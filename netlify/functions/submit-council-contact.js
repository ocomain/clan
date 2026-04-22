// netlify/functions/submit-council-contact.js
// Handles two form types from the members-area Council contact page:
//   - 'lineage'  : priority genealogy/DNA queries, routed to the Office of
//                  the Private Secretary pending Craoibhscríobhaí appointment.
//   - 'general'  : any other correspondence to the Council, with optional
//                  intended office; always triaged by the Private Secretary.
//
// Authenticated — requires a valid Supabase session bearer token (only
// members should be able to use these forms). We look up the member
// row so the email to the Office includes their tier and join date.

const { supa } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

// Map the office <select> values to human-readable labels for the email
const OFFICE_LABELS = {
  '': 'Office of the Private Secretary (for triage)',
  'chief': 'The Chief — Fergus Kinfauns',
  'tanaiste': 'The Tánaiste — Antoin Commane',
  'chancellor': 'Chancellor & Treasurer — Maria Kinfauns',
  'secretary': 'Private Secretary — Linda Cryan',
  'keeper': 'Keeper of the Seat — Jessica-Lily Commane',
  'marshall': 'Marshall & Standard Bearer — Michael Commane',
  'seanchai': 'Seanchaí — Paddy Commane, Ballymacooda',
  'bard': 'Clan Bard — Paddy Commane, Rockmount',
  'chaplain': 'Clan Chaplain (role open)',
  'anam-cara': 'Anam Cara · Counsellor (role open)',
  'ollamh-leighis': 'Ollamh Leighis · Health Advisor (role open)',
};

// Map DNA-status form values to readable labels
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

    // Best-effort member lookup for extra context in the email — non-blocking
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

  // ── Parse and validate payload ──────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { form_type, name, email, message } = data;
  if (!form_type || !name || !email || !message) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
  }
  if (!['lineage', 'general'].includes(form_type)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown form type' }) };
  }

  // ── Build the email ─────────────────────────────────────────────────────
  const memberContext = memberRow ? `
    <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Member tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(memberRow.tier || '—')}</strong></td></tr>
    <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member since</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(fmtDate(memberRow.joined_at))}</td></tr>
    <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member status</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberRow.status || '—')}</td></tr>
  ` : '<tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px" colspan="2"><em>Member record not found for signed-in email (account may be new).</em></td></tr>';

  let subject, html;

  if (form_type === 'lineage') {
    const { origin = '', dna_status = '' } = data;
    subject = `🌿 Lineage query — ${name} (Craoibhscríobhaí)`;
    html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
      <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Lineage &amp; DNA query — Clan Ó Comáin</h2>
      <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6"><strong>Office:</strong> Craoibhscríobhaí · <strong>Triage:</strong> Office of the Private Secretary<br><em>This is a priority channel — persona A genealogy/DNA lead, highest incoming-query category.</em></p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">From</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(name)}</strong></td></tr>
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(email)}" style="color:#B8975A">${esc(email)}</a></td></tr>
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Signed-in as</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberEmail)}</td></tr>
        ${memberContext}
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Earliest ancestor</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(origin) || '—'}</td></tr>
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Y-DNA status</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(DNA_LABELS[dna_status] || dna_status || '—')}</td></tr>
      </table>
      <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Their question</h3>
      <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(message)}</div>
      <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the Members' Area contact page. Reply directly to the member's email address above.</p>
    </div>`;
  } else {
    const { office = '', subject: userSubject = '' } = data;
    const officeLabel = OFFICE_LABELS[office] || OFFICE_LABELS[''];
    const subjectLine = userSubject ? userSubject.slice(0, 120) : '(no subject given)';
    subject = `Council message — ${name} · ${officeLabel.replace(/ \(.+\)$/, '')}`;
    html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
      <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Council correspondence — Clan Ó Comáin</h2>
      <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6"><strong>Intended office:</strong> ${esc(officeLabel)}<br><strong>Triage:</strong> Office of the Private Secretary</p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">From</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(name)}</strong></td></tr>
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(email)}" style="color:#B8975A">${esc(email)}</a></td></tr>
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Signed-in as</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberEmail)}</td></tr>
        ${memberContext}
        <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Their subject</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(subjectLine)}</strong></td></tr>
      </table>
      <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Message</h3>
      <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(message)}</div>
      <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the Members' Area contact page. Reply directly to the member's email address above.</p>
    </div>`;
  }

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
