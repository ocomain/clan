// netlify/functions/daily-cert-sweep.js
//
// Runs daily on a schedule (see netlify.toml). Handles two cases:
//
//  (A) DAY-29 REMINDER — members joined ~29 days ago who haven't yet
//      published their cert. Sends a "publishing in 24 hours" email
//      with their current draft details so they have a final
//      opportunity to refine before auto-publish.
//
//  (B) DAY-30 AUTO-PUBLISH — members joined 30+ days ago who never
//      published. Apply name auto-fix to their Herald-captured name,
//      generate the cert PDF, set cert_published_at + cert_locked_at,
//      send the publication-confirmation email (autoPublished: true).
//
// Both cases find members via the members_cert_unpublished_idx
// (cert_published_at IS NULL AND status = 'active'). The age-since-
// joined determines which bucket they're in.
//
// Idempotency:
//   - day-29 reminder: gated on cert_publish_reminder_sent_at IS NULL
//     so we only send once per member
//   - day-30 auto-publish: gated on cert_published_at IS NULL so once
//     published, never auto-publishes again

const { supa, clanId, logEvent } = require('./lib/supabase');
const { ensureCertificate } = require('./lib/cert-service');
const { ensurePatent } = require('./lib/patent-service');
const { autoFixName } = require('./lib/name-format');
const { sendEmail } = require('./lib/email');
const { sendPublicationConfirmation, sendGiftBuyerCertKeepsake } = require('./lib/publication-email');
const { sendCertReminder } = require('./lib/cert-reminder-email');
const { buildSignInUrl } = require('./lib/signin-token');

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_DAY = 29; // send reminder when joined_at was this many days ago
const AUTO_PUBLISH_DAY = 30; // auto-publish when joined_at was this many days ago

exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    let remindersSent = 0;
    let autoPublished = 0;
    let failed = 0;

    // ── (A) Day-29 reminder ──────────────────────────────────────────
    // joined between (now - 30 days) and (now - 29 days), reminder not sent.
    const reminderEarliest = new Date(now.getTime() - AUTO_PUBLISH_DAY * DAY_MS).toISOString();
    const reminderLatest   = new Date(now.getTime() - REMINDER_DAY * DAY_MS).toISOString();

    const { data: reminderTargets, error: reminderErr } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, partner_name, children_first_names, ancestor_dedication, joined_at')
      .eq('clan_id', clan_id)
      .eq('status', 'active')
      .is('cert_published_at', null)
      .is('cert_publish_reminder_sent_at', null)
      .gte('joined_at', reminderEarliest)
      .lt('joined_at', reminderLatest)
      .limit(50);

    if (reminderErr) {
      console.error('day-29 reminder query failed:', reminderErr.message);
    } else if (reminderTargets) {
      for (const m of reminderTargets) {
        try {
          const fixedName = autoFixName(m.name) || m.name || '—';
          const sent = await sendCertReminder(m, fixedName);
          if (sent) {
            await supa()
              .from('members')
              .update({ cert_publish_reminder_sent_at: now.toISOString() })
              .eq('id', m.id);
            await logEvent({
              clan_id,
              member_id: m.id,
              event_type: 'cert_publish_reminder_sent',
              payload: { hours_until_auto_publish: 24 },
            });
            remindersSent++;
          }
        } catch (e) {
          console.error(`day-29 reminder failed for member ${m.id}:`, e.message);
          failed++;
        }
      }
    }

    // ── (B) Day-30 auto-publish ──────────────────────────────────────
    // joined ≥ 30 days ago, still unpublished.
    const autoPublishCutoff = new Date(now.getTime() - AUTO_PUBLISH_DAY * DAY_MS).toISOString();

    const { data: publishTargets, error: publishErr } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, tier_family, partner_name, children_first_names, ancestor_dedication, joined_at, cert_version, public_register_visible')
      .eq('clan_id', clan_id)
      .eq('status', 'active')
      .is('cert_published_at', null)
      .lt('joined_at', autoPublishCutoff)
      .limit(50);

    if (publishErr) {
      console.error('day-30 auto-publish query failed:', publishErr.message);
    } else if (publishTargets) {
      for (const m of publishTargets) {
        try {
          // Apply name auto-fix BEFORE publishing. Update member row first
          // so the cert generation uses the fixed name.
          const fixedName = autoFixName(m.name);
          if (fixedName && fixedName !== m.name) {
            await supa()
              .from('members')
              .update({ name: fixedName, updated_at: now.toISOString() })
              .eq('id', m.id);
            m.name = fixedName;
          }

          // Stamp publication BEFORE generation so concurrent webhooks
          // (unlikely but possible) see consistent state. cert_locked_at
          // also set as the legacy alias.
          const publishedAt = now.toISOString();
          const newVersion = (m.cert_version || 1);
          await supa()
            .from('members')
            .update({
              cert_published_at: publishedAt,
              cert_locked_at: publishedAt,
              cert_version: newVersion,
              updated_at: publishedAt,
            })
            .eq('id', m.id);

          // Generate the PDF.
          const updated = { ...m, cert_version: newVersion };
          const certResult = await ensureCertificate(updated, clan_id, { forceRegenerate: true });

          await logEvent({
            clan_id,
            member_id: m.id,
            event_type: 'certificate_published',
            payload: {
              tier: m.tier,
              source: 'auto_publish',
              days_after_join: AUTO_PUBLISH_DAY,
              name_auto_fixed: fixedName !== m.name ? false : (autoFixName(m.name) !== m.name),
            },
          });

          if (certResult.storagePath) {
            await sendPublicationConfirmation(updated, certResult, { autoPublished: true });

            // Gift keepsake — if this auto-published member was a gift
            // recipient, send the buyer their copy too.
            try {
              const { data: gift } = await supa()
                .from('gifts')
                .select('buyer_email, buyer_name, recipient_email, personal_message, gifted_at')
                .eq('member_id', m.id)
                .maybeSingle();
              if (gift?.buyer_email) {
                await sendGiftBuyerCertKeepsake(updated, certResult, gift);
                await logEvent({
                  clan_id,
                  member_id: m.id,
                  event_type: 'gift_buyer_keepsake_sent',
                  payload: { buyer_email: gift.buyer_email, source: 'auto_publish' },
                });
              }
            } catch (keepsakeErr) {
              console.error(`keepsake send failed for member ${m.id} (non-fatal):`, keepsakeErr.message);
            }

            // Patent generation — if this member already holds any
            // dignities (raised earlier, never sealed cert manually),
            // their cert just sealed via the day-30 auto-publish so
            // the precondition is now met. Generate their letters
            // patent now and the dashboard will surface it.
            try {
              const { data: memberFull } = await supa()
                .from('members')
                .select('id, name, sponsor_titles_awarded, cert_published_at, cert_locked_at, patent_urls')
                .eq('id', m.id)
                .single();
              if (memberFull) {
                const titlesAwarded = memberFull.sponsor_titles_awarded || {};
                const dignitiesHeld = Object.entries(titlesAwarded)
                  .filter(([_, raisedAt]) => raisedAt != null)
                  .map(([slug]) => slug);
                for (const slug of dignitiesHeld) {
                  try {
                    const result = await ensurePatent(memberFull, slug, clan_id);
                    if (result.wasGenerated) {
                      console.log(`[auto-publish] patent generated for member ${m.id} dignity ${slug}: ${result.path}`);
                    }
                  } catch (pErr) {
                    console.error(`[auto-publish] patent ${slug} for member ${m.id} failed (non-fatal):`, pErr.message);
                  }
                }
              }
            } catch (patentBlockErr) {
              console.error(`[auto-publish] patent generation block failed for member ${m.id} (non-fatal):`, patentBlockErr.message);
            }
          }
          autoPublished++;
        } catch (e) {
          console.error(`auto-publish failed for member ${m.id}:`, e.message);
          failed++;
        }
      }
    }

    console.log(`cert sweep: reminders=${remindersSent} auto_published=${autoPublished} failed=${failed}`);
    return {
      statusCode: 200,
      body: JSON.stringify({ remindersSent, autoPublished, failed }),
    };
  } catch (err) {
    console.error('daily-cert-sweep crashed:', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
