// netlify/functions/lib/checkout-email.js
//
// HTML BUILDERS for the post-checkout / payment-flow emails sent by
// stripe-webhook.js. The senders themselves remain in stripe-webhook.js
// because they depend on Stripe runtime context (session metadata,
// customer object, gift table rows, member lookups, signed URL
// generation). What lives here is the HTML composition only —
// the builders take fully-resolved primitives and return strings.
//
// Why this exists:
//   The stripe-webhook is critical infrastructure (handles every paid
//   signup, every gift purchase, every cancellation). Its email
//   templates were originally inline 200+ line HTML strings inside the
//   sender functions. That made the webhook hard to read and meant
//   the email previews (for Privy Council review at /email-review/)
//   had no programmatic way to render the same copy. This lib is the
//   single source of truth for HTML body strings; the webhook senders
//   gather Stripe context, build the parameter object, and call the
//   builders.
//
// Five builders here, mirroring five member-facing senders in webhook:
//   buildMemberWelcomeHtml          — direct buyer welcome (post-purchase)
//   buildGiftRecipientWelcomeHtml   — gift recipient welcome (gift accepted)
//   buildGiftBuyerConfirmationHtml  — gift buyer receipt (cert keepsake later)
//   buildGiftConfirmationsHtml      — alt gift-buyer confirmation (legacy
//                                     path — still wired up; preserve until
//                                     determined obsolete)
//   buildAbandonedReminderHtml      — checkout abandoned, place still held
//
// The webhook's notifyClan() sender (admin-facing, goes to clan@ocomain.org)
// is NOT extracted — internal admin notifications don't need preview/review.
//
// CONVENTIONS:
//   - Builders are pure functions: same input → same output, no side
//     effects, no async work, no module-level state.
//   - Inputs are plain primitives or simple objects. Senders are
//     responsible for resolving things like signed URLs and member
//     lookups before calling the builder.
//   - The builders use a local escapeHtml. Don't call out to other
//     libs (kept self-contained for clean preview-tool import).

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────
// buildAbandonedReminderHtml
// ─────────────────────────────────────────────────────────────────
// Sent to people who started checkout but didn't complete payment.
// Voice is warm and non-pushy: 'a place is still held for you'. The
// Founders-of-the-Revival framing creates urgency without pleading
// — by stating a fact about year-one membership rather than asking.
//
// Caller (stripe-webhook.js → sendAbandonedReminder) supplies:
//   firstName  — already split off by caller (string, may be empty)
//   tierName   — the tier they were checking out (string|null)
function buildAbandonedReminderHtml({ firstName, tierName }) {
  const safeFirst = firstName || 'friend';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:36px 40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="80" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:10.5px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:80px">Ó COMÁIN</p>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:18px;color:#2C1A0C;margin:0 0 20px">Dear ${escapeHtml(safeFirst)},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your application to Clan Ó Comáin was received — but your membership was not completed.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 14px">A place is still held for you in the Register of Clan Members${tierName ? ` as <strong>${escapeHtml(tierName)}</strong>` : ''}. When you are ready, the door remains open.</p>
    <p style="font-family:'Georgia',serif;font-size:16px;color:#3C2A1A;line-height:1.8;margin:0 0 32px;padding:14px 18px;background:rgba(184,151,90,.08);border-left:3px solid #B8975A">This is the <strong>first year of the revival</strong>. Those who join now are inscribed as <strong>Founding Members</strong> of Clan Ó Comáin — a designation that carries no price in any later year. From the second year onward, members join as members; this distinction will not be offered again.</p>
    <div style="text-align:center;margin-bottom:32px">
      <a href="https://www.ocomain.org/membership.html" style="display:inline-block;background:#B8975A;color:#0C1A0C;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:16px 36px;border-radius:1px">Complete your membership</a>
    </div>
    <p style="font-family:'Georgia',serif;font-size:15px;color:#666;line-height:1.7">If something went wrong with your payment or you have questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> — we will be happy to help.</p>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center;border-top:1px solid rgba(184,151,90,.2)">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Caithfidh an stair a bheith i réim</p>
  </div>
</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────
// buildGiftConfirmationsHtml
// ─────────────────────────────────────────────────────────────────
// Sent to a gift buyer to confirm receipt of their gift purchase.
// Lighter than the keepsake email (which fires later when the
// recipient publishes their cert) — this is the immediate
// 'confirmed, in train' note.
//
// Caller (stripe-webhook.js → sendGiftConfirmations) supplies:
//   buyerFirstName  — already split off by caller (string)
//   tierDisplayName — the tier name as it should appear (e.g. 'Guardian
//                     of the Clan'), pre-resolved by caller
function buildGiftConfirmationsHtml({ buyerFirstName, tierDisplayName }) {
  const safeFirst = buyerFirstName || 'friend';
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F8F4EC">
<div style="max-width:580px;margin:0 auto">
  <div style="background:#0C1A0C;padding:40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0">Gift confirmed</h1>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${escapeHtml(safeFirst)},</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">On behalf of Fergus Kinfauns, The Commane — Chief of Ó Comáin — your gift of a <strong>${escapeHtml(tierDisplayName)}</strong> membership has been received and confirmed. This office will be in touch with your recipient shortly, and the Chief will write to them personally in the weeks that follow.</p>
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">If you have any questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> and I will respond on behalf of the Chief.</p>
    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;margin:0 0 24px">Go raibh míle maith agat.</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Commane Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Tigh Uí Chomáin · House of Ó Comáin · <a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · <a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>
  </div>
</div>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────────
// buildGiftBuyerConfirmationHtml
// ─────────────────────────────────────────────────────────────────
// Sent to a gift buyer post-purchase as a fuller confirmation than
// sendGiftConfirmations. This is the longer 'what happens next'
// note with two distinct branches:
//   - Deferred-acceptance flow (Phase 2, 2026-04-30): the recipient
//     must press 'Claim my place' before any membership exists in
//     their name. The gift is held one year, not 30 days.
//   - Existing-recipient tier upgrade: the recipient is already a
//     clan member; the gift updates their tier. They have 30 days
//     to refine their cert.
//
// Buyer's sponsorship credit (Cara/Ardchara/Onóir) is awarded on
// payment regardless of which branch.
//
// Caller (stripe-webhook.js → sendGiftBuyerConfirmation) supplies:
//   buyerFirstName    — already split off (string)
//   recipientDisplay  — recipient's display name (string)
//   recipientFirst    — recipient's first name (string)
//   recipientEmail    — recipient's email (string)
//   tierDisplayName   — tier name as it should appear (string)
//   isDeferred        — boolean: which branch to render
function buildGiftBuyerConfirmationHtml({
  buyerFirstName,
  recipientDisplay,
  recipientFirst,
  recipientEmail,
  tierDisplayName,
  isDeferred,
}) {
  const safeBuyerFirst = buyerFirstName || 'friend';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#F8F4EC;font-family:'Georgia',serif">
<div style="max-width:580px;margin:0 auto;background:#F8F4EC">
  <div style="background:#0C1A0C;padding:40px;text-align:center;border-bottom:2px solid #B8975A">
    <img src="https://www.ocomain.org/coat_of_arms.png" width="84" alt="Ó Comáin" style="display:block;margin:0 auto 6px;height:auto"><p style="font-family:'Helvetica Neue',Arial,sans-serif;font-size:11px;font-weight:700;letter-spacing:0.20em;color:#B8975A;margin:0 auto 18px;text-align:center;max-width:84px">Ó COMÁIN</p>
    <h1 style="font-family:'Georgia',serif;font-size:28px;font-weight:400;color:#D4B87A;margin:0">Your gift is on its way</h1>
  </div>
  <div style="padding:40px">
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Dear ${escapeHtml(safeBuyerFirst)},</p>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">Your gift of a <strong>${escapeHtml(tierDisplayName)}</strong> membership of Clan Ó Comáin has been received and confirmed. ${isDeferred
      ? `A welcome email has just been sent to <strong>${escapeHtml(recipientDisplay)}</strong> at ${escapeHtml(recipientEmail)} — inviting them to take up the place you've offered them.`
      : `A welcome email has just been sent to <strong>${escapeHtml(recipientDisplay)}</strong> at ${escapeHtml(recipientEmail)} — inviting them to confirm their certificate details and take their place in the Register.`}</p>

    ${isDeferred ? `
    <!-- "What happens next" — Phase 2 deferred-acceptance flow.
         The recipient must press 'Claim my place' on the welcome
         page; until then no membership exists in their name. The
         buyer's sponsorship credit (Cara/Ardchara/Onóir) is
         awarded immediately on payment regardless. -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-left:3px solid #B8975A;padding:22px 26px;margin:0 0 28px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">What happens next</p>
      <ol style="margin:0;padding-left:20px">
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px"><strong>${escapeHtml(recipientDisplay)}</strong> receives a welcome email with your personal message and an invitation to view their place in the clan.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">They press <em>Claim my place</em> on the welcome page — their place in the clan is confirmed. They will be invited to confirm their certificate details — their name, an optional ancestor dedication — and the certificate is sealed in their name and entered in the Register at Newhall House.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">We send you a copy of the published certificate as a keepsake of the gift you've given.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:0">The Chief — Fergus Commane — writes to them personally in the weeks that follow.</li>
      </ol>
    </div>

    <!-- Phase 2 quiet word — sets correct expectations:
         (1) the gift is held open for one year, not 30 days
         (2) acceptance is the recipient's act, not auto -->
    <div style="background:rgba(12,26,12,.04);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:18px 22px;margin:0 0 24px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 8px">A quiet word</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0">If you can, tell ${escapeHtml(recipientFirst)} the email is on its way — sometimes our messages land in a quiet folder. Once they accept, they will have <strong>30 days</strong> to refine their certificate details before it is sealed and entered in the Register in their name as it stands.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">We'll write to you again when ${escapeHtml(recipientFirst)} accepts and publishes their certificate, with their published copy as a keepsake.</p>
    ` : `
    <!-- Existing-recipient (tier upgrade) path — pre-Phase-2 wording.
         The recipient is already a clan member; this gift updates
         their tier. No 'claim my place' step. They have 30 days
         to refine their cert if newly issued, or it's already
         sealed if this is a tier upgrade for an existing member. -->
    <div style="background:#FFF9EC;border:1px solid #E6D4A3;border-left:3px solid #B8975A;padding:22px 26px;margin:0 0 28px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 12px">What happens next</p>
      <ol style="margin:0;padding-left:20px">
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px"><strong>${escapeHtml(recipientDisplay)}</strong> receives a welcome email from this office with your personal message and a single-click link to their Members' Area.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">There they confirm their certificate details — their name, an optional ancestor dedication — and publish it. The certificate is sealed, in their name, entered in the Register at Newhall House.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:8px">We send you a copy of the published certificate as a keepsake of the gift you've given.</li>
        <li style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin-bottom:0">The Chief — Fergus Commane — writes to them personally in the weeks that follow.</li>
      </ol>
    </div>

    <div style="background:rgba(12,26,12,.04);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:18px 22px;margin:0 0 24px;border-radius:0 2px 2px 0">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 8px">A quiet word</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0">If you can, tell ${escapeHtml(recipientFirst)} the email is on its way — sometimes our messages land in a quiet folder.</p>
    </div>

    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 20px">We'll write to you again when ${escapeHtml(recipientFirst)} publishes their certificate, with their published copy as a keepsake.</p>
    `}
    <p style="font-family:'Georgia',serif;font-size:17px;color:#3C2A1A;line-height:1.8;margin:0 0 28px">If you have any questions, please write to <a href="mailto:clan@ocomain.org" style="color:#B8975A">clan@ocomain.org</a> and I will respond on behalf of the Chief.</p>

    <!-- Another gift CTA -->
    <div style="background:rgba(184,151,90,.08);border:1px solid rgba(184,151,90,.3);border-left:3px solid #B8975A;padding:22px 24px;margin:0 0 28px;border-radius:0 2px 2px 0;text-align:center">
      <p style="font-family:'Georgia',sans-serif;font-size:10px;font-weight:600;letter-spacing:0.22em;text-transform:uppercase;color:#B8975A;margin:0 0 10px">Another in the family?</p>
      <p style="font-family:'Georgia',serif;font-size:15px;color:#3C2A1A;line-height:1.7;margin:0 0 16px">A gift of heritage has a way of being given more than once. If there's someone else in the family who would love this, you can send another.</p>
      <a href="https://www.ocomain.org/gift.html" style="display:inline-block;background:transparent;color:#B8975A;border:1px solid #B8975A;font-family:sans-serif;font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;text-decoration:none;padding:13px 28px;border-radius:1px">Send another gift →</a>
    </div>

    <p style="font-family:'Georgia',serif;font-size:16px;font-style:italic;color:#3C2A1A;margin:0 0 24px">Go raibh míle maith agat.</p>

    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px;width:100%">
      <tr>
        <td style="vertical-align:middle;padding-right:18px;width:84px">
          <img src="https://www.ocomain.org/linda_cryan_bubble.png" width="68" height="68" alt="Linda Commane Cryan" style="display:block;width:68px;height:68px;border-radius:50%">
        </td>
        <td style="vertical-align:middle">
          <p style="font-family:'Georgia',serif;font-size:15px;color:#0C1A0C;line-height:1.3;margin:0 0 4px"><strong>Linda Commane Cryan</strong></p>
          <p style="font-family:'Georgia',serif;font-size:13px;color:#3C2A1A;line-height:1.5;margin:0 0 2px">Office of the Private Secretary to the Chief</p>
          <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#6C5A4A;line-height:1.5;margin:0">Rúnaí Príobháideach an Taoisigh</p><p style="font-family:'Georgia',serif;font-size:12px;color:#6C5A4A;line-height:1.5;margin:6px 0 0"><a href="mailto:linda@ocomain.org" style="color:#B8975A;text-decoration:none">linda@ocomain.org</a> <span style="color:rgba(184,151,90,.5);margin:0 4px">·</span> <a href="https://www.ocomain.org" style="color:#B8975A;text-decoration:none">www.ocomain.org</a></p>
        </td>
      </tr>
    </table>
  </div>
  <div style="background:#0C1A0C;padding:20px 40px;text-align:center">
    <p style="font-family:'Georgia',serif;font-size:12px;font-style:italic;color:#C8A875;margin:0">Tigh Uí Chomáin · House of Ó Comáin · <a href="https://www.ocomain.org/terms.html" style="color:#A88B57;text-decoration:underline">Terms</a> · <a href="https://www.ocomain.org/privacy.html" style="color:#A88B57;text-decoration:underline">Privacy</a></p>
  </div>
</div>
</body>
</html>`;
}

module.exports = {
  buildAbandonedReminderHtml,
  buildGiftConfirmationsHtml,
  buildGiftBuyerConfirmationHtml,
  // Filled in subsequent commits during the Sequence-eight extraction
};
