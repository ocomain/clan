// netlify/functions/lib/notify-giver-activated.js
//
// Sends a single "your gift was accepted" email to the original giver when
// the recipient of a gifted membership signs into their members' area for
// the first time.
//
// Called from member-info.js with a guard (activated_notified_at stamped
// BEFORE the email send), so this module doesn't need to handle
// deduplication itself. If Resend fails, the email is lost for this gift —
// acceptable trade-off since the alternative is holding the signal and
// retrying, which risks multiple emails.
//
// Shape intentionally shallow so it can be unit-tested in isolation.

const RESEND_API_KEY = process.env.RESEND_API_KEY;

async function notifyGiverOfActivation({
  buyerEmail,
  buyerName,
  recipientName,
  recipientEmail,
  tierLabel,
}) {
  if (!buyerEmail) return;
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not configured — skipping giver activation email');
    return;
  }

  const firstName = buyerName ? buyerName.split(' ')[0] : 'friend';
  const recipientDisplay = recipientName || recipientEmail || 'your recipient';
  const recipientFirst = recipientDisplay.split(' ')[0];
  const tier = tierLabel || 'Clan';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 12px;height:auto">
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">A message from the clan</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0;line-height:1.2">Your gift was accepted</h1>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${escapeHtml(firstName)},</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px"><strong>${escapeHtml(recipientDisplay)}</strong> has signed into their members' area for the first time and taken up their place in Clan Ó Comáin.</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 28px">Your gift of a <strong>${escapeHtml(tier)}</strong> membership has been accepted. ${escapeHtml(recipientFirst)} is now a full member of the clan — their name on the Register, their certificate in hand, their line entered at Newhall.</p>

    <!-- A quiet italic moment -->
    <div style="border-left:3px solid #B8975A;padding:4px 0 4px 20px;margin:0 0 28px;background:rgba(184,151,90,0.05)">
      <p style="font-family:'Georgia',serif;font-size:15px;font-style:italic;color:#3C2A1A;line-height:1.75;margin:0">This was once a family, scattered across the world. Every gift like yours is how it gathers again.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">We thought you'd want to know.</p>

    <!-- Another gift CTA — warm, not pushy -->
    <div style="background:rgba(184,151,90,.08);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:22px 24px;margin:0 0 28px;border-radius:0 2px 2px 0;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Another in the family?</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0 0 16px">If another cousin, sibling, or friend would feel the same call, you can send another gift at any time.</p>
      <a href="https://www.ocomain.org/gift.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:13px 28px;border-radius:1px">Send another gift →</a>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;margin:0 0 24px">Go raibh míle maith agat.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Commane Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh · Newhall House, Co. Clare</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:rgba(184,151,90,.6);margin:0">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
  </div>
</div>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Clan Ó Comáin <clan@ocomain.org>',
        to: buyerEmail,
        subject: `${recipientFirst} has joined the clan — your gift was accepted`,
        html,
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Resend error (giver activation):', err);
    }
  } catch (e) {
    console.error('giver activation send failed:', e.message);
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

module.exports = { notifyGiverOfActivation };
