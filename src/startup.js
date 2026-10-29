// Cleaner > "Programs that slow your PC": what starts with Windows (turn off/on the way Task Manager does, through
// the StartupApproved registry keys — nothing is uninstalled) and what uses a lot of CPU or memory right now.
const path = require('path');
const crypto = require('crypto');
const { ps, IS_WIN, DEMO } = require('./util');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
const AP = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
const SOURCES = {
  HKCU: { label: 'Your account (registry)', key: `HKCU:\\${AP}\\Run` },
  HKLM: { label: 'All users (registry)', key: `HKLM:\\${AP}\\Run`, admin: true },
  HKLM32: { label: 'All users (registry, 32-bit)', key: `HKLM:\\${AP}\\Run32`, admin: true },
  UserFolder: { label: 'Your Startup folder', key: `HKCU:\\${AP}\\StartupFolder` },
  CommonFolder: { label: 'All users’ Startup folder', key: `HKLM:\\${AP}\\StartupFolder`, admin: true },
};

// Advice. Only names that are clear from the program itself — never a guess about how "bad" an app is.
const KEEP_SECURITY = /SecurityHealth|Windows Defender|antivirus|avast|\bavg\b|norton|mcafee|kaspersky|bitdefender|\beset\b|malwarebytes|sophos|trend ?micro|webroot|f-secure/i;
const KEEP_HARDWARE = /realtek|RtkAud|synaptics|\belan\b|dolby|waves maxx|conexant|nahimic|cirrus|intel.*(graphics|audio)|igfx|ctfmon/i;
const PERIPHERAL = /logitech|lghub|razer|synapse|corsair|icue|steelseries|hyperx|ngenuity|armoury|aura|msi center|mystic light|nzxt|rgb/i;
const CLOUD = /onedrive|dropbox|google ?drive|googledrivefs|icloud|megasync|pcloud|box ?drive/i;
const GAME_DIRS = /\\(steamapps\\common|epic games|xboxgames|riot games|gog games|ubisoft game launcher\\games|ea games)\\/i;

function advise(it) {
  const s = `${it.name} ${it.exe} ${it.company} ${it.desc}`;
  if (KEEP_SECURITY.test(s)) return { level: 'keep', text: 'Security software — keep it on.' };
  if (KEEP_HARDWARE.test(s)) return { level: 'keep', text: 'Helper for your sound, touchpad or input — keep it on, or those may stop working right.' };
  if (PERIPHERAL.test(s)) return { level: 'maybe', text: 'Mouse, keyboard or RGB software. Turn it off only if you don’t need its profiles or lighting until you open it.' };
  if (CLOUD.test(s)) return { level: 'maybe', text: 'Cloud storage: your files only sync while it runs.' };
  return { level: 'off', text: 'Not needed when Windows starts — the app still works when you open it yourself.' };
}

// ---------- Demo data (harmless, in memory) ----------
const DEMO_STARTUP = [
  { src: 'HKCU', name: 'Discord', exe: 'C:\\Users\\Gamer\\AppData\\Local\\Discord\\Update.exe', args: '--processStart Discord.exe', company: 'Discord Inc.', desc: 'Discord', state: 2, mem: 412 * MB, cpu: 1.2 },
  { src: 'HKCU', name: 'Steam', exe: 'C:\\Program Files (x86)\\Steam\\steam.exe', args: '-silent', company: 'Valve Corporation', desc: 'Steam', state: 2, mem: 236 * MB, cpu: 0.4 },
  { src: 'HKCU', name: 'MicrosoftEdgeAutoLaunch_8A1C', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args: '--no-startup-window --win-session-start', company: 'Microsoft Corporation', desc: 'Microsoft Edge', state: 2, mem: 188 * MB, cpu: 0.1 },
  { src: 'HKCU', name: 'OneDrive', exe: 'C:\\Users\\Gamer\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe', args: '/background', company: 'Microsoft Corporation', desc: 'Microsoft OneDrive', state: 2, mem: 96 * MB, cpu: 0.2 },
  { src: 'HKCU', name: 'Spotify', exe: 'C:\\Users\\Gamer\\AppData\\Roaming\\Spotify\\Spotify.exe', args: '--autostart --minimized', company: 'Spotify Ltd', desc: 'Spotify', state: 3, mem: 0, cpu: 0 },
  { src: 'HKLM', name: 'RtkAudUService', exe: 'C:\\Windows\\System32\\DriverStore\\FileRepository\\realtekservice.inf_amd64\\RtkAudUService64.exe', args: '-background', company: 'Realtek Semiconductor', desc: 'Realtek HD Audio Universal Service', state: 2, mem: 9 * MB, cpu: 0 },
  { src: 'HKLM', name: 'SecurityHealth', exe: 'C:\\Windows\\system32\\SecurityHealthSystray.exe', args: '', company: 'Microsoft Corporation', desc: 'Windows Security notification icon', state: 6, mem: 11 * MB, cpu: 0 },
  { src: 'UserFolder', name: 'Razer Synapse.lnk', exe: 'C:\\Program Files (x86)\\Razer\\Synapse3\\WPFUI\\Framework\\Razer Synapse 3 Host\\Razer Synapse 3.exe', args: '', company: 'Razer Inc.', desc: 'Razer Synapse 3', state: 2, mem: 305 * MB, cpu: 2.6 },
];
const DEMO_PROCS = [
  { name: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', desc: 'Google Chrome', company: 'Google LLC', cpu: 16.5, mem: 2.6 * GB, count: 24 },
  { name: 'wallpaper64', path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe', desc: 'Wallpaper Engine', company: 'Wallpaper Engine Team', cpu: 11.2, mem: 640 * MB, count: 1 },
  { name: 'Razer Synapse 3', path: DEMO_STARTUP[7].exe, desc: 'Razer Synapse 3', company: 'Razer Inc.', cpu: 2.6, mem: 1.2 * GB, count: 3 },
  { name: 'Discord', path: 'C:\\Users\\Gamer\\AppData\\Local\\Discord\\app-1.0.9170\\Discord.exe', desc: 'Discord', company: 'Discord Inc.', cpu: 1.2, mem: 412 * MB, count: 6 },
];
let demoState = null;

// ---------- Reading ----------
const LIST_PS = `$ErrorActionPreference = 'SilentlyContinue'
$ap = '${AP}'
$items = New-Object System.Collections.ArrayList
function Exe([string]$cmd) {
  $c = [Environment]::ExpandEnvironmentVariables($cmd).Trim()
  if ($c.StartsWith('"')) { $e = $c.IndexOf('"', 1); if ($e -gt 1) { return $c.Substring(1, $e - 1) } }
  $m = [regex]::Match($c, '^(.+?\\.(exe|bat|cmd|com|vbs|ps1|lnk))(\\s|$)', 'IgnoreCase')
  if ($m.Success) { return $m.Groups[1].Value }
  return ($c -split ' ')[0]
}
function Add-Item($src, $name, $cmd, $apKey) {
  $v = (Get-ItemProperty -LiteralPath $apKey -Name $name).$name
  $state = if ($v -is [byte[]] -and $v.Length -gt 0) { [int]$v[0] } else { -1 }
  $exe = Exe $cmd
  $vi = (Get-Item -LiteralPath $exe -Force).VersionInfo
  [void]$items.Add([pscustomobject]@{ src = $src; name = $name; cmd = $cmd; exe = $exe; state = $state; company = [string]$vi.CompanyName; desc = [string]$vi.FileDescription })
}
foreach ($s in @(@('HKCU', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', "HKCU:\\$ap\\Run"), @('HKLM', 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', "HKLM:\\$ap\\Run"), @('HKLM32', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', "HKLM:\\$ap\\Run32"))) {
  $k = Get-Item -LiteralPath $s[1]
  if ($k) { foreach ($n in $k.GetValueNames()) { if ($n) { Add-Item $s[0] $n ([string]$k.GetValue($n)) $s[2] } } }
}
$sh = New-Object -ComObject WScript.Shell
foreach ($s in @(@('UserFolder', [Environment]::GetFolderPath('Startup'), "HKCU:\\$ap\\StartupFolder"), @('CommonFolder', [Environment]::GetFolderPath('CommonStartup'), "HKLM:\\$ap\\StartupFolder"))) {
  if (-not $s[1]) { continue }
  foreach ($f in Get-ChildItem -LiteralPath $s[1] -File -Force) {
    if ($f.Name -eq 'desktop.ini') { continue }
    $cmd = $f.FullName
    if ($f.Extension -eq '.lnk') { $l = $sh.CreateShortcut($f.FullName); if ($l.TargetPath) { $cmd = ('"' + $l.TargetPath + '" ' + $l.Arguments).Trim() } }
    Add-Item $s[0] $f.Name $cmd $s[2]
  }
}
$sid = (Get-Process -Id $PID).SessionId
$a = @{}; foreach ($p in Get-Process) { $a[$p.Id] = $p.CPU }
$t0 = Get-Date
Start-Sleep -Milliseconds 2000
$secs = ((Get-Date) - $t0).TotalSeconds
$procs = foreach ($p in Get-Process) {
  if ($p.SessionId -ne $sid -or $p.Id -eq $PID) { continue }
  $c0 = $a[$p.Id]
  [pscustomobject]@{ id = $p.Id; name = $p.ProcessName; path = $p.Path; cpu = $(if ($p.CPU -ne $null -and $c0 -ne $null) { ($p.CPU - $c0) / $secs } else { 0 }); mem = $p.WorkingSet64; desc = [string]$p.Description; company = [string]$p.Company }
}
@{ items = @($items); procs = @($procs); cores = [Environment]::ProcessorCount } | ConvertTo-Json -Depth 4 -Compress`;

let last = null; // { startup, heavy, at } with internal fields (pids, keys)
const idOf = (src, name) => crypto.createHash('sha1').update(`${src}|${name}`).digest('hex').slice(0, 12);
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** Group process samples by program file and keep the ones that use a lot. */
function heavyFrom(procs, cores) {
  const windir = (process.env.WINDIR || 'C:\\Windows').toLowerCase() + '\\';
  const self = path.dirname(process.execPath).toLowerCase() + '\\';
  const groups = new Map();
  for (const p of procs) {
    if (!p.path) continue;
    const key = p.path.toLowerCase();
    if (key.startsWith(windir) || key.startsWith(self) || GAME_DIRS.test(p.path)) continue; // Windows itself, FrameForge, the game you play
    const g = groups.get(key) || { key, path: p.path, name: p.desc || p.name, company: p.company || '', cpu: 0, mem: 0, pids: [] };
    g.cpu += (Number(p.cpu) || 0) / Math.max(1, cores) * 100;
    g.mem += Number(p.mem) || 0;
    g.pids.push(p.id);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.cpu >= 8 || g.mem >= GB).sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, 8);
}

function shape(items, procs, cores) {
  const byExe = new Map();
  for (const p of procs) if (p.path) {
    const k = p.path.toLowerCase();
    const s = byExe.get(k) || { mem: 0, cpu: 0 };
    s.mem += Number(p.mem) || 0;
    s.cpu += (Number(p.cpu) || 0) / Math.max(1, cores) * 100;
    byExe.set(k, s);
  }
  const startup = items.map((it) => {
    const run = byExe.get(String(it.exe || '').toLowerCase());
    const a = advise(it);
    return {
      id: idOf(it.src, it.name), src: it.src, srcLabel: (SOURCES[it.src] || {}).label || it.src, name: it.name.replace(/\.lnk$/i, ''), rawName: it.name,
      exe: it.exe || '', cmd: it.cmd || `"${it.exe}" ${it.args || ''}`.trim(), company: it.company || '', desc: it.desc || '',
      on: it.state < 0 || it.state % 2 === 0, running: !!run, mem: run ? run.mem : 0, cpu: run ? Math.round(run.cpu * 10) / 10 : 0,
      advice: a.level, adviceText: a.text, admin: !!(SOURCES[it.src] || {}).admin,
    };
  });
  startup.sort((x, y) => (y.on - x.on) || ({ off: 0, maybe: 1, keep: 2 }[x.advice] - { off: 0, maybe: 1, keep: 2 }[y.advice]) || y.mem - x.mem || x.name.localeCompare(y.name));
  return { startup, heavy: heavyFrom(procs, cores), at: Date.now() };
}

/** Read startup programs and sample what is running for 2 seconds. */
async function check() {
  if (DEMO) {
    if (!demoState) demoState = { startup: DEMO_STARTUP.map((d) => ({ ...d })), procs: DEMO_PROCS.map((p, i) => ({ ...p, ids: Array.from({ length: p.count }, (_, j) => 9000 + i * 100 + j) })) };
    await new Promise((r) => setTimeout(r, 600));
    const procs = [];
    for (const p of demoState.procs) for (const id of p.ids) procs.push({ id, name: p.name, path: p.path, desc: p.desc, company: p.company, cpu: (p.cpu / 100) * 8 / p.ids.length, mem: p.mem / p.ids.length });
    for (const s of demoState.startup) if (s.state % 2 === 0 && s.mem && !procs.some((p) => p.path === s.exe)) procs.push({ id: 1, name: s.name, path: s.exe, cpu: (s.cpu / 100) * 8, mem: s.mem });
    last = shape(demoState.startup, procs, 8);
    return view();
  }
  if (!IS_WIN) return { startup: [], heavy: [], at: Date.now() };
  const r = await ps(LIST_PS, { timeout: 60000 });
  let d;
  try {
    d = JSON.parse(r.stdout.trim() || '{}');
  } catch {
    return { ok: false, message: 'Couldn’t read the startup programs.', startup: [], heavy: [] };
  }
  last = shape(arr(d.items), arr(d.procs), Number(d.cores) || 1);
  return view();
}

function view() {
  if (!last) return null;
  return { ok: true, at: last.at, startup: last.startup, heavy: last.heavy.map(({ pids, ...g }) => ({ ...g, cpu: Math.round(g.cpu * 10) / 10, count: pids.length })) };
}

/** Turn a startup program off or back on (StartupApproved, the same switch as Task Manager's). */
async function set(id, on) {
  const it = last && last.startup.find((s) => s.id === id);
  if (!it) return { ok: false, message: 'That program isn’t in the list any more — check again.' };
  if (DEMO) {
    const d = demoState.startup.find((s) => idOf(s.src, s.name) === id);
    d.state = on ? 2 : 3;
    it.on = !!on;
    return { ok: true, on: it.on, message: on ? `${it.name} starts with Windows again.` : `${it.name} won’t start with Windows any more.` };
  }
  const key = SOURCES[it.src] && SOURCES[it.src].key;
  if (!key) return { ok: false, message: 'Unknown startup location.' };
  const bytes = on ? '[byte[]](2,0,0,0,0,0,0,0,0,0,0,0)' : '[byte[]](@(3,0,0,0) + [BitConverter]::GetBytes([DateTime]::Now.ToFileTime()))';
  const r = await ps(`$k = ${q(key)}; if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force | Out-Null }; New-ItemProperty -LiteralPath $k -Name ${q(it.rawName)} -PropertyType Binary -Value ${bytes} -Force | Out-Null; [int](Get-ItemProperty -LiteralPath $k -Name ${q(it.rawName)}).${q(it.rawName)}[0]`, { timeout: 30000 });
  const state = parseInt(r.stdout.trim().split(/\r?\n/).pop(), 10);
  if (Number.isNaN(state) || state % 2 === (on ? 1 : 0)) {
    return { ok: false, message: it.admin ? 'Windows didn’t accept the change. This one is set for all users, so FrameForge needs to run as administrator.' : 'Windows didn’t accept the change.' };
  }
  it.on = !!on;
  return { ok: true, on: it.on, message: on ? `${it.name} starts with Windows again.` : `${it.name} won’t start with Windows any more. It takes effect the next time you start the PC.` };
}

/** Close a program that's using a lot (all its processes from the last check that still run the same file). */
async function close(key) {
  const g = last && last.heavy.find((h) => h.key === key);
  if (!g) return { ok: false, message: 'That program isn’t in the list any more — check again.' };
  if (DEMO) {
    demoState.procs = demoState.procs.filter((p) => p.path.toLowerCase() !== key);
    last.heavy = last.heavy.filter((h) => h.key !== key);
    return { ok: true, message: `Closed ${g.name}.` };
  }
  const r = await ps(`$ids = @(${g.pids.map(Number).join(',')}); $p = Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(g.path)} }; $p | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 800; @(Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq ${q(g.path)} }).Count`, { timeout: 30000 });
  const left = parseInt(r.stdout.trim().split(/\r?\n/).pop(), 10);
  if (left === 0) {
    last.heavy = last.heavy.filter((h) => h.key !== key);
    return { ok: true, message: `Closed ${g.name}.` };
  }
  return { ok: false, message: `${g.name} didn’t close${Number.isNaN(left) ? '' : ` (${left} still running)`}. It may need administrator rights, or close it from its own window or tray icon.` };
}

module.exports = { check, set, close, view, advise };
