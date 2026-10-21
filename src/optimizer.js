// Every change FrameForge makes lives here. Each tweak records what was there
// before it, so turning Auto Mode off puts the PC back exactly how it was.
const reg = require('./registry');
const { run, ps, sleep, DEMO } = require('./util');
const { backup, settings } = require('./store');

const HKCU = 'HKCU';
const HKLM = 'HKLM';
const ULTIMATE = 'e9a42b02-d5df-448d-aa00-03f14749eb61';
const HIGH_PERF = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';
const BEST_PERF_OVERLAY = 'ded574b5-45a0-4f42-8737-46345c09c238';
const BALANCED = '381b4222-f694-41f0-9685-ff5bb260df2e';

const shown = (e) => (e && e.exists ? (/^0x[0-9a-f]+$/i.test(e.data) ? String(parseInt(e.data, 16)) : e.data === '' ? '(empty)' : e.data) : 'not set');

/** "HKLM\...\GraphicsDrivers › HwSchMode: not set → 2" for every value, from the saved originals. */
function regDetails(values, entries = []) {
  return values.map((v) => {
    const prev = entries.find((e) => e.key === v.key && e.name === v.name);
    return `${v.key} › ${v.name}: ${shown(prev)} → ${v.data}`;
  });
}

const toNum = (d) => (typeof d === 'number' ? d >>> 0 : /^0x/i.test(String(d)) ? parseInt(d, 16) >>> 0 : parseInt(d, 10) >>> 0);
/** Does the registry value read back equal what the tweak writes? DWORDs compare as numbers. */
function sameValue(v, cur) {
  if (!cur || !cur.exists) return false;
  if (v.type === 'REG_DWORD') return toNum(cur.data) === toNum(v.data);
  return String(cur.data) === String(v.data);
}
const showData = (v) => (v.type === 'REG_DWORD' && toNum(v.data) === 0xffffffff ? '0xffffffff' : String(v.data));

/**
 * Registry-based tweak: backs up each value the first time, then writes the new ones.
 * Each value may carry `def`: the Windows default, used when switching it off without a backup
 * (otherwise the value is deleted, which is Windows' default for it).
 */
function registryTweak(values) {
  return {
    values,
    what: values.map((v) => `${v.key} › ${v.name} = ${showData(v)}`),
    async isOn() {
      for (const v of values) if (!sameValue(v, await reg.get(v.key, v.name))) return false;
      return true;
    },
    async forceOff() {
      for (const v of values) {
        if ('def' in v) await reg.set(v.key, v.name, v.type, v.def);
        else await reg.del(v.key, v.name);
      }
      if (this.after) await this.after(false);
      return { ok: true };
    },
    async apply() {
      if (!backup.get(this.id)) {
        const entries = [];
        for (const v of values) {
          const prev = await reg.get(v.key, v.name);
          entries.push({ key: v.key, name: v.name, ...prev });
        }
        backup.put(this.id, { entries });
      }
      for (const v of values) await reg.set(v.key, v.name, v.type, v.data);
      if (this.after) await this.after(true);
      return { ok: true, details: regDetails(values, backup.get(this.id).entries) };
    },
    async revert() {
      const b = backup.get(this.id);
      if (!b) return { ok: true, skipped: true };
      for (const e of b.entries) {
        if (e.exists) await reg.set(e.key, e.name, e.type, e.data);
        else await reg.del(e.key, e.name);
      }
      if (this.after) await this.after(false);
      backup.remove(this.id);
      return { ok: true };
    },
  };
}

function activeScheme(out) {
  const m = out.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1].toLowerCase() : null;
}

const TWEAKS = [
  {
    id: 'restore_point',
    name: 'Create a restore point first',
    desc: 'Saves a Windows restore point before anything changes, so you can roll the whole PC back if you ever need to.',
    admin: true,
    oneShot: true,
    demoDetails: ['Windows restore point “FrameForge - before optimizing” (Control Panel › Recovery › Open System Restore)'],
    async apply() {
      const r = await ps(
        "Checkpoint-Computer -Description 'FrameForge - before optimizing' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop",
        { timeout: 180000 }
      );
      if (r.code !== 0) {
        return {
          ok: false,
          warn: true,
          message: 'Skipped — System Protection is off for drive C:, or Windows already made one in the last 24 hours.',
        };
      }
      return { ok: true, message: 'Restore point saved.', details: ['Windows restore point “FrameForge - before optimizing” (Control Panel › Recovery › Open System Restore)'] };
    },
  },
  {
    id: 'power_plan',
    name: 'Ultimate Performance power plan',
    desc: 'Stops the CPU from clocking down and parking cores mid-game. Uses more power — turn off on a laptop running on battery.',
    admin: true,
    demoDetails: ['Active power plan: Balanced → Ultimate Performance (e9a42b02-d5df-448d-aa00-03f14749eb61)'],
    async apply() {
      const s = settings.get();
      const curOut = (await run('powercfg', ['/getactivescheme'])).stdout;
      const cur = activeScheme(curOut);
      const curName = (curOut.match(/\(([^)]+)\)\s*$/m) || [])[1] || cur;
      if (!backup.get(this.id)) backup.put(this.id, { prevScheme: cur, prevName: curName });
      const was = backup.get(this.id).prevName || 'previous plan';

      let guid = s.ultimatePlanGuid;
      if (guid && (await run('powercfg', ['/query', guid])).code !== 0) guid = null;
      if (!guid) {
        const dup = await run('powercfg', ['-duplicatescheme', ULTIMATE]);
        guid = dup.code === 0 ? activeScheme(dup.stdout) : null;
        if (guid) settings.set({ ultimatePlanGuid: guid });
      }
      if (guid && (await run('powercfg', ['/setactive', guid])).code === 0) {
        return { ok: true, message: 'Ultimate Performance is now active.', details: [`Active power plan: ${was} → Ultimate Performance (${guid})`] };
      }
      if ((await run('powercfg', ['/setactive', HIGH_PERF])).code === 0) {
        return { ok: true, message: 'High Performance is now active (Ultimate isn’t offered on this PC).', details: [`Active power plan: ${was} → High performance (${HIGH_PERF})`] };
      }
      // Modern Standby PCs hide classic plans; the "Best performance" power mode still works.
      if ((await run('powercfg', ['/overlaysetactive', BEST_PERF_OVERLAY])).code === 0) {
        const b = backup.get(this.id) || {};
        backup.put(this.id, { ...b, usedOverlay: true });
        return { ok: true, message: 'Power mode set to Best performance.', details: [`Windows power mode: ${was} → Best performance`] };
      }
      return {
        ok: false,
        warn: true,
        message: 'Windows hides power plans on this PC. Set Settings › System › Power › Power mode to Best performance.',
      };
    },
    what: ['Active power plan → Ultimate Performance (or High performance / “Best performance” power mode where Windows hides plans)'],
    async isOn() {
      const cur = activeScheme((await run('powercfg', ['/getactivescheme'])).stdout);
      const g = settings.get().ultimatePlanGuid;
      return !!cur && (cur === ULTIMATE || cur === HIGH_PERF || (g && cur === g.toLowerCase()));
    },
    async forceOff() {
      await run('powercfg', ['/setactive', BALANCED]);
      return { ok: true };
    },
    async revert() {
      const b = backup.get(this.id);
      if (!b) return { ok: true, skipped: true };
      if (b.prevScheme) await run('powercfg', ['/setactive', b.prevScheme]);
      if (b.usedOverlay) await run('powercfg', ['/overlaysetactive', '00000000-0000-0000-0000-000000000000']);
      const g = settings.get().ultimatePlanGuid;
      if (g && g !== b.prevScheme) {
        await run('powercfg', ['/delete', g]);
        settings.set({ ultimatePlanGuid: null });
      }
      backup.remove(this.id);
      return { ok: true };
    },
  },
  {
    id: 'game_mode',
    name: 'Windows Game Mode',
    desc: 'Tells Windows to give your game priority and hold back driver installs and update restarts while you play.',
    ...registryTweak([
      { key: `${HKCU}\\Software\\Microsoft\\GameBar`, name: 'AllowAutoGameMode', type: 'REG_DWORD', data: 1 },
      { key: `${HKCU}\\Software\\Microsoft\\GameBar`, name: 'AutoGameModeEnabled', type: 'REG_DWORD', data: 1 },
    ]),
  },
  {
    id: 'game_dvr',
    name: 'Turn off Xbox background recording',
    desc: 'Stops Game Bar from secretly recording the last minutes of gameplay. Doesn’t affect OBS or streaming.',
    ...registryTweak([
      { key: `${HKCU}\\System\\GameConfigStore`, name: 'GameDVR_Enabled', type: 'REG_DWORD', data: 0, def: 1 },
      {
        key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\GameDVR`,
        name: 'AppCaptureEnabled',
        type: 'REG_DWORD',
        data: 0,
      },
    ]),
  },
  {
    id: 'hags',
    name: 'Hardware-accelerated GPU scheduling',
    desc: 'Lets the graphics card manage its own memory queue. Needed for DLSS Frame Generation and AMD Fluid Motion Frames. Works on GTX 10-series / RX 5000 and newer.',
    admin: true,
    reboot: true,
    ...registryTweak([
      {
        key: `${HKLM}\\SYSTEM\\CurrentControlSet\\Control\\GraphicsDrivers`,
        name: 'HwSchMode',
        type: 'REG_DWORD',
        data: 2,
      },
    ]),
  },
  {
    id: 'game_priority',
    name: 'Give games top CPU and GPU priority',
    desc: 'Raises the priority Windows gives to the “Games” task class in its multimedia scheduler.',
    admin: true,
    ...registryTweak(
      (() => {
        const k = `${HKLM}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile\\Tasks\\Games`;
        return [
          { key: k, name: 'GPU Priority', type: 'REG_DWORD', data: 8, def: 8 },
          { key: k, name: 'Priority', type: 'REG_DWORD', data: 6, def: 2 },
          { key: k, name: 'Scheduling Category', type: 'REG_SZ', data: 'High', def: 'Medium' },
          { key: k, name: 'SFIO Priority', type: 'REG_SZ', data: 'High', def: 'Normal' },
        ];
      })()
    ),
  },
  {
    id: 'mouse_precision',
    name: 'Raw mouse aim (no acceleration)',
    desc: 'Turns off “Enhance pointer precision” so the same hand movement always turns the same distance in-game.',
    ...registryTweak([
      { key: `${HKCU}\\Control Panel\\Mouse`, name: 'MouseSpeed', type: 'REG_SZ', data: '0', def: '1' },
      { key: `${HKCU}\\Control Panel\\Mouse`, name: 'MouseThreshold1', type: 'REG_SZ', data: '0', def: '6' },
      { key: `${HKCU}\\Control Panel\\Mouse`, name: 'MouseThreshold2', type: 'REG_SZ', data: '0', def: '10' },
    ]),
    async after() {
      // Apply immediately instead of waiting for a sign-out.
      const { stdout } = await run('reg', ['query', `${HKCU}\\Control Panel\\Mouse`]);
      const val = (n, d) => {
        const m = stdout.match(new RegExp(`${n}\\s+REG_SZ\\s+(\\d+)`, 'i'));
        return m ? Number(m[1]) : d;
      };
      const a = [val('MouseThreshold1', 6), val('MouseThreshold2', 10), val('MouseSpeed', 1)];
      await ps(
        `Add-Type -Namespace FF -Name M -MemberDefinition '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a,int b,int[] c,int d);'; [FF.M]::SystemParametersInfo(4,0,[int[]](${a.join(',')}),3) | Out-Null`
      );
    },
  },
  {
    id: 'power_throttling',
    name: 'Turn off power throttling',
    desc: 'Stops Windows from slowing down apps it thinks are in the background. Best for desktops — leave off on laptops.',
    admin: true,
    reboot: true,
    ...registryTweak([
      {
        key: `${HKLM}\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerThrottling`,
        name: 'PowerThrottlingOff',
        type: 'REG_DWORD',
        data: 1,
      },
    ]),
  },
  {
    id: 'visual_effects',
    name: 'Performance visual effects',
    desc: 'Switches off Windows animations and shadows. Small gain on older PCs; makes Windows look plainer. Takes effect after you sign out.',
    ...registryTweak([
      {
        key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VisualEffects`,
        name: 'VisualFXSetting',
        type: 'REG_DWORD',
        data: 2,
      },
    ]),
  },
  {
    id: 'temp_cleanup',
    name: 'Clear temporary files',
    desc: 'Empties the Windows and user temp folders. Files that are in use are skipped.',
    oneShot: true,
    demoDetails: ['Deleted 1.4 GB of temporary files from %TEMP% and C:\\Windows\\Temp (files in use were skipped)'],
    async apply() {
      const r = await ps(
        `$paths=@($env:TEMP,"$env:WINDIR\\Temp"); $before=0; foreach($p in $paths){ $before += (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum };
         foreach($p in $paths){ Get-ChildItem $p -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue };
         $after=0; foreach($p in $paths){ $after += (Get-ChildItem $p -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum };
         [math]::Max(0,[math]::Round(($before-$after)/1MB))`,
        { timeout: 300000 }
      );
      const mb = parseInt(r.stdout.trim(), 10) || 0;
      const size = mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb + ' MB';
      if (mb === 0) return { ok: true, message: 'Temp folders were already clean — nothing to free (files that are in use are skipped).', details: ['%TEMP% and C:\\Windows\\Temp checked — already empty or in use'] };
      return { ok: true, message: `Freed ${size}.`, details: [`Deleted ${size} of temporary files from %TEMP% and C:\\Windows\\Temp (files in use were skipped)`] };
    },
  },
];

// What's in each winutil preset (read from winutil 26.10.07's own preset list).
const CTT_PRESETS = {
  Minimal: ['WPFTweaksConsumerFeatures', 'WPFTweaksWPBT', 'WPFTweaksServices', 'WPFTweaksTelemetry'],
  Standard: ['WPFTweaksActivity', 'WPFTweaksConsumerFeatures', 'WPFTweaksDisableExplorerAutoDiscovery', 'WPFTweaksWPBT', 'WPFTweaksLocation', 'WPFTweaksServices', 'WPFTweaksTelemetry', 'WPFTweaksDeliveryOptimization', 'WPFTweaksDiskCleanup', 'WPFTweaksDeleteTempFiles', 'WPFTweaksEndTaskOnTaskbar', 'WPFTweaksRestorePoint'],
  Advanced: ['WPFTweaksRestorePoint', 'WPFTweaksActivity', 'WPFTweaksConsumerFeatures', 'WPFTweaksDisableExplorerAutoDiscovery', 'WPFTweaksWPBT', 'WPFTweaksLocation', 'WPFTweaksServices', 'WPFTweaksTelemetry', 'WPFTweaksDeliveryOptimization', 'WPFTweaksDeleteTempFiles', 'WPFTweaksEndTaskOnTaskbar', 'WPFTweaksDisableStoreSearch', 'WPFTweaksRevertStartMenu', 'WPFTweaksWidget', 'WPFTweaksRemoveOneDrive', 'WPFTweaksWindowsAI', 'WPFTweaksRightClickMenu'],
};
const CTT_NAMES = {
  WPFTweaksActivity: 'Activity history turned off',
  WPFTweaksConsumerFeatures: 'Suggested apps and ads in Start turned off',
  WPFTweaksDisableExplorerAutoDiscovery: 'File Explorer folder-type auto-discovery turned off',
  WPFTweaksWPBT: 'Firmware-installed software (WPBT) blocked',
  WPFTweaksLocation: 'Location tracking turned off',
  WPFTweaksServices: 'Unneeded background services set to Manual',
  WPFTweaksTelemetry: 'Windows telemetry turned off',
  WPFTweaksDeliveryOptimization: 'Delivery Optimization (sharing updates over your internet) turned off',
  WPFTweaksDiskCleanup: 'Disk Cleanup ran',
  WPFTweaksDeleteTempFiles: 'Temporary files deleted',
  WPFTweaksEndTaskOnTaskbar: '“End task” added to the taskbar right-click menu',
  WPFTweaksRestorePoint: 'Restore point created',
  WPFTweaksDisableStoreSearch: 'Microsoft Store results in Start search turned off',
  WPFTweaksRevertStartMenu: 'Classic Start menu layout restored',
  WPFTweaksWidget: 'Widgets removed',
  WPFTweaksRemoveOneDrive: 'OneDrive removed',
  WPFTweaksWindowsAI: 'Windows AI features (Copilot, Recall) turned off',
  WPFTweaksRightClickMenu: 'Old full right-click menu restored',
};

// Chris Titus Tech's Windows Utility — runs one of his presets headless (no window, no clicking).
TWEAKS.push({
  id: 'ctt_tweaks',
  name: 'Chris Titus Tech tweaks (winutil)',
  desc: 'Downloads Chris Titus’s Windows Utility from his official GitHub and applies his preset by itself: telemetry off, background services set to manual, Delivery Optimization off, cleanup and more. Turning Auto Mode off does not undo these — use the restore point or winutil’s own Undo.',
  admin: true,
  oneShot: true,
  demoMessage: 'Applied Chris Titus’s Standard preset (12 tweaks).',
  get demoDetails() {
    const p = settings.get().cttPreset || 'Standard';
    return (CTT_PRESETS[p] || []).map((i) => `winutil ${p}: ${CTT_NAMES[i] || i}`);
  },
  async apply(ctx = {}) {
    const tools = require('./tools');
    const preset = settings.get().cttPreset || 'Standard';
    // FrameForge already made a restore point, and Windows allows only one per 24 hours, so winutil's
    // own restore-point step would fail — leave it out.
    const ids = (CTT_PRESETS[preset] || []).filter((i) => i !== 'WPFTweaksRestorePoint');
    const r = await tools.runWinutil(ids, (line) => ctx.progress && ctx.progress(line), CTT_NAMES);
    const names = ids.map((i) => `winutil ${preset}: ${CTT_NAMES[i] || i}`);
    const timedOut = r.steps.some((st) => /TIMED OUT/i.test(st.state));
    const skipped = r.harmless.map((e) => `Skipped (not on this PC — normal): ${e.replace(/^\[[^\]]+\]\s*/, '').replace(/^Non-terminating error\s*:\s*/i, '')}`);
    const log = r.logPath ? [`Full winutil log: ${r.logPath}`] : [];
    // Exit code 1 only because of "not found" items still means the preset was applied.
    const worked = r.ok || (r.code === 1 && r.errors.length === 0 && !timedOut && !r.fatal);
    if (worked) {
      const n = r.harmless.length;
      return {
        ok: true,
        message: `Applied Chris Titus’s ${preset} preset (${ids.length} tweaks).${n ? ` ${n} item${n === 1 ? ' was' : 's were'} skipped because ${n === 1 ? 'it isn’t' : 'they aren’t'} on your version of Windows — that’s normal.` : ''}`,
        details: [...names, ...skipped, ...r.warnings.map((w) => `Warning: ${w}`), ...log],
      };
    }
    if (r.code === 2) return { ok: false, warn: true, message: 'winutil said nothing was selected — this version may have renamed its tweaks. Try again after the next FrameForge update.', details: [...skipped, ...log], fix: 'ctt' };
    const first = r.fatal || (timedOut ? 'a step took too long and was stopped' : r.errors[0]);
    return {
      ok: false,
      warn: true,
      message: `Most of the ${preset} preset ran, but winutil reported a real problem${first ? `: ${String(first).replace(/^\[[^\]]+\]\s*/, '').replace(/^Non-terminating error\s*:\s*/i, '').replace(/\.+$/, '').slice(0, 160)}` : ''}. Try again, or open the Chris Titus tool from Fix mode.`,
      details: [...r.errors.map((e) => `Error: ${e}`), ...r.steps.filter((st) => st.state !== 'ok').map((st) => `${st.name}: ${st.state}`), ...skipped, ...log],
      fix: 'ctt',
    };
  },
});

// Competitive: nothing pops up over your game.
TWEAKS.push({
  id: 'no_popups',
  name: 'No pop-ups during matches',
  desc: 'Turns off Windows notification banners, and the Sticky Keys / Filter Keys prompts that steal focus when you tap Shift five times or hold it down.',
  ...registryTweak([
    { key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\PushNotifications`, name: 'ToastEnabled', type: 'REG_DWORD', data: 0, def: 1 },
    { key: `${HKCU}\\Control Panel\\Accessibility\\StickyKeys`, name: 'Flags', type: 'REG_SZ', data: '506', def: '510' },
    { key: `${HKCU}\\Control Panel\\Accessibility\\ToggleKeys`, name: 'Flags', type: 'REG_SZ', data: '58', def: '62' },
    { key: `${HKCU}\\Control Panel\\Accessibility\\Keyboard Response`, name: 'Flags', type: 'REG_SZ', data: '122', def: '126' },
  ]),
});

// Windows DirectX settings (Settings › Display › Graphics › Advanced): windowed-game optimizations,
// variable refresh rate, and — for Best graphics — Auto HDR.
TWEAKS.push({
  id: 'dx_opt',
  name: 'Windowed game optimizations and Auto HDR',
  desc: 'Turns on Windows’ optimizations for games in borderless/windowed mode (lower latency, VRR). Best graphics also turns on Auto HDR, which adds HDR to older games on HDR screens.',
  flags() {
    const p = settings.get().preset;
    const f = { SwapEffectUpgradeEnable: 1, VRROptimizeEnable: 1 };
    if (p === 'graphics') f.AutoHDREnable = 1;
    return f;
  },
  get demoDetails() {
    return [`HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences › DirectXUserGlobalSettings: not set → ${Object.entries(this.flags()).map(([k, v]) => `${k}=${v};`).join('')}`];
  },
  what: ['HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences › DirectXUserGlobalSettings += SwapEffectUpgradeEnable=1; VRROptimizeEnable=1; (AutoHDREnable=1 in Best graphics)'],
  async isOn() {
    const cur = await reg.get('HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences', 'DirectXUserGlobalSettings');
    return !!cur.exists && /SwapEffectUpgradeEnable=1/.test(cur.data) && /VRROptimizeEnable=1/.test(cur.data);
  },
  async forceOff() {
    const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
    const cur = await reg.get(key, 'DirectXUserGlobalSettings');
    if (!cur.exists) return { ok: true };
    const rest = String(cur.data).split(';').filter((kv) => kv && !/^(SwapEffectUpgradeEnable|VRROptimizeEnable|AutoHDREnable)=/.test(kv));
    if (rest.length) await reg.set(key, 'DirectXUserGlobalSettings', 'REG_SZ', rest.map((kv) => kv + ';').join(''));
    else await reg.del(key, 'DirectXUserGlobalSettings');
    return { ok: true };
  },
  async apply() {
    const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
    const name = 'DirectXUserGlobalSettings';
    const prev = await reg.get(key, name);
    if (!backup.get(this.id)) backup.put(this.id, { entries: [{ key, name, ...prev }] });
    // Keep any other flags already there, and set ours.
    const map = {};
    String(prev.exists ? prev.data : '').split(';').filter(Boolean).forEach((kv) => {
      const [k, v] = kv.split('=');
      map[k] = v;
    });
    if (settings.get().preset !== 'graphics') delete map.AutoHDREnable;
    Object.assign(map, this.flags());
    const data = Object.entries(map).map(([k, v]) => `${k}=${v};`).join('');
    await reg.set(key, name, 'REG_SZ', data);
    return { ok: true, message: settings.get().preset === 'graphics' ? 'Auto HDR and windowed game optimizations on.' : 'Windowed game optimizations and VRR on.', details: [`${key} › ${name}: ${shown(backup.get(this.id).entries[0])} → ${data}`] };
  },
  async revert() {
    const b = backup.get(this.id);
    if (!b) return { ok: true };
    for (const e of b.entries) {
      if (e.exists) await reg.set(e.key, e.name, e.type, e.data);
      else await reg.del(e.key, e.name);
    }
    backup.remove(this.id);
    return { ok: true };
  },
});

// Every installed game → "High performance" graphics card (Windows Settings › Display › Graphics, done for you).
TWEAKS.push({
  id: 'game_gpu',
  name: 'Run every game on the gaming graphics card',
  desc: 'Finds your Steam and Epic games and tells Windows to run each one on your fastest graphics card instead of the built-in one.',
  demoMessage: 'Set 23 games to the high-performance graphics card.',
  demoDetails: ['ELDEN RING (Steam): start_protected_game.exe, eldenring.exe → High performance GPU', 'Rocket League (Epic): RocketLeague.exe → High performance GPU', 'Forza Horizon 5 (Steam): ForzaHorizon5.exe → High performance GPU', '…and 20 more games'],
  async apply() {
    const { findGames } = require('./games');
    const key = 'HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences';
    const games = await findGames();
    if (!games.length) return { ok: true, message: 'No Steam or Epic games found.' };
    const exes = games.flatMap((g) => g.exes);
    const b = backup.get(this.id) || { entries: [] };
    const known = new Set(b.entries.map((e) => e.name.toLowerCase()));
    for (const exe of exes) {
      if (!known.has(exe.toLowerCase())) {
        b.entries.push({ key, name: exe, ...(await reg.get(key, exe)) });
        known.add(exe.toLowerCase());
      }
    }
    backup.put(this.id, b);
    for (const exe of exes) await reg.set(key, exe, 'REG_SZ', 'GpuPreference=2;');
    return {
      ok: true,
      message: `Set ${games.length} game${games.length === 1 ? '' : 's'} to the high-performance graphics card.`,
      details: games.map((g) => `${g.name} (${g.store}): ${g.exes.map((e) => e.split('\\').pop()).join(', ')} → High performance GPU`),
    };
  },
  async revert() {
    const b = backup.get(this.id);
    if (!b) return { ok: true };
    for (const e of b.entries) {
      if (e.exists) await reg.set(e.key, e.name, e.type, e.data);
      else await reg.del(e.key, e.name);
    }
    backup.remove(this.id);
    return { ok: true };
  },
});

// Overclocking: only the safe, vendor-supported knob FrameForge can set by itself.
TWEAKS.push({
  id: 'gpu_power_limit',
  name: 'Max out graphics card power limit',
  desc: 'Raises the NVIDIA power limit to the highest value your card allows, so it can hold higher boost clocks.',
  admin: true,
  overclock: true,
  vendor: 'nvidia',
  async apply() {
    const q = await run('nvidia-smi', ['--query-gpu=power.limit,power.default_limit,power.max_limit', '--format=csv,noheader,nounits']);
    if (q.code !== 0) return { ok: false, warn: true, message: 'Couldn’t read the power limit from the NVIDIA driver.' };
    const [cur, , max] = q.stdout.trim().split(/\r?\n/)[0].split(',').map((x) => parseFloat(x));
    if (!max || isNaN(max)) return { ok: false, warn: true, message: 'This card doesn’t report a maximum power limit.' };
    if (!backup.get(this.id)) backup.put(this.id, { prev: cur });
    if (Math.abs(max - cur) < 1) return { ok: true, message: `Already at the maximum (${Math.round(max)} W).` };
    const r = await run('nvidia-smi', ['-pl', String(Math.floor(max))]);
    if (r.code !== 0) {
      backup.remove(this.id);
      return { ok: false, warn: true, message: 'This card doesn’t allow the power limit to be changed from Windows. Use Automatic Tuning in the NVIDIA app instead.' };
    }
    return { ok: true, message: `Power limit raised from ${Math.round(cur)} W to ${Math.floor(max)} W.`, details: [`NVIDIA GPU power limit: ${Math.round(cur)} W → ${Math.floor(max)} W (resets on restart)`] };
  },
  async revert() {
    const b = backup.get(this.id);
    if (b && b.prev) await run('nvidia-smi', ['-pl', String(Math.round(b.prev))]);
    backup.remove(this.id);
    return { ok: true };
  },
});

// Driver-app settings for each preset. These live inside AMD Software / the NVIDIA app, which other apps
// can't change, so FrameForge opens the app and shows this checklist.
const G = (title, where) => ({ title, where });
const NV = 'NVIDIA Control Panel › Manage 3D settings';
const AMD_G = 'AMD Software › Gaming › Graphics';
const VENDOR_GUIDES = {
  nvidia: {
    competitive: [
      G('Low Latency Mode → Ultra', NV),
      G('Power management mode → Prefer maximum performance', NV),
      G('Texture filtering quality → High performance', NV),
      G('Vertical sync → Off', NV),
      G('In games: NVIDIA Reflex → On + Boost, V-Sync off, effects and shadows low for clear visibility', 'In-game graphics settings'),
    ],
    performance: [
      G('Low Latency Mode → Ultra', NV),
      G('Power management mode → Prefer maximum performance', NV),
      G('Texture filtering quality → High performance', NV),
      G('Shader Cache Size → Unlimited', NV),
      G('In games: NVIDIA Reflex → On + Boost, DLSS → Performance', 'In-game graphics settings'),
    ],
    balanced: [
      G('Low Latency Mode → On', NV),
      G('Power management mode → Prefer maximum performance', NV),
      G('In games: NVIDIA Reflex → On, DLSS → Quality', 'In-game graphics settings'),
    ],
    graphics: [
      G('Texture filtering quality → High quality', NV),
      G('Power management mode → Prefer maximum performance', NV),
      G('RTX HDR / RTX Dynamic Vibrance → On (HDR screens)', 'NVIDIA app › Graphics › Global settings'),
      G('G-SYNC → On for full screen and windowed', 'NVIDIA Control Panel › Set up G-SYNC'),
      G('In games: DLAA or DLSS → Quality, textures and anisotropic filtering → max', 'In-game graphics settings'),
    ],
  },
  amd: {
    competitive: [
      G('Radeon Anti-Lag → On (or Anti-Lag 2 in games that offer it)', AMD_G),
      G('Radeon Boost → Off (it blurs the image while you aim)', AMD_G),
      G('Enhanced Sync and Wait for Vertical Refresh → Off', AMD_G),
      G('AMD FreeSync → On', 'AMD Software › Gaming › Display'),
      G('In games: V-Sync off, effects and shadows low for clear visibility', 'In-game graphics settings'),
    ],
    performance: [
      G('HYPR-RX → On (Anti-Lag + Boost + Super Resolution in one click)', 'AMD Software › Home'),
      G('Radeon Anti-Lag → On', AMD_G),
      G('Radeon Boost → On', AMD_G),
      G('Enhanced Sync → Off (it can stutter)', AMD_G),
      G('In games: FSR → Performance, Fluid Motion Frames → On', 'In-game / AMD Software › Gaming'),
    ],
    balanced: [
      G('Radeon Anti-Lag → On', AMD_G),
      G('Radeon Image Sharpening → On', AMD_G),
      G('In games: FSR → Quality', 'In-game graphics settings'),
    ],
    graphics: [
      G('HYPR-RX → Off (its Boost lowers resolution while moving)', 'AMD Software › Home'),
      G('Radeon Image Sharpening → On, 50–80%', AMD_G),
      G('AMD FreeSync → On', 'AMD Software › Gaming › Display'),
      G('10-bit pixel format → On (if your screen supports it)', 'AMD Software › Gaming › Graphics › Advanced'),
      G('In games: native resolution or FSR → Native AA / Quality, textures → max', 'In-game graphics settings'),
    ],
  },
  intel: {
    competitive: [G('Low Latency → On', 'Intel Graphics Software › Graphics'), G('In games: V-Sync off, effects low', 'In-game graphics settings')],
    performance: [G('Low Latency → On', 'Intel Graphics Software › Graphics'), G('In games: XeSS → Performance', 'In-game graphics settings')],
    balanced: [G('Low Latency → On', 'Intel Graphics Software › Graphics'), G('In games: XeSS → Quality', 'In-game graphics settings')],
    graphics: [G('In games: XeSS → Ultra Quality or native', 'In-game graphics settings'), G('Adaptive Sync → On', 'Intel Graphics Software › Display')],
  },
};

function list() {
  return TWEAKS.filter((t) => !t.overclock).map(({ id, name, desc, admin, reboot, oneShot }) => ({
    id,
    name,
    desc,
    admin: !!admin,
    reboot: !!reboot,
    oneShot: !!oneShot,
  }));
}

/**
 * Turn Auto Mode on. `emit(step)` is called for every step so the UI can show live progress.
 * opts.quiet = true when re-applying silently on startup (skips one-shot steps).
 */
function planned({ quiet = false, rig }) {
  const s = settings.get();
  const vendor = rig && rig.gpu ? rig.gpu.vendor : null;
  return TWEAKS.filter((t) => {
    if (quiet && t.oneShot) return false;
    if (t.overclock) return s.overclock && t.vendor === vendor;
    return s.tweaks[t.id];
  });
}

/** Apply one tweak. Returns { status, message }. */
async function runOne(t, { admin, progress } = {}) {
  let res;
  if (t.admin && !admin) {
    res = { ok: false, warn: true, message: 'Skipped — needs FrameForge to run as administrator.' };
  } else if (DEMO && process.env.FRAMEFORGE_DEMO_FAIL === t.id && !runOne.failedOnce) {
    // Test hook: reproduce a real winutil failure once.
    runOne.failedOnce = true;
    await sleep(800);
    res = { ok: false, warn: true, fix: 'ctt', message: 'Most of the Standard preset ran, but winutil reported a problem: [Tweaks] WPFTweaksServices: timed out after 300 s. Open Fix mode to retry it or open the Chris Titus tool.', details: ['Error: [Tweaks] WPFTweaksServices: timed out after 300 s', 'Tweaks: 1 error(s)', 'Full winutil log: C:\\Users\\Tommy\\AppData\\Local\\winutil\\logs\\winutil_2026-10-20_19-01-40.log'] };
  } else if (DEMO && t.id === 'ctt_tweaks') {
    res = await t.apply({ progress });
  } else if (DEMO) {
    await sleep(450 + Math.random() * 500);
    res = { ok: true, message: t.demoMessage || (t.id === 'temp_cleanup' ? 'Freed 1.4 GB.' : 'Done.'), details: t.demoDetails || (t.values ? regDetails(t.values) : t.what || []) };
    if (!t.oneShot) backup.put(t.id, { demo: true });
  } else {
    try {
      res = await t.apply({ progress });
    } catch (e) {
      // A setting Windows won't let apps change on this PC isn't an error to fix — it's just not available.
      const locked = !!(e && e.constructor && e.constructor.name === 'LockedSetting');
      res = { ok: false, warn: locked, locked, message: String(e.message || e).slice(0, 300) };
    }
  }
  let message = res.message || '';
  if (res.ok && (!message || message === 'Done.')) message = t.desc.split(/(?<=\.)\s/)[0]; // first sentence of what it does
  return { status: res.ok ? 'done' : res.warn ? 'warn' : 'error', message, reboot: res.ok && (!!t.reboot || !!res.rebootNow), details: res.details || [], fix: res.fix || null, adminSkipped: t.admin && !admin, locked: !!res.locked };
}

/** Turn Auto Mode off: undo everything in reverse order. */
async function disable(emit) {
  const ids = Object.keys(backup.all());
  const ordered = TWEAKS.filter((t) => ids.includes(t.id)).reverse();
  let needsReboot = false;
  for (const t of ordered) {
    emit({ id: t.id, name: `Undo: ${t.name}`, status: 'running' });
    try {
      if (DEMO) await sleep(250);
      else await t.revert();
      if (t.reboot) needsReboot = true;
      emit({ id: t.id, name: `Undo: ${t.name}`, status: 'done', message: 'Restored.' });
    } catch (e) {
      emit({ id: t.id, name: `Undo: ${t.name}`, status: 'error', message: String(e.message || e).slice(0, 200) });
    }
  }
  if (DEMO) Object.keys(backup.all()).forEach((k) => backup.remove(k));
  return { needsReboot };
}

/** Boosts that are currently applied, in the order to undo them. */
function revertPlan() {
  const ids = Object.keys(backup.all());
  return TWEAKS.filter((t) => ids.includes(t.id)).reverse();
}

async function revertOne(t) {
  if (DEMO) {
    await sleep(300);
    backup.remove(t.id);
    return;
  }
  await t.revert();
}

function activeCount() {
  return Object.keys(backup.all()).length;
}

module.exports = { registryTweak, sameValue, toNum, activeScheme, BALANCED, CTT_PRESETS, CTT_NAMES, list, planned, runOne, revertPlan, revertOne, disable, activeCount, VENDOR_GUIDES, TWEAKS };
