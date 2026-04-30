// netlify/functions/claim-paid-gift.js
//
// POST /api/claim-paid-gift
// Body: { token: <uuid> }
//
// The claim moment of the deferred-acceptance flow for paid gifts.
// Recipient clicks 'Claim my place' on /gift-welcome.html → page
// POSTs the token here → server materialises the `members` row from
// the gift's data, links them, and flips status to 'claimed'.
//
// This endpoint is the one that creates the actual member. Until
// it runs successfully, the recipient is not a member of the clan,
// will not appear on the public Register, and will not have a
// certificate generated.
//
// Phase 2 sibling of claim-founder-gift.js — same logic, different
// table (gifts vs pending_founder_gifts) and slightly different
// member-creation shape (paid gifts don't set comped_by_chief and
// keep buyer info in metadata).
//
// AUTH: NONE. The claim_token IS the auth — UUIDv4 = 122 random
// bits. If the token leaks (forwarded email), the worst case is
// that some other person can claim a membership that was meant for
// the original recipient — implicit 'gift to a friend' affordance.
// The magic-link login still goes to the original recipient_email,
// so they can recover access if needed.
//
// IDEMPOTENCY: claiming a token that's already been claimed
// returns the existing member info rather than creating a duplicate
// or erroring. If the recipient double-clicks or refreshes after
// successful claim, they get the same member object back.
//
// LAPSED: if the gift is in 'lapsed' status OR expires_at is in
// the past, returns 410 Gone with a friendly message.

const { supa, clanId, logEvent, TIER_BY_SLUG } = require('./lib/supabase');
const { ensureAuthUser } = require('./lib/cert-service');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  const token = String(body.token || '').trim();
  if (!token) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing token' }),
    };
  }

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid token format' }),
    };
  }

  let cid;
  try {
    cid = await clanId();
  } catch (e) {
    console.error('clanId failed:', e.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal: clan lookup failed' }),
    };
  }

  // ── 1. LOOK UP THE GIFT ROW ───────────────────────────────────────
  const { data: gift, error: lookupErr } = await supa()
    .from('gifts')
    .select('id, recipient_email, recipient_name, buyer_email, buyer_name, tier, tier_label, tier_family, personal_message, status, expires_at, member_id, created_at')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (lookupErr) {
    console.error('claim paid gift lookup failed:', lookupErr.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal: lookup failed' }),
    };
  }

  if (!gift) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No gift for this token' }),
    };
  }

  // ── 2. STATE GATING ───────────────────────────────────────────────
  // Already claimed: gift.member_id is set. Return the existing
  // member info (idempotent).
  if (gift.member_id) {
    const { data: existingMember } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, joined_at')
      .eq('id', gift.member_id)
      .maybeSingle();
    if (existingMember) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok:              true,
          already_claimed: true,
          member:          existingMember,
        }),
      };
    }
    // Edge case: member_id set but member not found. Log + re-create.
    console.error(`gift ${gift.id} marked claimed but member ${gift.member_id} not found — re-creating`);
  }

  // Lapsed (explicit terminal status).
  if (gift.status === 'lapsed') {
    return {
      statusCode: 410,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:      'This gift has lapsed',
        message:    'The window for claiming this gift has passed. Please contact the giver — they may wish to renew it.',
        expired_at: gift.expires_at,
      }),
    };
  }

  // Defensive: also check expires_at directly. If the cron hasn't
  // run yet but the gift is logically lapsed, refuse and mark.
  if (gift.expires_at && new Date(gift.expires_at).getTime() < Date.now()) {
    try {
      await supa()
        .from('gifts')
        .update({ status: 'lapsed' })
        .eq('id', gift.id);
    } catch (e) {
      console.warn(`couldn't mark gift ${gift.id} lapsed inline:`, e.message);
    }
    return {
      statusCode: 410,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:      'This gift has lapsed',
        message:    'The window for claiming this gift has passed. Please contact the giver — they may wish to renew it.',
        expired_at: gift.expires_at,
      }),
    };
  }

  // ── 3. RESOLVE TIER (defensive) ───────────────────────────────────
  const tierInfo = TIER_BY_SLUG[gift.tier] || TIER_BY_SLUG['clan-ind'];
  if (!TIER_BY_SLUG[gift.tier]) {
    console.error(`gift ${gift.id} has unknown tier '${gift.tier}'; falling back to clan-ind`);
  }

  // ── 4. CREATE THE MEMBER ROW ──────────────────────────────────────
  // Same shape as the original direct-insert that the Stripe webhook
  // gift branch used to do, just deferred until now. Keeps buyer
  // info in metadata so analytics can still trace the gift origin.
  // No comped_by_chief — this was a paid gift, not a chief comp.
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
      // Stripe customer/subscription belong to the BUYER, not the
      // member — keep them null on the member row so the recipient
      // doesn't get Stripe renewal receipts. The original gift row
      // tracks them.
      stripe_customer_id:     null,
      stripe_subscription_id: null,
      status:                 'active',
      joined_at:              now.toISOString(),
      renewed_at:             now.toISOString(),
      expires_at:             expiresAt.toISOString(),
      metadata: {
        gift:           true,
        buyer_name:     gift.buyer_name,
        buyer_email:    gift.buyer_email,
        gift_id:        gift.id,
        claimed_via:    'gift_welcome_page',
      },
    })
    .select('id, email, name, tier, tier_label, joined_at')
    .single();

  if (insertRes.error) {
    console.error('claim paid gift member insert failed:', insertRes.error.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error:  'Could not create member row',
        detail: insertRes.error.message,
      }),
    };
  }

  const member = insertRes.data;

  // ── 5. LINK GIFT ROW → CLAIMED ────────────────────────────────────
  const updateRes = await supa()
    .from('gifts')
    .update({
      status:     'claimed',
      member_id:  member.id,
      claimed_at: now.toISOString(),
    })
    .eq('id', gift.id);

  if (updateRes.error) {
    console.error(`gift ${gift.id} status update failed:`, updateRes.error.message);
    // Don't fail the request — member exists. Soft inconsistency only.
  }

  // ── 6. ENSURE AUTH USER ───────────────────────────────────────────
  try {
    await ensureAuthUser(gift.recipient_email, gift.recipient_name);
  } catch (e) {
    console.warn(`ensureAuthUser failed for ${gift.recipient_email} (non-fatal):`, e.message);
  }

  // ── 7. EVENT LOG ──────────────────────────────────────────────────
  try {
    await logEvent({
      clan_id:    cid,
      member_id:  member.id,
      event_type: 'paid_gift_claimed',
      payload: {
        gift_id:         gift.id,
        recipient_email: gift.recipient_email,
        buyer_email:     gift.buyer_email,
        tier:            gift.tier,
        days_to_claim:   Math.round((now.getTime() - new Date(gift.created_at).getTime()) / (24 * 60 * 60 * 1000)),
      },
    });
  } catch (e) {
    console.warn('paid_gift_claimed event log failed (non-fatal):', e.message);
  }

  // ── 8. SUCCESS ────────────────────────────────────────────────────
  return {
    statusCode: 201,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ok:     true,
      member: {
        id:         member.id,
        email:      member.email,
        name:       member.name,
        tier:       member.tier,
        tier_label: member.tier_label,
        joined_at:  member.joined_at,
      },
    }),
  };
};
