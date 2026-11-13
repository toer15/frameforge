const { test } = require('node:test');
const assert = require('node:assert/strict');
const O = require('../renderer/overlay-core');

const full = { ...O.SAMPLE, cap: 141 };
const all = O.ITEMS.map((i) => i.id);
const at = { now: new Date(2026, 0, 1, 9, 5) };
const text = (html) => html.replace(/<svg[\s\S]*?<\/svg>/g, ' [graph] ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const draw = (stats, settings) => {
  const st = O.createState();
  for (let i = 0; i < 10; i++) O.push(st, stats);
  return O.html(stats, settings, st, at);
};

test('stored settings are brought into the allowed range, whatever was saved or typed', () => {
  assert.deepEqual(O.normalize(undefined), O.DEFAULTS);
  assert.deepEqual(O.normalize({}), O.DEFAULTS);
  const n = O.normalize({ overlayStyle: 'hologram', overlayItems: ['fps', 'nonsense', 'ram', 'fps'], overlayAccent: 'red; background:url(x)', overlayScale: 9999, overlayOpacity: -5, overlayFont: 'comic', overlayCorner: 7, overlayMargin: 'far' });
  assert.equal(n.overlayStyle, 'panel');
  assert.deepEqual(n.overlayItems, ['fps', 'ram']);
  assert.equal(n.overlayAccent, '#ff6b2c');
  assert.equal(n.overlayScale, 200);
  assert.equal(n.overlayOpacity, 0);
  assert.equal(n.overlayFont, 'orbitron');
  assert.equal(n.overlayCorner, 'notch');
  assert.equal(n.overlayMargin, 14);
  assert.equal(O.normalize({ overlayAccent: '#3FD8FF' }).overlayAccent, '#3fd8ff');
  assert.deepEqual(O.normalize({ overlayItems: [] }).overlayItems, [], 'an empty choice stays empty');
  assert.equal(O.normalize({ overlayScale: 60 }).overlayScale, 60);
  for (const id of O.DEFAULTS.overlayItems) assert.ok(all.includes(id));
});

test('panel: every reading in its place', () => {
  const t = text(draw(full, { overlayItems: all }));
  assert.match(t, /144 FPS/);
  assert.match(t, /1% low 113/);
  assert.match(t, /Frame 6\.9 ms/);
  assert.match(t, /Cap 141/);
  assert.match(t, /\[graph\]/);
  assert.match(t, /GPU 71° 94%/);
  assert.match(t, /214 W 1640 RPM 2480 MHz/);
  assert.match(t, /VRAM 9\.1 \/ 20 GB/);
  assert.match(t, /CPU 63° 38% 78 W/);
  assert.match(t, /RAM 14\.2 \/ 32 GB/);
  assert.match(t, /your game 09:05/);
});

test('list: one reading per line, like a classic monitoring overlay', () => {
  const h = draw(full, { overlayStyle: 'list', overlayItems: all });
  const lines = [...h.matchAll(/<div class="ffo-line[^"]*"><i>([^<]+)<\/i><b[^>]*>([^<]+)<\/b>/g)].map((m) => `${m[1]}: ${m[2]}`);
  assert.deepEqual(lines, [
    'FPS: 144', '1% low: 113', 'Frame time: 6.9 ms', 'FPS cap: 141',
    'GPU temp: 71 °C', 'GPU load: 94 %', 'GPU memory: 9.1 / 20 GB', 'GPU power: 214 W', 'GPU fan: 1640 RPM', 'GPU clock: 2480 MHz',
    'CPU temp: 63 °C', 'CPU load: 38 %', 'CPU power: 78 W', 'RAM: 14.2 / 32 GB',
    'Game: your game', 'Time: 09:05',
  ]);
  assert.equal((h.match(/ffo-sep/g) || []).length, 3, 'a divider before each group');
});

test('bar and mini carry the same numbers', () => {
  const b = text(draw(full, { overlayStyle: 'bar' }));
  assert.match(b, /144 FPS 1% low 113 Frame 6\.9 ms Cap 141 GPU 71° 94% 214 W 1640 RPM VRAM 9\.1 \/ 20 GB CPU 63° 38% RAM 14\.2 \/ 32 GB/);
  const m = text(draw(full, { overlayStyle: 'mini' }));
  assert.match(m, /^144 FPS 1% low 113/);
  assert.match(m, /GPU 71° 94%/);
});

test('a reading this PC does not report is left out — never shown as a made-up number', () => {
  const partial = { fpsEnabled: true, tempEnabled: true, fps: null, cpuLoad: 82, gpuLoad: 12, cpuTemp: null, gpuTemp: null, gpuPower: null, gpuFan: null, vramUsed: null, ramUsed: 8.3, ramTotal: 16 };
  const t = text(draw(partial, { overlayItems: all }));
  assert.match(t, /— FPS/, 'no game: a dash, not a number');
  assert.doesNotMatch(t, /1% low|Frame|°|RPM| W|MHz|VRAM/);
  assert.match(t, /GPU 12%/);
  assert.match(t, /CPU 82%/);
  assert.match(t, /RAM 8\.3 \/ 16 GB/);
  const l = draw(partial, { overlayStyle: 'list', overlayItems: all });
  assert.doesNotMatch(l, /GPU temp|GPU fan|GPU power|GPU memory|CPU temp/);
  assert.match(l, /GPU load/);
  // A stopped fan is a real reading.
  assert.match(text(draw({ ...full, gpuFan: 0 }, { overlayItems: all })), /0 RPM/);
});

test('the two switches decide which halves exist; nothing at all draws nothing', () => {
  assert.equal(draw({ ...full, fpsEnabled: false, tempEnabled: false }, {}), '');
  const hw = text(draw({ ...full, fpsEnabled: false }, {}));
  assert.doesNotMatch(hw, /FPS|1% low/);
  assert.match(hw, /GPU 71° 94%/);
  const fps = text(draw({ ...full, tempEnabled: false }, {}));
  assert.match(fps, /144 FPS/);
  assert.doesNotMatch(fps, /GPU|CPU|RAM/);
  assert.equal(draw(full, { overlayItems: [] }), '', 'everything unticked');
  assert.equal(text(draw(full, { overlayItems: ['time'] })), '09:05');
});

test('each item can be switched off on its own', () => {
  const only = (ids) => text(draw(full, { overlayItems: ids }));
  assert.equal(only(['fps']), '144 FPS');
  assert.doesNotMatch(only(['fps', 'low']), /Frame|Cap|\[graph\]/);
  assert.match(only(['gpuTemp']), /^GPU 71°$/);
  assert.match(only(['gpuFan']), /^GPU 1640 RPM$/);
  assert.match(only(['ram']), /^RAM 14\.2 \/ 32 GB$/);
  assert.ok(draw(full, { overlayItems: ['gpuLoad', 'meters'] }).includes('ffo-meter'));
  assert.ok(!draw(full, { overlayItems: ['gpuLoad'] }).includes('ffo-meter'), 'load bars are their own switch');
  assert.doesNotMatch(only(['cap', 'fps']) && text(draw({ ...full, cap: null }, { overlayItems: ['cap', 'fps'] })), /Cap/, 'no cap while the limiter is off');
});

test('heat colours, look settings and safe text', () => {
  assert.match(draw({ ...full, gpuTemp: 80 }, {}), /ffo-warm">80°/);
  assert.match(draw({ ...full, cpuTemp: 91 }, {}), /ffo-hot">91°/);
  assert.doesNotMatch(draw(full, {}), /ffo-warm|ffo-hot/);
  const h = draw(full, { overlayAccent: '#3fd8ff', overlayScale: 150, overlayOpacity: 40, overlayFont: 'mono', overlayCorner: 'round', overlayStyle: 'list' });
  assert.match(h, /^<div class="ffo ffo-list ffo-font-mono ffo-corner-round" style="--ffo-accent:#3fd8ff;--ffo-alpha:0\.40;zoom:1\.50">/);
  assert.match(draw(full, { overlayOpacity: 0 }), /ffo-bare/);
  const evil = draw({ ...full, fps: { fps: 60, low1: 50, app: '<img src=x onerror=alert(1)>' } }, { overlayItems: ['fps', 'game'], overlayAccent: '"><script>' });
  assert.ok(!evil.includes('<img') && !evil.includes('<script'), 'a program name or a stored colour can never become markup');
});

test('the graph keeps one minute and ignores seconds without a game', () => {
  const st = O.createState();
  for (let i = 0; i < 100; i++) O.push(st, { fpsEnabled: true, fps: { fps: 100 + (i % 9) } });
  assert.equal(st.hist.length, 60);
  O.push(st, { fpsEnabled: true, fps: null });
  O.push(st, { fpsEnabled: false, fps: { fps: 90 } });
  assert.deepEqual(st.hist.slice(-2), [null, null]);
  const svg = O.html({ ...full }, {}, st, at).match(/<svg[\s\S]*?<\/svg>/)[0];
  assert.match(svg, /<polyline class="ffo-graph-line" points="0\.0,/);
  for (const m of svg.matchAll(/(\d+\.\d),(\d+\.\d)/g)) assert.ok(Number(m[1]) >= 0 && Number(m[1]) <= 100 && Number(m[2]) >= 0 && Number(m[2]) <= 24);
  assert.match(O.html(full, {}, O.createState(), at), /<svg class="ffo-graph"[^>]*><\/svg>/, 'no history yet: an empty graph, not a crash');
});
