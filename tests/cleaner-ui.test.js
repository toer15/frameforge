const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { ageFiles } = require('../src/cleaner');

// Set FRAMEFORGE_TEST_SHOW=1 to watch the window; screenshots go next to the test data either way.
test('Cleaner tab scans, confirms and deletes only what was ticked', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-cleaner-ui-'));
  const sandbox = path.join(userData, 'pc');
  const home = path.join(sandbox, 'Users', 'Gamer');
  const local = path.join(home, 'AppData', 'Local');
  const P = {
    tmp: path.join(local, 'Temp', 'installer', 'setup.tmp'),
    tmpNew: path.join(local, 'Temp', 'fresh.tmp'),
    dump: path.join(local, 'CrashDumps', 'Game.exe.1.dmp'),
    chrome: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'Cache_Data', 'f_1'),
    history: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'History'),
    discord: path.join(home, 'AppData', 'Roaming', 'discord', 'Cache', 'Cache_Data', 'f_9'),
    shader: path.join(local, 'D3DSCache', 'abc', 'shader.idx'),
    setup: path.join(home, 'Downloads', 'OldGame-Setup.exe'),
    keepZip: path.join(home, 'Downloads', 'keep-me.zip'),
    clip: path.join(home, 'Videos', 'clip.mp4'),
  };
  for (const [k, p] of Object.entries(P)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(k === 'clip' ? 3 * 1024 * 1024 : 300 * 1024, 3));
  }
  await ageFiles(Object.entries(P).map(([k, p]) => ({ p, days: k === 'tmpNew' ? 0 : 45 })));

  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1', FRAMEFORGE_CLEAN_SANDBOX: sandbox, FRAMEFORGE_CLEAN_BIG: String(1024 * 1024), FRAMEFORGE_DEMO_RUNNING: 'discord.exe' };
  delete env.ELECTRON_RUN_AS_NODE;
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
    const waitIdle = () => evaluate(`(async () => { for (let i = 0; i < 300 && (clBusy || !CL); i++) await new Promise(r => setTimeout(r, 100)); return !clBusy && !!CL; })()`);
    await command('Runtime.enable');
    for (let i = 0; i < 100; i++) {
      if (await evaluate('typeof INFO !== "undefined" && !!INFO')) break;
      await delay(100);
    }

    // Opening the tab scans by itself.
    await evaluate(`document.querySelector('.nav-item[data-view="clean"]').click()`);
    assert.equal(await waitIdle(), true, 'scan finished');
    const ui = await evaluate(`({
      rows: [...document.querySelectorAll('#clGroups .cl-item')].map(r => r.dataset.clcat),
      checked: [...document.querySelectorAll('#clGroups [data-clpick]:checked')].map(b => b.dataset.clpick),
      discordDisabled: document.querySelector('[data-clpick="discord"]').disabled,
      discordTag: document.querySelector('[data-clcat="discord"] h3').textContent,
      files: [...document.querySelectorAll('[data-clfile]')].map(b => b.closest('.cl-file').querySelector('.cl-fn b').textContent),
      del: document.querySelector('#clDelete').textContent,
      disk: document.querySelector('#clDisk').textContent,
      visible: !document.querySelector('#view-clean').classList.contains('hidden'),
    })`);
    assert.equal(ui.visible, true);
    for (const c of ['temp_user', 'crash_dumps', 'chrome', 'discord', 'shaders', 'old_downloads', 'big_files']) assert.ok(ui.rows.includes(c), `${c} row shown`);
    assert.deepEqual(ui.checked.sort(), ['chrome', 'crash_dumps', 'temp_user']);
    assert.equal(ui.discordDisabled, true);
    assert.match(ui.discordTag, /App is open/);
    assert.deepEqual(ui.files.sort(), ['OldGame-Setup.exe', 'clip.mp4', 'keep-me.zip'].sort());
    assert.match(ui.del, /Delete selected \(\d/);
    assert.match(ui.disk, /free of/);
    await shot('cleaner-scanned.png');

    // "Select nothing" leaves nothing to delete; then tick safe items again plus one of the user's own files.
    const none = await evaluate(`(() => { document.querySelector('#clPickNone').click(); return document.querySelector('#clDelete').disabled; })()`);
    assert.equal(none, true);
    await evaluate(`(() => {
      document.querySelector('#clPickSafe').click();
      const box = [...document.querySelectorAll('[data-clfile]')].find(b => b.closest('.cl-file').textContent.includes('OldGame-Setup.exe'));
      box.click();
    })()`);
    const confirm = await evaluate(`(() => {
      document.querySelector('#clDelete').click();
      return { open: !document.querySelector('#clModal').classList.contains('hidden'), items: [...document.querySelectorAll('#clmList li')].map(li => li.textContent), text: document.querySelector('#clmText').textContent };
    })()`);
    assert.equal(confirm.open, true);
    assert.equal(confirm.items.length, 4);
    assert.match(confirm.text, /Recycle Bin/);
    await shot('cleaner-confirm.png');
    await evaluate(`(() => { const y = document.querySelector('#clmYes'); y.click(); y.click(); })()`); // a double click must not start twice
    assert.equal(await waitIdle(), true, 'delete finished');
    const done = await evaluate(`({ done: document.querySelector('#clDone').textContent, hidden: document.querySelector('#clDone').classList.contains('hidden'), modal: document.querySelector('#clModal').classList.contains('hidden') })`);
    assert.equal(done.hidden, false);
    assert.equal(done.modal, true);
    assert.match(done.done, /Freed \d/);
    assert.match(done.done, /Recycle Bin/);
    await shot('cleaner-done.png');

    for (const k of ['tmp', 'dump', 'chrome', 'setup']) assert.equal(fs.existsSync(P[k]), false, `${k} must be gone`);
    for (const k of ['tmpNew', 'history', 'discord', 'shader', 'keepZip', 'clip']) assert.equal(fs.existsSync(P[k]), true, `${k} must be kept`);
    const bin = path.join(sandbox, '$Recycle.Bin', 'S-1-5-21-0-0-0-1001');
    assert.equal(fs.readdirSync(bin).filter((n) => n.endsWith('.exe')).length, 1, 'the user file is in the (sandbox) Recycle Bin');
    const changes = await evaluate('ff.changes()');
    assert.ok(JSON.stringify(changes).includes('Cleaned junk files'), 'listed under What FrameForge changed');
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
  }
});
