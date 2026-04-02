#!/usr/bin/env bash
set -e

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

nvm install || nvm use

cd "$(dirname "$0")"

echo ""
echo "bobo build"
echo ""
echo "This will:"
echo "  Build bobo for macOS arm64 (~30 min)"
echo ""
echo "Output: ../VSCode-darwin-arm64/bobo.app"
echo ""
read -p "Proceed? [y/N] " confirm
if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
  echo "Cancelled."
  exit 0
fi

echo ""
echo "Building bobo (this takes ~30 min)..."
npx gulp vscode-darwin-arm64

echo ""
echo "Done. Run: open ../VSCode-darwin-arm64/bobo.app"
