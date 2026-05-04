#!/usr/bin/env python3
"""Stage 0: Footer hardening - de-anchor Newhall as trading address.

Per discussion:
- Replace footer Contact column "Newhall House, County Clare" + "Ireland" links
  with a single narrative line "Clan seat: Newhall House, County Clare" (no link).
- Add a small Legal links line in the footer-bottom row (Terms · Privacy · Refund · About).
- Heritage narrative throughout the rest of the site stays untouched.
"""
import re
import sys
from pathlib import Path

REPO = Path("/home/claude/clan")

# Files to update
PAGES = [
    "celtic-heritage-clan.html", "clan-stories.html", "coat-of-arms.html",
    "coman-heritage.html", "commins-ireland.html", "commons-ireland.html",
    "cummins-heritage.html", "heartlands.html", "hurley-o-comain.html",
    "index.html", "irish-diaspora-clan.html", "join.html", "patrons.html",
    "pedigree.html", "privy-council.html", "register.html", "relics.html",
    "surname-variants.html", "timeline.html",
]

# Footer Contact column patterns (variations exist for "County Clare" vs "Co. Clare")
FOOTER_PATTERNS = [
    (
        '<li><a href="#">Newhall House, County Clare</a></li>\n          <li><a href="#">Ireland</a></li>',
        '<li>Clan seat: Newhall House, County Clare</li>',
    ),
    (
        '<li><a href="#">Newhall House, Co. Clare</a></li>\n          <li><a href="#">Ireland</a></li>',
        '<li>Clan seat: Newhall House, County Clare</li>',
    ),
    # Variations with different indentation seen in some files
    (
        '<li><a href="#">Newhall House, County Clare</a></li>\n                <li><a href="#">Ireland</a></li>',
        '<li>Clan seat: Newhall House, County Clare</li>',
    ),
    (
        '<li><a href="#">Newhall House, Co. Clare</a></li>\n                <li><a href="#">Ireland</a></li>',
        '<li>Clan seat: Newhall House, County Clare</li>',
    ),
]

# Legal links line — added inside footer-bottom as a third row child
# Two existing variants of footer-bottom (utf8 vs html-entity copy text)
FOOTER_BOTTOM_VARIANTS = [
    (
        '<div class="footer-copy">© 2025–2026 Tigh Uí Chomáin · House of Ó Comáin · All rights reserved</div>',
        '<div class="footer-copy">© 2025–2026 Tigh Uí Chomáin · House of Ó Comáin · All rights reserved · '
        '<a href="/terms.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">Terms</a> · '
        '<a href="/privacy.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">Privacy</a> · '
        '<a href="/refund.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">Refund</a> · '
        '<a href="/about.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">About</a></div>',
    ),
    (
        '<div class="footer-copy">&copy; 2025&ndash;2026 Tigh U&iacute; Chom&aacute;in &middot; House of &Oacute; Com&aacute;in &middot; All rights reserved</div>',
        '<div class="footer-copy">&copy; 2025&ndash;2026 Tigh U&iacute; Chom&aacute;in &middot; House of &Oacute; Com&aacute;in &middot; All rights reserved &middot; '
        '<a href="/terms.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">Terms</a> &middot; '
        '<a href="/privacy.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">Privacy</a> &middot; '
        '<a href="/refund.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">Refund</a> &middot; '
        '<a href="/about.html" style="color:inherit;text-decoration:underline;text-decoration-color:rgba(184,151,90,.3)">About</a></div>',
    ),
]


def update_file(path: Path) -> tuple[bool, list[str]]:
    """Apply all Stage 0 changes to a single HTML file."""
    text = path.read_text(encoding="utf-8")
    original = text
    changes = []

    # Footer Contact column
    for old, new in FOOTER_PATTERNS:
        if old in text:
            text = text.replace(old, new)
            changes.append("footer-contact")
            break

    # Legal links in footer-bottom
    for old, new in FOOTER_BOTTOM_VARIANTS:
        if old in text:
            text = text.replace(old, new)
            changes.append("legal-links")
            break

    if text != original:
        path.write_text(text, encoding="utf-8")
        return True, changes
    return False, changes


def main():
    updated = []
    skipped = []
    for name in PAGES:
        path = REPO / name
        if not path.exists():
            print(f"  MISSING: {name}")
            continue
        changed, changes = update_file(path)
        if changed:
            updated.append((name, changes))
        else:
            skipped.append(name)

    print(f"\nUpdated {len(updated)}/{len(PAGES)} files:")
    for name, changes in updated:
        print(f"  {name}: {', '.join(changes)}")
    if skipped:
        print(f"\nSkipped (no matches): {len(skipped)}")
        for name in skipped:
            print(f"  {name}")


if __name__ == "__main__":
    main()
