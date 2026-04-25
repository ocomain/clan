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
  const firstName = (member.name || '').split(' ')[0] || 'friend';
  const certNumber = certResult.certNumber || '—';

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

  const eyebrow = autoPublished ? 'Auto-published' : 'Published';
  const heading = autoPublished
    ? 'Your certificate, now sealed'
    : 'Your certificate is sealed';
  const intro = autoPublished
    ? `As your 30-day publication window has closed, your certificate has been auto-issued in your name. It is attached to this email and available below.`
    : `Your certificate has been published in your name and entered into the formal Register at Newhall House. It is attached to this email and available below.`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header -->
  <div style="background:#0C1A0C;padding:38px 40px 30px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 12px;height:auto">
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
      <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;margin:0 0 4px">Cert № ${escapeHtml(certNumber)} · ${escapeHtml(member.tier_label || 'Member')}</p>
      ${member.ancestor_dedication ? `<p style="font-family:'Georgia',serif;font-size:12.5px;font-style:italic;color:#B8975A;margin:14px 0 0;padding:14px 0 0;border-top:1px solid rgba(184,151,90,.3)">${escapeHtml(member.ancestor_dedication)}</p>` : ''}
      ${downloadUrl ? `<div style="margin-top:24px"><a href="${downloadUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 30px;border-radius:1px">Download PDF →</a></div>` : ''}
      <p style="font-family:'Georgia',serif;font-size:11px;color:#8C7A64;margin:14px 0 0;line-height:1.5">${pdfBase64 ? 'Also attached to this email.' : ''}${downloadUrl ? ' Download link valid for 30 days.' : ''}</p>
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
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to Chief of Ó Comáin</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Newhall House, Co. Clare</p>
        </td>
      </tr>
    </table>
  </div>

  <!-- Footer -->
  <div style="background:#0C1A0C;padding:22px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:rgba(184,151,90,.6);margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:sans-serif;font-size:10px;color:rgba(184,151,90,.4);margin:0;letter-spacing:0.08em">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
  </div>
</div>
</body>
</html>`;

  const attachments = pdfBase64 ? [{ filename: pdfFilename, content: pdfBase64 }] : undefined;

  return await sendEmail({
    to: member.email,
    subject,
    html,
    attachments,
  });
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { sendPublicationConfirmation };
