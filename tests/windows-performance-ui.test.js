const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const preserved = (s) => ({
  autoMode: s.autoMode, animations: s.animations, preset: s.preset,
  fpsCounter: s.fpsCounter, fpsLimitOn: s.fpsLimitOn, fpsLimit: s.fpsLimit,
  tempMonitor: s.tempMonitor, autoFix: s.autoFix, overclock: s.overclock,
  smartProfile: s.smartProfile, tweaksCustomized: s.tweaksCustomized, tweaks: s.tweaks,
});

async function openDemo(repo, userData) {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FRAMEFORGE_FAKE_REBOOT;
  delete env.FRAMEFORGE_TEST_ANIM_TAMPER;
  const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'),
    ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--hidden'],
    { cwd: repo, env, windowsHide: true });
  let stderr = '', launchError, socket;
  child.stdout.resume();
  child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-8192); });
  child.on('error', (error) => { launchError = error; });
  const close = async () => {
    if (socket) socket.close();
    if (!launchError && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child.once('exit', resolve));
    }
  };
  try {
    let page;
    for (let i = 0; i < 150; i++) {
      if (launchError) throw launchError;
      if (child.exitCode !== null) throw Error(`Demo app exited: ${stderr}`);
      try {
        page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json())
          .find((p) => p.url.endsWith('/index.html'));
      } catch {}
      if (page) break;
      await delay(100);
    }
    assert.ok(page, `Main window not available: ${stderr}`);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', reject);
    });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    socket.addEventListener('message', ({ data }) => {
      const event = JSON.parse(data);
      if (event.method === 'Runtime.exceptionThrown')
        exceptions.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
      if (pending.has(event.id)) {
        pending.get(event.id)(event);
        pending.delete(event.id);
      }
    });
    const command = (method, params = {}) => new Promise((resolve) => {
      pending.set(++id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.error || result.result.exceptionDetails) throw Error(JSON.stringify(result));
      return result.result.result.value;
    };
    const waitFor = async (expression) => {
      for (let i = 0; i < 200; i++) {
        if (await evaluate(expression)) return;
        await delay(50);
      }
      throw Error(`Timed out: ${expression}`);
    };
    await command('Runtime.enable');
    await waitFor('typeof S !== "undefined" && !!S && !!PROFILE && document.querySelector("#verLine").textContent.includes("1.")');
    await evaluate('document.querySelector(".nav-item[data-view=settings]").click(); document.querySelector("#windowsPerformanceToggle").scrollIntoView({block:"center"})');
    return { evaluate, waitFor, command, exceptions, close };
  } catch (error) {
    await close();
    throw error;
  }
}

test('Windows performance mode saves independently and survives a demo relaunch',
  { skip: process.platform !== 'win32', timeout: 60000 }, async (t) => {
    const repo = path.resolve(__dirname, '..');
    const userData = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-windows-performance-'));
    const settingsPath = path.join(userData, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      autoMode: true, autoFix: false, autoRestart: false, autoCheckUpdates: false,
      smartProfile: false, tweaksCustomized: true, reapplyOnStartup: false,
      fpsCounter: false, fpsLimitOn: false, fpsLimit: 144, tempMonitor: true,
      animations: 'on', preset: 'balanced', overclock: false,
      scanSchedule: 'off', scanFullSchedule: 'off',
      tweaks: { power_plan: false, game_mode: true, visual_effects: false, no_popups: true },
    }));
    let demo;
    try {
      demo = await openDemo(repo, userData);
      const { evaluate, waitFor } = demo;
      const control = await evaluate(`(() => {
        const c = document.querySelector('#windowsPerformanceToggle');
        return { count: document.querySelectorAll('[data-key=windowsPerformanceMode]').length,
          checked: c.checked, type: c.type, key: c.dataset.key, label: c.getAttribute('aria-label'),
          group: c.closest('.set-group').querySelector('h2').textContent,
          help: document.getElementById(c.getAttribute('aria-describedby')).textContent,
          shown: !document.querySelector('#view-settings').classList.contains('hidden') };
      })()`);
      assert.deepEqual({ count: control.count, checked: control.checked, type: control.type, key: control.key, label: control.label, group: control.group, shown: control.shown },
        { count: 1, checked: false, type: 'checkbox', key: 'windowsPerformanceMode', label: 'Windows performance mode', group: 'Windows', shown: true });
      assert.match(control.help, /3 seconds instead of every second/);
      assert.match(control.help, /lower priority/);
      assert.match(control.help, /finish each check before starting another/);
      assert.match(control.help, /cannot remove all PC lag/);
      assert.equal(await evaluate('S.windowsPerformanceMode'), false, 'existing settings default to off');
      const baseline = preserved(await evaluate('ff.settings()'));
      assert.equal(baseline.autoMode, true, 'the independent switch is tested while Auto Mode is already on');
      const toggle = async (on, session = demo) => {
        await session.evaluate(`(() => { const c = document.querySelector('#windowsPerformanceToggle'); c.checked = ${on}; c.dispatchEvent(new Event('change', {bubbles:true})); })()`);
        await session.waitFor(`S.windowsPerformanceMode === ${on} && document.querySelector('#toast').textContent.includes('Windows performance mode is ${on ? 'on' : 'off'}')`);
      };
      await toggle(true);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).windowsPerformanceMode, true);
      assert.deepEqual(preserved(await evaluate('ff.settings()')), baseline);
      assert.deepEqual(preserved(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))), baseline);
      const shot = await demo.command('Page.captureScreenshot', { format: 'png' });
      if (shot.result?.data) fs.writeFileSync(path.join(userData, 'windows-performance-on.png'), Buffer.from(shot.result.data, 'base64'));
      assert.deepEqual(demo.exceptions, []);
      await demo.close();
      demo = null;

      demo = await openDemo(repo, userData);
      assert.equal(await demo.evaluate('S.windowsPerformanceMode && document.querySelector("#windowsPerformanceToggle").checked'), true,
        'the saved mode is restored after a full app relaunch');
      assert.deepEqual(preserved(await demo.evaluate('ff.settings()')), baseline);
      await toggle(false, demo);
      assert.equal(JSON.parse(fs.readFileSync(settingsPath, 'utf8')).windowsPerformanceMode, false);
      assert.deepEqual(preserved(await demo.evaluate('ff.settings()')), baseline);
      assert.deepEqual(preserved(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))), baseline);
      assert.deepEqual(demo.exceptions, []);
      t.diagnostic(`Demo-only settings and screenshot: ${userData}`);
    } finally {
      if (demo) await demo.close();
    }
  });
