// The in-game overlay, as plain text in → HTML out, so the real overlay window, the live preview on the
// FPS limiter tab and the tests all draw exactly the same thing.
//
// Nothing here measures anything: it formats the readings FrameForge already has. A reading this PC's sensors
// don't report (fan speed on some cards, power on others) is left out — never shown as a made-up number.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FFOverlay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  /** Everything the overlay can show. `needs`: which switch has to be on for it to have data. */
  const ITEMS = [
    { id: 'fps', label: 'FPS', needs: 'fps', hint: 'Frames per second, right now' },
    { id: 'low', label: '1% low', needs: 'fps', hint: 'The slowest 1% of frames — what stutter feels like' },
    { id: 'frametime', label: 'Frame time', needs: 'fps', hint: 'Milliseconds per frame' },
    { id: 'graph', label: 'FPS graph', needs: 'fps', hint: 'The last minute as a line' },
    { id: 'stability', label: 'FPS stability', needs: 'fps', hint: 'A live line against your recent FPS baseline; green is steady, red is a change' },
    { id: 'cap', label: 'FPS cap', needs: 'fps', hint: 'Your limiter’s number, while the limiter is on' },
    { id: 'game', label: 'Game name', needs: 'fps', hint: 'Which program is being measured' },
    { id: 'gpuTemp', label: 'GPU temperature', needs: 'sensors' },
    { id: 'gpuLoad', label: 'GPU load', needs: 'sensors' },
    { id: 'vram', label: 'Video memory', needs: 'sensors' },
    { id: 'gpuPower', label: 'GPU power', needs: 'sensors', hint: 'Watts' },
    { id: 'gpuFan', label: 'GPU fan', needs: 'sensors', hint: 'RPM' },
    { id: 'gpuClock', label: 'GPU clock', needs: 'sensors', hint: 'MHz' },
    { id: 'cpuTemp', label: 'CPU temperature', needs: 'sensors' },
    { id: 'cpuLoad', label: 'CPU load', needs: 'sensors' },
    { id: 'cpuPower', label: 'CPU power', needs: 'sensors', hint: 'Watts' },
    { id: 'ram', label: 'Memory (RAM)', needs: 'sensors' },
    { id: 'meters', label: 'Load bars', needs: 'sensors', hint: 'The small bars next to load and memory (Panel style)' },
    { id: 'time', label: 'Clock', needs: null, hint: 'Time of day' },
  ];
  const IDS = ITEMS.map((i) => i.id);
  const STYLES = ['panel', 'list', 'bar', 'mini'];
  const FONTS = ['orbitron', 'rajdhani', 'mono'];
  const CORNERS = ['notch', 'round', 'square'];
  const POSITIONS = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
  const ACCENTS = ['#ff6b2c', '#3fd8ff', '#57e389', '#b78cff', '#ff4d6d', '#ffd166', '#ffffff'];
  const DEFAULTS = {
    overlayStyle: 'panel',
    overlayItems: ['fps', 'low', 'frametime', 'graph', 'cap', 'gpuTemp', 'gpuLoad', 'vram', 'gpuPower', 'gpuFan', 'cpuTemp', 'cpuLoad', 'ram', 'meters'],
    overlayAccent: '#ff6b2c',
    overlayScale: 100, // % of normal size
    overlayOpacity: 80, // % background darkness; 0 = text only
    overlayFont: 'orbitron',
    overlayCorner: 'notch',
    overlayMargin: 14, // px from the screen edge
  };

  const clamp = (v, lo, hi, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };
  /** Any stored or typed settings → values that are safe to draw. Unknown or broken values fall back to the default. */
  function normalize(s) {
    const src = s || {};
    const items = Array.isArray(src.overlayItems) ? IDS.filter((id) => src.overlayItems.includes(id)) : DEFAULTS.overlayItems.slice();
    return {
      overlayStyle: STYLES.includes(src.overlayStyle) ? src.overlayStyle : DEFAULTS.overlayStyle,
      overlayItems: items,
      overlayAccent: /^#[0-9a-f]{6}$/i.test(String(src.overlayAccent || '')) ? String(src.overlayAccent).toLowerCase() : DEFAULTS.overlayAccent,
      overlayScale: clamp(src.overlayScale, 60, 200, DEFAULTS.overlayScale),
      overlayOpacity: clamp(src.overlayOpacity, 0, 100, DEFAULTS.overlayOpacity),
      overlayFont: FONTS.includes(src.overlayFont) ? src.overlayFont : DEFAULTS.overlayFont,
      overlayCorner: CORNERS.includes(src.overlayCorner) ? src.overlayCorner : DEFAULTS.overlayCorner,
      overlayMargin: clamp(src.overlayMargin, 0, 300, DEFAULTS.overlayMargin),
    };
  }

  const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const has = (v) => v != null && Number.isFinite(Number(v));
  const heat = (t) => (t >= 88 ? ' ffo-hot' : t >= 78 ? ' ffo-warm' : '');
  const gb = (mbytes) => {
    const g = mbytes / 1024;
    return g >= 10 ? String(Math.round(g)) : g.toFixed(1);
  };
  const pct = (v) => Math.max(0, Math.min(100, Math.round(v)));

  /** Keep the last minute of FPS for the graph. Call once per reading. */
  function push(state, stats) {
    const f = stats && stats.fpsEnabled && stats.fps && stats.fps.fps > 0 ? stats.fps.fps : null;
    state.hist.push(f);
    if (state.hist.length > 60) state.hist.shift();
    return state;
  }
  /** Keep forty live FPS samples (about ten seconds at the reader's 4 Hz update rate). */
  function pushStability(state, stats) {
    const f = stats && stats.fpsEnabled && stats.fps && Number(stats.fps.fps) > 0 ? Number(stats.fps.fps) : null;
    if (!state.stability) state.stability = [];
    if (f == null) {
      state.stability = [];
    } else {
      const app = String(stats.fps.app || '').toLowerCase();
      if (state.stability.length && state.stability[state.stability.length - 1].app !== app) state.stability = [];
      const recent = state.stability.slice(-19).map((sample) => sample.fps).sort((a, b) => a - b);
      const mid = Math.floor(recent.length / 2);
      const reference = recent.length ? (recent.length % 2 ? recent[mid] : (recent[mid - 1] + recent[mid]) / 2) : f;
      const steady = Math.abs(f - reference) <= Math.max(3, reference * 0.05);
      state.stability.push({ fps: f, reference, steady, app });
    }
    if (state.stability.length > 40) state.stability.splice(0, state.stability.length - 40);
    return state;
  }
  function createState() {
    return { hist: [], stability: [] };
  }

  function graph(hist) {
    const vals = hist.filter((v) => v != null);
    if (vals.length < 2) return '<svg class="ffo-graph" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"></svg>';
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = Math.max(max - min, Math.max(10, max * 0.15));
    const lo = Math.max(0, min - span * 0.35);
    const hi = max + span * 0.2;
    const n = Math.max(hist.length, 2);
    const pts = [];
    hist.forEach((v, i) => {
      if (v == null) return;
      const x = (i * 100) / (n - 1);
      const y = 23 - ((v - lo) / (hi - lo)) * 22;
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
    });
    const first = pts[0].split(',')[0];
    const lastX = pts[pts.length - 1].split(',')[0];
    return `<svg class="ffo-graph" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"><polygon class="ffo-graph-fill" points="${first},24 ${pts.join(' ')} ${lastX},24"/><polyline class="ffo-graph-line" points="${pts.join(' ')}"/></svg>`;
  }

  function stabilityModel(samples, fps) {
    const valid = (samples || []).filter(Boolean).slice(-40);
    const last = valid[valid.length - 1];
    if (!fps || !last) return { waiting: true, consistent: false, label: 'No game', samples: valid };
    return { waiting: false, consistent: last.steady, label: valid.length < 5 ? 'Measuring' : last.steady ? 'Consistent' : 'Not consistent', samples: valid };
  }

  function stabilityBox(s) {
    if (!s) return '';
    const values = s.samples.flatMap((v) => [v.fps, v.reference]);
    const loValue = values.length ? Math.min(...values) : 0;
    const hiValue = values.length ? Math.max(...values) : 1;
    const pad = Math.max(4, (hiValue - loValue) * 0.25);
    const lo = loValue - pad;
    const span = Math.max(1, hiValue - loValue + pad * 2);
    const y = (v) => (22 - ((v - lo) / span) * 20).toFixed(1);
    const point = (i, v, n) => `${(n > 1 ? (i * 100) / (n - 1) : 50).toFixed(1)},${y(v)}`;
    const refPoints = s.samples.map((v, i, a) => point(i, v.reference, a.length)).join(' ');
    const lines = s.samples.slice(1).map((v, j) => {
      const a = s.samples[j];
      const n = s.samples.length;
      const x1 = n > 1 ? (j * 100) / (n - 1) : 50;
      const x2 = n > 1 ? ((j + 1) * 100) / (n - 1) : 50;
      return `<line class="ffo-stability-live ${v.steady ? 'ffo-stable' : 'ffo-unstable'}" x1="${x1.toFixed(1)}" y1="${y(a.fps)}" x2="${x2.toFixed(1)}" y2="${y(v.fps)}"/>`;
    }).join('');
    const status = s.waiting ? 'ffo-stability-wait' : s.consistent ? 'ffo-stable' : 'ffo-unstable';
    const svg = s.samples.length
      ? `<svg viewBox="0 0 100 24" preserveAspectRatio="none" role="img" aria-label="FPS stability line; green is the recent baseline, red marks a change"><polyline class="ffo-stability-reference" points="${refPoints}"/>${lines}</svg>`
      : '<svg viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true"></svg>';
    return `<div class="ffo-stability"><div class="ffo-stability-head"><i>FPS stability</i><b class="${status}">${esc(s.label)}</b></div>${svg}</div>`;
  }

  /** The readings as display-ready pieces, shared by every style. `on(id)`: is this item switched on and available? */
  function model(stats, cfg, opts, state) {
    const s = stats || {};
    const want = new Set(cfg.overlayItems);
    const fpsOn = !!s.fpsEnabled;
    const hwOn = !!s.tempEnabled;
    const f = fpsOn && s.fps && s.fps.fps > 0 ? s.fps : null;
    const on = (id) => want.has(id);
    const m = { fps: null, side: [], rows: [], lines: [], foot: [] };
    const line = (g, k, v, cls) => m.lines.push({ g, k, v, cls: cls || '' });
    const meters = on('meters');
    if (fpsOn && (on('fps') || on('low') || on('frametime') || on('cap') || on('graph') || on('stability'))) {
      m.fps = { show: on('fps'), value: f ? String(f.fps) : '—', idle: !f };
      if (f && on('low') && has(f.low1)) m.side.push(['1% low', String(f.low1)]);
      if (f && on('frametime')) m.side.push(['Frame', `${(1000 / f.fps).toFixed(1)} ms`]);
      if (on('cap') && has(s.cap) && s.cap > 0) m.side.push(['Cap', String(s.cap)]);
      m.graph = on('graph');
      m.stability = on('stability') ? stabilityModel(state && state.stability, f) : null;
      if (m.fps.show) line('fps', 'FPS', m.fps.value, m.fps.idle ? ' ffo-idle' : '');
      for (const [k, v] of m.side) line('fps', k === 'Frame' ? 'Frame time' : k === 'Cap' ? 'FPS cap' : k, v);
    }
    if (hwOn) {
      const gpu = { k: 'GPU', vals: [], bar: null };
      if (on('gpuTemp') && has(s.gpuTemp)) {
        gpu.vals.push({ t: `${s.gpuTemp}°`, cls: heat(s.gpuTemp) });
        line('gpu', 'GPU temp', `${s.gpuTemp} °C`, heat(s.gpuTemp));
      }
      if (on('gpuLoad') && has(s.gpuLoad)) {
        gpu.vals.push({ t: `${pct(s.gpuLoad)}%`, cls: '' });
        if (meters) gpu.bar = pct(s.gpuLoad);
        line('gpu', 'GPU load', `${pct(s.gpuLoad)} %`);
      }
      const gchips = [];
      if (on('gpuPower') && has(s.gpuPower)) gchips.push(`${Math.round(s.gpuPower)} W`);
      if (on('gpuFan') && has(s.gpuFan)) gchips.push(`${Math.round(s.gpuFan)} RPM`);
      if (on('gpuClock') && has(s.gpuClock)) gchips.push(`${Math.round(s.gpuClock)} MHz`);
      if (gpu.vals.length || gchips.length) m.rows.push({ ...gpu, chips: gchips });
      if (on('vram') && has(s.vramUsed)) {
        const total = has(s.vramTotal) && s.vramTotal >= s.vramUsed ? s.vramTotal : null;
        const t = total ? `${gb(s.vramUsed)} / ${gb(total)} GB` : `${gb(s.vramUsed)} GB`;
        m.rows.push({ k: 'VRAM', vals: [{ t, cls: '' }], bar: total && meters ? pct((s.vramUsed / total) * 100) : null, chips: [] });
        line('gpu', 'GPU memory', t);
      }
      if (on('gpuPower') && has(s.gpuPower)) line('gpu', 'GPU power', `${Math.round(s.gpuPower)} W`);
      if (on('gpuFan') && has(s.gpuFan)) line('gpu', 'GPU fan', `${Math.round(s.gpuFan)} RPM`);
      if (on('gpuClock') && has(s.gpuClock)) line('gpu', 'GPU clock', `${Math.round(s.gpuClock)} MHz`);
      const cpu = { k: 'CPU', vals: [], bar: null };
      if (on('cpuTemp') && has(s.cpuTemp)) {
        cpu.vals.push({ t: `${s.cpuTemp}°`, cls: heat(s.cpuTemp) });
        line('cpu', 'CPU temp', `${s.cpuTemp} °C`, heat(s.cpuTemp));
      }
      if (on('cpuLoad') && has(s.cpuLoad)) {
        cpu.vals.push({ t: `${pct(s.cpuLoad)}%`, cls: '' });
        if (meters) cpu.bar = pct(s.cpuLoad);
        line('cpu', 'CPU load', `${pct(s.cpuLoad)} %`);
      }
      const cchips = on('cpuPower') && has(s.cpuPower) ? [`${Math.round(s.cpuPower)} W`] : [];
      if (cchips.length) line('cpu', 'CPU power', cchips[0]);
      if (cpu.vals.length || cchips.length) m.rows.push({ ...cpu, chips: cchips });
      if (on('ram') && has(s.ramUsed)) {
        const total = has(s.ramTotal) && s.ramTotal > 0 ? s.ramTotal : null;
        const u = Number(s.ramUsed);
        const t = total ? `${u.toFixed(1)} / ${Math.round(total)} GB` : `${u.toFixed(1)} GB`;
        m.rows.push({ k: 'RAM', vals: [{ t, cls: '' }], bar: total && meters ? pct((u / total) * 100) : null, chips: [] });
        line('cpu', 'RAM', t);
      }
    }
    if (fpsOn && on('game') && f && f.app) {
      m.foot.push(String(f.app).slice(0, 28));
      line('sys', 'Game', String(f.app).slice(0, 22));
    }
    if (on('time')) {
      const d = (opts && opts.now) || new Date();
      const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      m.foot.push(t);
      line('sys', 'Time', t);
    }
    return m;
  }

  function panel(m, state) {
    let out = '';
    if (m.fps) {
      const side = m.side.map(([k, v]) => `<span><i>${esc(k)}</i><b>${esc(v)}</b></span>`).join('');
      if (m.fps.show || side) out += `<div class="ffo-top">${m.fps.show ? `<div class="ffo-num${m.fps.idle ? ' ffo-idle' : ''}"><b>${esc(m.fps.value)}</b><span>FPS</span></div>` : ''}${side ? `<div class="ffo-side">${side}</div>` : ''}</div>`;
      if (m.graph) out += graph(state.hist);
      if (m.stability) out += stabilityBox(m.stability);
    }
    if (m.rows.length) {
      out += `<div class="ffo-rows">${m.rows
        .map(
          (r) =>
            `<div class="ffo-row"><span class="ffo-k">${r.k}</span><span class="ffo-vals">${r.vals.map((v) => `<b class="ffo-v${v.cls}">${esc(v.t)}</b>`).join('')}</span>${r.bar != null ? `<span class="ffo-meter"><i style="width:${r.bar}%"></i></span>` : '<span></span>'}</div>${r.chips.length ? `<div class="ffo-chips">${r.chips.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}`
        )
        .join('')}</div>`;
    }
    if (m.foot.length) out += `<div class="ffo-foot">${m.foot.map((t) => `<span>${esc(t)}</span>`).join('')}</div>`;
    return out;
  }

  /** One reading per line, label left and value right — the classic monitoring-overlay layout. */
  function list(m, state) {
    let out = '';
    let prev = null;
    for (const l of m.lines) {
      out += `<div class="ffo-line${l.k === 'FPS' ? ' ffo-line-fps' : ''}${prev && prev !== l.g ? ' ffo-sep' : ''}"><i>${esc(l.k)}</i><b class="ffo-v${l.cls}">${esc(l.v)}</b></div>`;
      prev = l.g;
    }
    if (out && m.fps && m.graph) out += graph(state.hist);
    if (m.stability) out += stabilityBox(m.stability);
    return out;
  }

  function bar(m) {
    const seg = [];
    if (m.fps) {
      const side = m.side.map(([k, v]) => `<span class="ffo-s"><i>${esc(k)}</i><b>${esc(v)}</b></span>`).join('');
      seg.push(`${m.fps.show ? `<span class="ffo-num${m.fps.idle ? ' ffo-idle' : ''}"><b>${esc(m.fps.value)}</b><span>FPS</span></span>` : ''}${side}`);
    }
    for (const r of m.rows) {
      seg.push(`<span class="ffo-s"><i>${r.k}</i>${r.vals.map((v) => `<b class="ffo-v${v.cls}">${esc(v.t)}</b>`).join('')}${r.chips.map((c) => `<b class="ffo-v ffo-dim">${esc(c)}</b>`).join('')}</span>`);
    }
    for (const t of m.foot) seg.push(`<span class="ffo-s"><b class="ffo-v ffo-dim">${esc(t)}</b></span>`);
    const content = seg.filter(Boolean).map((x) => `<div class="ffo-seg">${x}</div>`).join('');
    return `<div class="ffo-bar-content">${content}</div>${m.stability ? stabilityBox(m.stability) : ''}`;
  }

  function mini(m) {
    let out = '';
    if (m.fps && m.fps.show) out += `<div class="ffo-num${m.fps.idle ? ' ffo-idle' : ''}"><b>${esc(m.fps.value)}</b><span>FPS</span></div>`;
    const small = [];
    if (m.fps) for (const [k, v] of m.side) small.push(`<span><i>${esc(k)}</i><b>${esc(v)}</b></span>`);
    for (const r of m.rows) if (r.vals.length) small.push(`<span><i>${r.k}</i>${r.vals.map((v) => `<b class="ffo-v${v.cls}">${esc(v.t)}</b>`).join('')}</span>`);
    for (const t of m.foot) small.push(`<span><b>${esc(t)}</b></span>`);
    if (small.length) out += `<div class="ffo-minirows">${small.join('')}</div>`;
    if (m.stability) out += stabilityBox(m.stability);
    return out;
  }

  /**
   * The whole overlay as an HTML string (empty string when there is nothing to show).
   * @param {object} stats  one `stats` message from the main process
   * @param {object} settings  the app's settings (only the overlay* keys are read)
   * @param {{hist: (number|null)[]}} state  from createState(), fed by push()
   */
  function html(stats, settings, state, opts) {
    const cfg = normalize(settings);
    const st = state || createState();
    const m = model(stats, cfg, opts, st);
    const inner = cfg.overlayStyle === 'bar' ? bar(m) : cfg.overlayStyle === 'mini' ? mini(m) : cfg.overlayStyle === 'list' ? list(m, st) : panel(m, st);
    if (!inner) return '';
    const style = `--ffo-accent:${cfg.overlayAccent};--ffo-alpha:${(cfg.overlayOpacity / 100).toFixed(2)};zoom:${(cfg.overlayScale / 100).toFixed(2)}`;
    return `<div class="ffo ffo-${cfg.overlayStyle} ffo-font-${cfg.overlayFont} ffo-corner-${cfg.overlayCorner}${cfg.overlayOpacity < 15 ? ' ffo-bare' : ''}" style="${style}">${inner}</div>`;
  }

  /** Readings that make every line visible, for the preview when a real one is missing on this PC. */
  const SAMPLE = {
    fpsEnabled: true, tempEnabled: true, fps: { fps: 144, low1: 113, app: 'your game' }, cap: null,
    cpuTemp: 63, gpuTemp: 71, cpuLoad: 38, gpuLoad: 94, gpuPower: 214, gpuFan: 1640, gpuClock: 2480, vramUsed: 9300, vramTotal: 20464, cpuPower: 78, ramUsed: 14.2, ramTotal: 32,
  };

  return { ITEMS, STYLES, FONTS, CORNERS, POSITIONS, ACCENTS, DEFAULTS, SAMPLE, normalize, html, push, pushStability, createState, model };
});
