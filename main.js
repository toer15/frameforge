// FrameForge — main process
const { app, BrowserWindow, ipcMain, shell, Tray, Menu, globalShortcut, screen, nativeImage, dialog, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

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
  detectExtra().then(() => send('fix:changed', true)).catch(() => {});
  setInterval(() => detectExtra().then(() => send('fix:changed', true)).catch(() => {}), 2 * 60 * 1000);
  if (settings.get().resumeFixAll && (admin || DEMO)) {
    settings.set({ resumeFixAll: false });
    setTimeout(() => {
      send('goto', 'fix');
      fixEverything();
    }, 3000);
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

/** Checks that take a moment (display, disk, tweaks Windows undid, pending restart). Cached. */
let extra = { display: null, disk: null, reverted: [], rebootPending: false, at: 0 };
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
        if (!backup.get(t.id) || locked[t.id] || t.id === 'max_refresh') continue;
        if (!(await tweaksTab.stateOf(t))) out.reverted.push(t.id);
      }
      const rr = await run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired']);
      out.rebootPending = rr.code === 0;
    }
    try {
      const b = await si.battery();
      out.onBattery = !!(b && b.hasBattery && b.acConnected === false);
    } catch {}
    // Auto Mode is on, but some of the preset's settings aren't active (e.g. new tweaks from an update,
    // or ones that failed). Settings the user switched off by hand in the Tweaks tab are left alone.
    const st = settings.get();
    if (st.autoMode && rig) {
      const userOff = st.userOff || {};
      const tab = new Set(tweaksTab.tabTweaks().map((t) => t.id));
      for (const t of optimizer.planned({ quiet: true, rig })) {
        if (!tab.has(t.id) || locked[t.id] || userOff[t.id] || out.reverted.includes(t.id) || t.id === 'max_refresh') continue;
        if (problems.all()[t.id]) continue; // already listed as a failed step
        if (!(await tweaksTab.stateOf(t))) out.presetOff.push(t.id);
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
      vendor_app: 'Driver app installed',
      hot_cpu: 'CPU temperature is back to normal',
      hot_gpu: 'Graphics card temperature is back to normal',
      not_admin: 'FrameForge runs as administrator',
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
      it.strategies.push(A(`retry:${p.id}`, 'Run the Chris Titus preset again'), A('redownload_ctt', 'Download a fresh copy of the Chris Titus tool and run it again'));
      it.manual = ['FrameForge opened the Chris Titus tool for you.', 'Go to the Tweaks tab in it, tick the tweaks you want and click “Run Tweaks”.', 'If one tweak keeps failing, leave it unticked — the rest still work.'];
      it.manualAction = 'open_ctt';
    } else if (p.id === 'power_plan') {
      it.actions.push(A('retry:power_plan', 'Try again'), A('open:ms-settings:powersleep', 'Open Power mode settings'));
      it.strategies.push(A('retry:power_plan', 'Set the Ultimate Performance plan again'));
      it.manual = ['FrameForge opened Windows power settings.', 'Set “Power mode” to “Best performance”.'];
      it.manualAction = 'open:ms-settings:powersleep';
    } else {
      it.actions.push(A(`retry:${p.id}`, 'Try again'));
      it.strategies.push(A(`retry:${p.id}`, `Apply “${t.name}” again`), A(`retry:${p.id}`, 'Try once more'));
    }
    add(it);
  }
  if (extra.reverted.length) {
    const names = extra.reverted.map((id) => (tweakById(id) || {}).name).filter(Boolean);
    add({ id: 'reverted', level: 'medium', title: `Windows switched off ${names.length} of your tweak${names.length === 1 ? '' : 's'}`, body: `Windows updates sometimes reset settings: ${names.join(', ')}.`, actions: [A('reapply', 'Turn them back on')], strategies: [A('reapply', 'Turn them back on')] });
  }
  if (extra.presetOff.length) {
    const names = extra.presetOff.map((id) => (tweakById(id) || {}).name).filter(Boolean);
    const pn = presets.PRESETS[s.preset].name;
    add({ id: 'preset_off', level: 'medium', title: `${names.length} setting${names.length === 1 ? '' : 's'} from your ${pn} preset ${names.length === 1 ? 'isn’t' : 'aren’t'} on yet`, body: `${names.join(', ')}.`, actions: [A('preset_apply', 'Turn them on')], strategies: [A('preset_apply', `Turn on the missing ${pn} settings`)] });
  }
  if (extra.display && extra.display.cur < extra.display.max) {
    const d = extra.display;
    add({ id: 'display', level: 'big', title: `Your display runs at ${d.cur} Hz, but it can do ${d.max} Hz`, body: `Windows is only using ${Math.round((d.cur / d.max) * 100)}% of what your monitor can show at ${d.res}.`, actions: [A('tweak:max_refresh', `Switch to ${d.max} Hz`)], strategies: [A('tweak:max_refresh', `Switch the display to ${d.max} Hz`)], manual: guides.displayCable(d) });
  }
  if (extra.disk && (extra.disk.usePct >= 92 || extra.disk.freeGB < 15)) {
    add({ id: 'disk', level: 'medium', title: `Drive C: is almost full (${extra.disk.freeGB} GB free)`, body: 'A nearly full system drive makes Windows and game updates slow, and can cause stutter.', actions: [A('free_space', 'Free up space')], strategies: [A('free_space', 'Clear temp files and old Windows update leftovers')], manual: guides.diskFull(extra.disk) });
  }
  const tl = tools.status();
  if (s.fpsCounter && !tl.presentmon) add({ id: 'tool_presentmon', level: 'medium', title: 'The FPS counter needs PresentMon', body: 'A free tool from Intel that reads real in-game FPS.', actions: [A('install:presentmon', 'Download it')], strategies: [A('install:presentmon', 'Download PresentMon from Intel’s GitHub'), A('install:presentmon', 'Try the download again')] });
  if (s.tempMonitor && !tl.lhm && (!lastStats || lastStats.cpuTemp == null)) add({ id: 'tool_lhm', level: 'medium', title: 'CPU temperature can’t be read yet', body: 'Windows doesn’t share the real CPU sensor. LibreHardwareMonitor (free, open source) does.', actions: [A('install:lhm', 'Download it')], strategies: [A('install:lhm', 'Download LibreHardwareMonitor from its GitHub'), A('install:lhm', 'Try the download again')] });
  if (rig && rig.vendorApp && !rig.vendorApp.installed) {
    const amd = rig.gpu.vendor === 'amd';
    add({ id: 'vendor_app', level: 'medium', title: `${rig.vendorApp.name} isn’t installed`, body: 'The driver checklist and the vendor’s own auto-overclock and undervolt live in it.', actions: [A(amd ? 'vendor' : 'vendor_install', 'Get it')], strategies: amd ? [] : [A('vendor_install', `Install ${rig.vendorApp.name} from Microsoft’s verified app store`)], manual: amd ? guides.amdDriverApp() : null, manualAction: amd ? 'vendor' : null });
  }
  if (lastStats && lastStats.cpuTemp >= 90) {
    const heat = ['cpu_min', 'cpu_boost', 'core_parking'].filter((id) => backup.get(id));
    add({ id: 'hot_cpu', level: 'big', title: `CPU is hot (${lastStats.cpuTemp} °C)`, body: heat.length ? 'FrameForge’s CPU speed tweaks add some heat. Usually it’s dust, a weak fan setting or old thermal paste.' : 'Above 90 °C the CPU slows itself down. Usually dust, a weak fan setting or old thermal paste.', strategies: heat.length ? [A('cool_cpu', 'Switch off FrameForge’s heat-adding CPU tweaks')] : [], manual: guides.hotCpu(rig, lastStats.cpuTemp) });
  }
  if (lastStats && lastStats.gpuTemp >= 87) {
    const oc = !!backup.get('gpu_power_limit');
    add({ id: 'hot_gpu', level: 'big', title: `Graphics card is hot (${lastStats.gpuTemp} °C)`, body: oc ? 'FrameForge raised its power limit for overclocking — that’s the likely cause.' : 'It may be lowering its clocks to protect itself.', strategies: oc ? [A('revert_oc', 'Put the graphics card power limit back to normal')] : [], manual: guides.hotGpu(rig, lastStats.gpuTemp) });
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
      add({ id: `insight_${ins.id}`, level: ins.level, title: ins.title, body: ins.body, manual, bios: ins.id === 'ram_speed' });
    }
  }
  const pending = restartNeededFor();
  if (extra.rebootPending || pending.length) add({ id: 'restart', level: 'info', title: 'A restart is needed', body: pending.length ? `To finish: ${pending.join(', ')}.` : 'Windows has updates waiting for a restart.', actions: [A('restart', 'Restart now')], manual: guides.restartPending(), manualAction: null });
  if (app.isPackaged && updates && updates.state.status === 'unconfigured') add({ id: 'updates', level: 'info', title: 'In-app updates aren’t set up', body: 'FrameForge can’t find where new versions come from.', actions: [A('set_update_source', 'Fix it')], strategies: [A('set_update_source', 'Use the official FrameForge update source')] });
  // A problem is fixable automatically when it has strategies.
  for (const it of items) {
    it.auto = it.strategies.length > 0;
    it.fixedTitle = fixedTitleFor(it);
  }
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
      const r = await setTweak(arg, true);
      await detectExtra();
      return r;
    }
    case 'reapply': {
      const ids = [...extra.reverted];
      let ok = 0;
      for (const id of ids) if ((await setTweak(id, true)).ok) ok++;
      await detectExtra();
      return { ok: ok === ids.length, message: `Turned ${ok} of ${ids.length} tweak${ids.length === 1 ? '' : 's'} back on.` };
    }
    case 'preset_apply': {
      const ids = [...extra.presetOff];
      let ok = 0;
      for (const id of ids) {
        send('fix:line', { line: `Turning on: ${(tweakById(id) || {}).name || id}` });
        if ((await setTweak(id, true)).ok) ok++;
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
      if (!DEMO) await run('powercfg', ['/overlaysetactive', 'ded574b5-45a0-4f42-8737-46345c09c238']);
      await detectExtra();
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
    case 'restart':
      return { ok: true, restarted: await (async () => {
        const r = await dialog.showMessageBox(mainWin, { type: 'question', buttons: ['Restart now', 'Later'], defaultId: 1, title: 'Restart PC', message: 'Restart your PC now?', detail: 'Save anything you have open first.' });
        if (r.response === 0 && IS_WIN && !DEMO) run('shutdown', ['/r', '/t', '5']);
        return r.response === 0;
      })() };
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

/**
 * "Fix everything automatically": check the PC, then for each problem try its fixes in order, checking after
 * each one whether the problem is gone. What only the user can do gets step-by-step instructions.
 * If admin rights are missing, FrameForge restarts itself as administrator last and carries on by itself.
 */
let fixAllRunning = false;
async function fixEverything() {
  if (fixAllRunning) return { busy: true };
  if (busy) return { busy: true, message: 'Auto Mode is running — wait for it to finish.' };
  fixAllRunning = true;
  const ev = (e) => send('fixall', e);
  const tally = { fixed: 0, you: 0, failed: 0 };
  try {
    ev({ type: 'start' });
    ev({ type: 'phase', text: 'Checking your whole PC…' });
    if (rig) rig = await hardware.scan(settings.get().manualHardware).catch(() => rig);
    await detectExtra();
    const items = fixList();
    ev({ type: 'found', count: items.length });
    const needAdmin = items.find((i) => i.id === 'not_admin');
    for (const it of items) {
      if (it.id === 'not_admin') continue;
      if (!it.strategies.length) {
        if (it.manualAction) await runFixAction(it.manualAction).catch(() => {});
        if (it.manual) {
          tally.you++;
          ev({ type: 'item', id: it.id, title: it.title, outcome: 'you', message: it.body, steps: it.manual, buttons: it.actions });
        }
        continue;
      }
      ev({ type: 'item', id: it.id, title: it.title, outcome: 'working' });
      let fixed = false;
      let last = null;
      for (const [n, st] of it.strategies.entries()) {
        ev({ type: 'try', id: it.id, text: st.label, n: n + 1, of: it.strategies.length });
        last = await runFixAction(st.id).catch((e) => ({ ok: false, message: String(e.message || e) }));
        await detectExtra();
        fixed = !fixList().some((x) => x.id === it.id); // check: is the problem really gone?
        if (fixed) break;
      }
      if (fixed) {
        tally.fixed++;
        ev({ type: 'item', id: it.id, title: it.title, outcome: 'fixed', message: last && last.message });
        send('fix:changed', true); // the problem leaves the list and the count goes down right away
      } else if (it.manual) {
        if (it.manualAction) await runFixAction(it.manualAction).catch(() => {});
        tally.you++;
        ev({ type: 'item', id: it.id, title: it.title, outcome: 'you', message: last && last.message, steps: it.manual, buttons: it.actions.filter((a) => !it.strategies.some((st) => st.id === a.id)) });
      } else {
        tally.failed++;
        ev({ type: 'item', id: it.id, title: it.title, outcome: 'failed', message: (last && last.message) || 'It didn’t work after trying every fix FrameForge knows.' });
      }
    }
    if (needAdmin) {
      ev({ type: 'item', id: 'not_admin', title: needAdmin.title, outcome: 'working', message: 'Restarting FrameForge as administrator — it carries on fixing by itself after the restart.' });
      ev({ type: 'done', ...tally, restarting: true });
      settings.set({ resumeFixAll: true });
      await new Promise((r) => setTimeout(r, 2500));
      await runFixAction('admin');
      return { restarting: true };
    }
    ev({ type: 'done', ...tally });
    return tally;
  } finally {
    fixAllRunning = false;
    send('fix:changed', true);
  }
}

ipcMain.handle('fix:list', async () => {
  if (Date.now() - extra.at > 30000) await detectExtra();
  return { items: fixList(), repairs: Object.entries(fixes.REPAIRS).map(([id, r]) => ({ id, name: r.name, desc: r.desc, reboot: !!r.reboot })), busy: fixBusy || fixAllRunning };
});
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
