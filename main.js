// FrameForge — main process
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, screen, nativeImage, dialog, clipboard, Notification } = require('electron');
const path = require('path');

const { run, ps, isAdmin, IS_WIN, DEMO } = require('./src/util');
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
const ai = require('./src/ai');

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

  createMainWindow(process.argv.includes('--hidden'));
  createTray();
  updates = updater.setup({ send, getSettings: settings.get, onEvent: onUpdateEvent });

  reclassifyOldCttProblem();
  rig = await hardware.scan(settings.get().manualHardware).catch(() => null);
  applyProfileIfAuto();
  send('rig', rig);

  applyMonitoring();
  registerHotkey();
  setInterval(telemetryTick, 1000);

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

function createMainWindow(hidden) {
  mainWin = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    frame: false,
    show: !hidden,
    backgroundColor: '#0a0f1c',
    icon: ICON,
    title: 'FrameForge',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
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
  if (!mainWin) return;
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
    updates.install();
  } else {
    showMain();
    updates.download();
  }
}
function onUpdateEvent(st) {
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

function registerHotkey() {
  globalShortcut.unregisterAll();
  const key = settings.get().overlayHotkey;
  try {
    if (key) globalShortcut.register(key.replace(/Ctrl/i, 'CommandOrControl'), toggleOverlay);
  } catch {
    /* invalid accelerator — ignore */
  }
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
  send('stats', stats);
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.webContents.send('stats', stats);
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
    else if (!r.locked) problems.put(t.id, { id: t.id, name: t.name, status: r.status, message: r.message, details: r.details, fix: r.fix, adminSkipped: r.adminSkipped, at: Date.now() });
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
  const entries = Object.entries(changes.all())
    .map(([id, e]) => ({ id, ...e }))
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

async function setTweak(id, on) {
  const t = tweaksTab.tabTweaks().find((x) => x.id === id);
  if (!t) return { ok: false, message: 'Unknown tweak.' };
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
      await t.forceOff(); // Windows had it on before FrameForge: set the Windows default
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
  }
}

ipcMain.handle('tweaks:catalog', () => tweakCatalog());
ipcMain.handle('tweaks:set', (_e, id, on) => setTweak(id, !!on));

// ---------- Fix mode ----------

const A = (id, label) => ({ id, label });
/** Everything on this PC that needs fixing, with the actions that can fix each one. */
function fixList() {
  const s = settings.get();
  const items = [];
  if (IS_WIN && !DEMO && !admin) {
    items.push({ id: 'not_admin', level: 'big', title: 'FrameForge isn’t running as administrator', body: 'Most boosts and all repairs need admin rights, so they were skipped.', actions: [A('admin', 'Restart as administrator')], auto: false });
  }
  for (const p of Object.values(problems.all())) {
    const t = optimizer.TWEAKS.find((x) => x.id === p.id);
    if (!t) continue;
    const actions = [];
    if (p.adminSkipped) actions.push(A('admin', 'Restart as administrator'));
    else {
      if (p.id === 'restore_point') actions.push(A('repair:restore_points', 'Turn on System Protection'));
      actions.push(A(`retry:${p.id}`, 'Try again'));
      if (p.fix === 'ctt') {
        actions.push(A('open_ctt', 'Open Chris Titus tool'));
        const log = (p.details || []).find((d) => d.startsWith('Full winutil log: '));
        if (log) actions.push(A(`openfile:${log.slice(18)}`, 'Open winutil log'));
      }
      if (p.id === 'power_plan') actions.push(A('open:ms-settings:powersleep', 'Open Power mode settings'));
    }
    items.push({ id: `step_${p.id}`, level: p.status === 'error' ? 'big' : 'medium', title: `${t.name} didn’t finish`, body: p.message, details: p.details, actions, auto: !p.adminSkipped, at: p.at });
  }
  const tl = tools.status();
  if (s.fpsCounter && !tl.presentmon) items.push({ id: 'tool_presentmon', level: 'medium', title: 'The FPS counter needs PresentMon', body: 'A free tool from Intel that reads real in-game FPS.', actions: [A('install:presentmon', 'Download it')], auto: true });
  if (s.tempMonitor && !tl.lhm && (!lastStats || lastStats.cpuTemp == null)) items.push({ id: 'tool_lhm', level: 'medium', title: 'CPU temperature can’t be read yet', body: 'Windows doesn’t share the real CPU sensor. LibreHardwareMonitor (free, open source) does.', actions: [A('install:lhm', 'Download it')], auto: true });
  if (rig && rig.vendorApp && !rig.vendorApp.installed) items.push({ id: 'vendor_app', level: 'medium', title: `${rig.vendorApp.name} isn’t installed`, body: 'The driver checklist and the vendor’s auto-overclock/undervolt live in it.', actions: [A('vendor', 'Get it')], auto: false });
  if (lastStats && lastStats.cpuTemp >= 90) items.push({ id: 'hot_cpu', level: 'big', title: `CPU is hot (${lastStats.cpuTemp} °C)`, body: 'Above 90 °C the CPU slows itself down. Usually dust, a weak cooler profile or dried thermal paste.', actions: [], auto: false });
  if (lastStats && lastStats.gpuTemp >= 87) items.push({ id: 'hot_gpu', level: 'big', title: `Graphics card is hot (${lastStats.gpuTemp} °C)`, body: 'It may be lowering its clocks. An undervolt through the vendor auto-tuner or a stronger fan curve usually fixes it.', actions: [], auto: false });
  if (rig) {
    profile.insights(rig).forEach((ins, i) => {
      if (ins.level === 'info') return;
      const actions = /Hz/.test(ins.title) ? [A('open:ms-settings:display-advanced', 'Open display settings')] : [];
      items.push({ id: `insight_${i}`, level: ins.level, title: ins.title, body: ins.body, actions, auto: false, bios: /BIOS|stick/i.test(ins.body) });
    });
  }
  if (app.isPackaged && updates && updates.state.status === 'unconfigured') items.push({ id: 'updates', level: 'info', title: 'In-app updates aren’t set up', body: 'Set where updates come from so new versions arrive inside the app.', actions: [A('goto:settings', 'Open Settings')], auto: false });
  return items;
}

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

async function runFixAction(action) {
  const [kind, ...rest] = action.split(':');
  const arg = rest.join(':');
  switch (kind) {
    case 'retry': {
      if (busy) return { ok: false, message: 'Auto Mode is running — wait for it to finish.' };
      const t = optimizer.TWEAKS.find((x) => x.id === arg);
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
  }
  return { ok: false, message: 'Unknown fix' };
}

/** Fix everything that can be fixed without the user: retry failed steps, download missing tools. */
async function fixEverything() {
  const results = [];
  for (const it of fixList().filter((i) => i.auto)) {
    const a = it.actions.find((x) => /^(retry|install|repair):/.test(x.id));
    if (!a) continue;
    send('fix:repair', { name: it.id, status: 'running', title: it.title });
    const r = await runFixAction(a.id);
    send('fix:repair', { name: it.id, status: r && r.ok ? 'done' : 'warn', title: it.title, message: r && r.message });
    results.push({ problem: it.title, fixed: !!(r && r.ok), message: r && r.message });
  }
  send('fix:changed', true);
  return results;
}

ipcMain.handle('fix:list', () => ({ items: fixList(), repairs: Object.entries(fixes.REPAIRS).map(([id, r]) => ({ id, name: r.name, desc: r.desc, reboot: !!r.reboot })), busy: fixBusy }));
ipcMain.handle('fix:action', (_e, action) => runFixAction(action));
ipcMain.handle('fix:all', () => fixEverything());

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
    fixModeProblems: fixList().map((i) => ({ id: i.id, title: i.title, body: i.body, details: i.details, fixActions: i.actions.map((a) => a.id) })),
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

async function aiTool(name, input) {
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
      const it = fixList().find((i) => i.id === input.problem_id);
      if (!it) return { note: 'That problem is no longer in the list — it may already be fixed.' };
      const a = it.actions.find((x) => x.id === input.action) || it.actions[0];
      if (!a) return { note: 'This one can’t be fixed from Windows; explain the manual steps to the user.' };
      return { action: a.label, result: await runFixAction(a.id) };
    }
    case 'run_repair':
      return runRepair(input.repair);
    case 'set_tweak': {
      const r = await setTweak(input.id, input.on);
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
  return { provider: s.aiProvider, hasKey: !!ai.getKey(), model: s.aiModel, models: ai.MODELS, ollamaModel: s.ollamaModel, busy: !!aiAbort };
});
ipcMain.handle('ai:setKey', (_e, key) => ai.setKey(key));
ipcMain.handle('ai:history', () => chatView());
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
  if (aiAbort) return { busy: true };
  const msg = String(text || '').trim();
  if (!msg) return { empty: true };
  const chat = ai.loadChat();
  chat.messages.push({ role: 'user', content: [{ type: 'text', text: msg }] });
  ai.saveChat(chat);
  aiAbort = new AbortController();
  aiEvent({ type: 'start' });
  const s = settings.get();
  const args = {
    history: chat.messages,
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
    // Drop the unanswered question so the conversation stays valid.
    const c2 = ai.loadChat();
    if (c2.messages.length && c2.messages[c2.messages.length - 1].role === 'user') c2.messages.pop();
    ai.saveChat(c2);
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
  const before = settings.get();
  const s = settings.set(patch);
  if ('startWithWindows' in patch && IS_WIN && !DEMO) {
    if (patch.startWithWindows) {
      await run('schtasks', ['/Create', '/TN', 'FrameForge', '/TR', `"${process.execPath}" --hidden`, '/SC', 'ONLOGON', '/RL', 'HIGHEST', '/F']);
    } else {
      await run('schtasks', ['/Delete', '/TN', 'FrameForge', '/F']);
    }
  }
  if ('overlayHotkey' in patch && patch.overlayHotkey !== before.overlayHotkey) registerHotkey();
  if ('fpsCounter' in patch || 'tempMonitor' in patch || 'overlayPosition' in patch) applyMonitoring();
  return s;
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
ipcMain.handle('pc:restart', async () => {
  const r = await dialog.showMessageBox(mainWin, {
    type: 'question',
    buttons: ['Restart now', 'Later'],
    defaultId: 1,
    title: 'Restart PC',
    message: 'Restart your PC now to finish applying boosts?',
    detail: 'Save anything you have open first.',
  });
  if (r.response === 0 && IS_WIN && !DEMO) run('shutdown', ['/r', '/t', '5', '/c', 'FrameForge is restarting your PC to finish applying boosts.']);
  return r.response === 0;
});
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
