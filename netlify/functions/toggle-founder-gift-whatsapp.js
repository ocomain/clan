// netlify/functions/toggle-founder-gift-whatsapp.js
//
// POST /api/toggle-founder-gift-whatsapp
// Body: { id: <uuid>, sent: <boolean> }
//
// Per-row tickbox handler for the founder admin panel's WhatsApp
// follow-up tracking column. Fergus presses the tick on a row to
// mark 'I've sent this person a WhatsApp asking them to check
// their email'; the panel persists this so it survives page
// reloads and operator handoffs (Linda + Fergus both work the
// list).
//
// AUTH: same Bearer-token + isFounderAdmin pattern as
// send-founder-gift.js. Operator email is recorded in
// whatsapp_sent_by for audit.
//
// SHAPE:
//   id   — pending_founder_gifts.id (UUID)
//   sent — true: stamp whatsapp_sent_at = now(), record operator
//          false: clear both columns (untick / mistake recovery)
//
// IDEMPOTENCY: re-toggling 'sent: true' on an already-ticked row
// is a no-op (the timestamp doesn't move). Linda re-ticking
// Fergus's earlier tick won't change the operator either —
// first-tick wins for audit. Untick + re-tick will record the
// re-tick operator + time (intentional — represents a fresh
// follow-up).

const { supa, isFounderAdmin } = require('./lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── AUTH ──────────────────────────────────────────────────────────
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }

  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Not permitted' }) };
  }

  // ── PARSE BODY ────────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const id = String(body.id || '').trim();
  const sent = !!body.sent;

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid id' }) };
  }

  // ── UPDATE ────────────────────────────────────────────────────────
  // For sent=true, only stamp if not already set (preserves first-
  // tick audit trail). For sent=false, always clear both columns.
  let updatePayload;
  if (sent) {
    // Look up current state — we only stamp if currently null.
    // This preserves the original tick-time + operator on a re-tick
    // (which would otherwise overwrite who first marked it).
    const { data: existing, error: lookupErr } = await supa()
      .from('pending_founder_gifts')
      .select('whatsapp_sent_at')
      .eq('id', id)
      .maybeSingle();
    if (lookupErr) {
      console.error('[toggle-whatsapp] lookup failed:', lookupErr.message);
      return { statusCode: 500, body: JSON.stringify({ error: 'Internal: lookup failed' }) };
    }
    if (!existing) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Pending gift not found' }) };
    }
    if (existing.whatsapp_sent_at) {
      // Already ticked — return current state without touching it.
      // The frontend already shows it ticked; this is a no-op.
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, whatsapp_sent_at: existing.whatsapp_sent_at, no_change: true }),
      };
    }
    updatePayload = {
      whatsapp_sent_at: new Date().toISOString(),
      whatsapp_sent_by: operatorEmail,
    };
  } else {
    // Untick: clear both columns. Fresh re-tick will record new operator.
    updatePayload = {
      whatsapp_sent_at: null,
      whatsapp_sent_by: null,
    };
  }

  const { data, error } = await supa()
    .from('pending_founder_gifts')
    .update(updatePayload)
    .eq('id', id)
    .select('id, whatsapp_sent_at')
    .maybeSingle();

  if (error) {
    // Defensive: 'column does not exist' = migration 020 not applied.
    const isMissingColumn = /column .* does not exist/i.test(error.message || '');
    if (isMissingColumn) {
      console.warn('[toggle-whatsapp] columns missing — run migration 020.');
      return {
        statusCode: 503,
        body: JSON.stringify({ error: 'Feature unavailable — admin should run migration 020.' }),
      };
    }
    console.error('[toggle-whatsapp] update failed:', error.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal: update failed' }) };
  }

  if (!data) {
    return { statusCode: 404, body: JSON.stringify({ error: 'Pending gift not found' }) };
  }

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, whatsapp_sent_at: data.whatsapp_sent_at }),
  };
};
