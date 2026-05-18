// netlify/functions/admin-broadcast-create.js
//
// Creates a new Council broadcast. Inserts one row into broadcasts
// and one row per active member into member_broadcast_sends. The
// broadcast sits in 'scheduled' status until its start_at arrives;
// the daily-broadcast-sweep cron then picks it up.
//
// ─── AUTH ───────────────────────────────────────────────────────────────
// Bearer token in Authorization header; admin email checked against
// isFounderAdmin allowlist. Same pattern as admin-resend-publication-email.
//
// ─── REQUEST ────────────────────────────────────────────────────────────
//   POST /.netlify/functions/admin-broadcast-create
//   Authorization: Bearer <supabase access token>
//   Content-Type: application/json
//   Body:
//     {
//       "sender_voice": "maria",
//       "subject":      "Two new appointments to the Privy Council",
//       "body_md":      "Dear {first_name},\n\nMaria writing...",
//       "cta_label":    "Read on the Council page",          // optional
//       "cta_url":      "https://www.ocomain.org/privy-council.html",  // optional
//       "start_at":     "2026-05-20T09:00:00.000Z"           // ISO; must be future
//     }
//
// ─── RESPONSE ───────────────────────────────────────────────────────────
//   200:
//     { "ok": true, "broadcast_id": "uuid",
//       "immediate_count": 4, "delayed_count": 47 }
//
// ─── ACTIVE MEMBER SELECTOR ─────────────────────────────────────────────
//   status = 'active'
//   AND cert_published_at IS NOT NULL
//   AND email_unsubscribed_at IS NULL
//
// Stewards + Life Members (tier IN steward-ind, steward-fam, life-ind,
// life-fam) get release_at = start_at and is_immediate_batch = true.
// Everyone else gets release_at = start_at + 24h and is_immediate_batch
// = false.
//
// ─── IDEMPOTENCY ────────────────────────────────────────────────────────
// No server-side dedup of duplicate broadcasts — admin UI prevents
// double-click by disabling the schedule button after first click.
// If a duplicate broadcast lands anyway, both will send (rare; cost
// is one extra email per member). The unique index on
// (broadcast_id, member_id) prevents *within* a broadcast from
// inserting a member twice.

const { supa, clanId, logEvent, isFounderAdmin } = require('./lib/supabase');

const STEWARD_LIFE_TIERS = new Set([
  'steward-ind', 'steward-fam',
  'life-ind',    'life-fam',
]);

const VALID_VOICES = new Set([
  'maria', 'antoin', 'jessica', 'herald', 'fergus', 'linda',
]);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // ── AUTH ────────────────────────────────────────────────────────────
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return jsonResponse(401, { error: 'Missing Authorization header' });

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return jsonResponse(401, { error: 'Invalid or expired token' });
  }
  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) {
    return jsonResponse(403, { error: 'Not permitted' });
  }

  // ── PARSE & VALIDATE ────────────────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonResponse(400, { error: 'Invalid JSON body' }); }

  const sender_voice = String(body.sender_voice || '').trim();
  if (!VALID_VOICES.has(sender_voice)) {
    return jsonResponse(400, { error: 'Invalid sender_voice', received: sender_voice });
  }
  const subject = String(body.subject || '').trim();
  if (!subject || subject.length > 200) {
    return jsonResponse(400, { error: 'Subject required (1-200 chars)' });
  }
  const body_md = String(body.body_md || '').trim();
  if (!body_md || body_md.length > 20000) {
    return jsonResponse(400, { error: 'Body required (1-20000 chars)' });
  }
  const cta_label = body.cta_label ? String(body.cta_label).trim().slice(0, 80) : null;
  const cta_url   = body.cta_url   ? String(body.cta_url).trim().slice(0, 500) : null;
  if ((cta_label && !cta_url) || (cta_url && !cta_label)) {
    return jsonResponse(400, { error: 'cta_label and cta_url must both be set or both null' });
  }
  if (cta_url && !/^(https?:|mailto:)/i.test(cta_url)) {
    return jsonResponse(400, { error: 'cta_url must be http/https/mailto' });
  }

  // start_at — must parse, must be in the future
  const startAtRaw = body.start_at;
  if (!startAtRaw) return jsonResponse(400, { error: 'start_at required (ISO datetime)' });
  const startAt = new Date(startAtRaw);
  if (Number.isNaN(startAt.getTime())) {
    return jsonResponse(400, { error: 'start_at unparseable' });
  }
  // 60s grace — accounts for clock skew between admin laptop and server.
  if (startAt.getTime() < Date.now() - 60_000) {
    return jsonResponse(400, { error: 'start_at must be in the future' });
  }

  const sb = supa();
  const cid = await clanId();

  // ── INSERT BROADCAST ────────────────────────────────────────────────
  const { data: broadcast, error: bErr } = await sb
    .from('broadcasts')
    .insert({
      clan_id:      cid,
      created_by:   operatorEmail,
      sender_voice,
      subject,
      body_md,
      cta_label,
      cta_url,
      start_at:     startAt.toISOString(),
      status:       'scheduled',
    })
    .select('id')
    .single();
  if (bErr) {
    console.error('[broadcast-create] insert broadcast failed', bErr);
    return jsonResponse(500, { error: 'Failed to create broadcast' });
  }

  // ── FETCH ACTIVE MEMBERS ────────────────────────────────────────────
  // We page through in chunks of 1000 in case the clan grows beyond a
  // single Supabase response payload. For Ó Comáin at present this is
  // a single round-trip.
  const members = [];
  let page = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await sb
      .from('members')
      .select('id, email, name, tier')
      .eq('clan_id', cid)
      .eq('status', 'active')
      .not('cert_published_at', 'is', null)
      .is('email_unsubscribed_at', null)
      .range(page * pageSize, page * pageSize + pageSize - 1);
    if (error) {
      console.error('[broadcast-create] member fetch failed', error);
      return jsonResponse(500, { error: 'Failed to load members' });
    }
    if (!data || data.length === 0) break;
    members.push(...data);
    if (data.length < pageSize) break;
    page++;
  }

  // ── BUILD SEND ROWS ─────────────────────────────────────────────────
  const startMs = startAt.getTime();
  const delayedReleaseMs = startMs + 24 * 60 * 60 * 1000;
  const startIso   = startAt.toISOString();
  const delayedIso = new Date(delayedReleaseMs).toISOString();

  const rows = [];
  let immediateCount = 0;
  let delayedCount = 0;
  for (const m of members) {
    if (!m.email) continue;
    const isImmediate = STEWARD_LIFE_TIERS.has(m.tier);
    rows.push({
      broadcast_id:       broadcast.id,
      member_id:          m.id,
      status:             'queued',
      release_at:         isImmediate ? startIso : delayedIso,
      is_immediate_batch: isImmediate,
    });
    if (isImmediate) immediateCount++; else delayedCount++;
  }

  // ── INSERT IN BATCHES ───────────────────────────────────────────────
  // Supabase will accept up to 1000 rows per insert call comfortably,
  // but we chunk to 500 to leave headroom for response size.
  const batchSize = 500;
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const { error } = await sb.from('member_broadcast_sends').insert(chunk);
    if (error) {
      console.error('[broadcast-create] sends insert failed at offset', i, error);
      // Best-effort cleanup so we don't leave a half-populated broadcast.
      await sb.from('broadcasts').delete().eq('id', broadcast.id);
      return jsonResponse(500, { error: 'Failed to enqueue sends — broadcast rolled back' });
    }
  }

  // ── UPDATE BROADCAST COUNTS ─────────────────────────────────────────
  await sb
    .from('broadcasts')
    .update({ immediate_count: immediateCount, delayed_count: delayedCount })
    .eq('id', broadcast.id);

  await logEvent('broadcast_created', {
    broadcast_id:    broadcast.id,
    sender_voice,
    subject,
    immediate_count: immediateCount,
    delayed_count:   delayedCount,
    start_at:        startIso,
    created_by:      operatorEmail,
  });

  return jsonResponse(200, {
    ok:              true,
    broadcast_id:    broadcast.id,
    immediate_count: immediateCount,
    delayed_count:   delayedCount,
    start_at:        startIso,
  });
};
