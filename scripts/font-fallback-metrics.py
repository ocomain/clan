#!/usr/bin/env python3
"""
Compute the metric-matched fallback descriptors used in fonts/fonts.css
('Jost Fallback' and 'EB Garamond Fallback').

Why: with font-display:swap the page paints in Arial / Times New Roman
first and re-flows when the web font arrives. Those system fonts are
~4-5% wider than Jost / EB Garamond, so paragraphs change line count at
the swap and everything below them jumps (layout shift). Scaling the
system font so its average advance width and line box match the web
font removes the jump. This is the method next/font and Fontaine use.

    size-adjust       = mean advance(web font) / mean advance(fallback)
    ascent-override   = (hhea.ascent  / unitsPerEm) / size-adjust
    descent-override  = (|hhea.descent| / unitsPerEm) / size-adjust
    line-gap-override = (hhea.lineGap / unitsPerEm) / size-adjust

The mean advance is measured over real site copy (membership + pedigree)
rather than a generic alphabet, so the ratio reflects the letter
frequencies the pages actually render. Arial and Times New Roman are
measured through their metric-identical open clones, Liberation Sans and
Liberation Serif, which is what Linux (and this script) has installed.

Usage:  pip install fonttools && python3 scripts/font-fallback-metrics.py
Then paste the printed descriptors into fonts/fonts.css.
"""
import glob
import re
import sys
from pathlib import Path

from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent


def site_copy(*pages):
    text = ''
    for page in pages:
        t = (ROOT / page).read_text(encoding='utf-8')
        t = re.sub(r'<script.*?</script>|<style.*?</style>', ' ', t, flags=re.S)
        t = re.sub(r'<[^>]+>', ' ', t)
        t = re.sub(r'&[a-z#0-9]+;', ' ', t)
        text += ' ' + re.sub(r'\s+', ' ', t)
    return text


def mean_advance(path, text):
    f = TTFont(path)
    cmap, hmtx, upm = f.getBestCmap(), f['hmtx'], f['head'].unitsPerEm
    total = n = 0
    for ch in text:
        g = cmap.get(ord(ch))
        if g:
            total += hmtx[g][0]
            n += 1
    return total / n / upm


def vertical(path):
    f = TTFont(path)
    upm, hh = f['head'].unitsPerEm, f['hhea']
    return hh.ascent / upm, abs(hh.descent) / upm, hh.lineGap / upm


def find_font(name):
    hits = glob.glob(f'/usr/share/fonts/**/{name}', recursive=True)
    if not hits:
        sys.exit(f'{name} not found — install fonts-liberation (apt) or point this script at a copy.')
    return hits[0]


def main():
    sample = site_copy('membership.html', 'pedigree.html')
    pairs = [
        ('Jost Fallback', ROOT / 'fonts/Jost-Regular.ttf', find_font('LiberationSans-Regular.ttf'),
         "local('Arial'), local('Helvetica Neue'), local('Helvetica'), local('Liberation Sans')"),
        ('EB Garamond Fallback', ROOT / 'fonts/EBGaramond-Regular.ttf', find_font('LiberationSerif-Regular.ttf'),
         "local('Times New Roman'), local('Times'), local('Liberation Serif')"),
    ]
    for name, web, fallback, src in pairs:
        sa = mean_advance(web, sample) / mean_advance(fallback, sample)
        asc, desc, gap = vertical(web)
        print(f"@font-face {{\n  font-family: '{name}';\n  src: {src};\n"
              f"  size-adjust: {sa * 100:.1f}%;\n  ascent-override: {asc / sa * 100:.2f}%;\n"
              f"  descent-override: {desc / sa * 100:.2f}%;\n  line-gap-override: {gap / sa * 100:.0f}%;\n}}\n")


if __name__ == '__main__':
    main()
