// netlify/functions/daily-abandoned-sweep.js
// Runs on a schedule (see netlify.toml). Finds all applications that are still
// 'pending' after 24hrs and haven't yet had a reminder sent, then emails the
// applicant the abandoned-checkout message.
//
// This is the *real* abandoned-cart recovery — catches people who filled out
// the herald form but never completed Stripe (the Stripe session.expired event
// only fires if they actually got to the Stripe page).

const { supa, clanId, normaliseTier, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // Pull pending applications older than 24h with no reminder yet
    const { data: apps, error } = await supa()
      .from('applications')
      .select('id, email, name, tier')
      .eq('clan_id', clan_id)
      .eq('status', 'pending')
      .is('reminder_sent_at', null)
      .lt('submitted_at', cutoff)
      .limit(50); // safety cap per run

    if (error) {
      console.error('sweep query failed:', error.message);
      return { statusCode: 500, body: JSON.stringify({ error: error.message }) };
    }

    if (!apps || apps.length === 0) {
      console.log('sweep: no abandoned applications to process');
      return { statusCode: 200, body: JSON.stringify({ processed: 0 }) };
    }

    let processed = 0;
    let failed = 0;
    for (const app of apps) {
      try {
        const tierInfo = normaliseTier(app.tier);
        await sendReminder(app.email, app.name, tierInfo.label);
        // Mark as sent. Status stays 'pending' so if they still complete,
        // the webhook picks it up. If they never do, next sweep skips them
        // because reminder_sent_at is no longer null.
        await supa()
          .from('applications')
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq('id', app.id);
        await logEvent({ clan_id, event_type: 'abandoned_reminder_sent', payload: { application_id: app.id, email: app.email } });
        processed++;
      } catch (e) {
        console.error(`sweep: failed on application ${app.id}:`, e.message);
        failed++;
      }
    }

    console.log(`sweep: processed=${processed} failed=${failed}`);
    return { statusCode: 200, body: JSON.stringify({ processed, failed }) };
  } catch (e) {
    console.error('sweep fatal:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

async function sendReminder(email, name, tierName) {
  const firstName = name ? name.split(' ')[0] : 'friend';
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:36px 40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="80" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto;text-align:center;max-width:80px">Ó COMÁIN</p>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;margin:0 0 20px">Dear ${firstName},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your application to Clan Ó Comáin was received by this office — but your membership has not yet been confirmed.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 14px">A place is still held for you in the Register of Clan Members${tierName ? ` as <strong>${tierName}</strong>` : ''}. When you are ready, the door remains open.</p>
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 32px;padding:14px 18px;background:rgba(184,151,90,.08);border-left:3px solid #B8975A">This is the <strong>first year of the revival</strong>. Those who join now are inscribed as <strong>Founding Members</strong> of Clan Ó Comáin — a designation that carries no price in any later year. From the second year onward, members join as members; this distinction will not be offered again.</p>
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org/membership.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:16px 36px;border-radius:1px">Complete your membership</a>
    </div>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7">If something went wrong with your payment or you have questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> — the office will be happy to help.</p>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Caithfidh an stair a bheith i réim</p>
    <p style="font-family:'Georgia',serif;font-size:10px;color:#A88B57;margin:4px 0 0">History must prevail</p>
  </div>
</div>
</body></html>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'Clan Ó Comáin <clan@ocomain.org>',
      to: email,
      subject: 'Your place in Clan Ó Comáin is still open',
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}
