// netlify/functions/lib/meta-capi.js
//
// Meta Conversions API: server-side Purchase, sent from stripe-webhook.js
// on checkout.session.completed. Pairs with the browser Purchase fired by
// js/ocm-purchase.js — both use event_id 'purchase_' + session.id, so
// Meta counts them once.
//
// Env (Netlify only — never commit the token):
//   META_CAPI_TOKEN        required; when unset this is a silent no-op
//   META_PIXEL_ID          pixel / dataset id (2218274272324729)
//   META_TEST_EVENT_CODE   optional; routes events to Test Events
//   META_GRAPH_VERSION     optional override, default below
//
// Contract with the webhook: sendPurchase() NEVER throws and NEVER takes
// longer than TIMEOUT_MS. It resolves to a short status string for logs.

const crypto = require('crypto');

const DEFAULT_GRAPH_VERSION = 'v26.0';
const DEFAULT_PIXEL_ID = '2218274272324729';
const TIMEOUT_MS = 2500;

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// Stripe success_url still holds the {CHECKOUT_SESSION_ID} template and
// query string; Meta only needs the page the buyer landed on.
function sourceUrlFrom(session) {
  try {
    const u = new URL(String(session.success_url || ''));
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'https://www.ocomain.org/welcome.html';
  }
}

function buildPayload(session) {
  const meta = session.metadata || {};
  const email = String(session.customer_details?.email || session.customer_email || '').trim().toLowerCase();

  const userData = {};
  if (email) userData.em = [sha256(email)];
  if (meta.fbp) userData.fbp = String(meta.fbp);
  if (meta.fbc) userData.fbc = String(meta.fbc);

  const payload = {
    data: [{
      event_name: 'Purchase',
      event_time: Math.floor((Number(session.created) || Date.now() / 1000)),
      event_id: 'purchase_' + session.id,
      action_source: 'website',
      event_source_url: sourceUrlFrom(session),
      user_data: userData,
      custom_data: {
        value: (Number(session.amount_total) || 0) / 100,
        currency: String(session.currency || 'eur').toUpperCase(),
        content_name: meta.product_name || meta.tier_label || meta.tier || '',
        content_type: 'product',
      },
    }],
  };
  // event_time must be within the last 7 days; checkout.session.completed
  // can be retried by Stripe, so use "now" if the session is older.
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - payload.data[0].event_time > 6 * 24 * 3600 || payload.data[0].event_time > nowSec) {
    payload.data[0].event_time = nowSec;
  }
  if (process.env.META_TEST_EVENT_CODE) payload.test_event_code = process.env.META_TEST_EVENT_CODE;
  return payload;
}

async function sendPurchase(session) {
  try {
    const token = process.env.META_CAPI_TOKEN;
    if (!token) return 'skipped:no_token';
    if (!session || !session.id) return 'skipped:no_session';
    if (!(Number(session.amount_total) > 0)) return 'skipped:zero_amount';
    if (session.payment_status && session.payment_status !== 'paid') return 'skipped:unpaid';

    const pixelId = process.env.META_PIXEL_ID || DEFAULT_PIXEL_ID;
    const version = process.env.META_GRAPH_VERSION || DEFAULT_GRAPH_VERSION;
    const url = `https://graph.facebook.com/${version}/${encodeURIComponent(pixelId)}/events?access_token=${encodeURIComponent(token)}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildPayload(session)),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.error(`[meta-capi] Purchase not accepted (${resp.status}): ${text.slice(0, 300)}`);
        return `error:${resp.status}`;
      }
      console.log(`[meta-capi] Purchase sent for ${session.id}`);
      return 'sent';
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('[meta-capi] Purchase failed (ignored):', e && e.message);
    return 'error:exception';
  }
}

module.exports = { sendPurchase, buildPayload };
