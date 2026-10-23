// js/ocm-purchase.js
//
// Fires the Meta Pixel Purchase event, and the OpenAI (ChatGPT ads)
// Pixel order_created event, on the post-payment pages
// (welcome.html, gift-confirmed.html). Include AFTER the analytics
// loader, both deferred, so window.ocmTrack exists when this runs:
//
//   <script defer src="/js/analytics-deferred.js" data-pixel="immediate"></script>
//   <script defer src="/js/ocm-purchase.js"></script>
//
// The value comes from Stripe (amount_total via
// /api/checkout-session-summary), never from ?tier — promotion codes
// are enabled, so the list price can be wrong.
//
// event_id = 'purchase_' + session.id, the same id the webhook sends
// to the Meta and OpenAI Conversions APIs, so each platform counts
// browser + server as one.
//
// Fires at most once per Stripe session per browser: a marker is kept
// in localStorage['ocm_purchase_' + session_id] and checked first, so
// reloading the page does not count the purchase again. No session_id,
// an unpaid / expired session, or a zero amount fires nothing.

(function () {
  'use strict';
  try {
    var sessionId = new URLSearchParams(window.location.search).get('session_id') || '';
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return;
    if (typeof window.hasMarketingConsent === 'function' && !window.hasMarketingConsent()) return;

    var markerKey = 'ocm_purchase_' + sessionId;
    try { if (window.localStorage.getItem(markerKey)) return; } catch (e) { /* storage blocked: still fire once */ }

    fetch('/api/checkout-session-summary?session_id=' + encodeURIComponent(sessionId), {
      credentials: 'same-origin',
      cache: 'no-store',
    })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s || s.paid !== true) return;
        var value = Number(s.value);
        if (!(value > 0) || !s.currency || !s.event_id) return;
        // Re-check just before firing in case another tab got there first.
        try { if (window.localStorage.getItem(markerKey)) return; } catch (e) { /* ignore */ }
        if (typeof window.ocmTrack !== 'function') return;
        window.ocmTrack('Purchase', {
          value: value,
          currency: s.currency,
          content_name: s.content_name || '',
          content_type: 'product',
        }, s.event_id);
        // OpenAI (ChatGPT ads) order_created, same event_id as Meta's
        // Purchase and as the server-side Conversions API event, so
        // OpenAI deduplicates browser + server. amount is an integer in
        // minor units (cents), as the OpenAI Pixel requires. A silent
        // no-op unless OPENAI_PIXEL_ID is configured.
        try {
          if (typeof window.ocmTrackOpenAI === 'function') {
            var cents = Math.round(value * 100);
            window.ocmTrackOpenAI('order_created', {
              type: 'contents',
              amount: cents,
              currency: s.currency,
              contents: [{
                id: String(s.content_name || 'membership'),
                name: String(s.content_name || 'Clan Ó Comáin membership'),
                content_type: 'product',
                quantity: 1,
              }],
            }, s.event_id);
          }
        } catch (e) { /* never break the page */ }
        try { window.localStorage.setItem(markerKey, String(Date.now())); } catch (e) { /* ignore */ }
      })
      .catch(function () { /* never break the page */ });
  } catch (e) { /* never break the page */ }
})();
