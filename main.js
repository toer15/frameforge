// FrameForge — main process
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, screen, nativeImage, dialog, clipboard, Notification, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');

const { run, ps, isAdmin, sleep, IS_WIN, DEMO } = require('./src/util');
const os = require('os');
const { settings, changes, problems, backup } = require('./src/store');
const fixes = require('./src/fixes');
const presets = require('./src/presets');
const hardware = require('./src/hardware');
const optimizer = require('./src/optimizer');
const tweaksTab = require('./src/tweaks'); // adds the Tweaks-tab boosts to optimizer.TWEAKS
const profile = require('./src/profile');
const tools = require('./src/tools');
const { FpsReader } = require('./src/fps');
const { Sensors } = require('./src/sensors');
const updater = require('./src/updater');
const updateRelaunch = require('./src/update-relaunch');
const ai = require('./src/ai');
const localAi = require('./src/localai');
const scanner = require('./src/scanner');
const scanjob = require('./src/scanjob');
const animations = require('./src/animations');
const fplimit = require('./src/fplimit');
const controllers = require('./src/controllers');
const cleaner = require('./src/cleaner');
const startupApps = require('./src/startup');

app.setAppUserModelId('com.twicytom.frameforge');

let mainWin = null;
let overlayWin = null;
let tray = null;
let admin = true;
let rig = null;
let busy = false;
let overlayShown = true;
let quitting = false;
let updates = null;
let showWhenReady = false;

const fps = new FpsReader();
const sensors = new Sensors();

const ICON = path.join(__dirname, 'assets', 'icon.png');

function send(channel, payload) {
  if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send(channel, payload);
}

// ---------- Startup: one copy only, and run as administrator ----------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
  app.whenReady().then(boot);
}

async function relaunchAsAdmin() {
  const args = process.argv.slice(1).filter((a) => a !== '--hidden');
  const list = args.length ? `-ArgumentList ${args.map((a) => `'${a.replace(/'/g, "''")}'`).join(',')}` : '';
  app.releaseSingleInstanceLock();
  const r = await ps(`Start-Process -FilePath '${process.execPath.replace(/'/g, "''")}' ${list} -Verb RunAs`);
  if (r.code === 0) {
    app.exit(0);
    return true;
  }
  app.requestSingleInstanceLock();
  return false;
}

async function boot() {
  if (IS_WIN && !DEMO) {
    admin = await isAdmin();
    if (!admin && !process.argv.includes('--no-elevate')) {
      if (await relaunchAsAdmin()) return;
    }
  }

  const reopenedAfterUpdate = updateRelaunch.consume(app);
  createMainWindow(process.argv.includes('--hidden') && !reopenedAfterUpdate, reopenedAfterUpdate);
  createTray();
  scanjob.init({ send, onFinished: onScanFinished });
  updates = updater.setup({ send, getSettings: settings.get, onEvent: onUpdateEvent, isActive: () => !windowHidden() && mainWin.isFocused() });

  reclassifyOldCttProblem();
  rig = await hardware.scan(settings.get().manualHardware).catch(() => null);
  applyProfileIfAuto();
  send('rig', rig);

  applyMonitoring();
  registerHotkey();
  setInterval(telemetryTick, 1000);
  detectExtra().then(() => send('fix:changed', true)).catch(() => {});
  setInterval(() => detectExtra().then(() => {
    send('fix:changed', true);
    backgroundFix('check');
    enforceAnimations('check');
  }).catch(() => {}), 2 * 60 * 1000);
  const resuming = settings.get().resumeFixAll || process.argv.includes('--resume-fix');
  if (resuming) removeResumeTask();
  if (resuming && (admin || DEMO)) {
    settings.set({ resumeFixAll: false });
    setTimeout(() => {
      showMain();
      send('goto', 'fix');
      fixEverything({ resumed: true });
    }, 800);
  } else {
    // Fix mode works on its own: a little after start, and after every re-check, it fixes what it safely can.
    setTimeout(() => backgroundFix('start'), DEMO ? 3000 : 8000);
  }
  // Keep the user's animation choice, and check Windows' protection a little after start.
  setTimeout(() => enforceAnimations('start'), 2000);
  // Keep the "Start with Windows" task pointing at this copy of FrameForge (the install folder can change).
  if (settings.get().startWithWindows && admin && !DEMO) setStartWithWindows(true).catch(() => {});
  setInterval(() => animWatch(), 20000);
  // FPS limiter: put the user's cap back after a restart, or if another tool changed it or RTSS was closed.
  setTimeout(() => limiterWatch(), DEMO ? 1500 : 5000);
  setInterval(() => limiterWatch(), 60 * 1000);
  if (DEMO && process.env.FRAMEFORGE_TEST_ANIM_TAMPER) setTimeout(() => animations.demoTamper(), 20000); // test: another app flips the animations
  setTimeout(() => refreshSecurity().then(() => send('fix:changed', true)).catch(() => {}), DEMO ? 2000 : 8000);
  setInterval(() => refreshSecurity().catch(() => {}), 30 * 60 * 1000);
  // Scheduled virus scans: checked a minute after start and every 2 minutes; a background scan steps aside for games and for you.
  setTimeout(() => autoScanTick(), DEMO ? 6000 : 20000);
  setInterval(() => autoScanTick(), 2 * 60 * 1000);
  setInterval(() => {
    if (scanjob.background()) scanjob.autoPause(gameRunning() || idleMinutes() < 1);
  }, 15000);
  // NVIDIA resets power limits on every restart: put back the cooler limit Fix mode set for a hot card.
  if (backup.get('gpu_cool') && !DEMO && admin) {
    const t = tweakById('gpu_cool');
    if (t) t.apply().catch(() => {});
  }

  // After a PC restart, Auto Mode switches itself off. The changes stay exactly as they are —
  // they're listed in "What FrameForge changed on your PC" and can be undone from there.
  const s = settings.get();
  if (s.autoMode && s.lastBoot && (Math.abs(bootTime() - s.lastBoot) > 2 * 60 * 1000 || process.env.FRAMEFORGE_FAKE_REBOOT === '1')) {
    settings.set({ autoMode: false, restartedNotice: true });
    rebuildTrayMenu();
  }
}

/** When Windows last started (to the minute). */
function bootTime() {
  return Math.round((Date.now() - os.uptime() * 1000) / 60000) * 60000;
}

/**
 * Versions before 1.0.4 called the Chris Titus step failed when winutil only reported items that don't exist
 * on this PC (like the 'wermgr' service). Those runs did apply the preset, so move them to the changes list.
 */
function reclassifyOldCttProblem() {
  // 1.0.5 called a power setting Windows refuses to change (e.g. core parking on AMD X3D) a failure.
  // Since 1.0.6 that's shown as "locked on this PC" in the Tweaks tab instead of a Fix-mode problem.
  for (const [id, prob] of Object.entries(problems.all())) {
    if (!/malformed, or is not within the range/i.test(prob.message || '')) continue;
    const locked = { ...(settings.get().lockedTweaks || {}) };
    locked[id] =
      id === 'core_parking'
        ? 'Your CPU’s driver manages core parking itself and doesn’t let apps change it — that’s normal, especially on AMD X3D chips. Nothing was changed, and Windows still uses all your cores.'
        : `Windows doesn’t allow apps to change this setting on this PC, so nothing was changed.`;
    settings.set({ lockedTweaks: locked });
    problems.remove(id);
  }
  const p = problems.all().ctt_tweaks;
  if (!p) return;
  const errs = (p.details || []).filter((d) => d.startsWith('Error: '));
  const real = errs.filter((d) => !tools.HARMLESS.test(d));
  const timedOut = (p.details || []).some((d) => /TIMED OUT/i.test(d)) || /took too long|timed out/i.test(p.message || '');
  if (!errs.length || real.length || timedOut) return;
  const preset = ((p.message || '').match(/the (\w+) preset/) || [])[1] || settings.get().cttPreset;
  changes.put('ctt_tweaks', {
    name: p.name,
    summary: `Applied Chris Titus’s ${preset} preset. ${errs.length} item${errs.length === 1 ? ' was' : 's were'} skipped because ${errs.length === 1 ? 'it isn’t' : 'they aren’t'} on your version of Windows — that’s normal.`,
    details: (p.details || []).map((d) => (d.startsWith('Error: ') ? `Skipped (not on this PC — normal): ${d.slice(7).replace(/^\[[^\]]+\]\s*/, '').replace(/^Non-terminating error\s*:\s*/i, '')}` : d)).filter((d) => !/^Tweaks: \d+ error/.test(d)),
    at: p.at || Date.now(),
    preset: settings.get().preset,
    undoable: false,
    reboot: false,
  });
  problems.remove('ctt_tweaks');
}

// ---------- Windows ----------

// Controller tab: the page reads Sony and Nintendo pads straight over HID (buttons, sticks, triggers, touchpad and
// motion sensors), so no driver is needed. Only game controllers from those two vendors are allowed.
const PAD_HID_VENDORS = [0x054c, 0x057e];
function allowPadHid(ses) {
  if (ses.__ffPadHid) return;
  ses.__ffPadHid = true;
  ses.setDevicePermissionHandler((d) => d.deviceType === 'hid' && PAD_HID_VENDORS.includes(d.device.vendorId));
  ses.on('select-hid-device', (event, details, callback) => {
    event.preventDefault();
    const d = details.deviceList.find((x) => PAD_HID_VENDORS.includes(x.vendorId));
    callback(d ? d.deviceId : '');
  });
}

function createMainWindow(hidden, focusWhenReady = false) {
  if (showWhenReady) {
    hidden = false;
    focusWhenReady = true;
    showWhenReady = false;
  }
  mainWin = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: !hidden && !focusWhenReady,
    backgroundColor: '#0a0f1c',
    icon: ICON,
    title: 'FrameForge',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  if (focusWhenReady) {
    mainWin.once('ready-to-show', showMain);
    // Also show after loading: a Windows launcher may suppress the first show request.
    mainWin.webContents.once('did-finish-load', showMain);
  }
  allowPadHid(mainWin.webContents.session);
  mainWin.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWin.on('close', (e) => {
    if (!quitting && settings.get().minimizeToTray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  // Opening the window checks for updates too (at most every 10 minutes).
  mainWin.on('show', () => updates && updates.maybeCheck && updates.maybeCheck());
  mainWin.on('focus', () => updates && updates.maybeCheck && updates.maybeCheck());
  mainWin.on('maximize', () => send('window:state', { maximized: true }));
  mainWin.on('unmaximize', () => send('window:state', { maximized: false }));
}

function showMain() {
  if (!mainWin || mainWin.isDestroyed()) {
    showWhenReady = true;
    return;
  }
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }));
    tray.setToolTip('FrameForge');
    tray.on('click', showMain);
    rebuildTrayMenu();
  } catch {
    tray = null;
  }
}

// ---------- Updates: tell the user even when FrameForge is hidden in the tray ----------
const notifiedUpdates = new Set();
function windowHidden() {
  return !mainWin || mainWin.isDestroyed() || !mainWin.isVisible() || mainWin.isMinimized();
}
function updateNow() {
  if (!updates) return;
  if (updates.state.status === 'ready') {
    quitting = true;
    if (!updates.install()) quitting = false;
  } else {
    showMain();
    updates.download();
  }
}
function onUpdateEvent(st) {
  if (st.status === 'error' && quitting) {
    quitting = false;
    applyMonitoring();
  }
  rebuildTrayMenu();
  // With background downloads on, 'available' is followed by 'ready' — only announce once it's ready.
  const announce = st.status === 'ready' || (st.status === 'available' && !settings.get().backgroundDownloadUpdates);
  if (!announce || !st.version) return;
  const key = `${st.version}:${st.status}`;
  if (notifiedUpdates.has(key)) return;
  notifiedUpdates.add(key);
  if (windowHidden() && Notification.isSupported()) {
    const n = new Notification({
      title: st.status === 'ready' ? `FrameForge ${st.version} is ready to install` : `FrameForge ${st.version} is out`,
      body: st.status === 'ready' ? 'Click to open FrameForge and update — it takes about 10 seconds.' : 'Click to open FrameForge and get it.',
      icon: ICON,
    });
    n.on('click', showMain);
    n.show();
  }
  if (tray) tray.setToolTip(st.status === 'ready' ? `FrameForge — update ${st.version} ready` : 'FrameForge');
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = settings.get();
  const u = updates ? updates.state : {};
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open FrameForge', click: showMain },
      ...(restartTimer ? [{ label: 'Cancel the restart', click: cancelRestart }] : []),
      busy ? { label: 'Stop Auto Mode', click: stopAuto } : { label: s.autoMode ? 'Auto Mode: on' : 'Auto Mode: off', enabled: false },
      { label: 'Show/hide overlay', click: toggleOverlay },
      { type: 'separator' },
      u.status === 'ready'
        ? { label: `Update to ${u.version} now`, click: updateNow }
        : u.status === 'downloading'
          ? { label: `Downloading update… ${u.progress || 0}%`, enabled: false }
          : { label: 'Check for updates', click: () => updates && updates.check() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

function overlayWanted() {
  const s = settings.get();
  return (s.fpsCounter || s.tempMonitor) && overlayShown;
}

function placeOverlay() {
  if (!overlayWin) return;
  const { bounds } = screen.getPrimaryDisplay();
  const [w, h] = overlayWin.getSize();
  const pos = settings.get().overlayPosition;
  const m = 14;
  const x = pos.endsWith('right') ? bounds.x + bounds.width - w - m : bounds.x + m;
  const y = pos.startsWith('bottom') ? bounds.y + bounds.height - h - m - 48 : bounds.y + m;
  overlayWin.setPosition(Math.round(x), Math.round(y));
}

function applyOverlay() {
  if (!overlayWanted()) {
    if (overlayWin) {
      overlayWin.destroy();
      overlayWin = null;
    }
    return;
  }
  if (!overlayWin) {
    overlayWin = new BrowserWindow({
      width: 230,
      height: 150,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.setIgnoreMouseEvents(true);
    overlayWin.setVisibleOnAllWorkspaces(true);
    overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
    overlayWin.once('ready-to-show', () => overlayWin && overlayWin.showInactive());
  }
  placeOverlay();
  overlayWin.webContents.send('overlay:config', settings.get());
}

function toggleOverlay() {
  overlayShown = !overlayShown;
  applyOverlay();
  send('overlay:shown', overlayShown);
}

/** Registers the overlay shortcut. Returns false when it couldn't (invalid, or another program already owns it). */
function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = settings.get().overlayHotkey;
  try {
    if (key) return globalShortcut.register(key.replace(/Ctrl/i, 'CommandOrControl'), toggleOverlay) && globalShortcut.isRegistered(key.replace(/Ctrl/i, 'CommandOrControl'));
  } catch {
    return false; // invalid accelerator
  }
  return true;
}

/** Start FrameForge quietly in the tray when Windows starts (a sign-in task that runs with admin rights). */
async function setStartWithWindows(on) {
  if (!IS_WIN || DEMO) return { ok: true };
  const r = on ? await run('schtasks', ['/Create', '/TN', 'FrameForge', '/TR', `"${process.execPath}" --hidden`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']) : await run('schtasks', ['/Delete', '/TN', 'FrameForge', '/F']);
  if (r.code === 0 || !on) return { ok: true };
  return { ok: false, message: `Windows wouldn’t set it up (${(r.stderr || r.stdout || '').trim().split(/\r?\n/)[0].slice(0, 120) || `code ${r.code}`}). Run FrameForge as administrator and try again.` };
}

// ---------- Monitoring ----------

function applyMonitoring() {
  const s = settings.get();
  sensors.start(rig && rig.gpu ? rig.gpu.vendor : null);
  if (!DEMO) {
    if (s.tempMonitor && tools.status().lhm) tools.startLhm();
    const pm = tools.presentMonPath();
    if (s.fpsCounter && pm && admin) fps.start(pm);
    else if (!s.fpsCounter && fps.running) fps.stop(pm);
  }
  applyOverlay();
}

let demoFps = 142;
let lastStats = null;
let lastRunLog = [];
let runQuiet = false;
function telemetryTick() {
  const s = settings.get();
  const t = sensors.read();
  // Test hooks: pretend a part runs hot (demo / test runs only).
  if (DEMO && process.env.FRAMEFORGE_FAKE_GPU_TEMP) t.gpuTemp = Number(process.env.FRAMEFORGE_FAKE_GPU_TEMP);
  if (DEMO && process.env.FRAMEFORGE_FAKE_CPU_TEMP) t.cpuTemp = Number(process.env.FRAMEFORGE_FAKE_CPU_TEMP);
  let f = null;
  if (s.fpsCounter) {
    if (DEMO) {
      demoFps = Math.max(110, Math.min(165, demoFps + Math.round((Math.random() - 0.5) * 10)));
      f = { app: 'eldenring', fps: demoFps, low1: demoFps - 31 };
    } else {
      f = fps.read();
    }
  }
  const tl = tools.status();
  const stats = {
    ...t,
    fps: f,
    fpsEnabled: s.fpsCounter,
    tempEnabled: s.tempMonitor,
    fpsReady: DEMO || (tl.presentmon && admin),
    sensorsReady: tl.lhm,
  };
  lastStats = stats;
  trackLoad(stats);
  send('stats', stats);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('stats', stats);
}

// ---------- Heat and gaming, measured over time (one hot second isn't a problem; a hot minute is) ----------

/** The temperature where this CPU counts as too hot. Some chips are built to run hotter than others. */
function cpuHotLimit() {
  const n = (rig && rig.cpu && rig.cpu.name) || '';
  if (/Ryzen.*\b7\d{3}X3D/i.test(n)) return 87; // Ryzen 7000 X3D chips stop at 89 °C
  if (/Ryzen.*\b[79]\d{3}/i.test(n)) return 95; // Ryzen 7000/9000 are designed to run up to 95 °C
  if (/Core\(TM\) i\d-1[234]\d{3}|1[234]th Gen|Core\(TM\) Ultra|Core Ultra/i.test(n)) return 95; // Intel 12th–14th gen / Core Ultra: up to 100 °C
  return 90;
}
const GPU_HOT = 87;
const heat = { cpu: { since: 0, last: 0, peak: 0 }, gpu: { since: 0, last: 0, peak: 0 } };
let gpuBusySince = 0;
let lastGameSeen = 0;
function trackOne(h, temp, limit) {
  const now = Date.now();
  if (temp != null && temp >= limit) {
    if (!h.since) h.since = now;
    if (now - h.since >= (process.env.FRAMEFORGE_FAST_HEAT ? 0 : 30000)) {
      h.last = now; // hot for 30 seconds in a row
      h.peak = Math.max(h.peak, temp);
    }
  } else {
    h.since = 0;
    if (now - h.last > 5 * 60 * 1000) h.peak = 0;
  }
}
function trackLoad(st) {
  trackOne(heat.cpu, st.cpuTemp, cpuHotLimit());
  trackOne(heat.gpu, st.gpuTemp, GPU_HOT);
  const now = Date.now();
  if (st.fps && st.fps.fps > 0) lastGameSeen = now;
  if (!DEMO && st.gpuLoad != null && st.gpuLoad >= 70) {
    if (!gpuBusySince) gpuBusySince = now;
    if (now - gpuBusySince > 20000) lastGameSeen = now;
  } else gpuBusySince = 0;
}
/** Hot for 30 s in a row within the last 5 minutes → { temp } */
function hotNow(kind) {
  const h = heat[kind];
  return h.last && Date.now() - h.last < 5 * 60 * 1000 ? { temp: h.peak } : null;
}
/** A game (or anything that keeps the graphics card busy) ran in the last minute. */
function gameRunning() {
  if (process.env.FRAMEFORGE_FAKE_GAME === '1') return true;
  if (DEMO) return false;
  return Date.now() - lastGameSeen < 60000;
}
/** Minutes since the last mouse or keyboard input. */
function idleMinutes() {
  if (process.env.FRAMEFORGE_FAKE_IDLE) return Number(process.env.FRAMEFORGE_FAKE_IDLE);
  try {
    return powerMonitor.getSystemIdleTime() / 60;
  } catch {
    return 0;
  }
}

// ---------- Auto Mode ----------

function applyProfileIfAuto() {
  const s = settings.get();
  if (!rig || s.tweaksCustomized) return;
  const p = presets.compose(s.preset, s.smartProfile ? rig : null);
  settings.set({ tweaks: p.tweaks });
}

// ---------- The assistant: runs Auto Mode as a list of steps, in the background ----------
// It changes settings directly (no mouse or keyboard takeover), so you can keep using your PC,
// and it can be stopped at any time. Stopping always finishes the current step first so nothing
// is left half-changed.

class Stopped extends Error {}
let stopRequested = false;
let abortCtl = null;
let runState = null;

function sendProgress() {
  if (runState) send('auto:progress', { ...runState });
}

function step(entry) {
  send('auto:step', { ...entry, at: Date.now() });
  if (entry.status !== 'running') {
    lastRunLog = lastRunLog.filter((e) => e.id !== entry.id).concat({ id: entry.id, name: entry.name, status: entry.status, message: entry.message || '' });
  }
  if (runState && entry.status === 'running' && entry.id !== 'stop') {
    runState.current = entry.message && entry.id === 'ctt_tweaks' && /^Tweak \d/.test(entry.message) ? `${entry.name} — ${entry.message}` : entry.name;
    sendProgress();
  }
}

function checkStop() {
  if (stopRequested) throw new Stopped();
}

function tweakPhase(t) {
  return async () => {
    const isCtt = t.id === 'ctt_tweaks';
    step({ id: t.id, name: t.name, status: 'running', message: isCtt ? `Downloading the latest Chris Titus tool and running his ${settings.get().cttPreset} preset — takes a few minutes, and finishes even if you press Stop.` : '' });
    let lastLive = 0;
    const progress = (line) => {
      // Show what winutil is doing right now (at most a few updates per second).
      if (Date.now() - lastLive < 250) return;
      lastLive = Date.now();
      step({ id: t.id, name: t.name, status: 'running', message: line });
    };
    const r = await optimizer.runOne(t, { admin, progress });
    step({ id: t.id, name: t.name, status: r.status, message: r.message });
    if (isCtt && r.status !== 'error' && settings.get().cttOpenAfter && !runQuiet) {
      try {
        await tools.openWinutil();
        step({ id: 'ctt_open', name: 'Opened Chris Titus’s tool', status: 'done', message: 'Its window is open so you can see and check the tweaks. Close it when you’re done.' });
      } catch (e) {
        step({ id: 'ctt_open', name: 'Couldn’t open Chris Titus’s tool', status: 'warn', message: String(e.message || e).slice(0, 160) });
      }
    }
    if (r.status === 'done') problems.remove(t.id);
    else if (!r.locked) problems.put(t.id, { id: t.id, name: t.name, status: r.status, message: r.message, details: r.details, fix: r.fix, adminSkipped: r.adminSkipped, failedIds: r.failedIds || [], at: Date.now() });
    // Remember settings this PC locks, so the Tweaks tab can say so instead of offering a switch that can't work.
    const locked = { ...(settings.get().lockedTweaks || {}) };
    if (r.locked) locked[t.id] = r.message;
    else if (r.status === 'done') delete locked[t.id];
    settings.set({ lockedTweaks: locked });
    send('fix:changed', true);
    if (r.status === 'done') {
      changes.put(t.id, {
        name: t.name,
        summary: r.message,
        details: r.details,
        at: Date.now(),
        preset: settings.get().preset,
        undoable: !t.oneShot,
        reboot: !!t.reboot,
      });
      send('changes', changeList());
    }
    return { reboot: r.reboot, status: r.status, message: r.message, locked: r.locked };
  };
}

function revertPhase(t, why = '') {
  return async () => {
    step({ id: `undo_${t.id}`, name: `Undo: ${t.name}`, status: 'running', message: why });
    try {
      await optimizer.revertOne(t);
      changes.remove(t.id);
      send('changes', changeList());
      step({ id: `undo_${t.id}`, name: `Undo: ${t.name}`, status: 'done', message: why ? `${why} — put back how it was.` : 'Put back how it was.' });
    } catch (e) {
      step({ id: `undo_${t.id}`, name: `Undo: ${t.name}`, status: 'error', message: String(e.message || e).slice(0, 200) });
    }
    return { reboot: !!t.reboot };
  };
}

function changeList() {
  const s = settings.get();
  const boot = Date.now() - os.uptime() * 1000;
  const entries = Object.entries(changes.all())
    .map(([id, e]) => ({ id, ...e, pendingRestart: !!e.reboot && e.at > boot })) // restarted since? then it's finished
    .sort((a, b) => b.at - a.at);
  return { entries, restartedNotice: !!s.restartedNotice };
}

function downloadPhase(id) {
  return async () => {
    const name = `Downloading ${tools.TOOLS[id].name}`;
    step({ id: `dl_${id}`, name, status: 'running', message: 'From its official GitHub page' });
    abortCtl = new AbortController();
    try {
      const r = await tools.install(id, (p) => step({ id: `dl_${id}`, name, status: 'running', message: `${Math.round(p * 100)}%` }), abortCtl.signal);
      step({ id: `dl_${id}`, name, status: 'done', message: r.message });
    } catch (e) {
      if (stopRequested) {
        step({ id: `dl_${id}`, name, status: 'warn', message: 'Download stopped.' });
        throw new Stopped();
      }
      step({ id: `dl_${id}`, name, status: 'error', message: String(e.message || e) });
    } finally {
      abortCtl = null;
    }
    applyMonitoring();
  };
}

function vendorPhase() {
  return async () => {
    const s = settings.get();
    const va = rig.vendorApp;
    if (!va) return;
    if (!va.installed && s.autoDownloadTools) {
      const candidates = tools.WINGET_APPS[rig.gpu.vendor] || [];
      let installed = false;
      if (candidates.length && (await tools.hasWinget())) {
        for (const c of candidates) {
          checkStop();
          step({ id: 'vendor', name: `Looking up ${c.name}`, status: 'running', message: 'In Microsoft’s verified app store (winget)' });
          if (!(await tools.wingetKnows(c.id))) continue;
          step({ id: 'vendor', name: `Installing ${c.name}`, status: 'running', message: 'Silent install from winget — every file is checked against Microsoft’s fingerprint.' });
          const r = await tools.wingetInstall(c.id);
          if (r.ok) {
            rig = await hardware.scan(settings.get().manualHardware);
            send('rig', rig);
            step({ id: 'vendor', name: `Installed ${c.name}`, status: 'done', message: 'Verified install from winget.' });
            installed = true;
          } else {
            step({ id: 'vendor', name: `Couldn’t install ${c.name}`, status: 'warn', message: r.message });
          }
          break;
        }
      }
      if (!installed) {
        shell.openExternal(va.download);
        step({ id: 'vendor', name: `Opened the official ${va.name} download page`, status: 'warn', message: `${rig.gpu.vendorName} doesn’t offer a verified automatic install, so it’s one click for you on their own site.` });
        return;
      }
    }
    const v2 = rig.vendorApp;
    if (v2 && v2.installed && s.openVendorApp) {
      if (!DEMO && v2.path) shell.openPath(v2.path);
      step({ id: 'vendor_open', name: `Opened ${v2.name}`, status: 'done', message: 'Finish the driver tune-up checklist on the Home tab.' });
    } else if (v2 && !v2.installed) {
      step({ id: 'vendor', name: `${v2.name} not found`, status: 'warn', message: 'Turn on “Download performance tools” in Settings so the assistant can get it.' });
    }
  };
}

function onPhases(quiet, queue) {
  queue.push(async () => {
    step({ id: 'scan', name: 'Scanning your PC', status: 'running' });
    rig = await hardware.scan(settings.get().manualHardware);
    send('rig', rig);
    step({ id: 'scan', name: 'Scanning your PC', status: 'done', message: `${rig.cpu.name} · ${rig.gpu.name} · ${rig.ramGB} GB RAM` });
  });
  queue.push(async () => {
    applyProfileIfAuto();
    const s = settings.get();
    const presetName = presets.PRESETS[s.preset].name;
    const picked = Object.values(s.tweaks).filter(Boolean).length;
    step({
      id: 'profile',
      name: `${presetName} preset for this PC`,
      status: 'done',
      message: s.tweaksCustomized ? 'Using the boosts you picked by hand in Settings.' : `Picked ${picked} boosts for ${presetName.toLowerCase()} on a ${rig.laptop ? 'laptop' : 'desktop'} with ${rig.gpu.vendorName} graphics.`,
    });
    // Now that the plan is known: first undo boosts from an earlier preset that this one doesn't use…
    const plan = optimizer.planned({ quiet, rig });
    const planIds = new Set(optimizer.planned({ quiet: false, rig }).map((t) => t.id));
    optimizer.revertPlan().filter((t) => !planIds.has(t.id)).forEach((t) => queue.push(revertPhase(t, `Not part of ${presetName}`)));
    // …then apply this preset's boosts.
    plan.forEach((t) => queue.push(tweakPhase(t)));
    if (!quiet && s.autoDownloadTools) {
      const st = tools.status();
      if (s.fpsCounter && !st.presentmon) queue.push(downloadPhase('presentmon'));
      if (s.tempMonitor && !st.lhm) queue.push(downloadPhase('lhm'));
    }
    if (!quiet) queue.push(vendorPhase());
    if (!quiet && s.overclock) {
      queue.push(async () => {
        const plan = profile.overclockPlan(rig).filter((p) => !p.auto);
        if (plan.length) step({ id: 'oc_plan', name: `Overclocking: ${plan[0].title}`, status: 'warn', message: `${plan[0].body} Full plan is on the Home tab.` });
      });
    }
  });
}

function offPhases(queue) {
  optimizer.revertPlan().forEach((t) => queue.push(revertPhase(t)));
}

async function runAuto(on, { quiet = false } = {}) {
  if (busy) return { busy: true };
  busy = true;
  stopRequested = false;
  send('auto:busy', { on, quiet });
  const queue = [];
  lastRunLog = [];
  runQuiet = quiet;
  if (on) onPhases(quiet, queue);
  else offPhases(queue);
  runState = { on, done: 0, total: queue.length + (on ? 8 : 0), current: '' }; // estimate until the plan is known
  sendProgress();
  rebuildTrayMenu();
  let needsReboot = false;
  let stopped = false;
  try {
    for (let i = 0; i < queue.length; i++) {
      checkStop();
      const r = await queue[i]();
      if (r && r.reboot) needsReboot = true;
      runState.done = i + 1;
      runState.total = queue.length;
      sendProgress();
    }
    settings.set(on ? { autoMode: true, lastBoot: bootTime(), restartedNotice: false } : { autoMode: false, restartedNotice: false });
    if (on && !quiet) step({ id: 'finish', name: 'All done', status: 'done', message: `Your PC is tuned. ${optimizer.activeCount()} boosts are active.` });
  } catch (e) {
    if (e instanceof Stopped || stopRequested) {
      stopped = true;
      const kept = optimizer.activeCount();
      step({
        id: 'stop',
        name: on ? 'Stopped' : 'Undo stopped',
        status: 'warn',
        message: on
          ? kept
            ? `${kept} boost${kept === 1 ? '' : 's'} already applied and kept. They're listed in “What FrameForge changed”, where you can undo them.`
            : 'Stopped before anything was changed.'
          : `${kept} boost${kept === 1 ? ' is' : 's are'} still on. Turn Auto Mode off again to finish.`,
      });
      settings.set({ autoMode: kept > 0, lastBoot: bootTime() });
    } else {
      step({ id: 'fatal', name: 'Something stopped the run', status: 'error', message: String(e.message || e) });
      settings.set({ autoMode: optimizer.activeCount() > 0 });
    }
  } finally {
    busy = false;
    runState = null;
    detectExtra().then(() => send('fix:changed', true)).catch(() => {}); // re-check: Auto Mode may have fixed things
    enforceAnimations('auto');
    rebuildTrayMenu();
    send('auto:done', { on: settings.get().autoMode, needsReboot, active: optimizer.activeCount(), quiet, stopped });
  }
  return { ok: true };
}

function stopAuto() {
  if (!busy || stopRequested) return false;
  stopRequested = true;
  if (abortCtl) abortCtl.abort();
  step({ id: 'stop', name: 'Stopping…', status: 'running', message: 'Finishing the current step so nothing is left half-changed.' });
  return true;
}

// ---------- Tweaks tab: switch any boost on or off by hand ----------

async function tweakCatalog() {
  const s = settings.get();
  const rec = rig ? profile.recommend(rig) : { tweaks: {}, reasons: {} };
  const list = tweaksTab.tabTweaks();
  const states = await Promise.all(list.map((t) => tweaksTab.stateOf(t)));
  return {
    cats: tweaksTab.CATS,
    busy,
    admin,
    items: list.map((t, i) => ({
      id: t.id,
      cat: t.cat,
      name: t.name,
      desc: t.desc,
      what: t.what || (t.values ? t.values.map((v) => `${v.key} › ${v.name} = ${v.data}`) : []),
      admin: !!t.admin,
      reboot: !!t.reboot,
      on: states[i],
      byFrameForge: !!backup.get(t.id),
      recommended: rec.tweaks[t.id] !== false,
      reason: rec.reasons[t.id] || '',
      inPreset: !!s.tweaks[t.id],
      locked: (s.lockedTweaks || {})[t.id] || null,
    })),
  };
}

async function setTweak(id, on, { byUser = false } = {}) {
  const t = tweaksTab.tabTweaks().find((x) => x.id === id);
  if (!t) return { ok: false, message: 'Unknown tweak.' };
  if (byUser) {
    const userOff = { ...(settings.get().userOff || {}) };
    if (on) delete userOff[id];
    else userOff[id] = true;
    settings.set({ userOff });
  }
  if (busy) return { ok: false, message: 'FrameForge is busy with another change — try again in a moment.', on: await tweaksTab.stateOf(t) };
  if (t.admin && !admin) return { ok: false, message: 'This one needs FrameForge to run as administrator.', on: await tweaksTab.stateOf(t) };
  busy = true;
  let reboot = false;
  try {
    if (on) {
      const r = await tweakPhase(t)();
      reboot = !!(r && r.reboot);
      if (r.status !== 'done') return { ok: false, locked: !!r.locked, message: r.message, on: await tweaksTab.stateOf(t) };
      const c = changes.all()[t.id];
      return { ok: true, message: c ? c.summary : `${t.name} is on.`, on: await tweaksTab.stateOf(t), reboot };
    }
    if (backup.get(t.id)) {
      await revertPhase(t, 'Switched off in Tweaks')();
    } else if (!DEMO && typeof t.forceOff === 'function') {
      const fo = await t.forceOff(); // Windows had it on before FrameForge: set the Windows default
      if (fo && fo.keptOn) return { ok: false, message: t.offNote || 'Windows keeps this on.', on: await tweaksTab.stateOf(t) };
      step({ id: `undo_${t.id}`, name: `Off: ${t.name}`, status: 'done', message: 'Set back to the Windows default.' });
    }
    changes.remove(t.id);
    problems.remove(t.id);
    send('changes', changeList());
    send('fix:changed', true);
    return { ok: true, message: `${t.name} is off.`, on: await tweaksTab.stateOf(t), reboot: !!t.reboot };
  } catch (e) {
    return { ok: false, message: String(e.message || e).slice(0, 200), on: await tweaksTab.stateOf(t) };
  } finally {
    busy = false;
    detectExtra().then(() => send('fix:changed', true)).catch(() => {});
  }
}

ipcMain.handle('tweaks:catalog', () => tweakCatalog());
ipcMain.handle('tweaks:set', (_e, id, on) => setTweak(id, !!on, { byUser: true }));

// ---------- Fix mode ----------
// The built-in fixer: it finds problems, knows several ways to fix each one, tries them in order and checks
// after every try whether the problem is really gone. Works offline — no account or key needed.

const si = require('systeminformation');
const guides = require('./src/guides');
const A = (id, label) => ({ id, label });
const tweakById = (id) => optimizer.TWEAKS.find((t) => t.id === id);

/**
 * A tweak reads "off" but isn't a problem to fix:
 *  - it needs a restart and FrameForge applied it since Windows last started (it switches on after the restart), or
 *  - this PC doesn't have the setting at all (e.g. the power plan lacks it) — it can't be applied or checked, so it's
 *    set aside as unavailable instead of failing forever.
 */
async function settledOff(t) {
  const applied = changes.all()[t.id];
  if (t.reboot && applied && applied.at > Date.now() - os.uptime() * 1000) return true;
  if (typeof t.available === 'function' && !(await t.available().catch(() => true))) {
    await markUnavailable(t, `This PC doesn’t have the setting “${t.name}” uses, so it isn’t available here.`);
    return true;
  }
  return false;
}
async function markUnavailable(t, message) {
  if (backup.get(t.id)) {
    await optimizer.revertOne(t).catch(() => {});
    backup.remove(t.id);
  }
  changes.remove(t.id);
  problems.remove(t.id);
  settings.set({ lockedTweaks: { ...(settings.get().lockedTweaks || {}), [t.id]: message } });
  send('changes', changeList());
}

/**
 * Switch a tweak on and make sure Windows really reports it on afterwards. If it doesn't (a setting Windows won't
 * show as on), set the tweak aside as unavailable with a clear reason — so it never fails in a loop.
 */
async function applyAndVerify(id) {
  const t = tweakById(id);
  const r = await setTweak(id, true);
  if (!r.ok || DEMO || !t) return r;
  if (await tweaksTab.stateOf(t)) return r;
  if (t.reboot) return { ...r, message: `${t.name} is set — it switches on after the next restart.` };
  await sleep(700);
  if (await tweaksTab.stateOf(t)) return r;
  const msg = `Windows doesn’t report “${t.name}” as on after FrameForge sets it, so it can’t be used on this PC.`;
  await markUnavailable(t, msg);
  return { ok: true, unavailable: true, message: `${msg} FrameForge put it back and set it aside.` };
}

/** Checks that take a moment (display, disk, tweaks Windows undid, pending restart). Cached. */
let extra = { display: null, disk: null, reverted: [], presetOff: [], rebootPending: false, at: 0 };
let extraRunning = null;
async function detectExtra() {
  if (extraRunning) return extraRunning;
  extraRunning = (async () => {
    const out = { display: null, disk: null, reverted: [], presetOff: [], onBattery: false, rebootPending: false, at: Date.now() };
    const locked = settings.get().lockedTweaks || {};
    try {
      if (DEMO) out.display = { res: '2560 × 1440', cur: backup.get('max_refresh') ? 165 : 60, max: 165 };
      else if (!locked.max_refresh) out.display = await tweakById('max_refresh').info();
    } catch {}
    try {
      const c = (await si.fsSize()).find((f) => /^c:/i.test(f.mount || f.fs || ''));
      if (c && c.size) out.disk = { freeGB: Math.round((c.size - c.used) / 1024 ** 3), usePct: Math.round((c.used / c.size) * 100) };
    } catch {}
    if (!DEMO) {
      for (const t of tweaksTab.tabTweaks()) {
        if (!backup.get(t.id) || locked[t.id] || t.id === 'max_refresh' || (t.id === 'visual_effects' && settings.get().animations === 'on')) continue;
        if (!(await tweaksTab.stateOf(t)) && !(await settledOff(t))) out.reverted.push(t.id);
      }
      const rr = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired']);
      out.rebootPending = rr.code === 0;
    }
    try {
      const b = await si.battery();
      out.onBattery = !!(b && b.hasBattery && b.acConnected === false);
    } catch {}
    if (!out.onBattery) held.delete('insight_laptop'); // plugged in: if it's unplugged again, the problem is back
    // Auto Mode is on, but some of the preset's settings aren't active (e.g. new tweaks from an update,
    // or ones that failed). Settings the user switched off by hand in the Tweaks tab are left alone.
    const st = settings.get();
    if (st.autoMode && rig) {
      const userOff = st.userOff || {};
      const tab = new Set(tweaksTab.tabTweaks().map((t) => t.id));
      for (const t of optimizer.planned({ quiet: true, rig })) {
        if (!tab.has(t.id) || locked[t.id] || userOff[t.id] || out.reverted.includes(t.id) || t.id === 'max_refresh' || (t.id === 'visual_effects' && st.animations === 'on')) continue;
        if (problems.all()[t.id]) continue; // already listed as a failed step
        if (!(await tweaksTab.stateOf(t)) && !(await settledOff(t))) out.presetOff.push(t.id);
      }
    }
    extra = out;
    return out;
  })();
  try {
    return await extraRunning;
  } finally {
    extraRunning = null;
  }
}

/** FrameForge changes made since Windows last started that need a restart. */
function restartNeededFor() {
  const boot = Date.now() - os.uptime() * 1000;
  return Object.values(changes.all()).filter((c) => c.reboot && c.at > boot).map((c) => c.name);
}

/** How a problem reads once it's fixed (shown under "Fixed just now"). */
function fixedTitleFor(it) {
  const n = (it.title.match(/^(\d+)/) || [])[1];
  if (it.id.startsWith('step_')) return it.title.replace(/ didn’t finish$/, ' now works');
  return (
    {
      preset_off: `Turned on ${n || 'the'} missing preset setting${n === '1' ? '' : 's'}`,
      reverted: 'Turned your tweaks back on after Windows switched them off',
      display: extra.display ? `Display switched to ${extra.display.max} Hz` : 'Display runs at its highest refresh rate',
      disk: 'Freed up space on drive C:',
      tool_presentmon: 'Installed PresentMon — the FPS counter works',
      tool_lhm: 'Installed LibreHardwareMonitor — temperatures can be read',
      vendor_app: rig && rig.gpu && rig.gpu.vendor === 'amd' ? 'Started AMD’s verified installer' : 'Driver app installed',
      hot_cpu: 'Cooled the CPU down',
      hot_gpu: backup.get('gpu_power_limit') ? 'Cooled the graphics card down (power limit back to normal)' : 'Cooled the graphics card down (power limit 90 %)',
      not_admin: 'FrameForge runs as administrator',
      security: 'Windows protection is set up right again',
      threats: 'Threats from the virus scan are handled',
      insight_ram_speed: 'RAM runs at full speed',
      insight_single_stick: 'RAM runs in dual channel',
      insight_laptop: 'Laptop is set up for gaming',
      updates: 'In-app updates are set up',
      restart: 'Restart done',
    }[it.id] || `${it.title} — fixed`
  );
}

/**
 * Everything on this PC that needs fixing.
 *   strategies – fixes the fixer tries in order (it checks after each one)
 *   manual     – steps for the user when no app can fix it
 *   actions    – buttons shown on the problem
 */
function fixList() {
  const s = settings.get();
  const items = [];
  const add = (it) => items.push({ actions: [], strategies: [], manual: null, ...it });
  if (IS_WIN && !DEMO && !admin) {
    add({ id: 'not_admin', level: 'big', title: 'FrameForge isn’t running as administrator', body: 'Most boosts and all repairs need admin rights, so they were skipped.', actions: [A('admin', 'Restart as administrator')], strategies: [A('admin', 'Restart FrameForge as administrator')] });
  }
  for (const p of Object.values(problems.all())) {
    const t = tweakById(p.id);
    if (!t) continue;
    const it = { id: `step_${p.id}`, level: p.status === 'error' ? 'big' : 'medium', title: `${t.name} didn’t finish`, body: p.message, details: p.details, at: p.at, actions: [], strategies: [] };
    if (p.adminSkipped) {
      it.actions.push(A('admin', 'Restart as administrator'));
      it.strategies.push(A('admin', 'Restart FrameForge as administrator'));
    } else if (p.id === 'restore_point') {
      it.actions.push(A('repair:restore_points', 'Turn on System Protection'), A('retry:restore_point', 'Try again'));
      it.strategies.push(A('restore_check', 'Check for a restore point from today'), A('repair:restore_points', 'Turn on System Protection'), A('retry:restore_point', 'Make the restore point again'), A('restore_check', 'Check again for a restore point from today'));
    } else if (p.fix === 'ctt') {
      it.actions.push(A(`retry:${p.id}`, 'Try again'), A('open_ctt', 'Open Chris Titus tool'));
      const log = (p.details || []).find((d) => d.startsWith('Full winutil log: '));
      if (log) it.actions.push(A(`openfile:${log.slice(18)}`, 'Open winutil log'));
      it.strategies.push(
        A(`retry:${p.id}`, 'Run the Chris Titus preset again'),
        A('ctt_isolate', 'Find the Chris Titus tweak that fails on this PC and run the preset without it'),
        A('redownload_ctt', 'Download a fresh copy of the Chris Titus tool and run it again')
      );
      it.manual = ['FrameForge opened the Chris Titus tool for you.', 'Go to the Tweaks tab in it, tick the tweaks you want and click “Run Tweaks”.', 'If one tweak keeps failing, leave it unticked — the rest still work.'];
      it.manualAction = 'open_ctt';
      it.bg = 'idle'; // takes a few minutes and works the CPU: only while you're away
    } else if (p.id === 'power_plan') {
      it.actions.push(A('retry:power_plan', 'Try again'), A('open:ms-settings:powersleep', 'Open Power mode settings'));
      it.strategies.push(A('retry:power_plan', 'Set the Ultimate Performance plan again'));
      it.manual = ['FrameForge opened Windows power settings.', 'Set “Power mode” to “Best performance”.'];
      it.manualAction = 'open:ms-settings:powersleep';
    } else {
      it.actions.push(A(`retry:${p.id}`, 'Try again'));
      it.strategies.push(A(`retry:${p.id}`, `Apply “${t.name}” again`), A(`retry:${p.id}`, 'Try once more'));
    }
    if (!it.bg && !p.adminSkipped) it.bg = 'quiet';
    add(it);
  }
  if (extra.reverted.length) {
    const names = extra.reverted.map((id) => (tweakById(id) || {}).name).filter(Boolean);
    add({ id: 'reverted', level: 'medium', title: `Windows switched off ${names.length === 1 ? 'one' : names.length} of your tweaks`, body: `Windows updates sometimes reset settings: ${names.join(', ')}.`, actions: [A('reapply', 'Turn them back on')], strategies: [A('reapply', 'Turn them back on')], bg: 'quiet' });
  }
  if (extra.presetOff.length) {
    const names = extra.presetOff.map((id) => (tweakById(id) || {}).name).filter(Boolean);
    const pn = presets.PRESETS[s.preset].name;
    add({ id: 'preset_off', level: 'medium', title: `${names.length} setting${names.length === 1 ? '' : 's'} from your ${pn} preset ${names.length === 1 ? 'isn’t' : 'aren’t'} on yet`, body: `${names.join(', ')}.`, actions: [A('preset_apply', 'Turn them on')], strategies: [A('preset_apply', `Turn on the missing ${pn} settings`)], bg: 'quiet' });
  }
  if (extra.display && extra.display.cur < extra.display.max) {
    const d = extra.display;
    add({ id: 'display', level: 'big', title: `Your display runs at ${d.cur} Hz, but it can do ${d.max} Hz`, body: `Windows is only using ${Math.round((d.cur / d.max) * 100)}% of what your monitor can show at ${d.res}.`, actions: [A('tweak:max_refresh', `Switch to ${d.max} Hz`)], strategies: [A('tweak:max_refresh', `Switch the display to ${d.max} Hz`)], manual: guides.displayCable(d), bg: 'quiet' });
  }
  if (extra.disk && (extra.disk.usePct >= 92 || extra.disk.freeGB < 15)) {
    add({ id: 'disk', level: 'medium', title: `Drive C: is almost full (${extra.disk.freeGB} GB free)`, body: 'A nearly full system drive makes Windows and game updates slow, and can cause stutter.', actions: [A('free_space', 'Free up space'), A('goto:clean', 'Open Cleaner')], strategies: [A('free_space', 'Clear temp files and old Windows update leftovers')], manual: guides.diskFull(extra.disk), bg: 'idle' });
  }
  // "Download performance tools" (Settings): with it off FrameForge never fetches a tool by itself — not even from
  // Fix mode in the background. The item stays, with the button, and says why it's waiting.
  const tl = tools.status();
  const dlOk = !!s.autoDownloadTools;
  const dlManual = ['Downloads are off in Settings (“Download performance tools”), so FrameForge won’t fetch it by itself.', 'Press “Download it” here, or turn that setting on.'];
  if (s.fpsCounter && !tl.presentmon)
    add({ id: 'tool_presentmon', level: 'medium', title: 'The FPS counter needs PresentMon', body: 'A free tool from Intel that reads real in-game FPS.', actions: [A('install:presentmon', 'Download it')], strategies: dlOk ? [A('install:presentmon', 'Download PresentMon from Intel’s GitHub'), A('install:presentmon', 'Try the download again')] : [], manual: dlOk ? null : dlManual, bg: 'quiet' });
  if (s.tempMonitor && !tl.lhm && (!lastStats || lastStats.cpuTemp == null))
    add({ id: 'tool_lhm', level: 'medium', title: 'CPU temperature can’t be read yet', body: 'Windows doesn’t share the real CPU sensor. LibreHardwareMonitor (free, open source) does.', actions: [A('install:lhm', 'Download it')], strategies: dlOk ? [A('install:lhm', 'Download LibreHardwareMonitor from its GitHub'), A('install:lhm', 'Try the download again')] : [], manual: dlOk ? null : dlManual, bg: 'quiet' });
  if (rig && rig.vendorApp && !rig.vendorApp.installed) {
    const amd = rig.gpu.vendor === 'amd';
    const amdAuto = amd && tools.amdDriverPages(rig.gpu.name).length > 0;
    add({
      id: 'vendor_app',
      level: 'medium',
      title: `${rig.vendorApp.name} isn’t installed`,
      body: 'The driver checklist and the vendor’s own auto-overclock and undervolt live in it.',
      actions: [A(amd ? (amdAuto ? 'amd_install' : 'vendor') : 'vendor_install', 'Get it')],
      strategies: amd ? (amdAuto ? [A('amd_install', 'Download AMD Software from drivers.amd.com, let Windows check AMD’s signature, and start AMD’s installer')] : []) : [A('vendor_install', `Install ${rig.vendorApp.name} from Microsoft’s verified app store`)],
      manual: amd ? guides.amdDriverApp(false) : null,
      manualAfter: amd ? guides.amdDriverApp(true) : null, // when AMD's installer was started: only its Install click is left
      manualAction: amd ? 'vendor' : null,
      bg: amd ? false : 'idle',
    });
  }
  const hc = hotNow('cpu');
  if (hc) {
    const heatTweaks = ['cpu_min', 'cpu_boost', 'core_parking'].filter((id) => backup.get(id));
    const lim = cpuHotLimit();
    add({ id: 'hot_cpu', level: 'big', title: `CPU is hot (${hc.temp} °C)`, body: heatTweaks.length ? 'FrameForge’s CPU speed tweaks add some heat. Usually it’s dust, a weak fan setting or old thermal paste.' : `It stayed above ${lim} °C for over 30 seconds, so the CPU slows itself down. Usually dust, a weak fan setting or old thermal paste.`, strategies: heatTweaks.length ? [A('cool_cpu', 'Switch off FrameForge’s heat-adding CPU tweaks')] : [], manual: guides.hotCpu(rig, hc.temp), bg: 'game', verifyLater: true });
  }
  const hg = hotNow('gpu');
  if (hg) {
    const oc = !!backup.get('gpu_power_limit');
    const nv = rig && rig.gpu && rig.gpu.vendor === 'nvidia';
    const strategies = [];
    if (oc) strategies.push(A('revert_oc', 'Put the graphics card power limit back to normal'));
    if (nv && !backup.get('gpu_cool')) strategies.push(A('gpu_cool', 'Lower the graphics card power limit to 90 % (a few percent fewer FPS, much cooler)'));
    add({ id: 'hot_gpu', level: 'big', title: `Graphics card is hot (${hg.temp} °C)`, body: oc ? 'FrameForge raised its power limit for overclocking — that’s the likely cause.' : 'It stayed above 87 °C for over 30 seconds and may be lowering its clocks to protect itself.', strategies, manual: guides.hotGpu(rig, hg.temp), bg: 'game', verifyLater: true });
  }
  if (rig) {
    for (const ins of profile.insights(rig)) {
      if (ins.level === 'info') continue;
      if (ins.id === 'laptop') {
        if (!extra.onBattery) continue; // plugged in: nothing to fix
        add({ id: 'insight_laptop', level: 'medium', title: 'Your laptop is running on battery', body: 'Most laptops cut graphics power by half or more on battery.', actions: [A('laptop_power', 'Set Best performance mode')], strategies: [A('laptop_power', 'Set Windows power mode to Best performance')], manual: guides.laptop() });
        continue;
      }
      const manual = ins.id === 'ram_speed' ? guides.ramSpeed(rig) : ins.id === 'single_stick' ? guides.singleStick(rig) : null;
      add({ id: `insight_${ins.id}`, level: ins.level, title: ins.title, body: ins.body, manual, bios: ins.id === 'ram_speed', actions: ins.id === 'ram_speed' ? [A('bios', 'Restart into BIOS')] : [] });
    }
  }
  // Windows protection (from the Virus scan tab's checks) and threats the user hasn't handled yet.
  const sec = (secChecks || []).filter((c) => ['big', 'medium'].includes(c.level) && c.fix && c.id !== 'proxy' && c.fix !== 'open_defender');
  if (sec.length) add({ id: 'security', level: 'big', title: `Windows protection: ${sec.length} problem${sec.length === 1 ? '' : 's'}`, body: sec.map((c) => c.title).join(' · '), details: sec.flatMap((c) => c.details || []), actions: [A('sec_fix', 'Fix them'), A('goto:scan', 'Open Virus scan')], strategies: [A('sec_fix', 'Fix Windows protection settings')] });
  const lr = scanjob.last();
  const openThreats = lr ? lr.items.filter((i) => i.status === 'active' && ['real', 'unsure', 'pua', 'test'].includes(i.verdict) && !i.done) : [];
  if (openThreats.length) add({ id: 'threats', level: 'big', title: `${openThreats.length} detection${openThreats.length === 1 ? '' : 's'} from the virus scan ${openThreats.length === 1 ? 'is' : 'are'} waiting for your choice`, body: openThreats.map((i) => `${i.threat} — ${i.file}`).slice(0, 3).join(' · '), actions: [A('scan_results', 'Choose what to do')], strategies: openThreats.some((i) => i.verdict === 'real') ? [A('quarantine_real', 'Quarantine the clear-cut threats (they can be restored from the Virus scan tab)')] : [], manual: ['Open the scan results and pick Quarantine, Delete or Keep for each one — FrameForge does the rest.'], manualAction: null });
  const pending = restartNeededFor();
  if (extra.rebootPending || pending.length) add({ id: 'restart', level: 'info', title: 'A restart is needed', body: pending.length ? `To finish: ${pending.join(', ')}.` : 'Windows has updates waiting for a restart.', actions: [A('restart', 'Restart now')], manual: guides.restartPending(), manualAction: null, restartItem: true });
  if (app.isPackaged && updates && updates.state.status === 'unconfigured') add({ id: 'updates', level: 'info', title: 'In-app updates aren’t set up', body: 'FrameForge can’t find where new versions come from.', actions: [A('set_update_source', 'Fix it')], strategies: [A('set_update_source', 'Use the official FrameForge update source')], bg: 'game' });
  // Problems FrameForge fixed but can't re-check right away (e.g. the laptop is still on battery) stay hidden.
  const shown = items.filter((it) => {
    const h = held.get(it.id);
    if (!h) return true;
    if (Date.now() > h.until) {
      held.delete(it.id);
      return true;
    }
    return false;
  });
  // A problem is fixable automatically when it has strategies. A restart counts too: FrameForge does it.
  for (const it of shown) {
    it.auto = it.strategies.length > 0 || (it.restartItem && settings.get().autoRestart);
    it.fixedTitle = fixedTitleFor(it);
  }
  return shown;
}
const held = new Map(); // problem id -> { until }: fixed, but the condition can't be checked until it changes

let fixBusy = false;
async function runRepair(name) {
  const rp = fixes.REPAIRS[name];
  if (!rp) throw new Error('Unknown repair');
  if (fixBusy) return { busy: true };
  fixBusy = true;
  send('fix:repair', { name, status: 'running', title: rp.name });
  try {
    const r = await rp.run((line) => send('fix:line', { name, line }));
    if (r.ok || r.warn) {
      changes.put(`repair_${name}_${Date.now()}`, { name: rp.name, summary: r.message, details: r.details || [], at: Date.now(), preset: settings.get().preset, undoable: false, reboot: !!rp.reboot });
      send('changes', changeList());
    }
    send('fix:repair', { name, status: r.ok ? 'done' : 'warn', title: rp.name, message: r.message });
    return r;
  } catch (e) {
    send('fix:repair', { name, status: 'error', title: rp.name, message: String(e.message || e) });
    return { ok: false, message: String(e.message || e) };
  } finally {
    fixBusy = false;
    send('fix:changed', true);
  }
}


/** Is there a Windows restore point from the last 24 hours? (Windows allows only one a day.) */
async function recentRestorePoint() {
  if (DEMO) return true;
  const r = await ps("$p = Get-ComputerRestorePoint -ErrorAction SilentlyContinue | Sort-Object SequenceNumber | Select-Object -Last 1; if ($p) { [int]((Get-Date) - $p.ConvertToDateTime($p.CreationTime)).TotalHours } else { -1 }");
  const h = parseInt(r.stdout.trim(), 10);
  return h >= 0 && h < 24;
}

async function runFixAction(action) {
  const [kind, ...rest] = action.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'retry': {
      if (busy) return { ok: false, message: 'Auto Mode is running — wait for it to finish.' };
      const t = tweakById(arg);
      if (!t) return { ok: false, message: 'Unknown step' };
      busy = true;
      try {
        await tweakPhase(t)();
      } finally {
        busy = false;
      }
      const still = problems.all()[arg];
      return still ? { ok: false, message: still.message } : { ok: true, message: `${t.name} worked this time.` };
    }
    case 'tweak': {
      const r = await applyAndVerify(arg);
      await detectExtra();
      return r;
    }
    case 'reapply': {
      const ids = [...extra.reverted];
      let ok = 0;
      for (const id of ids) if ((await applyAndVerify(id)).ok) ok++;
      await detectExtra();
      return { ok: ok === ids.length, message: `Turned ${ok} of ${ids.length} tweak${ids.length === 1 ? '' : 's'} back on.` };
    }
    case 'preset_apply': {
      const ids = [...extra.presetOff];
      let ok = 0;
      for (const id of ids) {
        send('fix:line', { line: `Turning on: ${(tweakById(id) || {}).name || id}` });
        if ((await applyAndVerify(id)).ok) ok++;
      }
      await detectExtra();
      return { ok: ok === ids.length, message: `Turned on ${ok} of ${ids.length} preset setting${ids.length === 1 ? '' : 's'}.` };
    }
    case 'cool_cpu': {
      const ids = ['cpu_min', 'cpu_boost', 'core_parking'].filter((id) => backup.get(id));
      for (const id of ids) await setTweak(id, false, { byUser: true });
      return { ok: true, message: `Switched off ${ids.map((id) => tweakById(id).name).join(', ')}. Give it a few minutes of gaming to see the difference.` };
    }
    case 'laptop_power': {
      if (!DEMO) {
        const r = await run('powercfg', ['/overlaysetactive', 'ded574b5-45a0-4f42-8737-46345c09c238']);
        if (r.code !== 0) return { ok: false, message: 'Windows didn’t accept the power mode change.' };
      }
      await detectExtra();
      held.set('insight_laptop', { until: Date.now() + 12 * 3600 * 1000 }); // still on battery, but the mode is set; back when plugged in and unplugged again
      return { ok: true, message: 'Windows power mode is set to Best performance.' };
    }
    case 'restore_check': {
      if (await recentRestorePoint()) {
        problems.remove('restore_point');
        send('fix:changed', true);
        return { ok: true, message: 'You already have a restore point from today — Windows allows one a day, so you’re covered.' };
      }
      return { ok: false, message: 'No restore point from today yet.' };
    }
    case 'redownload_ctt': {
      try {
        fs.rmSync(tools.winutilPath(), { force: true });
      } catch {}
      return runFixAction('retry:ctt_tweaks');
    }
    case 'ctt_isolate': {
      // Find which of Chris Titus's tweaks fails on this PC, leave just those out, and run the rest.
      const p = problems.all().ctt_tweaks;
      const preset = settings.get().cttPreset || 'Standard';
      const skip = new Set(settings.get().cttSkip || []);
      let bad = ((p && p.failedIds) || []).filter((id) => !skip.has(id));
      if (!bad.length) {
        const ids = (optimizer.CTT_PRESETS[preset] || []).filter((i) => i !== 'WPFTweaksRestorePoint' && !skip.has(i));
        for (const [n, id] of ids.entries()) {
          const name = optimizer.CTT_NAMES[id] || id;
          send('fix:line', { line: `Testing Chris Titus tweak ${n + 1} of ${ids.length}: ${name}…` });
          const r = await tools.runWinutil([id], () => {}, optimizer.CTT_NAMES).catch((e) => ({ ok: false, code: -1, errors: [String(e.message || e)], fatal: null }));
          const worked = r.ok || (r.code === 1 && !(r.errors || []).length && !r.fatal);
          if (!worked) {
            bad.push(id);
            send('fix:line', { line: `  ✗ ${name} fails on this PC` });
          }
        }
      }
      if (!bad.length) return runFixAction('retry:ctt_tweaks');
      settings.set({ cttSkip: [...new Set([...skip, ...bad])] });
      const names = bad.map((id) => optimizer.CTT_NAMES[id] || id).join(', ');
      send('fix:line', { line: `Leaving out: ${names}. Running the rest of the ${preset} preset…` });
      const r = await runFixAction('retry:ctt_tweaks');
      return r.ok ? { ok: true, message: `The ${preset} preset is applied. Left out ${names} — ${bad.length === 1 ? 'it fails' : 'they fail'} on this PC.` } : r;
    }
    case 'gpu_cool': {
      const t = tweakById('gpu_cool');
      if (!t) return { ok: false, message: 'Unknown fix' };
      const r = await tweakPhase(t)();
      return { ok: r.status === 'done', message: r.message, cooling: true };
    }
    case 'amd_install': {
      if (!rig || rig.gpu.vendor !== 'amd') return { ok: false, message: 'This PC doesn’t have an AMD graphics card.' };
      const r = await tools.amdDriverInstall(rig.gpu.name, (line) => send('fix:line', { line })).catch((e) => ({ ok: false, message: String(e.message || e) }));
      if (!r.ok) {
        if (rig.vendorApp) shell.openExternal(rig.vendorApp.download);
        return { ok: false, message: `${r.message} FrameForge opened AMD’s download page instead.` };
      }
      // AMD Software may need a restart once it's installed: check again in a few minutes.
      setTimeout(async () => {
        rig = await hardware.scan(settings.get().manualHardware).catch(() => rig);
        send('rig', rig);
        send('fix:changed', true);
      }, 5 * 60 * 1000);
      return r;
    }
    case 'bios': {
      // Windows can restart straight into the BIOS/UEFI setup (no key tapping). The BIOS setting itself can
      // only be changed there — no app can reach it from Windows.
      settings.set({ biosCheck: { mts: (rig && rig.ram && rig.ram.speedMTs) || null, at: Date.now() } });
      const ok = await restartCountdown({ seconds: 20, reason: 'Restarting into the BIOS so you can turn on XMP/EXPO', bios: true });
      if (!ok) settings.set({ biosCheck: null });
      return { ok, message: ok ? 'Restarting into the BIOS…' : 'Restart cancelled.' };
    }
    case 'free_space': {
      const before = extra.disk;
      const t = tweakById('temp_cleanup');
      if (t) await tweakPhase(t)();
      if (!DEMO) {
        send('fix:line', { line: 'Removing old Windows update files (DISM /StartComponentCleanup) — this can take a few minutes…' });
        await fixes.runLines('DISM.exe', ['/Online', '/Cleanup-Image', '/StartComponentCleanup'], (line) => send('fix:line', { line }), 30 * 60 * 1000);
      }
      const after = await detectExtra();
      const freed = before && after.disk ? Math.max(0, after.disk.freeGB - before.freeGB) : 0;
      changes.put(`free_space_${Date.now()}`, { name: 'Freed up space on drive C:', summary: `Cleared temp files and old Windows update leftovers — about ${freed} GB freed.`, details: ['Temp folders emptied', 'DISM /Online /Cleanup-Image /StartComponentCleanup'], at: Date.now(), preset: settings.get().preset, undoable: false, reboot: false });
      send('changes', changeList());
      return { ok: true, message: `Freed about ${freed} GB.` };
    }
    case 'vendor_install': {
      const candidates = (rig && tools.WINGET_APPS[rig.gpu.vendor]) || [];
      if (!candidates.length || !(await tools.hasWinget())) return { ok: false, message: 'There’s no verified automatic installer for this driver app.' };
      for (const c of candidates) {
        send('fix:line', { line: `Looking up ${c.name} in Microsoft’s app store (winget)…` });
        if (!(await tools.wingetKnows(c.id))) continue;
        send('fix:line', { line: `Installing ${c.name}…` });
        const r = await tools.wingetInstall(c.id);
        rig = await hardware.scan(settings.get().manualHardware);
        send('rig', rig);
        return r.ok ? { ok: true, message: `Installed ${c.name}.` } : { ok: false, message: r.message };
      }
      return { ok: false, message: 'Microsoft’s app store doesn’t have it right now.' };
    }
    case 'revert_oc': {
      const t = tweakById('gpu_power_limit');
      if (t && backup.get(t.id)) await revertPhase(t, 'Graphics card was running hot')();
      return { ok: true, message: 'Graphics card power limit is back to normal.' };
    }
    case 'set_update_source':
      settings.set({ updateSource: 'toer15/frameforge' });
      if (updates) {
        updates.configure('toer15/frameforge');
        updates.check();
      }
      return { ok: true, message: 'Updates come from the official FrameForge page again.' };
    case 'restart': {
      const ok = await restartCountdown({ seconds: 10, reason: 'Restarting to finish the changes' });
      return { ok, restarted: ok, message: ok ? 'Restarting — FrameForge opens again by itself afterwards and finishes up.' : 'Restart cancelled.' };
    }
    case 'repair':
      return runRepair(arg);
    case 'install': {
      const r = await tools.install(arg, (p) => send('tools:progress', { id: arg, p })).catch((e) => ({ ok: false, message: String(e.message || e) }));
      applyMonitoring();
      send('fix:changed', true);
      return r;
    }
    case 'open_ctt':
      await tools.openWinutil();
      return { ok: true, message: 'Chris Titus’s Windows Utility is opening in its own window.' };
    case 'open':
      if (/^ms-settings:[a-z-]+$/.test(arg)) shell.openExternal(arg);
      return { ok: true, message: 'Opened Windows Settings.' };
    case 'openfile':
      if (/\.log$/i.test(arg)) shell.openPath(arg);
      return { ok: true, message: 'Opened the log.' };
    case 'vendor':
      if (rig && rig.vendorApp) shell.openExternal(rig.vendorApp.download);
      return { ok: true, message: 'Opened the official download page.' };
    case 'admin':
      if (IS_WIN && !DEMO) await relaunchAsAdmin();
      return { ok: true, message: 'Restarting as administrator…' };
    case 'goto':
      send('goto', arg);
      return { ok: true };
    case 'scan_results':
      send('goto', 'scan');
      send('scan:showResults', true);
      return { ok: true };
    case 'quarantine_real': {
      // Only detections that are clearly real (known malware family) — never "probably", unwanted programs or false positives.
      const lr = scanjob.last();
      const choices = {};
      for (const i of lr ? lr.items : []) if (i.status === 'active' && !i.done && i.verdict === 'real' && i.actions.includes('quarantine')) choices[i.id] = 'quarantine';
      const n = Object.keys(choices).length;
      if (!n) return { ok: false, message: 'No detection is clear-cut enough for FrameForge to quarantine by itself — open the scan results and choose.' };
      const res = await scanjob.apply(choices);
      send('changes', changeList());
      const okN = res.results.filter((x) => x.ok).length;
      return { ok: okN === n, message: `Quarantined ${okN} of ${n} confirmed threat${n === 1 ? '' : 's'} — they can’t run any more. Restore any of them from the Virus scan tab.${res.reboot ? ' A locked file is removed at the next restart.' : ''}` };
    }
    case 'sec_fix': {
      await refreshSecurity();
      const todo = (secChecks || []).filter((c) => ['big', 'medium'].includes(c.level) && c.fix && c.id !== 'proxy' && c.fix !== 'open_defender');
      const out = [];
      for (const c of todo) {
        send('fix:line', { line: `${c.fixLabel}: ${c.title}` });
        const r = await securityFix(c.id);
        out.push(r.ok);
      }
      await refreshSecurity();
      return { ok: out.every(Boolean), message: `Fixed ${out.filter(Boolean).length} of ${todo.length} Windows protection problem${todo.length === 1 ? '' : 's'}.` };
    }
  }
  return { ok: false, message: 'Unknown fix' };
}

// ---------- Restarting the PC for a fix: a countdown you can cancel, then FrameForge carries on by itself ----------
let restartTimer = null;
let restartResolve = null;
let restartInfo = null;
const RESUME_TASK = 'FrameForge Resume';
const RUNONCE = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce';

/** Make FrameForge start by itself right after the restart and finish fixing. */
async function prepareResume() {
  settings.set({ resumeFixAll: true });
  if (!IS_WIN || DEMO) return;
  const cmd = `"${process.execPath}" --resume-fix`;
  // A sign-in task with highest rights starts FrameForge as administrator (no extra prompt)…
  const r = admin ? await run('schtasks', ['/Create', '/TN', RESUME_TASK, '/TR', cmd, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']) : { code: 1 };
  // …and without admin rights, Windows' "run once at next sign-in" list does it.
  if (r.code !== 0) await run('reg', ['add', RUNONCE, '/v', 'FrameForgeResume', '/t', 'REG_SZ', '/d', cmd, '/f']);
}
function removeResumeTask() {
  if (!IS_WIN || DEMO) return;
  run('schtasks', ['/Delete', '/TN', RESUME_TASK, '/F']).catch(() => {});
  run('reg', ['delete', RUNONCE, '/v', 'FrameForgeResume', '/f']).catch(() => {});
}

async function doRestart({ bios = false, auto = false } = {}) {
  await prepareResume();
  if (auto) settings.set({ lastAutoRestart: Date.now() });
  send('restart:countdown', { left: 0, restarting: true, bios });
  if (!IS_WIN || DEMO) return true;
  // No /f: an app with unsaved work can still stop the restart and ask you, so nothing gets lost.
  const r = await run('shutdown', bios ? ['/r', '/fw', '/t', '0'] : ['/r', '/t', '0']);
  if (r.code !== 0) {
    settings.set({ resumeFixAll: false });
    removeResumeTask();
    const message = bios
      ? 'This PC can’t restart straight into the BIOS from Windows (older “Legacy” BIOS mode). Restart it and tap Delete or F2 as the screen turns on.'
      : `Windows didn’t accept the restart (${(r.stderr || r.stdout || '').trim().slice(0, 120) || `code ${r.code}`}).`;
    send('restart:countdown', { failed: true, message });
    return false;
  }
  quitting = true;
  return true;
}

/** Count down (shown in FrameForge, with Restart now / Cancel), then restart. Resolves true if restarting. */
function restartCountdown({ seconds = 60, reason = 'Restarting to finish the fixes', bios = false, auto = false } = {}) {
  if (restartTimer) return Promise.resolve(false);
  return new Promise((resolve) => {
    let left = seconds;
    restartResolve = resolve;
    restartInfo = { total: seconds, reason, bios, auto };
    const finish = async () => {
      clearInterval(restartTimer);
      restartTimer = null;
      restartResolve = null;
      restartInfo = null;
      resolve(await doRestart({ bios, auto }));
    };
    const tick = () => {
      if (left <= 0) return finish();
      send('restart:countdown', { left, total: seconds, reason, bios });
      if (tray) tray.setToolTip(`FrameForge — restarting in ${left} s`);
      left--;
    };
    restartCountdown.now = finish;
    if (windowHidden() && Notification.isSupported()) {
      const n = new Notification({ title: `FrameForge restarts your PC in ${seconds} seconds`, body: `${reason}. Click to open FrameForge to cancel or restart now. Save anything you have open.`, icon: ICON });
      n.on('click', showMain);
      n.show();
    }
    showMain();
    tick();
    restartTimer = setInterval(tick, 1000);
    rebuildTrayMenu();
  });
}
function cancelRestart() {
  if (!restartTimer) return false;
  clearInterval(restartTimer);
  restartTimer = null;
  restartInfo = null;
  if (tray) tray.setToolTip('FrameForge');
  settings.set({ resumeFixAll: false });
  send('restart:countdown', { cancelled: true });
  const r = restartResolve;
  restartResolve = null;
  if (r) r(false);
  rebuildTrayMenu();
  return true;
}
ipcMain.handle('restart:cancel', () => cancelRestart());
ipcMain.handle('restart:now', () => (restartTimer && restartCountdown.now ? (restartCountdown.now(), true) : false));

/** Restarting by itself is allowed at most once every 3 hours — a restart that doesn't clear the problem never loops. */
function mayAutoRestart() {
  const s = settings.get();
  return s.autoRestart && Date.now() - (s.lastAutoRestart || 0) > 3 * 60 * 60 * 1000;
}

/**
 * "Fix everything automatically": check the PC, then for each problem try its fixes in order, checking after
 * each one whether the problem is gone. If a fix needs a restart, FrameForge restarts the PC itself (with a
 * countdown you can cancel) and finishes after the restart. If admin rights are missing, it restarts itself
 * as administrator and carries on. Only what no app can do (BIOS, cables, dust) is left for you, with steps.
 *
 *   silent – background run: only fixes marked safe for the moment, opens nothing, never restarts
 *   only   – limit the run to these problem ids
 */
let fixAllRunning = false;

/**
 * Try one problem's fixes in order, checking after each one whether it's really gone — the problem then leaves
 * the list. Heat can't drop in a second: a cooling fix that worked counts, and if the part is still hot after a
 * few minutes the problem simply shows up again.
 */
async function tryFix(it, ev = () => {}) {
  let fixed = false;
  let last = null;
  for (const [n, st] of it.strategies.entries()) {
    ev({ type: 'try', id: it.id, text: st.label, n: n + 1, of: it.strategies.length });
    last = await runFixAction(st.id).catch((e) => ({ ok: false, message: String(e.message || e) }));
    await detectExtra();
    fixed = !fixList().some((x) => x.id === it.id) || (it.verifyLater && last && last.ok);
    if (fixed) break;
  }
  if (fixed && it.verifyLater) heat[it.id === 'hot_gpu' ? 'gpu' : 'cpu'].last = 0; // start measuring again from now
  send('fix:changed', true);
  return { fixed, last };
}

/**
 * One problem, fixed by a click or by the AI. Problems with fixes are tried in order and checked; the rest run
 * their single button. Returns what happened, plus the manual steps when only the user can finish it.
 */
async function fixOne(id) {
  if (fixAllRunning || fixBusy) return { ok: false, busy: true, message: 'FrameForge is already fixing something — hang on a moment.' };
  await detectExtra();
  const it = fixList().find((i) => i.id === id);
  if (!it) return { ok: true, fixed: true, message: 'That problem is already gone.' };
  if (!it.strategies.length) {
    const a = it.actions[0];
    if (!a) return { ok: false, fixed: false, message: 'FrameForge can’t fix this one from Windows.', steps: it.manual || [] };
    const last = await runFixAction(a.id).catch((e) => ({ ok: false, message: String(e.message || e) }));
    await detectExtra();
    send('fix:changed', true);
    const gone = !fixList().some((x) => x.id === id);
    return { ok: !!(last && last.ok !== false), fixed: gone, message: (last && last.message) || '', steps: gone ? [] : it.manual || [] };
  }
  const { fixed, last } = await tryFix(it);
  if (fixed) return { ok: true, fixed: true, title: it.fixedTitle || it.title, message: (last && last.message) || it.fixedTitle || 'Fixed.' };
  return { ok: false, fixed: false, message: (last && last.message) || 'It didn’t work after trying every fix FrameForge knows.', steps: it.manual || [] };
}
async function fixEverything({ silent = false, only = null, resumed = false } = {}) {
  if (fixAllRunning) return { busy: true };
  if (busy) return { busy: true, message: 'Auto Mode is running — wait for it to finish.' };
  fixAllRunning = true;
  const ev = (e) => send('fixall', { ...e, background: silent });
  const tally = { fixed: 0, you: 0, failed: 0, fixedTitles: [] };
  try {
    ev({ type: 'start', resumed });
    ev({ type: 'phase', text: resumed ? 'Back after the restart — checking that everything worked…' : silent ? 'Fixing in the background…' : 'Checking your whole PC…' });
    if (rig && !silent) rig = await hardware.scan(settings.get().manualHardware).catch(() => rig);
    await detectExtra();
    const items = fixList().filter((i) => !only || only.includes(i.id));
    ev({ type: 'found', count: items.filter((i) => !i.restartItem).length });
    // Back from the BIOS: did the RAM speed change?
    const bc = settings.get().biosCheck;
    if (resumed && bc) {
      settings.set({ biosCheck: null });
      const mts = rig && rig.ram && rig.ram.speedMTs;
      if (mts && bc.mts && mts > bc.mts && !items.some((i) => i.id === 'insight_ram_speed')) {
        tally.fixed++;
        tally.fixedTitles.push(`RAM runs at ${mts} MT/s`);
        ev({ type: 'item', id: 'bios_check', title: 'RAM speed after the BIOS change', outcome: 'fixed', message: `Your RAM now runs at ${mts} MT/s instead of ${bc.mts} — XMP/EXPO is on.` });
      }
    }
    const needAdmin = items.find((i) => i.id === 'not_admin');
    for (const it of items) {
      if (it.id === 'not_admin' || it.restartItem) continue; // both happen last
      if (!it.strategies.length) {
        if (silent) continue;
        if (it.manualAction) await runFixAction(it.manualAction).catch(() => {});
        if (it.manual) {
          tally.you++;
          ev({ type: 'item', id: it.id, title: it.title, outcome: 'you', message: it.body, steps: it.manual, buttons: it.actions });
        }
        continue;
      }
      ev({ type: 'item', id: it.id, title: it.title, outcome: 'working' });
      const { fixed, last } = await tryFix(it, ev);
      if (fixed) {
        tally.fixed++;
        tally.fixedTitles.push(it.fixedTitle || it.title);
        ev({ type: 'item', id: it.id, title: it.title, outcome: 'fixed', message: last && last.message });
        send('fix:changed', true); // the problem leaves the list and the count goes down right away
      } else if (silent) {
        ev({ type: 'item', id: it.id, title: it.title, outcome: 'failed', message: (last && last.message) || 'Didn’t work yet — FrameForge tries again later.' });
      } else if (it.manual) {
        const started = last && last.ok && it.manualAfter;
        if (it.manualAction && !started) await runFixAction(it.manualAction).catch(() => {});
        tally.you++;
        ev({ type: 'item', id: it.id, title: it.title, outcome: 'you', message: last && last.message, steps: started ? it.manualAfter : it.manual, buttons: it.actions.filter((a) => !it.strategies.some((st) => st.id === a.id)) });
      } else {
        tally.failed++;
        ev({ type: 'item', id: it.id, title: it.title, outcome: 'failed', message: (last && last.message) || 'It didn’t work after trying every fix FrameForge knows.' });
      }
    }
    // A restart that's needed now (by Windows or by a fix that just ran): FrameForge does it itself.
    await detectExtra();
    const restartIt = fixList().find((i) => i.restartItem);
    if (restartIt && !silent) {
      if (mayAutoRestart() && !needAdmin) {
        ev({ type: 'item', id: 'restart', title: restartIt.title, outcome: 'working', message: `${restartIt.body} Restarting in 60 seconds — FrameForge opens again by itself afterwards and checks everything. Save anything you have open, or press Cancel.` });
        ev({ type: 'done', ...tally, restarting: 'pc' });
        const ok = await restartCountdown({ seconds: 60, reason: restartIt.body.replace(/\.$/, ''), auto: true });
        if (ok) return { ...tally, restarting: 'pc' };
        ev({ type: 'item', id: 'restart', title: restartIt.title, outcome: 'you', message: 'Restart cancelled — restart whenever it suits you. FrameForge finishes up by itself afterwards.', buttons: [A('restart', 'Restart now')] });
        ev({ type: 'done', ...tally });
        return tally;
      }
      tally.you++;
      ev({ type: 'item', id: 'restart', title: restartIt.title, outcome: 'you', message: settings.get().autoRestart ? 'FrameForge already restarted the PC for this in the last few hours, so it won’t do it again by itself (no restart loops). Restart when it suits you.' : `${restartIt.body} Automatic restarts are off in Settings.`, buttons: [A('restart', 'Restart now')] });
    }
    if (needAdmin && !silent) {
      ev({ type: 'item', id: 'not_admin', title: needAdmin.title, outcome: 'working', message: 'Restarting FrameForge as administrator — it carries on fixing by itself after the restart.' });
      ev({ type: 'done', ...tally, restarting: 'admin' });
      settings.set({ resumeFixAll: true });
      await new Promise((r) => setTimeout(r, 700));
      await runFixAction('admin');
      return { restarting: 'admin' };
    }
    ev({ type: 'done', ...tally });
    return tally;
  } finally {
    fixAllRunning = false;
    send('fix:changed', true);
  }
}

/**
 * Fix mode on its own: after start and after every re-check (every 2 minutes) FrameForge fixes what it safely
 * can without asking. What's safe depends on what you're doing:
 *   'game'  – any time, even mid-game (e.g. cooling a hot graphics card — no flicker, no lag)
 *   'quiet' – not while a game runs (e.g. switching the display to its full refresh rate makes it blink once)
 *   'idle'  – only when you've been away for 10+ minutes (e.g. cleanup or Chris Titus — they keep the CPU busy)
 * Each problem is tried at most once every 6 hours, so a fix that doesn't work never runs in a loop.
 */
const bgTried = new Map();
let bgRunning = false;
async function backgroundFix(why = 'check') {
  const s = settings.get();
  if (!s.autoFix || bgRunning || fixAllRunning || busy || fixBusy || restartTimer) return null;
  if (IS_WIN && !DEMO && !admin) return null;
  bgRunning = true;
  try {
    await detectExtra();
    const game = gameRunning();
    const idle = idleMinutes();
    const ok = (it) => it.bg && it.strategies.length && (it.bg === 'game' || (it.bg === 'quiet' && !game) || (it.bg === 'idle' && !game && idle >= 10));
    const now = Date.now();
    const todo = fixList().filter((it) => ok(it) && !(now - (bgTried.get(it.id) || 0) < 6 * 60 * 60 * 1000));
    if (todo.length) {
      todo.forEach((it) => bgTried.set(it.id, now));
      const r = await fixEverything({ silent: true, only: todo.map((i) => i.id) });
      if (r && r.fixed) {
        const n = r.fixedTitles.length;
        if (Notification.isSupported() && windowHidden()) {
          const note = new Notification({ title: `FrameForge fixed ${n} thing${n === 1 ? '' : 's'} by itself`, body: r.fixedTitles.slice(0, 3).join(' · '), icon: ICON, silent: true });
          note.on('click', () => {
            showMain();
            send('goto', 'fix');
          });
          note.show();
        }
        send('fix:auto', { fixed: r.fixedTitles, why });
      }
    }
    // A restart that FrameForge's own changes need: done while you're away (20+ min idle, no game running).
    const pending = restartNeededFor();
    if (pending.length && mayAutoRestart() && !game && idle >= 20 && !fixAllRunning) {
      await restartCountdown({ seconds: 120, reason: `To finish ${pending.join(', ')}`, auto: true });
    }
    return todo.length;
  } finally {
    bgRunning = false;
  }
}

// ---------- Virus scan ----------
let secChecks = null;
let engine = null;
async function refreshSecurity() {
  engine = await scanner.engineStatus();
  secChecks = await scanner.checks(engine);
  return secChecks;
}
async function securityFix(id) {
  const c = (secChecks || []).find((x) => x.id === id);
  if (!c || !c.fix) return { ok: false, message: 'Nothing to fix.' };
  const r = await scanner.fixCheck(c.fix, c.data);
  if (r.ok) {
    changes.put(`security_${c.id}_${Date.now()}`, { name: `Protection: ${c.fixLabel}`, summary: `${c.title} — ${r.message}`, details: c.details || [], at: Date.now(), preset: settings.get().preset, undoable: false, reboot: !!r.reboot });
    send('changes', changeList());
  }
  await refreshSecurity();
  send('fix:changed', true);
  return r;
}
const DAY = 24 * 3600 * 1000;
const SCHEDULE_DAYS = { daily: 1, weekly: 7, biweekly: 14, monthly: 30 };
/**
 * Scheduled scans (Settings › Virus scan). Runs only while the user is away (10+ min idle), no game is running,
 * and — on a laptop — the charger is plugged in. A full scan that is due also covers the quick scan.
 */
function autoScanTick() {
  const s = settings.get();
  if (!engine || !engine.available || scanjob.running() || busy || fixAllRunning) return null;
  if (DEMO && !process.env.FRAMEFORGE_TEST_AUTOSCAN) return null;
  if (gameRunning() || idleMinutes() < 10) return null;
  try {
    if (powerMonitor.isOnBatteryPower()) return null;
  } catch {}
  const quickEvery = s.autoScan === false ? 0 : SCHEDULE_DAYS[s.scanSchedule || 'weekly'] || 0;
  const fullEvery = SCHEDULE_DAYS[s.scanFullSchedule] || 0;
  const stats = s.scanStats || {};
  const now = Date.now();
  if (now - lastAutoScanTry < 6 * 3600 * 1000) return null; // a stopped or failed scan isn't retried in a loop
  const due = (days, at) => days && now - (at || 0) > days * DAY;
  let type = null;
  if (due(fullEvery, stats.full && stats.full.at)) type = 'full';
  else if (due(quickEvery, s.lastScanAt)) type = 'quick';
  if (!type) return null;
  lastAutoScanTry = now;
  scanjob.start(type, { background: true });
  return type;
}
let lastAutoScanTry = 0;
function onScanFinished(r) {
  const s = scanjob.summary(r);
  send('fix:changed', true);
  if ((s.open || r.background) && Notification.isSupported() && windowHidden()) {
    const n = new Notification({
      title: s.open ? `FrameForge found ${s.open} threat${s.open === 1 ? '' : 's'}` : 'FrameForge’s weekly scan is done — all clear',
      body: s.open ? 'Click to see them and choose Quarantine, Delete or Keep.' : `${s.filesChecked.toLocaleString()} files checked. ${s.counts.fp ? `${s.counts.fp} false positive${s.counts.fp === 1 ? '' : 's'} left alone.` : ''}`,
      icon: ICON,
    });
    n.on('click', () => {
      showMain();
      send('goto', 'scan');
      send('scan:showResults', true);
    });
    n.show();
  }
}
ipcMain.handle('scan:info', async (_e, { refresh = false } = {}) => {
  if (refresh || !engine) await refreshSecurity().catch(() => {});
  const s = settings.get();
  return { engine, checks: secChecks || [], estimates: await scanjob.estimates(), running: scanjob.snapshot(), last: scanjob.last() ? scanjob.summary(scanjob.last()) : null, totals: scanjob.totals(), quarantine: scanner.quarantineList(), allowed: s.scanAllowed || [], hashLookup: s.scanHashLookup, autoScan: s.autoScan, history: scanjob.history(), lastScanAt: s.lastScanAt || 0, stats: s.scanStats || {} };
});
ipcMain.handle('scan:start', (_e, type, folder) => scanjob.start(type, { folder }));
ipcMain.handle('scan:cancel', () => scanjob.cancel());
ipcMain.handle('scan:pause', () => scanjob.pause());
ipcMain.handle('scan:resume', () => scanjob.resume());
ipcMain.handle('scan:drives', () => scanner.drives());
ipcMain.handle('scan:updateSigs', async () => {
  const r = await scanner.fixCheck('update_sigs');
  await refreshSecurity().catch(() => {});
  return r;
});
ipcMain.handle('scan:pickFile', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: 'Pick a file to scan', properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('scan:export', async () => {
  const text = scanjob.report(engine);
  if (!text) return { ok: false, message: 'No scan results yet.' };
  const def = path.join(app.getPath('documents'), `FrameForge-scan-report-${new Date().toISOString().slice(0, 10)}.txt`);
  const r = await dialog.showSaveDialog(mainWin, { title: 'Save the scan report', defaultPath: def, filters: [{ name: 'Text file', extensions: ['txt'] }] });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.writeFileSync(r.filePath, '﻿' + text, 'utf8');
  shell.showItemInFolder(r.filePath);
  return { ok: true, path: r.filePath };
});
ipcMain.handle('scan:last', () => scanjob.last());
ipcMain.handle('scan:apply', async (_e, choices) => {
  const r = await scanjob.apply(choices || {});
  send('changes', changeList());
  send('fix:changed', true);
  return r;
});
ipcMain.handle('scan:fixCheck', (_e, id) => securityFix(id));
ipcMain.handle('scan:qRestore', (_e, id, allow) => scanner.restoreQuarantined(id, { allow: !!allow }));
ipcMain.handle('scan:qDelete', (_e, id) => scanner.deleteQuarantined(id));
ipcMain.handle('scan:pickFolder', async () => {
  const r = await dialog.showOpenDialog(mainWin, { title: 'Pick a folder to scan', properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('scan:showFile', (_e, f) => {
  if (f && fs.existsSync(f)) shell.showItemInFolder(f);
});
ipcMain.handle('scan:virusTotal', (_e, sha) => {
  if (/^[a-f0-9]{64}$/i.test(sha || '')) shell.openExternal(`https://www.virustotal.com/gui/file/${sha}`);
});

// ---------- Cleaner: junk files that fill the drive and slow the PC down ----------
const cleanFolders = () => ({ downloads: app.getPath('downloads'), desktop: app.getPath('desktop'), documents: app.getPath('documents'), videos: app.getPath('videos') });
ipcMain.handle('clean:state', async () => {
  const lastScan = scanjob.last();
  return { ...cleaner.state(), disk: await cleaner.disk(), admin: admin || DEMO, stats: settings.get().cleanStats || null, programs: startupApps.view(), estimates: await scanjob.estimates().catch(() => null), virus: { running: scanjob.snapshot(), last: lastScan ? scanjob.summary(lastScan) : null } };
});
ipcMain.handle('clean:scan', async (_e, mode) => {
  const r = await cleaner.scan({ mode, folders: cleanFolders(), userData: app.getPath('userData') }, (p) => send('clean:progress', p));
  if (r.ok && !r.cancelled) settings.set({ cleanStats: { ...(settings.get().cleanStats || {}), lastScanAt: Date.now(), lastFound: r.result.found } });
  return { ...r, disk: await cleaner.disk() };
});
ipcMain.handle('clean:cancel', () => cleaner.cancel());
ipcMain.handle('clean:run', async (_e, sel) => {
  const r = await cleaner.clean(sel || {}, { trash: (f) => shell.trashItem(f) }, (p) => send('clean:progress', p));
  if (r.ok && (r.deleted || r.trashed)) {
    const st = settings.get().cleanStats || {};
    settings.set({ cleanStats: { ...st, lastCleanAt: Date.now(), lastFreed: r.freed, totalFreed: (st.totalFreed || 0) + r.freed } });
    const details = r.result.cats.filter((c) => c.last && (c.last.deleted || c.last.trashed)).map((c) => `${c.name}: ${c.last.message}`);
    changes.put(`clean_${Date.now()}`, { name: 'Cleaned junk files', summary: `Cleaner deleted ${r.deleted.toLocaleString('en-US')} file${r.deleted === 1 ? '' : 's'} and freed ${cleaner.fmt(r.freed)}${r.trashed ? `; ${r.trashed === 1 ? 'one of your own files' : `${r.trashed} of your own files`} went to the Recycle Bin` : ''}.`, details, at: Date.now(), preset: settings.get().preset, undoable: false, reboot: false });
    send('changes', changeList());
    extra.at = 0; // Fix mode re-reads the free space on drive C:
    send('fix:changed', true);
  }
  return { ...r, disk: await cleaner.disk() };
});
ipcMain.handle('clean:show', (_e, id) => {
  const f = cleaner.filePath(id);
  if (f && fs.existsSync(f)) shell.showItemInFolder(f);
});
// Programs that slow the PC: what starts with Windows, and what uses a lot right now.
ipcMain.handle('clean:programs', () => startupApps.check());
ipcMain.handle('clean:startupSet', async (_e, id, on) => {
  const r = await startupApps.set(id, !!on);
  const it = r.ok && (startupApps.view() || { startup: [] }).startup.find((s) => s.id === id);
  if (it) {
    if (on) changes.remove(`startup_${id}`);
    else changes.put(`startup_${id}`, { name: `${it.name} no longer starts with Windows`, summary: `Turned off in Cleaner, the same switch as Task Manager’s Startup apps. Nothing was uninstalled — switch it back on in Cleaner any time.`, details: [`${it.srcLabel}: ${it.rawName}`, it.cmd], at: Date.now(), preset: settings.get().preset, undoable: false, reboot: false });
    send('changes', changeList());
  }
  return r;
});
ipcMain.handle('clean:closeApp', (_e, key) => startupApps.close(key));

// ---------- Windows animations: one switch, kept the way the user set it ----------
/** Animations on wins over the older "Performance visual effects" boost: switch that off so the two don't fight. */
async function dropVisualEffectsBoost(why) {
  if (!backup.get('visual_effects')) return;
  settings.set({ userOff: { ...(settings.get().userOff || {}), visual_effects: true } });
  await revertPhase(tweakById('visual_effects'), why)();
}
async function enforceAnimations(why) {
  const want = settings.get().animations;
  if (want !== 'on' && want !== 'off') return false;
  if (want === 'on') await dropVisualEffectsBoost('Windows animations are switched on in Settings').catch(() => {});
  const fixed = await animations.enforce(want).catch(() => false);
  if (fixed && why !== 'start') {
    changes.put('animations', { name: `Windows animations ${want}`, summary: `Something changed Windows’ animations (a tweak tool, a preset, another app or Windows Settings), so FrameForge switched them ${want} again — your choice in Settings wins.`, details: [], at: Date.now(), preset: settings.get().preset, undoable: false, reboot: false });
    send('changes', changeList());
  }
  if (fixed) send('anim:changed', await animations.get());
  return fixed;
}
/**
 * Watch for anything that changes the animations after the user made their choice — another app, a tweak tool,
 * Windows Settings, a Windows update. A light registry fingerprint is compared every 20 seconds; any change (and a
 * full check every minute, for changes that never reach the registry) puts the user's choice back right away.
 * If something keeps fighting FrameForge, it backs off to once a minute instead of spinning.
 */
let animFp = null;
let animWatching = false;
let animTick = 0;
const animFixes = [];
async function animWatch() {
  const want = settings.get().animations;
  if ((want !== 'on' && want !== 'off') || animWatching || busy) return;
  animWatching = true;
  try {
    animTick++;
    const fp = await animations.fingerprint();
    const recent = animFixes.filter((t) => Date.now() - t < 5 * 60 * 1000);
    animFixes.length = 0;
    animFixes.push(...recent);
    const fighting = recent.length >= 5; // something undoes the choice again and again: check once a minute only
    const due = animFp === null || (fp !== animFp && !fighting) || animTick % 3 === 0;
    if (due) {
      if (await enforceAnimations('watch')) animFixes.push(Date.now());
      animFp = await animations.fingerprint();
    } else animFp = fp;
  } catch {
  } finally {
    animWatching = false;
  }
}
/** Cap games at the number chosen in Settings (or remove the cap). Returns { ok, limit, message }. */
async function applyLimiter() {
  const s = settings.get();
  const want = s.fpsLimitOn ? fplimit.clamp(s.fpsLimit) : 0;
  const r = await fplimit.apply(want, { install: () => tools.wingetInstall(fplimit.WINGET_ID) });
  if (!want) changes.remove('fps_limiter');
  else {
    changes.put('fps_limiter', r.ok
      ? { name: `FPS limit ${want}`, summary: `Games are capped at ${want} FPS by RivaTuner Statistics Server (RTSS). FrameForge keeps the cap in place.`, details: [], at: Date.now(), preset: s.preset, undoable: false, reboot: false }
      : { name: 'FPS limit needs attention', summary: r.message || 'The FPS limit was not applied.', details: [], at: Date.now(), preset: s.preset, undoable: false, reboot: false });
  }
  send('changes', changeList());
  return r;
}
let limiterBusy = false;
let limiterFails = 0;
async function limiterWatch() {
  const s = settings.get();
  if (!s.fpsLimitOn || limiterBusy || busy || limiterFails >= 3) return;
  limiterBusy = true;
  try {
    if (await fplimit.drifted(s.fpsLimit)) {
      const r = await applyLimiter();
      limiterFails = r.ok ? 0 : limiterFails + 1; // give up after 3 failed tries instead of looping
    } else limiterFails = 0;
  } catch {
  } finally {
    limiterBusy = false;
  }
}
ipcMain.handle('controllers:detect', () => controllers.detect());
ipcMain.handle('limiter:status', async () => ({ on: settings.get().fpsLimitOn, fps: settings.get().fpsLimit, ...(await fplimit.status()) }));
ipcMain.handle('anim:get', async () => ({ want: settings.get().animations, ...(await animations.get()) }));
ipcMain.handle('anim:set', async (_e, on) => {
  settings.set({ animations: on ? 'on' : 'off' });
  animFp = null; // the watcher takes a fresh baseline after the change
  if (on) await dropVisualEffectsBoost('Windows animations switched on in Settings');
  const r = await animations.set(!!on);
  changes.put('animations', { name: r.ok ? `Windows animations ${on ? 'on' : 'off'}` : 'Windows animations need attention', summary: !r.ok ? r.message : on ? 'Windows animations and live window contents while dragging are on, with visual effects restored. FrameForge keeps your choice.' : 'Windows animations and live window contents while dragging are off. FrameForge keeps your choice.', details: r.ok ? r.details || [] : [r.message], at: Date.now(), preset: settings.get().preset, undoable: false, reboot: false });
  send('changes', changeList());
  return { ...r, want: settings.get().animations, ...(await animations.get()) };
});

ipcMain.handle('fix:list', async () => {
  if (Date.now() - extra.at > 30000) await detectExtra();
  const s = settings.get();
  return { items: fixList(), repairs: Object.entries(fixes.REPAIRS).map(([id, r]) => ({ id, name: r.name, desc: r.desc, reboot: !!r.reboot })), busy: fixBusy || fixAllRunning, autoFix: s.autoFix, autoRestart: s.autoRestart, restart: restartInfo };
});
ipcMain.handle('fix:action', (_e, action) => runFixAction(action));
ipcMain.handle('fix:one', (_e, id) => fixOne(String(id)));
ipcMain.handle('fix:all', () => fixEverything());
ipcMain.handle('fix:background', () => backgroundFix('manual'));

// ---------- AI chat ----------

/** Everything the AI should know about this PC right now. */
function aiContext() {
  const s = settings.get();
  const prof = rig ? presets.compose(s.preset, s.smartProfile ? rig : null) : null;
  const vg = rig && optimizer.VENDOR_GUIDES[rig.gpu.vendor];
  return {
    now: new Date().toString(),
    app: { name: 'FrameForge', version: app.getVersion(), runningAsAdmin: admin, demoMode: DEMO },
    autoMode: { on: s.autoMode, runningNow: busy, progress: runState, lastRunSteps: lastRunLog.slice(-30) },
    preset: { current: s.preset, name: presets.PRESETS[s.preset].name, all: presets.list() },
    pc: rig,
    liveSensors: lastStats && {
      fps: lastStats.fps,
      cpuTempC: lastStats.cpuTemp,
      gpuTempC: lastStats.gpuTemp,
      cpuLoadPct: lastStats.cpuLoad,
      gpuLoadPct: lastStats.gpuLoad,
      sources: lastStats.sources,
      fpsCounterOn: lastStats.fpsEnabled,
    },
    whatFrameForgeChanged: changeList().entries.map((e) => ({ name: e.name, when: new Date(e.at).toString(), preset: e.preset, stillActive: e.undoable, needsRestart: e.reboot, summary: e.summary, exactChanges: e.details })),
    pcRestartedSinceLastRun: changeList().restartedNotice,
    boostsInCurrentPreset: prof && Object.entries(prof.tweaks).map(([id, on]) => ({ boost: (optimizer.TWEAKS.find((t) => t.id === id) || {}).name || id, on, why: prof.reasons[id] })),
    thingsToFixFoundOnThisPC: rig ? profile.insights(rig) : [],
    fixModeProblems: fixList().map((i) => ({ id: i.id, title: i.title, body: i.body, details: i.details, fixableByFrameForge: !!i.auto, fixActions: i.actions.map((a) => a.id), manualSteps: i.auto ? undefined : i.manual })),
    tweaksTab: tweaksTab.tabTweaks().map((t) => ({ id: t.id, category: t.cat, name: t.name, whatItDoes: t.desc, appliedByFrameForge: !!backup.get(t.id), needsRestart: !!t.reboot })),
    repairTools: Object.entries(fixes.REPAIRS).map(([id, r]) => ({ id, name: r.name, what: r.desc })),
    driverChecklistForPreset: vg ? vg[s.preset] : [],
    overclocking: { enabled: s.overclock, plan: rig ? profile.overclockPlan(rig, s.preset) : [] },
    tools: tools.status(),
    chrisTitusPreset: s.cttPreset,
    updates: updates && updates.state,
  };
}

let aiAbort = null;
const approvals = new Map();
function aiEvent(ev) {
  send('ai:event', ev);
}

/** Whatever the AI does, the app's lists (Fix mode, changes) are refreshed right after. */
async function aiTool(name, input) {
  try {
    return await aiToolRun(name, input);
  } finally {
    send('fix:changed', true);
    send('changes', changeList());
  }
}
async function aiToolRun(name, input) {
  switch (name) {
    case 'set_preset': {
      if (!presets.PRESETS[input.preset]) throw new Error('Unknown preset');
      settings.set({ preset: input.preset, tweaksCustomized: false });
      applyProfileIfAuto();
      send('preset:changed', settings.get());
      if (settings.get().autoMode && !busy) {
        await runAuto(true);
        return { preset: input.preset, retuned: true, steps: lastRunLog };
      }
      return { preset: input.preset, retuned: false, note: 'Auto Mode is off; the preset applies next time it is turned on.' };
    }
    case 'start_auto_mode':
      if (busy) return { note: 'Auto Mode is already running.' };
      await runAuto(true);
      return { autoModeOn: settings.get().autoMode, steps: lastRunLog };
    case 'undo_all_changes':
      if (busy) return { note: 'Auto Mode is busy; stop it first.' };
      await runAuto(false);
      return { undone: true, steps: lastRunLog, stillActive: optimizer.activeCount() };
    case 'stop_auto_mode':
      return { stopping: stopAuto() };
    case 'open_driver_app':
      if (!rig || !rig.vendorApp) return { opened: false };
      if (rig.vendorApp.path) shell.openPath(rig.vendorApp.path);
      else if (!DEMO) shell.openExternal(rig.vendorApp.download);
      return { opened: rig.vendorApp.name };
    case 'fix_problem': {
      await detectExtra();
      const it = fixList().find((i) => i.id === input.problem_id);
      if (!it) return { fixed: true, note: 'That problem is no longer in the list — it is fixed.' };
      // A specific button was asked for: run that one. Otherwise try the problem's fixes in order and check each.
      const a = input.action && it.actions.find((x) => x.id === input.action);
      if (a) {
        const result = await runFixAction(a.id);
        await detectExtra();
        send('fix:changed', true);
        return { action: a.label, result, fixed: !fixList().some((x) => x.id === it.id) };
      }
      const r = await fixOne(it.id);
      return { ...r, manualSteps: r.fixed ? undefined : r.steps };
    }
    case 'fix_everything': {
      const r = await fixEverything();
      return r && r.busy ? { note: r.message || 'FrameForge is already fixing.' } : { ...r, stillOpen: fixList().filter((i) => i.id !== 'restart').map((i) => ({ id: i.id, title: i.title })) };
    }
    case 'run_repair':
      return runRepair(input.repair);
    case 'set_tweak': {
      const r = await setTweak(input.id, input.on, { byUser: true });
      send('tweaks:changed', true);
      return r;
    }
    case 'open_chris_titus':
      await tools.openWinutil();
      return { opened: true };
    case 'rescan_pc':
      rig = await hardware.scan(settings.get().manualHardware);
      send('rig', rig);
      return rig;
  }
  throw new Error('Unknown tool');
}

/** Turn saved Claude-format messages into simple bubbles for the chat view. */
function chatView() {
  const out = [];
  for (const m of ai.loadChat().messages) {
    if (m.deleted) continue;
    if (ai.userText(m)) {
      out.push({ id: m.id, role: 'user', text: ai.messageText(m) });
      continue;
    }
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    for (const b of blocks) {
      if (b.type === 'text' && b.text.trim()) {
        const last = out[out.length - 1];
        if (m.role === 'assistant' && last && last.role === 'assistant') last.text += '\n\n' + b.text;
        else out.push({ role: m.role, text: b.text });
      } else if (b.type === 'tool_use') {
        const def = ai.TOOLS.find((t) => t.name === b.name);
        out.push({ role: 'action', text: def && def.approve ? def.approve(b.input || {}) : (b.name || '').replace(/_/g, ' ') });
      }
    }
  }
  return out;
}

ipcMain.handle('ai:status', () => {
  const s = settings.get();
  return { provider: s.aiProvider, hasKey: !!ai.getKey(), model: s.aiModel, models: ai.MODELS, ollamaModel: s.ollamaModel, localModels: localAi.LOCAL_MODELS, busy: !!aiAbort };
});
ipcMain.handle('ai:setKey', (_e, key) => ai.setKey(key));
// Free local AI: is Ollama + the chosen model there? If not, the chat shows an Install button (top right).
ipcMain.handle('ai:local', (_e, opts) => localAi.status(opts || {}));
ipcMain.handle('ai:install', async (_e, model) => {
  if (localAi.removing()) return { ok: false, busy: true, message: 'Wait for the model uninstall to finish.' };
  const m = String(model || settings.get().ollamaModel || 'llama3.1').trim();
  if (!/^[a-z0-9][a-z0-9._\-/:]{0,80}$/i.test(m)) return { ok: false, message: 'That doesn’t look like an Ollama model name.' };
  settings.set({ aiProvider: 'ollama', ollamaModel: m });
  const r = await localAi.install(m, (p) => send('ai:installProgress', { model: m, ...p }));
  send('ai:installProgress', { model: m, stage: r.ok ? 'done' : 'error', pct: r.ok ? 1 : null, text: r.message, final: true });
  return r;
});
ipcMain.handle('ai:installCancel', () => localAi.cancel());
ipcMain.handle('ai:uninstall', (_e, model) => {
  if (aiAbort) return { ok: false, busy: true, message: 'Wait for the reply to finish or press Stop before uninstalling the model.' };
  return localAi.uninstall(model);
});
ipcMain.handle('ai:history', () => chatView());
ipcMain.handle('ai:edit', (_e, id, text) => aiAbort ? { ok: false, message: 'Wait for the reply to finish or press Stop before editing messages.' } : ai.changeMessage(id, text));
ipcMain.handle('ai:delete', (_e, id) => aiAbort ? { ok: false, message: 'Wait for the reply to finish or press Stop before deleting messages.' } : ai.changeMessage(id, null, true));
ipcMain.handle('ai:clear', () => {
  ai.saveChat({ messages: [] });
  return [];
});
ipcMain.handle('ai:stop', () => {
  if (aiAbort) aiAbort.abort();
  for (const [, r] of approvals) r(false);
  approvals.clear();
  return true;
});
ipcMain.handle('ai:approve', (_e, id, ok) => {
  const r = approvals.get(id);
  if (r) {
    approvals.delete(id);
    r(!!ok);
  }
  return true;
});
ipcMain.handle('ai:send', async (_e, text) => {
  if (aiAbort || localAi.removing()) return { busy: true };
  const msg = String(text || '').trim();
  if (!msg) return { empty: true };
  const chat = ai.loadChat();
  const messageId = require('crypto').randomUUID();
  chat.messages.push({ id: messageId, role: 'user', content: [{ type: 'text', text: msg }] });
  ai.saveChat(chat);
  aiAbort = new AbortController();
  aiEvent({ type: 'start', messageId });
  const s = settings.get();
  const args = {
    history: ai.modelHistory(chat.messages),
    ctx: aiContext,
    signal: aiAbort.signal,
    onText: (t) => aiEvent({ type: 'text', text: t }),
    onTool: (t) => aiEvent({ type: 'tool', ...t }),
    askApproval: ({ id, label }) =>
      new Promise((resolve) => {
        approvals.set(id, resolve);
        aiEvent({ type: 'approval', id, label });
      }),
    runTool: aiTool,
  };
  try {
    const added = s.aiProvider === 'ollama' ? await ai.runOllama(args) : await ai.runClaude(args);
    const c2 = ai.loadChat();
    c2.messages.push(...added);
    ai.saveChat(c2);
    aiEvent({ type: 'done' });
  } catch (e) {
    const aborted = aiAbort && aiAbort.signal.aborted;
    // Keep the sent message so the user can edit or delete it after a failed or stopped reply.
    aiEvent(aborted ? { type: 'stopped' } : { type: 'error', message: String(e.message || e) });
  } finally {
    aiAbort = null;
    approvals.clear();
  }
  return { ok: true };
});

// ---------- IPC ----------

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  admin,
  demo: DEMO,
  platform: process.platform,
  active: optimizer.activeCount(),
}));
ipcMain.handle('rig:get', () => rig);
ipcMain.handle('rig:scan', async () => {
  rig = await hardware.scan(settings.get().manualHardware);
  applyProfileIfAuto();
  sensors.start(rig.gpu.vendor);
  return rig;
});
ipcMain.handle('rig:setManual', async (_e, manual) => {
  settings.set({ manualHardware: manual });
  rig = await hardware.scan(manual);
  applyProfileIfAuto();
  return rig;
});
ipcMain.handle('profile:get', () => {
  if (!rig) return null;
  const s = settings.get();
  const rec = presets.compose(s.preset, s.smartProfile ? rig : null);
  const vg = optimizer.VENDOR_GUIDES[rig.gpu.vendor];
  return {
    reasons: rec.reasons,
    recommended: rec.tweaks,
    preset: rec.preset.id,
    insights: profile.insights(rig),
    overclock: profile.overclockPlan(rig, s.preset),
    guide: vg ? vg[s.preset] || vg.performance : [],
  };
});
ipcMain.handle('presets:list', () => presets.list());
ipcMain.handle('preset:set', async (_e, id) => {
  if (!presets.PRESETS[id]) return settings.get();
  settings.set({ preset: id, tweaksCustomized: false });
  applyProfileIfAuto();
  // If Auto Mode is on, switch the PC over to the new preset right away.
  if (settings.get().autoMode && !busy) setTimeout(() => runAuto(true), 50);
  return settings.get();
});
ipcMain.handle('changes:get', () => changeList());
ipcMain.handle('changes:clearHistory', () => {
  changes.clearHistory();
  return changeList();
});
ipcMain.handle('notice:dismiss', () => {
  settings.set({ restartedNotice: false });
  return changeList();
});
ipcMain.handle('auto:offKeep', () => {
  if (busy) return false;
  settings.set({ autoMode: false });
  rebuildTrayMenu();
  send('auto:done', { on: false, needsReboot: false, active: optimizer.activeCount(), kept: true });
  return true;
});
ipcMain.handle('profile:reset', () => {
  settings.set({ tweaksCustomized: false });
  applyProfileIfAuto();
  return settings.get();
});
ipcMain.handle('tweaks:list', () => optimizer.list());
ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', async (_e, patch) => {
  if (patch.tweaks) patch.tweaksCustomized = true;
  if ('scanSchedule' in patch) patch.autoScan = true; // the old on/off switch is replaced by the schedule menu
  const before = settings.get();
  const s = settings.set(patch);
  if ('autoCheckUpdates' in patch && updates) updates.settingsChanged();
  if ('fpsLimit' in patch) settings.set({ fpsLimit: fplimit.clamp(patch.fpsLimit) });
  let limiterError = null;
  if ('fpsLimitOn' in patch || 'fpsLimit' in patch) {
    limiterFails = 0;
    const r = await applyLimiter();
    if (!r.ok) {
      limiterError = r.message || 'The FPS limit could not be applied.';
      if (patch.fpsLimitOn) settings.set({ fpsLimitOn: false }); // the switch must not claim a cap that is not there
    }
  }
  if ('startWithWindows' in patch && IS_WIN && !DEMO) {
    const r = patch.startWithWindows ? await setStartWithWindows(true) : await setStartWithWindows(false);
    if (!r.ok) {
      // Windows refused (e.g. no admin rights): the switch must not claim it's on.
      settings.set({ startWithWindows: !patch.startWithWindows });
      return { ...settings.get(), _error: r.message };
    }
  }
  let hotkeyFailed = false;
  if ('overlayHotkey' in patch && patch.overlayHotkey !== before.overlayHotkey) hotkeyFailed = !registerHotkey();
  if ('fpsCounter' in patch || 'tempMonitor' in patch || 'overlayPosition' in patch) applyMonitoring();
  if (limiterError) return { ...settings.get(), _error: limiterError };
  return hotkeyFailed ? { ...settings.get(), _error: `“${s.overlayHotkey}” couldn’t be registered — another program is probably using it. Pick a different shortcut.` } : settings.get();
});
ipcMain.handle('auto:set', (_e, on) => runAuto(!!on));
ipcMain.handle('auto:stop', () => stopAuto());
ipcMain.handle('auto:state', () => ({ busy, progress: runState }));
ipcMain.handle('tools:status', () => tools.status());
ipcMain.handle('ctt:open', async () => {
  try {
    await tools.openWinutil();
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});
ipcMain.handle('tools:install', async (_e, id) => {
  try {
    const r = await tools.install(id, (p) => send('tools:progress', { id, p }));
    applyMonitoring();
    return r;
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  }
});
ipcMain.handle('vendor:open', () => {
  if (!rig || !rig.vendorApp) return false;
  const va = rig.vendorApp;
  if (va.path) shell.openPath(va.path);
  else if (!DEMO) shell.openExternal(va.download);
  return true;
});
ipcMain.handle('link:open', (_e, url) => {
  if (/^https:\/\//.test(url)) shell.openExternal(url);
});
ipcMain.handle('pc:restart', () => restartCountdown({ seconds: 10, reason: 'Restarting to finish applying boosts' }));
ipcMain.handle('overlay:toggle', () => {
  toggleOverlay();
  return overlayShown;
});
ipcMain.handle('update:check', () => updates && updates.check());
ipcMain.handle('update:download', () => updates && updates.download());
ipcMain.handle('update:install', () => updateNow());
ipcMain.handle('update:state', () => (updates ? updates.state : null));

/** The one link friends need: GitHub's "latest release" page always shows the newest installer. */
function shareLink() {
  const src = settings.get().updateSource || 'toer15/frameforge';
  const p = updater.parseSource(src);
  if (p && p.provider === 'github') return `https://github.com/${p.owner}/${p.repo}/releases/latest`;
  return 'https://github.com/toer15/frameforge/releases/latest';
}
ipcMain.handle('share:copy', () => {
  const link = shareLink();
  clipboard.writeText(link);
  return link;
});
ipcMain.handle('share:open', () => shell.openExternal(shareLink()));
ipcMain.handle('update:setSource', (_e, src) => {
  settings.set({ updateSource: String(src || '').trim() });
  const st = updates ? updates.configure(src) : null;
  if (st && st.source && updates) updates.check();
  return st;
});
ipcMain.on('window:min', () => mainWin && mainWin.minimize());
ipcMain.on('window:max', () => mainWin && (mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize()));
ipcMain.on('window:close', () => mainWin && mainWin.close());

app.on('before-quit', () => {
  quitting = true;
  globalShortcut.unregisterAll();
  sensors.stop();
  fps.stop(tools.presentMonPath());
});
app.on('window-all-closed', () => {
  if (!settings.get().minimizeToTray) app.quit();
});
