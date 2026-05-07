// netlify/functions/lib/cert-reminder-email.js
//
// Sends the day-29 "publishing in 24 hours" reminder. This is the
// time-sensitive nudge that fires when a member is about to have
// their certificate auto-published at the +30 day window — it shows
// them the current draft details (name, tier, family, ancestor
// dedication) so they have a final opportunity to refine before
// the seal is set automatically.
//
// Used by:
//   - daily-cert-sweep.js (the daily scheduled function)
//
// Companion to publication-email.js: this module handles the
// pre-publish reminder; publication-email handles the post-publish
// confirmation (whether self-published or auto-published).
//
// Sender voice: Linda Cryan (Office of the Private Secretary). Linda
// is the practical, working-secretary voice — the Herald's +3 letter
// and Maria's correspondence carry the ceremonial weight; Linda
// carries the action-oriented messages. The day-29 reminder is in
// her register because its job is to tell the member "here is what
// will happen tomorrow if you do nothing".

const { sendEmail } = require('./email');
const { buildSignInUrl } = require('./signin-token');

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build the day-29 reminder HTML.
 *
 * @param {Object} args
 * @param {Object} args.member - the member row (preview-flow may pass a
 *   stubbed object; production passes the full row from the cert-sweep
 *   query)
 * @param {string} args.suggestedName - the name as it would appear on
 *   the certificate after autoFixName(member.name) — i.e. the name
 *   the auto-publish will use if the member doesn't refine
 * @param {string} args.signInUrl - one-click magic link into the
 *   member's dashboard, deep-linked to the cert-publish flow. In
 *   production this is built via buildSignInUrl with a 7-day TTL.
 *   In preview, a placeholder URL is acceptable.
 * @returns {string} HTML email body
 */
function buildCertReminderHtml({ member, suggestedName, signInUrl }) {
  const firstName = (member.name || '').split(' ')[0] || 'friend';
  const familyDetails = member.tier_family && (member.partner_name || (member.children_first_names && member.children_first_names.length))
    ? `<p style="margin:0 0 4px"><strong style="color:#0C1A0C">Family on certificate:</strong> ${escapeHtml(member.partner_name || '—')}${member.children_first_names && member.children_first_names.length ? ' and ' + escapeHtml(member.children_first_names.join(', ')) : ''}</p>`
    : '';
  const ancestor = member.ancestor_dedication
    ? `<p style="margin:0 0 4px"><strong style="color:#0C1A0C">Ancestor dedication:</strong> ${escapeHtml(member.ancestor_dedication)}</p>`
    : `<p style="margin:0 0 4px"><strong style="color:#0C1A0C">Ancestor dedication:</strong> <em>(none — your certificate will not include a dedication)</em></p>`;

  const nameWillFix = suggestedName !== member.name;

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:36px 40px 28px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="76" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;font-weight:700;letter-spacing:0.18em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:76px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">Final 24 hours</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0;line-height:1.2">Your certificate seals tomorrow</h1>
  </div>

  <div style="padding:36px 40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 18px">Dear ${escapeHtml(firstName)},</p>
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 22px">Your 30-day window to refine the details of your entry closes in 24 hours. After that, the Chief sets his seal upon your certificate automatically, in your name as it stands on your record. This is your final opportunity to refine the details.</p>

    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-top:3px solid #B8975A;padding:22px 24px;margin:0 0 24px;border-radius:2px">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 14px">Your certificate will read</p>
      <p style="font-family:'Georgia',serif;font-size:13.5px;color:#3C2A1A;line-height:1.75;margin:0 0 4px"><strong style="color:#0C1A0C">Name on certificate:</strong> ${escapeHtml(suggestedName)}${nameWillFix ? ` <em style="color:#8C7A64">(auto-corrected from "${escapeHtml(member.name || '')}")</em>` : ''}</p>
      <p style="font-family:'Georgia',serif;font-size:13.5px;color:#3C2A1A;line-height:1.75;margin:0 0 4px"><strong style="color:#0C1A0C">Tier:</strong> ${escapeHtml(member.tier_label || 'Member')}</p>
      ${familyDetails}
      ${ancestor}
    </div>

    <div style="text-align:center;margin:0 0 28px">
      <a href="${signInUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:14px 30px;border-radius:1px">Refine and seal now &rarr;</a>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;margin:12px 0 0;line-height:1.5">One click signs you in.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:14.5px;font-style:italic;color:#6C5A4A;line-height:1.7;margin:0 0 24px">If the details above are how you'd like your certificate to read, no action is needed — the Chief sets his seal automatically tomorrow.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0 0;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p><p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">&middot;</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
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

/**
 * Send the day-29 reminder. Builds the magic-link sign-in URL,
 * builds the HTML, and sends. Returns the sendEmail result.
 *
 * @param {Object} member - the member row
 * @param {string} suggestedName - autoFixName-corrected name
 * @returns {Promise<boolean>}
 */
async function sendCertReminder(member, suggestedName) {
  // ── ONE-CLICK SIGN-IN URL ────────────────────────────────────────
  // Day-29 reminder is high-urgency (member has 24 hours to refine
  // before auto-publish). One-click is essential here — making them
  // request a magic link adds friction at the worst moment. Falls
  // back to login.html?email if token issuance fails.
  const signInUrl = await buildSignInUrl({
    memberId: member.id,
    email:    member.email,
    purpose:  'cert_reminder',
    // Short TTL: this email is time-sensitive (24h before auto-pub)
    // so a 7-day window covers any realistic engagement scenario
    // while limiting the URL's lifespan.
    ttlDays:  7,
  });

  const html = buildCertReminderHtml({ member, suggestedName, signInUrl });

  return await sendEmail({
    to: member.email,
    subject: 'Your certificate seals in 24 hours — refine now if needed',
    html,
  });
}

module.exports = {
  buildCertReminderHtml,
  sendCertReminder,
};
