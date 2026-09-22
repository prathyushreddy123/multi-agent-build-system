#!/usr/bin/env bash
# Re-apply the pi >= 0.86 contract shim to an installed pi-claude-agent-sdk.
#
# `pi update`, `npm update`, or reinstalling the extension restores the stock
# package and silently reintroduces both bugs this patch fixes. Run this after
# any of those. See README.md in this directory for the why.
#
# Usage: .pi/patches/apply.sh [path-to-pi-claude-agent-sdk]
set -euo pipefail

PATCH_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH="$PATCH_DIR/pi-claude-agent-sdk-0.8.6-pi086-contract.patch"
TARGET_VERSION="0.8.6"

pkg="${1:-${PI_AGENT_DIR:-$HOME/.pi/agent}/npm/node_modules/pi-claude-agent-sdk}"

if [ ! -f "$pkg/package.json" ]; then
  echo "error: no pi-claude-agent-sdk at $pkg" >&2
  echo "       pass the path explicitly: $0 /path/to/pi-claude-agent-sdk" >&2
  exit 1
fi

version="$(node -p "require('$pkg/package.json').version")"
if [ "$version" != "$TARGET_VERSION" ]; then
  echo "warning: patch was written against $TARGET_VERSION, found $version." >&2
  echo "         Check whether upstream already fixed this before forcing it:" >&2
  echo "         https://github.com/pi-pod/pi-claude-agent-sdk" >&2
  if [ "${FORCE:-}" != "1" ]; then
    echo "         Re-run with FORCE=1 to apply anyway." >&2
    exit 1
  fi
fi

if grep -q "shimPi086Context" "$pkg/src/index.ts"; then
  echo "already applied — $pkg/src/index.ts has shimPi086Context()"
  exit 0
fi

if ! patch -p1 --dry-run -d "$pkg" < "$PATCH" >/dev/null 2>&1; then
  echo "error: patch does not apply cleanly to $pkg" >&2
  echo "       the package changed; re-derive the shim against the new source" >&2
  exit 1
fi

cp "$pkg/src/index.ts" "$pkg/src/index.ts.orig"
patch -p1 -d "$pkg" < "$PATCH"
echo "applied. Original saved to $pkg/src/index.ts.orig"
echo
echo "Verify with:"
echo "  CLAUDE_BRIDGE_DEBUG=1 pi -p -t read --provider claude-bridge \\"
echo "    --model claude-haiku-4-5 'read package.json and name the project'"
echo "  grep shimPi086Context \"\${PI_AGENT_DIR:-\$HOME/.pi/agent}\"/claude-bridge.log"
echo "A line reporting a non-zero tool count means the shim is live."
