// Temporary probe: does the FPS limiter work against a real RTSS on real Windows?
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { run, ps } = require('../src/util');
const fplimit = require('../src/fplimit');
const log = (...a) => console.log(...a);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const GAME = path.join(require('os').tmpdir(), 'fftestgame.exe');
async function build() {
  const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const r = await run(csc, ['/nologo', '/platform:x64', '/target:exe', '/r:System.Windows.Forms.dll', `/out:${GAME}`, path.join(__dirname, '..', 'tests', 'fixtures', 'testgame.cs')]);
  log('csc:', r.code, (r.stdout + r.stderr).trim().slice(0, 600));
}
/** Run the test game for `secs`; `at` = { second: async fn } runs things while it plays. */
async function measure(label, secs = 10, at = {}) {
  const out = [];
  let info = '';
  await new Promise((res) => {
    const c = spawn(GAME, [String(secs)]);
    c.stdout.on('data', (d) => String(d).split(/\r?\n/).forEach((l) => {
      if (/FPS \d+/.test(l)) { out.push(Number(l.match(/FPS (\d+)/)[1])); const fn = at[out.length]; if (fn) fn().catch((e) => log('at err', e)); }
      else if (l.trim()) info += l.trim() + ' ';
    }));
    c.stderr.on('data', (d) => (info += String(d)));
    c.on('exit', res);
    setTimeout(() => c.kill(), (secs + 15) * 1000);
  });
  log(`${label}: ${info.trim()} frames each second = [${out.join(', ')}]`);
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

  await build();
  const pdir = path.join(st.dir, 'Profiles');
  const showProf = (label) => {
    const names = fs.existsSync(pdir) ? fs.readdirSync(pdir) : [];
    log(label, 'files:', names.join(', ') || '(none)', '|', names.filter((n) => /^global/i.test(n)).map((n) => n + ': ' + fs.readFileSync(path.join(pdir, n), 'utf8').split(/\r?\n/).filter((l) => /^\[|Limit|Hook|Detect/i.test(l)).join(' ')).join(' ; '));
    log('  template Global:', fs.readFileSync(path.join(st.dir, 'ProfileTemplates', 'Global'), 'utf8').split(/\r?\n/).filter((l) => /^\[|Limit|Detect/i.test(l)).join(' ').slice(0, 500));
  };
  const base = await measure('RTSS never started, no limit');
  // Exactly what the app does on a fresh install: set the limit, which also starts RTSS.
  const a = await fplimit.apply(30);
  log('--- apply(30):', JSON.stringify(a), 'status:', JSON.stringify(await fplimit.status()));
  showProf('after apply(30):');
  log('RTSS processes:', (await run('tasklist', ['/FI', 'IMAGENAME eq RTSS*', '/FO', 'CSV', '/NH'])).stdout.trim().replace(/\r?\n/g, ' ; '));
  await delay(5000);
  const capped = await measure('limit 30, game started after');
  // Change the number while a game is running (lobby → match): does the running game follow?
  const live = await measure('limit 30 → 60 at second 6 → off at second 12', 18, { 6: () => fplimit.apply(60).then((r) => log('  live apply(60):', JSON.stringify(r))), 12: () => fplimit.apply(0).then((r) => log('  live apply(0):', JSON.stringify(r))) });
  showProf('after apply(0):');
  log('status:', JSON.stringify(await fplimit.status()), 'drifted(60)?', await fplimit.drifted(60));
  const free = await measure('limit removed, RTSS still running');
  const mid = (xs) => xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)] || 0;
  log(`RESULT: base ${mid(base)} FPS, capped ${mid(capped)} FPS, after removing ${mid(free)} FPS`);
  await ps("Get-Process RTSS,RTSSHooksLoader64,EncoderServer -ErrorAction SilentlyContinue | Stop-Process -Force");
})().catch((e) => { console.log('PROBE ERROR', e); process.exit(0); });
