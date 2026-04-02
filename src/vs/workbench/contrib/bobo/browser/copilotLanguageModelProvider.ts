/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Copilot Language Model Provider for bobo.
 *
 * NOTE: This provider requires the `@github/copilot-language-server` npm package.
 * Install it with: npm install @github/copilot-language-server
 * The package is not bundled with the fork and must be installed separately.
 *
 * The binary is resolved at runtime via `require.resolve('@github/copilot-language-server')`.
 */

import * as cp from 'child_process';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { ExtensionIdentifier } from '../../../../platform/extensions/common/extensions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import {
	ChatMessageRole,
	IChatMessage,
	IChatMessagePart,
	IChatResponsePart,
	ILanguageModelChatInfoOptions,
	ILanguageModelChatMetadata,
	ILanguageModelChatMetadataAndIdentifier,
	ILanguageModelChatProvider,
	ILanguageModelChatRequestOptions,
	ILanguageModelChatResponse,
	ILanguageModelsService,
} from '../../../contrib/chat/common/languageModels.js';

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
	jsonrpc: '2.0';
	id: number;
	method: string;
	params?: unknown;
}

interface JsonRpcResponse {
	jsonrpc: '2.0';
	id: number;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

interface JsonRpcNotification {
	jsonrpc: '2.0';
	method: string;
	params?: unknown;
}

// ---------------------------------------------------------------------------
// Copilot LSP client
// ---------------------------------------------------------------------------

class CopilotLspClient extends Disposable {

	private readonly _process: cp.ChildProcess;
	private _buffer = '';
	private _nextId = 1;
	private readonly _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

	constructor(binaryPath: string) {
		super();
		this._process = cp.spawn(binaryPath, ['--stdio'], {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: { ...process.env },
		});

		this._process.stdout?.on('data', (chunk: Buffer) => this._onData(chunk.toString()));
		this._process.stderr?.on('data', (data: Buffer) => {
			// Suppress stderr noise from the language server
			void data;
		});
		this._process.on('exit', () => {
			for (const pending of this._pending.values()) {
				pending.reject(new Error('Copilot language server exited unexpectedly'));
			}
			this._pending.clear();
		});

		this._register({ dispose: () => this._process.kill() });

		// Initialize the LSP connection
		this._sendRequest('initialize', {
			processId: process.pid,
			capabilities: {},
			rootUri: null,
		}).catch(() => { /* ignore init errors */ });
	}

	private _onData(data: string): void {
		this._buffer += data;
		while (true) {
			const headerEnd = this._buffer.indexOf('\r\n\r\n');
			if (headerEnd === -1) {
				break;
			}
			const header = this._buffer.slice(0, headerEnd);
			const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
			if (!lengthMatch) {
				break;
			}
			const length = parseInt(lengthMatch[1], 10);
			const bodyStart = headerEnd + 4;
			if (this._buffer.length < bodyStart + length) {
				break;
			}
			const body = this._buffer.slice(bodyStart, bodyStart + length);
			this._buffer = this._buffer.slice(bodyStart + length);
			try {
				const msg = JSON.parse(body) as JsonRpcResponse | JsonRpcNotification;
				if ('id' in msg && msg.id !== undefined) {
					const response = msg as JsonRpcResponse;
					const pending = this._pending.get(response.id);
					if (pending) {
						this._pending.delete(response.id);
						if (response.error) {
							pending.reject(new Error(response.error.message));
						} else {
							pending.resolve(response.result);
						}
					}
				}
			} catch {
				// Ignore parse errors
			}
		}
	}

	private _sendRequest(method: string, params?: unknown): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const id = this._nextId++;
			this._pending.set(id, { resolve, reject });
			const request: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
			const body = JSON.stringify(request);
			const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
			this._process.stdin?.write(header + body);
		});
	}

	async sendChatRequest(
		messages: IChatMessage[],
		options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		const lspMessages = messages.map(msg => ({
			role: msg.role === ChatMessageRole.System ? 'system'
				: msg.role === ChatMessageRole.Assistant ? 'assistant'
				: 'user',
			content: this._extractText(msg.content),
		}));

		const abortController = { aborted: false };
		token.onCancellationRequested(() => { abortController.aborted = true; });

		const self = this;
		async function* streamGenerator(): AsyncIterable<IChatResponsePart> {
			if (abortController.aborted) {
				return;
			}
			try {
				const result = await self._sendRequest('copilot/chat', {
					messages: lspMessages,
					...options.modelOptions,
				});
				if (abortController.aborted) {
					return;
				}
				const text = typeof result === 'string' ? result
					: (result as { text?: string })?.text ?? JSON.stringify(result);
				yield { type: 'text', value: text } satisfies IChatResponsePart;
			} catch (err) {
				if (!abortController.aborted) {
					yield { type: 'text', value: `[Copilot LS error: ${(err as Error).message}]` } satisfies IChatResponsePart;
				}
			}
		}

		return {
			stream: streamGenerator(),
			result: Promise.resolve(undefined),
		};
	}

	private _extractText(parts: IChatMessagePart[]): string {
		return parts
			.map(p => ('value' in p && typeof p.value === 'string' ? p.value : ''))
			.join('');
	}
}

// ---------------------------------------------------------------------------
// ILanguageModelChatProvider implementation
// ---------------------------------------------------------------------------

const BOBO_VENDOR = 'copilot';
const BOBO_MODEL_ID = 'bobo-gpt-4o';
const BOBO_EXTENSION_ID = 'bobo.copilot-provider';

export class CopilotLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private _client: CopilotLspClient | undefined;

	constructor() {
		super();
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const binaryPath: string = require('@github/copilot-language-server');
			this._client = this._register(new CopilotLspClient(binaryPath));
		} catch {
			// Package not installed — provider will return an error on every request.
			// Install with: npm install @github/copilot-language-server
		}
	}

	async provideLanguageModelChatInfo(
		_options: ILanguageModelChatInfoOptions,
		_token: CancellationToken,
	): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const metadata: ILanguageModelChatMetadata = {
			extension: new ExtensionIdentifier(BOBO_EXTENSION_ID),
			name: 'GPT-4o (bobo)',
			id: BOBO_MODEL_ID,
			vendor: BOBO_VENDOR,
			version: '1.0',
			family: 'gpt-4o',
			maxInputTokens: 128000,
			maxOutputTokens: 4096,
			isDefaultForLocation: {},
			isUserSelectable: true,
			modelPickerCategory: { label: 'bobo', order: 1 },
			capabilities: {
				toolCalling: false,
				agentMode: false,
			},
		};
		return [{ metadata, identifier: BOBO_MODEL_ID }];
	}

	async sendChatRequest(
		_modelId: string,
		messages: IChatMessage[],
		_from: ExtensionIdentifier | undefined,
		options: ILanguageModelChatRequestOptions,
		token: CancellationToken,
	): Promise<ILanguageModelChatResponse> {
		if (!this._client) {
			async function* errorStream(): AsyncIterable<IChatResponsePart> {
				yield {
					type: 'text',
					value: 'Copilot language server not available. Run: npm install @github/copilot-language-server',
				} satisfies IChatResponsePart;
			}
			return { stream: errorStream(), result: Promise.resolve(undefined) };
		}
		return this._client.sendChatRequest(messages, options, token);
	}

	async provideTokenCount(
		_modelId: string,
		message: string | IChatMessage,
		_token: CancellationToken,
	): Promise<number> {
		const text = typeof message === 'string'
			? message
			: message.content.map(p => ('value' in p && typeof p.value === 'string' ? p.value : '')).join('');
		return Math.ceil(text.length / 4);
	}
}

// ---------------------------------------------------------------------------
// Registration helper
// ---------------------------------------------------------------------------

export function registerCopilotLanguageModelProvider(accessor: ServicesAccessor): IDisposable {
	const languageModelsService = accessor.get(ILanguageModelsService);
	const provider = new CopilotLanguageModelProvider();
	const registration = languageModelsService.registerLanguageModelProvider(BOBO_VENDOR, provider);
	return {
		dispose: () => {
			registration.dispose();
			provider.dispose();
		},
	};
}
