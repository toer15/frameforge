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
  $('#undoAllBtn').classList.toggle('hidden', !live);
  $('#clearHistBtn').classList.toggle('hidden', !CHANGES.some((e) => !e.undoable));
  const pn = (id) => (PRESETS.find((p) => p.id === id) || { name: id }).name;
  $('#changeList').innerHTML = CHANGES.map(
    (e) => `<li class="${e.undoable ? '' : 'oneshot'}">
      <div class="ch-top"><b>${esc(e.name)}</b>
        <span class="ch-meta">${when(e.at)} · ${esc(pn(e.preset))}</span>
        ${e.undoable ? '<span class="ch-state active">Still active</span>' : '<span class="ch-state once">Done once</span>'}
        ${e.reboot ? '<span class="ch-state reboot">Needs a restart</span>' : ''}
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

/* ---------- Fix mode ---------- */
let FIX = null;
const FIX_ASK = (it) => `Help me fix this problem on my PC: “${it.title}”. ${it.body || ''} ${it.details && it.details.length ? 'Details: ' + it.details.slice(0, 6).join(' | ') : ''} Explain what caused it and fix it if you can.`;

function showView(name) {
  $$('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${name}`));
}

async function refreshFix() {
  FIX = await ff.fix.list();
  const items = FIX.items;
  const badge = $('#fixBadge');
  badge.textContent = items.length;
  badge.classList.toggle('hidden', !items.length);
  $('#fixAllBtn').disabled = !items.some((i) => i.auto);
  $('#fixList').innerHTML = items.length
    ? items.map((it) => `<div class="fix-item ${it.level}" data-fix="${esc(it.id)}">
        <h3>${esc(it.title)}${it.auto ? '<span class="tag rec">Can fix automatically</span>' : ''}${it.bios ? '<span class="tag bios">Fixed in the BIOS</span>' : ''}</h3>
        <p>${esc(it.body || '')}</p>
        ${it.details && it.details.length ? `<details><summary>What happened (${it.details.length})</summary><ul class="ch-exact">${it.details.map((d) => `<li><code>${esc(d)}</code></li>`).join('')}</ul></details>` : ''}
        <div class="fix-actions">
          ${it.actions.map((a) => `<button class="${/^(retry|install|repair)/.test(a.id) ? 'primary' : 'ghost'} small" data-fixact="${esc(a.id)}">${esc(a.label)}</button>`).join('')}
          <button class="ghost small" data-fixask="${esc(it.id)}">Ask AI to explain and fix</button>
        </div>
      </div>`).join('')
    : '<div class="fix-ok">Nothing to fix right now. If something feels off — stutter, crashes, lag — try a repair tool below or ask the AI.</div>';
  $('#repairGrid').innerHTML = FIX.repairs
    .map((r) => `<div class="repair"><h3>${esc(r.name)}</h3><p>${esc(r.desc)}</p><div class="fix-actions"><button class="primary small" data-fixact="repair:${r.id}">Run it</button><button class="ghost small" data-repairask="${esc(r.id)}">Ask AI if I need this</button></div></div>`)
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
$('#fixAllBtn').onclick = async () => {
  const b = $('#fixAllBtn');
  b.disabled = true;
  b.textContent = 'Fixing…';
  const res = await ff.fix.all();
  const fixed = res.filter((r) => r.fixed).length;
  toast(res.length ? `Fixed ${fixed} of ${res.length} problem${res.length === 1 ? '' : 's'}. ${fixed < res.length ? 'Ask the AI about the rest.' : ''}` : 'Nothing could be fixed automatically — the rest needs you (see each problem).', 6000);
  b.textContent = 'Fix everything automatically';
  refreshFix();
  refreshChanges();
};

/* ---------- AI chat ---------- */
let AI = null;
let aiBusy = false;
let liveBubble = null;
let liveText = '';

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
function addBubble(role, text, extra = '') {
  const d = document.createElement('div');
  d.className = `msg ${role} ${extra}`;
  if (role === 'user') d.textContent = text;
  else if (role === 'action') d.textContent = `⚙ ${text}`;
  else d.innerHTML = md(text);
  $('#chatLog').appendChild(d);
  $('#chatEmpty').classList.add('hidden');
  chatScroll();
  return d;
}
function setAiBusy(b) {
  aiBusy = b;
  $('#chatSend').classList.toggle('hidden', b);
  $('#chatStop').classList.toggle('hidden', !b);
}

async function refreshAi() {
  AI = await ff.ai.status();
  const needKey = AI.provider === 'claude' && !AI.hasKey;
  $('#chatSetup').classList.toggle('hidden', !needKey);
  $('#chatIn').disabled = needKey;
  $('#chatSend').disabled = needKey;
  const m = AI.models.find((x) => x.id === AI.model);
  $('#chatModelLine').textContent = AI.provider === 'ollama' ? `Running ${AI.ollamaModel} on this PC with Ollama. Knows your PC, your preset and everything FrameForge changed.` : `${m ? m.name.split(' —')[0] : AI.model} · Knows your PC, your preset and everything FrameForge changed, and can make changes with your OK.`;
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
  h.forEach((m) => addBubble(m.role, m.text));
  $('#chatEmpty').classList.toggle('hidden', h.length > 0);
}

async function sendChat(text) {
  const t = String(text || '').trim();
  if (!t || aiBusy) return;
  $('#chatIn').value = '';
  autoGrow();
  addBubble('user', t);
  await ff.ai.send(t);
}

ff.ai.onEvent((ev) => {
  if (ev.type === 'start') {
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
  S = await ff.setSettings({ [k]: el.type === 'checkbox' ? el.checked : el.value });
  if (['aiProvider', 'aiModel', 'ollamaModel'].includes(k)) refreshAi();
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
  $('#updSourceLine').textContent = u.source ? `Checking ${u.source}` : u.status === 'dev' ? '' : 'No update source set yet.';
  if (u.source && document.activeElement !== $('#updSource') && !$('#updSource').value) $('#updSource').value = u.source.replace(/^github\.com\//, '');
}
function showUpdate(u) {
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
ff.onUpdate((u) => {
  updLine(u);
  updSide(u);
  if (['available', 'downloading', 'ready'].includes(u.status) && updDismissed !== `${u.version}:${u.status}`) showUpdate(u);
});
$('#updGo').onclick = async () => {
  const u = await ff.updateState();
  if (u.status === 'ready') ff.installUpdate();
  else ff.downloadUpdate();
};
$('#updLater').onclick = async () => {
  const u = await ff.updateState();
  updDismissed = u ? `${u.version}:${u.status}` : null;
  $('#updModal').classList.add('hidden');
};
$('#updSourceSave').onclick = async () => {
  const st = await ff.setUpdateSource($('#updSource').value);
  if (st) updLine(st);
  toast(st && st.source ? `Updates now come from ${st.source}.` : st && st.status === 'dev' ? 'Saved. Updates work in the installed version.' : 'That doesn’t look like username/repo or an https link.');
};
$('#checkUpdBtn').onclick = () => {
  updDismissed = null;
  ff.checkUpdate();
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') $$('.modal').forEach((m) => m.classList.add('hidden'));
});

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
  if (u) {
    updLine(u);
    updSide(u);
    if (['available', 'downloading', 'ready'].includes(u.status)) showUpdate(u);
  }
  if (S.updateSource) $('#updSource').value = S.updateSource;
  $('#overlayBtn').textContent = 'Hide overlay';
  const st = await ff.autoState();
  if (st && st.busy) {
    busy = true;
    showRun(true);
    lever.classList.add('busy');
  }
})();
