// /members/gaelic-name-converter.js
//
// Small helper for suggesting Irish-language forms of English first
// names and clan-adjacent surnames. Used on the publish modal's
// 'Your name on the certificate' field so members can choose to
// have their cert sealed in their Irish name.
//
// DESIGN PRINCIPLES
//
// 1. Lookup table only — no AI, no fuzzy matching, no learning.
//    This is a polish feature, not a translation engine. We suggest
//    forms we're confident in; for everything else, the member
//    writes their own. Suggestions wrong about a member's identity
//    would be worse than suggesting nothing.
//
// 2. Multiple suggestions where they exist — many English names map
//    to several Irish forms (Anthony → Antoin / Antaine / Antóin),
//    and asking the member to choose feels right. The member knows
//    which variant is theirs (or whose name pattern they prefer).
//
// 3. Authoritative sources only — first names are standard
//    Irish-English correspondences (any reputable Irish names
//    reference); surnames come from the clan's own variants page
//    (surname-variants.html), so we know they're correct for THIS
//    clan. We deliberately do NOT include broad Irish surnames we
//    have no clan-specific knowledge of.
//
// 4. Pronunciation hints on hover — not for the suggestion itself
//    but for the suggested form, so the member can pick what they
//    can actually say at a clan gathering.
//
// 5. Surname-aware — the converter returns separate suggestions for
//    first name and surname. This way a member named 'Patrick
//    Cummins' can take 'Pádraig' for the first name AND 'Ó Comáin'
//    for the surname, building 'Pádraig Ó Comáin' — the full Irish
//    form — without the converter trying to compose it for them
//    (composition has gendered surname variants we'd rather let the
//    member handle).

// ─────────────────────────────────────────────────────────────────
// FIRST-NAME LOOKUP
//
// Keys are lowercased, with apostrophes/punctuation stripped — match
// is on the simplified form. Multiple Irish forms per English name
// are supported (the most common form first); the UI will list them
// in order so the topmost suggestion is the safest default.
//
// Structure: { irish, pronunciation, gender }
//   - irish: the suggested Irish form
//   - pronunciation: rough English pronunciation (consistent with
//     standard Irish-English pronunciation guides — e.g. 'PAW-rig'
//     for Pádraig follows the convention used on most Irish-language
//     teaching sites)
//   - gender: 'm' / 'f' / 'n' (neutral) — used only for sorting / UI
//     hints, not strictly enforced. A member is free to pick any.
// ─────────────────────────────────────────────────────────────────
const FIRST_NAMES = {
  // — Male names —
  'aidan':       [{ irish: 'Aodhán',    pronunciation: 'AY-dawn',     gender: 'm' }],
  'alan':        [{ irish: 'Ailín',     pronunciation: 'AH-leen',     gender: 'm' }],
  'andrew':      [{ irish: 'Aindriú',   pronunciation: 'AHN-droo',    gender: 'm' }],
  'anthony':     [{ irish: 'Antoin',    pronunciation: 'ON-tin',      gender: 'm' },
                  { irish: 'Antaine',   pronunciation: 'ON-tin-eh',   gender: 'm' }],
  'antony':      [{ irish: 'Antoin',    pronunciation: 'ON-tin',      gender: 'm' }],
  'arthur':      [{ irish: 'Artúr',     pronunciation: 'AR-toor',     gender: 'm' }],
  'austin':      [{ irish: 'Aibhistín', pronunciation: 'AV-ish-teen', gender: 'm' }],
  'barry':       [{ irish: 'Barra',     pronunciation: 'BARR-ah',     gender: 'm' }],
  'brendan':     [{ irish: 'Breandán',  pronunciation: 'BREN-dawn',   gender: 'm' }],
  'brian':       [{ irish: 'Brian',     pronunciation: 'BREE-an',     gender: 'm' }],
  'cathal':      [{ irish: 'Cathal',    pronunciation: 'KA-hull',     gender: 'm' }],
  'charles':     [{ irish: 'Cathal',    pronunciation: 'KA-hull',     gender: 'm' },
                  { irish: 'Séarlas',   pronunciation: 'SHAR-lus',    gender: 'm' }],
  'christopher': [{ irish: 'Críostóir', pronunciation: 'KREE-uss-tor', gender: 'm' }],
  'colin':       [{ irish: 'Coilín',    pronunciation: 'KAW-leen',    gender: 'm' }],
  'colm':        [{ irish: 'Colm',      pronunciation: 'CULL-um',     gender: 'm' }],
  'conor':       [{ irish: 'Conchúr',   pronunciation: 'KON-khoor',   gender: 'm' },
                  { irish: 'Conor',     pronunciation: 'KON-er',      gender: 'm' }],
  'connor':      [{ irish: 'Conchúr',   pronunciation: 'KON-khoor',   gender: 'm' }],
  'cormac':      [{ irish: 'Cormac',    pronunciation: 'KOR-mak',     gender: 'm' }],
  'daniel':      [{ irish: 'Dónal',     pronunciation: 'DOE-nul',     gender: 'm' },
                  { irish: 'Dainéil',   pronunciation: 'DON-yale',    gender: 'm' }],
  'david':       [{ irish: 'Dáithí',    pronunciation: 'DAW-hee',     gender: 'm' },
                  { irish: 'Daibhí',    pronunciation: 'DAH-vee',     gender: 'm' }],
  'declan':      [{ irish: 'Deaglán',   pronunciation: 'DAG-lawn',    gender: 'm' }],
  'denis':       [{ irish: 'Donnchadh', pronunciation: 'DUN-uh-khoo', gender: 'm' }],
  'dennis':      [{ irish: 'Donnchadh', pronunciation: 'DUN-uh-khoo', gender: 'm' }],
  'donal':       [{ irish: 'Dónal',     pronunciation: 'DOE-nul',     gender: 'm' }],
  'donald':      [{ irish: 'Dónal',     pronunciation: 'DOE-nul',     gender: 'm' }],
  'eamon':       [{ irish: 'Éamon',     pronunciation: 'AY-mun',      gender: 'm' }],
  'edward':      [{ irish: 'Éamon',     pronunciation: 'AY-mun',      gender: 'm' },
                  { irish: 'Éadbhard',  pronunciation: 'AID-vard',    gender: 'm' }],
  'enda':        [{ irish: 'Éanna',     pronunciation: 'AY-nah',      gender: 'm' }],
  'eoin':        [{ irish: 'Eoin',      pronunciation: 'OWE-in',      gender: 'm' }],
  'feargal':     [{ irish: 'Fearghal',  pronunciation: 'FAR-gul',     gender: 'm' }],
  'fergus':      [{ irish: 'Fearghas',  pronunciation: 'FAR-gus',     gender: 'm' }],
  'finbar':      [{ irish: 'Fionnbharr', pronunciation: 'FIN-bar',    gender: 'm' }],
  'francis':     [{ irish: 'Proinsias', pronunciation: 'PRIN-shee-us', gender: 'm' }],
  'gerald':      [{ irish: 'Gearóid',   pronunciation: 'GAR-odj',     gender: 'm' }],
  'gerard':      [{ irish: 'Gearóid',   pronunciation: 'GAR-odj',     gender: 'm' }],
  'henry':       [{ irish: 'Anraí',     pronunciation: 'ON-ree',      gender: 'm' }],
  'hugh':        [{ irish: 'Aodh',      pronunciation: 'EE',          gender: 'm' }],
  'james':       [{ irish: 'Séamus',    pronunciation: 'SHAY-mus',    gender: 'm' }],
  'jim':         [{ irish: 'Séamaisín', pronunciation: 'SHAY-mush-een', gender: 'm' }],
  'jimmy':       [{ irish: 'Séamaisín', pronunciation: 'SHAY-mush-een', gender: 'm' }],
  'john':        [{ irish: 'Seán',      pronunciation: 'SHAWN',       gender: 'm' },
                  { irish: 'Eoin',      pronunciation: 'OWE-in',      gender: 'm' }],
  'joseph':      [{ irish: 'Seosamh',   pronunciation: 'SHOSS-uv',    gender: 'm' }],
  'kevin':       [{ irish: 'Caoimhín',  pronunciation: 'KEE-veen',    gender: 'm' }],
  'kieran':      [{ irish: 'Ciarán',    pronunciation: 'KEER-awn',    gender: 'm' }],
  'liam':        [{ irish: 'Liam',      pronunciation: 'LEE-um',      gender: 'm' }],
  'luke':        [{ irish: 'Lúcás',     pronunciation: 'LOO-kawss',   gender: 'm' }],
  'mark':        [{ irish: 'Marcus',    pronunciation: 'MOR-kuss',    gender: 'm' }],
  'martin':      [{ irish: 'Máirtín',   pronunciation: 'MOR-cheen',   gender: 'm' }],
  'matthew':     [{ irish: 'Maitiú',    pronunciation: 'MAH-too',     gender: 'm' }],
  'michael':     [{ irish: 'Mícheál',   pronunciation: 'MEE-hawl',    gender: 'm' }],
  'neil':        [{ irish: 'Niall',     pronunciation: 'NEE-ull',     gender: 'm' }],
  'niall':       [{ irish: 'Niall',     pronunciation: 'NEE-ull',     gender: 'm' }],
  'nicholas':    [{ irish: 'Nioclás',   pronunciation: 'NICK-lawss',  gender: 'm' }],
  'noel':        [{ irish: 'Nollaig',   pronunciation: 'NULL-ig',     gender: 'm' }],
  'oliver':      [{ irish: 'Oilibhéar', pronunciation: 'IL-iv-ayr',   gender: 'm' }],
  'owen':        [{ irish: 'Eoghan',    pronunciation: 'OWE-un',      gender: 'm' }],
  'pat':         [{ irish: 'Pádraig',   pronunciation: 'PAW-rig',     gender: 'm' }],
  'patrick':     [{ irish: 'Pádraig',   pronunciation: 'PAW-rig',     gender: 'm' },
                  { irish: 'Páidín',    pronunciation: 'POD-jeen',    gender: 'm' }],
  'paul':        [{ irish: 'Pól',       pronunciation: 'POLE',        gender: 'm' }],
  'peter':       [{ irish: 'Peadar',    pronunciation: 'PAH-dur',     gender: 'm' }],
  'philip':      [{ irish: 'Pilib',     pronunciation: 'PIL-ib',      gender: 'm' }],
  'richard':     [{ irish: 'Risteard',  pronunciation: 'RISH-tard',   gender: 'm' }],
  'robert':      [{ irish: 'Roibeárd',  pronunciation: 'RO-bart',     gender: 'm' }],
  'roger':       [{ irish: 'Ruaidhrí',  pronunciation: 'ROO-ree',     gender: 'm' }],
  'ronan':       [{ irish: 'Rónán',     pronunciation: 'ROW-nawn',    gender: 'm' }],
  'rory':        [{ irish: 'Ruairí',    pronunciation: 'ROO-ree',     gender: 'm' },
                  { irish: 'Ruaidhrí',  pronunciation: 'ROO-ree',     gender: 'm' }],
  'sean':        [{ irish: 'Seán',      pronunciation: 'SHAWN',       gender: 'm' }],
  'shane':       [{ irish: 'Seán',      pronunciation: 'SHAWN',       gender: 'm' }],
  'stephen':     [{ irish: 'Stiofán',   pronunciation: 'SHTUFF-awn',  gender: 'm' }],
  'thomas':      [{ irish: 'Tomás',     pronunciation: 'TUM-awss',    gender: 'm' }],
  'tim':         [{ irish: 'Tadhg',     pronunciation: 'TIGE',        gender: 'm' }],
  'timothy':     [{ irish: 'Tadhg',     pronunciation: 'TIGE',        gender: 'm' }],
  'tom':         [{ irish: 'Tomás',     pronunciation: 'TUM-awss',    gender: 'm' }],
  'tony':        [{ irish: 'Antoin',    pronunciation: 'ON-tin',      gender: 'm' }],
  'william':     [{ irish: 'Liam',      pronunciation: 'LEE-um',      gender: 'm' },
                  { irish: 'Uilliam',   pronunciation: 'ULL-yum',     gender: 'm' }],

  // — Female names —
  'aileen':      [{ irish: 'Eibhlín',   pronunciation: 'EYE-leen',    gender: 'f' }],
  'aine':        [{ irish: 'Áine',      pronunciation: 'AWN-yeh',     gender: 'f' }],
  'alice':       [{ irish: 'Ailís',     pronunciation: 'AL-eesh',     gender: 'f' }],
  'ann':         [{ irish: 'Áine',      pronunciation: 'AWN-yeh',     gender: 'f' }],
  'anne':        [{ irish: 'Áine',      pronunciation: 'AWN-yeh',     gender: 'f' }],
  'aoife':       [{ irish: 'Aoife',     pronunciation: 'EE-fa',       gender: 'f' }],
  'bridget':     [{ irish: 'Bríd',      pronunciation: 'BREED',       gender: 'f' }],
  'brigid':      [{ irish: 'Bríd',      pronunciation: 'BREED',       gender: 'f' }],
  'caitlin':     [{ irish: 'Caitlín',   pronunciation: 'KOTCH-leen',  gender: 'f' }],
  'caroline':    [{ irish: 'Caitríona', pronunciation: 'KOTCH-reena', gender: 'f' }],
  'catherine':   [{ irish: 'Caitríona', pronunciation: 'KOTCH-reena', gender: 'f' },
                  { irish: 'Cáit',      pronunciation: 'KAWTCH',      gender: 'f' }],
  'cathy':       [{ irish: 'Cáit',      pronunciation: 'KAWTCH',      gender: 'f' }],
  'ciara':       [{ irish: 'Ciara',     pronunciation: 'KEE-ra',      gender: 'f' }],
  'deirdre':     [{ irish: 'Deirdre',   pronunciation: 'DAYR-druh',   gender: 'f' }],
  'eileen':      [{ irish: 'Eibhlín',   pronunciation: 'EYE-leen',    gender: 'f' }],
  'eilis':       [{ irish: 'Eilís',     pronunciation: 'EH-leesh',    gender: 'f' }],
  'elizabeth':   [{ irish: 'Eilís',     pronunciation: 'EH-leesh',    gender: 'f' },
                  { irish: 'Eilísabéad', pronunciation: 'EH-lees-uh-bayd', gender: 'f' }],
  'emily':       [{ irish: 'Eimíle',    pronunciation: 'EM-eel-eh',   gender: 'f' }],
  'emma':        [{ irish: 'Eimíle',    pronunciation: 'EM-eel-eh',   gender: 'f' }],
  'fiona':       [{ irish: 'Fiona',     pronunciation: 'FEE-uh-nuh',  gender: 'f' }],
  'grace':       [{ irish: 'Gráinne',   pronunciation: 'GRAW-nya',    gender: 'f' }],
  'helen':       [{ irish: 'Léan',      pronunciation: 'LAY-un',      gender: 'f' }],
  'jane':        [{ irish: 'Síle',      pronunciation: 'SHEE-luh',    gender: 'f' }],
  'joan':        [{ irish: 'Siobhán',   pronunciation: 'shi-VAWN',    gender: 'f' }],
  'judith':      [{ irish: 'Siobhán',   pronunciation: 'shi-VAWN',    gender: 'f' }],
  'julia':       [{ irish: 'Síle',      pronunciation: 'SHEE-luh',    gender: 'f' }],
  'kate':        [{ irish: 'Cáit',      pronunciation: 'KAWTCH',      gender: 'f' }],
  'kathleen':    [{ irish: 'Caitlín',   pronunciation: 'KOTCH-leen',  gender: 'f' }],
  'linda':       [{ irish: 'Líonadh',   pronunciation: 'LEE-nuh',     gender: 'f' }],
  'margaret':    [{ irish: 'Mairéad',   pronunciation: 'mor-AID',     gender: 'f' },
                  { irish: 'Peigí',     pronunciation: 'PEG-ee',      gender: 'f' }],
  'maria':       [{ irish: 'Máire',     pronunciation: 'MOY-ra',      gender: 'f' }],
  'marie':       [{ irish: 'Máire',     pronunciation: 'MOY-ra',      gender: 'f' }],
  'mary':        [{ irish: 'Máire',     pronunciation: 'MOY-ra',      gender: 'f' },
                  { irish: 'Muire',     pronunciation: 'MWIR-eh',     gender: 'f' }],
  'maureen':     [{ irish: 'Máirín',    pronunciation: 'MOR-een',     gender: 'f' }],
  'meaghan':     [{ irish: 'Méabh',     pronunciation: 'MAYV',        gender: 'f' }],
  'meg':         [{ irish: 'Méabh',     pronunciation: 'MAYV',        gender: 'f' }],
  'michelle':    [{ irish: 'Mícheálín', pronunciation: 'MEE-hawl-een', gender: 'f' }],
  'nora':        [{ irish: 'Nóra',      pronunciation: 'NORE-a',      gender: 'f' }],
  'noreen':      [{ irish: 'Nóirín',    pronunciation: 'NORE-een',    gender: 'f' }],
  'patricia':    [{ irish: 'Pádraigín', pronunciation: 'PAW-rig-een', gender: 'f' }],
  'peggy':       [{ irish: 'Peigí',     pronunciation: 'PEG-ee',      gender: 'f' }],
  'rose':        [{ irish: 'Róis',      pronunciation: 'ROSH',        gender: 'f' }],
  'roisin':      [{ irish: 'Róisín',    pronunciation: 'ROW-sheen',   gender: 'f' }],
  'ruth':        [{ irish: 'Rút',       pronunciation: 'ROOT',        gender: 'f' }],
  'sally':       [{ irish: 'Sailí',     pronunciation: 'SAH-lee',     gender: 'f' }],
  'saoirse':     [{ irish: 'Saoirse',   pronunciation: 'SEER-sha',    gender: 'f' }],
  'sarah':       [{ irish: 'Sorcha',    pronunciation: 'SUR-uh-kha',  gender: 'f' },
                  { irish: 'Sárait',    pronunciation: 'SAW-rit',     gender: 'f' }],
  'siobhan':     [{ irish: 'Siobhán',   pronunciation: 'shi-VAWN',    gender: 'f' }],
  'sinead':      [{ irish: 'Sinéad',    pronunciation: 'shi-NAYD',    gender: 'f' }],
  'sheila':      [{ irish: 'Síle',      pronunciation: 'SHEE-luh',    gender: 'f' }],
  'sile':        [{ irish: 'Síle',      pronunciation: 'SHEE-luh',    gender: 'f' }],
  'theresa':     [{ irish: 'Treasa',    pronunciation: 'TRASS-a',     gender: 'f' }],
  'teresa':      [{ irish: 'Treasa',    pronunciation: 'TRASS-a',     gender: 'f' }],
  'una':         [{ irish: 'Úna',       pronunciation: 'OO-na',       gender: 'f' }],
};

// ─────────────────────────────────────────────────────────────────
// CLAN-ADJACENT SURNAMES
//
// Sourced from surname-variants.html — the clan's own canonical
// list of anglicised forms, all of which derive from Ó Comáin /
// Mac Comáin.
//
// Why no broad Irish-surname dictionary? Because correct
// surname-Gaelicisation requires lineage knowledge we cannot have.
// Different McCarthys, Murphys, etc. trace to different Gaelic
// forms. We'd be guessing. For surnames we don't recognise as
// clan-adjacent, the converter says nothing.
//
// Each surname maps to the masculine ('Ó Comáin') and feminine
// ('Ní Chomáin') forms. Married women traditionally take the
// 'Bean Uí Chomáin' form ('wife of Ó Comáin'); we don't auto-pick
// between Ní/Bean since that's the member's call.
//
// 'Ó' is the patronymic (descendant of); 'Mac' is the matronymic
// (less common for this lineage but historically attested).
// ─────────────────────────────────────────────────────────────────
const CLAN_SURNAMES = new Set([
  'commane', 'commins', 'cummins', 'cummings', 'cumming', 'cumin',
  'comyn', 'coman', 'commons', 'commine', 'comine', 'comaine',
  'hurley',  // recognised variant via Ó Muirthile / Ó Comáin merger
  'ocomain', 'o-comain', 'ocoman',
]);

function suggestionsForFirstName(name) {
  if (!name) return [];
  const key = String(name).toLowerCase().trim().replace(/['']/g, '').replace(/[^a-z]/g, '');
  return FIRST_NAMES[key] || [];
}

function suggestionsForSurname(surname) {
  if (!surname) return [];
  const key = String(surname).toLowerCase().trim().replace(/['']/g, '').replace(/[^a-z]/g, '');
  if (!CLAN_SURNAMES.has(key)) return [];
  // For clan-adjacent surnames, we offer:
  //   1. Ó Comáin       — masculine descendant form
  //   2. Ní Chomáin     — feminine descendant form (unmarried)
  //   3. Bean Uí Chomáin — married woman's form
  //   4. Mac Comáin     — matronymic descendant (rarer)
  return [
    { irish: 'Ó Comáin',         pronunciation: 'OH KO-mawn',        note: 'descendant (m.)' },
    { irish: 'Ní Chomáin',       pronunciation: 'NEE KHO-mawn',      note: 'descendant (f., unmarried)' },
    { irish: 'Bean Uí Chomáin',  pronunciation: 'BAN EE KHO-mawn',   note: 'wife of (married f.)' },
    { irish: 'Mac Comáin',       pronunciation: 'MOK KO-mawn',       note: 'descendant (matronymic)' },
  ];
}

// ─────────────────────────────────────────────────────────────────
// PARSE A FULL NAME INTO PARTS
//
// Splits a name like 'Anthony "Tony" Cummins' into:
//   { firstNameRaw: 'Anthony', surnameRaw: 'Cummins',
//     middlePart: '"Tony"', original: 'Anthony "Tony" Cummins' }
//
// The first whitespace-delimited token is treated as first name.
// The last token is treated as surname. Anything in between
// (middle names, nicknames in quotes, initials) is preserved as
// middlePart so we can reconstruct the full name with substitutions.
// ─────────────────────────────────────────────────────────────────
function parseName(fullName) {
  const trimmed = String(fullName || '').trim();
  if (!trimmed) return { firstNameRaw: '', surnameRaw: '', middlePart: '', original: '' };
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 1) {
    return { firstNameRaw: tokens[0], surnameRaw: '', middlePart: '', original: trimmed };
  }
  return {
    firstNameRaw: tokens[0],
    surnameRaw:   tokens[tokens.length - 1],
    middlePart:   tokens.slice(1, -1).join(' '),
    original:     trimmed,
  };
}

// Reconstruct full name with optional first-name and surname swaps.
// If a swap value is null/empty, retains the original.
function rebuildName(parts, newFirst, newSurname) {
  const first = newFirst || parts.firstNameRaw;
  const surname = newSurname || parts.surnameRaw;
  const middle = parts.middlePart;
  return [first, middle, surname].filter(Boolean).join(' ').trim();
}

// Public API.
window.GaelicNameConverter = {
  suggestionsForFirstName,
  suggestionsForSurname,
  parseName,
  rebuildName,
};
