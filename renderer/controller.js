// FrameForge — Controller tab.
// Draws the chosen controller and shows live input on it. Two sources:
//  - WebHID for Sony (DualSense, DualSense Edge, DualShock 4) and Nintendo (Switch Pro, Joy-Con) pads: FrameForge reads
//    their raw reports itself, so every button, the analog triggers, the touchpad and the motion sensors work without
//    any driver or extra program.
//  - The browser Gamepad API for everything else (Xbox and other XInput pads): buttons, sticks and triggers.
// Motion: gyro + accelerometer go through a Mahony filter (gyro for fast moves, gravity to stop tilt drift) and show up
// as tilt and turning-speed readouts. The drawing itself stays fixed, so the controller never follows the pad around.
/* global $, $$, esc, S, ff */
'use strict';

const PADX = (() => {
  /* ---------- Models and drawings ---------- */
  // Button keys are positions, not labels: s/e/w/n = bottom/right/left/top face button, the standard gamepad order.
  const FACE = {
    xbox: { s: ['A', '#4cc44c'], e: ['B', '#ff4d4d'], w: ['X', '#3a8bff'], n: ['Y', '#ffd166'] },
    ps: { s: ['✕', '#6fa8ff', 'cross'], e: ['○', '#ff6b81', 'circle'], w: ['□', '#ff8fd0', 'square'], n: ['△', '#4cd9a0', 'triangle'] },
    nin: { s: ['B', '#d8dcec'], e: ['A', '#d8dcec'], w: ['Y', '#d8dcec'], n: ['X', '#d8dcec'] },
    gen: { s: ['1', '#d8dcec'], e: ['2', '#d8dcec'], w: ['3', '#d8dcec'], n: ['4', '#d8dcec'] },
  };
  const PAD_BODY = 'M95 50h210c30 0 52 22 62 62l20 100c4 22-10 40-30 40-14 0-24-8-32-22l-18-30c-6-10-14-14-26-14H119c-12 0-20 4-26 14l-18 30c-8 14-18 22-32 22-20 0-34-18-30-40l20-100c10-40 32-62 62-62Z';
  const PS_BODY = 'M100 52h200c28 0 46 16 56 50l26 104c6 26-8 46-30 46-16 0-26-10-34-26l-14-28c-6-12-14-16-26-16H122c-12 0-20 4-26 16l-14 28c-8 16-18 26-34 26-22 0-36-20-30-46l26-104c10-34 28-50 56-50Z';
  const SW_BODY = 'M92 50h216c28 0 46 18 54 52l22 104c5 24-9 44-30 44-15 0-25-9-33-24l-16-30c-6-11-14-15-26-15H121c-12 0-20 4-26 15l-16 30c-8 15-18 24-33 24-21 0-35-20-30-44l22-104c8-34 26-52 54-52Z';

  // Each part is one physical piece that moves on its own (a Joy-Con pair has two). Items:
  //  pill/trig {k,x,y,w,h,t}  face {k,x,y,set}  stick {k,x,y,ax}  dpad {x,y}  round {k,x,y,r,t}  touch {k,x,y,w,h}
  function xboxPart(kind) {
    const mid = kind === 'xbox-360' ? ['Back', 'Start'] : ['View', 'Menu'];
    const items = [
      { type: 'trig', k: 'lt', x: 100, y: 16, w: 64, h: 18, t: 'LT' }, { type: 'trig', k: 'rt', x: 300, y: 16, w: 64, h: 18, t: 'RT' },
      { type: 'pill', k: 'lb', x: 100, y: 40, w: 64, h: 16, t: 'LB' }, { type: 'pill', k: 'rb', x: 300, y: 40, w: 64, h: 16, t: 'RB' },
      { type: 'stick', k: 'l3', x: 112, y: 122, ax: 'l' }, { type: 'stick', k: 'r3', x: 262, y: 178, ax: 'r' },
      { type: 'dpad', x: 152, y: 178 }, { type: 'face', x: 300, y: 122, set: 'xbox' },
      { type: 'pill', k: 'back', x: 172, y: 122, w: 42, h: 16, t: mid[0] }, { type: 'pill', k: 'start', x: 228, y: 122, w: 42, h: 16, t: mid[1] },
      { type: 'round', k: 'guide', x: 200, y: 86, r: 12, t: 'X' },
    ];
    if (kind === 'xbox-series') items.push({ type: 'round', k: 'extra', x: 200, y: 140, r: 7, t: '' });
    if (kind === 'xbox-elite2') items.push({ type: 'pill', k: 'p1', x: 128, y: 262, w: 30, h: 12, t: 'P3' }, { type: 'pill', k: 'p2', x: 162, y: 262, w: 30, h: 12, t: 'P4' }, { type: 'pill', k: 'p3', x: 238, y: 262, w: 30, h: 12, t: 'P2' }, { type: 'pill', k: 'p4', x: 272, y: 262, w: 30, h: 12, t: 'P1' });
    return { body: PAD_BODY, view: '0 0 400 280', items };
  }
  function psPart(kind) {
    const ds4 = kind === 'dualshock4';
    const items = [
      { type: 'trig', k: 'lt', x: 100, y: 16, w: 64, h: 18, t: 'L2' }, { type: 'trig', k: 'rt', x: 300, y: 16, w: 64, h: 18, t: 'R2' },
      { type: 'pill', k: 'lb', x: 100, y: 40, w: 64, h: 16, t: 'L1' }, { type: 'pill', k: 'rb', x: 300, y: 40, w: 64, h: 16, t: 'R1' },
      { type: 'touch', k: 'extra', x: 200, y: 98, w: 96, h: 46 },
      { type: 'pill', k: 'back', x: 128, y: 76, w: 46, h: 14, t: ds4 ? 'Share' : 'Create' }, { type: 'pill', k: 'start', x: 272, y: 76, w: 46, h: 14, t: 'Options' },
      { type: 'dpad', x: 106, y: 130 }, { type: 'face', x: 294, y: 130, set: 'ps' },
      { type: 'stick', k: 'l3', x: 156, y: 182, ax: 'l' }, { type: 'stick', k: 'r3', x: 244, y: 182, ax: 'r' },
      { type: 'round', k: 'guide', x: 200, y: 166, r: 10, t: 'PS' },
    ];
    if (!ds4) items.push({ type: 'pill', k: 'mute', x: 200, y: 186, w: 20, h: 6, t: '' });
    if (kind === 'dualsense-edge') items.push({ type: 'pill', k: 'fnl', x: 164, y: 214, w: 24, h: 10, t: 'Fn' }, { type: 'pill', k: 'fnr', x: 236, y: 214, w: 24, h: 10, t: 'Fn' }, { type: 'pill', k: 'pl', x: 120, y: 266, w: 40, h: 12, t: 'LB' }, { type: 'pill', k: 'pr', x: 280, y: 266, w: 40, h: 12, t: 'RB' });
    return { body: PS_BODY, view: '0 0 400 280', items, light: ds4 };
  }
  function proPart() {
    return {
      body: SW_BODY, view: '0 0 400 280',
      items: [
        { type: 'trig', k: 'lt', x: 100, y: 16, w: 64, h: 18, t: 'ZL' }, { type: 'trig', k: 'rt', x: 300, y: 16, w: 64, h: 18, t: 'ZR' },
        { type: 'pill', k: 'lb', x: 100, y: 40, w: 64, h: 16, t: 'L' }, { type: 'pill', k: 'rb', x: 300, y: 40, w: 64, h: 16, t: 'R' },
        { type: 'stick', k: 'l3', x: 112, y: 122, ax: 'l' }, { type: 'stick', k: 'r3', x: 262, y: 178, ax: 'r' },
        { type: 'dpad', x: 152, y: 178 }, { type: 'face', x: 300, y: 122, set: 'nin' },
        { type: 'round', k: 'back', x: 168, y: 92, r: 8, t: '−' }, { type: 'round', k: 'start', x: 232, y: 92, r: 8, t: '+' },
        { type: 'round', k: 'extra', x: 176, y: 124, r: 7, t: '◉' }, { type: 'round', k: 'guide', x: 224, y: 124, r: 8, t: '⌂' },
      ],
    };
  }
  function joyconPart(side) {
    const body = side === 'l'
      ? 'M70 40h40v250H70c-24 0-40-16-40-40V80c0-24 16-40 40-40Z'
      : 'M30 40h40c24 0 40 16 40 40v170c0 24-16 40-40 40H30Z';
    const items = side === 'l'
      ? [
        { type: 'trig', k: 'lt', x: 70, y: 10, w: 56, h: 14, t: 'ZL' }, { type: 'pill', k: 'lb', x: 70, y: 28, w: 56, h: 12, t: 'L' },
        { type: 'round', k: 'back', x: 92, y: 62, r: 7, t: '−' }, { type: 'stick', k: 'l3', x: 70, y: 108, ax: 'l' },
        { type: 'round', k: 'up', x: 70, y: 156, r: 11, t: '▲' }, { type: 'round', k: 'down', x: 70, y: 202, r: 11, t: '▼' },
        { type: 'round', k: 'left', x: 47, y: 179, r: 11, t: '◀' }, { type: 'round', k: 'right', x: 93, y: 179, r: 11, t: '▶' },
        { type: 'round', k: 'extra', x: 88, y: 240, r: 7, t: '◉' },
        { type: 'pill', k: 'sll', x: 126, y: 110, w: 12, h: 30, t: '' }, { type: 'pill', k: 'srl', x: 126, y: 200, w: 12, h: 30, t: '' },
      ]
      : [
        { type: 'trig', k: 'rt', x: 70, y: 10, w: 56, h: 14, t: 'ZR' }, { type: 'pill', k: 'rb', x: 70, y: 28, w: 56, h: 12, t: 'R' },
        { type: 'round', k: 'start', x: 48, y: 62, r: 7, t: '+' }, { type: 'face', x: 70, y: 112, set: 'nin', gap: 22 },
        { type: 'stick', k: 'r3', x: 70, y: 186, ax: 'r' }, { type: 'round', k: 'guide', x: 52, y: 240, r: 8, t: '⌂' },
        { type: 'pill', k: 'slr', x: 14, y: 110, w: 12, h: 30, t: '' }, { type: 'pill', k: 'srr', x: 14, y: 200, w: 12, h: 30, t: '' },
      ];
    return { body, view: '0 0 140 300', items, side, accent: side === 'l' ? '#0ab9e6' : '#ff3c28' };
  }

  const MODELS = {
    'xbox-series': { name: 'Xbox Series X|S Controller', family: 'xbox', parts: () => [xboxPart('xbox-series')] },
    'xbox-elite2': { name: 'Xbox Elite Series 2', family: 'xbox', parts: () => [xboxPart('xbox-elite2')] },
    'xbox-one': { name: 'Xbox One Controller', family: 'xbox', parts: () => [xboxPart('xbox-one')] },
    'xbox-360': { name: 'Xbox 360 Controller', family: 'xbox', parts: () => [xboxPart('xbox-360')] },
    dualsense: { name: 'DualSense', family: 'ps', motion: true, parts: () => [psPart('dualsense')] },
    'dualsense-edge': { name: 'DualSense Edge', family: 'ps', motion: true, parts: () => [psPart('dualsense-edge')] },
    dualshock4: { name: 'DualShock 4', family: 'ps', motion: true, parts: () => [psPart('dualshock4')] },
    'switch-pro': { name: 'Switch Pro Controller', family: 'nin', motion: true, parts: () => [proPart()] },
    'joycon-pair': { name: 'Joy-Con (L + R)', family: 'nin', motion: true, parts: () => [joyconPart('l'), joyconPart('r')] },
    'joycon-l': { name: 'Joy-Con (L)', family: 'nin', motion: true, parts: () => [joyconPart('l')] },
    'joycon-r': { name: 'Joy-Con (R)', family: 'nin', motion: true, parts: () => [joyconPart('r')] },
    generic: { name: 'Gamepad', family: 'gen', parts: () => [xboxPart('xbox-one')] },
  };
  const LABELS = {
    xbox: { s: 'A', e: 'B', w: 'X', n: 'Y', lb: 'LB', rb: 'RB', lt: 'LT', rt: 'RT', back: 'View', start: 'Menu', l3: 'LS', r3: 'RS', guide: 'Xbox', extra: 'Share' },
    ps: { s: '✕', e: '○', w: '□', n: '△', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', back: 'Create', start: 'Options', l3: 'L3', r3: 'R3', guide: 'PS', extra: 'Touchpad', mute: 'Mute', fnl: 'Fn L', fnr: 'Fn R', pl: 'Back L', pr: 'Back R' },
    nin: { s: 'B', e: 'A', w: 'Y', n: 'X', lb: 'L', rb: 'R', lt: 'ZL', rt: 'ZR', back: '−', start: '+', l3: 'L stick', r3: 'R stick', guide: 'Home', extra: 'Capture', sll: 'SL', srl: 'SR', slr: 'SL', srr: 'SR' },
    gen: { s: '1', e: '2', w: '3', n: '4', lb: 'L1', rb: 'R1', lt: 'L2', rt: 'R2', back: 'Select', start: 'Start', l3: 'L3', r3: 'R3', guide: 'Home', extra: 'Extra' },
  };
  // Names that differ between models of one family.
  const LABEL_OVERRIDES = { dualshock4: { back: 'Share' }, 'xbox-360': { back: 'Back', start: 'Start', guide: 'Guide' } };
  const labelsFor = (id) => ({ ...LABELS[MODELS[id].family], ...(LABEL_OVERRIDES[id] || {}) });

  const ACTIONS = [
    ['Jump / Confirm', 's'], ['Dodge / Back', 'e'], ['Reload / Interact', 'w'], ['Switch weapon / Item', 'n'],
    ['Aim', 'lt'], ['Shoot / Attack', 'rt'], ['Block / Lean left', 'lb'], ['Grenade / Lean right', 'rb'],
    ['Sprint / Crouch (stick click)', 'l3'], ['Melee (stick click)', 'r3'], ['Pause / Menu', 'start'], ['Map / Scoreboard', 'back'],
  ];

  function faceGlyph(set, key, x, y) {
    const [label, col, sym] = FACE[set][key];
    if (!sym) return `<circle cx="${x}" cy="${y}" r="13"/><text x="${x}" y="${y + 5}" text-anchor="middle" font-size="14" font-weight="700" style="fill:${col}">${label}</text>`;
    const s = 6.5;
    const shape = {
      cross: `<path d="M${x - s} ${y - s}L${x + s} ${y + s}M${x + s} ${y - s}L${x - s} ${y + s}"/>`,
      circle: `<circle cx="${x}" cy="${y}" r="${s + 1}"/>`,
      square: `<rect x="${x - s}" y="${y - s}" width="${s * 2}" height="${s * 2}"/>`,
      triangle: `<path d="M${x} ${y - s - 1}L${x + s + 1} ${y + s}L${x - s - 1} ${y + s}Z"/>`,
    }[sym];
    return `<circle cx="${x}" cy="${y}" r="13"/><g class="pad-sym" style="stroke:${col}">${shape}</g>`;
  }

  function drawPart(part, labels) {
    const g = (k, inner) => `<g class="pad-key" data-k="${k}"><title>${esc(labels[k] || k)}</title>${inner}</g>`;
    let s = `<path class="pad-body" d="${part.body}"${part.accent ? ` style="stroke:${part.accent}"` : ''}/>`;
    if (part.light) s += '<rect class="pad-light" x="160" y="70" width="80" height="4" rx="2"/>';
    for (const it of part.items) {
      if (it.type === 'pill') s += g(it.k, `<rect x="${it.x - it.w / 2}" y="${it.y - it.h / 2}" width="${it.w}" height="${it.h}" rx="${Math.min(8, it.h / 2)}"/>${it.t ? `<text x="${it.x}" y="${it.y + 4}" text-anchor="middle" font-size="${it.h < 14 ? 8 : 11}">${esc(it.t)}</text>` : ''}`);
      else if (it.type === 'trig') s += g(it.k, `<rect x="${it.x - it.w / 2}" y="${it.y - it.h / 2}" width="${it.w}" height="${it.h}" rx="6"/><rect class="pad-fill" data-fill="${it.k}" x="${it.x - it.w / 2}" y="${it.y - it.h / 2}" width="0" height="${it.h}" rx="6"/><circle class="pad-trig" data-trig="${it.k}" data-x="${it.x - it.w / 2 + 4}" data-w="${it.w - 8}" cx="${it.x - it.w / 2 + 4}" cy="${it.y + it.h / 2 - 2.5}" r="2.5" aria-hidden="true"/><text class="pad-trig-text" data-trig-text="${it.k}" data-label="${esc(it.t)}" x="${it.x}" y="${it.y + 4}" text-anchor="middle" font-size="11">${esc(it.t)} 0%</text>`);
      else if (it.type === 'round') s += g(it.k, `<circle cx="${it.x}" cy="${it.y}" r="${it.r}"/>${it.t ? `<text x="${it.x}" y="${it.y + it.r * 0.38}" text-anchor="middle" font-size="${Math.max(8, it.r)}">${esc(it.t)}</text>` : ''}`);
      else if (it.type === 'stick') s += g(it.k, `<circle cx="${it.x}" cy="${it.y}" r="25"/><line class="pad-cross" x1="${it.x - 25}" y1="${it.y}" x2="${it.x + 25}" y2="${it.y}"/><line class="pad-cross" x1="${it.x}" y1="${it.y - 25}" x2="${it.x}" y2="${it.y + 25}"/><circle class="pad-stick" data-stick="${it.ax}" data-cx="${it.x}" data-cy="${it.y}" cx="${it.x}" cy="${it.y}" r="12"/><path class="pad-deadzone" data-dz="${it.ax}" data-cx="${it.x}" data-cy="${it.y}" d="" aria-hidden="true"/>`);
      else if (it.type === 'dpad') {
        const { x, y } = it;
        s += g('up', `<rect x="${x - 8}" y="${y - 28}" width="16" height="19" rx="3"/>`) + g('down', `<rect x="${x - 8}" y="${y + 9}" width="16" height="19" rx="3"/>`);
        s += g('left', `<rect x="${x - 28}" y="${y - 8}" width="19" height="16" rx="3"/>`) + g('right', `<rect x="${x + 9}" y="${y - 8}" width="19" height="16" rx="3"/>`);
      } else if (it.type === 'face') {
        const d = it.gap || 26;
        s += g('s', faceGlyph(it.set, 's', it.x, it.y + d)) + g('e', faceGlyph(it.set, 'e', it.x + d, it.y)) + g('w', faceGlyph(it.set, 'w', it.x - d, it.y)) + g('n', faceGlyph(it.set, 'n', it.x, it.y - d));
      } else if (it.type === 'touch') {
        s += g(it.k, `<rect x="${it.x - it.w / 2}" y="${it.y - it.h / 2}" width="${it.w}" height="${it.h}" rx="6"/><circle class="pad-touch" data-touch="0" r="4" cx="0" cy="0" data-x="${it.x - it.w / 2}" data-y="${it.y - it.h / 2}" data-w="${it.w}" data-h="${it.h}"/><circle class="pad-touch" data-touch="1" r="4" cx="0" cy="0" data-x="${it.x - it.w / 2}" data-y="${it.y - it.h / 2}" data-w="${it.w}" data-h="${it.h}"/>`);
      }
    }
    return s;
  }

  /* ---------- Live state ---------- */
  // One state per physical device: { buttons: {key: 0..1}, axes: {lx,ly,rx,ry}, touch: [{x,y}|null], q: quaternion, ... }
  function newState(kind) {
    return { kind, buttons: {}, axes: { lx: 0, ly: 0, rx: 0, ry: 0 }, touch: [null, null], motion: null, at: 0, q: [1, 0, 0, 0], ref: null, bias: [0, 0, 0], ix: [0, 0, 0], started: 0, gyro: [0, 0, 0], accel: [0, 0, 0] };
  }
  const hid = new Map(); // HIDDevice -> state
  let hidStarted = false;

  const HAT = [['up'], ['up', 'right'], ['right'], ['down', 'right'], ['down'], ['down', 'left'], ['left'], ['up', 'left']];
  const bit = (v, n) => ((v >> n) & 1 ? 1 : 0);
  const stick8 = (v) => (v - 128) / 127;

  function setHat(b, hat) {
    for (const k of ['up', 'down', 'left', 'right']) b[k] = 0;
    for (const k of HAT[hat] || []) b[k] = 1;
  }

  // Sony reports, Linux hid-playstation layout. o = offset of the common part in the report (USB 0, Bluetooth 1 or 2).
  function parseDualSense(st, d, o) {
    const u = (i) => d.getUint8(o + i);
    const s16 = (i) => d.getInt16(o + i, true);
    st.axes = { lx: stick8(u(0)), ly: stick8(u(1)), rx: stick8(u(2)), ry: stick8(u(3)) };
    const b = st.buttons;
    b.lt = u(4) / 255; b.rt = u(5) / 255;
    const b0 = u(7), b1 = u(8), b2 = u(9);
    setHat(b, b0 & 0x0f);
    b.w = bit(b0, 4); b.s = bit(b0, 5); b.e = bit(b0, 6); b.n = bit(b0, 7);
    b.lb = bit(b1, 0); b.rb = bit(b1, 1); b.back = bit(b1, 4); b.start = bit(b1, 5); b.l3 = bit(b1, 6); b.r3 = bit(b1, 7);
    b.guide = bit(b2, 0); b.extra = bit(b2, 1); b.mute = bit(b2, 2); b.fnl = bit(b2, 4); b.fnr = bit(b2, 5); b.pl = bit(b2, 6); b.pr = bit(b2, 7);
    // Raw sensor units: about 16.4 per degree/second (±2000 °/s) and 8192 per g.
    const gyro = [s16(15) / 16.384, s16(17) / 16.384, s16(19) / 16.384];
    const acc = [s16(21) / 8192, s16(23) / 8192, s16(25) / 8192];
    for (let i = 0; i < 2; i++) {
      const p = o + 32 + i * 4;
      const c = d.getUint8(p);
      st.touch[i] = c & 0x80 ? null : { x: (d.getUint8(p + 1) | ((d.getUint8(p + 2) & 0x0f) << 8)) / 1920, y: ((d.getUint8(p + 2) >> 4) | (d.getUint8(p + 3) << 4)) / 1080 };
    }
    return [{ gyro, acc }];
  }
  function parseDualShock4(st, d, o) {
    const u = (i) => d.getUint8(o + i);
    const s16 = (i) => d.getInt16(o + i, true);
    st.axes = { lx: stick8(u(0)), ly: stick8(u(1)), rx: stick8(u(2)), ry: stick8(u(3)) };
    const b = st.buttons;
    const b0 = u(4), b1 = u(5), b2 = u(6);
    setHat(b, b0 & 0x0f);
    b.w = bit(b0, 4); b.s = bit(b0, 5); b.e = bit(b0, 6); b.n = bit(b0, 7);
    b.lb = bit(b1, 0); b.rb = bit(b1, 1); b.back = bit(b1, 4); b.start = bit(b1, 5); b.l3 = bit(b1, 6); b.r3 = bit(b1, 7);
    b.guide = bit(b2, 0); b.extra = bit(b2, 1);
    b.lt = u(7) / 255; b.rt = u(8) / 255;
    const gyro = [s16(12) / 16.384, s16(14) / 16.384, s16(16) / 16.384];
    const acc = [s16(18) / 8192, s16(20) / 8192, s16(22) / 8192];
    const tp = o + 34; // first touch report: count byte, then a timestamp byte, then two 4-byte points
    if (d.byteLength >= tp + 8) {
      for (let i = 0; i < 2; i++) {
        const p = tp + i * 4;
        const c = d.getUint8(p);
        st.touch[i] = c & 0x80 ? null : { x: (d.getUint8(p + 1) | ((d.getUint8(p + 2) & 0x0f) << 8)) / 1920, y: ((d.getUint8(p + 2) >> 4) | (d.getUint8(p + 3) << 4)) / 943 };
      }
    }
    return [{ gyro, acc }];
  }
  // Nintendo full report 0x30 (dekuNukem's Joy-Con reverse engineering notes). Three IMU samples, 5 ms apart.
  function parseSwitch(st, d, kind) {
    const u = (i) => d.getUint8(i);
    const s16 = (i) => d.getInt16(i, true);
    const r = u(2), m = u(3), l = u(4);
    const b = st.buttons;
    if (kind !== 'joycon-l') {
      b.w = bit(r, 0); b.n = bit(r, 1); b.s = bit(r, 2); b.e = bit(r, 3); b.rb = bit(r, 6); b.rt = bit(r, 7);
      b.srr = bit(r, 4); b.slr = bit(r, 5); b.start = bit(m, 1); b.r3 = bit(m, 2); b.guide = bit(m, 4);
    }
    if (kind !== 'joycon-r') {
      b.down = bit(l, 0); b.up = bit(l, 1); b.right = bit(l, 2); b.left = bit(l, 3); b.lb = bit(l, 6); b.lt = bit(l, 7);
      b.srl = bit(l, 4); b.sll = bit(l, 5); b.back = bit(m, 0); b.l3 = bit(m, 3); b.extra = bit(m, 5);
    }
    const st12 = (i) => {
      const x = u(i) | ((u(i + 1) & 0x0f) << 8);
      const y = (u(i + 1) >> 4) | (u(i + 2) << 4);
      const n = (v) => Math.max(-1, Math.min(1, (v - 2048) / 1500));
      return [n(x), -n(y)];
    };
    const [lx, ly] = st12(5);
    const [rx, ry] = st12(8);
    if (kind !== 'joycon-r') { st.axes.lx = lx; st.axes.ly = ly; }
    if (kind !== 'joycon-l') { st.axes.rx = rx; st.axes.ry = ry; }
    const out = [];
    for (let i = 0; i < 3; i++) {
      const p = 12 + i * 12;
      if (d.byteLength < p + 12) break;
      // Switch sensor axes -> the same frame as Sony pads (x right, y up out of the face, z toward the player), as SDL does.
      const a = [s16(p), s16(p + 2), s16(p + 4)].map((v) => v / 4096);
      const g = [s16(p + 6), s16(p + 8), s16(p + 10)].map((v) => v * 0.0611);
      out.push({ acc: [-a[1], a[2], -a[0]], gyro: [-g[1], g[2], -g[0]], dt: 0.005 });
    }
    return out;
  }

  function kindOf(dev) {
    if (dev.vendorId === 0x054c) return dev.productId === 0x0ce6 ? 'dualsense' : dev.productId === 0x0df2 ? 'dualsense-edge' : 'dualshock4';
    if (dev.vendorId === 0x057e) return dev.productId === 0x2006 ? 'joycon-l' : dev.productId === 0x2007 ? 'joycon-r' : 'switch-pro';
    return null;
  }

  /* ---------- Motion: Mahony filter ---------- */
  const D2R = Math.PI / 180;
  function fuse(st, gyroDps, acc, dt) {
    // Gyro bias: while the pad is almost still, slowly learn what "not turning" reads, so yaw doesn't creep.
    const raw = gyroDps;
    const still = Math.abs(raw[0] - st.bias[0]) < 3 && Math.abs(raw[1] - st.bias[1]) < 3 && Math.abs(raw[2] - st.bias[2]) < 3;
    if (still) for (let i = 0; i < 3; i++) st.bias[i] += (raw[i] - st.bias[i]) * 0.02;
    let gx = (raw[0] - st.bias[0]) * D2R, gy = (raw[1] - st.bias[1]) * D2R, gz = (raw[2] - st.bias[2]) * D2R;
    let [q0, q1, q2, q3] = st.q;
    const n = Math.hypot(acc[0], acc[1], acc[2]);
    const warm = performance.now() - st.started < 1200;
    if (n > 0.6 && n < 1.4) {
      const ax = acc[0] / n, ay = acc[1] / n, az = acc[2] / n;
      // The sensor's "up" (y) as the current orientation predicts it, versus what gravity says.
      const vx = 2 * (q1 * q2 + q0 * q3), vy = q0 * q0 - q1 * q1 + q2 * q2 - q3 * q3, vz = 2 * (q2 * q3 - q0 * q1);
      const ex = ay * vz - az * vy, ey = az * vx - ax * vz, ez = ax * vy - ay * vx;
      const kp = warm ? 8 : 1.2;
      gx += kp * ex; gy += kp * ey; gz += kp * ez;
    }
    const h = 0.5 * dt;
    const a0 = q0 + (-q1 * gx - q2 * gy - q3 * gz) * h;
    const a1 = q1 + (q0 * gx + q2 * gz - q3 * gy) * h;
    const a2 = q2 + (q0 * gy - q1 * gz + q3 * gx) * h;
    const a3 = q3 + (q0 * gz + q1 * gy - q2 * gx) * h;
    const m = Math.hypot(a0, a1, a2, a3) || 1;
    st.q = [a0 / m, a1 / m, a2 / m, a3 / m];
    st.gyro = raw.map((v, i) => v - st.bias[i]);
    st.accel = acc;
    st.motion = true;
    if (!st.ref && !warm) st.ref = st.q.slice(); // first straight pose: how the pad was held when tracking started
  }

  const qmul = (a, b) => [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
  const qconj = (q) => [q[0], -q[1], -q[2], -q[3]];

  function rel(st) {
    const [w, x, y, z] = qmul(qconj(st.ref), st.q);
    return [
      [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
      [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
      [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
    ];
  }
  // Readable angles: how far the face tipped forward/back and sideways, and how far the pad turned left/right.
  function tiltAngles(st) {
    if (!st.ref) return null;
    const R = rel(st);
    return { pitch: Math.atan2(R[2][1], R[1][1]) / D2R, roll: Math.atan2(-R[0][1], R[1][1]) / D2R, yaw: Math.atan2(R[0][2], R[2][2]) / D2R };
  }

  /* ---------- HID devices ---------- */
  async function sendSwitch(dev, counter, sub, args) {
    const data = new Uint8Array(48);
    data[0] = counter & 0x0f;
    data.set([0x00, 0x01, 0x40, 0x40, 0x00, 0x01, 0x40, 0x40], 1); // neutral rumble
    data[9] = sub;
    data.set(args, 10);
    await dev.sendReport(0x01, data);
  }

  async function openHid(dev) {
    const kind = kindOf(dev);
    if (!kind || hid.has(dev)) return;
    const hasReport = (id) => dev.collections.some((c) => (c.inputReports || []).some((r) => r.reportId === id));
    // Only the gamepad interface (a DualSense also shows up as audio and other HID interfaces).
    if (!hasReport(0x01) && !hasReport(0x30) && !hasReport(0x31) && !hasReport(0x11) && !hasReport(0x3f)) return;
    const st = newState(kind);
    st.started = performance.now();
    st.name = dev.productName;
    hid.set(dev, st);
    try {
      if (!dev.opened) await dev.open();
    } catch {
      hid.delete(dev);
      return;
    }
    let last = 0;
    if (dev.__ffOnReport) dev.removeEventListener('inputreport', dev.__ffOnReport); // reopened after the tab was closed
    dev.__ffOnReport = (e) => {
      const d = e.data;
      const id = e.reportId;
      let samples = null;
      try {
        if (kind === 'dualsense' || kind === 'dualsense-edge') {
          if (id === 0x01 && d.byteLength >= 60) samples = parseDualSense(st, d, 0);
          else if (id === 0x31 && d.byteLength >= 61) samples = parseDualSense(st, d, 1);
        } else if (kind === 'dualshock4') {
          if (id === 0x01 && d.byteLength >= 40) samples = parseDualShock4(st, d, 0);
          else if (id === 0x11 && d.byteLength >= 42) samples = parseDualShock4(st, d, 2);
        } else if (id === 0x30 && d.byteLength >= 48) samples = parseSwitch(st, d, kind);
      } catch {
        samples = null;
      }
      if (!samples) return;
      const now = performance.now();
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.004;
      last = now;
      for (const smp of samples) fuse(st, smp.gyro, smp.acc, smp.dt || dt / samples.length);
      st.at = now;
    };
    dev.addEventListener('inputreport', dev.__ffOnReport);
    try {
      if (kind === 'dualsense' || kind === 'dualsense-edge' || kind === 'dualshock4') {
        // Over Bluetooth a Sony pad only sends its full report (with motion) after the calibration report is read.
        await dev.receiveFeatureReport(0x05).catch(() => {});
        if (kind === 'dualshock4') await dev.receiveFeatureReport(0x02).catch(() => {});
      } else {
        // Switch: USB handshake (wired Pro Controller), then full report mode 0x30 with the motion sensors on.
        await dev.sendReport(0x80, new Uint8Array([0x02])).catch(() => {});
        await dev.sendReport(0x80, new Uint8Array([0x04])).catch(() => {});
        await sendSwitch(dev, 0, 0x03, [0x30]).catch(() => {});
        await sendSwitch(dev, 1, 0x40, [0x01]).catch(() => {});
      }
    } catch {}
  }

  async function startHid() {
    if (!navigator.hid) return;
    if (!hidStarted) {
      hidStarted = true;
      navigator.hid.addEventListener('connect', (e) => openHid(e.device));
      navigator.hid.addEventListener('disconnect', (e) => hid.delete(e.device));
    }
    try {
      for (const dev of await navigator.hid.getDevices()) await openHid(dev);
    } catch {}
  }

  /* ---------- Deadzone and aim curve ---------- */
  // Saved as whole percentages: 0-40 % of full stick travel per stick, and 0-100 % for how cubic the aim curve is.
  const DZ_MAX = 40;
  const TRIGGER_DZ_MAX = 40;
  const CURVE_MAX = 100;
  const DZ_SHAPES = ['circle', 'cross', 'square'];
  const clampPct = (v, max) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(0, Math.min(max, Math.round(n))) : null;
  };
  const deadzone = (axis) => {
    const v = clampPct(S && S[axis === 'r' ? 'padDeadzoneR' : 'padDeadzoneL'], DZ_MAX);
    return (v === null ? 8 : v) / 100;
  };
  const triggerDeadzone = (axis) => {
    const v = clampPct(S && S[axis === 'r' ? 'padTriggerDeadzoneR' : 'padTriggerDeadzoneL'], TRIGGER_DZ_MAX);
    return (v === null ? 0 : v) / 100;
  };
  const curve = (axis) => {
    const key = axis === 'r' ? 'padCurveR' : 'padCurveL';
    const legacy = clampPct(S && S.padCurve, CURVE_MAX); // one saved value from 1.13.2 and older
    const v = clampPct(S && S[key], CURVE_MAX);
    return (v === null ? (legacy === null ? 60 : legacy) : v) / 100;
  };
  const deadzoneShape = () => {
    const v = S && S.padDeadzoneShape;
    return DZ_SHAPES.includes(v) ? v : 'square';
  };
  /**
   * Scaled square (axial) deadzone for one axis. X and Y are evaluated independently, so the deadzone is a
   * square around the centre rather than a circle. Below the threshold the axis reads 0; above it the
   * remaining travel is linearly rescaled from 0 at the threshold to 1 at full deflection, so no range is lost.
   */
  function axialDeadzone(v, dz) {
    const a = Math.min(1, Math.abs(Number(v) || 0));
    if (a <= dz) return 0;
    return Math.sign(v) * ((a - dz) / (1 - dz));
  }
  /**
   * One analog trigger, 0…1 in and out. The first `dz` of the pull is ignored, then the remaining travel
   * is rescaled so a full pull still reaches 1. At 0 % the raw value passes through unchanged.
   */
  function triggerShaped(v, dz) {
    const a = Math.max(0, Math.min(1, Number(v) || 0));
    if (dz <= 0) return a;
    return a <= dz ? 0 : (a - dz) / (1 - dz);
  }
  const applyCurve = (v, cubic) => {
    if (!v) return 0;
    const a = Math.abs(v);
    return Math.sign(v) * ((1 - cubic) * a + cubic * a * a * a);
  };
  /**
   * One stick axis, -1…1 in and out: the scaled square deadzone first, then the cubic aim curve on what is
   * left. Full deflection still reaches 1, and the centre stays still so a resting stick cannot drift aim.
   */
  function shapeAxis(v, dz, cubic) {
    return applyCurve(axialDeadzone(v, dz), cubic);
  }
  const CROSS_LOCK = 0.45;
  /**
   * One complete stick through the selected deadzone shape, -1…1 per axis in and out.
   *  - circle: radial deadzone; the whole direction is kept and diagonal travel stops at the circle.
   *  - cross: a small circle at the centre plus straight cardinal arms. Near-straight presses lock to the
   *    dominant axis instead of leaking a little movement into the other one.
   *  - square: each axis is judged and rescaled independently (the original FrameForge deadzone).
   * At 0 % the deadzone is off, so the raw axes pass through the aim curve unchanged.
   */
  function shapeStick(x, y, dz, cubic, shape = 'square') {
    const rawX = Math.max(-1, Math.min(1, Number(x) || 0));
    const rawY = Math.max(-1, Math.min(1, Number(y) || 0));
    if (dz <= 0) return { x: applyCurve(rawX, cubic), y: applyCurve(rawY, cubic) };
    if (shape === 'circle') {
      const r = Math.hypot(rawX, rawY);
      if (r <= dz) return { x: 0, y: 0 };
      const shaped = applyCurve((Math.min(1, r) - dz) / (1 - dz), cubic);
      return { x: (rawX / r) * shaped, y: (rawY / r) * shaped };
    }
    if (shape === 'cross') {
      const ax = Math.abs(rawX);
      const ay = Math.abs(rawY);
      if (Math.hypot(ax, ay) <= dz) return { x: 0, y: 0 };
      if (ax >= ay && ay <= ax * CROSS_LOCK) {
        const out = ax <= dz ? 0 : Math.sign(rawX) * applyCurve((ax - dz) / (1 - dz), cubic);
        return { x: out, y: 0 };
      }
      if (ay > ax && ax <= ay * CROSS_LOCK) {
        const out = ay <= dz ? 0 : Math.sign(rawY) * applyCurve((ay - dz) / (1 - dz), cubic);
        return { x: 0, y: out };
      }
      return { x: shapeAxis(rawX, dz, cubic), y: shapeAxis(rawY, dz, cubic) };
    }
    return { x: shapeAxis(rawX, dz, cubic), y: shapeAxis(rawY, dz, cubic) };
  }
  // The yellow shape over the stick cap: it grows with the deadzone and is hidden at 0 %.
  const ringRadius = (dz) => (dz <= 0 ? 0 : Math.max(2.5, 62.5 * dz));
  function deadzonePath(cx, cy, r, shape = 'square') {
    if (!(r > 0)) return '';
    const x = Number(cx) || 0;
    const y = Number(cy) || 0;
    if (shape === 'circle') {
      return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`;
    }
    if (shape === 'cross') {
      const w = Math.max(1.2, r * 0.42);
      return `M${x - w} ${y - r}H${x + w}V${y - w}H${x + r}V${y + w}H${x + w}V${y + r}H${x - w}V${y + w}H${x - r}V${y - w}H${x - w}Z`;
    }
    const side = r * 0.7;
    return `M${x - side} ${y - side}H${x + side}V${y + side}H${x - side}Z`;
  }

  function syncDeadzoneRings() {
    if (!UI.stage) return;
    const shape = deadzoneShape();
    for (const p of UI.stage.rings || []) {
      const dz = deadzone(p.dataset.dz);
      const r = ringRadius(dz);
      p.setAttribute('data-r', r.toFixed(2));
      p.setAttribute('data-shape', shape);
      p.setAttribute('d', deadzonePath(Number(p.dataset.cx), Number(p.dataset.cy), r, shape));
      p.classList.toggle('off', dz <= 0);
    }
  }

  const TUNE_SAVE = { timer: null, pending: {} };
  function syncTuneControls() {
    const v = {
      padDeadzoneL: Math.round(deadzone('l') * 100),
      padDeadzoneR: Math.round(deadzone('r') * 100),
      padTriggerDeadzoneL: Math.round(triggerDeadzone('l') * 100),
      padTriggerDeadzoneR: Math.round(triggerDeadzone('r') * 100),
      padCurveL: Math.round(curve('l') * 100),
      padCurveR: Math.round(curve('r') * 100),
    };
    for (const [id, key] of [['#padDzL', 'padDeadzoneL'], ['#padDzR', 'padDeadzoneR'], ['#padTdzL', 'padTriggerDeadzoneL'], ['#padTdzR', 'padTriggerDeadzoneR'], ['#padCurveL', 'padCurveL'], ['#padCurveR', 'padCurveR']]) {
      const el = $(id);
      if (el && String(el.value) !== String(v[key])) el.value = String(v[key]);
      const out = $(`${id}Val`);
      if (out) out.textContent = `${v[key]}%`;
    }
    const shapeEl = $('#padDzShape');
    if (shapeEl) shapeEl.value = deadzoneShape();
    syncDeadzoneRings();
  }
  function saveTune(patch) {
    // Show the change right away (the drawing and Live input follow the slider); save a moment later,
    // because a slider fires an input event for every pixel.
    S = { ...(S || {}), ...patch };
    TUNE_SAVE.pending = { ...TUNE_SAVE.pending, ...patch };
    syncDeadzoneRings();
    clearTimeout(TUNE_SAVE.timer);
    TUNE_SAVE.timer = setTimeout(() => {
      const pending = TUNE_SAVE.pending;
      TUNE_SAVE.pending = {};
      Promise.resolve(ff.setSettings(pending)).then((s) => { if (s && !s._error) S = s; }).catch(() => {});
    }, 180);
  }
  function bindTune(id, key, max, onInput) {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      const v = clampPct(el.value, max);
      if (v === null) return;
      const out = $(`${id}Val`);
      if (out) out.textContent = `${v}%`;
      saveTune({ [key]: v });
      if (onInput) onInput(v);
    });
  }

  /* ---------- Animated aim-curve preview ---------- */
  // A small graph of the response from the centre to the edge: dashed = linear, yellow = the current
  // cubic, dot = a sweep along the curve. It animates whenever the cubic slider changes.
  const CURVE_GRAPH = { x0: 20, y0: 112, x1: 240, y1: 16, samples: 56, sweep: 900 };
  const curveAnim = { shownL: 0.6, targetL: 0.6, shownR: 0.6, targetR: 0.6, active: false, start: 0 };
  const curveNodes = { pathL: null, pathR: null, dotL: null, dotR: null, caption: null };

  function curveOutput(t, cubic) {
    return (1 - cubic) * t + cubic * t * t * t;
  }
  function curvePath(cubic) {
    const { x0, y0, x1, y1, samples } = CURVE_GRAPH;
    let d = '';
    for (let i = 0; i <= samples; i++) {
      const t = i / samples;
      const x = x0 + t * (x1 - x0);
      const y = y0 - curveOutput(t, cubic) * (y0 - y1);
      d += `${i ? 'L' : 'M'}${x.toFixed(2)} ${y.toFixed(2)}`;
    }
    return d;
  }
  function curveWord(cubic) {
    const v = Math.round(cubic * 100);
    if (v === 0) return 'linear';
    if (v === 100) return 'full cubic';
    return `${v}% cubic`;
  }
  function curveCaption(left, right) {
    return `Left: ${curveWord(left)} · Right: ${curveWord(right)}`;
  }
  function placeDot(dot, t, cubic) {
    if (!dot) return;
    const x = CURVE_GRAPH.x0 + t * (CURVE_GRAPH.x1 - CURVE_GRAPH.x0);
    const y = CURVE_GRAPH.y0 - curveOutput(t, cubic) * (CURVE_GRAPH.y0 - CURVE_GRAPH.y1);
    dot.setAttribute('cx', x.toFixed(2));
    dot.setAttribute('cy', y.toFixed(2));
  }
  function drawCurve(dotT) {
    if (!curveNodes.pathL) return;
    const left = curveAnim.shownL;
    const right = curveAnim.shownR;
    curveNodes.pathL.setAttribute('d', curvePath(left));
    if (curveNodes.pathR) curveNodes.pathR.setAttribute('d', curvePath(right));
    const t = Math.max(0, Math.min(1, dotT));
    placeDot(curveNodes.dotL, t, left);
    placeDot(curveNodes.dotR, t, right);
    if (curveNodes.caption) {
      const text = curveCaption(left, right);
      if (curveNodes.caption.textContent !== text) curveNodes.caption.textContent = text;
    }
  }
  function buildCurvePreview() {
    curveNodes.pathL = $('#padCurvePathL');
    curveNodes.pathR = $('#padCurvePathR');
    curveNodes.dotL = $('#padCurveDotL');
    curveNodes.dotR = $('#padCurveDotR');
    curveNodes.caption = $('#padCurveCaption');
    curveAnim.shownL = curve('l');
    curveAnim.shownR = curve('r');
    curveAnim.targetL = curveAnim.shownL;
    curveAnim.targetR = curveAnim.shownR;
    curveAnim.active = false;
    drawCurve(0.55);
  }
  function previewCurve(axis, v) {
    const now = performance.now();
    if (!curveAnim.active) curveAnim.start = now;
    curveAnim.active = true;
    const target = clampPct(v, CURVE_MAX) / 100;
    if (axis === 'r') curveAnim.targetR = target;
    else curveAnim.targetL = target;
  }
  function easeCurve(shown, target) {
    const diff = target - shown;
    return Math.abs(diff) < 0.001 ? target : shown + diff * 0.18;
  }
  function animateCurve(now) {
    if (!curveAnim.active) return;
    curveAnim.shownL = easeCurve(curveAnim.shownL, curveAnim.targetL);
    curveAnim.shownR = easeCurve(curveAnim.shownR, curveAnim.targetR);
    const t = Math.min(1, Math.max(0, (now - curveAnim.start) / CURVE_GRAPH.sweep));
    drawCurve(t);
    if (t >= 1 && Math.abs(curveAnim.targetL - curveAnim.shownL) < 0.001 && Math.abs(curveAnim.targetR - curveAnim.shownR) < 0.001) {
      curveAnim.active = false;
    }
  }

  /* ---------- Rendering ---------- */
  const UI = { model: null, timer: null, raf: null, detected: null, lastLive: '', stage: null, read: null };

  function chosenModel() {
    const c = (S && S.controllerType) || 'auto';
    const legacy = { xbox: 'xbox-series', playstation: 'dualsense' };
    if (legacy[c]) return legacy[c];
    if (MODELS[c]) return c;
    return autoModel() || 'xbox-series';
  }
  function autoModel() {
    const kinds = [...hid.keys()].map(kindOf).filter(Boolean);
    if (kinds.includes('joycon-l') && kinds.includes('joycon-r')) return 'joycon-pair';
    if (kinds.length) return kinds[0];
    const d = UI.detected;
    if (d && d.devices.length) {
      const ms = d.devices.map((x) => x.model);
      if (ms.includes('joycon-l') && ms.includes('joycon-r')) return 'joycon-pair';
      return ms[0] || 'generic';
    }
    const gp = gamepad();
    if (gp) {
      if (/054c/i.test(gp.id)) return 'dualsense';
      if (/057e/i.test(gp.id)) return 'switch-pro';
      if (/045e|xbox|xinput/i.test(gp.id)) return 'xbox-series';
      return 'generic';
    }
    return null;
  }
  function gamepad() {
    const pads = (navigator.getGamepads ? [...navigator.getGamepads()] : []).filter(Boolean);
    return pads.find((p) => p.mapping === 'standard') || pads[0] || null;
  }

  function build(modelId) {
    const M = MODELS[modelId];
    const labels = labelsFor(modelId);
    const parts = M.parts();
    const stage = $('#padStage');
    stage.innerHTML = parts
      .map((p, i) => `<div class="pad-part" data-part="${i}" data-side="${p.side || ''}"><svg viewBox="${p.view}" class="pad-svg ${p.side ? 'joycon' : ''}" role="img" aria-label="${esc(M.name)}">${drawPart(p, labels)}</svg></div>`)
      .join('');
    $('#padDiagramTitle').textContent = M.name;
    $('#padKeys').innerHTML = ACTIONS.map(([act, key]) => `<tr><td>${esc(act)}</td><td>${chip(M.family, labels[key], key)}</td></tr>`).join('');
    $('#padRecenter').classList.toggle('hidden', !M.motion);
    UI.model = modelId;
    // Cache the nodes the live paint touches and build the readout rows once. A running controller then costs
    // no DOM queries and no re-renders at all — only the numbers that actually changed get written.
    UI.stage = {
      keys: [...stage.querySelectorAll('.pad-key')],
      fills: [...stage.querySelectorAll('.pad-fill')],
      trigs: [...stage.querySelectorAll('.pad-trig')],
      trigTexts: [...stage.querySelectorAll('.pad-trig-text')],
      sticks: [...stage.querySelectorAll('.pad-stick')],
      touches: [...stage.querySelectorAll('.pad-touch')],
      rings: [...stage.querySelectorAll('.pad-deadzone')],
    };
    syncDeadzoneRings();
    buildReadout(!!M.motion);
  }
  function chip(family, label, key) {
    const f = FACE[family] && FACE[family][key];
    return f ? `<i class="pad-logo" style="color:${f[1]}">${esc(label)}</i>` : `<i class="pad-logo plain">${esc(label)}</i>`;
  }

  const setText = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };
  const setWidth = (el, v) => { if (el && el.style.width !== v) el.style.width = v; };
  const setAttr = (el, name, v) => { const s = String(v); if (el && el.getAttribute(name) !== s) el.setAttribute(name, s); };

  function buildReadout(motion) {
    const labels = labelsFor(UI.model);
    const host = $('#padReadout');
    host.innerHTML = '';
    const row = (label) => {
      const r = document.createElement('div');
      r.className = 'pad-row';
      const l = document.createElement('span');
      l.textContent = label;
      const v = document.createElement('b');
      r.append(l, v);
      host.appendChild(r);
      return { row: r, value: v };
    };
    const barRow = (label) => {
      const r = document.createElement('div');
      r.className = 'pad-row';
      const l = document.createElement('span');
      l.textContent = label;
      const bar = document.createElement('span');
      bar.className = 'pad-bar';
      const fill = document.createElement('i');
      bar.appendChild(fill);
      const v = document.createElement('b');
      r.append(l, bar, v);
      host.appendChild(r);
      return { row: r, fill, value: v };
    };
    const read = { ls: row('Left stick'), rs: row('Right stick'), tuneL: row('Left tuning'), tuneR: row('Right tuning'), lt: barRow(labels.lt), rt: barRow(labels.rt), pressed: row('Pressed') };
    if (motion) {
      read.motion = row('Motion');
      read.motion.value.className = 'muted';
      read.tilt = row('Tilt');
      read.gyro = row('Turning speed');
      read.tilt.row.hidden = true;
      read.gyro.row.hidden = true;
    }
    UI.read = read;
  }

  // Trigger label text: "LT 37%". Clamped so a noisy pad cannot print 101 %.
  const triggerLabel = (label, v) => `${label} ${Math.round(Math.max(0, Math.min(1, Number(v) || 0)) * 100)}%`;

  // Gamepad API buttons: LT/RT keep their analog value; the rest are digital. Some pads report
  // `pressed` true for a partly pulled trigger, which used to snap the drawing to 100 %.
  function gamepadButton(k, b) {
    if (!b) return 0;
    const raw = Number.isFinite(b.value) ? b.value : b.pressed ? 1 : 0;
    const value = Math.max(0, Math.min(1, raw));
    if (k === 'lt' || k === 'rt') return value;
    return b.pressed ? 1 : value;
  }

  // The state to show: the HID devices for the model (merged for a Joy-Con pair), else the Gamepad API.
  function liveStates(modelId) {
    const now = performance.now();
    const fresh = [...hid.values()].filter((s) => now - s.at < 600);
    const want = modelId === 'joycon-pair' ? ['joycon-l', 'joycon-r'] : [modelId];
    const famOf = (k) => (MODELS[k] ? MODELS[k].family : '');
    let picked = fresh.filter((s) => want.includes(s.kind));
    if (!picked.length) picked = fresh.filter((s) => famOf(s.kind) === MODELS[modelId].family);
    if (!picked.length) picked = fresh; // another pad than the one picked: still show its input, button by position
    if (picked.length) return { source: 'hid', states: picked };
    const gp = gamepad();
    if (!gp) return { source: null, states: [] };
    const st = newState('gamepad');
    const keys = ['s', 'e', 'w', 'n', 'lb', 'rb', 'lt', 'rt', 'back', 'start', 'l3', 'r3', 'up', 'down', 'left', 'right', 'guide', 'extra'];
    keys.forEach((k, i) => {
      st.buttons[k] = gamepadButton(k, gp.buttons[i]);
    });
    st.axes = { lx: gp.axes[0] || 0, ly: gp.axes[1] || 0, rx: gp.axes[2] || 0, ry: gp.axes[3] || 0 };
    st.name = gp.id.replace(/\s*\(.*\)$/, '');
    return { source: 'gamepad', states: [st] };
  }

  function paint() {
    if (!UI.raf) return;
    const modelId = chosenModel();
    if (modelId !== UI.model) build(modelId);
    const { source, states } = liveStates(modelId);
    const merged = { buttons: {}, axes: { lx: 0, ly: 0, rx: 0, ry: 0 }, touch: [null, null] };
    for (const s of states) {
      for (const [k, v] of Object.entries(s.buttons)) merged.buttons[k] = Math.max(merged.buttons[k] || 0, v);
      for (const k of ['lx', 'ly', 'rx', 'ry']) if (Math.abs(s.axes[k]) > Math.abs(merged.axes[k])) merged.axes[k] = s.axes[k];
      s.touch.forEach((t, i) => { if (t) merged.touch[i] = t; });
    }
    // Trigger deadzones apply to whichever controller/source is being shown, before anything is drawn.
    merged.buttons.lt = triggerShaped(merged.buttons.lt, triggerDeadzone('l'));
    merged.buttons.rt = triggerShaped(merged.buttons.rt, triggerDeadzone('r'));
    // Apply the saved deadzone and per-stick cubic curve: this is what the sticks and the Live input show.
    const cubicL = curve('l');
    const cubicR = curve('r');
    const dzL = deadzone('l');
    const dzR = deadzone('r');
    const shape = deadzoneShape();
    const left = shapeStick(merged.axes.lx, merged.axes.ly, dzL, cubicL, shape);
    const right = shapeStick(merged.axes.rx, merged.axes.ry, dzR, cubicR, shape);
    const shown = { lx: left.x, ly: left.y, rx: right.x, ry: right.y };
    const stage = UI.stage || { keys: [], fills: [], trigs: [], trigTexts: [], sticks: [], touches: [] };
    for (const g of stage.keys) g.classList.toggle('pressed', (merged.buttons[g.dataset.k] || 0) > 0.5);
    for (const r of stage.fills) {
      const full = Number(r.previousElementSibling.getAttribute('width'));
      setAttr(r, 'width', (merged.buttons[r.dataset.fill] || 0) * full);
    }
    // The bright marker follows the exact analog trigger position, so slow partial presses are visible.
    for (const c of stage.trigs) {
      const v = Math.max(0, Math.min(1, merged.buttons[c.dataset.trig] || 0));
      setAttr(c, 'cx', (Number(c.dataset.x) + v * Number(c.dataset.w)).toFixed(2));
      c.classList.toggle('on', v > 0.01);
    }
    for (const t of stage.trigTexts) {
      const v = Math.max(0, Math.min(1, merged.buttons[t.dataset.trigText] || 0));
      setText(t, triggerLabel(t.dataset.label, v));
    }
    for (const c of stage.sticks) {
      const ax = c.dataset.stick;
      setAttr(c, 'cx', (Number(c.dataset.cx) + shown[ax + 'x'] * 14).toFixed(2));
      setAttr(c, 'cy', (Number(c.dataset.cy) + shown[ax + 'y'] * 14).toFixed(2));
    }
    for (const c of stage.touches) {
      const t = merged.touch[Number(c.dataset.touch)];
      if (t) {
        setAttr(c, 'cx', (Number(c.dataset.x) + t.x * Number(c.dataset.w)).toFixed(2));
        setAttr(c, 'cy', (Number(c.dataset.y) + t.y * Number(c.dataset.h)).toFixed(2));
      }
      c.classList.toggle('on', !!t);
    }
    // The drawing stays fixed on screen: motion sensors only feed the Live input numbers.
    animateCurve(performance.now());
    readout(merged, shown, states, source);
    UI.raf = requestAnimationFrame(paint);
  }

  const pct = (v) => `${Math.round(v * 100)}%`;
  const num = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2);
  function readout(m, shown, states, source) {
    const R = UI.read;
    if (!R) return;
    const labels = labelsFor(UI.model);
    const motionSt = states.find((s) => s.motion);
    const tilt = motionSt ? tiltAngles(motionSt) : null;
    const pressed = Object.entries(m.buttons).filter(([k, v]) => v > 0.5 && labels[k] !== undefined).map(([k]) => labels[k]);
    const dirs = ['up', 'down', 'left', 'right'].filter((k) => m.buttons[k] > 0.5).map((k) => `D-pad ${k}`);
    setText(R.ls.value, `X ${num(shown.lx)} · Y ${num(shown.ly)}`);
    setText(R.rs.value, `X ${num(shown.rx)} · Y ${num(shown.ry)}`);
    if (R.tuneL) setText(R.tuneL.value, `deadzone ${Math.round(deadzone('l') * 100)}% ${deadzoneShape()} · curve ${Math.round(curve('l') * 100)}%`);
    if (R.tuneR) setText(R.tuneR.value, `deadzone ${Math.round(deadzone('r') * 100)}% ${deadzoneShape()} · curve ${Math.round(curve('r') * 100)}%`);
    const lt = pct(m.buttons.lt || 0);
    const rt = pct(m.buttons.rt || 0);
    setWidth(R.lt.fill, lt);
    setText(R.lt.value, lt);
    setWidth(R.rt.fill, rt);
    setText(R.rt.value, rt);
    setText(R.pressed.value, [...pressed, ...dirs].join(', ') || '—');
    if (R.tilt) {
      if (tilt) {
        setText(R.tilt.value, `forward ${Math.round(tilt.pitch) || 0}° · side ${Math.round(tilt.roll) || 0}° · turn ${Math.round(tilt.yaw) || 0}°`);
        setText(R.gyro.value, `${motionSt.gyro.map((v) => Math.round(v) || 0).join(' / ')} °/s`);
        R.tilt.row.hidden = false;
        R.gyro.row.hidden = false;
        R.motion.row.hidden = true;
      } else {
        setText(R.motion.value, source === 'gamepad' ? 'Not available through this connection' : 'Waiting for the controller…');
        R.tilt.row.hidden = true;
        R.gyro.row.hidden = true;
        R.motion.row.hidden = false;
      }
    }
    const live = states.length ? `Live: ${states.map((s) => s.name || MODELS[s.kind]?.name || 'Controller').join(' + ')}${source === 'hid' ? ' (read directly by FrameForge)' : ''}. Press buttons, move the sticks and triggers${MODELS[UI.model].motion && source === 'hid' ? ', and tilt the controller' : ''}.` : 'Press any button on your controller to test it here.';
    if (live !== UI.lastLive) {
      UI.lastLive = live;
      $('#padLive').textContent = live;
    }
  }

  function renderInfo() {
    const d = UI.detected;
    const found = d && d.devices.length ? d.devices : [];
    const fam = { playstation: 'PlayStation', xbox: 'Xbox', nintendo: 'Nintendo', other: 'Other' };
    $('#padConnected').innerHTML = found.length
      ? found.map((c) => `<div class="pad-dev"><b>${esc(c.name)}</b><span class="tag ${c.family === 'playstation' ? 'rec' : 'admin'}">${fam[c.family] || 'Other'}</span><span class="muted">${esc(c.connection)}</span></div>`).join('')
      : '<p class="muted">No controller found yet. Plug one in or connect it by Bluetooth. You can still pick one below.</p>';
    const sel = $('#padModel');
    const choice = (S && S.controllerType) || 'auto';
    sel.value = MODELS[choice] || choice === 'auto' ? choice : { xbox: 'xbox-series', playstation: 'dualsense' }[choice] || 'auto';
    const auto = autoModel();
    $('#padAutoSub').textContent = choice === 'auto' ? (auto ? `Showing: ${MODELS[auto].name}` : 'Nothing plugged in yet, showing an Xbox controller') : '';
    // What games will show: the buttons of the controller Windows hands them.
    const model = MODELS[chosenModel()];
    const see = d ? d.gamesSee : null;
    const want = { xbox: 'xbox', ps: 'playstation', nin: 'nintendo', gen: 'other' }[model.family];
    const label = { xbox: 'Xbox', playstation: 'PlayStation', nintendo: 'Nintendo', other: 'generic' };
    let msg;
    if (!see) msg = `Showing the <b>${esc(model.name)}</b>. Connect a controller to test it live.`;
    else if (see === want) msg = `<span class="ok">✓</span> Your games show <b>${label[see]}</b> buttons for this controller.`;
    else msg = `<span class="warn">!</span> Windows hands your games a <b>${label[see] || 'generic'}</b>-style controller, so games show ${label[see] || 'their own'} buttons. The drawing shows your <b>${esc(model.name)}</b>.`;
    $('#padStatus').innerHTML = msg;
  }

  async function refresh() {
    try {
      UI.detected = await ff.controllers.detect();
    } catch {
      UI.detected = null;
    }
    await startHid();
    if (chosenModel() !== UI.model) build(chosenModel());
    renderInfo();
  }

  function open() {
    syncTuneControls();
    buildCurvePreview();
    refresh();
    clearInterval(UI.timer);
    UI.timer = setInterval(refresh, 6000);
    if (!UI.raf) UI.raf = requestAnimationFrame(paint);
  }
  function close() {
    clearInterval(UI.timer);
    UI.timer = null;
    if (UI.raf) cancelAnimationFrame(UI.raf);
    UI.raf = null;
    // Stop reading the pads while the tab is closed: no background work, and motion starts fresh next time.
    for (const dev of hid.keys()) dev.close().catch(() => {});
    hid.clear();
  }

  $$('.nav-item').forEach((b) => b.addEventListener('click', () => (b.dataset.view === 'controller' ? open() : close())));
  $('#padRefresh').onclick = refresh;
  $('#padRecenter').onclick = () => {
    for (const s of hid.values()) if (s.motion) s.ref = s.q.slice();
  };
  $('#padModel').addEventListener('change', async (e) => {
    S = await ff.setSettings({ controllerType: e.target.value });
    build(chosenModel());
    renderInfo();
  });
  window.addEventListener('gamepadconnected', () => { if (UI.raf) refresh(); });
  window.addEventListener('gamepaddisconnected', () => { if (UI.raf) refresh(); });
  bindTune('#padDzL', 'padDeadzoneL', DZ_MAX);
  bindTune('#padDzR', 'padDeadzoneR', DZ_MAX);
  bindTune('#padTdzL', 'padTriggerDeadzoneL', TRIGGER_DZ_MAX);
  bindTune('#padTdzR', 'padTriggerDeadzoneR', TRIGGER_DZ_MAX);
  bindTune('#padCurveL', 'padCurveL', CURVE_MAX, (v) => previewCurve('l', v));
  bindTune('#padCurveR', 'padCurveR', CURVE_MAX, (v) => previewCurve('r', v));
  const shapeEl = $('#padDzShape');
  if (shapeEl) shapeEl.addEventListener('change', () => {
    const shape = DZ_SHAPES.includes(shapeEl.value) ? shapeEl.value : 'square';
    saveTune({ padDeadzoneShape: shape });
  });

  return { MODELS, hid, chosenModel, parseDualSense, parseDualShock4, parseSwitch, newState, fuse, tiltAngles, axialDeadzone, shapeAxis, shapeStick, deadzonePath, deadzoneShape, triggerShaped, triggerDeadzone, curveOutput, gamepadButton, triggerLabel, deadzone, curve, ringRadius };
})();
