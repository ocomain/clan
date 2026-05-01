// netlify/functions/signin.js
//
// GET /api/signin?token=<uuid>
//
// Generic one-click sign-in endpoint. Consumes a row from
// sign_in_tokens, generates a fresh Supabase magic-link via
// admin API, 302-redirects the browser there. Lands the
// recipient signed in to /members/.
//
// Used by any email button labelled with a sign-in CTA (post-
// purchase welcome, cert reminders, gift-recipient email,
// abandoned-cart reminder for existing members, etc).
//
// Token issuance: see lib/signin-token.js. Callers compose the
// URL once (when sending the email) by calling
// issueSignInToken() / buildSignInUrl() and embedding the
// result in the email button href.
//
// FAILURE PATHS (every failure → graceful fallback to email-
// prefilled login form, never a bare 500 to the recipient):
//
//   - Token missing/malformed   → /members/login.html?signin=fallback
//   - Token not found in DB     → /members/login.html?signin=invalid
//   - Token expired             → /members/login.html?email=<>&expired=1
//   - Token already used        → /members/login.html?email=<>&claimed=1
//                                 (uses 'claimed=1' verbiage which
//                                  the login page already handles
//                                  with friendly 'your place is
//                                  confirmed, request a sign-in
//                                  link' messaging)
//   - Member not found          → /members/login.html?signin=fallback
//   - generateLink failed       → /members/login.html?email=<>&claimed=1

const { supa } = require('./lib/supabase');

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
  const userAgent = (event.headers && (event.headers['user-agent'] || event.headers['User-Agent'])) || null;

  if (!token || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    console.error('[signin] missing/invalid token format');
    return redirectTo('/members/login.html?signin=fallback');
  }

  // ── 1. LOOK UP THE TOKEN + MEMBER ──────────────────────────────────
  // Joined select — single round-trip rather than two queries.
  const { data, error } = await supa()
    .from('sign_in_tokens')
    .select('token, member_id, purpose, expires_at, used_at, members(id, email, name)')
    .eq('token', token)
    .maybeSingle();

  if (error) {
    console.error('[signin] lookup failed:', error.message);
    return redirectTo('/members/login.html?signin=fallback');
  }
  if (!data) {
    console.warn('[signin] no sign_in_tokens row for token');
    return redirectTo('/members/login.html?signin=invalid');
  }

  const member = data.members;
  if (!member || !member.email) {
    console.error(`[signin] token ${token} has no associated member (member_id=${data.member_id})`);
    return redirectTo('/members/login.html?signin=fallback');
  }

  const recipientEmail = member.email;

  // ── 2. EXPIRED ─────────────────────────────────────────────────────
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) {
    console.log(`[signin] token ${token} expired at ${data.expires_at} for ${recipientEmail}`);
    return redirectTo(`/members/login.html?email=${encodeURIComponent(recipientEmail)}&expired=1`);
  }

  // ── 3. ALREADY USED ────────────────────────────────────────────────
  // Single-use guard. Second click (or forwarded email opened by
  // someone else) gets the friendly fallback. Magic-link by email
  // is the recovery path — that link goes only to the recipient's
  // actual inbox.
  if (data.used_at) {
    console.log(`[signin] token ${token} already used at ${data.used_at} — falling back to magic-link flow`);
    return redirectTo(`/members/login.html?email=${encodeURIComponent(recipientEmail)}&claimed=1`);
  }

  // ── 4. MARK USED (race-safe) ───────────────────────────────────────
  // We update WHERE used_at IS NULL so concurrent clicks (rare but
  // possible if a mail-scanner pre-fetched the URL) result in only
  // one of the requests winning. The losing request gets affected=0
  // and routes to the already-used path on the next call.
  //
  // Note: Supabase UPDATE doesn't return affected-row count
  // directly. We use .select() to get the row back; if it's NULL,
  // the WHERE didn't match (race lost).
  const updRes = await supa()
    .from('sign_in_tokens')
    .update({ used_at: new Date().toISOString(), used_user_agent: userAgent })
    .eq('token', token)
    .is('used_at', null)
    .select('token')
    .maybeSingle();

  if (!updRes.data) {
    // Race lost — another click consumed the token between our
    // SELECT and our UPDATE. Treat as already-used.
    console.log(`[signin] token ${token} race lost — already consumed`);
    return redirectTo(`/members/login.html?email=${encodeURIComponent(recipientEmail)}&claimed=1`);
  }

  // ── 5. GENERATE MAGIC LINK + 302 REDIRECT ──────────────────────────
  // Same pattern as claim-and-enter-* endpoints. Admin generateLink
  // returns an action_link URL with auth tokens; redirect there
  // and Supabase processes it server-side, lands the recipient on
  // /members/ authenticated.
  const { data: linkData, error: linkErr } = await supa().auth.admin.generateLink({
    type: 'magiclink',
    email: recipientEmail,
    options: {
      redirectTo: `${SITE_URL}/members/`,
    },
  });

  if (linkErr || !linkData?.properties?.action_link) {
    console.error('[signin] generateLink failed:', linkErr?.message);
    // We've already burned the token (used_at set). Redirect to
    // login form with claimed=1 so the user gets a friendly message
    // and can request a fresh magic link manually.
    return redirectTo(`/members/login.html?email=${encodeURIComponent(recipientEmail)}&claimed=1`);
  }

  console.log(`[signin] one-click success for ${recipientEmail} (purpose=${data.purpose})`);
  return redirectTo(linkData.properties.action_link);
};
