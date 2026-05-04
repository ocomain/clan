// netlify/functions/submit-clan-story.js
//
// Member-initiated Share-Your-Story submission for the clan's public
// Stories page at /clan-stories. Replaces the earlier mailto: link
// on the Share-Your-Story card with a structured form.
//
// Stories are editorial — each one needs human curation (quality check,
// occasional follow-up interview, photo crop) before it goes onto the
// public page. So this function emails clan@ocomain.org rather than
// auto-publishing. The Chief reviews, replies to the member to
// confirm and request the portrait, and lifts the entry onto the page
// when ready. When demand justifies it, this can grow into a
// moderation queue + auto-render.
//
// Authenticated — requires a valid Supabase session bearer token AND
// Steward-or-higher tier (this is a Steward+ perk on the membership
// page; the dashboard hides the card for lower tiers, and this
// function is the server-side enforcement of that gate).

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

// Tier gate — Steward, Life. Mirror of the dashboard regex.
const ALLOWED_TIER_RE = /^(steward|life)-/;

// Soft length caps. Reject if over to keep the email reasonable and
// rule out abuse.
const MAX_NAME = 160;
const MAX_LOCATION = 160;
const MAX_LINEAGE = 280;
const MAX_STORY = 1500; // ~250 words; comfortably above 80-120 guidance

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

  // ── Tier gate ───────────────────────────────────────────────────────────
  // Stories are a Steward+ perk. UI hides the card for lower tiers;
  // this is the server-side enforcement so a determined poke at the
  // endpoint won't bypass the perk gate.
  if (!memberRow.tier || !ALLOWED_TIER_RE.test(memberRow.tier)) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({
        error: 'A dedicated story on /clan-stories is reserved for Steward and Life members.',
      }),
    };
  }

  // ── Parse and validate payload ──────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const storytellerName = String(data.storytellerName || '').trim();
  const location = String(data.location || '').trim();
  const lineage = String(data.lineage || '').trim();
  const story = String(data.story || '').trim();

  if (!storytellerName || !story) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Please fill in your full name and a few lines of story.' }),
    };
  }
  if (
    storytellerName.length > MAX_NAME ||
    location.length > MAX_LOCATION ||
    lineage.length > MAX_LINEAGE ||
    story.length > MAX_STORY
  ) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'One of your entries is longer than allowed — please shorten and try again.' }) };
  }

  // ── Build the email ─────────────────────────────────────────────────────
  const subject = `📖 Clan Stories submission — ${storytellerName}`;

  const html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Clan Stories submission — Clan Ó Comáin</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">A Steward has submitted a story for the clan's public Stories page at <a href="https://www.ocomain.org/clan-stories" style="color:#B8975A">ocomain.org/clan-stories</a>.<br><strong>Next step:</strong> review the piece, reply to the member to confirm and request the portrait photograph, then lift the entry onto the Stories page when ready.</p>

    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Submitted by</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(memberRow.name || '—')}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(memberEmail)}" style="color:#B8975A">${esc(memberEmail)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberRow.tier_label || memberRow.tier || '—')}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member since</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(fmtDate(memberRow.joined_at))}</td></tr>
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">For the byline</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Name</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(storytellerName)}</strong></td></tr>
      ${location ? `<tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Location</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(location)}</td></tr>` : ''}
      ${lineage ? `<tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Lineage</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(lineage)}</td></tr>` : ''}
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Their story</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(story)}</div>

    <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the Members' Area Stories form. Reply directly to the member's email above to confirm and request the portrait photograph.</p>
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
      event_type: 'clan_story_submitted',
      payload:    {
        has_location: !!location,
        has_lineage:  !!lineage,
        story_chars:  story.length,
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
