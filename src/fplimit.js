// FPS limiter. Games can only be capped from inside the game process, so FrameForge drives RivaTuner Statistics
// Server (RTSS), the frame limiter most tuners use: it sets the frame limit through RTSS's own RTSSHooks64.dll
// (the same interface MSI Afterburner uses), makes sure RTSS is running, and checks the value stuck.
//
// Two things make it work everywhere, not only in some games:
//   - RTSS's "Global" profile is only the template for apps that have no profile of their own. A game that RTSS
//     has seen before keeps its own profile (usually "no limit"), which would beat the Global value. So the limit
//     is written to every existing profile too — but only to profiles that have no limit of their own, so a cap
//     the user set inside RTSS is never overwritten. The names FrameForge capped are returned, so turning the
//     limiter off puts exactly those back.
//   - RTSS is installed on the spot when it is missing (Microsoft's winget store), started, and kept running.
const fs = require('fs');
const path = require('path');
const { run, ps, sleep, DEMO } = require('./util');

const MIN = 20;
const MAX = 1000;
const WINGET_ID = 'Guru3D.RTSS';
const DEFAULT_DIRS = ['C:\\Program Files (x86)\\RivaTuner Statistics Server', 'C:\\Program Files\\RivaTuner Statistics Server'];
const MAX_PROFILES = 400; // a pathological install can't make one PowerShell call run for minutes
const REG_KEYS = [
  'HKLM\\SOFTWARE\\WOW6432Node\\Unwinder\\RTSS',
  'HKLM\\SOFTWARE\\Unwinder\\RTSS',
  'HKCU\\SOFTWARE\\WOW6432Node\\Unwinder\\RTSS',
  'HKCU\\SOFTWARE\\Unwinder\\RTSS',
];

const demo = { installed: false, running: false, limit: 0, profiles: 0 };

function clamp(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX, Math.max(MIN, v)) : 60;
}

const hasDll = (dir) => !!dir && fs.existsSync(path.join(dir, 'RTSSHooks64.dll'));

async function regDir(key) {
  const r = await run('reg', ['query', key, '/v', 'InstallDir']);
  const m = /InstallDir\s+REG_SZ\s+(.+)/i.exec(r.stdout);
  return m ? m[1].trim() : null;
}

/** Folders that look like an RTSS install, for installs that wrote no registry value. */
function guessDirs() {
  const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean);
  const out = [];
  for (const root of roots) {
    try {
      for (const name of fs.readdirSync(root)) if (/riva|rtss/i.test(name)) out.push(path.join(root, name));
    } catch {
      // unreadable folder: not a place RTSS lives
    }
  }
  return out;
}

async function installDir() {
  const dirs = [];
  for (const key of REG_KEYS) {
    const d = await regDir(key);
    if (d) dirs.push(d);
  }
  dirs.push(...DEFAULT_DIRS, ...guessDirs());
  return dirs.find(hasDll) || null;
}

/** The app profiles RTSS has on disk (its Global template is not one of them). */
function profileNames(dir) {
  try {
    return fs
      .readdirSync(path.join(dir, 'Profiles'))
      .filter((f) => /\.cfg$/i.test(f))
      .map((f) => f.replace(/\.cfg$/i, ''))
      .filter((n) => n.toLowerCase() !== 'global')
      .slice(0, MAX_PROFILES);
  } catch {
    return [];
  }
}

async function isRunning() {
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq RTSS.exe', '/NH', '/FO', 'CSV']);
  return /"RTSS\.exe"/i.test(r.stdout);
}

// Talks to RTSSHooks64.dll. limit < 0 reads only; limit >= 0 sets the Global profile and every app profile that
// has no own limit (capList), and puts the profiles named in uncapList back to "no limit".
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FFRtss {
  [DllImport("kernel32", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr LoadLibraryA(string p);
  [DllImport("kernel32", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr h, string n);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl, CharSet = CharSet.Ansi)] delegate void Prof(string p);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl, CharSet = CharSet.Ansi)] delegate int Prop(string n, ref uint v, uint size);
  [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate void Upd();
  static T Fn<T>(IntPtr h, string n) where T : class {
    IntPtr p = GetProcAddress(h, n);
    if (p == IntPtr.Zero) throw new Exception("RTSSHooks64.dll has no " + n);
    return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
  }
  static string[] Split(string s) {
    if (string.IsNullOrEmpty(s)) return new string[0];
    return s.Split(new char[] { '|' }, StringSplitOptions.RemoveEmptyEntries);
  }
  public static string Apply(string dll, int limit, string capList, string uncapList) {
    IntPtr h = LoadLibraryA(dll);
    if (h == IntPtr.Zero) throw new Exception("Could not load RTSSHooks64.dll");
    var load = Fn<Prof>(h, "LoadProfile"); var save = Fn<Prof>(h, "SaveProfile");
    var get = Fn<Prop>(h, "GetProfileProperty"); var set = Fn<Prop>(h, "SetProfileProperty");
    var upd = Fn<Upd>(h, "UpdateProfiles");
    var capped = new List<string>();
    load("Global");
    if (limit >= 0) {
      uint v = (uint)limit;
      if (set("FramerateLimit", ref v, 4) == 0) throw new Exception("RTSS refused the FPS limit");
      save("Global");
    }
    foreach (string name in Split(capList)) {
      load(name);
      uint cur = 0;
      if (get("FramerateLimit", ref cur, 4) == 0) continue;
      if (cur != 0) continue;
      uint v = (uint)limit;
      if (set("FramerateLimit", ref v, 4) != 0) { save(name); capped.Add(name); }
    }
    foreach (string name in Split(uncapList)) {
      load(name);
      uint cur = 0;
      if (get("FramerateLimit", ref cur, 4) == 0) continue;
      uint z = 0;
      if (set("FramerateLimit", ref z, 4) != 0) save(name);
    }
    load("Global");
    uint back = 0;
    if (get("FramerateLimit", ref back, 4) == 0) throw new Exception("Could not read the FPS limit back from RTSS");
    upd();
    var sb = new StringBuilder();
    sb.Append(back.ToString());
    foreach (string n in capped) { sb.Append('|'); sb.Append(n); }
    return sb.ToString();
  }
}
"@
[Console]::Out.Write('RESULT=' + [FFRtss]::Apply($env:FF_RTSS_DLL, [int]$env:FF_RTSS_LIMIT, $env:FF_RTSS_CAP, $env:FF_RTSS_UNCAPPED))
`;

async function hooks(dir, limit, capList = [], uncapList = []) {
  const r = await ps(SCRIPT, {
    env: {
      ...process.env,
      FF_RTSS_DLL: path.join(dir, 'RTSSHooks64.dll'),
      FF_RTSS_LIMIT: String(limit),
      FF_RTSS_CAP: capList.join('|'),
      FF_RTSS_UNCAPPED: uncapList.join('|'),
    },
    timeout: 90000,
  });
  const m = /RESULT=(\d+)((?:\|[^\r\n|]*)*)/.exec(r.stdout);
  if (m) return { ok: true, limit: Number(m[1]), capped: (m[2] || '').split('|').filter(Boolean) };
  return { ok: false, message: (r.stderr || r.stdout || 'RTSS did not answer').split(/\r?\n/).filter(Boolean)[0].slice(0, 200) };
}

/** What is going on right now: is RTSS there, is it running, and what limit does it have (0 = none). */
async function status() {
  if (DEMO) return { ...demo };
  const dir = await installDir();
  if (!dir) return { installed: false, running: false, limit: 0, profiles: 0 };
  const running = await isRunning();
  const r = await hooks(dir, -1);
  return { installed: true, running, limit: r.ok ? r.limit : null, profiles: profileNames(dir).length, dir };
}

async function startRtss(dir) {
  if (await isRunning()) return true;
  const exe = path.join(dir, 'RTSS.exe');
  if (!fs.existsSync(exe)) return false;
  await ps(`Start-Process -FilePath '${exe.replace(/'/g, "''")}' -WorkingDirectory '${dir.replace(/'/g, "''")}'`, { timeout: 20000 });
  for (let i = 0; i < 24; i++) {
    await sleep(250);
    if (await isRunning()) return true;
  }
  return false;
}

/**
 * Cap games at `fps` (0 = remove the cap). Installs RTSS from winget the first time it's needed, starts it, sets the
 * limit on Global and on every app profile that has no own limit, and reads it back — so the answer is only ok when
 * RTSS really holds the number.
 *
 *   install  – called when RTSS is missing; must return { ok, message }
 *   previous – profile names capped last time, uncapped again when the limiter is switched off
 */
async function apply(fps, { install = null, previous = [] } = {}) {
  const want = fps ? clamp(fps) : 0;
  if (DEMO) {
    if (want && !demo.installed) {
      if (install) await install();
      demo.installed = true;
    }
    demo.running = demo.installed;
    demo.limit = want;
    demo.profiles = want ? Math.max(demo.profiles, 1) : 0;
    return { ok: true, limit: want, capped: want ? ['Demo game'] : [] };
  }
  let dir = await installDir();
  if (!dir) {
    if (!want) return { ok: true, limit: 0, capped: [] };
    if (!install) return { ok: false, message: 'RivaTuner Statistics Server (RTSS) is not installed.' };
    const r = await install();
    if (!r || !r.ok) return { ok: false, message: `RivaTuner Statistics Server (RTSS) could not be installed: ${(r && r.message) || 'no reason given'}` };
    dir = await installDir();
    if (!dir) return { ok: false, message: 'RTSS installed, but its files were not found.' };
  }
  const cap = want ? profileNames(dir) : [];
  const uncap = want ? [] : previous;
  const r = await hooks(dir, want, cap, uncap);
  if (!r.ok) return r;
  if (r.limit !== want) return { ok: false, message: `RTSS kept ${r.limit || 'no limit'} instead of ${want || 'no limit'} FPS.` };
  if (want && !(await startRtss(dir))) return { ok: false, message: 'The limit is saved, but RTSS would not start.' };
  return { ok: true, limit: want, capped: r.capped };
}

/** True when RTSS is not holding the limit the user chose (another tool changed it, or RTSS was closed). */
async function drifted(fps) {
  const s = await status();
  if (!s.installed) return true;
  return !s.running || s.limit !== clamp(fps);
}

module.exports = { _hooks: hooks, _profileNames: profileNames, apply, status, drifted, clamp, MIN, MAX, WINGET_ID };
