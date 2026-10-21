// Detects the CPU, graphics card, RAM, display and drivers.
const si = require('systeminformation');
const fs = require('fs');
const { run, IS_WIN, DEMO } = require('./util');

function vendorOf(text = '') {
  const t = text.toLowerCase();
  if (t.includes('nvidia') || t.includes('geforce') || t.includes('rtx') || t.includes('gtx')) return 'nvidia';
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

async function nvidiaSmi(query) {
  const r = await run('nvidia-smi', [`--query-gpu=${query}`, '--format=csv,noheader,nounits'], { timeout: 5000 });
  if (r.code !== 0) return null;
  return r.stdout.trim().split(/\r?\n/)[0].split(',').map((s) => s.trim());
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

async function scan(manual) {
  let rig;
  if (DEMO) {
    rig = JSON.parse(JSON.stringify(DEMO_RIG));
  } else {
    const [cpu, gfx, mem, os, battery, sticks, board] = await Promise.all([
      si.cpu(),
      si.graphics(),
      si.mem(),
      si.osInfo(),
      si.battery().catch(() => ({ hasBattery: false })),
      si.memLayout().catch(() => []),
      si.baseboard().catch(() => ({})),
    ]);
    const stick = (sticks || []).find((m) => m.size > 0) || {};

    const gpus = (gfx.controllers || [])
      .filter((c) => c.model && !/basic display|remote|virtual|parsec|meta virtual/i.test(c.model))
      .map((c) => {
        const vendor = vendorOf(`${c.vendor} ${c.model}`);
        return {
          name: c.model,
          vendor,
          vramGB: c.vram ? Math.round(c.vram / 1024) : null,
          driver: c.driverVersion || null,
        };
      });

    // Prefer a dedicated NVIDIA/AMD card, then the one with the most VRAM.
    gpus.sort((a, b) => {
      const score = (g) => (g.vendor === 'nvidia' || g.vendor === 'amd' ? 1000 : 0) + (g.vramGB || 0);
      return score(b) - score(a);
    });
    const gpu = gpus[0] || { name: 'No graphics card found', vendor: 'other', vramGB: null, driver: null };

    if (gpu.vendor === 'nvidia') {
      const smi = await nvidiaSmi('driver_version,name,memory.total');
      if (smi) {
        gpu.driver = smi[0];
        if (smi[1]) gpu.name = smi[1];
        if (smi[2]) gpu.vramGB = Math.round(Number(smi[2]) / 1024);
      }
    }

    const disp = (gfx.displays || []).find((d) => d.main) || (gfx.displays || [])[0] || {};
    const cpuName = `${cpu.manufacturer || ''} ${cpu.brand || ''}`.replace(/\s+/g, ' ').trim();

    rig = {
      cpu: {
        name: cpuName || 'Unknown CPU',
        vendor: vendorOf(cpuName),
        cores: cpu.physicalCores || null,
        threads: cpu.cores || null,
        baseGHz: cpu.speed || null,
      },
      gpu,
      otherGpus: gpus.slice(1),
      ramGB: Math.round((mem.total || 0) / 1024 ** 3),
      ram: { type: stick.type || null, speedMTs: stick.clockSpeed || null, sticks: (sticks || []).filter((m) => m.size > 0).length },
      display: {
        resolution: disp.currentResX ? `${disp.currentResX} × ${disp.currentResY}` : null,
        refreshHz: disp.currentRefreshRate || null,
      },
      os: `${os.distro || 'Windows'} ${os.release || ''}`.trim(),
      laptop: !!battery.hasBattery,
      board: { manufacturer: (board && board.manufacturer) || null, model: (board && board.model) || null },
      source: 'auto',
    };
  }

  // The user can override what was detected.
  if (manual && (manual.cpu || manual.gpu)) {
    if (manual.cpu) rig.cpu = { ...rig.cpu, name: manual.cpu, vendor: vendorOf(manual.cpu) };
    if (manual.gpu) rig.gpu = { ...rig.gpu, name: manual.gpu, vendor: manual.gpuVendor || vendorOf(manual.gpu) };
    else if (manual.gpuVendor) rig.gpu = { ...rig.gpu, vendor: manual.gpuVendor };
    rig.source = 'manual';
  }

  const v = rig.gpu.vendor;
  if (VENDOR_APPS[v]) {
    const p = DEMO ? null : findVendorApp(v);
    rig.vendorApp = {
      name: VENDOR_APPS[v].name,
      installed: DEMO ? true : !!p,
      path: p,
      download: VENDOR_APPS[v].download,
    };
  } else {
    rig.vendorApp = null;
  }
  rig.gpu.vendorName = VENDOR_NAMES[v] || 'Unknown';
  return rig;
}

module.exports = { scan, vendorOf, findVendorApp, nvidiaSmi, VENDOR_APPS };
