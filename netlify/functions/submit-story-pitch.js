// netlify/functions/submit-story-pitch.js
//
// Public-facing story-pitch intake. Used by the modal on
// /clan-stories.html. Replaces the previous mailto: button that
// directed the writer to email clan@ocomain.org from their own
// client (broken in two ways: it bypassed the household routing
// convention by labelling the destination 'the Chief', and it
// required the visitor to have a configured mail client).
//
// Why public (not authenticated): the Stories page is the clan's
// public statement on the voices of the diaspora coming home.
// Some pitchers will be members; some will be considering joining
// after pitching; some will be writing from outside the membership
// entirely (journalists, family historians, scholars). All should
// be able to pitch through the same channel without first going
// through sign-in.
//
// This is editorial intake — not auto-publish. Stories on the
// public page require human curation (Chief reviews, OPS coordinates
// follow-up interview / portrait / lineage check). The mail to the
// Office is the start of that process, not the end.
//
// NOTE — this is a separate endpoint from submit-clan-story.js,
// which is the AUTHENTICATED, Steward+ only flow used by the
// dashboard 'Share Your Story' card. That existing flow is for
// confirmed paying members at the right tier submitting their
// short-form acknowledgement; this new public flow is for anyone
// pitching a longer piece or expressing interest from outside the
// dashboard. Both ultimately route to clan@ocomain.org for OPS
// triage, but the gating, validation, and audit-trail differ.
//
// Spam protection (mirrors submit-council-application):
//   - Honeypot field 'website' — bots fill it; humans don't see it.
//   - Length caps on every field.
//   - Origin allowlist via CORS header.
//
// Sends a structured email to clan@ocomain.org with reply_to set to
// the pitcher's address, so the OPS can reply directly.
//
// Routing convention — communication with the Chief is reserved
// and flows through the Office of the Private Secretary. The
// pitcher never receives a direct Chief reply; the OPS triages
// and replies on the Chief's behalf, escalating only as appropriate.

const { supa, clanId, logEvent } = require('./lib/supabase');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const CLAN_EMAIL = 'clan@ocomain.org';

// Soft caps — reject anything over.
const MAX_NAME = 160;
const MAX_EMAIL = 320; // RFC 5321 hard limit
const MAX_CONNECTION = 280; // 'how are you connected'
const MAX_MESSAGE = 4000; // ~700 words; comfortable for a pitch

// Connection labels. Optional field — pitchers may not know how to
// describe their relationship to the clan. The 'unsure' / empty
// values let them write in regardless. Real-world picks help the
// OPS triage (e.g. an existing member's pitch goes to a different
// queue than a journalist's enquiry).
const CONNECTION_LABELS = {
  '':                '(not stated)',
  'unsure':          'Not sure — open to a conversation',
  'member':          'I am a member of the clan',
  'descendant':      'I carry the line / a clan surname',
  'family':          'A family member of mine carries the line',
  'researcher':      'Researcher / family historian',
  'journalist':      'Journalist / writer',
  'other':           'Other',
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
    console.log('story-pitch: honeypot hit, silently dropping');
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  }

  const name = String(data.name || '').trim();
  const email = String(data.email || '').trim();
  const connection = String(data.connection || '').trim();
  const message = String(data.message || '').trim();

  if (!name || !email || !message) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Please fill in your name, email, and a brief account of the story you would like to share.' }),
    };
  }

  // Email format — light check, not RFC-perfect.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'That email address does not look right — please check and try again.' }) };
  }

  if (
    name.length > MAX_NAME ||
    email.length > MAX_EMAIL ||
    connection.length > MAX_CONNECTION ||
    message.length > MAX_MESSAGE
  ) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'One of your entries is longer than allowed — please shorten and try again.' }) };
  }

  const connectionLabel = CONNECTION_LABELS[connection] !== undefined ? CONNECTION_LABELS[connection] : connection;

  // ── Build the email ─────────────────────────────────────────────────────
  const subject = `Story pitch — ${name} · ${connectionLabel}`;

  const html = `<div style="font-family:Georgia,serif;max-width:620px;color:#3C2A1A">
    <h2 style="color:#0C1A0C;border-bottom:2px solid #B8975A;padding-bottom:10px;margin:0 0 18px">Story pitch — Clan Ó Comáin</h2>
    <p style="background:#f6efe3;border-left:3px solid #B8975A;padding:12px 14px;margin:0 0 22px;font-size:14px;line-height:1.6">A pitcher has submitted a story for editorial consideration via the public Stories page.<br><strong>Triage:</strong> Office of the Private Secretary.</p>

    <table style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:20px">
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;width:160px;font-size:12px">From</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(name)}</strong></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Reply to</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><a href="mailto:${esc(email)}" style="color:#B8975A">${esc(email)}</a></td></tr>
      <tr><td style="padding:8px 10px;border:1px solid #e5dcc8;color:#6C5A4A;font-size:12px">Connection</td><td style="padding:8px 10px;border:1px solid #e5dcc8"><strong>${esc(connectionLabel)}</strong></td></tr>
    </table>

    <h3 style="color:#0C1A0C;font-size:16px;margin:0 0 10px">Their pitch</h3>
    <div style="background:#faf6ec;border:1px solid #e5dcc8;padding:16px 18px;border-radius:2px;white-space:pre-wrap;font-size:14px;line-height:1.7">${esc(message)}</div>

    <p style="margin-top:24px;font-size:12px;color:#8F7A5E;font-style:italic">Submitted via the public Stories page (/clan-stories.html). Reply directly to the pitcher's email above.</p>
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
      event_type: 'story_pitch_submitted',
      payload:    {
        name,
        email,
        connection,
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
