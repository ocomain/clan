// netlify/functions/daily-pdf-lead-sweep.js
//
// Daily cron sweep for the PDF lead-magnet email lifecycle. Dispatches
// Emails 2/3/4/5 at +3/+10/+21/+35 days from confirmed_at.
//
// (Email 1 is fired synchronously by confirm-roots.js on the
// confirmation click, NOT by this cron.)
//
// CONVERSION-CHECK — every dispatch is preceded by a check against
// the members table. If a row exists with the same email address
// (case-insensitive), the subscriber has converted to a member and
// the lead-magnet sequence stops for them. converted_to_member_at
// is stamped to short-circuit future cron runs.
//
// AGE BUCKETING — same one-day-wide bucket pattern as
// daily-post-signup-sweep.js: for each email at age N, find rows
// where confirmed_at falls in [now - (N+1)days, now - N days). One
// day wide, so each subscriber becomes eligible for exactly one
// bucket on exactly one day. If the cron misses a day, members in
// that day's bucket are NOT re-caught later.
//
// PER-BUCKET LIMIT 50. More than enough headroom for the expected
// volume; raise + parallelise if it materially grows.

const { supa, clanId, logEvent } = require('./lib/supabase');
const {
  sendEmail2_Standing,
  sendEmail3_Certificate,
  sendEmail4_Invitation,
  sendEmail5_FinalInvitation,
} = require('./lib/pdf-lead-email');

const DAY_MS = 24 * 60 * 60 * 1000;
const PER_BUCKET_LIMIT = 50;

function bucketRange(now, ageDays) {
  const earliest = new Date(now.getTime() - (ageDays + 1) * DAY_MS).toISOString();
  const latest   = new Date(now.getTime() - ageDays       * DAY_MS).toISOString();
  return { earliest, latest };
}

// Returns true if the subscriber's email matches a row in members.
async function hasConvertedToMember(clan_id, email) {
  const { data, error } = await supa()
    .from('members')
    .select('id')
    .eq('clan_id', clan_id)
    .ilike('email', email)
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error('hasConvertedToMember: lookup failed:', error.message);
    return false;  // fail-open: better to send than to silently skip on a transient DB issue
  }
  return !!data;
}

// Generic dispatcher for one bucket. Each bucket has its own age, its
// own tracking column, and its own sender function.
async function processBucket({ clan_id, now, ageDays, trackingColumn, sendFn, bucketLabel }) {
  const { earliest, latest } = bucketRange(now, ageDays);

  const { data: targets, error } = await supa()
    .from('pdf_subscribers')
    .select('id, email, first_name, confirmed_at, unsubscribe_token')
    .eq('clan_id', clan_id)
    .not('confirmed_at', 'is', null)
    .is(trackingColumn, null)
    .is('converted_to_member_at', null)
    .is('unsubscribed_at', null)
    .gte('confirmed_at', earliest)
    .lt('confirmed_at', latest)
    .limit(PER_BUCKET_LIMIT);

  if (error) {
    console.error(`pdf-lead-sweep: ${bucketLabel} query failed:`, error.message);
    return { sent: 0, skipped_converted: 0, failed: 0 };
  }

  let sent = 0, skipped_converted = 0, failed = 0;

  for (const sub of targets || []) {
    try {
      // Conversion exit check — if they're now a member, stop the sequence.
      const converted = await hasConvertedToMember(clan_id, sub.email);
      if (converted) {
        await supa()
          .from('pdf_subscribers')
          .update({ converted_to_member_at: new Date().toISOString() })
          .eq('id', sub.id);
        await logEvent({
          clan_id, member_id: null,
          event_type: 'pdf_subscriber_converted',
          payload: { subscriber_id: sub.id, bucket: bucketLabel },
        });
        skipped_converted += 1;
        continue;
      }

      const ok = await sendFn(sub);
      if (ok) {
        await supa()
          .from('pdf_subscribers')
          .update({ [trackingColumn]: new Date().toISOString() })
          .eq('id', sub.id);
        await logEvent({
          clan_id, member_id: null,
          event_type: 'pdf_lead_email_sent',
          payload: { subscriber_id: sub.id, bucket: bucketLabel },
        });
        sent += 1;
      } else {
        failed += 1;
      }
    } catch (err) {
      console.error(`pdf-lead-sweep: ${bucketLabel} send failed for`, sub.email, err.message);
      failed += 1;
    }
  }

  return { sent, skipped_converted, failed };
}

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    const stats = { e2: null, e3: null, e4: null, e5: null };

    stats.e2 = await processBucket({
      clan_id, now, ageDays: 3,
      trackingColumn: 'pdf_lead_email_3_sent_at',
      sendFn: sendEmail2_Standing,
      bucketLabel: 'e2',
    });

    stats.e3 = await processBucket({
      clan_id, now, ageDays: 10,
      trackingColumn: 'pdf_lead_email_10_sent_at',
      sendFn: sendEmail3_Certificate,
      bucketLabel: 'e3',
    });

    stats.e4 = await processBucket({
      clan_id, now, ageDays: 21,
      trackingColumn: 'pdf_lead_email_21_sent_at',
      sendFn: sendEmail4_Invitation,
      bucketLabel: 'e4',
    });

    stats.e5 = await processBucket({
      clan_id, now, ageDays: 35,
      trackingColumn: 'pdf_lead_email_35_sent_at',
      sendFn: sendEmail5_FinalInvitation,
      bucketLabel: 'e5',
    });

    console.log('pdf-lead-sweep complete:', JSON.stringify(stats));
    return { statusCode: 200, body: JSON.stringify(stats) };
  } catch (err) {
    console.error('pdf-lead-sweep: fatal error:', err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
