#!/usr/bin/env bash
# Runs after confirmatory.sh: (1) a catch-up pass that re-runs any model x seed block left incomplete (a runner that
# crashes ends its block and confirmatory.sh moves on; every runner skips finished records), (2) the Qwen3.6-35B-A3B
# subset (amendment v2: core tasks, seed 11). Replaces confirm-35b.sh (2026-10-09, after a port clash ended Gemma seed 11).
set -u
cd "$(dirname "$0")/.."
export NODE_TLS_REJECT_UNAUTHORIZED=0
CORE_ENGINES=postgres,mysql,mongodb,valkey,kafka,opensearch,sqlite,clickhouse,cassandra
ALL_TASKS=C1,C2,C3,C4,T01,T02,T03,T04,T05,T06,T07,T08,T09,T10
CORE_TASKS=C1,C2,C3,C4,T01,T02,T04,T05,T06,T08,T09,T10
say() { echo "$(date -Is) $*"; }
serve() {
  pkill -x llama-server; sleep 3
  nohup ./scripts/serve-model.sh "$1" > "logs/llama-server-$1.log" 2>&1 &
  for i in $(seq 1 100); do curl -s 127.0.0.1:47900/health | grep -q ok && return 0; sleep 3; done
  say "SERVER-FAILED $1"; return 1
}
count() { find "runs/confirm-b/$1" -name "*.s$2.G*.json" 2>/dev/null | wc -l; }
filter() { grep -v "^\[DB\]" | grep -vE "Warning|trace-warnings"; }

until grep -q "CONFIRM-DONE" logs/confirm.log 2>/dev/null; do sleep 120; done
say "PHASE CATCHUP start"
for pass in 1 2; do
  for seed in 11 23 37; do
    for m in qwen3.5-9b granite4.1-8b ministral-3-8b gemma4-12b; do
      n=$(count "$m" "$seed"); [ "$n" -ge 687 ] && continue
      say "CATCHUP pass=$pass seed=$seed model=$m have=$n"
      serve "$m" && bun layer-b/runner.ts --model "$m" --engines "$CORE_ENGINES" --arms G0,G1 --tasks "$ALL_TASKS" \
        --paraphrases 0,1,2 --seeds "$seed" --run confirm-b 2>&1 | filter
    done
  done
  n=$(count qwen3.5-4b 11)
  if [ "$n" -lt 612 ]; then
    say "CATCHUP pass=$pass B4 have=$n"
    serve qwen3.5-4b && bun layer-b/runner.ts --model qwen3.5-4b --engines "$CORE_ENGINES" --arms G0,G1 --tasks "$CORE_TASKS" \
      --paraphrases 0,1,2 --seeds 11 --run confirm-b 2>&1 | filter
  fi
done
pkill -x llama-server
say "PHASE CATCHUP done"

say "PHASE B35 start"
serve qwen3.6-35b-a3b && bun layer-b/runner.ts --model qwen3.6-35b-a3b --engines "$CORE_ENGINES" --arms G0,G1 --tasks "$CORE_TASKS" \
  --paraphrases 0,1,2 --seeds 11 --run confirm-b 2>&1 | filter
pkill -x llama-server
say "CONFIRM-35B-DONE"
