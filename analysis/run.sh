#!/usr/bin/env bash
# Runs one analysis script inside the pinned image: ./analysis/run.sh load.py
set -euo pipefail
cd "$(dirname "$0")/.."
docker run --rm -u "$(id -u):$(id -g)" -v "$PWD:/w" -w /w abr-analysis:1 python "analysis/$1" "${@:2}"
