const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('update startup shows an actual Windows window even when launched hidden', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const repo = path.resolve(__dirname, '..');
  for (const kind of ['hidden', 'updated-flag', 'updated-hidden-launcher', 'handoff']) {
    const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-window-test-'));
    if (kind === 'handoff') fs.writeFileSync(path.join(dir, 'update-relaunch.json'), JSON.stringify({ version: require('../package.json').version, at: Date.now() }));
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    const env = { ...process.env, FRAMEFORGE_DEMO: '1' };
    delete env.ELECTRON_RUN_AS_NODE;
    const args = ['.', `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, '--hidden'];
    if (kind.startsWith('updated')) args.push('--updated');
    const child = spawn(path.join(repo, 'node_modules/electron/dist/electron.exe'), args, { cwd: repo, env, windowsHide: kind === 'updated-hidden-launcher' });
    child.stdout.resume();
    child.stderr.resume();
    try {
      let ready = false;
      for (let i = 0; i < 100; i++) {
        try { ready = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).some((p) => p.url.endsWith('/index.html')); } catch {}
        if (ready) break;
        if (child.exitCode !== null) throw Error('Demo app exited before opening its window');
        await delay(100);
      }
      assert.equal(ready, true);
      const script = `Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class FFUpdateWindowTest {
  delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(Callback c, IntPtr p);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  public static string Inspect(uint target) {
    string result = "missing";
    EnumWindows(delegate(IntPtr h, IntPtr unused) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      var title = new StringBuilder(512); GetWindowText(h, title, 512);
      if (pid == target && title.ToString() == "FrameForge") result = IsWindowVisible(h) && !IsIconic(h) ? "visible" : "hidden";
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
'@
[FFUpdateWindowTest]::Inspect(${child.pid})`;
      let result;
      for (let i = 0; i < 8; i++) {
        result = (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })).stdout.trim();
        if (result === (kind === 'hidden' ? 'hidden' : 'visible')) break;
        await delay(150);
      }
      assert.equal(result, kind === 'hidden' ? 'hidden' : 'visible', kind);
      if (kind === 'handoff') assert.equal(fs.existsSync(path.join(dir, 'update-relaunch.json')), false);
    } finally {
      child.kill();
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve));
    }
  }
});
