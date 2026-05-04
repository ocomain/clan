// netlify/functions/lib/pdf-lead-email.js
//
// The PDF lead-magnet email lifecycle. One confirmation email (sent
// synchronously on form submit) plus five lifecycle emails dispatched
// across +0/+3/+10/+21/+35 days from confirmation:
//
//   CONF    Confirmation email          Sent on subscribe-roots.js form POST
//   E1      Your starter guide…         +0 — synchronously on confirm-roots.js click
//   E2      A note on the standing…     +3 — daily-pdf-lead-sweep.js
//   E3      On the certificate…         +10 — daily-pdf-lead-sweep.js
//   E4      A place for you…            +21 — daily-pdf-lead-sweep.js
//   E5      The Chief has asked me…     +35 — daily-pdf-lead-sweep.js
//
// VOICE — locked across many drafting iterations.
//
// All five lifecycle emails are sent from linda@ocomain.org in the
// authentic voice of a noble-house Private Secretary writing on
// behalf of the Chief. Modelled directly on the convention used by
// Ladies-in-Waiting at the British Royal Household ("The Queen
// wishes me to write and thank you for…"). Linda speaks for the
// Chief throughout — never AS the Chief, never by his first name.
// Closings are warm and modern: "With kind regards" — NOT the
// Edwardian "humble and obedient servant" line which is reserved
// for letters TO a sovereign.
//
// FRAMING — load-bearing across the sequence.
//
// The clan's positioning is open and inclusive: "all who love
// Ireland and its ancient Gaelic culture, whatever surname you
// carry". This is stated explicitly in Email 1 (the welcome) and
// Email 4 (the direct invitation). The clan is described
// throughout as "an ancient Gaelic royal house" and as an "Irish
// Gaelic clan" — the Irish identity made unambiguous, the royal
// standing made plain. The reader who came for genealogy is
// welcomed AS SOMEONE WHO LOVES IRELAND. That is the only
// criterion. Whether their line happens to run into Ó Comáin is
// expressly not relevant to membership.
//
// FOUNDERS OF THE REVIVAL — real, not invented.
//
// Members who join in 2026 (Year One) are recorded as "Founders of
// the Revival" on their certificate, marked with a gold seal, and
// the distinction stays with the record for the lifetime of the
// clan. Taken from the live membership page. Email 4 introduces
// this scarcity; Email 5 reinforces it.

const { sendEmail } = require('./email');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';
const PDF_FILENAME = 'first-steps-tracing-irish-line.pdf';
const PDF_URL = `${SITE}/${PDF_FILENAME}`;

const URLS = {
  pdf:            PDF_URL,
  membership:     `${SITE}/membership`,
  joinChat:       `${SITE}/join-chat`,
  pedigree:       `${SITE}/pedigree`,
};

const FROM_LINDA = 'Linda Commane Cryan <linda@ocomain.org>';

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function firstNameOf(subscriber) {
  if (subscriber.first_name && subscriber.first_name.trim()) {
    return subscriber.first_name.trim().split(/\s+/)[0];
  }
  // Fall back to the email local-part (gracefully — better than "friend"
  // for someone who didn't share their name on the form).
  const local = (subscriber.email || '').split('@')[0];
  return local ? (local.charAt(0).toUpperCase() + local.slice(1)) : 'friend';
}

function unsubscribeUrl(subscriber) {
  return `${SITE}/.netlify/functions/unsubscribe-roots?t=${encodeURIComponent(subscriber.unsubscribe_token)}`;
}

// ────────────────────────────────────────────────────────────────────
// Shared chrome — the same dark-green-header / cream-body / dark-footer
// shell used by publication-email.js and notify-giver-activated.js, so
// the lead-magnet emails sit in the same visual family as everything
// else the clan sends.
// ────────────────────────────────────────────────────────────────────

function wrapInChrome({ eyebrow, heading, bodyHtml, subscriber }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <div style="background:#0C1A0C;padding:38px 40px 30px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="${SITE}/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">${escapeHtml(eyebrow)}</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0;line-height:1.18">${escapeHtml(heading)}</h1>
  </div>

  <div style="padding:36px 40px">
    ${bodyHtml}
  </div>

  <div style="background:#0C1A0C;padding:22px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#C8A875;margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0 0 12px;letter-spacing:0.08em">Clan Ó Comáin · Newhall House, County Clare, Ireland</p>
    ${subscriber ? `<p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0;letter-spacing:0.04em"><a href="${unsubscribeUrl(subscriber)}" style="color:#A88B57;text-decoration:underline">Unsubscribe</a></p>` : ''}
  </div>
</div>
</body>
</html>`;
}

function ctaButtonHtml(label, url) {
  // Bulletproof email button — survives iOS Mail / Gmail / Outlook
  // overrides that strip inline anchor styles. Two defenses:
  //  (1) !important on text-decoration and color, so even clients
  //      that re-apply user-agent link styles cannot underline or
  //      recolor our text.
  //  (2) Inner <span> carrying its own copy of the critical text
  //      styles, so clients that style anchor *descendants*
  //      differently (looking at you, Apple Mail) still render
  //      our text correctly.
  return `
<div style="text-align:center;margin:24px 0 28px">
  <a href="${url}" style="display:inline-block;background:#B8975A;color:#0C1A0C !important;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none !important;padding:15px 32px;border-radius:1px;mso-padding-alt:0;mso-text-raise:0"><span style="display:inline-block;color:#0C1A0C !important;font-family:&apos;Helvetica Neue&apos;,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none !important">${escapeHtml(label)} &rarr;</span></a>
</div>`;
}

function p(text)       { return `<p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">${text}</p>`; }
function pItalic(text) { return `<p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0 0 20px">${text}</p>`; }

function lindaSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/linda_cryan_bubble.png" width="68" height="68" alt="Linda Commane Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Private Secretary to the Chief of Ó Comáin</p>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p>
      <p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a>
        <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span>
        <a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

// ────────────────────────────────────────────────────────────────────
// CONFIRMATION EMAIL — sent synchronously on subscribe-roots.js POST.
// Plain, transactional, ePrivacy-compliant. Verifies the email address
// is real before any further communication is sent.
// ────────────────────────────────────────────────────────────────────

function buildConfirmationHtml(subscriber, confirmUrl) {
  const firstName = firstNameOf(subscriber);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Thank you for asking us for the starter guide — <em>First Steps in Tracing Your Irish Line</em>. To complete your request, please confirm your email address by clicking the button below.`)}
${ctaButtonHtml('Confirm and send me the guide', confirmUrl)}
${p(`Once confirmed, the guide will arrive in your inbox within a moment or two. If you did not request this, you may safely ignore this message — no further emails will be sent.`)}
${p(`<em>With kind regards,<br>The Office of the Private Secretary to the Chief of Ó Comáin</em>`)}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'Please confirm your email address',
    bodyHtml: body,
    // No unsubscribe link on the confirmation email — they have not yet
    // confirmed and so are not yet on a list to leave.
    subscriber: null,
  });
}

async function sendConfirmationEmail(subscriber, confirmUrl) {
  return sendEmail({
    to: subscriber.email,
    from: FROM_LINDA,
    subject: 'Please confirm your email — Clan Ó Comáin',
    html: buildConfirmationHtml(subscriber, confirmUrl),
  });
}

// ────────────────────────────────────────────────────────────────────
// EMAIL 1 (+0) — Your starter guide, with the Chief's compliments
// Fired immediately on confirmation click (NOT by the cron).
// ────────────────────────────────────────────────────────────────────

function buildEmail1Html(subscriber) {
  const firstName = firstNameOf(subscriber);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`The Chief has asked me to write and thank you for requesting the starter guide. It is attached to this message, and a download link is below in case the attachment does not come through cleanly.`)}
${ctaButtonHtml('Download First Steps in Tracing Your Irish Line (PDF)', URLS.pdf)}
${p(`A word about the house from which it comes. <strong>Clan Ó Comáin is an ancient Gaelic royal house and a recognised Irish clan</strong> — authenticated by <strong>Clans of Ireland</strong> under the patronage of the President of Ireland — seated at Newhall House in County Clare. The Chief, <strong>Fergus Commane Kinfauns</strong>, was consecrated under Brehon law by the derbhfine of the kindred.`)}
${p(`And a word about who is welcome. <strong>Clan Ó Comáin is open to all who love Ireland and its ancient Gaelic culture — whatever surname you carry, and whether or not your line runs into ours.</strong> That is not a modern softening of an ancient idea — it is a return to one. The Gaelic clan was never purely a matter of blood; chosen allegiance has always been recognised as a way of belonging.`)}
${p(`If, having read the guide, you would like to take a place in the Register at Newhall, the Chief will sign and seal your certificate by his own hand. Membership opens at <strong>€49 the year (€79 family)</strong>. I shall write to you again over the coming weeks with a little more about what membership means.`)}
${p(`If a question arises in the meantime, please do write back.`)}
${p(`With kind regards,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'Your starter guide, with the Chief\u2019s compliments',
    bodyHtml: body,
    subscriber,
  });
}

async function sendEmail1_StarterGuide(subscriber) {
  return sendEmail({
    to: subscriber.email,
    from: FROM_LINDA,
    subject: 'Your starter guide, with the Chief\u2019s compliments — Clan Ó Comáin',
    html: buildEmail1Html(subscriber),
  });
}

// ────────────────────────────────────────────────────────────────────
// EMAIL 2 (+3) — A note on the standing of Clan Ó Comáin
// ────────────────────────────────────────────────────────────────────

function buildEmail2Html(subscriber) {
  const firstName = firstNameOf(subscriber);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`The Chief has asked me to write to you with a little more about the standing of the clan, since the question often comes up from those new to us.`)}
${p(`Clan Ó Comáin is <strong>authenticated by Clans of Ireland</strong>, the official body of the Republic established in 1989 under the patronage of the President. The committee verified the antiquity of the Gaelic name and the line, and recognised the clan formally as an Irish clan and ancient royal house. There are very few such authentications, and they are not lightly given.`)}
${p(`The pedigree is the subject of a full scholarly account, with <strong>forty-five footnotes</strong> drawn from the Annals, the Brehon Genealogies, the archaeological record at Cahercommane, and Y-DNA analysis tracing the kindred back almost four thousand years. The line runs from the Bronze Age, through the kings of Déisi Muman, into the Burren of County Clare, and forward into the modern record. Three academic endorsements are presently in train.`)}
${ctaButtonHtml('Read the full pedigree', URLS.pedigree)}
${p(`The Chief is the custodian of <strong>Killone Abbey and the Holy Well of St John the Baptist</strong>, both upon the Newhall estate. He was consecrated under Brehon law by the derbhfine of the kindred — that is, by the assembly of those of the clan with a recognised right to elect or confirm the chief.`)}
${p(`I mention all of this so that you might know what you are looking at. There is no obligation; but if you do choose to join, you will find it is a real Irish clan, with real history, and a welcome that is genuinely open to anyone who loves Ireland.`)}
${p(`With kind regards,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'On the standing of Clan Ó Comáin',
    bodyHtml: body,
    subscriber,
  });
}

async function sendEmail2_Standing(subscriber) {
  return sendEmail({
    to: subscriber.email,
    from: FROM_LINDA,
    subject: 'On the standing of Clan Ó Comáin',
    html: buildEmail2Html(subscriber),
  });
}

// ────────────────────────────────────────────────────────────────────
// EMAIL 3 (+10) — On the certificate, and what membership carries
// ────────────────────────────────────────────────────────────────────

function buildEmail3Html(subscriber) {
  const firstName = firstNameOf(subscriber);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`A further note from me, with a little more about what is conferred upon those who take a place in the Register at Newhall.`)}
${p(`Each member receives a <strong>certificate of membership signed by the Chief, by his own hand</strong>, bearing the arms of Ó Comáin and the seal of the clan. It is the formal instrument by which the Chief confers a place upon the holder. Members frame it and keep it on the wall — many tell us it is among the most cherished things in the family home.`)}
${p(`I should mention something the Chief considers important. The certificate names the holder, and — for those who join as a family — names the spouse and the children, with an inheritance clause by which the children carry their place in the clan into adulthood in their own right. <strong>One certificate. One Irish clan. One family, three generations deep.</strong> It is the most enduring Irish heirloom we know how to make.`)}
${p(`The four tiers of membership are these:`)}
${p(`<strong>Clan Member — €49 individual, €79 family.</strong> Entry into the Register at Newhall. The certificate signed and sealed by the Chief. Chief-approved use of the clan crest and the official clan tartan. Member access to the summer festivals at Newhall and Cahercommane.`)}
${p(`<strong>Guardian of the Clan — €150 individual, €220 family.</strong> All the foregoing, with the certificate posted as a physical document on heritage stock. Your name on the public Founding Members Register at Newhall. A personal letter from the Chief on headed Newhall stationery. A place at the table at the private annual Chief's Gala at Newhall House, with the Chief and Privy Council. First right of refusal on open Privy Council positions.`)}
${p(`<strong>Steward of the Clan — €350 individual, €480 family.</strong> All the foregoing, with the standing of a Steward of the kindred, your name inscribed on the Clan Roll of Honour permanently displayed at Newhall, your line of descent lodged in the clan archive, and a private call with the Chief himself.`)}
${p(`<strong>Life Member — €750 individual, €1,100 family, paid once.</strong> All the foregoing, conferred for life with no further annual renewal. A clan heirloom pack presented as a keepsake set. Your name engraved permanently on the Clan Roll of Honour at Newhall.`)}
${ctaButtonHtml('See the membership tiers in full', URLS.membership)}
${p(`Membership is, as the Chief puts it, an act of cultural stewardship — not a subscription. It directly funds the clan's revival: the summer festivals, the academic and heritage research, the preservation of Cahercommane, and the books and publications carrying the ancient Irish Gaelic story to new readers.`)}
${p(`With kind regards,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'On the certificate, and what membership carries',
    bodyHtml: body,
    subscriber,
  });
}

async function sendEmail3_Certificate(subscriber) {
  return sendEmail({
    to: subscriber.email,
    from: FROM_LINDA,
    subject: 'On the certificate of membership, and what it carries',
    html: buildEmail3Html(subscriber),
  });
}

// ────────────────────────────────────────────────────────────────────
// EMAIL 4 (+21) — A place for you in the Register at Newhall
// The direct invitation, with the Founders of the Revival scarcity.
// ────────────────────────────────────────────────────────────────────

function buildEmail4Html(subscriber) {
  const firstName = firstNameOf(subscriber);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`The Chief has asked me to write to you directly.`)}
${p(`There is a place for you in the Register of Clan Ó Comáin, if you would like to take it. <strong>Whatever surname you carry, and whether or not your line runs into ours,</strong> you are welcome here. The Chief will enter your name with his own hand, in the form you choose, and will set his seal upon a certificate to be sent to you in the post. Membership opens at <strong>€49 the year (€79 family)</strong>, and the entry can be made today.`)}
${ctaButtonHtml('Take a place in the Register', URLS.joinChat)}
${p(`I should mention that the kindred coming to Ó Comáin in the present revival are writing in from <strong>Boston, Chicago, the cities of Britain, Sydney, Auckland, and the towns of Ireland itself</strong> — people of every surname who simply love Ireland and want a real place in its living Gaelic story. Your name would stand among them.`)}
${p(`There is also one matter the Chief has asked me to draw to your attention. <strong>2026 is Year One of the Revival.</strong> Members who join this year are recorded in the clan Register as <strong>Founders of the Revival</strong> — a distinction that appears on the certificate as a gold seal, stays with the record for the lifetime of the clan, and can only be earned this year. Once 2026 closes, that distinction will not be conferred again.`)}
${p(`If you would consider one of the higher tiers — <strong>Guardian</strong> for the public Register and the Chief's Gala at Newhall, <strong>Life Member</strong> for the standing in perpetuity — I am happy to answer any question you might have. Please do write back.`)}
${ctaButtonHtml('Take a place in the Register', URLS.joinChat)}
${p(`With kind regards,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'A place for you in the Register at Newhall',
    bodyHtml: body,
    subscriber,
  });
}

async function sendEmail4_Invitation(subscriber) {
  return sendEmail({
    to: subscriber.email,
    from: FROM_LINDA,
    subject: 'A place for you in the Register at Newhall',
    html: buildEmail4Html(subscriber),
  });
}

// ────────────────────────────────────────────────────────────────────
// EMAIL 5 (+35) — The Chief has asked me to write once more
// Final considered invitation. Then exits cleanly into the standing
// Chronicle list.
// ────────────────────────────────────────────────────────────────────

function buildEmail5Html(subscriber) {
  const firstName = firstNameOf(subscriber);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`The Chief has asked me to write once more — and <strong>for the last time on this matter</strong> — in case the moment is now right for you to take a place in the Register.`)}
${p(`Membership remains at <strong>€49 the year (€79 family)</strong> for the first tier. Upon entry, the Chief will sign and seal your certificate by his own hand, and your name will be inscribed in the Register at Newhall in the form you choose. As 2026 is Year One of the Revival, your record will carry the <strong>Founders of the Revival</strong> distinction permanently.`)}
${ctaButtonHtml('Take a place in the Register', URLS.joinChat)}
${p(`If now is not the moment, I will not write again on this matter. You will continue to receive the occasional Chronicle from us — quarterly news from Newhall — which you can leave at any time with one click.`)}
${p(`Whatever you decide, the Chief asked me to thank you for the interest you have taken in the clan.`)}
${p(`With kind regards,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'The Chief has asked me to write once more',
    bodyHtml: body,
    subscriber,
  });
}

async function sendEmail5_FinalInvitation(subscriber) {
  return sendEmail({
    to: subscriber.email,
    from: FROM_LINDA,
    subject: 'The Chief has asked me to write once more',
    html: buildEmail5Html(subscriber),
  });
}

// ────────────────────────────────────────────────────────────────────
// PREVIEW INTEGRATION — for scripts/preview-pdf-lead-emails.mjs
// ────────────────────────────────────────────────────────────────────

const PREVIEW_BUILDERS = {
  'CONF': (s) => buildConfirmationHtml(s, `${SITE}/.netlify/functions/confirm-roots?t=PREVIEW_TOKEN`),
  'E1':   buildEmail1Html,
  'E2':   buildEmail2Html,
  'E3':   buildEmail3Html,
  'E4':   buildEmail4Html,
  'E5':   buildEmail5Html,
};

function getPreviewHtml(emailKey, subscriber) {
  const builder = PREVIEW_BUILDERS[emailKey];
  if (!builder) throw new Error(`Unknown email key: ${emailKey}. Valid keys: ${Object.keys(PREVIEW_BUILDERS).join(', ')}`);
  return builder(subscriber);
}

module.exports = {
  // Senders
  sendConfirmationEmail,
  sendEmail1_StarterGuide,
  sendEmail2_Standing,
  sendEmail3_Certificate,
  sendEmail4_Invitation,
  sendEmail5_FinalInvitation,
  // Preview
  getPreviewHtml,
  PREVIEW_BUILDERS,
};
