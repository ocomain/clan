// netlify/functions/lib/post-signup-email.js
//
// The post-signup email lifecycle. Eight emails across six time
// buckets (members.created_at + 3 / 9 / 18 / 28 / 60 / 90 days),
// dispatched by daily-post-signup-sweep.js.
//
// VOICE CAST — locked across many drafting iterations. Each email
// has a specific author and a specific job; the voices are
// distinct on purpose so the sequence reads as correspondence
// from a real household, not a marketing template.
//
//   1A/B/C  THE HERALD          (clan@) — formal, archaic, register
//                                voice. Three variants for tier +
//                                public_register_visible permutations.
//   2       FERGUS              (chief@) — warm, personal letter.
//                                The Chief writes by his own hand;
//                                no CTA, pure warmth.
//   3       LINDA / OFFICE      (linda@) — institutional voice. "A
//                                note from the Office, by the Chief's
//                                wish, on a matter the clan's revival
//                                depends on…" Carries the primary
//                                referral ask.
//   4       LINDA / OFFICE      (linda@) — institutional follow-up.
//                                Conditional — fires only when the
//                                member has zero conversions yet.
//                                "A second note from the Office. If
//                                the invitation path feels like a
//                                lot, the gift path is simpler…"
//   5       LINDA / OFFICE      (linda@) — institutional service note.
//                                Honours protocol explained plainly,
//                                with the warrant-language detail
//                                deferred to the honours page link.
//   6       PADDY (Seanchaí)    (clan@ — institutional From, Paddy
//                                in body) — storyteller voice. The
//                                pedigree as story, with the
//                                names-are-rivers Irish saying that
//                                gives the diaspora reader a way to
//                                hold their variant surname (Cummins,
//                                Commons, Hurley, Comyn) inside the
//                                clan.
//
// REGISTER PROTOCOL — locked:
//   - Linda never refers to Fergus by first name. Always "the
//     Chief" or "the Chief's wish". Same convention for The Herald
//     and Paddy. Only Fergus speaks of himself in first person, in
//     his own letter (Email 2).
//   - Linda never introduces herself by name in the body. The
//     Office speaks; her face and name appear only in the photo
//     signature block.

const { sendEmail } = require('./email');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';

// ── URLs ────────────────────────────────────────────────────────────
const URLS = {
  upgrade:        'mailto:clan@ocomain.org?subject=Upgrade%20to%20Guardian',
  publicRegister: `${SITE}/register`,
  membersArea:    `${SITE}/members/`,
  honoursPage:    `${SITE}/members/honours.html`,
  pedigreePage:   `${SITE}/pedigree`,
  giftPage:       `${SITE}/gift`,
};

// ── Helpers ─────────────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function firstNameOf(member) {
  return (member.name || '').trim().split(/\s+/)[0] || 'friend';
}

// ── Shared chrome ───────────────────────────────────────────────────
//
// All eight emails sit inside the same shell as publication-email.js
// and notify-giver-activated.js — dark green header (#0C1A0C) with
// coat of arms + eyebrow + heading, cream body (#F8F4EC) with Georgia
// serif at 17px, dark footer with "History must prevail" motto and
// the Newhall address.
//
// `bodyHtml` is the inner copy and signature block, already escaped.

function wrapInChrome({ eyebrow, heading, bodyHtml }) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">

  <!-- Header -->
  <div style="background:#0C1A0C;padding:38px 40px 30px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="${SITE}/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto">
    <p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <p style="font-family:'Georgia',sans-serif;font-size:11px;font-weight:600;letter-spacing:0.28em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">${escapeHtml(eyebrow)}</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0;line-height:1.18">${escapeHtml(heading)}</h1>
  </div>

  <!-- Body -->
  <div style="padding:36px 40px">
    ${bodyHtml}
  </div>

  <!-- Footer -->
  <div style="background:#0C1A0C;padding:22px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#C8A875;margin:0 0 6px">Caithfidh an stair a bheith i réim — History must prevail</p>
    <p style="font-family:sans-serif;font-size:10px;color:#A88B57;margin:0;letter-spacing:0.08em">Moohane LLC · 30 N Gould St Ste 36809, Sheridan, WY 82801, USA · <a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · <a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>
  </div>
</div>
</body>
</html>`;
}

// ── CTA button ──────────────────────────────────────────────────────
//
// Centred, gold-on-dark, single-line. Style matches the "Download
// PDF" button in publication-email.js.

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

// ── Body paragraph helper ───────────────────────────────────────────
function p(text) {
  return `<p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">${text}</p>`;
}
function pItalic(text) {
  return `<p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.8;margin:0 0 20px">${text}</p>`;
}

// ── Signature blocks ────────────────────────────────────────────────

// Linda — reused verbatim from publication-email.js + notify-giver-
// activated.js so visual identity stays consistent across the lifecycle.
function lindaSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/linda_cryan_bubble.png" width="68" height="68" alt="Linda Commane Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
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

// Paddy — same structure, paddy_commane_ballymacooda.png cropped
// circular via CSS. Pronunciation gloss (SHAN-a-kee) renders inline
// for clients that respect inline italic; falls back gracefully.
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
        <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span>
        <a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

// Fergus — fergus_at_killone.png cropped circular. No email line —
// the From-field already says chief@ocomain.org and his existing
// homepage letter signature is a name + role + seat block, no email.
function fergusSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/fergus_at_killone.png" width="68" height="68" alt="Fergus Commane Kinfauns" style="display:block;width:68px;height:68px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Fergus Commane Kinfauns</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Chief of Ó Comáin</p>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Newhall House, County Clare</p>
    </td>
  </tr>
</table>`;
}

// Herald — text-only. Single italic line as in founder-email.js.
function heraldSignatureHtml() {
  return `
<div style="text-align:left;margin:32px 0 8px">
  <div style="font-family:'Georgia',serif;color:#B8975A;font-size:18px;letter-spacing:0.6em;line-height:1;opacity:0.55;margin-bottom:18px">· · ·</div>
  <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;line-height:1.5;margin:0">— An tAralt, Clan Herald at Newhall</p>
</div>`;
}

// ── Shared body fragments ──────────────────────────────────────────

// Used in 1A, 1B, 1C. The order-of-dignities etiquette block.
function heraldEtiquetteHtml() {
  return p(`At the head of the Register stand those whom the Chief has raised to the three dignities of the clan — borne aloud at the gatherings, walking ceremonially beside the Chief and the Privy Council. <strong>Cara of Ó Comáin</strong> is conferred at one bringing-in; <strong>Ardchara</strong> at five; and <strong>Onóir</strong> at fifteen, most senior of the three. The bearer is named <em><strong>Cara John</strong></em> in speech and on the Register; <em><strong>John Cummins, Cara of Ó Comáin</strong></em> in formal correspondence.`)
       + p(`Each dignity opens with a single act — bringing another of your kindred to the clan, by invitation or by gift, both done from your <a href="${URLS.membersArea}" style="color:#8B6F32;text-decoration:underline">members' area</a>.`);
}

// Used in 1A, 1C. Sealing reminder.
function sealReminderHtml() {
  return p(`If your certificate is not yet sealed, do so within the thirty-day window — that fixes the spelling, the Gaelic form should you prefer it, and the name by which the kindred shall hereafter know you.`);
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 1 — Three variants (Herald)
// ─────────────────────────────────────────────────────────────────────

function buildEmail1A_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${pItalic(`Dia dhuit — God be with you.`)}
${p(`I am the Clan Herald of Ó Comáin, keeper of the clan's register at Newhall. Your name is inscribed among those who have answered the call after eight long centuries of silence — kindred newly returned to one ancient hearth.`)}
${p(`Your name is kept upon my private roll at Newhall, no less honoured for being unseen there. The <a href="${URLS.publicRegister}" style="color:#8B6F32;text-decoration:underline">public online Register</a>, reserved to the Guardian, Steward and Life tiers, sits open to you whenever you choose to take a place upon it — a short word to clan@ocomain.org, and the upgrade is done.`)}
${ctaButtonHtml('Write to the Office to upgrade', URLS.upgrade)}
${heraldEtiquetteHtml()}
${sealReminderHtml()}
${heraldSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Herald',
    heading: 'Your name in the Register of Clan Ó Comáin',
    bodyHtml: body,
  });
}

function buildEmail1B_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${pItalic(`Dia dhuit — God be with you.`)}
${p(`I am the Clan Herald of Ó Comáin, keeper of the clan's register at Newhall. Your name is inscribed among those who have answered the call after eight long centuries of silence — kindred newly returned to one ancient hearth.`)}
${p(`Your name is now openly kept among the Guardians, Stewards and Life Members of Ó Comáin in the <a href="${URLS.publicRegister}" style="color:#8B6F32;text-decoration:underline">public online Register</a> — alongside those of the kindred drawn back from across the wide world.`)}
${ctaButtonHtml('See your name in the public Register', URLS.publicRegister)}
${heraldEtiquetteHtml()}
${p(`If your certificate is not yet sealed, do so within the thirty-day window — that fixes the spelling, the Gaelic form should you prefer it, and the name by which the kindred shall hereafter know you. Your appearance on the public Register may be quietly changed at any time in your <a href="${URLS.membersArea}" style="color:#8B6F32;text-decoration:underline">members' area</a>.`)}
${heraldSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Herald',
    heading: 'Your name in the public online Register',
    bodyHtml: body,
  });
}

function buildEmail1C_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${pItalic(`Dia dhuit — God be with you.`)}
${p(`I am the Clan Herald of Ó Comáin, keeper of the clan's register at Newhall. Your name is inscribed among those who have answered the call after eight long centuries of silence — kindred newly returned to one ancient hearth.`)}
${p(`Your name is kept upon my private roll at Newhall by your own preference, no less honoured for being unseen there. The choice is freely yours, and may be quietly changed at any time should you wish your name to appear among the Guardians, Stewards and Life Members on the public Register.`)}
${ctaButtonHtml('Open my members\u2019 area', URLS.membersArea)}
${heraldEtiquetteHtml()}
${sealReminderHtml()}
${heraldSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Herald',
    heading: 'Your name in the Register of Clan Ó Comáin',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 2 — Fergus's personal letter
// ─────────────────────────────────────────────────────────────────────

function buildEmail2_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`A short word from Newhall, written by my own hand.`)}
${p(`The clan came very nearly to nothing. Between the Penal years, the Famine, and the long emigrations that followed, what you and I now share came close to vanishing from the record altogether. That your name is in the Register today is itself a small act of repair, and not a small one to me.`)}
${p(`I sit here looking out over the lawn at Killone — the abbey in its slow ruin and yet still standing, the rooks above it as they have been for centuries. The post arrives steadily now: envelopes from Boston, from Chicago, from the cities of Britain and beyond. Each one a name finding its way home. Yours is among them.`)}
${p(`I hope, in time, you will come to a gathering at Newhall and we will embrace. There is a good deal to say that does not fit on a page. Until then, your place is kept.`)}
${pItalic(`Yours, in clan and kindred,`)}
${fergusSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'From the desk of the Chief',
    heading: 'A word from Newhall',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 3 — Linda / Office: bring the kindred home
// ─────────────────────────────────────────────────────────────────────

function buildEmail3_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`A note from the Office, by the Chief's wish, on a matter the clan's revival depends on: <strong>bringing more of the kindred home</strong>.`)}
${p(`There are two simple paths from your members' area:`)}
${p(`<strong>Invitation</strong> — send a short note in your own name. It carries the Chief's letter to your friend or family member. They sign up, and you are recorded as the one who brought them.`)}
${p(`<strong>Gift</strong> — €49 buys someone a Clan Member tier. They receive a signed certificate from the Chief, which can be cherished for years.`)}
${p(`Both count toward the clan's honours — <strong>Cara</strong> at one bringing, <strong>Ardchara</strong> at five, <strong>Onóir</strong> at fifteen.`)}
${p(`If there is one in your circle who would feel the same call — a parent, a cousin, a friend with Irish roots — five minutes on the dashboard is all it takes.`)}
${ctaButtonHtml('Go to my dashboard to invite or gift', URLS.membersArea)}
${pItalic(`Go raibh míle maith agat,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'A simple way to grow the clan',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 4 — Linda / Office: gift-angle nudge (conditional)
// ─────────────────────────────────────────────────────────────────────

function buildEmail4_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`A second note from the Office. If the invitation path feels like a lot, the <strong>gift path is simpler — and probably more rewarding</strong>. €49 buys someone you love a year of membership. They receive a certificate signed by the Chief, which can be cherished for years.`)}
${p(`A few people who would be delighted to receive this gift:`)}
${p(`— An Irish-American parent in Boston, Chicago, or anywhere they have roots<br>— A cousin in Clare, Limerick, Galway who would appreciate the connection<br>— A daughter or son just beginning to explore their Irish side`)}
${p(`Five minutes, €49, a moment they will remember. The act of giving raises you in the clan's honours in turn — that is how it works.`)}
${ctaButtonHtml('Send a gift now', URLS.giftPage)}
${pItalic(`Go raibh míle maith agat,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A second note from the Office',
    heading: 'If sending an invitation feels like a lot…',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 5 — Linda / Office: how the honours work
// ─────────────────────────────────────────────────────────────────────

function buildEmail5_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`A note from the Office on how the clan's honours work — several members have asked.`)}
${p(`The three dignities are simple:`)}
${p(`<strong>Cara of Ó Comáin</strong> — for any member who brings one more into the clan. The vast majority of those raised hold this title.`)}
${p(`<strong>Ardchara</strong> — for those who bring five.`)}
${p(`<strong>Onóir</strong> — the apex, for those who bring fifteen. Very rare. The Onóir bearer is the Chief's named champion of welcome, walking ceremonially beside the Chief and the Privy Council.`)}
${p(`A few practical points:`)}
${p(`— The dignities are gender-neutral, borne the same by women and men<br>— Spouses are addressed alongside the bearer by courtesy of the kindred<br>— Both invitations AND gifts count toward the threshold`)}
${p(`If you would like the full ceremonial detail (warrant language, address-formula, etymology), it is all on the <a href="${URLS.honoursPage}" style="color:#8B6F32;text-decoration:underline">honours page</a> in the members' area.`)}
${p(`Otherwise: each dignity opens with a single bringing-in, and your <a href="${URLS.membersArea}" style="color:#8B6F32;text-decoration:underline">members' area</a> is where it is done.`)}
${ctaButtonHtml('Read the order of honours', URLS.honoursPage)}
${pItalic(`Go raibh míle maith agat,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'How the clan\u2019s honours work',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 6 — Paddy (Seanchaí): the royal house pedigree as story
// ─────────────────────────────────────────────────────────────────────

function buildEmail6_html(member) {
  const firstName = firstNameOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Paddy here — Paddy Commane of Ballymacooda. I serve the clan as <strong><em>Seanchaí (SHAN-a-kee)</em></strong>, the keeper of the stories.`)}
${p(`A few months in now, and I wanted to put down clearly a thing that ought to be said: <strong>the line you've joined is a royal one, and an old one</strong>.`)}
${p(`The line runs from the Bronze Age — four thousand years and more — through the kings of Déisi Muman in the south of Ireland, up into the Burren of County Clare where our ancestors built Cahercommane. The fort still stands, ringed in stone walls you can walk today.`)}
${p(`From there, through the long medieval centuries, the name shifted under outside pressure — Ó Comáin became Comyn, and Comyn became Cummins, Commons, Hurley, and the rest. But the line did not break.`)}
${p(`There's a saying among us <em>Seanchaithe</em> — names are like rivers. They run through different country and pick up new colours, but it's the same water all the way down. The river of Ó Comáin runs through your name too, whatever shape it takes today.`)}
${p(`The full account is on our pedigree page — forty-five footnotes, drawn from the Annals, the Brehon Genealogies, the archaeology at Cahercommane, and Y-DNA analysis.`)}
${p(`If you only read one thing about the clan, read this. It will change what you think about your name.`)}
${ctaButtonHtml('Read the pedigree', URLS.pedigreePage)}
${pItalic(`Yours,`)}
${paddySignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A word from the Seanchaí',
    heading: 'The royal house you have joined',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// SENDER FUNCTIONS
// ─────────────────────────────────────────────────────────────────────
//
// Each takes a member row and returns Promise<boolean>. From-field
// is set per author: clan@ for Herald and Paddy (institutional);
// chief@ for Fergus; linda@ for Linda's Office voice.

const FROM_HERALD = 'Clan Ó Comáin <clan@ocomain.org>';
const FROM_FERGUS = 'Fergus Commane <chief@ocomain.org>';
const FROM_LINDA  = 'Linda Commane Cryan <linda@ocomain.org>';
const FROM_CLAN   = 'Clan Ó Comáin <clan@ocomain.org>';

async function sendRegisterAck_ClanTier(member) {
  return sendEmail({
    to: member.email,
    from: FROM_HERALD,
    subject: 'Your name in the Register of Clan Ó Comáin',
    html: buildEmail1A_html(member),
  });
}

async function sendRegisterAck_GuardianPlusDefault(member) {
  return sendEmail({
    to: member.email,
    from: FROM_HERALD,
    subject: 'Your name in the public online Register of Clan Ó Comáin',
    html: buildEmail1B_html(member),
  });
}

async function sendRegisterAck_GuardianPlusOptedOut(member) {
  return sendEmail({
    to: member.email,
    from: FROM_HERALD,
    subject: 'Your name in the Register of Clan Ó Comáin',
    html: buildEmail1C_html(member),
  });
}

async function sendChiefPersonalLetter(member) {
  return sendEmail({
    to: member.email,
    from: FROM_FERGUS,
    subject: 'A word from Newhall',
    html: buildEmail2_html(member),
  });
}

async function sendLindaKindredAsk(member) {
  return sendEmail({
    to: member.email,
    from: FROM_LINDA,
    subject: 'A simple way to grow the clan',
    html: buildEmail3_html(member),
  });
}

async function sendLindaGiftNudge(member) {
  return sendEmail({
    to: member.email,
    from: FROM_LINDA,
    subject: 'If sending an invitation feels like a lot…',
    html: buildEmail4_html(member),
  });
}

async function sendLindaHonoursExplain(member) {
  return sendEmail({
    to: member.email,
    from: FROM_LINDA,
    subject: 'How the clan\u2019s honours work',
    html: buildEmail5_html(member),
  });
}

async function sendSeanchaiPedigree(member) {
  return sendEmail({
    to: member.email,
    from: FROM_CLAN,
    subject: 'The royal house you have joined',
    html: buildEmail6_html(member),
  });
}

// ─────────────────────────────────────────────────────────────────────
// PREVIEW INTEGRATION
// ─────────────────────────────────────────────────────────────────────
//
// Used by scripts/preview-post-signup-emails.mjs to render each email
// to a static HTML file for visual review without sending. Returns
// just the rendered HTML string for the given email key + member.
//
// Keys are 1A, 1B, 1C, 2, 3, 4, 5, 6 — the same identifiers used in
// the cadence document.

const PREVIEW_BUILDERS = {
  '1A': buildEmail1A_html,
  '1B': buildEmail1B_html,
  '1C': buildEmail1C_html,
  '2':  buildEmail2_html,
  '3':  buildEmail3_html,
  '4':  buildEmail4_html,
  '5':  buildEmail5_html,
  '6':  buildEmail6_html,
};

function getPreviewHtml(emailKey, member) {
  const builder = PREVIEW_BUILDERS[emailKey];
  if (!builder) throw new Error(`Unknown email key: ${emailKey}. Valid keys: ${Object.keys(PREVIEW_BUILDERS).join(', ')}`);
  return builder(member);
}

module.exports = {
  // Senders (used by daily-post-signup-sweep.js)
  sendRegisterAck_ClanTier,
  sendRegisterAck_GuardianPlusDefault,
  sendRegisterAck_GuardianPlusOptedOut,
  sendChiefPersonalLetter,
  sendLindaKindredAsk,
  sendLindaGiftNudge,
  sendLindaHonoursExplain,
  sendSeanchaiPedigree,
  // Preview (used by scripts/preview-post-signup-emails.mjs)
  getPreviewHtml,
  // For tests / introspection
  PREVIEW_BUILDERS,
};
