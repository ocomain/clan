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
// SUBJECT: 'A note from {Inviter Full Name}'. Names the sender by
// their full name. The clan name is intentionally NOT in the
// subject — the From field already shows 'Clan Ó Comáin', so
// putting the clan in the subject again would be redundant and
// would push the sender's name back. The recipient should see
// '{Sender}' in their inbox preview, not '{Sender} — Clan Ó Comáin'.
//
// OPENING: leads with the sender's identity AS a member of Clan Ó
// Comáin and their direct intent — they would like the recipient
// to join them in the clan. The Herald narrates this on the
// member's behalf in standard warrant convention. The straight
// 'would like you to join them' phrasing makes the want explicit;
// earlier drafts had the more abstract 'has thought of you' which
// was felt to underplay the personal-invitation nature.
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

  const subject = `${inviterFirstName} would like you to stand with them in Clan Ó Comáin`;

  // Optional personal-note block. Sits at the top, above the clan
  // body, signed by the inviter. Renders only when personalNote is
  // a non-empty string after trim. Italic with a soft burgundy left
  // rule so it reads as 'spoken by the inviter' before the clan
  // body picks up.
  const personalNoteBlock = personalNote && personalNote.trim()
    ? `<div style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.7;padding:18px 22px;background:rgba(184,151,90,.08);border-left:3px solid #6B1F1F;margin:0 0 28px;border-radius:0 2px 2px 0">${escapeHtml(personalNote.trim())}<br><span style="font-size:13px;color:#6C5A4A;margin-top:8px;display:inline-block">— ${escapeHtml(inviterFirstName)}</span></div>`
    : '';

  // ── THE LOCKED EMAIL BODY ────────────────────────────────────────
  // VOICE: written as if {Inviter} has just been let into an old,
  // private circle and is now turning to a specific friend they
  // think belongs there too. Warm, not formal. Exclusive-club
  // register — a personal vouch, not a recruitment pitch. The
  // Herald is present at the sign-off because he composed the
  // wording (Gaelic warrant convention), but the FEELING
  // throughout is of {Inviter} reaching back to bring {Recipient}
  // along.
  //
  // Three short paragraphs:
  //   1. {Inviter} has lately taken a place and has thought of YOU
  //      among 'the small number they would wish to see standing
  //      with them'. Names the recipient as having been
  //      specifically chosen — this is not a bulk note.
  //   2. What this place is — a brief, dignified naming of the
  //      clan, kept short because the recipient already has
  //      {Inviter}'s vouch. Membership framed as 'by design, a
  //      quiet thing' — exclusive register without saying so.
  //   3. {Inviter} would have you among them. Door, opened.
  //      A friend on the other side. No pressure.
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:560px;margin:0 auto;background:#F8F4EC">

  <!-- Header. Eyebrow reads 'By private welcome' (exclusive-club
       register) and the headline frames this as a personal gesture
       from {Inviter} keeping a place open — not an institution
       writing to a prospect. -->
  <div style="background:#0C1A0C;padding:34px 40px 26px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="${SITE_URL}/coat_of_arms.png" width="72" alt="Ó Comáin" style="display:block;margin:0 auto 8px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 14px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">By private welcome</p>
    <h1 style="font-family:'Georgia',serif;font-size:24px;font-weight:400;color:#D4B87A;margin:0;line-height:1.25">${escapeHtml(inviterFirstName)} has kept a place beside them for you</h1>
  </div>

  <!-- Body — friend-voicing throughout, locked text below. -->
  <div style="padding:32px 38px">

    ${personalNoteBlock}

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      Dia dhuit, ${escapeHtml(recipFirst)} — God be with you.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      ${escapeHtml(inviterFull)} has lately taken a place in Clan Ó Comáin and has thought of you among the small number they would wish to see standing with them — and has asked me, as Herald, to write to you in their stead.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      The clan is an ancient royal house of the Ó Comáin name and its many forms — Cummins, Commane, Commons, Comyn, Hurley, and others. After many centuries of silence it has been formally revived, recognised by Clans of Ireland in 2025 under the patronage of the President of Ireland. Membership is, by design, a quiet thing: a place in the Register at Newhall House, a certificate sealed in your own name, and the company of those who feel the pull of something old and worth keeping.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 28px">
      ${escapeHtml(inviterFirstName)} would have you among them. There is no urgency in it, and no obligation in receiving this note — only the door, opened, and a friend on the other side of it.
    </p>

    <!-- Single CTA. Burgundy block, central, foregrounds the
         inviter's name in the action ('beside {Inviter}'). -->
    <div style="text-align:center;margin:6px 0 28px">
      <a href="${SITE_URL}/membership.html" style="display:inline-block;background:#6B1F1F;color:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none;padding:16px 32px;border-radius:1px;border:1px solid #4A1010">Take a place beside ${escapeHtml(inviterFirstName)} →</a>
    </div>

    <!-- Sign-off — Herald-voiced single line. The inviter is in
         the body throughout; the signature is the Herald who
         composed the words, in the Gaelic warrant convention. -->
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
      You received this because ${escapeHtml(inviterFirstName)} thought of you. <a href="${unsubscribeUrl}" style="color:#C8A875;text-decoration:underline">Unsubscribe from invitations</a>
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
