#!/usr/bin/env bash
# Short development turn for every pinned model on PostgreSQL (timing + tool-call validity). Resumable.
set -u
cd "$(dirname "$0")/.."
for m in granite4.1-8b ministral-3-8b gemma4-12b qwen3.5-4b; do
  pkill -x llama-server; sleep 3
  nohup ./scripts/serve-model.sh "$m" > "logs/llama-server-$m.log" 2>&1 &
  for i in $(seq 1 60); do curl -s 127.0.0.1:47900/health | grep -q ok && break; sleep 3; done
  timeout 7200 bun layer-b/runner.ts --model "$m" --engines postgres --arms G0,G1 --tasks C1,C2,C3,C4,T01,T04,T07,T08 --paraphrases 0 --seeds 11 --run dev-b4 2>&1 | grep -v "^\[DB\]"
done
pkill -x llama-server
echo DEV-MODELS-DONE
