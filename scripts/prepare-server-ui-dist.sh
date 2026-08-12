#!/usr/bin/env bash
set -euo pipefail

# Copy the already-built UI into the server's single static artifact location.
# The caller owns the UI build so every pipeline has the same explicit order:
# build apps/ui/dist, then materialize apps/server/ui-dist.

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
UI_DIST="$REPO_ROOT/apps/ui/dist"
SERVER_UI_DIST="$REPO_ROOT/apps/server/ui-dist"

if [ ! -f "$UI_DIST/index.html" ]; then
  echo "Error: canonical UI build output missing at $UI_DIST/index.html"
  echo "Build @paperclipai/ui before preparing the server artifact."
  exit 1
fi

rm -rf "$SERVER_UI_DIST"
cp -r "$UI_DIST" "$SERVER_UI_DIST"
echo "  -> Materialized canonical apps/server/ui-dist artifact"
