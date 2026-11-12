const { test } = require('node:test');
const assert = require('node:assert/strict');
const fplimit = require('../src/fplimit');

test('limit numbers are kept inside what RTSS and games accept', () => {
  assert.equal(fplimit.clamp('144'), 144);
  assert.equal(fplimit.clamp(5), 20);
  assert.equal(fplimit.clamp(99999), 1000);
  assert.equal(fplimit.clamp('abc'), 60);
});

test('every RTSS game profile is found, and the Global template is never treated as one', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-rtss-profiles-'));
  fs.mkdirSync(path.join(dir, 'Profiles'));
  for (const f of ['Global', 'global.cfg', 'dota2.exe.cfg', 'FortniteClient-Win64-Shipping.exe.cfg', 'notes.txt']) {
    fs.writeFileSync(path.join(dir, 'Profiles', f), '');
  }
  assert.deepEqual(fplimit._profileNames(dir).sort(), ['FortniteClient-Win64-Shipping.exe', 'dota2.exe']);
  assert.deepEqual(fplimit._profileNames(path.join(dir, 'nope')), [], 'no Profiles folder: nothing to cap');
});

test('the RTSS bridge compiles and fails clearly when the DLL is missing', { skip: process.platform !== 'win32' || process.env.FRAMEFORGE_DEMO === '1', timeout: 60000 }, async () => {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ff-rtss-'));
  const r = await fplimit._hooks(dir, -1);
  assert.equal(r.ok, false);
  assert.match(r.message, /Could not load RTSSHooks64.dll/);
});
