/* Runs every test file. Usage: node test/run.js */
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');

const suites = ['matcher.test.js', 'parser.test.js', 'panel.test.js'];
let failed = 0;

for (const suite of suites) {
  console.log(`\n=== ${suite} ===`);
  try {
    execFileSync(process.execPath, [path.join(__dirname, suite)], { stdio: 'inherit' });
  } catch {
    failed++;
  }
}

console.log(failed ? `\n${failed} suite(s) failed` : '\nAll suites passed');
process.exit(failed ? 1 : 0);
