#!/usr/bin/env bash
# Watchdog: when pi-cursor logs a NEW auth rejection (last 5 min), run the E2E probe
# immediately to distinguish backend-side vs local-side failure.
# Requires the pi-cursor extension installed; probe runs against its SDK.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${PI_CURSOR_AGENT_DIR:=${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}}"
: "${PI_CURSOR_EXT_DIR:=${PI_CURSOR_AGENT_DIR}/extensions/pi-cursor}"
: "${PI_CURSOR_MODULE_DIR:=${SCRIPT_DIR}}"
LOG_DIR="$PI_CURSOR_EXT_DIR/logs"
PROBE="$PI_CURSOR_MODULE_DIR/e2e-sdk.mjs"
PROBE_DONE="/tmp/pi-cursor-e2e-last.txt"
TODAY=$(date +%F)
LOG="$LOG_DIR/pi-cursor-$TODAY.log"
SDK_ENTRY="$PI_CURSOR_EXT_DIR/node_modules/@cursor/sdk/dist/esm/index.js"

declare -A SEEN

echo "[$(date +%T)] watchdog started. watching $LOG (live rejections only, last 5 min)"

while true; do
  LAST=$(tail -500 "$LOG" 2>/dev/null \
    | grep -E "Auth error detected in result|Auth recovery attempt [0-9] failed|Warm-up auth-rejected" \
    | tail -1 \
    | grep -oE "^\[[0-9T:Z.-]+\]" | tr -d '[]')
  if [ -n "$LAST" ]; then
    TS=$(date -d "${LAST/T/ }" +%s 2>/dev/null)
    NOW_TS=$(date +%s)
    if [ -n "$TS" ] && [ $((NOW_TS - TS)) -le 300 ]; then
      key="${LAST}_${TODAY}"
      if [ -z "${SEEN[$key]:-}" ]; then
        SEEN[$key]=1
        echo "[$(date +%T)] AUTH REJECTION at $LAST (live) -> running E2E probe"
        if [ ! -f "$SDK_ENTRY" ]; then
          echo "[$(date +%T)] SDK missing at $SDK_ENTRY" | tee "$PROBE_DONE"
        else
          PI_CODING_AGENT_DIR="$PI_CURSOR_AGENT_DIR" \
          PI_CURSOR_SDK_ENTRY="$SDK_ENTRY" \
          timeout 90 node "$PROBE" 2>&1 \
            | grep -vE "INFO|ExperimentalWarning|trace-warnings" > "$PROBE_DONE"
        fi
        echo "[$(date +%T)] --- probe result:"
        cat "$PROBE_DONE"
        echo "[$(date +%T)] ---"
      fi
    fi
  fi
  sleep 20
done
