// netlify/functions/admin-members-list.js
//
// Founder-admin endpoint. POST → returns ALL members of the clan with
// a curated set of "list view" columns. Backs the members dashboard
// at /members/admin/members.html.
//
// AUTH: Bearer token in Authorization header. Same pattern as the
// other admin endpoints — token verified against Supabase auth,
// email checked against isFounderAdmin allowlist.
//
// REQUEST:
//   POST /.netlify/functions/admin-members-list
//   Authorization: Bearer <supabase access token>
//   (body is ignored)
//
// RESPONSE (200):
//   { "ok": true, "count": 47, "members": [ ...curated rows... ] }
//
// SCALE NOTE: this fetches every member in one go. Fine at current
// scale (~50 members). When the count crosses a few hundred and the
// payload starts to feel heavy, switch to cursor pagination on
// created_at. The frontend would then need to merge pages — defer
// until the threshold is actually hit.
//
// CURATION: deliberately not all columns. The list view shows
// identity, tier, dates, and the handful of status flags the
// dashboard renders as pills. Anything richer (postal address,
// dedications, family fields, metadata) is fetched on demand by
// admin-member-lookup when a row is clicked.

const { supa, clanId, isFounderAdmin } = require('./lib/supabase');

const LIST_FIELDS = [
  // identity
  'id', 'email', 'name',
  // tier
  'tier', 'tier_label', 'tier_family',
  // lifecycle
  'created_at', 'joined_at',
  'status',
  // status flags the dashboard renders as pills
  'auth_user_id',          // null = never signed in
  'stripe_customer_id',    // null + comped=false = ??? (rare)
  'comped_by_chief',
  'cert_published_at',
  'public_register_visible',
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

  // ── AUTH ────────────────────────────────────────────────────────────
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

  // ── FETCH ───────────────────────────────────────────────────────────
  const cid = await clanId();
  const { data: members, error: listErr } = await supa()
    .from('members')
    .select(LIST_FIELDS)
    .eq('clan_id', cid)
    .order('created_at', { ascending: false });

  if (listErr) {
    console.error('[admin-members-list] fetch failed:', listErr.message);
    return jsonResponse(500, { error: 'Fetch failed', detail: listErr.message });
  }

  return jsonResponse(200, {
    ok: true,
    count: (members || []).length,
    members: members || [],
  });
};
