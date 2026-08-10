#!/usr/bin/env bash
# Watchdog: when pi-cursor logs a NEW auth rejection (last 5 min), run the E2E probe
# immediately to distinguish backend-side vs local-side failure.
set -u

LOG_DIR="PI_MODULES_ROOT/.pi/agent/extensions/pi-cursor/logs"
PROBE="PI_MODULES_ROOT/pi-modulos/pi-cursor/e2e-sdk.mjs"
PROBE_DONE="/tmp/pi-cursor-e2e-last.txt"
TODAY=$(date +%F)
LOG="$LOG_DIR/pi-cursor-$TODAY.log"

declare -A SEEN

echo "[$(date +%T)] watchdog started. watching $LOG (live rejections only, last 5 min)"

while true; do
  # last auth rejection timestamp, only from recent lines
  LAST=$(tail -500 "$LOG" 2>/dev/null \
    | grep -E "Auth error detected in result|Auth recovery attempt [0-9] failed|Warm-up auth-rejected" \
    | tail -1 \
    | grep -oE "^\[[0-9T:Z.-]+\]" | tr -d '[]')
  if [ -n "$LAST" ]; then
    # only react if the rejection happened in the last 5 minutes
    TS=$(date -d "${LAST/T/ }" +%s 2>/dev/null)
    NOW_TS=$(date +%s)
    if [ -n "$TS" ] && [ $((NOW_TS - TS)) -le 300 ]; then
      key="${LAST}_${TODAY}"
      if [ -z "${SEEN[$key]:-}" ]; then
        SEEN[$key]=1
        echo "[$(date +%T)] AUTH REJECTION at $LAST (live) -> running E2E probe"
        timeout 90 node "$PROBE" 2>&1 | grep -vE "INFO|ExperimentalWarning|trace-warnings" > "$PROBE_DONE"
        echo "[$(date +%T)] --- probe result:"
        cat "$PROBE_DONE"
        echo "[$(date +%T)] ---"
      fi
    fi
  fi
  sleep 20
done
