/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';

export class BoboStatusBarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.boboStatusBar';

	private readonly _entry: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
	) {
		super();
		this._entry = this._register(statusbarService.addEntry(
			{
				name: 'bobo',
				text: '⚡ bobo',
				ariaLabel: 'bobo',
				tooltip: 'bobo — powered by Copilot Language Server',
			},
			BoboStatusBarContribution.ID,
			StatusbarAlignment.RIGHT,
			100,
		));
	}
}
