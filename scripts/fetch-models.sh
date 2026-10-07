#!/usr/bin/env bash
# Resumable: hf download skips complete files and resumes partial ones; sha256 verified after.
set -u
DEST="${DEST:-$HOME/models/abr}"
LOG="$(dirname "$0")/../logs/fetch-models.log"
grep -v '^#' "$(dirname "$0")/../manifest/models.tsv" | while IFS=$'\t' read -r id repo rev file sha lic; do
  out="$DEST/$id"; mkdir -p "$out"
  if [ -f "$out/$file" ] && echo "$sha  $out/$file" | sha256sum -c --status; then echo "$(date -Is) OK-SKIP $id" >>"$LOG"; continue; fi
  echo "$(date -Is) START $id" >>"$LOG"
  hf download "$repo" "$file" --revision "$rev" --local-dir "$out" >>"$LOG" 2>&1
  if echo "$sha  $out/$file" | sha256sum -c --status; then echo "$(date -Is) DONE $id sha-ok" >>"$LOG"; else echo "$(date -Is) FAIL $id sha-mismatch" >>"$LOG"; fi
done
echo "$(date -Is) ALL-FINISHED" >>"$LOG"
