/* /js/invite-token.js — invitation attribution token helper.
 *
 * The invitation flow (member invites a friend → email button →
 * /membership.html?invite=<uuid> → … → Stripe checkout → webhook
 * stamps invitations.converted_member_id) needs the token to
 * survive the entire signup pipeline regardless of how long it
 * takes the invitee to complete the conversion.
 *
 * Two storage stores, used in tandem:
 *
 *   sessionStorage — tab-scoped. Persists across navigation
 *                    within the same tab/session. Dies on tab
 *                    close. Sufficient for single-session
 *                    conversions.
 *
 *   Cookie         — domain-scoped. Persists across tab closes
 *                    and even browser restarts (within the
 *                    expiry window). Captures return-visit
 *                    conversions — the typical case for high-
 *                    consideration purchases like a €150
 *                    membership.
 *
 * Read priority: URL ?invite= → sessionStorage → cookie.
 * Write fans out to BOTH sessionStorage and cookie.
 * Clear (called after successful conversion) wipes both.
 *
 * Cookie spec (chosen deliberately):
 *
 *   name:     ocomain_invite
 *   value:    UUIDv4 (validated, never anything else)
 *   max-age:  30 days
 *   path:     /
 *   SameSite: Lax  — required so the cookie travels on the
 *                    cross-domain GET from the email link click
 *                    (the email is opened in a webmail client like
 *                    gmail.com; clicking the button navigates to
 *                    ocomain.org). 'Strict' would not be sent on
 *                    that initial cross-domain navigation.
 *   Secure:   true — site is HTTPS-only; explicit Secure flag
 *                    matches modern browser expectations and
 *                    belt-and-braces against any HTTP rewrite.
 *
 * Last-write wins on conflict — if a member receives a second
 * invitation while the first is still cookied, the second
 * invitation's link click (which calls write()) overwrites the
 * earlier token. Defensible: matches how marketing attribution
 * generally works (last-touch), and the inviter most recently
 * engaged is the one whose effort produced the conversion.
 *
 * GDPR note: this is a first-party functional cookie tied to an
 * explicit user action (clicking an invitation link). Necessary
 * for the feature to work; falls under 'strictly necessary' or
 * 'functional' depending on jurisdiction. Should be disclosed in
 * the cookie/privacy policy alongside any session cookies. No
 * cross-site tracking, no third-party recipients.
 */
(function () {
  'use strict';

  var COOKIE_NAME = 'ocomain_invite';
  var STORAGE_KEY = 'invite_token';
  var COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

  // UUIDv4 shape. Reject anything else so a corrupted/garbage
  // token from any source can't poison the pipeline.
  var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isValid(t) {
    return typeof t === 'string' && UUID_RE.test(t.trim());
  }

  function readSessionStorage() {
    try {
      var v = sessionStorage.getItem(STORAGE_KEY);
      return v ? v.trim() : '';
    } catch (e) {
      return ''; // private browsing throws on access
    }
  }

  function writeSessionStorage(t) {
    try { sessionStorage.setItem(STORAGE_KEY, t); } catch (e) { /* ignore */ }
  }

  function clearSessionStorage() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  function readCookie() {
    // document.cookie returns 'k1=v1; k2=v2; …'. Parse manually
    // to avoid pulling in a cookie library for one read.
    var raw = document.cookie || '';
    var parts = raw.split(';');
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i].trim();
      if (p.indexOf(COOKIE_NAME + '=') === 0) {
        try {
          return decodeURIComponent(p.substring(COOKIE_NAME.length + 1)).trim();
        } catch (e) {
          return '';
        }
      }
    }
    return '';
  }

  function writeCookie(t) {
    // Set with explicit attributes. SameSite=Lax permits the
    // cross-site navigation from the email-client domain. Secure
    // ensures the cookie is only sent over HTTPS (site is HTTPS-
    // only; this just makes the contract explicit).
    var parts = [
      COOKIE_NAME + '=' + encodeURIComponent(t),
      'max-age=' + COOKIE_MAX_AGE_SECONDS,
      'path=/',
      'SameSite=Lax',
      'Secure',
    ];
    document.cookie = parts.join('; ');
  }

  function clearCookie() {
    // Set max-age=0 with the same path so the browser drops it.
    document.cookie = COOKIE_NAME + '=; max-age=0; path=/; SameSite=Lax; Secure';
  }

  /**
   * Read the current attribution token. Resolution priority:
   *   1. URL ?invite=... (current page only) — most authoritative,
   *      represents the live click-through happening right now
   *   2. sessionStorage — earlier in this same tab session
   *   3. Cookie — earlier session, possibly different tab
   *
   * Returns '' if no valid token found at any tier.
   *
   * Side effect: if a valid token is found from URL, persists to
   * BOTH stores (so subsequent navigation within and across
   * sessions inherits it). If found from sessionStorage but not
   * cookie (or vice versa), refreshes the missing one — keeps
   * the two stores in sync for return-visit reliability.
   */
  function read() {
    var fromUrl = '';
    try {
      fromUrl = (new URLSearchParams(window.location.search).get('invite') || '').trim();
    } catch (e) { /* old browser fallback ignored */ }

    if (fromUrl && isValid(fromUrl)) {
      // URL is authoritative — write through to both stores.
      writeSessionStorage(fromUrl);
      writeCookie(fromUrl);
      return fromUrl;
    }

    var fromSession = readSessionStorage();
    if (fromSession && isValid(fromSession)) {
      // Refresh cookie if missing/different — keeps stores in
      // sync so a later same-tab refresh still has the token
      // even if sessionStorage somehow gets cleared.
      var cookieNow = readCookie();
      if (cookieNow !== fromSession) writeCookie(fromSession);
      return fromSession;
    }

    var fromCookie = readCookie();
    if (fromCookie && isValid(fromCookie)) {
      // Cookie was the only store — likely a return visit. Lift
      // the value back into sessionStorage so the rest of this
      // tab's interactions can use the faster store too.
      writeSessionStorage(fromCookie);
      return fromCookie;
    }

    return '';
  }

  /** Manually persist a token (used when read() isn't natural —
   *  e.g. if some flow constructs the token outside of URL/session/
   *  cookie). Validated; rejected if not a UUID. */
  function write(t) {
    if (!isValid(t)) return false;
    var trimmed = t.trim();
    writeSessionStorage(trimmed);
    writeCookie(trimmed);
    return true;
  }

  /** Clear from both stores. Call after successful conversion so
   *  a later invitation to the same browser doesn't get
   *  contaminated by stale attribution from this one.
   *
   *  Note: this runs CLIENT-side. The server's webhook stamps
   *  attribution from session.metadata.invite_token at the
   *  moment of conversion; that path is already complete by
   *  the time the client gets a chance to call clear(). So
   *  clear() is purely a hygiene step for future invitations
   *  to the same browser, not part of the attribution flow. */
  function clear() {
    clearSessionStorage();
    clearCookie();
  }

  // Public API namespaced under window.ocomainInvite. Avoids
  // global scope pollution while remaining easy to call from
  // inline onclick handlers and other flat-script contexts.
  window.ocomainInvite = {
    read: read,
    write: write,
    clear: clear,
    isValid: isValid,
  };
})();
