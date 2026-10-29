// Cleaner > "Programs that slow your PC": what starts with Windows (turn off/on the way Task Manager does, through
// the StartupApproved registry keys — nothing is uninstalled) and what uses a lot of CPU or memory right now.
// A program switched off here is kept off: enforce() turns it off again if the app switches itself back on.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ps, IS_WIN, DEMO } = require('./util');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
const AP = 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved';
// Tests only: a scratch HKCU key with its own Run + StartupApproved\Run, instead of Windows' real startup keys.
const TEST_ROOT = process.env.FRAMEFORGE_STARTUP_TEST_ROOT || '';

/** Where Windows starts programs from, and the StartupApproved key that switches each one on or off. */
function sources() {
  if (TEST_ROOT) return [{ id: 'HKCU', label: 'Your account (registry)', run: `${TEST_ROOT}\\Run`, ap: `${TEST_ROOT}\\StartupApproved\\Run` }];
  return [
    { id: 'HKCU', label: 'Your account (registry)', run: 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', ap: `HKCU:\\${AP}\\Run` },
    { id: 'HKLM', label: 'All users (registry)', run: 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', ap: `HKLM:\\${AP}\\Run`, admin: true },
    { id: 'HKLM32', label: 'All users (registry, 32-bit)', run: 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run', ap: `HKLM:\\${AP}\\Run32`, admin: true },
    { id: 'UserFolder', label: 'Your Startup folder', folder: 'Startup', ap: `HKCU:\\${AP}\\StartupFolder` },
    { id: 'CommonFolder', label: 'All users’ Startup folder', folder: 'CommonStartup', ap: `HKLM:\\${AP}\\StartupFolder`, admin: true },
  ];
}
const sourceOf = (id) => sources().find((s) => s.id === id);

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

/**
 * The folder a startup program's processes run from. Launchers often start the real app from a subfolder
 * (Discord's Update.exe → app-1.0.x\Discord.exe), so processes under this folder count as that program — unless the
 * folder is shared by many programs (Windows, Program Files, AppData, …), then only the exact file counts.
 */
function appDir(exe) {
  if (!exe) return '';
  const dir = path.dirname(exe).toLowerCase();
  const env = process.env;
  const shared = [env.WINDIR || 'C:\\Windows', env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, env.LOCALAPPDATA, env.APPDATA, env.USERPROFILE,
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs'), env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps'),
    env.APPDATA && path.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')]
    .filter(Boolean).map((d) => d.toLowerCase());
  if (dir.split('\\').filter(Boolean).length < 3) return '';
  if (shared.includes(dir) || dir.startsWith(shared[0] + '\\')) return '';
  return dir;
}
function belongs(procPath, exe) {
  if (!procPath || !exe) return false;
  const p = procPath.toLowerCase();
  if (p === exe.toLowerCase()) return true;
  const d = appDir(exe);
  return !!d && p.startsWith(d + '\\');
}

// ---------- Demo data (harmless, in memory) ----------
const DEMO_STARTUP = [
  { src: 'HKCU', name: 'Discord', exe: 'C:\\Users\\Gamer\\AppData\\Local\\Discord\\Update.exe', args: '--processStart Discord.exe', company: 'Discord Inc.', desc: 'Discord', state: 2 },
  { src: 'HKCU', name: 'Steam', exe: 'C:\\Program Files (x86)\\Steam\\steam.exe', args: '-silent', company: 'Valve Corporation', desc: 'Steam', state: 2 },
  { src: 'HKCU', name: 'MicrosoftEdgeAutoLaunch_8A1C', exe: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', args: '--no-startup-window --win-session-start', company: 'Microsoft Corporation', desc: 'Microsoft Edge', state: 2 },
  { src: 'HKCU', name: 'OneDrive', exe: 'C:\\Users\\Gamer\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe', args: '/background', company: 'Microsoft Corporation', desc: 'Microsoft OneDrive', state: 2 },
  { src: 'HKCU', name: 'Spotify', exe: 'C:\\Users\\Gamer\\AppData\\Roaming\\Spotify\\Spotify.exe', args: '--autostart --minimized', company: 'Spotify Ltd', desc: 'Spotify', state: 3 },
  { src: 'HKLM', name: 'RtkAudUService', exe: 'C:\\Windows\\System32\\DriverStore\\FileRepository\\realtekservice.inf_amd64\\RtkAudUService64.exe', args: '-background', company: 'Realtek Semiconductor', desc: 'Realtek HD Audio Universal Service', state: 2 },
  { src: 'HKLM', name: 'SecurityHealth', exe: 'C:\\Windows\\system32\\SecurityHealthSystray.exe', args: '', company: 'Microsoft Corporation', desc: 'Windows Security notification icon', state: 6 },
  { src: 'UserFolder', name: 'Razer Synapse.lnk', exe: 'C:\\Program Files (x86)\\Razer\\Synapse3\\WPFUI\\Framework\\Razer Synapse 3 Host\\Razer Synapse 3.exe', args: '', company: 'Razer Inc.', desc: 'Razer Synapse 3', state: 2 },
];
const DEMO_PROCS = [
  { name: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', desc: 'Google Chrome', company: 'Google LLC', cpu: 16.5, mem: 2.6 * GB, count: 24 },
  { name: 'wallpaper64', path: 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe', desc: 'Wallpaper Engine', company: 'Wallpaper Engine Team', cpu: 11.2, mem: 640 * MB, count: 1 },
  { name: 'Razer Synapse 3', path: DEMO_STARTUP[7].exe, desc: 'Razer Synapse 3', company: 'Razer Inc.', cpu: 2.6, mem: 1.2 * GB, count: 3 },
  { name: 'Discord', path: 'C:\\Users\\Gamer\\AppData\\Local\\Discord\\app-1.0.9170\\Discord.exe', desc: 'Discord', company: 'Discord Inc.', cpu: 1.2, mem: 412 * MB, count: 6 },
  { name: 'steam', path: 'C:\\Program Files (x86)\\Steam\\steam.exe', desc: 'Steam', company: 'Valve Corporation', cpu: 0.4, mem: 236 * MB, count: 1 },
  { name: 'msedge', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', desc: 'Microsoft Edge', company: 'Microsoft Corporation', cpu: 0.1, mem: 188 * MB, count: 4 },
  { name: 'OneDrive', path: 'C:\\Users\\Gamer\\AppData\\Local\\Microsoft\\OneDrive\\OneDrive.exe', desc: 'Microsoft OneDrive', company: 'Microsoft Corporation', cpu: 0.2, mem: 96 * MB, count: 1 },
];
let demoState = null;
function demo() {
  if (!demoState) demoState = { startup: DEMO_STARTUP.map((d) => ({ ...d })), procs: DEMO_PROCS.map((p, i) => ({ ...p, ids: Array.from({ length: p.count }, (_, j) => 9000 + i * 100 + j) })) };
  return demoState;
}
/** Demo: an app switches itself back on (like Spotify or Teams do), to show FrameForge keeping it off. */
function demoTamper(name) {
  const d = demo().startup.find((s) => s.name === name);
  if (d) d.state = 2;
}

// ---------- Reading ----------
const LIST_PS = (srcs) => `$ErrorActionPreference = 'SilentlyContinue'
$srcs = ${q(JSON.stringify(srcs))} | ConvertFrom-Json
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
$sh = New-Object -ComObject WScript.Shell
foreach ($s in $srcs) {
  if ($s.run) {
    $k = Get-Item -LiteralPath $s.run
    if ($k) { foreach ($n in $k.GetValueNames()) { if ($n) { Add-Item $s.id $n ([string]$k.GetValue($n)) $s.ap } } }
  } elseif ($s.folder) {
    $dir = [Environment]::GetFolderPath($s.folder)
    if (-not $dir) { continue }
    foreach ($f in Get-ChildItem -LiteralPath $dir -File -Force) {
      if ($f.Name -eq 'desktop.ini') { continue }
      $cmd = $f.FullName
      if ($f.Extension -eq '.lnk') { $l = $sh.CreateShortcut($f.FullName); if ($l.TargetPath) { $cmd = ('"' + $l.TargetPath + '" ' + $l.Arguments).Trim() } }
      Add-Item $s.id $f.Name $cmd $s.ap
    }
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
const isOn = (state) => state < 0 || state % 2 === 0; // StartupApproved: no value or an even first byte = on, odd = off

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
    g.cpu += ((Number(p.cpu) || 0) / Math.max(1, cores)) * 100;
    g.mem += Number(p.mem) || 0;
    g.pids.push(p.id);
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.cpu >= 8 || g.mem >= GB).sort((a, b) => b.cpu - a.cpu || b.mem - a.mem).slice(0, 8);
}

function shape(items, procs, cores) {
  const startup = items.map((it) => {
    let mem = 0;
    let cpu = 0;
    let n = 0;
    for (const p of procs) {
      if (!belongs(p.path, it.exe)) continue;
      mem += Number(p.mem) || 0;
      cpu += ((Number(p.cpu) || 0) / Math.max(1, cores)) * 100;
      n++;
    }
    const a = advise(it);
    const src = sourceOf(it.src) || {};
    return {
      id: idOf(it.src, it.name), src: it.src, srcLabel: src.label || it.src, name: it.name.replace(/\.lnk$/i, ''), rawName: it.name,
      exe: it.exe || '', cmd: it.cmd || `"${it.exe}" ${it.args || ''}`.trim(), company: it.company || '', desc: it.desc || '',
      on: isOn(it.state), running: n > 0, mem, cpu: Math.round(cpu * 10) / 10,
      advice: a.level, adviceText: a.text, admin: !!src.admin,
    };
  });
  const rank = { off: 0, maybe: 1, keep: 2 };
  startup.sort((x, y) => y.on - x.on || rank[x.advice] - rank[y.advice] || y.mem - x.mem || x.name.localeCompare(y.name));
  return { startup, heavy: heavyFrom(procs, cores), at: Date.now() };
}

function demoProcs() {
  const procs = [];
  for (const p of demo().procs) for (const id of p.ids) procs.push({ id, name: p.name, path: p.path, desc: p.desc, company: p.company, cpu: ((p.cpu / 100) * 8) / p.ids.length, mem: p.mem / p.ids.length });
  return procs;
}

/** Read startup programs and sample what is running for 2 seconds. */
async function check() {
  if (DEMO && !TEST_ROOT) {
    await new Promise((r) => setTimeout(r, 600));
    last = shape(demo().startup, demoProcs(), 8);
    return view();
  }
  if (!IS_WIN) return { ok: true, startup: [], heavy: [], at: Date.now() };
  const r = await ps(LIST_PS(sources()), { timeout: 60000 });
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

// ---------- Switching ----------
// Exactly what Task Manager writes: 02 + zeros = on, 03 + the time it was switched off = off.
const WRITE_PS = `function Set-Approved([string]$k, [string]$n, [bool]$on) {
  if (-not (Test-Path -LiteralPath $k)) { New-Item -Path $k -Force -ErrorAction Stop | Out-Null }
  if ($on) { $v = [byte[]](2,0,0,0,0,0,0,0,0,0,0,0) } else { $v = [byte[]](@(3,0,0,0) + [BitConverter]::GetBytes([DateTime]::Now.ToFileTime())) }
  New-ItemProperty -LiteralPath $k -Name $n -PropertyType Binary -Value $v -Force -ErrorAction Stop | Out-Null
}
function Get-Approved([string]$k, [string]$n) {
  $r = (Get-ItemProperty -LiteralPath $k -Name $n -ErrorAction SilentlyContinue).$n
  if ($r -is [byte[]] -and $r.Length -gt 0) { [int]$r[0] } else { -1 }
}`;

/** Turn a startup program off or back on (StartupApproved, the same switch as Task Manager's), then read it back. */
async function set(id, on) {
  const it = last && last.startup.find((s) => s.id === id);
  if (!it) return { ok: false, message: 'That program isn’t in the list any more — check again.' };
  if (DEMO && !TEST_ROOT) {
    const d = demo().startup.find((s) => idOf(s.src, s.name) === id);
    d.state = on ? 2 : 3;
    it.on = !!on;
    if (on) it.running = it.running || false;
    return { ok: true, on: it.on, state: d.state, running: it.running, message: msgFor(it, on) };
  }
  const src = sourceOf(it.src);
  if (!src) return { ok: false, message: 'Unknown startup location.' };
  const r = await ps(`$ErrorActionPreference = 'Stop'\n${WRITE_PS}\ntry { Set-Approved ${q(src.ap)} ${q(it.rawName)} $${on ? 'true' : 'false'} } catch { 'ERR ' + $_.Exception.Message }\nGet-Approved ${q(src.ap)} ${q(it.rawName)}`, { timeout: 30000 });
  const lines = r.stdout.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const err = lines.find((l) => l.startsWith('ERR '));
  const state = parseInt(lines[lines.length - 1], 10);
  if (Number.isNaN(state) || isOn(state) !== !!on) {
    const denied = /denied|not allowed|unauthori/i.test(`${err || ''} ${r.stderr}`);
    return {
      ok: false, state,
      message: denied || it.admin
        ? `Windows didn’t let FrameForge change ${it.name}: it’s set for all users, so FrameForge has to run as administrator. Restart FrameForge and choose “Yes” on the admin prompt.`
        : `Windows didn’t accept the change for ${it.name}${err ? ` (${err.slice(4)})` : ''}.`,
    };
  }
  it.on = !!on;
  return { ok: true, on: it.on, state, running: !!it.running, message: msgFor(it, on) };
}
function msgFor(it, on) {
  return on
    ? `${it.name} starts with Windows again (next time you turn on the PC).`
    : `${it.name} won’t start with Windows any more — Task Manager now shows it as Disabled.${it.running ? ' It’s still open right now: use “Close it now” to stop it too.' : ''}`;
}

/**
 * Keep switched-off programs off. choices = { id: { src, rawName, name } } (only "off" choices are kept).
 * Returns { fixed: [ids turned off again], gone: [ids whose startup entry no longer exists] }.
 */
async function enforce(choices) {
  const list = Object.entries(choices || {}).map(([id, c]) => ({ id, ...c, s: sourceOf(c.src) })).filter((c) => c.s);
  const out = { fixed: [], gone: [] };
  if (!list.length) return out;
  if (DEMO && !TEST_ROOT) {
    for (const c of list) {
      const d = demo().startup.find((s) => idOf(s.src, s.name) === c.id);
      if (!d) out.gone.push(c.id);
      else if (isOn(d.state)) {
        d.state = 3;
        out.fixed.push(c.id);
      }
    }
    return out;
  }
  if (!IS_WIN) return out;
  const tmp = path.join(os.tmpdir(), `frameforge-startup-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(list.map((c) => ({ id: c.id, n: c.rawName, ap: c.s.ap, run: c.s.run || '', folder: c.s.folder || '' }))));
  try {
    const r = await ps(`$ErrorActionPreference = 'SilentlyContinue'\n${WRITE_PS}\n$l = Get-Content -Raw -LiteralPath ${q(tmp)} | ConvertFrom-Json
foreach ($c in @($l)) {
  $exists = if ($c.run) { $k = Get-Item -LiteralPath $c.run; $k -and ($k.GetValueNames() -contains $c.n) } else { $d = [Environment]::GetFolderPath($c.folder); $d -and (Test-Path -LiteralPath (Join-Path $d $c.n)) }
  if (-not $exists) { "$($c.id)|gone"; continue }
  $s = Get-Approved $c.ap $c.n
  if ($s -ge 0 -and $s % 2 -eq 1) { "$($c.id)|ok"; continue }
  try { Set-Approved $c.ap $c.n $false } catch {}
  $s2 = Get-Approved $c.ap $c.n
  if ($s2 -ge 0 -and $s2 % 2 -eq 1) { "$($c.id)|fixed" } else { "$($c.id)|failed" }
}`, { timeout: 60000 });
    for (const line of r.stdout.split(/\r?\n/)) {
      const [id, st] = line.trim().split('|');
      if (st === 'fixed') out.fixed.push(id);
      if (st === 'gone') out.gone.push(id);
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  if (last) for (const s of last.startup) if (out.fixed.includes(s.id)) s.on = false;
  return out;
}

// ---------- Closing ----------
/** Stop the processes of a startup program right now (its file, or anything running from its own folder). */
async function closeStartup(id) {
  const it = last && last.startup.find((s) => s.id === id);
  if (!it) return { ok: false, message: 'That program isn’t in the list any more — check again.' };
  if (DEMO && !TEST_ROOT) {
    const st = demo();
    st.procs = st.procs.filter((p) => !belongs(p.path, it.exe));
    it.running = false;
    it.mem = 0;
    it.cpu = 0;
    last.heavy = last.heavy.filter((h) => !belongs(h.path, it.exe));
    return { ok: true, message: `Closed ${it.name}.` };
  }
  return stopWhere(it.name, it.exe, appDir(it.exe), () => {
    it.running = false;
    it.mem = 0;
    it.cpu = 0;
    last.heavy = last.heavy.filter((h) => !belongs(h.path, it.exe));
  });
}

/** Close a program that's using a lot (all its processes that still run the same file). */
async function close(key) {
  const g = last && last.heavy.find((h) => h.key === key);
  if (!g) return { ok: false, message: 'That program isn’t in the list any more — check again.' };
  if (DEMO && !TEST_ROOT) {
    demo().procs = demo().procs.filter((p) => p.path.toLowerCase() !== key);
    last.heavy = last.heavy.filter((h) => h.key !== key);
    return { ok: true, message: `Closed ${g.name}.` };
  }
  return stopWhere(g.name, g.path, '', () => {
    last.heavy = last.heavy.filter((h) => h.key !== key);
  });
}

async function stopWhere(name, exe, dir, onDone) {
  const match = `$_.SessionId -eq $sid -and $_.Path -and ($_.Path -ieq ${q(exe)}${dir ? ` -or $_.Path.StartsWith(${q(dir + '\\')}, [StringComparison]::OrdinalIgnoreCase)` : ''})`;
  const r = await ps(`$sid = (Get-Process -Id $PID).SessionId; Get-Process | Where-Object { ${match} } | Stop-Process -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 900; @(Get-Process | Where-Object { ${match} }).Count`, { timeout: 30000 });
  const left = parseInt(r.stdout.trim().split(/\r?\n/).pop(), 10);
  if (left === 0) {
    onDone();
    return { ok: true, message: `Closed ${name}.` };
  }
  return { ok: false, message: `${name} didn’t close${Number.isNaN(left) ? '' : ` (${left} still running)`}. It may need administrator rights, or close it from its own window or tray icon.` };
}

module.exports = { check, set, enforce, close, closeStartup, view, advise, belongs, appDir, demoTamper };
