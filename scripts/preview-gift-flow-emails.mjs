// scripts/preview-gift-flow-emails.mjs
//
// Renders the four gift-flow emails to email-previews-gift-flow/.
// Source of truth: lib/checkout-email.js + lib/publication-email.js.
//
// Four emails covered:
//   01-gift-buyer-confirmation-deferred.html   — buyer's post-purchase
//                                                receipt, deferred branch
//   02-gift-buyer-confirmation-upgrade.html    — buyer's post-purchase
//                                                receipt, tier-upgrade branch
//   03-gift-recipient-welcome-deferred.html    — recipient's welcome,
//                                                Phase 2 deferred-acceptance
//   04-gift-recipient-welcome-upgrade.html     — recipient's welcome,
//                                                tier-upgrade branch (already
//                                                a clan member)
//   05-gift-confirmations.html                 — alt buyer confirmation
//                                                (different code path)
//   06-gift-buyer-keepsake.html                — sent later, when the
//                                                recipient publishes their
//                                                cert (from publication-email.js)
//
// Six total. The two buyer-confirmation branches and two recipient-
// welcome branches are rendered separately so the Council can
// review both flow paths.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

process.env.SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

const {
  buildGiftBuyerConfirmationHtml,
  buildGiftRecipientWelcomeHtml,
  buildGiftConfirmationsHtml,
} = require(path.join(REPO_ROOT, 'netlify/functions/lib/checkout-email.js'));

const {
  buildGiftBuyerCertKeepsakeHtml,
} = require(path.join(REPO_ROOT, 'netlify/functions/lib/publication-email.js'));

const OUT_DIR = path.join(REPO_ROOT, 'email-previews-gift-flow');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`Rendering gift-flow email previews to ${OUT_DIR}`);

const VARIANTS = [
  {
    file: '01-gift-buyer-confirmation-deferred.html',
    builder: () => buildGiftBuyerConfirmationHtml({
      buyerFirstName: 'Antoin',
      recipientDisplay: 'Mary O\'Brien',
      recipientFirst: 'Mary',
      recipientEmail: 'mary@example.org',
      tierDisplayName: 'Clan Member',
      isDeferred: true,
    }),
  },
  {
    file: '02-gift-buyer-confirmation-upgrade.html',
    builder: () => buildGiftBuyerConfirmationHtml({
      buyerFirstName: 'Antoin',
      recipientDisplay: 'Mary O\'Brien',
      recipientFirst: 'Mary',
      recipientEmail: 'mary@example.org',
      tierDisplayName: 'Guardian of the Clan',
      isDeferred: false,
    }),
  },
  {
    file: '03-gift-recipient-welcome-deferred.html',
    builder: () => buildGiftRecipientWelcomeHtml({
      firstName: 'Mary',
      giverName: 'Antoin Commane',
      tierDisplayName: 'Clan Member',
      benefits: [
        'Your name in the Register at Newhall House',
        'A certificate of membership in your name',
        'A standing in Clan Ó Comáin wherever it has been carried',
      ],
      personalMsg: 'Mary, I thought of you when I came across this. Hope you take it up. — A',
      claimToken: 'PREVIEW_TOKEN',
      recipientSignInUrl: null,
    }),
  },
  {
    file: '04-gift-recipient-welcome-upgrade.html',
    builder: () => buildGiftRecipientWelcomeHtml({
      firstName: 'Mary',
      giverName: 'Antoin Commane',
      tierDisplayName: 'Guardian of the Clan',
      benefits: [
        'Everything in Clan Member, plus:',
        'A hand-printed certificate sent to your home',
        'Your place on the public Founding Members Register',
        'Dinner at the Chief\'s Black Tie Gala at Newhall House',
      ],
      personalMsg: 'You should have a place at the table, Mary. — A',
      claimToken: null,
      recipientSignInUrl: 'https://www.ocomain.org/members/?signed-in-via-magic-link=preview',
    }),
  },
  {
    file: '05-gift-confirmations.html',
    builder: () => buildGiftConfirmationsHtml({
      buyerFirstName: 'Antoin',
      tierDisplayName: 'Clan Member',
    }),
  },
  {
    file: '06-gift-buyer-keepsake.html',
    builder: () => buildGiftBuyerCertKeepsakeHtml({
      member: {
        name: 'Mary O\'Brien',
        email: 'mary@example.org',
        tier_label: 'Clan Member',
        ancestor_dedication: 'In honour of my grandmother, Eileen Quinn (1929-2018)',
      },
      certNumber: 'OC-2026-0042',
      gift: {
        buyer_name: 'Antoin Commane',
        buyer_email: 'antoin@example.org',
        recipient_email: 'mary@example.org',
      },
      downloadUrl: '#preview-download',
      hasAttachment: true,
    }),
  },
];

for (const v of VARIANTS) {
  let html = v.builder();
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
