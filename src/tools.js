// Downloads the free helper tools FrameForge uses:
//  - PresentMon (Intel, open source): reads real in-game FPS
//  - LibreHardwareMonitor (open source): reads CPU/GPU temperatures on any brand
const fs = require('fs');
const path = require('path');
const { app, net } = require('electron');
const { ps, run, DEMO } = require('./util');

const TOOLS = {
  presentmon: {
    name: 'PresentMon (FPS engine)',
    repo: 'GameTechDev/PresentMon',
    pick: (assets) =>
      assets.find((a) => /^PresentMon-[\d.]+-x64\.exe$/i.test(a.name)) ||
      assets.find((a) => /PresentMon.*x64\.exe$/i.test(a.name) && !/capture|app/i.test(a.name)),
  },
  lhm: {
    name: 'LibreHardwareMonitor (temperature sensors)',
    repo: 'LibreHardwareMonitor/LibreHardwareMonitor',
    pick: (assets) => {
      const zips = assets.filter((a) => /\.zip$/i.test(a.name) && !/lib\b|source|\.nupkg/i.test(a.name));
      return zips.find((a) => /net472/i.test(a.name)) || zips.find((a) => /^LibreHardwareMonitor\.zip$/i.test(a.name)) || zips[0];
    },
  },
};

function dir() {
  const d = path.join(app.getPath('userData'), 'tools');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function findFile(root, name) {
  if (!fs.existsSync(root)) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === name.toLowerCase()) return p;
    if (entry.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    }
  }
  return null;
}

function presentMonPath() {
  const p = path.join(dir(), 'PresentMon.exe');
  return fs.existsSync(p) ? p : null;
}

function lhmPath() {
  return findFile(path.join(dir(), 'lhm'), 'LibreHardwareMonitor.exe');
}

function status() {
  if (DEMO) return { presentmon: true, lhm: true };
  return { presentmon: !!presentMonPath(), lhm: !!lhmPath() };
}

async function latestAsset(tool) {
  const res = await net.fetch(`https://api.github.com/repos/${tool.repo}/releases/latest`, {
    headers: { 'User-Agent': 'FrameForge', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${tool.name}`);
  const rel = await res.json();
  const asset = tool.pick(rel.assets || []);
  if (!asset) throw new Error(`No Windows download found in the latest ${tool.name} release`);
  return { url: asset.browser_download_url, name: asset.name, size: asset.size, version: rel.tag_name };
}

async function download(url, dest, onProgress = null, signal) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'FrameForge' }, signal });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    if (onProgress && total) onProgress(got / total);
  }
  fs.writeFileSync(dest, Buffer.concat(chunks));
}

/** Install one tool. Returns { ok, message }. */
async function install(id, onProgress = () => {}, signal) {
  if (DEMO) {
    for (let i = 1; i <= 10; i++) {
      if (signal && signal.aborted) throw new Error('Stopped');
      await new Promise((r) => setTimeout(r, 150));
      onProgress(i / 10);
    }
    return { ok: true, message: `${TOOLS[id].name} installed.` };
  }
  const tool = TOOLS[id];
  const asset = await latestAsset(tool);
  if (id === 'presentmon') {
    await download(asset.url, path.join(dir(), 'PresentMon.exe'), onProgress, signal);
    return { ok: true, message: `${tool.name} ${asset.version} installed.` };
  }
  const zip = path.join(dir(), 'lhm.zip');
  const out = path.join(dir(), 'lhm');
  await download(asset.url, zip, onProgress, signal);
  const r = await ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${out}' -Force`);
  fs.rmSync(zip, { force: true });
  if (r.code !== 0 || !lhmPath()) throw new Error('Couldn’t unpack LibreHardwareMonitor');
  // Start minimized to the tray so it stays out of the way.
  // Start minimized to the tray and turn on its local-only sensor server (a second way to read temps).
  const cfg = path.join(path.dirname(lhmPath()), 'LibreHardwareMonitor.config');
  if (!fs.existsSync(cfg)) {
    const keys = { startMinMenuItem: 'true', minTrayMenuItem: 'true', minCloseMenuItem: 'true', runWebServerMenuItem: 'true', listenerPort: '8085' };
    const lines = Object.entries(keys).map(([k, v]) => `    <add key="${k}" value="${v}" />`).join('\n');
    fs.writeFileSync(cfg, `<?xml version="1.0" encoding="utf-8"?>\n<configuration>\n  <appSettings>\n${lines}\n  </appSettings>\n</configuration>\n`);
  }
  return { ok: true, message: `${tool.name} ${asset.version} installed.` };
}

// ---------- Chris Titus Tech's Windows Utility (winutil) ----------
const WINUTIL_URL = 'https://github.com/ChrisTitusTech/winutil/releases/latest/download/winutil.ps1';

function winutilPath() {
  return path.join(dir(), 'winutil.ps1');
}

/** Get the latest winutil.ps1 from Chris Titus's official GitHub release (refreshed every 3 days). */
async function ensureWinutil(signal) {
  const p = winutilPath();
  if (DEMO) return p;
  try {
    const age = Date.now() - fs.statSync(p).mtimeMs;
    if (age < 3 * 24 * 3600 * 1000) return p;
  } catch {}
  await download(WINUTIL_URL, p + '.tmp', null, signal);
  const head = fs.readFileSync(p + '.tmp', 'utf8').slice(0, 4000);
  if (!/winutil|Chris Titus/i.test(head)) {
    fs.rmSync(p + '.tmp', { force: true });
    throw new Error('The download didn’t look like Chris Titus’s winutil script, so it wasn’t used.');
  }
  fs.renameSync(p + '.tmp', p);
  return p;
}

// winutil errors that only mean "this thing isn't on your PC" — e.g. its Telemetry tweak tries to disable a
// 'wermgr' service that current Windows 11 doesn't have. Nothing was harmed, there was just nothing to change.
const HARMLESS = /was not found on computer|cannot find any service|does not exist|cannot find (path|the|a|an|any)|no msft_scheduledtask|objectnotfound|pathnotfound|nomatchfound|is not recognized as (the|a) name|the system cannot find the (file|path) specified|no such (service|task|package)|not installed|package .* not found|could not find/i;

/** "[2026-10-21 15:01:44.200] [INFO] [Tweaks] Applying tweak: X" → { level, component, text } */
function parseWinutilLine(l) {
  const m = l.match(/^\[[^\]]+\]\s*\[(INFO|WARN|ERROR|DEBUG)\]\s*\[([^\]]+)\]\s*(.*)$/);
  return m ? { level: m[1], component: m[2], text: m[3] } : null;
}

/**
 * Run a list of winutil tweak IDs with no window (winutil's headless mode, via a -Config file).
 * onLine(text) gets a friendly line for each step winutil starts, live.
 * Not interruptible: stopping halfway could leave Windows services half-changed.
 */
async function runWinutil(ids, onLine = () => {}, names = {}) {
  if (DEMO) {
    for (const [i, id] of ids.entries()) {
      await new Promise((r) => setTimeout(r, 160));
      onLine(`Tweak ${i + 1} of ${ids.length}: ${names[id] || id}`);
    }
    const harmless = /Telemetry/.test(ids.join()) ? ["[Tweaks] Non-terminating error : Service wermgr was not found on computer '.'."] : [];
    // Test hook: FRAMEFORGE_DEMO_CTT_FAIL=WPFTweaksServices makes that tweak fail, like on a real PC.
    const bad = (process.env.FRAMEFORGE_DEMO_CTT_FAIL || '').split(',').filter((b) => b && ids.includes(b));
    if (bad.length) {
      const errors = bad.map((b) => `[Tweaks] ${b}: timed out after 300 s`);
      return { ok: false, code: 1, lines: [], errors, harmless, warnings: [], steps: [{ name: 'Tweaks', items: ids.length, state: `${bad.length} error(s)` }], logPath: null, failedIds: bad };
    }
    return { ok: harmless.length === 0, code: harmless.length ? 1 : 0, lines: [], errors: [], harmless, warnings: [], steps: [{ name: 'Tweaks', items: ids.length, state: harmless.length ? '1 error(s)' : 'ok' }], logPath: null, failedIds: [] };
  }
  const p = await ensureWinutil();
  const cfg = path.join(dir(), 'winutil-frameforge.json');
  fs.writeFileSync(cfg, JSON.stringify(ids, null, 1));
  const lines = [];
  let n = 0;
  let current = null; // the tweak winutil is running right now — a real error belongs to it
  const failed = new Set();
  const { runLines } = require('./fixes');
  const code = await runLines(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p, '-Config', cfg],
    (l) => {
      lines.push(l);
      const e = parseWinutilLine(l);
      if (!e) return;
      const t = e.text.match(/^(Applying|Running) tweak:\s*(\S+)/i);
      if (t) {
        current = t[2];
        onLine(`Tweak ${Math.min(++n, ids.length)} of ${ids.length}: ${names[t[2]] || t[2]}`);
      } else if (e.level === 'ERROR') {
        if (!HARMLESS.test(e.text)) {
          const named = (e.text.match(/\b(WPF[A-Za-z0-9_]+)\b/) || [])[1];
          if (named && ids.includes(named)) failed.add(named);
          else if (current) failed.add(current);
        }
        onLine(HARMLESS.test(e.text) ? `Skipped something that isn't on this PC (${e.text.replace(/^Non-terminating error\s*:\s*/i, '').slice(0, 80)})` : `Problem: ${e.text.slice(0, 100)}`);
      }
    },
    45 * 60 * 1000
  );
  const entries = lines.map(parseWinutilLine).filter(Boolean);
  const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
  const allErrors = uniq(entries.filter((e) => e.level === 'ERROR').map((e) => `[${e.component}] ${e.text}`));
  const steps = lines
    .map((l) => l.match(/^(\S[\S ]*?)\s+(\d+) item\(s\)\s+([\d.]+)s\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ name: m[1].trim(), items: Number(m[2]), seconds: Number(m[3]), state: m[4].trim() }));
  const logLine = lines.find((l) => /\b(See|Log:)\s+\S+\.log/i.test(l));
  const logPath = logLine ? (logLine.match(/([A-Z]:\\[^\s]+\.log)/i) || [])[1] || null : null;
  const fatal = lines.find((l) => /could not complete the headless run/i.test(l));
  return {
    ok: code === 0,
    code,
    lines,
    errors: allErrors.filter((e) => !HARMLESS.test(e)),
    harmless: allErrors.filter((e) => HARMLESS.test(e)),
    warnings: uniq(entries.filter((e) => e.level === 'WARN').map((e) => `[${e.component}] ${e.text}`)),
    steps,
    logPath,
    fatal,
    failedIds: [...failed], // which tweaks hit a real error (so Fix mode can leave just those out)
  };
}

/** Open winutil's own window (its normal app) — e.g. to check its tweaks, install apps, or Undo. */
async function openWinutil() {
  const p = await ensureWinutil();
  if (DEMO) return p;
  const { spawn } = require('child_process');
  // Start PowerShell directly in its own (minimized) console; winutil then opens its window.
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Minimized', '-File', p], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  return p;
}

/** Start LibreHardwareMonitor in the background if it isn't running yet. */
async function startLhm() {
  if (DEMO) return;
  const exe = lhmPath();
  if (!exe) return;
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq LibreHardwareMonitor.exe', '/NH']);
  if (/LibreHardwareMonitor\.exe/i.test(r.stdout)) return;
  const { spawn } = require('child_process');
  spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// ---------- winget (Microsoft's package manager: every package is reviewed and hash-checked) ----------

/** Official packages FrameForge may install, by GPU brand. First one winget knows about wins. */
const WINGET_APPS = {
  nvidia: [
    { id: 'Nvidia.NVIDIAApp', name: 'NVIDIA app' },
    { id: 'Nvidia.GeForceExperience', name: 'NVIDIA GeForce Experience' },
  ],
  amd: [],
  intel: [{ id: 'Intel.IntelDriverAndSupportAssistant', name: 'Intel Driver & Support Assistant' }],
};

async function hasWinget() {
  if (DEMO) return true;
  return (await run('winget', ['--version'], { timeout: 15000 })).code === 0;
}

async function wingetKnows(id) {
  if (DEMO) return true;
  const r = await run('winget', ['show', '--id', id, '--exact', '--source', 'winget', '--accept-source-agreements', '--disable-interactivity'], { timeout: 90000 });
  return r.code === 0;
}

/** Install a winget package silently. Not interruptible — stopping an installer halfway can break it. */
async function wingetInstall(id) {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 1500));
    return { ok: true };
  }
  const r = await run(
    'winget',
    ['install', '--id', id, '--exact', '--source', 'winget', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
    { timeout: 20 * 60 * 1000 }
  );
  // 0 = installed, -1978335189 (0x8A15002B) = already installed / no newer version
  if (r.code === 0 || /already installed|No newer package|No available upgrade/i.test(r.stdout)) return { ok: true };
  return { ok: false, message: (r.stdout.split(/\r?\n/).filter(Boolean).pop() || 'winget failed').slice(0, 160) };
}

// ---------- Big downloads (straight to disk, with progress and an optional SHA-256 check) ----------

async function downloadFile(url, dest, { headers = {}, onProgress = null, signal, sha256 = null } = {}) {
  const crypto = require('crypto');
  const res = await net.fetch(url, { headers: { 'User-Agent': 'FrameForge', ...headers }, signal });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  const hash = crypto.createHash('sha256');
  const reader = res.body.getReader();
  let got = 0;
  let lastPct = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const buf = Buffer.from(value);
      hash.update(buf);
      if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
      got += buf.length;
      const pct = total ? Math.floor((got / total) * 100) : -1;
      if (onProgress && pct !== lastPct) {
        lastPct = pct;
        onProgress(total ? got / total : null, got, total);
      }
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  const digest = hash.digest('hex');
  if (sha256 && digest.toLowerCase() !== String(sha256).toLowerCase()) {
    fs.rmSync(tmp, { force: true });
    throw new Error('The download didn’t match its official fingerprint (SHA-256), so it was deleted and not run.');
  }
  fs.renameSync(tmp, dest);
  return { bytes: got, sha256: digest };
}

/** Ask Windows whether a file carries a valid digital signature from the expected company. */
async function verifySignature(file, publisher) {
  if (DEMO) return { ok: true, status: 'Valid', subject: 'CN=Demo' };
  const r = await ps(`$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`);
  const [status, subject = ''] = r.stdout.trim().split('|');
  return { ok: status === 'Valid' && publisher.test(subject), status, subject };
}

// ---------- AMD Software: Adrenalin Edition ----------
// AMD doesn't publish its driver app in Microsoft's winget store. So FrameForge reads the download link from
// AMD's own driver page for your card, downloads AMD's full package from drivers.amd.com, and lets Windows
// check its digital signature. Only a file signed by Advanced Micro Devices, Inc. is ever started.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const AMD_RDNA3_PAGE = 'https://www.amd.com/en/support/downloads/previous-drivers.html/graphics/radeon-rx/radeon-rx-7000-series/amd-radeon-rx-7900-xt.html';

function amdDriverPages(gpuName) {
  const m = String(gpuName || '').match(/RX\s*(\d)(\d{3})\s*(XTX|XT|GRE|S)?\b/i);
  if (!m || Number(m[1]) < 5) return [];
  const model = `amd-radeon-rx-${m[1]}${m[2]}${m[3] ? '-' + m[3].toLowerCase() : ''}`;
  const series = `radeon-rx-${m[1]}000-series`;
  const pages = [
    `https://www.amd.com/en/support/downloads/drivers.html/graphics/radeon-rx/${series}/${model}.html`,
    `https://www.amd.com/en/support/downloads/previous-drivers.html/graphics/radeon-rx/${series}/${model}.html`,
  ];
  // RX 7000 and RX 9000 cards share one driver package, so another RX 7000 page works as a backup.
  if (Number(m[1]) >= 7) pages.push(AMD_RDNA3_PAGE);
  return pages;
}

/** Newest official AMD driver package link on AMD's page for this card (prefers WHQL-certified ones). */
async function amdDriverLink(gpuName) {
  for (const page of amdDriverPages(gpuName)) {
    try {
      const res = await net.fetch(page, { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
      if (!res.ok) continue;
      const html = await res.text();
      // AMD's small "Auto-Detect and Install" setup (~50 MB, fetches the rest itself) is preferred over the
      // full ~900 MB package. Both are signed by AMD.
      const mini = (html.match(/https:\/\/drivers\.amd\.com\/drivers\/installer\/[\d.]+\/whql\/amd-software-adrenalin-edition-[A-Za-z0-9.\-_]*minimalsetup[A-Za-z0-9.\-_]*\.exe/) || [])[0];
      if (mini) return { url: mini, page, small: true };
      const links = [...new Set(html.match(/https:\/\/drivers\.amd\.com\/drivers\/(?:whql-)?amd-software-adrenalin-edition-[A-Za-z0-9.\-_]+\.exe/g) || [])];
      const pick = links.find((l) => /\/whql-/.test(l)) || links[0];
      if (pick) return { url: pick, page, small: false };
    } catch {}
  }
  return null;
}

async function amdDriverInstall(gpuName, onLine = () => {}, signal) {
  if (DEMO) {
    for (let i = 1; i <= 5; i++) {
      await new Promise((r) => setTimeout(r, 200));
      onLine(`Downloading AMD Software from drivers.amd.com… ${i * 20}%`);
    }
    return { ok: true, started: true, message: 'AMD’s installer is open — its digital signature checked out.' };
  }
  onLine('Finding the newest AMD driver for your card on amd.com…');
  const link = await amdDriverLink(gpuName);
  if (!link) return { ok: false, message: 'AMD’s driver page couldn’t be read for your card.' };
  const file = path.join(app.getPath('temp'), 'FrameForge', path.basename(link.url));
  if (!fs.existsSync(file)) {
    onLine(`Downloading ${path.basename(link.url)} from drivers.amd.com${link.small ? '' : ' (about 900 MB)'}…`);
    let lastShown = -1;
    await downloadFile(link.url, file, {
      headers: { 'User-Agent': BROWSER_UA, Referer: 'https://www.amd.com/' }, // drivers.amd.com refuses downloads without it
      signal,
      onProgress: (p) => {
        const pct = p == null ? -1 : Math.floor(p * 100);
        if (pct >= 0 && pct % 5 === 0 && pct !== lastShown) {
          lastShown = pct;
          onLine(`Downloading AMD Software… ${pct}%`);
        }
      },
    });
  }
  onLine('Asking Windows to check AMD’s digital signature on the download…');
  const sig = await verifySignature(file, /O="?Advanced Micro Devices/i);
  if (!sig.ok) {
    fs.rmSync(file, { force: true });
    return { ok: false, message: `The download isn’t signed by AMD (Windows says: ${sig.status || 'unknown'}), so it was deleted and not run.` };
  }
  onLine('Signature OK — signed by Advanced Micro Devices, Inc. Starting AMD’s installer…');
  const { spawn } = require('child_process');
  const child = spawn(file, [], { detached: true, stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('spawn', resolve);
  });
  child.unref();
  return { ok: true, started: true, message: 'AMD’s own installer is open (signature checked by Windows). Click Install in its window — FrameForge checks again when it’s done.' };
}

module.exports = { HARMLESS, ensureWinutil, runWinutil, openWinutil, winutilPath, install, status, presentMonPath, lhmPath, startLhm, TOOLS, WINGET_APPS, hasWinget, wingetKnows, wingetInstall, downloadFile, verifySignature, amdDriverInstall, amdDriverPages };
