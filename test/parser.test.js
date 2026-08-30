/*
 * Profile-page parser tests — run with:  node test/parser.test.js
 *
 * Valve retired the `xml=1` games feed: it redirects to the sign-in page even
 * for a signed-in user, while the plain HTML page loads normally. The library
 * is therefore scraped out of that page, and Steam has shipped two different
 * layouts for it. Both are covered here, along with the failure modes that
 * must not be mistaken for an empty library.
 */

'use strict';

const { loadUserscript } = require('./load');

const M = loadUserscript([
  'decodeEntities', 'parseProfileGames', 'parseProfileIdentity', 'normaliseRows',
  'parseSteamId', 'profileGamesUrl', 'scavengeGames',
  'parseWebApiToken', 'parseLoaderData', 'extractLiteral',
  'largest', 'collectGameArrays',
  'collectGameArrays',
]);

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

// --- Modern layout: JSON in a data- attribute, HTML-escaped ------------------
{
  const games = [
    { appid: 292030, name: 'The Witcher 3: Wild Hunt' },
    { appid: 289070, name: "Sid Meier's Civilization VI" },
    { appid: 220,    name: 'Half-Life 2' },
  ];
  const escaped = JSON.stringify({ rgGames: games })
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const html = `<html><body>
    <div id="gameslist_config" data-profile-gameslist="${escaped}"></div>
  </body></html>`;

  const rows = M.parseProfileGames(html);
  check('modern layout: finds every game', rows && rows.length === 3);
  check('modern layout: decodes escaped quotes',
    rows && rows[1].name === "Sid Meier's Civilization VI",
    rows ? JSON.stringify(rows[1] && rows[1].name) : 'no rows');
}

// --- Ampersands must survive: &amp; is decoded last --------------------------
{
  const escaped = JSON.stringify({ rgGames: [{ appid: 7, name: 'Command & Conquer' }] })
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  const html = `<div id="gameslist_config" data-profile-gameslist="${escaped}"></div>`;
  const rows = M.parseProfileGames(html);
  check('ampersands in titles decode correctly',
    rows && rows[0].name === 'Command & Conquer',
    rows ? JSON.stringify(rows[0].name) : 'no rows');
}

// --- A bare array, rather than {rgGames: [...]} ------------------------------
{
  const escaped = JSON.stringify([{ appid: 620, name: 'Portal 2' }]).replace(/"/g, '&quot;');
  const html = `<div id="gameslist_config" data-profile-gameslist="${escaped}"></div>`;
  const rows = M.parseProfileGames(html);
  check('accepts a bare array too', rows && rows.length === 1 && rows[0].appid === 620);
}

// --- Legacy layout: inline `var rgGames = [...]` -----------------------------
{
  const html = `<script>
    var rgGames = [{"appid":413150,"name":"Stardew Valley","playtime_forever":120}];
    var somethingElse = 1;
  </script>`;
  const rows = M.parseProfileGames(html);
  check('legacy layout: reads inline rgGames', rows && rows.length === 1);
  check('legacy layout: keeps the name', rows && rows[0].name === 'Stardew Valley');
}

// --- Container-agnostic scavenger --------------------------------------------
//
// Steam keeps relocating the games payload. The scavenger ignores containers
// and looks for the data itself, so it must survive layouts nobody has seen.
{
  const wrapped = `<div data-something="{&quot;x&quot;:1}"></div>
    <script>window.__DATA__ = {"rgOwned":[{"appid":220,"name":"Half-Life 2"},
    {"name":"Portal 2","appid":620}]};</script>`;
  const rows = M.scavengeGames(wrapped);
  check('scavenger finds games in an unknown container', rows && rows.length === 2);
  check('scavenger handles name-before-appid ordering',
    rows && rows.some(r => r.appid === 620 && r.name === 'Portal 2'));

  check('scavenger decodes escaped names',
    (M.scavengeGames('[{"appid":1,"name":"Sid Meier\\u2019s Civ"}]') || [])[0]?.name
      === 'Sid Meier\u2019s Civ');

  check('scavenger de-duplicates repeated appids',
    (M.scavengeGames('[{"appid":7,"name":"A"},{"appid":7,"name":"A"}]') || []).length === 1);

  check('scavenger ignores appids with no name nearby',
    M.scavengeGames('{"appid":123}') === null);

  check('scavenger returns null on data-free markup',
    M.scavengeGames('<html><body>nothing</body></html>') === null);

  // It is the LAST strategy: a recognised layout must still win.
  const known = `<div id="gameslist_config" data-profile-gameslist="${
    JSON.stringify({ rgGames: [{ appid: 1, name: 'Real' }] }).replace(/"/g, '&quot;')
  }"></div><script>var junk = {"appid":999,"name":"Decoy"};</script>`;
  const picked = M.parseProfileGames(known);
  check('known layouts take precedence over the scavenger',
    picked && picked.length === 1 && picked[0].name === 'Real');
}

// --- Steam's React SSR payload ------------------------------------------------
//
// Modern pages ship state as `window.SSR.loaderData`: a JS array whose entries
// are JSON *strings*, so the contents are double encoded. This is why a probe
// for `appid` followed by `:` finds nothing — it arrives as `appid\":`.
{
  const inner = JSON.stringify({
    strWebAPIToken: 'eyJhbGciOiJFZERTQSJ9.payload-part_x~y+z/w=',
    rgGames: [
      { appid: 570, name: 'Dota 2' },
      { appid: 39210, name: 'FINAL FANTASY XIV' },
      { appid: 1245620, name: 'ELDEN RING {Deluxe}' }, // braces inside a title
    ],
  });
  const page = `<!DOCTYPE html><html class="responsive DesktopUI"><body>
    <script nonce="abc">window.SSR={};window.SSR.loaderData = ${JSON.stringify([inner, '{"other":1}'])};
    window.SSR.somethingElse = [1,2,3];</script></body></html>`;

  const token = M.parseWebApiToken(page);
  check('extracts the escaped web API token',
    token === 'eyJhbGciOiJFZERTQSJ9.payload-part_x~y+z/w=', String(token));

  const rows = M.parseLoaderData(page);
  check('parses double-encoded loaderData', rows && rows.length === 3);
  check('survives braces inside a game title',
    rows && rows[2].name === 'ELDEN RING {Deluxe}');

  check('parseProfileGames prefers loaderData over the scavenger',
    (M.parseProfileGames(page) || []).length === 3);

  check('unescaped token form also works',
    M.parseWebApiToken('{"strWebAPIToken":"plain.token.value"}') === 'plain.token.value');
  check('missing token yields null', M.parseWebApiToken('<html></html>') === null);
}

// --- The largest games array wins --------------------------------------------
//
// Regression: a profile page carries several games arrays. "Recently played" is
// a handful of entries and sits earlier in the tree than the full library, so
// taking the FIRST match reported 5 games for a 3000-game account.
{
  const recent = [{ appid: 1, name: 'Recent A' }, { appid: 2, name: 'Recent B' }];
  const library = Array.from({ length: 3000 }, (_, i) => ({ appid: 100 + i, name: 'Game ' + i }));

  check('collects every games array present',
    M.collectGameArrays({ recentlyPlayed: recent, all: { games: library } }).length === 2);

  check('picks the largest, not the first',
    (M.largest(M.collectGameArrays({ recentlyPlayed: recent, all: { games: library } })) || []).length === 3000);

  // Same thing end to end, through the double-encoded SSR wrapper.
  const inner = JSON.stringify({ rgRecentGames: recent, rgGames: library });
  const page = `<script>window.SSR={};window.SSR.loaderData = ${JSON.stringify([inner])};</script>`;
  check('loaderData parsing picks the full library over recently-played',
    (M.parseLoaderData(page) || []).length === 3000);

  // And when the small list is in a different loaderData entry entirely.
  const split = `<script>window.SSR.loaderData = ${JSON.stringify([
    JSON.stringify({ rgRecentGames: recent }),
    JSON.stringify({ rgGames: library }),
  ])};</script>`;
  check('scans every loaderData entry, not just the first',
    (M.parseLoaderData(split) || []).length === 3000);
}

// --- Literal extraction is linear and string-aware ---------------------------
{
  check('stops at the matching bracket',
    M.extractLiteral('x = [1,[2],3]; more', 4) === '[1,[2],3]');
  check('brackets inside strings do not terminate the slice',
    M.extractLiteral('x = ["a]b", "c"]; more', 4) === '["a]b", "c"]');
  check('escaped quotes inside strings are respected',
    M.extractLiteral('x = ["a\\"]b", 1]; more', 4) === '["a\\"]b", 1]');
  check('unterminated literal yields null', M.extractLiteral('x = [1,2', 4) === null);
}

// --- Game-array discovery ----------------------------------------------------
{
  check('finds a nested games array',
    (M.largest(M.collectGameArrays({ a: { b: { c: [{ appid: 1, name: 'X' }] } } })) || []).length === 1);
  check('ignores arrays that are not games',
    M.largest(M.collectGameArrays({ a: [{ foo: 1 }], b: [1, 2, 3] })) === null);
  check('does not recurse forever on deep junk',
    M.largest(M.collectGameArrays(JSON.parse('{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":{"a":1}}}}}}}}}}'))) === null);
}

// --- Failure modes -----------------------------------------------------------
{
  check('unrecognised markup returns null, not an empty list',
    M.parseProfileGames('<html><body>Nothing here</body></html>') === null);
  check('malformed JSON returns null, not an empty list',
    M.parseProfileGames('<div id="gameslist_config" data-profile-gameslist="{not json}"></div>') === null);
}

// --- Identity ----------------------------------------------------------------
{
  const html = `<script>g_rgProfileData = {"steamid":"76561198000000001","personaname":"ibrahim"};</script>`;
  const id = M.parseProfileIdentity(html);
  check('reads steamid', id.steamId === '76561198000000001');
  check('reads persona name', id.persona === 'ibrahim');

  const blank = M.parseProfileIdentity('<html></html>');
  check('missing identity degrades to empty strings', blank.steamId === '' && blank.persona === '');
}

// --- Signed-in steam id ------------------------------------------------------
//
// Steam emits `g_steamID = false` when signed out, so this doubles as a
// definitive signed-in check. It must never mistake `false` for an id.
{
  check('reads the steamID64 when signed in',
    M.parseSteamId('<script>g_steamID = "76561198000000001";</script>') === '76561198000000001');
  check('handles an unquoted id',
    M.parseSteamId('<script>g_steamID = 76561198000000001;</script>') === '76561198000000001');
  check('signed out (g_steamID = false) yields null',
    M.parseSteamId('<script>g_steamID = false;</script>') === null);
  check('absent marker yields null', M.parseSteamId('<html></html>') === null);
  check('a short number is not mistaken for a steamid',
    M.parseSteamId('<script>g_steamID = 123;</script>') === null);

  check('builds a redirect-free profile games URL',
    M.profileGamesUrl('76561198000000001')
      === 'https://steamcommunity.com/profiles/76561198000000001/games?tab=all');
}

// --- Row normalisation -------------------------------------------------------
{
  const rows = M.normaliseRows([
    { appid: 1, name: '  Spaced Out  ' },
    { appid: 0, name: 'No appid' },
    { appid: 2, name: '' },
    { appid: '3', name: 'String appid' },
  ]);
  check('trims names', rows[0][1] === 'Spaced Out');
  check('drops rows without an appid or name', rows.length === 2);
  check('coerces string appids to numbers', rows[1][0] === 3);
}

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
