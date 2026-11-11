const { test } = require('node:test');
const assert = require('node:assert/strict');
const { plan, gpuFamily, isHybridIntel } = require('../src/frameplan');

const rig = (gpu, vendor, extra = {}) => ({
  gpu: { name: gpu, vendor },
  cpu: { name: 'AMD Ryzen 5 5600', vendor: 'amd', cores: 6, threads: 12 },
  ram: { type: 'DDR4', speedMTs: 3600, sticks: 2 },
  display: { resolution: '2560 × 1440', refreshHz: 144 },
  vendorApp: { name: vendor === 'amd' ? 'AMD Software: Adrenalin Edition' : 'NVIDIA app' },
  ...extra,
});
const ids = (r, state) => plan(r, state).map((i) => i.id);
const item = (r, id) => plan(r).find((i) => i.id === id);

test('graphics card families', () => {
  assert.equal(gpuFamily({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5070 Ti' }), 'rtx50');
  assert.equal(gpuFamily({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4060 Laptop GPU' }), 'rtx40');
  assert.equal(gpuFamily({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060' }), 'rtx');
  assert.equal(gpuFamily({ vendor: 'nvidia', name: 'NVIDIA GeForce GTX 1660 SUPER' }), 'nvidia-old');
  assert.equal(gpuFamily({ vendor: 'amd', name: 'AMD Radeon RX 9070 XT' }), 'rx9000');
  assert.equal(gpuFamily({ vendor: 'amd', name: 'AMD Radeon RX 7900 XT' }), 'rx7000');
  assert.equal(gpuFamily({ vendor: 'amd', name: 'AMD Radeon RX 6600' }), 'rx6000');
  assert.equal(gpuFamily({ vendor: 'amd', name: 'Radeon RX 580 Series' }), 'amd-old');
  assert.equal(gpuFamily({ vendor: 'amd', name: 'AMD Radeon 780M Graphics' }), 'radeon-igpu');
  assert.equal(gpuFamily({ vendor: 'intel', name: 'Intel(R) Arc(TM) B580 Graphics' }), 'arc');
  assert.equal(gpuFamily({ vendor: 'intel', name: 'Intel(R) UHD Graphics 770' }), 'intel-igpu');
});

test('Intel processors with two kinds of cores', () => {
  assert.equal(isHybridIntel({ vendor: 'intel', name: 'Intel(R) Core(TM) i5-13600K', cores: 14, threads: 20 }), true);
  assert.equal(isHybridIntel({ vendor: 'intel', name: 'Intel(R) Core(TM) Ultra 7 265K', cores: 20, threads: 20 }), true);
  assert.equal(isHybridIntel({ vendor: 'intel', name: 'Intel(R) Core(TM) i5-12400F', cores: 6, threads: 12 }), false);
  assert.equal(isHybridIntel({ vendor: 'intel', name: 'Intel(R) Core(TM) i7-9700K', cores: 8, threads: 8 }), false);
  assert.equal(isHybridIntel({ vendor: 'amd', name: 'AMD Ryzen 7 7800X3D', cores: 8, threads: 16 }), false);
});

test('each card only gets features it really has', () => {
  assert.match(item(rig('NVIDIA GeForce RTX 4070', 'nvidia'), 'framegen').title, /Smooth Motion/);
  assert.match(item(rig('NVIDIA GeForce RTX 5080', 'nvidia'), 'framegen').title, /Smooth Motion/);
  assert.doesNotMatch(item(rig('NVIDIA GeForce RTX 3070', 'nvidia'), 'framegen').title, /Smooth Motion/);
  assert.equal(item(rig('NVIDIA GeForce RTX 3070', 'nvidia'), 'framegen').action, undefined, 'nothing to open: it is in each game');
  assert.match(item(rig('NVIDIA GeForce RTX 3070', 'nvidia'), 'upscale').title, /DLSS/);
  assert.doesNotMatch(item(rig('NVIDIA GeForce GTX 1060 6GB', 'nvidia'), 'upscale').title, /DLSS/);
  assert.match(item(rig('AMD Radeon RX 7900 XT', 'amd'), 'framegen').title, /Fluid Motion Frames 2/);
  assert.match(item(rig('AMD Radeon RX 6600', 'amd'), 'framegen').body, /exclusive fullscreen/);
  assert.doesNotMatch(item(rig('Radeon RX 580 Series', 'amd'), 'framegen').title, /Fluid Motion/);
  assert.match(item(rig('AMD Radeon RX 9070 XT', 'amd'), 'upscale').title, /FSR 4/);
  assert.match(item(rig('Intel(R) Arc(TM) B580 Graphics', 'intel'), 'upscale').title, /XeSS/);
  assert.ok(ids(rig('Intel(R) Arc(TM) B580 Graphics', 'intel')).includes('rebar'));
  assert.ok(!ids(rig('NVIDIA GeForce RTX 4070', 'nvidia')).includes('rebar'));
});

test('the rest follows the PC: RAM, cores, screen, and what is already on', () => {
  const base = rig('NVIDIA GeForce RTX 4070', 'nvidia');
  assert.deepEqual(ids(base), ['framegen', 'upscale', 'booster', 'cap']);
  assert.match(item(base, 'cap').title, /141 FPS/);
  assert.deepEqual(ids(base, { on: { game_priority_boost: { active: true } } }), ['framegen', 'upscale', 'cap']);
  assert.ok(!ids({ ...base, display: { resolution: '1920 × 1080', refreshHz: 60 } }).includes('cap'));
  assert.match(item({ ...base, display: { resolution: '1920 × 1080', refreshHz: 60 } }, 'upscale').gain, /20–40%/);
  const slow = { ...base, ram: { type: 'DDR5', speedMTs: 4800, sticks: 1 }, cpu: { name: 'Intel(R) Core(TM) i7-14700K', vendor: 'intel', cores: 20, threads: 28 } };
  assert.deepEqual(ids(slow), ['framegen', 'upscale', 'ram_speed', 'single_stick', 'hybrid_pcores', 'booster', 'cap']);
  assert.match(item(slow, 'ram_speed').where, /XMP/);
  assert.deepEqual(item(slow, 'hybrid_pcores').action, { type: 'tweak', id: 'hybrid_pcores', label: 'Turn it on' });
  assert.ok(!ids(slow, { on: { hybrid_pcores: {} } }).includes('hybrid_pcores'));
  assert.deepEqual(plan(null), []);
  for (const i of plan(slow)) assert.ok(i.gain && i.title && i.body, `${i.id} is complete`);
});
