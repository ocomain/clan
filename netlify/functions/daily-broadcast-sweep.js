// netlify/functions/daily-broadcast-sweep.js
//
// Runs every 15 minutes on a schedule (see netlify.toml). Releases
// member_broadcast_sends rows whose release_at has passed.
//
// ─── WHAT THIS DOES ─────────────────────────────────────────────────────
// Two phases each invocation:
//
//   PHASE A: Promote broadcasts whose start_at has arrived from
//            'scheduled' → 'sending'. Idempotent — conditional update.
//
//   PHASE B: Process per-member sends:
//              1. SELECT queued rows where release_at <= now()
//                 (LIMIT 100 per invocation for safety)
//              2. For each row: claim it (conditional UPDATE of
//                 claim_token IS NULL), render, send, mark sent/failed
//              3. Continue on individual failures
//
// At the tail of every invocation, broadcasts where all sends have
// reached terminal state (sent or failed) are promoted from
// 'sending' → 'sent'.
//
// ─── IDEMPOTENCY ────────────────────────────────────────────────────────
// Same claim-token pattern as daily-post-signup-sweep. Conditional UPDATE
// of claim_token (was: null → uuid). If the row count returned is 1,
// this invocation owns the send. Concurrent crons + manual reruns
// cannot double-send.
//
// ─── FAILURE SEMANTICS (per DDW) ────────────────────────────────────────
//   - Continue-on-error: a failed send doesn't halt the sweep.
//   - Stamp 'failed' status + error_message on the row.
//   - Failed rows can be re-queued from the admin UI (sets status
//     back to 'queued', clears claim_token, clears error_message).
//
// ─── FAN-OUT BOUNDS ─────────────────────────────────────────────────────
//   - LIMIT 100 per invocation.
//   - At 15-minute cadence, 100 sends/run = 400/hour ceiling. A clan
//     of 1,000 members ships in 2.5 hours which is fine for daily-class
//     broadcasts. If volumes exceed this, raise the limit or shorten
//     the cron cadence.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { renderBroadcast } = require('./lib/broadcast-email');
const crypto = require('crypto');

const PER_RUN_LIMIT = 100;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// ── claimSend ───────────────────────────────────────────────────────────
// Conditional UPDATE that atomically claims a member_broadcast_sends
// row for this invocation. Returns true if we won the claim, false
// if another worker beat us to it.
async function claimSend(rowId) {
  const claimToken = crypto.randomUUID();
  const { data, error } = await supa()
    .from('member_broadcast_sends')
    .update({
      claim_token: claimToken,
      claimed_at: new Date().toISOString(),
    })
    .eq('id', rowId)
    .is('claim_token', null)
    .select('id');
  if (error) {
    console.error(`[broadcast-sweep] claim failed for row ${rowId}:`, error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ── sendViaResend ──────────────────────────────────────────────────────
// Resend POST with full error capture. Returns:
//   { ok: true, id: 'resend_email_id' }       on success
//   { ok: false, error: 'string' }            on failure
async function sendViaResend({ from, to, replyTo, subject, html }) {
  if (!RESEND_API_KEY) {
    return { ok: false, error: 'RESEND_API_KEY not configured' };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from,
        to,
        reply_to: replyTo,
        subject,
        html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `Resend ${res.status}: ${errText.slice(0, 240)}` };
    }
    const data = await res.json().catch(() => ({}));
    return { ok: true, id: data.id || null };
  } catch (err) {
    return { ok: false, error: `fetch error: ${err.message}` };
  }
}

// ── PHASE A: scheduled → sending ───────────────────────────────────────
// Conditional UPDATE: flips status to 'sending' for any broadcast
// past its start_at. Idempotent — once it's 'sending' or 'sent', no
// further transitions happen here.
async function promoteScheduledBroadcasts() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supa()
    .from('broadcasts')
    .update({ status: 'sending' })
    .eq('status', 'scheduled')
    .lte('start_at', nowIso)
    .select('id, sender_voice, subject');
  if (error) {
    console.error('[broadcast-sweep] promote scheduled failed:', error.message);
    return 0;
  }
  if (data && data.length) {
    console.log(`[broadcast-sweep] promoted ${data.length} broadcasts to sending`);
  }
  return data ? data.length : 0;
}

// ── PHASE B: process queued sends ──────────────────────────────────────
async function processQueuedSends() {
  const sb = supa();
  const nowIso = new Date().toISOString();

  // Fetch the queued rows along with broadcast + member data needed
  // for rendering. Inner join via FK relationships.
  const { data: rows, error } = await sb
    .from('member_broadcast_sends')
    .select(`
      id, broadcast_id, member_id, is_immediate_batch,
      broadcasts!inner(id, sender_voice, subject, body_md, cta_label, cta_url, status),
      members!inner(id, email, name, sponsor_titles_awarded)
    `)
    .eq('status', 'queued')
    .lte('release_at', nowIso)
    .is('claim_token', null)
    .order('release_at', { ascending: true })
    .limit(PER_RUN_LIMIT);

  if (error) {
    console.error('[broadcast-sweep] fetch queued failed:', error.message);
    return { processed: 0, sent: 0, failed: 0 };
  }
  if (!rows || rows.length === 0) {
    return { processed: 0, sent: 0, failed: 0 };
  }

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const broadcast = row.broadcasts;
    const member = row.members;
    if (!broadcast || !member || !member.email) {
      // Skip rows where the broadcast or member is somehow missing.
      // Mark failed so the row doesn't infinite-loop next run.
      await sb.from('member_broadcast_sends')
        .update({ status: 'failed', error_message: 'missing broadcast or member or email' })
        .eq('id', row.id);
      failed++;
      continue;
    }

    // Don't send if the broadcast has been cancelled since this row
    // was enqueued. Mark the row failed with a clear reason.
    if (broadcast.status === 'cancelled') {
      await sb.from('member_broadcast_sends')
        .update({ status: 'failed', error_message: 'broadcast cancelled before send' })
        .eq('id', row.id);
      failed++;
      continue;
    }

    // Claim the row atomically.
    const won = await claimSend(row.id);
    if (!won) continue;  // another worker has it

    // Render.
    let payload;
    try {
      payload = renderBroadcast({
        broadcast,
        member: { email: member.email, name: member.name, sponsor_titles_awarded: member.sponsor_titles_awarded },
        isImmediateBatch: row.is_immediate_batch,
      });
    } catch (err) {
      console.error(`[broadcast-sweep] render failed for row ${row.id}:`, err.message);
      await sb.from('member_broadcast_sends')
        .update({ status: 'failed', error_message: `render: ${err.message}` })
        .eq('id', row.id);
      failed++;
      continue;
    }

    // Send.
    const fromHeader = `${payload.fromName} <${payload.fromEmail}>`;
    const result = await sendViaResend({
      from: fromHeader,
      to: member.email,
      replyTo: payload.replyTo,
      subject: payload.subject,
      html: payload.html,
    });

    if (result.ok) {
      await sb.from('member_broadcast_sends')
        .update({ status: 'sent', sent_at: new Date().toISOString(), error_message: null })
        .eq('id', row.id);
      sent++;
    } else {
      await sb.from('member_broadcast_sends')
        .update({ status: 'failed', error_message: result.error })
        .eq('id', row.id);
      console.error(`[broadcast-sweep] send failed for row ${row.id}: ${result.error}`);
      failed++;
    }
  }

  return { processed: rows.length, sent, failed };
}

// ── PHASE C: sending → sent (when all rows terminal) ───────────────────
// For any broadcast in 'sending' status, check whether all its
// member_broadcast_sends rows have reached a terminal state.
// If so, update counts and flip to 'sent'.
async function finaliseSendingBroadcasts() {
  const sb = supa();
  const { data: sending, error } = await sb
    .from('broadcasts')
    .select('id')
    .eq('status', 'sending');
  if (error) {
    console.error('[broadcast-sweep] fetch sending broadcasts failed:', error.message);
    return 0;
  }
  if (!sending || sending.length === 0) return 0;

  let finalised = 0;
  for (const b of sending) {
    // Count rows by status for this broadcast.
    const { data: counts, error: cErr } = await sb
      .from('member_broadcast_sends')
      .select('status', { count: 'exact', head: false })
      .eq('broadcast_id', b.id);
    if (cErr) continue;

    let sent = 0, failed = 0, queued = 0;
    for (const r of (counts || [])) {
      if (r.status === 'sent') sent++;
      else if (r.status === 'failed') failed++;
      else queued++;
    }

    if (queued === 0) {
      // All rows terminal — finalise broadcast.
      await sb.from('broadcasts')
        .update({
          status: 'sent',
          sent_count: sent,
          failed_count: failed,
        })
        .eq('id', b.id);
      finalised++;
    } else {
      // Still in flight — update running counts only.
      await sb.from('broadcasts')
        .update({ sent_count: sent, failed_count: failed })
        .eq('id', b.id);
    }
  }
  return finalised;
}

// ── HANDLER ────────────────────────────────────────────────────────────
exports.handler = async () => {
  const startMs = Date.now();
  try {
    const promoted = await promoteScheduledBroadcasts();
    const { processed, sent, failed } = await processQueuedSends();
    const finalised = await finaliseSendingBroadcasts();

    const summary = {
      promoted_to_sending: promoted,
      processed,
      sent,
      failed,
      finalised_to_sent: finalised,
      duration_ms: Date.now() - startMs,
    };

    if (processed > 0 || promoted > 0 || finalised > 0) {
      await logEvent('broadcast_sweep_run', summary);
    }

    console.log('[broadcast-sweep]', JSON.stringify(summary));
    return { statusCode: 200, body: JSON.stringify(summary) };
  } catch (err) {
    console.error('[broadcast-sweep] fatal:', err.message, err.stack);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
