#!/usr/bin/env bash
# Regenerate the WOFF2 web fonts in /fonts as Latin subsets of the TTFs.
#
# Why: EB Garamond's full build is ~150-170 KB per face because it carries
# Cyrillic, Greek, Vietnamese, small caps, swashes and seven stylistic sets.
# The site renders Latin text with Irish fadas; subsetting to the ranges
# below (plus the OpenType features browsers apply by default, and tnum
# which pedigree/surname-variants request) cuts each face to ~55 KB with
# no visible change. See the header comment in fonts/fonts.css.
#
# The .ttf files are left alone on purpose: netlify/functions/lib/generate-*.js
# embed them in the certificate and patent PDFs and need the full glyph set.
#
# Usage:  pip install fonttools brotli && scripts/subset-web-fonts.sh
set -euo pipefail
cd "$(dirname "$0")/../fonts"

# Basic Latin, Latin-1, Latin Extended A/B, schwa, modifier letters, the
# combining marks browsers may synthesise, Latin Extended Additional
# (dotted Gaelic consonants), general punctuation, currency, №, ™, the
# arrows and symbols the CTAs/lists use, fi/fl ligatures, and the regional
# indicator letters behind the flag emoji on surname-variants.
UNICODES='U+0000-024F,U+0259,U+02BC,U+02C6-02DC,U+0300-0308,U+1E00-1EFF,U+2000-206F,U+20A0-20CF,U+2113,U+2116,U+2122,U+2190-2199,U+2212,U+2215,U+2248,U+2260,U+2264,U+2265,U+2500,U+2502,U+2550,U+25A0-25FF,U+2605,U+2606,U+2630,U+26A0,U+2713-2717,U+2726,U+2764,U+FB00-FB06,U+FEFF,U+FFFD,U+1F1E6-1F1FF'
# Default-on layout features + tnum (font-variant-numeric: tabular-nums).
FEATURES='kern,liga,clig,calt,ccmp,locl,mark,mkmk,rlig,curs,rclt,dist,tnum'

for face in EBGaramond-Regular EBGaramond-Italic EBGaramond-Medium Jost-Regular Jost-Medium Jost-SemiBold; do
  pyftsubset "$face.ttf" \
    --unicodes="$UNICODES" \
    --layout-features="$FEATURES" \
    --flavor=woff2 \
    --output-file="$face.woff2"
  printf '%-22s %7d bytes\n' "$face.woff2" "$(stat -c %s "$face.woff2")"
done
