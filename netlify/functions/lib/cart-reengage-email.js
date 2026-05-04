// netlify/functions/lib/cart-reengage-email.js
//
// The cart re-engagement sequence. Four emails dispatched at
// +10/+25/+50/+90 days after the existing 24h reminder
// (applications.reminder_sent_at), each addressing a distinct
// objection that may have prevented completion of the herald
// form → Stripe checkout flow.
//
// VOICE CAST — locked.
//
//   RE-1 (+10)  Linda      Practical re-extension. The Office
//                          notices the application is unfinished
//                          and offers one-click resume.
//   RE-2 (+25)  Paddy      Legitimacy. The Seanchaí addresses
//                          the 'is this real?' question through
//                          plain testimony of the clan's recognition.
//   RE-3 (+50)  Antoin     Civic value. The Tánaiste speaks for
//                          what membership funds — festivals,
//                          Cahercommane, the Chronicle, the work.
//   RE-4 (+90)  Linda      Graceful close. The Office shall not
//                          write again on this matter.
//
// LEGAL POSTURE — legitimate interest under GDPR Article 6(1)(f).
// Every email is anchored to the user's unfinished application
// (the legal continuation of the transaction they themselves
// initiated). The cadence tapers exponentially toward a definite
// stop at +90. No general clan marketing, no pivot to newsletter
// content, no infinite drip.
//
// REGISTER PROTOCOL — Linda never refers to the Chief by first
// name. Paddy and Antoin do the same. Each email uses the
// 'private secretary writes on behalf of the principal'
// convention adapted for the speaker's role.

const { sendEmail } = require('./email');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';

const FROM_LINDA  = 'Linda Commane Cryan <linda@ocomain.org>';
const FROM_PADDY  = 'Paddy Commane <paddy@ocomain.org>';
const FROM_ANTOIN = 'Antoin Commane <antoin@ocomain.org>';

// ───────────────────────── helpers ─────────────────────────

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function firstNameOf(application) {
  return ((application.name || '').trim().split(/\s+/)[0]) || 'friend';
}
function resumeUrl(application) {
  return `${SITE}/resume?token=${encodeURIComponent(application.resume_token || '')}`;
}
function pedigreeUrl() { return `${SITE}/pedigree`; }

// ───────────────── shared chrome ─────────────────

function wrapInChrome({ eyebrow, heading, bodyHtml }) {
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
    <p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0;letter-spacing:0.08em">Moohane LLC · 30 N Gould St Ste 36809, Sheridan, WY 82801, USA · <a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · <a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>
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

// ───────────────── photo signatures ─────────────────

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
      </p>
    </td>
  </tr>
</table>`;
}

// Paddy uses paddy_commane_ballymacooda.png with CSS bubble crop
function paddySignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/paddy_commane_ballymacooda.png" width="68" height="68" alt="Paddy Commane, Seanchaí" style="display:block;width:68px;height:68px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Paddy Commane</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Seanchaí <span style="font-style:italic;color:#6C5A4A">(SHAN-a-kee)</span> of Clan Ó Comáin</p>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Historian &amp; Storyteller</p>
      <p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:paddy@ocomain.org" style="color:#B8975A;text-decoration:none">paddy@ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

// Antoin — uses antoin_tanist.png with CSS bubble crop (no _bubble.png yet)
function antoinSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/antoin_tanist.png" width="68" height="68" alt="Antoin Commane, Tánaiste" style="display:block;width:68px;height:68px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Antoin Commane</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Tánaiste of Clan Ó Comáin</p>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Successor to the Chief, in the Brehon line</p>
      <p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:antoin@ocomain.org" style="color:#B8975A;text-decoration:none">antoin@ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

// ─────────────────────────────────────────────────────────────────
// RE-1 (+10) — Linda — practical re-extension
// ─────────────────────────────────────────────────────────────────

function buildRe1Html(application) {
  const firstName = firstNameOf(application);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`The Chief has asked me to write.`)}
${p(`Your application to take a place in the Register of Clan Ó Comáin sits unfinished in the Office's pending file. It has been there now for some weeks. The Chief has asked me to put one practical note in front of you, in case there was a small difficulty in completing the process — a payment that did not go through, an interruption at the moment, an email lost in the rush of a working day.`)}
${p(`Your details remain on file at Newhall. The tier you had begun to choose, the form of your name as you wished it inscribed, the line you were tracing — all of it is still here. <strong>A single click resumes where you left off</strong>, and no further detail need be re-entered.`)}
${ctaButtonHtml('Resume my application', resumeUrl(application))}
${p(`If something else stayed your hand — a question, a hesitation, a need to consult someone before going further — please write back to me directly. The Office is small enough that real replies still come from real hands, and there is no question too small.`)}
${p(`I should add: <strong>2026 is Year One of the Revival</strong>, and members entered this year are recorded as Founders of the Revival, with a gold seal upon their certificate. The Office has held that distinction in your record for the duration of your unfinished application — but it cannot be held there indefinitely.`)}
${p(`With kind regards,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'Your application sits unfinished',
    bodyHtml: body,
  });
}

async function sendReengage1_Practical(application) {
  return sendEmail({
    to: application.email,
    from: FROM_LINDA,
    subject: 'Your application sits unfinished — a practical word',
    html: buildRe1Html(application),
  });
}

// ─────────────────────────────────────────────────────────────────
// RE-2 (+25) — Paddy — legitimacy
// ─────────────────────────────────────────────────────────────────

function buildRe2Html(application) {
  const firstName = firstNameOf(application);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Paddy here — Paddy Commane of Ballymacooda. I serve the clan as <strong><em>Seanchaí (SHAN-a-kee)</em></strong>, the keeper of the stories. The Office tells me your application sits unfinished. Linda has written to you on the practical side; I write only on the question that some folk quietly carry but rarely ask aloud.`)}
${p(`<strong>Is the clan real.</strong>`)}
${p(`I'll tell you straight, because that is my office. <strong>Clan Ó Comáin is an ancient Gaelic royal house and a recognised Irish Gaelic clan</strong>, authenticated by Clans of Ireland under the patronage of the President of Ireland. The committee verified the antiquity of the Gaelic name and the line, and recognised the clan formally. There are very few such authentications. They are not lightly given.`)}
${p(`Our ancestral capital is Cahercommane — the great stone fort still standing on the Burren, in County Clare. You can drive to it. You can walk inside its walls. The fort goes back four thousand years, and the Y-DNA of the present kindred runs through that ground without break. Forty-five footnotes set out the line in full, drawn from the Annals, the Brehon Genealogies, the archaeology, and the modern science.`)}
${ctaButtonHtml('Read the full pedigree', pedigreeUrl())}
${p(`The Chief, <strong>Fergus Commane Kinfauns</strong>, was consecrated under Brehon law by the derbhfine of the kindred. He is the custodian of Killone Abbey and the Holy Well of St John the Baptist, both upon his estate at Newhall. None of this is contemporary invention. It is an old house in lawful and openly recognised revival.`)}
${p(`Your application sits unfinished. I do not know what stayed your hand, and I do not press you. I write only that, <strong>if it was the question of whether the thing is real that gave you pause</strong>, I have answered it as plainly as I know how.`)}
${ctaButtonHtml('Resume my application', resumeUrl(application))}
${p(`Yours,`)}
${paddySignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A word from the Seanchaí',
    heading: 'In case the question was whether the clan is real',
    bodyHtml: body,
  });
}

async function sendReengage2_Legitimacy(application) {
  return sendEmail({
    to: application.email,
    from: FROM_PADDY,
    subject: 'In case the question was whether the clan is real',
    html: buildRe2Html(application),
  });
}

// ─────────────────────────────────────────────────────────────────
// RE-3 (+50) — Antoin — civic value
// ─────────────────────────────────────────────────────────────────

function buildRe3Html(application) {
  const firstName = firstNameOf(application);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Antoin Commane writing — <em>Tánaiste</em> of Clan Ó Comáin. The role is the elected successor to the Chief in the Brehon line, and one part of it is to speak for what the clan is making of itself in the years to come. The Office has told me your application stands unfinished, and the Chief has asked that I write to you on this.`)}
${p(`I want to put one thing plainly, because it is the part that does not always come across in the form-filling.`)}
${p(`Membership of Clan Ó Comáin is <strong>an act of cultural stewardship</strong>, not a subscription. The €49 of the first tier — and the €150 of the Guardian, and the €750 of Life — does not buy a service. It funds the work of an Irish Gaelic clan in active revival. The summer festivals at Newhall and Cahercommane. The academic and heritage research. The preservation of our ancestral lands, which is on no one's budget but ours. The Chronicle and the publications carrying the ancient story to new readers. The Privy Council's standing meetings. The seal on every certificate. None of this happens without the kindred's hand on it.`)}
${p(`If your application sits unfinished because the question was <strong>is it worth €49</strong> — the truer question is what your hand on this work would mean, and what it could enable for the clan in the years your name appears beside ours.`)}
${p(`The clan has work to do. Your hand on it would matter.`)}
${ctaButtonHtml('Complete my application', resumeUrl(application))}
${p(`Yours, in clan and kindred,`)}
${antoinSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A word from the Tánaiste',
    heading: 'What your hand on this work would mean',
    bodyHtml: body,
  });
}

async function sendReengage3_CivicValue(application) {
  return sendEmail({
    to: application.email,
    from: FROM_ANTOIN,
    subject: 'What your hand on this work would mean',
    html: buildRe3Html(application),
  });
}

// ─────────────────────────────────────────────────────────────────
// RE-4 (+90) — Linda — graceful close
// ─────────────────────────────────────────────────────────────────

function buildRe4Html(application) {
  const firstName = firstNameOf(application);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`The Chief has asked me to write once more on this matter, and <strong>for the last time</strong>. The Office shall not write to you again about your unfinished application.`)}
${p(`Your application stays in the Register's pending file. If, in months or years to come, you find the moment is right — a particular birthday, a research breakthrough, a visit to Ireland, a quiet evening when the thought returns — the door remains open, and a single click will resume where you left off.`)}
${ctaButtonHtml('Resume my application', resumeUrl(application))}
${p(`If now is not the moment and never shall be, that is also fine. The Chief asked me to thank you, on his behalf, for the time you spent with us in the join chat. The fact that you came that far — that you read, and considered, and entered your details — is itself a small thing on the side of the clan's revival. We are grateful for it.`)}
${p(`With kind regards, and the Chief's thanks,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A final word from the Office',
    heading: 'A final word, with the Chief\u2019s thanks',
    bodyHtml: body,
  });
}

async function sendReengage4_FinalClose(application) {
  return sendEmail({
    to: application.email,
    from: FROM_LINDA,
    subject: 'A final word, with the Chief\u2019s thanks',
    html: buildRe4Html(application),
  });
}

// ─────────────────────────────────────────────────────────────────
// PREVIEW INTEGRATION
// ─────────────────────────────────────────────────────────────────

const PREVIEW_BUILDERS = {
  'RE1': buildRe1Html,
  'RE2': buildRe2Html,
  'RE3': buildRe3Html,
  'RE4': buildRe4Html,
};

function getPreviewHtml(emailKey, application) {
  const builder = PREVIEW_BUILDERS[emailKey];
  if (!builder) throw new Error(`Unknown email key: ${emailKey}. Valid keys: ${Object.keys(PREVIEW_BUILDERS).join(', ')}`);
  return builder(application);
}

module.exports = {
  sendReengage1_Practical,
  sendReengage2_Legitimacy,
  sendReengage3_CivicValue,
  sendReengage4_FinalClose,
  getPreviewHtml,
  PREVIEW_BUILDERS,
};
