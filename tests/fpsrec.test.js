const { test } = require('node:test');
const assert = require('node:assert/strict');
const { recommend, gpuClass } = require('../src/fpsrec');

const rig = (gpu, refreshHz) => ({ gpu: { name: gpu }, display: { refreshHz } });

test('recommendations follow both the display and the graphics card', () => {
  assert.equal(recommend(rig('AMD Radeon RX 7900 XT', 165)).fps, 162);
  assert.equal(recommend(rig('NVIDIA GeForce RTX 4060', 165)).fps, 141);
  assert.equal(recommend(rig('NVIDIA GeForce GTX 1650', 165)).fps, 75);
  assert.equal(recommend(rig('Intel UHD Graphics 770', 165)).fps, 60);
  assert.equal(recommend(rig('NVIDIA GeForce RTX 4090', 60)).fps, 60);
  assert.equal(recommend(rig('AMD Radeon RX 7600', 75)).fps, 75);
});

test('unknown hardware follows the display instead of assuming 60 FPS', () => {
  const noGpu = recommend({ gpu: { name: '' }, display: { refreshHz: 144 } });
  assert.equal(noGpu.fps, 141);
  assert.match(noGpu.reason, /couldn’t identify/);
  assert.match(noGpu.reason, /144 Hz/);
  assert.equal(recommend({ gpu: { name: '' }, display: { refreshHz: 165 } }).fps, 162);
  const noDisplay = recommend(rig('NVIDIA GeForce RTX 4080', null));
  assert.equal(noDisplay.fps, 60);
  assert.match(noDisplay.reason, /refresh rate/);
});

test('common cards that the first classifier missed get their own target', () => {
  assert.equal(recommend(rig('NVIDIA GeForce RTX 3050', 165)).fps, 75);
  assert.equal(recommend(rig('NVIDIA GeForce RTX 2060', 165)).fps, 141);
  assert.equal(recommend(rig('AMD Radeon RX 5700 XT', 144)).fps, 141);
  assert.equal(recommend(rig('AMD Radeon RX 6700', 165)).fps, 141);
});

test('graphics cards are sorted into useful performance classes', () => {
  assert.equal(gpuClass('NVIDIA GeForce RTX 5090'), 'high');
  assert.equal(gpuClass('AMD Radeon RX 9070 XT'), 'high');
  assert.equal(gpuClass('NVIDIA GeForce RTX 4060'), 'mid');
  assert.equal(gpuClass('NVIDIA GeForce RTX 2060'), 'mid');
  assert.equal(gpuClass('AMD Radeon RX 5700 XT'), 'mid');
  assert.equal(gpuClass('AMD Radeon RX 6700'), 'mid');
  assert.equal(gpuClass('Intel Arc B580'), 'mid');
  assert.equal(gpuClass('NVIDIA GeForce RTX 3050'), 'low');
  assert.equal(gpuClass('NVIDIA GeForce GTX 1060'), 'low');
  assert.equal(gpuClass('AMD Radeon Graphics'), 'integrated');
  assert.equal(gpuClass('No graphics card found'), 'unknown');
});

test('the reason names the hardware and the recommended number', () => {
  const r = recommend(rig('NVIDIA GeForce RTX 4070', 144));
  assert.equal(r.fps, 141);
  assert.match(r.reason, /RTX 4070/);
  assert.match(r.reason, /144 Hz/);
  assert.match(r.reason, /141 FPS/);
  assert.equal(r.refreshHz, 144);
});
