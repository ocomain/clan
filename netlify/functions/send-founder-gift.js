// netlify/functions/send-founder-gift.js
//
// Backend endpoint for the founder admin tool. POST a recipient
// (name, email, tier slug, optional one-line personal note from
// Fergus); endpoint auth-gates the operator, validates the recipient
// against the existing membership table, creates a `members` row
// directly (no Stripe — this is a comped membership), then fires the
// founder welcome email.
//
// AUTH: Bearer token in Authorization header. Token is verified
// against Supabase auth, and the resulting email is checked against
// the founder-admin allowlist (lib/supabase.js → isFounderAdmin).
// Currently allowlisted: clan@ocomain.org only.
//
// SHAPE OF THE CREATED MEMBER ROW: mirrors the gift-activation path
// in stripe-webhook.js (see lines 210-235 there) with three small
// differences specific to founder gifts:
//
//   1. metadata.gift = true, metadata.comped_by_chief = true
//      (so analytics distinguishes founder-gifts from paid gifts and
//      from regular paid memberships)
//   2. comped_by_chief, comped_at, comped_note columns set
//      (added in migration 013, used to render the 'Founding Member
//      by warrant of the Chief' italic line on the dashboard)
//   3. stripe_customer_id and stripe_subscription_id stay null
//      (no Stripe involvement — Fergus is paying out of pocket /
//      treating these as the clan's gift)
//
// The expires_at is set to 1 year from now, matching the duration
// of paid annual memberships. Renewal at year-end will need to be
// considered separately — likely a "your founding gift expires in
// 30 days, renew at clan tier" email, but that's a separate concern.
//
// IDEMPOTENCY: refuses if the email already exists as ANY member
// (active, expired, founder-comped, or paid). Linda must explicitly
// resolve duplicates outside this tool — by design, this endpoint
// won't quietly upgrade an existing row to founder status. The
// founder-admin tool is for NEW recipients only.

const {
  supa,
  clanId,
  logEvent,
  isFounderAdmin,
  TIER_BY_SLUG,
} = require('./lib/supabase');
const { sendFounderWelcome } = require('./lib/founder-email');

// One year in ms — used to compute expires_at for the founder
// membership. Mirrors annual paid memberships exactly.
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

// Light validation — trim, lowercase, basic shape. Doesn't try to
// validate deliverability (Resend will tell us if the address bounces).
function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}
function looksLikeEmail(s) {
  // Loose RFC-ish check — must have @, must have a dot in the
  // domain, no whitespace. Catches typos but isn't strict.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

exports.handler = async (event) => {
  // Only POST. Anything else → 405.
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  // ── 1. AUTH: verify Bearer token + admin allowlist ────────────────
  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Missing Authorization header' }),
    };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return {
      statusCode: 401,
      body: JSON.stringify({ error: 'Invalid or expired token' }),
    };
  }

  const operatorEmail = (authData.user.email || '').toLowerCase().trim();
  if (!isFounderAdmin(operatorEmail)) {
    // Don't reveal that the allowlist exists or what's on it —
    // generic 403 is enough. Anyone reaching this point has a
    // valid auth token, just not the right email.
    return {
      statusCode: 403,
      body: JSON.stringify({ error: 'Not permitted' }),
    };
  }

  // ── 2. PARSE BODY ─────────────────────────────────────────────────
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Invalid JSON body' }),
    };
  }

  // Required fields
  const recipientName = String(body.name || '').trim();
  const recipientEmail = normalizeEmail(body.email);
  const tierSlug = String(body.tier || '').trim();

  // Optional: one-line note from Fergus that prepends the email body.
  // Truncated to 200 chars defensively — if Fergus accidentally pastes
  // a paragraph, we'd prefer to clip than to send a wall of text.
  const personalNote = String(body.personal_note || '').trim().slice(0, 200);

  // Field validation — return specific errors so the admin form can
  // surface them next to the right input field.
  if (!recipientName) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Recipient name is required', field: 'name' }),
    };
  }
  if (!recipientEmail || !looksLikeEmail(recipientEmail)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Recipient email is required and must be valid', field: 'email' }),
    };
  }
  // Tier must be one of the canonical 8 slugs from TIER_BY_SLUG.
  // Anything else → reject with the available list (helps debugging
  // a malformed admin form, shouldn't happen in normal flow).
  const tierInfo = TIER_BY_SLUG[tierSlug];
  if (!tierInfo) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'Invalid tier',
        field: 'tier',
        valid_tiers: Object.keys(TIER_BY_SLUG),
      }),
    };
  }

  // ── 3. UNIQUENESS CHECK ───────────────────────────────────────────
  // Refuse if the email already exists as ANY member, regardless of
  // status. This prevents:
  //   - Accidentally double-gifting a recipient (Fergus runs the form
  //     twice for the same person)
  //   - Gifting to someone who's already paid (would create a duplicate
  //     row, breaking the email-uniqueness constraint anyway)
  //   - Gifting to a previously-comped recipient (a founder reactivating
  //     would re-send the welcome email — confusing for the recipient)
  //
  // The error response includes the existing member's status so the
  // admin form can show 'this person is already a member, joined
  // [date], status [active/lapsed/comped]' for context.
  let cid;
  try {
    cid = await clanId();
  } catch (e) {
    console.error('clanId failed:', e.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal: clan lookup failed' }),
    };
  }

  const { data: existing, error: lookupErr } = await supa()
    .from('members')
    .select('id, status, joined_at, comped_by_chief')
    .eq('clan_id', cid)
    .ilike('email', recipientEmail)  // case-insensitive
    .maybeSingle();

  if (lookupErr) {
    console.error('founder gift uniqueness check failed:', lookupErr.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal: lookup failed' }),
    };
  }
  if (existing) {
    return {
      statusCode: 409,  // Conflict
      body: JSON.stringify({
        error: 'This email is already on the clan rolls',
        existing: {
          status: existing.status,
          joined_at: existing.joined_at,
          comped_by_chief: !!existing.comped_by_chief,
        },
      }),
    };
  }

  // ── 4. CREATE THE MEMBER ROW ──────────────────────────────────────
  // Mirrors the gift-activation path in stripe-webhook.js. Three
  // founder-specific differences: metadata.comped_by_chief, the
  // comped_* columns from migration 013, and no Stripe linkage.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ONE_YEAR_MS);

  const insertRes = await supa()
    .from('members')
    .insert({
      clan_id:                cid,
      email:                  recipientEmail,
      name:                   recipientName,
      tier:                   tierInfo.tier,
      tier_label:             tierInfo.label,
      tier_family:            tierInfo.tier_family,
      // No Stripe — this is a comped membership.
      stripe_customer_id:     null,
      stripe_subscription_id: null,
      status:                 'active',
      joined_at:              now.toISOString(),
      renewed_at:             now.toISOString(),
      expires_at:             expiresAt.toISOString(),
      // Migration 013 columns. comped_by_chief is what the dashboard
      // checks to render 'Founding Member by warrant of the Chief'.
      comped_by_chief:        true,
      comped_at:              now.toISOString(),
      comped_note:            personalNote || null,
      // Metadata mirrors gift entries for consistency in analytics.
      metadata: {
        gift: true,
        comped_by_chief: true,
        gifted_by_operator: operatorEmail,
      },
    })
    .select('id, email, name, tier, tier_label, joined_at')
    .single();

  if (insertRes.error) {
    console.error('founder gift insert failed:', insertRes.error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Could not create member row',
        detail: insertRes.error.message,
      }),
    };
  }

  const member = insertRes.data;

  // Log the event (best-effort — failure here doesn't fail the request).
  try {
    await logEvent({
      clan_id: cid,
      member_id: member.id,
      event_type: 'founder_gift_sent',
      payload: {
        recipient_email: recipientEmail,
        tier: tierInfo.tier,
        operator_email: operatorEmail,
        had_personal_note: !!personalNote,
      },
    });
  } catch (e) {
    console.warn('founder_gift_sent event log failed (non-fatal):', e.message);
  }

  // ── 5. SEND THE WELCOME EMAIL ─────────────────────────────────────
  // The email is the centrepiece of this whole tool. If sending fails,
  // we still return success on the row creation but flag the email
  // failure so the admin form can offer a 'Resend email' affordance.
  // The member row is real either way — recipient is in the clan;
  // they just may not have heard about it yet.
  let emailSent = false;
  try {
    emailSent = await sendFounderWelcome({
      to: recipientEmail,
      recipientName,
      personalNote,
    });
  } catch (e) {
    console.error('founder welcome email send threw:', e.message);
  }

  if (!emailSent) {
    // Member row IS created, just email failed. Return 207 Multi-Status
    // (sort of — closest semantic match) with both bits of info so the
    // admin form can show 'Member created, but email failed — retry?'
    return {
      statusCode: 207,
      body: JSON.stringify({
        ok: true,
        member: {
          id: member.id,
          email: member.email,
          name: member.name,
          tier: member.tier,
          tier_label: member.tier_label,
          joined_at: member.joined_at,
        },
        email_sent: false,
        warning: 'Member created but welcome email failed to send. Check Resend logs and retry.',
      }),
    };
  }

  // ── 6. SUCCESS ────────────────────────────────────────────────────
  return {
    statusCode: 201,
    body: JSON.stringify({
      ok: true,
      member: {
        id: member.id,
        email: member.email,
        name: member.name,
        tier: member.tier,
        tier_label: member.tier_label,
        joined_at: member.joined_at,
      },
      email_sent: true,
    }),
  };
};
