// netlify/functions/daily-abandoned-sweep.js
// Runs on a schedule (see netlify.toml). Finds all applications that are still
// 'pending' after 24hrs and haven't yet had a reminder sent, then emails the
// applicant the abandoned-checkout message.
//
// This is the *real* abandoned-cart recovery — catches people who filled out
// the herald form but never completed Stripe (the Stripe session.expired event
// only fires if they actually got to the Stripe page).

const { supa, clanId, normaliseTier, logEvent, filterEmailsAlreadyMembers } = require('./lib/supabase');

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

    // ── Defensive filter: drop any application whose email has since
    //     become a confirmed member. The stripe-webhook does try to
    //     flip applications.status to 'paid' on payment, but that's a
    //     best-effort exact-email match — a member who reached us via
    //     a different flow (gift redemption, fresh herald form with
    //     casing/whitespace difference) may leave a stale pending row.
    //     We do NOT want to email a confirmed Life member telling them
    //     their place is 'still open'.
    //     For each match: skip the send, mark the application
    //     'superseded' so it won't be re-evaluated next run, and log
    //     the supersede event for visibility.
    const memberEmails = await filterEmailsAlreadyMembers(clan_id, apps.map(a => a.email));

    let processed = 0;
    let failed = 0;
    let superseded = 0;
    for (const app of apps) {
      try {
        const emailKey = (app.email || '').toLowerCase().trim();
        if (memberEmails.has(emailKey)) {
          await supa()
            .from('applications')
            .update({ status: 'superseded', reminder_sent_at: new Date().toISOString() })
            .eq('id', app.id);
          await logEvent({
            clan_id,
            event_type: 'abandoned_reminder_skipped_existing_member',
            payload: { application_id: app.id, email: app.email },
          });
          superseded++;
          continue;
        }

        const tierInfo = normaliseTier(app.tier);

        // Email-format guard (added 2026-06-01). Two application rows
        // (3f98f156…, 4ce34d69…) had malformed emails that failed the
        // Resend send with a 422 every single day — the sweep retried
        // them on every run because the failure threw before
        // reminder_sent_at could be set, leaving them perpetually
        // eligible. Validate first: if the address can't be a valid
        // email, mark it sent (to quarantine it out of future sweeps)
        // and log it for review rather than retrying forever.
        const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailKey || !EMAIL_RE.test(emailKey)) {
          console.warn(`sweep: skipping application ${app.id} — malformed email "${app.email}"`);
          await supa()
            .from('applications')
            .update({ reminder_sent_at: new Date().toISOString() })
            .eq('id', app.id);
          await logEvent({
            clan_id,
            event_type: 'abandoned_reminder_skipped_bad_email',
            payload: { application_id: app.id, email: app.email },
          });
          failed++;
          continue;
        }

        await sendReminder(app.email, app.name, tierInfo.label, tierInfo.tier);
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

    console.log(`sweep: processed=${processed} superseded=${superseded} failed=${failed}`);
    return { statusCode: 200, body: JSON.stringify({ processed, superseded, failed }) };
  } catch (e) {
    console.error('sweep fatal:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};

async function sendReminder(email, name, tierName, tierSlug) {
  const firstName = name ? name.split(' ')[0] : 'friend';
  // CTA target: link STRAIGHT to a pre-filled Stripe checkout via
  // /api/create-checkout?tier=<slug>&email=<email>, rather than the
  // /membership pricing page (which made an applicant start the whole
  // flow over). The applicant already chose a tier and gave their
  // email; this one-click link drops them back into checkout with both
  // pre-filled — the right path for someone whose payment failed or
  // who simply didn't finish. Each click mints a fresh checkout
  // session, so it works even after a previous 3D-Secure/decline
  // failure. Falls back to the pricing page only if we somehow lack a
  // tier slug or email.
  const ctaUrl = (tierSlug && email)
    ? `https://www.ocomain.org/api/create-checkout?tier=${encodeURIComponent(tierSlug)}&email=${encodeURIComponent(email)}`
    : 'https://www.ocomain.org/membership';
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:36px 40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/images/brand/coat_of_arms.png" width="80" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto;text-align:center;max-width:80px">Ó COMÁIN</p>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;margin:0 0 20px">Dear ${firstName},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">We tried to take payment for your membership of Clan Ó Comáin${tierName ? ` as <strong>${tierName}</strong>` : ''}, but it did not go through — so the payment was not completed and nothing has been charged to your card.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 14px">This is usually a small technical matter rather than anything to do with your balance — most often the bank's security check (the one-time code or app approval some cards require) was not completed, or the bank declined an unfamiliar online payment. Your place in the Register is still held; only this last step remains.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 28px">You do not need to fill anything in again. The button below takes you straight back to a secure checkout with your details already in place:</p>
    <div style="text-align:center;margin-bottom:14px">
      <a href="${ctaUrl}" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:16px 36px;border-radius:1px">Try your payment again</a>
    </div>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7;text-align:center;margin:0 0 28px">When the bank's security screen appears, do wait for the code or app prompt and approve it — that is the step that completes everything.</p>
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 24px;padding:14px 18px;background:rgba(184,151,90,.08);border-left:3px solid #B8975A">If it is declined again, it often helps to <strong>use a different card</strong>, or to <strong>telephone your bank first</strong> — a new online payment of this kind sometimes needs their go-ahead. And if any trouble remains, simply reply to this email or write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> and the office will see you through it personally.</p>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7">This is the <strong>first year of the revival</strong>, and those who join now are inscribed as <strong>Founding Members</strong> of Clan Ó Comáin — a designation offered in no later year.</p>
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
      subject: 'Your payment didn’t go through — let’s try again',
      html,
    }),
  });
  if (!res.ok) throw new Error(`Resend failed: ${res.status} ${await res.text()}`);
}
