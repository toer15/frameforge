const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('red uninstall button sits beside installed badge, removes the chosen model and allows reinstall', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-uninstall-ui-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoFix: false, autoCheckUpdates: false, tempMonitor: false }));
  fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ messages: [{ role: 'user', content: 'Keep my chat history' }] }));
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
    await waitFor('typeof AI !== "undefined" && !!AI && typeof S !== "undefined" && !!S');
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").classList.contains("hidden")'), true);
    await evaluate('ff.setSettings({aiProvider:"ollama",ollamaModel:"llama3.2"}).then(() => refreshAi())');
    await evaluate('document.querySelector("#aiInstallBtn").click()');
    await waitFor('!aiInstalling && LOCAL && LOCAL.ready');
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").previousElementSibling.id'), 'aiReadyChip');
    assert.equal(await evaluate('getComputedStyle(document.querySelector("#aiUninstallBtn")).color'), 'rgb(255, 51, 51)');
    await evaluate('ff.ai.install("qwen2.5").then(() => ff.setSettings({ollamaModel:"llama3.2"})).then(() => refreshAi())');
    await evaluate('setAiBusy(true)');
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").disabled'), true);
    await evaluate('setAiBusy(false)');
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").disabled'), false);
    const beforeChat = fs.readFileSync(path.join(dir, 'chat.json'), 'utf8');
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").click(); document.querySelector("#aiUninstallBtn").disabled && document.querySelector("#aiUninstallBtn").textContent === "Uninstalling…"'), true);
    await waitFor('!aiUninstalling && LOCAL && !LOCAL.ready');
    const state = await evaluate('ff.ai.local({start:false})');
    assert.equal(state.models.includes('llama3.2:latest'), false);
    assert.equal(state.models.includes('qwen2.5:latest'), true);
    assert.equal(state.installed, true);
    assert.equal(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8'), beforeChat);
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").classList.contains("hidden")'), true);
    assert.equal(await evaluate('document.querySelector("#aiReadyChip").classList.contains("hidden")'), true);
    assert.equal(await evaluate('document.querySelector("#aiInstallBtn").classList.contains("hidden")'), false);
    await evaluate('document.querySelector("#aiInstallBtn").click()');
    await waitFor('!aiInstalling && LOCAL && LOCAL.ready');
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").classList.contains("hidden")'), false);
    await evaluate('ff.setSettings({aiProvider:"claude"}).then(() => refreshAi())');
    assert.equal(await evaluate('document.querySelector("#aiUninstallBtn").classList.contains("hidden")'), true);
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
