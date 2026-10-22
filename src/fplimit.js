// FPS limiter. Games can only be capped from inside the game process, so FrameForge drives RivaTuner Statistics
// Server (RTSS), the frame limiter most tuners use: it sets the "Global" profile's FramerateLimit through RTSS's own
// RTSSHooks64.dll (the same interface MSI Afterburner uses), makes sure RTSS is running, and checks the value stuck.
const fs = require('fs');
const path = require('path');
const { run, ps, sleep, DEMO } = require('./util');

const MIN = 20;
const MAX = 1000;
const WINGET_ID = 'Guru3D.RTSS';
const DEFAULT_DIRS = ['C:\\Program Files (x86)\\RivaTuner Statistics Server', 'C:\\Program Files\\RivaTuner Statistics Server'];

const demo = { installed: false, running: false, limit: 0 };

function clamp(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(MAX, Math.max(MIN, v)) : 60;
}

async function installDir() {
  const r = await run('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Unwinder\\RTSS', '/v', 'InstallDir']);
  const m = /InstallDir\s+REG_SZ\s+(.+)/i.exec(r.stdout);
  const dirs = [m && m[1].trim(), ...DEFAULT_DIRS].filter(Boolean);
  return dirs.find((d) => fs.existsSync(path.join(d, 'RTSSHooks64.dll')) && fs.existsSync(path.join(d, 'RTSS.exe'))) || null;
}

async function isRunning() {
  const r = await run('tasklist', ['/FI', 'IMAGENAME eq RTSS.exe', '/NH', '/FO', 'CSV']);
  return /"RTSS\.exe"/i.test(r.stdout);
}

// Talks to RTSSHooks64.dll. mode "get" reads the limit; "set" writes it, saves the profile and tells RTSS to reload.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
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
  public static long Run(string dll, int limit) {
    IntPtr h = LoadLibraryA(dll);
    if (h == IntPtr.Zero) throw new Exception("Could not load RTSSHooks64.dll");
    var load = Fn<Prof>(h, "LoadProfile"); var save = Fn<Prof>(h, "SaveProfile");
    var get = Fn<Prop>(h, "GetProfileProperty"); var set = Fn<Prop>(h, "SetProfileProperty");
    var upd = Fn<Upd>(h, "UpdateProfiles");
    uint v = (uint)(limit < 0 ? 0 : limit);
    load("Global");
    if (limit >= 0) {
      if (set("FramerateLimit", ref v, 4) == 0) throw new Exception("RTSS refused the FPS limit");
      save("Global"); upd();
      load("Global");
    }
    uint back = 0;
    if (get("FramerateLimit", ref back, 4) == 0) throw new Exception("Could not read the FPS limit back from RTSS");
    return back;
  }
}
"@
[Console]::Out.Write('LIMIT=' + [FFRtss]::Run($env:FF_RTSS_DLL, [int]$env:FF_RTSS_LIMIT))
`;

async function hooks(dir, limit) {
  const r = await ps(SCRIPT, { env: { ...process.env, FF_RTSS_DLL: path.join(dir, 'RTSSHooks64.dll'), FF_RTSS_LIMIT: String(limit) }, timeout: 45000 });
  const m = /LIMIT=(\d+)/.exec(r.stdout);
  if (m) return { ok: true, limit: Number(m[1]) };
  return { ok: false, message: (r.stderr || r.stdout || 'RTSS did not answer').split(/\r?\n/).filter(Boolean)[0].slice(0, 200) };
}

/** What is going on right now: is RTSS there, is it running, and what limit does it have (0 = none). */
async function status() {
  if (DEMO) return { ...demo };
  const dir = await installDir();
  if (!dir) return { installed: false, running: false, limit: 0 };
  const running = await isRunning();
  const r = await hooks(dir, -1);
  return { installed: true, running, limit: r.ok ? r.limit : null, dir };
}

async function startRtss(dir) {
  if (await isRunning()) return true;
  await ps(`Start-Process -FilePath '${path.join(dir, 'RTSS.exe').replace(/'/g, "''")}' -WorkingDirectory '${dir.replace(/'/g, "''")}'`, { timeout: 20000 });
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    if (await isRunning()) return true;
  }
  return false;
}

/**
 * Cap games at `fps` (0 = remove the cap). Installs RTSS from winget the first time, starts it, sets the limit and
 * reads it back, so the answer is only ok when RTSS really holds the number.
 */
async function apply(fps, { install = null } = {}) {
  const want = fps ? clamp(fps) : 0;
  if (DEMO) {
    if (want && !demo.installed) {
      if (install) await install();
      demo.installed = true;
    }
    demo.running = demo.installed;
    demo.limit = want;
    return { ok: true, limit: want };
  }
  let dir = await installDir();
  if (!dir) {
    if (!want) return { ok: true, limit: 0 };
    if (!install) return { ok: false, message: 'RivaTuner Statistics Server (RTSS) is not installed.' };
    const r = await install();
    if (!r.ok) return { ok: false, message: `Could not install RTSS: ${r.message}` };
    dir = await installDir();
    if (!dir) return { ok: false, message: 'RTSS installed, but its files were not found.' };
  }
  const r = await hooks(dir, want);
  if (!r.ok) return r;
  if (r.limit !== want) return { ok: false, message: `RTSS kept ${r.limit || 'no limit'} instead of ${want || 'no limit'} FPS.` };
  if (want && !(await startRtss(dir))) return { ok: false, message: 'The limit is saved, but RTSS would not start.' };
  return { ok: true, limit: want };
}

/** True when RTSS is not holding the limit the user chose (another tool changed it, or RTSS was closed). */
async function drifted(fps) {
  const s = await status();
  if (!s.installed) return true;
  return !s.running || s.limit !== clamp(fps);
}

module.exports = { _hooks: hooks, apply, status, drifted, clamp, MIN, MAX, WINGET_ID };
