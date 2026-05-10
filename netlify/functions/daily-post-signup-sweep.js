// netlify/functions/daily-post-signup-sweep.js
//
// Runs daily on a schedule (see netlify.toml). Dispatches the
// post-signup email lifecycle (rev 2 — May 2026).
//
// CADENCE — anchored on members.created_at:
//
//   +3 days    Email 1   Herald — register acknowledgment (1A/B/C variants)
//   +9 days    Email 2   Fergus — Chief's letter (gated until calligrapher PNG ready)
//   +21 days   Email 3   Antoin — how I became Cara
//   +35 days   Email 4   Linda — bringing the kindred (CONDITIONAL on no sponsorships)
//   +60 days   Email 5   Herald — three titles of dignity
//   +90 days   Email 6   Michael — clan crest in your home
//   +180 days  Email 7   Paddy lite — standing of the line
//   +240 days  Email 8   Jessica — gathering at Newhall
//   +300 days  Email 9   Paddy full — royal house and saint
//   +330 days  Email 10  Linda — renewal mechanics (CONDITIONAL: skip Life)
//
// IDEMPOTENCY — each email has its own tracking column on members:
//   post_signup_email_3_sent_at, _9_sent_at, _21_sent_at,
//   _35_sent_at + _35_skipped, _60_sent_at, _90_sent_at,
//   _180_sent_at, _240_sent_at, _300_sent_at,
//   _330_sent_at + _330_skipped
// Once stamped, the email never re-sends for that member. Partial
// indexes (migrations 022 + 025) keep per-email "still pending"
// queries bounded.
//
// AGE BUCKETING — for each email at age N, look for members where
// created_at falls in [now - (N+1)days, now - N days). One day wide,
// so each member becomes eligible for exactly one bucket on exactly
// one day. If the cron misses a day (failure / deploy freeze), members
// in that day's bucket are NOT re-caught — that's acceptable for non-
// critical lifecycle mail and avoids back-fill blasts after pauses.
//
// SENDER GATING — some senders are not yet wired:
//   - chief@, linda@, paddy@      WIRED (already verified in Resend)
//   - herald@, antoin@, michael@,
//     jessica@                    NOT YET WIRED — DNS forwarders pending
// Plus Email 2 depends on the calligrapher's PNG asset which is not
// yet in the repo. The SENDER_READY map below controls dispatch:
// emails marked false are SKIPPED (not stamped). When DNS forwarders
// land or the asset is uploaded, flip the flag and the next cron run
// picks up that day's bucket. Members who passed through a bucket-day
// during the gating window will NOT receive that email retroactively;
// that's accepted to avoid awkward late sends.
//
// FAN-OUT BOUNDS — each per-email query is .limit(50). For expected
// steady-state volume (a few signups per day) this is more than enough.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { countSponsoredBy, highestAwardedTitle } = require('./lib/sponsor-service');
const {
  sendRegisterAck_ClanTier,
  sendRegisterAck_GuardianPlusDefault,
  sendRegisterAck_GuardianPlusOptedOut,
  sendChiefPersonalLetter,
  sendAntoinHowIBecameCara,
  sendAntoinForgotToAttach,
  sendLindaBringingKindred,
  sendHeraldThreeDignities,
  sendMichaelClanCrest,
  sendPaddyStandingOfTheLine,
  sendJessicaGathering,
  sendPaddyRoyalHouseAndSaint,
  sendLindaRenewal,
} = require('./lib/post-signup-email');

const DAY_MS = 24 * 60 * 60 * 1000;
const PER_BUCKET_LIMIT = 50;

// ── SENDER_READY gate ──────────────────────────────────────────────
// Flip these flags as senders come online and assets land.
//
// e1_herald: Email 1A/B/C — Herald (herald@). DNS ready as of 5 May 2026.
// e2_chief : Email 2 — Fergus (chief@). DNS ready. Asset rendered from
//            the visual mockup at /email-previews-fergus-mockup/ as
//            the_chiefs_letter_email.png. Will be replaced with the
//            calligrapher's hand-written version when ready, no code
//            change needed.
// e3_antoin: Email 3 — Antoin (antoin@). DNS ready as of 5 May 2026.
// e4_linda : Email 4 — Linda (linda@). WIRED.
// e5_herald: Email 5 — Herald (herald@). DNS ready as of 5 May 2026.
// e6_michael:Email 6 — Michael (michael@). DNS ready as of 5 May 2026.
// e7_paddy : Email 7 — Paddy (paddy@). WIRED.
// e8_jess  : Email 8 — Jessica (jessica@). DNS ready as of 5 May 2026.
// e9_paddy : Email 9 — Paddy (paddy@). WIRED.
// e10_linda: Email 10 — Linda (linda@). WIRED.
//
// SAFETY: the ONLY email-level gating is below. Do not add
// per-bucket gates anywhere else in this file — keep this map as
// the single source of truth for "is this email sendable today".
const SENDER_READY = {
  e1_herald:  true,
  e2_chief:   true,
  e3_antoin:  true,
  e3b_antoin: true,
  e4_linda:   true,
  e5_herald:  true,
  e6_michael: true,
  e7_paddy:   true,
  e8_jess:    true,
  e9_paddy:   true,
  e10_linda:  true,
};

// Returns the [earliest, latest) ISO range for "members who became
// age N today". Matches the daily-cert-sweep pattern.
function bucketRange(now, ageDays) {
  const earliest = new Date(now.getTime() - (ageDays + 1) * DAY_MS).toISOString();
  const latest   = new Date(now.getTime() - ageDays       * DAY_MS).toISOString();
  return { earliest, latest };
}

// 'clan' for entry-tier members, 'plus' for Guardian/Steward/Life.
function isClanTier(tier) {
  return !tier || String(tier).startsWith('clan-');
}

// 'life' for any of the Life-tier variants.
function isLifeTier(tier) {
  return tier && String(tier).startsWith('life-');
}

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    const stats = {
      e3: 0, e9: 0, e21: 0, e35_sent: 0, e35_skipped: 0,
      e60: 0, e90: 0, e180: 0, e240: 0, e300: 0,
      e330_sent: 0, e330_skipped: 0,
      gated: 0, failed: 0,
    };

    // ── EMAIL 1 — Herald, register ack (+3, branched 1A/B/C) ────────
    if (SENDER_READY.e1_herald) {
      const { earliest, latest } = bucketRange(now, 3);
      const { data: targets, error } = await supa()
        .from('members')
        .select('id, email, name, tier, public_register_visible, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id)
        .eq('status', 'active')
        .is('post_signup_email_3_sent_at', null)
        .gte('created_at', earliest)
        .lt('created_at', latest)
        .limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e3 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            let ok;
            if (isClanTier(m.tier)) ok = await sendRegisterAck_ClanTier(m);
            else if (m.public_register_visible !== false) ok = await sendRegisterAck_GuardianPlusDefault(m);
            else ok = await sendRegisterAck_GuardianPlusOptedOut(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_3_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e3', tier: m.tier } });
              stats.e3 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e3 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e3 (Herald) gated — herald@ DNS forwarder not ready');
    }

    // ── EMAIL 2 — Fergus, Chief's letter (+9) ───────────────────────
    if (SENDER_READY.e2_chief) {
      const { earliest, latest } = bucketRange(now, 9);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_9_sent_at', null)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e9 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            const ok = await sendChiefPersonalLetter(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_9_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e9' } });
              stats.e9 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e9 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e9 (Fergus) gated — calligrapher PNG not yet uploaded');
    }

    // ── EMAIL 3 — Antoin, how I became Cara (+21) ───────────────────
    if (SENDER_READY.e3_antoin) {
      const { earliest, latest } = bucketRange(now, 21);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_21_sent_at', null)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e21 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            const ok = await sendAntoinHowIBecameCara(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_21_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e21' } });
              stats.e21 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e21 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e21 (Antoin) gated — antoin@ DNS forwarder not ready');
    }

    // ── EMAIL 3B — Antoin, "I forgot to attach this" (same-day follow-up) ──
    // Fires for any member where _21_sent_at is set but _21b_sent_at is
    // null AND the member has NOT yet been raised to any dignity. The
    // titled-member gate (skip if sponsor_titles_awarded contains any
    // entry) is important: Email 3B sends Antoin's Cara patent as
    // social proof of what the dignity looks like — landing that in a
    // Cara/Ardchara/Onóir's inbox AFTER they already have their own
    // patent (sent at conferral) would be confusing and undercut the
    // singular-issuance ceremony of their own raising. Gate filters
    // these members out at the JS layer because Supabase JSONB filters
    // are awkward and the row count after the not-null/is-null filters
    // is already small enough that an extra in-memory pass is fine.
    if (SENDER_READY.e3b_antoin) {
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .not('post_signup_email_21_sent_at', 'is', null)
        .is('post_signup_email_21b_sent_at', null)
        .limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e21b query failed:', error.message);
      else {
        for (const m of targets || []) {
          // Titled-member gate: skip if member has any dignity awarded.
          // sponsor_titles_awarded is a JSONB object keyed by dignity
          // slug ("cara"/"ardchara"/"onoir") with ISO timestamp values
          // for raisings that have happened. An empty object {} or null
          // means the member has not been raised. Any non-null value
          // for any key means they have.
          const titles = m.sponsor_titles_awarded || {};
          const isTitled = Object.values(titles).some(v => v != null);
          if (isTitled) {
            // Mark as sent so we don't keep re-evaluating this member
            // every cron tick. They've already moved past Email 3B's
            // intended audience; treat the email as effectively
            // delivered for tracking purposes.
            await supa().from('members').update({ post_signup_email_21b_sent_at: new Date().toISOString() }).eq('id', m.id);
            await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_skipped', payload: { email: 'e21b', reason: 'member_already_titled' } });
            stats.e21b_skipped_titled = (stats.e21b_skipped_titled || 0) + 1;
            continue;
          }
          try {
            const ok = await sendAntoinForgotToAttach(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_21b_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e21b' } });
              stats.e21b = (stats.e21b || 0) + 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e21b send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e21b (Antoin follow-up) gated');
    }

    // ── EMAIL 4 — Linda, bringing the kindred (+35, CONDITIONAL) ────
    // Fires only if member has zero successful sponsorships. Members
    // with one or more get _35_skipped stamped.
    if (SENDER_READY.e4_linda) {
      const { earliest, latest } = bucketRange(now, 35);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_35_sent_at', null)
        .eq('post_signup_email_35_skipped', false)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e35 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            const sponsoredCount = await countSponsoredBy(m.id);
            if (sponsoredCount > 0) {
              await supa().from('members').update({ post_signup_email_35_skipped: true }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_skipped', payload: { email: 'e35', reason: 'already_sponsored', count: sponsoredCount } });
              stats.e35_skipped += 1;
            } else {
              const ok = await sendLindaBringingKindred(m);
              if (ok) {
                await supa().from('members').update({ post_signup_email_35_sent_at: new Date().toISOString() }).eq('id', m.id);
                await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e35' } });
                stats.e35_sent += 1;
              } else stats.failed += 1;
            }
          } catch (err) { console.error('post-signup-sweep: e35 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e35 (Linda kindred) gated');
    }

    // ── EMAIL 5 — Herald, three titles of dignity (+60) ─────────────
    if (SENDER_READY.e5_herald) {
      const { earliest, latest } = bucketRange(now, 60);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_60_sent_at', null)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e60 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            // Suppress the three-titles letter for Onóir holders. The
            // email's purpose is to introduce the title ladder and the
            // path to Cara — the apex of that ladder being someone who
            // has done the path many times over, the Office writing to
            // explain how to start would read as the system having
            // forgotten what they did. Mark sent_at to prevent the
            // sweep from re-evaluating this row daily, and log a
            // distinct event_type so this isn't conflated with normal
            // sends in analytics.
            const titleNow = highestAwardedTitle(m?.sponsor_titles_awarded);
            if (titleNow && titleNow.slug === 'onoir') {
              await supa().from('members').update({ post_signup_email_60_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_suppressed', payload: { email: 'e60', reason: 'onoir_apex' } });
              stats.suppressed = (stats.suppressed || 0) + 1;
              continue;
            }
            const ok = await sendHeraldThreeDignities(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_60_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e60' } });
              stats.e60 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e60 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e60 (Herald dignities) gated — herald@ DNS forwarder not ready');
    }

    // ── EMAIL 6 — Michael, clan crest (+90) ─────────────────────────
    if (SENDER_READY.e6_michael) {
      const { earliest, latest } = bucketRange(now, 90);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_90_sent_at', null)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e90 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            const ok = await sendMichaelClanCrest(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_90_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e90' } });
              stats.e90 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e90 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e90 (Michael) gated — michael@ DNS forwarder not ready');
    }

    // ── EMAIL 7 — Paddy lite, standing of the line (+180) ───────────
    if (SENDER_READY.e7_paddy) {
      const { earliest, latest } = bucketRange(now, 180);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_180_sent_at', null)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e180 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            const ok = await sendPaddyStandingOfTheLine(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_180_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e180' } });
              stats.e180 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e180 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e180 (Paddy lite) gated');
    }

    // ── EMAIL 8 — Jessica, gathering at Newhall (+240) ──────────────
    if (SENDER_READY.e8_jess) {
      const { earliest, latest } = bucketRange(now, 240);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_240_sent_at', null)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e240 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            const ok = await sendJessicaGathering(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_240_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e240' } });
              stats.e240 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e240 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e240 (Jessica) gated — jessica@ DNS forwarder not ready');
    }

    // ── EMAIL 9 — Paddy full, royal house and saint (+300) ──────────
    if (SENDER_READY.e9_paddy) {
      const { earliest, latest } = bucketRange(now, 300);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_300_sent_at', null)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e300 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            const ok = await sendPaddyRoyalHouseAndSaint(m);
            if (ok) {
              await supa().from('members').update({ post_signup_email_300_sent_at: new Date().toISOString() }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e300' } });
              stats.e300 += 1;
            } else stats.failed += 1;
          } catch (err) { console.error('post-signup-sweep: e300 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e300 (Paddy full) gated');
    }

    // ── EMAIL 10 — Linda, renewal (+330, CONDITIONAL: skip Life) ────
    if (SENDER_READY.e10_linda) {
      const { earliest, latest } = bucketRange(now, 330);
      const { data: targets, error } = await supa()
        .from('members').select('id, email, name, tier, sponsor_titles_awarded, created_at')
        .eq('clan_id', clan_id).eq('status', 'active')
        .is('post_signup_email_330_sent_at', null)
        .eq('post_signup_email_330_skipped', false)
        .gte('created_at', earliest).lt('created_at', latest).limit(PER_BUCKET_LIMIT);
      if (error) console.error('post-signup-sweep: e330 query failed:', error.message);
      else {
        for (const m of targets || []) {
          try {
            if (isLifeTier(m.tier)) {
              await supa().from('members').update({ post_signup_email_330_skipped: true }).eq('id', m.id);
              await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_skipped', payload: { email: 'e330', reason: 'life_tier_no_renewal', tier: m.tier } });
              stats.e330_skipped += 1;
            } else {
              const ok = await sendLindaRenewal(m);
              if (ok) {
                await supa().from('members').update({ post_signup_email_330_sent_at: new Date().toISOString() }).eq('id', m.id);
                await logEvent({ clan_id, member_id: m.id, event_type: 'post_signup_email_sent', payload: { email: 'e330', tier: m.tier } });
                stats.e330_sent += 1;
              } else stats.failed += 1;
            }
          } catch (err) { console.error('post-signup-sweep: e330 send failed for', m.email, err.message); stats.failed += 1; }
        }
      }
    } else {
      stats.gated += 1;
      console.log('post-signup-sweep: e330 (Linda renewal) gated');
    }

    console.log('post-signup-sweep complete:', JSON.stringify(stats));
    return { statusCode: 200, body: JSON.stringify(stats) };
  } catch (err) {
    console.error('post-signup-sweep: fatal error:', err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
