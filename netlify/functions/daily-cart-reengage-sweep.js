// netlify/functions/daily-cart-reengage-sweep.js
//
// Daily sweep dispatching the four cart re-engagement emails at
// +10/+25/+50/+90 days after applications.reminder_sent_at (the
// existing 24h reminder fired by daily-abandoned-sweep.js).
//
// LEGAL POSTURE — every email is anchored to the user's unfinished
// application. The cadence tapers exponentially toward a stop at
// +90. This sits firmly within GDPR Article 6(1)(f) legitimate
// interest / PECR's soft opt-in for unfinished commercial
// transactions. Each dispatch is preceded by a status check —
// if the application has flipped to 'paid' or any non-'pending'
// state, the sequence exits cleanly.
//
// AGE BUCKETING — same one-day-wide bucket pattern as the other
// sweeps. For each email at age N, find rows where
// reminder_sent_at falls in [now - (N+1)days, now - N days). One
// day wide, so each application becomes eligible for exactly one
// bucket on exactly one day. If the cron misses a day, members
// in that day's bucket are NOT re-caught later.
//
// PER-BUCKET LIMIT 50.

const { supa, clanId, logEvent } = require('./lib/supabase');
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

  const { data: targets, error } = await supa()
    .from('applications')
    .select('id, email, name, tier, status, resume_token, reminder_sent_at')
    .eq('clan_id', clan_id)
    .eq('status', 'pending')
    .not('reminder_sent_at', 'is', null)
    .is(trackingColumn, null)
    .is('reengage_complete_at', null)
    .gte('reminder_sent_at', earliest)
    .lt('reminder_sent_at', latest)
    .limit(PER_BUCKET_LIMIT);

  if (error) {
    console.error(`reengage-sweep: ${bucketLabel} query failed:`, error.message);
    return { sent: 0, failed: 0 };
  }

  let sent = 0, failed = 0;

  for (const app of targets || []) {
    try {
      const ok = await sendFn(app);
      if (ok) {
        const update = { [trackingColumn]: new Date().toISOString() };
        // RE-4 is the terminal email — also stamp reengage_complete_at
        // so the cron will not pick this row up for any further bucket.
        if (isFinal) update.reengage_complete_at = new Date().toISOString();
        await supa().from('applications').update(update).eq('id', app.id);
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

  return { sent, failed };
}

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    const stats = { re1: null, re2: null, re3: null, re4: null };

    stats.re1 = await processBucket({
      clan_id, now, ageDays: 10,
      trackingColumn: 'reengage_1_sent_at',
      sendFn: sendReengage1_Practical,
      bucketLabel: 're1', isFinal: false,
    });

    stats.re2 = await processBucket({
      clan_id, now, ageDays: 25,
      trackingColumn: 'reengage_2_sent_at',
      sendFn: sendReengage2_Legitimacy,
      bucketLabel: 're2', isFinal: false,
    });

    stats.re3 = await processBucket({
      clan_id, now, ageDays: 50,
      trackingColumn: 'reengage_3_sent_at',
      sendFn: sendReengage3_CivicValue,
      bucketLabel: 're3', isFinal: false,
    });

    stats.re4 = await processBucket({
      clan_id, now, ageDays: 90,
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
