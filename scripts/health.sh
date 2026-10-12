#!/usr/bin/env bash
# Health line every EVERY seconds (default 1800): disk, GPU (util, memory, temperature, power, throttle reasons), CPU (load,
# package temperature, memory). Added 2026-10-13 for the extended-engine run. Read-only; disk-guard.sh does the stopping.
cd "$(dirname "$0")/.."
while true; do
  disk=$(df --output=pcent,avail -h / | tail -1 | awk '{print $1" ("$2" free)"}')
  gpu=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,clocks_throttle_reasons.active --format=csv,noheader,nounits 2>/dev/null \
    | awk -F', ' '{printf "%s%% %s/%sMiB %sC %sW thr=%s", $1,$2,$3,$4,$5,$6}')
  load=$(cut -d' ' -f1-3 /proc/loadavg)
  ctemp=$(sensors 2>/dev/null | awk '/Package id 0/{print $4; exit}')
  mem=$(free -g | awk '/Mem:/{print $3"/"$2"G"}')
  recs=$(find runs/${RUN:-confirm-ext} -name '*.json' 2>/dev/null | wc -l)
  echo "$(date '+%F %T') HEALTH disk ${disk} | GPU ${gpu} | CPU load ${load} /$(nproc) ${ctemp} | RAM ${mem} | records ${recs}"
  sleep "${EVERY:-1800}"
done
