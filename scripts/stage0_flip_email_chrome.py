#!/usr/bin/env python3
"""Stage 0.1 — flip email chrome.

Classification:
  TRANSACTIONAL emails (no LLC line, cultural register only):
    - stripe-webhook.js: welcome (post-payment), gift-to-recipient, gift-to-giver confirmations
    - publication-email.js: certificate published notification
    - notify-giver-activated.js: gift recipient activated → notify giver
    - post-signup-email.js: post-signup register entry confirmations

  COMMERCIAL emails (cultural register + small grey LLC regulatory tail):
    - abandoned-checkout.js: cart abandonment re-engagement
    - cart-reengage-email.js: multi-touch nurture sequence
    - daily-expiry-sweep.js: renewal nudge (prompts new commercial decision)
    - pdf-lead-email.js: lead-magnet flow

The Moohane LLC + Wyoming address line currently appears in two CSS variants
across these files; we handle both. Cultural register = "Tigh Uí Chomáin ·
House of Ó Comáin · Terms · Privacy".
"""
from pathlib import Path

REPO = Path("/home/claude/clan")

# Existing Moohane line — two variants by CSS family/size
MOOHANE_VARIANT_A = (
    '<p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0;letter-spacing:0.08em">'
    'Moohane LLC · 30 N Gould St Ste 36809, Sheridan, WY 82801, USA · '
    '<a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · '
    '<a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>'
)
MOOHANE_VARIANT_A_06 = (
    '<p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0;letter-spacing:0.06em">'
    'Moohane LLC · 30 N Gould St Ste 36809, Sheridan, WY 82801, USA · '
    '<a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · '
    '<a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>'
)
MOOHANE_VARIANT_B = (
    '<p style="font-family:\'Georgia\',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">'
    'Moohane LLC · 30 N Gould St Ste 36809, Sheridan, WY 82801, USA · '
    '<a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · '
    '<a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>'
)

# Cultural register replacements
CULTURAL_VARIANT_A = (
    '<p style="font-family:\'Georgia\',serif;font-size:11px;color:#A88B57;margin:0;letter-spacing:0.06em">'
    'Tigh Uí Chomáin · House of Ó Comáin · '
    '<a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · '
    '<a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>'
)
CULTURAL_VARIANT_B = (
    '<p style="font-family:\'Georgia\',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">'
    'Tigh Uí Chomáin · House of Ó Comáin · '
    '<a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · '
    '<a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>'
)

# Regulatory tail (small dim grey, sits BELOW cultural register on commercial emails)
REGULATORY_TAIL = (
    '\n    <p style="font-family:sans-serif;font-size:9px;color:#5A4A2C;margin:8px 0 0;letter-spacing:0.04em">'
    'Moohane LLC · 30 N Gould St Ste 36809, Sheridan, WY 82801, USA</p>'
)

TRANSACTIONAL = [
    "netlify/functions/stripe-webhook.js",
    "netlify/functions/lib/publication-email.js",
    "netlify/functions/lib/notify-giver-activated.js",
    "netlify/functions/lib/post-signup-email.js",
]

COMMERCIAL = [
    "netlify/functions/abandoned-checkout.js",
    "netlify/functions/lib/cart-reengage-email.js",
    "netlify/functions/daily-expiry-sweep.js",
    "netlify/functions/lib/pdf-lead-email.js",
]


def flip_transactional(text: str) -> tuple[str, int]:
    """Replace Moohane lines with cultural register only (no regulatory tail)."""
    count = 0
    for old, new in [
        (MOOHANE_VARIANT_A, CULTURAL_VARIANT_A),
        (MOOHANE_VARIANT_A_06, CULTURAL_VARIANT_A),
        (MOOHANE_VARIANT_B, CULTURAL_VARIANT_B),
    ]:
        c = text.count(old)
        if c:
            text = text.replace(old, new)
            count += c
    return text, count


def flip_commercial(text: str) -> tuple[str, int]:
    """Replace Moohane lines with cultural register + append regulatory tail."""
    count = 0
    for old, cultural in [
        (MOOHANE_VARIANT_A, CULTURAL_VARIANT_A),
        (MOOHANE_VARIANT_A_06, CULTURAL_VARIANT_A),
        (MOOHANE_VARIANT_B, CULTURAL_VARIANT_B),
    ]:
        c = text.count(old)
        if c:
            text = text.replace(old, cultural + REGULATORY_TAIL)
            count += c
    return text, count


def main():
    print("=== TRANSACTIONAL (cultural register only) ===")
    for fp in TRANSACTIONAL:
        path = REPO / fp
        if not path.exists():
            print(f"  MISSING: {fp}")
            continue
        text = path.read_text(encoding="utf-8")
        new_text, count = flip_transactional(text)
        if count:
            path.write_text(new_text, encoding="utf-8")
            print(f"  {fp}: {count} replacement(s)")
        else:
            print(f"  {fp}: no match")

    print("\n=== COMMERCIAL (cultural register + regulatory tail) ===")
    for fp in COMMERCIAL:
        path = REPO / fp
        if not path.exists():
            print(f"  MISSING: {fp}")
            continue
        text = path.read_text(encoding="utf-8")
        new_text, count = flip_commercial(text)
        if count:
            path.write_text(new_text, encoding="utf-8")
            print(f"  {fp}: {count} replacement(s)")
        else:
            print(f"  {fp}: no match")


if __name__ == "__main__":
    main()
