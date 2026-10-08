#!/usr/bin/env bash
# Re-run every engine smoke test on the pinned digests; record pass/fail. Serves as the scorer mutation check.
cd "$(dirname "$0")/.."
out=logs/smoke-all-$(date +%Y%m%d-%H%M).log
for t in postgres postgres-r1 mysql mariadb sqlite mongodb cassandra valkey redis kafka clickhouse opensearch elasticsearch; do
  start=$(date +%s)
  if timeout 1800 bun tests/smoke-$t.ts > logs/smoke-$t.out 2>&1; then r=PASS; else r=FAIL; fi
  echo "$(date -Is) $t $r $(( $(date +%s) - start ))s" | tee -a "$out"
done
echo SMOKE-ALL-DONE | tee -a "$out"
