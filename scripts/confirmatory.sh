#!/usr/bin/env bash
# Confirmatory run (preregistration osf.io/ms7ef + amendment v2). Resumable: every runner skips finished records,
# so re-running this script after a shutdown continues where it stopped. Progress: logs/confirm.log.
set -u
cd "$(dirname "$0")/.."
export NODE_TLS_REJECT_UNAUTHORIZED=0
CORE_ENGINES=postgres,mysql,mongodb,valkey,kafka,opensearch,sqlite,clickhouse,cassandra
ALL_TASKS=C1,C2,C3,C4,T01,T02,T03,T04,T05,T06,T07,T08,T09,T10
CORE_TASKS=C1,C2,C3,C4,T01,T02,T04,T05,T06,T08,T09,T10
LAYER_A=(postgres mysql mariadb sqlite)
say() { echo "$(date -Is) $*"; }

serve() {
  pkill -x llama-server; sleep 3
  nohup ./scripts/serve-model.sh "$1" > "logs/llama-server-$1.log" 2>&1 &
  for i in $(seq 1 100); do curl -s 127.0.0.1:47900/health | grep -q ok && return 0; sleep 3; done
  say "SERVER-FAILED $1"; return 1
}

say "PHASE A0 start (Layer A, delay 0)"
for e in "${LAYER_A[@]}"; do bun layer-a/runner.ts "$e" --run confirm-a 2>&1 | grep -v "^\[DB\]" | tail -3; done
say "PHASE A0 done"

say "PHASE B start (Layer B main set)"
for seed in 11 23 37; do
  for m in qwen3.5-9b granite4.1-8b ministral-3-8b gemma4-12b; do
    serve "$m" || continue
    say "B seed=$seed model=$m"
    bun layer-b/runner.ts --model "$m" --engines "$CORE_ENGINES" --arms G0,G1 --tasks "$ALL_TASKS" \
      --paraphrases 0,1,2 --seeds "$seed" --run confirm-b 2>&1 | grep -v "^\[DB\]" | grep -vE "Warning|trace-warnings"
  done
done
say "PHASE B done"

say "PHASE B4 start (Qwen3.5-4B subset, seed 11, core tasks)"
serve qwen3.5-4b && bun layer-b/runner.ts --model qwen3.5-4b --engines "$CORE_ENGINES" --arms G0,G1 --tasks "$CORE_TASKS" \
  --paraphrases 0,1,2 --seeds 11 --run confirm-b 2>&1 | grep -v "^\[DB\]" | grep -vE "Warning|trace-warnings"
pkill -x llama-server
say "PHASE B4 done"

say "PHASE A10 start (Layer A, 10-minute delay on cells damaged under G0)"
for e in "${LAYER_A[@]}"; do
  (
    for rec in R0 R1; do
      ids=$(python3 -I scripts/damaged-g0.py "runs/confirm-a/$e" "$rec")
      [ -n "$ids" ] && bun layer-a/runner.ts "$e" --perm G0 --rec "$rec" --delay-ms 600000 --mistakes "$ids" --run confirm-a 2>&1 | grep -v "^\[DB\]" | tail -2
    done
  ) &
done
wait
say "PHASE A10 done"
say "CONFIRM-DONE"
