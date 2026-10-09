#!/usr/bin/env bash
# Disk guard for the confirmatory run: checks / every 30 minutes and prints a status line each time, and at >= LIMIT %
# stops the run (scripts, runner, llama-server) and prints CRITICAL. Added 2026-10-09 after the log incident.
LIMIT=${LIMIT:-80}
cd "$(dirname "$0")/.."
n=0
while true; do
  use=$(df --output=pcent / | tail -1 | tr -dc 0-9)
  if [ "$use" -ge "$LIMIT" ]; then
    pkill -f "scripts/[c]onfirm-35b.sh"; pkill -f "scripts/[c]onfirmatory.sh"; pkill -f "layer-[ab]/[r]unner.ts"; pkill -x llama-server
    echo "$(date '+%F %T') CRITICAL disk ${use}% >= ${LIMIT}%: run stopped. Top docker logs:"
    docker ps -aq | xargs -r docker inspect -f '{{.Name}} {{.LogPath}}' 2>/dev/null | head -20
    exit 1
  fi
  if true; then
    echo "$(date '+%F %T') disk ${use}% ($(df -h --output=avail / | tail -1 | tr -d ' ') free), records $(find runs/confirm-b -name '*.json' | wc -l), last: $(grep -E '^20' logs/confirm.log | tail -1 | cut -c1-80)"
  fi
  n=$((n + 1))
  sleep "${EVERY:-1800}"
done
