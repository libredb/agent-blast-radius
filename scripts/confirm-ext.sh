#!/usr/bin/env bash
# Extended engines (MariaDB, Redis, Elasticsearch) in Layer B, preregistration §8 rule: all three or none, secondary
# analyses only. Rule conditions measured 2026-10-13 (mean trial 26 s <= 95 s, buffer >= 3 days), so the run is
# brought forward from 20 Nov (deviation of 2026-10-13). Same design as the main set: four main models, seeds 11/23/37,
# all tasks, G0/G1. Separate run id so the confirmatory analysis never reads these records. Resumable; two passes so a
# block cut short by a harness error is completed. Progress: logs/confirm-ext.log.
set -u
cd "$(dirname "$0")/.."
export NODE_TLS_REJECT_UNAUTHORIZED=0
EXT_ENGINES=mariadb,redis,elasticsearch
ALL_TASKS=C1,C2,C3,C4,T01,T02,T03,T04,T05,T06,T07,T08,T09,T10
PER_BLOCK=243 # 3 engines x (G0 13 tasks + G1 14 tasks) x 3 paraphrases
say() { echo "$(date -Is) $*"; }
netok() {
  local warned=0
  local gw; gw=$(docker network inspect abr-net -f '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null || echo 172.17.1.1)
  until ip route get "${gw%.*}.254" | grep -q " dev br-"; do
    [ "$warned" = 0 ] && say "NETWORK-BLOCKED: Docker bridge not routable (VPN?), waiting"; warned=1; sleep 60
  done
}
serve() {
  pkill -x llama-server; sleep 3
  nohup ./scripts/serve-model.sh "$1" > "logs/llama-server-$1.log" 2>&1 &
  for i in $(seq 1 100); do curl -s 127.0.0.1:47900/health | grep -q ok && return 0; sleep 3; done
  say "SERVER-FAILED $1"; return 1
}
count() { find "runs/confirm-ext/$1" -name "*.s$2.G*.json" 2>/dev/null | wc -l; }
filter() { grep -v "^\[DB\]" | grep -vE "Warning|trace-warnings"; }

say "PHASE EXT start"
for pass in 1 2; do
  for seed in 11 23 37; do
    for m in qwen3.5-9b granite4.1-8b ministral-3-8b gemma4-12b; do
      n=$(count "$m" "$seed"); [ "$n" -ge "$PER_BLOCK" ] && continue
      say "EXT pass=$pass seed=$seed model=$m have=$n"
      netok; serve "$m" && bun layer-b/runner.ts --model "$m" --engines "$EXT_ENGINES" --arms G0,G1 --tasks "$ALL_TASKS" \
        --paraphrases 0,1,2 --seeds "$seed" --run confirm-ext 2>&1 | filter
      say "EXT block done seed=$seed model=$m have=$(count "$m" "$seed")"
    done
  done
done
pkill -x llama-server
say "EXT-DONE"
