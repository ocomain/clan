// /members/auth.js — browser-side Supabase auth client.
// Handles magic-link login / session persistence only. Member data is fetched
// from /api/member-info (service-role backend) to keep RLS simple.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.0/+esm';

const SUPABASE_URL  = 'https://nlrlxoplpjamttwbmgtx.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5scmx4b3BscGphbXR0d2JtZ3R4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY3MTE4OTksImV4cCI6MjA5MjI4Nzg5OX0.nwTWV1Ez2EuS5vnczmEk8kU2Mq__0u1-VrRizUnnj9U';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // NOTE: PKCE intentionally NOT used here. PKCE requires the magic link to
    // be opened in the same browser/device that requested it (the verifier
    // lives in sessionStorage of the requesting browser). Implicit flow
    // removes that requirement, so the link can be opened in a DIFFERENT
    // browser from the one that requested it — useful for the common
    // request-on-laptop / read-email-on-phone pattern.
    //
    // IMPORTANT: implicit flow does NOT make magic links re-usable. Supabase
    // enforces server-side single-use token consumption as a separate
    // security layer: the moment a magic link is opened anywhere, the token
    // is burned in Supabase's database and any subsequent click on the same
    // URL gets 'token expired' regardless of device. So 'open on any device'
    // means 'open on ONE device of your choice' — not 'open on multiple
    // devices to share the session'. The login.html copy reflects this.
    //
    // If we need to tighten cross-device behaviour later (e.g. for a payment
    // flow), we can layer PKCE in for those specific routes.
    flowType: 'implicit',
  },
});

export async function sendMagicLink(email, nextUrl) {
  const cleanEmail = email.toLowerCase().trim();
  // The post-magic-link destination defaults to the regular member
  // dashboard. Callers can pass a `nextUrl` (e.g. '/members/admin/...'
  // for admin sign-ins) to land somewhere else after the round-trip.
  // We resolve any relative path against the current origin so a
  // path-only argument like '/members/admin/founders.html' works.
  // Defence-in-depth: only allow same-origin destinations to prevent
  // an open-redirect via a maliciously-crafted ?next= on the login
  // page. Anything that doesn't resolve to the same origin falls back
  // to the dashboard.
  let redirectTo = window.location.origin + '/members/';
  if (nextUrl) {
    try {
      const resolved = new URL(nextUrl, window.location.origin);
      if (resolved.origin === window.location.origin) {
        redirectTo = resolved.toString();
      }
    } catch {
      // malformed URL — keep the safe default
    }
  }
  const { error } = await supabase.auth.signInWithOtp({
    email: cleanEmail,
    options: { emailRedirectTo: redirectTo },
  });
  // Diagnostic log so the requested redirect destination is visible
  // in the browser console. If Supabase silently overrides this value
  // (e.g. because `redirectTo` isn't in the project's Redirect URLs
  // allowlist and Supabase falls back to the Site URL), this log
  // makes the discrepancy obvious. Symptoms of an override: user
  // clicks the magic link in their inbox and lands on a URL different
  // from this logged value — typically the project's Site URL, which
  // could be 'http://localhost:3000' on a freshly-set-up project.
  // Resolution lives in the Supabase Dashboard, not in code:
  //   Authentication → URL Configuration → Site URL + Redirect URLs.
  console.log('[auth] magic link requested with emailRedirectTo:', redirectTo);
  // Cache the email locally so the expired-link recovery flow can offer to
  // send a fresh link without making the member retype it.
  if (!error) {
    try { localStorage.setItem('oc_last_email', cleanEmail); } catch {}
  }
  return { ok: !error, error: error?.message };
}

// Get the last email a magic link was sent to (for recovery flow)
export function getLastEmail() {
  try { return localStorage.getItem('oc_last_email') || ''; } catch { return ''; }
}

export async function currentSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signOut() {
  await supabase.auth.signOut();
  window.location.href = '/members/login.html';
}

// Fetches the member record for the current session via the server-side API.
// Server verifies JWT, looks up member by email, links auth_user_id first time.
// Returns null if no session; { notAMember: true } if session but no member row.
export async function getMemberProfile() {
  const session = await currentSession();
  if (!session) return null;
  const res = await fetch('/api/member-info', {
    headers: { Authorization: `Bearer ${session.access_token}` },
  });
  if (res.status === 404) return { notAMember: true, email: session.user.email };
  if (!res.ok) throw new Error(`member-info ${res.status}`);
  return await res.json();
}
