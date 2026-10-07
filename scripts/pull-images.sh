#!/usr/bin/env bash
# Pulls every image and records the resolved digest; rerunnable.
set -u
D="$(dirname "$0")/.."; LOG="$D/logs/pull-images.log"; OUT="$D/manifest/image-digests.tsv"
: > "$OUT.tmp"
grep -v '^#' "$D/manifest/images.tsv" | while IFS=$'\t' read -r eng img tier; do
  if docker pull -q "$img" >>"$LOG" 2>&1; then
    dig=$(docker image inspect --format '{{index .RepoDigests 0}}' "$img")
    printf '%s\t%s\t%s\n' "$eng" "$img" "$dig" >>"$OUT.tmp"; echo "$(date -Is) OK $eng $dig" >>"$LOG"
  else echo "$(date -Is) FAIL $eng $img" >>"$LOG"; printf '%s\t%s\tPULL-FAILED\n' "$eng" "$img" >>"$OUT.tmp"; fi
done
mv "$OUT.tmp" "$OUT"; echo "$(date -Is) ALL-FINISHED" >>"$LOG"
