// netlify/functions/gathering-host-upsert.js
//
// AUTHENTICATED endpoint. Active members only. Create or update the
// signed-in member's St Patrick's Day gathering pin for the requested
// year. One pin per (member, year) — calling again updates the row.
//
// Same shape as submit-event-rsvp / submit-obituary:
//   - Bearer token from Supabase auth
//   - Member identity read from JWT (never from client)
//   - Member must exist + status='active'
//
// Body:
//   {
//     year:               2027,
//     hostDisplayName:    "Sean from Newmarket",   // optional
//     message:            "First pin of...",        // optional, max 300
//     venueName:          "Crow's Nest",
//     venueAddress:       "17 Main St, Newmarket, ON",
//     venueCity:          "Newmarket",
//     venueCountry:       "CA",                     // ISO 3166-1 alpha-2
//     venueLat:           44.0532,
//     venueLng:           -79.4608,
//     venueUrl:           "https://maps.google.com/..." // optional
//     startsLocalTime:    "19:00"
//   }
//
// Response: { ok: true, gathering: {...}, isNew: bool }
//
// Side effect: emails clan@ocomain.org so Linda sees every new
// gathering in real time. Updates are also notified — easier to keep
// the Office in the loop than to start filtering "interesting" events.

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

const MAX_MESSAGE       = 300;
const MAX_DISPLAY_NAME  = 80;
const MAX_VENUE_NAME    = 120;
const MAX_VENUE_ADDRESS = 240;
const MAX_VENUE_CITY    = 80;
const MAX_VENUE_URL     = 500;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const headers = {
    'Access-Control-Allow-Origin': 'https://www.ocomain.org',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  // ── Verify bearer token → active member ────────────────────────────
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
      .select('id, name, email, tier, tier_label, status, joined_at')
      .eq('email', memberEmail)
      .maybeSingle();
    if (!m) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Member record not found' }) };
    }
    if (m.status !== 'active') {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Hosting a gathering requires an active membership.' }) };
    }
    // Tier gate: hosting is a Guardian+ benefit (Guardian, Steward, Life).
    // Clan Member tier can RSVP and attend but not host their own pin.
    // The same rule is mirrored client-side in /members/host-gathering.html
    // so Clan Member tier members see a "your tier doesn't include hosting"
    // message rather than a form they can't submit, but the authoritative
    // check is here — never trust the client to enforce tier policy.
    if (!m.tier || m.tier.startsWith('clan-')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Hosting a St Patrick\'s Day gathering is a Guardian-tier-or-above benefit. All tiers may RSVP and attend.', upgradeRequired: true }) };
    }
    memberRow = m;
  } catch (e) {
    console.error('auth check failed:', e.message);
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session expired — please sign in again' }) };
  }

  // ── Parse + validate payload ───────────────────────────────────────
  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const year = parseInt(body.year, 10);
  if (!Number.isInteger(year) || year < 2026 || year > 2099) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid year.' }) };
  }
  const gatheringDate = `${year}-03-17`;

  const trim = (s, max) => String(s == null ? '' : s).trim().slice(0, max);

  const hostDisplayName = trim(body.hostDisplayName, MAX_DISPLAY_NAME) || null;
  const message         = trim(body.message,         MAX_MESSAGE)      || null;
  const venueName       = trim(body.venueName,       MAX_VENUE_NAME);
  const venueAddress    = trim(body.venueAddress,    MAX_VENUE_ADDRESS);
  const venueCity       = trim(body.venueCity,       MAX_VENUE_CITY);
  const venueCountry    = trim(body.venueCountry, 2).toUpperCase();
  const venueUrl        = trim(body.venueUrl,        MAX_VENUE_URL) || null;
  const startsLocalTime = trim(body.startsLocalTime, 8);

  const venueLat = Number(body.venueLat);
  const venueLng = Number(body.venueLng);

  // Field-level validation. Specific messages so the form can surface
  // exactly what's wrong.
  if (!venueName)    return reject(headers, 'Pub name is required.');
  if (!venueAddress) return reject(headers, 'Pub address is required.');
  if (!venueCity)    return reject(headers, 'City is required.');
  if (!venueCountry || venueCountry.length !== 2) return reject(headers, 'Country (2-letter code) is required.');
  if (!startsLocalTime || !/^\d{1,2}:\d{2}$/.test(startsLocalTime)) {
    return reject(headers, 'Start time must be in HH:MM format (e.g. 19:00).');
  }
  if (!Number.isFinite(venueLat) || venueLat < -90  || venueLat > 90)  return reject(headers, 'Invalid latitude — please re-pick the pub on the map.');
  if (!Number.isFinite(venueLng) || venueLng < -180 || venueLng > 180) return reject(headers, 'Invalid longitude — please re-pick the pub on the map.');
  if (venueLat === 0 && venueLng === 0)                                return reject(headers, 'Please pick the pub on the map so it has real coordinates.');

  // ── Upsert ─────────────────────────────────────────────────────────
  let clan_id;
  try {
    clan_id = await clanId();
  } catch (e) {
    console.error('clanId failed:', e.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save gathering — please try again.' }) };
  }

  // Detect insert vs update by checking for an existing row on the
  // unique key — so we can return isNew honestly and send the office a
  // slightly different subject line.
  const { data: existing } = await supa()
    .from('gatherings')
    .select('id')
    .eq('clan_id', clan_id)
    .eq('host_member_id', memberRow.id)
    .eq('gathering_date', gatheringDate)
    .maybeSingle();
  const isNew = !existing;

  const row = {
    clan_id,
    host_member_id:    memberRow.id,
    gathering_date:    gatheringDate,
    host_display_name: hostDisplayName,
    message,
    venue_name:        venueName,
    venue_address:     venueAddress,
    venue_city:        venueCity,
    venue_country:     venueCountry,
    venue_lat:         venueLat,
    venue_lng:         venueLng,
    venue_url:         venueUrl,
    starts_local_time: startsLocalTime,
    status:            'published',
    updated_at:        new Date().toISOString(),
  };

  const { data: saved, error: upErr } = await supa()
    .from('gatherings')
    .upsert(row, { onConflict: 'clan_id,host_member_id,gathering_date' })
    .select()
    .single();

  if (upErr) {
    console.error('gathering upsert failed:', upErr.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not save gathering — please try again.' }) };
  }

  // ── Notify the Office (non-blocking) ───────────────────────────────
  notifyOffice({
    isNew,
    memberRow,
    memberEmail,
    saved,
    year,
  }).catch(e => console.warn('office notify failed (non-blocking):', e.message));

  // ── Audit event ────────────────────────────────────────────────────
  try {
    await logEvent({
      clan_id,
      member_id:  memberRow.id,
      event_type: isNew ? 'gathering_created' : 'gathering_updated',
      payload: {
        year,
        gathering_id: saved.id,
        venue_name:   saved.venue_name,
        venue_city:   saved.venue_city,
        venue_country: saved.venue_country,
      },
    });
  } catch (e) {
    console.warn('event log failed (non-blocking):', e.message);
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, isNew, gathering: saved }),
  };
};

// ── Helpers ──────────────────────────────────────────────────────────
function reject(headers, msg) {
  return { statusCode: 400, headers, body: JSON.stringify({ error: msg }) };
}

async function notifyOffice({ isNew, memberRow, memberEmail, saved, year }) {
  if (!RESEND_API_KEY) {
    console.warn('RESEND_API_KEY not set — skipping office notification');
    return;
  }
  const verb = isNew ? 'created' : 'updated';
  const subject = `🍀 Gathering ${verb} — ${saved.venue_city}, ${saved.venue_country} — ${memberRow.name || memberEmail}`;
  const e = esc;
  const html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">St Patrick's Day Gathering — ${e(verb)}</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">A member has ${e(verb)} a gathering pin for the ${e(String(year))} cycle of the St Patrick's Day map.</p>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Pub</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Venue</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${e(saved.venue_name)}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Address</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${e(saved.venue_address)}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">City</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${e(saved.venue_city)}, ${e(saved.venue_country)}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Time</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${e(saved.starts_local_time)} on 17 March ${e(String(year))}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Coords</td><td style="padding:8px 10px;border:1px solid #e5dcc8;font-family:Menlo,monospace;font-size:12px">${e(String(saved.venue_lat))}, ${e(String(saved.venue_lng))}</td></tr>
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Host</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Registered name</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${e(memberRow.name || '—')}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Display name (on map)</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${e(saved.host_display_name || memberRow.name || '—')}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${e(memberEmail)}" style="color:#B8975A">${e(memberEmail)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${e(memberRow.tier_label || memberRow.tier || '—')}</td></tr>
    </table>

    ${saved.message ? `<h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Host's message</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;white-space:pre-wrap;font-size:14px;line-height:1.7;margin-bottom:20px">${e(saved.message)}</div>` : ''}

    <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">If the venue or any detail looks wrong (test pin, duplicate, dubious location), hide it from the admin map review tool. The host can re-edit anytime.</p>
  </div>`;

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
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
