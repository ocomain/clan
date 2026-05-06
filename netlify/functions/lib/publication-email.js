// netlify/functions/lib/publication-email.js
//
// Sends the publication-confirmation email when a cert is published.
// Used by:
//   - submit-family-details.js (member-action publication via welcome
//     form or dashboard modal)
//   - daily-cert-sweep.js (auto-publication at day 30)
//
// The email is the emotional moment of the cert becoming real. It
// includes the cert PDF as attachment so the member can keep it
// without needing to log in again.
//
// Inline cert image: deferred to a future commit. Render-to-image at
// scale on Netlify functions is fragile (needs headless browser or
// PDF→PNG conversion; both have cold-start issues). For v1 we ship a
// stylised "cert ready" visual block in the email body, and the actual
// cert is the attachment + dashboard download. Less spectacular but
// reliably delivers across all email clients.

const { sendEmail } = require('./email');
const { signCertUrl, sanitizeFilename } = require('./cert-service');

/**
 * Send the publication-confirmation email.
 *
 * @param {Object} member - the member row (post-publish, includes
 *   updated cert_version, ancestor_dedication, etc.)
 * @param {Object} certResult - return value from ensureCertificate
 *   ({ storagePath, certNumber, ... })
 * @param {Object} opts
 * @param {boolean} [opts.autoPublished=false] - true if this was the
 *   day-30 auto-publish (different framing — apologetic about taking
 *   the action on their behalf)
 * @returns {Promise<boolean>}
 */
async function sendPublicationConfirmation(member, certResult, opts = {}) {
  const autoPublished = !!opts.autoPublished;

  // Generate a fresh signed download URL valid for 30 days. The PDF is
  // also attached, but the signed URL is provided as a fallback for
  // clients that strip attachments (some corporate filters do).
  let downloadUrl = null;
  let pdfBase64 = null;
  let pdfFilename = `Clan-O-Comain-Certificate-${sanitizeFilename(member.name || member.email)}.pdf`;
  try {
    downloadUrl = await signCertUrl(certResult.storagePath, {
      ttlSeconds: 60 * 60 * 24 * 30, // 30 days
      downloadAs: pdfFilename,
    });
  } catch (err) {
    console.error('publication-email: signCertUrl failed (non-fatal):', err.message);
  }

  // Try to fetch the PDF as base64 for attachment. This is best-effort —
  // if it fails, the email still ships with the download URL.
  try {
    if (certResult.pdfBytes) {
      // pdfBytes may be present if the caller already has them in memory
      pdfBase64 = Buffer.from(certResult.pdfBytes).toString('base64');
    }
  } catch (err) {
    console.error('publication-email: pdf attachment encoding failed (non-fatal):', err.message);
  }

  const subject = autoPublished
    ? `Your certificate has been published — Clan Ó Comáin`
    : `Your certificate is published — Clan Ó Comáin`;

  const html = buildPublicationConfirmationHtml({
    member,
    certNumber: certResult.certNumber,
    autoPublished,
    downloadUrl,
    hasAttachment: !!pdfBase64,
  });

  const attachments = pdfBase64 ? [{ filename: pdfFilename, content: pdfBase64 }] : undefined;

  return await sendEmail({
    to: member.email,
    subject,
    html,
    attachments,
  });
}

/**
 * buildPublicationConfirmationHtml — HTML-only builder for the
 * cert-published confirmation email. Exposed for the email-review
 * preview tooling.
 *
 * Runtime-derived values (signed URL, attachment presence) are
 * passed in by the caller; the builder does not call signCertUrl
 * or read pdf bytes itself. Preview tooling passes a stub URL and
 * hasAttachment:true to render representative copy.
 */
function buildPublicationConfirmationHtml({ member, certNumber, autoPublished, downloadUrl, hasAttachment }) {
  const firstName = (member.name || '').split(' ')[0] || 'friend';
  const certNumDisplay = certNumber || '—';

  const eyebrow = autoPublished ? 'Auto-published' : 'Published';
  const heading = autoPublished
    ? 'Your certificate, now sealed'
    : 'Your certificate is sealed';
  const intro = autoPublished
    ? `As your 30-day publication window has closed, your certificate has been auto-issued in your name. It is attached to this email and available below.`
    : `Your certificate has been published in your name and entered into the formal Register at Newhall House. It is attached to this email and available below.`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header -->
  <div style="background:#0C1A0C;padding:38px 40px 30px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">${eyebrow}</p>
    <h1 style="font-family:'Georgia',serif;font-size:30px;font-weight:400;color:#D4B87A;margin:0;line-height:1.15">${heading}</h1>
  </div>

  <!-- Body -->
  <div style="padding:36px 40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${firstName},</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 24px">${intro}</p>

    <!-- Cert ready block -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:30px 26px;margin:0 0 28px;border-radius:2px;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Your Certificate of Membership</p>
      <p style="font-family:'Georgia',serif;font-size:24px;font-weight:400;color:#0C1A0C;margin:0 0 8px;line-height:1.2">${escapeHtml(member.name || '')}</p>
      <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;margin:0 0 4px">Cert № ${escapeHtml(certNumDisplay)} · ${escapeHtml(member.tier_label || 'Member')}</p>
      ${member.ancestor_dedication ? `<p style="font-family:'Georgia',serif;font-size:12.5px;font-style:italic;color:#B8975A;margin:14px 0 0;padding:14px 0 0;border-top:1px solid rgba(184,151,90,.3)">${escapeHtml(member.ancestor_dedication)}</p>` : ''}
      ${downloadUrl ? `<div style="margin-top:24px"><a href="${downloadUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 30px;border-radius:1px">Download PDF →</a></div>` : ''}
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">${hasAttachment ? 'Also attached to this email.' : ''}${downloadUrl ? ' Download link valid for 30 days.' : ''}</p>
    </div>

    ${autoPublished ? `
    <p style="font-family:'Georgia',serif;font-size:14.5px;font-style:italic;color:#6C5A4A;line-height:1.7;margin:0 0 20px;padding:16px 18px;background:rgba(184,151,90,.08);border-left:3px solid #B8975A">If you would have wanted to refine your name, add a dedication, or include family on the certificate before publication, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> — re-issues are at the Chief's discretion but always considered.</p>
    ` : ''}

    <!-- Signoff -->
    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:24px 0 24px">Go raibh míle maith agat — your name now stands among those of the clan.</p>

    <!-- Signatory block -->
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 12px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>
  </div>

  <!-- Footer -->
  <div style="background:#0C1A0C;padding:22px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#C8A875;margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:'Georgia',serif;font-size:11px;color:#A88B57;margin:0;letter-spacing:0.06em">Tigh Uí Chomáin · House of Ó Comáin · <a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · <a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>
  </div>
</div>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Send the gift buyer a keepsake email when their gift recipient publishes
 * their certificate. The buyer receives a copy of the recipient's published
 * cert as PDF attachment, with copy that frames it as a souvenir of the
 * gift they gave.
 *
 * Sent from:
 *   - submit-family-details.js (member-action publication, after the
 *     recipient's confirmation email)
 *   - daily-cert-sweep.js (auto-publication at day 30)
 *
 * Best-effort — failure here doesn't affect the publication itself.
 *
 * @param {Object} member - the gift recipient's member row (post-publish)
 * @param {Object} certResult - return from ensureCertificate
 *   ({ storagePath, certNumber, pdfBytes, ... })
 * @param {Object} gift - the gifts row ({ buyer_email, buyer_name,
 *   personal_message, gifted_at, ... })
 * @returns {Promise<boolean>}
 */
async function sendGiftBuyerCertKeepsake(member, certResult, gift) {
  if (!gift?.buyer_email) return false;

  const recipientFirstName = (member.name || '').split(' ')[0] || 'your recipient';

  let downloadUrl = null;
  let pdfBase64 = null;
  let pdfFilename = `Clan-O-Comain-Gift-Certificate-${sanitizeFilename(member.name || member.email)}.pdf`;
  try {
    downloadUrl = await signCertUrl(certResult.storagePath, {
      ttlSeconds: 60 * 60 * 24 * 30,
      downloadAs: pdfFilename,
    });
  } catch (err) {
    console.error('keepsake: signCertUrl failed (non-fatal):', err.message);
  }
  try {
    if (certResult.pdfBytes) {
      pdfBase64 = Buffer.from(certResult.pdfBytes).toString('base64');
    }
  } catch (err) {
    console.error('keepsake: pdf attachment encoding failed (non-fatal):', err.message);
  }

  const html = buildGiftBuyerCertKeepsakeHtml({
    member,
    certNumber: certResult.certNumber,
    gift,
    downloadUrl,
    hasAttachment: !!pdfBase64,
  });

  const attachments = pdfBase64 ? [{ filename: pdfFilename, content: pdfBase64 }] : undefined;

  return await sendEmail({
    to: gift.buyer_email,
    subject: `${recipientFirstName} has been welcomed — your gift, in the Register`,
    html,
    attachments,
  });
}

/**
 * buildGiftBuyerCertKeepsakeHtml — HTML-only builder for the
 * gift-buyer keepsake email. Same pattern as
 * buildPublicationConfirmationHtml: runtime values (signed URL,
 * attachment flag) are passed in, the builder doesn't compute them.
 */
function buildGiftBuyerCertKeepsakeHtml({ member, certNumber, gift, downloadUrl, hasAttachment }) {
  const buyerFirstName = (gift.buyer_name || '').split(' ')[0] || 'friend';
  const recipientFirstName = (member.name || '').split(' ')[0] || 'your recipient';
  const recipientFull = member.name || gift.recipient_email || 'your recipient';
  const certNumDisplay = certNumber || '—';

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <div style="background:#0C1A0C;padding:36px 40px 28px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">A keepsake from your gift</p>
    <h1 style="font-family:'Georgia',serif;font-size:30px;font-weight:400;color:#D4B87A;margin:0;line-height:1.15">${escapeHtml(recipientFirstName)} has been welcomed</h1>
  </div>

  <div style="padding:36px 40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${escapeHtml(buyerFirstName)},</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 22px">${escapeHtml(recipientFull)} has confirmed and published the certificate for the membership you gave them. They are now formally entered in the Register of Clan Ó Comáin, held at Newhall House, County Clare.</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 24px">A copy of their published certificate is attached for you — a small keepsake of the gift you've given.</p>

    <!-- Cert keepsake block -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:30px 26px;margin:0 0 28px;border-radius:2px;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.26em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Their published certificate</p>
      <p style="font-family:'Georgia',serif;font-size:24px;font-weight:400;color:#0C1A0C;margin:0 0 8px;line-height:1.2">${escapeHtml(member.name || '')}</p>
      <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;margin:0 0 4px">Cert № ${escapeHtml(certNumDisplay)} · ${escapeHtml(member.tier_label || 'Member')}</p>
      ${member.ancestor_dedication ? `<p style="font-family:'Georgia',serif;font-size:12.5px;font-style:italic;color:#B8975A;margin:14px 0 0;padding:14px 0 0;border-top:1px solid rgba(184,151,90,.3)">${escapeHtml(member.ancestor_dedication)}</p>` : ''}
      ${downloadUrl ? `<div style="margin-top:24px"><a href="${downloadUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 30px;border-radius:1px">Download PDF →</a></div>` : ''}
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">${hasAttachment ? 'Also attached to this email.' : ''}${downloadUrl ? ' Download link valid for 30 days.' : ''}</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0 0 24px">Go raibh míle maith agat — for bringing another name to the clan.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p><p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>
  </div>

  <div style="background:#0C1A0C;padding:22px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#C8A875;margin:0">Caithfidh an stair a bheith i réim — History must prevail</p>
  </div>
</div>
</body>
</html>`;
}

module.exports = {
  sendPublicationConfirmation,
  sendGiftBuyerCertKeepsake,
  buildPublicationConfirmationHtml,
  buildGiftBuyerCertKeepsakeHtml,
};
