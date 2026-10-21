// Extra performance tweaks for the Tweaks tab (they can also be part of Auto Mode presets).
// Every tweak here:
//   apply()    – saves what was there before (in backup.json), then changes it
//   revert()   – puts back exactly what was saved
//   isOn()     – reads Windows itself, so the switch shows the real state
//   forceOff() – sets the Windows default when FrameForge didn't make the change
//   what       – the exact settings it touches, shown under "Exactly what it changes"
// Nothing parses English text from Windows tools, so it works on any Windows language.
const os = require('os');
const reg = require('./registry');
const { run, ps, DEMO } = require('./util');
const { backup } = require('./store');
const { TWEAKS, registryTweak, toNum, activeScheme } = require('./optimizer');

const HKCU = 'HKCU';
const HKLM = 'HKLM';

// ---------- Power-plan settings (powercfg), applied to the active plan, plugged-in (AC) only ----------
const SUB_PROCESSOR = '54533251-82be-4824-96c1-47b60b740d00';
const SUB_PCIE = '501a4d13-42af-4429-9fd1-a8218c268e20';
const SUB_USB = '2a737441-1930-4402-8d77-b2bebba308a3';
const P = {
  CPMINCORES: [SUB_PROCESSOR, '0cc5b647-c1df-4637-891a-dec35c318583'], // core parking: min % of cores unparked
  PROCTHROTTLEMIN: [SUB_PROCESSOR, '893dee8e-2bef-41e0-89c6-b55d0929964c'], // minimum processor state %
  PERFBOOSTMODE: [SUB_PROCESSOR, 'be337238-0d82-4146-a960-4f3749d470c7'], // 0 off, 1 on, 2 aggressive…
  ASPM: [SUB_PCIE, 'ee12f906-d277-404b-b6da-e5fa1a576df5'], // PCIe link state power management: 0 off
  USBSUSPEND: [SUB_USB, '48e6b7a6-50f5-4782-a5d4-53bb8f07e226'], // USB selective suspend: 0 disabled
};

async function currentScheme() {
  return activeScheme((await run('powercfg', ['/getactivescheme'])).stdout);
}

/**
 * Read one power setting from powercfg, in any Windows language. powercfg prints only hex values we
 * can rely on: range settings show min, max, step, then AC and DC; list settings show just AC and DC.
 */
async function readSetting(scheme, [sub, setting]) {
  const r = await run('powercfg', ['/query', scheme, sub, setting]);
  const hex = (r.stdout.match(/0x[0-9a-f]{8}/gi) || []).map((h) => parseInt(h, 16));
  if (hex.length < 2) return null;
  const info = { ac: hex[hex.length - 2], dc: hex[hex.length - 1] };
  if (hex.length >= 5) {
    info.min = hex[0];
    info.max = hex[1];
  }
  return info;
}

async function readAc(scheme, p) {
  const info = await readSetting(scheme, p);
  return info ? info.ac : null;
}

/** The value to use on this PC: the wanted value, kept inside the range Windows allows. */
function fit(info, value) {
  if (!info || info.min == null || info.max == null) return value;
  return Math.min(info.max, Math.max(info.min, value));
}

class LockedSetting extends Error {}

/** Write a plugged-in value; retry with the SCHEME_CURRENT alias; explain clearly if Windows refuses. */
async function writeAc(scheme, p, value, label = 'this power setting') {
  const [sub, setting] = p;
  let r = await run('powercfg', ['/setacvalueindex', scheme, sub, setting, String(value)]);
  if (r.code !== 0) r = await run('powercfg', ['/setacvalueindex', 'SCHEME_CURRENT', sub, setting, String(value)]);
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim().replace(/\s+/g, ' ').slice(0, 160);
    throw new LockedSetting(`Windows doesn’t allow apps to change ${label} on this PC, so nothing was changed.${why ? ` (Windows said: ${why})` : ''}`);
  }
}

/** items: [{ p: P.X, value, def, label, unit }] */
function powerTweak(items) {
  return {
    what: items.map((i) => `Power plan › ${i.label} (plugged in) = ${i.value}${i.unit || ''}`),
    async isOn() {
      const sch = await currentScheme();
      if (!sch) return false;
      for (const i of items) {
        const info = await readSetting(sch, i.p);
        if (!info || info.ac !== fit(info, i.value)) return false;
      }
      return true;
    },
    async apply() {
      const sch = await currentScheme();
      if (!sch) throw new Error('Couldn’t find the active power plan.');
      const b = backup.get(this.id);
      const first = !b || b.scheme !== sch;
      const vals = [];
      for (const i of items) {
        const info = await readSetting(sch, i.p);
        vals.push({ p: i.p, prev: info ? info.ac : null, to: fit(info, i.value) });
      }
      // Write everything before saving the backup, so a refused setting leaves nothing half-done.
      const done = [];
      try {
        for (const [k, i] of items.entries()) {
          await writeAc(sch, i.p, vals[k].to, i.label);
          done.push(k);
        }
      } catch (e) {
        for (const k of done) if (vals[k].prev != null) await writeAc(sch, items[k].p, vals[k].prev, items[k].label).catch(() => {});
        throw e;
      }
      if (first) backup.put(this.id, { scheme: sch, vals: vals.map(({ p, prev }) => ({ p, prev })) });
      await run('powercfg', ['/setactive', sch]); // makes Windows use the new values right away
      const saved = backup.get(this.id).vals;
      const capped = items.map((i, k) => (vals[k].to !== i.value ? `${i.label} set to ${vals[k].to}${i.unit || ''} — the highest your PC allows` : null)).filter(Boolean);
      return { ok: true, message: capped.length ? `${capped.join('; ')}.` : undefined, details: items.map((i, k) => `Power plan ${sch} › ${i.label} (plugged in): ${saved[k].prev ?? 'unknown'}${i.unit || ''} → ${vals[k].to}${i.unit || ''}${vals[k].to !== i.value ? ` (the highest your PC allows)` : ''}`) };
    },
    async revert() {
      const b = backup.get(this.id);
      if (!b) return { ok: true };
      const exists = (await run('powercfg', ['/query', b.scheme])).code === 0; // the plan may have been removed since
      if (exists) {
        for (const v of b.vals) if (v.prev != null) await writeAc(b.scheme, v.p, v.prev).catch(() => {});
        const cur = await currentScheme();
        if (cur) await run('powercfg', ['/setactive', cur]);
      }
      backup.remove(this.id);
      return { ok: true };
    },
    async forceOff() {
      const sch = await currentScheme();
      if (!sch) return { ok: true };
      for (const i of items) {
        const info = await readSetting(sch, i.p);
        await writeAc(sch, i.p, fit(info, i.def), i.label);
      }
      await run('powercfg', ['/setactive', sch]);
      return { ok: true };
    },
  };
}

// ---------- The tweaks ----------
const NEW = [
  // Input lag
  {
    id: 'usb_suspend',
    cat: 'input',
    name: 'Keep USB devices awake',
    desc: 'Turns off USB selective suspend while plugged in, so Windows never puts your mouse, keyboard or headset to sleep. Stops random input hiccups and audio dropouts.',
    admin: true,
    ...powerTweak([{ p: P.USBSUSPEND, value: 0, def: 1, label: 'USB selective suspend', unit: ' (0 = off)' }]),
  },
  {
    id: 'kb_repeat',
    cat: 'input',
    name: 'Fastest key repeat',
    desc: 'Shortest delay before a held key starts repeating, at the fastest repeat rate. Held keys respond right away. Works immediately.',
    ...registryTweak([
      { key: `${HKCU}\\Control Panel\\Keyboard`, name: 'KeyboardDelay', type: 'REG_SZ', data: '0', def: '1' },
      { key: `${HKCU}\\Control Panel\\Keyboard`, name: 'KeyboardSpeed', type: 'REG_SZ', data: '31', def: '31' },
    ]),
    async after() {
      // Apply now (SPI_SETKEYBOARDDELAY 0x17, SPI_SETKEYBOARDSPEED 0x0B) instead of after sign-out.
      const d = await reg.get(`${HKCU}\\Control Panel\\Keyboard`, 'KeyboardDelay');
      const sp = await reg.get(`${HKCU}\\Control Panel\\Keyboard`, 'KeyboardSpeed');
      const delay = d.exists ? parseInt(d.data, 10) || 0 : 1;
      const speed = sp.exists ? parseInt(sp.data, 10) || 31 : 31;
      await ps(
        `Add-Type -Namespace FF -Name K -MemberDefinition '[DllImport("user32.dll")] public static extern bool SystemParametersInfo(int a,int b,System.IntPtr c,int d);'; [FF.K]::SystemParametersInfo(0x17,${delay},[System.IntPtr]::Zero,3) | Out-Null; [FF.K]::SystemParametersInfo(0x0B,${speed},[System.IntPtr]::Zero,3) | Out-Null`
      );
    },
  },
  {
    id: 'fso_off',
    cat: 'input',
    name: 'Real exclusive fullscreen',
    desc: 'Turns off Windows’ “fullscreen optimizations”, so games set to Fullscreen get true exclusive fullscreen — often lower input lag in older DirectX 9/11 games. Leave off if alt-tab gets slow for you.',
    ...registryTweak([
      { key: `${HKCU}\\System\\GameConfigStore`, name: 'GameDVR_FSEBehaviorMode', type: 'REG_DWORD', data: 2, def: 0 },
      { key: `${HKCU}\\System\\GameConfigStore`, name: 'GameDVR_HonorUserFSEBehaviorMode', type: 'REG_DWORD', data: 1, def: 0 },
      { key: `${HKCU}\\System\\GameConfigStore`, name: 'GameDVR_FSEBehavior', type: 'REG_DWORD', data: 2 },
      { key: `${HKCU}\\System\\GameConfigStore`, name: 'GameDVR_DXGIHonorFSEWindowsCompatible', type: 'REG_DWORD', data: 1, def: 0 },
    ]),
  },
  {
    id: 'timer_res',
    cat: 'input',
    name: 'Precise game timers (Windows 11)',
    desc: 'Lets the high-precision timer a game asks for apply system-wide again, as it did before Windows 11. Can give steadier frame pacing and lower latency. Needs a restart.',
    admin: true,
    reboot: true,
    ...registryTweak([{ key: `${HKLM}\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\kernel`, name: 'GlobalTimerResolutionRequests', type: 'REG_DWORD', data: 1 }]),
  },

  // CPU
  {
    id: 'core_parking',
    cat: 'cpu',
    name: 'Use all CPU cores',
    desc: 'Windows already uses all your cores, but it “parks” (sleeps) some to save power and wakes them when needed. This keeps every core awake while plugged in, and removes the msconfig “Number of processors” limit if one was ever set. Not for AMD X3D chips — they park cores on purpose to keep games on the fast cache cores.',
    admin: true,
    what: ['Power plan › Processor core parking: minimum cores unparked (plugged in) = 100%', 'Boot setting “numproc” (msconfig › Number of processors) removed, if set — restart needed then'],
    async limited() {
      const si = require('systeminformation');
      const total = (await si.cpu()).cores || 0;
      return total > 0 && os.cpus().length < total ? { visible: os.cpus().length, total } : null;
    },
    async isOn() {
      const sch = await currentScheme();
      if (!sch) return false;
      const info = await readSetting(sch, P.CPMINCORES);
      return !!info && info.ac === fit(info, 100) && !(await this.limited());
    },
    async apply() {
      const sch = await currentScheme();
      if (!sch) throw new Error('Couldn’t find the active power plan.');
      const info = await readSetting(sch, P.CPMINCORES);
      const to = fit(info, 100);
      const b = backup.get(this.id) || {};
      const prev = info ? info.ac : null;
      const details = [];
      let parkingNote = '';
      try {
        await writeAc(sch, P.CPMINCORES, to, 'core parking');
        await run('powercfg', ['/setactive', sch]);
        if (b.scheme !== sch) b.prev = prev;
        b.scheme = sch;
        details.push(`Power plan ${sch} › core parking, minimum cores unparked (plugged in): ${b.prev ?? 'unknown'}% → ${to}%`);
      } catch (e) {
        if (!(e instanceof LockedSetting)) throw e;
        // AMD X3D drivers (and some laptop makers) manage core parking themselves and lock it.
        parkingNote = 'Your CPU’s driver manages core parking itself and doesn’t let apps change it — that’s normal, especially on AMD X3D chips.';
      }
      let reboot = false;
      const lim = await this.limited();
      if (lim && !b.numproc) {
        const r = await run('bcdedit', ['/deletevalue', '{current}', 'numproc']);
        if (r.code === 0) {
          b.numproc = lim.visible;
          reboot = true;
          details.push(`Removed the msconfig limit: Windows could only see ${lim.visible} of your ${lim.total} processor threads. Restart to use all of them.`);
        }
      }
      if (parkingNote && !reboot) {
        // Nothing could be changed at all.
        throw new LockedSetting(`${parkingNote} Nothing was changed, and Windows still uses all your cores.`);
      }
      backup.put(this.id, b);
      return {
        ok: true,
        message: parkingNote ? `Removed the core limit — restart to finish. ${parkingNote}` : reboot ? 'All cores stay awake, and the core limit is removed — restart to finish.' : 'All cores stay awake while plugged in.',
        details,
        rebootNow: reboot,
      };
    },
    async revert() {
      const b = backup.get(this.id);
      if (!b) return { ok: true };
      if (b.scheme && b.prev != null && (await run('powercfg', ['/query', b.scheme])).code === 0) {
        await writeAc(b.scheme, P.CPMINCORES, b.prev).catch(() => {});
        const cur = await currentScheme();
        if (cur) await run('powercfg', ['/setactive', cur]);
      }
      if (b.numproc) await run('bcdedit', ['/set', '{current}', 'numproc', String(b.numproc)]);
      backup.remove(this.id);
      return { ok: true };
    },
    async forceOff() {
      const sch = await currentScheme();
      if (sch) {
        const info = await readSetting(sch, P.CPMINCORES);
        await writeAc(sch, P.CPMINCORES, fit(info, 10), 'core parking');
        await run('powercfg', ['/setactive', sch]);
      }
      return { ok: true };
    },
  },
  {
    id: 'cpu_min',
    cat: 'cpu',
    name: 'Keep CPU at full speed',
    desc: 'Sets the minimum processor state to 100% while plugged in, so the CPU never drops to low clocks between frames. Already part of Ultimate Performance; this does it on any power plan. Uses more power at idle.',
    admin: true,
    ...powerTweak([{ p: P.PROCTHROTTLEMIN, value: 100, def: 5, label: 'Minimum processor state', unit: '%' }]),
  },
  {
    id: 'cpu_boost',
    cat: 'cpu',
    name: 'Aggressive CPU boost',
    desc: 'Tells the CPU to jump to its boost clocks as fast as it can while plugged in, instead of easing into them. Snappier when a game suddenly needs more CPU.',
    admin: true,
    ...powerTweak([{ p: P.PERFBOOSTMODE, value: 2, def: 1, label: 'Processor performance boost mode', unit: ' (2 = Aggressive)' }]),
  },

  // Graphics & games
  {
    id: 'sys_responsiveness',
    cat: 'games',
    name: 'Prioritize games over background tasks',
    desc: 'Windows normally keeps 20% of CPU time for background tasks while games and audio run. This lowers it to 10%, the minimum Windows allows, so games get more.',
    admin: true,
    ...registryTweak([{ key: `${HKLM}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile`, name: 'SystemResponsiveness', type: 'REG_DWORD', data: 10, def: 20 }]),
  },
  {
    id: 'pcie_lspm',
    cat: 'games',
    name: 'Keep the graphics card link at full power',
    desc: 'Turns off PCIe link-state power saving while plugged in, so the connection to your graphics card (and NVMe drive) never naps. Avoids small wake-up delays and stutter.',
    admin: true,
    ...powerTweak([{ p: P.ASPM, value: 0, def: 1, label: 'PCI Express link state power management', unit: ' (0 = off)' }]),
  },

  // Network
  {
    id: 'net_throttling',
    cat: 'network',
    name: 'Remove network throttling',
    desc: 'Windows limits network traffic while games or media play, to keep audio smooth on old PCs. This removes that limit.',
    admin: true,
    ...registryTweak([{ key: `${HKLM}\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Multimedia\\SystemProfile`, name: 'NetworkThrottlingIndex', type: 'REG_DWORD', data: 0xffffffff, def: 10 }]),
  },
  {
    id: 'nagle_off',
    cat: 'network',
    name: 'Send game packets instantly (Nagle off)',
    desc: 'Stops Windows from bundling small network packets together on your active network adapters. Lowers ping in games that use TCP (many MMOs and older online games). Games using UDP aren’t affected. New connections use it right away.',
    admin: true,
    what: ['HKLM\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\{each active adapter} › TcpAckFrequency = 1, TCPNoDelay = 1'],
    async adapters() {
      const r = await ps("Get-NetAdapter -Physical -ErrorAction SilentlyContinue | Where-Object Status -eq 'Up' | ForEach-Object { $_.InterfaceGuid }");
      return (r.stdout.match(/\{[0-9A-F-]{36}\}/gi) || []).map((g) => g.toUpperCase());
    },
    valuesFor(guid) {
      const key = `${HKLM}\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\${guid}`;
      return [
        { key, name: 'TcpAckFrequency', type: 'REG_DWORD', data: 1 },
        { key, name: 'TCPNoDelay', type: 'REG_DWORD', data: 1 },
      ];
    },
    async isOn() {
      const ads = await this.adapters();
      if (!ads.length) return false;
      for (const g of ads) for (const v of this.valuesFor(g)) {
        const cur = await reg.get(v.key, v.name);
        if (!cur.exists || toNum(cur.data) !== 1) return false;
      }
      return true;
    },
    async apply() {
      const ads = await this.adapters();
      if (!ads.length) return { ok: false, warn: true, message: 'No connected network adapter found.' };
      const b = backup.get(this.id) || { entries: [] };
      const details = [];
      for (const g of ads) {
        for (const v of this.valuesFor(g)) {
          let prev = b.entries.find((e) => e.key === v.key && e.name === v.name);
          if (!prev) b.entries.push((prev = { key: v.key, name: v.name, ...(await reg.get(v.key, v.name)) }));
          await reg.set(v.key, v.name, v.type, v.data);
          details.push(`${v.key} › ${v.name}: ${prev.exists ? toNum(prev.data) : 'not set'} → 1`);
        }
      }
      backup.put(this.id, b);
      return { ok: true, message: `Nagle turned off on ${ads.length} network adapter${ads.length === 1 ? '' : 's'}.`, details };
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
    async forceOff() {
      for (const g of await this.adapters()) for (const v of this.valuesFor(g)) await reg.del(v.key, v.name);
      return { ok: true };
    },
  },

  // Windows & background
  {
    id: 'bg_apps',
    cat: 'windows',
    name: 'Stop background apps',
    desc: 'Stops Microsoft Store apps (Mail, Photos, Weather, Xbox…) from running in the background. Normal programs like Discord, Steam and OBS are not affected.',
    ...registryTweak([
      { key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\BackgroundAccessApplications`, name: 'GlobalUserDisabled', type: 'REG_DWORD', data: 1, def: 0 },
      { key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Search`, name: 'BackgroundAppGlobalToggle', type: 'REG_DWORD', data: 0, def: 1 },
    ]),
  },
  {
    id: 'transparency',
    cat: 'windows',
    name: 'Turn off transparency effects',
    desc: 'Turns off the see-through blur in the taskbar, Start and windows. Saves a little graphics card work in the background. Works immediately.',
    ...registryTweak([{ key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize`, name: 'EnableTransparency', type: 'REG_DWORD', data: 0, def: 1 }]),
  },
  {
    id: 'startup_delay',
    cat: 'windows',
    name: 'No startup delay',
    desc: 'Windows waits about 10 seconds after you sign in before launching startup apps. This removes the wait, so Discord, Steam and FrameForge are ready sooner.',
    ...registryTweak([
      { key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize`, name: 'StartupDelayInMSec', type: 'REG_DWORD', data: 0 },
      { key: `${HKCU}\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\Serialize`, name: 'WaitForIdleState', type: 'REG_DWORD', data: 0 },
    ]),
  },
  {
    id: 'menu_delay',
    cat: 'windows',
    name: 'Instant menus',
    desc: 'Menus and sub-menus open instantly instead of after a 0.4-second delay. Takes effect the next time you sign in.',
    ...registryTweak([{ key: `${HKCU}\\Control Panel\\Desktop`, name: 'MenuShowDelay', type: 'REG_SZ', data: '0', def: '400' }]),
  },
  {
    id: 'sysmain_off',
    cat: 'windows',
    name: 'Turn off SysMain (Superfetch)',
    desc: 'SysMain preloads apps into memory and can cause heavy disk use and hitches on some PCs. On a fast SSD it helps little. Turn it back on if apps start feeling slower to open.',
    admin: true,
    ...registryTweak([{ key: `${HKLM}\\SYSTEM\\CurrentControlSet\\Services\\SysMain`, name: 'Start', type: 'REG_DWORD', data: 4, def: 2 }]),
    async after(on) {
      if (on) await run('sc', ['stop', 'SysMain']);
      else {
        const st = await reg.get(`${HKLM}\\SYSTEM\\CurrentControlSet\\Services\\SysMain`, 'Start');
        if (st.exists && toNum(st.data) === 2) await run('sc', ['start', 'SysMain']);
      }
    },
  },
  {
    id: 'mem_compression',
    cat: 'windows',
    name: 'Turn off memory compression (16 GB+ RAM)',
    desc: 'Windows compresses memory to fit more in RAM, which costs a little CPU time. With 16 GB or more you rarely need it. Needs a restart.',
    admin: true,
    reboot: true,
    what: ['Disable-MMAgent -MemoryCompression (turn back on: Enable-MMAgent -MemoryCompression)'],
    async isOn() {
      const r = await ps('(Get-MMAgent).MemoryCompression');
      return /^\s*False\s*$/i.test(r.stdout);
    },
    async apply() {
      const before = await ps('(Get-MMAgent).MemoryCompression');
      if (!backup.get(this.id)) backup.put(this.id, { wasOn: /True/i.test(before.stdout) });
      const r = await ps('Disable-MMAgent -MemoryCompression -ErrorAction Stop');
      if (r.code !== 0) {
        backup.remove(this.id);
        throw new Error((r.stderr || r.stdout).trim().slice(0, 160) || 'Disable-MMAgent failed');
      }
      return { ok: true, message: 'Memory compression turned off — restart to finish.', details: [`Memory compression: ${/True/i.test(before.stdout) ? 'on' : 'off'} → off (after restart)`] };
    },
    async revert() {
      const b = backup.get(this.id);
      if (b && b.wasOn) await ps('Enable-MMAgent -MemoryCompression');
      backup.remove(this.id);
      return { ok: true };
    },
    async forceOff() {
      await ps('Enable-MMAgent -MemoryCompression');
      return { ok: true };
    },
  },
];

// Add them to the shared list (before overclocking, which stays last) so Auto Mode, undo,
// the change list, Fix mode and the AI all treat them like every other boost.
const ocIndex = TWEAKS.findIndex((t) => t.overclock);
TWEAKS.splice(ocIndex >= 0 ? ocIndex : TWEAKS.length, 0, ...NEW);

// ---------- Where every boost shows up in the Tweaks tab ----------
const CATS = [
  { id: 'input', name: 'Reduce input lag', blurb: 'Faster response from mouse, keyboard and screen.' },
  { id: 'cpu', name: 'CPU', blurb: 'Keep the processor fast and awake while you play.' },
  { id: 'games', name: 'Graphics & games', blurb: 'Give games the hardware first, and the fastest graphics card.' },
  { id: 'network', name: 'Network', blurb: 'Lower lag in online games.' },
  { id: 'windows', name: 'Windows & background', blurb: 'Less going on behind your game.' },
];
// Category for the boosts that already existed before the Tweaks tab.
const EXISTING_CAT = {
  mouse_precision: 'input',
  no_popups: 'input',
  power_plan: 'cpu',
  power_throttling: 'cpu',
  game_mode: 'games',
  game_dvr: 'games',
  hags: 'games',
  game_priority: 'games',
  game_gpu: 'games',
  dx_opt: 'games',
  visual_effects: 'windows',
};
for (const t of TWEAKS) if (!t.cat && EXISTING_CAT[t.id]) t.cat = EXISTING_CAT[t.id];
const gg = TWEAKS.find((t) => t.id === 'game_gpu');
if (gg) gg.what = ['HKCU\\Software\\Microsoft\\DirectX\\UserGpuPreferences › <each Steam/Epic game .exe> = GpuPreference=2; (High performance)'];

/** Is this boost really on in Windows right now? */
async function stateOf(t) {
  if (DEMO) return !!backup.get(t.id);
  if (typeof t.isOn === 'function') {
    try {
      return !!(await t.isOn());
    } catch {
      return !!backup.get(t.id);
    }
  }
  return !!backup.get(t.id);
}

function tabTweaks() {
  return TWEAKS.filter((t) => t.cat && !t.oneShot && !t.overclock);
}

module.exports = { CATS, stateOf, tabTweaks, LockedSetting, NEW_IDS: NEW.map((t) => t.id) };
