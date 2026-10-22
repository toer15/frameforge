const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('Controller tab detects the pad, switches layouts and says what games will show', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-controller-ui-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoFix: false, autoCheckUpdates: false, tempMonitor: false }));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1', FRAMEFORGE_DEMO_PAD: process.env.PAD_CASE || 'playstation' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--hidden'], { cwd: repo, env, windowsHide: true });
  child.stdout.resume(); child.stderr.resume();
  let socket;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
    const exceptions = [];
    socket.addEventListener('message', ({ data }) => {
      const event = JSON.parse(data);
      if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params.exceptionDetails.text);
      if (pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); }
    });
    const command = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
      const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (result.error || result.result.exceptionDetails) throw Error(JSON.stringify(result));
      return result.result.result.value;
    };
    const waitFor = async (expression) => {
      for (let i = 0; i < 200; i++) { if (await evaluate(expression)) return; await delay(50); }
      throw Error('Timed out: ' + expression);
    };
    await command('Runtime.enable');
    await waitFor('typeof S !== "undefined" && !!S');
    await evaluate('document.querySelector(".nav-item[data-view=controller]").click()');
    await waitFor('document.querySelector("#padConnected .pad-dev")');
    assert.match(await evaluate('document.querySelector("#padConnected").textContent'), /DualSense/);
    // Automatic follows the detected PlayStation pad.
    assert.equal(await evaluate('document.querySelector("#padSvg .pad-key[data-k=a] .pad-sym") !== null'), true);
    assert.match(await evaluate('document.querySelector("#padStatus").textContent'), /already show PlayStation/);
    assert.match(await evaluate('document.querySelector("#padKeys").textContent'), /✕|○/);
    // Choose Xbox: layout, logos and the warning about what games get.
    await evaluate('document.querySelector("[data-pad=xbox]").click()');
    await waitFor('S.controllerType === "xbox" && document.querySelector("#padDiagramTitle").textContent.startsWith("Xbox")');
    assert.equal(await evaluate('document.querySelector("#padSvg .pad-sym") === null'), true);
    assert.match(await evaluate('document.querySelector("#padStatus").textContent'), /games show PlayStation logos/);
    assert.match(await evaluate('document.querySelector("#padKeys").textContent'), /LT/);
    assert.equal(await evaluate('document.querySelector("[data-pad=xbox]").classList.contains("on")'), true);
    // Choice survives a reload of the settings.
    assert.equal((await evaluate('ff.settings()')).controllerType, 'xbox');
    await evaluate('document.querySelector("[data-pad=playstation]").click()');
    await waitFor('S.controllerType === "playstation" && document.querySelector("#padDiagramTitle").textContent.startsWith("PlayStation")');
    assert.match(await evaluate('document.querySelector("#padStatus").textContent'), /already show PlayStation/);
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
