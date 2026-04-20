// netlify/functions/submit-gift.js
// Called when gift form is submitted
// Emails clan@ocomain.org with all gift details before Stripe redirect

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { tier, price, family, giftMode, giftModeLabel,
          giverName, giverEmail,
          recipientName, recipientName2, recipientEmail,
          address, message, connection } = data;

  // Default fallbacks for older form submissions that don't include giftMode
  const modeLabel = giftModeLabel || (giftMode === 'recurring' ? 'Renewing annually' : 'One-year gift');
  const modeColor = giftMode === 'recurring' ? '#A47A2C' : '#0C1A0C';

  const html = `<div style="font-family:sans-serif;max-width:580px">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px">
      🎁 Gift membership — Clan Ó Comáin
    </h2>

    <h3 style="color:#B8975A;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;font-weight:600">Membership tier</h3>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666;width:130px">Tier</td><td style="padding:10px;border:1px solid #ddd"><strong>${tier}</strong></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Price</td><td style="padding:10px;border:1px solid #ddd"><strong style="color:#B8975A">${price}</strong></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Type</td><td style="padding:10px;border:1px solid #ddd">${family ? 'Family' : 'Individual'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Gift mode</td><td style="padding:10px;border:1px solid #ddd"><strong style="color:${modeColor}">${modeLabel}</strong></td></tr>
    </table>

    <h3 style="color:#B8975A;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;font-weight:600">From (Giver)</h3>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666;width:130px">Name</td><td style="padding:10px;border:1px solid #ddd"><strong>${giverName}</strong></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Email</td><td style="padding:10px;border:1px solid #ddd"><a href="mailto:${giverEmail}">${giverEmail}</a></td></tr>
    </table>

    <h3 style="color:#B8975A;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;font-weight:600">To (Recipient)</h3>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666;width:130px">Name</td><td style="padding:10px;border:1px solid #ddd"><strong>${recipientName}</strong></td></tr>
      ${recipientName2 ? `<tr><td style="padding:10px;border:1px solid #ddd;color:#666">Second adult</td><td style="padding:10px;border:1px solid #ddd">${recipientName2}</td></tr>` : ''}
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Email</td><td style="padding:10px;border:1px solid #ddd"><a href="mailto:${recipientEmail}">${recipientEmail}</a></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Address</td><td style="padding:10px;border:1px solid #ddd">${address}</td></tr>
      ${connection ? `<tr><td style="padding:10px;border:1px solid #ddd;color:#666">Connection</td><td style="padding:10px;border:1px solid #ddd">${connection}</td></tr>` : ''}
    </table>

    ${message ? `<h3 style="color:#B8975A;font-size:13px;letter-spacing:0.1em;text-transform:uppercase;font-weight:600">Personal message</h3>
    <div style="background:#F8F4EC;border-left:3px solid #B8975A;padding:16px 20px;margin-bottom:20px;font-style:italic;color:#3C2A1A">"${message}"</div>` : ''}

    <p style="font-size:13px;color:#666;border-top:1px solid #eee;padding-top:12px">Payment via Stripe to follow — confirm delivery of certificate once payment is confirmed in Stripe dashboard.</p>
  </div>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Clan Ó Comáin <clan@ocomain.org>',
        to: CLAN_EMAIL,
        subject: `Gift membership: ${recipientName} from ${giverName} — ${tier}`,
        html,
      }),
    });
  } catch (err) {
    console.error('Gift email failed:', err);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
