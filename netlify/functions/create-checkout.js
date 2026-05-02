// netlify/functions/create-checkout.js
//
// GET /api/create-checkout?tier=clan-fam&email=optional@user.com
//
// Creates a Stripe Checkout Session for a regular (non-gift) clan
// membership purchase, then 302-redirects the buyer to the Stripe
// checkout page. Same code path works in live mode AND test mode —
// Stripe routes based on whichever STRIPE_SECRET_KEY is set in env
// (sk_live_ vs sk_test_), so toggling test mode is a Netlify env-var
// change with zero code/URL changes.
//
// This replaces the previous pattern of 8 hardcoded buy.stripe.com
// payment-link URLs in join-chat.html. Benefits:
//
//   - Single source of truth: prices live in one map here
//   - Explicit metadata on every session (tier slug, tier_family,
//     product_name) that the webhook reads directly — much more
//     reliable than parsing product names or matching amounts
//   - Test mode toggle is now zero-friction
//
// Subscription vs payment mode:
//   - life-ind, life-fam       → mode: 'payment'      (one-time)
//   - clan/guardian/steward    → mode: 'subscription' (annual)
//
// Mirrors create-gift-checkout.js conventions for consistency.

const TIER_PRICES_CENTS = {
  'clan-ind':     4900,   // €49/yr
  'clan-fam':     7900,   // €79/yr
  'guardian-ind': 15000,  // €150/yr
  'guardian-fam': 22000,  // €220/yr
  'steward-ind':  35000,  // €350/yr
  'steward-fam':  48000,  // €480/yr
  'life-ind':     75000,  // €750 once
  'life-fam':     110000, // €1,100 once
};

const TIER_PRODUCT_NAMES = {
  'clan-ind':     'Clan Member',
  'clan-fam':     'Clan Member (Family)',
  'guardian-ind': 'Guardian of the Clan',
  'guardian-fam': 'Guardian of the Clan (Family)',
  'steward-ind':  'Steward of the Clan',
  'steward-fam':  'Steward of the Clan (Family)',
  'life-ind':     'Life Member',
  'life-fam':     'Life Member (Family)',
};

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Accept tier+email from query string (link-click pattern) or
  // POST body (programmatic call). Query string takes precedence when
  // present so a GET-with-body still works the obvious way.
  const qs = event.queryStringParameters || {};
  let body = {};
  if (event.httpMethod === 'POST' && event.body) {
    try { body = JSON.parse(event.body); } catch { /* ignore */ }
  }
  const tier = (qs.tier || body.tier || '').trim();
  const email = (qs.email || body.email || '').trim();
  // Herald-captured name. Travels into Stripe as metadata.herald_name and
  // is read FIRST by stripe-webhook (deterministic — no DB race, no
  // dependency on the applications-table POST having completed before the
  // webhook fires). Optional: if absent, the webhook falls back to the
  // applications table lookup (keepalive-protected) and finally the Stripe
  // billing name.
  const heraldName = (qs.name || body.name || '').trim();

  // Invitation attribution token. Flowed from invitation email URL
  // (?invite=<uuid>) → /membership.html → /join-chat.html → here.
  // Will be attached to the Stripe session metadata (invite_token=<uuid>);
  // the webhook reads it on checkout.session.completed and stamps
  // invitations.converted_member_id with the new member id —
  // bypassing email-match attribution which silently breaks when
  // the invitee pays at Stripe with a different email than they
  // were invited at.
  //
  // Validated as UUID format here so a malformed value doesn't
  // pollute Stripe metadata. Empty string when not present.
  let inviteToken = (qs.invite || body.invite || '').trim();
  if (inviteToken && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(inviteToken)) {
    console.warn(`[create-checkout] invalid invite token format dropped: ${inviteToken.slice(0, 12)}...`);
    inviteToken = '';
  }

  if (!tier || !TIER_PRICES_CENTS[tier]) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: `Invalid or missing tier. Valid tiers: ${Object.keys(TIER_PRICES_CENTS).join(', ')}`,
    };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('create-checkout: STRIPE_SECRET_KEY not set in environment');
    return { statusCode: 500, body: 'Server configuration error' };
  }
  const stripe = require('stripe')(stripeKey);

  const amountCents = TIER_PRICES_CENTS[tier];
  const productName = TIER_PRODUCT_NAMES[tier];
  const isLife = tier.startsWith('life');
  const tierFamily = tier.endsWith('-fam');
  const mode = isLife ? 'payment' : 'subscription';

  // Build line item with inline price_data so we don't need to maintain
  // a parallel set of Stripe Price IDs across live/test modes — Stripe
  // creates the price on the fly from this data.
  const lineItem = {
    quantity: 1,
    price_data: {
      currency: 'eur',
      product_data: { name: productName },
      unit_amount: amountCents,
      ...(mode === 'subscription' ? { recurring: { interval: 'year' } } : {}),
    },
  };

  // Origin for redirects. Use forwarded headers so this works on
  // Netlify preview URLs as well as the production domain.
  const proto = event.headers['x-forwarded-proto'] || 'https';
  const host = event.headers['x-forwarded-host'] || event.headers.host || 'www.ocomain.org';
  const origin = `${proto}://${host}`;

  // Welcome page reads ?tier and ?session_id; these are the contract.
  const successUrl = `${origin}/welcome.html?tier=${encodeURIComponent(tier)}&session_id={CHECKOUT_SESSION_ID}`;
  const cancelUrl  = `${origin}/membership.html`;

  // Find or create a Stripe Customer with the buyer's email. Passing
  // `customer: <id>` to the session (vs `customer_email`) makes Stripe
  // LOCK the email field in Checkout — buyers can't accidentally edit
  // it to a different address, which would have caused the welcome
  // email and member row to end up tied to different addresses.
  //
  // Stripe doesn't deduplicate customers by email automatically, so we
  // look up first and reuse if found. Otherwise create new with the
  // herald-collected name, which Stripe also pre-fills as the billing
  // name (and may lock too, depending on the Customer's billing data).
  //
  // If find-or-create fails for any reason, fall back to customer_email
  // (pre-filled but editable). Better than blocking the purchase.
  let stripeCustomer = null;
  if (email) {
    try {
      const list = await stripe.customers.list({ email: email.toLowerCase(), limit: 1 });
      stripeCustomer = list.data[0]
        || await stripe.customers.create({
          email: email.toLowerCase(),
          ...(heraldName ? { name: heraldName } : {}),
        });
    } catch (custErr) {
      console.error('Stripe customer find-or-create failed (non-fatal, falling back to customer_email):', custErr.message);
    }
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode,
      payment_method_types: ['card'],
      line_items: [lineItem],
      // Locked email if we have a Customer; otherwise pre-fill only.
      // Mutually exclusive — Stripe rejects sessions that pass both.
      ...(stripeCustomer
        ? { customer: stripeCustomer.id }
        : (email ? { customer_email: email } : {})),
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Explicit metadata. The webhook reads metadata.tier first
      // (deterministic), falls back to amount-based detection, then
      // product-name parsing. Setting it here closes the previous
      // 'product name has no "family" word' detection bug at source.
      metadata: {
        tier,
        tier_family: tierFamily ? 'true' : 'false',
        tier_label: productName,
        product_name: productName,
        is_gift: 'false',
        // herald_name: only set if the herald captured one. The webhook
        // treats this as the authoritative name source — it reflects what
        // the buyer wrote when telling the clan who they are, not what
        // their card billing address says. (A buyer might have a card in
        // one name but go by another — common with married couples,
        // children paying for parents' membership, etc.)
        ...(heraldName ? { herald_name: heraldName.slice(0, 100) } : {}),
        // Invitation attribution token — when present, the webhook
        // stamps invitations.converted_member_id by token (not by
        // email), giving the inviter sponsorship credit regardless
        // of which email the buyer paid with.
        ...(inviteToken ? { invite_token: inviteToken } : {}),
      },
      // Carry metadata onto the subscription too for annual tiers, so
      // renewal invoice events have tier context.
      ...(mode === 'subscription' ? {
        subscription_data: {
          metadata: {
            tier,
            tier_family: tierFamily ? 'true' : 'false',
            tier_label: productName,
            ...(inviteToken ? { invite_token: inviteToken } : {}),
          },
        },
      } : {}),
      // Allow promotion codes if you ever want to run discounts (Founder
      // year, alumni rate, etc.) — Stripe just shows the field, no harm
      // if no codes exist yet.
      allow_promotion_codes: true,
    });

    // 302 to Stripe checkout. Browser-friendly: clicking the <a> link
    // routes through here, lands on Stripe.
    return {
      statusCode: 302,
      headers: {
        Location: session.url,
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  } catch (e) {
    console.error('create-checkout failed:', e.message);
    return { statusCode: 500, body: 'Could not create checkout session: ' + e.message };
  }
};
