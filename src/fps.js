// Real in-game FPS using Intel PresentMon (it reads frame timing from Windows itself,
// so it works with DirectX, Vulkan and OpenGL games, and with anti-cheat).
//
// The counter must show the FPS the player actually gets wherever they are — game lobby, menu, match,
// loading screen — not only while a "game" is detected. So this reader:
//   - measures every presenting app, and prefers a real game over browsers, launchers and Discord;
//   - keeps the last real reading for a few seconds across a loading screen or a lobby/menu switch;
//   - is restarted by main.js if PresentMon exits, instead of staying blank until the app is restarted.
const { spawn } = require('child_process');
const readline = require('readline');
const { run } = require('./util');
const { NOT_GAMES, cleanName } = require('./booster');

const SESSION = 'FrameForgeFPS';
// Windows itself and FrameForge are never the app whose FPS the player wants.
const IGNORE = new Set(['dwm.exe', 'frameforge.exe', 'electron.exe', 'explorer.exe', 'searchhost.exe', 'startmenuexperiencehost.exe', 'textinputhost.exe', 'shellexperiencehost.exe', '<unknown>']);
// Presenting apps that are never the game: browsers, launchers and their web views, chat and music.
// They are still measured when they are the only thing drawing (a browser game or a video counts), but a
// game presenting at the same time always wins.
const DESKTOP_APPS = new Set([
  ...NOT_GAMES,
  'chrome', 'msedge', 'firefox', 'opera', 'opera_gx', 'brave', 'vivaldi', 'arc', 'zen', 'librewolf', 'waterfox',
  'msedgewebview2', 'discord', 'steamwebhelper', 'steam', 'obs64', 'spotify', 'code', 'epicgameslauncher',
  'epicwebhelper', 'battle.net', 'riotclientservices', 'riotclientux', 'riotclientuxrender', 'eadesktop', 'eaapp',
  'origin', 'upc', 'ubisoftconnect', 'galaxyclient', 'goggalaxy', 'rockstargameslauncher', 'socialclub',
  'xboxpcapp', 'gamebar', 'gamebarftserver', 'amdlink', 'nvidia app', 'nvidia overlay', 'radeonsoftware',
]);

const BUFFER_MS = 10000; // 1% low window
const LIVE_MS = 1200; // a frame arrived this recently → the number is live
const KEEP_MS = 5000; // a stream may pause this long (loading screen, lobby switch) before it is dropped
const RESTART_MIN_MS = 4000;
const RESTART_MAX_MS = 30000;

function isDesktopApp(app) {
  const n = cleanName(app);
  return !n || DESKTOP_APPS.has(n) || NOT_GAMES.has(n);
}

/** Frames from the most recent second of frame time: { n, sum }. */
function recent(rec) {
  const { ms, head } = rec;
  let sum = 0;
  let n = 0;
  for (let i = ms.length - 1; i >= head && sum < 1000; i--) {
    sum += ms[i];
    n++;
  }
  return { n, sum };
}

class FpsReader {
  constructor() {
    this.proc = null;
    this.frames = new Map(); // app -> rolling frame-time buffer
    this.low1Cache = new Map(); // app -> { at, value }; low-1% is slower-changing than live FPS
    this.cols = null;
    this.lastError = null;
    this.retryAt = 0;
    this.failures = 0;
    this.startedAt = 0;
    this.generation = 0;
  }

  /** Start PresentMon if it isn't running and its restart backoff has passed. Called once a second. */
  ensure(exe) {
    if (!exe || this.proc) return false;
    if (Date.now() < this.retryAt) return false;
    this.start(exe);
    return !!this.proc;
  }

  start(exe) {
    if (this.proc || !exe) return;
    this.lastError = null;
    this.startedAt = Date.now();
    const generation = ++this.generation;
    let proc;
    try {
      proc = spawn(
        exe,
        ['--output_stdout', '--no_console_stats', '--stop_existing_session', '--session_name', SESSION, '--v1_metrics', '--no_track_input'],
        { windowsHide: true }
      );
    } catch (e) {
      this.lastError = String((e && e.message) || 'PresentMon could not start.').slice(0, 240);
      this.scheduleRestart();
      return;
    }
    this.proc = proc;
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => this.onLine(line));
    // PresentMon writes its real errors (no admin rights, ETW session refused) to stderr. Keep the last one
    // so the UI can say why the counter is blank instead of pretending a game is not running.
    const err = readline.createInterface({ input: proc.stderr });
    err.on('line', (line) => {
      const t = String(line || '').trim();
      if (t && /error|failed|denied|unable|refus/i.test(t)) this.lastError = t.slice(0, 240);
    });
    let finished = false;
    const gone = () => {
      // 'error' and 'exit' can both fire for one failed start; the backoff must only count it once.
      if (finished) return;
      finished = true;
      // An intentional stop (or a newer capture) must not be treated as a crash: it would leave a restart
      // backoff behind and delay turning the counter back on.
      if (generation !== this.generation) return;
      if (this.proc === proc) {
        this.proc = null;
        this.cols = null;
      }
      this.scheduleRestart();
    };
    proc.on('exit', gone);
    proc.on('error', (e) => {
      this.lastError = String((e && e.message) || 'PresentMon could not start.').slice(0, 240);
      gone();
    });
  }

  /** Exponential backoff so a PresentMon that cannot run is retried quietly, not once every tick. */
  scheduleRestart() {
    // A capture that ran for a while was healthy: start the backoff from the beginning again.
    if (Date.now() - this.startedAt > 30000) this.failures = 0;
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** Math.min(4, this.failures));
    this.failures++;
    this.retryAt = Date.now() + delay;
  }

  onLine(line) {
    // PresentMon's CSV may carry a UTF-8 BOM and quoted/whitespace-padded column names.
    // Normalize fields before looking up the header so the FPS stream doesn't silently stay empty.
    const parts = String(line || '')
      .replace(/^\uFEFF/, '')
      .split(',')
      .map((part) => part.trim().replace(/^"(.*)"$/, '$1'));
    if (parts[0] && parts[0].toLowerCase() === 'application') {
      const idx = (n) => parts.findIndex((part) => part.toLowerCase() === n.toLowerCase());
      const ms = ['MsBetweenPresents', 'MsBetweenDisplayChange', 'FrameTime', 'TimeInMs'].map(idx).find((i) => i >= 0);
      this.cols = {
        app: idx('Application') >= 0 ? idx('Application') : 0,
        ms: ms == null ? -1 : ms,
      };
      return;
    }
    if (!this.cols || this.cols.ms < 0) return;
    const raw = parts[this.cols.app] || '';
    const name = raw.trim().split(/[\\/]/).pop();
    const app = name.toLowerCase();
    if (!app || IGNORE.has(app)) return;
    const ms = parseFloat(parts[this.cols.ms]);
    if (!(ms > 0 && ms < 2000)) return;
    this.push(app, ms, Date.now(), name);
    this.failures = 0; // real frames are flowing: the engine is healthy
  }

  /** Store one frame time. Keeps ~10 seconds of frames per app (measured in frame time, not arrival time). */
  push(app, ms, now, name = app) {
    let rec = this.frames.get(app);
    if (!rec) this.frames.set(app, (rec = { ms: [], head: 0, sum: 0, last: 0, name }));
    rec.ms.push(ms);
    rec.sum += ms;
    rec.last = now;
    rec.name = name || rec.name;
    // Drop old frames by advancing a cursor. Array.shift() moves every remaining frame on every new frame.
    while (rec.sum > BUFFER_MS && rec.ms.length - rec.head > 1) rec.sum -= rec.ms[rec.head++];
    // Compact occasionally so the discarded prefix doesn't accumulate for a long-running game.
    if (rec.head >= 512 && rec.head * 2 >= rec.ms.length) {
      rec.ms = rec.ms.slice(rec.head);
      rec.head = 0;
    }
  }

  /**
   * { app, fps, low1, frametime, live } for the game on screen, or null.
   * FPS = frames presented in the most recent 1 second of frame time (same method as RTSS / Afterburner).
   * 1% low = based on the slowest 1% of frames over the last ~10 seconds.
   * `live` is false when the last frame is a moment old (a loading screen): the number is the last real
   * reading, held for a few seconds instead of flashing a dash in a lobby or between matches.
   */
  read(now = Date.now()) {
    let best = null;
    for (const [app, rec] of this.frames) {
      if (now - rec.last > KEEP_MS) {
        this.frames.delete(app); // stopped rendering (closed, or paused far too long to be the current app)
        this.low1Cache.delete(app);
        continue;
      }
      const win = recent(rec);
      if (!win.n || !(win.sum > 0)) continue;
      const age = now - rec.last;
      // A real game beats a browser/launcher, but only while it is actually drawing: a live app always
      // beats one that paused, so leaving a game for the desktop does not freeze the counter on old numbers.
      const score = win.n * 10 + (isDesktopApp(app) ? 0 : 1e6) + (age <= LIVE_MS ? 2e6 : 0);
      if (!best || score > best.score) best = { app, rec, ...win, age, score };
    }
    if (!best) return null;
    const fps = (best.n * 1000) / best.sum;
    // Recompute the 10-second 1% low once a second; the live FPS above still refreshes every 250 ms.
    let low1 = this.low1Cache.get(best.app);
    if (!low1 || now - low1.at >= 1000) {
      // 1% low = FPS of the average of the slowest 1% of frames (what reviewers and CapFrameX call "1% low").
      const sorted = best.rec.ms.slice(best.rec.head).sort((a, b) => b - a);
      const worst = sorted.slice(0, Math.max(1, Math.round(sorted.length / 100)));
      const worstAvg = worst.reduce((a, b) => a + b, 0) / worst.length;
      low1 = { at: now, value: Math.round(Math.min(fps, 1000 / worstAvg)) };
      this.low1Cache.set(best.app, low1);
    }
    return {
      app: best.rec.name.replace(/\.exe$/i, ''),
      fps: Math.round(fps),
      low1: Math.min(Math.round(fps), low1.value),
      frametime: Math.round((best.sum / best.n) * 10) / 10,
      live: best.age <= LIVE_MS,
    };
  }

  async stop(exe) {
    this.generation++;
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.frames.clear();
    this.low1Cache.clear();
    this.cols = null;
    this.lastError = null;
    this.failures = 0;
    this.retryAt = 0;
    if (exe) await run(exe, ['--terminate_existing_session', '--session_name', SESSION]);
  }

  get running() {
    return !!this.proc;
  }
}

module.exports = { FpsReader, isDesktopApp };
