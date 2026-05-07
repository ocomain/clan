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
 * If the sponsor already holds a sponsorship title, the salutation
 * acknowledges that dignity using the 'Title FirstName' convention
 * (like 'Sir John' for a knight) — e.g. 'Dia dhuit, Cara James'.
 * This is the salutation form; the full record-form 'James Comyn,
 * Cara of Ó Comáin' is reserved for the dashboard's Held in Honour
 * row and the honours-page example. Salutations are warmer and
 * tighter.
 *
 * @param {object} sponsor      — { email, name, sponsorTitle? }
 * @param {object} newMember    — { name, display_name_on_register }
 * @param {object|null} sponsorTitle — title definition object
 *                                     (Cara/Ardchara/Onóir) if the
 *                                     sponsor holds one, else null.
 *                                     Caller should pass
 *                                     highestAwardedTitle(sponsor.
 *                                     sponsor_titles_awarded).
 */
async function sendSponsorLetter(sponsor, newMember, sponsorTitle) {
  if (!sponsor?.email) return false;
  const newName = (newMember?.display_name_on_register || newMember?.name || 'A new member').trim();
  const subject = `${newName} has taken their place — through you`;
  const html = buildSponsorLetterHtml({ sponsor, newMember, sponsorTitle });

  return await sendEmail({
    to: sponsor.email,
    subject,
    html,
  });
}

/**
 * buildSponsorLetterHtml — HTML-only builder for the sponsor letter
 * (the email a sponsor receives when one of their invitees converts
 * to membership). Exposed for the email-review preview tooling.
 */
function buildSponsorLetterHtml({ sponsor, newMember, sponsorTitle }) {
  const sponsorFirst = (sponsor.name || sponsor.email || '').trim().split(/\s+/)[0] || 'friend';
  // Title-aware greeting: 'Dia dhuit, Cara James' if title held,
  // 'Dia dhuit, James' otherwise. The Title-FirstName form mirrors
  // the chivalric 'Sir John' convention.
  const greetingAddress = sponsorTitle
    ? `${sponsorTitle.irish} ${sponsorFirst}`
    : sponsorFirst;
  // Use the sealed display name if we have it (covers family-tier
  // entries like 'Mary Cummins & Family'); otherwise fall back to
  // the bare name.
  const newName = (newMember?.display_name_on_register || newMember?.name || 'A new member').trim();

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:560px;margin:0 auto;background:#F8F4EC">

  ${emailHeader('A note from Newhall', 'Through your welcome')}

  <div style="padding:32px 38px">

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      Dia dhuit, ${escapeHtml(greetingAddress)} — God be with you.
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
}

/**
 * The Title Awarded letter — sent once per threshold crossing.
 *
 * Voice notes (chivalric warrant register, raising-and-replacement
 * model — like an Order of Chivalry, NOT like peerage):
 *
 *   - The CHIEF is the actor throughout the body. The Herald
 *     composes the letter (Gaelic warrant convention) and signs
 *     at the foot. Fergus's name is not used directly — he is
 *     'the Chief', the office, in the same way real warrants
 *     reference the office rather than the personal name.
 *
 *   - Every title is a RAISING. Cara is the first raising into
 *     honour from no-title. Ardchara is a raising from Cara
 *     ('high friend' — morphologically extends Cara). Onóir is
 *     a raising from Ardchara to the highest dignity (the apex
 *     register shift: friendship-tier → ceremonial honour).
 *     The lower title is LAID BY (set down) when the higher is
 *     taken up — chivalric replacement model, not peerage
 *     accretion. KBE replaces CBE; CBE replaces MBE; MBE
 *     replaces no-title.
 *
 *   - Gravity scales with the dignity: Cara is warm, Ardchara
 *     is a measured raising-in-rank with the friendship-tier
 *     deepening, Onóir is the formal 'It hath pleased'
 *     chivalric warrant of advancement to the highest rank,
 *     with the henceforth-clause and the 'place and standing
 *     belonging to that rank' privilege-clause.
 *
 *   - 'Title' is used throughout, NEVER 'name'. The user's name
 *     is what their parents gave them. The TITLE is what the
 *     Chief confers. (Earlier draft confused these — fixed.)
 *
 *   - Closes with 'Le toil an Taoisigh — by the will of the
 *     Chief' (a brief Irish flourish in the Gaelic warrant
 *     tradition) above the Herald sign-off.
 *
 * @param {object} sponsor             — { email, name }
 * @param {object} title               — full title definition from
 *                                       SPONSOR_TITLES, with each
 *                                       per-title language field a
 *                                       function of priorTitleIrish
 * @param {string|null} priorTitleIrish — Irish form of the title
 *                                       the member held BEFORE
 *                                       this raising, or null if
 *                                       this is the first raising
 *                                       (i.e. they held no title).
 *                                       Drives the 'from {prior}'
 *                                       clauses throughout.
 * @param {number} totalCount          — current converted-invite
 *                                       count (available for
 *                                       future use; copy currently
 *                                       names counts inline in
 *                                       bodyOpening per title).
 */
async function sendTitleAwardLetter(sponsor, title, priorTitleIrish, totalCount) {
  if (!sponsor?.email || !title) return false;
  const subject = title.subjectLine(priorTitleIrish);
  const html = buildTitleAwardLetterHtml({ sponsor, title, priorTitleIrish, totalCount });

  return await sendEmail({
    to: sponsor.email,
    subject,
    html,
  });
}

/**
 * buildTitleAwardLetterHtml — HTML-only builder for the
 * title-award letter (the chivalric warrant raising a sponsor to
 * Cara, Ardchara, or Onóir). Exposed for the email-review preview
 * tooling.
 */
function buildTitleAwardLetterHtml({ sponsor, title, priorTitleIrish, totalCount }) {
  const sponsorFirst = (sponsor.name || sponsor.email || '').trim().split(/\s+/)[0] || 'friend';

  // The greeting addresses the recipient by the NEW title being
  // conferred. The letter IS the moment of bestowal, and from the
  // moment they read it they bear the new dignity. So 'Dia dhuit,
  // Onóir James' is correct on the letter raising James to Onóir,
  // and 'Dia dhuit, Cara James' on the letter conferring Cara
  // (their first raising). Reads consistently across all three
  // titles whether it's a first raising or a raising-from-prior.
  const greetingAddress = `${title.irish} ${sponsorFirst}`;

  // Resolve the per-title language by calling each template
  // function with the prior-title argument. Each function returns
  // the right form for first-raising vs raising-from-prior.
  const bodyOpening      = title.bodyOpening(priorTitleIrish);
  const bestowalIntro    = title.bestowalIntro(priorTitleIrish);
  const replacementText  = title.replacementSentence(priorTitleIrish); // null for Cara, or for any first-raising

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:560px;margin:0 auto;background:#F8F4EC">

  ${emailHeader(title.eyebrow, title.headline)}

  <div style="padding:32px 38px">

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      Dia dhuit, ${escapeHtml(greetingAddress)} — God be with you.
    </p>

    <!-- Opening paragraph: narrates the Chief's act, names the
         count, and (for non-first raisings) names the previous
         dignity being laid by. Per-title bodyOpening is a
         function of priorTitleIrish. -->
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 24px">
      ${escapeHtml(bodyOpening)}
    </p>

    <!-- The bestowal block — the ceremonial centrepiece. The
         small-caps line carries the per-title bestowal verb
         ('It pleases the Chief to raise you from Onóir to the
         dignity of', or for Ardchara 'It hath pleased the Chief
         to raise you from Onóir to the dignity of'). Visually
         set apart with thin gold rules so the title reads as a
         moment rather than a sentence. -->
    <div style="text-align:center;padding:22px 18px;margin:0 0 24px;border-top:1px solid rgba(184,151,90,.4);border-bottom:1px solid rgba(184,151,90,.4);background:rgba(184,151,90,.05)">
      <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#8B6F32;margin:0 0 12px;line-height:1.5">${escapeHtml(bestowalIntro)}</p>
      <p style="font-family:'Georgia',serif;font-size:32px;font-weight:400;color:#1A0A0A;margin:0 0 4px;line-height:1.15">${escapeHtml(title.irish)}</p>
      <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;margin:0">${escapeHtml(title.pronunciation)} — ${escapeHtml(title.english)}</p>
    </div>

    <!-- Closing narrative beat — what this dignity means in the
         clan. Single sentence, drawn from title.closingNarrative.
         Constant per title (doesn't depend on prior). -->
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 ${replacementText ? '18' : '24'}px">
      ${escapeHtml(title.closingNarrative)}
    </p>

    ${replacementText ? `<!-- Replacement sentence — the chivalric 'laid by / taken
         up' formulation. Names what's happening to the prior
         dignity. Only present for raisings from a prior title;
         omitted on first raisings (where there's nothing to lay
         by). -->
    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.85;margin:0 0 24px">
      ${escapeHtml(replacementText)}
    </p>` : ''}

    <!-- Members-area CTA — the title-conferral download landing
         point. The button label uses 'title conferral' (plain
         wayfinding any reader parses) rather than 'letters patent'
         (heritage register but obscure to most contemporary
         readers, especially outside the UK/Ireland). The italic
         subtitle beneath teaches the formal name in context: the
         dashboard download IS the letters patent, just under
         clearer wayfinding for the email moment. The button is
         deliberately understated (gold-bordered outline, not a
         filled CTA) to fit the dignified register; the email is
         a chivalric warrant first, a transactional notification
         second. -->
    <div style="text-align:center;margin:0 0 28px">
      <a href="https://www.ocomain.org/members#held-in-honour" style="display:inline-block;font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:600;letter-spacing:0.16em;text-transform:uppercase;color:#8B6F32;text-decoration:none;border:1px solid #8B6F32;padding:10px 22px;border-radius:2px">Download title conferral in members area &rarr;</a>
      <div style="font-family:'Georgia',serif;font-size:13.5px;font-style:italic;color:#6C5A4A;line-height:1.6;margin-top:10px">issued under the Chief\u2019s seal as letters patent</div>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.85;margin:0 0 28px">
      Your title is held quietly with the Chief and the Herald — recorded in the clan\u2019s keeping at Newhall. There is no fanfare to it; only the recognition of what you have done, in the company of those who do likewise.
    </p>

    <!-- Irish flourish above the Herald sign-off: 'Le toil an
         Taoisigh' — by the will of the Chief. The phrase stands
         on its own and the English meaning is given for those
         who don't read Irish. Pronunciation NOT included in the
         email body itself (would break the gravity). -->
    <p style="font-family:'Georgia',serif;font-size:13.5px;color:#6C5A4A;line-height:1.6;margin:0 0 4px;text-align:center;font-style:italic">
      Le toil an Taoisigh — by the will of the Chief
    </p>
    ${heraldSignoff()}

  </div>

  ${emailFooter()}

</div>
</body>
</html>`;
}

module.exports = {
  sendSponsorLetter,
  sendTitleAwardLetter,
  buildSponsorLetterHtml,
  buildTitleAwardLetterHtml,
};
