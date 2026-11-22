#!/usr/bin/env bash
# Builds the arXiv TeX source (pdfLaTeX, which arXiv compiles) from draft + Appendix A: ./scripts/build-arxiv.sh
# Output: report/submission/arxiv/main.tex, main.pdf (local test compile) and arxiv-source.tar.gz (upload this).
set -euo pipefail
cd "$(dirname "$0")/../report"
out=submission/arxiv
rm -rf "$out" && mkdir -p "$out"
{ cat draft.md; printf '\n\n\\newpage\n\\newgeometry{margin=1.3cm}\n\\scriptsize\n\n'; cat appendix.md; } > "$out/all.md"
cat > "$out/header.tex" <<'TEX'
\usepackage{xurl}
\usepackage{seqsplit}
\DeclareUnicodeCharacter{2265}{\ensuremath{\geq}}
\DeclareUnicodeCharacter{2264}{\ensuremath{\leq}}
\DeclareUnicodeCharacter{2192}{\ensuremath{\rightarrow}}
\DeclareUnicodeCharacter{00D7}{\ensuremath{\times}}
\DeclareUnicodeCharacter{00B1}{\ensuremath{\pm}}
TEX
pandoc "$out/all.md" -f markdown+autolink_bare_uris --lua-filter ../scripts/arxiv-longcode.lua -s -o "$out/main.tex" -H "$out/header.tex" -V geometry:margin=2.2cm -V fontsize=10pt -V colorlinks=true
rm "$out/all.md" "$out/header.tex"
(cd "$out" && for i in 1 2; do pdflatex -interaction=nonstopmode -halt-on-error main.tex >/dev/null; done)
if grep -q "Missing character" "$out/main.log"; then echo "missing glyphs:"; grep "Missing character" "$out/main.log" | sort | uniq -c; exit 1; fi
tar -C "$out" -czf "$out/arxiv-source.tar.gz" main.tex
pdfinfo "$out/main.pdf" | grep Pages
echo "$out/arxiv-source.tar.gz"
