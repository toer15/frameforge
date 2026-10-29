const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

// Demo PC: C: NVMe SSD, D: hard drive, E: external SSD, F: USB stick (C:, D:, E: are folders of harmless sample files).
test('Full check covers every drive: SSD, hard drive, external drive and USB stick', { skip: process.platform !== 'win32', timeout: 150000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-full-ui-'));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
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
    await evaluate(`document.querySelector('.nav-item[data-view="clean"]').click()`);
    await evaluate(`(async () => { for (let i = 0; i < 300 && (clBusy || !CL || !DRV); i++) await new Promise(r => setTimeout(r, 100)); })()`);
    const before = await evaluate(`({ line: document.querySelector('#ckDrvLine').textContent, rows: [...document.querySelectorAll('#ckDrives .dv-item')].map(r => r.dataset.drive) })`);
    assert.deepEqual(before.rows, ['C:', 'D:', 'E:', 'F:']);
    for (const k of ['C: NVMe SSD', 'D: Hard drive (HDD)', 'E: External SSD', 'F: USB stick']) assert.ok(before.line.includes(k), `card names ${k}`);

    await evaluate(`document.querySelector('[data-check="full"]').click()`);
    const done = await evaluate(`(async () => {
      for (let i = 0; i < 1200 && CK.step !== null; i++) await new Promise(r => setTimeout(r, 100));
      const chips = {};
      for (const r of document.querySelectorAll('#ckDrives .dv-item')) chips[r.dataset.drive] = [...r.querySelectorAll('.dv-chk')].map(c => c.textContent);
      const big = CL.cats.find(c => c.id === 'big_files');
      return { mode: CL.mode, steps: { ...CK.steps }, chips, big: big.items.map(i => i.name).sort(), virusDrives: (VIRUS.done || {}).drives, step1: document.querySelector('[data-step="junk"] small').textContent };
    })()`);
    assert.equal(done.mode, 'full');
    assert.equal(done.steps.junk, 'done');
    assert.equal(done.steps.programs, 'done');
    assert.ok(['done', 'found'].includes(done.steps.virus));
    assert.deepEqual(done.virusDrives, ['C:\\', 'D:\\', 'E:\\', 'F:\\'], 'the virus scan went through every drive, the USB stick too');
    for (const d of ['C:', 'D:', 'E:']) {
      assert.match(done.chips[d][0], /Big files: [\d,]+ files? looked at$/, `${d} looked through completely`);
      assert.equal(done.chips[d][1], 'Virus scan: every file');
    }
    assert.match(done.chips['F:'][0], /not on USB sticks/);
    assert.equal(done.chips['F:'][1], 'Virus scan: every file');
    assert.ok(done.big.includes('Gameplay 2025-12-24.mkv'), 'big file on the hard drive');
    assert.ok(done.big.includes('old-pc-image.vhdx'), 'big file on the external drive');
    assert.ok(!done.big.includes('data.pak'), 'a game’s own files are never listed');
    assert.match(done.step1, /drive\(s\) looked at/);
    await evaluate(`document.querySelector('#resLater') && document.querySelector('#resLater').click()`);
    await evaluate(`document.querySelector('#ckDrives').scrollIntoView()`);
    await delay(300);
    await shot('full-drives.png');
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
  }
});
