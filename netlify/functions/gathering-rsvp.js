// netlify/functions/gathering-rsvp.js
//
// AUTHENTICATED. Create, update, or remove the signed-in member's
// RSVP to a given gathering. Active members only.
//
// Body:
//   {
//     gatheringId: "uuid",
//     action: "set"   →  upsert RSVP with guestCount + note
//     action: "remove"  →  delete RSVP
//     guestCount:  1..12   (only required for action='set')
//     note: "..."          (optional, max 200)
//   }
//
// Returns: { ok: true, rsvp: {...}|null, gathering_rsvp_count, gathering_total_attending }
//
// Side effect: emails the host with a name + guest count so they know
// who's coming. This is a deliberate "human touch" — even if the host
// never opens the dashboard, they'll see incoming RSVPs in their
// inbox. Volume management: if a high-RSVP gathering produces too
// many emails, we batch into a daily digest in v2.

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const MAX_NOTE = 200;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // Auth → active member
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
      .select('id, name, email, tier_label, tier, status')
      .eq('email', memberEmail)
      .maybeSingle();
    if (!m) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member record not found' }) };
    if (m.status !== 'active') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'RSVP requires an active membership.' }) };
    }
    memberRow = m;
  } catch (e) {
    console.error('auth failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  // Parse body
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const gatheringId = String(body.gatheringId || '').trim();
  const action      = String(body.action || '').trim();
  if (!gatheringId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing gatheringId.' }) };
  if (!['set','remove'].includes(action)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "action must be 'set' or 'remove'." }) };
  }

  // Look up the gathering — must exist, be in this clan, and be
  // published. Members can RSVP only to live pins.
  let clan_id;
  try { clan_id = await clanId(); }
  catch (e) {
    console.error('clanId failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save RSVP — please try again.' }) };
  }

  const { data: gathering } = await supa()
    .from('gatherings')
    .select('id, host_member_id, venue_name, venue_city, venue_country, gathering_date, status')
    .eq('id', gatheringId)
    .eq('clan_id', clan_id)
    .maybeSingle();
  if (!gathering) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Gathering not found.' }) };
  }
  if (gathering.status !== 'published') {
    return { statusCode: 410, headers, body: JSON.stringify({ error: 'That gathering is no longer accepting RSVPs.' }) };
  }
  if (gathering.host_member_id === memberRow.id) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "You're the host — your attendance is implied." }) };
  }

  // ── Remove path ─────────────────────────────────────────────────────
  if (action === 'remove') {
    const { error: delErr } = await supa()
      .from('gathering_rsvps')
      .delete()
      .eq('gathering_id', gatheringId)
      .eq('member_id', memberRow.id);
    if (delErr) {
      console.error('rsvp delete failed:', delErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not remove RSVP — please try again.' }) };
    }
    const counts = await fetchCounts(gatheringId);
    try {
      await logEvent({
        clan_id, member_id: memberRow.id,
        event_type: 'gathering_rsvp_removed',
        payload: { gathering_id: gatheringId, venue_city: gathering.venue_city },
      });
    } catch (e) { console.warn('event log failed (non-blocking):', e.message); }
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rsvp: null, ...counts }) };
  }

  // ── Set path ────────────────────────────────────────────────────────
  let guestCount = parseInt(body.guestCount, 10);
  if (!Number.isInteger(guestCount) || guestCount < 1 || guestCount > 12) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'guestCount must be between 1 and 12.' }) };
  }
  const note = String(body.note || '').trim().slice(0, MAX_NOTE) || null;

  // Detect new vs update for the office/host email phrasing.
  const { data: existing } = await supa()
    .from('gathering_rsvps')
    .select('id, guest_count')
    .eq('gathering_id', gatheringId)
    .eq('member_id', memberRow.id)
    .maybeSingle();
  const isNew = !existing;

  const row = {
    gathering_id: gatheringId,
    member_id:    memberRow.id,
    guest_count:  guestCount,
    note,
  };
  const { data: saved, error: upErr } = await supa()
    .from('gathering_rsvps')
    .upsert(row, { onConflict: 'gathering_id,member_id' })
    .select()
    .single();
  if (upErr) {
    console.error('rsvp upsert failed:', upErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save RSVP — please try again.' }) };
  }

  // Notify the host (non-blocking).
  notifyHost({ isNew, gathering, memberRow, memberEmail, guestCount, note })
    .catch(e => console.warn('host notify failed (non-blocking):', e.message));

  // Audit
  try {
    await logEvent({
      clan_id, member_id: memberRow.id,
      event_type: isNew ? 'gathering_rsvp_created' : 'gathering_rsvp_updated',
      payload: { gathering_id: gatheringId, guest_count: guestCount, venue_city: gathering.venue_city },
    });
  } catch (e) { console.warn('event log failed (non-blocking):', e.message); }

  const counts = await fetchCounts(gatheringId);
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true, rsvp: saved, ...counts }) };
};

// ── Helpers ──────────────────────────────────────────────────────────
async function fetchCounts(gatheringId) {
  const { data } = await supa()
    .from('gathering_rsvps')
    .select('guest_count')
    .eq('gathering_id', gatheringId);
  const rows = data || [];
  return {
    gathering_rsvp_count:    rows.length,
    gathering_total_attending: rows.reduce((s, r) => s + (r.guest_count || 1), 0),
  };
}

async function notifyHost({ isNew, gathering, memberRow, memberEmail, guestCount, note }) {
  if (!RESEND_API_KEY) return;

  // Look up host email.
  const { data: host } = await supa()
    .from('members')
    .select('email, name')
    .eq('id', gathering.host_member_id)
    .maybeSingle();
  if (!host || !host.email) return;

  const verb = isNew ? 'New RSVP' : 'RSVP updated';
  const guestText = guestCount === 1 ? '1 person' : `${guestCount} people`;
  const subject = `🍀 ${verb} for ${gathering.venue_name} — ${guestText}`;

  const e = esc;
  const html = `<div style="font-family:Georgia,serif;max-width:560px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">${e(verb)} — St Patrick's Day at ${e(gathering.venue_name)}</h2>
    <p style="font-size:15px;line-height:1.7">${e(memberRow.name || memberEmail)} has said they'll be there — <strong>${e(guestText)}</strong>.</p>
    ${note ? `<div style="background:#faf6ec;border-left:3px solid #B8975A;padding:14px 16px;font-size:14px;line-height:1.7;font-style:italic;margin:18px 0">"${e(note)}"</div>` : ''}
    <p style="font-size:13px;color:#6C5A4A;margin-top:22px">Reply directly to this email if you'd like to send a word back. You can also view all RSVPs on your gathering page in the members' area.</p>
    <p style="font-size:12px;color:#8F7A5E;font-style:italic;margin-top:18px">Clan Ó Comáin · Lá Fhéile Pádraig</p>
  </div>`;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${RESEND_API_KEY}` },
    body: JSON.stringify({
      from: 'Clan Ó Comáin <clan@ocomain.org>',
      to: host.email,
      reply_to: memberEmail,
      subject,
      html,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
