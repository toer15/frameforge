// Detects the CPU, graphics card, RAM, display, drivers and OS.
//
// Windows PCs differ a lot. Windows' own WMI is the primary source: one short pass gives the CPU, every
// graphics chip, 64-bit VRAM, the display mode, RAM modules, the Windows version and the board — the data
// Task Manager shows. systeminformation is the fallback for a PC where WMI is broken or a class is empty
// (and it can return empty graphics/display lists on hybrid laptops). Every call is time-boxed so one hung
// provider cannot leave the app at "Scanning your PC…", and scan() always returns a complete rig — with
// "Unknown" fields where this PC really reports nothing — instead of failing.
const si = require('systeminformation');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { run, ps, IS_WIN, DEMO } = require('./util');

function vendorOf(text = '') {
  const t = text.toLowerCase();
  if (t.includes('nvidia') || t.includes('geforce') || t.includes('rtx') || t.includes('gtx') || t.includes('quadro') || t.includes('tesla')) return 'nvidia';
  if (t.includes('amd') || t.includes('advanced micro') || t.includes('radeon') || t.includes('ati ')) return 'amd';
  if (t.includes('intel')) return 'intel';
  return 'other';
}

const VENDOR_NAMES = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel', other: 'Unknown' };

const VENDOR_APPS = {
  nvidia: {
    name: 'NVIDIA app',
    paths: [
      'C:\\Program Files\\NVIDIA Corporation\\NVIDIA app\\CEF\\NVIDIA app.exe',
      'C:\\Program Files\\NVIDIA Corporation\\NVIDIA GeForce Experience\\NVIDIA GeForce Experience.exe',
    ],
    download: 'https://www.nvidia.com/en-us/software/nvidia-app/',
  },
  amd: {
    name: 'AMD Software: Adrenalin Edition',
    paths: [
      'C:\\Program Files\\AMD\\CNext\\CNext\\RadeonSoftware.exe',
      'C:\\Program Files\\AMD\\CNext\\CNext\\AMDRSServ.exe',
    ],
    download: 'https://www.amd.com/en/support/download/drivers.html',
  },
  intel: {
    name: 'Intel Graphics Software',
    paths: [
      'C:\\Program Files\\Intel\\Intel Graphics Software\\IntelGraphicsSoftware.exe',
      'C:\\Program Files\\Intel\\Intel Arc Control\\ArcControl.exe',
    ],
    download: 'https://www.intel.com/content/www/us/en/support/detect.html',
  },
};

function findVendorApp(vendor) {
  const info = VENDOR_APPS[vendor];
  if (!info || !IS_WIN) return null;
  const found = info.paths.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  return found || null;
}

/** A promise that settles within `ms`, so a hung Windows provider cannot hold up the whole scan. */
function withTimeout(promise, ms, fallback) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
      if (timer.unref) timer.unref();
    }),
  ]).finally(() => clearTimeout(timer));
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

/** Driver-friendly names: no ®/™/(R)/(TM) and no doubled spaces. */
function cleanName(value) {
  return String(value == null ? '' : value)
    .replace(/\((?:r|tm|c)\)/gi, ' ')
    .replace(/[®™©]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "AMD Ryzen 7 7800X3D 8-Core Processor" → "AMD Ryzen 7 7800X3D"; "Intel(R) Core(TM) i5-12400" → "Intel Core i5-12400". */
function tidyCpuName(value) {
  return cleanName(value)
    .replace(/^GenuineIntel\b/i, 'Intel')
    .replace(/^AuthenticAMD\b/i, 'AMD')
    .replace(/^Intel\s+Intel\b/i, 'Intel')
    .replace(/^AMD\s+AMD\b/i, 'AMD')
    .replace(/\s+\d+-Core Processor$/i, '')
    .replace(/\s+CPU\s*@\s*[\d.]+\s*GHz$/i, '')
    .replace(/\s+CPU$/i, '')
    .trim();
}

function tidyGpuName(value) {
  return cleanName(value).replace(/\s+Graphics Adapter$/i, '').trim();
}

/** Built into the processor / motherboard rather than a card of its own. */
function isIntegratedGpu(name = '') {
  const n = cleanName(name).toLowerCase();
  if (/\barc\s*[ab]\d{3}\b/.test(n)) return false; // Intel Arc A/B cards are dedicated
  if (/intel.*\barc\b/.test(n)) return true; // "Intel Arc Graphics" in Core Ultra processors
  if (/intel.*\b(hd|uhd|iris|graphics)\b/.test(n)) return true;
  if (/radeon.*(graphics|vega)|\bvega\s*\d/.test(n)) return true;
  if (/radeon.*\b\d{3}\s*m\b/.test(n)) return true; // Radeon 780M and other mobile integrated graphics
  if (/apple\s*m\d|qualcomm|adreno|mali/.test(n)) return true;
  return false;
}

const isVirtualGpu = (name) =>
  /basic display|microsoft basic|remote display|remote desktop|virtual|parsec|meta virtual|idd|indirect display|mirror driver|displaylink|spacedesk|duet/i.test(String(name || ''));

const norm = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

const gbFromMB = (mb) => {
  const n = Number(mb);
  return n >= 1024 ? Math.round(n / 1024) : null;
};
const gbFromBytes = (bytes) => {
  const n = Number(bytes);
  return n >= 1024 ** 3 ? Math.round(n / 1024 ** 3) : null;
};
const saneHz = (value) => {
  const n = Number(value);
  return n >= 20 && n <= 480 ? Math.round(n) : null;
};

const MEM_TYPES = { 20: 'DDR', 21: 'DDR2', 22: 'DDR2', 23: 'DDR2', 24: 'DDR3', 26: 'DDR4', 27: 'LPDDR', 28: 'LPDDR2', 29: 'LPDDR3', 30: 'LPDDR4', 34: 'DDR5', 35: 'LPDDR5' };

/** The CPU, from systeminformation and Windows' WMI, whichever has the better answer. */
function cpuInfo(cpu = {}, wmi = null) {
  const w = (wmi && wmi.cpu) || {};
  const maker = cleanName(cpu.manufacturer);
  const brand = cleanName(cpu.brand);
  const fromSi = brand && maker && !brand.toLowerCase().startsWith(maker.toLowerCase()) ? `${maker} ${brand}` : brand || maker;
  const name = tidyCpuName(w.Name) || tidyCpuName(fromSi);
  const cores = Number(cpu.physicalCores) || Number(w.NumberOfCores) || null;
  const threads = Number(cpu.cores) || Number(w.NumberOfLogicalProcessors) || null;
  const speedGHz = Number(cpu.speed) > 0 ? Number(cpu.speed) : Number(w.MaxClockSpeed) > 0 ? Number(w.MaxClockSpeed) / 1000 : 0;
  return {
    name: name || 'Unknown CPU',
    vendor: vendorOf(name),
    cores,
    threads,
    baseGHz: speedGHz > 0 ? Math.round(speedGHz * 10) / 10 : null,
  };
}

/** The display: systeminformation's list, then Windows' current video mode, then the native mode. */
function displayInfo(displays = [], wmi = null) {
  const list = asArray(displays);
  const main = list.find((d) => d.main) || list[0] || {};
  let x = Number(main.currentResX) || Number(main.resolutionX) || 0;
  let y = Number(main.currentResY) || Number(main.resolutionY) || 0;
  let hz = saneHz(main.currentRefreshRate);

  const modes = asArray(wmi && wmi.gpus)
    .map((g) => {
      let mx = Number(g.CurrentHorizontalResolution) || 0;
      let my = Number(g.CurrentVerticalResolution) || 0;
      let mhz = saneHz(g.CurrentRefreshRate);
      if (!(mx && my) || !mhz) {
        const m = String(g.VideoModeDescription || '').match(/(\d+)\s*x\s*(\d+)\s*x\s*(\d+)/i);
        if (m) {
          if (!(mx && my)) {
            mx = Number(m[1]);
            my = Number(m[2]);
          }
          if (!mhz) mhz = saneHz(Number(m[3]));
        }
      }
      return { x: mx, y: my, hz: mhz };
    })
    .filter((m) => m.x && m.y);

  if (!(x && y) || !hz) {
    // The mode with the most pixels, then the highest refresh rate: the monitor the user actually plays on.
    const best = modes.sort((a, b) => b.x * b.y - a.x * a.y || (b.hz || 0) - (a.hz || 0))[0];
    if (best) {
      if (!(x && y)) {
        x = best.x;
        y = best.y;
      }
      if (!hz) hz = best.hz;
    }
  }
  return { resolution: x && y ? `${x} × ${y}` : null, refreshHz: hz };
}

function ramInfo(modules = [], mem = {}, wmi = null) {
  const siMods = asArray(modules).filter((m) => Number(m.size) > 0);
  const wmiMods = asArray(wmi && wmi.mem).filter((m) => Number(m.Capacity) > 0);
  const speeds = [
    ...siMods.map((m) => Number(m.clockSpeed)),
    ...wmiMods.flatMap((m) => [Number(m.ConfiguredClockSpeed), Number(m.Speed)]),
  ].filter((n) => n > 0);
  const siType = siMods.map((m) => cleanName(m.type)).find((t) => t && !/unknown/i.test(t));
  const wmiType = wmiMods.map((m) => MEM_TYPES[Number(m.SMBIOSMemoryType)]).find(Boolean);
  const bytes =
    Number(mem.total) ||
    siMods.reduce((sum, m) => sum + Number(m.size || 0), 0) ||
    wmiMods.reduce((sum, m) => sum + Number(m.Capacity || 0), 0) ||
    os.totalmem();
  return {
    ramGB: Math.max(0, Math.round(bytes / 1024 ** 3)),
    type: siType || wmiType || null,
    speedMTs: speeds.length ? Math.max(...speeds) : null,
    sticks: siMods.length || wmiMods.length,
  };
}

function osInfoName(info = {}, wmi = null) {
  const caption = cleanName(wmi && wmi.os && wmi.os.Caption).replace(/^Microsoft\s+/i, '');
  let name = caption || cleanName(info.distro).replace(/^Microsoft\s+/i, '') || 'Windows';
  const version = cleanName(wmi && wmi.displayVersion);
  if (version && !new RegExp(`(^|\\s)${version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`, 'i').test(name)) name += ` ${version}`;
  return name;
}

// One PowerShell pass for the whole rig. Registry VRAM is the only reliable 64-bit VRAM source (WMI's
// AdapterRAM wraps at 4 GB), and the Win32_* classes are the same data Task Manager and Device Manager show.
const WMI_SCRIPT = String.raw`
$ErrorActionPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
$reg=@()
foreach($k in @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}')){
  $p=Get-ItemProperty $k.PSPath
  if($p.DriverDesc){
    $v=0
    $q=$p.PSObject.Properties['HardwareInformation.qwMemorySize']
    if($q -and $q.Value){ $v=[int64]$q.Value }
    $reg += [pscustomobject]@{ name=[string]$p.DriverDesc; vram=$v; driver=[string]$p.DriverVersion }
  }
}
$cpu=Get-CimInstance Win32_Processor | Select-Object -First 1 -Property Name,Manufacturer,NumberOfCores,NumberOfLogicalProcessors,MaxClockSpeed
$gpus=@(Get-CimInstance Win32_VideoController | Select-Object -Property Name,DriverVersion,AdapterCompatibility,CurrentHorizontalResolution,CurrentVerticalResolution,CurrentRefreshRate,VideoModeDescription)
$mem=@(Get-CimInstance Win32_PhysicalMemory | Select-Object -Property Capacity,Speed,ConfiguredClockSpeed,SMBIOSMemoryType,DeviceLocator,Manufacturer,PartNumber)
$osi=Get-CimInstance Win32_OperatingSystem | Select-Object -First 1 -Property Caption,Version,BuildNumber
$wv=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
$board=Get-CimInstance Win32_BaseBoard | Select-Object -First 1 -Property Manufacturer,Product
$batt=@(Get-CimInstance Win32_Battery)
[pscustomobject]@{cpu=$cpu;gpus=$gpus;reg=$reg;mem=$mem;os=$osi;displayVersion=[string]$wv.DisplayVersion;board=$board;battery=[int]$batt.Count} | ConvertTo-Json -Compress -Depth 6
`;

let wmiCache = { at: 0, data: null };

async function wmiInfo() {
  if (!IS_WIN || DEMO) return null;
  if (wmiCache.data && Date.now() - wmiCache.at < 5000) return wmiCache.data;
  const r = await ps(WMI_SCRIPT, { timeout: 8000 });
  if (r.code !== 0) return null;
  const text = String(r.stdout || '').replace(/^\uFEFF/, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let data = null;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  wmiCache = { at: Date.now(), data };
  return data;
}

/** NVIDIA's own tool. It is usually in System32, but not always on PATH for an elevated process. */
async function nvidiaSmi(query) {
  const exe = ['nvidia-smi', path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'), 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe'];
  for (const file of [...new Set(exe)]) {
    const r = await run(file, [`--query-gpu=${query}`, '--format=csv,noheader,nounits'], { timeout: 5000 });
    if (r.code === 0 && r.stdout.trim()) return r.stdout.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
  }
  return null;
}

/** Every graphics chip this PC has, best card first. Integrated graphics never beat a dedicated card. */
async function gpuInfo(controllers = [], wmi = null) {
  const regs = asArray(wmi && wmi.reg).filter((r) => r && r.name);
  const byReg = new Map(regs.map((r) => [norm(r.name), r]));
  const found = [];
  for (const c of asArray(controllers)) {
    const name = tidyGpuName(c.model || c.name);
    if (!name || isVirtualGpu(name)) continue;
    found.push({
      name,
      vendor: vendorOf(`${c.vendor || ''} ${name}`),
      vramGB: gbFromMB(c.vram),
      driver: cleanName(c.driverVersion) || null,
      integrated: isIntegratedGpu(name),
    });
  }
  for (const g of asArray(wmi && wmi.gpus)) {
    const name = tidyGpuName(g.Name);
    if (!name || isVirtualGpu(name)) continue;
    const reg = byReg.get(norm(name));
    found.push({
      name,
      vendor: vendorOf(`${g.AdapterCompatibility || ''} ${name}`),
      vramGB: gbFromBytes(reg && reg.vram),
      driver: cleanName(g.DriverVersion) || cleanName(reg && reg.driver) || null,
      integrated: isIntegratedGpu(name),
    });
  }

  // The same card usually appears in both lists: merge instead of showing it twice.
  const merged = new Map();
  for (const g of found) {
    const key = norm(g.name);
    const prev = merged.get(key);
    if (!prev) merged.set(key, g);
    else
      merged.set(key, {
        ...prev,
        vramGB: prev.vramGB || g.vramGB,
        driver: prev.driver || g.driver,
        vendor: prev.vendor === 'other' ? g.vendor : prev.vendor,
        integrated: prev.integrated && g.integrated,
      });
  }
  const list = [...merged.values()];
  // A single card with a registry entry but no matched name still gets its real 64-bit VRAM.
  if (list.length === 1 && !list[0].vramGB) {
    const reg = regs.filter((r) => Number(r.vram) > 0).sort((a, b) => Number(b.vram) - Number(a.vram))[0];
    if (reg) list[0].vramGB = gbFromBytes(reg.vram);
  }

  // NVIDIA's driver reports its marketing driver version and the exact card name. Ask it only when an
  // NVIDIA card exists (or when nothing was detected and it may be the only working source).
  if (!list.length || list.some((g) => g.vendor === 'nvidia')) {
    const smi = await nvidiaSmi('driver_version,name,memory.total');
    const name = smi && tidyGpuName(smi[1]);
    if (name && !isVirtualGpu(name)) {
      const hit = list.find((g) => norm(g.name) === norm(name)) || list.find((g) => g.vendor === 'nvidia');
      const vramGB = Number(smi[2]) > 0 ? Math.round(Number(smi[2]) / 1024) : null;
      if (hit) {
        hit.name = name;
        hit.driver = cleanName(smi[0]) || hit.driver;
        hit.vramGB = vramGB || hit.vramGB;
        hit.vendor = 'nvidia';
        hit.integrated = false;
      } else {
        list.push({ name, vendor: 'nvidia', vramGB, driver: cleanName(smi[0]) || null, integrated: false });
      }
    }
  }

  // Dedicated card first, then a card over processor graphics, then the most video memory.
  const score = (g) => (g.integrated ? 0 : 1e6) + (g.vendor === 'nvidia' || g.vendor === 'amd' ? 1e4 : g.vendor === 'intel' ? 1e3 : 0) + (g.vramGB || 0);
  list.sort((a, b) => score(b) - score(a));
  return list.map(({ integrated, ...g }) => g);
}

const DEMO_RIG = {
  cpu: { name: 'AMD Ryzen 7 7800X3D', vendor: 'amd', cores: 8, threads: 16, baseGHz: 4.2 },
  gpu: { name: 'AMD Radeon RX 7900 XT', vendor: 'amd', vramGB: 20, driver: '25.9.1' },
  otherGpus: [],
  ramGB: 32,
  ram: { type: 'DDR5', speedMTs: 4800, sticks: 2 },
  display: { resolution: '2560 × 1440', refreshHz: 165 },
  os: 'Windows 11 Pro 25H2',
  board: { manufacturer: 'ASUSTeK COMPUTER INC.', model: 'ROG STRIX B650E-F GAMING WIFI' },
  laptop: false,
  vendorApp: { name: VENDOR_APPS.amd.name, installed: true, path: null, download: VENDOR_APPS.amd.download },
  source: 'auto',
};

const NO_GPU = () => ({ name: 'No graphics card found', vendor: 'other', vramGB: null, driver: null });

function unknownRig() {
  const ramGB = Math.max(0, Math.round(os.totalmem() / 1024 ** 3));
  return {
    cpu: { name: 'Unknown CPU', vendor: 'other', cores: null, threads: null, baseGHz: null },
    gpu: NO_GPU(),
    otherGpus: [],
    ramGB,
    ram: { type: null, speedMTs: null, sticks: 0 },
    display: { resolution: null, refreshHz: null },
    os: 'Windows',
    board: { manufacturer: null, model: null },
    laptop: false,
    source: 'auto',
  };
}

/** systeminformation's own PowerShell calls run one at a time, so this is the slower fallback path. */
async function readSi() {
  const [cpu, gfx, mem, battery, sticks, osInfo, board] = await Promise.all([
    withTimeout(si.cpu(), 5000, {}),
    withTimeout(si.graphics(), 7000, {}),
    withTimeout(si.mem(), 4000, {}),
    withTimeout(si.battery(), 3000, { hasBattery: false }),
    withTimeout(si.memLayout(), 5000, []),
    withTimeout(si.osInfo(), 4000, {}),
    withTimeout(si.baseboard(), 4000, {}),
  ]);
  return { cpu, gfx, mem, battery, sticks, osInfo, board };
}

async function detect() {
  // Windows' WMI answers the whole rig in one short pass — the same data Task Manager shows — including
  // 64-bit VRAM and the current display mode. It is the primary source; systeminformation is only started
  // when WMI is broken or a class is empty, because its serialized PowerShell calls can take ten seconds.
  const wmi = IS_WIN ? await withTimeout(wmiInfo(), 8000, null) : null;
  const wmiGpus = asArray(wmi && wmi.gpus);
  const wmiNames = wmiGpus.map((g) => tidyGpuName(g.Name)).filter((n) => n && !isVirtualGpu(n));
  const wmiModes = wmiGpus.some(
    (g) =>
      (Number(g.CurrentHorizontalResolution) && Number(g.CurrentVerticalResolution)) ||
      /hertz/i.test(String(g.VideoModeDescription || ''))
  );
  const wmiEnough = !!(wmi && wmi.cpu && wmiNames.length && wmiModes && asArray(wmi.mem).length && wmi.os && wmi.os.Caption);
  const s = wmiEnough ? null : await readSi();

  const cpu = (s && s.cpu) || {};
  const gfx = (s && s.gfx) || {};
  const mem = (s && s.mem) || {};
  const battery = (s && s.battery) || { hasBattery: false };
  const modules = asArray(s && s.sticks);
  const osData = (s && s.osInfo) || {};
  const board = (s && s.board) || {};
  const controllers = asArray(gfx.controllers);
  const displays = asArray(gfx.displays);

  const cpuOut = cpuInfo(cpu, wmi);
  const gpus = await gpuInfo(controllers, wmi);
  const ram = ramInfo(modules, mem, wmi);
  const display = displayInfo(displays, wmi);
  const boardInfo = board || {};
  const wmiBoard = (wmi && wmi.board) || {};
  const laptop = !!(battery && battery.hasBattery) || Number(wmi && wmi.battery) > 0;

  return {
    cpu: cpuOut,
    gpu: gpus[0] || NO_GPU(),
    otherGpus: gpus.slice(1),
    ramGB: ram.ramGB,
    ram: { type: ram.type, speedMTs: ram.speedMTs, sticks: ram.sticks },
    display,
    os: osInfoName(osData, wmi),
    board: {
      manufacturer: cleanName(boardInfo.manufacturer) || cleanName(wmiBoard.Manufacturer) || null,
      model: cleanName(boardInfo.model) || cleanName(wmiBoard.Product) || null,
    },
    laptop,
    source: 'auto',
  };
}

async function scan(manual) {
  let rig;
  if (DEMO) {
    rig = JSON.parse(JSON.stringify(DEMO_RIG));
  } else {
    // Never let one broken sensor library leave "Your rig" empty for the rest of the session.
    rig = await detect().catch(() => unknownRig());
  }

  // The user can override what was detected.
  if (manual && (manual.cpu || manual.gpu)) {
    if (manual.cpu) rig.cpu = { ...rig.cpu, name: cleanName(manual.cpu) || rig.cpu.name, vendor: vendorOf(manual.cpu) };
    if (manual.gpu) rig.gpu = { ...rig.gpu, name: cleanName(manual.gpu) || rig.gpu.name, vendor: manual.gpuVendor || vendorOf(manual.gpu) };
    else if (manual.gpuVendor) rig.gpu = { ...rig.gpu, vendor: manual.gpuVendor };
    rig.source = 'manual';
  }

  const v = rig.gpu.vendor;
  if (VENDOR_APPS[v]) {
    const p = DEMO ? null : findVendorApp(v);
    rig.vendorApp = {
      name: VENDOR_APPS[v].name,
      installed: DEMO ? process.env.FRAMEFORGE_DEMO_NO_VENDOR !== '1' : !!p,
      path: p,
      download: VENDOR_APPS[v].download,
    };
  } else {
    rig.vendorApp = null;
  }
  rig.gpu.vendorName = VENDOR_NAMES[v] || 'Unknown';
  return rig;
}

module.exports = { scan, vendorOf, findVendorApp, nvidiaSmi, wmiInfo, VENDOR_APPS, tidyCpuName, isIntegratedGpu, displayInfo, ramInfo, osInfoName, cpuInfo, gpuInfo };
