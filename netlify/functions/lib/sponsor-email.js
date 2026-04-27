// netlify/functions/lib/sponsor-email.js
//
// Two Herald-voiced emails sent to sponsors:
//
//   1. sendSponsorLetter(sponsor, newMember)
//      Fires every time an invitee converts (publishes their cert).
//      Short, warm, signed — names the new member, frames the
//      moment as 'their name now stands beside yours'.
//
//   2. sendTitleAwardLetter(sponsor, title, totalCount)
//      Fires once per threshold crossing (1 / 5 / 15). Names the
//      Gaelic title, gives the English meaning + pronunciation,
//      and includes a one-sentence narrative beat from the title
//      definition in sponsor-service.js.
//
// VOICE CONSISTENCY:
//   - From-field always 'Clan Ó Comáin <clan@ocomain.org>'
//     (institutional sender; Herald sign-off in body)
//   - Sign-off: '— Clan Herald at Newhall' (single line)
//   - Greeting: 'Dia dhuit, {firstName} — God be with you.'
//   - Footer: clan motto + Newhall location
//   - Same coat-of-arms header treatment as the founder welcome
//     and invitation emails

const { sendEmail } = require('./email');

const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Common header used by both templates — matches the visual chrome
// of the other Herald-voiced emails (founder welcome, invitation)
// so the recipient experiences a consistent voice across surfaces.
function emailHeader(eyebrow, headline) {
  return `<div style="background:#0C1A0C;padding:34px 40px 26px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="${SITE_URL}/coat_of_arms.png" width="72" alt="Ó Comáin" style="display:block;margin:0 auto 8px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 14px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">${escapeHtml(eyebrow)}</p>
    <h1 style="font-family:'Georgia',serif;font-size:24px;font-weight:400;color:#D4B87A;margin:0;line-height:1.25">${escapeHtml(headline)}</h1>
  </div>`;
}

// Common footer — motto + location.
function emailFooter() {
  return `<div style="background:#0C1A0C;padding:22px 38px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12.5px;font-style:italic;color:#C8A875;margin:0">
      Caithfidh an stair a bheith i réim — History must prevail
    </p>
    <p style="font-family:'Georgia',sans-serif;font-size:10.5px;color:rgba(200,168,117,.7);margin:8px 0 0;line-height:1.55">
      Clan Ó Comáin · Newhall House · Co. Clare
    </p>
  </div>`;
}

// Short Herald sign-off, single line, italic, centred.
function heraldSignoff() {
  return `<p style="font-family:'Georgia',serif;font-size:13.5px;color:#6C5A4A;line-height:1.6;margin:6px 0 0;text-align:center;font-style:italic">
      — Clan Herald at Newhall
    </p>`;
}

/**
 * The Sponsor's Letter — sent every time a member's invitee
 * converts (publishes their cert). Short, warm, names the new
 * member and frames the moment in terms of 'their name now stands
 * beside yours.'
 *
 * @param {object} sponsor    — { email, name }
 * @param {object} newMember  — { name, display_name_on_register }
 */
async function sendSponsorLetter(sponsor, newMember) {
  if (!sponsor?.email) return false;
  const sponsorFirst = (sponsor.name || sponsor.email).trim().split(/\s+/)[0] || 'friend';
  // Use the sealed display name if we have it (covers family-tier
  // entries like 'Mary Cummins & Family'); otherwise fall back to
  // the bare name.
  const newName = (newMember?.display_name_on_register || newMember?.name || 'A new member').trim();

  const subject = `${newName} has taken their place — through you`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:560px;margin:0 auto;background:#F8F4EC">

  ${emailHeader('A note from Newhall', 'Through your welcome')}

  <div style="padding:32px 38px">

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      Dia dhuit, ${escapeHtml(sponsorFirst)} — God be with you.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      <strong>${escapeHtml(newName)}</strong> has lately taken their place in the Register at Newhall. They came to the clan through your welcome — and their name now stands beside yours among the kindred.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 22px">
      The Chief is grateful for what you bring to the clan. So am I.
    </p>

    ${heraldSignoff()}

  </div>

  ${emailFooter()}

</div>
</body>
</html>`;

  return await sendEmail({
    to: sponsor.email,
    subject,
    html,
  });
}

/**
 * The Title Awarded letter — sent once per threshold crossing.
 *
 * @param {object} sponsor  — { email, name }
 * @param {object} title    — { irish, english, pronunciation,
 *                              threshold, narrative } from
 *                              SPONSOR_TITLES
 * @param {number} totalCount — current count of converted invites
 */
async function sendTitleAwardLetter(sponsor, title, totalCount) {
  if (!sponsor?.email || !title) return false;
  const sponsorFirst = (sponsor.name || sponsor.email).trim().split(/\s+/)[0] || 'friend';

  const subject = `Among the kindred, you are now ${title.irish}`;

  // The body is structured as a small ceremonial moment:
  //   - greeting
  //   - the count beat ('You have brought N to the clan')
  //   - the title bestowing line ('We name you {Irish} — {English}')
  //   - the title's narrative beat (one sentence about what this
  //     title means, from sponsor-service.js)
  //   - sign-off
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:560px;margin:0 auto;background:#F8F4EC">

  ${emailHeader('A title bestowed', `You are named ${title.irish}`)}

  <div style="padding:32px 38px">

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      Dia dhuit, ${escapeHtml(sponsorFirst)} — God be with you.
    </p>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 22px">
      ${escapeHtml(title.narrative)}
    </p>

    <!-- Title bestowal block — the ceremonial centrepiece. Set
         apart visually so the title itself reads as a moment
         rather than a sentence. -->
    <div style="text-align:center;padding:22px 18px;margin:0 0 24px;border-top:1px solid rgba(184,151,90,.4);border-bottom:1px solid rgba(184,151,90,.4);background:rgba(184,151,90,.05)">
      <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.24em;text-transform:uppercase;color:#8B6F32;margin:0 0 8px">In the keeping of the clan, you are now</p>
      <p style="font-family:'Georgia',serif;font-size:30px;font-weight:400;color:#1A0A0A;margin:0 0 4px;line-height:1.15">${escapeHtml(title.irish)}</p>
      <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;margin:0">${escapeHtml(title.pronunciation)} — ${escapeHtml(title.english)}</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 22px">
      Your title is held quietly with the Chief and the Herald — recorded in the clan's keeping at Newhall. There is no fanfare to it; only the recognition of what you have done, in the company of those who do likewise.
    </p>

    ${heraldSignoff()}

  </div>

  ${emailFooter()}

</div>
</body>
</html>`;

  return await sendEmail({
    to: sponsor.email,
    subject,
    html,
  });
}

module.exports = {
  sendSponsorLetter,
  sendTitleAwardLetter,
};
