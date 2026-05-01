// netlify/functions/lib/founder-email.js
//
// Sends the founder welcome email when Fergus (via Linda's admin tool)
// gifts a founding membership to one of his ~100+ network. The email
// is the centrepiece of the entire founder-admin-tool workflow — every
// other piece (the auth-gating, the form UI, the send endpoint) exists
// to deliver this one message to the right person at the right moment.
//
// VOICE AND DESIGN DECISIONS — locked across many iterations of
// drafting in chat. Do not modify the locked copy below without
// re-running it past Antoin first; every paragraph has rationale.
//
//   FROM-FIELD: 'Fergus Commane <clan@ocomain.org>' — display name is
//   Fergus's, mailbox is the clan inbox. Recipients in his network
//   recognise his name in their inbox where the clan name might land
//   as institutional. Set explicitly via the from override on
//   sendEmail (which defaults to 'Clan Ó Comáin <...>').
//
//   SIGN-OFF: '— Clan Herald at Newhall'. Single line, Herald-voiced.
//   Fergus's name is in the From-field and named throughout the body
//   ('I write at the wish of Fergus Commane'); the signature is just
//   the Herald, who composed the letter on Fergus's behalf in the
//   Gaelic warrant convention. Honest about the form.
//
//   AUDIENCE: three groups receive THE SAME EMAIL — (1) ~60 who
//   filled in the older Tally-form signup and got membership numbers,
//   newsletter, etc; (2) some who Fergus invited but didn't act; (3)
//   the rest: brand new to the clan. The copy handles all three
//   gracefully — see the 'as the clan has grown' paragraph which
//   addresses previously-engaged recipients explicitly without
//   alienating brand-new ones.
//
//   URGENCY: explicit '—but the new platform keeps no record from the
//   older one, and I shall need you to press the button below by your
//   own hand.' This is the must-claim-afresh sentence. It exists
//   because previously-engaged recipients might otherwise read the
//   email and think 'I already did this in 2025, no action needed.'
//   The plain-language consequence ('Without that step, the clan
//   cannot count you among its number') closes the loophole.

const { sendEmail } = require('./email');

// FROM/SUBJECT — updated 2026-04-30 per user request:
//
//   FROM: 'Clan Ó Comáin' (was 'Fergus Commane') — the clan
//     itself is the institutional sender. The body of the email
//     IS Fergus's letter signed by him, but the From field
//     reads as the institution. Same convention used elsewhere
//     in clan correspondence (mailing-house etiquette: an
//     institution sends, an individual signs).
//
//   SUBJECT: 'Invitation on behalf of Fergus Commane' — the
//     Herald's voice. 'Invitation' is a positive, anticipatory
//     frame; recipients lean in to invitations rather than
//     defending against 'Important'-prefixed obligations.
//     'On behalf of' explains why the From field is the clan
//     and not Fergus personally — the Herald (institution) is
//     doing the inviting; Fergus is the principal whose name
//     carries the weight. Iterated through:
//       - 'A founding place in Clan Ó Comáin' (original — too
//         abstract, reads as a tagline)
//       - 'Important message from Fergus Commane' (rejected —
//         'Important' triggers spam-defence instinct)
//       - 'Invitation on behalf of Fergus Commane' (chosen —
//         positive social frame + named principal + Herald
//         framing in three words)
const FROM = 'Clan Ó Comáin <clan@ocomain.org>';
const SUBJECT = 'Invitation on behalf of Fergus Commane';

// The site URL — recipients click through to /founder-welcome.html
// where they get a single-CTA landing page that hands them off to the
// members area to sign in via magic link.
const SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

/**
 * Send the founder welcome email.
 *
 * @param {Object} opts
 * @param {string} opts.to            - recipient email
 * @param {string} opts.recipientName - recipient's full name (for first-name extraction)
 * @param {string} [opts.personalNote] - optional one-line note from Fergus,
 *                                       prepended above the Herald body in
 *                                       italic. Empty/null = no note.
 * @param {string} opts.claimToken    - UUID claim token for the welcome-page
 *                                       URL. Required since the deferred-
 *                                       acceptance flow shipped (2026-04-28);
 *                                       previously the URL carried email+name
 *                                       directly, but now the token is the
 *                                       handle and the welcome page does a
 *                                       server lookup to populate name/email.
 * @returns {Promise<boolean>}
 */
async function sendFounderWelcome({ to, recipientName, personalNote, claimToken }) {
  // First-name extraction — same approach as publication-email.js.
  // Whitespace-split, take first token. 'Antoin Commane' → 'Antoin'.
  // Falls back to 'friend' if the name is somehow empty (shouldn't
  // happen in normal flow but defensive coding for the edge).
  const firstName = (recipientName || '').trim().split(/\s+/)[0] || 'friend';

  // Build the optional personal-note block. Only renders if Fergus
  // typed a note in the admin form. Italic, set off above the Herald
  // body — reads as 'a personal word from Fergus' before the formal
  // letter begins.
  const personalNoteBlock = personalNote && personalNote.trim()
    ? `<p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.7;margin:0 0 28px;padding:18px 20px;background:rgba(184,151,90,.08);border-left:3px solid #B8975A">${escapeHtml(personalNote.trim())}<br><span style="font-size:13px;color:#6C5A4A;margin-top:8px;display:inline-block">— Fergus</span></p>`
    : '';

  // Claim URL — points at the founder welcome landing page with
  // the claim_token. This page renders pure UI on GET (no side
  // effects), so mail scanners pre-fetching the URL cannot consume
  // the token. The recipient sees their name + tier + the Chief's
  // personal note, clicks 'Enter the clan →', and the page POSTs
  // to /api/claim-and-enter-founder which performs the claim and
  // returns a Supabase magic-link action_link. The page then
  // window.location.href's to that action_link, landing the
  // recipient signed in to /members/?welcome=founder.
  //
  // POST-only on the API endpoint is what protects against mail
  // scanners (Outlook ATP, Gmail safe-link, Mimecast, Proofpoint
  // — all GET every link in incoming email to malware-check).
  // The intermediate page is industry-standard pattern for
  // sensitive token-in-URL flows (GitHub, Notion, Stripe all
  // do this).
  const claimUrl = claimToken
    ? `${SITE_URL}/founder-welcome.html?token=${encodeURIComponent(claimToken)}`
    : `${SITE_URL}/founder-welcome.html`;

  // ── THE LOCKED EMAIL BODY ────────────────────────────────────────
  // This is the body verbatim from the chat lock. Every paragraph has
  // rationale captured at the head of this file. If a paragraph needs
  // to change, change it here AND update the rationale comments.
  // No paragraph is decorative; each is doing specific work.
  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header — same chrome as other clan emails (dark green panel,
       small coat of arms, gold rule below). Eyebrow text 'A founding
       place' so the recipient sees the framing instantly even in the
       inbox preview pane. -->
  <div style="background:#0C1A0C;padding:38px 40px 30px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="${SITE_URL}/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">A founding place</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0;line-height:1.18">For ${escapeHtml(firstName)}, by warrant of the Chief</h1>
  </div>

  <!-- Body — Herald's voice throughout, italic for the prose so it
       reads as 'words spoken' rather than 'page printed'. The locked
       text below is the verbatim chat-locked copy. -->
  <div style="padding:36px 40px">

    ${personalNoteBlock}

    <p style="font-family:'Georgia',serif;font-size:17px;font-style:italic;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      Dia dhuit, ${escapeHtml(firstName)} — God be with you.
    </p>

    <p style="font-family:'Georgia',serif;font-size:17px;font-style:italic;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      I write at the wish of Fergus Commane, the Chief of Clan Ó Comáin, who has set down your name among those he calls home in this first hour of the clan's revival. After eight long centuries of silence, the clan stands again — and the Chief has thought of you, by name, as one of those he wishes to see standing with him from its first day. The membership for the year ahead is his gift to you, freely given, and asks nothing of you in return but that you take your place.
    </p>

    <p style="font-family:'Georgia',serif;font-size:17px;font-style:italic;color:#3C2A1A;line-height:1.85;margin:0 0 18px">
      As the clan has grown, its ways have been quietly adapted to keep faith with what it is becoming. To those who wrote to us once before, my warm thanks — but the new platform keeps no record from the older one, and I shall need you to press the button below by your own hand, that I may set down your name in the present register beside those of your fellow founders. Without that step, the clan cannot count you among its number.
    </p>

    <p style="font-family:'Georgia',serif;font-size:17px;font-style:italic;color:#3C2A1A;line-height:1.85;margin:0 0 28px">
      There is but one step to claim your place. The spelling of your name on your certificate, a dedication to an ancestor or someone special you wish to honour, and your choice on the matter of the public Register — these you will attend to inside the members' area.
    </p>

    <!-- The CTA. Burgundy block with gold border, central, prominent.
         Big enough to be unmissable on mobile. Single button, no
         secondary CTAs anywhere in the email — the recipient has one
         action to take. -->
    <div style="text-align:center;margin:8px 0 14px">
      <a href="${claimUrl}" style="display:inline-block;background:#6B1F1F;color:#F7F4ED;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;text-decoration:none;padding:18px 36px;border-radius:1px;border:1px solid #4A1010">Claim your founder's place →</a>
    </div>

    <!-- Soft secondary link to the homepage — for the recipient who
         wants to look at the clan before pressing the main button.
         Small italic, beneath the CTA but well-spaced from it; reads
         as an option rather than an alternative CTA. The 'or' framing
         and the smaller size mean the visual hierarchy still drives
         to the main button. -->
    <p style="font-family:'Georgia',serif;font-size:14px;font-style:italic;color:#6C5A4A;text-align:center;margin:0 0 32px">
      Or visit <a href="${SITE_URL}" style="color:#6B1F1F;text-decoration:underline">ocomain.org</a> to see the clan first.
    </p>

    <!-- Closing imperative + welcome — two short sentences. The first
         commands gently ('Take up your place now'), the second
         welcomes warmly ('Welcome home'). They balance: present-tense
         action and present-tense embrace. -->
    <p style="font-family:'Georgia',serif;font-size:17px;font-style:italic;color:#3C2A1A;line-height:1.7;margin:0 0 6px;text-align:center">
      Take up your place now. Welcome home.
    </p>

    <!-- Sign-off block — Herald voice. Fergus is in the From-field
         and named in the body ('I write at the wish of Fergus
         Commane'); the signature is the Herald who composed the
         letter, in the Gaelic warrant convention. Lifted styling
         (larger, ornamental break above) so it reads as a proper
         signature rather than a small footnote — but kept centered
         and italic to remain restrained. -->
    <div style="text-align:center;margin:32px 0 8px">
      <div style="font-family:'Georgia',serif;color:#B8975A;font-size:18px;letter-spacing:0.6em;line-height:1;opacity:0.55;margin-bottom:18px">· · ·</div>
      <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.5;margin:0">
        — Clan Herald at Newhall
      </p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#8C7A6A;line-height:1.5;margin:6px 0 0">
        On behalf of Fergus Commane, Chief of Ó Comáin
      </p>
    </div>

  </div>

  <!-- Footer motto, same as other clan emails -->
  <div style="background:#0C1A0C;padding:22px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#C8A875;margin:0">
      Caithfidh an stair a bheith i réim — History must prevail
    </p>
  </div>

</div>
</body>
</html>`;

  return await sendEmail({
    from: FROM,
    to,
    subject: SUBJECT,
    html,
  });
}

// Local copy of the standard escapeHtml helper used by other email
// modules. Keeps this file self-contained.
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { sendFounderWelcome };
