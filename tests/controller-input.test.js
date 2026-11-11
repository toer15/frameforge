const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load renderer/controller.js with just enough of a page around it.
function load(settings = {}) {
  const el = () => ({ addEventListener() {}, classList: { toggle() {} }, set onclick(_) {}, style: {}, textContent: '', innerHTML: '' });
  const ctx = {
    $: el, $$: () => [], esc: (s) => String(s), S: { controllerType: 'auto', ...settings }, ff: {},
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

test('scaled square (axial) deadzone: each axis is independent and the range is linearly rescaled', () => {
  const P = load();
  // Below the threshold the axis is exactly zero.
  assert.equal(P.axialDeadzone(0.05, 0.1), 0);
  assert.equal(P.axialDeadzone(-0.1, 0.1), 0);
  // Linear rescale from 0 at the threshold to 1 at full deflection.
  assert.ok(Math.abs(P.axialDeadzone(0.1 + 0.45, 0.1) - 0.5) < 1e-12);
  assert.equal(P.axialDeadzone(1, 0.1), 1);
  assert.equal(P.axialDeadzone(-1, 0.1), -1);
  // A circular deadzone of radius 0.2 would let this diagonal through (magnitude ≈ 0.212);
  // the square deadzone keeps both axes at zero because each one is below the threshold.
  assert.ok(Math.hypot(0.15, 0.15) > 0.2);
  assert.equal(P.axialDeadzone(0.15, 0.2), 0);
  assert.equal(P.shapeAxis(-0.15, 0.2, 0), 0);
  // One axis can still move while the other stays centred.
  assert.equal(P.shapeAxis(0.02, 0.2, 0), 0);
  assert.ok(P.shapeAxis(0.8, 0.2, 0) > 0.7);
  // The cubic curve comes after the deadzone, so full travel is still preserved.
  assert.equal(P.shapeAxis(1, 0.2, 1), 1);
  assert.equal(P.shapeAxis(-1, 0.2, 1), -1);
  // The preview graph plots the same cubic as the stick response.
  assert.equal(P.curveOutput(0, 0.6), 0);
  assert.equal(P.curveOutput(1, 0.6), 1);
  assert.ok(P.curveOutput(0.5, 1) < P.curveOutput(0.5, 0));
});

test('deadzone shapes: circle, cross and square shape one stick differently', () => {
  const P = load();
  // Square is the default and keeps the original per-axis behaviour.
  assert.equal(P.deadzoneShape(), 'square');
  const square = P.shapeStick(0.5, 0.25, 0.2, 0, 'square');
  assert.ok(Math.abs(square.x - 0.375) < 1e-12);
  assert.ok(Math.abs(square.y - 0.0625) < 1e-12);
  // Circle uses the combined radius, so a diagonal inside that radius is dead even though both axes are
  // above nothing on their own; direction is kept when it moves.
  assert.deepEqual({ ...P.shapeStick(0.1, 0.1, 0.2, 0, 'circle') }, { x: 0, y: 0 });
  const circle = P.shapeStick(0.5, 0.5, 0.2, 0, 'circle');
  assert.ok(Math.abs(circle.x - circle.y) < 1e-12);
  assert.ok(Math.abs(Math.hypot(circle.x, circle.y) - (Math.SQRT1_2 - 0.2) / 0.8) < 1e-12);
  // Full diagonal travel stops on the circle instead of reaching 1 on both axes.
  const fullCircle = P.shapeStick(1, 1, 0.2, 0, 'circle');
  assert.ok(Math.abs(Math.hypot(fullCircle.x, fullCircle.y) - 1) < 1e-12);
  assert.ok(Math.abs(fullCircle.x - Math.SQRT1_2) < 1e-12);
  // Cross locks a small off-axis wobble to the dominant axis…
  const cross = P.shapeStick(0.5, 0.05, 0.1, 0, 'cross');
  assert.ok(Math.abs(cross.x - (0.5 - 0.1) / 0.9) < 1e-12);
  assert.equal(cross.y, 0);
  // …but keeps true diagonals diagonal.
  const diag = P.shapeStick(0.5, 0.5, 0.1, 0, 'cross');
  assert.ok(diag.x > 0 && Math.abs(diag.x - diag.y) < 1e-12);
  // Every shape is off at 0 %, and a bad saved shape falls back to square.
  const none = P.shapeStick(0.4, -0.3, 0, 0, 'circle');
  assert.ok(Math.abs(none.x - 0.4) < 1e-12 && Math.abs(none.y + 0.3) < 1e-12);
  assert.equal(load({ padDeadzoneShape: 'cross' }).deadzoneShape(), 'cross');
  assert.equal(load({ padDeadzoneShape: 'nope' }).deadzoneShape(), 'square');
  // The yellow graphic is a circle, plus or square, not always a ring.
  const circlePath = P.deadzonePath(100, 100, 10, 'circle');
  const crossPath = P.deadzonePath(100, 100, 10, 'cross');
  const squarePath = P.deadzonePath(100, 100, 10, 'square');
  assert.match(circlePath, /a10 10/);
  assert.notEqual(circlePath, crossPath);
  assert.notEqual(crossPath, squarePath);
  assert.match(squarePath, /H/);
});

test('deadzone and cubic aim curve: centre stays still, edge reaches full, curve softens small moves', () => {
  const P = load();
  // Inside the deadzone the stick reads the centre; just outside, movement starts from zero.
  assert.equal(P.shapeAxis(0.09, 0.1, 0), 0);
  assert.equal(P.shapeAxis(-0.1, 0.1, 0), 0);
  const justOut = P.shapeAxis(0.11, 0.1, 0);
  assert.ok(justOut > 0 && justOut < 0.02, `just outside the deadzone: ${justOut}`);
  // The whole travel still reaches full deflection, in both directions.
  assert.equal(P.shapeAxis(1, 0.15, 0.5), 1);
  assert.equal(P.shapeAxis(-1, 0.15, 0.5), -1);
  // A cubic curve gives finer control near the centre than linear.
  assert.ok(P.shapeAxis(0.4, 0, 1) < P.shapeAxis(0.4, 0, 0) / 2);
  // The yellow deadzone ring grows with the setting and disappears at 0 %.
  assert.ok(P.ringRadius(0.2) > P.ringRadius(0.08));
  assert.equal(P.ringRadius(0), 0);
  // Saved sliders drive it, clamped to the ranges the UI offers.
  const tuned = load({ padDeadzoneL: 20, padDeadzoneR: 40, padCurveL: 100, padCurveR: 25 });
  assert.equal(tuned.deadzone('l'), 0.2);
  assert.equal(tuned.deadzone('r'), 0.4);
  assert.equal(tuned.curve('l'), 1);
  assert.equal(tuned.curve('r'), 0.25);
  const clamped = load({ padDeadzoneL: 999, padCurveL: -5, padCurveR: 999 });
  assert.equal(clamped.deadzone('l'), 0.4);
  assert.equal(clamped.curve('l'), 0);
  assert.equal(clamped.curve('r'), 1);
  // Files from 1.13.2 and older saved one curve for both sticks.
  const legacy = load({ padCurve: 35 });
  assert.equal(legacy.curve('l'), 0.35);
  assert.equal(legacy.curve('r'), 0.35);
  // Defaults match the values in index.html.
  assert.equal(P.deadzone('l'), 0.08);
  assert.equal(P.deadzone('r'), 0.08);
  assert.equal(P.curve('l'), 0.6);
  assert.equal(P.curve('r'), 0.6);
});

test('analog triggers keep their exact partial value through the Gamepad API', () => {
  const P = load();
  // A partly pulled trigger stays partly pulled even when the browser also marks it pressed.
  assert.equal(P.gamepadButton('lt', { value: 0.37, pressed: true }), 0.37);
  assert.equal(P.gamepadButton('rt', { value: 0.05, pressed: false }), 0.05);
  assert.equal(P.gamepadButton('lt', { value: 1, pressed: true }), 1);
  assert.equal(P.gamepadButton('lt', { value: 0, pressed: true }), 0);
  // Values outside 0-1 are clamped.
  assert.equal(P.gamepadButton('rt', { value: 1.4, pressed: true }), 1);
  assert.equal(P.gamepadButton('rt', { value: -0.2, pressed: false }), 0);
  // Digital buttons still read as pressed/unpressed.
  assert.equal(P.gamepadButton('s', { value: 1, pressed: true }), 1);
  assert.equal(P.gamepadButton('s', { value: 0, pressed: false }), 0);
  assert.equal(P.gamepadButton('lt', null), 0);
  // The label on the drawing shows the same live value.
  assert.equal(P.triggerLabel('LT', 0), 'LT 0%');
  assert.equal(P.triggerLabel('RT', 0.375), 'RT 38%');
  assert.equal(P.triggerLabel('ZL', 1.4), 'ZL 100%');
});

test('trigger deadzones: each back trigger ignores its first pull and keeps full travel', () => {
  const P = load();
  // Below the threshold the trigger is exactly released; above it the rest is rescaled to 0…1.
  assert.equal(P.triggerShaped(0.05, 0.1), 0);
  assert.equal(P.triggerShaped(0.1, 0.1), 0);
  assert.ok(Math.abs(P.triggerShaped(0.55, 0.1) - 0.5) < 1e-12);
  assert.equal(P.triggerShaped(1, 0.1), 1);
  assert.equal(P.triggerShaped(-0.2, 0.1), 0);
  assert.equal(P.triggerShaped(1.4, 0), 1);
  // Saved values, defaults and clamping work per trigger.
  assert.equal(P.triggerDeadzone('l'), 0);
  const tuned = load({ padTriggerDeadzoneL: 20, padTriggerDeadzoneR: 40 });
  assert.equal(tuned.triggerDeadzone('l'), 0.2);
  assert.equal(tuned.triggerDeadzone('r'), 0.4);
  const clamped = load({ padTriggerDeadzoneL: 999 });
  assert.equal(clamped.triggerDeadzone('l'), 0.4);
});

test('macros: rapid fire pulses and combos fire once on the rising edge', () => {
  const P = load();
  assert.equal(P.MACRO_PICKS.join(','), 'rapid-rt,rapid-lt,combo-ab,combo-ba');
  assert.equal(P.macroOn(), false);
  assert.equal(P.macroPick(), 'rapid-rt');
  const tuned = load({ macroOn: true, macroPick: 'combo-ba' });
  assert.equal(tuned.macroOn(), true);
  assert.equal(tuned.macroPick(), 'combo-ba');
  assert.equal(load({ macroPick: 'bad' }).macroPick(), 'rapid-rt');

  const rapid = {};
  assert.deepEqual({ ...P.macroStep('rapid-rt', { rt: 1 }, 0, rapid) }, { rt: 0 });
  assert.deepEqual({ ...P.macroStep('rapid-rt', { rt: 1 }, 125, rapid) }, { rt: 1 });
  assert.deepEqual({ ...P.macroStep('rapid-rt', { rt: 1 }, 250, rapid) }, { rt: 0 });
  assert.deepEqual({ ...P.macroStep('rapid-rt', { rt: 0 }, 300, rapid) }, {});

  const combo = {};
  assert.deepEqual({ ...P.macroStep('combo-ab', { s: 1 }, 1000, combo) }, { e: 1 });
  assert.deepEqual({ ...P.macroStep('combo-ab', { s: 1 }, 1120, combo) }, { rt: 1 });
  assert.deepEqual({ ...P.macroStep('combo-ab', { s: 1 }, 1300, combo) }, {});
  assert.deepEqual({ ...P.macroStep('combo-ab', { s: 1 }, 1400, combo) }, {});
  P.macroStep('combo-ab', { s: 0 }, 1500, combo);
  assert.deepEqual({ ...P.macroStep('combo-ab', { s: 1 }, 1600, combo) }, { e: 1 });
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
  // The deadzone, shape and both aim curve controls live in the same tab.
  for (const id of ['padDzL', 'padDzR', 'padDzShape', 'padTdzL', 'padTdzR', 'padCurveL', 'padCurveR']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
    if (id !== 'padDzShape') assert.match(html, new RegExp(`id="${id}Val"`), id);
  }
  const shapeSel = html.slice(html.indexOf('id="padDzShape"'), html.indexOf('</select>', html.indexOf('id="padDzShape"')));
  for (const shape of ['circle', 'cross', 'square']) assert.match(shapeSel, new RegExp(`value="${shape}"`), shape);
  for (const id of ['macroOn', 'macroPick', 'macroState']) assert.match(html, new RegExp(`id="${id}"`), id);
  for (const pick of ['rapid-rt', 'rapid-lt', 'combo-ab', 'combo-ba']) assert.match(html, new RegExp(`value="${pick}"`), pick);
  for (const id of ['padCurvePathL', 'padCurvePathR', 'padCurveDotL', 'padCurveDotR', 'padCurveCaption']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /Deadzone &amp; aim curve/);
});
