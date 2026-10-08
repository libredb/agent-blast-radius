#!/usr/bin/env bash
# Pilot (plumbing only; excluded from confirmatory analysis per preregistration v1.1). Resumable.
set -u
cd "$(dirname "$0")/.."
export NODE_TLS_REJECT_UNAUTHORIZED=0
for m in gemma4-12b granite4.1-8b; do
  pkill -x llama-server; sleep 3
  nohup ./scripts/serve-model.sh "$m" > "logs/llama-server-$m.log" 2>&1 &
  for i in $(seq 1 60); do curl -s 127.0.0.1:47900/health | grep -q ok && break; sleep 3; done
  timeout 21600 bun layer-b/runner.ts --model "$m" --engines mysql,mongodb,opensearch,sqlite,clickhouse --arms G0,G1 --tasks C1,T08 --paraphrases 0 --seeds 11 --run pilot-2 2>&1 | grep -v "^\[DB\]"
done
pkill -x llama-server
echo PILOT2-DONE
