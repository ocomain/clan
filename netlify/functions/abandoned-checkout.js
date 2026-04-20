// netlify/functions/abandoned-checkout.js
// Called by Netlify scheduled function 24hrs after application submitted
// Sends gentle reminder if no corresponding Stripe payment found

const RESEND_API_KEY = process.env.RESEND_API_KEY;

exports.handler = async (event) => {
  // This function is called with applicant data when no payment found after 24hrs
  // In Phase 2, this will query Supabase to find unpaid applications
  // For now, it can be triggered manually or via a cron job

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { name, email, tier } = data;
  const firstName = name ? name.split(' ')[0] : 'friend';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC">
<div style="max-width:580px;margin:0 auto">

  <div style="background:#0C1A0C;padding:36px 40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="80" alt="Ó Comáin" style="display:block;margin:0 auto 12px;height:auto">
    <p style="font-family:sans-serif;font-size:10px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:#B8975A;margin:0">Clan Ó Comáin · County Clare, Ireland</p>
  </div>

  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;margin:0 0 20px">Dear ${firstName},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your application to Clan Ó Comáin was received — but your membership has not yet been confirmed.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 32px">A place is still held for you in the Register of Clan Members. ${tier ? `Your selected tier — <strong>${tier}</strong> — is still available.` : ''} Complete your membership today.</p>

    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org/membership.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:16px 36px;border-radius:1px">Complete your membership</a>
    </div>

    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7">If you have any questions before joining, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> — the clan will be happy to help.</p>
  </div>

  <div style="background:#0C1A0C;padding:20px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:rgba(184,151,90,.6);margin:0 0 6px">Caithfidh an stair a bheith i réim</p>
    <p style="font-family:sans-serif;font-size:10px;color:rgba(184,151,90,.35);margin:0;letter-spacing:0.06em">Clan Ó Comáin · Newhall House · County Clare · Ireland</p>
    <p style="font-family:sans-serif;font-size:10px;color:rgba(184,151,90,.25);margin:8px 0 0"><a href="https://www.ocomain.org/unsubscribe?email=${encodeURIComponent(email)}" style="color:rgba(184,151,90,.3)">Unsubscribe</a></p>
  </div>
</div>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Ó Comáin Private Secretary <clan@ocomain.org>',
        to: email,
        subject: 'Your place in Clan Ó Comáin is still open',
        html,
      }),
    });
    if (!res.ok) throw new Error(await res.text());
    return { statusCode: 200, body: JSON.stringify({ sent: true }) };
  } catch (err) {
    console.error('Abandoned email failed:', err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
