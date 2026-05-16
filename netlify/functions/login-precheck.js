// netlify/functions/login-precheck.js
//
// Called by /members/login.html BEFORE invoking Supabase's
// signInWithOtp. Resolves the dead-end where a non-member enters
// their email at the login page and gets nothing — Supabase
// silently swallows the request, leaving the person staring at
// "Check your email" with no email forthcoming and no path to
// becoming a member.
//
// FLOW:
//   1. Browser POSTs { email } here.
//   2. If a members-row exists for that email → return
//      { is_member: true }. Browser then proceeds with the
//      normal signInWithOtp flow (Supabase sends magic link).
//   3. If NO members-row exists → we send a friendly "no clan
//      account for this email" email via Resend with a Join CTA
//      pointing at /membership, then return { is_member: false }.
//      Browser still shows "Check your email" — the page UX is
//      identical from the user's point of view, but they get a
//      different email tailored to their actual situation.
//
// PRIVACY POSTURE:
//   This DOES leak membership status by which email arrives — a
//   discoverable, deliberate change from the previous silent-on-
//   non-member behaviour. Decision made 11 May 2026 in conversation
//   with Fergus: the conversion friction was outweighing the value
//   of the privacy-by-obscurity. The clan brand isn't sensitive
//   enough that "is X a member" needs to be a secret.
//
// SCRAPING DEFENCE:
//   No founder-admin gate (login is public). Rate-limited at the
//   IP level by a soft sliding window in lib/login-precheck-ratelimit
//   — 5 requests per IP per 5 minutes, more than enough for a human
//   typing typos but enough resistance to make bulk enumeration
//   unattractive. If someone really wants to scrape membership they
//   already could by running signInWithOtp repeatedly and observing
//   delivery; we're not creating a new attack vector, just shaving
//   one finger off the cost.
//
// FAILURE MODE:
//   If the Resend send fails for a non-member, we still return
//   is_member: false to the browser. The browser still tells the
//   user to check their email. They check, nothing arrives, they
//   try again — which re-fires this endpoint, which retries the
//   send. Sustainable degradation.

const { supa, clanId, isFounderAdmin } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_CLAN = 'Clan Ó Comáin <clan@ocomain.org>';

// Light in-memory rate limit. Per Netlify-lambda-instance, not
// across instances, so it's a soft floor. For real abuse we'd need
// a shared store — that's overkill for the threat model here.
const recentRequests = new Map(); // ip -> [timestamps]
const WINDOW_MS = 5 * 60 * 1000;
const MAX_PER_WINDOW = 5;

function isRateLimited(ip) {
  const now = Date.now();
  const stamps = (recentRequests.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (stamps.length >= MAX_PER_WINDOW) {
    recentRequests.set(ip, stamps);
    return true;
  }
  stamps.push(now);
  recentRequests.set(ip, stamps);
  return false;
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}

function escapeHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// HTML body for the non-member fallback email. Heritage-styled,
// sent from clan@ (the main mailbox — login-failure fallbacks are
// general correspondence rather than lifecycle Herald comms).
// Soft CTA — invitation, not pressure. Closes with the explicit
// "ignore this if you weren't trying to sign in" line because the
// recipient didn't ask for marketing — they were trying to log in.
function buildNoAccountEmail(recipientEmail) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>No clan account for this email</title>
</head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'EB Garamond',Georgia,serif">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#F8F4EC">
  <tr><td style="padding:48px 24px">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#FFFFFF;border:1px solid rgba(184,151,90,.18)">
      <tr><td style="padding:40px 40px 24px;text-align:center">
        <div style="font-family:'Jost',sans-serif;font-size:11px;font-weight:500;letter-spacing:.22em;text-transform:uppercase;color:#6B1F1F;margin-bottom:18px">From the Office</div>
        <h1 style="font-family:'EB Garamond',Georgia,serif;font-size:28px;font-weight:400;color:#1F1B14;margin:0;line-height:1.3">No clan account <em style="font-style:italic;color:#6B1F1F">for this email</em></h1>
      </td></tr>
      <tr><td style="padding:8px 40px 16px;font-family:'EB Garamond',Georgia,serif;font-size:17px;color:#3C2A1A;line-height:1.75">
        <p style="margin:0 0 18px">You tried to sign in to the Members' Area of Clan Ó Comáin using <strong>${escapeHtml(recipientEmail)}</strong>, but no clan account is held against that address.</p>
        <p style="margin:0 0 18px">A few possibilities:</p>
        <ul style="margin:0 0 24px;padding-left:22px">
          <li style="margin-bottom:8px"><strong>You are already a member, but with a different email.</strong> Try the address on your welcome correspondence from the clan.</li>
          <li style="margin-bottom:8px"><strong>You have not joined yet.</strong> The clan is open to all who love Ireland — bloodline or surname is not required.</li>
        </ul>
      </td></tr>
      <tr><td style="padding:0 40px 28px;text-align:center">
        <a href="https://www.ocomain.org/membership" style="display:inline-block;font-family:'Jost',sans-serif;font-size:12px;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#F4EAD0;background:#6B1F1F;padding:14px 34px;border-radius:1px;text-decoration:none">Join the clan</a>
      </td></tr>
      <tr><td style="padding:0 40px 36px;font-family:'EB Garamond',Georgia,serif;font-size:15px;color:#5A5043;line-height:1.7;font-style:italic;text-align:center">
        <p style="margin:0">If you did not try to sign in just now, you may safely ignore this letter.</p>
      </td></tr>
      <tr><td style="padding:24px 40px;border-top:1px solid rgba(184,151,90,.18);font-family:'EB Garamond',Georgia,serif;font-size:13px;color:#7A7060;line-height:1.6;text-align:center">
        Sent with respect from the Office of Clan Ó Comáin
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

async function sendNoAccountEmail(recipientEmail) {
  if (!RESEND_API_KEY) {
    console.error('[login-precheck] RESEND_API_KEY not set, cannot send no-account email');
    return false;
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: FROM_CLAN,
        to: recipientEmail,
        subject: 'No clan account for this email',
        html: buildNoAccountEmail(recipientEmail),
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      console.error('[login-precheck] Resend send failed:', res.status, errText);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[login-precheck] send threw:', e.message);
    return false;
  }
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // Rate-limit by IP. Netlify's headers vary; x-forwarded-for is the
  // canonical one and is set on every request the edge fronts.
  const ip = (event.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (isRateLimited(ip)) {
    return jsonResponse(429, { error: 'Too many requests — please wait a moment.' });
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  const email = String(body.email || '').toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse(400, { error: 'Missing or invalid email' });
  }

  // FOUNDER-ADMIN GATE — admin accounts (clan@ocomain.org, linda@,
  // etc.) sign in via the same login flow but DO NOT have a row in
  // the members table. Without this short-circuit, an admin trying
  // to log in would be told they have no account and would be sent
  // the "no clan account for this email" fallback letter — which is
  // exactly the bug Fergus reported on 13 May 2026 when clan@ couldn't
  // sign in. Admins always pass through to signInWithOtp.
  if (isFounderAdmin(email)) {
    return jsonResponse(200, { is_member: true });
  }

  const cid = await clanId();
  const { data: member, error: memberErr } = await supa()
    .from('members')
    .select('id')
    .eq('clan_id', cid)
    .ilike('email', email)
    .maybeSingle();

  if (memberErr) {
    // On lookup error, fail OPEN — i.e. tell the browser it's a member.
    // That way the login flow proceeds with signInWithOtp and the user
    // isn't blocked by our intermediate check. Worst case: a real non-
    // member doesn't get the fallback email this time. They can retry,
    // or they may notice the absence of a magic link arriving and try
    // a different path themselves. Safer than blocking sign-in for a
    // real member just because our pre-check hiccupped.
    console.error('[login-precheck] member lookup failed, failing open:', memberErr.message);
    return jsonResponse(200, { is_member: true });
  }

  if (member) {
    return jsonResponse(200, { is_member: true });
  }

  // Non-member: fire the fallback email. We don't await any
  // confirmation; if Resend rejects, we logged it above. Browser
  // still sees "is_member: false" and shows the success state.
  await sendNoAccountEmail(email);
  return jsonResponse(200, { is_member: false });
};
