// netlify/functions/daily-post-signup-sweep.js
//
// Runs daily on a schedule (see netlify.toml). Dispatches the
// post-signup email lifecycle (six time buckets, eight email
// variants total).
//
// CADENCE — anchored on members.created_at:
//
//   +3 days   Email 1   The Herald — register acknowledgment
//                       (1A clan-tier upsell / 1B Guardian+ default /
//                        1C Guardian+ opted-out)
//   +9 days   Email 2   Fergus — personal letter
//   +18 days  Email 3   Linda / Office — bringing the kindred (the
//                       primary referral ask, by the Chief's wish)
//   +28 days  Email 4   Linda / Office — gift-angle nudge.
//                       CONDITIONAL: fires only when the member has
//                       zero conversions yet (countSponsoredBy === 0).
//                       Members who have already converted skip
//                       entirely; their +28 column is marked
//                       skipped so the sweep does not retry.
//   +60 days  Email 5   Linda / Office — honours protocol
//   +90 days  Email 6   Paddy (Seanchaí) — pedigree as story
//
// IDEMPOTENCY — each email has its own tracking column on members:
//   post_signup_email_3_sent_at, _9_sent_at, _18_sent_at,
//   _28_sent_at + _28_skipped, _60_sent_at, _90_sent_at
// Once stamped, the email never re-sends for that member. The
// partial indexes (migration 022) keep the per-email "still pending"
// query bounded.
//
// AGE BUCKETING — for each email at age N, we look for members
// where created_at falls in [now - (N+1)days, now - N days). One day
// wide, so each member becomes eligible for exactly one bucket on
// exactly one day. If the cron misses a day (failure, deploy
// freeze, etc.), members in that day's bucket are NOT re-caught
// later; they get skipped. That is acceptable for non-critical
// lifecycle mail and avoids the alternative — un-bounded
// "everyone older than N who hasn't received it" queries — which
// would cause back-fill blasts after any pause.
//
// FAN-OUT BOUNDS — each per-email query is .limit(50). For the
// expected steady-state volume (a few signups per day) this is
// more than enough headroom. If signup volume materially grows
// beyond that, raise the limit and consider parallelising sends.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { countSponsoredBy } = require('./lib/sponsor-service');
const {
  sendRegisterAck_ClanTier,
  sendRegisterAck_GuardianPlusDefault,
  sendRegisterAck_GuardianPlusOptedOut,
  sendChiefPersonalLetter,
  sendLindaKindredAsk,
  sendLindaGiftNudge,
  sendLindaHonoursExplain,
  sendSeanchaiPedigree,
} = require('./lib/post-signup-email');

const DAY_MS = 24 * 60 * 60 * 1000;
const PER_BUCKET_LIMIT = 50;

// Age-bucket helper — returns the [earliest, latest) ISO range for
// "members who became age N today". Matches the daily-cert-sweep
// pattern of ">= earliest, < latest" so the bucket is exactly one
// day wide.
function bucketRange(now, ageDays) {
  const earliest = new Date(now.getTime() - (ageDays + 1) * DAY_MS).toISOString();
  const latest   = new Date(now.getTime() - ageDays       * DAY_MS).toISOString();
  return { earliest, latest };
}

// Tier classifier — returns 'clan' for entry-tier members, 'plus' for
// Guardian/Steward/Life. Matches canAppearOnPublicRegister() in
// lib/supabase.js (which gates by 'clan-' prefix).
function isClanTier(tier) {
  return !tier || String(tier).startsWith('clan-');
}

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    const stats = { e3: 0, e9: 0, e18: 0, e28_sent: 0, e28_skipped: 0, e60: 0, e90: 0, failed: 0 };

    // ── EMAIL 1 — Register acknowledgment (3 days, branched 1A/B/C) ─
    {
      const { earliest, latest } = bucketRange(now, 3);
      const { data: targets, error } = await supa()
        .from('members')
        .select('id, email, name, tier, public_register_visible, created_at')
        .eq('clan_id', clan_id)
        .eq('status', 'active')
        .is('post_signup_email_3_sent_at', null)
        .gte('created_at', earliest)
        .lt('created_at', latest)
        .limit(PER_BUCKET_LIMIT);

      if (error) {
        console.error('post-signup-sweep: e3 query failed:', error.message);
      } else {
        for (const m of targets || []) {
          try {
            let ok;
            if (isClanTier(m.tier)) {
              ok = await sendRegisterAck_ClanTier(m);
            } else if (m.public_register_visible !== false) {
              ok = await sendRegisterAck_GuardianPlusDefault(m);
            } else {
              ok = await sendRegisterAck_GuardianPlusOptedOut(m);
            }
            if (ok) {
              await supa().from('members')
                .update({ post_signup_email_3_sent_at: new Date().toISOString() })
                .eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', metadata: { email: 'e3', tier: m.tier } });
              stats.e3 += 1;
            } else {
              stats.failed += 1;
            }
          } catch (err) {
            console.error('post-signup-sweep: e3 send failed for', m.email, err.message);
            stats.failed += 1;
          }
        }
      }
    }

    // ── EMAIL 2 — Fergus personal letter (9 days, universal) ────────
    {
      const { earliest, latest } = bucketRange(now, 9);
      const { data: targets, error } = await supa()
        .from('members')
        .select('id, email, name, created_at')
        .eq('clan_id', clan_id)
        .eq('status', 'active')
        .is('post_signup_email_9_sent_at', null)
        .gte('created_at', earliest)
        .lt('created_at', latest)
        .limit(PER_BUCKET_LIMIT);

      if (error) {
        console.error('post-signup-sweep: e9 query failed:', error.message);
      } else {
        for (const m of targets || []) {
          try {
            const ok = await sendChiefPersonalLetter(m);
            if (ok) {
              await supa().from('members')
                .update({ post_signup_email_9_sent_at: new Date().toISOString() })
                .eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', metadata: { email: 'e9' } });
              stats.e9 += 1;
            } else {
              stats.failed += 1;
            }
          } catch (err) {
            console.error('post-signup-sweep: e9 send failed for', m.email, err.message);
            stats.failed += 1;
          }
        }
      }
    }

    // ── EMAIL 3 — Linda kindred ask (18 days, universal) ────────────
    {
      const { earliest, latest } = bucketRange(now, 18);
      const { data: targets, error } = await supa()
        .from('members')
        .select('id, email, name, created_at')
        .eq('clan_id', clan_id)
        .eq('status', 'active')
        .is('post_signup_email_18_sent_at', null)
        .gte('created_at', earliest)
        .lt('created_at', latest)
        .limit(PER_BUCKET_LIMIT);

      if (error) {
        console.error('post-signup-sweep: e18 query failed:', error.message);
      } else {
        for (const m of targets || []) {
          try {
            const ok = await sendLindaKindredAsk(m);
            if (ok) {
              await supa().from('members')
                .update({ post_signup_email_18_sent_at: new Date().toISOString() })
                .eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', metadata: { email: 'e18' } });
              stats.e18 += 1;
            } else {
              stats.failed += 1;
            }
          } catch (err) {
            console.error('post-signup-sweep: e18 send failed for', m.email, err.message);
            stats.failed += 1;
          }
        }
      }
    }

    // ── EMAIL 4 — Linda gift nudge (28 days, CONDITIONAL) ───────────
    //
    // Fires only if the member has zero successful conversions
    // (countSponsoredBy === 0). Members who have already converted
    // get their +28 column marked skipped so we never retry.
    {
      const { earliest, latest } = bucketRange(now, 28);
      const { data: targets, error } = await supa()
        .from('members')
        .select('id, email, name, created_at')
        .eq('clan_id', clan_id)
        .eq('status', 'active')
        .is('post_signup_email_28_sent_at', null)
        .eq('post_signup_email_28_skipped', false)
        .gte('created_at', earliest)
        .lt('created_at', latest)
        .limit(PER_BUCKET_LIMIT);

      if (error) {
        console.error('post-signup-sweep: e28 query failed:', error.message);
      } else {
        for (const m of targets || []) {
          try {
            const sponsoredCount = await countSponsoredBy(m.id);
            if (sponsoredCount > 0) {
              // Skip — already converted at least one. Stamp skipped.
              await supa().from('members')
                .update({ post_signup_email_28_skipped: true })
                .eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_skipped', metadata: { email: 'e28', reason: 'already_converted', count: sponsoredCount } });
              stats.e28_skipped += 1;
            } else {
              const ok = await sendLindaGiftNudge(m);
              if (ok) {
                await supa().from('members')
                  .update({ post_signup_email_28_sent_at: new Date().toISOString() })
                  .eq('id', m.id);
                await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', metadata: { email: 'e28' } });
                stats.e28_sent += 1;
              } else {
                stats.failed += 1;
              }
            }
          } catch (err) {
            console.error('post-signup-sweep: e28 send failed for', m.email, err.message);
            stats.failed += 1;
          }
        }
      }
    }

    // ── EMAIL 5 — Linda honours explainer (60 days, universal) ──────
    {
      const { earliest, latest } = bucketRange(now, 60);
      const { data: targets, error } = await supa()
        .from('members')
        .select('id, email, name, created_at')
        .eq('clan_id', clan_id)
        .eq('status', 'active')
        .is('post_signup_email_60_sent_at', null)
        .gte('created_at', earliest)
        .lt('created_at', latest)
        .limit(PER_BUCKET_LIMIT);

      if (error) {
        console.error('post-signup-sweep: e60 query failed:', error.message);
      } else {
        for (const m of targets || []) {
          try {
            const ok = await sendLindaHonoursExplain(m);
            if (ok) {
              await supa().from('members')
                .update({ post_signup_email_60_sent_at: new Date().toISOString() })
                .eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', metadata: { email: 'e60' } });
              stats.e60 += 1;
            } else {
              stats.failed += 1;
            }
          } catch (err) {
            console.error('post-signup-sweep: e60 send failed for', m.email, err.message);
            stats.failed += 1;
          }
        }
      }
    }

    // ── EMAIL 6 — Paddy pedigree (90 days, universal) ───────────────
    {
      const { earliest, latest } = bucketRange(now, 90);
      const { data: targets, error } = await supa()
        .from('members')
        .select('id, email, name, created_at')
        .eq('clan_id', clan_id)
        .eq('status', 'active')
        .is('post_signup_email_90_sent_at', null)
        .gte('created_at', earliest)
        .lt('created_at', latest)
        .limit(PER_BUCKET_LIMIT);

      if (error) {
        console.error('post-signup-sweep: e90 query failed:', error.message);
      } else {
        for (const m of targets || []) {
          try {
            const ok = await sendSeanchaiPedigree(m);
            if (ok) {
              await supa().from('members')
                .update({ post_signup_email_90_sent_at: new Date().toISOString() })
                .eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', metadata: { email: 'e90' } });
              stats.e90 += 1;
            } else {
              stats.failed += 1;
            }
          } catch (err) {
            console.error('post-signup-sweep: e90 send failed for', m.email, err.message);
            stats.failed += 1;
          }
        }
      }
    }

    console.log('post-signup-sweep complete:', JSON.stringify(stats));
    return { statusCode: 200, body: JSON.stringify(stats) };
  } catch (err) {
    console.error('post-signup-sweep: fatal error:', err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
