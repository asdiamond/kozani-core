#!/usr/bin/env bash
# Wrapper script to launch Kozani in development mode with the kozani extension
# This hides the --extensionDevelopmentPath from Cursor's argument detection

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

cd "$ROOT_DIR"

# Get the extension path from the first argument, or use default
EXT_PATH="${1:-$ROOT_DIR/extensions/kozani-ext}"

# Skip prelaunch since we're using watch mode (electron and compilation already done)
export VSCODE_SKIP_PRELAUNCH=1

# Launch code.sh with extension development arguments
exec ./scripts/code.sh \
	--enable-proposed-api kozani.kozani-ext \
	--extensionDevelopmentPath "$EXT_PATH"
