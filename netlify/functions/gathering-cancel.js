// netlify/functions/gathering-cancel.js
//
// AUTHENTICATED. The host's "I can no longer do this" button. Flips
// status to 'cancelled' on their own gathering. Idempotent — calling
// twice is harmless. Cancelling drops the pin from the public map
// immediately and hides it from the host's own dashboard card
// (host-mine.js filters status != 'cancelled').
//
// We don't hard-delete: existing RSVPs are dropped by the foreign
// key cascade if the row is deleted, but if we keep the row at
// status='cancelled' the RSVPs remain attached for audit/reporting.
// Cancelled gatherings can't be re-published — the host can create
// a fresh pin (same unique key fails, so they'd need to edit in
// place rather than cancel-then-recreate). For v1 that's a known
// rough edge; if it comes up, we add a 'reactivate' endpoint.
//
// Side effect: notifies clan@ocomain.org so Linda can update any
// follow-up correspondence.
//
// Body: { year: 2027 }

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // Auth → member
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Not signed in' }) };
  }

  let memberRow = null;
  let memberEmail = null;
  try {
    const { data: userResp, error: userErr } = await supa().auth.getUser(token);
    if (userErr || !userResp?.user?.email) throw new Error('Invalid session');
    memberEmail = userResp.user.email.toLowerCase();
    const { data: m } = await supa()
      .from('members')
      .select('id, name, email, status')
      .eq('email', memberEmail)
      .maybeSingle();
    if (!m) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member record not found' }) };
    memberRow = m;
  } catch (e) {
    console.error('auth failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  // Parse year
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const year = parseInt(body.year, 10);
  if (!Number.isInteger(year) || year < 2026 || year > 2099) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid year.' }) };
  }
  const gatheringDate = `${year}-03-17`;

  // Cancel
  let clan_id;
  try { clan_id = await clanId(); }
  catch (e) {
    console.error('clanId failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not cancel — please try again.' }) };
  }

  const { data: cancelled, error: upErr } = await supa()
    .from('gatherings')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .eq('clan_id', clan_id)
    .eq('host_member_id', memberRow.id)
    .eq('gathering_date', gatheringDate)
    .select()
    .maybeSingle();

  if (upErr) {
    console.error('gathering cancel failed:', upErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not cancel — please try again.' }) };
  }
  if (!cancelled) {
    // Nothing to cancel — return success anyway so the UI is
    // idempotent.
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, alreadyAbsent: true }) };
  }

  // Notify the Office (non-blocking).
  if (RESEND_API_KEY) {
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify({
        from: 'Clan Ó Comáin <clan@ocomain.org>',
        to: CLAN_EMAIL,
        reply_to: memberEmail,
        subject: `Gathering cancelled — ${cancelled.venue_city}, ${cancelled.venue_country} — ${memberRow.name || memberEmail}`,
        html: `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
          <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">St Patrick's Day Gathering — Cancelled</h2>
          <p>${esc(memberRow.name || memberEmail)} has cancelled their gathering at <strong>${esc(cancelled.venue_name)}</strong> in ${esc(cancelled.venue_city)}, ${esc(cancelled.venue_country)} for ${year}.</p>
          <p style="font-size:13px;color:#6C5A4A">Any RSVPs to this gathering remain in the database for audit but the pin is no longer visible on the public map. If the member wishes to host again, they'll need to email the Office to clear the cancelled row first.</p>
        </div>`,
      }),
    }).catch(e => console.warn('office notify failed (non-blocking):', e.message));
  }

  // Audit
  try {
    await logEvent({
      clan_id,
      member_id:  memberRow.id,
      event_type: 'gathering_cancelled',
      payload:    { year, gathering_id: cancelled.id, venue_city: cancelled.venue_city, venue_country: cancelled.venue_country },
    });
  } catch (e) { console.warn('event log failed (non-blocking):', e.message); }

  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, gathering: cancelled }) };
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
