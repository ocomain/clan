// netlify/functions/lib/generate-cert.js
// Pure function: takes member/recipient data, returns a PDF buffer.
// Uses pdf-lib's built-in Times fonts + embedded shield PNG from the site.
// No network calls, no external font files. Safe to invoke on every request.

const { PDFDocument, rgb, PageSizes } = require('pdf-lib');
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

/**
 * Generate a member certificate PDF.
 * @param {Object} opts
 * @param {string} opts.name       - recipient full name
 * @param {string} opts.tierLabel  - e.g. "Clan Member" / "Guardian of the Clan"
 * @param {string} opts.joinedAt   - ISO timestamp
 * @param {string} opts.certNumber - short unique cert number
 * @param {Buffer} opts.shieldPng  - PNG buffer of the coat of arms
 * @returns {Promise<Uint8Array>}  PDF bytes
 */
async function generateCertificate({ name, tierLabel, joinedAt, certNumber, shieldPng }) {
  // Sanitize all string inputs to WinAnsi-safe characters since pdf-lib's
  // standard fonts only speak WinAnsi. Replaces typographic quotes/dashes
  // that might arrive via copy-paste; unknown chars are dropped rather than
  // crashing the whole PDF.
  name       = sanitizeWinAnsi(name       || 'Member of the Clan');
  tierLabel  = sanitizeWinAnsi(tierLabel  || 'Clan Member');
  certNumber = sanitizeWinAnsi(certNumber || 'OC-UNKNOWN');

  const doc = await PDFDocument.create();
  doc.setTitle(`Certificate of Membership — ${name}`);
  doc.setAuthor('Clan Ó Comáin');
  doc.setSubject('Clan Ó Comáin Membership Certificate');
  doc.setCreationDate(new Date(joinedAt));

  const page = doc.addPage([W, H]);

  // Fonts — built-in PDF Standard 14, hardcoded by name to avoid any issue
  // with StandardFonts enum availability across pdf-lib versions.
  const fontSerif       = await doc.embedFont('Times-Roman');
  const fontSerifItalic = await doc.embedFont('Times-Italic');
  const fontSans        = await doc.embedFont('Helvetica');
  const fontSansBold    = await doc.embedFont('Helvetica-Bold');

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

  // Certificate Title
  const title = 'Certificate of Membership';
  const titleSize = 24;
  const titleWidth = fontSerif.widthOfTextAtSize(title, titleSize);
  page.drawText(title, {
    x: (W - titleWidth) / 2,
    y: ruleY - 38,
    size: titleSize,
    font: fontSerif,
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
  const register1 = `is hereby entered as a ${tierLabel} of Clan Ó Comáin`;
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

  // Signature area — left Chief, right Register
  const sigY = margin + 100;
  const sigLineLen = 140;

  // Chief signature (left)
  const sigLeftX = W * 0.28;
  page.drawLine({
    start: { x: sigLeftX - sigLineLen/2, y: sigY + 28 },
    end:   { x: sigLeftX + sigLineLen/2, y: sigY + 28 },
    thickness: 0.5,
    color: C_GOLD,
  });
  drawCentered(page, 'Fergus Kinfauns, The Commane', fontSerif, 11, C_INK, sigY + 12, sigLeftX);
  drawCentered(page, 'Chief of Ó Comáin', fontSerifItalic, 9, C_MUTED, sigY - 2, sigLeftX);

  // Register (right)
  const sigRightX = W * 0.72;
  page.drawLine({
    start: { x: sigRightX - sigLineLen/2, y: sigY + 28 },
    end:   { x: sigRightX + sigLineLen/2, y: sigY + 28 },
    thickness: 0.5,
    color: C_GOLD,
  });
  drawCentered(page, 'Newhall House, County Clare', fontSerif, 11, C_INK, sigY + 12, sigRightX);
  drawCentered(page, 'Registered', fontSerifItalic, 9, C_MUTED, sigY - 2, sigRightX);

  // Cert metadata footer
  const issuedDate = new Date(joinedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const footerText = `Issued ${issuedDate}   ·   Cert No. ${certNumber}`;
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

// Helper: strip / normalise characters that WinAnsi can't encode, so member
// names with unexpected unicode (e.g. copy-pasted curly quotes, weird symbols,
// CJK) don't crash cert generation. Common typographic replacements first,
// then anything outside Latin-1 gets dropped.
function sanitizeWinAnsi(s) {
  if (!s) return '';
  return String(s)
    .replace(/[\u2018\u2019]/g, "'")      // curly single quotes → straight
    .replace(/[\u201C\u201D]/g, '"')      // curly double quotes → straight
    .replace(/\u2013/g, '-')              // en dash → hyphen
    .replace(/\u2014/g, '-')              // em dash → hyphen (WinAnsi has it, but safer)
    .replace(/\u2026/g, '...')            // ellipsis → three dots
    .replace(/\u2116/g, 'No.')            // numero sign → No.
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, ''); // drop anything outside Latin-1
}

module.exports = { generateCertificate };
