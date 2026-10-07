#!/usr/bin/env bash
# Serve one pinned model with the preregistered flags. Usage: scripts/serve-model.sh <model-id> [ctx]
set -euo pipefail
ID="$1"; CTX="${2:-16384}"
LLAMA="$HOME/tools/llama.cpp/llama-b11191"
FILE=$(grep -v '^#' "$(dirname "$0")/../manifest/models.tsv" | awk -F'\t' -v id="$ID" '$1==id{print $4}')
[ -n "$FILE" ] || { echo "unknown model $ID" >&2; exit 2; }
cd "$LLAMA"
exec env LD_LIBRARY_PATH=. ./llama-server -m "$HOME/models/abr/$ID/$FILE" \
  --jinja -np 1 -c "$CTX" -ngl 99 --host 127.0.0.1 --port 47900 \
  --cache-type-k f16 --cache-type-v f16 --metrics --no-webui
