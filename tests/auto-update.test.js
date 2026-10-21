const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const net = require('node:net');

test('Auto update observes its toggle and checks faster in use than in the tray', async () => {
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => '1.3.6' });
  const au = new EventEmitter();
  au.setFeedURL = () => {};
  let checks = 0;
  au.checkForUpdates = async () => { checks++; au.emit('update-not-available'); };
  let now = 1_000_000;
  let active = true;
  const settings = { autoCheckUpdates: true };
  const timers = {};
  class ClockDate extends Date { static now() { return now; } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/updater.js'), 'utf8'), {
    require: (id) => ({ electron: { app }, 'electron-updater': { autoUpdater: au }, './update-relaunch': {}, '../package.json': require('../package.json') })[id],
    module, process: { env: {} }, Date: ClockDate,
    setTimeout: (fn) => { timers.start = fn; }, setInterval: (fn) => { timers.tick = fn; },
  });
  const updater = module.exports.setup({ send: () => {}, getSettings: () => settings, isActive: () => active });
  await timers.start();
  assert.equal(checks, 1);
  now += 4 * 60_000; await timers.tick(); assert.equal(checks, 1);
  now += 60_000; await timers.tick(); assert.equal(checks, 2);
  active = false;
  now += 29 * 60_000; await timers.tick(); assert.equal(checks, 2);
  now += 60_000; await timers.tick(); assert.equal(checks, 3);
  settings.autoCheckUpdates = false;
  now += 60 * 60_000; await timers.tick(); await updater.maybeCheck();
  assert.equal(checks, 3);
  await updater.check(); assert.equal(checks, 4); // manual checks still work while Off
  settings.autoCheckUpdates = true;
  await updater.settingsChanged(); assert.equal(checks, 5);
  await updater.maybeCheck(); assert.equal(checks, 5);
  now += 60_000; await updater.maybeCheck(); assert.equal(checks, 6);
});

test('Auto update toggle saves and automatic popups honor foreground, Later and new versions', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-auto-update-test-'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ autoCheckUpdates: false }));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--hidden'], { cwd: repo, env, windowsHide: true });
  child.stdout.resume(); child.stderr.resume();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let socket;
  try {
    let page;
    for (let i = 0; i < 100; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.url.endsWith('/index.html')); } catch {}
      if (page) break;
      if (child.exitCode !== null) throw Error('Demo app exited');
      await delay(100);
    }
    assert.ok(page);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    let id = 0;
    const pending = new Map();
    socket.addEventListener('message', ({ data }) => {
      const event = JSON.parse(data);
      if (pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); }
    });
    const evaluate = async (expression) => {
      const result = await new Promise((resolve) => { pending.set(++id, resolve); socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); });
      if (result.error || result.result.exceptionDetails) throw Error(JSON.stringify(result));
      return result.result.result.value;
    };
    for (let i = 0; i < 100; i++) {
      if (await evaluate('typeof S !== "undefined" && !!S && document.querySelector("#verLine").textContent.includes("1.")')) break;
      await delay(100);
    }
    assert.equal(await evaluate('document.querySelectorAll("[data-key=autoCheckUpdates]").length'), 1);
    assert.equal(await evaluate('document.querySelector("#updCard").nextElementSibling.id'), 'autoUpdateRow');
    assert.equal(await evaluate('document.querySelector("#autoUpdateToggle").checked'), false);
    await evaluate(`window.testFocused = true; window.testVisible = true;
      Object.defineProperty(document, 'hasFocus', { value: () => window.testFocused });
      Object.defineProperty(document, 'visibilityState', { get: () => window.testVisible ? 'visible' : 'hidden' });
      window.fixtureUpdate = { status: 'available', version: '9.0.0', current: '1.3.6' };
      receiveUpdate(window.fixtureUpdate);`);
    const hidden = () => evaluate('document.querySelector("#updModal").classList.contains("hidden")');
    assert.equal(await hidden(), true);
    const toggle = async (on) => {
      await evaluate(`document.querySelector('#autoUpdateToggle').checked = ${on}; document.querySelector('#autoUpdateToggle').dispatchEvent(new Event('change', {bubbles:true}));`);
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`S.autoCheckUpdates === ${on} && document.querySelector('#toast').textContent.includes('Auto update is ${on ? 'on' : 'off'}')`)) return;
        await delay(50);
      }
      throw Error('Toggle did not save');
    };
    await toggle(true);
    assert.equal(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf8')).autoCheckUpdates, true);
    await evaluate('window.testFocused = false; receiveUpdate(window.fixtureUpdate)');
    assert.equal(await hidden(), true);
    await evaluate('window.testFocused = true; window.testVisible = false; window.dispatchEvent(new Event("focus"))');
    assert.equal(await hidden(), true);
    await evaluate('window.testVisible = true; window.dispatchEvent(new Event("focus"))');
    assert.equal(await hidden(), false);
    await evaluate('document.querySelector("#updLater").click(); receiveUpdate({...window.fixtureUpdate, status:"downloading", progress:50}); receiveUpdate({...window.fixtureUpdate, status:"ready"})');
    assert.equal(await hidden(), true);
    await evaluate('receiveUpdate({...window.fixtureUpdate, version:"9.1.0"})');
    assert.equal(await hidden(), false);
    await evaluate('document.querySelector("#updLater").click()');
    await toggle(false);
    await evaluate('receiveUpdate({...window.fixtureUpdate, version:"9.2.0"})');
    assert.equal(await hidden(), true);
    await evaluate('updManualCheck = true; receiveUpdate({...window.fixtureUpdate, version:"9.2.0"})');
    assert.equal(await hidden(), false);
  } finally {
    if (socket) socket.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
