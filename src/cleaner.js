// Cleaner tab: finds the junk that fills the drive and slows Windows down — temp files, update leftovers, crash
// dumps, browser and app caches, unpacked driver installers, big old files — and deletes only what the user picks.
// Only files found by the last scan are ever touched, and only if they haven't changed since.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { run, ps, IS_WIN, DEMO } = require('./util');

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const GB = 1024 ** 3;
const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string
// Big-file threshold. Demo mode uses a small one so the generated sample files show up.
const BIG = DEMO ? Number(process.env.FRAMEFORGE_CLEAN_BIG) || 8 * 1024 * 1024 : GB;
const USER_SKIP_DIRS = /^(node_modules|\.git|AppData|\$Recycle\.Bin|System Volume Information|steamapps|SteamLibrary|Epic Games|XboxGames|WindowsApps|Riot Games|GOG Games|Paks|romfs|exefs)$/i;
// Big files inside an installed game or program are part of it: deleting one breaks it. Such folders are skipped.
const PROGRAM_MARKERS = /^(\.egstore|steam_appid\.txt|UnityPlayer\.dll|GameAssembly\.dll|\.itch|goggame-\d+\.info|installscript\.vdf)$/i;
const USER_FOLDER_NAMES = /^(downloads?|desktop|documents|videos|pictures|music)$/i;
function looksInstalled(list, dir, isRoot) {
  if (list.some((d) => PROGRAM_MARKERS.test(d.name))) return true;
  if (list.some((d) => d.isDirectory() && /^Engine$/i.test(d.name)) && list.some((d) => d.isDirectory() && /Game$/i.test(d.name))) return true; // Unreal Engine
  // A folder with its own .exe/.dll files is a program's folder (Downloads and the like hold installers, so not those).
  return !isRoot && !USER_FOLDER_NAMES.test(path.basename(dir)) && list.some((d) => d.isFile() && /\.(exe|dll)$/i.test(d.name));
}
// Full check, top level of each drive: Windows, installed programs, other categories' folders and Users (your own
// folder is walked separately, so other people's files on this PC are never listed).
const DRIVE_SKIP_DIRS = /^(Windows|Windows\.old|Program Files|Program Files \(x86\)|ProgramData|Users|Recovery|PerfLogs|MSOCache|Config\.Msi|OneDriveTemp|AMD|NVIDIA|Intel|\$WinREAgent|\$Windows\.~BT|\$Windows\.~WS|\$SysReset|\$GetCurrent)$/i;
const SYSTEM_FILES = /^(pagefile|hiberfil|swapfile)\.sys$|^DumpStack\.log/i;

const GROUPS = [
  { id: 'windows', name: 'Windows junk' },
  { id: 'browsers', name: 'Browser caches' },
  { id: 'apps', name: 'Apps and games' },
  { id: 'yours', name: 'Your own files — check before deleting' },
];

const exists = (p) => fsp.access(p).then(() => true, () => false);
async function existing(list) {
  const out = [];
  for (const p of list) if (p && (await exists(p))) out.push(p);
  return out;
}
async function subdirs(dir, test) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory() && test(d.name)).map((d) => path.join(dir, d.name));
  } catch {
    return [];
  }
}

// Chromium browsers keep one cache per profile ("Default", "Profile 1", …) plus a few shared GPU caches.
const CHROMIUM_PROFILE_CACHES = ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];
const CHROMIUM_SHARED_CACHES = ['ShaderCache', 'GrShaderCache', 'GraphiteDawnCache'];
function chromium(id, name, dir, procs, single = false) {
  return {
    id, group: 'browsers', name: `${name} cache`, level: 'safe', procs, app: name,
    desc: `Saved copies of web pages and images. ${name} downloads them again when it needs them. Logins, history, bookmarks and passwords are not touched.`,
    roots: async (b) => {
      const base = dir(b);
      if (!(await exists(base))) return [];
      const profiles = single ? [base] : await subdirs(base, (n) => /^(Default|Profile \d+|Guest Profile|System Profile)$/.test(n));
      return existing([...profiles.flatMap((p) => CHROMIUM_PROFILE_CACHES.map((c) => path.join(p, c))), ...CHROMIUM_SHARED_CACHES.map((c) => path.join(base, c))]);
    },
  };
}

/**
 * Everything the Cleaner looks for. `level` safe = selected by default; review = the user decides.
 * `minAge`: files newer than this are left alone (an installer may still be using them).
 */
const DEFS = [
  {
    id: 'temp_user', group: 'windows', name: 'Temporary files', level: 'safe', minAge: DAY,
    desc: 'Leftovers that apps and installers put in your temp folder and never cleaned up. Files from the last 24 hours are kept.',
    roots: (b) => existing([b.temp]),
  },
  {
    id: 'temp_windows', group: 'windows', name: 'Windows temporary files', level: 'safe', minAge: DAY, admin: true,
    desc: 'The same kind of leftovers, from Windows itself and from programs that run as administrator.',
    roots: (b) => existing([path.join(b.windir, 'Temp')]),
  },
  {
    id: 'update_cache', group: 'windows', name: 'Windows Update downloads', level: 'safe', minAge: 3 * DAY, admin: true,
    desc: 'Update files Windows already installed. If it ever needs one again it downloads it again.',
    roots: (b) => existing([path.join(b.windir, 'SoftwareDistribution', 'Download')]),
  },
  {
    id: 'delivery_opt', group: 'windows', name: 'Delivery Optimization cache', level: 'safe', admin: true,
    desc: 'Copies of updates Windows keeps to share with other PCs. Not needed to keep Windows up to date.',
    roots: (b) => existing([path.join(b.windir, 'ServiceProfiles', 'NetworkService', 'AppData', 'Local', 'Microsoft', 'Windows', 'DeliveryOptimization', 'Cache')]),
    pre: () => ps('Delete-DeliveryOptimizationCache -Force -ErrorAction SilentlyContinue', { timeout: 120000 }),
  },
  {
    id: 'crash_dumps', group: 'windows', name: 'Crash dumps and error reports', level: 'safe', admin: true,
    desc: 'Memory snapshots and reports saved when an app, a game, a driver or Windows crashed. Only useful to developers — some are several GB.',
    roots: (b) => existing([
      path.join(b.local, 'CrashDumps'), path.join(b.windir, 'Minidump'), path.join(b.windir, 'LiveKernelReports'),
      path.join(b.local, 'Microsoft', 'Windows', 'WER'),
      path.join(b.programData, 'Microsoft', 'Windows', 'WER', 'ReportArchive'), path.join(b.programData, 'Microsoft', 'Windows', 'WER', 'ReportQueue'), path.join(b.programData, 'Microsoft', 'Windows', 'WER', 'Temp'),
    ]),
    files: (b) => [path.join(b.windir, 'MEMORY.DMP')],
  },
  {
    id: 'win_logs', group: 'windows', name: 'Old Windows log files', level: 'safe', minAge: 7 * DAY, admin: true, match: /\.(log|cab|etl)$/i,
    desc: 'Setup and repair logs (CBS, DISM) older than a week. On some PCs they grow to several GB.',
    roots: (b) => existing([path.join(b.windir, 'Logs', 'CBS'), path.join(b.windir, 'Logs', 'DISM')]),
  },
  {
    id: 'thumbs', group: 'windows', name: 'Thumbnail cache', level: 'safe', match: /^(thumbcache|iconcache)_.*\.db$/i, maxDepth: 0,
    desc: 'Picture and icon previews Explorer saved. It makes new ones when you open a folder. The ones Explorer is using right now are skipped.',
    roots: (b) => existing([path.join(b.local, 'Microsoft', 'Windows', 'Explorer')]),
  },
  {
    id: 'driver_installers', group: 'windows', name: 'Old graphics driver installers', level: 'safe', admin: true,
    desc: 'AMD and NVIDIA unpack every driver download to C:\\AMD or C:\\NVIDIA and keep it. Your installed driver stays exactly as it is.',
    roots: (b) => existing([path.join(b.drive, 'AMD'), path.join(b.drive, 'NVIDIA'), path.join(b.programData, 'NVIDIA Corporation', 'Downloader')]),
  },
  {
    id: 'recycle', group: 'windows', name: 'Recycle Bin', level: 'review', skipName: /^desktop\.ini$/i,
    desc: 'Files you deleted before. Emptying it frees the space for good — you can’t get them back afterwards.',
    roots: (b) => existing(b.recycle),
  },
  chromium('chrome', 'Google Chrome', (b) => path.join(b.local, 'Google', 'Chrome', 'User Data'), ['chrome.exe']),
  chromium('edge', 'Microsoft Edge', (b) => path.join(b.local, 'Microsoft', 'Edge', 'User Data'), ['msedge.exe']),
  chromium('brave', 'Brave', (b) => path.join(b.local, 'BraveSoftware', 'Brave-Browser', 'User Data'), ['brave.exe']),
  chromium('vivaldi', 'Vivaldi', (b) => path.join(b.local, 'Vivaldi', 'User Data'), ['vivaldi.exe']),
  chromium('opera', 'Opera', (b) => path.join(b.local, 'Opera Software', 'Opera Stable'), ['opera.exe'], true),
  chromium('operagx', 'Opera GX', (b) => path.join(b.local, 'Opera Software', 'Opera GX Stable'), ['opera.exe'], true),
  {
    id: 'firefox', group: 'browsers', name: 'Firefox cache', level: 'safe', procs: ['firefox.exe'], app: 'Firefox',
    desc: 'Saved copies of web pages and images. Firefox downloads them again when it needs them. Logins, history, bookmarks and passwords are not touched.',
    roots: async (b) => {
      const profiles = await subdirs(path.join(b.local, 'Mozilla', 'Firefox', 'Profiles'), () => true);
      return existing(profiles.flatMap((p) => [path.join(p, 'cache2'), path.join(p, 'startupCache')]));
    },
  },
  {
    id: 'shaders', group: 'apps', name: 'Graphics shader caches', level: 'review',
    desc: 'Game shaders your graphics driver saved. Clear them if games stutter or crash after a driver update. The first start of each game afterwards loads a little slower while they are rebuilt.',
    roots: (b) => existing([
      path.join(b.local, 'D3DSCache'), path.join(b.local, 'NVIDIA', 'DXCache'), path.join(b.local, 'NVIDIA', 'GLCache'),
      path.join(b.localLow, 'NVIDIA', 'PerDriverVersion', 'DXCache'), path.join(b.localLow, 'NVIDIA', 'PerDriverVersion', 'GLCache'),
      path.join(b.programData, 'NVIDIA Corporation', 'NV_Cache'),
      path.join(b.local, 'AMD', 'DxCache'), path.join(b.local, 'AMD', 'DxcCache'), path.join(b.local, 'AMD', 'Dx9Cache'), path.join(b.local, 'AMD', 'VkCache'), path.join(b.local, 'AMD', 'GLCache'),
      path.join(b.localLow, 'Intel', 'ShaderCache'), path.join(b.local, 'Intel', 'ShaderCache'),
    ]),
  },
  {
    id: 'discord', group: 'apps', name: 'Discord cache', level: 'safe', procs: ['discord.exe'], app: 'Discord',
    desc: 'Images, videos and emojis Discord saved from chats. It loads them again when you scroll back.',
    roots: (b) => existing(['Cache', 'Code Cache', 'GPUCache'].map((c) => path.join(b.roaming, 'discord', c))),
  },
  {
    id: 'steam', group: 'apps', name: 'Steam web cache', level: 'safe', procs: ['steam.exe', 'steamwebhelper.exe'], app: 'Steam',
    desc: 'Store and community pages Steam saved. Your games, downloads and settings are not touched.',
    roots: (b) => existing([path.join(b.local, 'Steam', 'htmlcache')]),
  },
  {
    id: 'epic', group: 'apps', name: 'Epic Games Launcher web cache', level: 'safe', procs: ['epicgameslauncher.exe', 'epicwebhelper.exe'], app: 'the Epic Games Launcher',
    desc: 'Store pages the launcher saved. Your games and settings are not touched.',
    roots: (b) => subdirs(path.join(b.local, 'EpicGamesLauncher', 'Saved'), (n) => /^webcache/i.test(n)),
  },
  {
    id: 'spotify', group: 'apps', name: 'Spotify cache', level: 'safe', procs: ['spotify.exe'], app: 'Spotify',
    desc: 'Songs Spotify saved while you listened. Downloaded playlists stay; the rest streams again.',
    roots: (b) => existing([path.join(b.local, 'Spotify', 'Data'), path.join(b.local, 'Packages', 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0', 'LocalCache', 'Spotify', 'Data')]),
  },
  {
    id: 'old_downloads', group: 'yours', name: 'Old installers and archives in Downloads', level: 'review', perFile: true, method: 'trash', minAge: 30 * DAY, maxDepth: 1,
    match: /\.(exe|msi|msix|msixbundle|appx|appxbundle|zip|7z|rar|iso|img|tar|gz|tgz)$/i,
    desc: 'Setup files and archives you downloaded more than a month ago — usually the program is installed already. They go to the Recycle Bin, so you can still get them back.',
    roots: (b) => existing([b.downloads]),
    full: { maxDepth: null },
  },
  {
    id: 'big_files', group: 'yours', name: `Big files (over ${BIG >= GB ? `${Math.round(BIG / GB)} GB` : `${Math.round(BIG / 1024 / 1024)} MB`})`, level: 'review', perFile: true, method: 'trash', minSize: BIG, skipDir: USER_SKIP_DIRS, skipName: SYSTEM_FILES, skipPrograms: true, budget: 25000,
    desc: 'The biggest files in Downloads, Desktop, Documents and Videos — old game clips, videos, disk images. Only tick what you don’t need any more. They go to the Recycle Bin.',
    roots: (b, mode) => existing(mode === 'full' ? [b.home, ...b.drives] : [b.downloads, b.desktop, b.documents, b.videos]),
    full: {
      budget: 240000,
      skipDir: (name, dir, root, b) => USER_SKIP_DIRS.test(name) || (dir === root && b.drives.includes(root) && DRIVE_SKIP_DIRS.test(name)),
      desc: 'Every file over this size on all your drives — outside Windows, installed programs and game libraries: old videos, clips, disk images, backups. Only tick what you don’t need any more. They go to the Recycle Bin.',
    },
  },
];

// ---------- Locations ----------
let sandbox = null; // demo mode: every location lives in this folder, filled with harmless generated files

function demoBases(root) {
  const home = path.join(root, 'Users', 'Gamer');
  const local = path.join(home, 'AppData', 'Local');
  return {
    home, local, temp: path.join(local, 'Temp'), roaming: path.join(home, 'AppData', 'Roaming'), localLow: path.join(home, 'AppData', 'LocalLow'),
    windir: path.join(root, 'Windows'), programData: path.join(root, 'ProgramData'), drive: root, drives: [root],
    recycle: [path.join(root, '$Recycle.Bin', 'S-1-5-21-0-0-0-1001')],
    downloads: path.join(home, 'Downloads'), desktop: path.join(home, 'Desktop'), documents: path.join(home, 'Documents'), videos: path.join(home, 'Videos'),
  };
}

/** Fixed drives (C:\, D:\, …) and the current user's recycle bin folder on each (X:\$Recycle.Bin\<SID>). */
async function driveDirs() {
  const [who, drives] = await Promise.all([run('whoami', ['/user', '/fo', 'csv', '/nh']), ps('(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3").DeviceID', { timeout: 20000 })]);
  const sid = (who.stdout.match(/"(S-1-[\d-]+)"/) || [])[1];
  const letters = drives.stdout.split(/\r?\n/).map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]:$/.test(s));
  const roots = (letters.length ? letters : [process.env.SystemDrive || 'C:']).map((d) => `${d}\\`);
  return { drives: roots, recycle: sid ? roots.map((d) => path.join(d, '$Recycle.Bin', sid)) : [] };
}

async function bases(folders = {}) {
  if (DEMO) return demoBases(sandbox);
  const env = process.env;
  const home = env.USERPROFILE || os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const dd = await driveDirs().catch(() => ({ drives: [`${env.SystemDrive || 'C:'}\\`], recycle: [] }));
  return {
    home, local, temp: env.TEMP || os.tmpdir(), roaming: env.APPDATA || path.join(home, 'AppData', 'Roaming'), localLow: path.join(home, 'AppData', 'LocalLow'),
    windir: env.WINDIR || env.SystemRoot || 'C:\\Windows', programData: env.ProgramData || 'C:\\ProgramData', drive: `${env.SystemDrive || 'C:'}\\`,
    drives: dd.drives, recycle: dd.recycle,
    downloads: folders.downloads || path.join(home, 'Downloads'), desktop: folders.desktop || path.join(home, 'Desktop'),
    documents: folders.documents || path.join(home, 'Documents'), videos: folders.videos || path.join(home, 'Videos'),
  };
}

/** Set file dates (creation + last write) to `days` ago. Used for the demo files and by the tests. */
async function ageFiles(list) {
  for (const { p, days } of list) {
    const t = new Date(Date.now() - days * DAY);
    fs.utimesSync(p, t, t);
  }
  if (!IS_WIN || !list.length) return;
  const tmp = path.join(os.tmpdir(), `frameforge-age-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(list.map(({ p, days }) => ({ p, d: days }))));
  try {
    await ps(`$l = Get-Content -Raw -LiteralPath ${q(tmp)} | ConvertFrom-Json; foreach ($i in $l) { $d = (Get-Date).AddDays(-[double]$i.d); $f = Get-Item -LiteralPath $i.p -Force; $f.CreationTime = $d; $f.LastWriteTime = $d }`, { timeout: 60000 });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Demo mode without a test folder: generate a small, harmless sample PC under user data (once). */
async function seedDemo(root) {
  if (fs.existsSync(path.join(root, '.seeded'))) return;
  const b = demoBases(root);
  const MB = 1024 * 1024;
  const files = [
    [path.join(b.temp, 'setup_4821.tmp'), 3 * MB, 12], [path.join(b.temp, 'chrome_installer.log'), 0.4 * MB, 30],
    [path.join(b.temp, 'NVIDIA', 'nvcpl_extract.bin'), 4 * MB, 40], [path.join(b.temp, 'just-now.tmp'), 0.5 * MB, 0],
    [path.join(b.windir, 'Temp', 'MpCmdRun.log'), 1 * MB, 9], [path.join(b.windir, 'SoftwareDistribution', 'Download', 'a1b2c3', 'windows11.0-kb5039212.cab'), 6 * MB, 20],
    [path.join(b.local, 'CrashDumps', 'Game.exe.15320.dmp'), 5 * MB, 15], [path.join(b.windir, 'LiveKernelReports', 'WATCHDOG-20260911.dmp'), 4 * MB, 45],
    [path.join(b.windir, 'Logs', 'CBS', 'CbsPersist_20260801.cab'), 2 * MB, 80],
    [path.join(b.local, 'Microsoft', 'Windows', 'Explorer', 'thumbcache_256.db'), 2 * MB, 5],
    [path.join(b.drive, 'AMD', 'AMD-Software-Installer', 'Packages', 'Drivers', 'driver.cab'), 7 * MB, 60],
    [path.join(b.recycle[0], '$RX1Y2Z3.mp4'), 3 * MB, 6], [path.join(b.recycle[0], '$IX1Y2Z3.mp4'), 544, 6],
    [path.join(b.local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'Cache_Data', 'f_000a1b'), 2 * MB, 2],
    [path.join(b.local, 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache', 'js', 'index'), 1 * MB, 2],
    [path.join(b.local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data', 'data_1'), 3 * MB, 1],
    [path.join(b.local, 'NVIDIA', 'DXCache', 'shader_1.nvph'), 2 * MB, 10],
    [path.join(b.roaming, 'discord', 'Cache', 'Cache_Data', 'f_0001'), 2 * MB, 3],
    [path.join(b.downloads, 'SteamSetup.exe'), 2 * MB, 120], [path.join(b.downloads, 'mod-pack.zip'), 3 * MB, 75],
    [path.join(b.downloads, 'new-driver.exe'), 1 * MB, 2], [path.join(b.videos, 'Captures', 'Clip 2026-05-01.mp4'), 9 * MB, 180],
    [path.join(b.documents, 'notes.txt'), 1024, 100],
  ];
  for (const [p, size] of files) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(Math.round(size), 7)); // harmless filler bytes
  }
  await ageFiles(files.map(([p, , days]) => ({ p, days })));
  fs.writeFileSync(path.join(root, '.seeded'), 'FrameForge Cleaner demo files — safe to delete.');
}

// ---------- Scan ----------
let busy = null; // 'scan' | 'clean'
let cancelled = false;
let result = null; // { at, cats: [{ def, roots, entries, … }] }
let seq = 0;
let progress = null;

/** Lower-case names of running programs. */
async function runningProcs() {
  if (DEMO) return new Set(String(process.env.FRAMEFORGE_DEMO_RUNNING || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean));
  const r = await run('tasklist', ['/fo', 'csv', '/nh'], { timeout: 20000 });
  return new Set(r.stdout.split(/\r?\n/).map((l) => (l.match(/^"([^"]+)"/) || [])[1]).filter(Boolean).map((s) => s.toLowerCase()));
}

const touched = (s) => Math.max(s.mtimeMs, s.birthtimeMs || 0); // the newest of "made" and "changed"
const busyCode = (e) => e && ['EBUSY', 'EPERM', 'EACCES'].includes(e.code);

function makeTicker(onProgress) {
  let last = 0;
  return (p, force) => {
    progress = p;
    const now = Date.now();
    if (force || now - last > 120) {
      last = now;
      try { onProgress(p); } catch {}
    }
  };
}

/** Walk one folder (no junctions/symlinks), collecting the files that match the category's filters. */
async function walk(root, def, cat, ctx) {
  const stack = [{ dir: root, depth: 0 }];
  const now = Date.now();
  while (stack.length) {
    if (cancelled || Date.now() > ctx.deadline || cat.entries.length > 500000) {
      cat.partial = true;
      return;
    }
    const { dir, depth } = stack.pop();
    let list;
    try {
      list = await fsp.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (dir === root && busyCode(e)) cat.denied++;
      continue;
    }
    if (def.skipPrograms && looksInstalled(list, dir, dir === root)) continue;
    const files = [];
    for (const d of list) {
      if (d.isSymbolicLink()) continue; // junctions and links point somewhere else: never follow or delete them
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (typeof def.skipDir === 'function' ? def.skipDir(d.name, dir, root, ctx.b) : def.skipDir && def.skipDir.test(d.name)) continue;
        if (def.maxDepth == null || depth < def.maxDepth) stack.push({ dir: p, depth: depth + 1 });
      } else if (d.isFile() && (!def.match || def.match.test(d.name)) && !(def.skipName && def.skipName.test(d.name))) files.push(p);
    }
    for (let i = 0; i < files.length; i += 64) {
      const stats = await Promise.all(files.slice(i, i + 64).map((p) => fsp.lstat(p).then((s) => [p, s], () => null)));
      for (const x of stats) {
        if (!x || !x[1].isFile()) continue;
        const [p, s] = x;
        if (def.minAge && now - touched(s) < def.minAge) {
          cat.kept++;
          continue;
        }
        if (def.minSize && s.size < def.minSize) continue;
        cat.entries.push({ id: `f${++seq}`, p, s: s.size, m: s.mtimeMs, t: touched(s) });
        ctx.files++;
        ctx.bytes += s.size;
      }
      ctx.tick({ phase: 'scan', index: ctx.index, total: DEFS.length, name: def.name, files: ctx.files, bytes: ctx.bytes, current: dir });
    }
  }
}

/** Files in OneDrive that are online-only use no space here: leave them out. Others get a OneDrive flag. */
async function cloudCheck(cat) {
  if (DEMO || !IS_WIN || !cat.entries.length) return;
  const tmp = path.join(os.tmpdir(), `frameforge-attr-${crypto.randomUUID()}.json`);
  fs.writeFileSync(tmp, JSON.stringify(cat.entries.map((e) => e.p)));
  try {
    const r = await ps(`$l = Get-Content -Raw -LiteralPath ${q(tmp)} | ConvertFrom-Json; foreach ($p in @($l)) { try { [int64](Get-Item -LiteralPath $p -Force).Attributes } catch { -1 } }`, { timeout: 60000 });
    const attrs = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== '').map(Number);
    if (attrs.length !== cat.entries.length) return;
    const od = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean).map((d) => d.toLowerCase() + path.sep);
    cat.entries = cat.entries.filter((e, i) => {
      const a = attrs[i];
      if (a >= 0 && a & (0x1000 | 0x40000 | 0x400000)) return false; // offline / recall on open / recall on data access
      e.cloud = (a >= 0 && a & (0x80000 | 0x100000)) || od.some((d) => e.p.toLowerCase().startsWith(d));
      return true;
    });
  } catch {} finally {
    fs.rmSync(tmp, { force: true });
  }
}

async function scanCat(base, b, running, ctx) {
  const def = ctx.mode === 'full' && base.full ? { ...base, ...base.full } : base; // a full check looks further
  const cat = { def, roots: [], entries: [], denied: 0, kept: 0, partial: false, last: null };
  try {
    cat.roots = await def.roots(b, ctx.mode);
  } catch {}
  // A folder can belong to only one category (e.g. TEMP pointing at C:\Windows\Temp).
  cat.roots = cat.roots.filter((r) => {
    const k = path.resolve(r).toLowerCase();
    if (ctx.seen.has(k)) return false;
    ctx.seen.add(k);
    return true;
  });
  ctx.deadline = Date.now() + (def.budget || 90000);
  for (const r of cat.roots) await walk(r, def, cat, ctx);
  for (const f of def.files ? def.files(b) : []) {
    const s = await fsp.lstat(f).catch(() => null);
    if (s && s.isFile()) {
      cat.roots.push(f);
      cat.entries.push({ id: `f${++seq}`, p: f, s: s.size, m: s.mtimeMs, t: touched(s) });
    }
  }
  if (def.perFile) {
    cat.entries.sort((x, y) => y.s - x.s);
    if (cat.entries.length > 300) cat.entries.length = 300;
    await cloudCheck(cat);
  }
  cat.running = (def.procs || []).some((p) => running.has(p));
  return cat;
}

function catView(c) {
  const d = c.def;
  const size = c.entries.reduce((n, e) => n + e.s, 0);
  let status = 'ok';
  let note = '';
  if (!c.roots.length) status = 'missing';
  else if (c.running && c.entries.length) {
    status = 'running';
    note = `${d.app || d.name} is open. Close it (also from the tray), then scan again — FrameForge doesn’t clear a cache an app is using.${d.id === 'edge' ? ' Edge can keep running in the background: turn off “Startup boost” and “Continue running background extensions” in Edge’s System settings.' : ''}`;
  } else if (c.denied && c.denied >= c.roots.length) {
    status = 'admin';
    note = 'Windows only lets FrameForge into these folders when it runs as administrator. Restart FrameForge and choose “Yes” on the admin prompt.';
  } else if (!c.entries.length) status = 'empty';
  if (status === 'ok' && c.kept) note = `${c.kept.toLocaleString('en-US')} newer file${c.kept === 1 ? '' : 's'} left alone — an app may still be using ${c.kept === 1 ? 'it' : 'them'}.`;
  if (c.partial) note = `${note ? note + ' ' : ''}Stopped looking after a while — there may be more.`.trim();
  return {
    id: d.id, group: d.group, name: d.name, desc: d.desc, level: d.level, perFile: !!d.perFile, method: d.method || 'delete',
    size, count: c.entries.length, status, note, selectable: status === 'ok' && c.entries.length > 0,
    selected: d.level === 'safe' && status === 'ok' && c.entries.length > 0,
    roots: c.roots.slice(0, 12), moreRoots: Math.max(0, c.roots.length - 12),
    items: d.perFile ? c.entries.map((e) => ({ id: e.id, name: path.basename(e.p), dir: path.dirname(e.p), size: e.s, at: e.t, cloud: !!e.cloud, dup: !!e.dup })) : undefined,
    last: c.last,
  };
}

function view() {
  if (!result) return null;
  const cats = result.cats.map(catView);
  const sum = (list) => list.filter((c) => c.status !== 'missing').reduce((n, c) => n + c.size, 0);
  // found = everything listed; junk = without the user's own files (those are only suggestions)
  return { at: result.at, partial: result.partial, mode: result.mode, cats, groups: GROUPS, found: sum(cats), junk: sum(cats.filter((c) => c.group !== 'yours')) };
}

async function scan(opts = {}, onProgress = () => {}) {
  if (busy) return { ok: false, busy, message: busy === 'scan' ? 'Already scanning.' : 'FrameForge is deleting files — hang on.' };
  busy = 'scan';
  cancelled = false;
  try {
    if (DEMO) {
      sandbox = process.env.FRAMEFORGE_CLEAN_SANDBOX || path.join(opts.userData || os.tmpdir(), 'cleaner-demo');
      if (!process.env.FRAMEFORGE_CLEAN_SANDBOX) await seedDemo(sandbox);
    }
    const tick = makeTicker(onProgress);
    tick({ phase: 'scan', index: 0, total: DEFS.length, name: 'Getting ready', files: 0, bytes: 0 }, true);
    const mode = opts.mode === 'full' ? 'full' : 'quick';
    const [b, running] = await Promise.all([bases(opts.folders), runningProcs().catch(() => new Set())]);
    const ctx = { seen: new Set(), files: 0, bytes: 0, tick, index: 0, deadline: 0, mode, b };
    const cats = [];
    for (const [i, def] of DEFS.entries()) {
      if (cancelled) break;
      ctx.index = i;
      tick({ phase: 'scan', index: i, total: DEFS.length, name: def.name, files: ctx.files, bytes: ctx.bytes }, true);
      cats.push(await scanCat(def, b, running, ctx));
    }
    // A big old installer in Downloads shows up once, under "Old installers".
    const old = cats.find((c) => c.def.id === 'old_downloads');
    const big = cats.find((c) => c.def.id === 'big_files');
    if (old && big) {
      const ids = new Set(old.entries.map((e) => e.p.toLowerCase()));
      big.entries = big.entries.filter((e) => !ids.has(e.p.toLowerCase()));
    }
    // The same file (name and size) in two places: one copy is usually enough.
    const yours = cats.filter((c) => c.def.perFile).flatMap((c) => c.entries);
    const twice = new Map();
    for (const e of yours) {
      const k = `${path.basename(e.p).toLowerCase()}|${e.s}`;
      twice.set(k, (twice.get(k) || 0) + 1);
    }
    for (const e of yours) e.dup = twice.get(`${path.basename(e.p).toLowerCase()}|${e.s}`) > 1;
    result = { at: Date.now(), partial: cancelled, mode, cats };
    progress = null;
    return { ok: true, cancelled, result: view() };
  } finally {
    busy = null;
    progress = null;
  }
}

// ---------- Clean ----------
function inside(p, roots) {
  const f = path.resolve(p).toLowerCase();
  return roots.some((r) => {
    const root = path.resolve(r).toLowerCase();
    return f === root || f.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
}

async function moveToDemoBin(p) {
  const bin = demoBases(sandbox).recycle[0];
  fs.mkdirSync(bin, { recursive: true });
  await fsp.rename(p, path.join(bin, `$R${crypto.randomBytes(4).toString('hex').toUpperCase()}${path.extname(p)}`));
}

/** Remove one scanned file. Returns deleted | trashed | gone | inuse | changed | failed. */
async function removeOne(e, c, trash) {
  let s;
  try {
    s = await fsp.lstat(e.p);
  } catch (err) {
    return err.code === 'ENOENT' ? 'gone' : busyCode(err) ? 'inuse' : 'failed';
  }
  if (!s.isFile() || !inside(e.p, c.roots)) return 'failed';
  if (s.size !== e.s || Math.abs(s.mtimeMs - e.m) > 2) return 'changed'; // written to since the scan: something is using it
  if ((c.def.method || 'delete') === 'trash') {
    try {
      if (DEMO) await moveToDemoBin(e.p);
      else await trash(e.p);
    } catch {
      return 'failed';
    }
    return fs.existsSync(e.p) ? 'failed' : 'trashed';
  }
  try {
    await fsp.unlink(e.p);
  } catch (err) {
    if (err.code === 'ENOENT') return 'gone';
    if (err.code !== 'EPERM' && err.code !== 'EACCES') return err.code === 'EBUSY' ? 'inuse' : 'failed';
    try {
      await fsp.chmod(e.p, 0o666); // read-only files
      await fsp.unlink(e.p);
    } catch (err2) {
      return busyCode(err2) ? 'inuse' : err2.code === 'ENOENT' ? 'gone' : 'failed';
    }
  }
  return fs.existsSync(e.p) ? 'inuse' : 'deleted';
}

/**
 * Remove folders the clean left empty: only folders that held a deleted file, and their parents, up to (not
 * including) the category's own folders. A folder that still has anything in it stays.
 */
async function pruneDirs(dirs, c) {
  const roots = new Set(c.roots.map((r) => path.resolve(r).toLowerCase()));
  const all = new Set();
  for (const d of dirs) {
    let cur = path.resolve(d);
    while (inside(cur, c.roots) && !roots.has(cur.toLowerCase())) {
      all.add(cur);
      cur = path.dirname(cur);
    }
  }
  const sorted = [...all].sort((a, b) => b.length - a.length);
  for (const d of sorted) {
    const s = await fsp.lstat(d).catch(() => null);
    if (!s || !s.isDirectory() || s.isSymbolicLink()) continue;
    await fsp.rmdir(d).catch(() => {}); // fails (and stays) if anything is still inside
  }
}

const fmt = (n) => {
  if (n >= GB) return `${(n / GB).toFixed(n >= 10 * GB ? 0 : 1)} GB`;
  if (n >= 1024 * 1024) return `${Math.round(n / 1024 / 1024)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
};

/**
 * Delete what the user picked: sel = { cats: [ids], files: { catId: [fileIds] } }.
 * Caches and junk are deleted; the user's own files go to the Recycle Bin (opts.trash).
 */
async function clean(sel = {}, opts = {}, onProgress = () => {}) {
  if (busy) return { ok: false, message: busy === 'scan' ? 'Wait for the scan to finish.' : 'Already deleting.' };
  if (!result) return { ok: false, message: 'Scan first, then pick what to delete.' };
  busy = 'clean';
  cancelled = false;
  const tick = makeTicker(onProgress);
  try {
    const pickCats = new Set(sel.cats || []);
    const plan = [];
    for (const c of result.cats) {
      const ids = new Set(((sel.files || {})[c.def.id]) || []);
      const ents = c.def.perFile ? c.entries.filter((e) => ids.has(e.id)) : pickCats.has(c.def.id) ? c.entries.slice() : [];
      if (ents.length) plan.push({ c, ents });
    }
    if (!plan.length) return { ok: false, message: 'Nothing is selected.' };
    // Empty the Recycle Bin before anything new goes into it; the user's own files last.
    const rank = (c) => (c.def.id === 'recycle' ? 0 : c.def.method === 'trash' ? 2 : 1);
    plan.sort((x, y) => rank(x.c) - rank(y.c));
    const running = await runningProcs().catch(() => new Set());
    const total = plan.reduce((n, x) => n + x.ents.length, 0);
    const sum = { freed: 0, deleted: 0, trashed: 0, trashedBytes: 0, inUse: 0, failed: 0, skippedCats: [] };
    let done = 0;
    for (const { c, ents } of plan) {
      const d = c.def;
      const last = { freed: 0, deleted: 0, trashed: 0, inUse: 0, failed: 0, message: '' };
      if ((d.procs || []).some((p) => running.has(p))) {
        last.message = `${d.app || d.name} is open — close it and try again. Nothing was deleted here.`;
        last.skipped = true;
        sum.skippedCats.push(d.name);
        c.last = last;
        done += ents.length;
        continue;
      }
      if (d.pre && !DEMO) await d.pre().catch(() => {});
      const touchedDirs = new Set();
      const removed = new Set();
      for (const e of ents) {
        if (cancelled) break;
        const r = await removeOne(e, c, opts.trash);
        if (r === 'deleted' || r === 'trashed' || r === 'gone') {
          removed.add(e.id);
          touchedDirs.add(path.dirname(e.p));
          if (r === 'deleted') {
            last.deleted++;
            last.freed += e.s;
          } else if (r === 'trashed') {
            last.trashed++;
            sum.trashedBytes += e.s;
          }
        } else if (r === 'inuse' || r === 'changed') last.inUse++;
        else last.failed++;
        done++;
        tick({ phase: 'clean', name: d.name, done, total, freed: sum.freed + last.freed, current: e.p });
      }
      await pruneDirs(touchedDirs, c);
      c.entries = c.entries.filter((e) => !removed.has(e.id));
      const parts = [];
      if (last.deleted) parts.push(`Deleted ${last.deleted.toLocaleString('en-US')} file${last.deleted === 1 ? '' : 's'} — ${fmt(last.freed)} freed`);
      if (last.trashed) parts.push(`Moved ${last.trashed} file${last.trashed === 1 ? '' : 's'} to the Recycle Bin`);
      if (last.inUse) parts.push(`${last.inUse.toLocaleString('en-US')} in use, left alone`);
      if (last.failed) parts.push(`${last.failed.toLocaleString('en-US')} couldn’t be deleted`);
      last.message = parts.join(' · ') || (cancelled ? 'Stopped before this one.' : 'Already gone.');
      c.last = last;
      for (const k of ['freed', 'deleted', 'trashed', 'inUse', 'failed']) sum[k] += last[k];
      if (cancelled) break;
    }
    tick({ phase: 'clean', name: 'Done', done: total, total, freed: sum.freed }, true);
    return { ok: true, cancelled, ...sum, result: view() };
  } finally {
    busy = null;
    progress = null;
  }
}

function cancel() {
  if (!busy) return false;
  cancelled = true;
  return true;
}

/** Path of a file in the "your own files" lists (for Show in folder). */
function filePath(id) {
  if (!result) return null;
  for (const c of result.cats) if (c.def.perFile) for (const e of c.entries) if (e.id === id) return e.p;
  return null;
}

/** Free space on the system drive. */
async function disk() {
  const root = IS_WIN ? `${process.env.SystemDrive || 'C:'}\\` : '/';
  try {
    const s = await fsp.statfs(root);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    return { drive: IS_WIN ? root.slice(0, 2) : '/', total, free, usePct: total ? Math.round(((total - free) / total) * 100) : 0 };
  } catch {
    return null;
  }
}

function state() {
  return { busy, progress, result: view() };
}

module.exports = { scan, clean, cancel, state, disk, filePath, ageFiles, DEFS, GROUPS, fmt };
