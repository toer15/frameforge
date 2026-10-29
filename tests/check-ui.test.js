const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

// Set FRAMEFORGE_TEST_SHOW=1 to watch the window; screenshots go next to the test data either way.
test('Quick check runs junk, programs and virus steps; startup switch and Close it work', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-check-ui-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' }; // the Cleaner seeds harmless sample files under userData
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.FRAMEFORGE_CLEAN_SANDBOX;
  const args = ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`];
  if (!process.env.FRAMEFORGE_TEST_SHOW) args.push('--hidden');
  const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), args, { cwd: repo, env, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  let socket;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    let page;
    for (let i = 0; i < 150; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.url.endsWith('/index.html')); } catch {}
      if (page) break;
      if (child.exitCode !== null) throw Error(`App exited: ${stderr}`);
      await delay(100);
    }
    assert.ok(page, `Main window not available: ${stderr}`);
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
    let id = 0;
    const pending = new Map();
    const exceptions = [];
    socket.addEventListener('message', ({ data }) => {
      const ev = JSON.parse(data);
      if (ev.method === 'Runtime.exceptionThrown') exceptions.push(ev.params.exceptionDetails.exception?.description || ev.params.exceptionDetails.text);
      if (pending.has(ev.id)) { pending.get(ev.id)(ev); pending.delete(ev.id); }
    });
    const command = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
      const r = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.error || r.result.exceptionDetails) throw Error(JSON.stringify(r));
      return r.result.result.value;
    };
    const shot = async (name) => {
      const r = await command('Page.captureScreenshot', { format: 'png' });
      if (r.result && r.result.data) fs.writeFileSync(path.join(userData, name), Buffer.from(r.result.data, 'base64'));
    };
    await command('Runtime.enable');
    for (let i = 0; i < 100; i++) {
      if (await evaluate('typeof INFO !== "undefined" && !!INFO')) break;
      await delay(100);
    }

    // Open the tab (it scans junk by itself), wait, then start a quick check.
    await evaluate(`document.querySelector('.nav-item[data-view="clean"]').click()`);
    await evaluate(`(async () => { for (let i = 0; i < 300 && (clBusy || !CL); i++) await new Promise(r => setTimeout(r, 100)); })()`);
    const cards = await evaluate(`({ quick: document.querySelector('#ckEstQuick').textContent, full: document.querySelector('#ckEstFull').textContent, n: document.querySelectorAll('[data-check]').length })`);
    assert.equal(cards.n, 2);
    assert.match(cards.quick, /about/);
    await evaluate(`document.querySelector('[data-check="quick"]').click()`);
    const mid = await evaluate(`(async () => {
      for (let i = 0; i < 200 && CK.step !== 'virus'; i++) await new Promise(r => setTimeout(r, 100));
      for (let i = 0; i < 100 && !VIRUS.running; i++) await new Promise(r => setTimeout(r, 100));
      return { step: CK.step, steps: { ...CK.steps }, cardsDisabled: document.querySelector('[data-check="full"]').disabled, stepsShown: !document.querySelector('#ckSteps').classList.contains('hidden'), stop: !document.querySelector('#ckStop').classList.contains('hidden') };
    })()`);
    assert.equal(mid.step, 'virus');
    assert.deepEqual(mid.steps, { junk: 'done', programs: 'done', virus: 'running' });
    assert.equal(mid.cardsDisabled, true, 'no second check while one runs');
    assert.equal(mid.stepsShown, true);
    assert.equal(mid.stop, true);
    await delay(3000);
    await shot('check-running.png');
    const done = await evaluate(`(async () => {
      for (let i = 0; i < 600 && CK.step; i++) await new Promise(r => setTimeout(r, 100));
      return { step: CK.step, steps: { ...CK.steps }, title: document.querySelector('#ckTitle').textContent, virus: document.querySelector('#ckVirus').textContent,
        results: !document.querySelector('#scanModal').classList.contains('hidden'), open: VIRUS.done && VIRUS.done.open,
        startup: [...document.querySelectorAll('[data-pgstart]')].map(b => b.closest('.cl-item').querySelector('h3').textContent),
        heavy: [...document.querySelectorAll('[data-hvclose]')].length, junk: document.querySelectorAll('#clGroups .cl-item').length };
    })()`);
    assert.equal(done.step, null);
    assert.deepEqual(done.steps, { junk: 'done', programs: 'done', virus: 'found' });
    assert.match(done.title, /Quick check — finished/);
    assert.ok(done.open > 0, 'the demo virus scan finds threats');
    assert.match(done.virus, /to remove/);
    assert.equal(done.results, true, 'the results window opens to remove them');
    assert.ok(done.startup.some((t) => /Discord/.test(t)));
    assert.ok(done.heavy >= 1);
    assert.ok(done.junk > 3);
    await evaluate(`document.querySelector('#resLater').click()`);
    await shot('check-done.png');

    // Switch Discord off at startup, then close the heaviest program.
    const sw = await evaluate(`(async () => {
      const box = [...document.querySelectorAll('[data-pgstart]')].find(b => /Discord/.test(b.closest('.cl-item').textContent));
      box.click();
      for (let i = 0; i < 50 && PG.startup.find(s => s.name === 'Discord').on; i++) await new Promise(r => setTimeout(r, 100));
      const changes = JSON.stringify(await ff.changes());
      const row = [...document.querySelectorAll('[data-pgstart]')].find(b => /Discord/.test(b.closest('.cl-item').textContent));
      return { on: PG.startup.find(s => s.name === 'Discord').on, checked: row.checked, logged: changes.includes('Discord no longer starts with Windows') };
    })()`);
    assert.deepEqual(sw, { on: false, checked: false, logged: true });
    const closed = await evaluate(`(async () => {
      const before = PG.heavy.length;
      document.querySelector('[data-hvclose]').click();
      const modal = !document.querySelector('#hvModal').classList.contains('hidden');
      const text = document.querySelector('#hvText').textContent;
      document.querySelector('#hvYes').click();
      for (let i = 0; i < 50 && PG.heavy.length === before; i++) await new Promise(r => setTimeout(r, 100));
      return { modal, text, before, after: PG.heavy.length };
    })()`);
    assert.equal(closed.modal, true);
    assert.match(closed.text, /unsaved/);
    assert.equal(closed.after, closed.before - 1);
    await evaluate(`document.querySelector('#ckVirus').scrollIntoView()`);
    await delay(300);
    await shot('check-programs.png');
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
  }
});
