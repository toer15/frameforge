// Temporary probe: does the FPS limiter work against a real RTSS on real Windows?
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, ps } = require('../src/util');
const fplimit = require('../src/fplimit');
const log = (...a) => console.log(...a);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function measure(label) {
  // An Electron window drawing as fast as it can; it reports how many frames it drew each second.
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'ff-probe-'));
  fs.writeFileSync(path.join(dir, 'main.js'), `
    const { app, BrowserWindow } = require('electron');
    app.commandLine.appendSwitch('disable-frame-rate-limit');
    app.commandLine.appendSwitch('disable-gpu-vsync');
    app.whenReady().then(() => {
      const w = new BrowserWindow({ width: 640, height: 360, webPreferences: { backgroundThrottling: false } });
      w.loadFile('index.html');
      w.webContents.on('console-message', (_e, _l, m) => console.log(m));
      setTimeout(() => app.quit(), 14000);
    });`);
  fs.writeFileSync(path.join(dir, 'index.html'), `<canvas id=c width=600 height=300></canvas><script>
    const g = c.getContext('2d'); let n = 0, t0 = performance.now(), x = 0;
    function f() { n++; x = (x + 7) % 600; g.fillStyle = '#000'; g.fillRect(0,0,600,300); g.fillStyle = '#f60'; g.fillRect(x, 100, 60, 60);
      const t = performance.now(); if (t - t0 >= 1000) { console.log('FPS ' + Math.round(n * 1000 / (t - t0))); n = 0; t0 = t; } requestAnimationFrame(f); }
    requestAnimationFrame(f);</script>`);
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"probe","main":"main.js"}');
  const exe = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const out = [];
  await new Promise((res) => {
    const c = spawn(exe, [dir, '--no-sandbox'], { env });
    c.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => /FPS \d+/.test(l) && out.push(Number(l.match(/FPS (\d+)/)[1]))));
    c.stderr.resume();
    c.on('exit', res);
    setTimeout(() => c.kill(), 20000);
  });
  log(`${label}: frames per second each second = [${out.join(', ')}]`);
  return out;
}

(async () => {
  log('--- winget');
  const wv = await run('winget', ['--version']);
  log('winget --version:', wv.code, (wv.stdout || wv.stderr || '').trim().slice(0, 100));
  log('--- status before:', JSON.stringify(await fplimit.status()));
  const wi = await run('winget', ['install', '--id', fplimit.WINGET_ID, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'], { timeout: 15 * 60 * 1000 });
  log('winget install code:', wi.code, '\n', String(wi.stdout || '').split(/\r?\n/).filter((l) => l.trim() && !/^[\s\-\\|/█▒]+$/.test(l)).slice(-12).join('\n'), '\n', String(wi.stderr || '').slice(0, 400));
  const st = await fplimit.status();
  log('--- status after install:', JSON.stringify(st));
  for (const d of ['C:\\Program Files (x86)\\RivaTuner Statistics Server', 'C:\\Program Files\\RivaTuner Statistics Server']) log(d, fs.existsSync(d) ? fs.readdirSync(d).slice(0, 40).join(', ') : '(missing)');
  if (!st.installed) return log('RESULT: RTSS not installed — nothing more to test');

  const prof = path.join(st.dir, 'Profiles', 'Global');
  const showProf = (label) => log(label, fs.existsSync(prof) ? fs.readFileSync(prof, 'utf8').split(/\r?\n/).filter((l) => /^\[|Limit|Detection|Enable/i.test(l)).join(' | ') : '(missing)');
  log('ProfileTemplates:', fs.readdirSync(path.join(st.dir, 'ProfileTemplates')).filter((n) => /electron|chrome|global|^\./i.test(n)).join(', '), '| count', fs.readdirSync(path.join(st.dir, 'ProfileTemplates')).length);
  log('Profiles dir before start:', fs.existsSync(path.join(st.dir, 'Profiles')) ? fs.readdirSync(path.join(st.dir, 'Profiles')).join(', ') : '(missing)');
  // 1. start RTSS first, so it creates its profiles
  await ps(`Start-Process -FilePath '${path.join(st.dir, 'RTSS.exe')}' -WorkingDirectory '${st.dir}'`, { timeout: 20000 });
  for (let i = 0; i < 40 && !fs.existsSync(prof); i++) await delay(500);
  await delay(3000);
  log('RTSS process:', (await run('tasklist', ['/FI', 'IMAGENAME eq RTSS*', '/FO', 'CSV', '/NH'])).stdout.trim().replace(/\r?\n/g, ' ; '));
  log('Profiles dir after start:', fs.existsSync(path.join(st.dir, 'Profiles')) ? fs.readdirSync(path.join(st.dir, 'Profiles')).join(', ') : '(missing)');
  showProf('Global after first start:');
  const base = await measure('RTSS running, no limit');
  // 2. the hooks API, now that the profile exists
  const a = await fplimit.apply(30);
  log('--- apply(30) via hooks:', JSON.stringify(a), 'status:', JSON.stringify(await fplimit.status()));
  showProf('Global after hooks set:');
  await delay(3000);
  let capped = await measure('limit 30 (hooks API)');
  // 3. if that did not cap: write the profile file directly and restart RTSS
  if (!(capped.slice(3).every((f) => f <= 40))) {
    log('--- hooks API did not cap; writing the profile file directly');
    let txt = fs.existsSync(prof) ? fs.readFileSync(prof, 'utf8') : '';
    if (/^\[Framerate\]/m.test(txt)) {
      txt = /^Limit=.*$/m.test(txt) ? txt.replace(/^Limit=.*$/m, 'Limit=30') : txt.replace(/^\[Framerate\]\r?\n/m, '[Framerate]\r\nLimit=30\r\n');
    } else txt += '\r\n[Framerate]\r\nLimit=30\r\nLimitDenominator=1\r\n';
    await ps("Get-Process RTSS,RTSSHooksLoader64,RTSSHooksLoader,EncoderServer,EncoderServer64 -ErrorAction SilentlyContinue | Stop-Process -Force");
    await delay(1500);
    fs.mkdirSync(path.dirname(prof), { recursive: true });
    fs.writeFileSync(prof, txt);
    await ps(`Start-Process -FilePath '${path.join(st.dir, 'RTSS.exe')}' -WorkingDirectory '${st.dir}'`, { timeout: 20000 });
    await delay(6000);
    showProf('Global after direct write + restart:');
    log('status:', JSON.stringify(await fplimit.status()));
    capped = await measure('limit 30 (profile file)');
  }
  const b = await fplimit.apply(0);
  log('--- apply(0):', JSON.stringify(b));
  showProf('Global after apply(0):');
  await delay(3000);
  const free = await measure('limit removed');
  const mid = (xs) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)] || 0;
  log(`RESULT: base ${mid(base)} FPS, capped ${mid(capped)} FPS, after removing ${mid(free)} FPS`);
  await ps("Get-Process RTSS,RTSSHooksLoader64,EncoderServer -ErrorAction SilentlyContinue | Stop-Process -Force");
})().catch((e) => { console.log('PROBE ERROR', e); process.exit(0); });
