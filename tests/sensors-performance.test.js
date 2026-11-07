const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const flush = () => new Promise((resolve) => setImmediate(resolve));
function load({ currentLoad, priorityFails = false, spawnFails = false, demo = false } = {}) {
  let now = 1000000, loadCalls = 0, nvCalls = 0;
  const children = [], priorities = [], timers = new Map();
  const module = { exports: {} };
  class Clock extends Date { static now() { return now; } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/sensors.js'), 'utf8'), {
    module, Date: Clock, Buffer, console,
    setInterval: (fn, ms) => { const id = {}; timers.set(id, { fn, ms }); return id; },
    clearInterval: (id) => timers.delete(id),
    require: (id) => ({
      child_process: { spawn: (file, args, options) => {
        if (spawnFails) throw Error('test launch denied');
        const child = Object.assign(new EventEmitter(), {
          pid: 4000 + children.length, file, args, options,
          stdout: new EventEmitter(), kills: 0, kill() { this.kills++; },
        });
        children.push(child); return child;
      } },
      readline: { createInterface: ({ input }) => input },
      http: { get: () => { const req = new EventEmitter(); req.destroy = () => {}; queueMicrotask(() => req.emit('error', Error('no LHM server'))); return req; } },
      systeminformation: { currentLoad: async () => { loadCalls++; return currentLoad ? currentLoad() : { currentLoad: 24 }; } },
      os: { constants: { priority: { PRIORITY_BELOW_NORMAL: 10 } }, setPriority: (pid, value) => {
        priorities.push([pid, value]); if (priorityFails) throw Error('test access denied');
      } },
      './util': { DEMO: demo, run: async () => { nvCalls++; return { code: 0, stdout: '66, 42' }; } },
    })[id],
  });
  return {
    sensors: new module.exports.Sensors(), api: module.exports, children, priorities, timers,
    advance: (ms) => { now += ms; }, loadCalls: () => loadCalls, nvCalls: () => nvCalls,
    tick: async () => { await [...timers.values()][0].fn(); await flush(); },
  };
}

test('performance mode lowers only owned helper PIDs and reduces every poll cadence', async () => {
  const h = load(); h.sensors.start('nvidia', { performanceMode: true }); await flush();
  assert.equal(h.children.length, 2);
  assert.deepEqual(h.priorities, [[4000, 10], [4001, 10]]);
  for (const child of h.children) {
    assert.equal(child.file, 'powershell.exe');
    assert.equal(child.options.windowsHide, true);
    assert.match(child.args.at(-1), /Start-Sleep -Milliseconds 3000/);
  }
  assert.equal([...h.timers.values()][0].ms, 3000);
  assert.equal(h.nvCalls(), 1);
  h.advance(3000); await h.tick(); assert.equal(h.nvCalls(), 1);
  h.advance(3000); await h.tick(); assert.equal(h.nvCalls(), 2);
  h.sensors.stop();
  assert.equal(h.timers.size, 0);
  assert.ok(h.children.every((child) => child.kills === 1));
});

test('unchanged configuration does not restart helpers; switching off restores normal cadence', async () => {
  const h = load(); h.sensors.start('amd', { performanceMode: true }); await flush();
  h.sensors.start('amd', { performanceMode: true });
  assert.equal(h.children.length, 2);
  assert.ok(h.children.every((child) => child.kills === 0));
  h.sensors.start('amd', { performanceMode: false }); await flush();
  assert.equal(h.children.length, 4);
  assert.equal([...h.timers.values()][0].ms, 1000);
  assert.match(h.children[2].args.at(-1), /Start-Sleep -Milliseconds 1000/);
  assert.equal(h.priorities.length, 2, 'normal mode never changes priority');
  assert.equal(h.sensors.performanceMode, false);
  h.sensors.stop();
});

test('slow fallback reads never overlap', async () => {
  let release;
  const h = load({ currentLoad: () => new Promise((resolve) => { release = resolve; }) });
  h.sensors.start('amd', { performanceMode: true }); await flush();
  assert.equal(h.loadCalls(), 1);
  h.advance(3000); await h.tick(); await h.tick();
  assert.equal(h.loadCalls(), 1);
  release({ currentLoad: 37 }); await flush();
  assert.equal(h.sensors.read().cpuLoad, 37);
  h.sensors.stop();
});

test('results and helper lines from a stopped generation cannot overwrite new readings', async () => {
  const pending = [];
  const h = load({ currentLoad: () => new Promise((resolve) => pending.push(resolve)) });
  h.sensors.start('amd'); await flush();
  h.sensors.start('amd', { performanceMode: true }); await flush();
  assert.equal(pending.length, 2);
  pending[1]({ currentLoad: 22 }); await flush();
  pending[0]({ currentLoad: 99 }); await flush();
  h.children[1].stdout.emit('line', '100');
  assert.equal(h.sensors.read().cpuLoad, 22);
  assert.equal(h.sensors.read().gpuLoad, null);
  h.sensors.stop();
});

test('slower sampling retains fresh readings, then expires stale values', async () => {
  const h = load(); h.sensors.start('amd', { performanceMode: true }); await flush();
  h.children[1].stdout.emit('line', '45');
  h.sensors.setLhm({ cpuTemp: 64, gpuTemp: 70, cpuLoad: 20, gpuLoad: 40 }, 'LibreHardwareMonitor');
  h.advance(5500);
  assert.equal(h.sensors.read().cpuTemp, 64);
  h.advance(501);
  assert.equal(h.sensors.read().cpuTemp, null);
  assert.equal(h.sensors.read().cpuLoad, null);
  assert.equal(h.sensors.read().gpuLoad, null);
  h.sensors.stop();
});

test('priority and launch failures keep available fallback readings usable and report a warning', async () => {
  for (const options of [{ priorityFails: true }, { spawnFails: true }]) {
    const h = load(options); h.sensors.start('amd', { performanceMode: true }); await flush();
    assert.ok(h.sensors.warning);
    assert.equal(h.sensors.read().cpuLoad, 24);
    assert.equal([...h.timers.values()][0].ms, 3000);
    h.sensors.stop();
  }
});

test('demo mode records the saved policy without starting Windows helpers', () => {
  const h = load({ demo: true }); h.sensors.start('nvidia', { performanceMode: true });
  assert.equal(h.sensors.performanceMode, true);
  assert.equal(h.sensors.pollInterval, 3000);
  assert.equal(h.children.length, 0);
  h.sensors.stop();
});
