// netlify/functions/submit-council-application.js
//
// Public-facing council application intake. Used by the modal on
// /privy-council.html. Replaces the previous mailto: button that
// directed the writer to email clan@ocomain.org from their own client.
//
// Why public (not authenticated): the Privy Council page is the
// clan's public statement on its constitution and open offices.
// Some applicants will be members; some will be considering joining
// in order to serve. Both should be able to apply through the same
// channel without first going through sign-in.
//
// Spam protection:
//   - Honeypot field 'website' — bots fill it; real users don't see it.
//   - Length caps on every field. Reject if over.
//   - Origin check on the request (CORS allowlist).
//
// Sends a structured email to clan@ocomain.org for triage by the
// Office of the Private Secretary. Reply-to is the applicant's email
// so the OPS can reply directly.
//
// Routing convention — communication with the Chief is reserved and
// flows through the Office of the Private Secretary. The applicant
// never receives a direct Chief reply; the OPS triages and either
// replies on the Chief's behalf or escalates as appropriate.

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

// Soft caps — reject anything over.
const MAX_NAME = 160;
const MAX_EMAIL = 320; // RFC 5321 hard limit
const MAX_OFFICE = 80;
const MAX_MESSAGE = 4000; // ~700 words; comfortable for a brief account

// Office labels. Kept in sync with the role list rendered on
// privy-council.html. The 'open' office labels come from the
// existing Council page copy. Two synthetic values support the
// modal's edge cases — empty (nothing chosen) and 'unsure'.
const OFFICE_LABELS = {
  '':                      '(no office named)',
  'unsure':                'Not sure — open to a conversation',
  'viceroy':               'Viceroy',
  'anam-cara':             'Anam Cara · Counsellor',
  'ollamh-leighis':        'Ollamh Leighis · Health Advisor',
  'craoibhscriobhai':      'Craoibhscríobhaí · Genealogist',
  'chaplain':              'Clan Chaplain',
  'herald':                'Clan Herald',
  'gaelic-officer':        'Gaelic Officer',
  'ambassador':            'Clan Ambassador (diaspora)',
  'chronicler':            'Chronicler of Legends',
  'archivist':             'Heritage Archivist',
  'diaspora-liaison':      'Diaspora Liaison',
  'pr-officer':            'PR Officer',
  'membership-officer':    'Membership Officer',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // ── Parse and validate payload ──────────────────────────────────────────
  let data;
  try {
    data = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  // Honeypot — bots fill the 'website' field; humans don't see it (display:none).
  // If it has any content, silently 'succeed' so the bot doesn't learn to retry,
  // but never email anyone.
  if (typeof data.website === 'string' && data.website.trim() !== '') {
    console.log('council-application: honeypot hit, silently dropping');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  const office = String(data.office || '').trim();
  const message = String(data.message || '').trim();

  if (!name || !email || !message) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Please fill in your name, email, and a brief account of your interest.' }),
    };
  }

  // Email format — light check, not RFC-perfect.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'That email address does not look right — please check and try again.' }) };
  }

  if (
    name.length > MAX_NAME ||
    email.length > MAX_EMAIL ||
    office.length > MAX_OFFICE ||
    message.length > MAX_MESSAGE
  ) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'One of your entries is longer than allowed — please shorten and try again.' }) };
  }

  const officeLabel = OFFICE_LABELS[office] !== undefined ? OFFICE_LABELS[office] : office;

  // ── Build the email ─────────────────────────────────────────────────────
  const subject = `Privy Council application — ${name} · ${officeLabel}`;

  const html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Privy Council application — Clan Ó Comáin</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">An applicant has submitted interest in serving on the Privy Council via the public council page.<br><strong>Triage:</strong> Office of the Private Secretary.</p>

    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">From</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(name)}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(email)}" style="color:#B8975A">${esc(email)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Office of interest</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(officeLabel)}</strong></td></tr>
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Their account</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(message)}</div>

    <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the public Privy Council page (/privy-council.html). Reply directly to the applicant's email above.</p>
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

  // Audit-trail event log. Non-blocking. No member_id since this is
  // a public submission and may or may not correspond to a member.
  try {
    const clan_id = await clanId();
    await logEvent({
      clan_id,
      member_id:  null,
      event_type: 'council_application_submitted',
      payload:    {
        name,
        email,
        office,
        message_chars: message.length,
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
