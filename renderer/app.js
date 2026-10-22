/* FrameForge UI */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let S = null; // settings
let RIG = null;
let INFO = null;
let PROFILE = null;
let TWEAKS = [];
let busy = false;
const logEntries = new Map();

const ICONS = {
  done: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M4 12.5 9.5 18 20 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><path d="M12 3 2 21h20z"/><path d="M12 10v5M12 18v.5"/></svg>',
  error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 5l14 14M19 5 5 19"/></svg>',
  running: '<span class="spin"></span>',
};

const GPU_SUGGEST = ['GeForce RTX 5090', 'GeForce RTX 5080', 'GeForce RTX 5070 Ti', 'GeForce RTX 5070', 'GeForce RTX 5060 Ti', 'GeForce RTX 4090', 'GeForce RTX 4080 Super', 'GeForce RTX 4070 Super', 'GeForce RTX 4060', 'GeForce RTX 3080', 'GeForce RTX 3070', 'GeForce RTX 3060', 'GeForce GTX 1660 Super', 'GeForce GTX 1060', 'Radeon RX 9070 XT', 'Radeon RX 9070', 'Radeon RX 9060 XT', 'Radeon RX 7900 XTX', 'Radeon RX 7900 XT', 'Radeon RX 7800 XT', 'Radeon RX 7700 XT', 'Radeon RX 7600', 'Radeon RX 6800 XT', 'Radeon RX 6700 XT', 'Radeon RX 6600', 'Radeon RX 580', 'Intel Arc B580', 'Intel Arc A770', 'Intel Arc A750'];
const CPU_SUGGEST = ['AMD Ryzen 7 9800X3D', 'AMD Ryzen 9 9950X3D', 'AMD Ryzen 7 7800X3D', 'AMD Ryzen 9 9950X', 'AMD Ryzen 7 9700X', 'AMD Ryzen 5 9600X', 'AMD Ryzen 7 7700X', 'AMD Ryzen 5 7600X', 'AMD Ryzen 7 5800X3D', 'AMD Ryzen 5 5600X', 'Intel Core Ultra 9 285K', 'Intel Core Ultra 7 265K', 'Intel Core Ultra 5 245K', 'Intel Core i9-14900K', 'Intel Core i7-14700K', 'Intel Core i5-14600K', 'Intel Core i5-13400F', 'Intel Core i5-12400F'];

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------- Navigation + window ---------- */
$$('.nav-item').forEach((b) =>
  b.addEventListener('click', () => {
    $$('.nav-item').forEach((n) => n.classList.toggle('active', n === b));
    $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${b.dataset.view}`));
    if (b.dataset.view === 'fix' && typeof refreshFix === 'function') refreshFix();
    if (b.dataset.view === 'tweaks') refreshTweaks();
    if (b.dataset.view === 'scan') refreshScan(true);
  })
);
$('#wMin').onclick = () => ff.win.min();
$('#wMax').onclick = () => ff.win.max();
$('#wClose').onclick = () => ff.win.close();

/* ---------- The big switch ---------- */
const lever = $('#lever');

function renderAuto(on, active) {
  const live = CHANGES.filter((e) => e.undoable).length;
  lever.setAttribute('aria-checked', on ? 'true' : 'false');
  $('#forge').classList.toggle('on', on);
  const st = $('#sideStatus');
  st.classList.toggle('on', on);
  st.lastElementChild.textContent = on ? 'Auto Mode on' : 'Auto Mode off';
  $('#autoToggle').checked = on;
  $('#autoCard').classList.toggle('on', on);
  $('#autoCard').classList.toggle('busy', busy);
  if (busy) return;
  $('#autoCardText').textContent = on
    ? `On — ${presetName()}. ${live} change${live === 1 ? '' : 's'} active. Change the goal on the Home tab.`
    : `Off. Turn it on and FrameForge tunes your whole PC for ${presetName()}.`;
  $('#forgeStatus').textContent = on
    ? `On. ${presetName()} — ${live} change${live === 1 ? '' : 's'} active on ${RIG ? RIG.gpu.name : 'your PC'}.`
    : live
      ? `Off. ${live} change${live === 1 ? '' : 's'} from FrameForge ${live === 1 ? 'is' : 'are'} still active — see “What FrameForge changed”.`
      : 'Off. Pick your goal below, then flip the switch.';
}

async function startAuto(turnOn) {
  if (busy) return;
  if (!turnOn) return askOff();
  logEntries.clear();
  $('#logList').innerHTML = '';
  await ff.setAuto(true);
}

/** Turning Auto Mode off: keep the PC tuned, or put everything back. */
function askOff() {
  const n = CHANGES.filter((e) => e.undoable).length;
  if (!n) return ff.offKeep();
  $('#offText').textContent = `${n} change${n === 1 ? ' is' : 's are'} active on your PC. Keep them and just switch Auto Mode off, or put everything back exactly how it was?`;
  $('#offModal').classList.remove('hidden');
  $('#offKeep').focus();
}
$('#offCancel').onclick = () => {
  $('#offModal').classList.add('hidden');
  renderAuto(S.autoMode, INFO && INFO.active);
};
$('#offKeep').onclick = async () => {
  $('#offModal').classList.add('hidden');
  await ff.offKeep();
};
$('#offUndo').onclick = async () => {
  $('#offModal').classList.add('hidden');
  logEntries.clear();
  $('#logList').innerHTML = '';
  await ff.setAuto(false);
};
async function stopAuto() {
  if (!busy) return;
  const ok = await ff.stopAuto();
  if (ok) {
    $$('#stopBtn, #stopBtn2').forEach((b) => ((b.disabled = true), (b.textContent = 'Stopping…')));
    $('#runNow').textContent = 'Stopping after this step…';
  }
}
// Flipping the switch while the assistant is working stops it.
lever.addEventListener('click', () => (busy ? stopAuto() : startAuto(lever.getAttribute('aria-checked') !== 'true')));
$('#autoToggle').addEventListener('change', (e) => {
  e.stopPropagation();
  if (busy) {
    e.target.checked = !e.target.checked;
    stopAuto();
    return;
  }
  if (!e.target.checked) {
    e.target.checked = true;
    return askOff();
  }
  startAuto(true);
  toast('Tuning your PC… watch the steps on the Home tab.');
});
$('#stopBtn').onclick = stopAuto;
$('#stopBtn2').onclick = stopAuto;

function showRun(on) {
  $('#runBar').classList.toggle('hidden', !on);
  $('#stopBtn2').classList.toggle('hidden', !on);
  $$('#stopBtn, #stopBtn2').forEach((b) => ((b.disabled = false), (b.textContent = 'Stop')));
  if (on) {
    $('#runFill').style.width = '0';
    $('#runNow').textContent = 'Starting…';
    $('#runCount').textContent = '';
  }
}
ff.onProgress((p) => {
  if (!p) return;
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0;
  $('#runFill').style.width = pct + '%';
  if (p.current && !$('#stopBtn').disabled) $('#runNow').textContent = p.current + '…';
  $('#runCount').textContent = p.total ? `Step ${Math.min(p.done + 1, p.total)} of ${p.total}` : '';
  $('#autoCardText').textContent = `${p.on ? 'Working' : 'Undoing'}: ${p.current || 'starting'} (step ${Math.min(p.done + 1, p.total)} of ${p.total}). You can keep using your PC.`;
});

ff.onBusy(({ on, quiet }) => {
  busy = true;
  showRun(true);
  lever.classList.add('busy');
  lever.setAttribute('aria-label', 'Stop Auto Mode');
  lever.setAttribute('aria-checked', on ? 'true' : 'false');
  $('#forge').classList.toggle('on', on);
  $('#forgeStatus').textContent = quiet ? 'Re-checking your boosts…' : on ? 'Boosting your PC… you can watch every step below.' : 'Putting everything back the way it was…';
  $('#autoToggle').checked = on;
  $('#autoCard').classList.add('busy');
  $('#autoCard').classList.toggle('on', on);
  $('#autoCardText').textContent = on ? 'Boosting your PC… every step shows on the Home tab.' : 'Putting everything back the way it was…';
  if (quiet) {
    logEntries.clear();
    $('#logList').innerHTML = '';
  }
});

const cnt = (n, label, cls = '') => (n ? `<span class="cnt ${cls}"><b>${n}</b>${label}</span>` : '');
function updateLogCounts() {
  const list = $('#logList');
  const c = (cls) => list.querySelectorAll(`li.${cls}`).length;
  const done = c('st-done');
  const warn = c('st-warn');
  const bad = c('st-error');
  const run = c('st-running');
  $('#logCounts').innerHTML = cnt(done, 'done', 'on') + cnt(run, 'working', 'run') + cnt(warn, 'skipped', 'warn') + cnt(bad, 'failed', 'bad');
}
new MutationObserver(updateLogCounts).observe($('#logList'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });

ff.onStep((s) => {
  // Live detail for the running step (e.g. "Tweak 5 of 16: Windows telemetry turned off") on the progress line.
  if (s.status === 'running' && s.message && busy && !$('#stopBtn').disabled) $('#runNow').textContent = `${s.name}: ${s.message}`;
  const list = $('#logList');
  list.querySelector('.empty')?.remove();
  let li = logEntries.get(s.id + s.name.startsWith('Undo'));
  if (!li) {
    li = document.createElement('li');
    logEntries.set(s.id + s.name.startsWith('Undo'), li);
    list.appendChild(li);
  }
  li.className = `st-${s.status}`;
  li.innerHTML = `<span class="ico">${ICONS[s.status] || ''}</span><div><div class="name">${esc(s.name)}</div>${s.message ? `<div class="msg">${esc(s.message)}</div>` : ''}</div>`;
  list.scrollTop = list.scrollHeight; // scroll the list only, not the page
});

ff.onDone(async (d) => {
  busy = false;
  showRun(false);
  lever.classList.remove('busy');
  lever.setAttribute('aria-label', 'Automatic PC Best Gaming Performance Assistance');
  S = await ff.settings();
  renderAuto(d.on, d.active);
  renderPresets();
  if (!$('#view-tweaks').classList.contains('hidden')) refreshTweaks();
  $('#restartBtn').classList.toggle('hidden', !d.needsReboot);
  if (d.kept) toast('Auto Mode is off. Your changes are still active — they’re listed under “What FrameForge changed”.');
  else if (d.stopped) toast(d.active ? `Stopped. ${d.active} boost${d.active === 1 ? '' : 's'} kept — turn Auto Mode off to undo.` : 'Stopped. Nothing was changed.');
  else if (!d.quiet) toast(d.on ? `Auto Mode is on. Your PC is tuned for ${presetName()}.` : 'Everything FrameForge changed is back to how it was.');
  if (INFO) INFO.active = d.active;
  refreshChanges();
  refreshProfile();
  renderSettings();
  refreshFix();
});

$('#restartBtn').onclick = () => ff.restartPc();

/* ---------- Rig ---------- */
function vendorChip(v) {
  const n = { nvidia: 'NVIDIA', amd: 'AMD', intel: 'Intel' }[v];
  return n ? `<span class="chip ${v}">${n}</span>` : '';
}

function renderRig(r) {
  RIG = r;
  if (!r) return;
  const rows = [
    ['Graphics', `${esc(r.gpu.name)}${vendorChip(r.gpu.vendor)}${r.source === 'manual' ? '<span class="chip manual">Picked by you</span>' : ''}<small>${[r.gpu.vramGB ? r.gpu.vramGB + ' GB VRAM' : '', r.gpu.driver ? 'Driver ' + esc(r.gpu.driver) : ''].filter(Boolean).join(' · ')}</small>`],
    ['Processor', `${esc(r.cpu.name)}${vendorChip(r.cpu.vendor)}<small>${[r.cpu.cores ? r.cpu.cores + ' cores' : '', r.cpu.threads ? r.cpu.threads + ' threads' : ''].filter(Boolean).join(' · ')}</small>`],
    ['Memory', `${r.ramGB} GB<small>${[r.ram && r.ram.type, r.ram && r.ram.speedMTs ? r.ram.speedMTs + ' MT/s' : '', r.ram && r.ram.sticks ? r.ram.sticks + (r.ram.sticks === 1 ? ' stick' : ' sticks') : ''].filter(Boolean).join(' · ')}</small>`],
    ['Display', `${esc(r.display.resolution || 'Unknown')}<small>${r.display.refreshHz ? r.display.refreshHz + ' Hz' : ''}</small>`],
    ['System', `${esc(r.os)}<small>${r.laptop ? 'Laptop' : 'Desktop'}</small>`],
  ];
  $('#rigList').innerHTML = rows.map(([k, v]) => `<div class="rig-row"><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  const va = r.vendorApp;
  $('#vendorBtn').textContent = va ? (va.installed ? `Open ${va.name.split(':')[0]}` : `Get ${va.name.split(':')[0]}`) : 'Open driver app';
  $('#vendorBtn').classList.toggle('hidden', !va);
  renderAuto(lever.getAttribute('aria-checked') === 'true', INFO && INFO.active);
}

ff.onRig((r) => {
  renderRig(r);
  refreshProfile();
});
$('#rescanBtn').onclick = async () => {
  $('#rigList').innerHTML = '<div class="skeleton">Scanning your PC…</div>';
  renderRig(await ff.scan());
  refreshProfile();
  renderSettings();
};
$('#vendorBtn').onclick = () => ff.openVendor();

/* ---------- Profile: insights, driver guide, overclock plan ---------- */
async function refreshProfile() {
  PROFILE = await ff.profile();
  if (!PROFILE) return;
  const ins = PROFILE.insights;
  $('#insightList').innerHTML = ins.length
    ? ins.map((i) => `<div class="insight ${i.level}"><h3>${esc(i.title)}</h3><p>${esc(i.body)}</p></div>`).join('')
    : '<p class="insight-empty">Nothing holding this PC back that FrameForge can see. Nice build.</p>';

  const vendorName = RIG ? RIG.gpu.vendorName : '';
  $('#tuneTitle').textContent = vendorName && vendorName !== 'Unknown' ? `${vendorName} driver tune-up` : 'Driver tune-up';
  $('#guideList').innerHTML = PROFILE.guide.length
    ? PROFILE.guide.map((g) => `<li><div><b>${esc(g.title)}</b><span>${esc(g.where)}</span></div></li>`).join('')
    : '<li><div><b>No driver checklist for this graphics card</b><span>Pick your card under “Choose parts myself” if it was detected wrong.</span></div></li>';
  $('#tuneLead').classList.toggle('hidden', !PROFILE.guide.length);

  const showOc = S && S.overclock && PROFILE.overclock.length;
  $('#ocBlock').classList.toggle('hidden', !showOc);
  $('#ocList').innerHTML = PROFILE.overclock
    .map((o) => `<li><b>${esc(o.title)}${o.auto ? '<span class="auto-tag">FrameForge does this</span>' : ''}</b><span>${esc(o.body)}</span></li>`)
    .join('');
}

/* ---------- Live telemetry ---------- */
function tempClass(t) {
  return t >= 88 ? 't-hot' : t >= 78 ? 't-warm' : '';
}
let lastStats = null;
ff.onStats((s) => {
  lastStats = s;
  const set = (id, v) => ($(id).textContent = v == null ? '—' : v);
  if (s.fpsEnabled && s.fps) {
    set('#tFps', s.fps.fps);
    $('#tFpsSub').textContent = `${s.fps.app} · 1% low ${s.fps.low1}`;
  } else {
    set('#tFps', null);
    $('#tFpsSub').textContent = !s.fpsEnabled ? 'FPS counter is off' : !s.fpsReady ? 'Needs the FPS engine' : 'Start a game to see FPS';
  }
  const showT = s.tempEnabled;
  set('#tCpuT', showT ? s.cpuTemp : null);
  set('#tGpuT', showT ? s.gpuTemp : null);
  $('#tCpuT').className = showT && s.cpuTemp ? tempClass(s.cpuTemp) : '';
  $('#tGpuT').className = showT && s.gpuTemp ? tempClass(s.gpuTemp) : '';
  $('#bCpu').style.width = showT && s.cpuTemp ? Math.min(100, s.cpuTemp) + '%' : '0';
  $('#bGpu').style.width = showT && s.gpuTemp ? Math.min(100, s.gpuTemp) + '%' : '0';
  const src = s.sources || {};
  $('#sCpu').textContent = showT ? (src.cpuTemp ? `From ${src.cpuTemp}` : 'Needs a real CPU sensor reader') : '';
  $('#sGpu').textContent = showT ? (src.gpuTemp ? `From ${src.gpuTemp}` : 'Needs a real GPU sensor reader') : '';
  set('#tCpuL', s.cpuLoad != null ? s.cpuLoad + '%' : null);
  set('#tGpuL', s.gpuLoad != null ? s.gpuLoad + '%' : null);

  // Point the user at the one fix that gets missing numbers showing.
  const hint = $('#teleHint');
  let msg = null;
  let tool = null;
  if (s.fpsEnabled && !s.fpsReady) {
    msg = 'The FPS counter needs PresentMon, a free tool from Intel.';
    tool = 'presentmon';
  } else if (s.tempEnabled && (s.cpuTemp == null || s.gpuTemp == null) && !s.sensorsReady) {
    msg = 'Windows can’t read the real CPU temperature on its own. LibreHardwareMonitor (free, open source) reads the actual chip sensors.';
    tool = 'lhm';
  }
  if (msg) {
    if (hint.dataset.tool !== tool) {
      hint.dataset.tool = tool;
      hint.innerHTML = `<span>${msg}</span><button class="primary small" data-install="${tool}">Download it</button>`;
    }
    hint.classList.remove('hidden');
  } else {
    hint.classList.add('hidden');
    hint.dataset.tool = '';
  }
});

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-install]');
  if (!b) return;
  const id = b.dataset.install;
  b.disabled = true;
  b.textContent = 'Downloading…';
  const r = await ff.installTool(id);
  toast(r.ok ? r.message : `Download failed: ${r.message}`);
  b.disabled = false;
  b.textContent = 'Download it';
  renderTools();
});
ff.onToolProgress(({ p }) => {
  $$('[data-install]').forEach((b) => b.disabled && (b.textContent = `Downloading… ${Math.round(p * 100)}%`));
});

let overlayOn = true;
$('#overlayBtn').onclick = async () => {
  overlayOn = await ff.toggleOverlay();
  $('#overlayBtn').textContent = overlayOn ? 'Hide overlay' : 'Show overlay';
};
ff.onOverlayShown((v) => {
  overlayOn = v;
  $('#overlayBtn').textContent = v ? 'Hide overlay' : 'Show overlay';
});

/* ---------- Choose parts dialog ---------- */
let mVendor = 'nvidia';
$('#gpuList').innerHTML = GPU_SUGGEST.map((g) => `<option value="${g}">`).join('');
$('#cpuList').innerHTML = CPU_SUGGEST.map((c) => `<option value="${c}">`).join('');
function setSeg(v) {
  mVendor = v;
  $$('#vendorSeg button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
}
$$('#vendorSeg button').forEach((b) => b.addEventListener('click', (e) => (e.preventDefault(), setSeg(b.dataset.v))));
$('#mGpu').addEventListener('input', (e) => {
  const v = e.target.value.toLowerCase();
  if (/rtx|gtx|geforce/.test(v)) setSeg('nvidia');
  else if (/radeon|rx /.test(v)) setSeg('amd');
  else if (/arc/.test(v)) setSeg('intel');
});
$('#manualBtn').onclick = () => {
  setSeg(RIG && ['nvidia', 'amd', 'intel'].includes(RIG.gpu.vendor) ? RIG.gpu.vendor : 'nvidia');
  $('#mGpu').value = RIG ? RIG.gpu.name : '';
  $('#mCpu').value = RIG ? RIG.cpu.name : '';
  $('#manualModal').classList.remove('hidden');
  $('#mGpu').focus();
};
const closeManual = () => $('#manualModal').classList.add('hidden');
$('#mCancel').onclick = closeManual;
$('#mSave').onclick = async () => {
  renderRig(await ff.setManual({ cpu: $('#mCpu').value.trim(), gpu: $('#mGpu').value.trim(), gpuVendor: mVendor }));
  closeManual();
  refreshProfile();
  renderSettings();
  toast('Saved. FrameForge will tune for these parts.');
};
$('#mAuto').onclick = async () => {
  renderRig(await ff.setManual(null));
  closeManual();
  refreshProfile();
  renderSettings();
  toast('Back to automatic detection.');
};

/* ---------- Preset slideshow ---------- */
let PRESETS = [];
let slide = 0;
const presetName = () => (PRESETS.find((p) => p.id === (S && S.preset)) || { name: 'gaming' }).name;

const ART = {
  competitive: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="4"><circle cx="50" cy="50" r="34"/><circle cx="50" cy="50" r="14"/><path d="M50 6v22M50 72v22M6 50h22M72 50h22"/><circle cx="50" cy="50" r="3" fill="currentColor"/></svg>',
  performance: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"><path d="M14 70a38 38 0 1 1 72 0"/><path d="M50 62 72 34" stroke-width="6"/><circle cx="50" cy="62" r="6" fill="currentColor"/><path d="M22 44l6 3M33 30l4 5M50 24v6M67 30l-4 5M78 44l-6 3"/></svg>',
  balanced: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"><path d="M50 14v70M30 84h40"/><path d="M18 30h64"/><path d="M18 30 8 56h20zM82 30 72 56h20z"/><circle cx="50" cy="20" r="5" fill="currentColor"/></svg>',
  graphics: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"><path d="M50 12 86 76H14z"/><path d="M4 50 34 54M66 46l30-14M66 54l30 6M66 62l30 22" stroke-width="3"/></svg>',
};

function renderPresets() {
  const cur = S ? S.preset : 'performance';
  $('#carTrack').innerHTML = PRESETS.map(
    (p) => `<article class="slide ${p.id === cur ? 'selected' : ''}" data-id="${p.id}" aria-label="${esc(p.name)}">
      <div class="slide-art">${ART[p.id] || ''}</div>
      <div class="slide-body">
        <h3>${esc(p.name)}</h3>
        <p>${esc(p.tagline)}</p>
        <ul>${p.changes.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
        ${p.id === cur ? `<span class="chosen">✓ Your goal${S && S.autoMode ? ' — active now' : ''}</span>` : `<button class="primary small pick" data-preset="${p.id}">Use ${esc(p.name)}</button>`}
      </div>
    </article>`
  ).join('');
  $('#carDots').innerHTML = PRESETS.map((p, i) => `<button role="tab" aria-label="${esc(p.name)}" class="${i === slide ? 'on' : ''}" data-dot="${i}"></button>`).join('');
  goSlide(slide, false);
}
function goSlide(i, animate = true) {
  slide = (i + PRESETS.length) % PRESETS.length;
  const t = $('#carTrack');
  if (!animate) t.style.transition = 'none';
  t.style.transform = `translateX(-${slide * 100}%)`;
  if (!animate) requestAnimationFrame(() => (t.style.transition = ''));
  $$('#carDots button').forEach((b, k) => b.classList.toggle('on', k === slide));
}
$('#carPrev').onclick = () => goSlide(slide - 1);
$('#carNext').onclick = () => goSlide(slide + 1);
$('#carousel').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') goSlide(slide - 1);
  if (e.key === 'ArrowRight') goSlide(slide + 1);
});
document.addEventListener('click', async (e) => {
  const dot = e.target.closest('[data-dot]');
  if (dot) return goSlide(Number(dot.dataset.dot));
  const pick = e.target.closest('[data-preset]');
  if (!pick || busy) return;
  const wasOn = S.autoMode;
  S = await ff.setPreset(pick.dataset.preset);
  renderPresets();
  await refreshProfile();
  renderSettings();
  renderAuto(S.autoMode, INFO && INFO.active);
  toast(wasOn ? `Switching your PC to ${presetName()}…` : `${presetName()} picked. Flip the switch to tune your PC for it.`);
});

/* ---------- What FrameForge changed (saved on disk, survives restarts) ---------- */
let CHANGES = [];
function when(ts) {
  const d = new Date(ts);
  const today = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `Today ${time}`;
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${time}`;
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}
function renderChanges(c) {
  CHANGES = c.entries || [];
  $('#restartNotice').classList.toggle('hidden', !c.restartedNotice);
  $('#changesEmpty').classList.toggle('hidden', CHANGES.length > 0);
  const live = CHANGES.filter((e) => e.undoable).length;
  const once = CHANGES.length - live;
  const restart = CHANGES.filter((e) => e.pendingRestart).length;
  $('#chCounts').innerHTML = cnt(live, 'turned on', 'on') + cnt(once, 'done once') + cnt(restart, 'need a restart', 'warn');
  $('#undoAllBtn').classList.toggle('hidden', !live);
  $('#clearHistBtn').classList.toggle('hidden', !CHANGES.some((e) => !e.undoable));
  const pn = (id) => (PRESETS.find((p) => p.id === id) || { name: id }).name;
  $('#changeList').innerHTML = CHANGES.map(
    (e) => `<li class="${e.undoable ? '' : 'oneshot'}">
      <div class="ch-top"><b>${esc(e.name)}</b>
        <span class="ch-meta">${when(e.at)} · ${esc(pn(e.preset))}</span>
        ${e.undoable ? '<span class="ch-state active">Still active</span>' : '<span class="ch-state once">Done once</span>'}
        ${e.pendingRestart ? '<span class="ch-state reboot">Needs a restart</span>' : ''}
      </div>
      <p>${esc(e.summary)}</p>
      ${e.details && e.details.length ? `<details><summary>Exact changes (${e.details.length})</summary><ul class="ch-exact">${e.details.map((d) => `<li><code>${esc(d)}</code></li>`).join('')}</ul></details>` : ''}
    </li>`
  ).join('');
  renderAuto(lever.getAttribute('aria-checked') === 'true', INFO && INFO.active);
}
async function refreshChanges() {
  renderChanges(await ff.changes());
}
ff.onChanges(renderChanges);
$('#noticeOk').onclick = async () => renderChanges(await ff.dismissNotice());
$('#clearHistBtn').onclick = async () => renderChanges(await ff.clearHistory());
$('#undoAllBtn').onclick = () => {
  if (busy) return;
  const n = CHANGES.filter((e) => e.undoable).length;
  $('#offTitle').textContent = 'Undo all changes?';
  $('#offText').textContent = `This puts all ${n} active change${n === 1 ? '' : 's'} back exactly how ${n === 1 ? 'it was' : 'they were'} before FrameForge. One-time things like deleted temp files can’t come back.`;
  $('#offKeep').classList.add('hidden');
  $('#offModal').classList.remove('hidden');
};
// Reset the dialog's wording whenever it closes.
new MutationObserver(() => {
  if ($('#offModal').classList.contains('hidden')) {
    $('#offTitle').textContent = 'Turn off Auto Mode?';
    $('#offKeep').classList.remove('hidden');
  }
}).observe($('#offModal'), { attributes: true, attributeFilter: ['class'] });

/* ---------- Share ---------- */
$('#shareBtn').onclick = async () => {
  const link = await ff.shareCopy();
  toast(`Download link copied — paste it in Discord: ${link}`, 6000);
};

/* ---------- Tweaks tab ---------- */
let TW = null;
const twWorking = new Set();
const twRebootNames = new Set();

function twRow(t) {
  const tags = [
    t.recommended ? '<span class="tag rec">Recommended for your PC</span>' : '<span class="tag no">Not recommended for your PC</span>',
    t.inPreset ? '<span class="tag">In your preset</span>' : '',
    t.reboot ? '<span class="tag reboot">Restart to finish</span>' : '',
    t.admin && TW && !TW.admin ? '<span class="tag admin">Needs admin</span>' : '',
    t.locked && !t.on ? '<span class="tag no">Locked on this PC</span>' : '',
  ].join('');
  const state = t.on ? (t.byFrameForge ? 'On — set by FrameForge' : 'On — Windows already had this set') : 'Off';
  return `<div class="tw-row ${twWorking.has(t.id) ? 'working' : ''}" data-tw="${t.id}">
    <div class="set-text">
      <h3>${esc(t.name)}${tags}</h3>
      <p>${esc(t.desc)}</p>
      ${t.reason ? `<p class="why ${t.recommended ? '' : 'no'}">${esc(t.reason)}</p>` : ''}
      ${t.locked && !t.on ? `<p class="tw-locked">${esc(t.locked)} <button class="link-btn" data-twretry="${t.id}">Try again</button></p>` : ''}
      <div class="tw-state ${t.on ? 'on' : 'off'}">${twWorking.has(t.id) ? 'Working…' : t.locked && !t.on ? 'Not available on this PC' : state}</div>
      ${t.what && t.what.length ? `<details><summary>Exactly what it changes</summary><ul class="ch-exact">${t.what.map((w) => `<li><code>${esc(w)}</code></li>`).join('')}</ul></details>` : ''}
    </div>
    <label class="switch"><input type="checkbox" data-twset="${t.id}" ${t.on ? 'checked' : ''} ${twWorking.has(t.id) || (t.locked && !t.on) ? 'disabled' : ''} aria-label="${esc(t.name)}" /><span></span></label>
  </div>`;
}

function renderTweaks() {
  if (!TW) return;
  // Keep any open "Exactly what it changes" boxes open across re-renders.
  const open = new Set($$('#twList details[open]').map((d) => d.closest('[data-tw]').dataset.tw));
  $('#twList').innerHTML = TW.cats
    .map((c) => {
      const items = TW.items.filter((t) => t.cat === c.id);
      if (!items.length) return '';
      const offRec = items.filter((t) => !t.on && t.recommended && !t.locked).length;
      return `<section class="tw-cat">
        <div class="tw-cat-head"><div><h2>${esc(c.name)}</h2><p>${esc(c.blurb)}</p></div>
        <button class="ghost small" data-twcat="${c.id}" ${offRec ? '' : 'disabled'}>${offRec ? `Turn on ${offRec} recommended` : 'All recommended are on'}</button></div>
        ${items.map(twRow).join('')}
      </section>`;
    })
    .join('');
  open.forEach((id) => {
    const d = $(`#twList [data-tw="${id}"] details`);
    if (d) d.open = true;
  });
  const on = TW.items.filter((t) => t.on).length;
  $('#twCount').textContent = `${on} of ${TW.items.length} on`;
  const offRec = TW.items.filter((t) => !t.on && t.recommended && !t.locked).length;
  $('#twAllRec').disabled = !offRec;
  $('#twAllRec').textContent = offRec ? `Turn on ${offRec} recommended` : 'Everything recommended is on';
  $('#twReboot').classList.toggle('hidden', !twRebootNames.size);
  $('#twRebootText').textContent = `Restart your PC to finish: ${[...twRebootNames].join(', ')}.`;
}

async function refreshTweaks() {
  TW = await ff.tw.catalog();
  renderTweaks();
}

async function setTweak(id, on) {
  const t = TW.items.find((x) => x.id === id);
  twWorking.add(id);
  renderTweaks();
  const r = await ff.tw.set(id, on);
  twWorking.delete(id);
  if (t) {
    t.on = r.on;
    t.byFrameForge = r.on && on;
  }
  if (r.reboot && t) twRebootNames.add(t.name);
  if (t) t.locked = r.locked ? r.message : r.ok ? null : t.locked;
  if (!r.ok) toast(`${t ? t.name : 'Tweak'}: ${r.message}`, 8000);
  else if (on && r.on === false) toast(`${t.name} didn’t take effect — see Fix mode.`, 6000);
  renderTweaks();
  return r;
}

document.addEventListener('change', (e) => {
  const sw = e.target.closest('[data-twset]');
  if (sw) setTweak(sw.dataset.twset, sw.checked);
});
document.addEventListener('click', async (e) => {
  const retry = e.target.closest('[data-twretry]');
  if (retry) return setTweak(retry.dataset.twretry, true);
  const cat = e.target.closest('[data-twcat]');
  if (!cat || !TW) return;
  cat.disabled = true;
  for (const t of TW.items.filter((x) => x.cat === cat.dataset.twcat && !x.on && x.recommended && !x.locked)) await setTweak(t.id, true);
  refreshTweaks();
});
$('#twAllRec').onclick = async () => {
  $('#twAllRec').disabled = true;
  const todo = TW.items.filter((x) => !x.on && x.recommended && !x.locked);
  let ok = 0;
  for (const t of todo) if ((await setTweak(t.id, true)).ok) ok++;
  toast(`Turned on ${ok} of ${todo.length} recommended tweaks.`);
  refreshTweaks();
};
$('#twRebootBtn').onclick = () => ff.restartPc();
ff.tw.onChanged(() => refreshTweaks());

/* ---------- Fix mode ---------- */
let FIX = null;
const FIX_ASK = (it) => `Help me fix this problem on my PC: “${it.title}”. ${it.body || ''} ${it.details && it.details.length ? 'Details: ' + it.details.slice(0, 6).join(' | ') : ''} Explain what caused it and fix it if you can.`;

function showView(name) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
  if (name === 'scan') refreshScan(true);
}

// Problems that were in the list and then disappeared = fixed (by Fix everything, a button, Auto Mode or the AI).
const FIXED_NOW = new Map(); // id -> { title, at }
const FIRST_SEEN = new Map(); // id -> fixedTitle from when the problem first showed up (keeps e.g. "19 settings")
let lastFixIds = null;
function renderFixedNow() {
  const list = [...FIXED_NOW.values()].sort((a, b) => b.at - a.at);
  $('#fixDone').classList.toggle('hidden', !list.length);
  $('#fixDoneCount').innerHTML = cnt(list.length, 'fixed', 'on');
  $('#fixDoneList').innerHTML = list
    .map((f) => `<li><span class="ico">${ICONS.done}</span><b>${esc(f.title)}</b><small>${new Date(f.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</small></li>`)
    .join('');
}

// Several things ask for a refresh at once (timer, "changed" events, buttons): run one at a time, then once more.
let fixRefreshing = false;
let fixRefreshAgain = false;
async function refreshFix() {
  if (fixRefreshing) {
    fixRefreshAgain = true;
    return;
  }
  fixRefreshing = true;
  try {
    do {
      fixRefreshAgain = false;
      await refreshFixOnce();
    } while (fixRefreshAgain);
  } finally {
    fixRefreshing = false;
  }
}
async function refreshFixOnce() {
  const prev = FIX ? new Map(FIX.items.map((i) => [i.id, i])) : null;
  FIX = await ff.fix.list();
  const items = FIX.items;
  const ids = new Set(items.map((i) => i.id));
  // Anything that left the list since last time got fixed: animate it out and log it under "Fixed just now".
  if (prev && lastFixIds) {
    for (const [id, it] of prev) {
      if (ids.has(id) || id === 'restart') continue;
      FIXED_NOW.set(id, { title: FIRST_SEEN.get(id) || it.fixedTitle || it.title, at: Date.now() });
      FIRST_SEEN.delete(id);
      const card = $(`#fixList [data-fix="${CSS.escape(id)}"]`);
      if (card) card.classList.add('leaving');
    }
    if ($$('#fixList .leaving').length) await new Promise((r) => setTimeout(r, 420));
  }
  for (const it of items) {
    FIXED_NOW.delete(it.id); // it came back: not fixed after all
    if (!FIRST_SEEN.has(it.id)) FIRST_SEEN.set(it.id, it.fixedTitle);
  }
  lastFixIds = ids;
  renderFixedNow();
  // A pending restart is a follow-up step, not a problem: it doesn't count toward the open problems.
  const open = items.filter((i) => i.id !== 'restart');
  const auto = open.filter((i) => i.auto).length;
  const you = open.filter((i) => !i.auto).length;
  const restart = items.some((i) => i.id === 'restart');
  $('#fixCounts').innerHTML =
    (open.length ? cnt(open.length, 'open', 'warn') + cnt(auto, 'fixable automatically', 'on') + cnt(you, you === 1 ? 'needs you' : 'need you') : '<span class="cnt on"><b>0</b>open — all good</span>') +
    (restart ? '<span class="cnt"><b>1</b>restart pending</span>' : '');
  const badge = $('#fixBadge');
  badge.textContent = open.length;
  badge.classList.toggle('hidden', !open.length);
  $('#fixAllBtn').disabled = fixAllRunning || !items.length;
  $('#fixList').innerHTML = items.length
    ? items.map((it) => `<div class="fix-item ${it.level}" data-fix="${esc(it.id)}">
        <h3>${esc(it.title)}${it.auto ? '<span class="tag rec">Can fix automatically</span>' : ''}${it.bios ? '<span class="tag bios">Fixed in the BIOS</span>' : ''}</h3>
        <p>${esc(it.body || '')}</p>
        ${it.details && it.details.length ? `<details><summary>What happened (${it.details.length})</summary><ul class="ch-exact">${it.details.map((d) => `<li><code>${esc(d)}</code></li>`).join('')}</ul></details>` : ''}
        ${it.manual && !it.auto ? `<details class="how"><summary>How to fix it</summary><ol class="fr-steps">${it.manual.map((m) => `<li>${esc(m)}</li>`).join('')}</ol></details>` : ''}
        <div class="fix-actions">
          ${it.strategies && it.strategies.length ? `<button class="primary small" data-fixone="${esc(it.id)}">Fix it</button>` : ''}
          ${it.actions.filter((a) => !(it.strategies || []).some((st) => st.id === a.id) || a.id.startsWith('goto')).map((a) => `<button class="${/^(retry|install|repair)/.test(a.id) ? 'primary' : 'ghost'} small" data-fixact="${esc(a.id)}">${esc(a.label)}</button>`).join('')}
          ${aiReady() ? `<button class="ghost small" data-fixask="${esc(it.id)}">Ask AI to explain</button>` : ''}
        </div>
      </div>`).join('')
    : '<div class="fix-ok">Nothing to fix right now. If something feels off — stutter, crashes, lag — try a repair tool below or ask the AI.</div>';
  $('#repairGrid').innerHTML = FIX.repairs
    .map((r) => `<div class="repair"><h3>${esc(r.name)}</h3><p>${esc(r.desc)}</p><div class="fix-actions"><button class="primary small" data-fixact="repair:${r.id}">Run it</button>${aiReady() ? `<button class="ghost small" data-repairask="${esc(r.id)}">Ask AI if I need this</button>` : ''}</div></div>`)
    .join('');
}

function consoleStart(title) {
  $('#fixConsole').classList.remove('hidden');
  $('#fcTitle').textContent = title;
  $('#fcSpin').classList.remove('hidden');
  $('#fcLog').textContent = '';
}
ff.fix.onLine(({ line }) => {
  const pre = $('#fcLog');
  pre.textContent += line + '\n';
  pre.scrollTop = pre.scrollHeight;
});
ff.fix.onRepair((r) => {
  if (r.status === 'running') {
    if ($('#fixConsole').classList.contains('hidden') || !$('#fcSpin').classList.contains('hidden')) consoleStart(`${r.title}…`);
    else consoleStart(`${r.title}…`);
  } else {
    $('#fcSpin').classList.add('hidden');
    $('#fcTitle').textContent = `${r.title}: ${r.message || (r.status === 'done' ? 'done' : 'finished with problems')}`;
    $('#fcLog').textContent += `${r.status === 'done' ? '✓' : '!'} ${r.message || ''}\n`;
  }
});
ff.fix.onChanged(() => refreshFix());
ff.onGoto((v) => showView(v));

document.addEventListener('click', async (e) => {
  const one = e.target.closest('[data-fixone]');
  if (one) {
    if (fixAllRunning) return toast('FrameForge is already fixing — hang on.');
    const id = one.dataset.fixone;
    const item = FIX && FIX.items.find((i) => i.id === id);
    const card = one.closest('.fix-item');
    $$('#fixList [data-fixone], #fixList [data-fixact]').forEach((b) => (b.disabled = true));
    one.textContent = 'Fixing…';
    consoleStart(`Fixing: ${item ? item.title : id}…`);
    const r = await ff.fix.one(id);
    $('#fcSpin').classList.add('hidden');
    $('#fcTitle').textContent = r.fixed ? `Fixed: ${(item && item.title) || id}` : `Couldn’t fully fix it: ${r.message || ''}`;
    if (r.fixed) {
      toast(`✓ ${r.message || 'Fixed.'}`, 5000);
      // It's gone from the list right away; refreshFix confirms it and logs it under "Fixed just now".
      if (card) card.classList.add('leaving');
    } else {
      toast(r.message || 'That didn’t work.', 7000);
      $$('#fixList [data-fixone], #fixList [data-fixact]').forEach((b) => (b.disabled = false));
      one.textContent = 'Try again';
      if (card && r.steps && r.steps.length && !card.querySelector('.fix-result')) {
        card.insertAdjacentHTML('beforeend', `<div class="fix-result"><b>${esc(r.message || 'This one needs you:')}</b><ol class="fr-steps">${r.steps.map((m) => `<li>${esc(m)}</li>`).join('')}</ol></div>`);
      }
    }
    refreshFix();
    refreshChanges();
    return;
  }
  const act = e.target.closest('[data-fixact]');
  if (act) {
    const id = act.dataset.fixact;
    act.disabled = true;
    const old = act.textContent;
    act.textContent = 'Working…';
    if (/^(retry|install)/.test(id)) consoleStart(`${old}…`);
    const r = await ff.fix.action(id);
    if (r && r.message) toast(r.message, 5000);
    if (/^(retry|install)/.test(id)) {
      $('#fcSpin').classList.add('hidden');
      $('#fcTitle').textContent = r && r.message ? r.message : 'Done.';
    }
    act.disabled = false;
    act.textContent = old;
    refreshFix();
    refreshChanges();
    return;
  }
  const ask = e.target.closest('[data-fixask]');
  if (ask && FIX) {
    const it = FIX.items.find((i) => i.id === ask.dataset.fixask);
    if (it) {
      showView('chat');
      sendChat(FIX_ASK(it));
    }
    return;
  }
  const rask = e.target.closest('[data-repairask]');
  if (rask && FIX) {
    const r = FIX.repairs.find((x) => x.id === rask.dataset.repairask);
    showView('chat');
    sendChat(`Should I run “${r.name}” on my PC? Look at my PC info and problems and tell me honestly if it would help.`);
  }
});
const aiReady = () => !!(AI && ((AI.provider === 'claude' && AI.hasKey) || AI.provider === 'ollama'));
let fixAllRunning = false;
const FR_ICON = {
  working: '<span class="spin"></span>',
  fixed: ICONS.done,
  failed: ICONS.error,
  you: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};
function frRow(id) {
  let li = $(`#frList [data-fr="${CSS.escape(id)}"]`);
  if (!li) {
    li = document.createElement('li');
    li.dataset.fr = id;
    $('#frList').appendChild(li);
  }
  return li;
}
ff.fix.onAll((e) => {
  if (e.type === 'start') {
    fixAllRunning = true;
    $('#fixReport').classList.remove('hidden');
    $('#frList').innerHTML = '';
    $('#frSummary').classList.add('hidden');
    $('#frSpin').classList.remove('hidden');
    $('#frTitle').textContent = e.background ? 'Fixing by itself in the background…' : e.resumed ? 'Back after the restart — finishing up…' : 'Fixing everything…';
    $('#fixAllBtn').disabled = true;
    $('#fixAllBtn').textContent = 'Fixing…';
  } else if (e.type === 'phase') {
    $('#frTitle').textContent = e.text;
  } else if (e.type === 'found') {
    $('#frTitle').textContent = e.count ? `Found ${e.count} thing${e.count === 1 ? '' : 's'} to look at — fixing…` : 'Nothing to fix — your PC looks good.';
  } else if (e.type === 'try') {
    const li = frRow(e.id);
    const m = li.querySelector('.m');
    if (m) m.textContent = `Trying${e.of > 1 ? ` (${e.n} of ${e.of})` : ''}: ${e.text}…`;
  } else if (e.type === 'item') {
    const li = frRow(e.id);
    li.className = e.outcome;
    const msg = e.outcome === 'fixed' ? `Fixed. ${e.message || ''}` : e.outcome === 'you' ? 'This needs you — here’s exactly what to do:' : e.outcome === 'failed' ? `Couldn’t fix it: ${e.message || ''}` : e.message || 'Working on it…';
    li.innerHTML = `<span class="ico">${FR_ICON[e.outcome] || ''}</span><div><div class="t">${esc(e.title)}</div><div class="m">${esc(msg)}</div>${e.steps ? `<ol class="fr-steps">${e.steps.map((st) => `<li>${esc(st)}</li>`).join('')}</ol>` : ''}${e.buttons && e.buttons.length ? `<div class="fix-actions">${e.buttons.map((b) => `<button class="ghost small" data-fixact="${esc(b.id)}">${esc(b.label)}</button>`).join('')}</div>` : ''}</div>`;
  } else if (e.type === 'done') {
    fixAllRunning = false;
    $('#frSpin').classList.add('hidden');
    const parts = [];
    if (e.fixed) parts.push(`fixed ${e.fixed}`);
    if (e.you) parts.push(`${e.you} need${e.you === 1 ? 's' : ''} you (steps below each)`);
    if (e.failed) parts.push(`${e.failed} couldn’t be fixed`);
    $('#frTitle').textContent =
      e.restarting === 'admin'
        ? 'Restarting as administrator to finish…'
        : e.restarting === 'pc'
          ? `${parts.length ? `So far: ${parts.join(', ')}. ` : ''}Restarting the PC to finish — FrameForge opens again by itself afterwards.`
          : e.background
            ? `Fixed by itself in the background — ${parts.join(', ') || 'nothing needed fixing'}.`
            : parts.length
              ? `Done — ${parts.join(', ')}.`
              : 'Done — nothing needed fixing.';
    $('#fixAllBtn').textContent = 'Fix everything automatically';
    refreshFix();
    refreshChanges();
  }
});
ff.fix.onAuto((a) => {
  if (a && a.fixed && a.fixed.length) toast(`Fixed by itself: ${a.fixed.join(' · ')}`, 6000);
});

/* Restart countdown — FrameForge restarts the PC itself when a fix needs it (you can cancel). */
const RS_C = 2 * Math.PI * 52;
ff.fix.onRestart((r) => {
  const modal = $('#rsModal');
  if (r.cancelled || r.failed) {
    modal.classList.add('hidden');
    toast(r.failed ? r.message : 'Restart cancelled. Restart whenever it suits you — FrameForge finishes up by itself afterwards.', r.failed ? 9000 : 5000);
    refreshFix();
    return;
  }
  modal.classList.remove('hidden');
  if (r.restarting) {
    $('#rsLeft').textContent = '0';
    $('#rsArc').style.strokeDashoffset = RS_C;
    $('#rsTitle').textContent = r.bios ? 'Restarting into the BIOS…' : 'Restarting…';
    $$('#rsCancel, #rsNow').forEach((b) => (b.disabled = true));
    return;
  }
  $$('#rsCancel, #rsNow').forEach((b) => (b.disabled = false));
  $('#rsLeft').textContent = r.left;
  $('#rsArc').style.strokeDashoffset = RS_C * (1 - r.left / r.total);
  $('#rsTitle').textContent = r.bios ? `Restarting into the BIOS in ${r.left} s` : `Restarting your PC in ${r.left} s`;
  $('#rsText').textContent = r.bios
    ? 'Your PC restarts straight into the BIOS — no key tapping. Change the one setting from the steps (take a photo of them now), press F10 to save, and FrameForge checks the RAM speed when Windows is back.'
    : `${r.reason}. FrameForge opens again by itself afterwards and checks that everything worked.`;
});
$('#rsCancel').onclick = () => ff.fix.cancelRestart();
$('#rsNow').onclick = () => ff.fix.restartNow();

$('#fixAllBtn').onclick = async () => {
  if (fixAllRunning) return;
  const r = await ff.fix.all();
  if (r && r.busy) toast(r.message || 'FrameForge is already fixing — hang on.');
};

/* ---------- AI chat ---------- */
let AI = null;
let aiUninstalling = false;
let aiBusy = false;
let liveBubble = null;
let liveText = '';
let pendingUserBubble = null;
let chatChanging = false;

/** Tiny, safe Markdown: escapes everything first, then bold, code, headings and lists. */
function md(text) {
  const inline = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  const out = [];
  let list = null;
  const flush = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (const raw of String(text).split('\n')) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)/);
    if (ul || ol) {
      const tag = ul ? 'ul' : 'ol';
      if (!list || list.tag !== tag) {
        flush();
        list = { tag, items: [] };
      }
      list.items.push((ul || ol)[1]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)/);
    out.push(h ? `<h4>${inline(h[1])}</h4>` : `<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('');
}

function chatScroll() {
  const v = $('#view-chat');
  v.scrollTop = v.scrollHeight;
}
function addBubble(role, text, extra = '', id = null) {
  const d = document.createElement('div');
  d.className = `msg ${role} ${extra}`;
  let row = d;
  if (role === 'user') {
    row = document.createElement('div');
    row.className = 'user-message';
    row.dataset.text = text;
    if (id) row.dataset.messageId = id;
    row.appendChild(d);
    const menu = document.createElement('details');
    menu.className = 'msg-menu';
    menu.innerHTML = '<summary data-chat-menu aria-label="Message options" title="Message options">⋮</summary><div class="msg-menu-actions"><button type="button" data-chat-edit>Edit message</button><button type="button" data-chat-delete>Delete message</button></div>';
    menu.querySelector('summary').setAttribute('aria-disabled', String(aiBusy || !id));
    row.appendChild(menu);
    renderUserContent(row);
  }
  else if (role === 'action') d.textContent = `⚙ ${text}`;
  else d.innerHTML = md(text);
  $('#chatLog').appendChild(row);
  $('#chatEmpty').classList.add('hidden');
  chatScroll();
  return d;
}
function setAiBusy(b) {
  aiBusy = b;
  if (AI) AI.busy = b;
  $$('#chatLog [data-chat-menu]').forEach((el) => el.setAttribute('aria-disabled', String(b || !el.closest('.user-message').dataset.messageId)));
  $$('#chatLog [data-chat-save]').forEach((el) => { el.disabled = b; });
  if (b) $$('#chatLog .msg-menu[open]').forEach((el) => { el.open = false; });
  $('#chatSend').classList.toggle('hidden', b);
  $('#chatStop').classList.toggle('hidden', !b);
  updateUninstallButton();
}

function updateUninstallButton() {
  const ready = AI && AI.provider === 'ollama' && LOCAL && LOCAL.ready;
  const button = $('#aiUninstallBtn');
  $('#aiInstalledGroup').classList.toggle('hidden', !ready);
  button.classList.toggle('hidden', !ready);
  button.disabled = aiBusy || !!(AI && AI.busy) || aiInstalling || aiUninstalling || !!(LOCAL && LOCAL.busy);
  button.textContent = aiUninstalling ? 'Uninstalling…' : 'Uninstall AI model';
}

function renderUserContent(row) {
  row.classList.remove('editing');
  const content = document.createElement('div');
  content.className = 'msg-text';
  content.textContent = row.dataset.text;
  row.querySelector('.msg.user').replaceChildren(content);
}
function editUserMessage(row) {
  row.classList.add('editing');
  const bubble = row.querySelector('.msg.user');
  bubble.innerHTML = '<textarea class="msg-edit-input" aria-label="Edit message" rows="3"></textarea><div class="msg-edit-actions"><button type="button" class="ghost small" data-chat-cancel>Cancel</button><button type="button" class="primary small" data-chat-save>Save changes</button></div>';
  const input = bubble.querySelector('textarea');
  input.value = row.dataset.text;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
$('#chatLog').addEventListener('click', async (e) => {
  const row = e.target.closest('.user-message');
  if (!row) return;
  const summary = e.target.closest('[data-chat-menu]');
  if (summary && (aiBusy || chatChanging || !row.dataset.messageId)) { e.preventDefault(); return; }
  if (e.target.closest('[data-chat-cancel]')) { renderUserContent(row); return; }
  const edit = e.target.closest('[data-chat-edit]');
  const save = e.target.closest('[data-chat-save]');
  const remove = e.target.closest('[data-chat-delete]');
  if (!edit && !save && !remove) return;
  if (aiBusy || chatChanging) return;
  row.querySelector('.msg-menu').open = false;
  if (edit) return editUserMessage(row);
  const text = save ? row.querySelector('textarea').value : null;
  if (save && !text.trim()) return toast('Write a message before saving.');
  chatChanging = true;
  if (save) save.disabled = true;
  try {
    const r = remove ? await ff.ai.delete(row.dataset.messageId) : await ff.ai.edit(row.dataset.messageId, text);
    if (!r.ok) return toast(r.message || 'Couldn’t change the message.', 5000);
    if (remove) row.remove();
    else { row.dataset.text = text.trim(); renderUserContent(row); }
    $('#chatEmpty').classList.toggle('hidden', $('#chatLog').children.length > 0);
  } catch (err) {
    toast(`Couldn’t change the message: ${err.message || err}`, 5000);
  } finally {
    chatChanging = false;
    if (save && save.isConnected) save.disabled = false;
  }
});
$('#chatLog').addEventListener('keydown', (e) => {
  const row = e.target.closest('.user-message');
  if (!row) return;
  if (e.key === 'Escape') {
    row.querySelector('.msg-menu').open = false;
    if (row.classList.contains('editing')) renderUserContent(row);
    row.querySelector('summary').focus();
    e.preventDefault();
    e.stopPropagation();
  } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && row.classList.contains('editing')) {
    e.preventDefault();
    row.querySelector('[data-chat-save]').click();
  }
});
document.addEventListener('click', (e) => {
  $$('#chatLog .msg-menu[open]').forEach((menu) => { if (!menu.contains(e.target)) menu.open = false; });
});

/* The model picker (top right of the chat) and the Install button for models that run on this PC. */
let LOCAL = null;
let aiInstalling = false;
const localInfo = (id) => (AI && AI.localModels.find((m) => m.id === id)) || { id, name: id, size: '' };
function renderModelPick() {
  const have = (LOCAL && LOCAL.models) || [];
  const installed = (id) => have.some((n) => n === id || n === `${id}:latest`);
  const local = [...AI.localModels];
  if (AI.ollamaModel && !local.some((m) => m.id === AI.ollamaModel)) local.push({ id: AI.ollamaModel, name: AI.ollamaModel, size: '' });
  $('#chatModelPick').innerHTML =
    `<optgroup label="Claude — smartest, can make changes (API key)">${AI.models.map((x) => `<option value="claude:${esc(x.id)}">${esc(x.name.split(' —')[0])}</option>`).join('')}</optgroup>` +
    `<optgroup label="Free — runs on your PC (Ollama)">${local.map((m) => `<option value="ollama:${esc(m.id)}">${esc(m.name)}${m.size ? ` · ${esc(m.size)}` : ''}${installed(m.id) ? ' · installed' : ''}</option>`).join('')}</optgroup>`;
  $('#chatModelPick').value = AI.provider === 'ollama' ? `ollama:${AI.ollamaModel}` : `claude:${AI.model}`;
}
$('#chatModelPick').addEventListener('change', async (e) => {
  const v = e.target.value;
  const i = v.indexOf(':');
  const prov = v.slice(0, i);
  const id = v.slice(i + 1);
  S = await ff.setSettings(prov === 'claude' ? { aiProvider: 'claude', aiModel: id } : { aiProvider: 'ollama', ollamaModel: id });
  renderSettings();
  await refreshAi();
  if (prov === 'ollama' && LOCAL && !LOCAL.ready) toast(`${localInfo(id).name} isn’t installed yet — press Install at the top right.`, 5000);
});
function installLabel() {
  const m = localInfo(AI.ollamaModel);
  if (LOCAL && !LOCAL.installed) return `Install Ollama + ${m.name}`;
  return `Install ${m.name}${m.size ? ` · ${m.size}` : ''}`;
}

async function refreshAi() {
  AI = await ff.ai.status();
  LOCAL = await ff.ai.local({ start: AI.provider === 'ollama' }).catch(() => null);
  renderModelPick();
  const needKey = AI.provider === 'claude' && !AI.hasKey;
  const needInstall = AI.provider === 'ollama' && !(LOCAL && LOCAL.ready);
  const busyInstall = aiInstalling || aiUninstalling || !!(LOCAL && LOCAL.busy);
  $('#chatSetup').classList.toggle('hidden', !needKey);
  $('#localSetup').classList.toggle('hidden', !needInstall || busyInstall);
  if (needInstall) {
    const m = localInfo(AI.ollamaModel);
    $('#localSetupTitle').textContent = LOCAL && !LOCAL.installed ? `${m.name} needs the free Ollama app` : `${m.name} isn’t downloaded yet`;
    $('#localSetupText').innerHTML = LOCAL && !LOCAL.installed
      ? `Press <b>${esc(installLabel())}</b> at the top right. FrameForge installs Ollama from Microsoft’s verified app store, starts it, and downloads the model${m.size ? ` (${esc(m.size)})` : ''} — nothing else to do.`
      : `Press <b>${esc(installLabel())}</b> at the top right and FrameForge downloads it with Ollama${m.size ? ` (${esc(m.size)})` : ''}. Every part is checked against its fingerprint.`;
  }
  $('#aiInstallBtn').textContent = installLabel();
  $('#aiInstallBtn').classList.toggle('hidden', !needInstall || busyInstall);
  $('#aiReadyChip').classList.toggle('hidden', !(AI.provider === 'ollama' && LOCAL && LOCAL.ready));
  $('#aiReadyChip').textContent = 'Installed · runs on your PC';
  updateUninstallButton();
  $('#chatModelPick').disabled = aiUninstalling;
  $('#chatIn').disabled = needKey || needInstall || aiUninstalling;
  $('#chatSend').disabled = needKey || needInstall || aiUninstalling;
  $('#chatIn').placeholder = needInstall ? 'Press Install at the top right first…' : needKey ? 'Add your Claude API key above first…' : 'Ask FrameForge AI…';
  const m = AI.models.find((x) => x.id === AI.model);
  $('#chatModelLine').textContent = AI.provider === 'ollama' ? `${localInfo(AI.ollamaModel).name} runs on this PC with Ollama — free and private. Knows your PC, your preset and everything FrameForge changed.` : `${m ? m.name.split(' —')[0] : AI.model} · Knows your PC, your preset and everything FrameForge changed, and can make changes with your OK.`;
  $('#aiModelSel').innerHTML = AI.models.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
  $('#aiModelSel').value = AI.model;
  $('#aiKeyLine').textContent = AI.hasKey ? 'Saved and encrypted on this PC.' : 'Not set. Get one at console.anthropic.com › API keys.';
  $('#aiKeyRemove').classList.toggle('hidden', !AI.hasKey);
  $('#rowAiModel').classList.toggle('hidden', AI.provider !== 'claude');
  $('#rowAiKey').classList.toggle('hidden', AI.provider !== 'claude');
  $('#rowOllama').classList.toggle('hidden', AI.provider !== 'ollama');
}

async function loadChatHistory() {
  const h = await ff.ai.history();
  $('#chatLog').innerHTML = '';
  h.forEach((m) => addBubble(m.role, m.text, '', m.id));
  $('#chatEmpty').classList.toggle('hidden', h.length > 0);
}

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t || aiBusy || aiUninstalling || chatChanging || pendingUserBubble) return;
  $('#chatIn').value = '';
  autoGrow();
  setAiBusy(true);
  pendingUserBubble = addBubble('user', t);
  try {
    const r = await ff.ai.send(t);
    if (r && (r.busy || r.empty)) {
      pendingUserBubble.closest('.user-message').remove();
      toast(r.busy ? 'The AI is already replying.' : 'Write a message first.');
    }
  } catch (err) {
    pendingUserBubble.closest('.user-message').remove();
    toast(`Couldn’t send the message: ${err.message || err}`, 5000);
  } finally {
    pendingUserBubble = null;
    setAiBusy(false);
  }
}

ff.ai.onEvent((ev) => {
  if (ev.type === 'start') {
    if (pendingUserBubble && ev.messageId) pendingUserBubble.closest('.user-message').dataset.messageId = ev.messageId;
    setAiBusy(true);
    liveText = '';
    liveBubble = addBubble('assistant', '');
    liveBubble.innerHTML = '<span class="cursor"></span>';
  } else if (ev.type === 'text') {
    if (!liveBubble) liveBubble = addBubble('assistant', '');
    liveText += ev.text;
    liveBubble.innerHTML = md(liveText) + '<span class="cursor"></span>';
    chatScroll();
  } else if (ev.type === 'approval') {
    const card = document.createElement('div');
    card.className = 'approval';
    card.innerHTML = `<span>The AI wants to: <b>${esc(ev.label)}</b></span><button class="ghost small" data-no>Don’t allow</button><button class="primary small" data-yes>Allow</button>`;
    const answer = (ok) => {
      ff.ai.approve(ev.id, ok);
      card.classList.add('answered');
      card.querySelectorAll('button').forEach((b) => b.remove());
      card.querySelector('span').innerHTML += ok ? ' — <b>allowed</b>' : ' — not allowed';
    };
    // Finish the text bubble above the card (no blinking cursor left behind).
    if (liveBubble) {
      if (liveText.trim()) liveBubble.innerHTML = md(liveText);
      else liveBubble.remove();
    }
    card.querySelector('[data-yes]').onclick = () => answer(true);
    card.querySelector('[data-no]').onclick = () => answer(false);
    $('#chatLog').appendChild(card);
    // Keep the answer bubble below the approval card.
    liveBubble = null;
    liveText = '';
    chatScroll();
  } else if (ev.type === 'tool') {
    if (ev.status === 'running') addBubble('action', `${ev.label}…`);
  } else if (['done', 'error', 'stopped'].includes(ev.type)) {
    setAiBusy(false);
    if (liveBubble) {
      if (liveText.trim()) liveBubble.innerHTML = md(liveText);
      else liveBubble.remove();
    }
    liveBubble = null;
    if (ev.type === 'error') addBubble('assistant', ev.message, 'err');
    if (ev.type === 'stopped') addBubble('action', 'Stopped.');
    refreshChanges();
  }
});

function autoGrow() {
  const ta = $('#chatIn');
  ta.style.height = 'auto';
  ta.style.height = Math.min(180, ta.scrollHeight) + 'px';
}
$('#chatIn').addEventListener('input', autoGrow);
$('#chatIn').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChat($('#chatIn').value);
  }
});
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChat($('#chatIn').value);
});
$('#chatStop').onclick = () => ff.ai.stop();

$('#aiUninstallBtn').onclick = async () => {
  if (aiBusy || aiInstalling || aiUninstalling || !AI || AI.provider !== 'ollama' || !(LOCAL && LOCAL.ready)) return;
  const model = AI.ollamaModel;
  aiUninstalling = true;
  updateUninstallButton();
  $('#chatModelPick').disabled = true;
  $('#chatIn').disabled = true;
  $('#chatSend').disabled = true;
  try {
    const r = await ff.ai.uninstall(model);
    toast(r.message || (r.ok ? 'AI model uninstalled.' : 'Couldn’t uninstall the AI model.'), 5000);
  } catch (err) {
    toast(`Couldn’t uninstall the AI model: ${err.message || err}`, 5000);
  } finally {
    aiUninstalling = false;
    await refreshAi();
  }
};

// One click: FrameForge installs Ollama (if needed), starts it and downloads the chosen model.
const INSTALL_TITLE = { app: 'Installing Ollama (free)…', start: 'Starting Ollama…', model: 'Downloading the AI model…', done: 'Installed', error: 'The install didn’t finish' };
$('#aiInstallBtn').onclick = async () => {
  if (aiInstalling) return;
  aiInstalling = true;
  $('#aiInstallBtn').classList.add('hidden');
  $('#localSetup').classList.add('hidden');
  $('#aiInstallBar').classList.remove('hidden');
  $('#aiInstallCancel').classList.remove('hidden');
  $('#aiInstallTitle').textContent = 'Getting ready…';
  $('#aiInstallText').textContent = '';
  const r = await ff.ai.install(AI.ollamaModel);
  aiInstalling = false;
  $('#aiInstallCancel').classList.add('hidden');
  if (r && r.ok) {
    toast(r.message, 5000);
    setTimeout(() => $('#aiInstallBar').classList.add('hidden'), 2200);
  }
  await refreshAi();
  if (r && !r.ok) $('#aiInstallBtn').textContent = 'Try again';
};
$('#aiInstallCancel').onclick = () => ff.ai.cancelInstall();
ff.ai.onInstall((p) => {
  $('#aiInstallBar').classList.remove('hidden');
  const name = localInfo(p.model).name;
  $('#aiInstallTitle').textContent = p.stage === 'model' ? `Downloading ${name}…` : p.stage === 'done' ? `${name} is installed` : INSTALL_TITLE[p.stage] || 'Installing…';
  const bar = $('#aiInstallBar .bar');
  bar.classList.toggle('indet', p.pct == null && !['done', 'error'].includes(p.stage));
  $('#aiInstallFill').style.width = p.pct == null ? '' : `${Math.round(p.pct * 100)}%`;
  $('#aiInstallText').textContent = p.text || '';
  $('#aiInstallBar').classList.toggle('err', p.stage === 'error');
});
$('#newChatBtn').onclick = async () => {
  if (aiBusy) await ff.ai.stop();
  await ff.ai.clear();
  $('#chatLog').innerHTML = '';
  $('#chatEmpty').classList.remove('hidden');
};
document.addEventListener('click', (e) => {
  const ask = e.target.closest('[data-ask]');
  if (ask) sendChat(ask.dataset.ask);
  const link = e.target.closest('[data-link]');
  if (link) {
    e.preventDefault();
    ff.openLink(link.dataset.link);
  }
});
async function saveKey(input) {
  const v = input.value.trim();
  if (!v) return toast('Paste your API key first.');
  if (!/^sk-ant-/.test(v)) toast('That doesn’t look like a Claude API key (they start with sk-ant-). Saved anyway.');
  await ff.ai.setKey(v);
  input.value = '';
  await refreshAi();
  toast('API key saved and encrypted on this PC.');
}
$('#chatKeySave').onclick = () => saveKey($('#chatKeyIn'));
$('#aiKeySave').onclick = () => saveKey($('#aiKeyIn'));
$('#aiKeyRemove').onclick = async () => {
  await ff.ai.setKey('');
  await refreshAi();
  toast('API key removed.');
};
ff.onPresetChanged(async (st) => {
  S = st;
  renderPresets();
  await refreshProfile();
  renderSettings();
  renderAuto(S.autoMode, INFO && INFO.active);
});

/* ---------- Settings ---------- */
function renderSettings() {
  if (!S) return;
  $$('[data-key]').forEach((el) => {
    const k = el.dataset.key;
    if (el.type === 'checkbox') el.checked = !!S[k];
    else el.value = S[k];
  });
  const reasons = PROFILE ? PROFILE.reasons : {};
  const rec = PROFILE ? PROFILE.recommended : {};
  $('#tweakRows').innerHTML = TWEAKS.map((t) => {
    const why = reasons[t.id];
    return `<div class="set-row">
      <div class="set-text">
        <h3>${esc(t.name)}${t.admin ? '<span class="tag admin">Needs admin</span>' : ''}${t.reboot ? '<span class="tag reboot">Restart to finish</span>' : ''}${rec[t.id] ? '<span class="tag rec">In your preset</span>' : ''}</h3>
        <p>${esc(t.desc)}</p>
        ${why && S.smartProfile ? `<p class="why ${rec[t.id] ? '' : 'no'}">${esc(why)}</p>` : ''}
      </div>
      <label class="switch"><input type="checkbox" data-tweak="${t.id}" ${S.tweaks[t.id] ? 'checked' : ''} aria-label="${esc(t.name)}" /><span></span></label>
    </div>`;
  }).join('');
  $('#resetProfileBtn').classList.toggle('hidden', !S.tweaksCustomized);
  renderTools();
}

async function renderTools() {
  const st = await ff.toolStatus();
  const rows = [
    ['presentmon', 'PresentMon by Intel', 'FPS counter'],
    ['lhm', 'LibreHardwareMonitor', 'Temperatures'],
  ];
  $('#toolRows').innerHTML = rows
    .map(([id, name, what]) => `<div class="tool-row"><span class="t-name">${name} <span class="muted">· ${what}</span></span>${st[id] ? '<span class="t-state ok">Installed</span>' : `<button class="ghost small" data-install="${id}">Download</button>`}</div>`)
    .join('');
}

document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.tweak) {
    S = await ff.setSettings({ tweaks: { [el.dataset.tweak]: el.checked } });
    $('#resetProfileBtn').classList.remove('hidden');
    return;
  }
  const k = el.dataset.key;
  if (!k) return;
  if (k === 'overclock' && el.checked) {
    el.checked = false;
    $('#ocModal').classList.remove('hidden');
    return;
  }
  if (k === 'fpsLimitOn' && el.checked) toast('Setting up the FPS limiter… the first time this installs RTSS, which can take a minute.', 6000);
  S = await ff.setSettings({ [k]: el.type === 'checkbox' ? el.checked : el.value });
  if ((k === 'fpsLimitOn' || k === 'fpsLimit') && S && !S._error && S.fpsLimitOn) toast(`Games are now capped at ${S.fpsLimit} FPS.`);
  else if (k === 'fpsLimitOn' && S && !S._error) toast('FPS limit removed.');
  if (k === 'autoCheckUpdates') {
    if (S.autoCheckUpdates) maybeShowUpdate(await ff.updateState());
    toast(S.autoCheckUpdates ? 'Auto update is on. New versions will show a popup while you use FrameForge.' : 'Auto update is off. You can still check for updates manually.');
  }
  if (S && S._error) {
    // The change didn't fully work (Windows refused it, or the shortcut is taken): say so, and show the real state.
    toast(S._error, 8000);
    delete S._error;
    renderSettings();
  }
  if (['aiProvider', 'aiModel', 'ollamaModel'].includes(k)) refreshAi();
  if (k === 'autoFix' || k === 'autoRestart') {
    renderSettings(); // the same switch is in Fix mode and in Settings
    refreshFix();
    if (k === 'autoFix' && el.checked) ff.fix.background();
  }
  if (k === 'cttPreset' && el.value === 'Advanced') toast('Advanced removes OneDrive, Widgets and Windows AI features. Use the restore point if you want them back.', 6000);
  if (k === 'smartProfile' || k === 'overclock') {
    if (k === 'smartProfile' && el.checked) S = await ff.resetProfile();
    await refreshProfile();
    renderSettings();
  }
  if (k === 'overclock' && S.autoMode) toast('Turn Auto Mode off and on again to undo the overclock now.');
});

$('#openCttBtn').onclick = async () => {
  const b = $('#openCttBtn');
  b.disabled = true;
  b.textContent = 'Opening…';
  const r = await ff.openCtt();
  toast(r.ok ? 'Chris Titus’s Windows Utility is opening in its own window.' : `Couldn’t open it: ${r.message}`);
  b.disabled = false;
  b.textContent = 'Open Chris Titus tool';
};
$('#ocNo').onclick = () => $('#ocModal').classList.add('hidden');
$('#ocYes').onclick = async () => {
  $('#ocModal').classList.add('hidden');
  S = await ff.setSettings({ overclock: true });
  renderSettings();
  await refreshProfile();
  toast(S.autoMode ? 'Overclocking on. Turn Auto Mode off and on to apply it now.' : 'Overclocking on. It runs next time you turn on Auto Mode.');
};

$('#resetProfileBtn').onclick = async () => {
  S = await ff.resetProfile();
  renderSettings();
  toast('Boosts reset to what fits this PC best.');
};

/* ---------- Updates ---------- */
let updDismissed = null;
let updState = null;
let updDisplayedVersion = null;
let updManualCheck = false;
const updAnnounced = new Set();
function maybeShowUpdate(u = updState) {
  if (!S || !S.autoCheckUpdates || !u || !u.version || !['available', 'downloading', 'ready'].includes(u.status)) return;
  if (document.visibilityState !== 'visible' || !document.hasFocus()) return;
  if (updDismissed === u.version || updAnnounced.has(u.version)) return;
  showUpdate(u);
}
function receiveUpdate(u) {
  updState = u;
  updLine(u);
  updSide(u);
  if (['available', 'downloading', 'ready'].includes(u.status)) {
    if (updManualCheck || (!$('#updModal').classList.contains('hidden') && updDisplayedVersion === u.version)) {
      updManualCheck = false;
      showUpdate(u);
    } else maybeShowUpdate(u);
  } else if (['latest', 'error', 'dev', 'unconfigured'].includes(u.status)) updManualCheck = false;
}
window.addEventListener('focus', () => maybeShowUpdate());
document.addEventListener('visibilitychange', () => maybeShowUpdate());
function updLine(u) {
  const map = {
    idle: 'Not checked yet.',
    checking: 'Checking for updates…',
    latest: 'You have the latest version.',
    available: `Version ${u.version} is available.`,
    downloading: `Downloading update… ${u.progress}%`,
    ready: `Version ${u.version} is downloaded. Restart to install.`,
    error: u.error || 'Couldn’t check for updates.',
    dev: u.error,
    unconfigured: 'Set where updates come from above, then check.',
  };
  $('#updLine').textContent = map[u.status] || '';
  $('#updCard').classList.toggle('has-update', ['available', 'downloading', 'ready'].includes(u.status));
  const btn = $('#checkUpdBtn');
  btn.textContent = u.status === 'ready' ? 'Update now' : u.status === 'available' ? 'Download update' : u.status === 'checking' ? 'Checking…' : 'Check for updates';
  btn.disabled = u.status === 'checking' || u.status === 'downloading';
  $('#updSourceLine').textContent = u.source ? `Checking ${u.source}` : u.status === 'dev' ? '' : 'No update source set yet.';
  if (u.source && document.activeElement !== $('#updSource') && !$('#updSource').value) $('#updSource').value = u.source.replace(/^github\.com\//, '');
}
function showUpdate(u) {
  if (!u || !u.version) return;
  updDisplayedVersion = u.version;
  updAnnounced.add(u.version);
  $('#updModal').classList.remove('hidden');
  $('#updBadge').textContent = u.current ? `${u.current} → ${u.version}` : 'New';
  $('#updTitle').textContent = u.status === 'ready' ? `FrameForge ${u.version} is ready` : `FrameForge ${u.version} is out`;
  $('#updText').textContent = u.status === 'ready' ? 'Downloaded and checked. FrameForge closes, updates itself in about 10 seconds and reopens — no installer to click through. Your settings and changes list stay as they are.' : u.status === 'downloading' ? 'Downloading the update…' : 'Get the newest boosts and fixes. Your settings stay as they are.';
  const notes = $('#updNotes');
  notes.innerHTML = u.notes ? md(u.notes) : '';
  notes.classList.toggle('hidden', !u.notes);
  let later = $('#updModal .upd-later-note');
  if (!later) {
    later = document.createElement('p');
    later.className = 'upd-later-note';
    $('#updModal .modal-actions').before(later);
  }
  later.textContent = u.status === 'ready' ? 'Not now? It installs by itself the next time you quit FrameForge.' : 'It downloads in the background — you can keep using FrameForge.';
  $('#updProg').classList.toggle('hidden', u.status !== 'downloading');
  $('#updProg i').style.width = (u.progress || 0) + '%';
  const go = $('#updGo');
  go.disabled = u.status === 'downloading';
  go.textContent = u.status === 'ready' ? 'Update now' : u.status === 'downloading' ? 'Downloading…' : 'Update now';
}
function updSide(u) {
  const b = $('#sideUpdate');
  const show = ['ready', 'available', 'downloading'].includes(u.status);
  b.classList.toggle('hidden', !show);
  b.textContent = u.status === 'ready' ? `Update ${u.version} ready — install` : u.status === 'downloading' ? `Downloading ${u.version}… ${u.progress || 0}%` : `Update ${u.version} available`;
}
$('#sideUpdate').onclick = async () => showUpdate(await ff.updateState());
ff.onUpdate(receiveUpdate);
$('#updGo').onclick = async () => {
  const u = await ff.updateState();
  if (u.status === 'ready') ff.installUpdate();
  else ff.downloadUpdate();
};
$('#updLater').onclick = () => {
  updDismissed = updDisplayedVersion;
  $('#updModal').classList.add('hidden');
};
$('#updSourceSave').onclick = async () => {
  const st = await ff.setUpdateSource($('#updSource').value);
  if (st) updLine(st);
  toast(st && st.source ? `Updates now come from ${st.source}.` : st && st.status === 'dev' ? 'Saved. Updates work in the installed version.' : 'That doesn’t look like username/repo or an https link.');
};
$('#checkUpdBtn').onclick = async () => {
  updDismissed = null;
  const u = await ff.updateState();
  if (u && u.status === 'ready') return ff.installUpdate();
  if (u && u.status === 'available') {
    showUpdate(u);
    return ff.downloadUpdate();
  }
  updManualCheck = true;
  ff.checkUpdate();
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
});

/* ---------- Virus scan ---------- */
let SCAN = null;
let RES = null; // last results (with items)
let CHOICE = {}; // item id -> action
let applying = false;
let FILTER = 'all'; // results list filter
const RES_FILTERS = [
  ['all', 'All', () => true],
  ['todo', 'Needs your choice', (i) => i.status === 'active' && !i.done && ['real', 'unsure', 'pua', 'test'].includes(i.verdict)],
  ['threats', 'Threats', (i) => ['real', 'unsure'].includes(i.verdict)],
  ['unwanted', 'Unwanted programs', (i) => i.verdict === 'pua'],
  ['fp', 'False positives', (i) => i.verdict === 'fp'],
  ['history', 'Found by Defender before', (i) => i.source === 'defender'],
];
const VLABEL = { real: 'Real threat', unsure: 'Probably a threat', pua: 'Unwanted program', fp: 'False positive', test: 'Test file' };
const ALABEL = { quarantine: 'Quarantine', delete: 'Delete', keep: 'Keep', allow: 'Keep & allow', keepq: 'Leave in quarantine', restore: 'Restore' };
const STLABEL = { active: 'On the disk', quarantined: 'In Defender’s quarantine', removed: 'Already removed by Defender', gone: 'No longer on the disk', allowed: 'Allowed', ffquarantined: 'Quarantined by FrameForge', deleted: 'Deleted' };
const mins = (sec) => {
  if (sec == null) return '—';
  if (sec < 60) return `${Math.max(1, Math.round(sec))} s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const clock = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
const sizeStr = (b) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b ? `${Math.max(1, Math.round(b / 1024))} KB` : '—');
const SCANNAME = { quick: 'Quick scan', full: 'Full scan', custom: 'Custom scan' };
const LOOKUP_TEXT = { notlisted: 'not listed', off: 'turned off in Settings', failed: 'couldn’t be reached (offline?)', nohash: 'not checked' };

async function refreshScan(refresh = false) {
  SCAN = await ff.scan.info({ refresh });
  const e = SCAN.engine || {};
  const line = $('#engineLine');
  line.classList.toggle('ok', !!e.available);
  line.classList.toggle('bad', !e.available);
  $('#engineText').textContent = e.available
    ? `Microsoft Defender engine ${e.engine || ''}${e.sigVersion ? ` · virus definitions ${e.sigVersion}` : ''}${e.sigAgeHours != null ? ` (updated ${e.sigAgeHours < 1 ? 'less than an hour' : `${e.sigAgeHours} h`} ago)` : ''} · real-time protection ${e.rtp ? 'on' : 'OFF'}`
    : e.reason || 'Microsoft Defender isn’t available.';
  const est = SCAN.estimates || {};
  $('#estQuick').textContent = `about ${mins(est.quick && est.quick.sec)}${est.quick && est.quick.learned ? '' : ''}`;
  $('#estFull').textContent = `about ${mins(est.full && est.full.sec)}`;
  $('#estFull').title = est.full ? `${est.full.learned ? 'Based on your last full scan' : `Estimated from ${est.full.gb} GB used (about ${est.full.files.toLocaleString()} files)`} — the exact time left shows once the files are counted.` : '';
  $('#scanCards').classList.toggle('busy', !!SCAN.running || !e.available);
  $('#scanResultsBtn').classList.toggle('hidden', !SCAN.last);
  // Everything found on this PC so far (FrameForge scans + Defender's history)
  const t = SCAN.totals || {};
  $('#totCounts').innerHTML = cnt(t.all, 'detections in total');
  $('#totGrid').innerHTML = [
    ['real', (t.real || 0) + (t.unsure || 0), 'real threats'],
    ['fp', t.fp || 0, 'false positives'],
    ['pua', t.pua || 0, 'unwanted programs'],
    ['test', t.test || 0, 'test files'],
  ]
    .map(([c, n, l]) => `<div class="tot ${c}"><b>${n}</b><span>${l}</span></div>`)
    .join('');
  // Windows protection
  const checks = SCAN.checks || [];
  const bad = checks.filter((c) => ['big', 'medium'].includes(c.level));
  $('#secCounts').innerHTML = bad.length ? cnt(bad.length, bad.length === 1 ? 'problem' : 'problems', 'warn') : '<span class="cnt on"><b>✓</b>all good</span>';
  $('#secList').innerHTML = checks
    .map((c) => `<div class="sec ${c.level}"><div><b>${esc(c.title)}</b><p>${esc(c.body || '')}</p>${(c.details || []).map((d) => `<code>${esc(d)}</code>`).join('')}</div>${c.fix ? `<button class="${c.level === 'big' ? 'primary' : 'ghost'} small" data-secfix="${esc(c.id)}">${esc(c.fixLabel)}</button>` : ''}</div>`)
    .join('') || '<p class="muted">Checking…</p>';
  // Quarantine
  const qs = SCAN.quarantine || [];
  $('#qCounts').innerHTML = cnt(qs.length, qs.length === 1 ? 'file' : 'files');
  $('#qList').innerHTML = qs.length
    ? qs.map((x) => `<div class="q-item"><div><b>${esc(x.threat)}</b><code>${esc(x.file)}</code></div><span class="muted">${new Date(x.at).toLocaleDateString()}</span><button class="ghost small" data-qrestore="${esc(x.id)}">Restore</button><button class="ghost small stop" data-qdelete="${esc(x.id)}">Delete for good</button></div>`).join('')
    : '<p class="muted">Nothing in FrameForge’s quarantine. Quarantined files are stored encoded in a folder only Windows and administrators can open, so they can’t run.</p>';
  renderHistory(SCAN.history || []);
  if (SCAN.running) showScanRun(SCAN.running);
  else hideScanRun();
  const open = SCAN.last ? SCAN.last.open : 0;
  $('#scanBadge').textContent = open;
  $('#scanBadge').classList.toggle('hidden', !open);
  renderProtBanner();
  loadDrives();
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'just now';
  if (m < 90) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} days ago` : `${Math.round(d / 30)} months ago`;
};

/** One look at how safe this PC is: engine, Windows protection checks, open detections, how old the last scan is. */
function renderProtBanner() {
  const e = SCAN.engine || {};
  const checks = SCAN.checks || [];
  const big = checks.filter((c) => c.level === 'big');
  const med = checks.filter((c) => c.level === 'medium');
  const open = SCAN.last ? SCAN.last.open : 0;
  const lastAt = Math.max(SCAN.lastScanAt || 0, e.lastQuick ? Date.parse(e.lastQuick.at) || 0 : 0, e.lastFull ? Date.parse(e.lastFull.at) || 0 : 0); // FrameForge's scans and Defender's own
  const otherAv = (e.otherAv || []).find((a) => a.on);
  let st = 'ok';
  let icon = '✓';
  let title = 'Your PC is protected';
  let action = null;
  const notes = [];
  if (!e.available && !otherAv) {
    st = 'bad';
    icon = '!';
    title = 'Nothing is protecting this PC';
    notes.push(e.reason || 'Microsoft Defender isn’t available.');
  } else if (!e.available) {
    st = 'ok';
    title = `${otherAv.name} is protecting this PC`;
    notes.push('FrameForge can’t scan with Defender’s engine while another antivirus is in charge.');
  } else if (open) {
    st = 'bad';
    icon = '!';
    title = `${open} detection${open === 1 ? '' : 's'} need${open === 1 ? 's' : ''} your decision`;
    action = { label: 'Choose what to do', run: () => openResults() };
  } else if (big.length) {
    st = 'bad';
    icon = '!';
    title = `Windows protection has ${big.length} problem${big.length === 1 ? '' : 's'}`;
    notes.push(big.map((c) => c.title).slice(0, 2).join(' · '));
    action = { label: 'Show them', run: () => $('#secList').scrollIntoView({ behavior: 'smooth', block: 'start' }) };
  } else if (med.length) {
    st = 'warn';
    icon = '!';
    title = `Protection is good, with ${med.length} thing${med.length === 1 ? '' : 's'} to improve`;
    notes.push(med.map((c) => c.title).slice(0, 2).join(' · '));
    action = { label: 'Show them', run: () => $('#secList').scrollIntoView({ behavior: 'smooth', block: 'start' }) };
  } else if (!lastAt || Date.now() - lastAt > 14 * 86400000) {
    st = 'warn';
    icon = '!';
    title = lastAt ? 'It’s been a while since the last scan' : 'This PC hasn’t been scanned with FrameForge yet';
    action = { label: 'Start a quick scan', run: () => startScan('quick') };
  }
  if (e.available) {
    if (!e.rtp && st !== 'bad') notes.unshift('Real-time protection is off.');
    notes.push(lastAt ? `Last scan ${ago(lastAt)}` : 'No scan yet');
    if (e.sigAgeHours != null) notes.push(`definitions ${e.sigAgeHours < 1 ? 'just updated' : `updated ${e.sigAgeHours} h ago`}`);
  }
  const b = $('#protBanner');
  b.className = `prot-banner ${st}`;
  $('#pbIcon').textContent = icon;
  $('#pbTitle').textContent = title;
  $('#pbSub').textContent = notes.filter(Boolean).join(' · ');
  const btn = $('#pbAction');
  btn.classList.toggle('hidden', !action || !!SCAN.running);
  if (action) {
    btn.textContent = action.label;
    btn.onclick = action.run;
  }
  $('#updSigsBtn').classList.toggle('hidden', !e.available);
}

let DRIVES = [];
async function loadDrives() {
  try {
    DRIVES = await ff.scan.drives();
  } catch {
    DRIVES = [];
  }
  $('#driveChips').innerHTML = DRIVES.map((d) => `<button type="button" class="${d.removable ? 'usb' : ''}" data-drive="${esc(d.letter)}" title="Scan the whole ${esc(d.letter)} drive (${d.usedGB} of ${d.sizeGB} GB used)">${esc(d.letter)} ${esc(d.label || (d.removable ? 'USB / external' : 'Drive'))}<small>${d.usedGB} GB</small></button>`).join('');
}

function renderHistory(list) {
  $('#histCounts').innerHTML = cnt(list.length, list.length === 1 ? 'scan' : 'scans');
  $('#histList').innerHTML = list.length
    ? list
        .slice(0, 12)
        .map((h) => {
          const res = h.cancelled ? ['Stopped early', ''] : h.threats ? [`${h.threats} threat${h.threats === 1 ? '' : 's'} found`, 'found'] : h.unwanted ? [`${h.unwanted} unwanted program${h.unwanted === 1 ? '' : 's'}`, 'unw'] : ['All clear', 'clean'];
          const what = [h.background ? 'scheduled' : '', h.folder || '', `${(h.filesChecked || 0).toLocaleString()} files in ${mins(h.durationSec)}`].filter(Boolean).join(' · ');
          return `<div class="h-item"><b>${esc(SCANNAME[h.type] || 'Scan')}</b><span class="h-what">${esc(what)} · <span class="h-res ${res[1]}">${res[0]}</span></span><span class="h-when" title="${esc(new Date(h.endedAt).toLocaleString())}">${esc(ago(h.endedAt))}</span></div>`;
        })
        .join('')
    : '<p class="muted">Finished scans are listed here.</p>';
}

function hideScanRun() {
  $('#scanRun').classList.add('hidden');
  $('#scanCards').classList.remove('busy');
}

function showScanRun(p) {
  $('#scanRun').classList.remove('hidden');
  $('#scanRun').classList.toggle('paused', !!p.paused);
  $('#scanCards').classList.add('busy');
  $('#pbAction').classList.add('hidden');
  $('#srTitle').textContent = `${SCANNAME[p.type] || 'Scan'}${p.background ? ' (scheduled, in the background)' : ''}${p.paused ? ' — paused' : ''}`;
  $('#srPhase').textContent = p.paused ? (p.autoPaused ? 'Paused while you use the PC or play — it carries on when you’re away.' : 'Paused. Press Resume to carry on.') : p.phaseText || '';
  const pb = $('#scanPause');
  pb.classList.toggle('hidden', !(p.pausable || p.paused));
  pb.textContent = p.paused ? 'Resume' : 'Pause';
  $('#srRecent').classList.toggle('hidden', !(p.recent && p.recent.length));
  $('#srRecent').innerHTML = (p.recent || []).map((d) => `<div class="${d.kind}"><b>${esc(d.threat)}</b><code>${esc(d.file)}</code></div>`).join('');
  const counting = p.phase === 'count' || p.phase === 'update';
  $('#srFiles').textContent = counting ? (p.counted || 0).toLocaleString() : `${(p.filesDone || 0).toLocaleString()}`;
  $('#srFilesLbl').textContent = counting ? 'files found so far' : `of ${(p.filesTotal || 0).toLocaleString()} files checked`;
  $('#srEta').textContent = counting ? 'counting…' : p.etaSec == null ? '—' : `about ${mins(p.etaSec)}`;
  $('#srElapsed').textContent = clock(p.elapsedSec || 0);
  $('#srFound').textContent = p.found || 0;
  $('#srFill').style.width = `${Math.round((p.pct || 0) * 100)}%`;
  $('#srCurrent').textContent = p.current ? `Now: ${p.current}` : '';
}
ff.scan.onProgress((p) => {
  if (!p) return;
  showScanRun(p);
});
ff.scan.onDone(async (d) => {
  $('#scanRun').classList.add('hidden');
  $('#scanCards').classList.remove('busy');
  if (!d.ok) {
    toast(`The scan couldn’t run: ${d.message}`, 8000);
    refreshScan(true);
    return;
  }
  await refreshScan(true);
  // A scheduled scan that found nothing shouldn't pop a window up in front of you.
  if (d.background && !d.open) return toast(`The scheduled ${(SCANNAME[d.type] || 'scan').toLowerCase()} finished — all clear (${(d.filesChecked || 0).toLocaleString()} files).`, 6000);
  openResults();
});
async function startScan(type, folder = null) {
  const r = await ff.scan.start(type, folder);
  if (r && (r.busy || r.ok === false)) return toast(r.message || 'A scan is already running.');
  showScanRun({ type, phase: 'prepare', phaseText: 'Getting ready…', elapsedSec: 0 });
}
$$('[data-start]').forEach((b) =>
  b.addEventListener('click', async () => {
    const what = b.dataset.start;
    if (what === 'custom' || what === 'file') {
      const picked = what === 'file' ? await ff.scan.pickFile() : await ff.scan.pickFolder();
      if (picked) startScan('custom', picked);
      return;
    }
    startScan(what);
  })
);
$('#driveChips').addEventListener('click', (e) => {
  const b = e.target.closest('[data-drive]');
  if (b && !SCAN.running) startScan('custom', `${b.dataset.drive}\\`);
});
$('#scanStop').onclick = async () => {
  $('#scanStop').disabled = true;
  await ff.scan.cancel();
  setTimeout(() => ($('#scanStop').disabled = false), 1500);
};
$('#scanPause').onclick = async () => {
  const pausing = $('#scanPause').textContent === 'Pause';
  $('#scanPause').disabled = true;
  await (pausing ? ff.scan.pause() : ff.scan.resume());
  $('#scanPause').disabled = false;
};
$('#updSigsBtn').onclick = async () => {
  const b = $('#updSigsBtn');
  b.disabled = true;
  b.textContent = 'Updating…';
  const r = await ff.scan.updateSigs();
  b.disabled = false;
  b.textContent = 'Update definitions';
  toast(r.message, 5000);
  refreshScan(true);
};
$('#scanResultsBtn').onclick = () => openResults();
ff.scan.onShowResults(() => openResults());

document.addEventListener('click', async (e) => {
  const sf = e.target.closest('[data-secfix]');
  if (sf) {
    sf.disabled = true;
    sf.textContent = 'Fixing…';
    const r = await ff.scan.fixCheck(sf.dataset.secfix);
    toast(r.message, 5000);
    refreshScan(true);
    return;
  }
  const qr = e.target.closest('[data-qrestore]');
  if (qr) {
    const r = await ff.scan.qRestore(qr.dataset.qrestore, true);
    toast(r.message, 5000);
    return refreshScan();
  }
  const qd = e.target.closest('[data-qdelete]');
  if (qd) {
    const r = await ff.scan.qDelete(qd.dataset.qdelete);
    toast(r.message);
    return refreshScan();
  }
  const vt = e.target.closest('[data-vt]');
  if (vt) return ff.scan.virusTotal(vt.dataset.vt);
  const sh = e.target.closest('[data-showfile]');
  if (sh) return ff.scan.showFile(sh.dataset.showfile);
  const flt = e.target.closest('[data-filter]');
  if (flt && RES) {
    FILTER = flt.dataset.filter;
    return renderResults();
  }
  const bulk = e.target.closest('[data-bulk]');
  if (bulk && RES && !applying) {
    if (bulk.dataset.bulk === 'delete') {
      const deletions = {};
      for (const it of RES.items) {
        if (!it.done && ['real', 'unsure', 'pua', 'test'].includes(it.verdict) && it.actions.includes('delete')) deletions[it.id] = 'delete';
      }
      if (!Object.keys(deletions).length) return toast('No threats available to delete.');
      Object.assign(CHOICE, deletions);
      renderResults();
      return applyResults(deletions);
    }
    for (const it of RES.items) {
      if (!it.actions.length || it.done) continue;
      if (bulk.dataset.bulk === 'reset') CHOICE[it.id] = it.defaultAction;
      else if (['real', 'unsure', 'pua', 'test'].includes(it.verdict) && it.actions.includes(bulk.dataset.bulk)) CHOICE[it.id] = bulk.dataset.bulk;
    }
    renderResults();
  }
});
document.addEventListener('change', (e) => {
  const r = e.target.closest('[data-act]');
  if (r && !applying) {
    CHOICE[r.dataset.act] = r.value;
    renderPlan();
  }
});

async function openResults() {
  if (applying) return $('#scanModal').classList.remove('hidden');
  RES = await ff.scan.last();
  if (!RES) return toast('No scan results yet.');
  CHOICE = {};
  FILTER = RES.items.some(RES_FILTERS[1][2]) ? 'todo' : 'all'; // open on what needs a decision
  for (const it of RES.items) if (it.actions.length && !it.done) CHOICE[it.id] = it.defaultAction;
  applying = false;
  $('#resApply').disabled = false;
  $('#resApply').textContent = 'Do it';
  $('#resLater').textContent = 'Decide later';
  renderResults();
  $('#scanModal').classList.remove('hidden');
}
function renderPlan() {
  const n = {};
  for (const [id, a] of Object.entries(CHOICE)) {
    const it = RES.items.find((i) => i.id === id);
    if (!it || it.done) continue;
    n[a] = (n[a] || 0) + 1;
  }
  const parts = ['quarantine', 'delete', 'restore', 'allow', 'keep', 'keepq'].filter((a) => n[a]).map((a) => `${n[a]} ${a === 'quarantine' ? 'to quarantine' : a === 'delete' ? 'to delete' : a === 'restore' ? 'to restore' : a === 'allow' ? 'to keep & allow' : a === 'keepq' ? 'left in quarantine' : 'kept'}`);
  $('#resPlan').textContent = parts.length ? parts.join(' · ') : 'Nothing to do.';
  $('#resApply').classList.toggle('hidden', !parts.length);
}
function renderResults() {
  const r = RES;
  const c = r.counts || {};
  const h = r.historyCounts || {};
  const scanFound = r.items.filter((i) => i.source !== 'defender').length;
  $('#resTitle').textContent = r.cancelled ? 'Scan stopped' : scanFound ? `${SCANNAME[r.type]} finished — ${scanFound} detection${scanFound === 1 ? '' : 's'}` : `${SCANNAME[r.type]} finished — no threats found`;
  $('#resSub').textContent = `${r.filesChecked.toLocaleString()} file${r.filesChecked === 1 ? '' : 's'} checked in ${mins(r.durationSec)}${r.folder ? ` · ${r.folder}` : ''} · ${new Date(r.endedAt).toLocaleString()}${(r.notes || []).length ? ` · ${r.notes.join(' ')}` : ''}`;
  $('#resTiles').innerHTML = [
    ['real', (c.real || 0) + (c.unsure || 0), 'real threats'],
    ['fp', c.fp || 0, 'false positives'],
    ['pua', c.pua || 0, 'unwanted programs'],
    ['test', c.test || 0, 'test files'],
    ['', r.items.filter((i) => i.source === 'defender').length, 'found by Defender before'],
  ]
    .map(([k, n, l]) => `<div class="tot ${k}"><b>${n}</b><span>${l}</span></div>`)
    .join('');
  $('#resBulk').classList.toggle('hidden', !r.items.some((i) => !i.done && i.actions.length && ['real', 'unsure', 'pua', 'test'].includes(i.verdict)));
  $('[data-bulk="delete"]').disabled = applying || !r.items.some((i) => !i.done && ['real', 'unsure', 'pua', 'test'].includes(i.verdict) && i.actions.includes('delete'));
  const chips = RES_FILTERS.map(([id, label, test]) => [id, label, r.items.filter(test).length]).filter(([id, , n]) => id === 'all' || n > 0);
  $('#resFilters').innerHTML = r.items.length > 2 && chips.length > 2 ? chips.map(([id, label, n]) => `<button type="button" class="${id === FILTER ? 'on' : ''}" data-filter="${id}">${label}<span>${n}</span></button>`).join('') : '';
  const test = (RES_FILTERS.find((f) => f[0] === FILTER) || RES_FILTERS[0])[2];
  const shown = $('#resFilters').innerHTML ? r.items.filter(test) : r.items;
  if (!r.items.length) {
    $('#resList').innerHTML = `<div class="res-empty"><b>All clear</b>Microsoft Defender’s engine found nothing in ${r.filesChecked.toLocaleString()} files, and Defender has no earlier detections on this PC.</div>`;
  } else {
    $('#resList').innerHTML = shown
      .map((it) => {
        const status = STLABEL[it.status] || it.status;
        const found = it.source === 'defender' ? `by Microsoft Defender on ${new Date(it.detectedAt).toLocaleDateString()}` : it.source === 'memory' ? 'by Defender’s memory check in this scan' : 'by this scan';
        const facts = [
          `Signed by: <b>${it.signer ? esc(it.signer) : it.status === 'active' ? 'nobody (not signed)' : 'unknown'}</b>`,
          `Size: <b>${sizeStr(it.size)}</b>`,
          `Known-software database: <b>${it.known ? `listed (${esc(it.known.source)})` : LOOKUP_TEXT[it.lookup] || 'not checked'}</b>`,
          `Found: <b>${found}</b>`,
          it.sha256 ? `SHA-256: <b>${it.sha256.slice(0, 12)}…${it.sha256.slice(-6)}</b> · <a data-vt="${it.sha256}">Second opinion on VirusTotal</a>` : '',
          it.file && it.status === 'active' ? `<a data-showfile="${esc(it.file)}">Show in folder</a>` : '',
        ].filter(Boolean);
        const acts = it.done
          ? ''
          : it.actions.length
            ? `<div class="seg" role="radiogroup" aria-label="What to do">${it.actions.map((a) => `<label><input type="radio" name="act-${esc(it.id)}" data-act="${esc(it.id)}" value="${a}" ${CHOICE[it.id] === a ? 'checked' : ''}/><span class="a-${a}">${ALABEL[a]}</span></label>`).join('')}</div>`
            : `<span class="muted">${it.status === 'removed' ? 'Nothing to do — Defender already removed it.' : 'Nothing to do.'}</span>`;
        return `<div class="ri v-${it.verdict}" data-ri="${esc(it.id)}">
          <div class="ri-head"><span class="vbadge ${it.verdict}">${VLABEL[it.verdict]}</span><b class="ri-name">${esc(it.threat)}</b><span class="ri-status ${it.running ? 'hot' : ''}">${esc(status)}${it.running ? ' · running now' : ''}</span></div>
          <p class="ri-type"><b>${it.verdict === 'fp' ? 'What Defender thinks it is' : 'What it is'}:</b> ${esc(it.typeInfo)}</p>
          ${it.file ? `<code class="ri-path">${esc(it.file)}</code>` : `<code class="ri-path">${esc((it.other || []).join(' · ') || 'No file (memory or registry)')}</code>`}
          <div class="ri-facts">${facts.map((f) => `<span>${f}</span>`).join('')}</div>
          <details ${['fp', 'unsure'].includes(it.verdict) ? 'open' : ''}><summary>Why FrameForge says “${VLABEL[it.verdict].toLowerCase()}”</summary><ul>${it.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>
          ${acts}
          <div class="ri-result ${it.done ? 'ok' : it.doneMessage ? 'err' : ''}">${it.done ? `✓ ${esc(it.doneMessage || ALABEL[it.done])}` : it.doneMessage ? `✕ ${esc(it.doneMessage)}` : ''}</div>
        </div>`;
      })
      .join('');
  }
  renderPlan();
}
ff.scan.onApplying((a) => {
  const el = $(`[data-ri="${CSS.escape(a.id)}"] .ri-result`);
  if (el) {
    el.className = 'ri-result';
    el.textContent = `${ALABEL[a.action]}…`;
  }
});
ff.scan.onApplied((a) => {
  const card = $(`[data-ri="${CSS.escape(a.id)}"]`);
  if (!card) return;
  const el = card.querySelector('.ri-result');
  el.className = `ri-result ${a.ok ? 'ok' : 'err'}`;
  el.textContent = `${a.ok ? '✓' : '✗'} ${a.message}`;
  if (a.ok) {
    const seg = card.querySelector('.seg');
    if (seg) seg.remove();
    const st = card.querySelector('.ri-status');
    if (st) st.textContent = STLABEL[a.status] || a.status;
  }
});
async function applyResults(choices) {
  if (applying) return;
  applying = true;
  const requested = { ...choices };
  $$('#resList .seg').forEach((s) => s.classList.add('locked'));
  $$('#resList input, #resBulk button').forEach((el) => { el.disabled = true; });
  $('#resApply').disabled = true;
  $('#resApply').textContent = 'Working…';
  $('#resPlan').textContent = Object.values(requested).every((a) => a === 'delete') ? `Deleting ${Object.keys(requested).length} threat(s)…` : 'Applying your choices…';
  try {
    const r = await ff.scan.apply(requested);
    if (!r.results) throw new Error(r.message || 'Couldn’t apply your choices.');
    RES = (await ff.scan.last()) || RES;
    renderResults();
    const ok = r.results.filter((x) => x.ok).length;
    const failed = r.results.length - ok;
    $('#resPlan').textContent = `${failed ? 'Needs attention' : 'Done'} — ${ok} of ${r.results.length} handled.${failed ? ` ${failed} failed; see the details and retry.` : ''}${r.reboot ? ' A locked file will be removed at the next restart.' : ''}`;
    $('#resLater').textContent = 'Close';
    const refreshed = await Promise.allSettled([refreshScan(), refreshChanges(), refreshFix()]);
    if (refreshed.some((x) => x.status === 'rejected')) toast('Actions finished. Some status panels could not refresh.');
  } catch (err) {
    $('#resPlan').textContent = `Couldn’t finish: ${err.message || err}. You can retry.`;
    toast($('#resPlan').textContent, 5000);
  } finally {
    applying = false;
    $$('#resList .seg').forEach((s) => s.classList.remove('locked'));
    $$('#resList input, #resBulk button').forEach((el) => { el.disabled = false; });
    $('#resApply').disabled = false;
    $('#resApply').textContent = 'Do it';
    $('[data-bulk="delete"]').disabled = !RES.items.some((i) => !i.done && ['real', 'unsure', 'pua', 'test'].includes(i.verdict) && i.actions.includes('delete'));
  }
}
$('#resApply').onclick = () => applyResults(CHOICE);
$('#resExport').onclick = async () => {
  const r = await ff.scan.exportReport();
  if (r.ok) toast('Report saved.', 4000);
  else if (!r.canceled) toast(r.message || 'Couldn’t save the report.');
};
$('#resLater').onclick = () => $('#scanModal').classList.add('hidden');
$('#resClose').onclick = () => $('#scanModal').classList.add('hidden');

/* ---------- Windows animations (Settings) ---------- */
async function refreshAnim(st) {
  st = st || (await ff.anim.get());
  const sw = $('#animSwitch');
  sw.checked = st.want ? st.want === 'on' : st.on;
  const now = st.on ? 'all on' : st.off ? 'all off' : 'some on, some off';
  $('#animLine').textContent = st.want ? `Right now: ${now}. FrameForge keeps them ${st.want} — even if another tool or Windows Settings changes them.` : `Right now in Windows: ${now}. Flip the switch and FrameForge takes over.`;
  if (st.want === 'on' && !st.on && st.details) {
    const missing = st.details.filter((d) => d.group !== 'separate' && !d.on).map((d) => d.name);
    if (missing.length) $('#animLine').textContent += ` Still off or unavailable: ${missing.join(', ')}.`;
  }
}
$('#animSwitch').addEventListener('change', async (e) => {
  const on = e.target.checked;
  e.target.disabled = true;
  try {
    const r = await ff.anim.set(on);
    toast(r.ok ? (on ? 'Windows animations and window dragging effects are on.' : 'Windows animations and window dragging effects are off.') : r.message || 'Windows didn’t accept every part of the change.', 5000);
    await refreshAnim(r);
    refreshChanges();
  } catch (err) {
    toast(`Couldn’t change Windows animations: ${err.message || err}`, 5000);
    refreshAnim().catch(() => {});
  } finally {
    e.target.disabled = false;
  }
});
ff.anim.onChanged(() => refreshAnim());

/* ---------- Boot ---------- */
(async () => {
  INFO = await ff.info();
  S = await ff.settings();
  TWEAKS = await ff.tweaks();
  PRESETS = await ff.presets();
  await refreshAi();
  await loadChatHistory();
  await refreshFix();
  setInterval(refreshFix, 15000); // temperatures and tools can change
  refreshScan().catch(() => {});
  refreshAnim().catch(() => {});
  slide = Math.max(0, PRESETS.findIndex((p) => p.id === S.preset));
  renderPresets();
  await refreshChanges();
  $('#sideVersion').textContent = `v${INFO.version}${INFO.demo ? ' · demo' : ''}`;
  $('#verLine').textContent = `FrameForge ${INFO.version}`;
  $('#adminBadge').classList.toggle('hidden', INFO.admin);
  const r = await ff.rig();
  if (r) renderRig(r);
  await refreshProfile();
  renderSettings();
  renderAuto(S.autoMode, INFO.active);
  const u = await ff.updateState();
  if (u) receiveUpdate(u);
  if (S.updateSource) $('#updSource').value = S.updateSource;
  $('#overlayBtn').textContent = 'Hide overlay';
  const st = await ff.autoState();
  if (st && st.busy) {
    busy = true;
    showRun(true);
    lever.classList.add('busy');
  }
})();
