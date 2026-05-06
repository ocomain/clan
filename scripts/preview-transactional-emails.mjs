// scripts/preview-transactional-emails.mjs
//
// Renders the transactional/notification emails to
// email-previews-transactional/. These are receipts and audit-
// trail emails that fire in response to specific member actions
// (publishing a cert, sponsoring a new member, completing a
// purchase, abandoning checkout). Unlike the campaign sequences,
// these are one-off transactional sends — no drip cadence, no
// nurture flow.
//
// Five emails covered:
//   01-member-welcome.html              — direct buyer post-purchase
//                                          welcome (lib/checkout-email.js)
//   02-publication-confirmation.html    — sent when a cert is published
//                                          (lib/publication-email.js)
//   03-publication-auto-published.html  — same email, auto-publication
//                                          variant (day 30 sweep)
//   04-sponsor-letter.html               — sent when a sponsor's invitee
//                                          converts (lib/sponsor-email.js)
//   05-title-award-cara.html             — sent when a sponsor crosses
//                                          the Cara threshold
//   06-title-award-ardchara.html         — Ardchara raising
//   07-title-award-onoir.html            — Onóir raising
//   08-abandoned-reminder.html           — checkout abandoned, place
//                                          held (lib/checkout-email.js)

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

process.env.SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

const {
  buildMemberWelcomeHtml,
  buildAbandonedReminderHtml,
} = require(path.join(REPO_ROOT, 'netlify/functions/lib/checkout-email.js'));

const {
  buildPublicationConfirmationHtml,
} = require(path.join(REPO_ROOT, 'netlify/functions/lib/publication-email.js'));

const {
  buildSponsorLetterHtml,
  buildTitleAwardLetterHtml,
} = require(path.join(REPO_ROOT, 'netlify/functions/lib/sponsor-email.js'));

const { SPONSOR_TITLES } = require(path.join(REPO_ROOT, 'netlify/functions/lib/sponsor-service.js'));
const TITLES = Object.fromEntries((SPONSOR_TITLES || []).map(t => [t.slug, t]));

const OUT_DIR = path.join(REPO_ROOT, 'email-previews-transactional');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`Rendering transactional email previews to ${OUT_DIR}`);

const SAMPLE_MEMBER = {
  name: 'Antoin Commane',
  email: 'antoin@example.org',
  tier_label: 'Guardian of the Clan',
  ancestor_dedication: 'In honour of my grandfather, John Commane (1923-2015)',
};

const VARIANTS = [
  {
    file: '01-member-welcome.html',
    builder: () => buildMemberWelcomeHtml({
      firstName: 'Antoin',
      tierDisplayName: 'Guardian of the Clan',
      benefits: [
        'Your name in the public Founding Members Register at ocomain.org/register',
        'A hand-printed certificate sent to your home',
        'Dinner at the Chief\'s Black Tie Gala Dinner at Newhall House',
        'A loved one remembered on your certificate',
        'A personal letter from the Chief',
      ],
      signInUrl: 'https://www.ocomain.org/members/?signed-in-via-magic-link=preview',
    }),
  },
  {
    file: '02-publication-confirmation.html',
    builder: () => buildPublicationConfirmationHtml({
      member: SAMPLE_MEMBER,
      certNumber: 'OC-2026-0042',
      autoPublished: false,
      downloadUrl: '#preview-download',
      hasAttachment: true,
    }),
  },
  {
    file: '03-publication-auto-published.html',
    builder: () => buildPublicationConfirmationHtml({
      member: SAMPLE_MEMBER,
      certNumber: 'OC-2026-0042',
      autoPublished: true,
      downloadUrl: '#preview-download',
      hasAttachment: true,
    }),
  },
  {
    file: '04-sponsor-letter.html',
    builder: () => buildSponsorLetterHtml({
      sponsor: { email: 'antoin@example.org', name: 'Antoin Commane', sponsor_titles_awarded: {} },
      newMember: { name: 'James Brennan', display_name_on_register: 'James Brennan' },
      sponsorTitle: null, // no title yet — first conversion
    }),
  },
  // Note: title-award letter previews require live TITLES module + functions.
  // If TITLES is structured per-title with subjectLine/bodyOpening/etc, the
  // preview can render them. Use Cara as the canonical example.
  ...(TITLES && TITLES.cara ? [{
    file: '05-title-award-cara.html',
    builder: () => buildTitleAwardLetterHtml({
      sponsor: { email: 'antoin@example.org', name: 'Antoin Commane', sponsor_titles_awarded: {} },
      title: TITLES.cara,
      priorTitleIrish: null,
      totalCount: 1,
    }),
  }] : []),
  ...(TITLES && TITLES.ardchara ? [{
    file: '06-title-award-ardchara.html',
    builder: () => buildTitleAwardLetterHtml({
      sponsor: { email: 'antoin@example.org', name: 'Antoin Commane', sponsor_titles_awarded: { cara: '2026-01-15T00:00:00Z' } },
      title: TITLES.ardchara,
      priorTitleIrish: 'Cara',
      totalCount: 5,
    }),
  }] : []),
  ...(TITLES && TITLES.onoir ? [{
    file: '07-title-award-onoir.html',
    builder: () => buildTitleAwardLetterHtml({
      sponsor: { email: 'antoin@example.org', name: 'Antoin Commane', sponsor_titles_awarded: { cara: '2026-01-15T00:00:00Z', ardchara: '2026-03-20T00:00:00Z' } },
      title: TITLES.onoir,
      priorTitleIrish: 'Ardchara',
      totalCount: 15,
    }),
  }] : []),
  {
    file: '08-abandoned-reminder.html',
    builder: () => buildAbandonedReminderHtml({
      firstName: 'Antoin',
      tierName: 'Guardian of the Clan',
    }),
  },
];

for (const v of VARIANTS) {
  let html;
  try {
    html = v.builder();
  } catch (err) {
    console.error(`  ✗ ${v.file}: ${err.message}`);
    continue;
  }
  html = html.replace(
    /<meta charset="UTF-8">/,
    '<meta charset="UTF-8"><meta name="robots" content="noindex,nofollow">'
  );
  if (!html.includes('noindex,nofollow')) {
    html = html.replace(
      /<html>/,
      '<html><head><meta name="robots" content="noindex,nofollow"></head>'
    );
  }
  fs.writeFileSync(path.join(OUT_DIR, v.file), html, 'utf8');
  console.log('  ✔', v.file);
}

console.log('\nDone.');
