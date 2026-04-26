// netlify/functions/create-gift-checkout.js
//
// POST /api/create-gift-checkout
//
// Creates a Stripe Checkout Session for a gift membership purchase. Unlike
// the regular membership flow (which uses pre-built Stripe Payment Links),
// gifts MUST use Checkout Sessions so we can attach metadata that the
// webhook needs to route emails correctly:
//
//   metadata.is_gift         = 'true'
//   metadata.gift_id         = Supabase gifts row id (UUID)
//   metadata.recipient_email = the person who will receive the membership
//   metadata.recipient_name  = recipient display name
//   metadata.buyer_email     = the person paying (giver)
//   metadata.buyer_name      = giver display name
//   metadata.personal_message = giver's message to recipient (may be empty)
//   metadata.tier            = e.g. 'guardian-ind', 'life-fam'
//   metadata.tier_label      = 'Guardian Member', 'Life Member (Family)'
//   metadata.gift_mode       = 'onetime' | 'recurring'
//
// Stripe metadata has a 500-char value limit per key — personal_message is
// truncated defensively. Full message is already stored in the gifts row
// in Supabase (via submit-gift.js), so truncation here only affects what
// gets surfaced in Stripe dashboard views.
//
// Returns: { url: <checkout session url> }
//
// The caller (gift-form.html) already wrote the gift row via submit-gift.js
// BEFORE calling this endpoint, so gift_id is passed in and referenced here.

const GIFT_PRICE_CENTS = {
  'clan-ind':     4900,
  'clan-fam':     7900,
  // Guardian gift pricing previously had a 'gift premium' built in
  // (19500 / 31500 = €195 / €315) but gift.html marketing displays
  // €150 / €220 — same as the regular Guardian tier. The mismatch led
  // to users being charged ~€45-95 more than the page advertised.
  // Aligned to the regular tier prices so what the page shows is what
  // Stripe charges. Bonus: these now match AMOUNT_CENTS_TO_TIER_SLUG
  // in lib/supabase.js, so the webhook's amount-based tier detection
  // works as a fallback if metadata is somehow missing.
  'guardian-ind': 15000,
  'guardian-fam': 22000,
  'life-ind':     75000,
  'life-fam':    110000,
};

const TIER_LABELS = {
  'clan-ind':     'Clan Member',
  'clan-fam':     'Clan Member (Family)',
  'guardian-ind': 'Guardian Member',
  'guardian-fam': 'Guardian Member (Family)',
  'life-ind':     'Life Member',
  'life-fam':     'Life Member (Family)',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const {
    tier,              // 'clan-ind', 'guardian-fam', 'life-ind', etc.
    giftMode,          // 'onetime' | 'recurring'
    giverName,
    giverEmail,
    recipientName,
    recipientEmail,
    personalMessage,
    giftId,            // Supabase gifts row ID (uuid), from submit-gift.js response
  } = body;

  // Basic validation
  if (!tier || !GIFT_PRICE_CENTS[tier]) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid or missing tier' }) };
  }
  if (!giverEmail || !recipientEmail) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Giver and recipient email required' }) };
  }
  // Life tier can only be one-time — recurring makes no sense for permanent membership.
  const isLife = tier.startsWith('life');
  const mode = isLife ? 'onetime' : (giftMode === 'recurring' ? 'recurring' : 'onetime');

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('create-gift-checkout: STRIPE_SECRET_KEY not set in environment');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Stripe is not configured on the server. Please email clan@ocomain.org.' }),
    };
  }
  // Log the key prefix (sk_test_ vs sk_live_) so function logs make
  // test-vs-live mode obvious without exposing the secret. Helps next
  // time someone reports 'gift checkout broken' — log will show whether
  // the env var has the expected prefix.
  console.log('create-gift-checkout: stripe key prefix =', stripeKey.slice(0, 8));
  const stripe = require('stripe')(stripeKey);
  const amountCents = GIFT_PRICE_CENTS[tier];
  const tierLabel = TIER_LABELS[tier];
  const productName = `${tierLabel} — Gift`;

  // Build the price_data inline so we don't have to maintain a separate set
  // of Stripe Price IDs for the gift variants. The webhook reads productName
  // for tier parsing, so suffix ' — Gift' keeps the gift signal on it.
  const lineItem = {
    quantity: 1,
    price_data: {
      currency: 'eur',
      product_data: { name: productName },
      unit_amount: amountCents,
      // For recurring gifts, Stripe requires recurring.interval on price_data.
      ...(mode === 'recurring' ? { recurring: { interval: 'year' } } : {}),
    },
  };

  // Origin for success/cancel redirects. Prefer the request's Host header so
  // this works on Netlify preview deploys and production alike.
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['x-forwarded-host'] || event.headers.host || 'www.ocomain.org';
  const origin = `${proto}://${host}`;

  // Success URL carries the recipient email for the confirmation page to
  // display. Stripe exposes session id via {CHECKOUT_SESSION_ID} expansion.
  const successUrl = `${origin}/gift-confirmed.html?rec_email=${encodeURIComponent(recipientEmail)}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${origin}/gift.html`;

  // Truncate message defensively to fit Stripe's 500-char metadata value limit.
  const msg = (personalMessage || '').slice(0, 450);

  // Find or create a Stripe Customer for the GIVER (the buyer paying for
  // the gift — the recipient never interacts with Stripe directly).
  // Passing `customer: <id>` locks the email field in Checkout so the
  // giver can't accidentally type a different address than they used in
  // the gift form, which would have caused the receipt + payment-confirm
  // emails to go to the wrong inbox.
  //
  // Mirrors the same pattern in create-checkout.js; if a third checkout
  // endpoint appears we should extract this into a shared helper.
  // Falls back to customer_email (pre-fill only) if find-or-create fails.
  let stripeCustomer = null;
  try {
    const list = await stripe.customers.list({ email: giverEmail.toLowerCase(), limit: 1 });
    stripeCustomer = list.data[0]
      || await stripe.customers.create({
        email: giverEmail.toLowerCase(),
        ...(giverName ? { name: giverName } : {}),
      });
  } catch (custErr) {
    console.error('Stripe customer find-or-create failed (non-fatal, falling back to customer_email):', custErr.message);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: mode === 'recurring' ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      line_items: [lineItem],
      // Customer is the BUYER (giver) - this is who's paying and whose email
      // Stripe will use for the receipt. The recipient never interacts with
      // Stripe directly; they get their welcome email from the webhook.
      // Locked email if we have a Customer; pre-fill only otherwise.
      ...(stripeCustomer
        ? { customer: stripeCustomer.id }
        : { customer_email: giverEmail }),
      success_url: successUrl,
      cancel_url: cancelUrl,
      // All gift-routing info lives in metadata. Webhook reads this.
      metadata: {
        is_gift: 'true',
        gift_id: giftId || '',
        tier,
        tier_label: tierLabel,
        gift_mode: mode,
        buyer_email: giverEmail,
        buyer_name: giverName || '',
        recipient_email: recipientEmail,
        recipient_name: recipientName || '',
        personal_message: msg,
        product_name: productName,
      },
      // Also attach metadata to the subscription itself for recurring gifts,
      // so future renewal events carry context.
      ...(mode === 'recurring' ? {
        subscription_data: {
          metadata: {
            is_gift: 'true',
            gift_id: giftId || '',
            recipient_email: recipientEmail,
            buyer_email: giverEmail,
          },
        },
      } : {}),
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url }),
    };
  } catch (e) {
    // Stripe errors carry useful structure: type ('StripeInvalidRequestError',
    // 'StripeAuthenticationError', etc.), code, and a request_log_url that
    // links back to the Stripe dashboard. Log all three so the function
    // logs are actionable — last time this errored, the user-facing alert
    // was useless and we had no log signal to diagnose from.
    console.error('create-gift-checkout failed:', {
      message: e.message,
      type:    e.type,
      code:    e.code,
      param:   e.param,
      request_log_url: e.requestLogUrl,
      tier,
      mode,
    });
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: e.message,
        // Surface the Stripe error type to the client too. The frontend
        // can show a friendlier message (e.g. for auth errors, point at
        // env-var setup) without exposing the secret.
        type: e.type || 'unknown',
      }),
    };
  }
};
