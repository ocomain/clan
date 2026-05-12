// netlify/functions/lib/post-signup-email.js
//
// The post-signup email lifecycle, FULL REBUILD (rev 2 — May 2026).
//
// Ten emails over the first year of membership, dispatched by
// daily-post-signup-sweep.js. Each carries a specific voice and a
// specific job; the sequence reads as correspondence from a real
// household, not a marketing template.
//
// CADENCE — anchored on members.created_at:
//
//   +3    Email 1A/B/C  THE HERALD       herald@   register acknowledgment
//                       — three variants by tier and public-register flag
//   +9    Email 2       FERGUS           chief@    Chief's letter
//                       — image-only Kensington-letterhead PNG, no chrome
//   +21   Email 3       ANTOIN (CARA)    antoin@   how I became Cara
//   +35   Email 4       LINDA / OFFICE   linda@    bringing the kindred
//                       — CONDITIONAL: skipped if member has any
//                       successful sponsorship (_35_skipped flag stamped)
//   +60   Email 5       THE HERALD       herald@   three titles of dignity
//   +90   Email 6       MICHAEL          michael@  clan crest in your home
//   +180  Email 7       PADDY (lite)     paddy@    standing of the line
//   +240  Email 8       JESSICA          jessica@  gathering at Newhall
//   +300  Email 9       PADDY (full)     paddy@    royal house and saint
//   +330  Email 10      LINDA / OFFICE   linda@    renewal mechanics
//                       — CONDITIONAL: skipped for Life-tier members
//                       (_330_skipped flag stamped)
//
// REGISTER PROTOCOL — locked:
//   - Linda never refers to Fergus by first name. Always "the Chief".
//     Same convention for the Herald, Paddy, Michael, Jessica.
//   - Antoin in Email 3 explicitly disclaims the Tánaiste role in the
//     second sentence and writes first-person as the first member ever
//     raised to Cara. This is the ONE moment the role-frame is set
//     aside for personal testimony.
//   - Only Fergus speaks first-person in his own letter (Email 2).
//   - Emails 1A/B/C all mention that titles of dignity are addressed
//     by the kindred (not just by the Chief). Critical for the
//     social-proof story Email 3 tells.
//
// SENDER GATING — some senders are not yet wired. The cron in
// daily-post-signup-sweep.js applies runtime gating; this lib emits
// the email regardless. See SENDER_READY map in the cron.
//
// VISUAL CHROME:
//   - Emails 1, 3, 4, 5, 6, 7, 8, 9, 10 use wrapInChrome() with the
//     dark-green-and-gold header, cream body, dark footer, motto.
//   - Email 2 (Fergus) is markedly different — header chrome stripped,
//     body is JUST the Kensington-letterhead PNG. The letterhead
//     carries its own header band so adding the standard chrome
//     above would double-band the page.
//
// HISTORY:
//   - rev 1 (Apr 2026): 8 emails, Linda-heavy, Herald three variants
//   - rev 2 (May 2026): 10 emails, six voices, pedigree split
//     early/late, renewal-anchored back half, Antoin first-person
//     for Cara

const { sendEmail } = require('./email');
const { generateChiefsLetterPdf } = require('./generate-chiefs-letter-pdf');
const { highestAwardedTitle, formatAddressForm } = require('./sponsor-service');

const SITE = process.env.SITE_URL || 'https://www.ocomain.org';

// ── Sender display addresses ────────────────────────────────────────
//
// All within the verified ocomain.org domain so Resend doesn't need
// per-address re-verification — the domain key signs them all.

// FROM_HERALD shortened (5 May 2026) — the longer 'The Herald of Ó
// Comáin' was being truncated by mail clients to 'The Herald of
// Ó...' which lost the household name entirely. 'The Herald' stands
// alone clearly; the household identity is reinforced inside the
// body, in the signature block, and in the burgundy wax seal.
const FROM_HERALD  = 'The Herald <herald@ocomain.org>';
const FROM_FERGUS  = 'Fergus Commane <chief@ocomain.org>';
const FROM_ANTOIN  = 'Antoin Commane <antoin@ocomain.org>';
const FROM_LINDA   = 'Linda Commane Cryan <linda@ocomain.org>';
const FROM_PADDY   = 'Paddy Commane <paddy@ocomain.org>';
const FROM_MICHAEL = 'Michael Commane <michael@ocomain.org>';
const FROM_JESSICA = 'Jessica-Lily Commane <jessica@ocomain.org>';

// ── URLs ────────────────────────────────────────────────────────────
const URLS = {
  members:        `${SITE}/members`,
  publicRegister: `${SITE}/register`,
  honours:        `${SITE}/members/honours`,
  pedigree:       `${SITE}/pedigree`,
  clanStories:    `${SITE}/clan-stories`,
  mariaStory:     `${SITE}/stories/maria-kinfauns.html`,
  gathering:      `${SITE}/members/gathering`,
  renewal:        `${SITE}/members/renewal`,
  invite:         `${SITE}/members#minvite`,
  gift:           `${SITE}/gift`,
  regalia:        `${SITE}/members/regalia`,
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

/**
 * Title-aware form-of-address for salutations.
 *
 * Returns 'Cara Aoife' / 'Ardchara Aoife' / 'Onóir Aoife' if the
 * member holds a sponsor title of dignity, otherwise just 'Aoife'.
 * The chief shows the courtesy of ALWAYS addressing a titled member
 * by their dignity in correspondence (per honours.html: 'The honours
 * follow one another: the higher is taken up; the lower is laid by').
 *
 * Reads from member.sponsor_titles_awarded (JSONB column added in
 * migration 015). The cron must SELECT this column for the member
 * row passed in here — if it's missing, this function gracefully
 * degrades to first-name-only (no error, no incorrect address).
 *
 * highestAwardedTitle handles the 'higher is taken up' rule: if a
 * member has been raised to Onóir, that's what they're addressed by,
 * even if Cara/Ardchara timestamps are also present in the JSONB
 * (the audit trail is preserved; only the current dignity is
 * spoken).
 *
 * Used in EVERY lifecycle email salutation EXCEPT the casual cover
 * note from Fergus (Email 2), which intentionally stays on
 * first-name-only as it's an intimate personal note rather than
 * formal correspondence.
 *
 * @param {object} member — must have { name }, may have
 *                          { sponsor_titles_awarded }
 * @returns {string}      — 'Cara Aoife', 'Onóir Aoife', or just 'Aoife'
 */
function addressFormOf(member) {
  const title = highestAwardedTitle(member?.sponsor_titles_awarded);
  // formatAddressForm gracefully handles missing name / missing title
  // and returns 'friend' fallback if name is unparseable.
  const result = formatAddressForm(member, title);
  return result || 'friend';
}

// ── Shared chrome (used by all emails except #2) ────────────────────
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
    <p style="font-family:'Georgia',serif;font-size:11px;color:#A88B57;margin:0;letter-spacing:0.06em">Tigh Uí Chomáin · House of Ó Comáin · <a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · <a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>
  </div>
</div>
</body>
</html>`;
}

// ── CTA button — bulletproof against iOS Mail / Outlook overrides ──
function ctaButtonHtml(label, url) {
  return `
<div style="text-align:center;margin:24px 0 28px">
  <a href="${url}" style="display:inline-block;background:#B8975A;color:#0C1A0C !important;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none !important;padding:15px 32px;border-radius:1px;mso-padding-alt:0;mso-text-raise:0"><span style="display:inline-block;color:#0C1A0C !important;font-family:&apos;Helvetica Neue&apos;,Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none !important">${escapeHtml(label)} &rarr;</span></a>
</div>`;
}

// ── Body paragraph helper ───────────────────────────────────────────
function p(text) {
  return `<p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">${text}</p>`;
}

// ── Signature blocks ────────────────────────────────────────────────
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

// Antoin sign-off — single font, single style, no italic gold treatment.
//   Line 1 (bold):   Antoin Commane, Cara of Ó Comáin
//   Line 2 (plain):  Tánaiste
function antoinSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/antoin_tanist.png" width="68" height="68" alt="Antoin Commane, Tánaiste" style="display:block;width:68px;height:68px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Antóin Commane, Cara of Ó Comáin</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0">Tánaiste</p>
      <p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:antoin@ocomain.org" style="color:#B8975A;text-decoration:none">antoin@ocomain.org</a>
        <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span>
        <a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

function michaelSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/michael_commane_capecod.png" width="68" height="68" alt="Michael Commane, Marshall" style="display:block;width:68px;height:68px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Michael Commane</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Marshall &amp; Standard Bearer of Clan Ó Comáin</p>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Maraschall &amp; Iompróir Meirgí</p>
      <p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:michael@ocomain.org" style="color:#B8975A;text-decoration:none">michael@ocomain.org</a>
        <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span>
        <a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

function jessicaSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/jessica_lily_commane.png" width="68" height="68" alt="Jessica-Lily Commane" style="display:block;width:68px;height:68px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Jessica-Lily Commane</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Keeper of the Seat of Clan Ó Comáin</p>
      <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Coimeádaí na Suíochán</p>
      <p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:jessica@ocomain.org" style="color:#B8975A;text-decoration:none">jessica@ocomain.org</a>
        <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span>
        <a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

// Herald — burgundy wax seal (matches the Sigillum seal that appears
// at the head of the public Register page at /register.html). Same
// design lifted into the email signature so the visual identity is
// continuous between the Herald's emails and the Register page the
// emails point to. Asset: the_herald_seal.png (rendered from the
// inline SVG in register.html).
function heraldSignatureHtml() {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/the_herald_seal.png" alt="Sigillum · Clan Ó Comáin" width="72" style="display:block;width:72px;height:72px;border:0">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>The Herald of Clan Ó Comáin</strong></p>
      <p style="font-family:'Georgia',serif;font-size:13px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">An tAralt</p>
      <p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:herald@ocomain.org" style="color:#B8975A;text-decoration:none">herald@ocomain.org</a>
        <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span>
        <a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a>
      </p>
    </td>
  </tr>
</table>`;
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 1A — Herald, Clan tier (+3)
// ─────────────────────────────────────────────────────────────────────
function buildEmail1A_html(member) {
  const firstName = addressFormOf(member);
  // The Register entry happens at signup (immediate). The cert seal
  // is a separate ceremonial act — set the moment the member
  // confirms the details of their entry, or by the Chief's own hand
  // automatically at the +30 day window. Universal language describes
  // the process so it reads correctly for members who've already
  // sealed (recognising the standard process, having completed it)
  // and for those who haven't yet (seeing the path).
  //
  // Branched variants were tried (commits 51dad7c, 6513347) and
  // reverted in favour of universal copy: the Herald's role at +3
  // is to welcome formally, not to drive engagement. CTA pulls and
  // state-specific framing belong in the day-29 reminder, not here.
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p('It is the Herald who keeps the Register of Clan Ó Comáin, and it is from that office that I write to you.')}
${p(`Your name has been entered into the Register, in the form you chose, and <strong>your place is formally recorded in the household of Ó Comáin</strong>. The Chief sets his seal upon your certificate at the moment you confirm the details of your entry in your members' area; should you wish your entry to stand as it is, the Chief sets his seal automatically thirty days after your joining.`)}
${p(`There is a quiet matter I should also draw to your attention. The Chief raises members of the clan, by his own hand, to <strong>three titles of dignity</strong> — Cara, Ardchara, and Onóir. Once raised, the holder is addressed by their title among the kindred — informally as <em>Cara [Firstname]</em>, and formally as <em>[Firstname] [Lastname], Cara of Ó Comáin</em>. It is a real honour, and one many members find moving when their name is read out at the gatherings.`)}
${p(`The path to <em>Cara</em> opens with a single bringing-in — by <strong>inviting one friend or family member into the Register</strong>, or by <strong>gifting them a €49 Clan Membership</strong>.`)}
${p(`Both invitations and gifts can be sent from your <a href="${URLS.members}" style="color:#8B6F32;text-decoration:underline">members' area</a>, where the count toward <em>Cara</em> is also kept.`)}
${ctaButtonHtml("Visit your members' area", URLS.members)}
${p('With the compliments of the Office, and a welcome from the household of Ó Comáin.')}
${heraldSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office of the Herald',
    heading: 'Your name in the Register',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 1B — Herald, Guardian+ default public (+3)
// Per Council edit (May 2026): "delete 'Guardian, Steward, or Life Member'"
// from the standing-paragraph. The recipient already knows their tier;
// the public-Register framing carries the importance.
//
// REGISTER DISTINCTION (5 May 2026 Council fix): Two distinct Registers
// must be kept separate in the copy:
//   1. The physical Register at Newhall — bound book kept by the Herald,
//      inscribed by the Herald. The Chief's act on a member's record
//      is signing and sealing the CERTIFICATE, not writing in the
//      Register itself; the Register is the Herald's office and book,
//      the certificate is the artefact carrying the Chief's seal.
//      (Earlier draft of 1B muddled these — see 6 May 2026 fix.)
//      Private, ceremonial.
//   2. The public online Founding Members Register — the website roll
//      at /register, browsable to anyone in the world.
//
// SCOPE OF 'BY HIS OWN HAND': reserved for the Chief's personal
// ceremonial acts — primarily raising members to titles of dignity
// (Cara/Ardchara/Onóir). It carries weight; using it for generic
// Register administration dilutes it. The dignity-conferring
// paragraph later in this same email uses it correctly.
//
// VOICE: passive throughout the Register paragraph, matching 1A
// and 1C's structure for parallelism between the three Herald
// welcomes. Earlier attempt at first-person Herald ('inscribed ...
// in my own hand') was rejected in favour of the passive form for
// consistency with the sibling emails.
//
// Previous version of 1B's first paragraph also conflated the two
// Registers ("inscribed onto the public Founding Members Register
// at Newhall, ... visible to anyone who comes to the household")
// which mixed physical-location and online-visibility into one
// muddled sentence.
// ─────────────────────────────────────────────────────────────────────
function buildEmail1B_html(member) {
  const firstName = addressFormOf(member);
  // 1B speaks to Guardian+ members on the public Register. The public
  // Register query (register.js) does NOT filter by cert_published_at —
  // Register entry happens at signup, sealing is a separate act within
  // 30 days. So the recipient IS on the public Register at +3
  // regardless of cert seal state.
  //
  // Universal language as for 1A; second sentence describes the cert
  // seal process (member-triggered or auto-seal at +30) without
  // claiming a particular state.
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Your name is now in the <strong>Register of Clan Ó Comáin</strong> — both the physical Register kept by hand at Newhall, and the <strong>public online Founding Members Register</strong>, where it stands among the founders of the present revival. The Chief sets his seal upon your certificate at the moment you confirm the details of your entry in your members' area; should you wish your entry to stand as it is, the Chief sets his seal automatically thirty days after your joining.`)}
${p('Your standing also carries with it certain other courtesies of the household, which Linda will detail in correspondence to come.')}
${ctaButtonHtml('View the public Founding Members Register', URLS.publicRegister)}
${p(`A short word about a quiet privilege of the Register. The Chief raises members, by his own hand, to <strong>three titles of dignity</strong> — <em>Cara</em>, <em>Ardchara</em>, and <em>Onóir</em>. Once raised, the Herald is commanded to make the title known among the kindred, and the holder is addressed by it thereafter — informally as <em>Cara [Firstname]</em>, and formally as <em>[Firstname] [Lastname], Cara of Ó Comáin</em>. It is a real honour, and one many members find moving when their name is read out at the gatherings.`)}
${p(`The path to <em>Cara</em> opens by bringing one person into the kindred — either by <strong>inviting a friend or family member to join</strong>, or by <strong>gifting a €49 Clan Membership to someone who would value your present</strong>.`)}
${p(`The clan is built for friends and family to share; the title marks those who do the sharing. Both invitations and gifts can be sent from your <a href="${URLS.members}" style="color:#8B6F32;text-decoration:underline">members' area</a>, where the count toward <em>Cara</em> is also kept.`)}
${p('With the compliments of the Office, and a welcome from the household of Ó Comáin.')}
${heraldSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office of the Herald',
    heading: 'Your name in the Register',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 1C — Herald, Guardian+ opted-out of public (+3)
// Per Council edit (May 2026): retain "as Guardian, Steward, or Life
// Member" — this email speaks to the member's tier specifically because
// they've made an active privacy choice; 1B's recipient is in the
// default state and doesn't need the tier callout.
// ─────────────────────────────────────────────────────────────────────
function buildEmail1C_html(member) {
  const firstName = addressFormOf(member);
  // 1C is the opt-out variant. The opt-out paragraph speaks to the
  // privacy choice. Universal cert-seal language as for 1A and 1B.
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p('It is the Herald who keeps the Register of Clan Ó Comáin, and it is from that office that I write to you.')}
${p(`Your name has been entered into the Register, in the form you chose, and your place is formally recorded in the household of Ó Comáin. The Chief sets his seal upon your certificate at the moment you confirm the details of your entry in your members' area; should you wish your entry to stand as it is, the Chief sets his seal automatically thirty days after your joining.`)}
${p(`I have noted that you have chosen <strong>not to appear on the public Register</strong>. That is entirely your right, and it is observed. Your standing as Guardian, Steward, or Life Member is the same — only the public visibility differs, and your courtesies of the household carry as fully as for any other member at your tier.`)}
${p(`A short word about a quiet privilege of the Register. The Chief raises members, by his own hand, to <strong>three titles of dignity</strong> — <em>Cara</em>, <em>Ardchara</em>, and <em>Onóir</em>. Once raised, the Herald is commanded to make the title known among the kindred, and the holder is addressed by it thereafter — informally as <em>Cara [Firstname]</em>, and formally as <em>[Firstname] [Lastname], Cara of Ó Comáin</em>. Your name need not appear on the public Register for this to be so.`)}
${p(`The path to <em>Cara</em> opens by bringing one person into the kindred — either by <strong>inviting a friend or family member to join</strong>, or by <strong>gifting a €49 Clan Membership to someone who would value your present</strong>.`)}
${p(`The clan is built for friends and family to share; the title marks those who do the sharing. Both invitations and gifts can be sent from your <a href="${URLS.members}" style="color:#8B6F32;text-decoration:underline">members' area</a>, where the count toward <em>Cara</em> is also kept.`)}
${ctaButtonHtml("Visit your members' area", URLS.members)}
${p('With the compliments of the Office.')}
${heraldSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office of the Herald',
    heading: 'Your name in the Register',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────
// EMAIL 2 — Fergus, Chief's letter (+9)
//
// SHORT COVER NOTE + PDF ATTACHMENT
//
// The Chief's full letter is now generated as a real PDF
// (lib/generate-chiefs-letter-pdf.js) using EB Garamond, the proper
// chancery stamp, and authentic letterpress aesthetic — none of the
// email-client constraints that were fighting the previous HTML
// version (web fonts not loading, position:absolute stripped by
// Gmail iOS, CSS rotation unreliable, watermarks rendering as
// blocks above the body).
//
// This function builds the short, personal cover note that arrives
// in the inbox alongside the PDF. The cover note's job is small:
//   - establish that the attached letter is genuinely from Fergus
//   - give the recipient enough warmth to make them want to open it
//   - sign personally as 'Fergus' (not 'The Chief', not 'FC') so
//     the cover reads as a personal note from the same person who
//     signed the letter
//
// Reference: Royal House of Georgia secretariat correspondence —
// short cover, signed personally, formal letter attached. That's
// the pattern this implements, with the cover coming directly from
// the Chief rather than from a secretary so the tone is personal
// rather than transactional.
//
// SENDER stays Fergus Commane <chief@ocomain.org> — same as the
// previous HTML version. The PDF attachment ships with the email.
//
// Cover note design intentionally minimal:
//   - No standard chrome (header bar, footer rule)
//   - No coat-of-arms images or stamps in the cover (those live in
//     the PDF, where they belong)
//   - Just plain serif text in a narrow column, signed 'Fergus'
//   - Tiny footer giving address + website
// The visual gravity is in the attachment, not in the cover.
// ─────────────────────────────────────────────────────────────────────
function buildEmail2_html(member) {
  // Cover note uses the title-bearing form ('Dear Cara Aoife,' for a
  // titled member, 'Dear Aoife,' otherwise) — same as the PDF inside.
  //
  // Per Council direction (6 May 2026): the Chief shows the courtesy
  // of the dignity in ALL correspondence, regardless of register. The
  // casualness of this cover note is in its CONTENT (one-line note,
  // no formal sig block, no styling) and LENGTH (four lines), not in
  // dropping the address form. A casual note from the Chief to a
  // titled member still acknowledges the dignity in the salutation;
  // the warmth and the title aren't in tension — both are courtesies.
  //
  // Earlier iteration (5 May 2026) had this on first-name-only
  // because I'd argued informal register justified dropping the
  // title — corrected: the Chief always addresses the dignity.
  const firstName = addressFormOf(member);

  // Per Council direction (5 May 2026): 'the cover letter email needs
  // to look like a normal casual email no footer no styling no detail
  // no signature'. Just the four lines specified — Dear / one-line note
  // / regards / Fergus.
  //
  // Subsequent direction (5 May 2026): 'add www.ocomain.org after
  // fergus with a br line break'. Single website link beneath the
  // sign-off, no formal sig block, still casual.
  //
  // No font-family declared so the recipient's mail client default
  // takes over (Gmail = Arial-ish sans, Apple Mail = Helvetica), which
  // looks like a real personal email rather than something composed
  // in marketing tooling.
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:16px;color:#1A1A1A;font-size:15px;line-height:1.5">
  <p style="margin:0 0 14px">Dear ${escapeHtml(firstName)},</p>
  <p style="margin:0 0 14px">A short note to say that my welcome letter to you is attached.</p>
  <p style="margin:0 0 14px">With my warm regards,</p>
  <p style="margin:0">Fergus<br><br><a href="${SITE}" style="color:#1A1A1A">www.ocomain.org</a></p>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 3 — Antoin (Cara), how I became Cara (+21)
// All May 2026 Council edits applied.
// ─────────────────────────────────────────────────────────────────────
function buildEmail3_html(member) {
  const firstName = addressFormOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Antoin Commane writing. The Chief has asked me to write to you on a particular matter, but not in my Tánaiste capacity. I write today as the first member ever raised to <strong>Cara</strong> in the present revival, and I want to tell you how that came about.`)}
${p(`When the clan reopened in 2026 I was a member like anyone else. The first title of dignity, Cara, opens with a single act: <strong>you recommend one other person who loves Ireland for membership, and they accept</strong>. That is the whole of it. I recommended a friend I'd known since school — he had Cork people on his mother's side and had always been quietly proud of it. He joined. The Chief raised me to the honour Cara at the next gathering, by his own hand.`)}
${p('Two things stay with me from that moment.')}
${p(`<strong>The first: the Chief reads your name and title out</strong> — your full name and title, before the assembled kindred — when he raises you. It is a real ceremony, in a real house, in front of real people. The Chief's hand is on your shoulder. He says the words and commands the Herald to let it be known among the kindred that I am to be addressed as <em>Cara Antoin</em>, with the place and standing belonging to that rank. There is a small applause and you sit back down and supper goes on. But the moment stays.`)}
${p(`<strong>The second: how easy it is</strong>. I had thought "recommending a friend for membership" would feel like asking someone to sign up to a service. It did not. It was telling someone I liked about something I cared about — the same thing the rest of the kindred were doing in their own ways, in cities and towns I'd never been to. Many of them tell me afterwards that they wish they'd done it sooner.`)}
${p(`If there is someone in your life — a sibling, a cousin, a friend, anyone with a love of Ireland — who you think might want a place in the Register, <strong>the path is in your members' area</strong>. You can either send them an invitation to join themselves, or gift them membership directly. Both count toward Cara.`)}
${ctaButtonHtml('Send an invitation, or gift membership', URLS.invite)}
${p('All my very best, in clan and kindred,')}
${p(`<em>Erin go bragh</em>`)}
${antoinSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Tánaiste',
    heading: 'How I became Cara',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 3B — Antoin, "I forgot to attach this" (same day as Email 3)
//
// COVER-NOTE TREATMENT (per Council direction, 6 May 2026):
// This email follows the Fergus Email 2 pattern — stripped of all
// standard chrome (no header bar, no footer, no styling, no
// signature block, no font-family declarations). The recipient's
// mail client default font takes over (Gmail = Arial-ish sans,
// Apple Mail = Helvetica), making it look like a real personal email
// rather than something composed in marketing tooling.
//
// The visual gravity is in the ATTACHMENT (Antoin's actual Cara
// letters patent PDF), not in the cover. The cover's job is just to
// say 'I meant to attach this earlier' and let the document speak.
//
// Same-day follow-up to Email 3. Triggers data-driven from the cron
// any time _21_sent_at is set but _21b_sent_at is null.
// ─────────────────────────────────────────────────────────────────────
function buildEmail3b_html(member) {
  const firstName = addressFormOf(member);
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
</head>
<body style="margin:0;padding:16px;color:#1A1A1A;font-size:15px;line-height:1.5">
  <p style="margin:0 0 14px">${escapeHtml(firstName)},</p>
  <p style="margin:0 0 14px">Sorry — meant to attach my letters patent to the earlier note and didn't. Here it is. Mine has been on the wall in the hallway since the day it arrived.</p>
  <p style="margin:0 0 14px">If you bring one person into the clan, by gift or invitation, yours will arrive soon after.</p>
  <p style="margin:0">Antoin<br><br><a href="${URLS.invite}" style="color:#1A1A1A">Send an invitation, or gift membership →</a></p>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 4 — Linda, bringing the kindred (+35) — CONDITIONAL
// Sent only if the member has zero successful sponsorships. The cron
// checks countSponsoredBy(member.id) before dispatching.
// ─────────────────────────────────────────────────────────────────────
function buildEmail4_html(member) {
  const firstName = addressFormOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`The Chief has asked me to write with a practical note on bringing kindred into the Register, since Antoin's letter on becoming <em>Cara</em> sometimes raises a small follow-up question: <strong>how, exactly, does one do it.</strong>`)}
${p('There are two ways, and you may choose whichever feels more natural to you for any given person.')}
${p(`<strong>First, an invitation to join.</strong> From your members' area, you generate a personal invitation link addressed from you. The recipient receives a short, dignified email — written by us, but signed in your name — telling them you have invited them to take a place in the Register. They click through, see what membership is, and choose for themselves whether to join. They pay their own membership fee, and your Cara dignity is conferred on the Chief's next raising.`)}
${p(`<strong>Second, gift membership.</strong> From the gift page on the website you may purchase a year of membership at any tier on someone else's behalf. They receive their certificate signed by the Chief, and a personal letter from him on Newhall headed paper. This is the path many take for parents, godchildren, and members of the kindred for whom asking them to pay would feel awkward.`)}
${p(`Both count equally toward <em>Cara</em>. The Chief considers either act — a person you invited, or a person you gifted into the Register — as the same: a member of the kindred brought home through your hand.`)}
${ctaButtonHtml("Send an invitation from your members' area", URLS.invite)}
${ctaButtonHtml('Gift membership at any tier', URLS.gift)}
${p('If you would prefer to talk it through first — particularly the awkwardness around asking, which everyone feels — please write back. I am happy to help you find the words.')}
${p('With kind regards,')}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'Bringing the kindred, in practice',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 5 — Herald, three titles of dignity (+60)
// All May 2026 Council edits applied.
// ─────────────────────────────────────────────────────────────────────
function buildEmail5_html(member) {
  const firstName = addressFormOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`I write again from the Office of the Herald — this time on the matter of the <strong>three titles of dignity of the clan</strong>, which the Chief raises members to by his own hand. <strong>These are titles of dignity and rank.</strong> They are honours of the household.`)}
${p(`<strong><em>Cara —</em></strong> in Irish, "friend". Conferred upon a member who has brought one other person of the kindred into the Register, by invitation or by gift. This is the most-conferred dignity, and it is the one many members take quiet pride in. Cara is the first acknowledgement that you have not only joined the clan but extended it.`)}
${p(`<strong><em>Ardchara —</em></strong> "high friend". Conferred upon a member who has brought five into the Register. The Chief regards Ardchara as the working honour — the dignity of the kindred who carry the household into the world more than once or twice. At the gatherings, those raised to Ardchara dine at a table near the Chief's own.`)}
${p(`<strong><em>Onóir —</em></strong> "honour". Conferred upon a member who has brought fifteen or more. Onóir is the senior dignity of the clan and is rarely conferred. Those raised to it sit on the Chief's right hand at the gatherings and are recorded as such in the Roll of the kindred. They speak in council when the Chief invites it. The dignity stays with the holder for life.`)}
${p(`All three are bestowed in person at the gatherings, where the Chief reads each name aloud and lays his hand on the shoulder of the member raised. The Herald is then commanded to make the title known among the kindred, and the holder is addressed by it thereafter — as <em>Cara [Firstname]</em>, <em>Ardchara [Firstname]</em>, or <em>Onóir [Firstname]</em>.`)}
${p(`I write because the path opens with a single act: <strong>one bringing-in</strong>, and Cara is conferred. Those who carry the work further reach Ardchara at five, and Onóir at fifteen.`)}
${ctaButtonHtml('Read the order of honours', URLS.honours)}
${p('With the compliments of the Office.')}
${heraldSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office of the Herald',
    heading: 'The three titles of dignity',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 6 — Michael (Marshall), clan crest in your home (+90)
// All May 2026 Council edits applied.
// ─────────────────────────────────────────────────────────────────────
function buildEmail6_html(member) {
  const firstName = addressFormOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Michael Commane writing — <em>Marshall and Standard Bearer</em> of Clan Ó Comáin. My office is the keeping of the clan's standards, the regalia, and the heraldic privileges of the kindred. I write today on a question that often comes up among members in the months after joining: <strong>what may I display, wear, or carry, that marks me as of the household?</strong>`)}
${p('The honest answer is: more than most realise. Membership in Ó Comáin carries the Chief\'s approval for the use of the clan crest and <strong>our tartan</strong> on <strong>personal items and stationery</strong>. This includes, but is not limited to:')}
${p(`<strong>The crest on signet rings, bookplates, embroidered linens, blazer pockets, engraved silverware, and family stationery.</strong> These are the traditional uses, and the ones members most often commission. The crest is the mermaid of Newhall Lake playing the harp — the same figure on the Chief's stamp.`)}
${p(`<strong>Our tartan worn at family events, and at the Guardian's Dinner during the gathering.</strong> Members wear our tartan trousers (or skirt) at the formal evening at Newhall — the dress code for the Guardian's Dinner is white tie or black tie with our tartan as the trouser. Members wear our tartan also at weddings, christenings, funerals, and the gatherings. It is for the kindred, not for sale to the public.`)}
${p(`<strong>The crest at significant family ceremonies.</strong> Many members request a small embossed crest seal for the order-of-service at family weddings or christenings — a practical and quiet way to mark a moment as connected to the wider household. The Chancellor's office can supply the digital arms file on request.`)}
${p(`<strong>The crest on the headstone or memorial of a member.</strong> Should the time come, the household has standing approval for the crest to be placed on the headstone or memorial of any member. This is a long-held privilege of clan membership and one we honour without question.`)}
${p(`These privileges remain in your name for as long as you are a member in good standing. The Chief regards them as an extension of your standing in the household, not a perk.`)}
${ctaButtonHtml('Request the digital arms or tartan details', URLS.regalia)}
${p('If there is a particular use you have in mind that I have not mentioned — a vehicle insignia, a piece of jewellery commissioned for a specific occasion — please write to me directly. I am happy to confirm whether the use is within the household\'s standing approval, and to assist with anything specialised.')}
${p('Yours, in service of the clan,')}
${michaelSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: "A note from the Marshall's office",
    heading: 'The clan crest in your home',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 7 — Paddy lite, standing of the line (+180)
// Reframed as Gaelic story-telling per Council direction.
// ─────────────────────────────────────────────────────────────────────
function buildEmail7_html(member) {
  const firstName = addressFormOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Paddy here — Paddy Commane of Ballymacooda, your <em>Seanchaí (SHAN-a-kee)</em>. Half a year you've been with us now, and around this time of the year a small voice tends to whisper into the back of the kindred's thoughts: <em>is this real? what is it, exactly, that I've put my name to?</em>`)}
${p(`The Chief asked me to answer it the Seanchaí's way, which is by telling. So I'll tell you a thing or two, and the long telling I'll keep for the year-end.`)}
${p(`There's a stone fort on the Burren, in County Clare, called <strong>Cahercommane</strong>. You can stand on the ridge near it of an evening and the wind will come over the limestone the way it has done for four thousand years. The fort was built around 800 BCE — older than the Pyramids of Giza by some accounts, though the Egyptians might quibble. The Ó Comáin chieftains held it as their seat. They did so for so long that when the archaeologists ran the Y-DNA analysis on the present-day kindred and compared it against the bones beneath the fort, the line came up unbroken. <strong>The same blood, four millennia, the same ground.</strong>`)}
${p(`That's not me telling tales. That's the science.`)}
${p(`The story of how the clan was recognised again in our own century is shorter. <strong>Clans of Ireland</strong> — the official body of the Republic, established in 1989 under the patronage of the President — verified the antiquity of the Gaelic name, the line, and the Chief's claim. The committee does not give such recognitions lightly. There are very few authenticated Gaelic clans, and Ó Comáin is among them.`)}
${p(`And the Chief himself — <strong>Fergus Commane</strong> — was consecrated under <em>Brehon law</em>, in the old way, by the <em>derbhfine</em> of the kindred. (The derbhfine is the assembly of those of the clan with the recognised right to confirm the Chief — a Gaelic institution older than Crown or Parliament.) He's the custodian today of <em>Killone Abbey</em> and the <em>Holy Well of St John the Baptist</em>, both upon the Newhall estate. Real places. You can walk to them.`)}
${p(`So there is the short of it: <strong>a real fort, a real line, a real Chief, lawfully recognised, openly authenticated.</strong> No invention. No fanciful claim. A clan in active modern revival.`)}
${p(`The longer story — the kings of Déisi, the saint, the long erasure of the Penal years and what is being unmade now — that is the Seanchaí's year-end letter to come. For tonight, only the plainer note: that voice in the back of your thoughts can rest. <strong>You've put your name to something real.</strong>`)}
${ctaButtonHtml('Read the full pedigree', URLS.pedigree)}
${p('Yours, in clan and story,')}
${paddySignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A word from the Seanchaí',
    heading: 'The standing of the line',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 8 — Jessica-Lily, gathering at Newhall (+240)
// Bubblier voice per Council direction.
// ─────────────────────────────────────────────────────────────────────
function buildEmail8_html(member) {
  const firstName = addressFormOf(member);
  const body = `
${p(`Hi ${escapeHtml(firstName)}! 💚`)}
${p(`Jessica-Lily here — your <em>Coimeádaí na Suíochán</em>, which sounds frightfully grand but really just means I'm the one who makes sure there's a chair at the table for everyone who wants one at Newhall. The Chief asked me to write to you because something rather lovely is being planned and you should be the first to know.`)}
${p(`We're putting on the <strong>first revival gathering at Newhall this summer</strong> — and after eight hundred years of the clan being scattered, that sentence is still giving me goosebumps as I type it.`)}
${p(`Here's what we're cooking up. Two days at Newhall House on the estate. The kindred coming in from across Ireland, Britain, the United States, Australia — many of them meeting cousins they never knew they had. There'll be a <strong>formal evening with the Chief and the Privy Council</strong> (which I promise is much more fun than it sounds — there's pipe music, and supper goes very late). On the second morning, a procession to <strong>Cahercommane</strong>, the great stone fort. Music in the long room. The raising of those members the Chief has chosen to honour with <em>Cara</em>, <em>Ardchara</em>, or <em>Onóir</em>. And ample time at the lake and around the gardens — bring a swim, the lake is glorious in July.`)}
${p(`Children are welcome. So is the dog, if the dog is well-behaved (and your honour will be on the line as to whether it is).`)}
${p(`The thing I get asked most often is <em>what does one wear?</em> Honest answer: <strong>what you'd wear to a country wedding</strong>. Our tartan if you have it, smart otherwise. The Chief is in tweeds by the second morning, and at the formal evening it's white tie or black tie with our tartan as the trouser (or the skirt — same rules either way, no pressure on style). If anyone tells you there's a strict dress code, that's me, but only because I want everyone to feel right when they arrive.`)}
${p(`<strong>Members in good standing get priority booking</strong> when registration opens in <strong>early summer</strong>. Capacity is limited — Newhall is a real house, not a function venue — and we expect this first gathering to fill quickly. I'll write again with the booking link the moment it opens.`)}
${p(`I write now because your year of standing renews in the coming weeks, and <strong>renewal is what unlocks booking</strong>. Linda will write to you on the practical side nearer the time. From me, only the warm suggestion that, if you're thinking of coming — and oh, I do hope you are — keeping your standing intact means your seat is held.`)}
${ctaButtonHtml('Read about the gathering at Newhall', URLS.gathering)}
${p('Cannot wait to meet you in person,')}
${jessicaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Keeper of the Seat',
    heading: 'Plans for the gathering at Newhall',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 9 — Paddy full, royal house and saint (+300)
// Reframed as full Seanchaí story-telling per Council direction.
// ─────────────────────────────────────────────────────────────────────
function buildEmail9_html(member) {
  const firstName = addressFormOf(member);
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`Paddy here. The year is nearly out, and I owe you the longer telling. Pour yourself something. Settle in. This is a Seanchaí's letter, the way they were always meant to be told — not from a textbook, but as a story passed down to a kinsman who has just come home.`)}
${p(`We start on the Burren, on the high stone ridge, four thousand years back.`)}
${p(`The people called themselves the <strong>Déisi Muman</strong> — the Déisi of Munster — and they were a confederation of fierce, learned, wandering peoples whose original seat was in what is now County Waterford. They pressed westward, generation after generation, until their leading line reached the limestone country of Clare and built a fort there. <em>Cahercommane.</em> Three concentric stone walls, raised by the bare hands of men whose names are long gone and whose blood, by the strangest grace, is still in your kinsmen today.`)}
${p(`Time moved on, as time does. The kings of Déisi held that fort and the lands around it through the long Bronze Age into the Iron Age, and on into the Christian centuries. And here's where the story takes a turn that I love most in all of it.`)}
${p(`In the seventh century, a man named <strong>Commán</strong> was born of the line. He chose the cloister over the chieftaincy. He went out into the wild west of Ireland and founded the monastery at Roscommon — <em>Ros Comáin</em>, the wood of Commán — and another at Kinvara on the bay. He healed people. He preached the Gospel to the chieftains who still drank their wine in the old halls. He died in odour of sanctity, and the Church recognised him as a saint, and he is venerated to this day.`)}
${p(`<strong>Saint Commán is our patron.</strong> He is who the clan calls upon. The shamrock border around our coat of arms is for the protection of the Holy Trinity, the saint, and the deep ecclesiastical strand in the clan's heritage. The harp the mermaid plays is for the music of the line. The mermaid herself is for Newhall Lake — the household's mystical guardian, in the story we tell about her.`)}
${p(`From the saint, the line carries through the medieval centuries. The Lords of Kinvara, who held court at the bay. The Ó Comáin chieftains who fought at the Battle of Knockdoe in 1504, where ten thousand Irishmen of all the clans rose against the encroaching Crown. They lost the battle. They did not lose the line.`)}
${p(`Then came the long erasure. The Penal years. The Famine. The Catholic Gaelic clans were systematically dismantled — the lands taken, the chiefs scattered, the names anglicised by clerks who could not hear what their bearers were saying. <strong>Ó Comáin became Cummins, Commins, Commons, Comyn, Coman, Hurley</strong> — the same line wearing different names, the way a river runs the same water through a hundred miles of country. The diaspora carried those scattered names to America, Australia, the cities of Britain. The clan was suppressed for almost eight hundred years.`)}
${p(`And here we come to the part that is happening now.`)}
${p(`What is occurring is a <strong>revival</strong>. Lawfully recognised, openly authenticated. The Chief's consecration under Brehon law. The recognition by Clans of Ireland. The rebuilding of Newhall as the household seat. The gatherings, the Register, the kindred — none of this is invention. It is restoration. <strong>The line was always there.</strong> What was missing was the household, and that is what is being rebuilt — with your name, now, among those rebuilding it.`)}
${p(`And there is one more thread, the hardest to tell. The revival in our own day was not begun for legal reasons or for heritage reasons alone. It began in 2023, in a particular grief, in the Chief's own family. <a href="${URLS.mariaStory}" style="color:#8B6F32;text-decoration:underline">Maria has told that story in her own words.</a> I will not retell it here. But you should know that the work you are now part of began there — and the love that has gathered the kindred since is the answer the family chose to give it.`)}
${p(`That, in the shape of a Seanchaí's telling, is the story of the line you carry. <strong>You are not joining a club. You are taking your place in a real and lawful royal house, with a saint at its centre, with a four-thousand-year line behind it, in active modern revival.</strong>`)}
${p(`I wanted you to hear it told, before the year was out. Sleep on it. Carry it.`)}
${ctaButtonHtml('Read the full pedigree of the line', URLS.pedigree)}
${p('Yours, in clan and story,')}
${paddySignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: "The Seanchaí's year-end letter",
    heading: 'The royal house and the saint',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// EMAIL 10 — Linda, renewal mechanics (+330) — CONDITIONAL
// Sent only for non-Life-tier members. Life Members get _330_skipped
// stamped true. Assumes a card on file (founders invited by the Chief
// without cards on file receive a separate flow).
// ─────────────────────────────────────────────────────────────────────
function buildEmail10_html(member) {
  const firstName = addressFormOf(member);
  const renewalDate = '[renewal_date]'; // literal placeholder — substituted in future
  const body = `
${p(`Dear ${escapeHtml(firstName)},`)}
${p(`In the Brehon law of the old kingdoms, <em>a year and a day</em> marked the threshold of claim &mdash; the time after which a thing was held to be truly yours, by your standing in it rather than by mere arrival. Your year in the Register of Clan Ó Comáin reaches that threshold in the coming weeks.`)}
${p(`It has also been a year of the heritage and cultural revival of Ó Comáin and the ways of Gaelic Ireland &mdash; a revival to which your standing has been a real contribution.`)}
${p(`The Chief has asked me to write with a practical note: your year of standing renews on <strong>${renewalDate}</strong>, which is approximately one month from today.`)}
${p(`There is nothing for you to do — <strong>the Office shall handle the renewal on your behalf using the card you have on file</strong>. The renewal preserves your standing without break, and <strong>Jessica's priority booking for the gathering at Newhall opens to renewed members the moment the renewal lands</strong>. The two are joined: standing intact, seat at Newhall held.`)}
${p(`Should you wish to <strong>raise your tier</strong> — to Guardian for the Newhall dinner and printed letter from the Chief, or to Steward for your name engraved on the Clan Roll of Honour at Newhall House (a permanent physical record in the clan seat), or to Life for standing in perpetuity — please tell me before ${renewalDate} and the renewal will be processed at the new tier instead. The difference is taken at renewal; nothing further is needed from you.`)}
${ctaButtonHtml('Manage your renewal', URLS.renewal)}
${p(`Should you wish <strong>not to renew</strong>, you may either click cancel in your members' area or write back to me directly. Either is fine, and there is no awkwardness on this side. We've enjoyed having you among the kindred for the year. Your name and the year of your standing are inscribed in the Herald's Register at Newhall &mdash; a hand-bound annual volume, written alphabetically by a professional scribe at year's end, and kept permanently in the clan seat.`)}
${p(`With kind regards, and the Chief's thanks for the year and a day of your standing,`)}
${lindaSignatureHtml()}
`;
  return wrapInChrome({
    eyebrow: 'A note from the Office',
    heading: 'Your year and a day',
    bodyHtml: body,
  });
}

// ─────────────────────────────────────────────────────────────────────
// SENDERS
// ─────────────────────────────────────────────────────────────────────

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
    subject: 'Your name in the public Register of Clan Ó Comáin',
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
  // Generate the Chief's welcome letter as a PDF. The PDF is attached
  // to the email and is the primary artefact of this dispatch — the
  // HTML body is just a short cover note from Fergus pointing to it.
  //
  // ADDRESS FORM — the PDF salutation uses the title-bearing form
  // ('Dear Cara Aoife,' for a member raised to Cara, etc.) per the
  // chivalric convention that the Chief always addresses titled
  // members by their dignity in formal correspondence. The cover
  // note in the email body uses casual first-name only — informal/
  // formal registers correctly distinguished.
  //
  // PDF generation is best-effort: if it fails, we still ship the
  // cover email (the recipient gets a personal note from Fergus
  // explaining the welcome, just without the formal letter attached).
  // Graceful degradation — better than blocking the entire post-
  // signup sequence on a transient PDF failure.
  let attachments = undefined;
  try {
    const addressForm = addressFormOf(member);
    const pdfBytes = await generateChiefsLetterPdf({ addressForm });
    attachments = [{
      filename: 'A letter from the Chief of Clan Ó Comáin.pdf',
      content: Buffer.from(pdfBytes).toString('base64'),
    }];
  } catch (err) {
    console.error('sendChiefPersonalLetter: PDF generation failed (non-fatal):', err.message, err.stack);
    // attachments stays undefined; cover email still ships
  }

  // Personalise the subject with the recipient's address-form. This is
  // the same string used in the PDF salutation: 'Cara Aoife' if the
  // member has been raised to a sponsor dignity, otherwise just
  // 'Aoife'. Subject becomes:
  //     'Letter for Cara Aoife from the desk of the Chief'   (titled)
  //     'Letter for Aoife from the desk of the Chief'         (untitled)
  // If addressFormOf returns its 'friend' fallback (no parseable name
  // on the row, shouldn't happen in production but possible if a
  // founder gift was created without a recipient_name) we ship the
  // unpersonalised subject — "Letter for friend from..." would read
  // worse than just dropping the personalisation.
  const addressee = addressFormOf(member);
  const subject = addressee && addressee !== 'friend'
    ? `Letter for ${addressee} from the desk of the Chief`
    : 'From the desk of the Chief';

  return sendEmail({
    to: member.email,
    from: FROM_FERGUS,
    subject,
    html: buildEmail2_html(member),
    attachments,
  });
}

async function sendAntoinHowIBecameCara(member) {
  return sendEmail({
    to: member.email,
    from: FROM_ANTOIN,
    subject: 'How I became Cara — the simplest thing the clan asks of you',
    html: buildEmail3_html(member),
  });
}

async function sendAntoinForgotToAttach(member) {
  // Cover note is intentionally plain (per Council direction, 6 May
  // 2026): looks like a real personal note, not a marketing email.
  // The visual gravity is the ATTACHMENT — Antoin's actual Cara
  // letters patent. Same pattern as Fergus Email 2.
  //
  // Attachment is best-effort: if the file read fails for any reason,
  // the cover email still ships (the recipient gets a follow-up note
  // explaining the patent, just without the file attached). Graceful
  // degradation matches the sendChiefPersonalLetter pattern.
  let attachments = undefined;
  try {
    const fs = require('fs');
    const path = require('path');
    const pdfPath = path.join(__dirname, '..', 'assets', 'antoin_cara_patent.pdf');
    // Explicit existence check so the failure mode is loud in logs
    // rather than silently swallowed by the catch. The Netlify
    // bundler does not always include net-new asset files added in
    // the same commit as their first reference (per the deploy
    // gotcha in DDW's notes — fix is 'Clear cache and deploy site').
    if (!fs.existsSync(pdfPath)) {
      console.error(`sendAntoinForgotToAttach: PDF NOT BUNDLED at ${pdfPath} — likely a Netlify cache issue, try Clear cache and deploy site`);
      console.error(`sendAntoinForgotToAttach: __dirname is ${__dirname}, contents:`, fs.existsSync(__dirname) ? fs.readdirSync(__dirname).join(', ') : '(__dirname missing)');
      const assetsDir = path.join(__dirname, 'assets');
      if (fs.existsSync(assetsDir)) {
        console.error(`sendAntoinForgotToAttach: assets dir contents:`, fs.readdirSync(assetsDir).join(', '));
      } else {
        console.error('sendAntoinForgotToAttach: assets/ dir does not exist in bundle');
      }
    } else {
      const pdfBytes = fs.readFileSync(pdfPath);
      console.log(`sendAntoinForgotToAttach: PDF loaded, ${pdfBytes.length} bytes`);
      attachments = [{
        filename: 'Letters Patent — Antoin Commane, Cara of Ó Comáin.pdf',
        content: Buffer.from(pdfBytes).toString('base64'),
      }];
    }
  } catch (err) {
    console.error('sendAntoinForgotToAttach: PDF attachment failed (non-fatal):', err.message);
    // attachments stays undefined; cover email still ships
  }

  return sendEmail({
    to: member.email,
    from: FROM_ANTOIN,
    subject: 'I forgot to attach this',
    html: buildEmail3b_html(member),
    attachments,
  });
}

async function sendLindaBringingKindred(member) {
  return sendEmail({
    to: member.email,
    from: FROM_LINDA,
    subject: 'Bringing the kindred, in practice — a practical note',
    html: buildEmail4_html(member),
  });
}

async function sendHeraldThreeDignities(member) {
  return sendEmail({
    to: member.email,
    from: FROM_HERALD,
    subject: 'The three titles of dignity — Cara, Ardchara, Onóir',
    html: buildEmail5_html(member),
  });
}

async function sendMichaelClanCrest(member) {
  return sendEmail({
    to: member.email,
    from: FROM_MICHAEL,
    subject: 'The clan crest in your home — what members may display',
    html: buildEmail6_html(member),
  });
}

async function sendPaddyStandingOfTheLine(member) {
  return sendEmail({
    to: member.email,
    from: FROM_PADDY,
    subject: "The standing of the line — a Seanchaí's note",
    html: buildEmail7_html(member),
  });
}

async function sendJessicaGathering(member) {
  return sendEmail({
    to: member.email,
    from: FROM_JESSICA,
    subject: 'Plans for the gathering at Newhall',
    html: buildEmail8_html(member),
  });
}

async function sendPaddyRoyalHouseAndSaint(member) {
  return sendEmail({
    to: member.email,
    from: FROM_PADDY,
    subject: "The royal house and the saint — the Seanchaí's year-end letter",
    html: buildEmail9_html(member),
  });
}

async function sendLindaRenewal(member) {
  return sendEmail({
    to: member.email,
    from: FROM_LINDA,
    subject: 'Your year and a day in the Register — a practical note on renewal',
    html: buildEmail10_html(member),
  });
}

// ─────────────────────────────────────────────────────────────────────
// PREVIEW INTEGRATION
// ─────────────────────────────────────────────────────────────────────
const PREVIEW_BUILDERS = {
  '1A': buildEmail1A_html,
  '1B': buildEmail1B_html,
  '1C': buildEmail1C_html,
  '2':  buildEmail2_html,
  '3':  buildEmail3_html,
  '3B': buildEmail3b_html,
  '4':  buildEmail4_html,
  '5':  buildEmail5_html,
  '6':  buildEmail6_html,
  '7':  buildEmail7_html,
  '8':  buildEmail8_html,
  '9':  buildEmail9_html,
  '10': buildEmail10_html,
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
  sendAntoinHowIBecameCara,
  sendAntoinForgotToAttach,
  sendLindaBringingKindred,
  sendHeraldThreeDignities,
  sendMichaelClanCrest,
  sendPaddyStandingOfTheLine,
  sendJessicaGathering,
  sendPaddyRoyalHouseAndSaint,
  sendLindaRenewal,
  // Preview (used by scripts/preview-post-signup-emails.mjs)
  getPreviewHtml,
  PREVIEW_BUILDERS,
};
