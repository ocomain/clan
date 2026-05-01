// netlify/functions/claim-and-enter-founder.js
//
// POST /api/claim-and-enter-founder
// Body: { token: <uuid> }
//
// ONE-CLICK FOUNDER GIFT FLOW (revised 2026-05-01):
//
// Originally a GET endpoint with 302 redirects — clicked directly
// from the email button. That created a critical bug: corporate
// email scanners (Outlook ATP, Gmail safe-link, Mimecast,
// Proofpoint) GET every link in incoming email to check for
// malware. Each scan-GET hit this endpoint, ran the full claim
// flow, marked the gift claimed, and redirected. By the time
// the recipient clicked, the token was consumed and they
// landed on the 'already claimed — request a magic link' page.
//
// Fix: POST-only. Mail scanners GET — they get 405 here, but
// they GET /founder-welcome.html?token=X first which is a
// pure render with no side effects. Real recipients arrive at
// the welcome page, see their name + tier + the personal note
// from the Chief, and click 'Claim my place →'. That button
// click POSTs to this endpoint, which:
//
//   1. Looks up the pending founder gift by claim_token
//   2. Materialises the members row (with comped_by_chief=true,
//      public_register_visible=true, etc — same shape as
//      claim-founder-gift.js)
//   3. Marks the pending row as claimed
//   4. Pre-creates the Supabase auth user
//   5. Generates a magic-link via admin API (no email sent —
//      generateLink returns the action_link directly)
//   6. Returns JSON { ok: true, action_link } — the welcome page's
//      JS sets window.location.href = action_link, which Supabase
//      processes server-side and lands the recipient on
//      /members/?welcome=founder authenticated.
//
// User experience: open email → see welcome page with name + tier
// → click button → land in members area signed in. Two clicks
// instead of the original 'one click' design, but ONE of those
// clicks is unavoidable for safety against mail scanners. Real
// industry standard pattern (GitHub/Notion/Stripe all do this).
//
// SECURITY MODEL: the claim_token is the auth. UUIDv4 = 122 bits
// of entropy, sent only via email. POST-only ensures the token
// is consumed by deliberate human action, not automated scans.
//
// IDEMPOTENCY:
//   - First POST: claims + returns action_link
//   - Second POST (refresh of claim, or someone else with same URL):
//     pending row already claimed → returns { ok: false,
//     reason: 'already_claimed', recipient_email } so the
//     welcome page can show 'fallback to magic link' UI
//
// FAILURE PATHS (all return JSON with reason; no redirects):
//   - Method != POST                  → 405
//   - Token missing/malformed          → 400 reason: 'invalid_token'
//   - Pending row not found            → 404 reason: 'not_found'
//   - Already claimed                  → 409 reason: 'already_claimed'
//   - Lapsed                           → 410 reason: 'lapsed'
//   - Member insert failed             → 500 reason: 'insert_failed'
//   - generateLink failed              → 500 reason: 'signin_failed'
//                                        (still returns recipient_email
//                                        so welcome page can offer
//                                        magic-link fallback)

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
  // ── METHOD GUARD ────────────────────────────────────────────────────
  // POST-only. GET requests come from mail scanners pre-fetching the
  // URL — we do NOT want to claim on those. Return 405 so scanners
  // give up and the recipient's first real click is the one that lands.
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { ok: false, reason: 'method_not_allowed' });
  }

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* ignore */ }
  const token = String(body.token || '').trim();
  console.log(`[claim-and-enter-founder] POST HIT — token=${token ? token.slice(0,8)+'...'+token.slice(-4) : '(empty)'}`);

  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    console.error('[claim-and-enter-founder] invalid token format');
    return jsonResponse(400, { ok: false, reason: 'invalid_token' });
  }

  let cid;
  try {
    cid = await clanId();
    console.log(`[claim-and-enter-founder] clan_id=${cid}`);
  } catch (e) {
    console.error('[claim-and-enter-founder] clanId failed:', e.message);
    return jsonResponse(500, { ok: false, reason: 'server_error' });
  }

  // ── 1. LOOK UP PENDING ROW ─────────────────────────────────────────
  const { data: pending, error: lookupErr } = await supa()
    .from('pending_founder_gifts')
    .select('id, recipient_email, recipient_name, tier, tier_label, tier_family, personal_note, status, created_at, expires_at, claimed_at, member_id')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (lookupErr) {
    console.error('[claim-and-enter-founder] lookup ERROR:', lookupErr.message);
    return jsonResponse(500, { ok: false, reason: 'lookup_failed' });
  }
  if (!pending) {
    console.warn(`[claim-and-enter-founder] no pending row for token`);
    return jsonResponse(404, { ok: false, reason: 'not_found' });
  }
  console.log(`[claim-and-enter-founder] FOUND pending: id=${pending.id} recipient=${pending.recipient_email} status=${pending.status} member_id=${pending.member_id || 'null'}`);

  // ── 2. ALREADY-CLAIMED PATH ────────────────────────────────────────
  // Even though POST-only protects against most mail-scanner pre-clicks,
  // a recipient could legitimately re-POST (refresh, double-click). We
  // surface this as 409 with the recipient_email so the welcome page
  // can show the magic-link fallback affordance ('Sign in with a fresh
  // link to your inbox').
  if (pending.status === 'claimed' && pending.member_id) {
    console.log(`[claim-and-enter-founder] already claimed (member_id=${pending.member_id})`);
    return jsonResponse(409, {
      ok: false,
      reason: 'already_claimed',
      recipient_email: pending.recipient_email,
    });
  }

  // ── 3. LAPSED ──────────────────────────────────────────────────────
  if (pending.status === 'lapsed' ||
      (pending.expires_at && new Date(pending.expires_at).getTime() < Date.now())) {
    console.log(`[claim-and-enter-founder] lapsed (status=${pending.status}, expires_at=${pending.expires_at})`);
    return jsonResponse(410, {
      ok: false,
      reason: 'lapsed',
      recipient_email: pending.recipient_email,
    });
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
    console.error('[claim-and-enter-founder] member insert FAILED:', insertRes.error.message);
    return jsonResponse(500, {
      ok: false,
      reason: 'insert_failed',
      recipient_email: pending.recipient_email,
    });
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

  // ── 9. GENERATE MAGIC LINK + RETURN action_link AS JSON ────────────
  // Same pattern as welcome-signin.js: admin generateLink returns an
  // action_link URL with auth tokens. We return it in JSON; the
  // welcome page's JS does window.location.href = data.action_link
  // and Supabase processes it server-side, landing the recipient
  // signed in to /members/.
  console.log(`[claim-and-enter-founder] calling generateLink for ${pending.recipient_email}, redirectTo=${SITE_URL}/members/?welcome=founder`);
  const { data: linkData, error: linkErr } = await supa().auth.admin.generateLink({
    type: 'magiclink',
    email: pending.recipient_email,
    options: {
      redirectTo: `${SITE_URL}/members/?welcome=founder`,
    },
  });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error('[claim-and-enter-founder] generateLink FAILED:', linkErr?.message || 'no action_link');
    console.error('[claim-and-enter-founder] linkErr full:', JSON.stringify(linkErr || {}));
    // Member is created and pending row is marked claimed, but we
    // couldn't auto-sign-in. Return signin_failed so the welcome
    // page can show 'fallback to magic link' UI — recipient will
    // request a fresh magic link from /members/login.html.
    return jsonResponse(500, {
      ok: false,
      reason: 'signin_failed',
      recipient_email: pending.recipient_email,
    });
  }

  console.log(`[claim-and-enter-founder] one-click SUCCESS for ${pending.recipient_email}`);
  return jsonResponse(200, {
    ok: true,
    action_link: linkData.properties.action_link,
    recipient_email: pending.recipient_email,
  });
};
