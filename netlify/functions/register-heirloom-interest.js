// netlify/functions/register-heirloom-interest.js
//
// POST /api/register-heirloom-interest with Authorization: Bearer <jwt>
//
// A member who's seen the heirloom-edition modal and clicked
// "Register my interest" lands here. We log the event (so the Office
// can pull a list of interested members later) and send a small
// notification to the clan inbox so the Office sees it land.
//
// No schema change needed: we use the existing event_log table via
// logEvent() with event_type='heirloom_interest_registered'. The note
// the member optionally typed lives in the payload.
//
// USAGE (from dashboard JS):
//   fetch('/api/register-heirloom-interest', {
//     method: 'POST',
//     headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
//     body: JSON.stringify({ note: 'optional free text' }),
//   });
//
// RESPONSE: JSON {"recorded":true} on success, error object on failure.

const { supa, clanId, logEvent } = require('./lib/supabase');
const { highestAwardedTitle } = require('./lib/sponsor-service');
const { sendEmail } = require('./lib/email');

const NOTIFY_TO = 'clan@ocomain.org';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization;
  const token = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Missing Authorization header' }) };
  }

  const { data: authData, error: authErr } = await supa().auth.getUser(token);
  if (authErr || !authData?.user) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Invalid or expired token' }) };
  }
  const authUser = authData.user;

  let body = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'invalid_json' }) };
  }
  // Cap the note at 1000 chars — anything longer is almost certainly
  // not a sincere note and could be abused for storage padding.
  const note = (body.note || '').toString().trim().slice(0, 1000);

  try {
    const clan_id = await clanId();

    // Look up the member.
    let { data: member } = await supa()
      .from('members')
      .select('id, email, name, sponsor_titles_awarded')
      .eq('clan_id', clan_id)
      .eq('auth_user_id', authUser.id)
      .maybeSingle();

    if (!member) {
      const email = (authUser.email || '').toLowerCase().trim();
      if (email) {
        const fallback = await supa()
          .from('members')
          .select('id, email, name, sponsor_titles_awarded')
          .eq('clan_id', clan_id)
          .eq('email', email)
          .maybeSingle();
        member = fallback.data;
      }
    }

    if (!member) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Member not found' }) };
    }

    // Log the event for the Office's later reporting.
    const dignity = highestAwardedTitle(member.sponsor_titles_awarded);
    await logEvent({
      clan_id,
      member_id: member.id,
      event_type: 'heirloom_interest_registered',
      payload: {
        dignity_slug: dignity ? dignity.slug : null,
        dignity_irish: dignity ? dignity.irish : null,
        note: note || null,
      },
    });

    // Quiet notification to the Office. Best-effort — if it fails,
    // the event log captures the interest regardless. So we wrap
    // the email send in its own try/catch and always return success
    // to the member.
    try {
      const dignityName = dignity ? `${dignity.irish} of \u00d3 Com\u00e1in` : 'Member';
      const memberLine = `${member.name || '(unnamed)'} (${member.email})`;
      const subject = `Heirloom edition interest: ${memberLine}`;
      const html = `
        <p>A member has registered interest in the framed heirloom edition of their letters patent.</p>
        <p><strong>Member:</strong> ${escapeHtml(memberLine)}<br>
        <strong>Dignity:</strong> ${escapeHtml(dignityName)}</p>
        ${note ? `<p><strong>Their note:</strong></p><blockquote style="border-left:3px solid #ccc;padding-left:12px;margin-left:0;font-style:italic;color:#555">${escapeHtml(note)}</blockquote>` : '<p><em>No note provided.</em></p>'}
        <p style="font-size:12px;color:#888">Logged via /api/register-heirloom-interest. Member ID: ${member.id}</p>
      `;
      await sendEmail({
        to: NOTIFY_TO,
        subject,
        html,
        from: 'Clan \u00d3 Com\u00e1in <clan@ocomain.org>',
      });
    } catch (notifyErr) {
      console.error('heirloom interest notification email failed (non-fatal):', notifyErr.message);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recorded: true }),
    };
  } catch (err) {
    console.error('register-heirloom-interest crashed:', err.message, err.stack);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Could not record interest', message: err.message }),
    };
  }
};

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
