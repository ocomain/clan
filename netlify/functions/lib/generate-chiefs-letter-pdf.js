// netlify/functions/lib/generate-chiefs-letter-pdf.js
//
// Generates the Chief's welcome letter as a PDF, personalised with
// the recipient's first name. Used by Email 2 in the post-signup
// lifecycle (sendChiefPersonalLetter in post-signup-email.js).
//
// VERTICAL RHYTHM (rev 2 — 5 May 2026):
//
//   The previous version cramped all the header elements into the
//   top ~120pt and left the bottom half of the page sparse, with
//   the footer floating in empty space. This redesign distributes
//   the page properly across the A4 canvas:
//
//   ┌──────────────────────────────────────────────┐ y=792 (top)
//   │  margin                                      │
//   │  ┌────────────────────────────────────────┐  │ y=742
//   │  │ HEADER ZONE — 230pt                    │  │
//   │  │   arms (80pt)                          │  │
//   │  │   'CLAN Ó COMÁIN' eyebrow              │  │
//   │  │   'An Ancient Gaelic Royal House'      │  │
//   │  │   decorative gold rule with diamond    │  │
//   │  │   'FROM THE DESK OF THE CHIEF'         │  │
//   │  │   'NEWHALL ESTATE · COUNTY CLARE…'     │  │
//   │  │   thin gold divider                    │  │
//   │  ├────────────────────────────────────────┤  │ y=512
//   │  │ BODY ZONE — ~370pt                     │  │
//   │  │   [coat-of-arms watermark behind]      │  │
//   │  │   Dear [Firstname],                    │  │
//   │  │   [4 body paragraphs]                  │  │
//   │  │   Slán go fóill — (goodbye for now)    │  │
//   │  │   [signature image]                    │  │
//   │  │   Fergus Kinfauns, The Commane         │  │
//   │  │   Chief of Ó Comáin                    │  │
//   │  │           [chancery stamp overlapping] │  │
//   │  ├────────────────────────────────────────┤  │ y=142
//   │  │ PS ZONE — 70pt                         │  │
//   │  │   ┃ P.S.                               │  │
//   │  │   ┃ "Know someone who belongs..."      │  │
//   │  ├────────────────────────────────────────┤  │ y=72
//   │  │ FOOTER ZONE — 60pt                     │  │
//   │  │   gold mini-rule with diamond          │  │
//   │  │   'Caithfidh an stair...' italic motto │  │
//   │  └────────────────────────────────────────┘  │
//   │  margin                                      │
//   └──────────────────────────────────────────────┘ y=0 (bottom)
//
// PS POSITION — postscripts come AFTER the signature in real
// correspondence (the literal meaning of 'post script'). Restored
// to its natural position.
//
// WATERMARK — restored. PDF lets us draw the watermark first (low
// opacity) with the body text drawn on top, without any of the
// email-client layering bugs that forced its removal from HTML.
//
// Same architecture as generate-cert.js — pdf-lib + @pdf-lib/fontkit
// + bundled EB Garamond fonts. Pure function. Safe to invoke per
// recipient on every send.

const { PDFDocument, rgb, PageSizes, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// A4 portrait
const [W, H] = PageSizes.A4;

// Colour palette — matches generate-cert.js for cross-asset coherence.
const C_INK    = rgb(0.102, 0.102, 0.102);  // #1A1A1A  body text
const C_GOLD   = rgb(0.722, 0.592, 0.353);  // #B8975A  rule colour
const C_GOLD_D = rgb(0.545, 0.435, 0.196);  // #8B6F32  eyebrow
const C_GOLD_M = rgb(0.467, 0.376, 0.169);  // #776030  from-the-desk
const C_GOLD_L = rgb(0.353, 0.290, 0.184);  // #5A4A2F  address line
const C_MUTED  = rgb(0.424, 0.353, 0.290);  // #6C5A4A  subtitle
const C_PS_INK = rgb(0.227, 0.290, 0.227);  // #3A4A3A  PS italic
const C_PAPER  = rgb(0.980, 0.957, 0.902);  // #FAF4E6  cream paper

// Font cache — same convention as generate-cert.js. Loaded once per
// function instance, kept warm across invocations.
const FONTS_DIR = path.join(__dirname, '..', '..', '..', 'fonts');
let _fontCache = null;
function loadFontBuffers() {
  if (_fontCache) return _fontCache;
  _fontCache = {
    serifRegular: fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Regular.ttf')),
    serifItalic:  fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Italic.ttf')),
    serifMedium:  fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Medium.ttf')),
    sansRegular:  fs.readFileSync(path.join(FONTS_DIR, 'Jost-Regular.ttf')),
    sansSemiBold: fs.readFileSync(path.join(FONTS_DIR, 'Jost-SemiBold.ttf')),
  };
  return _fontCache;
}

// Asset cache — coat of arms, signature, chancery stamp PNGs.
// Loaded from netlify/functions/assets/ to match the cert generator
// convention. The /assets/ glob is in netlify.toml's included_files
// so these ship with the function bundle.
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
let _assetCache = null;
function loadAssetBuffers() {
  if (_assetCache) return _assetCache;
  _assetCache = {
    coatOfArms: fs.readFileSync(path.join(ASSETS_DIR, 'coat_of_arms.png')),
    signature:  fs.readFileSync(path.join(ASSETS_DIR, 'the_commane_signature.png')),
    chancerySeal: fs.readFileSync(path.join(ASSETS_DIR, 'the_commane_seal.png')),
  };
  return _assetCache;
}

// Wrap text into lines that fit a given width at a given font size.
function wrapTextToLines(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const candidate = currentLine ? currentLine + ' ' + word : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

// Draw a centred letter-spaced run of text — each character placed
// individually so we approximate CSS letter-spacing.
function drawSpacedTextCentered(page, { text, font, size, color, y, centerX, letterSpacing = 0 }) {
  const chars = text.split('');
  const charWidths = chars.map(c => font.widthOfTextAtSize(c, size));
  const totalWidth = charWidths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  let x = centerX - totalWidth / 2;
  for (let i = 0; i < chars.length; i++) {
    page.drawText(chars[i], { x, y, size, font, color });
    x += charWidths[i] + letterSpacing;
  }
}

// Small gold diamond ornament (rotated square).
function drawGoldDiamond(page, cx, cy, size = 3) {
  page.drawRectangle({
    x: cx - size,
    y: cy - size,
    width: size * 2,
    height: size * 2,
    color: C_GOLD,
    rotate: degrees(45),
  });
}

/**
 * Generate the Chief's welcome letter PDF.
 *
 * @param {Object} opts
 * @param {string} opts.addressForm  - the title-bearing form-of-address
 *                                     for the salutation. e.g. 'Cara Aoife'
 *                                     for a Cara, 'Onóir James' for an
 *                                     Onóir, plain 'Aoife' if no title.
 *                                     The Chief addresses titled members
 *                                     by their dignity in formal
 *                                     correspondence (per honours.html).
 *                                     Caller should compute via
 *                                     addressFormOf(member) in the
 *                                     post-signup-email lib, which reads
 *                                     sponsor_titles_awarded and applies
 *                                     'higher is taken up'.
 * @returns {Promise<Uint8Array>}     PDF bytes
 */
async function generateChiefsLetterPdf({ addressForm }) {
  addressForm = (addressForm || 'friend').trim();

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle('A letter from the Chief of Clan Ó Comáin');
  doc.setAuthor('Fergus Kinfauns, The Commane — Chief of Clan Ó Comáin');
  doc.setSubject('Welcome letter from the Chief');
  doc.setCreationDate(new Date());

  const page = doc.addPage([W, H]);

  const fb = loadFontBuffers();
  const fontSerif       = await doc.embedFont(fb.serifRegular,  { subset: false });
  const fontSerifItalic = await doc.embedFont(fb.serifItalic,   { subset: false });
  const fontSerifMedium = await doc.embedFont(fb.serifMedium,   { subset: false });
  const fontSans        = await doc.embedFont(fb.sansRegular,   { subset: false });
  const fontSansBold    = await doc.embedFont(fb.sansSemiBold,  { subset: false });

  const ab = loadAssetBuffers();
  const arms = await doc.embedPng(ab.coatOfArms);
  const signature = await doc.embedPng(ab.signature);
  const stamp = await doc.embedPng(ab.chancerySeal);

  // ─────────── BACKGROUND + FRAME ───────────
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C_PAPER });

  // Generous outer margin (50pt) gives the letterhead the breathing
  // room a real Kensington-style letter has.
  const margin = 50;

  // Double gold-rule frame — thin outer, slightly thicker inner.
  page.drawRectangle({
    x: margin, y: margin, width: W - 2*margin, height: H - 2*margin,
    borderColor: C_GOLD, borderWidth: 0.5,
  });
  page.drawRectangle({
    x: margin + 8, y: margin + 8,
    width: W - 2*(margin + 8), height: H - 2*(margin + 8),
    borderColor: C_GOLD, borderWidth: 1.2,
  });

  // ─────────── WATERMARK ───────────
  // Drawn FIRST so the body text sits cleanly on top. Faint coat-of-arms
  // behind the body, slightly below page-centre. Opacity 0.06 — visible
  // but doesn't compete with body text. This is the real letterhead
  // aesthetic that wasn't possible in the HTML version.
  const watermarkSize = 320;
  const watermarkH = watermarkSize * (arms.height / arms.width);
  page.drawImage(arms, {
    x: (W - watermarkSize) / 2,
    y: (H - watermarkH) / 2 - 40,
    width: watermarkSize,
    height: watermarkH,
    opacity: 0.06,
  });

  // ─────────── HEADER ZONE — 230pt ───────────
  // Generous breathing room. The letterhead reads as a real masthead,
  // not a compressed strip.
  const headerTop = H - margin - 30;

  // Arms — larger this time (80pt vs previous 56pt). Anchors the masthead.
  const armsW = 80;
  const armsHpt = armsW * (arms.height / arms.width);
  page.drawImage(arms, {
    x: (W - armsW) / 2,
    y: headerTop - armsHpt,
    width: armsW,
    height: armsHpt,
  });

  // 'CLAN Ó COMÁIN' eyebrow — sans-serif gold caps, generous tracking.
  drawSpacedTextCentered(page, {
    text: 'CLAN Ó COMÁIN',
    font: fontSansBold,
    size: 11,
    color: C_GOLD_D,
    y: headerTop - armsHpt - 24,
    centerX: W / 2,
    letterSpacing: 3.0,
  });

  // 'An Ancient Gaelic Royal House' — serif italic subline.
  const subline = 'An Ancient Gaelic Royal House';
  const sublineSize = 13;
  const sublineWidth = fontSerifItalic.widthOfTextAtSize(subline, sublineSize);
  page.drawText(subline, {
    x: (W - sublineWidth) / 2,
    y: headerTop - armsHpt - 44,
    size: sublineSize,
    font: fontSerifItalic,
    color: C_MUTED,
  });

  // Decorative gold rule with diamond — wider than before so it reads
  // as an actual masthead element.
  const ruleY = headerTop - armsHpt - 70;
  page.drawLine({
    start: { x: W/2 - 70, y: ruleY },
    end:   { x: W/2 - 14, y: ruleY },
    thickness: 0.7,
    color: C_GOLD,
  });
  page.drawLine({
    start: { x: W/2 + 14, y: ruleY },
    end:   { x: W/2 + 70, y: ruleY },
    thickness: 0.7,
    color: C_GOLD,
  });
  drawGoldDiamond(page, W/2, ruleY, 3.5);

  // 'FROM THE DESK OF THE CHIEF' — small caps eyebrow.
  drawSpacedTextCentered(page, {
    text: 'FROM THE DESK OF THE CHIEF',
    font: fontSansBold,
    size: 9,
    color: C_GOLD_M,
    y: ruleY - 22,
    centerX: W / 2,
    letterSpacing: 2.0,
  });

  // 'NEWHALL ESTATE · COUNTY CLARE · IRELAND' — slightly smaller.
  drawSpacedTextCentered(page, {
    text: 'NEWHALL ESTATE  ·  COUNTY CLARE  ·  IRELAND',
    font: fontSans,
    size: 8,
    color: C_GOLD_L,
    y: ruleY - 36,
    centerX: W / 2,
    letterSpacing: 1.6,
  });

  // Header divider — thin gold line beneath the address. Marks the
  // end of the header zone.
  const headerBottomY = ruleY - 54;
  page.drawLine({
    start: { x: margin + 28, y: headerBottomY },
    end:   { x: W - margin - 28, y: headerBottomY },
    thickness: 0.4,
    color: C_GOLD,
  });

  // ─────────── BODY ZONE ───────────
  // Generous left margin so body doesn't crowd the gold-rule frame.
  // Body starts 18pt below the header divider (was 36pt — tightened
  // so the date line + salutation fit in the same vertical slot the
  // salutation alone previously occupied; without this, the PS at
  // the bottom of the body was being pushed into the footer motto).
  const bodyLeftX = margin + 40;
  const bodyMaxWidth = W - 2 * (margin + 40);
  const bodySize = 12;
  const bodyLineHeight = 18;
  const paragraphGap = 10;
  let y = headerBottomY - 18;

  const drawParagraph = (text, opts = {}) => {
    const useFont = opts.font || fontSerif;
    const useSize = opts.size || bodySize;
    const useColor = opts.color || C_INK;
    const lines = wrapTextToLines(text, useFont, useSize, bodyMaxWidth);
    for (const line of lines) {
      page.drawText(line, {
        x: bodyLeftX,
        y,
        size: useSize,
        font: useFont,
        color: useColor,
      });
      y -= bodyLineHeight;
    }
    y -= paragraphGap;
  };

  // ─────────── DATE ───────────
  // Right-aligned above the salutation, real letter convention.
  // Generated at PDF creation time so each recipient's letter is
  // dated on the day it actually goes out (true to the personal-
  // correspondence framing). Long-form British/Irish convention:
  // '5 May 2026' (no comma, no day-of-week, no ordinal suffix).
  const today = new Date();
  const monthNames = ['January', 'February', 'March', 'April', 'May', 'June',
                      'July', 'August', 'September', 'October', 'November', 'December'];
  const dateStr = `${today.getDate()} ${monthNames[today.getMonth()]} ${today.getFullYear()}`;
  const dateSize = 11;
  const dateWidth = fontSerifItalic.widthOfTextAtSize(dateStr, dateSize);
  page.drawText(dateStr, {
    x: bodyLeftX + bodyMaxWidth - dateWidth,
    y,
    size: dateSize,
    font: fontSerifItalic,
    color: C_MUTED,
  });
  y -= bodyLineHeight + 12;  // extra space between date and salutation

  // Salutation — same size as body (real correspondence doesn't
  // differentiate; the salutation is content, not typography). Slight
  // extra space after to set it apart visually from the first paragraph.
  drawParagraph(`Dear ${addressForm},`);
  y -= 4;

  drawParagraph('It is my pleasure to welcome you to the newly revived Clan Ó Comáin!');
  drawParagraph('After a long suppression of 800 years, the clan is back, and I am thrilled that you have chosen to be a part of our founding family in 2026.');
  drawParagraph("I am incredibly excited to grow our community and would love for you to help & support me and be a part of that journey. I encourage you to browse our website to learn more about our shared heritage, the fascinating history of Irish clans, and how our ancestors lived under Brehon Law. Don't forget to explore the special Private Members' area.");
  drawParagraph("Here's to a long and wonderful friendship!");

  y -= 10;  // extra space before the formal close

  // ─────────── CLOSE ───────────
  // 'Slán go fóill — (goodbye for now)' — italic Irish + plain English gloss.
  page.drawText('Slán go fóill', {
    x: bodyLeftX, y, size: bodySize, font: fontSerifItalic, color: C_INK,
  });
  const closeWidth = fontSerifItalic.widthOfTextAtSize('Slán go fóill', bodySize);
  page.drawText(' — (goodbye for now)', {
    x: bodyLeftX + closeWidth, y, size: 11, font: fontSerif, color: C_MUTED,
  });
  y -= 32;

  // ─────────── SIGNATURE ───────────
  const sigW = 200;
  const sigH = sigW * (signature.height / signature.width);
  const sigY = y - sigH;
  page.drawImage(signature, {
    x: bodyLeftX, y: sigY, width: sigW, height: sigH,
  });
  y = sigY - 8;

  // Typed name + title beneath signature.
  page.drawText('Fergus Kinfauns, The Commane', {
    x: bodyLeftX, y, size: 10.5, font: fontSerif, color: C_INK,
  });
  y -= 14;
  page.drawText('Chief of Ó Comáin', {
    x: bodyLeftX, y, size: 10.5, font: fontSerif, color: C_INK,
  });
  const typedNameBottom = y;

  // ─────────── PS ───────────
  // Drawn BEFORE the chancery stamp so the stamp sits on top of the
  // PS where they overlap — a real stamp pressed onto a finished
  // letter is the topmost ink layer at the point of contact.
  //
  // Inline italic postscript, no callout box, no gold rule. The
  // 'P.S. ' marker itself does the work — no decoration needed.
  // Anchored to typedNameBottom (a fixed reference) so it can't
  // collide with the footer regardless of stamp dimensions.
  //
  // SINGLE LINE — the PS runs across the full body width and the
  // chancery stamp is pressed over the right end of it. The stamp's
  // ~65% washed opacity means the underlying text shows through
  // faintly through the translucent stamp ink — which is what real
  // ink stamps look like on real correspondence. The alternative
  // (briefly tried in commit 6466aa1) of hard-breaking the PS onto
  // two lines so the text dodges around the stamp is wrong: real
  // chancery letters don't lay out their text to avoid the seal,
  // the seal goes wherever it's pressed and the writer doesn't
  // accommodate it. The authentic look is stamp-on-top-of-text,
  // not text-arranged-around-stamp.
  const psY = typedNameBottom - 28;
  const psFullText = 'P.S. "Know someone who belongs with us? Inviting them is easy through your members\' area!"';
  const psLines = wrapTextToLines(psFullText, fontSerifItalic, 11.5, bodyMaxWidth);
  let psYCursor = psY;
  for (const line of psLines) {
    page.drawText(line, {
      x: bodyLeftX, y: psYCursor, size: 11.5, font: fontSerifItalic, color: C_PS_INK,
    });
    psYCursor -= 16;
  }

  // ─────────── CHANCERY STAMP ───────────
  // Right side, rotated -8°, overlapping the signature/typed-name
  // area AND the right end of the PS line. Drawn LAST so it sits on
  // top of all underlying text (signature, typed name, PS).
  //
  // OPACITY NOTE — this is subtler than it looks. The chancery stamp
  // PNG (the_commane_seal.png) was rendered with natural ink-wash
  // variation baked into its alpha channel: ~67% of pixels are fully
  // transparent (the gaps in the ink impression), and the inked
  // pixels themselves are mostly at alpha 0.65 (giving the ink the
  // washed-and-pressed-into-paper look). pdf-lib's opacity parameter
  // MULTIPLIES on top of the PNG's own alpha — so opacity 0.92 was
  // actually rendering at 0.65 × 0.92 = 0.60 effective opacity, which
  // washed the stamp too far and let the underlying PS text dominate
  // visually.
  //
  // Setting pdf-lib opacity to 1.0 lets the PNG's own 0.65 alpha do
  // the wash work alone — that gives the authentic 'pressed ink'
  // look (you can still see the watermark behind it through the
  // transparent gaps in the impression) while making the stamp dense
  // enough at the inked areas to genuinely cover the PS text where
  // they overlap. Stamp visually 'wins' the layering at those points,
  // which is the chancery aesthetic we want.
  //
  // Centre pulled inward so the rotated stamp's bounding box fits
  // comfortably within the body content area — right edge sits ~8pt
  // inside the body content.
  const stampW = 180;
  const stampH = stampW * (stamp.height / stamp.width);
  const stampCenterX = bodyLeftX + bodyMaxWidth - stampW / 2 - 8;
  const stampCenterY = sigY + sigH * 0.4;
  page.drawImage(stamp, {
    x: stampCenterX - stampW / 2,
    y: stampCenterY - stampH / 2,
    width: stampW,
    height: stampH,
    rotate: degrees(-8),
    opacity: 1.0,
  });

  // ─────────── FOOTER ───────────
  // Bottom of page. Mini gold rule + diamond + italic motto.
  // Fixed y from bottom so the footer doesn't depend on body length.
  const footerY = margin + 32;
  page.drawLine({
    start: { x: W/2 - 36, y: footerY + 14 },
    end:   { x: W/2 - 8,  y: footerY + 14 },
    thickness: 0.5,
    color: C_GOLD,
  });
  page.drawLine({
    start: { x: W/2 + 8,  y: footerY + 14 },
    end:   { x: W/2 + 36, y: footerY + 14 },
    thickness: 0.5,
    color: C_GOLD,
  });
  drawGoldDiamond(page, W/2, footerY + 14, 2.5);

  const motto = 'Caithfidh an stair a bheith i réim — History must prevail';
  const mottoSize = 10;
  const mottoWidth = fontSerifItalic.widthOfTextAtSize(motto, mottoSize);
  page.drawText(motto, {
    x: (W - mottoWidth) / 2,
    y: footerY,
    size: mottoSize,
    font: fontSerifItalic,
    color: C_GOLD_D,
  });

  return await doc.save();
}

module.exports = { generateChiefsLetterPdf };
