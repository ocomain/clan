#!/usr/bin/env node
// scripts/preview-post-signup-emails.mjs
//
// Renders every variant of the post-signup email lifecycle to a
// static HTML file in ./email-previews/, so you can open them in a
// browser and visually review the rendering — the chrome, the
// signature blocks, the CTA buttons, the photo bubbles for Linda /
// Paddy / Fergus — without sending real mail.
//
// USAGE:
//   node scripts/preview-post-signup-emails.mjs
//   open email-previews/index.html
//
// The script writes one HTML file per email variant plus an
// index.html with thumbnails-ish links. All eight variants:
//
//   01a-clan-tier-upsell.html              Email 1A — Herald
//   01b-guardian-default.html              Email 1B — Herald
//   01c-guardian-opted-out.html            Email 1C — Herald
//   02-fergus-personal-letter.html         Email 2  — Fergus
//   03-linda-kindred-ask.html              Email 3  — Linda / Office
//   04-linda-gift-nudge.html               Email 4  — Linda / Office
//   05-linda-honours-explainer.html        Email 5  — Linda / Office
//   06-paddy-seanchai-pedigree.html        Email 6  — Paddy / Seanchaí
//
// IMAGE PATHS — the rendered emails reference images via SITE_URL,
// which defaults to https://www.ocomain.org. Photos in signature
// blocks (linda_cryan_bubble.png, paddy_commane_ballymacooda.png,
// fergus_at_killone.png) and the coat of arms in the header will
// load from the live site, NOT from the local repo. This is the same
// way they will load when the email arrives in a real inbox, so the
// preview is faithful. If you want to preview against a local SITE,
// set SITE_URL=http://localhost:8888 before running this script and
// the same path scheme will resolve against your dev server.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// The lib is CommonJS (matches the rest of netlify/functions/lib/),
// so we use createRequire to load it from this ESM script.
const { getPreviewHtml } = require('../netlify/functions/lib/post-signup-email');

// Mock member used for {{firstName}} substitution in the preview.
// Aoife is a common Irish name and reads naturally in every email's
// salutation. Tier and register flag don't affect the preview output
// for any single email — they are used by the cron sweep to BRANCH
// to the correct 1A/B/C; here we render all three regardless.
const MOCK_MEMBER = {
  id: 'preview-member-uuid-0001',
  email: 'aoife.example@ocomain.org',
  name: 'Aoife Commane',
  tier: 'guardian-ind',
  public_register_visible: true,
  created_at: new Date().toISOString(),
};

const VARIANTS = [
  { key: '1A', file: '01a-clan-tier-upsell.html',          title: 'Email 1A — Herald — Clan tier (upsell)' },
  { key: '1B', file: '01b-guardian-default.html',          title: 'Email 1B — Herald — Guardian+ default'   },
  { key: '1C', file: '01c-guardian-opted-out.html',        title: 'Email 1C — Herald — Guardian+ opted-out' },
  { key: '2',  file: '02-fergus-personal-letter.html',     title: 'Email 2 — Fergus — A word from Newhall'  },
  { key: '3',  file: '03-linda-kindred-ask.html',          title: 'Email 3 — Linda — Bringing the kindred (Office)' },
  { key: '4',  file: '04-linda-gift-nudge.html',           title: 'Email 4 — Linda — Gift-angle nudge (Office)' },
  { key: '5',  file: '05-linda-honours-explainer.html',    title: 'Email 5 — Linda — Honours explainer (Office)' },
  { key: '6',  file: '06-paddy-seanchai-pedigree.html',    title: 'Email 6 — Paddy (Seanchaí) — Pedigree'   },
];

const OUT_DIR = path.resolve(__dirname, '..', 'email-previews');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('Rendering email previews to', OUT_DIR);

for (const v of VARIANTS) {
  const html = getPreviewHtml(v.key, MOCK_MEMBER);
  const outPath = path.join(OUT_DIR, v.file);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('  ✔', v.file);
}

// Index page with links to each — also a good visual list for
// reviewing the full lifecycle in one place. Styled to match the
// clan visual identity loosely so the index itself feels in-house.
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
  <p class="lede">Eight variants across six time buckets. Click any title to open the rendered email exactly as it would arrive in an inbox. Photo bubbles, coat of arms, and CTA links all resolve against <code>${process.env.SITE_URL || 'https://www.ocomain.org'}</code>.</p>
  <ol>
    <li><span class="day">+3</span><a href="01a-clan-tier-upsell.html">Email 1A — Herald — Clan tier (upsell to Guardian+)</a><div class="meta">Sent when tier starts with <code>clan-</code></div></li>
    <li><span class="day">+3</span><a href="01b-guardian-default.html">Email 1B — Herald — Guardian+ default (name on public Register)</a><div class="meta">Sent when tier ≥ Guardian AND <code>public_register_visible = true</code></div></li>
    <li><span class="day">+3</span><a href="01c-guardian-opted-out.html">Email 1C — Herald — Guardian+ opted out</a><div class="meta">Sent when tier ≥ Guardian AND <code>public_register_visible = false</code></div></li>
    <li><span class="day">+9</span><a href="02-fergus-personal-letter.html">Email 2 — Fergus — A word from Newhall</a><div class="meta">Universal — chief@ocomain.org</div></li>
    <li><span class="day">+18</span><a href="03-linda-kindred-ask.html">Email 3 — Linda — Bringing the kindred (Office)</a><div class="meta">Universal — linda@ocomain.org · primary referral ask</div></li>
    <li><span class="day">+28</span><a href="04-linda-gift-nudge.html">Email 4 — Linda — Gift-angle nudge (Office)</a><div class="meta">Conditional — only if <code>countSponsoredBy(member) === 0</code></div></li>
    <li><span class="day">+60</span><a href="05-linda-honours-explainer.html">Email 5 — Linda — Honours explainer (Office)</a><div class="meta">Universal — explains Cara / Ardchara / Onóir in plain language</div></li>
    <li><span class="day">+90</span><a href="06-paddy-seanchai-pedigree.html">Email 6 — Paddy (Seanchaí) — The royal house you have joined</a><div class="meta">Universal — clan@ocomain.org · pedigree as story</div></li>
  </ol>
  <footer>Mock recipient: ${MOCK_MEMBER.name} &lt;${MOCK_MEMBER.email}&gt;</footer>
</body></html>`;

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');
console.log('  ✔ index.html');
console.log('\nDone. Open in your browser:');
console.log('  open', path.join(OUT_DIR, 'index.html'));
