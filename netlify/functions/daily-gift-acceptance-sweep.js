// netlify/functions/daily-gift-acceptance-sweep.js
//
// PHASE 3 (2026-04-30): scheduled daily sweep that handles two
// time-based actions for the deferred-acceptance flow shipped in
// Phase 1 (founder gifts) and Phase 2 (paid Stripe gifts):
//
//   (A) DAY-30 REMINDER — gifts created 30 days ago whose recipient
//       has not yet pressed 'Claim my place'. Sends a single nudge
//       to the recipient. Idempotent via reminder_sent_at.
//
//   (B) DAY-365 LAPSE — gifts created 365+ days ago whose recipient
//       still hasn't claimed. Marks the gift as lapsed. No member
//       row was ever created. The recipient's claim URL will return
//       410 Gone going forward (claim endpoints already check
//       expires_at defensively, so this is mostly a state hygiene
//       step + paves the way for an admin-panel 'lapsed' display).
//
// Both founder and paid gifts go through the same sweep because the
// pattern is identical — only the table differs (pending_founder_gifts
// vs gifts). Combining the two keeps the cron count manageable and
// the staggering simple.
//
// SCHEDULE: 15:30 UTC daily (15min after daily-cert-sweep, see
// netlify.toml). UTC chosen for consistency with other sweeps and
// because Resend doesn't honour timezone in send time anyway —
// recipients see whatever time their mail server stamps.
//
// IDEMPOTENCY:
//   - Reminder gate: WHERE reminder_sent_at IS NULL
//   - Lapse gate: WHERE status='pending'/'paid' AND expires_at < now()
//   These are mutually exclusive — a gift is in EITHER the reminder
//   window (created 30-364 days ago) or the lapse window (>=365
//   days old). The 30-day reminder fires once per gift; the lapse
//   transition fires once when status flips terminal.
//
// FAILURE HANDLING: per-row try/catch — one failure doesn't abort
// the sweep. Failed rows show in Netlify logs but the job exits
// 200 so the cron doesn't retry the entire batch.
//
// SAFETY CAP: limit 50 rows per type per run. At normal volumes
// (< 50 gifts going pending or expiring on any given day) this is
// generous. If we ever ingest a backlog (e.g. bulk gift drive
// from Fergus), the next-day run picks up what was missed —
// natural backpressure rather than risking timeouts on a single
// 1000-row sweep.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { sendEmail } = require('./lib/email');
const { buildFounderReminderHtml } = require('./lib/founder-email');

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_DAY = 30;       // send reminder when gift is this many days old
const LAPSE_DAY = 365;         // mark lapsed when gift is this many days old (= expires_at default)
const SAFETY_CAP = 50;         // per-type rows per run

const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

// ─────────────────────────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────────────────────────
exports.handler = async () => {
  try {
    const clan_id = await clanId();
    const now = new Date();
    const summary = {
      founder_reminders_sent: 0,
      paid_reminders_sent:    0,
      founder_lapsed:         0,
      paid_lapsed:            0,
      failed:                 0,
    };

    // (A) FOUNDER GIFT REMINDERS — table: pending_founder_gifts
    //     Window: created 30 days ago, status='pending', no reminder yet.
    //     Defensive: also exclude rows where expires_at has passed
    //     (those go straight to lapse, not reminder — though normally
    //     the day-30 window is well within the 1-year expiry).
    const reminderWindowStart = new Date(now.getTime() - LAPSE_DAY * DAY_MS).toISOString();
    const reminderWindowEnd   = new Date(now.getTime() - REMINDER_DAY * DAY_MS).toISOString();

    try {
      const { data: founderTargets, error: fqErr } = await supa()
        .from('pending_founder_gifts')
        .select('id, recipient_email, recipient_name, claim_token, created_at, expires_at, tier_label')
        .eq('clan_id', clan_id)
        .eq('status', 'pending')
        .is('reminder_sent_at', null)
        .gte('created_at', reminderWindowStart)
        .lt('created_at', reminderWindowEnd)
        .limit(SAFETY_CAP);

      if (fqErr) {
        // 'relation does not exist' is the expected case if migration
        // 017 hasn't been applied. Log + continue (paid gifts may still
        // process). Any other error is a real problem; log loudly.
        const isMissingTable = fqErr.code === '42P01' || /relation .* does not exist/i.test(fqErr.message || '');
        if (isMissingTable) {
          console.warn('[gift sweep] pending_founder_gifts missing — run migration 017. Skipping founder reminders.');
        } else {
          console.error('[gift sweep] founder reminder query failed:', fqErr.message);
        }
      } else if (founderTargets && founderTargets.length) {
        for (const g of founderTargets) {
          try {
            await sendFounderReminderEmail(g);
            await supa()
              .from('pending_founder_gifts')
              .update({ reminder_sent_at: now.toISOString() })
              .eq('id', g.id);
            await logEvent({
              clan_id,
              member_id: null,
              event_type: 'founder_gift_reminder_sent',
              payload: {
                pending_gift_id: g.id,
                recipient_email: g.recipient_email,
                days_since_offer: Math.round((now - new Date(g.created_at)) / DAY_MS),
              },
            });
            summary.founder_reminders_sent++;
          } catch (e) {
            console.error(`[gift sweep] founder reminder failed for pending ${g.id}:`, e.message);
            summary.failed++;
          }
        }
      }
    } catch (e) {
      console.error('[gift sweep] founder reminder block threw:', e.message);
    }

    // (B) PAID GIFT REMINDERS — table: gifts
    //     Same window logic. Status filter accepts 'paid' (the
    //     Phase 2 default for unclaimed) and 'pending_acceptance'
    //     (synonym used in some paths). Excludes 'claimed' (already
    //     accepted) and 'lapsed' (terminal).
    try {
      const { data: paidTargets, error: pqErr } = await supa()
        .from('gifts')
        .select('id, recipient_email, recipient_name, buyer_name, claim_token, created_at, expires_at, tier_label, personal_message')
        .eq('clan_id', clan_id)
        .in('status', ['paid', 'pending_acceptance'])
        .is('member_id', null)
        .is('reminder_sent_at', null)
        .gte('created_at', reminderWindowStart)
        .lt('created_at', reminderWindowEnd)
        .limit(SAFETY_CAP);

      if (pqErr) {
        const isMissingColumn = /column .*reminder_sent_at.* does not exist/i.test(pqErr.message || '')
          || /column .*claim_token.* does not exist/i.test(pqErr.message || '');
        if (isMissingColumn) {
          console.warn('[gift sweep] gifts table missing Phase 2 columns — run migration 018. Skipping paid reminders.');
        } else {
          console.error('[gift sweep] paid reminder query failed:', pqErr.message);
        }
      } else if (paidTargets && paidTargets.length) {
        for (const g of paidTargets) {
          try {
            await sendPaidReminderEmail(g);
            await supa()
              .from('gifts')
              .update({ reminder_sent_at: now.toISOString() })
              .eq('id', g.id);
            await logEvent({
              clan_id,
              member_id: null,
              event_type: 'paid_gift_reminder_sent',
              payload: {
                gift_id: g.id,
                recipient_email: g.recipient_email,
                days_since_offer: Math.round((now - new Date(g.created_at)) / DAY_MS),
              },
            });
            summary.paid_reminders_sent++;
          } catch (e) {
            console.error(`[gift sweep] paid reminder failed for gift ${g.id}:`, e.message);
            summary.failed++;
          }
        }
      }
    } catch (e) {
      console.error('[gift sweep] paid reminder block threw:', e.message);
    }

    // (C) FOUNDER GIFT LAPSE — flip status pending → lapsed.
    //     Predicate: expires_at <= now AND status='pending'. The
    //     Postgres-side default already set expires_at = created_at
    //     + 1 year, so we use that column directly.
    //     We don't email recipients on lapse (silent) — the gift
    //     is being closed, not offered again. If we ever want to
    //     notify the giver (Fergus for founder gifts, the buyer
    //     for paid gifts), it'd be a separate concern handled by
    //     a dedicated 'gift lapsed' notification function.
    try {
      // Use a single UPDATE rather than per-row to keep the sweep
      // efficient. .select() returns the affected rows so we can
      // log + count.
      const lapseRes = await supa()
        .from('pending_founder_gifts')
        .update({ status: 'lapsed' })
        .eq('clan_id', clan_id)
        .eq('status', 'pending')
        .lte('expires_at', now.toISOString())
        .select('id, recipient_email, expires_at');

      if (lapseRes.error) {
        const isMissingTable = lapseRes.error.code === '42P01' || /relation .* does not exist/i.test(lapseRes.error.message || '');
        if (isMissingTable) {
          console.warn('[gift sweep] pending_founder_gifts missing for lapse — run migration 017.');
        } else {
          console.error('[gift sweep] founder lapse update failed:', lapseRes.error.message);
        }
      } else if (lapseRes.data && lapseRes.data.length) {
        summary.founder_lapsed = lapseRes.data.length;
        for (const r of lapseRes.data) {
          try {
            await logEvent({
              clan_id,
              member_id: null,
              event_type: 'founder_gift_lapsed',
              payload: { pending_gift_id: r.id, recipient_email: r.recipient_email, expires_at: r.expires_at },
            });
          } catch (e) { /* event log non-fatal */ }
        }
      }
    } catch (e) {
      console.error('[gift sweep] founder lapse block threw:', e.message);
    }

    // (D) PAID GIFT LAPSE — flip status paid|pending_acceptance → lapsed.
    //     Same pattern as founder lapse. member_id IS NULL ensures
    //     we don't accidentally lapse a paid gift to an existing
    //     member (those have member_id set and were never deferred).
    try {
      const lapseRes = await supa()
        .from('gifts')
        .update({ status: 'lapsed' })
        .eq('clan_id', clan_id)
        .in('status', ['paid', 'pending_acceptance'])
        .is('member_id', null)
        .lte('expires_at', now.toISOString())
        .select('id, recipient_email, buyer_email, expires_at');

      if (lapseRes.error) {
        const isMissingColumn = /column .*expires_at.* does not exist/i.test(lapseRes.error.message || '');
        if (isMissingColumn) {
          console.warn('[gift sweep] gifts table missing expires_at — run migration 018.');
        } else {
          console.error('[gift sweep] paid lapse update failed:', lapseRes.error.message);
        }
      } else if (lapseRes.data && lapseRes.data.length) {
        summary.paid_lapsed = lapseRes.data.length;
        for (const r of lapseRes.data) {
          try {
            await logEvent({
              clan_id,
              member_id: null,
              event_type: 'paid_gift_lapsed',
              payload: { gift_id: r.id, recipient_email: r.recipient_email, buyer_email: r.buyer_email, expires_at: r.expires_at },
            });
          } catch (e) { /* event log non-fatal */ }
        }
      }
    } catch (e) {
      console.error('[gift sweep] paid lapse block threw:', e.message);
    }

    console.log(`[gift sweep] summary: ${JSON.stringify(summary)}`);
    return {
      statusCode: 200,
      body: JSON.stringify(summary),
    };
  } catch (e) {
    console.error('[gift sweep] fatal:', e.message, e.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: e.message }),
    };
  }
};

// ─────────────────────────────────────────────────────────────────
// EMAIL TEMPLATES
//
// Both reminder emails follow the same pattern as the original
// welcome emails: dark ink header with shield + small caps, body
// in EB Garamond on cream, single CTA button (burgundy for the
// claim flow), motto in footer.
//
// Tone: gentle nudge, not nagging. The recipient already received
// the original welcome email 30 days ago and either ignored it,
// missed it, or is still considering. This second touch should
// feel like a polite reminder — 'no pressure, the place is still
// held' — rather than urgency or guilt.
// ─────────────────────────────────────────────────────────────────

async function sendFounderReminderEmail(g) {
  // Body now built by lib/founder-email.js → buildFounderReminderHtml
  // so the email-review preview tooling can render the same body
  // for Privy Council review without sending. Single source of truth
  // for the reminder copy.
  const html = buildFounderReminderHtml(g);

  await sendEmail({
    to: g.recipient_email,
    subject: 'Your founding place in Clan Ó Comáin — a final note',
    html,
  });
}

async function sendPaidReminderEmail(g) {
  const firstName = (g.recipient_name || '').trim().split(/\s+/)[0] || 'friend';
  const giverName = (g.buyer_name || '').trim() || 'a friend';
  const giverFirst = giverName.split(/\s+/)[0];
  const claimUrl = `${SITE_URL}/gift-welcome.html?token=${encodeURIComponent(g.claim_token)}`;
  const tierLabel = g.tier_label || 'Clan Membership';

  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:36px 40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="${SITE_URL}/coat_of_arms.png" width="80" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto;text-align:center;max-width:120px">Ó COMÁIN</p>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">A gift still held</p>
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;margin:0 0 20px">Dear ${escapeHtml(firstName)},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">A month has passed since <strong>${escapeHtml(giverName)}</strong> chose you for a place in Clan Ó Comáin. The gift is still held in your name.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 32px">If the original email is buried, the door is still open below. The membership for the year ahead — <strong>${escapeHtml(tierLabel)}</strong> — is ${escapeHtml(giverFirst)}'s gift to you, freely given, awaiting only your acceptance.</p>
    <div style="text-align:center;margin-bottom:14px">
      <a href="${claimUrl}" style="display:inline-block;background:#6B1F1F;color:#F7F4ED;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:16px 36px;border-radius:1px;border:1px solid #4A1010">View your invitation →</a>
    </div>
    <p style="font-family:'Georgia',serif;font-size:13px;color:#8C7A64;text-align:center;margin:0 0 32px;font-style:italic">A gift is held open for one year from the day it is offered.</p>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7">If you did not expect this email, or wish not to take up the place, no further messages will be sent. You may also reach out to ${escapeHtml(giverFirst)} directly, or write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a>.</p>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-top:28px">— The Herald, Clan Ó Comáin</p>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Caithfidh an stair a bheith i réim</p>
    <p style="font-family:'Georgia',serif;font-size:10px;color:#A88B57;margin:4px 0 0">History must prevail</p>
  </div>
</div>
</body></html>`;

  await sendEmail({
    to: g.recipient_email,
    subject: `Your gift from ${giverName} — still held`,
    html,
  });
}

// Tiny escape — duplicates the helper from email-builder libs.
// Kept inline to avoid pulling a heavy dependency for one use.
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
