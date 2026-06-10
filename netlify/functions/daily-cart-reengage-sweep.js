// netlify/functions/daily-cart-reengage-sweep.js
//
// Daily sweep dispatching the four cart re-engagement emails at
// +2/+7/+21/+45 days after applications.submitted_at — i.e. measured
// from when the application was completed, NOT from the decline
// reminder. This is the re-engagement sequence for everyone who
// completed the application but never completed payment; it is a
// DIFFERENT audience from the payment-declined email
// (daily-abandoned-sweep.js, for cards entered but failed) and runs
// independently of whether that reminder was ever sent.
//
// LEGAL POSTURE — every email is anchored to the user's unfinished
// application. The cadence tapers toward a stop at +45. This sits
// firmly within GDPR Article 6(1)(f) legitimate interest / PECR's
// soft opt-in for unfinished commercial transactions. Each dispatch
// is preceded by a status check — if the application has flipped to
// 'paid' or any non-'pending' state, the sequence exits cleanly.
//
// AGE BUCKETING — same one-day-wide bucket pattern as the other
// sweeps. For each email at age N, find rows where submitted_at
// falls in [now - (N+1)days, now - N days). One day wide, so each
// application becomes eligible for exactly one bucket on exactly one
// day. If the cron misses a day, members in that day's bucket are
// NOT re-caught later.
//
// PER-BUCKET LIMIT 50.

const { supa, clanId, logEvent, filterEmailsAlreadyMembers } = require('./lib/supabase');
const {
  sendReengage1_Practical,
  sendReengage2_Legitimacy,
  sendReengage3_CivicValue,
  sendReengage4_FinalClose,
} = require('./lib/cart-reengage-email');

const DAY_MS = 24 * 60 * 60 * 1000;
const PER_BUCKET_LIMIT = 50;

function bucketRange(now, ageDays) {
  const earliest = new Date(now.getTime() - (ageDays + 1) * DAY_MS).toISOString();
  const latest   = new Date(now.getTime() - ageDays       * DAY_MS).toISOString();
  return { earliest, latest };
}

async function processBucket({ clan_id, now, ageDays, trackingColumn, sendFn, bucketLabel, isFinal }) {
  const { earliest, latest } = bucketRange(now, ageDays);

  // Trigger from the APPLICATION time (submitted_at), independent of
  // whether the decline/abandoned reminder was ever sent. This is the
  // re-engagement sequence for everyone who completed the application
  // but never completed payment — a DIFFERENT audience from the
  // payment-declined email (which is for cards entered but failed).
  // Previously this keyed off reminder_sent_at, which chained it
  // behind the 24h decline reminder; now RE-1 fires 48h after the
  // application itself. The 1-day-wide bucket window matches the daily
  // 15:30 UTC cron, so each application is caught once per stage.
  const { data: targets, error } = await supa()
    .from('applications')
    .select('id, email, name, tier, status, submitted_at')
    .eq('clan_id', clan_id)
    .eq('status', 'pending')
    .is(trackingColumn, null)
    .is('reengage_complete_at', null)
    .gte('submitted_at', earliest)
    .lt('submitted_at', latest)
    .limit(PER_BUCKET_LIMIT);

  if (error) {
    console.error(`reengage-sweep: ${bucketLabel} query failed:`, error.message);
    return { sent: 0, failed: 0, superseded: 0 };
  }

  // ── Defensive filter: drop any application whose email has since
  //     become a confirmed member. The stripe-webhook does try to
  //     flip applications.status to 'paid' on payment, but that's a
  //     best-effort exact-email match — a member who reached us via
  //     a different flow may leave a stale pending row that the
  //     bucketing query will still pick up. Belt-and-braces here so
  //     we never email a confirmed member a re-engagement nudge.
  const memberEmails = await filterEmailsAlreadyMembers(clan_id, (targets || []).map(t => t.email));

  let sent = 0, failed = 0, superseded = 0;
  // Dedup within this bucket run: a single person can have more than
  // one pending application row (e.g. they submitted the herald form
  // twice). Without this, each row triggers its own copy of the same
  // re-engagement email — the person receives duplicates. Email the
  // FIRST row for a given address; for any later row with the same
  // email, stamp it complete (so it won't linger or re-fire) but send
  // nothing.
  const seenEmails = new Set();

  for (const app of targets || []) {
    try {
      const emailKey = (app.email || '').toLowerCase().trim();
      if (memberEmails.has(emailKey)) {
        // Mark superseded + complete so this row is never picked up
        // again by any bucket. Don't stamp the trackingColumn — that
        // would imply we sent the email, which we did not.
        await supa()
          .from('applications')
          .update({ status: 'superseded', reengage_complete_at: new Date().toISOString() })
          .eq('id', app.id);
        await logEvent({
          clan_id,
          event_type: 'cart_reengage_skipped_existing_member',
          payload: { application_id: app.id, email: app.email, bucket: bucketLabel },
        });
        superseded += 1;
        continue;
      }

      if (emailKey && seenEmails.has(emailKey)) {
        // Duplicate pending row for an address we've already emailed
        // this run — close it out without sending again.
        await supa()
          .from('applications')
          .update({ reengage_complete_at: new Date().toISOString() })
          .eq('id', app.id);
        await logEvent({
          clan_id,
          event_type: 'cart_reengage_skipped_duplicate_email',
          payload: { application_id: app.id, email: app.email, bucket: bucketLabel },
        });
        continue;
      }

      const ok = await sendFn(app);
      if (ok) {
        seenEmails.add(emailKey);
        const update = { [trackingColumn]: new Date().toISOString() };
        // RE-4 is the terminal email — also stamp reengage_complete_at
        // so the cron will not pick this row up for any further bucket.
        if (isFinal) update.reengage_complete_at = new Date().toISOString();
        await supa().from('applications').update(update).eq('id', app.id);
        // Close out any SIBLING pending rows for the same address
        // (double submissions, possibly in different age buckets).
        // Without this, a second row submitted hours later — landing
        // in tomorrow's bucket — would send this person the same
        // stage again. The emailed row above carries the sequence;
        // the siblings are marked complete and go quiet.
        if (emailKey) {
          await supa()
            .from('applications')
            .update({ reengage_complete_at: new Date().toISOString() })
            .eq('clan_id', clan_id)
            .eq('status', 'pending')
            .is('reengage_complete_at', null)
            .neq('id', app.id)
            .ilike('email', emailKey);
        }
        await logEvent({
          clan_id,
          event_type: 'cart_reengage_email_sent',
          payload: { application_id: app.id, bucket: bucketLabel },
        });
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      console.error(`reengage-sweep: ${bucketLabel} send failed for`, app.email, err.message);
      failed += 1;
    }
  }

  return { sent, failed, superseded };
}

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    const stats = { re1: null, re2: null, re3: null, re4: null };

    stats.re1 = await processBucket({
      clan_id, now, ageDays: 2,
      trackingColumn: 'reengage_1_sent_at',
      sendFn: sendReengage1_Practical,
      bucketLabel: 're1', isFinal: false,
    });

    stats.re2 = await processBucket({
      clan_id, now, ageDays: 7,
      trackingColumn: 'reengage_2_sent_at',
      sendFn: sendReengage2_Legitimacy,
      bucketLabel: 're2', isFinal: false,
    });

    stats.re3 = await processBucket({
      clan_id, now, ageDays: 21,
      trackingColumn: 'reengage_3_sent_at',
      sendFn: sendReengage3_CivicValue,
      bucketLabel: 're3', isFinal: false,
    });

    stats.re4 = await processBucket({
      clan_id, now, ageDays: 45,
      trackingColumn: 'reengage_4_sent_at',
      sendFn: sendReengage4_FinalClose,
      bucketLabel: 're4', isFinal: true,
    });

    console.log('cart-reengage-sweep complete:', JSON.stringify(stats));
    return { statusCode: 200, body: JSON.stringify(stats) };
  } catch (err) {
    console.error('cart-reengage-sweep: fatal error:', err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
