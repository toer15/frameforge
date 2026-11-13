const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { pickSensors, flattenLhmJson, _LHM_LOOP } = require('../src/sensors');

const s = (Name, SensorType, Value, Identifier) => ({ Name, SensorType, Value, Identifier });

// What LibreHardwareMonitor lists for a Radeon card next to a Ryzen with built-in graphics.
const AMD = [
  s('GPU Core', 'Temperature', 77, '/gpu-amd/0/temperature/0'),
  s('GPU Hot Spot', 'Temperature', 91, '/gpu-amd/0/temperature/1'),
  s('GPU Core', 'Load', 51, '/gpu-amd/0/load/0'),
  s('GPU Core', 'Power', 141, '/gpu-amd/0/power/0'),
  s('GPU Package', 'Power', 172.4, '/gpu-amd/0/power/3'),
  s('GPU Fan', 'Fan', 2415, '/gpu-amd/0/fan/0'),
  s('GPU Core', 'Clock', 1375, '/gpu-amd/0/clock/0'),
  s('GPU Memory', 'Clock', 800, '/gpu-amd/0/clock/1'),
  s('GPU Memory Used', 'SmallData', 4403, '/gpu-amd/0/smalldata/0'),
  s('GPU Memory Total', 'SmallData', 8176, '/gpu-amd/0/smalldata/1'),
  s('D3D Dedicated Memory Used', 'SmallData', 4380, '/gpu-amd/0/smalldata/2'),
  s('GPU Core', 'Temperature', 48, '/gpu-amd-integrated/0/temperature/0'),
  s('GPU Core', 'Load', 3, '/gpu-amd-integrated/0/load/0'),
  s('GPU Memory Total', 'SmallData', 512, '/gpu-amd-integrated/0/smalldata/1'),
  s('Core (Tctl/Tdie)', 'Temperature', 61.5, '/amdcpu/0/temperature/2'),
  s('CPU Total', 'Load', 18.2, '/amdcpu/0/load/0'),
  s('Package', 'Power', 64.6, '/amdcpu/0/power/0'),
];

test('AMD card: power, fan, clocks and video memory come from the main graphics card', () => {
  assert.deepEqual(pickSensors(AMD), {
    gpuPower: 172, gpuFan: 2415, gpuClock: 1375, gpuMemClock: 800, vramUsed: 4403, vramTotal: 8176, cpuPower: 65,
    cpuTemp: 62, gpuTemp: 77, cpuLoad: 18, gpuLoad: 51,
  });
});

test('NVIDIA card with stopped fans, and a PC that reports none of the extras', () => {
  const nv = pickSensors([
    s('GPU Core', 'Temperature', 44, '/gpu-nvidia/0/temperature/0'),
    s('GPU Core', 'Load', 2, '/gpu-nvidia/0/load/0'),
    s('GPU Package', 'Power', 31.7, '/gpu-nvidia/0/power/0'),
    s('GPU Fan 1', 'Fan', 0, '/gpu-nvidia/0/fan/1'),
    s('GPU Fan 2', 'Fan', 0, '/gpu-nvidia/0/fan/2'),
    s('GPU Core', 'Clock', 210, '/gpu-nvidia/0/clock/0'),
    s('GPU Memory', 'Clock', 405, '/gpu-nvidia/0/clock/1'),
    s('GPU Memory Total', 'SmallData', 12282, '/gpu-nvidia/0/smalldata/0'),
    s('GPU Memory Used', 'SmallData', 1410, '/gpu-nvidia/0/smalldata/2'),
    s('CPU Package', 'Temperature', 39, '/intelcpu/0/temperature/0'),
    s('CPU Total', 'Load', 4, '/intelcpu/0/load/0'),
    s('CPU Package', 'Power', 18.4, '/intelcpu/0/power/0'),
    s('CPU Cores', 'Power', 9, '/intelcpu/0/power/1'),
  ]);
  assert.equal(nv.gpuFan, 0, 'fans standing still is a real reading');
  assert.equal(nv.gpuPower, 32);
  assert.equal(nv.cpuPower, 18);
  assert.equal(nv.vramUsed, 1410);
  assert.equal(nv.gpuTemp, 44);

  const bare = pickSensors([s('CPU Total', 'Load', 82, '/intelcpu/0/load/0'), s('D3D 3D', 'Load', 12, '/gpu-intel-integrated/0/load/0')]);
  for (const k of ['gpuPower', 'gpuFan', 'gpuClock', 'gpuMemClock', 'vramUsed', 'vramTotal', 'cpuPower', 'cpuTemp', 'gpuTemp']) assert.equal(bare[k], null, `${k} is not invented`);
  assert.equal(bare.cpuLoad, 82);
  assert.equal(bare.gpuLoad, 12);
  // Another card's or the motherboard's sensors never leak into the main card's numbers.
  const other = pickSensors([...AMD.filter((x) => x.SensorType !== 'Fan'), s('Fan #2', 'Fan', 900, '/lpc/nct6798d/fan/1'), s('GPU Fan', 'Fan', 600, '/gpu-amd-integrated/0/fan/0')]);
  assert.equal(other.gpuFan, null);
});

test('the web-server form of the same data gives the same readings', () => {
  const node = (Text, Type, Value, SensorId, Children = []) => ({ Text, Type, Value, SensorId, Children });
  const tree = { Children: [{ Text: 'PC', Children: [
    node('GPU Core', 'Temperature', '77,0 °C', '/gpu-amd/0/temperature/0'),
    node('GPU Core', 'Load', '51,0 %', '/gpu-amd/0/load/0'),
    node('GPU Package', 'Power', '172,4 W', '/gpu-amd/0/power/3'),
    node('GPU Fan', 'Fan', '2415 RPM', '/gpu-amd/0/fan/0'),
    node('GPU Core', 'Clock', '1375,0 MHz', '/gpu-amd/0/clock/0'),
    node('GPU Memory Used', 'SmallData', '4403,0 MB', '/gpu-amd/0/smalldata/0'),
    node('GPU Memory Total', 'SmallData', '8176,0 MB', '/gpu-amd/0/smalldata/1'),
    node('Core #1', 'Clock', '4650,0 MHz', '/amdcpu/0/clock/1'),
    node('Fan #1', 'Fan', '900 RPM', '/lpc/nct6798d/fan/0'),
    node('Vcore', 'Voltage', '1,2 V', '/lpc/nct6798d/voltage/0'),
  ] }] };
  const flat = flattenLhmJson(tree);
  assert.deepEqual(flat.map((x) => x.Name + ':' + x.SensorType), ['GPU Core:Temperature', 'GPU Core:Load', 'GPU Package:Power', 'GPU Fan:Fan', 'GPU Core:Clock', 'GPU Memory Used:SmallData', 'GPU Memory Total:SmallData']);
  const p = pickSensors(flat);
  assert.deepEqual([p.gpuTemp, p.gpuLoad, p.gpuPower, p.gpuFan, p.gpuClock, p.vramUsed, p.vramTotal], [77, 51, 172, 2415, 1375, 4403, 8176]);
});

// The sensor helper is a PowerShell script that loops forever; a typo in it would silently stop every reading.
test('real Windows: the sensor helper script has no syntax errors in Windows PowerShell', { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
  const out = await new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput($env:FF_SCRIPT, [ref]$null, [ref]$e); "errors=" + $e.Count; $e | ForEach-Object { $_.Message }'],
    { env: { ...process.env, FF_SCRIPT: _LHM_LOOP }, windowsHide: true }, (_err, stdout, stderr) => resolve(String(stdout) + String(stderr))));
  assert.match(out, /errors=0/, out);
});
