// netlify/functions/lib/generate-cert.js
// Pure function: takes member/recipient data, returns a PDF buffer.
// Uses self-hosted EB Garamond + Jost (embedded TTF) via @pdf-lib/fontkit.
// No network calls. Safe to invoke on every request.

const { PDFDocument, rgb, PageSizes, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const fs = require('fs');
const path = require('path');

// A4 portrait: 595.28 × 841.89 pt
const [W, H] = PageSizes.A4;

// Colours (hex → rgb 0..1)
const C_INK    = rgb(0.047, 0.102, 0.047);  // #0C1A0C
const C_INK_S  = rgb(0.235, 0.165, 0.102);  // #3C2A1A  warmer body text
const C_GOLD   = rgb(0.722, 0.592, 0.353);  // #B8975A
const C_GOLD_L = rgb(0.831, 0.722, 0.478);  // #D4B87A
const C_GOLD_D = rgb(0.584, 0.459, 0.216);  // #957537  slightly darker gold — used for seal arc text
const C_MUTED  = rgb(0.424, 0.353, 0.290);  // #6C5A4A
const C_CREAM  = rgb(0.973, 0.957, 0.925);  // #F8F4EC

// ──────────────────────────────────────────────────────────────────────────
// FOUNDING MEMBER SEAL — configuration
//
// Certificates issued to members whose join year is in FOUNDING_YEARS receive
// a gold "FOUNDER · YEAR ONE OF THE REVIVAL · [year]" seal in the top-right
// corner. Currently the founding window is the single year 2026 (the first
// full year after the 2025 Clans of Ireland recognition).
//
// To extend the founding window later (e.g. including 2025 once the lifetime
// founding members are imported), add years to this Set. Never remove a year
// once certs have been issued — existing certs would still show the seal (we
// do NOT regenerate past certs), but new joins in the removed year would
// silently lose the badge, which would be operationally confusing.
//
// Year II, III etc. would get their own distinct seal designs (to be added
// to drawFoundingMemberSeal below as a branching renderer) — do not simply
// extend FOUNDING_YEARS to 2027 unless you want the 2026 seal design re-used.
const FOUNDING_YEARS = new Set([2026]);

// Font files live at /fonts/ in the repo root. bundle them with the
// function via netlify.toml [functions] included_files pattern.
// Cached at module scope so repeated invocations share the same Buffer.
const FONTS_DIR = path.join(__dirname, '..', '..', '..', 'fonts');
let _fontCache = null;
function loadFontBuffers() {
  if (_fontCache) return _fontCache;
  _fontCache = {
    serifRegular: fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Regular.ttf')),
    serifItalic:  fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Italic.ttf')),
    serifMedium:  fs.readFileSync(path.join(FONTS_DIR, 'EBGaramond-Medium.ttf')),
    sansRegular:  fs.readFileSync(path.join(FONTS_DIR, 'Jost-Regular.ttf')),
    sansMedium:   fs.readFileSync(path.join(FONTS_DIR, 'Jost-Medium.ttf')),
    sansSemiBold: fs.readFileSync(path.join(FONTS_DIR, 'Jost-SemiBold.ttf')),
  };
  return _fontCache;
}

/**
 * Generate a member certificate PDF.
 * @param {Object} opts
 * @param {string} opts.name       - recipient full name
 * @param {string} opts.tierLabel  - e.g. "Clan Member" / "Guardian of the Clan"
 * @param {string} opts.joinedAt   - ISO timestamp
 * @param {string} opts.certNumber - short unique cert number
 * @param {Buffer} opts.shieldPng  - PNG buffer of the coat of arms
 * @param {Buffer} [opts.signaturePng] - PNG buffer of the Chief's signature (optional, drawn over centre signature line if present)
 * @returns {Promise<Uint8Array>}  PDF bytes
 */
async function generateCertificate({ name, tierLabel, joinedAt, certNumber, shieldPng, signaturePng, partnerName, childrenFirstNames, ancestorDedication }) {
  // With real Unicode fonts, we don't need WinAnsi sanitization — EB Garamond
  // covers the full Latin Extended-A range including Irish acute accents (á é
  // í ó ú) and typographic punctuation. Keep the name exactly as the member
  // typed it.
  name       = name       || 'Member of the Clan';
  tierLabel  = tierLabel  || 'Clan Member';
  certNumber = certNumber || 'OC-UNKNOWN';

  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`Certificate of Membership — ${name}`);
  doc.setAuthor('Clan Ó Comáin');
  doc.setSubject('Clan Ó Comáin Membership Certificate');
  doc.setCreationDate(new Date(joinedAt));

  const page = doc.addPage([W, H]);

  // Load and embed the site's actual typefaces (EB Garamond for serifs,
  // Jost for sans). The cert now typographically matches ocomain.org.
  // Note: subset:false (full embed) — pdf-lib's subsetter can't predict
  // which glyphs will be drawn after the embed call, so subsetting produced
  // empty-glyph certificates. The six TTFs total ~1.8MB uncompressed but
  // pdf-lib gzips them; full-embed cert is only ~680KB in practice.
  const fb = loadFontBuffers();
  const fontSerif       = await doc.embedFont(fb.serifRegular,  { subset: false });
  const fontSerifItalic = await doc.embedFont(fb.serifItalic,   { subset: false });
  const fontSerifMedium = await doc.embedFont(fb.serifMedium,   { subset: false });
  const fontSans        = await doc.embedFont(fb.sansRegular,   { subset: false });
  const fontSansMedium  = await doc.embedFont(fb.sansMedium,    { subset: false });
  const fontSansBold    = await doc.embedFont(fb.sansSemiBold,  { subset: false });

  // Cream background fill
  page.drawRectangle({ x: 0, y: 0, width: W, height: H, color: C_CREAM });

  // Double gold border — outer thin rule, inner thicker rule
  const margin = 36;
  page.drawRectangle({ x: margin, y: margin, width: W - 2*margin, height: H - 2*margin, borderColor: C_GOLD, borderWidth: 0.6 });
  page.drawRectangle({ x: margin + 8, y: margin + 8, width: W - 2*(margin + 8), height: H - 2*(margin + 8), borderColor: C_GOLD, borderWidth: 2 });
  page.drawRectangle({ x: margin + 12, y: margin + 12, width: W - 2*(margin + 12), height: H - 2*(margin + 12), borderColor: C_GOLD, borderWidth: 0.4 });

  // Shield (embed PNG, scale proportionally)
  const shield = await doc.embedPng(shieldPng);
  const shieldW = 88;
  const shieldH = shieldW * (shield.height / shield.width);
  const shieldY = H - margin - 60 - shieldH;
  page.drawImage(shield, {
    x: (W - shieldW) / 2,
    y: shieldY,
    width: shieldW,
    height: shieldH,
  });

  // "IRISH CLAN" small caps eyebrow
  const eyebrowText = 'IRISH CLAN';
  const eyebrowSize = 9;
  const eyebrowWidth = fontSansBold.widthOfTextAtSize(eyebrowText, eyebrowSize);
  // Approximate letter-spacing 0.32em by manually spacing chars
  drawSpacedText(page, {
    text: eyebrowText,
    font: fontSansBold,
    size: eyebrowSize,
    color: C_GOLD,
    y: shieldY - 22,
    centerX: W / 2,
    letterSpacing: 2.6,
  });

  // Big "Ó Comáin" gold serif
  const nameHeading = 'Ó Comáin';
  const nameHeadingSize = 40;
  const nameHeadingWidth = fontSerif.widthOfTextAtSize(nameHeading, nameHeadingSize);
  page.drawText(nameHeading, {
    x: (W - nameHeadingWidth) / 2,
    y: shieldY - 74,
    size: nameHeadingSize,
    font: fontSerif,
    color: C_GOLD,
  });

  // Gold thin divider
  const ruleY = shieldY - 98;
  page.drawLine({
    start: { x: W/2 - 32, y: ruleY },
    end:   { x: W/2 + 32, y: ruleY },
    thickness: 0.7,
    color: C_GOLD,
  });

  // Certificate Title — use Medium weight (500) for slightly firmer presence.
  // The fi-pair rendering gap in EB Garamond + pdf-lib is bypassed by using
  // the Unicode precomposed ligature (U+FB01 ﬁ) instead of "fi" — pdf-lib
  // renders the single glyph without the broken kerning interpretation.
  const title = 'Certi\uFB01cate of Membership';
  const titleSize = 24;
  const titleWidth = fontSerifMedium.widthOfTextAtSize(title, titleSize);
  page.drawText(title, {
    x: (W - titleWidth) / 2,
    y: ruleY - 38,
    size: titleSize,
    font: fontSerifMedium,
    color: C_INK,
  });

  // Irish subtitle
  const subtitle = 'Teastas Ballraíochta';
  const subtitleSize = 14;
  const subtitleWidth = fontSerifItalic.widthOfTextAtSize(subtitle, subtitleSize);
  page.drawText(subtitle, {
    x: (W - subtitleWidth) / 2,
    y: ruleY - 60,
    size: subtitleSize,
    font: fontSerifItalic,
    color: C_GOLD,
  });

  // Body text
  const bodyIntro = 'This is to certify that';
  const bodyIntroSize = 13;
  const bodyIntroWidth = fontSerifItalic.widthOfTextAtSize(bodyIntro, bodyIntroSize);
  page.drawText(bodyIntro, {
    x: (W - bodyIntroWidth) / 2,
    y: ruleY - 110,
    size: bodyIntroSize,
    font: fontSerifItalic,
    color: C_MUTED,
  });

  // ── FAMILY FORMAT: heraldic letters-patent convention ────────────────────
  // The four real-world household types are handled by computeFamilyDisplay
  // (defined at the bottom of this file). Same logic now also drives the
  // public register page, ensuring sealed-cert and register-listing always
  // match exactly.
  //
  //   couple + children:   "JOHN CUMMINS & FAMILY"
  //                        with Mary Cummins, and Saoirse, Liam, and Aoife
  //
  //   couple, no children: "JOHN & MARY CUMMINS"
  //                        (no credit line — both adults are in the main body)
  //
  //   single + children:   "MARY CUMMINS & FAMILY"
  //                        with their children Saoirse, Liam, and Aoife
  //
  //   individual / no family details: just "JOHN CUMMINS"
  const { displayName, creditLine } = computeFamilyDisplay(
    name, partnerName, childrenFirstNames
  );

  // Recipient name — large gold italic, the emotional centre of the cert
  const recipientSize = 34;
  const recipientWidth = fontSerifItalic.widthOfTextAtSize(displayName, recipientSize);
  // If the name is too wide, shrink it gracefully
  let actualRecipientSize = recipientSize;
  let actualRecipientWidth = recipientWidth;
  const maxNameWidth = W - 2 * (margin + 60);
  if (recipientWidth > maxNameWidth) {
    actualRecipientSize = recipientSize * (maxNameWidth / recipientWidth);
    actualRecipientWidth = fontSerifItalic.widthOfTextAtSize(displayName, actualRecipientSize);
  }
  page.drawText(displayName, {
    x: (W - actualRecipientWidth) / 2,
    y: ruleY - 160,
    size: actualRecipientSize,
    font: fontSerifItalic,
    color: C_GOLD_L,
  });

  // FAMILY CREDIT LINE — sits just below the main name in muted italic.
  // Only rendered when we have a creditLine (couple+children or single+children).
  // Pushes the register block down by 18pt to make room.
  const hasCreditLine = !!creditLine;
  if (hasCreditLine) {
    const creditSize = 12;
    const creditWidth = fontSerifItalic.widthOfTextAtSize(creditLine, creditSize);
    // Truncate gracefully if the credit line is too long for the page width
    let actualCreditLine = creditLine;
    let actualCreditWidth = creditWidth;
    let actualCreditSize = creditSize;
    if (creditWidth > maxNameWidth) {
      actualCreditSize = creditSize * (maxNameWidth / creditWidth);
      actualCreditWidth = fontSerifItalic.widthOfTextAtSize(actualCreditLine, actualCreditSize);
    }
    page.drawText(actualCreditLine, {
      x: (W - actualCreditWidth) / 2,
      y: ruleY - 182,
      size: actualCreditSize,
      font: fontSerifItalic,
      color: C_MUTED,
    });
  }

  // Register block Y offset — pushed down 18pt when credit line is present
  const regOffset = hasCreditLine ? -18 : 0;

  // Register statement — wraps across two lines for readability
  // If the tier label already contains "Clan" (e.g. "Guardian of the Clan"),
  // don't tack on "of Clan Ó Comáin" after it — it reads "Clan of Clan".
  // Smarter template: tier label owns the "of Clan Ó Comáin" phrasing when
  // it already names the clan, otherwise we append it.
  const tierContainsClan = /\bclan\b/i.test(tierLabel);
  const register1 = tierContainsClan
    ? `is hereby entered as a ${tierLabel.replace(/\bclan\b/i, 'Clan Ó Comáin')}`
    : `is hereby entered as a ${tierLabel} of Clan Ó Comáin`;
  const register2 = 'in the Register of the clan, held at Newhall House, County Clare, Ireland';
  const registerSize = 12;
  const register1Width = fontSerif.widthOfTextAtSize(register1, registerSize);
  const register2Width = fontSerif.widthOfTextAtSize(register2, registerSize);
  page.drawText(register1, {
    x: (W - register1Width) / 2,
    y: ruleY - 200 + regOffset,
    size: registerSize,
    font: fontSerif,
    color: C_INK_S,
  });
  page.drawText(register2, {
    x: (W - register2Width) / 2,
    y: ruleY - 220 + regOffset,
    size: registerSize,
    font: fontSerif,
    color: C_INK_S,
  });

  const register3 = 'an ancient Gaelic royal house recognised by Clans of Ireland.';
  const register3Width = fontSerifItalic.widthOfTextAtSize(register3, registerSize);
  page.drawText(register3, {
    x: (W - register3Width) / 2,
    y: ruleY - 240 + regOffset,
    size: registerSize,
    font: fontSerifItalic,
    color: C_MUTED,
  });

  // Running Y cursor for the conditional cert extensions below the register
  // block: inheritance line (families with children), ancestor dedication
  // line (optional member-entered). Each pushes the next one down further
  // but neither encroaches on the signature area (which starts at margin+110).
  let cursorY = ruleY - 240 + regOffset;

  // Local 'has children' check used by both the inheritance-line block
  // below and the dedication-spacing tweak further down. Was previously
  // referenced as a free variable (causing 'hasChildren is not defined'
  // ReferenceError) — that name only exists inside the helper functions
  // computeFamilyDisplay() and computeRegisterDisplay(), not in the
  // main generateCertificate scope. This declaration restores it.
  const hasChildren = Array.isArray(childrenFirstNames)
    && childrenFirstNames.filter(c => c && c.trim()).length > 0;

  // ── INHERITANCE LINE — only for families with children ────────────────
  // Heraldic letters-patent convention: the cert names the inheritors.
  // Rendered as two short italic lines in muted ink, wrapping naturally.
  if (hasChildren) {
    cursorY -= 30;
    const inherit1 = 'The children named herein shall inherit this membership in their own right,';
    const inherit2 = 'in the fullness of time — their parents\u2019 names remembered always.';
    const inheritSize = 11;
    const i1w = fontSerifItalic.widthOfTextAtSize(inherit1, inheritSize);
    const i2w = fontSerifItalic.widthOfTextAtSize(inherit2, inheritSize);
    page.drawText(inherit1, {
      x: (W - i1w) / 2,
      y: cursorY,
      size: inheritSize,
      font: fontSerifItalic,
      color: C_INK_S,
    });
    cursorY -= 16;
    page.drawText(inherit2, {
      x: (W - i2w) / 2,
      y: cursorY,
      size: inheritSize,
      font: fontSerifItalic,
      color: C_INK_S,
    });
  }

  // ── ANCESTOR DEDICATION — optional member-entered free text ───────────
  // Renders the member's own dedication as a single italic line between
  // the register block and the signature. Members type this into the
  // welcome-page form (or the dashboard edit modal) after paying.
  // Free-text — whatever the member writes is what appears, verbatim.
  // If the dedication is too long for one line, it gracefully reduces
  // size to fit (same approach as the recipient name scaling above).
  if (ancestorDedication && ancestorDedication.trim()) {
    const dedication = ancestorDedication.trim();
    cursorY -= hasChildren ? 26 : 30;
    const dedSize = 12;
    const dedWidth = fontSerifItalic.widthOfTextAtSize(dedication, dedSize);
    let actualDedSize = dedSize;
    let actualDedWidth = dedWidth;
    const maxDedWidth = W - 2 * (margin + 60);
    if (dedWidth > maxDedWidth) {
      actualDedSize = dedSize * (maxDedWidth / dedWidth);
      actualDedWidth = fontSerifItalic.widthOfTextAtSize(dedication, actualDedSize);
    }
    page.drawText(dedication, {
      x: (W - actualDedWidth) / 2,
      y: cursorY,
      size: actualDedSize,
      font: fontSerifItalic,
      color: C_GOLD_D,
    });
  }

  // Signature area — single centred block with handwritten signature image
  // above the gold line, typed Chief name and ceremonial title beneath
  const sigY = margin + 110;
  const sigCenterX = W / 2;
  const sigLineLen = 220;

  // Embed and draw the Chief's signature image, if provided
  if (signaturePng) {
    try {
      const sigImg = await doc.embedPng(signaturePng);
      // Target signature width — larger than strictly required by the gold
      // line beneath, because real hand-signed documents always overflow the
      // line rather than sit inside it. A tighter fit reads as a printed
      // label, not a signature.
      const sigDrawWidth = 260;
      const aspectRatio = sigImg.height / sigImg.width;
      const sigDrawHeight = sigDrawWidth * aspectRatio;
      page.drawImage(sigImg, {
        x: sigCenterX - sigDrawWidth / 2,
        y: sigY + 28,                 // overlaps the gold line naturally
        width: sigDrawWidth,
        height: sigDrawHeight,
      });
    } catch (e) {
      // If embed fails (e.g. corrupt PNG) silently skip — typed name remains
      console.error('Signature embed failed:', e.message);
    }
  }

  // Single centred gold signature line
  page.drawLine({
    start: { x: sigCenterX - sigLineLen/2, y: sigY + 28 },
    end:   { x: sigCenterX + sigLineLen/2, y: sigY + 28 },
    thickness: 0.5,
    color: C_GOLD,
  });

  // Typed Chief name and ceremonial title beneath the line
  drawCentered(page, 'Fergus Kinfauns, The Commane', fontSerif, 11, C_INK, sigY + 12, sigCenterX);
  drawCentered(page, 'Chief of Ó Comáin', fontSerifItalic, 9, C_MUTED, sigY - 2, sigCenterX);

  // Cert metadata footer — registration place + issue date + cert number
  const issuedDate = new Date(joinedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const footerText = `Registered at Newhall House, County Clare   ·   Issued ${issuedDate}   ·   Cert No. ${certNumber}`;
  drawCentered(page, footerText, fontSans, 8, C_MUTED, margin + 48, W/2);

  // Small gold dot at top of the cert between inner borders — quiet heraldic flourish
  page.drawCircle({ x: W/2, y: H - margin - 22, size: 2.2, color: C_GOLD });

  // Founding Member seal (top-right corner) — rendered ONLY for members
  // whose join year falls inside the founding window. The seal is cosmetic
  // and non-invasive: nothing else on the cert moves when it's present or
  // absent. See FOUNDING_YEARS comment at top of file for extension rules.
  const joinYear = new Date(joinedAt).getFullYear();
  if (FOUNDING_YEARS.has(joinYear)) {
    drawFoundingMemberSeal(page, {
      fonts: { fontSerif, fontSerifItalic, fontSerifMedium, fontSansBold },
      margin, W, H,
      joinYear,
    });
  }

  return await doc.save();
}

// Helper: centered text at a given baseline y
function drawCentered(page, text, font, size, color, y, centerX) {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: centerX - w/2, y, size, font, color });
}

// Helper: letter-spaced centered text (manual, since pdf-lib has no tracking)
function drawSpacedText(page, { text, font, size, color, y, centerX, letterSpacing }) {
  const chars = text.split('');
  const charWidths = chars.map(c => font.widthOfTextAtSize(c, size));
  const totalWidth = charWidths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  let x = centerX - totalWidth / 2;
  chars.forEach((c, i) => {
    page.drawText(c, { x, y, size, font, color });
    x += charWidths[i] + letterSpacing;
  });
}

// ──────────────────────────────────────────────────────────────────────────
// Founding Member seal — corner badge for Year One (2026) members
// ──────────────────────────────────────────────────────────────────────────
//
// Layout (inside-out):
//   - Outer bold gold ring + inner thin gold ring
//   - Cream fill inside inner ring (so arc text reads cleanly on a clean ground)
//   - Top-arc curved text: "YEAR ONE OF THE REVIVAL"  (Jost SemiBold, small caps)
//   - Bottom-arc curved text: "· <joinYear> ·"        (EB Garamond italic)
//   - Dot ornaments at the 3- and 9-o'clock positions separating the arcs
//   - Centre word: FOUNDER  (EB Garamond Medium)
//   - Small flourish rule under the centre word
//
// Characters on the arcs are drawn at their angular position and rotated
// tangent so the text follows the curve. The baseline sits on the arc;
// character tops naturally extend slightly outward, which reads as formal
// engraved lettering on a seal.
function drawFoundingMemberSeal(page, { fonts, margin, W, H, joinYear }) {
  const { fontSerif, fontSerifItalic, fontSerifMedium, fontSansBold } = fonts;

  // Seal geometry — positioned in the top-right corner with breathing room
  // from the triple gold border (kept 72pt from each edge = ~22pt gap from
  // the innermost border line at margin+12).
  const cx = W - margin - 72;
  const cy = H - margin - 72;
  const rOuter    = 50;
  const rInner    = 44;
  const rArcTop   = 38;  // baseline radius for top-arc text
  const rArcBottom = 36; // slightly smaller for the italic bottom text which sits lower visually

  // Outer thick ring
  page.drawCircle({ x: cx, y: cy, size: rOuter, borderColor: C_GOLD, borderWidth: 1.4 });
  // Inner thin ring
  page.drawCircle({ x: cx, y: cy, size: rInner, borderColor: C_GOLD, borderWidth: 0.5 });
  // Cream fill inside inner ring — hides anything the seal overlaps so the
  // arc text reads cleanly regardless of what the seal sits on top of.
  page.drawCircle({ x: cx, y: cy, size: rInner - 1, color: C_CREAM });

  // Top-arc curved text
  drawArcTextTop(page, {
    text: 'YEAR ONE OF THE REVIVAL',
    font: fontSansBold,
    size: 5.5,
    color: C_GOLD_D,
    centerX: cx, centerY: cy,
    radius: rArcTop,
    letterSpacing: 1.2,
  });

  // Bottom-arc curved year text — dynamically shows the member's join year
  // so the seal is truthful regardless of when we later extend FOUNDING_YEARS.
  drawArcTextBottom(page, {
    text: `· ${joinYear} ·`,
    font: fontSerifItalic,
    size: 8,
    color: C_GOLD_D,
    centerX: cx, centerY: cy,
    radius: rArcBottom,
    letterSpacing: 1.0,
  });

  // Dot ornaments at 3 and 9 o'clock separating the two arcs
  page.drawCircle({ x: cx - rArcTop, y: cy, size: 0.9, color: C_GOLD });
  page.drawCircle({ x: cx + rArcTop, y: cy, size: 0.9, color: C_GOLD });

  // Centre word — FOUNDER
  const founderSize = 13;
  const founderWidth = fontSerifMedium.widthOfTextAtSize('FOUNDER', founderSize);
  page.drawText('FOUNDER', {
    x: cx - founderWidth / 2,
    y: cy - 3,
    size: founderSize,
    font: fontSerifMedium,
    color: C_GOLD,
  });

  // Small flourish rule under the centre word
  page.drawLine({
    start: { x: cx - 12, y: cy - 8 },
    end:   { x: cx + 12, y: cy - 8 },
    thickness: 0.4,
    color: C_GOLD,
  });
}

// Draw text along an upper arc of given radius, reading left-to-right across
// the top of the circle. Characters are placed at their angular position and
// rotated tangent (rotation = arc-angle - 90°). pdf-lib rotates around each
// glyph's baseline-left origin, so baselines sit on the arc and character
// tops extend slightly outward — which reads as engraved seal lettering.
function drawArcTextTop(page, { text, font, size, color, centerX, centerY, radius, letterSpacing = 0 }) {
  const chars = text.split('');
  const widths = chars.map(c => font.widthOfTextAtSize(c, size));
  const totalLen = widths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  const totalAngleRad = totalLen / radius;
  // Start angle at top of circle (90°) plus half the span; walk clockwise.
  let angleRad = Math.PI / 2 + totalAngleRad / 2;

  chars.forEach((c, i) => {
    const charW = widths[i];
    const charAngleRad = charW / radius;
    const placeAngleRad = angleRad - charAngleRad / 2;
    const x = centerX + radius * Math.cos(placeAngleRad);
    const y = centerY + radius * Math.sin(placeAngleRad);
    const rotDeg = (placeAngleRad * 180 / Math.PI) - 90;
    page.drawText(c, { x, y, size, font, color, rotate: degrees(rotDeg) });
    angleRad -= charAngleRad + (letterSpacing / radius);
  });
}

// Draw text along a lower arc, reading left-to-right across the bottom of the
// circle (characters upright). Rotation = arc-angle + 90° so glyphs flip to
// read upright at the bottom rather than upside-down.
function drawArcTextBottom(page, { text, font, size, color, centerX, centerY, radius, letterSpacing = 0 }) {
  const chars = text.split('');
  const widths = chars.map(c => font.widthOfTextAtSize(c, size));
  const totalLen = widths.reduce((a, b) => a + b, 0) + letterSpacing * (chars.length - 1);
  const totalAngleRad = totalLen / radius;
  // Start angle at bottom of circle (-90°) minus half the span; walk counter-
  // clockwise (increasing angle) so text reads left-to-right.
  let angleRad = -Math.PI / 2 - totalAngleRad / 2;

  chars.forEach((c, i) => {
    const charW = widths[i];
    const charAngleRad = charW / radius;
    const placeAngleRad = angleRad + charAngleRad / 2;
    const x = centerX + radius * Math.cos(placeAngleRad);
    const y = centerY + radius * Math.sin(placeAngleRad);
    const rotDeg = (placeAngleRad * 180 / Math.PI) + 90;
    page.drawText(c, { x, y, size, font, color, rotate: degrees(rotDeg) });
    angleRad += charAngleRad + (letterSpacing / radius);
  });
}

// computeFamilyDisplay — given the canonical inputs, return the {displayName,
// creditLine} pair used on the cert. This is the SOURCE OF TRUTH for how a
// member's name is rendered; the cert calls this directly, the publish
// endpoint uses it to compute display_name_on_register, and the register
// endpoint uses it (via computeRegisterCreditLine below) to build the
// public-facing entry. Keeping all three in lock-step prevents the kind
// of drift where the cert says "John Cummins & Family" and the register
// page says something else.
//
// Inputs:
//   name              - primary member's full name (string, required)
//   partnerName       - partner's full name (string or null/empty)
//   childrenFirstNames - array of children's first names (under 18s only,
//                        per project policy — over-18s buy their own
//                        memberships and don't appear in this list)
//
// Returns: { displayName, creditLine }
//   displayName - the large heraldic name on the cert (e.g. "JOHN CUMMINS &
//                 FAMILY"). On the cert it's UPPERCASED at render time; here
//                 we return the title-cased form, callers uppercase if
//                 needed.
//   creditLine  - the small italic line under the displayName on the cert,
//                 or null when there's no family detail to credit (solo
//                 member or named couple).
function computeFamilyDisplay(name, partnerName, childrenFirstNames) {
  const hasPartner = partnerName && partnerName.trim();
  const hasChildren = Array.isArray(childrenFirstNames)
    && childrenFirstNames.filter(c => c && c.trim()).length > 0;
  const cleanChildren = hasChildren
    ? childrenFirstNames.filter(c => c && c.trim()).map(c => c.trim())
    : [];

  if (hasPartner && hasChildren) {
    return {
      displayName: `${name} & Family`,
      creditLine:  `with ${partnerName.trim()}, and ${formatNameList(cleanChildren)}`,
    };
  }
  if (hasPartner && !hasChildren) {
    return {
      displayName: combineCoupleNames(name, partnerName.trim()),
      creditLine:  null,
    };
  }
  if (!hasPartner && hasChildren) {
    // 'child' singular when there's exactly one child name; 'children'
    // plural for two or more. English grammar requires this and the
    // bug bit on a real publish ('with their children Roger' instead
    // of 'with their child Roger').
    const childWord = cleanChildren.length === 1 ? 'child' : 'children';
    return {
      displayName: `${name} & Family`,
      creditLine:  `with their ${childWord} ${formatNameList(cleanChildren)}`,
    };
  }
  // Individual member — no family details
  return { displayName: name, creditLine: null };
}

// computeRegisterCreditLine — like computeFamilyDisplay's creditLine output,
// but with the additional children-opted-out branch the cert doesn't need.
// On the cert (private), children's names always appear when they exist.
// On the public register, the children_visible_on_register flag gates
// whether the names are shown. When children EXIST but are opted out:
//
//   - couple + opted-out kids → "with [Partner], and children"
//   - single + opted-out kids → "with children"
//
// The displayName is always identical to the cert's displayName (always
// shows "& Family" when children exist) — only the credit line differs.
//
// Inputs: same as computeFamilyDisplay PLUS:
//   childrenVisible - boolean, the public_register's per-row gate for
//                     whether children's names appear publicly
//
// Returns: { displayName, creditLine } with the same shape as
// computeFamilyDisplay; can be used as a drop-in replacement on the
// register page.
function computeRegisterDisplay(name, partnerName, childrenFirstNames, childrenVisible) {
  const hasPartner = partnerName && partnerName.trim();
  const hasChildren = Array.isArray(childrenFirstNames)
    && childrenFirstNames.filter(c => c && c.trim()).length > 0;

  // If children exist AND are opted in, fall through to the cert logic.
  // (Same output, no divergence between sealed cert and public register.)
  if (childrenVisible || !hasChildren) {
    return computeFamilyDisplay(name, partnerName, childrenFirstNames);
  }

  // Children exist BUT opted out of public register.
  // Display name still says "& Family" (the family-tier nature of the
  // entry isn't a privacy issue; only the children's names are).
  // Credit line gets the redacted form. Pluralization matches the
  // visible-children path for consistency: 'child' singular vs
  // 'children' plural even when names are redacted.
  const cleanChildren = childrenFirstNames.filter(c => c && c.trim());
  const childWord = cleanChildren.length === 1 ? 'child' : 'children';
  if (hasPartner) {
    return {
      displayName: `${name} & Family`,
      creditLine:  `with ${partnerName.trim()}, and ${childWord}`,
    };
  }
  return {
    displayName: `${name} & Family`,
    creditLine:  `with ${childWord}`,
  };
}

module.exports = {
  generateCertificate,
  // Exported for the publish endpoint and the public register endpoint
  // so they can compute the same family-display strings without
  // duplicating the logic. Keep these in sync — drift between them is
  // exactly the bug we're trying to prevent.
  computeFamilyDisplay,
  computeRegisterDisplay,
  formatNameList,
  combineCoupleNames,
};

// ──────────────────────────────────────────────────────────────────────────
// Name-list helpers used by the family-format rendering above.
//
// formatNameList — renders an array of names as a natural English list:
//   ["Aoife"]                 → "Aoife"
//   ["Aoife", "Liam"]         → "Aoife and Liam"
//   ["Aoife", "Liam", "Saoirse"] → "Aoife, Liam, and Saoirse" (Oxford comma)
//
// combineCoupleNames — combines two adult names into a single display string:
//   ("John Cummins", "Mary Cummins")          → "John & Mary Cummins"
//   ("John Cummins", "Mary O'Brien-Cummins")  → "John Cummins & Mary O'Brien-Cummins"
//   ("John", "Mary")                          → "John & Mary"
// Logic: if both names share the same final word (likely shared surname),
// collapse to "First1 & First2 SharedSurname". Otherwise keep both full
// names side by side. Surname-detection is naive (last whitespace-separated
// token) but handles the common case correctly without hyphenated-surname
// false collapses.
// ──────────────────────────────────────────────────────────────────────────
function formatNameList(names) {
  if (!names || names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const last = names[names.length - 1];
  const rest = names.slice(0, -1).join(', ');
  return `${rest}, and ${last}`;
}

function combineCoupleNames(name1, name2) {
  const tokens1 = name1.trim().split(/\s+/);
  const tokens2 = name2.trim().split(/\s+/);
  // Only attempt collapse if BOTH have at least 2 tokens (first + surname)
  // AND the final tokens match (case-insensitive). Otherwise keep both full.
  if (tokens1.length >= 2 && tokens2.length >= 2) {
    const surname1 = tokens1[tokens1.length - 1];
    const surname2 = tokens2[tokens2.length - 1];
    if (surname1.toLowerCase() === surname2.toLowerCase()) {
      const first1 = tokens1.slice(0, -1).join(' ');
      const first2 = tokens2.slice(0, -1).join(' ');
      return `${first1} & ${first2} ${surname1}`;
    }
  }
  // Otherwise present as two distinct full names
  return `${name1.trim()} & ${name2.trim()}`;
}
