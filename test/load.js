/*
 * Loads the userscript for testing.
 *
 * It is a single IIFE with no exports, so we read the source, splice in a
 * `return` exposing the internals a test needs, and cut execution off just
 * before the browser-only boot section.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const SCRIPT = path.join(__dirname, '..', 'owned-on-steam.user.js');

function loadUserscript(names) {
  const src = fs.readFileSync(SCRIPT, 'utf8');
  const start = src.indexOf('(function () {');
  const boot = src.indexOf('  async function init() {');
  if (start === -1 || boot === -1) {
    throw new Error('Could not find the IIFE or the boot section — did the layout change?');
  }

  const exported = `  return { ${names.join(', ')} };\n\n`;
  const body = src.slice(start, boot) + exported + src.slice(boot);

  const mod = new Module(SCRIPT, null);
  mod._compile(body.replace('(function () {', 'module.exports = (function () {', 1), SCRIPT);
  return mod.exports;
}

module.exports = { loadUserscript, SCRIPT };
