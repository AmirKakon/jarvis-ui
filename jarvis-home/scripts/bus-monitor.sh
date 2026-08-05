#!/bin/bash
# Wrapper so cron can run the Node bus monitor with a stable PATH.
set -euo pipefail
export HOME="${HOME:-/home/iot}"
export PATH="/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin:$PATH"
mkdir -p "$HOME/jarvis/logs"
exec /usr/bin/env node "$HOME/jarvis/scripts/bus-monitor.mjs" >>"$HOME/jarvis/logs/bus-monitor.log" 2>&1
