// netlify/functions/admin-resend-publication-email.js
//
// Founder-admin endpoint to manually re-send the publication-confirmation
// email to a member whose original send was dropped (e.g. by lambda
// freeze on the original publish transaction).
//
// First built 8 May 2026 to recover Blackie O'Connell's missing email
// after the diagnosis of a publication side-effect drop on the
// dashboard-action publish path. Kept around as ongoing operational
// tooling — same pattern of failure could in principle recur until
// every publication path is fully awaited (it is, as of the same
// commit, but defensive tooling is cheap).
//
// AUTH: Bearer token in Authorization header. Same pattern as
// send-founder-gift.js — token verified against Supabase auth, email
// checked against isFounderAdmin allowlist (currently clan@ocomain.org).
//
// REQUEST:
//   POST /.netlify/functions/admin-resend-publication-email
//   Authorization: Bearer <supabase access token>
//   Content-Type: application/json
//   Body: { "email": "recipient@example.com" }
//
// RESPONSE (200):
//   { "ok": true, "member_id": "...", "cert_number": "...",
//     "storage_path": "...", "sent_at": "..." }
//
// PRECONDITIONS:
//   - Member exists with the given email.
//   - Member has cert_published_at set (we don't send publication
//     emails to members who haven't published; if you want to publish
//     for them, that's a different action).
//
// IDEMPOTENCY:
//   Re-running this endpoint will send the email again. There's no
//   server-side dedup — caller's responsibility to not spam. The
//   common case is one resend per drop, and a second resend if the
//   first also fails (rare).

const { supa, clanId, logEvent, isFounderAdmin } = require('./lib/supabase');
const { ensureCertificate } = require('./lib/cert-service');
const { sendPublicationConfirmation } = require('./lib/publication-email');

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

  // ── 1. AUTH ─────────────────────────────────────────────────────────
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return jsonResponse(401, { error: 'Missing Authorization header' });
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return jsonResponse(401, { error: 'Invalid or expired token' });
  }

  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) {
    return jsonResponse(403, { error: 'Not permitted' });
  }

  // ── 2. PARSE BODY ───────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const targetEmail = String(body.email || '').toLowerCase().trim();
  if (!targetEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(targetEmail)) {
    return jsonResponse(400, { error: 'Missing or invalid email' });
  }

  console.log(`[admin-resend-publication-email] operator=${operatorEmail} target=${targetEmail}`);

  // ── 3. LOOK UP MEMBER ───────────────────────────────────────────────
  const cid = await clanId();
  const { data: member, error: memberErr } = await supa()
    .from('members')
    .select('*')
    .eq('clan_id', cid)
    .ilike('email', targetEmail)
    .maybeSingle();

  if (memberErr) {
    console.error('[admin-resend-publication-email] member lookup failed:', memberErr.message);
    return jsonResponse(500, { error: 'Member lookup failed', detail: memberErr.message });
  }
  if (!member) {
    return jsonResponse(404, { error: 'No member with that email' });
  }
  if (!member.cert_published_at) {
    return jsonResponse(409, {
      error: 'Member has not published their cert yet',
      member_id: member.id,
    });
  }

  // ── 4. ENSURE CERT (idempotent — returns existing path) ─────────────
  let certResult;
  try {
    certResult = await ensureCertificate(member, cid /* no opts → don't force regenerate */);
  } catch (certErr) {
    console.error('[admin-resend-publication-email] ensureCertificate failed:', certErr.message);
    return jsonResponse(500, { error: 'Certificate not available', detail: certErr.message });
  }

  if (!certResult || !certResult.storagePath) {
    return jsonResponse(500, { error: 'Certificate has no storage path' });
  }

  // ── 5. SEND ─────────────────────────────────────────────────────────
  try {
    await sendPublicationConfirmation(member, certResult, { autoPublished: false });
  } catch (sendErr) {
    console.error('[admin-resend-publication-email] send failed:', sendErr.message, sendErr.stack);
    return jsonResponse(500, {
      error: 'Send failed',
      detail: sendErr.message,
      member_id: member.id,
    });
  }

  const sentAt = new Date().toISOString();

  // ── 6. AUDIT LOG ────────────────────────────────────────────────────
  try {
    await logEvent({
      clan_id: cid,
      member_id: member.id,
      event_type: 'publication_email_resent',
      payload: {
        operator: operatorEmail,
        target_email: targetEmail,
        cert_number: certResult.certNumber || null,
        storage_path: certResult.storagePath,
        sent_at: sentAt,
      },
    });
  } catch (logErr) {
    console.error('[admin-resend-publication-email] logEvent failed (non-fatal):', logErr.message);
  }

  console.log(`[admin-resend-publication-email] OK member_id=${member.id}`);
  return jsonResponse(200, {
    ok: true,
    member_id: member.id,
    cert_number: certResult.certNumber || null,
    storage_path: certResult.storagePath,
    sent_at: sentAt,
  });
};
