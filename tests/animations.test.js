const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load({ demo = false, readCode = 0, writeCode = 0 } = {}) {
  let parts;
  let writes = 0;
  const module = { exports: {} };
  const util = {
    IS_WIN: true, DEMO: demo,
    run: async () => ({ code: 0, stdout: '' }),
    ps: async (script) => {
      if (script.includes('[FFAnim]::Set(')) {
        writes++;
        const on = script.includes('::Set($true)');
        if (writeCode === 0) {
          parts = Object.fromEntries(Object.keys(parts).map((k) => [k, k === 'policy' ? +!on : on ? 1 : parts[k]]));
          if (!on) for (const key of module.exports.ANIM_KEYS) parts[key] = 0;
        }
        return { code: writeCode, stdout: 'ok' };
      }
      return { code: readCode, stdout: Object.entries(parts).map(([k, v]) => `${k}=${v}`).join(';') };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/animations.js'), 'utf8'), {
    require: () => util, module, Buffer, setTimeout,
  });
  parts = Object.fromEntries([...module.exports.ANIM_KEYS, ...module.exports.EFFECT_KEYS].map((k) => [k, 1]));
  parts.policy = 0;
  return { api: module.exports, parts, writes: () => writes };
}

test('live dragging disabled among enabled animations is detected and repaired', async () => {
  const { api, parts, writes } = load();
  parts.drag = 0;
  assert.equal((await api.get()).on, false);
  assert.equal(await api.enforce('on'), true);
  assert.equal((await api.get()).parts.drag, 1);
  assert.equal(writes(), 1);
  assert.equal(await api.enforce('on'), false);
});

test('off disables dragging and animations while preserving static visual effects', async () => {
  const { api } = load();
  const result = await api.set(false);
  assert.equal(result.ok, true);
  assert.equal(result.state.off, true);
  assert.equal(result.state.parts.drag, 0);
  assert.equal(result.state.parts.font, 1);
});

test('read failures and unavailable Windows controls cannot count as success', async () => {
  const failed = load({ readCode: 1 });
  assert.equal((await failed.api.get()).on, false);
  assert.equal((await failed.api.set(true)).ok, false);
  const unknown = load();
  unknown.parts.drag = -1;
  assert.equal((await unknown.api.get()).mixed, true);
  unknown.parts.policy = -1;
  unknown.parts.drag = 1;
  assert.equal((await unknown.api.get()).on, false);
});

test('a failed native write stays failed even if readback happens to match', async () => {
  const { api } = load({ writeCode: 1 });
  assert.equal((await api.set(true)).ok, false);
});

test('demo mode covers both toggle directions and repairing external changes', async () => {
  const { api } = load({ demo: true });
  assert.equal((await api.set(false)).state.parts.drag, 0);
  assert.equal((await api.set(true)).state.parts.drag, 1);
  api.demoTamper();
  assert.equal(await api.enforce('on'), true);
});
