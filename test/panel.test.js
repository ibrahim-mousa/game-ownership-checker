/*
 * Panel tests — run with:  node test/panel.test.js
 *
 * These guard the interaction bugs that are invisible to a syntax check:
 * the panel closing itself, and the connection test reporting the wrong thing.
 */

'use strict';

const { loadUserscript } = require('./load');
const { installGlobals, dispatchClick, find, mkNode } = require('./dom-stub');

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const EXPORTS = ['state', 'els', 'mountUI', 'renderPanel', 'openPanel',
                 'runConnectionTest', 'interpretProbes', 'buildIndex', 'isProductCard',
                 'badgeHost', 'badgeCard', 'issueUrl', 'reportBody'];

// --- Clicking a panel button must not close the panel ------------------------
//
// renderPanel() rebuilds the panel with `textContent = ''`, which detaches the
// button that was just clicked. A bubble-phase `root.contains(event.target)`
// check then sees an orphaned node, reads it as an outside click, and closes
// the panel. The containment test has to happen during the capture phase.
{
  installGlobals();
  const M = loadUserscript(EXPORTS);
  M.mountUI();
  M.openPanel();

  const button = find(M.els.panel, n => n.tagName === 'button' && n._text === 'Run connection test');
  check('panel exposes a "Run connection test" button', Boolean(button));

  if (button) {
    dispatchClick(button);
    check('clicked button is detached by the re-render (the trap)', !M.els.root.contains(button));
    check('panel stays open after clicking a button that re-renders it',
      !M.els.panel.hidden, 'the panel closed itself');
  }
}

// --- Clicking outside still closes it ----------------------------------------
{
  installGlobals();
  const M = loadUserscript(EXPORTS);
  M.mountUI();
  M.openPanel();

  dispatchClick(global.document.body);
  check('clicking outside the panel closes it', M.els.panel.hidden);
}

// --- Non-product tiles must never be badged -----------------------------------
//
// Genre, publisher and promo tiles reuse the same card markup as games:
// "Puzzle", "Horror", "Ubisoft", "Deals Under $5" all arrive as titled cards.
// Badging one would be a false positive against any Steam game of that name.
{
  installGlobals();
  const M = loadUserscript(EXPORTS);

  const card = href => {
    const node = mkNode('li');
    const link = mkNode('a');
    link.setAttribute('href', href);
    node.querySelector = () => (href === null ? null : link);
    return node;
  };

  const TILES = [
    ['/store/wuchang-fallen-feathers',      true,  'product page'],
    ['/store/borderlands-4',                true,  'product page'],
    ['/store/search?genres=puzzle',         false, 'genre tile'],
    ['/store/search?publishers=team17',     false, 'publisher tile'],
    ['/store/search?sort=discount&price=5', false, 'a "Deals Under $5" tile'],
    ['/store/promo/summer-sale',            false, 'promo tile'],
    ['/store/browse/rpg',                   false, 'browse tile'],
    ['/subscription/gamingpass',            false, 'subscription tile'],
    [null,                                  true,  'no link at all is allowed through'],
  ];

  for (const [href, want, why] of TILES) {
    check(`tile ${want ? 'kept  ' : 'reject'} ${href}`, M.isProductCard(card(href)) === want, why);
  }
}

// --- Badges must never be parented to a void element --------------------------
//
// appendChild() on an <img> succeeds in the DOM API and renders nothing, so the
// badge is created and counted while being invisible. Image containers and
// images share naming conventions, which makes this trivial to hit:
// '.entity-image-container' is a div, '.entity-image' is often the <img>.
{
  installGlobals();
  const M = loadUserscript(EXPORTS);

  const buildCard = (matches) => {
    const card = mkNode('li');
    card.querySelector = sel => matches[sel] || null;
    return card;
  };
  const adapter = { anchor: ['.entity-image-container', '.entity-image', 'a.entity-link'] };
  // 'a.entity-link' is kept in this fixture on purpose: the guard must hold
  // even when an adapter lists a link selector.

  const img = mkNode('img');
  const div = mkNode('div');
  const link = mkNode('a');

  check('prefers a real container when present',
    M.badgeHost(buildCard({ '.entity-image-container': div, '.entity-image': img }), adapter) === div);

  const cardWithImgAndLink = buildCard({ '.entity-image': img, 'a.entity-link': link });
  check('skips an <img> host rather than rendering nothing',
    M.badgeHost(cardWithImgAndLink, adapter) !== img);

  // badgeCard() sets `position: relative` on its host. Doing that to a link
  // makes the link the containing block, and a right-anchored badge is then
  // measured against the link's box instead of the card's -- it lands outside
  // and gets clipped. Left-anchoring masked this by extending inwards.
  check('never positions the badge against a link',
    M.badgeHost(cardWithImgAndLink, adapter) === cardWithImgAndLink);

  check('a container still wins over a link',
    M.badgeHost(buildCard({ '.entity-image-container': div, 'a.entity-link': link }), adapter) === div);

  const cardOnly = buildCard({ '.entity-image': img });
  check('falls back to the card itself when only void hosts match',
    M.badgeHost(cardOnly, adapter) === cardOnly);

  check('falls back to the card when nothing matches',
    (() => { const c = buildCard({}); return M.badgeHost(c, adapter) === c; })());

  // End to end: the badge must land somewhere that can actually hold children.
  const card = buildCard({ '.entity-image': img });
  M.badgeCard(card, adapter, { tier: 'exact', how: 'test', name: 'X' });
  check('badge is appended to a non-void parent',
    card.children.length === 1 && img.children.length === 0);
}

// --- Bug reports are filled in for the user ----------------------------------
//
// A report that depends on someone hand-copying a table out of a panel is a
// report that never arrives. The link carries the diagnostics.
{
  installGlobals();
  const M = loadUserscript(EXPORTS);

  M.state.test = {
    probes: [
      { key: 'root', label: 'steamcommunity.com', ok: true, status: 200, note: 'signed in' },
      { key: 'feed', label: '  games page', ok: true, status: 200, note: 'markup not recognised',
        hints: { length: 15835025, title: 'Steam Community :: Games', markers: [], bigVars: ['g_rgProfileData'] } },
    ],
    byKey: {},
    verdict: { level: 'warn', report: true, text: 'markup is not one this parser knows' },
  };
  M.state.test.byKey.feed = M.state.test.probes[1];

  const url = M.issueUrl('Connection test failed', M.reportBody());
  check('issue link points at this repository',
    url.startsWith('https://github.com/ibrahim-mousa/game-ownership-checker/issues/new?'));

  const body = new URL(url).searchParams.get('body');
  check('report carries the script version', body.includes('3.1.0') || /Script version/.test(body));
  check('report carries the probe results', body.includes('steamcommunity.com: ok (200)'));
  check('report carries the page structure', body.includes('15835025'));

  // GitHub URLs are not unbounded, and the page-structure block can be huge.
  M.state.test.probes[1].hints.title = 'x'.repeat(20000);
  const capped = new URL(M.issueUrl('t', M.reportBody())).searchParams.get('body');
  check('an oversized report is capped rather than producing a broken URL',
    capped.length === 4000, `body was ${capped.length}`);
}

// --- Connection-test verdicts ------------------------------------------------
//
// The trap these guard against: Steam answers 200 with a login page when signed
// out, so status codes alone look healthy while nothing actually works.
{
  installGlobals();
  const M = loadUserscript(EXPORTS);
  const dead = { ok: false, status: 0 };
  const fine = { ok: true, status: 200 };
  const rootIn = { ok: true, status: 200, steamId: '76561198000000001' };
  const rootOut = { ok: true, status: 200, steamId: null };
  const feedOk = { ok: true, status: 200, gamesFound: 5, token: 'jwt.token' };
  const feedNoToken = { ok: true, status: 200, gamesFound: 5, token: null };
  const apiOk = { ok: true, status: 200, gamesFound: 3707 };
  const apiFailed = { ok: false, status: 0, gamesFound: null };
  const feedUnparsed = { ok: true, status: 200, gamesFound: null };
  const storeIn = { ok: true, status: 200, ownedCount: 1284 };
  const storeOut = { ok: true, status: 200, ownedCount: 0 };

  check('everything dead -> blames the userscript manager',
    /userscript manager|site-access/i.test(
      M.interpretProbes({ root: dead, deep: dead, redirect: dead, feed: dead, store: dead }).text));

  check('host dead but store fine -> blames the network',
    /DNS|ISP|VPN|firewall/i.test(
      M.interpretProbes({ root: dead, deep: dead, redirect: dead, feed: dead, store: fine }).text));

  check('root fine but deep path dead -> blames URL filtering',
    /filtering by URL|content blocker/i.test(
      M.interpretProbes({ root: fine, deep: dead, redirect: dead, feed: dead, store: fine }).text));

  // All 200s, zero owned games: healthy-looking and completely broken.
  check('all 200s but no g_steamID -> names the cookie problem, not the network',
    /SIGNED OUT|cookies/i.test(
      M.interpretProbes({ root: rootOut, deep: fine, redirect: fine, feed: fine, store: storeOut }).text));

  // Regression: a signed-out STORE must not override a signed-in COMMUNITY.
  // They use separate cookies, and only the community session matters.
  check('signed-in community outranks a signed-out store',
    !/SIGNED OUT/.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedOk, api: apiOk, store: storeOut }).text));

  check('signed-out store is reported as harmless, not fatal',
    M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedOk, api: apiOk, store: storeOut }).level === 'ok');

  check('markup failure is not blamed on the user',
    /Nothing is wrong with your setup/i.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedUnparsed, store: storeIn }).text));

  check('signed in but markup unrecognised -> calls it a parser fix',
    /markup|parser/i.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedUnparsed, store: storeIn }).text));

  check('signed in with the API answering -> ok',
    M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedOk, api: apiOk, xml: dead, store: storeIn }).level === 'ok');

  // The headline number must be the API's, not the page's. Page parsing finds
  // only the small "recently played" list, and reporting 5 for a 3707-game
  // library is exactly the confusion this guards against.
  check('ok verdict reports the API count, not the page count',
    /3707/.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedOk, api: apiOk, xml: dead, store: storeIn }).text)
    && !/\b5 games\b/.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedOk, api: apiOk, xml: dead, store: storeIn }).text));

  check('page parsing finding fewer than the API is called expected, not an error',
    /expected/i.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedOk, api: apiOk, xml: dead, store: storeIn }).text));

  check('token found but API failing -> points at the new @connect entry',
    /@connect|api\.steampowered/i.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedOk, api: apiFailed, xml: dead, store: storeIn }).text));

  check('no token -> warns that page parsing may be incomplete',
    /incomplete/i.test(
      M.interpretProbes({ root: rootIn, deep: fine, redirect: fine, feed: feedNoToken, xml: dead, store: storeIn }).text));
}

// --- The test runs to completion and renders its results ---------------------
(async () => {
  installGlobals();
  const M = loadUserscript(EXPORTS);
  M.mountUI();
  M.openPanel();

  const result = await M.runConnectionTest();
  check('connection test resolves with every probe',
    Boolean(result && result.probes && result.probes.length === 6));
  check('blocked probes are reported as status 0',
    result.probes.every(p => p.status === 0));
  check('results are rendered into the panel',
    /steamcommunity\.com/.test(M.els.panel.textContent));
  check('panel is still open after the test finishes', !M.els.panel.hidden);

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} passed`);
  if (failures.length) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
    process.exit(1);
  }
})();
