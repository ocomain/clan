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
  'guardian-ind': 19500,
  'guardian-fam': 31500,
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

  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

  try {
    const session = await stripe.checkout.sessions.create({
      mode: mode === 'recurring' ? 'subscription' : 'payment',
      payment_method_types: ['card'],
      line_items: [lineItem],
      // Customer is the BUYER (giver) - this is who's paying and whose email
      // Stripe will use for the receipt. The recipient never interacts with
      // Stripe directly; they get their welcome email from the webhook.
      customer_email: giverEmail,
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
    console.error('create-gift-checkout failed:', e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
};
