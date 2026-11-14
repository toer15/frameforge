const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('../src/hardware');

test('CPU and GPU names are cleaned, and the model survives', () => {
  assert.equal(H.tidyCpuName('AMD Ryzen 7 7800X3D 8-Core Processor'), 'AMD Ryzen 7 7800X3D');
  assert.equal(H.tidyCpuName('Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz'), 'Intel Core i7-9700K');
  assert.equal(H.tidyCpuName('12th Gen Intel(R) Core(TM) i5-12400'), '12th Gen Intel Core i5-12400');
  assert.equal(H.tidyCpuName('GenuineIntel Intel(R) Core(TM) Ultra 7 155H'), 'Intel Core Ultra 7 155H');
  assert.equal(H.tidyCpuName(''), '');
});

test('a dedicated card is never beaten by processor graphics', async () => {
  const list = await H.gpuInfo(
    [
      { model: 'AMD Radeon(TM) Graphics', vendor: 'Advanced Micro Devices, Inc.', vram: 512, driverVersion: '31.0.1' },
      { model: 'AMD Radeon RX 7800 XT', vendor: 'Advanced Micro Devices, Inc.', vram: 16384, driverVersion: '31.0.2' },
    ],
    null
  );
  assert.equal(list[0].name, 'AMD Radeon RX 7800 XT');
  assert.equal(list[0].vramGB, 16);
  assert.equal(list[1].name, 'AMD Radeon Graphics');
});

test('Intel Arc cards count as dedicated; Iris/UHD and Intel Arc Graphics count as integrated', async () => {
  assert.equal(H.isIntegratedGpu('Intel(R) Iris(R) Xe Graphics'), true);
  assert.equal(H.isIntegratedGpu('Intel(R) UHD Graphics 630'), true);
  assert.equal(H.isIntegratedGpu('Intel(R) Arc(TM) Graphics'), true);
  assert.equal(H.isIntegratedGpu('Intel(R) Arc(TM) A770 Graphics'), false);
  assert.equal(H.isIntegratedGpu('Intel(R) Arc(TM) B580 Graphics'), false);
  assert.equal(H.isIntegratedGpu('AMD Radeon 780M'), true);
  assert.equal(H.isIntegratedGpu('AMD Radeon RX 7900 XT'), false);
  const list = await H.gpuInfo(
    [
      { model: 'Intel(R) Iris(R) Xe Graphics', vendor: 'Intel Corporation', vram: 1024 },
      { model: 'Intel(R) Arc(TM) A750 Graphics', vendor: 'Intel Corporation', vram: 8192 },
    ],
    null
  );
  assert.equal(list[0].name, 'Intel Arc A750 Graphics');
});

test('the same card from systeminformation and WMI is merged, with 64-bit VRAM filled in', async () => {
  const list = await H.gpuInfo(
    [{ model: 'AMD Radeon RX 7900 XT', vendor: 'Advanced Micro Devices, Inc.', vram: null, driverVersion: '31.0.1' }],
    {
      gpus: [{ Name: 'AMD Radeon RX 7900 XT', AdapterCompatibility: 'Advanced Micro Devices, Inc.', DriverVersion: '31.0.1' }],
      reg: [{ name: 'AMD Radeon RX 7900 XT', vram: 21474836480, driver: '31.0.1' }],
    }
  );
  assert.equal(list.length, 1);
  assert.equal(list[0].vramGB, 20);
});

test('the display comes from Windows when systeminformation sees no monitor', () => {
  const d = H.displayInfo([], {
    gpus: [
      { CurrentHorizontalResolution: 1920, CurrentVerticalResolution: 1080, CurrentRefreshRate: 60 },
      { CurrentHorizontalResolution: 2560, CurrentVerticalResolution: 1440, CurrentRefreshRate: 165 },
    ],
  });
  assert.equal(d.resolution, '2560 × 1440');
  assert.equal(d.refreshHz, 165);
  // No display list and no WMI: the native mode is better than "Unknown".
  const native = H.displayInfo([{ resolutionX: 1920, resolutionY: 1080, currentRefreshRate: -1 }], null);
  assert.equal(native.resolution, '1920 × 1080');
  assert.equal(native.refreshHz, null);
  const mode = H.displayInfo([], { gpus: [{ VideoModeDescription: '1920 x 1080 x 144 hertz' }] });
  assert.equal(mode.resolution, '1920 × 1080');
  assert.equal(mode.refreshHz, 144);
});

test('RAM modules, type and speed fall back to Windows', () => {
  const ram = H.ramInfo([], {}, {
    mem: [{ Capacity: 8589934592, ConfiguredClockSpeed: 6000, SMBIOSMemoryType: 34 }],
  });
  assert.equal(ram.ramGB, 8);
  assert.equal(ram.type, 'DDR5');
  assert.equal(ram.speedMTs, 6000);
  assert.equal(ram.sticks, 1);
});

test('CPU detection deduplicates the vendor and uses WMI when systeminformation is empty', () => {
  const amd = H.cpuInfo({ manufacturer: 'AMD', brand: 'Ryzen 7 7800X3D 8-Core Processor', physicalCores: 8, cores: 16, speed: 4.2 });
  assert.equal(amd.name, 'AMD Ryzen 7 7800X3D');
  assert.equal(amd.vendor, 'amd');
  assert.deepEqual([amd.cores, amd.threads, amd.baseGHz], [8, 16, 4.2]);
  const intel = H.cpuInfo({}, { cpu: { Name: 'Intel(R) Core(TM) i7-13700K', NumberOfCores: 16, NumberOfLogicalProcessors: 24, MaxClockSpeed: 3400 } });
  assert.equal(intel.name, 'Intel Core i7-13700K');
  assert.equal(intel.vendor, 'intel');
  assert.deepEqual([intel.cores, intel.threads, intel.baseGHz], [16, 24, 3.4]);
});

test('the Windows name is shown with its release, without a duplicate build number', () => {
  assert.equal(H.osInfoName({ distro: 'Windows 11 Pro' }, { os: { Caption: 'Microsoft Windows 11 Pro' }, displayVersion: '24H2' }), 'Windows 11 Pro 24H2');
  assert.equal(H.osInfoName({ distro: 'Windows 11 Pro' }, null), 'Windows 11 Pro');
  assert.equal(H.osInfoName({ distro: 'Windows 10 Home 24H2' }, { displayVersion: '24H2' }), 'Windows 10 Home 24H2');
});
