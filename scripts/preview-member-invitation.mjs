// scripts/preview-member-invitation.mjs
//
// Renders the single member-to-friend invitation email to
// email-previews-member-invitation/ for Privy Council review.
//
// One email — sent by a clan member to someone they want to
// recommend for membership. Source of truth: lib/invitation-email.js
// → buildInvitationHtml.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

process.env.SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

const { buildInvitationHtml } = require(path.join(REPO_ROOT, 'netlify/functions/lib/invitation-email.js'));

const OUT_DIR = path.join(REPO_ROOT, 'email-previews-member-invitation');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`Rendering member invitation preview to ${OUT_DIR}`);

const VARIANTS = [
  {
    file: '01-member-invitation.html',
    builder: () => buildInvitationHtml({
      recipientName: 'Mary O\'Brien',
      inviterName: 'Antoin Commane',
      inviterFirstName: 'Antoin',
      personalNote: '', // Optional — empty to show the structurally cleanest version
      inviteToken: 'PREVIEW_TOKEN',
      unsubscribeUrl: '#preview-unsubscribe',
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
