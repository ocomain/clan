// netlify/functions/lib/invitation-email.js
//
// Sends the invitation email when a member uses the invite-a-friend
// feature. Hybrid voicing per the spec:
//
//   - The MAIN body is in the clan's voice (Herald-narrated, same
//     register as the founder welcome email but warmer and shorter
//     — this is a personal-introduction email, not a formal warrant).
//
//   - If the inviting member added a personal note (one line, capped),
//     it sits ABOVE the clan body in italic, attributed to the
//     inviter by name. Reads as: 'a personal word from {Inviter},
//     and then the clan introducing itself'.
//
// FROM-FIELD: 'Clan Ó Comáin <clan@ocomain.org>' (default — no
// override). Recipients should see the clan name in their inbox,
// not the inviter's name. Two reasons:
//   1. Spam-filter trust — the clan domain is a verified Resend
//      sender; spoofing the inviter's display name would land in
//      spam more often.
//   2. Set-expectations — the recipient is being introduced to a
//      clan, not getting a personal note from a friend pretending
//      to be the friend's organisation.
//
// SUBJECT: includes the inviter's first name, naming the recipient
// — 'A note from {Inviter} — Clan Ó Comáin'. Personal enough to
// open, formal enough to recognise the institutional source.
//
// LINK: /invitation?token={token} where the token is signed via
// HMAC of the invitation row id + secret. The link routes to a
// landing page that previews the clan and offers 'Take a place →'
// (forwards to /membership.html).

const { sendEmail } = require('./email');

const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

/**
 * Send an invitation email.
 *
 * @param {Object} opts
 * @param {string} opts.recipientEmail
 * @param {string} opts.recipientName    - first name preferred for greeting
 * @param {string} opts.inviterName      - the inviting member's full name
 * @param {string} opts.inviterFirstName - convenience first name from inviterName
 * @param {string} [opts.personalNote]   - optional one-line note (200 char max)
 * @param {string} opts.invitationId     - uuid for unsub link tokenisation
 * @param {string} opts.unsubscribeUrl   - pre-built unsubscribe URL
 * @returns {Promise<boolean>}
 */
async function sendInvitation({
  recipientEmail,
  recipientName,
  inviterName,
  inviterFirstName,
  personalNote,
  invitationId,
  unsubscribeUrl,
}) {
  const recipFirst = (recipientName || '').trim().split(/\s+/)[0] || 'friend';
  const inviterFull = (inviterName || '').trim() || inviterFirstName || 'a member of the clan';

  const subject = `A note from ${inviterFirstName} — Clan Ó Comáin`;

  // Optional personal-note block. Sits at the top, above the clan
  // body, signed by the inviter. Renders only when personalNote is
  // a non-empty string after trim. Italic with a soft burgundy left
  // rule so it reads as 'spoken by the inviter' before the clan
  // body picks up.
  const personalNoteBlock = personalNote && personalNote.trim()
    ? `<div style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.7;padding:18px 22px;background:rgba(184,151,90,.08);border-left:3px solid #6B1F1F;margin:0 0 28px;border-radius:0 2px 2px 0">${escapeHtml(personalNote.trim())}<br><span style="font-size:13px;color:#6C5A4A;margin-top:8px;display:inline-block">— ${escapeHtml(inviterFirstName)}</span></div>`
    : '';

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:560px;margin:0 auto;background:#F8F4EC">

  <!-- Header — quieter than the founder email since this is an
       introduction, not a warrant. Coat of arms, eyebrow, simple
       framing line. -->
  <div style="background:#0C1A0C;padding:34px 40px 26px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="${SITE_URL}/coat_of_arms.png" width="72" alt="Ó Comáin" style="display:block;margin:0 auto 8px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 14px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">An invitation</p>
    <h1 style="font-family:'Georgia',serif;font-size:24px;font-weight:400;color:#D4B87A;margin:0;line-height:1.2">For ${escapeHtml(recipFirst)}, from ${escapeHtml(inviterFirstName)}</h1>
  </div>

  <!-- Body -->
  <div style="padding:32px 38px">

    ${personalNoteBlock}

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 16px">
      Dia dhuit, ${escapeHtml(recipFirst)} — God be with you.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 16px">
      ${escapeHtml(inviterFull)}, a member of Clan Ó Comáin, has thought of you and has asked us to write. The clan is an ancient royal house of the Ó Comáin name — Cummins, Commane, Commons, Comyn, Hurley, and many other variants — recognised by Clans of Ireland in 2025 under the patronage of the President of Ireland. After many centuries of silence, it has begun again. Members are entered in the Register at Newhall House, County Clare, and receive a certificate of membership in their own name.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 26px">
      You are most welcome to read of the clan and, if it speaks to you, take a place of your own. There is no obligation in receiving this note — only an invitation, freely given.
    </p>

    <!-- Single CTA. Burgundy, central. -->
    <div style="text-align:center;margin:6px 0 28px">
      <a href="${SITE_URL}/membership.html" style="display:inline-block;background:#6B1F1F;color:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none;padding:16px 32px;border-radius:1px;border:1px solid #4A1010">Read of the clan →</a>
    </div>

    <!-- Sign-off block — Herald-voiced, single line. Same convention
         as the founder email; readers who recognise it will read
         the consistent voice across surfaces. -->
    <p style="font-family:'Georgia',serif;font-size:13.5px;color:#6C5A4A;line-height:1.6;margin:0;text-align:center;font-style:italic">
      — Clan Herald at Newhall
    </p>

  </div>

  <!-- Footer — motto + unsubscribe -->
  <div style="background:#0C1A0C;padding:22px 38px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12.5px;font-style:italic;color:#C8A875;margin:0 0 12px">
      Caithfidh an stair a bheith i réim — History must prevail
    </p>
    <p style="font-family:'Georgia',sans-serif;font-size:10.5px;color:rgba(200,168,117,.7);margin:0;line-height:1.55">
      You received this because ${escapeHtml(inviterFirstName)} thought you'd like to know. <a href="${unsubscribeUrl}" style="color:#C8A875;text-decoration:underline">Unsubscribe from invitations</a>
    </p>
  </div>

</div>
</body>
</html>`;

  return await sendEmail({
    to: recipientEmail,
    subject,
    html,
  });
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendInvitation };
