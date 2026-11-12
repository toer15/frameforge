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
    // The global profile's name is the empty string. ("Global" is a profile for a program called Global.exe:
    // RTSS accepts it, saves it, and it never applies to any game.)
    load("");
    if (limit >= 0) {
      if (set("FramerateLimit", ref v, 4) == 0) throw new Exception("RTSS refused the FPS limit");
      save(""); upd();
      load("");
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
  for (let i = 0; i < 16; i++) {
    await sleep(250);
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
  // RTSS only creates its Profiles folder the first time it runs, and nothing can be saved before that. So when a
  // cap is wanted: start RTSS first, then write the number.
  if (want) {
    if (!(await startRtss(dir))) return { ok: false, message: 'RTSS is installed, but it would not start.' };
    await profilesReady(dir);
  } else if (!fs.existsSync(path.join(dir, 'Profiles'))) {
    return { ok: true, limit: 0 }; // never used: there is no cap to remove
  }
  let r = await hooks(dir, want);
  // What counts is the file RTSS reads its global profile from. If the number is not in it, write it there and
  // tell RTSS to reload.
  if (!r.ok || r.limit !== want || fileLimit(dir) !== want) {
    writeFileLimit(dir, want);
    r = await hooks(dir, want);
    if (r.ok && r.limit !== want) r = await hooks(dir, -1);
  }
  if (!r.ok) return r;
  if (r.limit !== want || fileLimit(dir) !== want) return { ok: false, message: `RTSS kept ${r.limit || 'no limit'} instead of ${want || 'no limit'} FPS.` };
  return { ok: true, limit: want };
}

/** Wait for RTSS to create its Profiles folder (first start); make it ourselves if it doesn't. */
async function profilesReady(dir) {
  const p = path.join(dir, 'Profiles');
  for (let i = 0; i < 20 && !fs.existsSync(p); i++) await sleep(250);
  try {
    fs.mkdirSync(p, { recursive: true });
  } catch {}
}

/** The cap in RTSS's global profile file (Profiles\Global, an INI file): [Framerate] Limit=N. 0 = none. */
function fileLimit(dir) {
  return parseLimit(readText(path.join(dir, 'Profiles', 'Global')));
}
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
function parseLimit(text) {
  const sec = /^\[Framerate\]\s*$([\s\S]*?)(?=^\[|(?![\s\S]))/im.exec(String(text || ''));
  const m = sec && /^Limit\s*=\s*(\d+)\s*$/im.exec(sec[1]);
  return m ? Number(m[1]) : 0;
}
/** The same INI text with [Framerate] Limit set to n; everything else is left exactly as it was. */
function withLimit(text, n) {
  const t = String(text || '');
  const nl = /\r\n/.test(t) || !t ? '\r\n' : '\n';
  const sec = /^\[Framerate\]\s*$/im.exec(t);
  if (!sec) return `${t}${t && !/\n$/.test(t) ? nl : ''}[Framerate]${nl}Limit=${n}${nl}`;
  const start = sec.index + sec[0].length;
  const rest = t.slice(start);
  const next = /^\[/m.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  const after = next ? rest.slice(next.index) : '';
  const newBody = /^Limit\s*=.*$/im.test(body) ? body.replace(/^Limit\s*=.*$/im, `Limit=${n}`) : `${nl}Limit=${n}${body.startsWith('\n') || body.startsWith('\r') ? '' : nl}${body}`;
  return t.slice(0, start) + newBody + after;
}
function writeFileLimit(dir, n) {
  const file = path.join(dir, 'Profiles', 'Global');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // A first profile starts from RTSS's own template, so every other default stays as RTSS ships it.
    const base = fs.existsSync(file) ? readText(file) : readText(path.join(dir, 'ProfileTemplates', 'Global'));
    fs.writeFileSync(file, withLimit(base, n));
    return true;
  } catch {
    return false;
  }
}

/** True when RTSS is not holding the limit the user chose (another tool changed it, or RTSS was closed). */
async function drifted(fps) {
  const s = await status();
  if (!s.installed) return true;
  return !s.running || s.limit !== clamp(fps) || fileLimit(s.dir) !== clamp(fps);
}

module.exports = { _hooks: hooks, _parseLimit: parseLimit, _withLimit: withLimit, apply, status, drifted, clamp, MIN, MAX, WINGET_ID };
