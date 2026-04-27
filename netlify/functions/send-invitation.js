// netlify/functions/send-invitation.js
//
// POST endpoint for the invite-a-friend feature. Authenticated
// member sends an invitation to a recipient (name + email +
// optional one-line personal note). Spam guards run BEFORE the
// invitation row is created or the email fires.
//
// AUTH: Bearer JWT, verified via supa().auth.getUser. Member must
// exist in the members table for this clan (resolved by email).
//
// RATE LIMIT: a member can send N invitations per H hours.
// Currently: 5 per hour, 20 per 24 hours. Soft limits, returned
// as 429 with the next-allowed time so the UI can show 'try again
// at HH:MM'.
//
// DEDUP: a member cannot invite the same recipient email twice
// within 30 days. Returns 409 with detail so the UI can show
// 'you already invited X on date Y'.
//
// UNSUBSCRIBE: any email present in invitation_unsubscribes is
// blocked from receiving any further invitations from anyone.
// Returns 403 with a friendly message.
//
// SELF-INVITE: refused. Member can't invite their own email
// (silly, would be confusing).
//
// EXISTING MEMBER: if the recipient email is already a member of
// this clan, refuse with 409 — no point inviting an existing
// member; would be confusing to receive.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { sendInvitation } = require('./lib/invitation-email');
const crypto = require('crypto');

const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';
const UNSUB_SECRET = process.env.UNSUB_SECRET || process.env.STRIPE_WEBHOOK_SECRET || 'fallback-secret-change-me';

// Rate-limit windows. Tuned conservatively for a small clan; can
// be loosened if usage shows it should be.
const RATE_PER_HOUR = 5;
const RATE_PER_DAY = 20;

// Dedup window — same recipient can't be re-invited by the same
// inviter within this many days.
const DEDUP_DAYS = 30;

function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}
function looksLikeEmail(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
}

// HMAC-sign an invitation id for the unsubscribe URL. Recipients
// should be able to unsub without authentication, so the link
// itself carries the proof — token = HMAC(invitationId, secret).
function signUnsubToken(invitationId) {
  return crypto.createHmac('sha256', UNSUB_SECRET).update(invitationId).digest('hex').slice(0, 32);
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const inviterEmail = (authData.user.email || '').toLowerCase().trim();

  // Parse body
  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }
  const recipientName = String(body.name || '').trim();
  const recipientEmail = normalizeEmail(body.email);
  const personalNote = String(body.personal_note || '').trim().slice(0, 200);

  if (!recipientName) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Recipient name is required', field: 'name' }) };
  }
  if (!recipientEmail || !looksLikeEmail(recipientEmail)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Recipient email looks invalid', field: 'email' }) };
  }

  let cid;
  try {
    cid = await clanId();
  } catch (e) {
    console.error('clanId failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: 'Internal: clan lookup failed' }) };
  }

  // ── Resolve the inviting member ─────────────────────────────────
  const { data: inviter, error: inviterErr } = await supa()
    .from('members')
    .select('id, email, name, status')
    .eq('clan_id', cid)
    .ilike('email', inviterEmail)
    .maybeSingle();

  if (inviterErr || !inviter) {
    console.error('inviter lookup failed:', inviterErr?.message);
    return { statusCode: 403, body: JSON.stringify({ error: 'You must be a clan member to send invitations' }) };
  }

  // Inactive members can't invite. Lapsed accounts shouldn't be a
  // megaphone for the clan; they need to renew first.
  if (inviter.status !== 'active') {
    return { statusCode: 403, body: JSON.stringify({ error: 'Your membership must be active to send invitations' }) };
  }

  // ── Self-invite refusal ─────────────────────────────────────────
  if (recipientEmail === inviterEmail.toLowerCase()) {
    return { statusCode: 400, body: JSON.stringify({ error: "You can't invite yourself", field: 'email' }) };
  }

  // ── Recipient is already a member ───────────────────────────────
  const { data: existingMember } = await supa()
    .from('members')
    .select('id, status')
    .eq('clan_id', cid)
    .ilike('email', recipientEmail)
    .maybeSingle();
  if (existingMember) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: 'This person is already on the clan rolls — no need to invite them.',
        reason: 'already_member',
      }),
    };
  }

  // ── Unsubscribed? ───────────────────────────────────────────────
  const { data: unsubRow } = await supa()
    .from('invitation_unsubscribes')
    .select('email')
    .eq('email', recipientEmail)
    .maybeSingle();
  if (unsubRow) {
    // Don't reveal that they specifically unsubbed — could be
    // identity-disclosing. Just say we can't send right now.
    return {
      statusCode: 403,
      body: JSON.stringify({
        error: 'We are unable to send to that address. They may have opted out of clan communications.',
        reason: 'unsubscribed',
      }),
    };
  }

  // ── Rate limit ──────────────────────────────────────────────────
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [hourRes, dayRes] = await Promise.all([
    supa().from('invitations')
      .select('id', { count: 'exact', head: true })
      .eq('inviter_member_id', inviter.id)
      .gte('sent_at', oneHourAgo),
    supa().from('invitations')
      .select('id', { count: 'exact', head: true })
      .eq('inviter_member_id', inviter.id)
      .gte('sent_at', oneDayAgo),
  ]);

  const hourCount = hourRes.count || 0;
  const dayCount = dayRes.count || 0;
  if (hourCount >= RATE_PER_HOUR) {
    return {
      statusCode: 429,
      body: JSON.stringify({
        error: `You've sent ${hourCount} invitations in the last hour — please pause before sending more.`,
        reason: 'rate_limit_hour',
        limit: RATE_PER_HOUR,
        retry_after_minutes: 60,
      }),
    };
  }
  if (dayCount >= RATE_PER_DAY) {
    return {
      statusCode: 429,
      body: JSON.stringify({
        error: `You've sent ${dayCount} invitations today — please come back tomorrow.`,
        reason: 'rate_limit_day',
        limit: RATE_PER_DAY,
        retry_after_minutes: 60 * 24,
      }),
    };
  }

  // ── Dedup: did this inviter already invite this recipient? ──────
  const dedupCutoff = new Date(Date.now() - DEDUP_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data: priorInvite } = await supa()
    .from('invitations')
    .select('id, sent_at, status')
    .eq('inviter_member_id', inviter.id)
    .ilike('recipient_email', recipientEmail)
    .gte('sent_at', dedupCutoff)
    .order('sent_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (priorInvite) {
    return {
      statusCode: 409,
      body: JSON.stringify({
        error: `You already invited ${recipientEmail} on ${new Date(priorInvite.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}. Wait at least ${DEDUP_DAYS} days before re-inviting the same address.`,
        reason: 'recently_invited',
        prior_sent_at: priorInvite.sent_at,
      }),
    };
  }

  // ── Insert the invitation row ───────────────────────────────────
  const { data: invitation, error: insertErr } = await supa()
    .from('invitations')
    .insert({
      clan_id: cid,
      inviter_member_id: inviter.id,
      recipient_email: recipientEmail,
      recipient_name: recipientName,
      personal_note: personalNote || null,
      status: 'sent',
    })
    .select('id, sent_at')
    .single();

  if (insertErr) {
    console.error('invitation insert failed:', insertErr.message, insertErr.code, insertErr.details);
    // Surface a more diagnostic error so the operator can tell the
    // difference between 'table missing (run migration 014)',
    // 'permission denied', and other DB-level failures. The
    // friendly message is still safe to show users; the detail
    // helps when reading server logs or testing.
    const friendlyMessage = insertErr.code === '42P01'
      ? 'The invitations table is not yet set up. Please contact clan@ocomain.org to enable invitations.'
      : 'Could not record the invitation';
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: friendlyMessage,
        debug_code: insertErr.code || null,
      }),
    };
  }

  // ── Build unsubscribe URL ───────────────────────────────────────
  const unsubToken = signUnsubToken(invitation.id);
  const unsubscribeUrl = `${SITE_URL}/.netlify/functions/invitation-unsubscribe?id=${encodeURIComponent(invitation.id)}&t=${encodeURIComponent(unsubToken)}`;

  // ── Send the email ──────────────────────────────────────────────
  const inviterFirst = (inviter.name || inviterEmail).trim().split(/\s+/)[0] || 'a member';
  let emailSent = false;
  try {
    emailSent = await sendInvitation({
      recipientEmail,
      recipientName,
      inviterName: inviter.name || inviterEmail,
      inviterFirstName: inviterFirst,
      personalNote,
      invitationId: invitation.id,
      unsubscribeUrl,
    });
  } catch (e) {
    console.error('invitation email send threw:', e.message);
  }

  // Log event (best-effort)
  try {
    await logEvent({
      clan_id: cid,
      member_id: inviter.id,
      event_type: 'invitation_sent',
      payload: {
        invitation_id: invitation.id,
        recipient_email_domain: recipientEmail.split('@')[1] || null,
        had_personal_note: !!personalNote,
        email_delivered: emailSent,
      },
    });
  } catch (e) {
    console.warn('invitation_sent log failed (non-fatal):', e.message);
  }

  if (!emailSent) {
    return {
      statusCode: 207,
      body: JSON.stringify({
        ok: true,
        invitation_id: invitation.id,
        email_sent: false,
        warning: 'Invitation recorded but the email failed to send. Try again later or contact clan@ocomain.org.',
      }),
    };
  }

  return {
    statusCode: 201,
    body: JSON.stringify({
      ok: true,
      invitation_id: invitation.id,
      sent_at: invitation.sent_at,
      remaining_today: RATE_PER_DAY - dayCount - 1,
    }),
  };
};
