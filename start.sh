#!/usr/bin/env bash
#
# Launch term-copilot: open Hyper and run the bridge in the foreground.
# Ctrl-C stops the bridge (the panel then shows offline until you start it again).

set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  printf "\033[33m! ANTHROPIC_API_KEY is set — this bills the API, not your subscription.\033[0m\n"
fi

open -a Hyper 2>/dev/null || echo "(could not open Hyper — launch it manually)"
echo "Starting bridge (Ctrl-C to stop)…"
exec node "$DIR/bridge/index.js"
