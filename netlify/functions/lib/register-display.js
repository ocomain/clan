// netlify/functions/lib/register-display.js
//
// Pure string helpers for computing the display name + credit line of a
// member on the public Register and on the certificate. NO dependencies
// — deliberately. These were previously defined inside generate-cert.js,
// which loads pdf-lib + @pdf-lib/fontkit at module scope. register.js
// only needed computeRegisterDisplay (a pure string function) but, by
// requiring generate-cert, dragged the entire PDF stack into the
// register function's bundle. On a cold start that heavy init, on top of
// the Supabase queries, pushed the data endpoint past its execution
// timeout — the /register page hung on "Loading the Register…".
//
// Extracting these four pure functions here lets register.js import them
// with zero PDF dependencies; generate-cert.js re-exports them so its own
// callers are unchanged.

// Join a list of names with Oxford-comma 'and': [] -> '', [a] -> 'a',
// [a,b] -> 'a and b', [a,b,c] -> 'a, b, and c'.
function formatNameList(names) {
  if (!names || names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const last = names[names.length - 1];
  const rest = names.slice(0, -1).join(', ');
  return `${rest}, and ${last}`;
}

// Collapse a couple sharing a surname into 'First1 & First2 Surname';
// otherwise keep both full names. Only collapses when both names have at
// least first + surname AND the surnames match (case-insensitive).
function combineCoupleNames(name1, name2) {
  const tokens1 = name1.trim().split(/\s+/);
  const tokens2 = name2.trim().split(/\s+/);
  if (tokens1.length >= 2 && tokens2.length >= 2) {
    const surname1 = tokens1[tokens1.length - 1];
    const surname2 = tokens2[tokens2.length - 1];
    if (surname1.toLowerCase() === surname2.toLowerCase()) {
      const first1 = tokens1.slice(0, -1).join(' ');
      const first2 = tokens2.slice(0, -1).join(' ');
      return `${first1} & ${first2} ${surname1}`;
    }
  }
  return `${name1.trim()} & ${name2.trim()}`;
}

// Full family display (cert logic): names the partner and children when
// present. Children are shown unconditionally here — the register's
// opt-out gate is applied by computeRegisterDisplay below.
function computeFamilyDisplay(name, partnerName, childrenFirstNames) {
  const hasPartner = partnerName && partnerName.trim();
  const hasChildren = Array.isArray(childrenFirstNames)
    && childrenFirstNames.filter(c => c && c.trim()).length > 0;
  const cleanChildren = hasChildren
    ? childrenFirstNames.filter(c => c && c.trim()).map(c => c.trim())
    : [];

  if (hasPartner && hasChildren) {
    return {
      displayName: `${name} & Family`,
      creditLine:  `with ${partnerName.trim()}, and ${formatNameList(cleanChildren)}`,
    };
  }
  if (hasPartner && !hasChildren) {
    return {
      displayName: combineCoupleNames(name, partnerName.trim()),
      creditLine:  null,
    };
  }
  if (!hasPartner && hasChildren) {
    const childWord = cleanChildren.length === 1 ? 'child' : 'children';
    return {
      displayName: `${name} & Family`,
      creditLine:  `with their ${childWord} ${formatNameList(cleanChildren)}`,
    };
  }
  return { displayName: name, creditLine: null };
}

// Register display: same as the cert family display, EXCEPT when children
// exist but are opted out of the public register — then the credit line is
// redacted (names removed) while the '& Family' display name is kept.
function computeRegisterDisplay(name, partnerName, childrenFirstNames, childrenVisible) {
  const hasPartner = partnerName && partnerName.trim();
  const hasChildren = Array.isArray(childrenFirstNames)
    && childrenFirstNames.filter(c => c && c.trim()).length > 0;

  if (childrenVisible || !hasChildren) {
    return computeFamilyDisplay(name, partnerName, childrenFirstNames);
  }

  const cleanChildren = childrenFirstNames.filter(c => c && c.trim());
  const childWord = cleanChildren.length === 1 ? 'child' : 'children';
  if (hasPartner) {
    return {
      displayName: `${name} & Family`,
      creditLine:  `with ${partnerName.trim()}, and ${childWord}`,
    };
  }
  return {
    displayName: `${name} & Family`,
    creditLine:  `with ${childWord}`,
  };
}

module.exports = {
  formatNameList,
  combineCoupleNames,
  computeFamilyDisplay,
  computeRegisterDisplay,
};
