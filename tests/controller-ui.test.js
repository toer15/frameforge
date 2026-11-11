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
    // Deadzone sliders: changing one saves the value and grows that stick's yellow shape at once.
    assert.equal(await evaluate('document.querySelector("#padDzL").value'), '8');
    const ring = (side) => evaluate(`Number(document.querySelector(".pad-deadzone[data-dz=${side}]").getAttribute("data-r"))`);
    const dzPath = () => evaluate('document.querySelector(".pad-deadzone[data-dz=l]").getAttribute("d")');
    const leftBefore = await ring('l');
    await evaluate('(() => { const s = document.querySelector("#padDzL"); s.value = "20"; s.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await delay(400);
    assert.equal((await evaluate('ff.settings()')).padDeadzoneL, 20);
    assert.ok((await ring('l')) > leftBefore + 2, `left shape ${await ring('l')} vs ${leftBefore}`);
    assert.equal(await evaluate('document.querySelector("#padDzLVal").textContent'), '20%');
    assert.match(await evaluate('document.querySelector("#padReadout").textContent'), /deadzone 20%/);
    // The deadzone shape dropdown controls both the saved shape and the yellow graphic on the stick.
    assert.equal(await evaluate('document.querySelector("#padDzShape").value'), 'square');
    const squarePath = await dzPath();
    assert.match(squarePath, /H/);
    assert.equal(await evaluate('document.querySelector(".pad-deadzone[data-dz=l]").getAttribute("data-shape")'), 'square');
    await evaluate('(() => { const s = document.querySelector("#padDzShape"); s.value = "cross"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await delay(400);
    assert.equal((await evaluate('ff.settings()')).padDeadzoneShape, 'cross');
    assert.equal(await evaluate('document.querySelector(".pad-deadzone[data-dz=l]").getAttribute("data-shape")'), 'cross');
    assert.notEqual(await dzPath(), squarePath);
    await evaluate('(() => { const s = document.querySelector("#padDzShape"); s.value = "circle"; s.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await delay(400);
    assert.equal((await evaluate('ff.settings()')).padDeadzoneShape, 'circle');
    assert.match(await dzPath(), /a/);
    assert.equal(await evaluate('document.querySelectorAll("#padStage .pad-trig").length'), 2);
    assert.match(await evaluate('[...document.querySelectorAll("#padStage .pad-trig-text")].map((t) => t.textContent).join(",")'), /L2 0%/);
    // The animated graph exists for both sticks and follows each cubic slider separately.
    assert.ok(await evaluate('document.querySelector("#padCurvePathL").getAttribute("d").startsWith("M")'));
    assert.ok(await evaluate('document.querySelector("#padCurvePathR").getAttribute("d").startsWith("M")'));
    await evaluate('(() => { const s = document.querySelector("#padCurveL"); s.value = "30"; s.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await evaluate('(() => { const s = document.querySelector("#padCurveR"); s.value = "85"; s.dispatchEvent(new Event("input", { bubbles: true })); })()');
    await delay(400);
    const tuned = await evaluate('ff.settings()');
    assert.equal(tuned.padCurveL, 30);
    assert.equal(tuned.padCurveR, 85);
    assert.equal(await evaluate('document.querySelector("#padCurveLVal").textContent'), '30%');
    assert.equal(await evaluate('document.querySelector("#padCurveRVal").textContent'), '85%');
    assert.match(await evaluate('document.querySelector("#padCurveCaption").textContent'), /Left: \d+% cubic · Right: \d+% cubic/);
    await pick('auto');
    assert.deepEqual(exceptions, []);
  } finally {
    if (socket) socket.close();
    child.kill();
    if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
  }
});
