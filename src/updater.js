// In-app updates.
//
// Where updates come from: a public GitHub repo's Releases (or any https folder that holds
// latest.yml + the installer). Set it in Settings › Updates, or bake it into package.json
// (build.publish). When a newer version is published there, FrameForge shows a popup, downloads
// the installer, checks its SHA-512 fingerprint against latest.yml, and installs it.
const { app } = require('electron');
const updateRelaunch = require('./update-relaunch');

let electronUpdater = null;
try {
  electronUpdater = require('electron-updater');
} catch {
  electronUpdater = null;
}

const PLACEHOLDER = 'YOUR_GITHUB_USERNAME';
const TEST = process.env.FRAMEFORGE_UPDATER_TEST === '1';

/** "owner/repo", "https://github.com/owner/repo", or an https folder URL → feed config. */
function parseSource(src) {
  const v = String(src || '').trim().replace(/\/+$/, '');
  if (!v) return null;
  const gh = v.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  if (gh && gh[1] !== PLACEHOLDER) return { provider: 'github', owner: gh[1], repo: gh[2], label: `github.com/${gh[1]}/${gh[2]}` };
  if (/^https?:\/\//.test(v)) return { provider: 'generic', url: v, label: v };
  return null;
}

/** The source baked into package.json at build time, if it was filled in. */
function builtInSource() {
  try {
    const pub = (require('../package.json').build || {}).publish;
    const p = Array.isArray(pub) ? pub[0] : pub;
    if (p && p.provider === 'github' && p.owner && p.owner !== PLACEHOLDER) return `${p.owner}/${p.repo}`;
  } catch {}
  return 'toer15/frameforge';
}

function friendlyError(e, feed) {
  const msg = String((e && e.message) || e || '');
  if (/404|Cannot find latest|No published versions|latest\.yml/i.test(msg)) {
    return `No published release found at ${feed ? feed.label : 'the update source'} yet. Publish one with latest.yml and the installer attached.`;
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|net::ERR|getaddrinfo/i.test(msg)) return 'No internet connection to the update server. FrameForge will try again later.';
  if (/sha512|checksum/i.test(msg)) return 'The downloaded update didn’t match its fingerprint, so it was thrown away. Try again.';
  if (/rate limit|403/i.test(msg)) return 'GitHub is limiting requests right now. FrameForge will try again later.';
  return 'Couldn’t check for updates: ' + msg.split('\n')[0].slice(0, 140);
}

function setup({ send, getSettings, onEvent = () => {}, isActive = () => true }) {
  const state = { status: 'idle', version: null, progress: 0, error: null, source: null, current: app.getVersion() };
  const push = (patch) => {
    Object.assign(state, patch);
    send('update:event', { ...state });
    try {
      onEvent({ ...state });
    } catch {}
  };

  if (!electronUpdater || (!app.isPackaged && !TEST)) {
    return {
      state: Object.assign(state, { status: 'dev', error: 'Updates work in the installed version of FrameForge.' }),
      async check() {
        push({ status: 'dev', error: 'Updates work in the installed version of FrameForge.' });
      },
      async download() {},
      maybeCheck() {},
      settingsChanged() {},
      install() {},
      configure() {
        return state;
      },
    };
  }

  const au = TEST ? new electronUpdater.NsisUpdater() : electronUpdater.autoUpdater;
  if (TEST) {
    au.forceDevUpdateConfig = true;
    // Test machines may not run Windows: read the Windows update files anyway.
    if (process.env.FRAMEFORGE_UPDATER_TEST_PLATFORM) au._testOnlyOptions = { platform: process.env.FRAMEFORGE_UPDATER_TEST_PLATFORM, isUseDifferentialDownload: false };
  }
  au.autoDownload = false;
  // Handle quit ourselves: the library's automatic quit path does not force a relaunch.
  au.autoInstallOnAppQuit = false;
  au.autoRunAppAfterInstall = true;
  au.allowDowngrade = false;
  au.disableDifferentialDownload = false; // download only the parts of the app that changed
  au.logger = null;

  let feed = null;
  function configure(source) {
    feed = parseSource(source != null ? source : getSettings().updateSource || builtInSource());
    if (feed) {
      const { label, ...cfg } = feed;
      au.setFeedURL(cfg);
      push({ status: state.status === 'unconfigured' ? 'idle' : state.status, source: label, error: null });
    } else {
      push({ status: 'unconfigured', source: null, error: 'Set where updates come from in Settings › Updates.' });
    }
    return { ...state };
  }

  au.on('checking-for-update', () => push({ status: 'checking', error: null, progress: 0 }));
  au.on('update-not-available', () => push({ status: 'latest', checkedAt: Date.now() }));
  au.on('update-available', (info) => {
    const n = info.releaseNotes;
    const notes = typeof n === 'string' ? n : Array.isArray(n) ? n.map((x) => x.note).join('\n') : '';
    const clean = notes.replace(/\r\n?/g, '\n').replace(/<\/(p|li|h\d)>/gi, '\n').replace(/<li>/gi, '- ').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\n{3,}/g, '\n\n').trim();
    push({ status: 'available', version: info.version, notes: clean, checkedAt: Date.now() });
    if (getSettings().backgroundDownloadUpdates) download();
  });
  au.on('download-progress', (p) => push({ status: 'downloading', progress: Math.round(p.percent) }));
  au.on('update-downloaded', (info) => push({ status: 'ready', version: info.version, progress: 100 }));
  let installing = false;
  function installError(e) {
    if (installing) {
      installing = false;
      try { updateRelaunch.clear(app); } catch {}
    }
    push({ status: 'error', error: friendlyError(e, feed), detail: String((e && e.message) || e).slice(0, 600) });
  }
  au.on('error', installError);

  function install() {
    if (installing || state.status !== 'ready') return false;
    try {
      updateRelaunch.prepare(app, state.version);
      installing = true;
      au.quitAndInstall(true, true);
      return installing;
    } catch (e) {
      installError(e);
      return false;
    }
  }
  app.on('before-quit', (event) => {
    if (!installing && state.status === 'ready') {
      event.preventDefault();
      install();
    }
  });

  let checking = false;
  async function check() {
    if (!feed) configure();
    if (!feed || checking || ['downloading', 'ready'].includes(state.status)) return;
    checking = true;
    try {
      await au.checkForUpdates();
    } catch (e) {
      if (state.status !== 'error') push({ status: 'error', error: friendlyError(e, feed) }); // usually already sent by the 'error' event
    } finally {
      checking = false;
    }
  }
  async function download() {
    if (state.status === 'downloading' || state.status === 'ready') return;
    if (state.status !== 'available') return check();
    push({ status: 'downloading', progress: 0, error: null });
    try {
      await au.downloadUpdate();
    } catch (e) {
      if (state.status !== 'error') push({ status: 'error', error: friendlyError(e, feed) });
    }
  }

  configure();
  // Check at startup, every five minutes in use (30 minutes in the tray), and on return.
  let lastAuto = 0;
  const autoCheck = (minGapMs) => {
    if (!getSettings().autoCheckUpdates) return;
    if (Date.now() - lastAuto < minGapMs) return;
    lastAuto = Date.now();
    return check();
  };
  setTimeout(() => autoCheck(0), 5000);
  setInterval(() => autoCheck((isActive() ? 5 : 30) * 60 * 1000), 60 * 1000);

  return {
    state,
    check,
    download,
    /** Called when the window is opened or focused. */
    maybeCheck: () => autoCheck(60 * 1000),
    settingsChanged: () => autoCheck(0),
    // Silent in-place install: no installer window, FrameForge reopens by itself on the new version.
    install,
    configure,
    _updater: au,
  };
}

module.exports = { setup, parseSource };
