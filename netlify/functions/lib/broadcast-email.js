// netlify/functions/lib/broadcast-email.js
//
// Rendering pipeline for admin-composed Council broadcasts (Maria,
// Antoin, Jessica, Herald — and on rare occasion Fergus or Linda).
//
// Composed in markdown in the admin UI at /members/admin/broadcasts.html.
// Rendered here to HTML, wrapped in the standard Ó Comáin email chrome,
// signed by the sender, and tail-spliced with one of two footer
// variants — Stewards' Privilege (immediate batch) or Cultural
// Stewardship upsell (delayed batch, 24h later).
//
// ─── PUBLIC API ────────────────────────────────────────────────────────
//
//   renderBroadcast({ broadcast, member, isImmediateBatch })
//     → { subject, html, fromName, fromEmail, replyTo }
//
//   senderVoices()
//     → array of available sender voices for admin UI dropdown
//
// The render function is pure — given a broadcast row, a member row,
// and the batch flag, it returns the complete send payload ready for
// the Resend API. No DB calls, no Resend calls, no logging. The caller
// (admin-broadcast-send.js or daily-broadcast-sweep.js) handles those.
//
// ─── SENDER VOICES ─────────────────────────────────────────────────────
//
// Each voice carries:
//   - From name (display)
//   - From address (dedicated mailbox, e.g. maria@ocomain.org)
//   - Eyebrow text shown above the heading in the chrome
//   - Signature block (avatar + name + role + email)
//
// The five lifecycle signature helpers in post-signup-email.js are NOT
// reused. The chrome here uses the same Ó Comáin visual identity
// (cream background, gold-on-ink header, EB Garamond / Georgia) but
// is composed independently so changes to lifecycle emails don't
// silently change the look of broadcast emails.
//
// ─── MARKDOWN ──────────────────────────────────────────────────────────
//
// We deliberately don't pull a markdown library — saves a dep and gives
// us full control over which HTML survives. The mini-parser below
// supports just what these letters need:
//
//   Paragraphs                Blank line separator
//   **bold**                  → <strong>
//   *italic*                  → <em>
//   [text](url)               → <a href>
//   - lists                   → <ul><li>
//   > quote                   → <blockquote>
//
// Everything else is escaped to HTML entities. No raw HTML survives —
// if admin pastes HTML it shows as literal text. This is intentional:
// it stops accidental broken HTML from ruining a multi-hundred-person
// send. Caller's escape hatch (if ever needed) is to extend the parser
// here, not to allow raw HTML through.

const SITE = process.env.PUBLIC_SITE_URL || 'https://www.ocomain.org';

// ─── HTML ESCAPING ──────────────────────────────────────────────────────
function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── ADDRESS FORM ───────────────────────────────────────────────────────
// Best effort first-name extraction. Used in "Dear X," opener if the
// markdown body contains the literal token {first_name}.
function firstNameOf(member) {
  if (!member || !member.name) return 'friend';
  const trimmed = String(member.name).trim();
  if (!trimmed) return 'friend';
  const parts = trimmed.split(/\s+/);
  return parts[0] || 'friend';
}

// ─── MINI MARKDOWN PARSER ───────────────────────────────────────────────
// Very small, intentionally restricted. Order of operations matters:
// inline transforms run after escaping; block transforms run on lines.
//
// Supported:
//   **x**                bold
//   *x*                  italic
//   [text](url)          link
//   - line               unordered list (consecutive - lines)
//   > line               blockquote
//   blank-line-separated paragraphs
//
// Token-replacement of {first_name} happens BEFORE escaping so the
// substituted name is also escaped.
function renderMarkdown(md, member) {
  if (!md) return '';

  // 1. Token substitution
  const firstName = firstNameOf(member);
  let src = String(md).replace(/\{first_name\}/g, firstName);

  // 2. Escape HTML
  src = escapeHtml(src);

  // 3. Split into blocks on blank lines
  const blocks = src.split(/\n\s*\n/);

  // Pre-pass: pair an image-only block with the next paragraph block
  // to produce a two-column portrait+text layout. The markdown source
  // is:
  //
  //   ![Alt text](image.jpg)
  //
  //   Paragraph that pairs with the image…
  //
  // Renders as a 64px round portrait on the left, paragraph on the
  // right, in a single email-safe table. If the image-only block has
  // no following paragraph, it falls back to a centred figure.
  const IMG_RE = /^!\[([^\]]*)\]\(([^)]+)\)$/;
  const merged = [];
  for (let i = 0; i < blocks.length; i++) {
    const t = (blocks[i] || '').trim();
    if (!t) continue;
    const m = t.match(IMG_RE);
    if (m) {
      const url = m[2].trim();
      const alt = m[1] || '';
      // Only allow http/https URLs for image src (no file paths, no
      // data: URLs, no javascript:). Internal images can be referenced
      // by relative path; we prefix with SITE.
      let src;
      if (/^https?:/i.test(url)) {
        src = url;
      } else if (/^[\w.\-/]+\.(jpg|jpeg|png|gif|webp)$/i.test(url)) {
        // bare filename — assume it's on the site
        src = `${SITE}/${url.replace(/^\//, '')}`;
      } else {
        // Unsupported — skip image, retain the next block as plain.
        if (i + 1 < blocks.length) merged.push(blocks[i + 1]);
        i++;
        continue;
      }
      const nextBlock = (i + 1 < blocks.length) ? blocks[i + 1] : null;
      const paragraphHtml = nextBlock
        ? nextBlock.split(/\n/).map(renderInline).join('<br>')
        : '';
      merged.push({
        kind: 'portrait',
        src,
        alt,
        paragraphHtml,
      });
      if (nextBlock) i++; // consume the next block as paired
      continue;
    }
    merged.push(t);
  }

  const out = [];
  for (const item of merged) {
    if (item && typeof item === 'object' && item.kind === 'portrait') {
      out.push(`
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px;width:100%">
  <tr>
    <td style="vertical-align:top;padding-right:18px;width:80px">
      <img src="${item.src}" width="64" height="64" alt="${escapeHtml(item.alt)}" style="display:block;width:64px;height:64px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:top">
      <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.7;margin:0">${item.paragraphHtml}</p>
    </td>
  </tr>
</table>`);
      continue;
    }

    const rawBlock = item;
    const block = rawBlock.trim();
    if (!block) continue;

    const lines = block.split(/\n/);
    const firstLine = lines[0] || '';

    // Unordered list
    if (firstLine.startsWith('- ')) {
      const items = lines
        .filter(l => l.startsWith('- '))
        .map(l => `<li style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.7;margin:0 0 8px">${renderInline(l.slice(2))}</li>`)
        .join('');
      out.push(`<ul style="margin:0 0 20px;padding-left:24px">${items}</ul>`);
      continue;
    }

    // Blockquote
    if (firstLine.startsWith('&gt; ')) {
      const stripped = lines
        .map(l => l.replace(/^&gt; ?/, ''))
        .join(' ');
      out.push(`<blockquote style="margin:0 0 20px;padding:0 0 0 16px;border-left:3px solid #B8975A;font-family:'Georgia',serif;font-size:17px;font-style:italic;color:#3C2A1A;line-height:1.7">${renderInline(stripped)}</blockquote>`);
      continue;
    }

    // Default: paragraph. Multiple lines inside a paragraph block
    // get joined with <br>. Single line stays single.
    const joined = lines.map(renderInline).join('<br>');
    out.push(`<p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">${joined}</p>`);
  }
  return out.join('\n');
}

// Inline transforms — applied after HTML escaping, so they look for
// the **already-escaped** versions of brackets (i.e. nothing to worry
// about; the markdown syntax characters (* _ [ ] ( )) are not HTML
// special characters).
function renderInline(text) {
  // Links must run before italics because the [text](url) pattern
  // contains parens that wouldn't otherwise confuse italics, but
  // explicit-ordering makes the failure modes obvious.
  let s = text;
  // Links: [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, label, url) => {
    // Only allow http/https/mailto urls — anything else is rendered
    // as the literal text. Defence against admin pasting javascript:
    // URLs or similar.
    if (!/^(https?:|mailto:)/i.test(url)) return label;
    return `<a href="${url}" style="color:#B8975A;text-decoration:underline">${label}</a>`;
  });
  // Bold: **x**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic: *x* (after bold so ** isn't misread)
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return s;
}

// ─── SENDER VOICES ──────────────────────────────────────────────────────
// One source of truth for from-name, from-address, eyebrow, signature.
// Adding a new voice means adding one row here.
const VOICES = {
  maria: {
    label: 'Maria Kinfauns — Chancellor',
    fromName: 'Maria Kinfauns',
    fromEmail: 'maria@ocomain.org',
    replyTo: 'maria@ocomain.org',
    eyebrow: 'A letter from the Chancellor',
    signature: () => signatureBlock({
      avatar: 'maria_kinfauns_bubble.jpg',
      name: 'Maria Kinfauns',
      role: 'Chancellor of Clan Ó Comáin',
      irish: 'Seansailéir',
      email: 'maria@ocomain.org',
    }),
  },
  antoin: {
    label: 'Antóin Commane — Tánaiste',
    fromName: 'Antóin Commane',
    fromEmail: 'antoin@ocomain.org',
    replyTo: 'antoin@ocomain.org',
    eyebrow: 'A note from the Tánaiste',
    signature: () => signatureBlock({
      avatar: 'antoin_tanist.png',
      name: 'Antóin Commane, Cara of Ó Comáin',
      role: 'Tánaiste',
      irish: null,
      email: 'antoin@ocomain.org',
    }),
  },
  jessica: {
    label: 'Jessica-Lily Commane — Keeper of the Seat',
    fromName: 'Jessica-Lily Commane',
    fromEmail: 'jessica@ocomain.org',
    replyTo: 'jessica@ocomain.org',
    eyebrow: 'From the Keeper of the Seat',
    signature: () => signatureBlock({
      avatar: 'jessica_lily_commane.png',
      name: 'Jessica-Lily Commane',
      role: 'Keeper of the Seat of Clan Ó Comáin',
      irish: 'Coimeádaí na Suíochán',
      email: 'jessica@ocomain.org',
    }),
  },
  herald: {
    label: 'The Herald',
    fromName: 'The Herald',
    fromEmail: 'herald@ocomain.org',
    replyTo: 'herald@ocomain.org',
    eyebrow: 'A proclamation from the Herald',
    signature: () => signatureBlock({
      avatar: 'the_herald_seal.png',
      name: 'The Herald of Clan Ó Comáin',
      role: null,
      irish: 'An tAralt',
      email: 'herald@ocomain.org',
    }),
  },
  // Fergus and Linda available but rarely used; included so admin
  // dropdown can offer them if the need arises.
  fergus: {
    label: 'Fergus Commane — Chief',
    fromName: 'Fergus Commane',
    fromEmail: 'chief@ocomain.org',
    replyTo: 'clan@ocomain.org',
    eyebrow: 'A word from the Chief',
    signature: () => signatureBlock({
      avatar: 'fergus_kinfauns.jpg',
      name: 'Fergus Christopher The Commane Kinfauns',
      role: 'Ceann Fine · Chief of Clan Ó Comáin',
      irish: null,
      email: null,
    }),
  },
  linda: {
    label: 'Linda Commane Cryan — Private Secretary',
    fromName: 'Linda Commane Cryan',
    fromEmail: 'linda@ocomain.org',
    replyTo: 'linda@ocomain.org',
    eyebrow: 'From the Office of the Private Secretary',
    signature: () => signatureBlock({
      avatar: 'linda_cryan_bubble.png',
      name: 'Linda Commane Cryan',
      role: 'Office of the Private Secretary to the Chief',
      irish: null,
      email: 'linda@ocomain.org',
    }),
  },
};

function senderVoices() {
  return Object.entries(VOICES).map(([id, v]) => ({
    id,
    label: v.label,
    fromName: v.fromName,
    fromEmail: v.fromEmail,
  }));
}

// Shared signature renderer. Avatar size, name treatment, email link
// styling all match the lifecycle email signatures so broadcasts feel
// of-a-piece with the rest of the email programme.
function signatureBlock({ avatar, name, role, irish, email }) {
  return `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
  <tr>
    <td style="vertical-align:middle;padding-right:18px;width:84px">
      <img src="${SITE}/${avatar}" width="68" height="68" alt="${escapeHtml(name)}" style="display:block;width:68px;height:68px;border-radius:50%;object-fit:cover">
    </td>
    <td style="vertical-align:middle">
      <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>${escapeHtml(name)}</strong></p>
      ${role ? `<p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">${escapeHtml(role)}</p>` : ''}
      ${irish ? `<p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">${escapeHtml(irish)}</p>` : ''}
      ${email ? `<p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0">
        <a href="mailto:${email}" style="color:#B8975A;text-decoration:none">${email}</a>
        <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span>
        <a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a>
      </p>` : `<p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="${SITE}" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>`}
    </td>
  </tr>
</table>`;
}

// ─── CTA BUTTON ─────────────────────────────────────────────────────────
function ctaButtonHtml(label, url) {
  return `
<div style="text-align:center;margin:24px 0 28px">
  <a href="${url}" style="display:inline-block;background:#B8975A;color:#0C1A0C !important;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none !important;padding:15px 32px;border-radius:1px"><span style="display:inline-block;color:#0C1A0C !important;font-family:'Helvetica Neue',Arial,sans-serif;font-size:12px;font-weight:700;letter-spacing:0.16em;text-transform:uppercase;text-decoration:none !important">${escapeHtml(label)} &rarr;</span></a>
</div>`;
}

// ─── FOOTNOTES — TWO VARIANTS ──────────────────────────────────────────
//
// Both footers are deliberately quiet — a single thin rule, italic
// serif, ~12px type. Footnote register so they don't compete with
// the body of the Council letter above them.
//
// Immediate (Steward + Life Member): one-line privilege ack, no
// upsell — they're already at the top tier(s).
//
// Delayed (everyone else): three short sentences ending in an
// inline mailto link to the office. No "upgrade" language. No
// styled CTA button — the link is a plain anchor in the running
// prose. Per DDW: "should this whole section read more as a
// footnote if going at the end of each email?" Yes.

function privilegeFooterHtml() {
  return `
<div style="margin:28px 0 0;padding:14px 0 0;border-top:1px solid rgba(184,151,90,.25)">
  <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.55;margin:0">Stewards' Privilege — the inside track. This letter reaches Stewards and Life Members 24 hours before the kindred at large.</p>
</div>`;
}

function upsellFooterHtml() {
  return `
<div style="margin:28px 0 0;padding:14px 0 0;border-top:1px solid rgba(184,151,90,.25)">
  <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.65;margin:0">Stewards and Life Members received this letter 24 hours ago — Stewards' Privilege, the inside track. Stewards make an annual contribution of €350 (€480 family); the one-time contribution of a Life Founder, available during the 2026 founding period only, is €750 (€1,100 family). To be counted among the great benefactors of the revival, write to <a href="mailto:clan@ocomain.org" style="color:#8C7A4A;text-decoration:underline">clan@ocomain.org</a>.</p>
</div>`;
}

// ─── CHROME WRAPPER ─────────────────────────────────────────────────────
// Same visual identity as lifecycle emails (post-signup-email.js
// wrapInChrome). Kept independent so changes here don't ripple
// across the lifecycle programme.
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
    <p style="font-family:'Georgia',serif;font-size:11px;color:#A88B57;margin:0;letter-spacing:0.06em">Tigh Uí Chomáin · House of Ó Comáin · <a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · <a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>
  </div>
</div>
</body>
</html>`;
}

// ─── PUBLIC: renderBroadcast ────────────────────────────────────────────
//
// broadcast: { subject, body_md, sender_voice, cta_label, cta_url }
// member:    { email, name }
// isImmediateBatch: boolean (true = Steward/Life footer)
//
// Returns the payload for the Resend API call:
//   { subject, html, fromName, fromEmail, replyTo }
function renderBroadcast({ broadcast, member, isImmediateBatch }) {
  const voice = VOICES[broadcast.sender_voice];
  if (!voice) {
    throw new Error(`Unknown sender_voice: ${broadcast.sender_voice}`);
  }

  // Body: markdown → HTML → optional CTA → signature → footer
  const bodyHtml = [
    renderMarkdown(broadcast.body_md, member),
    broadcast.cta_label && broadcast.cta_url
      ? ctaButtonHtml(broadcast.cta_label, broadcast.cta_url)
      : '',
    voice.signature(),
    isImmediateBatch ? privilegeFooterHtml() : upsellFooterHtml(),
  ].filter(Boolean).join('\n');

  const html = wrapInChrome({
    eyebrow: voice.eyebrow,
    heading: broadcast.subject,
    bodyHtml,
  });

  return {
    subject: broadcast.subject,
    html,
    fromName: voice.fromName,
    fromEmail: voice.fromEmail,
    replyTo: voice.replyTo,
  };
}

module.exports = {
  renderBroadcast,
  senderVoices,
  // Exported for the admin preview endpoint:
  renderMarkdown,
  privilegeFooterHtml,
  upsellFooterHtml,
};
