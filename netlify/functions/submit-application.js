// netlify/functions/submit-application.js
// Called when herald conversation completes
// Stores applicant data, sends notification to clan

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  let data;
  try {
    data = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { name, email, country, connection, source, tier } = data;
  if (!name || !email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name and email required' }) };
  }

  // Notify clan with full details
  const html = `<div style="font-family:sans-serif;max-width:500px">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px">New membership application — Clan Ó Comáin</h2>
    <table style="border-collapse:collapse;width:100%;margin-bottom:20px">
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666;width:130px">Name</td><td style="padding:10px;border:1px solid #ddd"><strong>${name}</strong></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Email</td><td style="padding:10px;border:1px solid #ddd"><a href="mailto:${email}">${email}</a></td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Country</td><td style="padding:10px;border:1px solid #ddd">${country || '—'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Connection</td><td style="padding:10px;border:1px solid #ddd">${connection || '—'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Heard via</td><td style="padding:10px;border:1px solid #ddd">${source || '—'}</td></tr>
      <tr><td style="padding:10px;border:1px solid #ddd;color:#666">Tier selected</td><td style="padding:10px;border:1px solid #ddd"><strong style="color:#B8975A">${tier || 'Not specified'}</strong></td></tr>
    </table>
    <p style="font-size:13px;color:#666">This application was submitted via the Clan Herald. Payment may or may not have been completed — check Stripe for confirmation.</p>
  </div>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Ó Comáin Herald <herald@ocomain.org>',
        to: CLAN_EMAIL,
        subject: `New application: ${name} — ${tier || 'tier not selected'}`,
        html,
      }),
    });
  } catch (err) {
    console.error('Email failed:', err);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
