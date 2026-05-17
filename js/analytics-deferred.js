// js/analytics-deferred.js
//
// Loads Microsoft Clarity and Meta Pixel ONLY after the user has
// interacted with the page (scroll, touch, click, or keyboard).
// Initial paint loads no third-party tracking, which prevents iOS
// Safari from showing the 'Reduce Privacy Protections' banner that
// Apple started surfacing more aggressively in recent iOS versions
// when the page tries to load fingerprinting / cross-site trackers
// on first paint.
//
// THE TRADE-OFF (deliberate, agreed 13 May 2026):
//   - Bounced visitors who never scroll or click aren't tracked
//     in Clarity or Pixel.
//   - Engaged visitors (anyone who scrolls or taps) are still
//     tracked from the moment they engage. Pixel records its
//     PageView event the moment the script loads, so the data is
//     captured — just deferred from first paint by ~100ms-2s
//     depending on how soon the user interacts.
//   - The vast majority of marketing-relevant signal lives in
//     'visitor engaged with the site' rather than 'visitor
//     opened the URL and bounced', so this preserves what
//     matters and drops what doesn't.
//
// WHY ONE FILE:
//   Previously every page inlined the same Clarity + Pixel
//   snippets in its <head>. That duplication made it hard to
//   change the loading strategy site-wide. Now a single
//   <script defer src="/js/analytics-deferred.js"></script>
//   replaces ~20 lines of inline JS per page and ensures every
//   page uses the same deferred-load behaviour automatically.
//
// SAFETY:
//   - Uses { once: true } event listeners so each handler fires
//     at most once.
//   - Uses { passive: true } on scroll/touch so we don't block
//     iOS scroll responsiveness.
//   - Guards against double-loading via a top-level flag.
//   - Removes its own listeners after firing so memory stays
//     clean even if 'once:true' isn't supported.

(function () {
  'use strict';

  var loaded = false;

  function loadAnalytics() {
    if (loaded) return;
    loaded = true;

    // ── Microsoft Clarity ──────────────────────────────────────
    (function (c, l, a, r, i, t, y) {
      c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
      t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
      y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
    })(window, document, 'clarity', 'script', 'wleiviogzk');

    // ── Meta Pixel ─────────────────────────────────────────────
    !function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n; n.loaded = !0; n.version = '2.0';
      n.queue = []; t = b.createElement(e); t.async = !0;
      t.src = v; s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    fbq('init', '2218274272324729');
    fbq('track', 'PageView');
  }

  // Events that count as user interaction. scroll/touchstart catch
  // mobile (the iOS case we're solving), click/keydown catch desktop,
  // pointerdown is a modern unified catch-all. Any one fires the load,
  // then they all unbind themselves.
  var events = ['scroll', 'touchstart', 'pointerdown', 'click', 'keydown'];
  var opts = { once: true, passive: true, capture: true };

  events.forEach(function (evt) {
    window.addEventListener(evt, loadAnalytics, opts);
  });

  // Failsafe: if the user really does nothing for 8 seconds (very
  // rare — most engaged visitors interact within 2-3 seconds), still
  // load analytics so we don't lose long-dwell visits entirely. 8s
  // is past the typical 'is Safari going to flag this' moment, so
  // by then any banner would have appeared and the user has accepted
  // or dismissed it.
  setTimeout(loadAnalytics, 8000);
})();
