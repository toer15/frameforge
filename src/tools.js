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

/**
 * Run a list of winutil tweak IDs with no window (winutil's headless mode, via a -Config file).
 * Returns what winutil reported: per-step states, its ERROR/WARN lines and the log path.
 * Not interruptible: stopping halfway could leave Windows services half-changed.
 */
async function runWinutil(ids) {
  if (DEMO) {
    await new Promise((r) => setTimeout(r, 2500));
    return { ok: true, code: 0, lines: ['All steps completed.'], errors: [], warnings: [], steps: [{ name: 'Tweaks', items: ids.length, state: 'ok' }], logPath: null };
  }
  const p = await ensureWinutil();
  const cfg = path.join(dir(), 'winutil-frameforge.json');
  fs.writeFileSync(cfg, JSON.stringify(ids, null, 1));
  const r = await run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p, '-Config', cfg], { timeout: 45 * 60 * 1000 });
  const lines = (r.stdout + '\n' + r.stderr).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tag = (lvl) => lines.filter((l) => new RegExp(`\\[${lvl}\\]`).test(l)).map((l) => l.replace(/^\[[^\]]+\]\s*/, '').replace(/^\[(ERROR|WARN|INFO|DEBUG)\]\s*/, '')).filter((l, i, a) => a.indexOf(l) === i);
  const steps = lines
    .map((l) => l.match(/^(\S[\S ]*?)\s+(\d+) item\(s\)\s+([\d.]+)s\s+(.+)$/))
    .filter(Boolean)
    .map((m) => ({ name: m[1].trim(), items: Number(m[2]), seconds: Number(m[3]), state: m[4].trim() }));
  const logLine = lines.find((l) => /\b(See|Log:)\s+\S+\.log/i.test(l));
  const logPath = logLine ? (logLine.match(/([A-Z]:\\[^\s]+\.log)/i) || [])[1] || null : null;
  const fatal = lines.find((l) => /could not complete the headless run/i.test(l));
  return { ok: r.code === 0, code: r.code, lines, errors: tag('ERROR'), warnings: tag('WARN'), steps, logPath, fatal };
}

/** Open winutil's normal window so you can pick extra tweaks or apps by hand. */
async function openWinutil() {
  const p = await ensureWinutil();
  if (DEMO) return p;
  const { spawn } = require('child_process');
  spawn('cmd.exe', ['/c', 'start', '"Chris Titus Tech Windows Utility"', 'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', p], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
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

module.exports = { ensureWinutil, runWinutil, openWinutil, winutilPath, install, status, presentMonPath, lhmPath, startLhm, TOOLS, WINGET_APPS, hasWinget, wingetKnows, wingetInstall };
