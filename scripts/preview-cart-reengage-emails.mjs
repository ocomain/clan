#!/usr/bin/env node
// scripts/preview-cart-reengage-emails.mjs
//
// Renders all four cart re-engagement emails to static HTML files in
// ./email-previews-cart-reengage/, for visual review by the Council
// and Chief without sending real mail.
//
// USAGE:
//   node scripts/preview-cart-reengage-emails.mjs
//   open email-previews-cart-reengage/index.html

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { getPreviewHtml } = require('../netlify/functions/lib/cart-reengage-email');

const MOCK_APPLICATION = {
  id: 'preview-application-uuid-0001',
  email: 'aoife.example@ocomain.org',
  name: 'Aoife Commane',
  tier: 'guardian-ind',
  status: 'pending',
  resume_token: 'PREVIEW_RESUME_TOKEN',
  reminder_sent_at: new Date().toISOString(),
};

const VARIANTS = [
  { key: 'RE1', file: '01-practical-reextension.html', title: 'RE-1 (+10) — Linda — Practical re-extension' },
  { key: 'RE2', file: '02-legitimacy-paddy.html',      title: 'RE-2 (+25) — Paddy — In case the question was whether the clan is real' },
  { key: 'RE3', file: '03-civic-value-antoin.html',    title: 'RE-3 (+50) — Antoin — What your hand on this work would mean' },
  { key: 'RE4', file: '04-graceful-close.html',        title: 'RE-4 (+90) — Linda — Final word with the Chief\u2019s thanks' },
];

const OUT_DIR = path.resolve(__dirname, '..', 'email-previews-cart-reengage');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log('Rendering cart re-engagement email previews to', OUT_DIR);

for (const v of VARIANTS) {
  const html = getPreviewHtml(v.key, MOCK_APPLICATION);
  const outPath = path.join(OUT_DIR, v.file);
  fs.writeFileSync(outPath, html, 'utf8');
  console.log('  ✔', v.file);
}

const indexHtml = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="robots" content="noindex,nofollow"><title>Cart re-engagement email previews — Clan Ó Comáin</title>
<style>
  body { font-family: 'Georgia', serif; background: #F8F4EC; color: #1A1A1A; margin: 0; padding: 40px; max-width: 720px; margin: 0 auto; }
  h1 { color: #0C1A0C; font-size: 28px; font-weight: 400; border-bottom: 2px solid #B8975A; padding-bottom: 12px; }
  .lede { color: #555; font-style: italic; margin-bottom: 24px; line-height: 1.6; }
  .frame { background: #FAEEDD; border-left: 3px solid #B8975A; padding: 16px 20px; margin: 0 0 32px; font-size: 14px; line-height: 1.65; color: #4A3A2A; }
  .frame strong { color: #0C1A0C; }
  ol { padding-left: 0; list-style: none; }
  li { background: white; border: 1px solid #E0DACA; border-left: 3px solid #B8975A; padding: 18px 22px; margin-bottom: 12px; border-radius: 1px; }
  li a { color: #0C1A0C; text-decoration: none; font-weight: 600; font-size: 17px; }
  li a:hover { color: #B8975A; }
  .day { display: inline-block; background: #B8975A; color: #0C1A0C; font-family: sans-serif; font-size: 11px; font-weight: 700; letter-spacing: 0.08em; padding: 4px 10px; border-radius: 1px; margin-right: 12px; vertical-align: middle; }
  .meta { color: #6C5A4A; font-size: 13px; margin-top: 6px; font-style: italic; }
  footer { margin-top: 40px; color: #6C5A4A; font-size: 12px; font-style: italic; text-align: center; }
</style></head>
<body>
  <h1>Cart re-engagement email previews</h1>
  <p class="lede">Four emails dispatched in the months following an unfinished application — sent only to people who began the herald-form join chat but never completed Stripe payment, after the existing 24h reminder has already gone out.</p>
  <div class="frame">
    <strong>For the Council and Chief — what these emails do.</strong> Each addresses a distinct objection that may have prevented completion, in a different voice from the household.
    Linda opens with the practical re-extension; Paddy speaks (as Seanchaí) to the question of legitimacy; Antoin speaks (as Tánaiste) to the question of civic value;
    Linda closes with the Chief's thanks. The cadence tapers — +10, +25, +50, +90 — to a definite stop. Every email is anchored to the recipient's unfinished application,
    keeping the sequence within legitimate-interest grounds under GDPR.
  </div>
  <ol>
    <li><span class="day">+10</span><a href="01-practical-reextension.html">RE-1 — Linda — Your application sits unfinished, a practical word</a><div class="meta">Addresses friction / payment / got distracted. One-click resume CTA.</div></li>
    <li><span class="day">+25</span><a href="02-legitimacy-paddy.html">RE-2 — Paddy (Seanchaí) — In case the question was whether the clan is real</a><div class="meta">Addresses 'is this real?' through plain testimony of the clan's recognition.</div></li>
    <li><span class="day">+50</span><a href="03-civic-value-antoin.html">RE-3 — Antoin (Tánaiste) — What your hand on this work would mean</a><div class="meta">Addresses 'is it worth €49?' by reframing membership as cultural stewardship.</div></li>
    <li><span class="day">+90</span><a href="04-graceful-close.html">RE-4 — Linda — A final word, with the Chief's thanks</a><div class="meta">Graceful close. The Office shall not write again on this matter. Door remains open.</div></li>
  </ol>
  <footer>Mock recipient: ${MOCK_APPLICATION.name} &lt;${MOCK_APPLICATION.email}&gt; — tier: ${MOCK_APPLICATION.tier}</footer>
</body></html>`;

fs.writeFileSync(path.join(OUT_DIR, 'index.html'), indexHtml, 'utf8');
console.log('  ✔ index.html');
console.log('\nDone.');
