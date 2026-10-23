#!/usr/bin/env bash
# Builds the manuscript PDF (draft + Appendix A): ./scripts/build-pdf.sh
# Output: report/agent-blast-radius-draft.pdf
set -euo pipefail
cd "$(dirname "$0")/../report"
tmp="$(mktemp --suffix=.md)"
trap 'rm -f "$tmp"' EXIT
{ cat draft.md; printf '\n\n\\newpage\n\\newgeometry{margin=1.3cm}\n\\scriptsize\n\n'; cat appendix.md; } > "$tmp"
pandoc "$tmp" -o agent-blast-radius-draft.pdf --pdf-engine=xelatex -V mainfont="DejaVu Serif" \
  -V monofont="DejaVu Sans Mono" -V geometry:margin=2.2cm -V fontsize=10pt -V colorlinks=true
echo "report/agent-blast-radius-draft.pdf"
