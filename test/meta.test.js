/*
 * Metadata tests — run with:  node test/meta.test.js
 *
 * Release hygiene. These catch mistakes that are invisible until after the
 * script is published, when the people affected are users rather than you.
 */

'use strict';

const fs = require('fs');
const { SCRIPT } = require('./load');

const src = fs.readFileSync(SCRIPT, 'utf8');
const header = src.slice(0, src.indexOf('==/UserScript=='));

let passed = 0;
const failures = [];

function check(name, ok, detail) {
  if (ok) { passed++; console.log(`  ok    ${name}`); }
  else { failures.push({ name, detail }); console.log(`  FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

const meta = key => {
  const m = header.match(new RegExp('^//\\s*@' + key + '\\s+(.+)$', 'm'));
  return m ? m[1].trim() : null;
};
const metaAll = key =>
  Array.from(header.matchAll(new RegExp('^//\\s*@' + key + '\\s+(.+)$', 'gm'))).map(m => m[1].trim());

// --- Version -----------------------------------------------------------------
//
// Userscript managers decide whether to update by comparing @version against
// the installed copy. Ship a change without bumping it and nobody ever receives
// the fix -- silently, with no error anywhere.
{
  const declared = meta('version');
  check('@version is present', Boolean(declared));
  check('@version looks like a version', /^\d+\.\d+\.\d+$/.test(declared || ''), declared);

  // The constant is what the UI and bug reports display. If it drifts from the
  // metadata, reports name a version that was never released.
  const constant = (src.match(/const VERSION\s*=\s*'([^']+)'/) || [])[1];
  check('VERSION constant matches @version', declared === constant,
    `@version is ${declared}, VERSION is ${constant}`);
}

// --- Update channel ----------------------------------------------------------
{
  for (const key of ['updateURL', 'downloadURL', 'namespace', 'license', 'author']) {
    check(`@${key} is set`, Boolean(meta(key)));
  }
  check('@updateURL and @downloadURL agree', meta('updateURL') === meta('downloadURL'));
  check('@downloadURL serves raw source, not a rendered page',
    (meta('downloadURL') || '').includes('raw.githubusercontent.com'),
    meta('downloadURL'));
  check('@downloadURL ends in .user.js so managers offer to install it',
    (meta('downloadURL') || '').endsWith('.user.js'));
}

// --- Cross-origin permissions ------------------------------------------------
//
// Every host the script fetches must be declared. A missing @connect fails at
// the network layer with no HTTP status, which is indistinguishable from being
// blocked by an extension -- an afternoon of debugging, as this project learned.
{
  const connects = metaAll('connect');

  // Only hosts the script actually requests need permission. These constants
  // are used as link hrefs, opened by the browser in a new tab.
  const LINK_ONLY = new Set(['URL_ISSUES', 'URL_LOGIN']);

  const hosts = new Set();
  for (const m of src.matchAll(/const (URL_[A-Z_]+)\s*=\s*'https:\/\/([^/']+)/g)) {
    if (!LINK_ONLY.has(m[1])) hosts.add(m[2]);
  }

  for (const host of hosts) {
    const covered = connects.some(c => host === c || host.endsWith('.' + c));
    check(`@connect covers ${host}`, covered, `declared: ${connects.join(', ')}`);
  }
  check('found the URL constants to check', hosts.size > 0);
}

// --- Grants ------------------------------------------------------------------
{
  const grants = metaAll('grant');
  for (const g of ['GM_xmlhttpRequest', 'GM_getValue', 'GM_setValue', 'unsafeWindow']) {
    check(`@grant ${g}`, grants.includes(g));
  }
}

const total = passed + failures.length;
console.log(`\n${passed}/${total} passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures) console.log(`  ${f.name}${f.detail ? ' — ' + f.detail : ''}`);
  process.exit(1);
}
