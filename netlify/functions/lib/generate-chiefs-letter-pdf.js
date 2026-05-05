// netlify/functions/lib/generate-chiefs-letter-pdf.js
//
// Pure function: takes recipient first name, returns the Chief's
// welcome letter as PDF bytes. Used by the Email 2 cover note in
// post-signup-email.js, which attaches the PDF and sends with a
// short personal cover from Fergus.
//
// Same architecture as generate-cert.js — pdf-lib + @pdf-lib/fontkit
// + bundled EB Garamond fonts. No network calls. Safe to invoke
// per-recipient on every send.
//
// LAYOUT — A4 portrait, 595.28 × 841.89 pt:
//
//   ┌──────────────────────────────────────────────┐
//   │ outer cream + double gold-rule frame         │
//   │   ┌──────────────────────────────────────┐   │
//   │   │ HEADER: arms / Clan Ó Comáin / sub-  │   │
//   │   │   line / divider / from-the-desk     │   │
//   │   ├──────────────────────────────────────┤   │
//   │   │ BODY                                 │   │
//   │   │   Dear [Firstname],                  │   │
//   │   │   It is my pleasure...               │   │
//   │   │   After a long suppression...        │   │
//   │   │   I am incredibly excited...         │   │
//   │   │   Here's to a long...                │   │
//   │   │                                      │   │
//   │   │   ┃ P.S.  "Know someone..."          │   │
//   │   │                                      │   │
//   │   │   Slán go fóill — (goodbye for now)  │   │
//   │   │                                      │   │
//   │   │   [signature image]                  │   │
//   │   │   Fergus Kinfauns, The Commane       │   │
//   │   │   Chief of Ó Comáin                  │   │
//   │   │                       [chancery stamp│   │
//   │   │                        rotated -8°,  │   │
//   │   │                        overlapping]  │   │
//   │   ├──────────────────────────────────────┤   │
//   │   │ FOOTER: gold rule + motto            │   │
//   │   └──────────────────────────────────────┘   │
//   └──────────────────────────────────────────────┘
//
// Why PDF rather than email-HTML for the Chief's letter? PDF is the
// authentic-correspondence medium for formal letters from a household
// — the recipient experiences opening an attachment in the same way
// they'd experience opening a posted letter. It also lets us use real
// fonts (web fonts don't load in mail clients), proper image overlap
// (CSS transforms are unreliable in email), and watermark layering
// (position:absolute is stripped by Gmail iOS) — all the things that
// were fighting us in the HTML version.

const { PDFDocument, rgb, PageSizes, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// A4 portrait
const [W, H] = PageSizes.A4;

// Colour palette — matches generate-cert.js for cross-asset coherence.
const C_INK    = rgb(0.102, 0.102, 0.102);  // #1A1A1A  body text
const C_INK_S  = rgb(0.235, 0.165, 0.102);  // #3C2A1A  warmer body
const C_GOLD   = rgb(0.722, 0.592, 0.353);  // #B8975A  rule colour
const C_GOLD_D = rgb(0.545, 0.435, 0.196);  // #8B6F32  eyebrow
const C_GOLD_M = rgb(0.467, 0.376, 0.169);  // #776030  from-the-desk
const C_GOLD_L = rgb(0.353, 0.290, 0.184);  // #5A4A2F  address line
const C_MUTED  = rgb(0.424, 0.353, 0.290);  // #6C5A4A  subtitle
const C_PS_INK = rgb(0.227, 0.290, 0.227);  // #3A4A3A  PS italic body
const C_PAPER  = rgb(0.980, 0.957, 0.902);  // #FAF4E6  cream paper
const C_RED    = rgb(0.686, 0.129, 0.110);  // #AF211C  chancery red

// Font cache — same convention as generate-cert.js.
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
//
// Loaded from netlify/functions/assets/ — the same location the
// certificate generator reads from. This is the path that ships
// with the function bundle (per the included_files glob in
// netlify.toml). Reading from the repo root would NOT work in
// production because Netlify only bundles what's explicitly
// included; the assets are duplicated here on purpose.
//
// Cached at module scope so the cold-start file read happens once
// per function instance rather than per invocation.
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

/**
 * Word-wrap a paragraph into lines that fit `maxWidth` at the given
 * font/size. Used for the body paragraphs of the letter (each one
 * becomes 2-4 lines on A4).
 *
 * @param {string} text
 * @param {Object} font  - pdf-lib font object
 * @param {number} size  - font size in pt
 * @param {number} maxWidth - max width in pt
 * @returns {string[]} array of lines that each fit within maxWidth
 */
function wrapTextToLines(text, font, size, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let currentLine = '';
  for (const word of words) {
    const candidate = currentLine ? currentLine + ' ' + word : word;
    const candidateWidth = font.widthOfTextAtSize(candidate, size);
    if (candidateWidth <= maxWidth) {
      currentLine = candidate;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

/**
 * Draw a centred letter-spaced run of text. Same approach as
 * drawSpacedText in generate-cert.js — each character placed
 * individually so we can approximate CSS letter-spacing.
 */
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

/**
 * Draw a small gold diamond ornament at (cx, cy). Used either side of
 * the central decorative rule. Two filled triangles meeting at a point
 * approximate a diamond — pdf-lib has no native polygon, but a
 * rotated tiny rectangle works fine.
 */
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
 * Generate the Chief's welcome letter PDF for a given recipient.
 *
 * @param {Object} opts
 * @param {string} opts.firstName - the recipient's first name (will be
 *                                  rendered into 'Dear [Firstname],')
 * @returns {Promise<Uint8Array>} PDF bytes
 */
async function generateChiefsLetterPdf({ firstName }) {
  firstName = (firstName || 'friend').trim();

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`A letter from the Chief of Clan Ó Comáin`);
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

  // Double gold-rule Kensington-style frame — same pattern as the cert.
  const margin = 36;
  page.drawRectangle({
    x: margin, y: margin, width: W - 2*margin, height: H - 2*margin,
    borderColor: C_GOLD, borderWidth: 0.6,
  });
  page.drawRectangle({
    x: margin + 8, y: margin + 8,
    width: W - 2*(margin + 8), height: H - 2*(margin + 8),
    borderColor: C_GOLD, borderWidth: 1.4,
  });

  // ─────────── HEADER ───────────
  // Drawn from the top down — y values measured from the top of the page.
  const headerTop = H - margin - 36;

  // Coat of arms, centred at top of header
  const armsW = 56;
  const armsH = armsW * (arms.height / arms.width);
  page.drawImage(arms, {
    x: (W - armsW) / 2,
    y: headerTop - armsH,
    width: armsW,
    height: armsH,
  });

  // 'CLAN Ó COMÁIN' eyebrow — sans-serif gold, letter-spaced caps.
  // Uses Jost SemiBold for the firmer presence; matches the cert eyebrow.
  drawSpacedTextCentered(page, {
    text: 'CLAN Ó COMÁIN',
    font: fontSansBold,
    size: 9,
    color: C_GOLD_D,
    y: headerTop - armsH - 16,
    centerX: W / 2,
    letterSpacing: 2.4,
  });

  // 'An Ancient Gaelic Royal House' — serif italic subline
  const subline = 'An Ancient Gaelic Royal House';
  const sublineSize = 12;
  const sublineWidth = fontSerifItalic.widthOfTextAtSize(subline, sublineSize);
  page.drawText(subline, {
    x: (W - sublineWidth) / 2,
    y: headerTop - armsH - 32,
    size: sublineSize,
    font: fontSerifItalic,
    color: C_MUTED,
  });

  // Decorative gold rule with diamond at the centre.
  const ruleY = headerTop - armsH - 50;
  page.drawLine({
    start: { x: W/2 - 64, y: ruleY },
    end:   { x: W/2 - 12, y: ruleY },
    thickness: 0.6,
    color: C_GOLD,
  });
  page.drawLine({
    start: { x: W/2 + 12, y: ruleY },
    end:   { x: W/2 + 64, y: ruleY },
    thickness: 0.6,
    color: C_GOLD,
  });
  drawGoldDiamond(page, W/2, ruleY, 3);

  // 'FROM THE DESK OF THE CHIEF' — small caps eyebrow under the rule
  drawSpacedTextCentered(page, {
    text: 'FROM THE DESK OF THE CHIEF',
    font: fontSansBold,
    size: 8,
    color: C_GOLD_M,
    y: ruleY - 18,
    centerX: W / 2,
    letterSpacing: 1.6,
  });

  // 'NEWHALL ESTATE · COUNTY CLARE · IRELAND' — even smaller caps
  drawSpacedTextCentered(page, {
    text: 'NEWHALL ESTATE  ·  COUNTY CLARE  ·  IRELAND',
    font: fontSans,
    size: 7.5,
    color: C_GOLD_L,
    y: ruleY - 30,
    centerX: W / 2,
    letterSpacing: 1.3,
  });

  // Header divider — thin gold line across the page beneath the address
  const headerBottomY = ruleY - 42;
  page.drawLine({
    start: { x: margin + 24, y: headerBottomY },
    end:   { x: W - margin - 24, y: headerBottomY },
    thickness: 0.4,
    color: C_GOLD,
  });

  // ─────────── BODY ───────────
  // The body sits in a generous content column. Wrapping is done via
  // wrapTextToLines so each paragraph flows naturally on A4. y tracked
  // top-to-bottom, decremented as each line is drawn.
  const bodyLeftX = margin + 56;
  const bodyMaxWidth = W - 2 * (margin + 56);
  const bodySize = 12;
  const bodyLineHeight = 18;
  const paragraphGap = 10;
  let y = headerBottomY - 36;

  const drawParagraph = (text, opts = {}) => {
    const useFont = opts.font || fontSerif;
    const useSize = opts.size || bodySize;
    const useColor = opts.color || C_INK;
    const useLineHeight = opts.lineHeight || bodyLineHeight;
    const useMaxWidth = opts.maxWidth || bodyMaxWidth;
    const useLeft = opts.leftX != null ? opts.leftX : bodyLeftX;
    const lines = wrapTextToLines(text, useFont, useSize, useMaxWidth);
    for (const line of lines) {
      page.drawText(line, {
        x: useLeft,
        y,
        size: useSize,
        font: useFont,
        color: useColor,
      });
      y -= useLineHeight;
    }
    y -= paragraphGap;
  };

  // Salutation — slightly larger so it reads as the opening
  drawParagraph(`Dear ${firstName},`, { size: 13 });

  drawParagraph('It is my pleasure to welcome you to the newly revived Clan Ó Comáin!');
  drawParagraph('After a long suppression of 800 years, the clan is back, and I am thrilled that you have chosen to be a part of our founding family in 2026.');
  drawParagraph("I am incredibly excited to grow our community and would love for you to help & support me and be a part of that journey. I encourage you to browse our website to learn more about our shared heritage, the fascinating history of Irish clans, and how our ancestors lived under Brehon Law. Don't forget to explore the special Private Members' area.");
  drawParagraph("Here's to a long and wonderful friendship!");

  // ─────────── PS BLOCK ───────────
  // Thin gold rule on the left, eyebrow then italic quoted line.
  const psTop = y;
  const psHeight = 56;
  // Left rule
  page.drawLine({
    start: { x: bodyLeftX - 14, y: psTop + 6 },
    end:   { x: bodyLeftX - 14, y: psTop - psHeight + 6 },
    thickness: 1.4,
    color: C_GOLD,
  });
  // 'P.S.' eyebrow
  drawSpacedTextCentered(page, {
    text: 'P.S.',
    font: fontSansBold,
    size: 8,
    color: C_GOLD_D,
    y: psTop - 4,
    centerX: bodyLeftX + 12,
    letterSpacing: 1.4,
  });
  // PS body text — italic, slightly muted
  const psBody = '"Know someone who belongs with us? Inviting them is easy through your members\' area!"';
  const psLines = wrapTextToLines(psBody, fontSerifItalic, 11.5, bodyMaxWidth - 4);
  let psY = psTop - 18;
  for (const line of psLines) {
    page.drawText(line, {
      x: bodyLeftX,
      y: psY,
      size: 11.5,
      font: fontSerifItalic,
      color: C_PS_INK,
    });
    psY -= 16;
  }
  y = psY - 14;

  // ─────────── CLOSE ───────────
  // 'Slán go fóill — (goodbye for now)'
  const closeText = 'Slán go fóill';
  const closeGloss = '— (goodbye for now)';
  page.drawText(closeText, {
    x: bodyLeftX,
    y,
    size: bodySize,
    font: fontSerifItalic,
    color: C_INK,
  });
  const closeWidth = fontSerifItalic.widthOfTextAtSize(closeText, bodySize);
  page.drawText(' ' + closeGloss, {
    x: bodyLeftX + closeWidth,
    y,
    size: 11,
    font: fontSerif,
    color: C_MUTED,
  });
  y -= 30;

  // ─────────── SIGNATURE ───────────
  // Embedded handwritten signature image, scaled to ~180pt wide.
  const sigW = 180;
  const sigH = sigW * (signature.height / signature.width);
  const sigY = y - sigH;
  page.drawImage(signature, {
    x: bodyLeftX,
    y: sigY,
    width: sigW,
    height: sigH,
  });
  y = sigY - 6;

  // Typed name + title beneath signature
  page.drawText('Fergus Kinfauns, The Commane', {
    x: bodyLeftX,
    y,
    size: 10,
    font: fontSerif,
    color: C_INK,
  });
  y -= 13;
  page.drawText('Chief of Ó Comáin', {
    x: bodyLeftX,
    y,
    size: 10,
    font: fontSerif,
    color: C_INK,
  });
  y -= 16;

  // ─────────── CHANCERY STAMP ───────────
  // Large, on the right, rotated -8°, overlapping the signature/typed-name
  // area to look like the seal was pressed onto the paper after the body
  // and signature were already there.
  //
  // Positioning: we want the centre of the stamp to land roughly over
  // the right end of the signature line, vertically straddling the
  // signature and the typed name. So we compute its target centre and
  // back out the bottom-left x/y for pdf-lib's drawImage origin.
  //
  // pdf-lib's `rotate` rotates around the bottom-left corner — we
  // compensate by computing the rotated bounding box and offsetting.
  const stampW = 170;
  const stampH = stampW * (stamp.height / stamp.width);
  const stampRotation = -8;  // degrees
  // Target centre point (over the signature's right end, slightly below)
  const stampCenterX = W - margin - 56 - stampW * 0.35;
  const stampCenterY = sigY + sigH * 0.45;
  // pdf-lib draws image with origin at bottom-left; for rotated images,
  // it rotates AROUND that origin. To centre the rotated stamp at our
  // target, we draw it at (centerX - stampW/2, centerY - stampH/2)
  // BEFORE rotation; the API accepts a rotate option that rotates
  // around the image centre when xSkew/ySkew are 0.
  page.drawImage(stamp, {
    x: stampCenterX - stampW / 2,
    y: stampCenterY - stampH / 2,
    width: stampW,
    height: stampH,
    rotate: degrees(stampRotation),
    opacity: 0.92,
  });

  // ─────────── FOOTER ───────────
  // Small gold rule + diamond + motto, sitting at the bottom of the page
  // inside the frame.
  const footerY = margin + 36;
  // Gold mini-rule
  page.drawLine({
    start: { x: W/2 - 32, y: footerY + 14 },
    end:   { x: W/2 - 6,  y: footerY + 14 },
    thickness: 0.5,
    color: C_GOLD,
  });
  page.drawLine({
    start: { x: W/2 + 6,  y: footerY + 14 },
    end:   { x: W/2 + 32, y: footerY + 14 },
    thickness: 0.5,
    color: C_GOLD,
  });
  drawGoldDiamond(page, W/2, footerY + 14, 2.5);

  // Motto — italic gold
  const motto = 'Caithfidh an stair a bheith i réim — History must prevail';
  const mottoSize = 9.5;
  const mottoWidth = fontSerifItalic.widthOfTextAtSize(motto, mottoSize);
  page.drawText(motto, {
    x: (W - mottoWidth) / 2,
    y: footerY,
    size: mottoSize,
    font: fontSerifItalic,
    color: C_GOLD_D,
  });

  // ─────────── DONE ───────────
  return await doc.save();
}

module.exports = { generateChiefsLetterPdf };
