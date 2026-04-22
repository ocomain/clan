// netlify/functions/lib/generate-cert.js
// Pure function: takes member/recipient data, returns a PDF buffer.
// Uses self-hosted EB Garamond + Jost (embedded TTF) via @pdf-lib/fontkit.
// No network calls. Safe to invoke on every request.

const { PDFDocument, rgb, PageSizes } = require('pdf-lib');
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
const C_MUTED  = rgb(0.424, 0.353, 0.290);  // #6C5A4A
const C_CREAM  = rgb(0.973, 0.957, 0.925);  // #F8F4EC

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
async function generateCertificate({ name, tierLabel, joinedAt, certNumber, shieldPng, signaturePng }) {
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

  // Recipient name — large gold italic, the emotional centre of the cert
  const recipientSize = 34;
  const recipientWidth = fontSerifItalic.widthOfTextAtSize(name, recipientSize);
  // If the name is too wide, shrink it gracefully
  let actualRecipientSize = recipientSize;
  let actualRecipientWidth = recipientWidth;
  const maxNameWidth = W - 2 * (margin + 60);
  if (recipientWidth > maxNameWidth) {
    actualRecipientSize = recipientSize * (maxNameWidth / recipientWidth);
    actualRecipientWidth = fontSerifItalic.widthOfTextAtSize(name, actualRecipientSize);
  }
  page.drawText(name, {
    x: (W - actualRecipientWidth) / 2,
    y: ruleY - 160,
    size: actualRecipientSize,
    font: fontSerifItalic,
    color: C_GOLD_L,
  });

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
    y: ruleY - 200,
    size: registerSize,
    font: fontSerif,
    color: C_INK_S,
  });
  page.drawText(register2, {
    x: (W - register2Width) / 2,
    y: ruleY - 220,
    size: registerSize,
    font: fontSerif,
    color: C_INK_S,
  });

  const register3 = 'an ancient Gaelic royal house recognised by Clans of Ireland.';
  const register3Width = fontSerifItalic.widthOfTextAtSize(register3, registerSize);
  page.drawText(register3, {
    x: (W - register3Width) / 2,
    y: ruleY - 240,
    size: registerSize,
    font: fontSerifItalic,
    color: C_MUTED,
  });

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

module.exports = { generateCertificate };
