// netlify/functions/lib/ancestor-dedication.js
//
// Server-side defensive normalisation for the ancestor_dedication
// field. The dashboard's seal modal does both pre-input formatting
// (chip prefix + detail field) and submit-time validation, but a
// determined or accidental bypass — paste-with-extension, future
// API client, replayed payload — could still send a malformed
// string. These helpers make the server the source of truth so
// what gets stored is always sane.
//
// Behaviour matches the existing length-cap convention in
// submit-family-details.js / update-family-details.js: normalise
// quietly rather than reject. The member can correct via the
// dashboard if the silent fix doesn't match their intent; we
// prefer that over a hard error mid-flow.

// Common prefix variants seen in the wild. Includes British and
// American spellings, bare forms, and the most common informal
// alternatives. Order doesn't matter for the duplicate-prefix
// stripper — it iterates through pairs.
const KNOWN_PREFIXES = [
  'In memory of',
  'In honour of', 'In honor of',
  'Memory of',    'Honour of', 'Honor of',
  'In remembrance of', 'Remembering',
  'For',
];

/**
 * If a dedication starts with two stacked prefix variants
 * ('In honour of In honor of …' / 'In memory of For …' etc.),
 * strip the second one. Case-insensitive matching; preserves
 * the original casing of whatever survives.
 *
 * Returns the original string unchanged if no duplication found.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function stripDuplicateAncestorPrefix(value) {
  if (!value || typeof value !== 'string') return value || null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const lc = trimmed.toLowerCase();

  for (const p of KNOWN_PREFIXES) {
    const pSpace = (p + ' ').toLowerCase();
    if (!lc.startsWith(pSpace)) continue;
    // First prefix matched. Look at the remainder for a second one.
    const afterFirst = trimmed.slice(pSpace.length);
    const afterFirstLc = afterFirst.toLowerCase();
    for (const q of KNOWN_PREFIXES) {
      const qSpace = (q + ' ').toLowerCase();
      if (afterFirstLc.startsWith(qSpace)) {
        // Drop the second prefix; keep the first prefix + the rest.
        // Preserve the case of the first prefix as the user/chip
        // entered it (trimmed.slice gives us back the original
        // casing of the surviving substring).
        const survivor = trimmed.slice(0, pSpace.length) + afterFirst.slice(qSpace.length);
        return survivor.trim();
      }
    }
    // Only one prefix found — no duplication, return as-is.
    return trimmed;
  }
  // No known prefix at all — return as-is (Custom dedication path).
  return trimmed;
}

module.exports = { stripDuplicateAncestorPrefix, KNOWN_PREFIXES };
