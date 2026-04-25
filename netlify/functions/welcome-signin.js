// netlify/functions/welcome-signin.js
//
// One-click auto-login from the welcome page → Members' Area, using the
// Stripe session_id in the URL as proof of identity.
//
// SECURITY MODEL:
// The session_id is in the URL because Stripe placed it there at redirect.
// Anyone with the URL could use it within Stripe's session validity window.
// We therefore verify session_id with Stripe (proves it's a real, recent
// payment session), read the buyer's email from session.customer_details,
// and mint a Supabase magic-link URL for that email — single-use, expires
// in Supabase's configured window (24h on this account).
//
// This is intentionally NOT used by the welcome email button (which keeps
// magic-link-prompt) because email forwarding makes the URL leakage risk
// too high. The welcome page is "we just saw them pay 30 seconds ago" —
// fresher signal, narrower risk window.
//
// Flow:
//   1. Welcome page button hits /api/welcome-signin?session_id=cs_live_...
//   2. We verify session_id with Stripe → get buyer email
//   3. We call Supabase auth.admin.generateLink({ type: 'magiclink', email })
//   4. We 302-redirect to the URL Supabase returned — browser processes
//      the magic-link token in the URL fragment automatically
//   5. User lands at /members/ logged in
//
// If anything fails (session_id missing/invalid, Stripe down, Supabase
// admin API unavailable), we fall back to /members/login.html with a
// flash message — user can still get in via the email-prompt path.

const { supa } = require('./lib/supabase');

exports.handler = async (event) => {
  const sessionId = event.queryStringParameters?.session_id;

  // ── Validate session_id presence ─────────────────────────────────
  if (!sessionId || typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) {
    // Likely a direct hit on the endpoint without a Stripe context.
    // Fall back to standard sign-in.
    return redirectTo('/members/login.html');
  }

  try {
    // ── Verify with Stripe and get buyer email ───────────────────────
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeKey) {
      console.error('welcome-signin: STRIPE_SECRET_KEY missing');
      return redirectTo('/members/login.html?signin=fallback');
    }

    const sessionResp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!sessionResp.ok) {
      console.error(`welcome-signin: Stripe session lookup failed (${sessionResp.status})`);
      return redirectTo('/members/login.html?signin=fallback');
    }
    const session = await sessionResp.json();
    const email = (session?.customer_details?.email || session?.customer_email || '').toLowerCase().trim();
    if (!email) {
      console.error('welcome-signin: no buyer email on Stripe session');
      return redirectTo('/members/login.html?signin=fallback');
    }

    // Sanity check: session must have actually been paid (defensive — Stripe
    // should not redirect on incomplete sessions, but verify anyway).
    if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') {
      console.error(`welcome-signin: session payment_status=${session.payment_status} — refusing auto-login`);
      return redirectTo('/members/login.html?signin=fallback');
    }

    // ── Generate magic-link URL for this email ───────────────────────
    // generateLink with type='magiclink' returns a properties.action_link URL
    // containing tokens Supabase will accept as authentication. We redirect
    // the browser to that URL — Supabase processes it and lands the user
    // on redirectTo (/members/) authenticated.
    const { data: linkData, error: linkErr } = await supa().auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: {
        redirectTo: 'https://www.ocomain.org/members/',
      },
    });
    if (linkErr || !linkData?.properties?.action_link) {
      console.error('welcome-signin: generateLink failed:', linkErr?.message);
      return redirectTo('/members/login.html?signin=fallback');
    }

    // 302-redirect to the magic-link URL. Supabase processes it,
    // authenticates the session, redirects to /members/.
    return {
      statusCode: 302,
      headers: {
        Location: linkData.properties.action_link,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  } catch (err) {
    console.error('welcome-signin error:', err.message);
    return redirectTo('/members/login.html?signin=fallback');
  }
};

function redirectTo(url) {
  return {
    statusCode: 302,
    headers: { Location: url, 'Cache-Control': 'no-store' },
    body: '',
  };
}
