'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const OLD_GTIN = '08600015381754';
const MONO_GTIN = '00860001538175';

// Correct only the existing MONO queue default. No database writes or migrations.
// This does not allocate or approve a DI for another model.
function applyMonoGtinFix(source) {
  const oldPattern = /\bgtin:\s*(["'])08600015381754\1/g;
  const newPattern = /\bgtin:\s*(["'])00860001538175\1/g;
  const oldCount = [...source.matchAll(oldPattern)].length;
  const newCount = [...source.matchAll(newPattern)].length;
  if (oldCount === 0 && newCount === 1) return source;
  if (oldCount !== 1 || newCount !== 0) {
    throw new Error('MONO GTIN patch: expected exactly one legacy queue default; review App.js.');
  }
  return source.replace(oldPattern, (match) => match.replace(OLD_GTIN, MONO_GTIN));
}

function checkDigit(body) {
  assert.match(body, /^\d{13}$/);
  const sum = [...body].reverse().reduce((n, digit, index) =>
    n + Number(digit) * (index % 2 === 0 ? 3 : 1), 0);
  return String((10 - sum % 10) % 10);
}

function selfTest() {
  const input = 'const payload = {gtin: "08600015381754", quantity: finalQty, lotNumber: finalLot};';
  const expected = input.replace(OLD_GTIN, MONO_GTIN);
  assert.equal(applyMonoGtinFix(input), expected);
  assert.equal(applyMonoGtinFix(expected), expected);
  assert.equal(checkDigit(MONO_GTIN.slice(0, 13)), '5');
  assert.equal(MONO_GTIN.slice(0, 13) + checkDigit(MONO_GTIN.slice(0, 13)), MONO_GTIN);
  assert.equal(checkDigit('0086000153818'), '2');
  assert.throws(() => applyMonoGtinFix(''), /expected exactly/);
  assert.throws(() => applyMonoGtinFix(input + input), /expected exactly/);
  assert.equal(applyMonoGtinFix(input + '\nconst other = {gtin: "00860001538182"};'),
    expected + '\nconst other = {gtin: "00860001538182"};');
}

if (require.main === module) {
  selfTest();
  if (process.argv.includes('--test')) {
    console.log('MONO GTIN tests passed.');
  } else {
    const file = path.join(__dirname, '..', 'src', 'App.js');
    const before = fs.readFileSync(file, 'utf8');
    const after = applyMonoGtinFix(before);
    if (before !== after) fs.writeFileSync(file, after, 'utf8');
    console.log('MONO GTIN queue default: ' + MONO_GTIN + ' (BarTender body: ' + MONO_GTIN.slice(0, 13) + ')');
  }
}
module.exports = { applyMonoGtinFix, selfTest };
