#!/usr/bin/env node
// scripts/preview-post-signup-emails.mjs
//
// Renders every variant of the post-signup email lifecycle (rev 2,
// May 2026) to a static HTML file in ./email-previews/, so they can
// be opened in a browser and visually reviewed without sending real
// mail.
//
// USAGE:
//   node scripts/preview-post-signup-emails.mjs
//   open email-previews/index.html
//
// Twelve files written (one per email variant + index):
//
//   01a-herald-clan-tier.html              Email 1A — Herald, Clan tier
//   01b-herald-guardian-default.html       Email 1B — Herald, Guardian+ default
//   01c-herald-guardian-private.html       Email 1C — Herald, Guardian+ opted out
//   02-fergus-chiefs-letter.html           Email 2  — Fergus, Chief's letter (image-only)
//   03-antoin-how-i-became-cara.html       Email 3  — Antoin, how I became Cara
//   04-linda-bringing-kindred.html         Email 4  — Linda, bringing the kindred
//   05-herald-three-dignities.html         Email 5  — Herald, three titles of dignity
//   06-michael-clan-crest.html             Email 6  — Michael, clan crest in your home
//   07-paddy-standing-of-line.html         Email 7  — Paddy lite, standing of the line
//   08-jessica-gathering.html              Email 8  — Jessica, gathering at Newhall
//   09-paddy-royal-house-and-saint.html    Email 9  — Paddy full, royal house and saint
//   10-linda-renewal.html                  Email 10 — Linda, renewal mechanics
//
// IMAGE PATHS resolve against SITE_URL (default https://www.ocomain.org).
// Photo bubbles, coat of arms, etc. all load from the live site, not
// from the local repo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { getPreviewHtml } = require('../netlify/functions/lib/post-signup-email');

// Mock member used for {{firstName}} substitution in the preview.
const MOCK_MEMBER = {
  id: 'preview-member-uuid-0001',
  email: 'aoife.example@ocomain.org',
  name: 'Aoife Commane',
  tier: 'guardian-ind',
  public_register_visible: true,
  created_at: new Date().toISOString(),
};

const VARIANTS = [
  { key: '1A', file: '01a-herald-clan-tier.html',           day: '+3',   title: 'Email 1A — Herald — Your name in the Register (Clan tier)',                                  meta: 'Sent when tier starts with <code>clan-</code>' },
  { key: '1B', file: '01b-herald-guardian-default.html',    day: '+3',   title: 'Email 1B — Herald — Your name in the public Register (Guardian+ default)',                  meta: 'Sent when tier ≥ Guardian AND <code>public_register_visible = true</code>' },
  { key: '1C', file: '01c-herald-guardian-private.html',    day: '+3',   title: 'Email 1C — Herald — Your name in the Register (Guardian+ opted out)',                       meta: 'Sent when tier ≥ Guardian AND <code>public_register_visible = false</code>' },
  { key: '2',  file: '02-fergus-chiefs-letter.html',        day: '+9',   title: 'Email 2 — Fergus — From the desk of the Chief',                                              meta: 'Universal — chief@ocomain.org · image-only Kensington-letterhead PNG' },
  { key: '3',  file: '03-antoin-how-i-became-cara.html',    day: '+21',  title: 'Email 3 — Antoin (Cara) — How I became Cara',                                                meta: 'Universal — antoin@ocomain.org · first-person social proof' },
  { key: '3B', file: '03b-antoin-i-forgot-to-attach.html',   day: '+21',  title: 'Email 3B — Antoin (Cara) — I forgot to attach this',                                         meta: 'Same-day follow-up to Email 3 · embeds Antoin\'s actual Cara patent' },
  { key: '4',  file: '04-linda-bringing-kindred.html',      day: '+35',  title: 'Email 4 — Linda — Bringing the kindred, in practice',                                        meta: 'Conditional — only if <code>countSponsoredBy(member) === 0</code>' },
  { key: '5',  file: '05-herald-three-dignities.html',      day: '+60',  title: 'Email 5 — Herald — The three titles of dignity',                                             meta: 'Universal — herald@ocomain.org · Cara / Ardchara / Onóir' },
  { key: '6',  file: '06-michael-clan-crest.html',          day: '+90',  title: 'Email 6 — Michael — The clan crest in your home',                                            meta: 'Universal — michael@ocomain.org · regalia, our tartan, signet rings, headstones' },
  { key: '7',  file: '07-paddy-standing-of-line.html',      day: '+180', title: 'Email 7 — Paddy (Seanchaí lite) — The standing of the line',                                 meta: 'Universal — paddy@ocomain.org · early pedigree as story' },
  { key: '8',  file: '08-jessica-gathering.html',           day: '+240', title: 'Email 8 — Jessica-Lily — Plans for the gathering at Newhall',                                meta: 'Universal — jessica@ocomain.org · bubbly anticipation builder' },
  { key: '9',  file: '09-paddy-royal-house-and-saint.html', day: '+300', title: 'Email 9 — Paddy (Seanchaí full) — The royal house and the saint',                            meta: 'Universal — paddy@ocomain.org · year-end pedigree as story' },
  { key: '10', file: '10-linda-renewal.html',               day: '+330', title: 'Email 10 — Linda — Your year of standing renews',                                            meta: 'Conditional — sent for non-Life tiers only' },
];

const OUT_DIR = path.resolve(__dirname, '..', 'email-previews');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('Rendering email previews to', OUT_DIR);

for (const v of VARIANTS) {
  let html = getPreviewHtml(v.key, MOCK_MEMBER);
  // Inject <meta name="robots" content="noindex,nofollow"> into the
  // <head> so these previews stay out of search engine results.
  html = html.replace(
    '<meta charset="UTF-8">',
    '<meta charset="UTF-8"><meta name="robots" content="noindex,nofollow">'
  );
  fs.writeFileSync(path.join(OUT_DIR, v.file), html, 'utf8');
  console.log('  ✔', v.file);
}

const indexHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Post-signup email previews — Clan Ó Comáin</title>
<style>
  body { font-family: 'Georgia', serif; background: #F8F4EC; color: #1A1A1A; margin: 0; padding: 40px; max-width: 720px; margin: 0 auto; }
  h1 { color: #0C1A0C; font-size: 28px; font-weight: 400; border-bottom: 2px solid #B8975A; padding-bottom: 12px; }
  .lede { color: #555; font-style: italic; margin-bottom: 32px; }
  ol { padding-left: 0; list-style: none; }
  li { background: white; border: 1px solid #E0DACA; border-left: 3px solid #B8975A; padding: 18px 22px; margin-bottom: 12px; border-radius: 1px; }
  li a { color: #0C1A0C; text-decoration: none; font-weight: 600; font-size: 17px; }
  li a:hover { color: #B8975A; }
  .day { display: inline-block; background: #B8975A; color: #0C1A0C; font-family: sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; padding: 4px 10px; border-radius: 1px; margin-right: 12px; vertical-align: middle; }
  .meta { color: #6C5A4A; font-size: 13px; margin-top: 6px; font-style: italic; }
  footer { margin-top: 40px; color: #6C5A4A; font-size: 12px; font-style: italic; text-align: center; }
</style></head>
<body>
  <h1>Post-signup email previews</h1>
  <p class="lede">Twelve files across ten emails (1A/B/C are tier-branched variants of the +3 send). Click any title to open the rendered email exactly as it would arrive in an inbox. Photo bubbles, coat of arms, and CTA links resolve against <code>${process.env.SITE_URL || 'https://www.ocomain.org'}</code>.</p>
  <ol>
    ${VARIANTS.map(v => `<li><span class="day">${v.day}</span><a href="${v.file}">${v.title}</a><div class="meta">${v.meta}</div></li>`).join('\n    ')}
  </ol>
  <footer>Mock recipient: ${MOCK_MEMBER.name} &lt;${MOCK_MEMBER.email}&gt;</footer>
</body></html>`;

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');
console.log('  ✔ index.html');
console.log('\nDone. Open in your browser:');
console.log('  open', path.join(OUT_DIR, 'index.html'));
