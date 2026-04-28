// netlify/functions/lib/name-format.js
//
// Conservative name capitalisation for the cert auto-publication path.
// Acts only on names that are clearly mis-cased (all lowercase or all
// uppercase) or that contain known Irish surname prefix patterns
// (Mc/Mac/O') that benefit from specific handling. Otherwise leaves
// the name as-is — assumes the user knew what they were typing.
//
// This sits in the path of cert auto-publication at day 30, so its
// goal is to make sure the most common typing problems ('fergus
// commane' lowercase, 'O brien' missing apostrophe) don't end up
// permanently sealed on a heraldic cert. Anything ambiguous gets
// left alone.

// Particles / nobiliary prefixes that should NOT be capitalised when
// they appear in the middle of a name. e.g. 'van der Berg', 'de la Torre'.
// Word-initial particle (start of full name) IS capitalised, since
// English convention capitalises sentence-initial words.
const PARTICLES = new Set([
  'de', 'du', 'la', 'le', 'van', 'von', 'der', 'den', 'ter', 'ten',
  'da', 'do', 'dos', 'das', 'di', 'del', 'della', 'delle', 'degli',
  'el', 'bin', 'binte', 'bint', 'ibn', 'al', 'als', 'an',
]);

function titleCaseWord(word, isFirst) {
  if (!word) return word;
  const lower = word.toLowerCase();

  // Particles: lowercase unless word-initial (start of full name)
  if (PARTICLES.has(lower) && !isFirst) {
    return lower;
  }

  // Mc prefix: 'mcgowan' -> 'McGowan', 'mcdonald' -> 'McDonald'
  // Heuristic: if word starts with 'mc' and has at least 4 chars,
  // capitalise M, lowercase the rest, then capitalise the letter
  // after 'mc'.
  if (lower.length >= 4 && lower.startsWith('mc')) {
    return 'Mc' + lower.charAt(2).toUpperCase() + lower.slice(3);
  }

  // Mac prefix: 'macgowan' -> 'MacGowan'. Slight risk of false
  // positives ('mackenzie' is fine, 'macy' is not — but 'macy' is
  // 4 chars including 'mac', so requiring 5+ avoids it).
  if (lower.length >= 5 && lower.startsWith('mac')) {
    return 'Mac' + lower.charAt(3).toUpperCase() + lower.slice(4);
  }

  // Standard title case: capitalise first letter, lowercase the rest
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/**
 * Auto-fix capitalisation on a person's name — conservative.
 *
 * Acts only when the input name is:
 *   - entirely lowercase (e.g. 'fergus commane')
 *   - entirely uppercase (e.g. 'FERGUS COMMANE')
 *   - contains 'O ' or "O'" patterns that need standardisation to "O'"
 *
 * Returns input unchanged otherwise. Safe to call on already-correct names.
 *
 * @param {string} input — raw name as typed
 * @returns {string} — possibly-fixed name, or input as-is
 */
function autoFixName(input) {
  if (!input || typeof input !== 'string') return input || '';
  const trimmed = input.trim();
  if (!trimmed) return trimmed;

  let working = trimmed;

  // Detect all-lowercase or all-uppercase BEFORE any transforms, so the
  // O' fix below doesn't accidentally turn a "fergus o brien" mixed-case
  // detection into something that bypasses title-casing.
  const hasUpper = /[A-Z]/.test(working);
  const hasLower = /[a-z]/.test(working);
  const isAllOneCase = !hasUpper || !hasLower;

  // Title-case if all-one-case. Hyphens and apostrophes split into
  // separate tokens so each side gets capitalised independently
  // ('mary-jane' -> 'Mary-Jane').
  if (isAllOneCase) {
    const tokens = working.split(/(\s+|-|')/);
    let firstWordSeen = false;
    working = tokens.map((token) => {
      if (/^(\s+|-|')$/.test(token)) return token;
      if (!token) return token;
      const isFirst = !firstWordSeen;
      firstWordSeen = true;
      return titleCaseWord(token, isFirst);
    }).join('');
  }

  // Apply O' prefix normalisation AFTER title casing so it works in both
  // paths (all-lower had title casing applied, then O' is finalised; mixed
  // case skips title casing but still gets O' fixed).
  // Match: word-boundary, O or o, optional apostrophe or space, then a letter.
  // Replace with O' + capital letter.
  working = working.replace(
    /\b(O)['\s](\p{L})/giu,
    (match, _o, letter) => `O'${letter.toUpperCase()}`,
  );

  return working;
}

/**
 * Detect if a name field looks like it contains multiple people
 * rather than one person's full name. The cert names ONE primary
 * grantee — even on family tier, where partner and children are
 * recorded in separate fields. The single name field should always
 * contain ONE person's name.
 *
 * Detection looks for the specific connectors that almost always
 * indicate two people glued together:
 *   - Ampersand   ('John & Mary Smith')
 *   - Plus sign   ('John + Mary')
 *   - Slash       ('John / Mary Smith')
 *   - Word 'and'  ('John and Mary Smith') — surrounded by spaces,
 *                  with capital-letter words on each side
 *
 * Does NOT trigger on:
 *   - Multiple words alone (middle names: 'John Patrick Anthony Smith')
 *   - Hyphenated names ('Anne-Marie Smith', 'Smith-Jones')
 *   - Apostrophes ('Mary O'Connor')
 *   - Mac/Mc surnames ('John MacDonald')
 *   - Multi-word particle surnames ('Mary van der Berg')
 *   - Comma — explicitly NOT a trigger, because comma is a
 *     legitimate single-person construct for post-nominals
 *     ('John Smith, OBE', 'James Smith, PhD', 'Mary O'Connor, FRCS').
 *     Two-people-with-only-a-comma is rare in real input — almost
 *     anyone writing two names uses '&' or 'and'.
 *
 * @param {string} name
 * @returns {boolean} true if the input looks like multiple people
 */
function looksLikeMultipleNames(name) {
  if (!name || typeof name !== 'string') return false;
  const s = name.trim();
  if (!s) return false;

  // Punctuation connectors — any of these signals 'two people'.
  // Comma is deliberately NOT here (post-nominals).
  if (/[&+/]/.test(s)) return true;

  // Word 'and' as a connector — must be surrounded by whitespace
  // on both sides AND have alphabetic content on both sides.
  // Word-boundary regex ensures we don't false-positive on names
  // like 'Anders' or 'Ferdinand'. Both halves must START with a
  // capital letter to look like proper names rather than a phrase.
  if (/\s+and\s+/i.test(s)) {
    const parts = s.split(/\s+and\s+/i);
    if (parts.length >= 2 && parts.every(p => /^[A-Z]/.test(p.trim()))) {
      return true;
    }
  }

  return false;
}

module.exports = { autoFixName, looksLikeMultipleNames };
