// Windows animations: one switch for all of them.
//
// Off: window open/close/minimize/maximize animations, the "Animation effects" switch in Windows Settings,
//      menu and tooltip animations and fades, combo-box and list-box animations, taskbar animations, and the
//      master "UI effects" switch.
// On:  all of those back on.
//
// Changed the way Windows' own settings change them (SystemParametersInfo with "save + tell every app"), so it
// works right away, without signing out. FrameForge then keeps it that way: if the Chris Titus tool, Windows
// Settings or another app changes it, FrameForge sets it back (see enforce()).
const { run, ps, IS_WIN, DEMO } = require('./util');

const CS = `
using System;
using System.Runtime.InteropServices;
public static class FFAnim {
  [StructLayout(LayoutKind.Sequential)] public struct ANIMATIONINFO { public uint cbSize; public int iMinAnimate; }
  [DllImport("user32.dll", SetLastError=true)] static extern bool SystemParametersInfo(uint a, uint u, ref ANIMATIONINFO p, uint f);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SystemParametersInfo(uint a, uint u, IntPtr p, uint f);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SystemParametersInfo(uint a, uint u, ref bool p, uint f);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, uint m, UIntPtr w, string l, uint f, uint t, out UIntPtr r);
  const uint SPIF = 0x01 | 0x02; // save to the user profile + tell every app
  // menu animation, combo box, list box smooth scroll, menu fade, selection fade, tooltip animation, tooltip fade, client-area ("Animation effects")
  static readonly uint[] SETS = { 0x1003, 0x1005, 0x1007, 0x1013, 0x1015, 0x1017, 0x1019, 0x1043 };
  static readonly uint[] GETS = { 0x1002, 0x1004, 0x1006, 0x1012, 0x1014, 0x1016, 0x1018, 0x1042 };
  public static string Get() {
    var ai = new ANIMATIONINFO(); ai.cbSize = (uint)Marshal.SizeOf(typeof(ANIMATIONINFO));
    SystemParametersInfo(0x0048, ai.cbSize, ref ai, 0);
    string s = "min=" + ai.iMinAnimate;
    for (int i = 0; i < GETS.Length; i++) { bool b = false; SystemParametersInfo(GETS[i], 0, ref b, 0); s += ";" + GETS[i].ToString("x") + "=" + (b ? 1 : 0); }
    bool ui = false; SystemParametersInfo(0x103E, 0, ref ui, 0); s += ";ui=" + (ui ? 1 : 0);
    return s;
  }
  public static void Set(bool on) {
    if (on) SystemParametersInfo(0x103F, 0, (IntPtr)1, SPIF); // UI effects master switch first
    var ai = new ANIMATIONINFO(); ai.cbSize = (uint)Marshal.SizeOf(typeof(ANIMATIONINFO)); ai.iMinAnimate = on ? 1 : 0;
    SystemParametersInfo(0x0049, ai.cbSize, ref ai, SPIF);
    foreach (uint a in SETS) SystemParametersInfo(a, 0, on ? (IntPtr)1 : IntPtr.Zero, SPIF);
    if (!on) SystemParametersInfo(0x103F, 0, IntPtr.Zero, SPIF);
    UIntPtr r;
    SendMessageTimeout((IntPtr)0xFFFF, 0x001A, UIntPtr.Zero, "TraySettings", 2, 1000, out r); // taskbar re-reads its settings
    SendMessageTimeout((IntPtr)0xFFFF, 0x001A, UIntPtr.Zero, "WindowMetrics", 2, 1000, out r);
  }
}`;
const CS_B64 = Buffer.from(CS, 'utf8').toString('base64');
const LOAD = `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${CS_B64}')));`;

const ADV = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
const VFX = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects';
const DWM_POL = 'Software\\Policies\\Microsoft\\Windows\\DWM';

let demoState = true;

/** { on: all animations on, off: all off, mixed, parts } — read live from Windows. */
async function get() {
  if (DEMO) return { on: demoState, off: !demoState, mixed: false, parts: {} };
  if (!IS_WIN) return { on: false, off: false, mixed: true, parts: {} };
  const r = await ps(`${LOAD} [FFAnim]::Get()`);
  const parts = Object.fromEntries(
    String(r.stdout)
      .trim()
      .split(';')
      .filter(Boolean)
      .map((kv) => kv.split('='))
      .map(([k, v]) => [k, Number(v)])
  );
  const tb = await run('reg', ['query', ADV, '/v', 'TaskbarAnimations']);
  parts.taskbar = /0x0\b/.test(tb.stdout) ? 0 : 1; // missing = Windows default (on)
  const pol = await run('reg', ['query', `HKCU\\${DWM_POL}`, '/v', 'DisallowAnimations']);
  parts.policyOff = /0x1\b/.test(pol.stdout) ? 1 : 0;
  const vals = Object.entries(parts).filter(([k]) => k !== 'policyOff').map(([, v]) => v);
  const allOn = vals.length > 2 && vals.every((v) => v >= 1) && !parts.policyOff;
  const allOff = vals.length > 2 && vals.every((v) => v === 0);
  return { on: allOn, off: allOff, mixed: !allOn && !allOff, parts };
}

/** Switch every animation on or off, whatever another tool or Windows Settings set before. */
async function set(on) {
  if (DEMO) {
    demoState = !!on;
    await new Promise((r) => setTimeout(r, 400));
    return { ok: true, details: demoDetails(on) };
  }
  if (!IS_WIN) return { ok: false, message: 'Windows only.' };
  const r = await ps(`${LOAD} [FFAnim]::Set($${on ? 'true' : 'false'}); 'ok'`);
  await run('reg', ['add', ADV, '/v', 'TaskbarAnimations', '/t', 'REG_DWORD', '/d', on ? '1' : '0', '/f']);
  await run('reg', ['add', VFX, '/v', 'VisualFXSetting', '/t', 'REG_DWORD', '/d', '3', '/f']); // "Custom" in Performance Options
  await run('reg', ['add', 'HKCU\\Control Panel\\Desktop\\WindowMetrics', '/v', 'MinAnimate', '/t', 'REG_SZ', '/d', on ? '1' : '0', '/f']);
  await run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\DWM', '/v', 'EnableAeroPeek', '/t', 'REG_DWORD', '/d', on ? '1' : '0', '/f']); // the Peek hover preview
  if (on) {
    // A policy (set by tweak tools or Group Policy) that forces window animations off would beat the switch.
    await run('reg', ['delete', `HKCU\\${DWM_POL}`, '/v', 'DisallowAnimations', '/f']);
    await run('reg', ['delete', `HKLM\\${DWM_POL}`, '/v', 'DisallowAnimations', '/f']);
  } else {
    await run('reg', ['add', `HKCU\\${DWM_POL}`, '/v', 'DisallowAnimations', '/t', 'REG_DWORD', '/d', '1', '/f']);
  }
  const st = await get();
  const ok = /ok/.test(r.stdout) && (on ? st.on : st.off);
  return { ok, state: st, details: demoDetails(on), message: ok ? '' : 'Windows didn’t accept every part of the change.' };
}

function demoDetails(on) {
  const v = on ? 'on' : 'off';
  return [
    `Window open/close/minimize/maximize animations → ${v}`,
    `Windows Settings › Accessibility › Visual effects › Animation effects → ${v}`,
    `Menu, tooltip, combo-box and list-box animations and fades → ${v}`,
    `Taskbar animations (TaskbarAnimations) → ${v}`,
    `UI effects master switch → ${v}`,
    on ? 'Removed the DisallowAnimations policy (if a tool had set it)' : 'DisallowAnimations policy → 1 (keeps window animations off)',
  ];
}

/** Keep the user's choice: if something changed it, put it back. Returns true when it had to fix it. */
async function enforce(want) {
  if (want !== 'on' && want !== 'off') return false;
  const st = await get();
  if ((want === 'on' && st.on) || (want === 'off' && st.off)) return false;
  const r = await set(want === 'on');
  return r.ok;
}

/**
 * A cheap fingerprint of every registry value that carries the animation settings (a handful of `reg query` calls —
 * far lighter than get()). When it changes, something else touched the animations and enforce() puts them back.
 */
async function fingerprint() {
  if (DEMO) return `demo:${demoState}`;
  if (!IS_WIN) return '';
  const reads = await Promise.all([
    run('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'UserPreferencesMask']),
    run('reg', ['query', 'HKCU\\Control Panel\\Desktop\\WindowMetrics', '/v', 'MinAnimate']),
    run('reg', ['query', ADV, '/v', 'TaskbarAnimations']),
    run('reg', ['query', VFX, '/v', 'VisualFXSetting']),
    run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\DWM', '/v', 'EnableAeroPeek']),
    run('reg', ['query', `HKCU\\${DWM_POL}`, '/v', 'DisallowAnimations']),
    run('reg', ['query', `HKLM\\${DWM_POL}`, '/v', 'DisallowAnimations']),
  ]);
  return reads.map((r) => (r.code === 0 ? r.stdout.replace(/\s+/g, ' ').trim() : '-')).join('|');
}

/** Test hook (demo only): something else switches the animations the other way. */
function demoTamper() {
  if (DEMO) demoState = !demoState;
}

module.exports = { get, set, enforce, fingerprint, demoTamper };
