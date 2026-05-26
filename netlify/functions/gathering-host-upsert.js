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

// Avatar upload constraints. The client resizes to ~400x400 JPEG at 0.85
// quality (~50-150KB typical), so even a 5MB ceiling here is hugely
// generous for legitimate uploads. The ceiling exists only to bound the
// worst case from a hostile client that bypasses the resize. Bumped
// from 1 MB → 5 MB (2026-05-25) after a real-world host reported a
// rejection on a normal-sized photo: their image was within the 8 MB
// raw-file ceiling but the client-side canvas round-trip produced
// output slightly over 1 MB (high-megapixel modern phone photos can
// do this even with 0.85 JPEG quality), and the resulting rejection
// was opaque to the user.
const AVATAR_BUCKET = 'gathering-avatars';
const AVATAR_MAX_DECODED_BYTES = 5 * 1024 * 1024;   // 5 MB
const AVATAR_ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// Upload a data: URL to Supabase Storage and return the public URL.
// Throws on invalid input or storage error so the caller can decide
// to bail or fall back.
async function uploadAvatarFromDataUrl(dataUrl, memberId, year) {
  // Format: data:<mime>;base64,<payload>
  const m = /^data:([\w/+.-]+);base64,(.+)$/i.exec(dataUrl);
  if (!m) throw new Error('Avatar payload not a base64 data URL.');
  const contentType = m[1].toLowerCase();
  const base64      = m[2];

  if (!AVATAR_ALLOWED_TYPES.has(contentType)) {
    throw new Error(`Avatar type ${contentType} not allowed. Use JPEG, PNG, or WebP.`);
  }
  const buf = Buffer.from(base64, 'base64');
  if (buf.length > AVATAR_MAX_DECODED_BYTES) {
    throw new Error(`Avatar too large (${buf.length} bytes). Max 1 MB after decode.`);
  }

  // Path scheme: <member_id>/<year>-<timestamp>.<ext>
  // Per-member folder keeps things organised; timestamp suffix means we
  // never overwrite, so old URLs (e.g. cached in an old email) stay
  // valid. Storage is cheap; orphaned files are harmless.
  const ext = contentType === 'image/png'  ? 'png'
            : contentType === 'image/webp' ? 'webp'
            :                                 'jpg';
  const ts  = Date.now();
  const path = `${memberId}/${year}-${ts}.${ext}`;

  const client = supa();
  const { error: upErr } = await client.storage.from(AVATAR_BUCKET).upload(path, buf, {
    contentType,
    upsert: false,   // unique path; no overwrite expected
    cacheControl: '31536000',  // immutable URL; cache for a year
  });
  if (upErr) throw new Error(`Storage upload failed: ${upErr.message}`);

  const { data: pub } = client.storage.from(AVATAR_BUCKET).getPublicUrl(path);
  if (!pub || !pub.publicUrl) throw new Error('Could not derive public URL after upload.');
  return pub.publicUrl;
}

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

  // Avatar — three accepted shapes from the client:
  //   data:image/...;base64,...  → fresh upload; decode + push to Storage
  //   https://...                → existing URL; pass through unchanged
  //   '' (empty) or null/missing → explicit clear; null the column
  // Errors uploading are non-fatal: we fall back to passing through whatever
  // was already on the existing row so the form save still succeeds.
  const avatarInput = (typeof body.avatar === 'string') ? body.avatar : null;
  // (We resolve the final value after we have a gathering id, since the
  //  storage key benefits from being scoped by gathering — see below.)

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
    .select('id, host_avatar_url')
    .eq('clan_id', clan_id)
    .eq('host_member_id', memberRow.id)
    .eq('gathering_date', gatheringDate)
    .maybeSingle();
  const isNew = !existing;

  // ── Resolve avatar URL ─────────────────────────────────────────────
  // avatarInput from the client tells us what to do:
  //   - starts with 'data:image/'  → fresh upload; push to Storage
  //   - other non-empty string     → existing URL; keep as-is
  //   - empty/missing              → reject (avatar is required)
  //
  // Tracks whether this request brought a freshly-uploaded photo, so
  // we can mirror it onto members.avatar_url after the upsert lands.
  let hostAvatarUrl = existing ? (existing.host_avatar_url || null) : null;
  let freshlyUploaded = false;
  if (typeof avatarInput === 'string' && avatarInput.startsWith('data:image/')) {
    try {
      hostAvatarUrl = await uploadAvatarFromDataUrl(avatarInput, memberRow.id, year);
      freshlyUploaded = true;
    } catch (e) {
      console.warn('avatar upload failed:', e.message);
      // Pick a user-facing message that actually matches the failure
      // mode. The internal e.message values are intentionally verbose
      // for the server log; the public-facing string is short and
      // actionable. Note: the previous message mentioned "under 8 MB"
      // which was misleading — that's the raw-file client ceiling,
      // not the server's post-decode limit. Users were sending small
      // photos and getting an irrelevant "8 MB" message back.
      let userMsg;
      if (e.message.startsWith('Avatar too large')) {
        userMsg = 'Your photo is too large after processing — please try a smaller or lower-resolution image.';
      } else if (e.message.includes('not allowed')) {
        userMsg = 'That image format is not supported — please use JPEG, PNG or WebP.';
      } else if (e.message.startsWith('Storage upload')) {
        userMsg = 'There was a temporary problem saving your photo — please try again in a moment.';
      } else {
        userMsg = 'We could not save your photo — please try a different image (JPEG, PNG or WebP).';
      }
      return reject(headers, userMsg);
    }
  } else if (typeof avatarInput === 'string' && avatarInput.length > 0) {
    // Existing URL passed through unchanged — common path on edit when
    // the user didn't pick a new file.
    hostAvatarUrl = avatarInput;
  }
  // Mandatory: every published gathering must carry a host photo. The
  // map relies on a face to make pins legible at-a-glance, and an
  // empty-circle pin reads as broken rather than anonymous.
  if (!hostAvatarUrl) {
    return reject(headers, 'A headshot photo of the host is required — please choose one before saving.');
  }

  const row = {
    clan_id,
    host_member_id:    memberRow.id,
    gathering_date:    gatheringDate,
    host_display_name: hostDisplayName,
    host_avatar_url:   hostAvatarUrl,
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

  // ── Mirror a freshly-uploaded avatar onto the member profile ──────
  // The host-form is the one place in the app where a member uploads a
  // photo today, so this is also the canonical moment to persist the
  // headshot as their profile avatar. Future flows (member directory,
  // RSVP signature lines, etc.) can read members.avatar_url without
  // re-prompting. Non-blocking: a failure to mirror should not prevent
  // the gathering save from succeeding.
  if (freshlyUploaded) {
    try {
      const { error: memberAvatarErr } = await supa()
        .from('members')
        .update({ avatar_url: hostAvatarUrl })
        .eq('id', memberRow.id);
      if (memberAvatarErr) {
        console.warn('mirror to members.avatar_url failed (non-blocking):', memberAvatarErr.message);
      }
    } catch (e) {
      console.warn('mirror to members.avatar_url threw (non-blocking):', e && e.message);
    }
  }

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
