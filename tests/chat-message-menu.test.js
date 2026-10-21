const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');

test('user message menu edits, cancels, deletes and persists; next reply receives revised history', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-chat-ui-'));
  const requests = [];
  let heldResponse;
  const model = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    if (req.url !== '/api/chat') { res.writeHead(404); res.end(); return; }
    requests.push(JSON.parse(body));
    if (requests.length === 1) {
      heldResponse = res;
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Fixture reply' }, done: false }) + '\n');
    } else { res.writeHead(503); res.end('Fixture failure'); }
  });
  await new Promise((resolve) => model.listen(0, '127.0.0.1', resolve));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ aiProvider: 'ollama', ollamaUrl: `http://127.0.0.1:${model.address().port}`, ollamaModel: 'fixture', autoFix: false, autoCheckUpdates: false, tempMonitor: false }));
  fs.writeFileSync(path.join(dir, 'chat.json'), JSON.stringify({ messages: [
    { role: 'user', content: 'First question' }, { role: 'assistant', content: 'First answer' },
    { role: 'user', content: [{ type: 'text', text: 'Second question' }] }, { role: 'assistant', content: 'Second answer' },
  ] }));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--hidden'], { cwd: repo, env, windowsHide: true });
  let stderr = '';
  child.stdout.resume(); child.stderr.on('data', (data) => { stderr += data; });
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let socket;
  try {
    let page;
    for (let i = 0; i < 100; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.url.endsWith('/index.html')); } catch {}
      if (page) break;
      if (child.exitCode !== null) throw Error('App exited before loading chat');
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
    await command('Runtime.enable');
    const waitFor = async (expression) => {
      for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(50); }
      throw Error(`Timed out: ${expression}; ${JSON.stringify(await evaluate('({aiBusy, pending:!!pendingUserBubble, changing:chatChanging, log:document.querySelector("#chatLog").textContent, toast:document.querySelector("#toast").textContent})'))}; ${stderr}`);
    };
    await waitFor('typeof INFO !== "undefined" && !!INFO && document.querySelectorAll(".user-message").length === 2');
    assert.equal(await evaluate('document.querySelectorAll(".msg.assistant .msg-menu").length'), 0);
    await evaluate('window.firstId = document.querySelector(".user-message").dataset.messageId; document.querySelector(".msg-menu summary").click()');
    assert.equal(await evaluate('document.querySelector(".msg-menu").open'), true);
    await evaluate('document.body.click()');
    assert.equal(await evaluate('document.querySelector(".msg-menu").open'), false);
    await evaluate('document.querySelector("[data-chat-edit]").click(); document.querySelector(".msg-edit-input").value = "Cancelled text"; document.querySelector("[data-chat-cancel]").click()');
    assert.equal(await evaluate('document.querySelector(".msg-text").textContent'), 'First question');
    await evaluate('document.querySelector("[data-chat-edit]").click(); document.querySelector(".msg-edit-input").value = "   "; document.querySelector("[data-chat-save]").click()');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8')).messages[0].content, 'First question');
    const edited = 'Edited <b>plain text</b>\nSecond line';
    await evaluate(`document.querySelector('.msg-edit-input').value = ${JSON.stringify(edited)}; document.querySelector('[data-chat-save]').click()`);
    await waitFor('!chatChanging && !document.querySelector(".msg-edit-input")');
    assert.equal(await evaluate('document.querySelector(".msg-text").textContent'), edited);
    assert.equal(await evaluate('document.querySelector(".msg-text b")'), null);
    await evaluate('loadChatHistory()');
    assert.equal(await evaluate('document.querySelector(".msg-text").textContent'), edited);
    await evaluate('document.querySelectorAll("[data-chat-delete]")[1].click()');
    await waitFor('!chatChanging && document.querySelectorAll(".user-message").length === 1');
    assert.equal(await evaluate('document.querySelectorAll(".msg.assistant").length'), 2);
    assert.equal(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8').includes('Second question'), false);
    await evaluate('loadChatHistory()');
    assert.equal(await evaluate('document.querySelectorAll(".user-message").length'), 1);
    await evaluate('window.sendPromise = sendChat("Follow-up question"); undefined');
    await waitFor('aiBusy && document.querySelectorAll(".user-message").length === 2');
    for (let i = 0; i < 100 && !heldResponse; i++) await delay(50);
    assert.ok(heldResponse, 'Local fixture should receive the next chat request');
    assert.equal(requests[0].messages.some((m) => m.content === edited), true);
    assert.equal(JSON.stringify(requests[0]).includes('Second question'), false);
    assert.equal(requests[0].messages.some((m) => 'id' in m || 'deleted' in m), false);
    assert.equal((await evaluate('ff.ai.edit(window.firstId, "Blocked")')).ok, false);
    assert.equal((await evaluate('ff.ai.delete(window.firstId)')).ok, false);
    await evaluate('document.querySelector(".msg-menu summary").click()');
    assert.equal(await evaluate('document.querySelector(".msg-menu").open'), false);
    heldResponse.end(JSON.stringify({ done: true }) + '\n');
    await evaluate('window.sendPromise');
    assert.equal(await evaluate('document.querySelectorAll(".user-message")[1].dataset.messageId.length > 0'), true);
    assert.equal(await evaluate('document.querySelectorAll(".msg-menu summary")[1].getAttribute("aria-disabled")'), 'false');
    await evaluate('sendChat("Failed request question")');
    assert.equal(await evaluate('document.querySelectorAll(".user-message").length'), 3);
    assert.equal(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8').includes('Failed request question'), true);
    await evaluate('document.querySelectorAll("[data-chat-edit]")[2].click(); document.querySelector(".msg-edit-input").value = "Revised after failure"; document.querySelector("[data-chat-save]").click()');
    await waitFor('!chatChanging && !document.querySelector(".msg-edit-input")');
    assert.equal(fs.readFileSync(path.join(dir, 'chat.json'), 'utf8').includes('Revised after failure'), true);
    assert.deepEqual(exceptions, []);
  } finally {
    if (heldResponse && !heldResponse.writableEnded) heldResponse.end();
    if (socket) socket.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    model.closeAllConnections();
    await new Promise((resolve) => model.close(resolve));
  }
});
