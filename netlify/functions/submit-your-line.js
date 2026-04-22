// netlify/functions/submit-your-line.js
// Members-only: a signed-in member submits their own line for inclusion in
// the clan pedigree. Routed to the Office of the Private Secretary for
// triage and eventual handover to the Craoibhscríobhaí.
//
// Route: POST /api/submit-your-line
// Auth:  Bearer <supabase-jwt> in Authorization header

const { supa } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

const DNA_LABELS = {
  'none': 'Not tested',
  'ancestry': 'Autosomal only (Ancestry / 23andMe / MyHeritage)',
  'ydna-37': 'Y-DNA short (FTDNA Y-37 / Y-67 / Y-111)',
  'bigy': 'Big-Y 500 or Big-Y 700',
  'other': 'Other / not sure',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // ── Verify bearer token → member identity ──────────────────────────────
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

    try {
      const { data: m } = await supa()
        .from('members')
        .select('name, tier, joined_at, status')
        .eq('email', memberEmail)
        .maybeSingle();
      memberRow = m || null;
    } catch (e) {
      console.warn('members lookup failed (non-blocking):', e.message);
    }
  } catch (e) {
    console.error('auth check failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  // ── Parse payload ──────────────────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const {
    name, email,
    surname = '', country = '',
    p_name = '', p_place = '', p_year = '',
    gpp_name = '', gpp_place = '', gpp_year = '',
    gpm_name = '', gpm_place = '', gpm_year = '',
    ggp_name = '', ggp_place = '', ggp_year = '',
    earliest = '',
    dna_status = '',
    sources = '',
    stories = '',
    notes = '',
  } = data;

  if (!name || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and email are required' }) };
  }

  // Basic meaningful-content check — mirrors the client-side check so we
  // never forward an empty submission to Linda
  const genealogyFields = [p_name, gpp_name, gpm_name, ggp_name, earliest, stories, sources];
  const hasContent = genealogyFields.some(v => String(v || '').trim().length > 0);
  if (!hasContent) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please include at least one piece of genealogical information' }) };
  }

  // ── Build a generation row helper ──────────────────────────────────────
  const genRow = (label, n, p, y) => {
    if (!n && !p && !y) return '';
    return `<tr>
      <td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px;font-weight:600">${esc(label)}</td>
      <td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(n) || '—'}</strong>${p ? '<br><span style="color:#6C5A4A;font-size:13px">' + esc(p) + '</span>' : ''}${y ? '<br><span style="color:#6C5A4A;font-size:13px">c. ' + esc(y) + '</span>' : ''}</td>
    </tr>`;
  };

  const generations =
    genRow('Parents', p_name, p_place, p_year) +
    genRow('Grandparents (paternal)', gpp_name, gpp_place, gpp_year) +
    genRow('Grandparents (maternal)', gpm_name, gpm_place, gpm_year) +
    genRow('Great-grandparents', ggp_name, ggp_place, ggp_year);

  const memberContext = memberRow ? `
    <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Member tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(memberRow.tier || '—')}</strong></td></tr>
    <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member since</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(fmtDate(memberRow.joined_at))}</td></tr>
    <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member status</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberRow.status || '—')}</td></tr>
  ` : '<tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px" colspan="2"><em>Member record not found for signed-in email (account may be new).</em></td></tr>';

  const subject = `🌳 Line submission — ${name}${surname ? ' (' + surname + ')' : ''}`;

  const html = `<div style="font-family:Georgia,serif;max-width:680px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Line submission — Clan Ó Comáin</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">
      <strong>For:</strong> Craoibhscríobhaí · <strong>Triage:</strong> Office of the Private Secretary<br>
      <em>A member has submitted their line for eventual inclusion in the clan pedigree. Review, follow up with any clarifying questions, and add to the master tree when the connection is clear.</em>
    </p>

    <h3 style="color:#0C1A0C;font-size:16px;margin:18px 0 8px">The submitter</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Name</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(name)}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(email)}" style="color:#B8975A">${esc(email)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Signed-in as</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberEmail)}</td></tr>
      ${memberContext}
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Surname / variant</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(surname) || '—'}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Location</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(country) || '—'}</td></tr>
    </table>

    ${generations ? `
    <h3 style="color:#0C1A0C;font-size:16px;margin:24px 0 8px">Their line back</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      ${generations}
    </table>` : ''}

    ${earliest ? `
    <h3 style="color:#0C1A0C;font-size:16px;margin:24px 0 8px">Earliest Ó Comáin ancestor</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:14px 16px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7;margin-bottom:20px">${esc(earliest)}</div>` : ''}

    <h3 style="color:#0C1A0C;font-size:16px;margin:24px 0 8px">DNA &amp; sources</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Y-DNA status</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(DNA_LABELS[dna_status] || dna_status || '—')}</td></tr>
    </table>
    ${sources ? `<div style="background:#faf6ec;border:1px solid #e5dcc8;padding:14px 16px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7;margin-bottom:20px"><strong style="font-size:12px;color:#6C5A4A;text-transform:uppercase;letter-spacing:0.08em">Records / heirlooms</strong><br><br>${esc(sources)}</div>` : ''}

    ${stories ? `
    <h3 style="color:#0C1A0C;font-size:16px;margin:24px 0 8px">Family stories</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:14px 16px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7;margin-bottom:20px">${esc(stories)}</div>` : ''}

    ${notes ? `
    <h3 style="color:#0C1A0C;font-size:16px;margin:24px 0 8px">Notes to the Craoibhscríobhaí</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:14px 16px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7;margin-bottom:20px">${esc(notes)}</div>` : ''}

    <p style="margin-top:28px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the Members' Area 'Your line in the clan' page. Reply directly to the member's email address above.</p>
  </div>`;

  // ── Send ────────────────────────────────────────────────────────────────
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
        reply_to: email,
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
