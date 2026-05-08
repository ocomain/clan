// netlify/functions/admin-pending-invitations-list.js
//
// Founder-admin endpoint. POST → returns every UNCLAIMED invitation
// across both gift paths in a single combined list. Backs the
// /members/admin/pending-invitations.html page.
//
// TWO GIFT PATHS:
//   1. Chief gifts: rows in pending_founder_gifts where status='pending'
//      (claimed_at IS NULL). Sent by Linda/Fergus via the Founder
//      Admin tool. The recipient gets a personal welcome from the
//      Chief and a claim link.
//   2. Member-to-member paid gifts: rows in gifts where
//      member_id IS NULL. Bought by one paying member as a gift for
//      another person. The recipient gets the gift email and a
//      claim link. Stays unclaimed until they press the button.
//
// In both cases, "pending" = an invitation has been sent but the
// recipient hasn't acted. Claimed gifts disappear from this list
// (they show up in /members/admin/members.html instead).
//
// AUTH: Bearer token; founder-admin allowlist. Same as siblings.

const { supa, clanId, isFounderAdmin } = require('./lib/supabase');

const CHIEF_GIFT_FIELDS = [
  'id', 'recipient_email', 'recipient_name',
  'tier', 'tier_label', 'tier_family',
  'personal_note',
  'status',
  'created_at', 'expires_at', 'reminder_sent_at',
].join(', ');

const PAID_GIFT_FIELDS = [
  'id', 'recipient_email', 'recipient_name',
  'buyer_email', 'buyer_name',
  'tier', 'tier_label', 'tier_family',
  'gift_mode', 'personal_message',
  'sent_to_recipient_at', 'created_at',
  'status',
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
  if (!token) return jsonResponse(401, { error: 'Missing Authorization header' });

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) return jsonResponse(401, { error: 'Invalid or expired token' });

  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) return jsonResponse(403, { error: 'Not permitted' });

  // ── FETCH (parallel) ────────────────────────────────────────────────
  const cid = await clanId();
  const [chiefRes, paidRes] = await Promise.all([
    supa()
      .from('pending_founder_gifts')
      .select(CHIEF_GIFT_FIELDS)
      .eq('clan_id', cid)
      .eq('status', 'pending')
      .order('created_at', { ascending: false }),
    supa()
      .from('gifts')
      .select(PAID_GIFT_FIELDS)
      .eq('clan_id', cid)
      .is('member_id', null)
      .order('created_at', { ascending: false }),
  ]);

  if (chiefRes.error) {
    console.error('[admin-pending-invitations-list] chief gifts fetch failed:', chiefRes.error.message);
  }
  if (paidRes.error) {
    console.error('[admin-pending-invitations-list] paid gifts fetch failed:', paidRes.error.message);
  }

  // ── NORMALISE INTO ONE SHAPE ────────────────────────────────────────
  // Both gift types collapse to a common envelope so the frontend
  // table can iterate uniformly. The 'type' discriminator drives the
  // pill colour and any per-type rendering.
  const chiefRows = (chiefRes.data || []).map(g => ({
    type: 'chief_gift',
    id: g.id,
    recipient_name:  g.recipient_name,
    recipient_email: g.recipient_email,
    tier:            g.tier,
    tier_label:      g.tier_label,
    tier_family:     g.tier_family,
    from_label:      'The Chief',
    from_email:      null,
    sent_at:         g.created_at,        // pending_founder_gifts has no separate "sent" — created = sent
    expires_at:      g.expires_at,
    reminder_sent_at: g.reminder_sent_at,
    note:            g.personal_note || null,
    status:          g.status,
  }));

  const paidRows = (paidRes.data || []).map(g => ({
    type: 'paid_gift',
    id: g.id,
    recipient_name:  g.recipient_name,
    recipient_email: g.recipient_email,
    tier:            g.tier,
    tier_label:      g.tier_label,
    tier_family:     g.tier_family,
    from_label:      g.buyer_name || g.buyer_email,
    from_email:      g.buyer_email,
    // For paid gifts, sent_to_recipient_at is when the recipient
    // notification was actually emailed; created_at is when the buyer
    // paid. We prefer sent_to_recipient_at when present (true "sent"
    // moment) and fall back to created_at if it isn't stamped yet.
    sent_at:         g.sent_to_recipient_at || g.created_at,
    expires_at:      null,                // paid gifts have no expiry
    reminder_sent_at: null,
    note:            g.personal_message || null,
    status:          g.status,
    gift_mode:       g.gift_mode,
  }));

  const all = [...chiefRows, ...paidRows].sort((a, b) => {
    // Newest sent_at first.
    return new Date(b.sent_at).getTime() - new Date(a.sent_at).getTime();
  });

  return jsonResponse(200, {
    ok: true,
    count: all.length,
    counts: { chief: chiefRows.length, paid: paidRows.length },
    invitations: all,
  });
};
