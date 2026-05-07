// netlify/functions/lib/generate-patent.js
//
// Pure function: takes member/conferral data, returns a PDF buffer for
// a single letters patent. Mirrors the structure of generate-cert.js —
// pdf-lib + @pdf-lib/fontkit, embedded EB Garamond + Jost, no network.
//
// The visual reference is the Python+WeasyPrint generator at
// build-letters-patent.py (kept in the repo for design iteration).
// This file is the production renderer: same layout, same colours,
// same wording, translated from CSS positioning to pdf-lib's
// coordinate-based draw calls.
//
// Coordinate system note: pdf-lib uses bottom-left origin (PDF native).
// CSS uses top-left. All Y values here are computed as
//   y = H - distance_from_top
// to keep the mental model aligned with the design reference.
//
// SPECIMEN watermark: produced ONLY when isSpecimen=true. The Antoin-
// as-social-proof PDF for Email 3B sets this to true. Real per-member
// patents from the conferral pipeline MUST set this to false (the
// default). A real conferred patent with SPECIMEN stamped across it
// would be a "what is this" moment for the recipient.

const { PDFDocument, rgb, PageSizes, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// A4 portrait: 595.28 × 841.89 pt
const [W, H] = PageSizes.A4;

// Colour palette — must match build-letters-patent.py and the website
const C_PAPER     = rgb(0.973, 0.957, 0.925);  // #F8F4EC paper cream
const C_INK       = rgb(0.102, 0.114, 0.071);  // #1A1D12 main text
const C_INK_SOFT  = rgb(0.235, 0.165, 0.102);  // #3C2A1A warmer body text
const C_BURGUNDY  = rgb(0.420, 0.102, 0.063);  // #6B1A10 the conferral colour
const C_GOLD      = rgb(0.722, 0.592, 0.353);  // #B8975A primary gold
const C_GOLD_DEEP = rgb(0.584, 0.459, 0.216);  // #957537 deep gold (eyebrow text)
const C_MUTED     = rgb(0.424, 0.353, 0.290);  // #6C5A4A muted greys

// ── Asset paths — bundled with the function via netlify.toml included_files
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const FONTS_DIR  = path.join(__dirname, '..', '..', '..', 'fonts');

let _fontCache = null;
function loadFontBuffers() {
  if (_fontCache) return _fontCache;
  _fontCache = {
    serifRegular:  fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Regular.ttf')),
    serifItalic:   fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Italic.ttf')),
    serifMedium:   fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Medium.ttf')),
    sansRegular:   fs.readFileSync(path.join(FONTS_DIR, 'Jost-Regular.ttf')),
    sansSemiBold:  fs.readFileSync(path.join(FONTS_DIR, 'Jost-SemiBold.ttf')),
  };
  return _fontCache;
}

let _imageCache = null;
function loadImageBuffers() {
  if (_imageCache) return _imageCache;
  _imageCache = {
    arms:      fs.readFileSync(path.join(ASSETS_DIR, 'coat_of_arms.png')),
    chiefSeal: fs.readFileSync(path.join(ASSETS_DIR, 'the_commane_seal.png')),
    heraldSeal:fs.readFileSync(path.join(ASSETS_DIR, 'the_herald_seal.png')),
    signature: fs.readFileSync(path.join(ASSETS_DIR, 'the_commane_signature.png')),
  };
  return _imageCache;
}

// Per-honour content table — must match the Python reference exactly.
// 'irish' / 'pron' / 'english' appear in the hero conferral block.
// 'degree_word' is rendered as "Cara is the [first/second/third and
// highest] degree of honour conferred by the Chief.".
// 'body_voice' is the closing clause of the Whereas paragraph, joining
// onto "...within the kindred and the favour We bear them,".
// 'body_extra' is the explanatory paragraph after the hero block.
// 'address_intro' is the formal address-formula paragraph.
const HONOURS = {
  cara: {
    irish: 'Cara',
    pron:  'KAR-uh',
    english: 'Friend',
    degree_word: 'first',
    body_voice: 'it hath pleased Us to raise the said member within the clan to the dignity hereunder',
    body_extra: (
      "Cara is the first degree of honour conferred by the Chief. " +
      "It is the older Irish word for a friend — and in the Brehon-law tradition, " +
      "the Chief\u2019s {ITALIC}cairde{/ITALIC} were the trusted kin-allies who carried his interests " +
      "outward into the wider world. In raising the bearer to this dignity, We name them " +
      "as such — a friend of the clan, in the older sense of that word."
    ),
    address_intro: (
      "By Our command, the Privy Council, the Office of the Private Secretary, and the kindred " +
      "of \u00d3 Com\u00e1in, both within and without the boundaries of the clan\u2019s historic seat at " +
      "Newhall, do acknowledge and address the bearer henceforth as"
    ),
  },
  ardchara: {
    irish: 'Ardchara',
    pron:  'ARD-khar-uh',
    english: 'Friend of high standing',
    degree_word: 'second',
    body_voice: 'it hath pleased Us to raise the said member within the clan, from Cara to the dignity hereunder',
    body_extra: (
      "Ardchara is the second degree of honour conferred by the Chief. " +
      "The title joins the prefix {ITALIC}ard-{/ITALIC} (high, lofty) to {ITALIC}cara{/ITALIC} (friend) — so " +
      "by its parts, the title reads as {ITALIC}Friend of high standing{/ITALIC}. Where Cara names " +
      "the friend, Ardchara names the high friend — and the bearer is so named, in the " +
      "particular regard of the Chief and the kindred."
    ),
    address_intro: (
      "By Our express command, the Privy Council, the Office of the Private Secretary, and " +
      "the kindred of \u00d3 Com\u00e1in, both within and without the boundaries of the clan\u2019s historic " +
      "seat at Newhall, shall hereafter acknowledge and address the bearer, in the dignity " +
      "now conferred, as"
    ),
  },
  onoir: {
    irish: 'On\u00f3ir',
    pron:  'UH-nor',
    english: 'One held in honour',
    degree_word: 'third and highest',
    body_voice: 'it hath pleased Us to raise the said member within the clan, from Ardchara to the highest dignity hereunder',
    body_extra: (
      "On\u00f3ir is the third and highest degree of honour conferred by the Chief. " +
      "The title carries the weight of its meaning: where Cara names the friend and Ardchara " +
      "the high friend, On\u00f3ir names the dignity itself — and the bearer is so held, in " +
      "particular regard, among those most honoured by Clan \u00d3 Com\u00e1in."
    ),
    address_intro: (
      "By Our express command, the Privy Council, the Office of the Private Secretary, and " +
      "all the kindred of \u00d3 Com\u00e1in, both within and without the boundaries of the clan\u2019s " +
      "historic seat at Newhall, do acknowledge and address the bearer henceforth, with the " +
      "place and standing belonging to that rank, as"
    ),
  },
};

// ──────────────────────────────────────────────────────────────────────────
// MAIN ENTRY
//
// @param {Object} opts
// @param {string} opts.honourSlug    'cara' | 'ardchara' | 'onoir'
// @param {string} opts.recipientName Recipient full name as it should
//                                    appear on the patent (frozen at
//                                    issuance — never updates if the
//                                    member changes their name later).
// @param {string} opts.dateString    Long-form date e.g. "this third
//                                    day of May, in the year of Our
//                                    Lord two thousand and twenty-six".
// @param {boolean} [opts.isSpecimen] If true, render the diagonal
//                                    SPECIMEN watermark across the
//                                    page. Real conferred patents
//                                    MUST leave this false.
// @returns {Promise<Uint8Array>}
// ──────────────────────────────────────────────────────────────────────────
async function generatePatent({ honourSlug, recipientName, dateString, isSpecimen = false }) {
  const h = HONOURS[honourSlug];
  if (!h) throw new Error(`generatePatent: unknown honourSlug "${honourSlug}"`);
  if (!recipientName) throw new Error('generatePatent: recipientName required');
  if (!dateString) throw new Error('generatePatent: dateString required');

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Letters Patent — ${recipientName}, ${h.irish} of \u00d3 Com\u00e1in`);
  doc.setAuthor('Clan \u00d3 Com\u00e1in');
  doc.setSubject(`Letters patent of raising to the dignity of ${h.irish}`);
  doc.setCreationDate(new Date());

  const page = doc.addPage([W, H]);

  const fb = loadFontBuffers();
  const fonts = {
    serif:        await doc.embedFont(fb.serifRegular,  { subset: false }),
    serifItalic:  await doc.embedFont(fb.serifItalic,   { subset: false }),
    serifMedium:  await doc.embedFont(fb.serifMedium,   { subset: false }),
    sans:         await doc.embedFont(fb.sansRegular,   { subset: false }),
    sansBold:     await doc.embedFont(fb.sansSemiBold,  { subset: false }),
  };

  const ib = loadImageBuffers();
  const images = {
    arms:       await doc.embedPng(ib.arms),
    chiefSeal:  await doc.embedPng(ib.chiefSeal),
    heraldSeal: await doc.embedPng(ib.heraldSeal),
    signature:  await doc.embedPng(ib.signature),
  };

  // Paper background
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C_PAPER });

  // ── TOP HEADER BAND ──────────────────────────────────────────────
  // Arms shield, eyebrow, two-line salutation, gold rule.
  drawTopHeader(page, fonts, images);

  // ── ISSUING AUTHORITY — the "We" drop-cap and styling block ─────
  drawIssuingAuthority(page, fonts);

  // ── BODY — the Whereas paragraph, hero conferral, two body
  //          paragraphs, date line. The wrap helper below handles
  //          word wrapping and inline {ITALIC}...{/ITALIC} markers. ─
  const bodyTopY = drawBodyBlocks(page, fonts, h, recipientName);

  // ── FOOT — sign-off, signature, signature line, two seals ────────
  drawFoot(page, fonts, images);

  // ── WATERMARK (optional) — diagonal SPECIMEN across the page ────
  if (isSpecimen) {
    drawSpecimenWatermark(page, fonts);
  }

  // ── REFERENCE STAMP — bottom-left "Cl. Ó.C. · Honours · No. 0001"
  drawRefStamp(page, fonts);

  return doc.save();
}

// ── HEADER ──────────────────────────────────────────────────────────
function drawTopHeader(page, fonts, images) {
  // Arms shield, ~54px wide, centred at top:14mm-ish (mm conversion: 1mm = 2.835pt)
  const armsW = 54;
  const armsH = armsW * (images.arms.height / images.arms.width);
  page.drawImage(images.arms, {
    x: (W - armsW) / 2,
    y: H - 40 - armsH,
    width: armsW,
    height: armsH,
  });

  // Eyebrow "LETTERS PATENT · IRISH CLAN Ó COMÁIN"
  drawSpacedText(page, {
    text: 'LETTERS PATENT  \u00B7  IRISH CLAN \u00D3 COM\u00C1IN',
    font: fonts.sansBold,
    size: 8,
    color: C_GOLD_DEEP,
    y: H - 130,
    centerX: W / 2,
    letterSpacing: 2.6,
  });

  // Salutation — two lines, italic burgundy serif, centred
  // Line 1: TO ALL WHOM THESE PRESENTS
  // Line 2: DO OR MAY CONCERN
  // letter-spaced 2pt to match the Python reference
  const salSize = 22;
  const salFont = fonts.serifItalic;
  const salColor = C_BURGUNDY;
  drawSpacedText(page, {
    text: 'TO ALL WHOM THESE PRESENTS',
    font: salFont, size: salSize, color: salColor,
    y: H - 158, centerX: W / 2, letterSpacing: 2,
  });
  drawSpacedText(page, {
    text: 'DO OR MAY CONCERN',
    font: salFont, size: salSize, color: salColor,
    y: H - 182, centerX: W / 2, letterSpacing: 2,
  });

  // Gold rule beneath
  const ruleY = H - 200;
  page.drawLine({
    start: { x: W/2 - 140, y: ruleY },
    end:   { x: W/2 + 140, y: ruleY },
    thickness: 0.5,
    color: C_GOLD,
  });
}

// ── ISSUING AUTHORITY ───────────────────────────────────────────────
// "We" giant drop-cap on the left, followed by a flowing styling
// paragraph that wraps naturally. The first line is the chief's
// proper styling (15pt italic burgundy); subsequent lines are
// custodian/seat/parenthetical/office prose at 11pt.
//
// Inline emphasis: Chief of Ó Comáin in burgundy (the conferring office).
// Inline emphasis: name+title on first line in 15pt burgundy.
//
// The drop-cap occupies ~2 body lines of vertical space. We indent
// the first two body lines past the drop-cap, then return to full
// width.
function drawIssuingAuthority(page, fonts) {
  const leftMargin = 28 * 2.835;
  const rightMargin = 28 * 2.835;
  const topY = H - 232;  // moved down ~14pt so the issuing block has more breath above
  const lineH = 14;
  const fullWidth = W - leftMargin - rightMargin;

  // "We" drop-cap — baseline aligned with the chief's name line.
  // Both share y=topY; the cap-height difference (32pt vs 15pt)
  // means the top of 'We' rises high above the name line, which is
  // the correct drop-cap effect. Previously y was topY-18 which put
  // the We baseline level with the body line BELOW the chief's
  // name, making 'We' visually lead into 'custodian' instead of
  // 'Taoiseach'.
  const dropCapWidth = fonts.serifItalic.widthOfTextAtSize('We', 32);
  page.drawText('We', {
    x: leftMargin,
    y: topY,
    size: 32,
    font: fonts.serifItalic,
    color: C_BURGUNDY,
  });

  // Line 1 — name in 15pt italic burgundy (indented past drop-cap)
  const indentX = leftMargin + dropCapWidth + 8;
  page.drawText(safeText('Taoiseach Fearghas \u00d3 Com\u00e1in, The Commane,'), {
    x: indentX,
    y: topY,
    size: 15,
    font: fonts.serifItalic,
    color: C_BURGUNDY,
  });

  // Body text — wraps naturally. First line indents past the drop-cap
  // (drop-cap occupies ~2 vertical body lines); from line 2 onwards,
  // full width.
  //
  // Gap from chief's name line to first body line is 16pt (down from
  // 22pt) — reads as a continuation of the same sentence rather than
  // a paragraph break. The 15pt name + 16pt gap puts the body line
  // baseline ~16pt below the name baseline, which is the natural
  // line-leading for 15pt → 11pt cascade.
  //
  // The text uses inline {ITALIC_BURGUNDY}Chief of Ó Comáin{/ITALIC_BURGUNDY}
  // so the office name appears in the conferring colour.
  const stylingBody = (
    'custodian of Killone Abbey and the Holy Well of St John the Baptist, ' +
    'of Newhall Estate in the County of Clare \u2014 and also XXVI Baron of ' +
    'Kinfauns and Hereditary Admiral of the Water of Tay \u2014 ' +
    '{ITALIC_BURGUNDY}Chief of \u00d3 Com\u00e1in{/ITALIC_BURGUNDY}, send Greeting.'
  );

  const tokens = tokenize(stylingBody);
  // Wrap with two different widths: first line at indented width
  // (pushed past drop-cap), subsequent lines at full width.
  // Wrap with two width values: line 0 of body indented past the
  // drop-cap (along with the chief's name line above, which is drawn
  // separately and also indented), then lines 1+ flow back to full
  // width. The 32pt 'We' drop-cap visually occupies the chief's name
  // line + ONE body line of vertical space — not two — so only one
  // body line needs the indent.
  //
  // Reference layout (matches WeasyPrint): 2 visual lines indented
  // (Taoiseach... + custodian...), 2 visual lines at full width
  // (County of Clare... + Water of Tay... Chief of Ó Comáin, send
  // Greeting.).
  const indentedW = fullWidth - (dropCapWidth + 8);
  const lines = wrapTokensVariableWidth(
    tokens, fonts.serifItalic, fonts.serifItalic, 11,
    [indentedW, fullWidth]  // line 0: indented; lines 1+: full
  );

  let y = topY - 16;  // tighter continuation gap (was 22)
  for (let i = 0; i < lines.length; i++) {
    // Body line 0 stays indented past the drop-cap; from body line 1
    // onwards, return to the full-width left margin.
    const x = (i === 0) ? indentX : leftMargin;
    const w = (i === 0) ? indentedW : fullWidth;
    drawLineTokens(page, lines[i], fonts.serifItalic, fonts.serifItalic, 11,
      C_INK, C_BURGUNDY, x, y, w, false);
    y -= lineH;
  }
}

// ── BODY BLOCKS (Whereas + hero + body_extra + address + date) ──────
//
// Returns Y coordinate at which the body finishes (for layout debug).
//
// Y coordinates are computed top-down from a startY, decrementing
// after each block. Every block is responsible for declaring its own
// height so the next block knows where to begin.
function drawBodyBlocks(page, fonts, h, recipientName) {
  const leftMargin = 28 * 2.835;   // 28mm
  const rightMargin = 28 * 2.835;
  const lineH = 14;                 // 10pt × 1.4 line-height
  const bodyW = W - leftMargin - rightMargin;

  let y = H - 310;  // start below the issuing authority — ~22pt below the last styling line

  // ── WHEREAS PARAGRAPH ─────────────────────────────────────────
  // "Whereas it hath pleased Us, by the recommendation of Our
  // Privy Council and the Office of the Private Secretary, and in
  // recognition of the standing of <recipientName> within the
  // kindred and the favour We bear them, <body_voice>:"
  //
  // This wording is from the signed-off reference. The repetition
  // of "it hath pleased Us" (once at the head, once before the
  // dignity) was discussed and kept — the warmth of the reference
  // (the Chief is doing the raising in PERSONAL recognition) is
  // worth more than tidiness. The earlier "represented to Us...
  // standeth in good favour" wording read bureaucratic.
  //
  // Recipient name is in italic burgundy mid-sentence.
  const whereas = (
    `Whereas it hath pleased Us, by the recommendation of Our Privy Council and the Office of the ` +
    `Private Secretary, and in recognition of the standing of {ITALIC_BURGUNDY}${recipientName}{/ITALIC_BURGUNDY} within the ` +
    `kindred and the favour We bear them, ${h.body_voice}:`
  );
  y = drawWrappedJustified(page, {
    text: whereas,
    font: fonts.serif,
    italicFont: fonts.serifItalic,
    size: 10,
    color: C_INK_SOFT,
    burgundyColor: C_BURGUNDY,
    x: leftMargin,
    y,
    width: bodyW,
    lineHeight: lineH,
  });

  // ── HERO CONFERRAL ────────────────────────────────────────────
  y -= 20;  // gap above hero

  // ── HERO CONFERRAL BLOCK with INSET BACKGROUND CONTAINER ──────
  //
  // The reference renders the hero conferral as a deed-pasted-in:
  // a slightly-darker beige rectangle behind the eyebrow + name +
  // dignity + pronunciation, framed top and bottom by gold rules
  // that extend slightly beyond the inset edges. Without the
  // background container the conferral reads as plain text
  // between rules and loses the deed-of-grant presentation.
  //
  // We draw the rectangle FIRST (behind), then the rules, then
  // the text content on top. This requires computing the block
  // height upfront so the rect dimensions are known.
  //
  // Layout from top of block (matches reference breath):
  //   topRule:       0pt
  //   eyebrow:       24pt below rule
  //   name:          eyebrow + 36pt (was 22, too cramped)
  //   dignity:       name + 38pt (was 30)
  //   pron line:     dignity + 28pt (was 24)
  //   bottomRule:    pron + 24pt (was 14)
  // Block reads as a deed presented with proper breath, not
  // text squashed between rules.

  const heroEyebrowGap = 24;
  const heroNameGap    = 36;
  const heroDignityGap = 38;
  const heroPronGap    = 28;
  const heroBottomGap  = 24;
  const heroBlockHeight = heroEyebrowGap + heroNameGap + heroDignityGap + heroPronGap + heroBottomGap;

  // y currently points to where the top gold rule will sit. The
  // background rect sits BETWEEN the top and bottom rules.
  const heroTopY    = y;
  const heroBottomY = y - heroBlockHeight;

  // Inset background: slightly inset from page text width so the
  // rules visibly extend beyond the rect edges. Slightly more
  // saturated beige than the paper colour.
  const insetMargin = 6;  // inset from leftMargin/rightMargin
  const C_INSET_BEIGE = rgb(0.953, 0.937, 0.870);  // slightly darker than paper
  page.drawRectangle({
    x: leftMargin + insetMargin,
    y: heroBottomY,
    width: (W - leftMargin - rightMargin) - 2 * insetMargin,
    height: heroBlockHeight,
    color: C_INSET_BEIGE,
  });

  // Top gold rule (drawn ABOVE the inset, at the page text width)
  page.drawLine({
    start: { x: leftMargin, y: heroTopY },
    end:   { x: W - rightMargin, y: heroTopY },
    thickness: 0.6,
    color: C_GOLD,
  });
  y -= heroEyebrowGap;

  // "IN HONOUR NOW CONFERRED" eyebrow
  drawSpacedText(page, {
    text: 'IN HONOUR NOW CONFERRED',
    font: fonts.sansBold,
    size: 7,
    color: C_GOLD_DEEP,
    y,
    centerX: W / 2,
    letterSpacing: 2.6,
  });
  y -= heroNameGap;

  // Recipient name (28pt italic, ink) — centred
  drawCentered(page, `${recipientName},`, fonts.serifItalic, 28, C_INK, y, W / 2);
  y -= heroDignityGap;

  // Dignity line (28pt italic, burgundy) — centred
  drawCentered(page, `${h.irish} of \u00d3 Com\u00e1in`, fonts.serifItalic, 28, C_BURGUNDY, y, W / 2);
  y -= heroPronGap;

  // Pronunciation key — "Cara · /KAR-uh/ · Friend"
  const pronLine = `${h.irish}  \u00b7  /${h.pron}/  \u00b7  ${h.english}`;
  drawCentered(page, pronLine, fonts.serifItalic, 11, C_MUTED, y, W / 2);
  y -= heroBottomGap;

  // Bottom gold rule
  page.drawLine({
    start: { x: leftMargin, y },
    end:   { x: W - rightMargin, y },
    thickness: 0.6,
    color: C_GOLD,
  });
  y -= 18;

  // ── BODY EXTRA paragraph ──────────────────────────────────────
  y = drawWrappedJustified(page, {
    text: h.body_extra,
    font: fonts.serif,
    italicFont: fonts.serifItalic,
    size: 10,
    color: C_INK_SOFT,
    burgundyColor: C_BURGUNDY,
    x: leftMargin,
    y,
    width: bodyW,
    lineHeight: lineH,
  });

  // ── ADDRESS-FORMULA paragraph ─────────────────────────────────
  y -= 4;
  const addressFull = `${h.address_intro} {ITALIC_BURGUNDY}${recipientName}, ${h.irish} of \u00d3 Com\u00e1in{/ITALIC_BURGUNDY}.`;
  y = drawWrappedJustified(page, {
    text: addressFull,
    font: fonts.serif,
    italicFont: fonts.serifItalic,
    size: 10,
    color: C_INK_SOFT,
    burgundyColor: C_BURGUNDY,
    x: leftMargin,
    y,
    width: bodyW,
    lineHeight: lineH,
  });

  // ── DATE LINE ─────────────────────────────────────────────────
  // Positioned ABSOLUTELY above the foot sign-off. The foot's
  // 'Le toil an Taoisigh' line sits at footBottom+100 (= 51+100 = 151
  // points up from page bottom). The date line sits 30pt above that
  // for proper breath. Foot stays anchored independently.
  //
  // (Earlier iterations positioned the date line relatively from the
  // address paragraph, but with the v13 hero-block expansion the
  // body got tall enough that relative positioning collided with
  // the foot. Absolute positioning is the right choice for any
  // element above the foot — the body grew but the foot didn't.)
  const dateY = (18 * 2.835) + 130;
  const dateText = `Given under Our hand and seal at the seat of \u00d3 Com\u00e1in, this third day of May, in the year of Our Lord two thousand and twenty-six.`;
  drawWrappedCentered(page, {
    text: dateText,
    font: fonts.serifItalic,
    size: 9.5,
    color: C_INK_SOFT,
    centerX: W / 2,
    y: dateY,
    width: bodyW * 0.85,
    lineHeight: 13,
  });

  return y;
}

// ── FOOT — sign-off, signature, two seals ───────────────────────────
function drawFoot(page, fonts, images) {
  // Three columns: left seal, centre signature, right seal
  // Anchored at bottom 18mm of page (~51pt)

  const footBottom = 18 * 2.835;   // 18mm
  const sealW = 100;               // both seals at 100pt

  // LEFT — Chief's red wax seal
  const leftCenterX = 22 * 2.835 + sealW/2 + 10;  // approx 22mm + half-seal
  const chiefSealRatio = images.chiefSeal.height / images.chiefSeal.width;
  page.drawImage(images.chiefSeal, {
    x: leftCenterX - sealW/2,
    y: footBottom + 16,
    width: sealW,
    height: sealW * chiefSealRatio,
  });
  drawSpacedText(page, {
    text: 'SEAL OF THE CHIEF',
    font: fonts.sansBold,
    size: 6.5,
    color: C_GOLD_DEEP,
    y: footBottom + 4,
    centerX: leftCenterX,
    letterSpacing: 1.8,
  });

  // CENTRE — sign-off above signature
  const centerX = W / 2;

  // "Le toil an Taoisigh" italic burgundy
  drawCentered(page, 'Le toil an Taoisigh', fonts.serifItalic, 12, C_BURGUNDY, footBottom + 100, centerX);
  // "— by the will of the Chief —" italic muted
  drawCentered(page, '\u2014 by the will of the Chief \u2014', fonts.serifItalic, 8.5, C_MUTED, footBottom + 86, centerX);

  // Signature image
  const sigW = 170;
  const sigRatio = images.signature.height / images.signature.width;
  const sigH = sigW * sigRatio;
  page.drawImage(images.signature, {
    x: centerX - sigW/2,
    y: footBottom + 60,
    width: sigW,
    height: sigH,
  });

  // Signature rule beneath
  page.drawLine({
    start: { x: centerX - 120, y: footBottom + 56 },
    end:   { x: centerX + 120, y: footBottom + 56 },
    thickness: 0.5,
    color: rgb(0.102, 0.114, 0.071),
  });

  // Signature name + title beneath the rule
  drawCentered(page, 'Fergus Kinfauns, The Commane', fonts.serifItalic, 10, C_INK, footBottom + 42, centerX);
  drawCentered(page, 'Chief of \u00d3 Com\u00e1in', fonts.serifItalic, 9.5, C_MUTED, footBottom + 28, centerX);

  // RIGHT — Herald (clan) seal
  const rightCenterX = W - 22 * 2.835 - sealW/2 - 10;
  const heraldSealRatio = images.heraldSeal.height / images.heraldSeal.width;
  page.drawImage(images.heraldSeal, {
    x: rightCenterX - sealW/2,
    y: footBottom + 16,
    width: sealW,
    height: sealW * heraldSealRatio,
  });
  drawSpacedText(page, {
    text: 'SIGILLUM OF THE CLAN',
    font: fonts.sansBold,
    size: 6.5,
    color: C_GOLD_DEEP,
    y: footBottom + 4,
    centerX: rightCenterX,
    letterSpacing: 1.8,
  });
}

// ── REFERENCE STAMP ─────────────────────────────────────────────────
function drawRefStamp(page, fonts) {
  drawSpacedText(page, {
    text: 'Cl. \u00d3.C. \u00B7 Honours \u00B7 No. 0001',
    font: fonts.sans,
    size: 6.5,
    color: C_MUTED,
    y: 20,
    centerX: 14 * 2.835 + 60,  // bottom-left, ~14mm in
    letterSpacing: 0.6,
  });
}

// ── SPECIMEN WATERMARK ──────────────────────────────────────────────
// Diagonal across the page in burgundy at ~10% opacity, rotated -30°.
// Only rendered when isSpecimen=true.
//
// pdf-lib's drawText rotates the entire text string around its origin
// (the x,y point passed in). We compute an origin such that the
// rotated text is visually centred on the page.
function drawSpecimenWatermark(page, fonts) {
  const text = 'SPECIMEN';
  const size = 90;  // smaller so the rotated text fits within the page
  const font = fonts.serifItalic;
  const angle = -30;

  // Width of text at this size
  const textW = font.widthOfTextAtSize(text, size);
  // Approximate text height (cap-height + a bit) for vertical centring
  const textH = size * 0.7;

  // pdf-lib rotates around the text's origin point (lower-left corner
  // of the first glyph). To visually centre the rotated text on the
  // page, we compute the origin offset by half the rotated text's
  // bounding box from the page centre.
  const cx = W / 2;
  const cy = H / 2;
  const rad = (angle * Math.PI) / 180;
  // Offset from origin to text-centre, in unrotated coords
  const offsetX = textW / 2;
  const offsetY = textH / 2;
  // Rotate that offset by `angle` to find where the text-centre would
  // land if we drew at (cx, cy); then subtract to get the origin that
  // puts the text-centre exactly at (cx, cy).
  const rotatedOffsetX = offsetX * Math.cos(rad) - offsetY * Math.sin(rad);
  const rotatedOffsetY = offsetX * Math.sin(rad) + offsetY * Math.cos(rad);
  const originX = cx - rotatedOffsetX;
  const originY = cy - rotatedOffsetY;

  page.drawText(text, {
    x: originX,
    y: originY,
    size,
    font,
    color: C_BURGUNDY,
    opacity: 0.10,
    rotate: degrees(angle),
  });
}

// ──────────────────────────────────────────────────────────────────────────
// LAYOUT HELPERS
// ──────────────────────────────────────────────────────────────────────────

// Substitute the common Latin ligatures for their Unicode precomposed
// glyphs. EB Garamond + pdf-lib renders 'fi' / 'fl' / 'ffi' / 'ffl' as
// broken kerning (gaps appear between letters); the precomposed glyphs
// (U+FB00..U+FB04) render as a single ligature and look correct.
// Apply at draw time; never store these in source text (they break
// search/copy in some PDF readers if the precomposed glyph isn't
// recognised). Order matters — substitute longer sequences first.
function safeText(text) {
  return text
    .replace(/ffi/g, '\uFB03')
    .replace(/ffl/g, '\uFB04')
    .replace(/fi/g,  '\uFB01')
    .replace(/fl/g,  '\uFB02')
    .replace(/ff/g,  '\uFB00');
}

// Centred text at a given Y. (Mirrors generate-cert.js helper.)
function drawCentered(page, text, font, size, color, y, centerX) {
  const safe = safeText(text);
  const w = font.widthOfTextAtSize(safe, size);
  page.drawText(safe, { x: centerX - w/2, y, size, font, color });
}

// Letter-spaced centred text. (Mirrors generate-cert.js helper.)
function drawSpacedText(page, { text, font, size, color, y, centerX, letterSpacing }) {
  const chars = safeText(text).split('');
  const charWidths = chars.map(c => font.widthOfTextAtSize(c, size));
  const totalWidth = charWidths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  let x = centerX - totalWidth / 2;
  chars.forEach((c, i) => {
    page.drawText(c, { x, y, size, font, color });
    x += charWidths[i] + letterSpacing;
  });
}

// ── PARAGRAPH WRAP HELPERS ──────────────────────────────────────────
//
// pdf-lib has no native paragraph-wrap. We tokenise the text into
// segments (with inline {ITALIC_BURGUNDY}...{/ITALIC_BURGUNDY} markers
// for emphasis spans), then greedy-fill lines. For justified text we
// distribute extra space across word gaps on each line except the
// last.
//
// Marker convention (kept simple — no nesting):
//   {ITALIC_BURGUNDY}xxx{/ITALIC_BURGUNDY}  → italic burgundy
//   {ITALIC}xxx{/ITALIC}                    → italic, same colour as
//                                             the surrounding text
//
// Returns: the Y coordinate at which the paragraph ends (so the
// caller can decrement y for the next block).

// Tokenise text-with-markers into a flat list of {text, isItalic, isBurgundy}
function tokenize(input) {
  const tokens = [];
  // Split on marker boundaries
  const parts = input.split(/(\{ITALIC_BURGUNDY\}|\{\/ITALIC_BURGUNDY\}|\{ITALIC\}|\{\/ITALIC\})/);
  let italic = false;
  let burgundy = false;
  for (const part of parts) {
    if (part === '{ITALIC_BURGUNDY}') { italic = true; burgundy = true; continue; }
    if (part === '{/ITALIC_BURGUNDY}') { italic = false; burgundy = false; continue; }
    if (part === '{ITALIC}') { italic = true; continue; }
    if (part === '{/ITALIC}') { italic = false; continue; }
    if (!part) continue;
    // Split into words+spaces preserving order
    const words = part.match(/\S+|\s+/g) || [];
    for (const w of words) {
      tokens.push({ text: w, italic, burgundy });
    }
  }
  return tokens;
}

// Compute width of a token under the given font/size
function tokenWidth(token, font, italicFont, size) {
  const f = token.italic ? italicFont : font;
  return f.widthOfTextAtSize(token.text, size);
}

// Greedy-wrap tokens into lines that fit within `width`
function wrapTokens(tokens, font, italicFont, size, width) {
  const lines = [];
  let current = [];
  let currentWidth = 0;
  for (const tok of tokens) {
    const w = tokenWidth(tok, font, italicFont, size);
    // If token is whitespace and we're at line start, skip it
    if (/^\s+$/.test(tok.text) && current.length === 0) continue;
    if (currentWidth + w > width && current.length > 0) {
      // Trim trailing whitespace from current line, push, start new
      while (current.length && /^\s+$/.test(current[current.length-1].text)) {
        currentWidth -= tokenWidth(current.pop(), font, italicFont, size);
      }
      lines.push(current);
      current = [];
      currentWidth = 0;
      // Skip leading whitespace on new line
      if (/^\s+$/.test(tok.text)) continue;
    }
    current.push(tok);
    currentWidth += w;
  }
  // Flush last line (also trim trailing whitespace)
  while (current.length && /^\s+$/.test(current[current.length-1].text)) {
    current.pop();
  }
  if (current.length) lines.push(current);
  return lines;
}

// Like wrapTokens but with per-line width. widths[i] is the width
// allowed for line i; the last value is reused for any line beyond.
// Useful for blocks where line 0 is indented past a drop-cap and
// subsequent lines span the full width.
function wrapTokensVariableWidth(tokens, font, italicFont, size, widths) {
  const lines = [];
  let current = [];
  let currentWidth = 0;
  const widthFor = (i) => widths[Math.min(i, widths.length - 1)];
  for (const tok of tokens) {
    const w = tokenWidth(tok, font, italicFont, size);
    if (/^\s+$/.test(tok.text) && current.length === 0) continue;
    if (currentWidth + w > widthFor(lines.length) && current.length > 0) {
      while (current.length && /^\s+$/.test(current[current.length-1].text)) {
        currentWidth -= tokenWidth(current.pop(), font, italicFont, size);
      }
      lines.push(current);
      current = [];
      currentWidth = 0;
      if (/^\s+$/.test(tok.text)) continue;
    }
    current.push(tok);
    currentWidth += w;
  }
  while (current.length && /^\s+$/.test(current[current.length-1].text)) {
    current.pop();
  }
  if (current.length) lines.push(current);
  return lines;
}

// Draw a single line of tokens with optional justification
// (extra space distributed across inter-word gaps).
function drawLineTokens(page, line, font, italicFont, size, color, burgundyColor, x, y, lineWidth, justify) {
  if (line.length === 0) return;

  // Compute natural width and count of whitespace tokens
  let naturalWidth = 0;
  let spaceCount = 0;
  for (const tok of line) {
    naturalWidth += tokenWidth(tok, font, italicFont, size);
    if (/^\s+$/.test(tok.text)) spaceCount++;
  }

  // If justifying and there's room and there are spaces to expand,
  // compute extra-per-space.
  const extraPerSpace = (justify && spaceCount > 0)
    ? (lineWidth - naturalWidth) / spaceCount
    : 0;

  let cursorX = x;
  for (const tok of line) {
    const isSpace = /^\s+$/.test(tok.text);
    const f = tok.italic ? italicFont : font;
    const c = tok.burgundy ? burgundyColor : color;
    if (isSpace) {
      // Don't draw whitespace; just advance cursor
      cursorX += tokenWidth(tok, font, italicFont, size) + extraPerSpace;
    } else {
      page.drawText(safeText(tok.text), { x: cursorX, y, size, font: f, color: c });
      cursorX += tokenWidth(tok, font, italicFont, size);
    }
  }
}

// Justified-paragraph wrapper.
// All lines except the last are justified; the last line is left-aligned.
function drawWrappedJustified(page, { text, font, italicFont, size, color, burgundyColor, x, y, width, lineHeight }) {
  const tokens = tokenize(text);
  const lines = wrapTokens(tokens, font, italicFont, size, width);
  let cursorY = y;
  for (let i = 0; i < lines.length; i++) {
    const isLast = (i === lines.length - 1);
    drawLineTokens(page, lines[i], font, italicFont, size, color, burgundyColor, x, cursorY, width, !isLast);
    cursorY -= lineHeight;
  }
  return cursorY;
}

// Centred-paragraph wrapper (for the date line).
function drawWrappedCentered(page, { text, font, size, color, centerX, y, width, lineHeight }) {
  const tokens = tokenize(text);
  // For centred wrapping we don't need italic-distinction; treat all tokens
  // as the single font.
  const lines = wrapTokens(tokens, font, font, size, width);
  let cursorY = y;
  for (const line of lines) {
    let lineWidth = 0;
    for (const tok of line) lineWidth += tokenWidth(tok, font, font, size);
    let cursorX = centerX - lineWidth / 2;
    for (const tok of line) {
      if (!/^\s+$/.test(tok.text)) {
        page.drawText(safeText(tok.text), { x: cursorX, y: cursorY, size, font, color });
      }
      cursorX += tokenWidth(tok, font, font, size);
    }
    cursorY -= lineHeight;
  }
  return cursorY;
}

module.exports = {
  generatePatent,
  HONOURS,  // exported for tests/inspection
};
