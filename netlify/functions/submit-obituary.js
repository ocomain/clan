// netlify/functions/submit-obituary.js
//
// Member-initiated obituary submission for the clan's online memorial roll
// at /patrons. Replaces the earlier mailto: link on the dashboard with a
// proper structured form so:
//   - the chief receives consistent, well-formatted entries
//   - the member doesn't have to remember the template fields
//   - the data is shaped for easy paste into the /patrons page later
//   - we have a clean upgrade path to a moderation queue + auto-render
//     once volume justifies it
//
// For now the function only emails clan@ocomain.org. The portrait
// photograph is handled out-of-band: the response copy asks the member
// to reply to the chief's follow-up email with the photograph attached.
// When demand justifies it, we can add Supabase storage upload + a
// /patrons CMS-style flow.
//
// Authenticated — requires a valid Supabase session bearer token AND
// Guardian-or-higher tier (this is a Guardian+ perk on the membership
// page; the dashboard hides the card for Clan tier, and this function
// is the server-side enforcement of that gate).

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

// Tier gate — Guardian, Steward, Life. Mirror of the dashboard regex.
const ALLOWED_TIER_RE = /^(guardian|steward|life)-/;

// Soft length caps for free-text fields. We trim at submit time and
// reject if over — keeps the email reasonable and rules out abuse.
const MAX_NAME = 160;
const MAX_RELATIONSHIP = 80;
const MAX_PLACE_DATE = 200;
const MAX_TRIBUTE = 1500; // ~250 words; comfortably above the 80-120 guidance

// Photo upload caps. Frontend enforces 4 MB raw before base64-encoding;
// we add a small server-side buffer to allow for the ~33% inflation
// the encoding produces, then reject anything over.
const MAX_PHOTO_RAW_BYTES = 4 * 1024 * 1024;             // 4 MB raw
const MAX_PHOTO_BASE64_LEN = Math.ceil(MAX_PHOTO_RAW_BYTES * 4 / 3) + 1024;

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
  // The obituary is a Guardian+ perk. UI hides the card for Clan tier;
  // this is the server-side enforcement so a determined poke at the
  // endpoint won't bypass the perk gate.
  if (!memberRow.tier || !ALLOWED_TIER_RE.test(memberRow.tier)) {
    return {
      statusCode: 403,
      headers,
      body: JSON.stringify({
        error: 'The memorial entry on /patrons is reserved for Guardian, Steward, and Life members.',
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

  const subjectName = String(data.subjectName || '').trim();
  const relationship = String(data.relationship || '').trim();
  const born = String(data.born || '').trim();
  const died = String(data.died || '').trim();
  const tribute = String(data.tribute || '').trim();

  if (!subjectName || !relationship || !tribute) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Please fill in name, relationship, and a few lines of tribute.' }),
    };
  }
  if (
    subjectName.length > MAX_NAME ||
    relationship.length > MAX_RELATIONSHIP ||
    born.length > MAX_PLACE_DATE ||
    died.length > MAX_PLACE_DATE ||
    tribute.length > MAX_TRIBUTE
  ) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'One of your entries is longer than allowed — please shorten and try again.' }) };
  }

  // Optional portrait photograph. Validated and, if present, attached to
  // the outbound email via the Resend attachments API (matches the
  // existing pattern in lib/publication-email.js).
  const photoIn = data.photo && typeof data.photo === 'object' ? data.photo : null;
  let photoAttachment = null;
  if (photoIn) {
    const contentType = typeof photoIn.contentType === 'string' ? photoIn.contentType : '';
    const dataBase64 = typeof photoIn.dataBase64 === 'string' ? photoIn.dataBase64 : '';
    const filename = typeof photoIn.filename === 'string' && photoIn.filename ? photoIn.filename : 'portrait';
    if (!contentType.startsWith('image/')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Photo must be an image (JPEG, PNG, HEIC).' }) };
    }
    if (!dataBase64) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Photo data missing.' }) };
    }
    if (dataBase64.length > MAX_PHOTO_BASE64_LEN) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Photo is too large. Please use a file under 4 MB.' }) };
    }
    // Best-effort sanity check the base64 actually decodes — defends against
    // a payload where the wrong field is base64-shaped but isn't a real image.
    // We don't try to validate the image bytes themselves; that's a job for
    // the editorial review when the attachment is opened.
    if (!/^[A-Za-z0-9+/=]+$/.test(dataBase64)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Photo data appears malformed.' }) };
    }
    photoAttachment = { filename, content: dataBase64 };
  }

  // ── Build the email ─────────────────────────────────────────────────────
  const subject = `🌿 Obituary submission — ${subjectName} (from ${memberRow.name || memberEmail})`;

  const photoNote = photoAttachment
    ? `<br><strong>Portrait photograph:</strong> attached to this email as <em>${esc(photoAttachment.filename)}</em>.`
    : `<br><strong>Next step:</strong> reply to the member to request the portrait photograph (none was attached).`;

  const html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Obituary submission — Clan Ó Comáin</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">A member has submitted a memorial entry for the clan's online roll at <a href="https://www.ocomain.org/patrons" style="color:#B8975A">ocomain.org/patrons</a>.${photoNote}</p>

    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Submitted by</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(memberRow.name || '—')}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(memberEmail)}" style="color:#B8975A">${esc(memberEmail)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member tier</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(memberRow.tier_label || memberRow.tier || '—')}</td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Member since</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(fmtDate(memberRow.joined_at))}</td></tr>
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">In memory of</h3>
    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">Name</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(subjectName)}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Relationship</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(relationship)}</td></tr>
      ${born ? `<tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Born</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(born)}</td></tr>` : ''}
      ${died ? `<tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Died</td><td style="padding:8px 10px;border:1px solid #e5dcc8">${esc(died)}</td></tr>` : ''}
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Tribute</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(tribute)}</div>

    <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the Members' Area obituary form. Reply directly to the member's email above${photoAttachment ? '' : ' to request the portrait photograph'}.</p>
  </div>`;

  // ── Send the email ──────────────────────────────────────────────────────
  try {
    const resendBody = {
      from: 'Clan Ó Comáin <clan@ocomain.org>',
      to: CLAN_EMAIL,
      reply_to: memberEmail,
      subject,
      html,
    };
    if (photoAttachment) resendBody.attachments = [photoAttachment];
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify(resendBody),
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
      event_type: 'obituary_submitted',
      payload:    {
        subject_name: subjectName,
        relationship,
        has_born: !!born,
        has_died: !!died,
        has_photo: !!photoAttachment,
        tribute_chars: tribute.length,
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
