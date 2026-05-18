// netlify/functions/admin-broadcast-actions.js
//
// Multi-verb admin endpoint for the broadcast tool. Handles the
// supporting actions that don't need a dedicated function each:
//
//   action=list      List recent broadcasts (history panel)
//   action=detail    Per-broadcast summary + per-row send statuses
//   action=preview   Render HTML for a draft (no send, no DB write)
//   action=test_send Send a draft to the admin's own email
//   action=cancel    Cancel a scheduled broadcast (sets cancelled)
//   action=retry     Re-queue all failed sends for a broadcast
//
// ─── AUTH ──────────────────────────────────────────────────────────────
// Bearer token; isFounderAdmin allowlist. Same pattern as the rest of
// the admin suite.

const { supa, clanId, logEvent, isFounderAdmin } = require('./lib/supabase');
const { renderBroadcast, senderVoices } = require('./lib/broadcast-email');

const RESEND_API_KEY = process.env.RESEND_API_KEY;

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

// ─── ACTION HANDLERS ───────────────────────────────────────────────────

async function actionList() {
  const cid = await clanId();
  const { data, error } = await supa()
    .from('broadcasts')
    .select('id, created_by, created_at, sender_voice, subject, start_at, status, immediate_count, delayed_count, sent_count, failed_count')
    .eq('clan_id', cid)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return jsonResponse(500, { error: 'List failed', detail: error.message });
  return jsonResponse(200, { broadcasts: data || [] });
}

async function actionDetail(body) {
  const id = String(body.broadcast_id || '').trim();
  if (!id) return jsonResponse(400, { error: 'broadcast_id required' });

  const { data: b, error: bErr } = await supa()
    .from('broadcasts')
    .select('*')
    .eq('id', id)
    .single();
  if (bErr || !b) return jsonResponse(404, { error: 'Broadcast not found' });

  // Aggregate send statuses
  const { data: sends, error: sErr } = await supa()
    .from('member_broadcast_sends')
    .select('status, is_immediate_batch')
    .eq('broadcast_id', id);
  if (sErr) return jsonResponse(500, { error: 'Send fetch failed', detail: sErr.message });

  const counts = { queued: 0, sent: 0, failed: 0 };
  const immediate = { queued: 0, sent: 0, failed: 0 };
  const delayed = { queued: 0, sent: 0, failed: 0 };
  for (const r of (sends || [])) {
    counts[r.status] = (counts[r.status] || 0) + 1;
    const bucket = r.is_immediate_batch ? immediate : delayed;
    bucket[r.status] = (bucket[r.status] || 0) + 1;
  }
  return jsonResponse(200, { broadcast: b, counts, immediate, delayed });
}

async function actionPreview(body, operatorEmail) {
  // Render a broadcast as HTML without sending or persisting.
  // Used by the admin compose UI to show what a recipient will see,
  // for both Steward (immediate) and other-member (delayed) variants.
  const sender_voice = String(body.sender_voice || '').trim();
  const subject      = String(body.subject || '').trim();
  const body_md      = String(body.body_md || '').trim();
  const cta_label    = body.cta_label ? String(body.cta_label).trim() : null;
  const cta_url      = body.cta_url   ? String(body.cta_url).trim() : null;
  const variant      = String(body.variant || 'immediate'); // 'immediate'|'delayed'

  if (!sender_voice || !subject || !body_md) {
    return jsonResponse(400, { error: 'sender_voice, subject, body_md required' });
  }

  try {
    const out = renderBroadcast({
      broadcast: { sender_voice, subject, body_md, cta_label, cta_url },
      member: { name: operatorEmail.split('@')[0] || 'friend', email: operatorEmail },
      isImmediateBatch: variant === 'immediate',
    });
    return jsonResponse(200, out);
  } catch (err) {
    return jsonResponse(400, { error: 'Render failed', detail: err.message });
  }
}

async function actionTestSend(body, operatorEmail) {
  // Send a draft broadcast to a test recipient so the admin can see
  // exactly what arrives before committing to a full broadcast.
  //
  // Recipient defaults to the operator's own email (the address they
  // signed in with), but an optional `to` parameter lets them send
  // to any other inbox — useful for previewing how the email renders
  // in Gmail vs Outlook vs Apple Mail, or for checking how the From-
  // line appears to a recipient who doesn't have the sender already
  // in their address book.
  const sender_voice = String(body.sender_voice || '').trim();
  const subject      = String(body.subject || '').trim();
  const body_md      = String(body.body_md || '').trim();
  const cta_label    = body.cta_label ? String(body.cta_label).trim() : null;
  const cta_url      = body.cta_url   ? String(body.cta_url).trim() : null;
  const variant      = String(body.variant || 'immediate');
  const toRaw        = body.to ? String(body.to).trim().toLowerCase() : null;

  if (!sender_voice || !subject || !body_md) {
    return jsonResponse(400, { error: 'sender_voice, subject, body_md required' });
  }
  if (!RESEND_API_KEY) {
    return jsonResponse(500, { error: 'RESEND_API_KEY not configured' });
  }

  // Validate the recipient address. If admin didn't supply one, fall
  // back to the operator's signed-in email.
  const to = toRaw || operatorEmail;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return jsonResponse(400, { error: 'Invalid recipient email', received: to });
  }

  let payload;
  try {
    payload = renderBroadcast({
      broadcast: { sender_voice, subject, body_md, cta_label, cta_url },
      member: { name: to.split('@')[0] || 'friend', email: to },
      isImmediateBatch: variant === 'immediate',
    });
  } catch (err) {
    return jsonResponse(400, { error: 'Render failed', detail: err.message });
  }

  // Prepend a test banner so it's obvious this isn't a real send.
  const testBanner = `<div style="background:#FFE5B4;color:#8B4513;padding:10px 16px;font-family:'Helvetica Neue',Arial,sans-serif;font-size:13px;font-weight:600;text-align:center;border-bottom:1px solid #B8975A">⚠ TEST SEND · variant=${variant} · not delivered to members</div>`;
  const html = payload.html.replace('<body style="', `<body style="background:#FFE5B4;`).replace(/(<body[^>]*>)/, `$1${testBanner}`);

  const from = `${payload.fromName} <${payload.fromEmail}>`;
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
        reply_to: payload.replyTo,
        subject: `[TEST] ${payload.subject}`,
        html,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return jsonResponse(502, { error: `Resend ${res.status}`, detail: errText.slice(0, 300) });
    }
    return jsonResponse(200, { ok: true, sent_to: to, variant });
  } catch (err) {
    return jsonResponse(502, { error: 'Send failed', detail: err.message });
  }
}

async function actionCancel(body, operatorEmail) {
  // Cancel a scheduled broadcast. Only allowed if status='scheduled'
  // (i.e. start_at hasn't passed yet). Once a broadcast enters
  // 'sending' it can't be cancelled — partial sends would already
  // have gone out.
  const id = String(body.broadcast_id || '').trim();
  if (!id) return jsonResponse(400, { error: 'broadcast_id required' });

  const { data, error } = await supa()
    .from('broadcasts')
    .update({ status: 'cancelled' })
    .eq('id', id)
    .eq('status', 'scheduled')
    .select('id');
  if (error) return jsonResponse(500, { error: 'Cancel failed', detail: error.message });
  if (!data || data.length === 0) {
    return jsonResponse(409, { error: 'Cannot cancel — broadcast is not in scheduled status' });
  }

  await logEvent('broadcast_cancelled', { broadcast_id: id, by: operatorEmail });
  return jsonResponse(200, { ok: true, broadcast_id: id });
}

async function actionRetry(body, operatorEmail) {
  // Re-queue all failed sends for a broadcast so the next cron run
  // picks them up again. Clears claim_token + error_message so
  // claimSend can win on the retry path.
  const id = String(body.broadcast_id || '').trim();
  if (!id) return jsonResponse(400, { error: 'broadcast_id required' });

  // Also bump the broadcast back to 'sending' if it's been finalised.
  const { data: updated, error } = await supa()
    .from('member_broadcast_sends')
    .update({
      status: 'queued',
      claim_token: null,
      claimed_at: null,
      error_message: null,
    })
    .eq('broadcast_id', id)
    .eq('status', 'failed')
    .select('id');
  if (error) return jsonResponse(500, { error: 'Retry failed', detail: error.message });

  // Reopen the parent broadcast if it had been finalised to 'sent'
  // — there are now queued rows again.
  if (updated && updated.length > 0) {
    await supa().from('broadcasts').update({ status: 'sending' }).eq('id', id);
  }

  await logEvent('broadcast_retry', { broadcast_id: id, requeued: updated?.length || 0, by: operatorEmail });
  return jsonResponse(200, { ok: true, requeued: updated?.length || 0 });
}

async function actionVoices() {
  return jsonResponse(200, { voices: senderVoices() });
}

// ─── HANDLER ───────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // Auth
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return jsonResponse(401, { error: 'Missing Authorization header' });
  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) return jsonResponse(401, { error: 'Invalid token' });
  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) return jsonResponse(403, { error: 'Not permitted' });

  // Body
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON' }); }

  const action = String(body.action || '').trim();
  switch (action) {
    case 'list':       return actionList();
    case 'detail':     return actionDetail(body);
    case 'preview':    return actionPreview(body, operatorEmail);
    case 'test_send':  return actionTestSend(body, operatorEmail);
    case 'cancel':     return actionCancel(body, operatorEmail);
    case 'retry':      return actionRetry(body, operatorEmail);
    case 'voices':     return actionVoices();
    default: return jsonResponse(400, { error: 'Unknown action', received: action });
  }
};
