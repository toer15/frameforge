// Windows animations and visual effects: one switch for all of them.
//
// Off: every ANIMATION — window open/close/minimize/maximize, the "Animation effects" switch in Windows Settings,
//      menu and tooltip animations and fades, combo-box and list-box animations, taskbar animations, Peek and the
//      master "UI effects" switch, plus live window contents while dragging.
// On:  all of those back on, and every other visual effect from Windows' own Performance Options list too —
//      "Adjust for best appearance": window contents while dragging a window, shadows under windows and under the
//      mouse pointer, smooth screen fonts, the translucent selection box, icon-label shadows, thumbnails instead of
//      icons and saved taskbar thumbnails. (Transparency effects is a switch of its own: the "Turn off transparency
//      effects" tweak.)
//
// Changed the way Windows' own settings change them (SystemParametersInfo with "save + tell every app"), so it
// animations and dragging apply right away; some Explorer effects can need sign-out. FrameForge keeps the
// choice: if the Chris Titus tool, Windows
// Settings, a preset or another app changes it, FrameForge sets it back (see enforce()).
const { run, ps, IS_WIN, DEMO } = require('./util');

const CS = `
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32;
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
  const string DESK = "Control Panel\\\\Desktop";
  const string METRICS = "Control Panel\\\\Desktop\\\\WindowMetrics";
  const string ADV = "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\Advanced";
  const string VFX = "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Explorer\\\\VisualEffects";
  const string THEME = "Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Themes\\\\Personalize";
  const string DWM = "Software\\\\Microsoft\\\\Windows\\\\DWM";
  const string POL = "Software\\\\Policies\\\\Microsoft\\\\Windows\\\\DWM";

  static int Flag(uint a) { bool b = false; return SystemParametersInfo(a, 0, ref b, 0) ? (b ? 1 : 0) : -1; }
  static int Num(RegistryKey root, string sub, string name, int def) {
    try {
      using (RegistryKey k = root.OpenSubKey(sub)) {
        if (k == null) return def;
        object v = k.GetValue(name, null);
        if (v == null) return def;
        int n; return int.TryParse(Convert.ToString(v), out n) ? n : -1;
      }
    } catch { return -1; }
  }
  static void PutNum(string sub, string name, int val) {
    if (Num(Registry.CurrentUser, sub, name, -1) == val) return;
    using (RegistryKey k = Registry.CurrentUser.CreateSubKey(sub)) { k.SetValue(name, val, RegistryValueKind.DWord); }
  }
  static void PutStr(string sub, string name, string val) {
    using (RegistryKey k = Registry.CurrentUser.CreateSubKey(sub)) { k.SetValue(name, val, RegistryValueKind.String); }
  }
  static void Del(RegistryKey root, string sub, string name) {
    using (RegistryKey k = root.OpenSubKey(sub)) { if (k == null || k.GetValue(name, null) == null) return; }
    using (RegistryKey k = root.OpenSubKey(sub, true)) { if (k != null) k.DeleteValue(name, false); }
  }
  static void Broadcast() {
    UIntPtr r;
    SendMessageTimeout((IntPtr)0xFFFF, 0x001A, UIntPtr.Zero, "TraySettings", 2, 1000, out r); // taskbar re-reads its settings
    SendMessageTimeout((IntPtr)0xFFFF, 0x001A, UIntPtr.Zero, "WindowMetrics", 2, 1000, out r);
    SendMessageTimeout((IntPtr)0xFFFF, 0x001A, UIntPtr.Zero, "VisualEffects", 2, 1000, out r);
    SendMessageTimeout((IntPtr)0xFFFF, 0x001A, UIntPtr.Zero, "Policy", 2, 1000, out r);
  }

  // key=value;… for every setting, read live from Windows (1 = on)
  public static string Get() {
    var ai = new ANIMATIONINFO(); ai.cbSize = (uint)Marshal.SizeOf(typeof(ANIMATIONINFO));
    bool minKnown = SystemParametersInfo(0x0048, ai.cbSize, ref ai, 0);
    string s = "min=" + (minKnown ? (ai.iMinAnimate != 0 ? 1 : 0) : -1);
    for (int i = 0; i < GETS.Length; i++) s += ";" + GETS[i].ToString("x") + "=" + Flag(GETS[i]);
    s += ";ui=" + Flag(0x103E);
    s += ";drag=" + Flag(0x26);        // show window contents while dragging
    s += ";shadow=" + Flag(0x1024);    // drop shadows for supported windows
    s += ";cursor=" + Flag(0x101A);    // shadows under the mouse pointer
    s += ";font=" + Flag(0x4A);        // smooth edges of screen fonts
    // Missing value = what Windows does without it.
    s += ";taskbar=" + Num(Registry.CurrentUser, ADV, "TaskbarAnimations", 1);
    s += ";peek=" + Num(Registry.CurrentUser, DWM, "EnableAeroPeek", 1);
    s += ";hib=" + Num(Registry.CurrentUser, DWM, "AlwaysHibernateThumbnails", 0);
    s += ";alpha=" + Num(Registry.CurrentUser, ADV, "ListviewAlphaSelect", 1);
    s += ";lshadow=" + Num(Registry.CurrentUser, ADV, "ListviewShadow", 1);
    int icons = Num(Registry.CurrentUser, ADV, "IconsOnly", 0);
    s += ";icons=" + (icons < 0 ? -1 : (icons == 0 ? 1 : 0)); // 1 = thumbnails instead of icons
    s += ";transp=" + Num(Registry.CurrentUser, THEME, "EnableTransparency", 1);      // its own switch: not part of on/off
    int userPolicy = Num(Registry.CurrentUser, POL, "DisallowAnimations", 0);
    int machinePolicy = Num(Registry.LocalMachine, POL, "DisallowAnimations", 0);
    s += ";policy=" + (userPolicy < 0 || machinePolicy < 0 ? -1 : (userPolicy == 1 || machinePolicy == 1 ? 1 : 0));
    return s;
  }

  // Every visual effect that isn't an animation, back to "Adjust for best appearance".
  public static void SetEffects(bool on) {
    if (!on) return;
    SystemParametersInfo(0x1025, 0, (IntPtr)1, SPIF);            // shadows under windows
    SystemParametersInfo(0x101B, 0, (IntPtr)1, SPIF);            // shadows under the mouse pointer
    SystemParametersInfo(0x004B, 1, IntPtr.Zero, SPIF);          // smooth edges of screen fonts…
    SystemParametersInfo(0x200B, 0, (IntPtr)2, SPIF);            // …with ClearType
    PutStr(DESK, "FontSmoothing", "2");
    PutNum(ADV, "ListviewAlphaSelect", 1);                       // translucent selection rectangle
    PutNum(ADV, "ListviewShadow", 1);                            // drop shadows for icon labels on the desktop
    PutNum(ADV, "IconsOnly", 0);                                 // thumbnails instead of icons
    PutNum(DWM, "AlwaysHibernateThumbnails", 1);                 // saved taskbar thumbnail previews
  }

  public static void Set(bool on) {
    if (on) SystemParametersInfo(0x103F, 0, (IntPtr)1, SPIF); // UI effects master switch first
    var ai = new ANIMATIONINFO(); ai.cbSize = (uint)Marshal.SizeOf(typeof(ANIMATIONINFO)); ai.iMinAnimate = on ? 1 : 0;
    SystemParametersInfo(0x0049, ai.cbSize, ref ai, SPIF);
    foreach (uint a in SETS) SystemParametersInfo(a, 0, on ? (IntPtr)1 : IntPtr.Zero, SPIF);
    SystemParametersInfo(0x0025, on ? 1u : 0u, IntPtr.Zero, SPIF); // live window contents while dragging
    PutStr(DESK, "DragFullWindows", on ? "1" : "0");
    if (!on) SystemParametersInfo(0x103F, 0, IntPtr.Zero, SPIF);
    PutStr(METRICS, "MinAnimate", on ? "1" : "0");
    PutNum(ADV, "TaskbarAnimations", on ? 1 : 0);
    PutNum(DWM, "EnableAeroPeek", on ? 1 : 0);
    PutNum(VFX, "VisualFXSetting", 3);                           // "Custom" in Performance Options
    if (on) {
      SetEffects(true);
      // A policy (set by tweak tools or Group Policy) that forces window animations off would beat the switch.
      Del(Registry.CurrentUser, POL, "DisallowAnimations");
      Del(Registry.LocalMachine, POL, "DisallowAnimations");
    } else {
      PutNum(POL, "DisallowAnimations", 1);
    }
    Broadcast();
  }
}`;
const CS_B64 = Buffer.from(CS, 'utf8').toString('base64');
const LOAD = `Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${CS_B64}')));`;

// Settings that are animations (Off turns them off, On turns them on) and the other visual effects (only On sets them).
const ANIM_KEYS = ['min', '1002', '1004', '1006', '1012', '1014', '1016', '1018', '1042', 'ui', 'taskbar', 'peek', 'drag'];
const EFFECT_KEYS = ['shadow', 'cursor', 'font', 'alpha', 'lshadow', 'icons', 'hib'];

/** Every effect in Windows' Performance Options list, with whether it is on right now. */
function describe(p) {
  const on = (...keys) => keys.every((k) => p[k] >= 1);
  const row = (name, ok, group = 'animation') => ({ name, on: !!ok, group });
  return [
    row('Animate windows when minimizing and maximizing', on('min')),
    row('Animate controls and elements inside windows', on('1042')),
    row('Animations in the taskbar', on('taskbar')),
    row('Fade or slide menus into view', on('1002', '1012')),
    row('Fade or slide ToolTips into view', on('1016', '1018')),
    row('Fade out menu items after clicking', on('1014')),
    row('Slide open combo boxes', on('1004')),
    row('Smooth-scroll list boxes', on('1006')),
    row('Enable Peek', on('peek')),
    row('Windows policy allows animations', p.policy === 0, 'policy'),
    row('Show window contents while dragging', on('drag')),
    row('Show shadows under windows', on('shadow'), 'effect'),
    row('Show shadows under mouse pointer', on('cursor'), 'effect'),
    row('Show translucent selection rectangle', on('alpha'), 'effect'),
    row('Use drop shadows for icon labels on the desktop', on('lshadow'), 'effect'),
    row('Show thumbnails instead of icons', on('icons'), 'effect'),
    row('Save taskbar thumbnail previews', on('hib'), 'effect'),
    row('Smooth edges of screen fonts', on('font'), 'effect'),
    row('Transparency effects (controlled separately in Tweaks)', on('transp'), 'separate'),
  ];
}

let demoState = true;
const demoParts = (on) => Object.fromEntries([...ANIM_KEYS.map((k) => [k, on ? 1 : 0]), ...EFFECT_KEYS.map((k) => [k, 1]), ['transp', 1], ['policy', on ? 0 : 1]]);

/** { on: everything on, off: every animation off, mixed, parts, details } — read live from Windows. */
async function get() {
  if (DEMO) {
    const parts = demoParts(demoState);
    return { on: demoState, off: !demoState, mixed: false, parts, details: describe(parts) };
  }
  if (!IS_WIN) return { on: false, off: false, mixed: true, parts: {}, details: [] };
  const r = await ps(`${LOAD} [FFAnim]::Get()`);
  const parts = Object.fromEntries(
    String(r.stdout)
      .trim()
      .split(';')
      .filter(Boolean)
      .map((kv) => kv.split('='))
      .map(([k, v]) => [k, Number(v)])
  );
  const known = r.code === 0 && ANIM_KEYS.every((k) => parts[k] === 0 || parts[k] === 1);
  const allOn = known && ANIM_KEYS.every((k) => parts[k] === 1) && EFFECT_KEYS.every((k) => parts[k] === 1) && parts.policy === 0;
  const allOff = known && ANIM_KEYS.every((k) => parts[k] === 0);
  return { on: allOn, off: allOff, mixed: !allOn && !allOff, parts, details: describe(parts) };
}

/** Switch every animation on or off (On: every visual effect too), whatever another tool or Windows Settings set before. */
async function set(on) {
  if (DEMO) {
    demoState = !!on;
    await new Promise((r) => setTimeout(r, 80));
    return { ok: true, details: demoDetails(on), state: await get() };
  }
  if (!IS_WIN) return { ok: false, message: 'Windows only.' };
  const r = await ps(`$ErrorActionPreference='Stop'; ${LOAD} [FFAnim]::Set($${on ? 'true' : 'false'}); 'ok'`);
  const st = await get();
  const ok = r.code === 0 && r.stdout.trim() === 'ok' && (on ? st.on : st.off);
  const missing = st.details.filter((d) => d.group !== 'separate' && (on ? !d.on : d.group === 'animation' && d.on)).map((d) => d.name);
  return { ok, state: st, details: demoDetails(on), message: ok ? '' : `Windows didn’t accept every part of the change${missing.length ? ` (still ${on ? 'off' : 'on'}: ${missing.join(', ')})` : ''}.` };
}

function demoDetails(on) {
  const v = on ? 'on' : 'off';
  return [
    `Window open/close/minimize/maximize animations → ${v}`,
    `Windows Settings › Accessibility › Visual effects › Animation effects → ${v}`,
    `Menu, tooltip, combo-box and list-box animations and fades → ${v}`,
    `Taskbar animations (TaskbarAnimations), Peek and live window contents while dragging → ${v}`,
    `UI effects master switch → ${v}`,
    ...(on
      ? [
          'Shadows under supported windows and under the mouse pointer → on',
          'Smooth screen fonts (ClearType), translucent selection rectangle, icon-label shadows, thumbnails instead of icons, saved taskbar thumbnails → on',
          'Removed the DisallowAnimations policy (if a tool had set it)',
        ]
      : ['DisallowAnimations policy → 1 (keeps window animations off)']),
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
 * A cheap fingerprint of every registry value that carries the animation and effect settings (a handful of
 * `reg query` calls — far lighter than get()). When it changes, something else touched them and enforce() puts them
 * back. Settings that only live in memory are caught by the full check every minute.
 */
async function fingerprint() {
  if (DEMO) return `demo:${demoState}`;
  if (!IS_WIN) return '';
  const ADV = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Advanced';
  const DESK = 'HKCU\\Control Panel\\Desktop';
  const DWM = 'HKCU\\Software\\Microsoft\\Windows\\DWM';
  const POL = 'Software\\Policies\\Microsoft\\Windows\\DWM';
  const reads = await Promise.all(
    [
      [DESK, 'UserPreferencesMask'],
      [DESK, 'DragFullWindows'],
      [DESK, 'FontSmoothing'],
      [`${DESK}\\WindowMetrics`, 'MinAnimate'],
      [ADV, 'TaskbarAnimations'],
      [ADV, 'ListviewAlphaSelect'],
      [ADV, 'ListviewShadow'],
      [ADV, 'IconsOnly'],
      [DWM, 'EnableAeroPeek'],
      [DWM, 'AlwaysHibernateThumbnails'],
      [`HKCU\\${POL}`, 'DisallowAnimations'],
      [`HKLM\\${POL}`, 'DisallowAnimations'],
    ].map(([key, name]) => run('reg', ['query', key, '/v', name]))
  );
  return reads.map((r) => (r.code === 0 ? r.stdout.replace(/\s+/g, ' ').trim() : '-')).join('|');
}

/** Test hook (demo only): something else switches the animations the other way. */
function demoTamper() {
  if (DEMO) demoState = !demoState;
}

module.exports = { get, set, enforce, fingerprint, demoTamper, CS, ANIM_KEYS, EFFECT_KEYS };
