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
// PLACEHOLDERS — to be filled in successive commits
// ─────────────────────────────────────────────────────────────────

module.exports = {
  // Filled in subsequent commits during the Sequence-eight extraction
};
