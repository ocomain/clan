// netlify/functions/lib/openai-capi.js
//
// OpenAI (ChatGPT ads) Conversions API: server-side order_created, sent
// from stripe-webhook.js on checkout.session.completed, alongside the
// Meta Conversions API call. Pairs with the browser order_created fired
// by js/ocm-purchase.js through the OpenAI Measurement Pixel — both use
// the id 'purchase_' + session.id (the same id Meta gets), so OpenAI
// counts browser + server as one conversion (dedupe key: Pixel ID +
// event name + id).
//
// Docs (checked 23 Oct 2026):
//   https://developers.openai.com/ads/conversions-api
//   https://developers.openai.com/ads/measurement-pixel
//
// Request: POST https://bzr.openai.com/v1/events?pid=<PIXEL_ID>
//          Authorization: Bearer <OPENAI_CAPI_KEY>
//          { validate_only, integration_source?, events: [ … ] }
//
// Env (Netlify only — never commit the key):
//   OPENAI_CAPI_KEY             required; when unset this is a silent no-op
//   OPENAI_PIXEL_ID             required; when unset this is a silent no-op
//   OPENAI_CAPI_VALIDATE_ONLY   optional; 'true' asks OpenAI to validate the
//                               event without saving it (use on previews)
//
// Contract with the webhook: sendOrderCreated() NEVER throws and NEVER
// takes longer than TIMEOUT_MS. It resolves to a short status string for
// logs. The API key is never logged.

const crypto = require('crypto');

const ENDPOINT = 'https://bzr.openai.com/v1/events';
const TIMEOUT_MS = 2500;
const INTEGRATION_SOURCE = 'ocomain_site';

function sha256(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

// Same rule as meta-capi.js: the page the buyer landed on, without the
// {CHECKOUT_SESSION_ID} template or query string.
function sourceUrlFrom(session) {
  try {
    const u = new URL(String(session.success_url || ''));
    return `${u.origin}${u.pathname}`;
  } catch {
    return 'https://www.ocomain.org/welcome.html';
  }
}

function buildPayload(session, nowMs) {
  const meta = session.metadata || {};
  // Normalise as OpenAI documents: trim, lowercase, then SHA-256 hex.
  const email = String(session.customer_details?.email || session.customer_email || '').trim().toLowerCase();

  const user = {};
  if (email) user.emails_sha256 = [sha256(email)];
  // obref = the Pixel's __obref first-party cookie, captured in the browser
  // (js/analytics-deferred.js) and carried in the Stripe metadata. Sent
  // unchanged, unhashed, as documented.
  if (meta.obref && String(meta.obref).trim()) user.obref = String(meta.obref).trim();

  const amount = Math.round(Number(session.amount_total) || 0); // already minor units (cents)
  const currency = String(session.currency || 'eur').toUpperCase();
  const contentName = meta.product_name || meta.tier_label || meta.tier || '';

  const evt = {
    id: 'purchase_' + session.id,
    type: 'order_created',
    // Time of payment confirmation (the webhook runs as Stripe confirms
    // completion). Always "now", so it is inside OpenAI's 7-day window
    // even when Stripe retries the webhook later.
    timestamp_ms: nowMs,
    source_url: sourceUrlFrom(session),
    action_source: 'web',
    data: {
      type: 'contents',
      amount,
      currency,
      contents: [{
        id: String(meta.tier || contentName || 'membership').slice(0, 100),
        name: String(contentName || 'Clan Ó Comáin membership').slice(0, 200),
        content_type: 'product',
        quantity: 1,
      }],
    },
  };
  // oppref: OpenAI's click reference, captured from the landing URL by
  // js/analytics-deferred.js and stored in the Stripe metadata. Passed
  // through without modification, as the docs require.
  if (meta.oppref && String(meta.oppref).trim()) evt.oppref = String(meta.oppref).trim();
  if (Object.keys(user).length) evt.user = user;

  return {
    validate_only: String(process.env.OPENAI_CAPI_VALIDATE_ONLY || '').toLowerCase() === 'true',
    integration_source: INTEGRATION_SOURCE,
    events: [evt],
  };
}

async function sendOrderCreated(session) {
  try {
    const key = process.env.OPENAI_CAPI_KEY;
    const pixelId = String(process.env.OPENAI_PIXEL_ID || '').trim();
    if (!key || !pixelId) return 'skipped:not_configured';
    if (!session || !session.id) return 'skipped:no_session';
    if (!(Number(session.amount_total) > 0)) return 'skipped:zero_amount';
    if (session.payment_status && session.payment_status !== 'paid') return 'skipped:unpaid';

    const url = `${ENDPOINT}?pid=${encodeURIComponent(pixelId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(buildPayload(session, Date.now())),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.error(`[openai-capi] order_created not accepted (${resp.status}): ${text.slice(0, 300)}`);
        return `error:${resp.status}`;
      }
      console.log(`[openai-capi] order_created sent for ${session.id}`);
      return 'sent';
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error('[openai-capi] order_created failed (ignored):', e && e.name === 'AbortError' ? 'timeout' : (e && e.message));
    return 'error:exception';
  }
}

module.exports = { sendOrderCreated, buildPayload };
