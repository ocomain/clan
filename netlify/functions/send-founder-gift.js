// netlify/functions/send-founder-gift.js
//
// Backend endpoint for the founder admin tool. POST a recipient
// (name, email, tier slug, optional one-line personal note from
// Fergus); endpoint auth-gates the operator, validates the recipient
// against the existing membership AND any open pending-gift, then
// creates a `pending_founder_gifts` row and fires the founder
// welcome email with a claim_token-bearing URL.
//
// IMPORTANT (changed 2026-04-28): this endpoint NO LONGER creates a
// `members` row. The members row is created when the recipient
// clicks the 'Claim my place' button on the welcome page, which
// hits claim-founder-gift.js. The pending-gift row holds all the
// info needed to materialise the member at claim time.
//
// Why: prevents the recipient from being auto-published to the
// public Register (after the 30-day cert publication window) without
// ever having said yes. Also keeps the founder-gift state visible
// as 'pending' in the admin panel until the recipient acts.
//
// AUTH: Bearer token in Authorization header. Token is verified
// against Supabase auth, and the resulting email is checked against
// the founder-admin allowlist (lib/supabase.js → isFounderAdmin).
// Currently allowlisted: clan@ocomain.org only.
//
// SHAPE OF THE CREATED PENDING ROW:
//   - status='pending', member_id=NULL
//   - claim_token=<uuid> embedded in the welcome-email URL
//   - expires_at=NOW()+1year (Phase 3 cron lapses unclaimed gifts)
//   - tier/tier_label/tier_family captured at submit time, fixed
//
// IDEMPOTENCY: refuses if the email already exists as a member OR
// as an open pending founder-gift. Linda must explicitly resolve
// duplicates outside this tool — by design, this endpoint won't
// quietly re-issue a pending gift to the same recipient. Lapsed
// pending gifts (1 year+ unclaimed) DO allow a fresh send, since
// at that point the original is dead and a new offer is meaningful.

const {
  supa,
  clanId,
  logEvent,
  isFounderAdmin,
  TIER_BY_SLUG,
} = require('./lib/supabase');
const { sendFounderWelcome } = require('./lib/founder-email');

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

  // Also check for an open pending founder gift to the same address.
  // We refuse to send a second pending gift while the first is still
  // open — Fergus would be sending the recipient two welcome emails
  // with two claim URLs, both of which would race when the recipient
  // clicked. Lapsed pending gifts (>1 year unclaimed) are excluded
  // here so a re-offer after the original lapses is allowed; that's
  // a meaningful new act, not a duplicate.
  const { data: existingPending, error: pendingLookupErr } = await supa()
    .from('pending_founder_gifts')
    .select('id, created_at, status')
    .eq('clan_id', cid)
    .ilike('recipient_email', recipientEmail)
    .eq('status', 'pending')
    .maybeSingle();

  if (pendingLookupErr) {
    console.error('founder gift pending lookup failed:', pendingLookupErr.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal: pending lookup failed' }),
    };
  }
  if (existingPending) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'A founder gift to this email is already pending',
        existing_pending: {
          created_at: existingPending.created_at,
          status: existingPending.status,
        },
      }),
    };
  }

  // ── 4. CREATE THE PENDING GIFT ROW ────────────────────────────────
  // Replaces the previous direct-member-insert. The actual `members`
  // row is created when the recipient clicks 'Claim my place' on
  // the welcome page (claim-founder-gift.js). claim_token, status,
  // and expires_at use the Postgres defaults from migration 017.
  const insertRes = await supa()
    .from('pending_founder_gifts')
    .insert({
      clan_id:         cid,
      recipient_email: recipientEmail,
      recipient_name:  recipientName,
      tier:            tierInfo.tier,
      tier_label:      tierInfo.label,
      tier_family:     tierInfo.tier_family,
      personal_note:   personalNote || null,
      // status, claim_token, created_at, expires_at all default in DB.
    })
    .select('id, claim_token, recipient_email, recipient_name, tier, tier_label, created_at, expires_at')
    .single();

  if (insertRes.error) {
    console.error('founder gift pending insert failed:', insertRes.error.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Could not create pending gift row',
        detail: insertRes.error.message,
      }),
    };
  }

  const pending = insertRes.data;

  // Log the event (best-effort — failure here doesn't fail the request).
  // member_id is NULL on the event because no member exists yet —
  // logEvent accepts a null member_id for events that aren't tied to
  // a particular member (or in this case, a member-to-be).
  try {
    await logEvent({
      clan_id: cid,
      member_id: null,
      event_type: 'founder_gift_pending_created',
      payload: {
        pending_gift_id:  pending.id,
        recipient_email:  recipientEmail,
        tier:             tierInfo.tier,
        operator_email:   operatorEmail,
        had_personal_note: !!personalNote,
      },
    });
  } catch (e) {
    console.warn('founder_gift_pending_created event log failed (non-fatal):', e.message);
  }

  // ── 5. SEND THE WELCOME EMAIL ─────────────────────────────────────
  // The email is the centrepiece of this whole tool. The claim_token
  // is passed so the email's CTA URL can carry it (recipient clicks
  // → /founder-welcome.html?token=X → page reads token, looks it up,
  // shows claim button). If sending fails, we still return success
  // on the pending row but flag the failure so the admin form can
  // offer 'Resend email' or, if the operator decides the pending is
  // unrecoverable, they can delete the row and re-submit.
  let emailSent = false;
  try {
    emailSent = await sendFounderWelcome({
      to: recipientEmail,
      recipientName,
      personalNote,
      claimToken: pending.claim_token,
    });
  } catch (e) {
    console.error('founder welcome email send threw:', e.message);
  }

  if (!emailSent) {
    // Pending row IS created, just email failed. Return 207 Multi-Status
    // (sort of — closest semantic match) with both bits of info so the
    // admin form can show 'Pending gift created, but email failed —
    // retry?'. Fergus can either delete the pending row and re-send,
    // or the admin form could surface a one-shot 'resend' button.
    return {
      statusCode: 207,
      body: JSON.stringify({
        ok: true,
        pending: {
          id:               pending.id,
          recipient_email:  pending.recipient_email,
          recipient_name:   pending.recipient_name,
          tier:             pending.tier,
          tier_label:       pending.tier_label,
          created_at:       pending.created_at,
          expires_at:       pending.expires_at,
        },
        email_sent: false,
        warning: 'Pending gift created but welcome email failed to send. Check Resend logs and retry.',
      }),
    };
  }

  // ── 6. SUCCESS ────────────────────────────────────────────────────
  return {
    statusCode: 201,
    body: JSON.stringify({
      ok: true,
      pending: {
        id:               pending.id,
        recipient_email:  pending.recipient_email,
        recipient_name:   pending.recipient_name,
        tier:             pending.tier,
        tier_label:       pending.tier_label,
        created_at:       pending.created_at,
        expires_at:       pending.expires_at,
      },
      email_sent: true,
    }),
  };
};
