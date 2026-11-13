const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

// The real app in demo mode: the FPS counter switch lives on the FPS limiter tab, the overlay studio changes the
// real overlay window, and that window is resized to fit whatever it draws.
test('overlay studio on the FPS limiter tab drives the real overlay window', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-overlay-ui-'));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ autoFix: false, autoCheckUpdates: false, tempMonitor: false, fpsCounter: false }));
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--hidden'], { cwd: repo, env, windowsHide: true });
  child.stdout.resume(); child.stderr.resume();
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sockets = [];
  const attach = async (suffix, tries = 100) => {
    let page;
    for (let i = 0; i < tries; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((p) => p.url.endsWith(suffix)); } catch {}
      if (page) break;
      if (child.exitCode !== null) throw Error('Demo app exited');
      await delay(100);
    }
    if (!page) return null;
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    sockets.push(socket);
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
    return { evaluate, waitFor, exceptions };
  };
  try {
    const app = await attach('/index.html');
    assert.ok(app);
    await app.waitFor('typeof S !== "undefined" && !!S');

    // The switches moved: FPS limiter tab has them, Settings points there.
    for (const key of ['fpsCounter', 'tempMonitor', 'overlayHotkey']) {
      assert.equal(await app.evaluate(`!!document.querySelector('#view-settings [data-key=${key}]')`), false, `${key} left Settings`);
      assert.equal(await app.evaluate(`document.querySelectorAll('#view-limiter [data-key=${key}]').length`), 1, `${key} is on the FPS limiter tab`);
    }
    await app.evaluate('document.querySelector("#view-settings [data-goto=limiter]").click()');
    await app.waitFor('!document.querySelector("#view-limiter").classList.contains("hidden")');

    // Both switches off: no overlay window, and the preview says why it is empty.
    assert.equal(await attach('/overlay.html', 5), null);
    await app.waitFor('/overlay is off/.test(document.querySelector("#ovNote").textContent)');

    // FPS counter on → the real overlay window appears and fits its drawing exactly.
    await app.evaluate('(() => { const c = document.querySelector("#view-limiter [data-key=fpsCounter]"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await app.waitFor('S.fpsCounter === true');
    const ov = await attach('/overlay.html');
    assert.ok(ov, 'overlay window opened');
    const fits = 'JSON.stringify((() => { const r = document.getElementById("wrap").getBoundingClientRect(); return [Math.ceil(r.width) - innerWidth, Math.ceil(r.height) - innerHeight, r.width > 100, r.height > 30]; })())';
    // On failure, say what the window and its content actually measured.
    const mustFit = async (when) => {
      let seen;
      for (let i = 0; i < 200; i++) {
        seen = await ov.evaluate(fits);
        if (seen === '[0,0,true,true]') return;
        await delay(50);
      }
      const detail = await ov.evaluate('JSON.stringify((() => { const r = document.getElementById("wrap").getBoundingClientRect(); return { content: [r.width, r.height], inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], dpr: devicePixelRatio }; })())');
      assert.fail(`${when}: the overlay window does not fit its drawing: ${detail}`);
    };
    await ov.waitFor('!!document.querySelector(".ffo-panel .ffo-num b") && /^\\d+$/.test(document.querySelector(".ffo-panel .ffo-num b").textContent)');
    await mustFit('FPS only');
    await app.waitFor('!!document.querySelector("#ovPreview .ffo-panel")');
    assert.equal(await ov.evaluate('!!document.querySelector(".ffo-rows")'), false, 'hardware readings are off, so only FPS shows');

    // Hardware on, List style: preview and real overlay both follow, and the window is resized again.
    await app.evaluate('(() => { const c = document.querySelector("#view-limiter [data-key=tempMonitor]"); c.checked = true; c.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await app.waitFor('S.tempMonitor === true');
    await app.evaluate('document.querySelector(\'[data-ov=overlayStyle] [data-val=list]\').click()');
    await app.waitFor('S.overlayStyle === "list" && !!document.querySelector("#ovPreview .ffo-list")');
    await ov.waitFor('document.querySelectorAll(".ffo-list .ffo-line").length >= 8');
    await mustFit('List style');
    const lines = await ov.evaluate('[...document.querySelectorAll(".ffo-line i")].map((e) => e.textContent).join("|")');
    assert.match(lines, /^FPS\|1% low\|Frame time\|GPU temp\|GPU load\|GPU memory\|GPU power\|GPU fan\|CPU temp\|CPU load\|RAM$/);

    // One chip off, one on.
    await app.evaluate('document.querySelector("[data-ov-item=gpuFan]").click()');
    await app.waitFor('!S.overlayItems.includes("gpuFan")');
    await app.evaluate('document.querySelector("[data-ov-item=gpuClock]").click()');
    await app.waitFor('S.overlayItems.includes("gpuClock")');
    await ov.waitFor('(() => { const t = [...document.querySelectorAll(".ffo-line i")].map((e) => e.textContent); return !t.includes("GPU fan") && t.includes("GPU clock"); })()');

    // Colour, size, corner, position: stored clean and applied to the real overlay.
    await app.evaluate('document.querySelector(\'[data-ov-accent="#3fd8ff"]\').click()');
    await app.evaluate('document.querySelector(\'[data-ov=overlayCorner] [data-val=round]\').click()');
    await app.evaluate('document.querySelector(\'[data-ov=overlayPosition] [data-val=bottom-right]\').click()');
    await app.evaluate('(() => { const r = document.querySelector("[data-ov-range=overlayScale]"); r.value = "150"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); })()');
    await app.waitFor('S.overlayAccent === "#3fd8ff" && S.overlayCorner === "round" && S.overlayPosition === "bottom-right" && S.overlayScale === 150');
    await ov.waitFor('(() => { const e = document.querySelector(".ffo"); return !!e && e.classList.contains("ffo-corner-round") && e.style.getPropertyValue("--ffo-accent") === "#3fd8ff" && e.style.zoom === "1.5"; })()');
    await mustFit('150% size');
    assert.equal(await app.evaluate('document.querySelector("#ovStage").dataset.pos'), 'bottom-right');
    assert.equal(await app.evaluate('document.querySelector("[data-ov-out=overlayScale]").textContent'), '150%');

    // Nonsense never reaches the file.
    const cleaned = await app.evaluate('ff.setSettings({ overlayScale: 99999, overlayAccent: "red", overlayStyle: "hologram", overlayItems: ["fps", "bogus"], overlayPosition: "middle" }).then((s) => JSON.stringify([s.overlayScale, s.overlayAccent, s.overlayStyle, s.overlayItems, s.overlayPosition]))');
    assert.equal(cleaned, '[200,"#ff6b2c","panel",["fps"],"top-left"]');

    // Reset puts the shipped look back, on disk too.
    await app.evaluate('document.querySelector("#ovResetBtn").click()');
    await app.waitFor('S.overlayStyle === "panel" && S.overlayScale === 100 && S.overlayItems.length === 14 && S.overlayCorner === "notch"');
    await ov.waitFor('!!document.querySelector(".ffo-panel.ffo-corner-notch")');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(saved.overlayStyle, 'panel');
    assert.equal(saved.fpsCounter, true);
    assert.deepEqual([...app.exceptions, ...ov.exceptions], []);
  } finally {
    for (const s of sockets) try { s.close(); } catch {}
    child.kill();
    await delay(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
