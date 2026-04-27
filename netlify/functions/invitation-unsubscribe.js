// netlify/functions/invitation-unsubscribe.js
//
// Public unsubscribe endpoint for invitation recipients. Hit via
// GET from the email's footer link:
//
//   /.netlify/functions/invitation-unsubscribe?id={invitationId}&t={token}
//
// The token is HMAC(invitationId, secret); verifying it confirms
// the request came from a legitimate invitation we sent (not a
// random user typing URLs).
//
// Behaviour:
//   - GET with valid id+t → adds the recipient_email to
//     invitation_unsubscribes (idempotent), updates the
//     invitation row's status to 'unsub', responds with a
//     simple HTML confirmation page (no design heroics — just
//     a clear 'you have unsubscribed' message).
//   - GET with bad/missing token or non-existent id → 404 HTML
//     ('this link is no longer valid'). Don't reveal whether the
//     id exists; just refuse cleanly.
//   - Any other method → 405

const { supa } = require('./lib/supabase');
const crypto = require('crypto');

const UNSUB_SECRET = process.env.UNSUB_SECRET || process.env.STRIPE_WEBHOOK_SECRET || 'fallback-secret-change-me';

function signUnsubToken(invitationId) {
  return crypto.createHmac('sha256', UNSUB_SECRET).update(invitationId).digest('hex').slice(0, 32);
}

// Constant-time compare to avoid timing attacks on the token.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

const HTML_OK = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed — Clan Ó Comáin</title><meta name="robots" content="noindex,nofollow"><style>body{font-family:Georgia,serif;background:#F8F4EC;color:#1A1410;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}.card{max-width:480px;text-align:center;background:#fff;border:1px solid rgba(184,151,90,.35);border-top:3px solid #B8975A;padding:38px 32px;border-radius:2px;box-shadow:0 4px 18px rgba(20,5,5,.06)}h1{font-family:"Cormorant Garamond",Georgia,serif;font-size:32px;font-weight:500;margin:0 0 12px;color:#1A1410}p{font-size:16px;line-height:1.7;color:#3D2D1F;margin:0 0 12px}.foot{font-style:italic;color:#8B6F32;font-size:13px;margin-top:24px}</style></head><body><div class="card"><h1>You have been unsubscribed</h1><p>This email address will not receive further invitations from any member of Clan Ó Comáin.</p><p>If this was a mistake, simply ask the friend who invited you to send another note.</p><p class="foot">— Clan Herald at Newhall</p></div></body></html>`;

const HTML_BAD = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link no longer valid — Clan Ó Comáin</title><meta name="robots" content="noindex,nofollow"><style>body{font-family:Georgia,serif;background:#F8F4EC;color:#1A1410;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px}.card{max-width:480px;text-align:center;background:#fff;border:1px solid rgba(184,151,90,.35);border-top:3px solid #6B1F1F;padding:38px 32px;border-radius:2px;box-shadow:0 4px 18px rgba(20,5,5,.06)}h1{font-family:"Cormorant Garamond",Georgia,serif;font-size:28px;font-weight:500;margin:0 0 12px;color:#6B1F1F}p{font-size:15px;line-height:1.65;color:#3D2D1F;margin:0 0 10px}a{color:#B8975A}</style></head><body><div class="card"><h1>This link is no longer valid</h1><p>If you wish to opt out of future invitations, please write to <a href="mailto:clan@ocomain.org">clan@ocomain.org</a> and we will see to it directly.</p></div></body></html>`;

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const params = event.queryStringParameters || {};
  const id = (params.id || '').trim();
  const t = (params.t || '').trim();

  if (!id || !t) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: HTML_BAD,
    };
  }

  const expectedToken = signUnsubToken(id);
  if (!safeEqual(expectedToken, t)) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: HTML_BAD,
    };
  }

  // Token valid — fetch the invitation and act on it.
  const { data: invitation, error: lookupErr } = await supa()
    .from('invitations')
    .select('id, recipient_email, status')
    .eq('id', id)
    .maybeSingle();

  if (lookupErr || !invitation) {
    // Either gone or never existed — generic refusal.
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
      body: HTML_BAD,
    };
  }

  // Idempotent: if already unsubbed, just show success again.
  // No side effects on a duplicate hit.
  const recipientEmail = (invitation.recipient_email || '').toLowerCase().trim();

  // Insert into the unsub table (upsert by primary key)
  await supa()
    .from('invitation_unsubscribes')
    .upsert({ email: recipientEmail }, { onConflict: 'email' });

  // Update this invitation row's status (best-effort)
  await supa()
    .from('invitations')
    .update({ status: 'unsub', responded_at: new Date().toISOString() })
    .eq('id', id);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: HTML_OK,
  };
};
