// Tiny JSON stores for settings and for the undo backup.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULT_SETTINGS = {
  autoMode: false,
  manualHardware: null, // { cpu, gpuVendor, gpu } when the user picks their parts by hand
  tweaks: {
    restore_point: true,
    power_plan: true,
    game_mode: true,
    game_dvr: true,
    hags: true,
    game_priority: true,
    mouse_precision: true,
    power_throttling: false,
    visual_effects: false,
    temp_cleanup: true,
    game_gpu: true,
    ctt_tweaks: true,
    dx_opt: true,
    no_popups: false,
  },
  preset: 'performance', // competitive | performance | balanced | graphics
  lastBoot: null, // when Windows last started, as of the last Auto Mode run
  restartedNotice: false,
  cttPreset: 'Standard', // Minimal | Standard | Advanced
  cttOpenAfter: true, // open winutil's own window after Auto Mode runs it
  smartProfile: true, // pick tweaks to fit this specific PC
  tweaksCustomized: false, // true once the user changes a tweak toggle by hand
  overclock: false,
  autoDownloadTools: false,
  openVendorApp: true,
  fpsCounter: false,
  tempMonitor: true,
  overlayPosition: 'top-left',
  overlayHotkey: 'Ctrl+Shift+F',
  autoCheckUpdates: true,
  updateSource: '', // 'owner/repo' on GitHub, or an https folder with latest.yml
  backgroundDownloadUpdates: true, // updates arrive ready to install
  startWithWindows: false,
  minimizeToTray: true,
  reapplyOnStartup: true,
  ultimatePlanGuid: null,
  aiProvider: 'claude', // claude | ollama
  aiModel: 'claude-opus-5-5',
  aiKeyEnc: null, // encrypted with Windows DPAPI
  ollamaModel: 'llama3.1',
  ollamaUrl: 'http://127.0.0.1:11434',
  autoFix: true, // Fix mode fixes what it safely can in the background, without a click
  autoRestart: true, // restart the PC by itself (with a countdown) when a fix needs it
  lastAutoRestart: 0, // never restart by itself twice within a few hours (no restart loops)
  cttSkip: [], // Chris Titus tweaks that fail on this PC — left out of the preset
  biosCheck: null, // RAM speed before "Restart into BIOS", to check the change worked
};

function file(name) {
  return path.join(app.getPath('userData'), name);
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, data) {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  const tmp = file(name) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file(name));
}

let settingsCache = null;

const settings = {
  get() {
    if (!settingsCache) {
      const saved = readJson('settings.json', {});
      settingsCache = {
        ...DEFAULT_SETTINGS,
        ...saved,
        tweaks: { ...DEFAULT_SETTINGS.tweaks, ...(saved.tweaks || {}) },
      };
    }
    return settingsCache;
  },
  set(patch) {
    const cur = settings.get();
    settingsCache = {
      ...cur,
      ...patch,
      tweaks: { ...cur.tweaks, ...(patch.tweaks || {}) },
    };
    writeJson('settings.json', settingsCache);
    return settingsCache;
  },
};

const backup = {
  all() {
    return readJson('backup.json', {});
  },
  get(id) {
    return backup.all()[id] || null;
  },
  put(id, data) {
    const all = backup.all();
    all[id] = data;
    writeJson('backup.json', all);
  },
  remove(id) {
    const all = backup.all();
    delete all[id];
    writeJson('backup.json', all);
  },
};

// Everything FrameForge changed, kept on disk so it's still listed after a restart.
const changes = {
  all() {
    return readJson('changes.json', { entries: {} }).entries;
  },
  put(id, entry) {
    const d = readJson('changes.json', { entries: {} });
    d.entries[id] = entry;
    writeJson('changes.json', d);
  },
  remove(id) {
    const d = readJson('changes.json', { entries: {} });
    delete d.entries[id];
    writeJson('changes.json', d);
  },
  /** Drop one-time entries (cleanups, restore points) — the undoable ones stay until undone. */
  clearHistory() {
    const d = readJson('changes.json', { entries: {} });
    for (const [id, e] of Object.entries(d.entries)) if (!e.undoable) delete d.entries[id];
    writeJson('changes.json', d);
  },
};

// Steps that didn't work, kept until they're fixed (shown in Fix mode).
const problems = {
  all() {
    return readJson('problems.json', {});
  },
  put(id, p) {
    const d = problems.all();
    d[id] = p;
    writeJson('problems.json', d);
  },
  remove(id) {
    const d = problems.all();
    if (d[id]) {
      delete d[id];
      writeJson('problems.json', d);
    }
  },
};

module.exports = { settings, backup, changes, problems, DEFAULT_SETTINGS };
