#!/usr/bin/env bash
# Qwen3.6-35B-A3B subset (amendment v2: core tasks, seed 11). Starts after confirmatory.sh finishes; resumable.
set -u
cd "$(dirname "$0")/.."
export NODE_TLS_REJECT_UNAUTHORIZED=0
until grep -q "CONFIRM-DONE" logs/confirm.log 2>/dev/null; do sleep 120; done
echo "$(date -Is) PHASE B35 start"
pkill -x llama-server; sleep 3
nohup ./scripts/serve-model.sh qwen3.6-35b-a3b > logs/llama-server-qwen3.6-35b-a3b.log 2>&1 &
for i in $(seq 1 100); do curl -s 127.0.0.1:47900/health | grep -q ok && break; sleep 3; done
bun layer-b/runner.ts --model qwen3.6-35b-a3b --engines postgres,mysql,mongodb,valkey,kafka,opensearch,sqlite,clickhouse,cassandra \
  --arms G0,G1 --tasks C1,C2,C3,C4,T01,T02,T04,T05,T06,T08,T09,T10 --paraphrases 0,1,2 --seeds 11 --run confirm-b 2>&1 \
  | grep -v "^\[DB\]" | grep -vE "Warning|trace-warnings"
pkill -x llama-server
echo "$(date -Is) CONFIRM-35B-DONE"
