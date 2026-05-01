// netlify/functions/lib/signin-token.js
//
// Helper for issuing one-click sign-in tokens. Used by any email-
// sending function that wants to embed a "click here to sign in"
// URL in the email body.
//
// Pattern:
//   const url = await issueSignInToken({
//     memberId: member.id,
//     purpose:  'cert_reminder',
//   });
//   // url is now https://www.ocomain.org/api/signin?token=<uuid>
//   // Embed in email button href.
//
// The /api/signin endpoint (signin.js) consumes the token,
// generates a fresh Supabase magic-link via admin API, and
// 302-redirects the recipient's browser to the magic-link URL —
// landing them signed in to /members/.
//
// Security model:
//   - Token = UUIDv4 = 122 bits of entropy
//   - Single-use (used_at gate) — forwarded-email hijack mitigation
//   - 30-day TTL — long enough that recipients don't hit "expired"
//     on normal email engagement windows
//   - On any failure path (expired, used, member not found) the
//     endpoint redirects to /members/login.html with email pre-fill
//     so the recipient can still recover via standard magic-link

const { supa } = require('./supabase');

const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

/**
 * Issue a single-use sign-in token for a member, return the URL
 * to embed in an email button.
 *
 * @param {Object} opts
 * @param {string} opts.memberId       - members.id (UUID)
 * @param {string} opts.purpose        - categorical label, e.g.
 *                                       'welcome_self', 'cert_reminder'
 * @param {number} [opts.ttlDays=30]   - override default 30-day TTL
 * @returns {Promise<string|null>}     - URL to embed, or null on failure
 *                                       (caller should fall back to a
 *                                       plain /members/login.html?email= URL)
 */
async function issueSignInToken({ memberId, purpose, ttlDays }) {
  if (!memberId || !purpose) {
    console.error('[signin-token] missing required arg', { memberId: !!memberId, purpose: !!purpose });
    return null;
  }

  // Compute expires_at if a non-default TTL was requested. Default
  // is set by the DB (now() + 30 days) so we omit the field entirely
  // for the common case to keep the INSERT small.
  const overrideExpires = (ttlDays && ttlDays !== 30)
    ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString()
    : undefined;

  const insertPayload = {
    member_id: memberId,
    purpose,
  };
  if (overrideExpires) insertPayload.expires_at = overrideExpires;

  const { data, error } = await supa()
    .from('sign_in_tokens')
    .insert(insertPayload)
    .select('token')
    .single();

  if (error) {
    // Defensive: 'relation does not exist' (42P01) means migration
    // 019 hasn't run yet. Log + return null so the caller falls
    // back to a non-one-click URL.
    const isMissingTable = error.code === '42P01' || /relation .* does not exist/i.test(error.message || '');
    if (isMissingTable) {
      console.warn('[signin-token] sign_in_tokens table missing — run migration 019. Falling back to non-one-click URL.');
    } else {
      console.error('[signin-token] insert failed:', error.message);
    }
    return null;
  }

  return `${SITE_URL}/api/signin?token=${encodeURIComponent(data.token)}`;
}

/**
 * Convenience wrapper that returns either the one-click URL OR a
 * fallback /members/login.html?email=X URL if token issuance fails.
 * Either way, the recipient gets a working button — the difference
 * is whether they sign in with one click or two.
 *
 * Most callers should use this rather than issueSignInToken directly,
 * because it never returns null.
 *
 * @param {Object} opts
 * @param {string} opts.memberId
 * @param {string} opts.email          - for fallback URL pre-fill
 * @param {string} opts.purpose
 * @param {number} [opts.ttlDays]
 * @returns {Promise<string>}
 */
async function buildSignInUrl({ memberId, email, purpose, ttlDays }) {
  const oneClick = await issueSignInToken({ memberId, purpose, ttlDays });
  if (oneClick) return oneClick;
  // Fallback: standard login form, email pre-filled. Recipient
  // requests magic link manually — same as the pre-2026-04-30 UX.
  return `${SITE_URL}/members/login.html?email=${encodeURIComponent(email || '')}`;
}

module.exports = { issueSignInToken, buildSignInUrl };
