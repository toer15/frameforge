const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
const optimizerSource = fs.readFileSync(path.join(root, 'src/optimizer.js'), 'utf8');
const failure = { status: 'error', message: 'The first write failed.', details: [] };
const success = { status: 'done', message: 'Game Mode is on.', details: [] };

function testMain({ autoFix = true, hasAdmin = true, outcomes = [failure, success], tweak = {}, onAttempt } = {}) {
  const handlers = new Map();
  const recorded = [];
  const events = [];
  let on = false;
  const stored = { autoFix, preset: 'balanced', tweaksCustomized: true, tweaks: { game_mode: true } };
  const memory = () => {
    const entries = {};
    return {
      all: () => ({ ...entries }),
      get: (id) => entries[id],
      put: (id, entry) => { entries[id] = entry; },
      remove: (id) => { delete entries[id]; },
    };
  };
  const changes = memory();
  const problems = memory();
  const backup = memory();
  const t = {
    id: 'game_mode',
    name: 'Windows Game Mode',
    values: [{ key: 'HKCU\\Software\\Microsoft\\GameBar', name: 'AutoGameModeEnabled', type: 'REG_DWORD', data: 1 }],
    isOn: async () => on,
    ...tweak,
  };
  const call = (channel, ...args) => handlers.get(channel)(null, ...args);
  const deps = {
    electron: {
      app: { setAppUserModelId() {}, requestSingleInstanceLock: () => false, quit() {}, on() {} },
      ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
    },
    path,
    fs,
    os: { uptime: () => 100 },
    systeminformation: { fsSize: async () => [], battery: async () => null },
    './src/util': { IS_WIN: true, DEMO: false, run: async () => ({ code: 1, stdout: '', stderr: '' }), sleep: async () => {} },
    './src/store': { settings: { get: () => stored, set: (patch) => Object.assign(stored, patch) }, changes, problems, backup },
    './src/hardware': { scan: async () => ({ cpu: { name: 'Test CPU' }, gpu: { name: 'Test GPU', vendorName: 'Test' }, ramGB: 16 }) },
    './src/presets': { PRESETS: { balanced: { name: 'Balanced' } } },
    './src/fps': { FpsReader: class {} },
    './src/sensors': { Sensors: class {} },
    './src/booster': { Booster: class {} },
    './src/bgfix': require('../src/bgfix'),
    './src/gamewatch': require('../src/gamewatch'),
    './src/optimizer': {
      TWEAKS: [t],
      planned: () => [t],
      revertPlan: () => [],
      activeCount: () => Number(on),
      async runOne(target, options) {
        assert.equal(target, t);
        const outcome = outcomes[recorded.length];
        recorded.push(options);
        assert.ok(outcome, 'an unexpected extra apply was attempted');
        if (onAttempt) await onAttempt(call, recorded.length);
        if (outcome.status === 'done') on = true;
        return { ...outcome, verified: options.verify === true && outcome.status === 'done' };
      },
    },
    './src/tweaks': { tabTweaks: () => [t], stateOf: () => t.isOn() },
  };
  const context = vm.createContext({
    require: (name) => deps[name] || {},
    __dirname: root,
    process: { env: {} },
    setTimeout: () => 0, // work main.js schedules for later (the background fix a few seconds after a run) doesn't run here
    clearTimeout() {},
    hasAdmin,
    windowMock: {
      isDestroyed: () => false,
      webContents: { send: (name, data) => events.push({ name, data: JSON.parse(JSON.stringify(data)) }) },
    },
  });
  vm.runInContext(source + '\nmainWin = windowMock; admin = hasAdmin;', context, { filename: 'main.js' });
  return { call, t, recorded, events, problems, changes };
}

const recoveries = (h) => h.events.filter(({ name }) => name === 'fix:auto').map(({ data }) => data);

test('Fix Mode recovers a transient failure when a tweak is switched on', async () => {
  const h = testMain();
  const result = await h.call('tweaks:set', h.t.id, true);
  assert.equal(result.ok, true);
  assert.equal(result.on, true);
  assert.equal(result.recovered, true);
  assert.equal(h.recorded.length, 2);
  assert.ok(h.recorded.every(({ verify }) => verify === true));
  assert.equal(h.problems.get(h.t.id), undefined);
  assert.ok(h.changes.get(h.t.id));
  assert.deepEqual(recoveries(h), [
    { fixed: [h.t.name], stepId: h.t.id, why: 'tweak-recovery' },
  ]);
});

test('Auto Mode recovers the failed tweak during the same run', async () => {
  const h = testMain();
  await h.call('auto:set', true);
  assert.equal(h.recorded.length, 2);
  assert.equal(h.problems.get(h.t.id), undefined);
  assert.ok(h.changes.get(h.t.id));
  assert.deepEqual(recoveries(h), [
    { fixed: [h.t.name], stepId: h.t.id, why: 'tweak-recovery' },
  ]);
});

test('A second failure stays in Fix Mode with the new error', async () => {
  const h = testMain({ outcomes: [failure, { ...failure, message: 'The retry write failed.' }] });
  const result = await h.call('tweaks:set', h.t.id, true);
  assert.equal(result.ok, false);
  assert.equal(h.recorded.length, 2);
  assert.match(h.problems.get(h.t.id).message, /The retry write failed/);
  assert.equal(h.changes.get(h.t.id), undefined);
  assert.deepEqual(recoveries(h), []);
});

test('Turning off automatic fixes leaves the failure available for a manual retry', async () => {
  const h = testMain({ autoFix: false, outcomes: [failure] });
  const result = await h.call('tweaks:set', h.t.id, true);
  assert.equal(result.ok, false);
  assert.equal(h.recorded.length, 1);
  assert.ok(h.problems.get(h.t.id));
  assert.deepEqual(recoveries(h), []);
});

test('Auto Mode does not retry locked, administrator-only, one-time or overclocking steps', async (group) => {
  const cases = [
    { name: 'hardware lock', outcomes: [{ ...failure, locked: true }] },
    { name: 'administrator required', hasAdmin: false, tweak: { admin: true }, outcomes: [{ ...failure, adminSkipped: true }] },
    { name: 'one-time operation', tweak: { oneShot: true }, outcomes: [failure] },
    { name: 'overclocking step', tweak: { overclock: true }, outcomes: [failure] },
  ];
  for (const { name, ...options } of cases) {
    await group.test(name, async () => {
      const h = testMain(options);
      await h.call('auto:set', true);
      assert.equal(h.recorded.length, 1);
      assert.deepEqual(recoveries(h), []);
    });
  }
});

test('Stopping Auto Mode during the initial attempt prevents a retry', async () => {
  const h = testMain({
    outcomes: [failure],
    onAttempt(call, count) {
      if (count === 1) assert.equal(call('auto:stop'), true);
    },
  });
  await h.call('auto:set', true);
  assert.equal(h.recorded.length, 1);
  assert.deepEqual(recoveries(h), []);
});

test('Fix Mode’s own retry action makes only its explicit attempt', async () => {
  const h = testMain({ outcomes: [failure] });
  const result = await h.call('fix:action', `retry:${h.t.id}`);
  assert.equal(result.ok, false);
  assert.equal(h.recorded.length, 1);
  assert.ok(h.problems.get(h.t.id));
  assert.deepEqual(recoveries(h), []);
});

function testOptimizer() {
  const module = { exports: {} };
  const deps = {
    './registry': {},
    './util': { DEMO: false },
    './store': { backup: { get: () => ({ entries: [] }) }, settings: {} },
  };
  vm.runInNewContext(optimizerSource, { require: (name) => deps[name], module }, { filename: 'optimizer.js' });
  return module.exports;
}

test('A write is verified only when the Windows readback confirms it', async (group) => {
  const optimizer = testOptimizer();
  const apply = async () => ({ ok: true, message: 'Write completed.' });
  const cases = [
    { name: 'mismatched setting', isOn: async () => false, status: 'error' },
    { name: 'unreadable setting', isOn: async () => { throw Error('Read failed.'); }, status: 'error' },
    { name: 'confirmed setting', isOn: async () => true, status: 'done' },
  ];
  for (const { name, isOn, status } of cases) {
    await group.test(name, async () => {
      const result = await optimizer.runOne({ id: 'game_mode', name: 'Windows Game Mode', apply, isOn }, { verify: true });
      assert.equal(result.status, status);
      assert.equal(result.verified, status === 'done');
      if (status === 'error') assert.match(result.message, /Windows did not confirm/);
    });
  }

  let reads = 0;
  const result = await optimizer.runOne({
    id: 'game_mode', name: 'Windows Game Mode', apply,
    isOn: async () => { reads++; return true; },
  });
  assert.equal(result.status, 'done');
  assert.equal(result.verified, false);
  assert.equal(reads, 0);
});
