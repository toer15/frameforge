// FPS limiter. Games can only be capped from inside the game process, so FrameForge drives RivaTuner Statistics
// Server (RTSS), the frame limiter most tuners use: it sets the frame limit through RTSS's own RTSSHooks64.dll
// (the same interface MSI Afterburner uses), makes sure RTSS is running, and checks the value stuck.
//
// Three things make it work everywhere, not only in some games:
//   - RTSS's global profile is the template for apps that have no profile of their own. A game that RTSS has seen
//     before keeps its own profile (usually "no limit"), which would beat the global value. So the limit is
//     written to every existing profile too — but only to profiles that have no limit of their own, so a cap the
//     user set inside RTSS is never overwritten. The names FrameForge capped are returned, so turning the limiter
//     off puts exactly those back.
//   - RTSS can have its whole frame limiter switched off in its own properties. Setting a number alone is not
//     enough: the RTSSHOOKSFLAG_LIMITER_DISABLED flag (bit 4) is cleared too. RTSS keeps that flag per hook
//     context, so a 32-bit bridge does the same for 32-bit games.
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

const demo = { installed: false, running: false, limit: 0, enabled: false, profiles: 0 };

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

/** The app profiles RTSS has on disk (its global template is not one of them). */
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

// Talks to RTSSHooks64.dll, or RTSSHooks.dll from 32-bit PowerShell. limit < 0 reads only; limit >= 0 sets the
// global profile and every app profile that has no own limit (capList), and puts the profiles named in uncapList
// back to "no limit". flagsOnly is the 32-bit pass: it only switches the limiter flag on and reads it back.
const scriptFor = (conv) => `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FFRtss {
  [DllImport("kernel32", CharSet = CharSet.Ansi, SetLastError = true)] static extern IntPtr LoadLibraryA(string p);
  [DllImport("kernel32", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr h, string n);
  [DllImport("user32", CharSet = CharSet.Auto)] static extern IntPtr FindWindow(string cls, string title);
  [DllImport("user32", CharSet = CharSet.Auto)] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [UnmanagedFunctionPointer(CallingConvention.${conv}, CharSet = CharSet.Ansi)] delegate void Prof(string p);
  [UnmanagedFunctionPointer(CallingConvention.${conv}, CharSet = CharSet.Ansi)] delegate int Prop(string n, ref uint v, uint size);
  [UnmanagedFunctionPointer(CallingConvention.${conv})] delegate void Upd();
  [UnmanagedFunctionPointer(CallingConvention.${conv})] delegate uint SetFlagsFn(uint andMask, uint xorMask);
  [UnmanagedFunctionPointer(CallingConvention.${conv})] delegate uint GetFlagsFn();
  static string DllName;
  static T Fn<T>(IntPtr h, string n) where T : class {
    IntPtr p = GetProcAddress(h, n);
    if (p == IntPtr.Zero) throw new Exception(DllName + " has no " + n);
    return Marshal.GetDelegateForFunctionPointer(p, typeof(T)) as T;
  }
  static string[] Split(string s) {
    if (string.IsNullOrEmpty(s)) return new string[0];
    return s.Split(new char[] { '|' }, StringSplitOptions.RemoveEmptyEntries);
  }
  static void NotifyGui() {
    IntPtr h = FindWindow(null, "RTSS");
    if (h == IntPtr.Zero) h = FindWindow(null, "RivaTuner Statistics Server");
    if (h != IntPtr.Zero) PostMessage(h, 0x8000u + 100u, IntPtr.Zero, IntPtr.Zero); // WM_RTSS_UPDATESETTINGS
  }
  public static string Apply(string dll, int limit, string capList, string uncapList, bool flagsOnly) {
    DllName = System.IO.Path.GetFileName(dll);
    IntPtr h = LoadLibraryA(dll);
    if (h == IntPtr.Zero) throw new Exception("Could not load " + DllName);
    var load = Fn<Prof>(h, "LoadProfile"); var save = Fn<Prof>(h, "SaveProfile");
    var get = Fn<Prop>(h, "GetProfileProperty"); var set = Fn<Prop>(h, "SetProfileProperty");
    var upd = Fn<Upd>(h, "UpdateProfiles");
    var getFlags = Fn<GetFlagsFn>(h, "GetFlags"); var setFlags = Fn<SetFlagsFn>(h, "SetFlags");
    var capped = new List<string>();
    load(""); // RTSS's SDK uses the empty string for the global profile
    if (limit >= 0 && !flagsOnly) {
      uint denominator = 1; // make sure 144 means 144 FPS even if a fractional denominator was left behind
      set("FramerateLimitDenominator", ref denominator, 4);
      uint v = (uint)limit;
      if (set("FramerateLimit", ref v, 4) == 0) throw new Exception("RTSS refused the FPS limit");
      save("");
      upd();
      load("");
    }
    // Clearing bit 4 is what RTSS's own "Enable framerate limiter" option does. Do it for the 64-bit hook
    // context here and for the 32-bit one in the second pass.
    if (limit > 0) {
      // SetFlags' return value differs between RTSS builds (some return the old flags), so read the real state
      // afterwards instead of trusting it. The final GetFlags below is what apply() checks.
      setFlags(0xFFFFFFFBu, 0);
      upd();
      NotifyGui();
    }
    if (!flagsOnly) {
      foreach (string name in Split(capList)) {
        load(name);
        uint cur = 0;
        if (get("FramerateLimit", ref cur, 4) == 0) continue;
        if (cur != 0) continue;
        uint one = 1; // a profile's fractional denominator must not turn 144 into 0.144 FPS
        set("FramerateLimitDenominator", ref one, 4);
        uint v = (uint)limit;
        if (set("FramerateLimit", ref v, 4) != 0) { save(name); capped.Add(name); }
      }
      foreach (string name in Split(uncapList)) {
        load(name);
        uint cur = 0;
        if (get("FramerateLimit", ref cur, 4) == 0) continue;
        uint one = 1;
        set("FramerateLimitDenominator", ref one, 4);
        uint z = 0;
        if (set("FramerateLimit", ref z, 4) != 0) save(name);
      }
      load("");
    }
    uint back = 0;
    if (get("FramerateLimit", ref back, 4) == 0) throw new Exception("Could not read the FPS limit back from RTSS");
    uint current = getFlags();
    upd();
    var sb = new StringBuilder();
    sb.Append(back.ToString());
    sb.Append('|');
    sb.Append(((current & 4u) == 0u) ? "1" : "0");
    foreach (string n in capped) { sb.Append('|'); sb.Append(n); }
    return sb.ToString();
  }
}
"@
[Console]::Out.Write('RESULT=' + [FFRtss]::Apply($env:FF_RTSS_DLL, [int]$env:FF_RTSS_LIMIT, $env:FF_RTSS_CAP, $env:FF_RTSS_UNCAPPED, ($env:FF_RTSS_FLAGS_ONLY -eq '1')))
`;

const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const PS32 = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'SysWOW64', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function hooks(dir, limit, capList = [], uncapList = [], { bits = 64, flagsOnly = false } = {}) {
  const dll = path.join(dir, bits === 32 ? 'RTSSHooks.dll' : 'RTSSHooks64.dll');
  const exe = bits === 32 ? PS32 : 'powershell.exe';
  if (bits === 32 && !fs.existsSync(exe)) return { ok: false, skipped: true, message: '32-bit PowerShell is not available' };
  // The 32-bit DLL is old and its exports have shipped with both calling conventions. Try the Windows standard
  // first, then Cdecl. Each attempt is its own process, so a stack mismatch cannot touch FrameForge.
  const conventions = bits === 32 ? ['StdCall', 'Cdecl'] : ['Cdecl'];
  let last = { ok: false, message: 'RTSS did not answer' };
  for (const conv of conventions) {
    const r = await run(exe, [...PS_ARGS, scriptFor(conv)], {
      env: {
        ...process.env,
        FF_RTSS_DLL: dll,
        FF_RTSS_LIMIT: String(limit),
        FF_RTSS_CAP: capList.join('|'),
        FF_RTSS_UNCAPPED: uncapList.join('|'),
        FF_RTSS_FLAGS_ONLY: flagsOnly ? '1' : '0',
      },
      timeout: bits === 32 ? 20000 : 90000,
    });
    const m = /RESULT=(\d+)\|([01])((?:\|[^\r\n|]*)*)/.exec(r.stdout);
    if (m) return { ok: true, limit: Number(m[1]), enabled: m[2] === '1', capped: (m[3] || '').split('|').filter(Boolean) };
    last = { ok: false, message: (r.stderr || r.stdout || 'RTSS did not answer').split(/\r?\n/).filter(Boolean)[0].slice(0, 200) };
  }
  return last;
}

/** What is going on right now: is RTSS there, is it running, and what limit does it have (0 = none). */
async function status() {
  if (DEMO) return { ...demo };
  const dir = await installDir();
  if (!dir) return { installed: false, running: false, limit: 0, enabled: false, profiles: 0 };
  const running = await isRunning();
  const r = await hooks(dir, -1);
  return { installed: true, running, limit: r.ok ? r.limit : null, enabled: r.ok ? r.enabled : null, profiles: profileNames(dir).length, dir };
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
 * limit on the global profile and on every app profile that has no own limit, and reads it back — so the answer is
 * only ok when RTSS really holds the number.
 *
 *   install     – called when RTSS is missing; must return { ok, message }
 *   previous    – profile names capped last time, uncapped again when the limiter is switched off
 *   installOnly – install and report, without starting RTSS or changing any cap
 */
async function apply(fps, { install = null, previous = [], installOnly = false } = {}) {
  const want = fps ? clamp(fps) : 0;
  if (DEMO) {
    if ((want || installOnly) && !demo.installed) {
      if (install) await install();
      demo.installed = true;
    }
    if (installOnly) return { ok: true, installed: true, limit: demo.limit, enabled: demo.enabled, capped: [] };
    demo.running = demo.installed;
    demo.limit = want;
    demo.enabled = !!want;
    demo.profiles = want ? Math.max(demo.profiles, 1) : 0;
    return { ok: true, limit: want, enabled: demo.enabled, capped: want ? ['Demo game'] : [] };
  }
  let dir = await installDir();
  if (!dir) {
    if (!want && !installOnly) return { ok: true, limit: 0, enabled: false, capped: [] };
    if (!install) return { ok: false, message: 'RivaTuner Statistics Server (RTSS) is not installed.' };
    const r = await install();
    if (!r || !r.ok) return { ok: false, message: `RivaTuner Statistics Server (RTSS) could not be installed: ${(r && r.message) || 'no reason given'}` };
    // winget returning does not always mean the installer has finished writing its files and registry entry.
    for (let i = 0; i < 20 && !dir; i++) {
      await sleep(500);
      dir = await installDir();
    }
    if (!dir) return { ok: false, message: 'RTSS installed, but its files were not found. Open RTSS once, then press Set up and apply.' };
    // The installer may still be copying the hook DLL after RTSS.exe appears. Wait for it, or the first apply
    // fails with “Could not load RTSSHooks64.dll” even though the install is fine.
    for (let i = 0; i < 60 && !hasDll(dir); i++) {
      await sleep(500);
      dir = (await installDir()) || dir;
    }
    if (!hasDll(dir)) return { ok: false, message: 'RTSS installed, but its hook DLL is not there yet. Open RTSS once, then press Install RTSS again.' };
  }
  // The tab's own Install button uses this path: install only, never change the user's cap or start RTSS.
  if (installOnly) return { ok: true, installed: true, limit: 0, enabled: false, capped: [] };
  if (want && !(await startRtss(dir))) return { ok: false, message: 'RTSS is installed, but its background helper would not start.' };
  const cap = want ? profileNames(dir) : [];
  const uncap = want ? [] : previous;
  const r = await hooks(dir, want, cap, uncap);
  if (!r.ok) return r;
  if (r.limit !== want) return { ok: false, message: `RTSS kept ${r.limit || 'no limit'} instead of ${want || 'no limit'} FPS.` };
  if (want && !r.enabled) return { ok: false, message: 'RTSS has its framerate limiter switched off in its own properties.' };
  // RTSS keeps a separate hook context for 32-bit games. Enable the same limiter flag there too; a 64-bit-only
  // install has no RTSSHooks.dll and still caps every 64-bit game, so a missing bridge is not a hard failure.
  let warning = null;
  if (want && fs.existsSync(path.join(dir, 'RTSSHooks.dll'))) {
    const r32 = await hooks(dir, want, [], [], { bits: 32, flagsOnly: true });
    if (!r32.ok && !r32.skipped) warning = `64-bit games are capped, but the 32-bit RTSS bridge failed: ${r32.message}`;
    else if (r32.ok && !r32.enabled) warning = '64-bit games are capped, but RTSS did not enable its limiter for 32-bit games.';
  }
  return { ok: true, limit: want, enabled: r.enabled, capped: r.capped, warning };
}

/** True when RTSS is not holding the limit the user chose (another tool changed it, or RTSS was closed). */
async function drifted(fps) {
  const s = await status();
  if (!s.installed) return true;
  return !s.running || !s.enabled || s.limit !== clamp(fps);
}

module.exports = { _hooks: hooks, _profileNames: profileNames, apply, status, drifted, clamp, MIN, MAX, WINGET_ID };
