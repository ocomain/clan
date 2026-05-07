"""
Letters patent generator — Clan Ó Comáin
Renders the formal warrant by which the Chief raises a member to one of the
three Honours: Cara (1 soul), Ardchara (5), Onóir (15).

Same toolchain as the cert: HTML + CSS + WeasyPrint, with embedded EB Garamond,
the real Chief's wax seal, the real Herald's seal, and the Chief's signature PNG.
"""
import base64, os, sys
from pathlib import Path
from weasyprint import HTML

CLAN_DIR = Path('/home/claude/clan')
FONTS_DIR = CLAN_DIR / 'fonts'
ARMS_PATH = CLAN_DIR / 'coat_of_arms.png'
SIG_PATH = CLAN_DIR / 'the_commane_signature.png'
COMMANE_SEAL_PATH = CLAN_DIR / 'the_commane_seal.png'
HERALD_SEAL_PATH = CLAN_DIR / 'the_herald_seal.png'

OUT_PDF = '/mnt/user-data/outputs/clan_o_comain_letters_patent_cara.pdf'


def b64(p): return base64.b64encode(Path(p).read_bytes()).decode()
def font_face(name, file, weight=400, style='normal'):
    return f"@font-face{{font-family:'{name}';font-weight:{weight};font-style:{style};src:url(data:font/ttf;base64,{b64(FONTS_DIR/file)}) format('truetype');}}"


# ─── ASSETS ─────────────────────────────────────────────────────────────────
arms_b64 = b64(ARMS_PATH)
sig_b64 = b64(SIG_PATH) if SIG_PATH.exists() else None
commane_seal_b64 = b64(COMMANE_SEAL_PATH)
herald_seal_b64 = b64(HERALD_SEAL_PATH)


# ─── HONOUR DEFINITIONS (matches members/honours.html voice exactly) ────────
HONOURS = {
    'cara': {
        'irish': 'Cara',
        'pron': 'KAR-uh',
        'english': 'Friend',
        'threshold': 'one soul',
        'threshold_word': 'first',
        'body_voice': 'it hath pleased Us to raise the said member within the clan to the dignity hereunder',
        'body_extra': (
            "Cara is the older Irish word for a friend — and in the Brehon-law tradition, "
            "the Chief's <em>cairde</em> were the trusted kin-allies who carried his interests "
            "outward into the wider world. In raising the bearer to this dignity, We name them "
            "exactly that — a member through whom the clan reaches another."
        ),
        'address_intro': (
            "By Our command, the Privy Council, the Office of the Private Secretary, and the kindred "
            "of Ó Comáin, both within and without the boundaries of the clan's historic seat at "
            "Newhall, do acknowledge and address the bearer henceforth as"
        ),
    },
    'ardchara': {
        'irish': 'Ardchara',
        'pron': 'ARD-khar-uh',
        'english': 'Friend of high standing',
        'threshold': 'five souls',
        'threshold_word': 'fifth',
        'body_voice': 'it hath pleased Us to raise the said member within the clan, from Cara to the dignity hereunder',
        'body_extra': (
            "Ardchara joins the prefix <em>ard-</em> (high, lofty) to <em>cara</em> (friend) — so "
            "the title reads, by its parts, as <em>Friend of high standing</em>. Where Cara names "
            "the friend, Ardchara names the high friend — the clan's recognition that the bearer "
            "carries the work of welcome with particular grace."
        ),
        'address_intro': (
            "By Our express command, the Privy Council, the Office of the Private Secretary, and "
            "the kindred of Ó Comáin, both within and without the boundaries of the clan's historic "
            "seat at Newhall, shall hereafter acknowledge and address the bearer, in the dignity "
            "now conferred, as"
        ),
    },
    'onoir': {
        'irish': 'Onóir',
        'pron': 'UH-nor',
        'english': 'One held in honour',
        'threshold': 'fifteen souls',
        'threshold_word': 'fifteenth',
        'body_voice': 'it hath pleased Us to raise the said member within the clan, from Ardchara to the highest dignity hereunder',
        'body_extra': (
            "Onóir carries the weight of its meaning: where Cara names the friend and Ardchara "
            "the high friend, Onóir names the dignity itself — a member whose contribution has been "
            "marked, and who is held by the Chief and the Herald as one of the clan's standing-bearers. "
            "Few in any generation carry fifteen to the Register; from this raising, the bearer stands "
            "among those most honoured by Clan Ó Comáin."
        ),
        'address_intro': (
            "By Our express command, the Privy Council, the Office of the Private Secretary, and "
            "all the kindred of Ó Comáin, both within and without the boundaries of the clan's "
            "historic seat at Newhall, do acknowledge and address the bearer henceforth, with the "
            "place and standing belonging to that rank, as"
        ),
    },
}


def build(honour_key, recipient_name, surname, date_str='this third day of May, in the year of Our Lord two thousand and twenty-six'):
    h = HONOURS[honour_key]
    sig_html = f'<img src="data:image/png;base64,{sig_b64}" class="sig"/>' if sig_b64 else ''
    address = f"{recipient_name}, {h['irish']} of Ó Comáin"
    out_pdf = f'/mnt/user-data/outputs/clan_o_comain_letters_patent_{honour_key}.pdf'

    html = f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"/>
<style>
  {font_face('EBG', 'EBGaramond-Regular.ttf', 400)}
  {font_face('EBG', 'EBGaramond-Italic.ttf', 400, 'italic')}
  {font_face('EBG', 'EBGaramond-Medium.ttf', 500)}
  {font_face('Jost', 'Jost-Regular.ttf', 400)}
  {font_face('Jost', 'Jost-Medium.ttf', 500)}
  {font_face('Jost', 'Jost-SemiBold.ttf', 600)}

  @page {{ size: A4 portrait; margin: 0; }}
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}

  :root {{
    --ink: #0c1a0c;
    --ink-soft: #2a2418;
    --muted: #5a5246;
    --burgundy: #6a1810;
    --burgundy-dark: #4a0a04;
    --gold: #b8975a;
    --gold-deep: #8c6a2a;
    --gold-faint: rgba(184, 151, 90, 0.45);
    --paper: #fbf8f0;
  }}

  body {{
    width: 210mm; height: 297mm;
    background: var(--paper);
    font-family: 'EBG', serif;
    color: var(--ink);
    position: relative;
    overflow: hidden;
  }}

  /* DECORATIVE BORDER — minimal, double-rule */
  .border-outer {{
    position: absolute;
    inset: 10mm;
    border: 1pt solid var(--gold);
  }}
  .border-inner {{
    position: absolute;
    inset: 12mm;
    border: 0.4pt solid var(--gold-faint);
  }}

  /* TOP BAND — arms centred between two flanking flourishes */
  .top-band {{
    position: absolute;
    top: 14mm;
    left: 0; right: 0;
    text-align: center;
  }}
  .top-band img.arms {{
    width: 54px;
    height: auto;
    display: block;
    margin: 0 auto;
  }}

  /* ISSUING AUTHORITY — red display caps */
  .salutation {{
    position: absolute;
    top: 38mm;
    left: 0; right: 0;
    text-align: center;
  }}
  .sal-eyebrow {{
    font-family: 'Jost', sans-serif;
    font-size: 8pt;
    font-weight: 600;
    letter-spacing: 4pt;
    color: var(--gold-deep);
    text-transform: uppercase;
    margin-bottom: 6pt;
  }}
  .sal-main {{
    font-family: 'EBG', serif;
    font-weight: 400;
    font-size: 22pt;
    color: var(--burgundy);
    letter-spacing: 2pt;
    line-height: 1.15;
    text-transform: uppercase;
    font-style: italic;
  }}
  .sal-rule {{
    margin: 10pt auto 0;
    width: 280pt;
    height: 0.5pt;
    background: linear-gradient(to right, transparent, var(--gold) 25%, var(--gold) 75%, transparent);
  }}

  /* BODY — portrait: tall and narrow */
  .body {{
    position: absolute;
    top: 80mm;
    left: 28mm; right: 28mm;
    bottom: 78mm;
    font-family: 'EBG', serif;
    font-size: 10pt;
    line-height: 1.5;
    color: var(--ink-soft);
    text-align: justify;
  }}

  /* Drop-cap "We" treatment */
  .body-open {{
    margin-bottom: 8pt;
    text-align: left;
  }}
  .we-cap {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-weight: 400;
    font-size: 32pt;
    color: var(--burgundy);
    line-height: 1;
    float: left;
    margin: -2pt 8pt -2pt 0;
  }}

  /* Issuing styling — Chief's full styling rendered as elegant prose block */
  .styling {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 11pt;
    line-height: 1.55;
    color: var(--ink);
  }}
  .styling-name {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-weight: 500;
    font-size: 15pt;
    color: var(--burgundy);
    line-height: 1.15;
    display: block;
    margin-bottom: 3pt;
  }}

  .body p {{
    margin-top: 6pt;
  }}

  .body em {{
    font-style: italic;
    color: var(--burgundy);
  }}

  /* Two-column body — for the explanatory text below the hero */
  .body-cols {{
    display: grid;
    grid-template-columns: 1fr 1fr;
    column-gap: 24pt;
    margin-top: 8pt;
    font-size: 9.5pt;
    line-height: 1.5;
  }}
  .body-col {{
    text-align: justify;
  }}

  /* HERO CONFERRAL — recipient and dignity at PARITY */
  .hero-conferral {{
    margin: 14pt 0;
    padding: 14pt 0;
    border-top: 0.6pt solid var(--gold);
    border-bottom: 0.6pt solid var(--gold);
    text-align: center;
    background: rgba(184, 151, 90, 0.05);
  }}
  .hero-pre {{
    font-family: 'Jost', sans-serif;
    font-size: 7pt;
    font-weight: 600;
    letter-spacing: 4pt;
    color: var(--gold-deep);
    text-transform: uppercase;
    margin-bottom: 10pt;
  }}
  .hero-name {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-weight: 400;
    color: var(--burgundy);
    line-height: 1.12;
    margin-bottom: 8pt;
  }}
  .hero-recipient {{
    display: block;
    font-size: 28pt;
    color: var(--ink);
    margin-bottom: 4pt;
    letter-spacing: 0.4pt;
  }}
  .hero-dignity {{
    display: block;
    font-size: 28pt;
    color: var(--burgundy);
    letter-spacing: 0.4pt;
    line-height: 1.05;
  }}
  .hero-meaning {{
    font-family: 'EBG', serif;
    font-size: 11pt;
    color: var(--ink-soft);
    margin-top: 6pt;
  }}
  .hero-irish {{
    font-style: italic;
    color: var(--ink);
  }}
  .hero-pron {{
    font-style: italic;
    color: var(--muted);
    font-size: 10pt;
  }}
  .hero-english {{
    font-style: italic;
    color: var(--ink-soft);
  }}

  /* DATE LINE — flows inline at end of body */
  .date-line {{
    margin-top: 10pt;
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 9.5pt;
    color: var(--ink-soft);
    text-align: center;
    line-height: 1.5;
  }}

  /* DATE LINE — absolute positioning above foot to avoid overflow */
  .date-line-abs {{
    position: absolute;
    bottom: 70mm;
    left: 28mm; right: 28mm;
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 9.5pt;
    color: var(--ink-soft);
    text-align: center;
    line-height: 1.5;
  }}

  /* FOOT — portrait: signature centre, two seals flanking */
  .foot {{
    position: absolute;
    bottom: 18mm;
    left: 22mm; right: 22mm;
    display: grid;
    grid-template-columns: 1fr 2.4fr 1fr;
    align-items: end;
    gap: 16pt;
  }}

  .foot-left {{
    text-align: center;
  }}
  .foot-left img.seal-img {{
    width: 95px;
    height: auto;
    display: block;
    margin: 0 auto;
  }}
  .foot-left .seal-caption {{
    font-family: 'Jost', sans-serif;
    font-size: 6.5pt;
    font-weight: 600;
    letter-spacing: 2pt;
    color: var(--gold-deep);
    text-transform: uppercase;
    margin-top: 4pt;
  }}

  .foot-centre {{
    text-align: center;
  }}
  .signoff {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 12pt;
    color: var(--burgundy);
    margin-bottom: 1pt;
  }}
  .signoff-gloss {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 8.5pt;
    color: var(--muted);
    margin-bottom: 6pt;
    letter-spacing: 0.4pt;
  }}
  .foot-centre img.sig {{
    width: 170px;
    display: block;
    margin: 0 auto;
  }}
  .foot-centre .sig-rule {{
    width: 240pt;
    height: 0.5pt;
    background: rgba(26, 29, 18, 0.5);
    margin: 2pt auto 0;
  }}
  .foot-centre .sig-name {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 10pt;
    color: var(--ink);
    margin-top: 4pt;
  }}
  .foot-centre .sig-title {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 9.5pt;
    color: var(--muted);
  }}
  .foot-centre .sig-bio {{
    font-family: 'EBG', serif;
    font-style: italic;
    font-size: 7.5pt;
    color: var(--muted);
    margin-top: 5pt;
    letter-spacing: 0.2pt;
  }}

  .foot-right {{
    text-align: center;
  }}
  .foot-right img.seal-img {{
    width: 95px;
    height: auto;
    display: block;
    margin: 0 auto;
  }}
  .foot-right .seal-caption {{
    font-family: 'Jost', sans-serif;
    font-size: 6.5pt;
    font-weight: 600;
    letter-spacing: 2pt;
    color: var(--gold-deep);
    text-transform: uppercase;
    margin-top: 4pt;
  }}

  .sample {{
    position: absolute;
    bottom: 8mm; right: 14mm;
    font-family: 'Jost', sans-serif;
    font-size: 6.5pt;
    color: var(--gold-deep);
    letter-spacing: 3pt;
    border: 0.4pt solid var(--gold-deep);
    padding: 3pt 9pt;
  }}

  .ref {{
    position: absolute;
    bottom: 8mm; left: 14mm;
    font-family: 'Jost', sans-serif;
    font-size: 6.5pt;
    color: var(--muted);
    letter-spacing: 1pt;
  }}
</style></head>
<body>
  <div class="border-outer"></div>
  <div class="border-inner"></div>

  <div class="top-band">
    <img src="data:image/png;base64,{arms_b64}" class="arms"/>
  </div>

  <div class="salutation">
    <div class="sal-eyebrow">Letters Patent · Irish Clan Ó Comáin</div>
    <div class="sal-main">To All and Sundry whom these Presents do or may concern</div>
    <div class="sal-rule"></div>
  </div>

  <div class="body">
    <div class="body-open">
      <span class="we-cap">We</span>
      <span class="styling">
        <span class="styling-name">Taoiseach Fearghas Ó Comáin, The Commane,</span>
        custodian of Killone Abbey and the Holy Well of St John the Baptist,
        of Newhall Estate in the County of Clare
        — and also XXVI Baron of Kinfauns and Hereditary Admiral of the Water of Tay —
        Chief of Ó Comáin, send Greeting.
      </span>
    </div>

    <p>Whereas it hath been represented to Us, by the recommendation of Our Privy Council and the
    Office of the Private Secretary, that <em>{recipient_name}</em>, by act of welcome and allegiance
    to the clan, hath brought {h['threshold']} unto the Register at Newhall — and whereas the labour of
    bringing-others-in is held by Us as a particular grace, deserving of recognition in the keeping
    of the clan — {h['body_voice']}:</p>

    <div class="hero-conferral">
      <div class="hero-pre">In honour now conferred</div>
      <div class="hero-name">
        <span class="hero-recipient">{recipient_name},</span>
        <span class="hero-dignity">{h['irish']} of Ó Comáin</span>
      </div>
      <div class="hero-meaning">
        <span class="hero-irish">{h['irish']}</span>
        &nbsp;&middot;&nbsp;
        <span class="hero-pron">/ {h['pron']} /</span>
        &nbsp;&middot;&nbsp;
        <span class="hero-english">{h['english']}</span>
      </div>
    </div>

    <p>{h['body_extra']}</p>

    <p>{h['address_intro']} <em>{address}</em>.</p>

    <div class="date-line">Given under Our hand and seal at the seat of Ó Comáin,
    {date_str}.</div>
  </div>

  <div class="foot">
    <div class="foot-left">
      <img src="data:image/png;base64,{commane_seal_b64}" class="seal-img"/>
      <div class="seal-caption">Seal of the Chief</div>
    </div>
    <div class="foot-centre">
      <div class="signoff">Le toil an Taoisigh</div>
      <div class="signoff-gloss">— by the will of the Chief —</div>
      {sig_html}
      <div class="sig-rule"></div>
      <div class="sig-name">Fergus Kinfauns, The Commane</div>
      <div class="sig-title">Chief of Ó Comáin</div>
    </div>
    <div class="foot-right">
      <img src="data:image/png;base64,{herald_seal_b64}" class="seal-img"/>
      <div class="seal-caption">Sigillum of the Herald</div>
    </div>
  </div>

  <div class="ref">Cl. Ó.C. · Honours · No. 0001</div>
  <div class="sample">SAMPLE</div>
</body></html>"""

    HTML(string=html).write_pdf(out_pdf)
    print(f'Wrote: {out_pdf} ({os.path.getsize(out_pdf)} bytes)')


if __name__ == '__main__':
    # Generate all three honours for council review
    build(honour_key='cara',     recipient_name='James Comyn',  surname='Comyn')
    build(honour_key='ardchara', recipient_name='Mary O\u2019Sullivan', surname='O\u2019Sullivan')
    build(honour_key='onoir',    recipient_name='Antoin Commane', surname='Commane')
