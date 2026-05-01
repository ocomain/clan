// netlify/functions/claim-and-enter-founder.js
//
// GET /api/claim-and-enter-founder?token=<uuid>
//
// ONE-CLICK FOUNDER GIFT FLOW (2026-04-30):
//
// Replaces the two-step claim-then-magic-link flow with a single
// endpoint that does everything in one HTTP exchange:
//
//   1. Looks up the pending founder gift by claim_token
//   2. Materialises the members row (with comped_by_chief=true,
//      public_register_visible=true, etc — same shape as
//      claim-founder-gift.js)
//   3. Marks the pending row as claimed
//   4. Pre-creates the Supabase auth user
//   5. Generates a magic-link via admin API (no email sent —
//      generateLink returns the action_link directly)
//   6. 302-redirects the browser to the magic-link URL, which
//      Supabase processes server-side and lands the recipient
//      authenticated on /members/?welcome=founder
//
// User experience: click button in email → land in members area
// signed in. No intermediate welcome page, no magic-link-by-email
// step, no email-entry form. A single click does everything.
//
// SECURITY MODEL: the claim_token is the auth. UUIDv4 = 122 bits
// of entropy, sent only via email to a single recipient. If the
// token leaks (forwarded email), the worst case is that some
// other person can claim and sign in as the recipient. Same
// security profile as standard "magic link in email" auth used
// by most SaaS — the link IS the auth.
//
// IDEMPOTENCY:
//   - First click: claims + signs in
//   - Second click (same person, refresh): the gift is already
//     claimed; we DON'T sign them in automatically (could be a
//     forwarded email being clicked by someone else). Instead
//     redirect to /members/login.html?email=<recipient>&claimed=1
//     where they request a magic link to confirm they still
//     control the inbox. This is the safety net.
//
// FAILURE PATHS:
//   - Token missing/malformed → /members/login.html?signin=fallback
//   - Pending row not found   → /members/login.html?signin=invalid
//   - Lapsed gift             → /founder-welcome.html?token=<uuid>
//                               (the existing welcome page handles
//                               the lapsed UX gracefully)
//   - Member insert failed    → /members/login.html?signin=fallback
//   - generateLink failed     → /members/login.html?email=<recipient>&claimed=1
//                               (member exists, just couldn't auto-sign;
//                                they recover via magic link)

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
  console.log(`[claim-and-enter-founder] HIT — token=${token ? token.slice(0,8)+'...'+token.slice(-4) : '(empty)'}`);

  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    console.error('[claim-and-enter-founder] PATH 1: missing/invalid token format → /members/login.html?signin=fallback');
    return redirectTo('/members/login.html?signin=fallback');
  }

  let cid;
  try {
    cid = await clanId();
    console.log(`[claim-and-enter-founder] clan_id=${cid}`);
  } catch (e) {
    console.error('[claim-and-enter-founder] clanId failed:', e.message);
    return redirectTo('/members/login.html?signin=fallback');
  }

  // ── 1. LOOK UP PENDING ROW ─────────────────────────────────────────
  const { data: pending, error: lookupErr } = await supa()
    .from('pending_founder_gifts')
    .select('id, recipient_email, recipient_name, tier, tier_label, tier_family, personal_note, status, created_at, expires_at, claimed_at, member_id')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (lookupErr) {
    console.error('[claim-and-enter-founder] PATH: lookup ERROR:', lookupErr.message, '→ /members/login.html?signin=fallback');
    return redirectTo('/members/login.html?signin=fallback');
  }
  if (!pending) {
    console.warn(`[claim-and-enter-founder] PATH 2: no pending row for token=${token.slice(0,8)}... → /members/login.html?signin=invalid`);
    return redirectTo('/members/login.html?signin=invalid');
  }
  console.log(`[claim-and-enter-founder] FOUND pending: id=${pending.id} recipient=${pending.recipient_email} status=${pending.status} member_id=${pending.member_id || 'null'} expires_at=${pending.expires_at}`);

  // ── 2. ALREADY-CLAIMED PATH ────────────────────────────────────────
  if (pending.status === 'claimed' && pending.member_id) {
    console.log(`[claim-and-enter-founder] PATH 3: pending ${pending.id} already claimed (member_id=${pending.member_id}) → /members/login.html?email=...&claimed=1`);
    return redirectTo(`/members/login.html?email=${encodeURIComponent(pending.recipient_email)}&claimed=1`);
  }

  // ── 3. LAPSED ──────────────────────────────────────────────────────
  if (pending.status === 'lapsed' ||
      (pending.expires_at && new Date(pending.expires_at).getTime() < Date.now())) {
    console.log(`[claim-and-enter-founder] PATH: pending ${pending.id} lapsed (status=${pending.status}, expires_at=${pending.expires_at}) → /founder-welcome.html`);
    return redirectTo(`/founder-welcome.html?token=${encodeURIComponent(token)}`);
  }

  // ── 4. RESOLVE TIER ────────────────────────────────────────────────
  const tierInfo = TIER_BY_SLUG[pending.tier] || TIER_BY_SLUG['clan-ind'];
  if (!TIER_BY_SLUG[pending.tier]) {
    console.error(`[claim-and-enter-founder] pending ${pending.id} unknown tier '${pending.tier}'; using clan-ind`);
  }
  console.log(`[claim-and-enter-founder] tier resolved: ${tierInfo.tier} (${tierInfo.label})`);

  // ── 5. CREATE MEMBER ROW ───────────────────────────────────────────
  // Identical shape to claim-founder-gift.js — comped_by_chief,
  // public_register_visible defaults true, children_visible_on_register
  // when family tier. If we ever change one of these we need to keep
  // both endpoints in sync (or refactor to a shared lib).
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ONE_YEAR_MS);

  const insertRes = await supa()
    .from('members')
    .insert({
      clan_id:                cid,
      email:                  pending.recipient_email,
      name:                   pending.recipient_name,
      tier:                   tierInfo.tier,
      tier_label:             tierInfo.label,
      tier_family:            !!pending.tier_family,
      stripe_customer_id:     null,
      stripe_subscription_id: null,
      status:                 'active',
      joined_at:              now.toISOString(),
      renewed_at:             now.toISOString(),
      expires_at:             expiresAt.toISOString(),
      comped_by_chief:        true,
      comped_at:              now.toISOString(),
      comped_note:            pending.personal_note || null,
      public_register_visible:    true,
      public_register_opted_in_at: now.toISOString(),
      children_visible_on_register: !!pending.tier_family,
      metadata: {
        gift:                 true,
        comped_by_chief:      true,
        pending_gift_id:      pending.id,
        claimed_via:          'one_click_founder',
      },
    })
    .select('id, email, name')
    .single();

  if (insertRes.error) {
    console.error('[claim-and-enter-founder] PATH 4: member insert FAILED:', insertRes.error.message, '→ /members/login.html?signin=fallback');
    return redirectTo(`/members/login.html?email=${encodeURIComponent(pending.recipient_email)}&signin=fallback`);
  }

  const member = insertRes.data;
  console.log(`[claim-and-enter-founder] member created: id=${member.id} email=${member.email}`);

  // ── 6. LINK PENDING → CLAIMED ──────────────────────────────────────
  try {
    await supa()
      .from('pending_founder_gifts')
      .update({
        status:     'claimed',
        member_id:  member.id,
        claimed_at: now.toISOString(),
      })
      .eq('id', pending.id);
    console.log(`[claim-and-enter-founder] pending row marked claimed`);
  } catch (e) {
    console.error(`[claim-and-enter-founder] pending ${pending.id} status update failed:`, e.message);
  }

  // ── 7. ENSURE AUTH USER ────────────────────────────────────────────
  try {
    await ensureAuthUser(pending.recipient_email, pending.recipient_name);
    console.log(`[claim-and-enter-founder] ensureAuthUser OK for ${pending.recipient_email}`);
  } catch (e) {
    console.warn(`[claim-and-enter-founder] ensureAuthUser FAILED for ${pending.recipient_email}:`, e.message, '— continuing, generateLink may still create the user');
  }

  // ── 8. EVENT LOG ───────────────────────────────────────────────────
  try {
    await logEvent({
      clan_id:    cid,
      member_id:  member.id,
      event_type: 'founder_gift_claimed_one_click',
      payload: {
        pending_gift_id:  pending.id,
        recipient_email:  pending.recipient_email,
        tier:             pending.tier,
        days_to_claim:    Math.round((now.getTime() - new Date(pending.created_at).getTime()) / (24 * 60 * 60 * 1000)),
      },
    });
  } catch (e) { /* event log non-fatal */ }

  // ── 9. GENERATE MAGIC LINK + 302 REDIRECT ──────────────────────────
  // Same pattern as welcome-signin.js: admin generateLink returns
  // an action_link URL containing tokens Supabase will accept as
  // authentication. We redirect the browser there; Supabase processes
  // it server-side and lands the recipient authenticated on /members/.
  // No email is sent — generateLink returns the link directly.
  console.log(`[claim-and-enter-founder] calling generateLink for ${pending.recipient_email}, redirectTo=${SITE_URL}/members/?welcome=founder`);
  const { data: linkData, error: linkErr } = await supa().auth.admin.generateLink({
    type: 'magiclink',
    email: pending.recipient_email,
    options: {
      redirectTo: `${SITE_URL}/members/?welcome=founder`,
    },
  });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error('[claim-and-enter-founder] PATH 5: generateLink FAILED:', linkErr?.message || 'no action_link in response', '→ /members/login.html?email=...&claimed=1');
    console.error('[claim-and-enter-founder] linkErr full:', JSON.stringify(linkErr || {}));
    return redirectTo(`/members/login.html?email=${encodeURIComponent(pending.recipient_email)}&claimed=1`);
  }

  console.log(`[claim-and-enter-founder] one-click SUCCESS for ${pending.recipient_email} — redirecting to action_link`);
  return redirectTo(linkData.properties.action_link);
};
