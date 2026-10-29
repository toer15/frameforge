const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

// The real (not demo) code, pointed at a scratch HKCU key instead of Windows' real startup keys.
const KEY = `Software\\FrameForgeTest-${process.pid}`;
process.env.FRAMEFORGE_STARTUP_TEST_ROOT = `HKCU:\\${KEY}`;
delete process.env.FRAMEFORGE_DEMO;
const startup = require('../src/startup');

const reg = (...args) => execFileSync('reg', args, { encoding: 'utf8', windowsHide: true });
const approved = (name) => {
  try {
    const out = reg('query', `HKCU\\${KEY}\\StartupApproved\\Run`, '/v', name);
    return (out.match(/REG_BINARY\s+([0-9A-F]+)/i) || [])[1] || null;
  } catch {
    return null;
  }
};

test('startup switch really writes Windows’ StartupApproved, keeps it off and closes the running app', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-startup-'));
  const exe = path.join(dir, 'ff-test-app.exe');
  fs.copyFileSync(path.join(process.env.WINDIR, 'System32', 'PING.EXE'), exe); // a harmless program to "start with Windows"
  const NAME = 'FF Test App';
  reg('add', `HKCU\\${KEY}\\Run`, '/v', NAME, '/t', 'REG_SZ', '/d', `"${exe}" -n 60 127.0.0.1`, '/f');
  const proc = spawn(exe, ['-n', '60', '127.0.0.1'], { windowsHide: true });
  try {
    let r = await startup.check();
    let it = r.startup.find((s) => s.rawName === NAME);
    assert.ok(it, 'listed');
    assert.equal(it.on, true, 'no StartupApproved value = on');
    assert.equal(it.running, true, 'its process is found');

    const off = await startup.set(it.id, false);
    assert.equal(off.ok, true, off.message);
    assert.equal(off.state, 3);
    const bytes = approved(NAME);
    assert.match(bytes, /^03000000[0-9A-F]{16}$/i, 'Task Manager’s format: 03 + the time it was switched off');
    assert.notEqual(bytes.slice(8), '0000000000000000');
    assert.equal(off.running, true, 'it says the app is still open');
    r = await startup.check();
    assert.equal(r.startup.find((s) => s.rawName === NAME).on, false, 'reads back as off');

    // The app switches itself back on; FrameForge puts the user's choice back.
    reg('add', `HKCU\\${KEY}\\StartupApproved\\Run`, '/v', NAME, '/t', 'REG_BINARY', '/d', '020000000000000000000000', '/f');
    const choices = { [it.id]: { src: it.src, rawName: NAME, name: it.name } };
    const kept = await startup.enforce(choices);
    assert.deepEqual(kept.fixed, [it.id]);
    assert.match(approved(NAME), /^03/);
    assert.deepEqual((await startup.enforce(choices)).fixed, [], 'nothing to do when it is already off');

    // Close it now: the running copy stops.
    const closed = await startup.closeStartup(it.id);
    assert.equal(closed.ok, true, closed.message);
    for (let i = 0; i < 30 && proc.exitCode === null && proc.signalCode === null; i++) await new Promise((res) => setTimeout(res, 100));
    assert.ok(proc.exitCode !== null || proc.signalCode !== null, 'the process was stopped');

    const on = await startup.set(it.id, true);
    assert.equal(on.ok, true, on.message);
    assert.equal(approved(NAME), '020000000000000000000000');

    // Uninstalled (its Run value is gone): nothing left to keep off.
    reg('delete', `HKCU\\${KEY}\\Run`, '/v', NAME, '/f');
    assert.deepEqual((await startup.enforce(choices)).gone, [it.id]);
  } finally {
    proc.kill();
    try { reg('delete', `HKCU\\${KEY}`, '/f'); } catch {}
  }
});
