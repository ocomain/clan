// netlify/functions/checkout-session-summary.js
//
// GET /api/checkout-session-summary?session_id=cs_...
//
// Minimal, PII-free summary of a Stripe Checkout Session, used by
// js/ocm-purchase.js on welcome.html / gift-confirmed.html to fire the
// Meta Pixel Purchase event with the amount actually charged.
//
// Returns: { paid, value, currency, event_id, content_name, is_gift }
//   paid      true only when status==='complete' AND payment_status==='paid'
//             AND amount_total > 0 (a zero-amount session is never a
//             Purchase for ad measurement)
//   value     amount_total / 100 — reflects promotion codes
//   currency  session.currency upper-cased (EUR)
//   event_id  'purchase_' + session.id — identical to the id the webhook
//             sends to the Conversions API, so Meta deduplicates
//
// No email, name, address or customer id is returned. Same Stripe
// lookup pattern as welcome-signin.js. Uses whichever STRIPE_SECRET_KEY
// is set (test keys on deploy previews).

const HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const NOT_PAID = (extra) => ({
  statusCode: 200,
  headers: HEADERS,
  body: JSON.stringify({ paid: false, ...(extra || {}) }),
});

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const sessionId = ((event.queryStringParameters || {}).session_id || '').trim();
  if (!/^cs_[A-Za-z0-9_]{10,250}$/.test(sessionId)) {
    return { statusCode: 400, headers: HEADERS, body: JSON.stringify({ paid: false, error: 'Invalid session_id' }) };
  }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeKey) {
    console.error('checkout-session-summary: STRIPE_SECRET_KEY missing');
    return { statusCode: 500, headers: HEADERS, body: JSON.stringify({ paid: false, error: 'Server configuration error' }) };
  }

  let session;
  try {
    const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!resp.ok) {
      console.error(`checkout-session-summary: Stripe lookup failed (${resp.status})`);
      return { statusCode: resp.status === 404 ? 404 : 502, headers: HEADERS, body: JSON.stringify({ paid: false }) };
    }
    session = await resp.json();
  } catch (e) {
    console.error('checkout-session-summary: Stripe lookup error:', e.message);
    return { statusCode: 502, headers: HEADERS, body: JSON.stringify({ paid: false }) };
  }

  const amountTotal = Number(session.amount_total) || 0;
  const paid = session.status === 'complete'
    && session.payment_status === 'paid'
    && amountTotal > 0;

  if (!paid) return NOT_PAID();

  const meta = session.metadata || {};
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({
      paid: true,
      value: amountTotal / 100,
      currency: String(session.currency || '').toUpperCase(),
      event_id: 'purchase_' + session.id,
      content_name: meta.product_name || meta.tier_label || meta.tier || '',
      is_gift: meta.is_gift === 'true',
    }),
  };
};
