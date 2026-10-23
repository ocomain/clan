// netlify/functions/ads-config.js
//
// GET /api/ads-config
//
// Public, non-secret advertising configuration for the browser loader
// (js/analytics-deferred.js). It exists so that the OpenAI (ChatGPT ads)
// Measurement Pixel ID is read from a Netlify setting rather than being
// hard-coded in the page source.
//
// Env (Netlify only):
//   OPENAI_PIXEL_ID   the Pixel ID from ChatGPT Ads Manager → Conversions.
//                     When unset (or malformed) the response carries null
//                     and the browser loads no OpenAI code at all.
//
// A Pixel ID is public by nature (it is visible in every page that loads
// the pixel). The Conversions API key (OPENAI_CAPI_KEY) is NEVER returned
// here; it is used only by netlify/functions/lib/openai-capi.js.

const HEADERS = {
  'Content-Type': 'application/json',
  // Short cache: browsers and the CDN reuse the answer for five minutes,
  // so a newly set ID takes effect quickly without a function call on
  // every page view.
  'Cache-Control': 'public, max-age=300',
};

function cleanPixelId(v) {
  const s = String(v == null ? '' : v).trim();
  return /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : null;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    return { statusCode: 405, headers: HEADERS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify({ openai_pixel_id: cleanPixelId(process.env.OPENAI_PIXEL_ID) }),
  };
};
