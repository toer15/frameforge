const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('FPS limiter setting installs RTSS in demo, clamps the number and keeps it in settings.json', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-fplimit-ui-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoFix: false, autoCheckUpdates: false, tempMonitor: false }));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
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
    assert.equal(await evaluate('document.querySelector("[data-key=fpsLimitOn]").checked'), false);
    assert.equal(await evaluate('ff.limiter.status().then((s) => s.installed)'), false);
    await evaluate('(() => { const n = document.querySelector("[data-key=fpsLimit]"); n.value = "144"; n.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitFor('S.fpsLimit === 144');
    await evaluate('(() => { const c = document.querySelector("[data-key=fpsLimitOn]"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitFor('S.fpsLimitOn === true');
    const on = await evaluate('ff.limiter.status()');
    assert.deepEqual([on.installed, on.running, on.limit, on.on, on.fps], [true, true, 144, true, 144]);
    await evaluate('(() => { const n = document.querySelector("[data-key=fpsLimit]"); n.value = "5"; n.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitFor('S.fpsLimit === 20');
    assert.equal((await evaluate('ff.limiter.status()')).limit, 20);
    await evaluate('(() => { const c = document.querySelector("[data-key=fpsLimitOn]"); c.checked = false; c.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await waitFor('S.fpsLimitOn === false');
    assert.equal((await evaluate('ff.limiter.status()')).limit, 0);
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
