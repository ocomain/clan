// scripts/preview-founder-emails.mjs
//
// Renders the founder-invite emails to email-previews-founder/ for
// Privy Council review via the email-review hub.
//
// Two emails covered:
//   01-original-invite.html        — the founder welcome (lib/founder-email.js)
//   02-day-30-reminder.html        — the day-30 nudge for unaccepted gifts
//                                    (lib/founder-email.js, also used by
//                                     daily-gift-acceptance-sweep.js)
//
// Usage:
//   node scripts/preview-founder-emails.mjs
//
// Same pattern as preview-pdf-lead-emails.mjs and the other preview
// scripts. Source of truth is the live render — this script never
// hand-writes copy. If a builder changes, run the script and the
// previews follow.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

// Set SITE_URL before requiring the lib so internal URLs are correct.
process.env.SITE_URL = process.env.SITE_URL || 'https://www.ocomain.org';

const { buildFounderWelcomeHtml, buildFounderReminderHtml } =
  require(path.join(REPO_ROOT, 'netlify/functions/lib/founder-email.js'));

const OUT_DIR = path.join(REPO_ROOT, 'email-previews-founder');
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log(`Rendering founder email previews to ${OUT_DIR}`);

const MOCK_RECIPIENT = {
  recipientName: 'Antoin Commane',
  // Personal note left empty by default — the original-invite preview
  // shows the structurally clean version. If reviewing how the personal
  // note block looks, set this to a sample one-liner.
  personalNote: '',
  claimToken: 'PREVIEW_TOKEN',
};

const MOCK_REMINDER = {
  recipient_name: 'Antoin Commane',
  recipient_email: 'preview@example.org',
  claim_token: 'PREVIEW_TOKEN',
  tier_label: 'Founding Member',
};

const VARIANTS = [
  {
    file: '01-original-invite.html',
    builder: () => buildFounderWelcomeHtml(MOCK_RECIPIENT),
  },
  {
    file: '02-day-30-reminder.html',
    builder: () => buildFounderReminderHtml(MOCK_REMINDER),
  },
];

for (const v of VARIANTS) {
  let html = v.builder();
  // Inject <meta name="robots" content="noindex,nofollow"> into the
  // <head> so these previews stay out of search engine results
  // (they live at public URLs under www.ocomain.org/email-previews-
  // founder/). Same pattern used by the other preview scripts.
  html = html.replace(
    /<meta charset="UTF-8">/,
    '<meta charset="UTF-8"><meta name="robots" content="noindex,nofollow">'
  );
  // The day-30 reminder builder uses <html><body...> rather than
  // <html><head><meta>...</head>, so the substitution above won't
  // hit. Add a defensive fallback that injects after <html> if no
  // <meta charset> was present.
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
