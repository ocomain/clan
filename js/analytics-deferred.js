// js/analytics-deferred.js
//
// Shared analytics loader: Microsoft Clarity, the Meta Pixel, and
// first-touch campaign attribution (UTM tags + fbclid).
//
// ── CLARITY: deferred until interaction (unchanged) ──────────────
// Clarity loads ONLY after the user has interacted with the page
// (scroll, touch, click, or keyboard), or after an 8-second failsafe.
// Initial paint loads no third-party tracking, which prevents iOS
// Safari from showing the 'Reduce Privacy Protections' banner that
// Apple started surfacing more aggressively in recent iOS versions
// when the page tries to load fingerprinting / cross-site trackers
// on first paint.
//
// THE TRADE-OFF (deliberate, agreed 13 May 2026):
//   - Bounced visitors who never scroll or click aren't tracked
//     in Clarity (or in the Pixel, on deferred pages).
//   - Engaged visitors (anyone who scrolls or taps) are still
//     tracked from the moment they engage.
//   - The vast majority of marketing-relevant signal lives in
//     'visitor engaged with the site' rather than 'visitor
//     opened the URL and bounced', so this preserves what
//     matters and drops what doesn't.
//
// NOTE: the deferral is NOT consent handling. Consent lives in
// hasMarketingConsent() below.
//
// ── META PIXEL: immediate on funnel pages, deferred elsewhere ────
// Pages whose loader tag carries data-pixel="immediate"
//   <script defer src="/js/analytics-deferred.js" data-pixel="immediate"></script>
// load the Pixel on DOMContentLoaded, so the checkout funnel (join,
// join-chat, membership, gift, gift-form, welcome, gift-confirmed and
// the surname landing pages) records PageView for every visit — ad
// traffic that bounces from a landing page is exactly what Meta needs
// to see. Every other page keeps the old behaviour: the Pixel script
// loads together with Clarity on first interaction / 8 s failsafe.
//
// The fbq stub (the standard Meta snippet minus the network request)
// is created as soon as this file runs, with init + a single PageView
// queued. Only the fbevents.js download is deferred. That means:
//   - PageView fires exactly once per page load (it is queued once,
//     and the stub refuses to be created twice).
//   - Events tracked before fbevents.js arrives (window.ocmTrack) sit
//     in the stub's own queue and are replayed in order when it loads.
//
// ── ATTRIBUTION ──────────────────────────────────────────────────
// utm_source / utm_medium / utm_campaign / utm_content and fbclid are
// captured from the landing URL on ANY page, first touch wins, kept 30
// days in localStorage. window.ocmAttribution() returns them together
// with the _fbp / _fbc cookies, and window.ocmDecorateCheckoutUrl()
// appends them to /api/create-checkout links. They end up in the
// Stripe Checkout Session metadata so the owner can see which campaign
// and ad produced each payment.
//
// ── OPENAI (CHATGPT ADS) MEASUREMENT PIXEL ───────────────────────
// Docs: https://developers.openai.com/ads/measurement-pixel
// The Pixel ID is NOT in this file. It is read at runtime from
// /api/ads-config (netlify/functions/ads-config.js), which returns the
// Netlify env var OPENAI_PIXEL_ID. With no ID set, nothing from OpenAI
// is created or downloaded — a silent no-op. With an ID, the official
// oaiq stub is created and init queued (no network), and the SDK
// (bzrcdn.openai.com/sdk/oaiq.min.js) downloads on the same schedule
// as the Meta Pixel script: on load for data-pixel="immediate" pages,
// otherwise on first interaction / 8 s failsafe.
// window.ocmTrackOpenAI(eventName, data, eventId) is queue-safe: calls
// made before the config arrives wait for it, and are dropped if no
// ID is configured.
// The OpenAI click reference (oppref) is captured from the landing URL
// separately from the first-touch UTM record: the latest oppref wins
// and is kept 30 days (matching the Pixel's own __oppref cookie), so a
// visitor first tagged by another campaign still carries the ChatGPT
// click into Stripe. ocmAttribution() also returns the Pixel's __obref
// browser reference when present, for the server-side Conversions API.
//
// ── CONSENT ──────────────────────────────────────────────────────
// Everything marketing-related (both Pixels, ocmTrack, attribution capture)
// sits behind hasMarketingConsent(). It returns true for now (the
// privacy notice discloses the Pixel, CAPI and UTM storage). A consent
// banner later is a one-line change there.
//
// SAFETY:
//   - Interaction listeners use { once: true } and passive where it
//     matters, so iOS scroll responsiveness is untouched.
//   - Every storage / cookie access is wrapped in try/catch.
//   - Double-load guards on Clarity, the Pixel stub and the Pixel
//     script.

const META_PIXEL_ID = '2218274272324729'; // Clan Ó Comáin pixel, used by ad account 1146388872717383

(function () {
  'use strict';

  // ── Consent hook ─────────────────────────────────────────────────
  // Single source of truth for marketing consent. When a banner is
  // added, make this return the visitor's stored choice.
  function hasMarketingConsent() {
    return true;
  }
  window.hasMarketingConsent = hasMarketingConsent;

  // Which mode did the including page ask for? document.currentScript
  // is valid for deferred classic scripts while they execute.
  var selfTag = document.currentScript ||
    document.querySelector('script[src*="/js/analytics-deferred.js"]');
  var pixelImmediate = !!(selfTag && selfTag.getAttribute('data-pixel') === 'immediate');

  // ── Attribution (first touch, 30 days) ───────────────────────────
  var ATTR_KEY = 'ocm_attr';
  var ATTR_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  var ATTR_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'fbclid'];

  function clean(v) {
    return String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').trim().slice(0, 200);
  }

  function readStoredAttr() {
    try {
      var raw = window.localStorage.getItem(ATTR_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object' || !obj.ts || (Date.now() - obj.ts) > ATTR_TTL_MS) {
        window.localStorage.removeItem(ATTR_KEY);
        return null;
      }
      return obj;
    } catch (e) { return null; }
  }

  function captureAttribution() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (e) { return; }
    var found = {};
    var any = false;
    ATTR_FIELDS.forEach(function (k) {
      var v = clean(params.get(k));
      if (v) { found[k] = v; any = true; }
    });
    if (!any) return;
    // First touch wins: keep an unexpired earlier record untouched.
    if (readStoredAttr()) return;
    found.ts = Date.now();
    found.landing_page = clean(window.location.pathname);
    try { window.localStorage.setItem(ATTR_KEY, JSON.stringify(found)); } catch (e) { /* private mode etc. */ }
  }

  // OpenAI click reference: latest click wins (not first touch), 30 days.
  var OPPREF_KEY = 'ocm_oppref';
  var OPPREF_MAX_LEN = 500; // Stripe metadata value limit

  // oppref / obref are opaque: pass them on unmodified or not at all.
  function opaque(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s || s.length > OPPREF_MAX_LEN || /[\u0000-\u001f]/.test(s)) return '';
    return s;
  }

  function readStoredOppref() {
    try {
      var raw = window.localStorage.getItem(OPPREF_KEY);
      if (!raw) return '';
      var obj = JSON.parse(raw);
      if (!obj || !obj.v || !obj.ts || (Date.now() - obj.ts) > ATTR_TTL_MS) {
        window.localStorage.removeItem(OPPREF_KEY);
        return '';
      }
      return opaque(obj.v);
    } catch (e) { return ''; }
  }

  function captureOppref() {
    var v = '';
    try { v = opaque(new URLSearchParams(window.location.search).get('oppref')); } catch (e) { return; }
    if (!v) return;
    try { window.localStorage.setItem(OPPREF_KEY, JSON.stringify({ v: v, ts: Date.now() })); } catch (e) { /* private mode etc. */ }
  }

  function readCookie(name) {
    try {
      var m = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : '';
    } catch (e) { return ''; }
  }

  // Returns { utm_source, utm_medium, utm_campaign, utm_content, fbclid,
  // landing_page, fbp, fbc, oppref, obref } — only keys that have values.
  function ocmAttribution() {
    var out = {};
    if (!hasMarketingConsent()) return out;
    var stored = readStoredAttr() || {};
    ATTR_FIELDS.concat(['landing_page']).forEach(function (k) {
      if (stored[k]) out[k] = clean(stored[k]);
    });
    var fbp = clean(readCookie('_fbp'));
    var fbc = clean(readCookie('_fbc'));
    // If the Pixel hasn't written _fbc yet but we know the click id,
    // build it in Meta's documented format: fb.1.<ms timestamp>.<fbclid>
    if (!fbc && stored.fbclid) fbc = clean('fb.1.' + (stored.ts || Date.now()) + '.' + stored.fbclid);
    if (fbp) out.fbp = fbp;
    if (fbc) out.fbc = fbc;
    // OpenAI: our stored click reference, else the Pixel's own cookie.
    var oppref = readStoredOppref() || opaque(readCookie('__oppref'));
    var obref = opaque(readCookie('__obref'));
    if (oppref) out.oppref = oppref;
    if (obref) out.obref = obref;
    return out;
  }
  window.ocmAttribution = ocmAttribution;

  // Append attribution params to a /api/create-checkout URL. Idempotent:
  // params already on the URL are left alone.
  function ocmDecorateCheckoutUrl(url) {
    try {
      if (!url || url.indexOf('/api/create-checkout') < 0) return url;
      var attr = ocmAttribution();
      var add = [];
      Object.keys(attr).forEach(function (k) {
        if (new RegExp('[?&]' + k + '=').test(url)) return;
        add.push(k + '=' + encodeURIComponent(attr[k]));
      });
      if (!add.length) return url;
      return url + (url.indexOf('?') >= 0 ? '&' : '?') + add.join('&');
    } catch (e) { return url; }
  }
  window.ocmDecorateCheckoutUrl = ocmDecorateCheckoutUrl;

  // Safety net for any plain <a href="/api/create-checkout?..."> on any
  // page: decorate the href at click time (capture phase, so it runs
  // before page handlers read the href).
  document.addEventListener('click', function (e) {
    try {
      var a = e.target && e.target.closest ? e.target.closest('a[href*="/api/create-checkout"]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      var decorated = ocmDecorateCheckoutUrl(href);
      if (decorated !== href) a.setAttribute('href', decorated);
    } catch (err) { /* never break the click */ }
  }, true);

  // ── Meta Pixel ───────────────────────────────────────────────────
  var pixelScriptLoaded = false;

  // Standard Meta snippet, split in two: the stub (no network) and the
  // script download. Returns true if a stub exists afterwards.
  function ensurePixelStub() {
    if (!hasMarketingConsent()) return false;
    if (window.fbq) return true;
    var n = window.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!window._fbq) window._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0';
    n.queue = [];
    window.fbq('init', META_PIXEL_ID);
    window.fbq('track', 'PageView');
    return true;
  }

  function loadPixelScript() {
    if (pixelScriptLoaded) return;
    if (!ensurePixelStub()) return;
    pixelScriptLoaded = true;
    var t = document.createElement('script');
    t.async = true;
    t.src = 'https://connect.facebook.net/en_US/fbevents.js';
    var s = document.getElementsByTagName('script')[0];
    s.parentNode.insertBefore(t, s);
  }

  // Queue-safe tracking helper. eventID (optional) lets Meta
  // deduplicate a browser event against the same server (CAPI) event.
  function ocmTrack(eventName, params, eventID) {
    try {
      if (!hasMarketingConsent()) return;
      if (!ensurePixelStub()) return;
      if (eventID) {
        window.fbq('track', eventName, params || {}, { eventID: String(eventID) });
      } else {
        window.fbq('track', eventName, params || {});
      }
    } catch (e) { /* never break the page */ }
  }
  window.ocmTrack = ocmTrack;

  // ── OpenAI (ChatGPT ads) Measurement Pixel ──────────────────────
  var OPENAI_CONFIG_URL = '/api/ads-config';
  var OPENAI_CONFIG_CACHE = 'ocm_ads_cfg';
  var openaiState = 'pending'; // 'pending' | 'on' | 'off'
  var openaiPending = [];      // measure calls made before the config arrived
  var openaiWantScript = false;
  var openaiScriptLoaded = false;

  // Official installation snippet (developers.openai.com/ads/measurement-pixel),
  // split like the Meta one: the stub (no network) now, the SDK download
  // later. Consent is set before init, as the docs require.
  function ensureOpenAIStub(pixelId) {
    if (!hasMarketingConsent() || !pixelId) return false;
    if (!window.oaiq) {
      var q = function () { q.q.push(arguments); };
      q.q = [];
      window.oaiq = q;
    }
    window.oaiq('consent', true);
    window.oaiq('init', { pixelId: pixelId });
    return true;
  }

  function loadOpenAIScript() {
    openaiWantScript = true;
    if (openaiState !== 'on' || openaiScriptLoaded) return;
    openaiScriptLoaded = true;
    var t = document.createElement('script');
    t.async = true;
    t.src = 'https://bzrcdn.openai.com/sdk/oaiq.min.js';
    var s = document.getElementsByTagName('script')[0];
    s.parentNode.insertBefore(t, s);
  }

  function openaiReady(pixelId) {
    if (openaiState !== 'pending') return;
    if (pixelId && ensureOpenAIStub(pixelId)) {
      openaiState = 'on';
      openaiPending.forEach(function (args) {
        try { window.oaiq.apply(null, args); } catch (e) { /* ignore */ }
      });
      if (openaiWantScript) loadOpenAIScript();
    } else {
      openaiState = 'off';
    }
    openaiPending = [];
  }

  function cleanPixelId(v) {
    var s = String(v == null ? '' : v).trim();
    return /^[A-Za-z0-9_-]{1,128}$/.test(s) ? s : '';
  }

  // Reads OPENAI_PIXEL_ID via /api/ads-config, memoised per tab session.
  function fetchOpenAIConfig() {
    try {
      var cached = window.sessionStorage.getItem(OPENAI_CONFIG_CACHE);
      if (cached) {
        var c = JSON.parse(cached);
        if (c && (Date.now() - (c.ts || 0)) < 30 * 60 * 1000) {
          openaiReady(cleanPixelId(c.id));
          return;
        }
      }
    } catch (e) { /* fall through to fetch */ }
    if (typeof window.fetch !== 'function') { openaiReady(''); return; }
    window.fetch(OPENAI_CONFIG_URL, { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (cfg) {
        var id = cleanPixelId(cfg && cfg.openai_pixel_id);
        try { window.sessionStorage.setItem(OPENAI_CONFIG_CACHE, JSON.stringify({ id: id, ts: Date.now() })); } catch (e) { /* ignore */ }
        openaiReady(id);
      })
      .catch(function () { openaiReady(''); });
  }

  // Queue-safe OpenAI measure helper. eventId (optional) lets OpenAI
  // deduplicate the browser event against the same server (CAPI) event.
  function ocmTrackOpenAI(eventName, data, eventId) {
    try {
      if (!hasMarketingConsent()) return;
      var args = ['measure', eventName, data || {}];
      if (eventId) args.push({ event_id: String(eventId) });
      if (openaiState === 'on') window.oaiq.apply(null, args);
      else if (openaiState === 'pending') openaiPending.push(args);
      // 'off': no Pixel ID configured — silently do nothing.
    } catch (e) { /* never break the page */ }
  }
  window.ocmTrackOpenAI = ocmTrackOpenAI;

  // ── Clarity ──────────────────────────────────────────────────────
  var clarityLoaded = false;
  function loadClarity() {
    if (clarityLoaded) return;
    clarityLoaded = true;
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', 'wleiviogzk');
  }

  // What happens on first interaction / failsafe. Clarity always; the
  // Pixel script too unless it already loaded immediately.
  var deferredDone = false;
  function loadDeferred() {
    if (deferredDone) return;
    deferredDone = true;
    loadClarity();
    loadPixelScript();
    loadOpenAIScript();
  }

  // ── Boot ─────────────────────────────────────────────────────────
  if (hasMarketingConsent()) {
    captureAttribution();
    captureOppref();
    ensurePixelStub(); // queues init + the one PageView; no network yet
    fetchOpenAIConfig(); // OpenAI stub only if OPENAI_PIXEL_ID is set
    if (pixelImmediate) {
      var loadImmediate = function () { loadPixelScript(); loadOpenAIScript(); };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadImmediate, { once: true });
      } else {
        loadImmediate();
      }
    }
  } else {
    openaiState = 'off';
  }

  // Events that count as user interaction. scroll/touchstart catch
  // mobile (the iOS case we're solving), click/keydown catch desktop,
  // pointerdown is a modern unified catch-all. Any one fires the load,
  // then they all unbind themselves.
  var events = ['scroll', 'touchstart', 'pointerdown', 'click', 'keydown'];
  var opts = { once: true, passive: true, capture: true };

  events.forEach(function (evt) {
    window.addEventListener(evt, loadDeferred, opts);
  });

  // Failsafe: if the user really does nothing for 8 seconds (very
  // rare — most engaged visitors interact within 2-3 seconds), still
  // load analytics so we don't lose long-dwell visits entirely. 8s
  // is past the typical 'is Safari going to flag this' moment, so
  // by then any banner would have appeared and the user has accepted
  // or dismissed it.
  setTimeout(loadDeferred, 8000);
})();
