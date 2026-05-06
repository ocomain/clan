// netlify/functions/submit-event-rsvp.js
//
// Member-initiated RSVP for clan events. Replaces the earlier mailto:
// flow on the dashboard event card with a structured form. Same shape
// as submit-obituary, with a few differences:
//
//   - NO tier gate. Events on the dashboard are open to all members
//     unless explicitly gated. The current event (Feast of St John,
//     23 June 2026) is open to every member regardless of tier.
//   - NO photo attachment. RSVPs are text-only.
//   - The 'others_attending' free-text field carries names of partner,
//     children, and any other guests the member wants to bring; the
//     office uses this for headcount and seating where relevant.
//
// Authenticated — requires a valid Supabase session bearer token.
// Member identity is read from the JWT and looked up in the members
// table; we don't trust client-supplied name/email.

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

// Soft length caps on the free-text fields. Keeps the email reasonable
// and rules out abuse.
const MAX_OTHERS_ATTENDING = 600;
const MAX_EVENT_SLUG = 80;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // ── Verify bearer token → member identity ───────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  let memberEmail = null;
  let memberRow = null;
  try {
    const { data: userResp, error: userErr } = await supa().auth.getUser(token);
    if (userErr || !userResp?.user?.email) throw new Error('Invalid session');
    memberEmail = userResp.user.email.toLowerCase();

    const { data: m } = await supa()
      .from('members')
      .select('id, name, email, tier, tier_label, joined_at, status')
      .eq('email', memberEmail)
      .maybeSingle();
    if (!m) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member record not found' }) };
    }
    memberRow = m;
  } catch (e) {
    console.error('auth check failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  // ── Parse and validate payload ──────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const eventSlug = String(data.eventSlug || '').trim();
  const eventTitle = String(data.eventTitle || '').trim();
  const eventDate = String(data.eventDate || '').trim();
  const othersAttending = String(data.othersAttending || '').trim();

  if (!eventSlug || !eventTitle) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing event details — please refresh and try again.' }) };
  }
  if (eventSlug.length > MAX_EVENT_SLUG) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Event identifier too long.' }) };
  }
  if (othersAttending.length > MAX_OTHERS_ATTENDING) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `'Others attending' is too long. Please keep it under ${MAX_OTHERS_ATTENDING} characters.` }) };
  }

  // ── Build the email ─────────────────────────────────────────────────────
  const memberDisplay = memberRow.name || memberEmail;
  const subject = `🌿 RSVP — ${eventTitle} — ${memberDisplay}`;

  const html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Event RSVP — Clan Ó Comáin</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">A member has RSVP'd via the Members' Area event card.</p>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Event</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Title</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(eventTitle)}</strong></td></tr>
      ${eventDate ? `<tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">When</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(eventDate)}</td></tr>` : ''}
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Identifier</td><td style="padding:8px 10px;border:1px solid #e5dcc8;font-family:Menlo,monospace;font-size:12px">${esc(eventSlug)}</td></tr>
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Member</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Name</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(memberRow.name || '—')}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(memberEmail)}" style="color:#B8975A">${esc(memberEmail)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberRow.tier_label || memberRow.tier || '—')}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member since</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(fmtDate(memberRow.joined_at))}</td></tr>
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Others attending</h3>
    ${othersAttending
      ? `<div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(othersAttending)}</div>`
      : `<p style="font-size:14px;color:#6C5A4A;font-style:italic;margin:0">Attending alone.</p>`}

    <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the Members' Area event RSVP form. Reply directly to the member's email above to confirm or follow up.</p>
  </div>`;

  // ── Send the email ──────────────────────────────────────────────────────
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: 'Clan Ó Comáin <clan@ocomain.org>',
        to: CLAN_EMAIL,
        reply_to: memberEmail,
        subject,
        html,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error('Resend failed:', resp.status, body);
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'Mail delivery failed — please try again or write to clan@ocomain.org' }) };
    }
  } catch (err) {
    console.error('Email send error:', err.message);
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Mail service unreachable — please try again shortly' }) };
  }

  // Audit-trail event log. Non-blocking.
  try {
    const clan_id = await clanId();
    await logEvent({
      clan_id,
      member_id:  memberRow.id,
      event_type: 'event_rsvp_submitted',
      payload:    {
        event_slug: eventSlug,
        event_title: eventTitle,
        event_date: eventDate || null,
        others_attending_chars: othersAttending.length,
        has_others: !!othersAttending,
      },
    });
  } catch (e) {
    console.warn('event log failed (non-blocking):', e.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};

// ── Helpers ────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function fmtDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-IE', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return iso;
  }
}
