// ==UserScript==
// @name         Humble Bundle - Owned on Steam
// @namespace    https://github.com/ibrahim-mousa/game-ownership-checker
// @version      2.4.1
// @description  Badges games you already own on Steam while you browse Humble Bundle. No Steam API key required.
// @author       Ibrahim Mousa
// @license      MIT
// @homepageURL  https://github.com/ibrahim-mousa/game-ownership-checker
// @supportURL   https://github.com/ibrahim-mousa/game-ownership-checker/issues
// @downloadURL  https://raw.githubusercontent.com/ibrahim-mousa/game-ownership-checker/master/humble-steam-owned.user.js
// @updateURL    https://raw.githubusercontent.com/ibrahim-mousa/game-ownership-checker/master/humble-steam-owned.user.js
// @match        https://www.humblebundle.com/*
// @connect      steamcommunity.com
// @connect      store.steampowered.com
// @connect      api.steampowered.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_addStyle
// @grant        unsafeWindow
// @run-at       document-idle
// @noframes
// ==/UserScript==

/*
 * How this works
 * --------------
 * Your Steam library is read through your existing Steam browser session:
 *
 *   https://steamcommunity.com/my/games?tab=all&xml=1   -> appids + names
 *   https://store.steampowered.com/dynamicstore/userdata/ -> owned appid set
 *
 * GM_xmlhttpRequest sends your steamcommunity.com / steampowered.com cookies,
 * so this works on PRIVATE libraries and needs no API key and no profile URL.
 * The only requirement is being signed in to Steam in the same browser.
 *
 * Nothing is sent anywhere. The library is stored locally by your userscript
 * manager and only ever compared against titles on the page.
 */

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------

  const VERSION       = '2.4.1';
  const STORE_KEY     = 'hbso.library.v1';
  const LOG           = '[HB Steam]';
  const STALE_AFTER   = 24 * 60 * 60 * 1000; // background refresh after a day
  const SCAN_DEBOUNCE = 250;
  const REQ_TIMEOUT   = 30000;

  const URL_GAMES_HTML = 'https://steamcommunity.com/my/games?tab=all';
  const URL_GAMES_XML  = 'https://steamcommunity.com/my/games?tab=all&xml=1';
  const URL_COMMUNITY = 'https://steamcommunity.com/';
  const URL_DEEP_PATH = 'https://steamcommunity.com/login/home/';
  const URL_MY_REDIR  = 'https://steamcommunity.com/my/';
  const URL_USERDATA  = 'https://store.steampowered.com/dynamicstore/userdata/';
  const URL_OWNED_API = 'https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/';
  const URL_LOGIN     = 'https://store.steampowered.com/login/';

  const log  = (...a) => console.log(LOG, ...a);
  const warn = (...a) => console.warn(LOG, ...a);

  // ---------------------------------------------------------------------------
  // Alias map - curated exceptions
  // ---------------------------------------------------------------------------
  //
  // Only needed when Humble and Steam disagree in a way normalisation cannot
  // bridge (renames, regional titles, compilations). Keys are normalised Humble
  // titles. Values are either a Steam appid (number, most precise) or a
  // normalised Steam title (string).
  //
  //   'pac man championship edition 2': 6000,
  //   'grand theft auto v': 'grand theft auto v enhanced',
  //
  // Contributions welcome - please include a note on why the pair is needed.

  const ALIASES = Object.create(null);

  // ---------------------------------------------------------------------------
  // Userscript-manager shims (Violentmonkey / Tampermonkey / Greasemonkey)
  // ---------------------------------------------------------------------------

  const GMAPI = (typeof GM !== 'undefined') ? GM : null;

  async function storageGet(key) {
    try {
      if (typeof GM_getValue === 'function') return await GM_getValue(key, null);
      if (GMAPI && GMAPI.getValue) return await GMAPI.getValue(key, null);
    } catch (e) { warn('storage read failed, falling back to localStorage', e); }
    try { return localStorage.getItem(key); } catch { return null; }
  }

  async function storageSet(key, value) {
    try {
      if (typeof GM_setValue === 'function') return await GM_setValue(key, value);
      if (GMAPI && GMAPI.setValue) return await GMAPI.setValue(key, value);
    } catch (e) { warn('storage write failed, falling back to localStorage', e); }
    try { localStorage.setItem(key, value); } catch { /* out of quota */ }
  }

  async function storageDel(key) {
    try {
      if (typeof GM_deleteValue === 'function') return await GM_deleteValue(key);
      if (GMAPI && GMAPI.deleteValue) return await GMAPI.deleteValue(key);
    } catch (e) { warn('storage delete failed', e); }
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  function getXhr() {
    if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    if (GMAPI && GMAPI.xmlHttpRequest) return GMAPI.xmlHttpRequest.bind(GMAPI);
    return null;
  }

  function hostOf(url) {
    try { return new URL(url).host; } catch { return url; }
  }

  /**
   * Managers report cross-origin failures through `onerror` with almost no
   * context, so squeeze out whatever the response object carries. A blocked
   * @connect permission looks like status 0 with an empty readyState; a real
   * network failure usually carries an `error` string.
   */
  function describeFailure(kind, r, host) {
    const bits = [];
    if (r) {
      if (r.error)               bits.push('error=' + r.error);
      if (r.status)              bits.push('status=' + r.status + (r.statusText ? ' ' + r.statusText : ''));
      else if (r.status === 0)   bits.push('status=0 (request never left the browser)');
      if (r.readyState != null)  bits.push('readyState=' + r.readyState);
      if (r.finalUrl)            bits.push('finalUrl=' + r.finalUrl);
    }
    return `${kind} ${host}` + (bits.length ? ` - ${bits.join(', ')}` : '') +
           '. Run hbso.debugFetch() in the console for the full response.';
  }

  /**
   * Like request(), but never rejects: it always resolves to a plain report.
   * Used by the connection test, where a failure IS the result we want to see.
   */
  function probeRequest(url) {
    const host = hostOf(url);
    const xhr = getXhr();
    if (!xhr) {
      return Promise.resolve({ host, url, kind: 'no-api', ok: false, status: null,
        detail: 'GM_xmlhttpRequest is unavailable' });
    }
    return new Promise(resolve => {
      const report = kind => r => resolve({
        host, url, kind,
        ok: kind === 'onload' && r && r.status > 0,
        status: r ? r.status : null,
        statusText: r ? r.statusText : null,
        readyState: r ? r.readyState : null,
        finalUrl: r ? r.finalUrl : null,
        error: r ? r.error : null,
        body: (r && r.responseText) ? r.responseText.slice(0, 400) : null,
        raw: r,
      });
      xhr({
        method: 'GET', url, timeout: REQ_TIMEOUT, anonymous: false,
        onload: report('onload'), onerror: report('onerror'),
        ontimeout: report('ontimeout'), onabort: report('onabort'),
      });
    });
  }

  /**
   * Turns the probe reports into a plain-English verdict.
   *
   * The probes are chosen to change exactly one variable at a time:
   *
   *   root     https://steamcommunity.com/            host reachable?
   *   deep     .../login/home/                        deep path, no redirect
   *   redirect .../my/                                redirects, no query string
   *   feed     .../my/games?tab=all&xml=1             redirects AND has a query
   *   store    store.steampowered.com userdata        signed in?
   *
   * `status: 0` means the request never completed at the network layer. Any
   * real status means the network is fine and the problem sits above it.
   */
  function interpretProbes(p) {
    const dead = r => r && !r.ok && !r.status;
    const live = r => r && r.ok;

    if (dead(p.root) && dead(p.feed) && dead(p.store)) {
      return { level: 'bad', text:
        'Every host was blocked before leaving the browser \u2014 the userscript ' +
        'manager or the extension\u2019s site-access setting, not Steam.' };
    }
    if (dead(p.root) && live(p.store)) {
      return { level: 'bad', text:
        'steamcommunity.com is unreachable at the network layer while the store ' +
        'works. That points at DNS, an ISP, a VPN, or a firewall blocking the domain.' };
    }
    if (live(p.root) && dead(p.deep)) {
      return { level: 'bad', text:
        'The homepage loads but other paths on steamcommunity.com do not \u2014 ' +
        'something is filtering by URL. Check content blockers.' };
    }

    // Authoritative: g_steamID on a community page. If it is present, cookies
    // are reaching Steam and nothing below should claim otherwise.
    const communitySignedIn = live(p.root) && Boolean(p.root.steamId);

    if (live(p.root) && !communitySignedIn) {
      return { level: 'bad', text:
        'Steam is reachable but the requests are arriving SIGNED OUT \u2014 cookies are ' +
        'not being attached. Everything returning 200 is a login page or an empty ' +
        'payload. Check you are signed in at steamcommunity.com, and that the ' +
        'userscript manager may send cookies (on Firefox, Enhanced Tracking ' +
        'Protection can partition them away).' };
    }
    if (live(p.feed) && /login page/.test(p.feed.note || '')) {
      return { level: 'bad', text:
        'The games page redirected to sign-in even though the session looks valid. ' +
        'Please open an issue with this output.' };
    }
    if (live(p.feed) && p.feed.gamesFound === null) {
      return { level: 'warn', text:
        'Signed in, and your games page loaded \u2014 but its markup is not one this ' +
        'parser knows. This is a one-line fix: send the "page structure" details ' +
        'below. Nothing is wrong with your setup.' };
    }
    if (p.api && p.api.ok && p.api.gamesFound > 0) {
      return { level: 'ok', text:
        `Signed in. The web API returned ${p.api.gamesFound} games \u2014 that is the ` +
        'complete library and the number the badges use. (Page parsing finds fewer; ' +
        'the page ships several small lists, which is expected.)' };
    }
    if (p.feed && p.feed.token && p.api && !p.api.ok) {
      return { level: 'bad', text:
        'A token was found but the web API call failed. Check that ' +
        'api.steampowered.com is allowed \u2014 a clean reinstall registers the new ' +
        '@connect entry.' };
    }
    if (p.feed && p.feed.gamesFound && !p.feed.token) {
      return { level: 'warn', text:
        `No web API token on the page, so the library falls back to page parsing ` +
        `(${p.feed.gamesFound} games). That can be incomplete \u2014 please open an issue.` };
    }
    if (live(p.feed) && p.feed.gamesFound > 0) {
      const storeNote = (p.store && p.store.ownedCount === 0)
        ? ' You are not signed in at store.steampowered.com, so the appid supplement ' +
          'is unavailable \u2014 harmless, names still sync.'
        : '';
      return { level: 'ok', text:
        `Signed in and ${p.feed.gamesFound} games parsed.` + storeNote };
    }

    if (live(p.root) && dead(p.feed)) {
      return { level: 'bad', text:
        'The games page specifically is failing while the rest of steamcommunity.com ' +
        'works. Check content blockers, then please open an issue.' };
    }
    return { level: 'warn', text:
      'Mixed results \u2014 check the rows above. A non-zero status means the network is fine.' };
  }

  function request(url) {
    const xhr = getXhr();
    if (!xhr) {
      return Promise.reject(new Error(
        'GM_xmlhttpRequest is unavailable. Re-install the script so the manager grants it.'));
    }
    const host = hostOf(url);
    return new Promise((resolve, reject) => {
      xhr({
        method: 'GET',
        url,
        timeout: REQ_TIMEOUT,
        // Explicit: the whole design depends on the request carrying the user's
        // Steam session. Managers differ on the default.
        anonymous: false,
        headers: { Accept: 'text/xml,application/xml,application/json,text/html;q=0.9,*/*;q=0.8' },
        onload: r => resolve({ status: r.status, text: r.responseText || '', finalUrl: r.finalUrl || '' }),
        onerror: r => {
          warn('raw failure object for', host, r);
          reject(new Error(describeFailure('Could not reach', r, host)));
        },
        ontimeout: r => reject(new Error(describeFailure('Timed out reaching', r, host))),
        onabort:   r => reject(new Error(describeFailure('Request aborted for', r, host))),
      });
    });
  }

  function addStyle(css) {
    if (typeof GM_addStyle === 'function') { try { return GM_addStyle(css); } catch { /* fall through */ } }
    const el = document.createElement('style');
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
    return el;
  }

  // ---------------------------------------------------------------------------
  // Steam client
  // ---------------------------------------------------------------------------

  class NotSignedInError extends Error {
    constructor() { super('Not signed in to Steam in this browser.'); this.name = 'NotSignedInError'; }
  }

  function looksLikeLoginPage(res) {
    return /\/login\b/.test(res.finalUrl) || /steamcommunity\.com\/login/i.test(res.text.slice(0, 4000));
  }

  /** Decodes the HTML entities that wrap JSON inside an attribute. */
  function decodeEntities(str) {
    return str
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
      .replace(/&amp;/g, '&'); // last, so a literal &amp;quot; survives intact
  }

  /**
   * Pulls the games array out of the profile games page.
   *
   * Steam has shipped two layouts, so both are handled:
   *   modern  <div id="gameslist_config" data-profile-gameslist="{...}">
   *   legacy  var rgGames = [ ... ];
   */
  function parseProfileGames(html) {
    const attr = html.match(/id="gameslist_config"[^>]*?data-profile-gameslist="([^"]*)"/);
    if (attr) {
      try {
        const data = JSON.parse(decodeEntities(attr[1]));
        const rows = Array.isArray(data) ? data : data.rgGames;
        if (Array.isArray(rows)) return rows;
      } catch (e) {
        warn('could not parse data-profile-gameslist:', e.message);
      }
    }

    const inline = html.match(/var\s+rgGames\s*=\s*(\[[\s\S]*?\])\s*;/);
    if (inline) {
      try { return JSON.parse(inline[1]); }
      catch (e) { warn('could not parse rgGames:', e.message); }
    }

    const ssr = parseLoaderData(html);
    if (ssr) return ssr;

    return scavengeGames(html);
  }

  /**
   * When the games page does not parse, describe what it *does* contain so the
   * parser can be fixed without asking anyone to go spelunking in devtools.
   */
  function describeMarkup(html) {
    const uniq = arr => Array.from(new Set(arr));
    const grab = (re, group) => uniq(Array.from(html.matchAll(re)).map(m => m[group]));
    const tidy = str => str.replace(/\s+/g, ' ').trim();

    const title = html.match(/<title>([\s\S]{0,200}?)<\/title>/i);

    // Where does the weight actually sit? The biggest script blocks usually
    // hold the payload, whatever key names it uses.
    const scripts = Array.from(html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi))
      .map(m => ({ attrs: tidy(m[1]).slice(0, 70), len: m[2].length, head: tidy(m[2].slice(0, 140)) }))
      .sort((a, b) => b.len - a.len)
      .slice(0, 5);

    // Appids hide in CDN image paths even when no JSON key names them.
    const cdnIds = grab(/steam\/apps\/(\d+)/g, 1);
    const linkIds = grab(/\/app\/(\d+)/g, 1);

    const probes = [
      'app_id', 'appid', 'appId', '"id":', '"name":', 'capsule', 'header.jpg',
      'library_600x900', 'window.__', 'self.__', 'INITIAL_STATE', 'application/json',
      'g_rgProfileData', 'rgGames', 'IPlayerService', 'webapi_token', 'access_token',
    ];

    return {
      length: html.length,
      title: title ? tidy(title[1]) : '(no <title>)',
      opensWith: tidy(html.slice(0, 180)),
      scriptCount: (html.match(/<script/gi) || []).length,
      biggestScripts: scripts.map(x => `len=${x.len} <script ${x.attrs}> ${x.head}`),
      cdnAppIds: `${cdnIds.length} unique (e.g. ${cdnIds.slice(0, 6).join(', ') || 'none'})`,
      storeLinkIds: `${linkIds.length} unique (e.g. ${linkIds.slice(0, 6).join(', ') || 'none'})`,
      probesFound: probes.filter(x => html.includes(x)),
      gameIds: grab(/id="([^"]*game[^"]*)"/gi, 1).slice(0, 8),
      bigDataAttrs: grab(/\s(data-[a-z-]+)="[^"]{200,}"/gi, 1).slice(0, 8),
      bigVars: grab(/(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*[[{][^;]{200,}/g, 1).slice(0, 8),
    };
  }

  /**
   * The signed-in user's steamID64, read from any community page.
   * Steam emits `g_steamID = false` when signed out, which is a definitive
   * signal rather than the heuristics used elsewhere.
   */
  function parseSteamId(html) {
    const m = html.match(/g_steamID\s*=\s*"?(\d{17})"?/);
    return m ? m[1] : null;
  }

  function profileGamesUrl(steamId) {
    return `https://steamcommunity.com/profiles/${steamId}/games?tab=all`;
  }

  /**
   * The web API token Steam embeds in its React pages.
   *
   * The payload is JSON-encoded inside a JS string, so the quotes around the
   * key arrive escaped: {"strWebAPIToken\":\"eyJ...". Both forms are accepted.
   */
  function parseWebApiToken(html) {
    const m = html.match(/strWebAPIToken\\?"\s*:\s*\\?"([A-Za-z0-9._~+/-]+=*)/);
    return m ? m[1] : null;
  }

  /**
   * Slices out a complete JS array/object literal starting at `start`.
   *
   * A lazy regex would work but has to walk ~15MB one character at a time on
   * the games page. This is a single linear pass that respects string literals
   * and escapes, so braces inside game titles cannot end the slice early.
   */
  function extractLiteral(src, start) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < src.length; i++) {
      const c = src[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') {
        depth--;
        if (depth === 0) return src.slice(start, i + 1);
      }
    }
    return null;
  }

  /**
   * Collects every array that looks like a list of games.
   *
   * A profile page carries several: "recently played" is a handful of entries
   * and sits earlier in the tree than the full library, so taking the first
   * match yields five games instead of three thousand. Collect them all and let
   * the caller pick.
   */
  function collectGameArrays(node, depth, out) {
    depth = depth || 0;
    out = out || [];
    if (depth > 8 || !node || typeof node !== 'object') return out;

    if (Array.isArray(node)) {
      const first = node[0];
      if (first && typeof first === 'object' && 'appid' in first && 'name' in first) {
        out.push(node);
        return out; // no need to descend into the games themselves
      }
      for (const item of node) collectGameArrays(item, depth + 1, out);
      return out;
    }
    for (const key of Object.keys(node)) collectGameArrays(node[key], depth + 1, out);
    return out;
  }

  /** The biggest games array found anywhere in `node`, or null. */
  function findGameArray(node) {
    let best = null;
    for (const candidate of collectGameArrays(node)) {
      if (!best || candidate.length > best.length) best = candidate;
    }
    return best;
  }

  /**
   * Steam's React pages ship their state as `window.SSR.loaderData`: a JS array
   * whose entries are themselves JSON *strings*, so everything inside is double
   * encoded. Parse the outer array, then each entry, then hunt for the games.
   */
  function parseLoaderData(html) {
    const marker = html.indexOf('window.SSR.loaderData');
    if (marker === -1) return null;

    const start = html.indexOf('[', marker);
    if (start === -1) return null;

    const literal = extractLiteral(html, start);
    if (!literal) return null;

    let outer;
    try { outer = JSON.parse(literal); }
    catch (e) { warn('could not parse SSR.loaderData:', e.message); return null; }

    // Scan every entry, keeping the largest candidate rather than the first.
    let best = null;
    const sizes = [];
    for (const entry of Array.isArray(outer) ? outer : []) {
      let inner = entry;
      if (typeof entry === 'string') {
        try { inner = JSON.parse(entry); } catch { continue; }
      }
      for (const candidate of collectGameArrays(inner)) {
        sizes.push(candidate.length);
        if (!best || candidate.length > best.length) best = candidate;
      }
    }
    if (sizes.length > 1) log('games arrays found in SSR state:', sizes.join(', '), '-> using largest');
    return best;
  }

  /**
   * Last resort: scan the whole document for JSON objects that carry both an
   * appid and a name, regardless of the container they live in.
   *
   * Steam keeps moving this payload between inline vars, data- attributes and
   * JSON script tags. This does not care which -- it looks for the data itself.
   * Only reached when the specific strategies above have all failed.
   */
  function scavengeGames(html) {
    const found = [];
    const seen = new Set();
    const object = /\{[^{}]{0,800}?"appid"\s*:\s*"?(\d+)"?[^{}]{0,800}?\}/g;

    let match;
    while ((match = object.exec(html)) !== null) {
      const appid = Number(match[1]);
      if (!appid || seen.has(appid)) continue;

      const name = match[0].match(/"name"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (!name) continue;

      let decoded;
      try { decoded = JSON.parse('"' + name[1] + '"'); } catch { continue; }
      if (!decoded) continue;

      seen.add(appid);
      found.push({ appid, name: decoded });
    }
    return found.length ? found : null;
  }

  /** steamid + persona come from the same page, in g_rgProfileData. */
  function parseProfileIdentity(html) {
    const m = html.match(/g_rgProfileData\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) return { steamId: '', persona: '' };
    try {
      const d = JSON.parse(m[1]);
      return { steamId: d.steamid || '', persona: d.personaname || '' };
    } catch { return { steamId: '', persona: '' }; }
  }

  function normaliseRows(rows) {
    const games = [];
    for (const row of rows) {
      const appid = Number(row.appid);
      const name = String(row.name || '').trim();
      if (appid && name) games.push([appid, name]);
    }
    return games;
  }

  /**
   * Reads appids + names from the profile games page (needs a Steam session).
   *
   * Valve retired the `xml=1` feed. It redirects to the sign-in page
   * unconditionally, so for a signed-in user the login page bounces straight back
   * and the request becomes an infinite redirect loop. A userscript manager
   * follows redirects until it gives up, then reports `onerror` with status 0 --
   * indistinguishable from a blocked request. Retrying it as a fallback is
   * pointless: it cannot succeed. The HTML page is the only source.
   */
  /**
   * Asks Steam for the library directly, using the web API token its own pages
   * carry. This is the good path: a few KB of clean JSON with appids and names,
   * complete regardless of how the games page lazy-loads on scroll.
   */
  async function fetchOwnedViaApi(token, steamId) {
    const url = URL_OWNED_API +
      '?access_token=' + encodeURIComponent(token) +
      '&steamid=' + encodeURIComponent(steamId) +
      '&include_appinfo=1&include_played_free_games=1&format=json';

    const res = await request(url);
    if (res.status === 401 || res.status === 403) return null; // token expired

    let data;
    try { data = JSON.parse(res.text); }
    catch { return null; }

    const games = data && data.response && data.response.games;
    if (!Array.isArray(games) || !games.length) return null;
    return games;
  }

  /**
   * Builds the library.
   *
   * Order matters. The games page is ~16MB on a large account, so it is fetched
   * once and mined for two things: the web API token (preferred -- gives a
   * complete list in a small follow-up request) and, failing that, the embedded
   * SSR state.
   */
  async function fetchGamesFeed() {
    const steamIdFromRoot = await resolveSteamId();

    let res = await request(URL_GAMES_HTML);
    if (looksLikeLoginPage(res)) throw new NotSignedInError();

    const identity = parseProfileIdentity(res.text);
    const steamId = identity.steamId || steamIdFromRoot || '';

    // Preferred: the API, via the token the page hands us.
    const token = parseWebApiToken(res.text);
    if (token && steamId) {
      const viaApi = await fetchOwnedViaApi(token, steamId).catch(err => {
        warn('web API call failed, falling back to page parsing:', err.message);
        return null;
      });
      if (viaApi) {
        log(`library via web API: ${viaApi.length} games`);
        return { steamId, persona: identity.persona, games: normaliseRows(viaApi), source: 'api' };
      }
    }

    // Fallback: mine the page we already downloaded.
    let rows = parseProfileGames(res.text);

    if (!rows && steamId) {
      res = await request(profileGamesUrl(steamId));
      if (!looksLikeLoginPage(res)) rows = parseProfileGames(res.text);
    }

    if (!rows) {
      throw new Error(
        'Signed in, but the games list could not be read. Steam may have changed ' +
        'its markup \u2014 please open an issue with the page structure details.');
    }

    log(`library via page parsing: ${rows.length} games`);
    return { steamId, persona: identity.persona, games: normaliseRows(rows), source: 'page' };
  }

  /** Reads the signed-in steamID64 off the community home page. */
  async function resolveSteamId() {
    try {
      const res = await request(URL_COMMUNITY);
      return parseSteamId(res.text);
    } catch (e) {
      warn('could not resolve steam id:', e.message);
      return null;
    }
  }

  /**
   * Owned appids straight from the store session. Cheap, name-free, and it
   * catches things the community feed can omit. Best effort: never fatal.
   */
  async function fetchOwnedAppIds() {
    try {
      const res = await request(URL_USERDATA);
      const data = JSON.parse(res.text);
      return Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps : [];
    } catch (e) {
      warn('store userdata unavailable (non-fatal):', e.message);
      return [];
    }
  }

  async function syncLibrary() {
    const feed  = await fetchGamesFeed();
    const owned = await fetchOwnedAppIds();
    const record = {
      v: 1,
      steamId: feed.steamId,
      persona: feed.persona,
      games: feed.games,
      ownedAppIds: owned,
      syncedAt: Date.now(),
    };
    await storageSet(STORE_KEY, JSON.stringify(record));
    log(`synced ${record.games.length} games (+${owned.length} owned appids) for ${record.persona || record.steamId}`);
    return record;
  }

  async function loadRecord() {
    const raw = await storageGet(STORE_KEY);
    if (!raw) return null;
    try {
      const rec = JSON.parse(raw);
      if (!rec || !Array.isArray(rec.games)) return null;
      return rec;
    } catch { return null; }
  }

  // ---------------------------------------------------------------------------
  // Title normalisation
  // ---------------------------------------------------------------------------

  // Multi-character romans only. Single letters (I, V, X) are left alone so
  // "Mega Man X" never collides with "Mega Man 10".
  const ROMAN = {
    ii: 2, iii: 3, iv: 4, vi: 6, vii: 7, viii: 8, ix: 9, xi: 11, xii: 12,
    xiii: 13, xiv: 14, xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20,
  };

  const EDITION_TAIL = new RegExp(
    '\\s+(?:the\\s+)?(?:' +
    'goty|game of the year|digital deluxe|deluxe|definitive|enhanced|complete|ultimate|' +
    'standard|premium|collectors|collector|anniversary|remastered|remaster|redux|' +
    'directors cut|extended|special|gold|platinum|legendary|day one|classic' +
    ')(?:\\s+(?:edition|cut|version|pack|bundle))?$'
  );

  // Subtitles that mean "separate product", not "same game with a tagline".
  const CONTENT_SUBTITLE = /\b(episode|episodes|chapter|part|expansion|dlc|season pass|add on|addon|prologue|soundtrack|ost|artbook|art book|bonus)\b/;

  // Products that are never the base game.
  const NON_GAME = /\b(soundtrack|ost|artbook|art book|season pass|expansion pass|wallpapers?|comic|digital book|strategy guide|manual)\b/;

  /** Lowercase + de-accent + tidy symbols, but keeps ':' and '-' for subtitle splitting. */
  function preClean(str) {
    return String(str)
      // Must run before NFKD: it decomposes ™ into the letters "TM" and ℠ into "SM",
      // which would otherwise weld themselves onto the previous word.
      .replace(/[™®©℠]/g, ' ')  // (tm) (r) (c) (sm)
      .replace(/[\u2018\u2019\u02bc\u00b4]/g, "'") // curly apostrophes
      .replace(/[\u201c\u201d]/g, '"')            // curly quotes
      .replace(/[\u2010-\u2015]/g, '-')            // hyphen / en dash / em dash
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')            // combining marks (accents)
      .toLowerCase();
  }

  /** Strips everything that is not a letter or digit. */
  function tighten(str) {
    return str
      .replace(/&/g, ' and ')
      .replace(/'/g, '')          // "meier's" -> "meiers", so a dropped apostrophe still matches
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function normalize(str) {
    return tighten(preClean(str));
  }

  function stripEditions(norm) {
    let out = norm;
    for (let i = 0; i < 3; i++) {
      const next = out.replace(EDITION_TAIL, '');
      if (next === out) break;
      out = next.trim();
    }
    return out;
  }

  function romanize(norm) {
    return norm.replace(/\b([ivx]{2,})\b/g, (m) => (ROMAN[m] != null ? String(ROMAN[m]) : m));
  }

  /** Every normalised spelling of a title that we consider equivalent. */
  function fullKeys(title) {
    const base = normalize(title);
    if (!base) return [];
    const keys = new Set([base, stripEditions(base)]);
    for (const k of Array.from(keys)) keys.add(romanize(k));
    keys.delete('');
    return Array.from(keys);
  }

  /**
   * The title with its subtitle removed - "The Witcher 3: Wild Hunt" -> "the witcher 3".
   *
   * Only returned when it is safe to compare against a *full* title:
   *  - the base must contain a number, so franchise names ("batman", "fallout")
   *    can never swallow a different entry in the series;
   *  - the discarded subtitle must not name separate content ("Episode One").
   * Returns null otherwise.
   */
  function baseKey(title) {
    const pre = preClean(title);
    const parts = pre.split(/\s*:\s*|\s+-\s+/);
    if (parts.length < 2) return null;

    const head = romanize(stripEditions(tighten(parts[0])));
    const tail = tighten(parts.slice(1).join(' '));
    if (!head || head.length < 3) return null;
    if (!/\d/.test(head)) return null;
    if (CONTENT_SUBTITLE.test(tail)) return null;
    return head;
  }

  // ---------------------------------------------------------------------------
  // Matching
  // ---------------------------------------------------------------------------

  function buildIndex(record) {
    const appIds = new Set((record.ownedAppIds || []).map(Number));
    const full = new Map(); // normalised full title -> steam name
    const base = new Map(); // normalised base title -> steam name

    for (const [appid, name] of record.games) {
      appIds.add(Number(appid));
      for (const k of fullKeys(name)) if (!full.has(k)) full.set(k, name);
      const b = baseKey(name);
      if (b && !base.has(b)) base.set(b, name);
    }
    return { appIds, full, base, size: record.games.length };
  }

  /**
   * Tiers, most trustworthy first:
   *   1. appid            -> certain
   *   2. exact normalised -> certain enough
   *   3. alias            -> curated
   *   4. subtitle/edition -> likely  (full<->base only, never base<->base)
   */
  function matchProduct(index, title, appid) {
    if (appid && index.appIds.has(Number(appid))) {
      return { tier: 'appid', how: 'Steam appid ' + appid, name: null };
    }
    if (!title) return null;
    if (NON_GAME.test(normalize(title))) return null;

    const keys = fullKeys(title);

    for (const k of keys) {
      if (index.full.has(k)) return { tier: 'exact', how: 'exact title match', name: index.full.get(k) };
    }

    const alias = ALIASES[normalize(title)];
    if (alias != null) {
      if (typeof alias === 'number' && index.appIds.has(alias)) {
        return { tier: 'alias', how: 'alias -> appid ' + alias, name: null };
      }
      if (typeof alias === 'string' && index.full.has(alias)) {
        return { tier: 'alias', how: 'alias -> ' + alias, name: index.full.get(alias) };
      }
    }

    // Humble has the subtitle, Steam does not (or vice versa).
    for (const k of keys) {
      if (index.base.has(k)) return { tier: 'likely', how: 'matched Steam base title', name: index.base.get(k) };
    }
    const b = baseKey(title);
    if (b && index.full.has(b)) {
      return { tier: 'likely', how: 'matched without subtitle', name: index.full.get(b) };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Humble page adapters
  // ---------------------------------------------------------------------------
  //
  // Humble rewrites its markup regularly, so every hook is a list of candidates
  // tried in order. Run `hbso.diagnose()` in the console to see what is matching
  // on the current page.

  const ADAPTERS = [
    {
      name: 'store-grid',           // store front, search results, wishlist, carousels
      cards:  ['li.entity-block-container', '.entity-block-container'],
      titles: ['span.entity-title', '.entity-title'],
      anchor: ['.entity-image-container', '.entity-image', 'a.entity-link'],
    },
    {
      name: 'bundle-tier',          // /games/<bundle>, /books/<bundle>, /software/<bundle>
      cards:  ['.tier-item-view', '.dd-item-details', '.js-tier-item', '.tier-item'],
      titles: ['.item-title', '.dd-image-box-caption', '.tier-item-details .item-title', 'h3'],
      anchor: ['.dd-image-box-figure', '.item-image', '.tier-item-image'],
    },
    {
      name: 'product-row',          // list-style rows used on some bundle layouts
      cards:  ['.deliverance-item', '.selector-content'],
      titles: ['.item-title', 'h3'],
      anchor: [],
    },
  ];

  function pick(root, selectors) {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function extractAppId(el) {
    const read = (node) => {
      if (!node || !node.getAttribute) return null;
      const v = node.getAttribute('data-steam-appid') || node.getAttribute('data-appid');
      return v && /^\d+$/.test(v) ? Number(v) : null;
    };
    const own = read(el);
    if (own) return own;

    const nested = el.querySelector?.('[data-steam-appid],[data-appid]');
    if (nested) {
      const v = read(nested);
      if (v) return v;
    }
    const link = el.querySelector?.('a[href*="steampowered.com/app/"]');
    if (link) {
      const m = link.getAttribute('href').match(/\/app\/(\d+)/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Badge rendering
  // ---------------------------------------------------------------------------

  const STEAM_MARK = 'M11.98 0C5.67 0 .5 4.87 0 11.05l6.44 2.66a3.4 3.4 0 0 1 1.9-.59l2.87-4.15v-.06a4.55 4.55 0 1 1 4.55 4.55h-.11l-4.09 2.92c0 .05.01.1.01.15a3.42 3.42 0 0 1-6.78.66L.06 15.3A12 12 0 1 0 11.98 0zm-4.4 18.2l-1.48-.61a2.57 2.57 0 0 0 4.74-1.4 2.56 2.56 0 0 0-3.53-2.38l1.53.63a1.89 1.89 0 1 1-1.45 3.49l.19.08zm11.3-9.23a3.03 3.03 0 1 0-6.06 0 3.03 3.03 0 0 0 6.06 0zm-5.3 0a2.28 2.28 0 1 1 4.55 0 2.28 2.28 0 0 1-4.56 0z';

  function steamIcon(cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    if (cls) svg.setAttribute('class', cls);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', STEAM_MARK);
    path.setAttribute('fill', 'currentColor');
    svg.appendChild(path);
    return svg;
  }

  function makeBadge(match, variant) {
    const badge = document.createElement('div');
    badge.className = 'hbso-badge' + (variant ? ' hbso-badge--' + variant : '');
    badge.appendChild(steamIcon('hbso-badge__icon'));
    const label = document.createElement('span');
    label.textContent = 'Owned on Steam';
    badge.appendChild(label);
    badge.title = match.name
      ? `Owned on Steam as “${match.name}” (${match.how})`
      : `Owned on Steam (${match.how})`;
    return badge;
  }

  function badgeCard(card, adapter, match) {
    const host = pick(card, adapter.anchor) || card;
    const cs = getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';
    host.appendChild(makeBadge(match, match.tier === 'likely' ? 'likely' : null));
    card.classList.add('hbso-owned');
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  const state = {
    record: null, index: null, syncing: false, error: null,
    testing: false, test: null,
    stats: { seen: 0, owned: 0 },
  };

  function scan() {
    if (!state.index) return;
    let seen = 0, owned = 0;

    for (const adapter of ADAPTERS) {
      for (const cardSel of adapter.cards) {
        document.querySelectorAll(cardSel).forEach(card => {
          // Humble re-renders cards in place, which can wipe a badge without
          // replacing the card element. Re-do the ones that lost theirs.
          const done = card.dataset.hbso === '1';
          const lostBadge = card.dataset.hbsoOwned === '1' && !card.querySelector('.hbso-badge');
          if (done && !lostBadge) return;

          const titleEl = pick(card, adapter.titles);
          const title = titleEl && titleEl.textContent.trim();
          if (!title) return;

          card.dataset.hbso = '1';
          if (!done) seen++;

          const match = matchProduct(state.index, title, extractAppId(card));
          if (match) {
            badgeCard(card, adapter, match);
            card.dataset.hbsoOwned = '1';
            if (!done) owned++;
          }
        });
      }
    }

    scanProductPage();

    if (seen) {
      state.stats.seen += seen;
      state.stats.owned += owned;
      log(`scanned ${seen} new item(s), ${owned} owned`);
      renderPanel();
    }
  }

  /** Single-product store pages get one badge next to the title. */
  function scanProductPage() {
    if (!/^\/store\/[^/]+\/?$/.test(location.pathname)) return;
    if (/^\/store\/(search|subscription)/.test(location.pathname)) return;

    const heading = document.querySelector('.product-detail-view h1, .human-name, h1.heading-medium, h1');
    if (!heading || heading.dataset.hbso) return;

    const title = heading.textContent.trim();
    if (!title) return;
    heading.dataset.hbso = '1';

    const match = matchProduct(state.index, title, extractAppId(document.body));
    if (!match) return;

    const badge = makeBadge(match, 'inline');
    heading.insertAdjacentElement('afterend', badge);
  }

  function rescanAll() {
    document.querySelectorAll('[data-hbso]').forEach(el => {
      delete el.dataset.hbso;
      delete el.dataset.hbsoOwned;
    });
    document.querySelectorAll('.hbso-badge').forEach(el => el.remove());
    document.querySelectorAll('.hbso-owned').forEach(el => el.classList.remove('hbso-owned'));
    state.stats = { seen: 0, owned: 0 };
    scan();
  }

  let scanTimer = null;
  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, SCAN_DEBOUNCE);
  }

  function startObserver() {
    new MutationObserver(scheduleScan).observe(document.body, { childList: true, subtree: true });

    // Humble is a SPA. On navigation, clear everything and start over - React
    // reuses nodes, so a stale badge can otherwise outlive the product it named.
    let lastPath = location.pathname;
    setInterval(() => {
      if (location.pathname === lastPath) return;
      lastPath = location.pathname;
      rescanAll();
    }, 700);
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------

  const els = {};

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null) el.setAttribute(k, v);
    }
    for (const c of children) if (c) el.appendChild(c);
    return el;
  }

  function formatCount(n) { return Number(n).toLocaleString(); }

  function formatAgo(ts) {
    if (!ts) return 'never';
    const secs = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (secs < 60)    return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60)    return mins + (mins === 1 ? ' minute ago' : ' minutes ago');
    const hours = Math.floor(mins / 60);
    if (hours < 24)   return hours + (hours === 1 ? ' hour ago' : ' hours ago');
    const days = Math.floor(hours / 24);
    return days + (days === 1 ? ' day ago' : ' days ago');
  }

  function mountUI() {
    els.launcher = h('button', {
      class: 'hbso-launcher',
      type: 'button',
      title: 'Steam ownership',
      onclick: togglePanel,
    });
    els.launcher.appendChild(steamIcon('hbso-launcher__icon'));
    els.launcherLabel = h('span', { class: 'hbso-launcher__label' });
    els.launcher.appendChild(els.launcherLabel);

    els.panel = h('div', { class: 'hbso-panel', hidden: '' });
    els.root = h('div', { class: 'hbso-root' }, els.panel, els.launcher);
    document.body.appendChild(els.root);

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !els.panel.hidden) closePanel();
    });

    // Prevent panel from closing when clicking a button inside
    let clickedInside = false;
    document.addEventListener('click', e => {
      clickedInside = els.root.contains(e.target);
    }, true);
    document.addEventListener('click', () => {
      if (!els.panel.hidden && !clickedInside) closePanel();
    });

    renderPanel();
  }

  function togglePanel() { els.panel.hidden ? openPanel() : closePanel(); }
  function openPanel()  { els.panel.hidden = false; renderPanel(); }
  function closePanel() { els.panel.hidden = true; }

  function renderPanel() {
    if (!els.panel) return;
    const rec = state.record;

    els.launcher.classList.toggle('hbso-launcher--connected', !!rec);
    els.launcherLabel.textContent =
      state.syncing            ? 'Syncing…' :
      !rec                     ? 'Connect Steam' :
      state.stats.owned > 0    ? `${formatCount(state.stats.owned)} owned here` :
                                 'Steam library';

    els.panel.textContent = '';
    els.panel.appendChild(rec ? connectedView(rec) : connectView());
  }

  function connectView() {
    const body = h('div', { class: 'hbso-panel__body' });

    body.appendChild(h('h2', { class: 'hbso-title', text: 'Connect your Steam library' }));
    body.appendChild(h('p', { class: 'hbso-copy', text:
      'Sign in to Steam in this browser, then connect. Your library is read from ' +
      'your own Steam session - no API key, no profile URL, and private libraries work too.' }));

    if (state.error) {
      body.appendChild(h('div', { class: 'hbso-alert' },
        h('strong', { text: state.error.title }),
        h('span', { text: state.error.detail })));
    }

    const connect = h('button', {
      class: 'hbso-btn hbso-btn--primary', type: 'button',
      text: state.syncing ? 'Connecting…' : 'Connect Steam',
      onclick: () => refresh({ interactive: true }),
    });
    if (state.syncing) connect.disabled = true;

    body.appendChild(h('div', { class: 'hbso-actions' }, connect));
    body.appendChild(h('a', {
      class: 'hbso-link', href: URL_LOGIN, target: '_blank', rel: 'noopener',
      text: 'Not signed in? Open Steam →',
    }));
    body.appendChild(h('p', { class: 'hbso-fineprint', text:
      'Your library never leaves this browser.' }));
    body.appendChild(diagnosticsSection());
    return body;
  }

  function connectedView(rec) {
    const body = h('div', { class: 'hbso-panel__body' });

    body.appendChild(h('div', { class: 'hbso-status' },
      h('span', { class: 'hbso-check', text: '✓' }),
      h('span', { text: 'Steam connected' })));

    if (rec.persona) {
      body.appendChild(h('p', { class: 'hbso-persona', text: rec.persona }));
    }
    body.appendChild(h('p', { class: 'hbso-count', text: `${formatCount(rec.games.length)} games found` }));
    body.appendChild(h('p', { class: 'hbso-sub', text: `Last synced: ${formatAgo(rec.syncedAt)}` }));
    body.appendChild(h('p', { class: 'hbso-sub', text:
      `${formatCount(state.stats.owned)} of ${formatCount(state.stats.seen)} items on this page` }));

    if (state.error) {
      body.appendChild(h('div', { class: 'hbso-alert' },
        h('strong', { text: state.error.title }),
        h('span', { text: state.error.detail })));
    }

    const refreshBtn = h('button', {
      class: 'hbso-btn', type: 'button',
      text: state.syncing ? 'Refreshing…' : 'Refresh library',
      onclick: () => refresh({ interactive: true }),
    });
    if (state.syncing) refreshBtn.disabled = true;

    const disconnect = h('button', {
      class: 'hbso-btn hbso-btn--ghost', type: 'button', text: 'Disconnect',
      onclick: disconnectLibrary,
    });

    body.appendChild(h('div', { class: 'hbso-actions' }, refreshBtn, disconnect));
    body.appendChild(h('p', { class: 'hbso-fineprint', text:
      'To use a different account, switch accounts on Steam, then refresh.' }));
    body.appendChild(diagnosticsSection());
    return body;
  }

  /** "Run connection test" button plus its results. Shown in both panel states. */
  function diagnosticsSection() {
    const wrap = h('div', { class: 'hbso-diag' });

    const btn = h('button', {
      class: 'hbso-linkbtn', type: 'button',
      text: state.testing ? 'Testing…' : 'Run connection test',
      onclick: runConnectionTest,
    });
    if (state.testing) btn.disabled = true;
    wrap.appendChild(btn);

    if (!state.test) return wrap;

    const { probes, verdict } = state.test;
    const rows = h('div', { class: 'hbso-diag__rows' });
    for (const r of probes) {
      const status = r.ok
        ? `ok (${r.status})`
            + (r.ownedCount != null ? ` \u00b7 ${r.ownedCount} owned` : '')
            + (r.note ? ` \u00b7 ${r.note}` : '')
        : r.status ? `${r.kind} (${r.status})`
                   : `blocked (${r.kind}, status 0)`;
      rows.appendChild(h('div', { class: 'hbso-diag__row' },
        h('span', { class: 'hbso-diag__host', text: r.label || r.host }),
        h('span', { class: 'hbso-diag__state' +
          (r.ok ? ' is-ok' : r.informational ? ' is-muted' : ' is-bad'), text: status })));
    }
    wrap.appendChild(rows);
    wrap.appendChild(h('p', { class: 'hbso-diag__verdict hbso-diag__verdict--' + verdict.level, text: verdict.text }));

    // When the games page did not parse, show what it actually contains so the
    // details can be copied straight into an issue.
    const hints = state.test.byKey && state.test.byKey.feed && state.test.byKey.feed.hints;
    if (hints) {
      const lines = [
        `length: ${hints.length}`,
        `title: ${hints.title}`,
        `opens with: ${hints.opensWith}`,
        `scripts: ${hints.scriptCount}`,
        `cdn appids: ${hints.cdnAppIds}`,
        `store link appids: ${hints.storeLinkIds}`,
        `probes found: ${hints.probesFound.join(', ') || 'none'}`,
        `game ids: ${hints.gameIds.join(', ') || 'none'}`,
        `big data attrs: ${hints.bigDataAttrs.join(', ') || 'none'}`,
        `big vars: ${hints.bigVars.join(', ') || 'none'}`,
        'biggest scripts:',
        ...hints.biggestScripts.map(x => '  ' + x),
      ];
      wrap.appendChild(h('p', { class: 'hbso-diag__label', text: 'Page structure' }));
      wrap.appendChild(h('pre', { class: 'hbso-diag__pre', text: lines.join('\n') }));
    }

    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------

  async function refresh({ interactive = false, silent = false } = {}) {
    if (state.syncing) return;
    state.syncing = true;
    state.error = null;
    if (interactive) openPanel(); else renderPanel();

    try {
      const rec = await syncLibrary();
      state.record = rec;
      state.index = buildIndex(rec);
      rescanAll();
    } catch (err) {
      if (err instanceof NotSignedInError) {
        state.error = {
          title: 'You are not signed in to Steam. ',
          detail: 'Open Steam in another tab, sign in, then try again.',
        };
      } else {
        state.error = { title: 'Could not reach Steam. ', detail: err.message };
      }
      if (!silent) warn('sync failed:', err);
    } finally {
      state.syncing = false;
      renderPanel();
      if (state.error && interactive) openPanel();
    }
  }

  const PROBES = [
    { key: 'root',     label: 'steamcommunity.com',     url: URL_COMMUNITY },
    { key: 'deep',     label: '  \u21b3 deep path',         url: URL_DEEP_PATH },
    { key: 'redirect', label: '  \u21b3 redirect (/my/)',   url: URL_MY_REDIR },
    { key: 'feed',     label: '  \u21b3 games page',        url: URL_GAMES_HTML },
    { key: 'xml',      label: '  \u21b3 xml feed (retired)', url: URL_GAMES_XML, informational: true },
    { key: 'store',    label: 'store.steampowered.com', url: URL_USERDATA },
  ];

  async function runConnectionTest() {
    if (state.testing) return;
    state.testing = true;
    state.test = null;
    renderPanel();

    const probes = [];
    const byKey = {};
    let apiRow = null;
    for (const spec of PROBES) {
      const report = Object.assign(await probeRequest(spec.url),
        { key: spec.key, label: spec.label, informational: spec.informational || false });

      // A 200 proves nothing on its own. Signed out, Steam answers 200 with a
      // login page or an empty payload, so every probe checks the body.
      const bodyText = (report.raw && report.raw.responseText) || '';

      if (spec.key === 'root' && report.ok) {
        report.steamId = parseSteamId(bodyText);
        report.note = report.steamId ? 'signed in' : 'SIGNED OUT (no cookies)';
      }

      if (spec.key === 'feed' && report.ok) {
        if (looksLikeLoginPage({ finalUrl: report.finalUrl || '', text: bodyText })) {
          report.note = 'login page, not your library';
        } else {
          const rows = parseProfileGames(bodyText);
          report.gamesFound = rows ? rows.length : null;
          report.token = parseWebApiToken(bodyText);
          report.note = (rows ? `${rows.length} parsed from page` : 'markup not recognised')
            + (report.token ? ', token found' : ', NO token');
          if (!rows) report.hints = describeMarkup(bodyText);

          // The real path Connect uses. Reported separately so page parsing
          // falling short (it carries several small lists) is not mistaken for
          // the library actually being incomplete.
          const steamId = (byKey.root && byKey.root.steamId)
            || parseProfileIdentity(bodyText).steamId;
          if (report.token && steamId) {
            const viaApi = await fetchOwnedViaApi(report.token, steamId).catch(() => null);
            apiRow = {
              key: 'api', label: '  \u21b3 web API (used)', ok: Boolean(viaApi),
              status: viaApi ? 200 : 0, informational: false,
              note: viaApi ? `${viaApi.length} games` : 'call failed',
              gamesFound: viaApi ? viaApi.length : null,
            };
          }
        }
      }

      if (spec.key === 'store' && report.ok) {
        try {
          const data = JSON.parse(bodyText);
          report.ownedCount = Array.isArray(data.rgOwnedApps) ? data.rgOwnedApps.length : 0;
        } catch { report.ownedCount = null; }
      }

      probes.push(report);
      byKey[spec.key] = report;
    }

    if (apiRow) {
      const at = probes.findIndex(r => r.key === 'xml');
      probes.splice(at === -1 ? probes.length : at, 0, apiRow);
      byKey.api = apiRow;
    }

    const verdict = interpretProbes(byKey);
    state.test = { probes, byKey, verdict };
    state.testing = false;
    renderPanel();

    console.log(LOG, 'connection test:', verdict.text);
    for (const r of probes) console.log(LOG, r.url, '->', r);
    return state.test;
  }

  async function disconnectLibrary() {
    await storageDel(STORE_KEY);
    state.record = null;
    state.index = null;
    state.error = null;
    state.stats = { seen: 0, owned: 0 };
    document.querySelectorAll('.hbso-badge').forEach(el => el.remove());
    document.querySelectorAll('[data-hbso]').forEach(el => {
      delete el.dataset.hbso;
      delete el.dataset.hbsoOwned;
    });
    document.querySelectorAll('.hbso-owned').forEach(el => el.classList.remove('hbso-owned'));
    renderPanel();
  }

  // ---------------------------------------------------------------------------
  // Console helpers - `hbso.diagnose()` etc.
  // ---------------------------------------------------------------------------

  const api = {
    version: VERSION,
    get record() { return state.record; },
    sync: () => refresh({ interactive: false }),
    rescan: rescanAll,
    reset: disconnectLibrary,
    normalize,
    match: (title, appid) => state.index ? matchProduct(state.index, title, appid) : null,
    /** Raw request probe; logs everything the manager returns. */
    async debugFetch(url = URL_GAMES_XML) {
      const r = await probeRequest(url);
      console.log(LOG, r.kind, r);
      return r;
    },

    /** Tests both Steam hosts and prints a verdict. */
    debugAll: () => runConnectionTest(),

    diagnose() {
      const rows = [];
      for (const adapter of ADAPTERS) {
        for (const sel of adapter.cards) {
          const nodes = document.querySelectorAll(sel);
          if (!nodes.length) { rows.push({ adapter: adapter.name, selector: sel, cards: 0, titled: 0, sample: '' }); continue; }
          let titled = 0, sample = '';
          nodes.forEach(n => {
            const t = pick(n, adapter.titles);
            if (t && t.textContent.trim()) { titled++; if (!sample) sample = t.textContent.trim(); }
          });
          rows.push({ adapter: adapter.name, selector: sel, cards: nodes.length, titled, sample });
        }
      }
      console.table(rows);
      console.log(LOG, 'library:', state.record ? state.record.games.length + ' games' : 'not connected',
        '| badged on this page:', state.stats.owned, '/', state.stats.seen);
      return rows;
    },
    unmatched() {
      if (!state.index) return [];
      const out = [];
      for (const adapter of ADAPTERS) {
        for (const sel of adapter.cards) {
          document.querySelectorAll(sel).forEach(card => {
            const t = pick(card, adapter.titles);
            const title = t && t.textContent.trim();
            if (title && !matchProduct(state.index, title, extractAppId(card))) {
              out.push({ title, normalized: normalize(title), base: baseKey(title) });
            }
          });
        }
      }
      console.table(out);
      return out;
    },
  };

  // ---------------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------------

  const CSS = `
.hbso-badge{
  position:absolute; top:8px; left:8px; z-index:30;
  display:inline-flex; align-items:center; gap:5px;
  padding:3px 7px; border-radius:3px;
  background:rgba(23,40,56,.94);
  color:#66c0f4;
  border:1px solid rgba(102,192,244,.5);
  font:700 9.5px/1.25 "Nunito Sans","Brandon Text",system-ui,-apple-system,sans-serif;
  letter-spacing:.075em; text-transform:uppercase; white-space:nowrap;
  box-shadow:0 1px 6px rgba(0,0,0,.45);
  pointer-events:auto;
}
.hbso-badge__icon{width:11px;height:11px;flex:0 0 auto;opacity:.95}
.hbso-badge--likely{color:#a7cfe4;border-color:rgba(167,207,228,.4);border-style:dashed}
.hbso-badge--inline{position:static;margin:10px 0 0;display:inline-flex}

.hbso-root{position:fixed;right:18px;bottom:18px;z-index:2147483000;
  font-family:"Nunito Sans","Brandon Text",system-ui,-apple-system,sans-serif}

.hbso-launcher{
  display:flex;align-items:center;gap:7px;margin-left:auto;
  padding:8px 13px;border-radius:999px;cursor:pointer;
  background:#1b2838;color:#c7d5e0;border:1px solid rgba(102,192,244,.35);
  font:600 12px/1 inherit;box-shadow:0 4px 14px rgba(0,0,0,.4);
  transition:background .15s ease,border-color .15s ease;
}
.hbso-launcher:hover{background:#24384d;border-color:rgba(102,192,244,.7)}
.hbso-launcher__icon{width:15px;height:15px;color:#66c0f4}
.hbso-launcher--connected .hbso-launcher__icon{color:#5ba32b}

.hbso-panel{
  width:288px;margin-bottom:10px;border-radius:8px;overflow:hidden;
  background:#12212f;border:1px solid rgba(102,192,244,.22);
  box-shadow:0 12px 34px rgba(0,0,0,.55);color:#c7d5e0;
}
.hbso-panel[hidden]{display:none}
.hbso-panel__body{padding:16px}

.hbso-title{margin:0 0 7px;font-size:14px;font-weight:700;color:#fff}
.hbso-copy{margin:0 0 13px;font-size:11.5px;line-height:1.55;color:#8fa3b5}
.hbso-status{display:flex;align-items:center;gap:7px;font-size:14px;font-weight:700;color:#fff}
.hbso-check{color:#5ba32b;font-size:15px}
.hbso-persona{margin:7px 0 0;font-size:12px;color:#66c0f4;font-weight:600}
.hbso-count{margin:4px 0 0;font-size:12.5px;color:#c7d5e0}
.hbso-sub{margin:2px 0 0;font-size:11px;color:#7f93a5}

.hbso-actions{display:flex;gap:8px;margin-top:14px}
.hbso-btn{
  flex:1;padding:8px 10px;border-radius:4px;cursor:pointer;
  background:#2a475e;color:#c7d5e0;border:1px solid transparent;
  font:600 11.5px/1 inherit;transition:background .15s ease;
}
.hbso-btn:hover:not(:disabled){background:#35566f}
.hbso-btn:disabled{opacity:.6;cursor:default}
.hbso-btn--primary{background:#66c0f4;color:#0d1b26}
.hbso-btn--primary:hover:not(:disabled){background:#8ed2fb}
.hbso-btn--ghost{flex:0 0 auto;background:transparent;border-color:rgba(199,213,224,.25);color:#8fa3b5}
.hbso-btn--ghost:hover{background:rgba(199,213,224,.08)}

.hbso-link{display:inline-block;margin-top:11px;font-size:11.5px;color:#66c0f4;text-decoration:none}
.hbso-link:hover{text-decoration:underline}
.hbso-fineprint{margin:11px 0 0;font-size:10.5px;line-height:1.5;color:#6b7f91}
.hbso-alert{
  margin:0 0 12px;padding:9px 10px;border-radius:4px;
  background:rgba(214,92,74,.12);border:1px solid rgba(214,92,74,.4);
  font-size:11px;line-height:1.5;color:#e6b0a6;
}
.hbso-alert strong{color:#f0c4bb;font-weight:700}

.hbso-diag{margin-top:12px;padding-top:11px;border-top:1px solid rgba(199,213,224,.12)}
.hbso-linkbtn{
  padding:0;background:none;border:0;cursor:pointer;
  color:#66c0f4;font:600 11px/1 inherit;text-decoration:underline;
}
.hbso-linkbtn:disabled{opacity:.6;cursor:default;text-decoration:none}
.hbso-diag__rows{margin-top:9px;display:flex;flex-direction:column;gap:4px}
.hbso-diag__row{display:flex;justify-content:space-between;gap:8px;font-size:10.5px}
.hbso-diag__host{color:#8fa3b5;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.hbso-diag__state{font-weight:700}
.hbso-diag__state.is-ok{color:#5ba32b}
.hbso-diag__state.is-bad{color:#d65c4a}
.hbso-diag__state.is-muted{color:#6b7f91;font-weight:400}
.hbso-diag__verdict{margin:9px 0 0;font-size:10.5px;line-height:1.5;color:#8fa3b5}
.hbso-diag__verdict--bad{color:#e6b0a6}
.hbso-diag__verdict--ok{color:#9ec97f}
.hbso-diag__label{margin:10px 0 4px;font-size:10px;font-weight:700;letter-spacing:.06em;
  text-transform:uppercase;color:#8fa3b5}
.hbso-diag__pre{
  margin:0;padding:8px;max-height:150px;overflow:auto;
  background:rgba(0,0,0,.28);border-radius:3px;
  font:400 10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;
  color:#a8bccd;white-space:pre-wrap;word-break:break-word;user-select:text;
}
`;

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function init() {
    addStyle(CSS);

    const rec = await loadRecord();
    if (rec) {
      state.record = rec;
      state.index = buildIndex(rec);
    }

    mountUI();
    startObserver();
    scan();

    if (rec && Date.now() - rec.syncedAt > STALE_AFTER) {
      log('library is stale, refreshing in the background');
      refresh({ silent: true });
    }

    // Violentmonkey/Tampermonkey sandbox the script when any @grant is used, so
    // plain `window` is a proxy the page console cannot see. unsafeWindow is the
    // real page window. Firefox can refuse the assignment across the Xray
    // boundary, which is why the connection test also lives in the panel UI.
    const pageWindow = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    let exposed = false;
    for (const target of [pageWindow, window]) {
      try {
        Object.defineProperty(target, 'hbso', { value: api, configurable: true, writable: true });
        exposed = true;
      } catch {
        try { target.hbso = api; exposed = true; } catch { /* Xray boundary */ }
      }
    }
    if (!exposed) {
      warn('could not expose `hbso` to the page console; use the panel\u2019s "Run connection test" button instead.');
    }

    log(`v${VERSION} ready.`, rec ? `${rec.games.length} games loaded.` : 'Not connected yet.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
