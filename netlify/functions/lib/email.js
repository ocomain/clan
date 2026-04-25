// netlify/functions/lib/email.js
//
// Shared email helper for all functions that need to send mail.
// Uses Resend (RESEND_API_KEY env var). Supports optional attachments
// (used by publication-confirmation email to include the cert PDF).
//
// Sender convention: 'Clan Ó Comáin <clan@ocomain.org>'.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM = 'Clan Ó Comáin <clan@ocomain.org>';

/**
 * Send an email via Resend.
 *
 * @param {Object} opts
 * @param {string} opts.to            - recipient email address
 * @param {string} opts.subject       - subject line
 * @param {string} opts.html          - HTML body
 * @param {Object[]} [opts.attachments] - optional Resend-format attachments
 *                                        each: { filename, content (base64) }
 * @param {string|string[]} [opts.bcc] - optional BCC
 * @returns {Promise<boolean>} true if 2xx response
 */
async function sendEmail({ to, subject, html, attachments, bcc }) {
  if (!RESEND_API_KEY) {
    console.error('RESEND_API_KEY not configured — skipping email send');
    return false;
  }

  const body = { from: FROM, to, subject, html };
  if (Array.isArray(attachments) && attachments.length) body.attachments = attachments;
  if (bcc) body.bcc = bcc;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      console.error(`Resend error (${res.status}):`, err.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error('Resend exception:', err.message);
    return false;
  }
}

module.exports = { sendEmail };
