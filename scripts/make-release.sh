#!/usr/bin/env bash
# Builds the Zenodo release archive in release/ from a clean copy: the code at HEAD plus confirmatory records,
# with this machine's absolute repo path replaced by "<repo>" (it appears in SQLite file paths and driver stack traces).
set -euo pipefail
cd "$(dirname "$0")/.."
here="$(pwd)"
stage="release/agent-blast-radius"
rm -rf release && mkdir -p "$stage"
git archive HEAD | tar -x -C "$stage"
# Working notes and the manuscript stay out (the paper itself goes to arXiv): report/ keeps the appendix only.
rm -rf "$stage/report/submission" "$stage/report/draft.md" "$stage/report"/sources-*.md
for d in confirm-a confirm-b confirm-ext drill-b; do cp -r "runs/$d" "$stage/runs-$d"; done
mkdir -p "$stage/analysis/out" && cp analysis/out/*.md analysis/out/*.csv analysis/out/*.json "$stage/analysis/out/" 2>/dev/null || true
grep -rl --null "$here" "$stage" | xargs -0 -r sed -i "s#$here#<repo>#g"
if grep -rqF "$HOME/" "$stage"; then echo "home path left:"; grep -rlF "$HOME/" "$stage" | head; exit 1; fi
tar -C release -czf release/agent-blast-radius.tar.gz agent-blast-radius
sha256sum release/agent-blast-radius.tar.gz > release/agent-blast-radius.tar.gz.sha256
du -sh release/agent-blast-radius.tar.gz
