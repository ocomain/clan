// netlify/functions/admin-member-lookup.js
//
// Founder-admin endpoint. POST { email } → returns the member row
// (curated fields) and that member's last 20 events. Read-only —
// no mutations from this endpoint. Designed to back the
// /members/admin/member-lookup.html page so an operator can pull up
// a member by email without opening the Supabase SQL editor.
//
// AUTH: Bearer token in Authorization header. Same pattern as the
// other admin endpoints — token verified against Supabase auth,
// email checked against isFounderAdmin allowlist.
//
// REQUEST:
//   POST /.netlify/functions/admin-member-lookup
//   Authorization: Bearer <supabase access token>
//   Content-Type: application/json
//   Body: { "email": "name@example.com" }
//
// RESPONSE (200):
//   {
//     "ok": true,
//     "member": { ... curated subset of the row ... },
//     "events": [
//       { "id", "created_at", "event_type", "payload" },
//       ...up to 20, newest first
//     ]
//   }
//
// RESPONSE (404): { "error": "No member with that email" }
//
// Curated fields: we deliberately do NOT return everything. Stripe
// internal IDs (stripe_subscription_id) are returned because they
// help diagnose payment issues, but raw tokens, hashed values, or
// auth payloads stay out. If a future feature needs another field,
// add it to MEMBER_FIELDS explicitly.

const { supa, clanId, isFounderAdmin } = require('./lib/supabase');

const MEMBER_FIELDS = [
  // identity
  'id', 'email', 'name',
  // lifecycle timestamps
  'created_at', 'joined_at', 'renewed_at', 'expires_at',
  // tier
  'tier', 'tier_label', 'tier_family',
  'status',
  // auth + payment hints (admin uses these to triage)
  'auth_user_id',
  'stripe_customer_id', 'stripe_subscription_id',
  // chief-comped flags
  'comped_by_chief', 'comped_at', 'comped_note',
  // cert
  'cert_version', 'cert_locked_at', 'cert_published_at',
  'cert_publish_reminder_sent_at',
  'ancestor_dedication', 'name_confirmed_on_cert',
  // family
  'partner_name', 'children_first_names',
  // public register
  'public_register_visible', 'public_register_opted_in_at',
  'children_visible_on_register', 'dedication_visible_on_register',
  'display_name_on_register',
  // postal
  'postal_address', 'postal_address_provided_at', 'cert_posted_at',
  // patents
  'patent_urls', 'sponsor_titles_awarded',
  // welcome flow
  'family_details_completed_at',
  // lifecycle emails — explicit columns; the daily-post-signup-sweep
  // stamps these and they're the fastest signal for 'did email N fire'
  'post_signup_email_3_sent_at',
  'post_signup_email_9_sent_at',
  'gift_renewal_reminded_at',
  // free-form metadata blob — small, useful (gift origin, claim path)
  'metadata',
].join(', ');

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

  // ── 3. LOOK UP MEMBER ───────────────────────────────────────────────
  const cid = await clanId();
  const { data: member, error: memberErr } = await supa()
    .from('members')
    .select(MEMBER_FIELDS)
    .eq('clan_id', cid)
    .ilike('email', targetEmail)
    .maybeSingle();

  if (memberErr) {
    console.error('[admin-member-lookup] lookup failed:', memberErr.message);
    return jsonResponse(500, { error: 'Lookup failed', detail: memberErr.message });
  }
  if (!member) {
    return jsonResponse(404, { error: 'No member with that email' });
  }

  // ── GIFT RECIPIENT FLAG ─────────────────────────────────────────────
  // Same logic as admin-members-list: a member is a "gift" recipient
  // (vs Chief-comped) if they appear in the gifts table. Single-row
  // lookup here so just check existence.
  let isGiftRecipient = false;
  try {
    const { data: giftRow } = await supa()
      .from('gifts')
      .select('id')
      .eq('clan_id', cid)
      .eq('member_id', member.id)
      .maybeSingle();
    isGiftRecipient = !!giftRow;
  } catch (e) {
    console.error('[admin-member-lookup] gift check threw (non-fatal):', e.message);
  }
  member.is_gift_recipient = isGiftRecipient;

  // ── 4. EVENTS — newest first, capped at 20 ──────────────────────────
  const { data: events, error: eventsErr } = await supa()
    .from('events')
    .select('id, created_at, event_type, payload')
    .eq('clan_id', cid)
    .eq('member_id', member.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (eventsErr) {
    // Non-fatal — return the member without events rather than 500.
    console.error('[admin-member-lookup] events fetch failed (non-fatal):', eventsErr.message);
  }

  return jsonResponse(200, {
    ok: true,
    member,
    events: events || [],
  });
};
