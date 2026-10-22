const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load renderer/controller.js with just enough of a page around it.
function load() {
  const el = () => ({ addEventListener() {}, classList: { toggle() {} }, set onclick(_) {}, style: {}, textContent: '', innerHTML: '' });
  const ctx = {
    $: el, $$: () => [], esc: (s) => String(s), S: { controllerType: 'auto' }, ff: {},
    navigator: {}, window: { addEventListener() {} }, performance: { now: () => 1e9 },
    requestAnimationFrame() {}, cancelAnimationFrame() {}, setInterval() {}, clearInterval() {},
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/controller.js'), 'utf8') + '\nthis.PADX = PADX;', ctx);
  return ctx.PADX;
}

test('DualSense USB and Bluetooth reports: buttons, triggers, sticks, touchpad and motion', () => {
  const P = load();
  for (const o of [0, 1]) {
    const b = new DataView(new ArrayBuffer(64 + o));
    b.setUint8(o + 0, 255); b.setUint8(o + 1, 0); b.setUint8(o + 2, 128); b.setUint8(o + 3, 128);
    b.setUint8(o + 4, 255); b.setUint8(o + 5, 51);
    b.setUint8(o + 7, 0x20 | 2); // cross + D-pad right
    b.setUint8(o + 8, 0x01 | 0x20); // L1 + Options
    b.setUint8(o + 9, 0x01 | 0x40); // PS + Edge back paddle left
    b.setInt16(o + 15, 1638, true); // ~100 °/s
    b.setInt16(o + 23, 8192, true); // 1 g up
    b.setUint8(o + 32, 0x80); // finger 0 lifted
    b.setUint8(o + 36, 0x01); b.setUint8(o + 37, 0xc0); b.setUint8(o + 38, 0x03); b.setUint8(o + 39, 0x22); // finger 1 at 960,544
    const st = P.newState('dualsense-edge');
    const [smp] = P.parseDualSense(st, b, o);
    assert.equal(st.axes.lx, 1);
    assert.equal(Math.round(st.axes.ly), -1);
    assert.equal(st.buttons.lt, 1);
    assert.equal(st.buttons.rt, 0.2);
    assert.deepEqual([st.buttons.s, st.buttons.right, st.buttons.up, st.buttons.lb, st.buttons.start, st.buttons.guide, st.buttons.pl], [1, 1, 0, 1, 1, 1, 1]);
    assert.equal(Math.round(smp.gyro[0]), 100);
    assert.equal(smp.acc[1], 1);
    assert.equal(st.touch[0], null);
    assert.equal(Math.round(st.touch[1].x * 1920), 960);
    assert.equal(Math.round(st.touch[1].y * 1080), 544);
  }
});

test('DualShock 4 reports (USB and Bluetooth offsets)', () => {
  const P = load();
  for (const o of [0, 2]) {
    const b = new DataView(new ArrayBuffer(64 + o));
    for (let i = 0; i < 4; i++) b.setUint8(o + i, 128);
    b.setUint8(o + 4, 0x80 | 8); // triangle, D-pad released
    b.setUint8(o + 5, 0x10); // Share
    b.setUint8(o + 7, 128);
    b.setInt16(o + 18 + 2, 8192, true);
    const st = P.newState('dualshock4');
    const [smp] = P.parseDualShock4(st, b, o);
    assert.deepEqual([st.buttons.n, st.buttons.back, st.buttons.up, st.buttons.down], [1, 1, 0, 0]);
    assert.equal(Math.round(st.buttons.lt * 100), 50);
    assert.equal(smp.acc[1], 1);
  }
});

test('Switch full report: both halves, 12-bit sticks and three motion samples', () => {
  const P = load();
  const b = new DataView(new ArrayBuffer(48));
  b.setUint8(2, 0x08 | 0x80); // A + ZR
  b.setUint8(3, 0x02 | 0x20); // + and Capture
  b.setUint8(4, 0x02 | 0x40); // up + L
  // left stick full right (x = 4095), centre y; right stick centred
  b.setUint8(5, 0xff); b.setUint8(6, 0x0f); b.setUint8(7, 0x80);
  b.setUint8(8, 0x00); b.setUint8(9, 0x08); b.setUint8(10, 0x80);
  for (let i = 0; i < 3; i++) b.setInt16(12 + i * 12 + 4, 4096, true); // accel z = 1 g (pad lying flat)
  const pro = P.newState('switch-pro');
  const smps = P.parseSwitch(pro, b, 'switch-pro');
  assert.deepEqual([pro.buttons.e, pro.buttons.rt, pro.buttons.start, pro.buttons.extra, pro.buttons.up, pro.buttons.lb], [1, 1, 1, 1, 1, 1]);
  assert.equal(pro.axes.lx, 1);
  assert.equal(Math.abs(Math.round(pro.axes.rx * 10)), 0);
  assert.equal(smps.length, 3);
  assert.equal(JSON.stringify(smps[0].acc.map((v) => Math.round(v) || 0)), '[0,1,0]'); // Switch z-up becomes the shared y-up frame
  // A left Joy-Con ignores the right half's bits.
  const jl = P.newState('joycon-l');
  P.parseSwitch(jl, b, 'joycon-l');
  assert.equal(jl.buttons.e, undefined);
  assert.equal(jl.buttons.up, 1);
});

test('motion: turning the pad 60° forward shows 60° forward tilt, and gravity keeps it level when still', () => {
  const P = load();
  const st = P.newState('dualsense');
  st.started = -1e9; // past the warm-up
  // still, level: sets the straight pose
  for (let i = 0; i < 50; i++) P.fuse(st, [0, 0, 0], [0, 1, 0], 0.004);
  // tip forward about x at 90 °/s for one second, gravity following in the pad's frame
  const N = 250;
  for (let i = 1; i <= N; i++) {
    const th = (Math.PI / 3) * (i / N);
    P.fuse(st, [60, 0, 0], [0, Math.cos(th), -Math.sin(th)], 1 / N);
  }
  let t = P.tiltAngles(st);
  assert.ok(Math.abs(t.pitch - 60) < 3, `pitch ${t.pitch}`);
  assert.ok(Math.abs(t.roll) < 3 && Math.abs(t.yaw) < 3, `roll ${t.roll} yaw ${t.yaw}`);
  // and back
  for (let i = N - 1; i >= 0; i--) {
    const th = (Math.PI / 3) * (i / N);
    P.fuse(st, [-60, 0, 0], [0, Math.cos(th), -Math.sin(th)], 1 / N);
  }
  t = P.tiltAngles(st);
  assert.ok(Math.abs(t.pitch) < 3, `pitch back ${t.pitch}`);
  // a side tilt (about z) shows as side tilt
  for (let i = 1; i <= N; i++) {
    const th = (Math.PI / 6) * (i / N);
    P.fuse(st, [0, 0, 30], [Math.sin(th), Math.cos(th), 0], 1 / N);
  }
  t = P.tiltAngles(st);
  assert.ok(Math.abs(Math.abs(t.roll) - 30) < 3, `roll ${t.roll}`);
});

test('every model in the dropdown has a drawing', () => {
  const P = load();
  const html = fs.readFileSync(path.join(__dirname, '../renderer/index.html'), 'utf8');
  const sel = html.slice(html.indexOf('id="padModel"'), html.indexOf('</select>', html.indexOf('id="padModel"')));
  const ids = [...sel.matchAll(/<option value="([a-z0-9-]+)"/g)].map((m) => m[1]).filter((v) => v !== 'auto');
  assert.ok(ids.length >= 11);
  for (const id of ids) {
    assert.ok(P.MODELS[id], id);
    assert.ok(P.MODELS[id].parts().length >= 1);
  }
  assert.equal(P.MODELS['joycon-pair'].parts().length, 2);
});
