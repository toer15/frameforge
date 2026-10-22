const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('Controller tab: dropdown of controllers, each drawn with its own buttons, live readout and motion controls', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
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
    await waitFor('document.querySelector("#padConnected .pad-dev") && document.querySelector("#padStage .pad-part")');
    assert.match(await evaluate('document.querySelector("#padAutoSub").textContent'), /Showing: (DualSense|DualSense Edge)/);
    const pick = async (v) => {
      await evaluate(`(() => { const s = document.querySelector("#padModel"); s.value = "${v}"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
      await waitFor(`S.controllerType === "${v}"`);
      await delay(100);
    };
    const title = () => evaluate('document.querySelector("#padDiagramTitle").textContent');
    const keys = () => evaluate('[...document.querySelectorAll("#padStage .pad-key title")].map((t) => t.textContent).join(",")');
    await pick('switch-pro');
    assert.equal(await title(), 'Switch Pro Controller');
    assert.match(await keys(), /ZL.*ZR|ZR.*ZL/);
    assert.match(await keys(), /Home/);
    assert.equal(await evaluate('document.querySelector("#padRecenter").classList.contains("hidden")'), false);
    await pick('joycon-pair');
    assert.equal(await evaluate('document.querySelectorAll("#padStage .pad-part").length'), 2);
    assert.match(await keys(), /SL/);
    await pick('xbox-elite2');
    assert.equal(await title(), 'Xbox Elite Series 2');
    assert.match(await keys(), /LT/);
    assert.equal(await evaluate('document.querySelector("#padRecenter").classList.contains("hidden")'), true);
    assert.match(await evaluate('document.querySelector("#padKeys").textContent'), /RT/);
    await pick('dualshock4');
    assert.match(await keys(), /Share/);
    assert.match(await evaluate('document.querySelector("#padKeys").textContent'), /✕/);
    assert.equal((await evaluate('ff.settings()')).controllerType, 'dualshock4');
    assert.match(await evaluate('document.querySelector("#padReadout").textContent'), /Left stick/);
    await pick('auto');
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
