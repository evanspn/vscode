#!/usr/bin/env bash
set -e

# Load nvm
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

# Use the exact Node version required by the repo
nvm install
nvm use

cd "$(dirname "$0")"

echo ""
echo "bobo build"
echo ""
echo "This will:"
echo "  1. npm install (~2 min)"
echo "  2. Build bobo for macOS arm64 (~30 min)"
echo ""
echo "Output: ../VSCode-darwin-arm64/bobo.app"
echo ""
read -p "Proceed? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "Installing dependencies..."
npm install
npm install @github/copilot-language-server

echo ""
echo "Building bobo (this takes ~30 min)..."
npx gulp vscode-darwin-arm64

echo ""
echo "Done. Run: open ../VSCode-darwin-arm64/bobo.app"
