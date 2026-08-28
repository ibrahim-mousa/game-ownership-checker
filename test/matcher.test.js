/*
 * Matcher tests — run with:  node test/matcher.test.js
 *
 * No dependencies and no build step.
 *
 * Adding an entry to ALIASES, or touching normalisation? Add a case here.
 * The "must NOT match" half is the important half: a wrong badge is worse
 * than a missing one.
 */

'use strict';

const { loadUserscript } = require('./load');

const M = loadUserscript([
  'normalize', 'preClean', 'tighten', 'stripEditions',
  'romanize', 'spellings', 'exactKeys', 'editionKeys', 'buildIndex', 'matchProduct', 'ALIASES',
]);

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// A stand-in Steam library. Entries are deliberately adjacent to each other
// (same franchise, sequels, expansions) so the guards get exercised.
const LIBRARY = [
  [292030,  'The Witcher 3: Wild Hunt'],
  [289070,  "Sid Meier's Civilization VI"],
  [8930,    "Sid Meier's Civilization V"],
  [377160,  'Fallout 4'],
  [2050650, 'Resident Evil 4'],
  [1145360, 'Hades'],
  [782330,  'DOOM Eternal'],
  [208650,  'Batman: Arkham Knight'],
  [22380,   'Fallout: New Vegas'],
  [220,     'Half-Life 2'],
  [620,     'Portal 2'],
  [1151340, 'Mega Man X'],
  [413150,  'Stardew Valley'],
];

const index = M.buildIndex({ games: LIBRARY, ownedAppIds: [] });

// [ humble title, should it badge?, why this case exists ]
const CASES = [
  // Should badge -------------------------------------------------------------
  ['The Witcher 3',                             true,  'covered by an ALIASES entry'],
  ['The Witcher® 3: Wild Hunt',            true,  'registered-trademark symbol'],
  ['The Witcher 3 - Wild Hunt',                 true,  'dash instead of colon'],
  ['The Witcher 3: Wild Hunt',                  true,  'identical titles'],
  ["Sid Meier's Civilization® VI",         true,  'apostrophe plus symbol'],
  ["Sid Meier's Civilization 6",                true,  'arabic numeral vs roman'],
  ['Fallout 4: Game of the Year Edition',       true,  'edition as a subtitle'],
  ['Fallout 4 Game of the Year Edition',        true,  'edition without a colon'],
  ['DOOM Eternal - Deluxe Edition',             true,  'edition after a dash'],
  ['RESIDENT EVIL 4',                           true,  'all caps'],
  ['Stardew  Valley',                           true,  'doubled whitespace'],

  // Must not badge -----------------------------------------------------------
  ['Batman: Arkham City',                       false, 'same franchise base, different game'],
  ['Fallout',                                   false, 'franchise name vs Fallout: New Vegas'],
  ['Half-Life 2: Episode One',                  false, 'expansion, not the base game'],
  ['Portal',                                    false, 'owning Portal 2 is not owning Portal'],
  ['The Witcher 2: Assassins of Kings',         false, 'wrong entry in the series'],
  ['DOOM Eternal: The Ancient Gods - Part One', false, 'DLC'],
  ['The Witcher 3: Wild Hunt - Soundtrack',     false, 'soundtrack'],
  ['Mega Man 10',                               false, 'must not collide with Mega Man X'],
  ["Sid Meier's Civilization VI - Season Pass", false, 'season pass'],
  ['Hades II',                                  false, 'sequel that is not owned'],
  ['Fallout 76',                                false, 'different number'],
  ['Resident Evil 4 Original Soundtrack',       false, 'soundtrack without punctuation'],
];

for (const [title, want, why] of CASES) {
  const match = M.matchProduct(index, title, null);
  check(`${(match ? match.tier : '-').padEnd(6)} ${title}`, Boolean(match) === want,
    `expected ${want ? 'a match' : 'no match'} — ${why}`);
}

// Tier 1 must win even when the names share nothing at all.
{
  const appIdIndex = M.buildIndex({ games: [], ownedAppIds: [292030] });
  const match = M.matchProduct(appIdIndex, 'A Title That Matches Nothing', 292030);
  check('appid  tier-1 appid match with no name overlap', Boolean(match) && match.tier === 'appid');
}

// --- Edition suffixes, taken from a real humblebundle.com/store page ---------
//
// Qualifiers stack. Matching only the last one leaves "borderlands 4 super",
// which matches nothing — every case below failed before that was fixed.
{
  const owned = M.buildIndex({
    ownedAppIds: [],
    games: [
      [1285190, 'Borderlands 4'],
      [253230,  'A Hat in Time'],
      [1771300, 'Kingdom Come: Deliverance II'],
      [2680010, 'WUCHANG: Fallen Feathers'],
      [534380,  'Dying Light 2 Stay Human'],
      [239140,  'Dying Light'],
    ],
  });

  const EDITIONS = [
    ['Borderlands 4 Super Deluxe Edition',               'stacked qualifiers'],
    ['A Hat in Time - Ultimate Edition',                 'edition after a dash'],
    ['Kingdom Come: Deliverance II Royal Edition',       'roman numeral plus edition'],
    ['WUCHANG: Fallen Feathers Deluxe Edition',          'subtitle plus edition'],
    ['Dying Light 2: Stay Human Digital Extras Edition', 'two qualifiers, colon subtitle'],
    ['Dying Light Essentials Edition',                   'single qualifier'],
  ];
  for (const [title, why] of EDITIONS) {
    const match = M.matchProduct(owned, title, null);
    check(`${(match ? match.tier : '-').padEnd(6)} ${title}`, Boolean(match), why);
  }

  // Editions must not become a wildcard — these words are part of the name.
  const decoys = M.buildIndex({ ownedAppIds: [], games: [[1, 'Persona 5'], [2, 'Portal']] });
  for (const [title, why] of [
    ['Persona 5 Royal', 'Royal is the game name, not an edition'],
    ['Portal Reloaded', 'Reloaded is the game name, not an edition'],
  ]) {
    check(`-      ${title}`, !M.matchProduct(decoys, title, null), why);
  }
}

// --- Demos and betas are not ownership ---------------------------------------
//
// GetOwnedGames is called with include_played_free_games=1, so playtests and
// open betas arrive as apps. Playing the Street Fighter 6 Open Beta badged
// Street Fighter 6 as owned.
{
  const withBeta = M.buildIndex({
    ownedAppIds: [],
    games: [
      [2246340, 'Street Fighter 6 Open Beta'],
      [1229490, 'ULTRAKILL Demo'],
      [2183900, 'Warhaven Playtest'],
      [34330,   'Total War: SHOGUN 2 Benchmark'],
      [96000,   'Alpha Protocol'],          // a real game, must survive
      [227300,  'Euro Truck Simulator 2'],
    ],
  });

  for (const [title, why] of [
    ['Street Fighter 6', 'an open beta is not the game'],
    ['ULTRAKILL',        'a demo is not the game'],
    ['Warhaven',         'a playtest is not the game'],
  ]) {
    check(`-      ${title}`, !M.matchProduct(withBeta, title, null), why);
  }

  check('exact  Alpha Protocol',
    Boolean(M.matchProduct(withBeta, 'Alpha Protocol', null)),
    'a bare /alpha/ filter would have thrown this real game away');
  check('exact  Euro Truck Simulator 2',
    Boolean(M.matchProduct(withBeta, 'Euro Truck Simulator 2', null)));
}

// --- Edition matches must not claim certainty --------------------------------
//
// Owning Borderlands 2 is not owning Borderlands 2 GOTY. Those still badge, but
// as an inferred match, never as tier "exact".
{
  const ownsBase = M.buildIndex({ ownedAppIds: [], games: [[49520, 'Borderlands 2']] });

  const goty = M.matchProduct(ownsBase, 'Borderlands 2 Game of the Year Edition', null);
  check('edition GOTY listing still matches the base game', Boolean(goty));
  check('edition match is not reported as exact', goty && goty.tier === 'edition',
    goty ? `tier was "${goty.tier}"` : 'no match at all');
  check('edition match is flagged uncertain', goty && goty.certain === false);
  check('edition match explains itself', goty && /base game/i.test(goty.how));

  // The reverse direction is NOT symmetric: an edition includes the base game,
  // so owning the GOTY does mean you own what is on sale. That must stay certain.
  const ownsGoty = M.buildIndex({
    ownedAppIds: [], games: [[49520, 'Borderlands 2 Game of the Year Edition']],
  });
  const plain = M.matchProduct(ownsGoty, 'Borderlands 2', null);
  check('owning an edition matches the plain listing', Boolean(plain));
  check('owning a superset is certain, not hedged', plain && plain.certain === true,
    plain ? `certain was ${plain.certain}` : 'no match');

  // Steam renames base apps outright: appid 292030 is the Witcher 3 people
  // bought in 2015, now titled "Complete Edition". Treating that as a different
  // product would break the case this project started from.
  const renamed = M.buildIndex({
    ownedAppIds: [], games: [[292030, 'The Witcher 3: Wild Hunt - Complete Edition']],
  });
  const witcher = M.matchProduct(renamed, 'The Witcher 3: Wild Hunt', null);
  check('a renamed Steam app still matches the plain listing', Boolean(witcher));
  check('and is not hedged, because you do own it', witcher && witcher.certain === true);

  const dl2 = M.buildIndex({
    ownedAppIds: [], games: [[534380, 'Dying Light 2 Stay Human: Reloaded Edition']],
  });
  check('same for Dying Light 2 Reloaded Edition',
    (M.matchProduct(dl2, 'Dying Light 2 Stay Human', null) || {}).certain === true);

  // A genuine exact match must stay certain.
  const exact = M.matchProduct(ownsBase, 'Borderlands 2', null);
  check('exact  a true title match stays certain',
    exact && exact.tier === 'exact' && exact.certain === true);
}

// --- Stores disagree about spacing -------------------------------------------
//
// Steam sells "HunterX" (app 1918450); a Humble bundle lists it as "Hunter X".
// Whitespace is no more meaningful in a title than the punctuation normalize()
// already strips, so both spellings are indexed.
{
  const owned = M.buildIndex({
    ownedAppIds: [],
    games: [
      [1918450, 'HunterX'],
      [413150,  'Stardew Valley'],
      [220,     'Half-Life 2'],
    ],
  });

  for (const [title, why] of [
    ['Hunter X',        'Humble adds a space Steam does not have'],
    ['HunterX',         'identical spelling still works'],
    ['Hunter  X',       'doubled whitespace'],
    ['Half Life 2',     'hyphen dropped as well as respaced'],
    ['Stardew Valley',  'ordinary titles are unaffected'],
  ]) {
    check(`spacing ${title}`, Boolean(M.matchProduct(owned, title, null)), why);
  }

  // Squashing spaces must not make unrelated titles collide.
  check('-      Hunter Y still does not match', !M.matchProduct(owned, 'Hunter Y', null));
  check('-      Hunter still does not match',   !M.matchProduct(owned, 'Hunter', null));

  // The variant is additive, never a replacement.
  const keys = M.exactKeys('Hunter X');
  check('keeps both the spaced and squashed spellings',
    keys.includes('hunter x') && keys.includes('hunterx'), keys.join(', '));
  check('adds nothing extra for a single-word title',
    M.exactKeys('Noita').length === 1, M.exactKeys('Noita').join(', '));
}

// --- Aliases carry what the matcher deliberately will not guess -------------
//
// There is no fuzzy or subtitle matching: anything normalisation cannot bridge
// lives in ALIASES, checked by a human. Every seeded entry must actually fire.
{
  const owned = M.buildIndex({
    ownedAppIds: [945360, 386940, 1250410, 319630, 292030],
    games: [],
  });

  for (const [title, why] of [
    ['Among Us: 4-Pack',                                         'multi-copy pack'],
    ['Ultimate Chicken Horse 4 Pack',                            'multi-copy pack'],
    ['Microsoft Flight Simulator (2020) - Premium Deluxe Edition','Steam adds "40th Anniversary"'],
    ['Life Is Strange™ - Complete Season',                  'Steam lists five episodes'],
    ['The Witcher 3',                                            'Humble drops the subtitle'],
  ]) {
    const match = M.matchProduct(owned, title, null);
    check(`alias  ${title}`, Boolean(match) && match.tier === 'alias', why);
  }

  // An alias must not fire for a library that does not contain the appid.
  const empty = M.buildIndex({ ownedAppIds: [], games: [] });
  check('-      alias does not fire on an unowned appid',
    !M.matchProduct(empty, 'Among Us: 4-Pack', null));

  // Keys are normalized Humble titles; a raw title would silently never match.
  const badKeys = Object.keys(M.ALIASES).filter(k => M.normalize(k) !== k);
  check('every ALIASES key is already normalized', badKeys.length === 0, badKeys.join(', '));
}

// --- Character handling ------------------------------------------------------
//
// These silently poison matching: NFKD expands "™" into the letters TM, and a
// dropped apostrophe is one of the commonest differences between the stores.
const NORMALISATION = [
  ['Pokémon Trading Card Game',        'pokemon trading card game'],
  ['Ōkami HD',                          'okami hd'],
  ['Sid Meier’s Civilization VI',       'sid meiers civilization vi'],
  ['Sid Meiers Civilization VI',             'sid meiers civilization vi'],
  ['The Witcher® 3',                    'the witcher 3'],
  ['Command & Conquer',                      'command and conquer'],
  ['Tom Clancy’s Splinter Cell™',  'tom clancys splinter cell'],
];

for (const [input, want] of NORMALISATION) {
  const got = M.normalize(input);
  check(`norm   ${input}`, got === want, `normalises to "${got}", expected "${want}"`);
}

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);

if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name}${f.detail ? '\n    ' + f.detail : ''}`);
  process.exit(1);
}
