// netlify/functions/claim-founder-gift.js
//
// POST /api/claim-founder-gift
// Body: { token: <uuid> }
//
// The claim moment of the deferred-acceptance flow. Recipient clicks
// 'Claim my place' on /founder-welcome.html → page POSTs the token
// here → server materialises the `members` row from the pending
// row's data, links them, and flips status to 'claimed'.
//
// This endpoint is the one that creates the actual member. Until
// it runs successfully, the recipient is not a member of the clan,
// will not appear on the public Register, and will not have a
// certificate generated.
//
// AUTH: NONE. The claim_token IS the auth — UUIDv4 has 122 random
// bits, sent only via the welcome email to a single recipient. If
// the token leaks (forwarded email, etc.), the worst case is that
// some other person can claim a membership that was meant for the
// original recipient — which is reasonable: the 'gift to a friend'
// affordance is implicit.
//
// IDEMPOTENCY: this endpoint is idempotent in the sense that
// claiming a token that's already 'claimed' returns the existing
// member info (rather than creating a duplicate or erroring). If a
// recipient double-clicks the button or refreshes after a
// successful claim, they get the same member object back. The DB
// constraint on members.email (unique within clan) would catch a
// genuine duplicate-create attempt anyway, but checking status
// first means we never even try the INSERT for a claimed row.
//
// LAPSED handling: if the pending row is already 'lapsed', return
// 410 Gone with a friendly message. Lapsed means the 1-year window
// has passed and the cron has marked the row terminal — even if a
// token leak triggers a click later, the gift cannot revive itself.
// The recipient would need to be re-offered a new gift by Fergus.

const { supa, clanId, logEvent, TIER_BY_SLUG } = require('./lib/supabase');
const { ensureAuthUser } = require('./lib/cert-service');

// One year in ms — used to compute the new member's expires_at.
// Mirrors paid annual memberships.
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

  // ── 1. LOOK UP THE PENDING ROW ────────────────────────────────────
  const { data: pending, error: lookupErr } = await supa()
    .from('pending_founder_gifts')
    .select('id, recipient_email, recipient_name, tier, tier_label, tier_family, personal_note, status, created_at, expires_at, claimed_at, member_id')
    .eq('clan_id', cid)
    .eq('claim_token', token)
    .maybeSingle();

  if (lookupErr) {
    console.error('claim founder gift lookup failed:', lookupErr.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Internal: lookup failed' }),
    };
  }

  if (!pending) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No pending gift for this token' }),
    };
  }

  // ── 2. STATE GATING ───────────────────────────────────────────────
  // Already claimed: return the existing member info (idempotent).
  if (pending.status === 'claimed' && pending.member_id) {
    const { data: existingMember } = await supa()
      .from('members')
      .select('id, email, name, tier, tier_label, joined_at')
      .eq('id', pending.member_id)
      .maybeSingle();
    if (existingMember) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ok:           true,
          already_claimed: true,
          member:       existingMember,
        }),
      };
    }
    // Edge case: status='claimed' but no member found. Treat as a
    // recoverable corruption — log loudly, then proceed with the
    // claim as if it were pending. Better to over-create than to
    // leave the recipient stuck.
    console.error(`pending gift ${pending.id} marked claimed but member ${pending.member_id} not found — re-creating`);
  }

  // Lapsed: terminal. Return 410 Gone.
  if (pending.status === 'lapsed') {
    return {
      statusCode: 410,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'This gift has lapsed',
        message: 'The window for claiming this founding place has passed. Please contact the clan if you would like to be welcomed afresh.',
        expired_at: pending.expires_at,
      }),
    };
  }

  // Defensive: also check expires_at directly. If the cron hasn't
  // run yet but the gift is logically lapsed, refuse the claim
  // rather than creating a member off an expired offer.
  if (pending.expires_at && new Date(pending.expires_at).getTime() < Date.now()) {
    // Mark the row lapsed inline so subsequent calls are consistent.
    // Best-effort — failure here doesn't change what we return.
    try {
      await supa()
        .from('pending_founder_gifts')
        .update({ status: 'lapsed' })
        .eq('id', pending.id);
    } catch (e) {
      console.warn(`couldn't mark pending ${pending.id} lapsed inline:`, e.message);
    }
    return {
      statusCode: 410,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'This gift has lapsed',
        message: 'The window for claiming this founding place has passed. Please contact the clan if you would like to be welcomed afresh.',
        expired_at: pending.expires_at,
      }),
    };
  }

  // ── 3. RESOLVE TIER (defensive — should already be valid in the row) ─
  // If something went wrong at insert and we've got a non-canonical
  // tier slug stored, fall back to clan-ind. Logged loudly.
  const tierInfo = TIER_BY_SLUG[pending.tier] || TIER_BY_SLUG['clan-ind'];
  if (!TIER_BY_SLUG[pending.tier]) {
    console.error(`pending gift ${pending.id} has unknown tier '${pending.tier}'; falling back to clan-ind`);
  }

  // ── 4. CREATE THE MEMBER ROW ──────────────────────────────────────
  // Same shape as the original direct-insert that send-founder-gift
  // used to do, just deferred until now. comped_by_chief=TRUE remains
  // the dashboard's signal to render the 'Founding Member by warrant
  // of the Chief' line. The metadata block now also captures the
  // pending_gift_id for traceability.
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
      // Public Register opt-in by default (2026-04-30): when the
      // recipient claims, they are added to the public Register
      // automatically. The members area tickbox is pre-ticked
      // (members/index.html line ~769) so this matches the UI: the
      // member sees their name on the Register, and can untick at
      // any time to opt out.
      //
      // Note on tier filtering: the Register page only DISPLAYS
      // Guardian / Steward / Life tiers (REGISTER_TIERS in
      // register.js). A Clan-tier member with public_register_visible
      // = true is still NOT shown publicly. This is by design and
      // unchanged. The flag here keeps the data consistent for if
      // they upgrade tier later; their consent is already on file.
      //
      // Schema default for this column is also true (migration 012),
      // but we set it explicitly here so future schema-default
      // changes don't silently flip the behaviour.
      public_register_visible:    true,
      public_register_opted_in_at: now.toISOString(),
      // Children visibility — for tier_family, default also true
      // so the family certificate name (Antoin & Sinead) appears
      // on the Register entry. Member can opt out children
      // separately (the children tickbox in the members area is
      // independent of the parent visibility).
      children_visible_on_register: !!pending.tier_family,
      metadata: {
        gift:                 true,
        comped_by_chief:      true,
        pending_gift_id:      pending.id,
        claimed_via:          'founder_welcome_page',
      },
    })
    .select('id, email, name, tier, tier_label, joined_at')
    .single();

  if (insertRes.error) {
    console.error('claim founder gift member insert failed:', insertRes.error.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: 'Could not create member row',
        detail: insertRes.error.message,
      }),
    };
  }

  const member = insertRes.data;

  // ── 5. LINK PENDING ROW → CLAIMED ─────────────────────────────────
  // Update is best-effort but expected to succeed. If it fails for
  // some reason (race, network), the member row is created and the
  // pending row's status is wrong — but the dashboard / register
  // works off the member row, not the pending row, so this is a
  // soft inconsistency for the admin panel only.
  const updateRes = await supa()
    .from('pending_founder_gifts')
    .update({
      status:     'claimed',
      member_id:  member.id,
      claimed_at: now.toISOString(),
    })
    .eq('id', pending.id);

  if (updateRes.error) {
    console.error(`pending ${pending.id} status update failed:`, updateRes.error.message);
    // Don't fail the request — the member exists. Admin panel will
    // show the gift as still 'pending' until manually corrected,
    // but the recipient is fully a member.
  }

  // ── 6. ENSURE AUTH USER ───────────────────────────────────────────
  // Pre-create the Supabase auth user so the magic-link login works
  // out of the box on the next step. ensureAuthUser is idempotent
  // and best-effort — failure here doesn't fail the request, the
  // recipient just gets a confirm-signup link instead of magic-link
  // on first login (still works, slightly less smooth).
  try {
    await ensureAuthUser(pending.recipient_email, pending.recipient_name);
  } catch (e) {
    console.warn(`ensureAuthUser failed for ${pending.recipient_email} (non-fatal):`, e.message);
  }

  // ── 7. EVENT LOG ──────────────────────────────────────────────────
  try {
    await logEvent({
      clan_id:    cid,
      member_id:  member.id,
      event_type: 'founder_gift_claimed',
      payload: {
        pending_gift_id:  pending.id,
        recipient_email:  pending.recipient_email,
        tier:             pending.tier,
        days_to_claim:    Math.round((now.getTime() - new Date(pending.created_at).getTime()) / (24 * 60 * 60 * 1000)),
      },
    });
  } catch (e) {
    console.warn('founder_gift_claimed event log failed (non-fatal):', e.message);
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
