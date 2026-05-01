// netlify/functions/claim-and-enter-paid.js
//
// GET /api/claim-and-enter-paid?token=<uuid>
//
// ONE-CLICK PAID GIFT FLOW (2026-04-30):
//
// Phase 2 sibling of claim-and-enter-founder.js — same pattern,
// reads the gifts table instead of pending_founder_gifts, doesn't
// set comped_by_chief, keeps buyer info in metadata.
//
// See claim-and-enter-founder.js header comment for full
// architectural rationale + security model.

const { supa, clanId, logEvent, TIER_BY_SLUG } = require('./lib/supabase');
const { ensureAuthUser } = require('./lib/cert-service');

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

function redirectTo(url) {
  return {
    statusCode: 302,
    headers: { Location: url, 'Cache-Control': 'no-store' },
    body: '',
  };
}

exports.handler = async (event) => {
  const token = (event.queryStringParameters && event.queryStringParameters.token) || '';

  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    console.error('[claim-and-enter-paid] missing/invalid token');
    return redirectTo('/members/login.html?signin=fallback');
  }

  let cid;
  try {
    cid = await clanId();
  } catch (e) {
    console.error('[claim-and-enter-paid] clanId failed:', e.message);
    return redirectTo('/members/login.html?signin=fallback');
  }

  // ── 1. LOOK UP GIFT ROW ────────────────────────────────────────────
  const { data: gift, error: lookupErr } = await supa()
    .from('gifts')
    .select('id, recipient_email, recipient_name, buyer_email, buyer_name, tier, tier_label, tier_family, personal_message, status, expires_at, member_id, created_at')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (lookupErr) {
    console.error('[claim-and-enter-paid] lookup failed:', lookupErr.message);
    return redirectTo('/members/login.html?signin=fallback');
  }
  if (!gift) {
    console.warn('[claim-and-enter-paid] no gift row for token');
    return redirectTo('/members/login.html?signin=invalid');
  }

  // ── 2. ALREADY-CLAIMED PATH ────────────────────────────────────────
  // Second click — fall back to magic-link flow with email pre-fill.
  // (Don't auto-sign-in second click; could be a forwarded email
  // opened by someone else. Magic link goes only to recipient inbox.)
  if (gift.member_id) {
    console.log(`[claim-and-enter-paid] gift ${gift.id} already claimed — falling back to magic-link flow`);
    return redirectTo(`/members/login.html?email=${encodeURIComponent(gift.recipient_email)}&claimed=1`);
  }

  // ── 3. LAPSED ──────────────────────────────────────────────────────
  if (gift.status === 'lapsed' ||
      (gift.expires_at && new Date(gift.expires_at).getTime() < Date.now())) {
    console.log(`[claim-and-enter-paid] gift ${gift.id} lapsed — sending to welcome page for graceful UX`);
    return redirectTo(`/gift-welcome.html?token=${encodeURIComponent(token)}`);
  }

  // ── 4. RESOLVE TIER ────────────────────────────────────────────────
  const tierInfo = TIER_BY_SLUG[gift.tier] || TIER_BY_SLUG['clan-ind'];
  if (!TIER_BY_SLUG[gift.tier]) {
    console.error(`[claim-and-enter-paid] gift ${gift.id} unknown tier '${gift.tier}'; using clan-ind`);
  }

  // ── 5. CREATE MEMBER ROW ───────────────────────────────────────────
  // Identical shape to claim-paid-gift.js. No comped_by_chief — paid
  // gifts are bought, not warranted. Buyer info kept in metadata for
  // analytics. public_register_visible defaults true (same policy as
  // founder claim).
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
    return redirectTo(`/members/login.html?email=${encodeURIComponent(gift.recipient_email)}&signin=fallback`);
  }

  const member = insertRes.data;

  // ── 6. LINK GIFT → CLAIMED ─────────────────────────────────────────
  try {
    await supa()
      .from('gifts')
      .update({
        status:     'claimed',
        member_id:  member.id,
        claimed_at: now.toISOString(),
      })
      .eq('id', gift.id);
  } catch (e) {
    console.error(`[claim-and-enter-paid] gift ${gift.id} status update failed:`, e.message);
  }

  // ── 7. ENSURE AUTH USER ────────────────────────────────────────────
  try {
    await ensureAuthUser(gift.recipient_email, gift.recipient_name);
  } catch (e) {
    console.warn(`[claim-and-enter-paid] ensureAuthUser failed for ${gift.recipient_email}:`, e.message);
  }

  // ── 8. EVENT LOG ───────────────────────────────────────────────────
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
        days_to_claim:   Math.round((now.getTime() - new Date(gift.created_at).getTime()) / (24 * 60 * 60 * 1000)),
      },
    });
  } catch (e) { /* event log non-fatal */ }

  // ── 9. GENERATE MAGIC LINK + 302 REDIRECT ──────────────────────────
  const { data: linkData, error: linkErr } = await supa().auth.admin.generateLink({
    type: 'magiclink',
    email: gift.recipient_email,
    options: {
      redirectTo: `${SITE_URL}/members/?welcome=gift`,
    },
  });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error('[claim-and-enter-paid] generateLink failed:', linkErr?.message);
    return redirectTo(`/members/login.html?email=${encodeURIComponent(gift.recipient_email)}&claimed=1`);
  }

  console.log(`[claim-and-enter-paid] one-click success for ${gift.recipient_email}`);
  return redirectTo(linkData.properties.action_link);
};
