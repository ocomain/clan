// netlify/functions/daily-abandoned-sweep.js
// Runs on a schedule (see netlify.toml). Finds all applications that are still
// 'pending' after 24hrs and haven't yet had a reminder sent, then emails the
// applicant the abandoned-checkout message.
//
// This is the *real* abandoned-cart recovery — catches people who filled out
// the herald form but never completed Stripe (the Stripe session.expired event
// only fires if they actually got to the Stripe page).

const { supa, clanId, normaliseTier, logEvent, filterEmailsAlreadyMembers } = require('./lib/supabase');
const { buildAbandonedReminderHtml } = require('./lib/checkout-email');

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
    // Dedup within this run: one person can have multiple pending rows
    // (double form submission). Email each address at most once.
    const seenEmails = new Set();
    for (const app of apps) {
      try {
        const emailKey = (app.email || '').toLowerCase().trim();
        if (emailKey && seenEmails.has(emailKey)) {
          await supa()
            .from('applications')
            .update({ reminder_sent_at: new Date().toISOString() })
            .eq('id', app.id);
          await logEvent({
            clan_id,
            event_type: 'abandoned_reminder_skipped_duplicate_email',
            payload: { application_id: app.id, email: app.email },
          });
          continue;
        }
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
        seenEmails.add(emailKey);
        // Mark as sent. Status stays 'pending' so if they still complete,
        // the webhook picks it up. If they never do, next sweep skips them
        // because reminder_sent_at is no longer null.
        // Stamp by EMAIL (not just this row id): if the person has
        // other pending rows from a double submission — including ones
        // submitted later, not yet in this sweep's age window — they
        // are all marked reminded now, so no future run can send the
        // same person a second decline email from a sibling row.
        await supa()
          .from('applications')
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq('clan_id', clan_id)
          .eq('status', 'pending')
          .is('reminder_sent_at', null)
          .ilike('email', emailKey);
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
  // Single source of truth: the email HTML is built by
  // buildAbandonedReminderHtml in lib/checkout-email.js, the same
  // function the preview generator uses. Previously this function had
  // its own inline duplicate of the markup, which drifted out of sync
  // with the preview. Pass the per-recipient pre-filled checkout link
  // as ctaUrl.
  const html = buildAbandonedReminderHtml({ firstName, tierName, ctaUrl });

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
