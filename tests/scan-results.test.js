const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('Delete all immediately deletes only eligible threats, reports failures and permits retry', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const userData = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-scan-test-'));
  const item = (id, verdict, extra = {}) => {
    const file = path.join(userData, `${id}.txt`);
    fs.writeFileSync(file, 'Harmless FrameForge deletion test fixture.');
    return { id, file, verdict, status: 'active', source: 'scan', threat: `Fixture ${id}`, typeInfo: 'Harmless test fixture', reasons: ['UI deletion regression check'], actions: ['delete', 'quarantine', 'keep'], defaultAction: 'quarantine', ...extra };
  };
  const items = [
    item('real', 'real'), item('unsure', 'unsure'), item('pua', 'pua'), item('test', 'test'),
    item('fp', 'fp', { actions: ['delete', 'keep', 'allow'], defaultAction: 'allow' }),
    item('done', 'real', { done: 'quarantine', status: 'ffquarantined' }),
    item('defender', 'real', { source: 'defender', status: 'quarantined', actions: ['keepq', 'restore'], defaultAction: 'restore' }),
    item('failure', 'real'),
  ];
  const failurePath = items.find((i) => i.id === 'failure').file;
  fs.unlinkSync(failurePath);
  fs.mkdirSync(failurePath); // An empty directory deliberately makes the file-only delete fail.
  fs.writeFileSync(path.join(userData, 'scan-last.json'), JSON.stringify({ type: 'quick', endedAt: Date.now(), durationSec: 1, filesChecked: items.length, counts: {}, items }));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${port}`, '--hidden'], { cwd: repo, env, windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (data) => { stderr += data; });
  let socket;
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    let page;
    for (let i = 0; i < 100; i++) {
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
      const event = JSON.parse(data);
      if (event.method === 'Runtime.exceptionThrown') exceptions.push(event.params.exceptionDetails.text);
      if (pending.has(event.id)) { pending.get(event.id)(event); pending.delete(event.id); }
    });
    const command = (method, params = {}) => new Promise((resolve) => { pending.set(++id, resolve); socket.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => {
      const response = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (response.error || response.result.exceptionDetails) throw Error(JSON.stringify(response));
      return response.result.result.value;
    };
    await command('Runtime.enable');
    for (let i = 0; i < 100; i++) {
      if (await evaluate('typeof INFO !== "undefined" && !!INFO')) break;
      await delay(100);
    }
    await evaluate('openResults()');
    const deleteAll = async () => evaluate(`(async () => {
      const button = document.querySelector('[data-bulk="delete"]');
      button.click(); button.click(); // rapid repeat must not start a second batch
      for (let i = 0; i < 100 && applying; i++) await new Promise(r => setTimeout(r, 100));
      if (applying) throw Error('Delete all did not finish');
      return { results: await ff.scan.last(), plan: document.querySelector('#resPlan').textContent,
        error: document.querySelector('[data-ri="failure"] .ri-result')?.textContent,
        disabled: button.disabled };
    })()`);
    const first = await deleteAll();
    for (const id of ['real', 'unsure', 'pua', 'test']) {
      assert.equal(fs.existsSync(items.find((i) => i.id === id).file), false, `${id} must actually be deleted`);
      assert.equal(first.results.items.find((i) => i.id === id).done, 'delete');
    }
    for (const id of ['fp', 'done', 'defender', 'failure']) assert.equal(fs.existsSync(items.find((i) => i.id === id).file), true, `${id} must be preserved`);
    assert.equal(first.results.items.find((i) => i.id === 'fp').done, undefined);
    assert.equal(first.results.items.find((i) => i.id === 'defender').done, undefined);
    assert.match(first.plan, /1 failed/);
    assert.match(first.error, /Couldn.t delete/);
    assert.equal(first.disabled, false);
    fs.rmdirSync(failurePath); // only the empty directory created above
    fs.writeFileSync(failurePath, 'Harmless retry fixture');
    const retry = await deleteAll();
    assert.equal(fs.existsSync(failurePath), false);
    assert.equal(retry.results.items.find((i) => i.id === 'failure').done, 'delete');
    assert.match(retry.plan, /Done/);
    assert.equal(retry.disabled, true);
    // A stale request must not delete a new file created at a previously handled path.
    fs.writeFileSync(items[0].file, 'New harmless file at an old path');
    assert.equal((await evaluate('ff.scan.apply({real: "delete"})')).results.length, 0);
    assert.equal(fs.existsSync(items[0].file), true);
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
  }
});
