#!/usr/bin/env bash
# Builds the manuscript PDF (draft + Appendix A): ./scripts/build-pdf.sh [YYYY-MM-DD]
# Output: report/agent-blast-radius-draft-<date>.pdf (date defaults to today; use the send date for right-of-reply).
set -euo pipefail
cd "$(dirname "$0")/../report"
date="${1:-$(date +%F)}"
tmp="$(mktemp --suffix=.md)"
trap 'rm -f "$tmp"' EXIT
{ cat draft.md; printf '\n\n\\newpage\n\\newgeometry{margin=1.3cm}\n\\scriptsize\n\n'; cat appendix.md; } > "$tmp"
pandoc "$tmp" -o "agent-blast-radius-draft-$date.pdf" --pdf-engine=xelatex -V mainfont="DejaVu Serif" \
  -V monofont="DejaVu Sans Mono" -V geometry:margin=2.2cm -V fontsize=10pt -V colorlinks=true
echo "report/agent-blast-radius-draft-$date.pdf"
