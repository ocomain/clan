// netlify/functions/claim-and-enter-paid.js
//
// POST /api/claim-and-enter-paid
// Body: { token: <uuid> }
//
// Phase 2 sibling of claim-and-enter-founder.js — same POST-only
// pattern, reads the gifts table instead of pending_founder_gifts,
// doesn't set comped_by_chief, keeps buyer info in metadata.
//
// See claim-and-enter-founder.js header comment for full
// architectural rationale (POST-only protects against mail-scanner
// pre-clicks consuming the token).

const { supa, clanId, logEvent, TIER_BY_SLUG } = require('./lib/supabase');
const { ensureAuthUser } = require('./lib/cert-service');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, reason: 'method_not_allowed' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const token = String(body.token || '').trim();
  console.log(`[claim-and-enter-paid] POST HIT — token=${token ? token.slice(0,8)+'...'+token.slice(-4) : '(empty)'}`);

  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return jsonResponse(400, { ok: false, reason: 'invalid_token' });
  }

  let cid;
  try {
    cid = await clanId();
  } catch (e) {
    console.error('[claim-and-enter-paid] clanId failed:', e.message);
    return jsonResponse(500, { ok: false, reason: 'server_error' });
  }

  const { data: gift, error: lookupErr } = await supa()
    .from('gifts')
    .select('id, recipient_email, recipient_name, buyer_email, buyer_name, tier, tier_label, tier_family, personal_message, status, expires_at, member_id, created_at')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (lookupErr) {
    console.error('[claim-and-enter-paid] lookup failed:', lookupErr.message);
    return jsonResponse(500, { ok: false, reason: 'lookup_failed' });
  }
  if (!gift) {
    return jsonResponse(404, { ok: false, reason: 'not_found' });
  }
  console.log(`[claim-and-enter-paid] FOUND gift: id=${gift.id} status=${gift.status} member_id=${gift.member_id || 'null'}`);

  if (gift.member_id) {
    return jsonResponse(409, { ok: false, reason: 'already_claimed', recipient_email: gift.recipient_email });
  }

  if (gift.status === 'lapsed' ||
      (gift.expires_at && new Date(gift.expires_at).getTime() < Date.now())) {
    return jsonResponse(410, { ok: false, reason: 'lapsed', recipient_email: gift.recipient_email });
  }

  const tierInfo = TIER_BY_SLUG[gift.tier] || TIER_BY_SLUG['clan-ind'];
  if (!TIER_BY_SLUG[gift.tier]) {
    console.error(`[claim-and-enter-paid] unknown tier '${gift.tier}'; using clan-ind`);
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + ONE_YEAR_MS);

  const insertRes = await supa()
    .from('members')
    .insert({
      clan_id:                cid,
      email:                  gift.recipient_email,
      name:                   gift.recipient_name,
      tier:                   tierInfo.tier,
      tier_label:             tierInfo.label,
      tier_family:            !!gift.tier_family,
      stripe_customer_id:     null,
      stripe_subscription_id: null,
      status:                 'active',
      joined_at:              now.toISOString(),
      renewed_at:             now.toISOString(),
      expires_at:             expiresAt.toISOString(),
      public_register_visible:    true,
      public_register_opted_in_at: now.toISOString(),
      children_visible_on_register: !!gift.tier_family,
      metadata: {
        gift:           true,
        buyer_name:     gift.buyer_name,
        buyer_email:    gift.buyer_email,
        gift_id:        gift.id,
        claimed_via:    'one_click_paid',
      },
    })
    .select('id, email, name')
    .single();

  if (insertRes.error) {
    console.error('[claim-and-enter-paid] member insert failed:', insertRes.error.message);
    return jsonResponse(500, { ok: false, reason: 'insert_failed', recipient_email: gift.recipient_email });
  }

  const member = insertRes.data;

  try {
    await supa()
      .from('gifts')
      .update({ status: 'claimed', member_id: member.id, claimed_at: now.toISOString() })
      .eq('id', gift.id);
  } catch (e) {
    console.error(`[claim-and-enter-paid] gift status update failed:`, e.message);
  }

  try {
    await ensureAuthUser(gift.recipient_email, gift.recipient_name);
  } catch (e) {
    console.warn(`[claim-and-enter-paid] ensureAuthUser failed:`, e.message);
  }

  try {
    await logEvent({
      clan_id:    cid,
      member_id:  member.id,
      event_type: 'paid_gift_claimed_one_click',
      payload: {
        gift_id:         gift.id,
        recipient_email: gift.recipient_email,
        buyer_email:     gift.buyer_email,
        tier:            gift.tier,
      },
    });
  } catch (e) { /* non-fatal */ }

  const { data: linkData, error: linkErr } = await supa().auth.admin.generateLink({
    type: 'magiclink',
    email: gift.recipient_email,
    options: { redirectTo: `${SITE_URL}/members/?welcome=gift` },
  });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error('[claim-and-enter-paid] generateLink failed:', linkErr?.message);
    return jsonResponse(500, { ok: false, reason: 'signin_failed', recipient_email: gift.recipient_email });
  }

  console.log(`[claim-and-enter-paid] SUCCESS for ${gift.recipient_email}`);
  return jsonResponse(200, {
    ok: true,
    action_link: linkData.properties.action_link,
    recipient_email: gift.recipient_email,
  });
};
