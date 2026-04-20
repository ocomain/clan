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
    flowType: 'pkce',
  },
});

export async function sendMagicLink(email) {
  const redirectTo = window.location.origin + '/members/';
  const { error } = await supabase.auth.signInWithOtp({
    email: email.toLowerCase().trim(),
    options: { emailRedirectTo: redirectTo },
  });
  return { ok: !error, error: error?.message };
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
