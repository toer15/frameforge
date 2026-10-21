// Real in-game FPS using Intel PresentMon (it reads frame timing from Windows itself,
// so it works with DirectX, Vulkan and OpenGL games, and with anti-cheat).
const { spawn } = require('child_process');
const readline = require('readline');
const path = require('path');
const { run } = require('./util');

const SESSION = 'FrameForgeFPS';
const IGNORE = new Set(['dwm.exe', 'frameforge.exe', 'electron.exe', 'explorer.exe', 'searchhost.exe', 'startmenuexperiencehost.exe', 'textinputhost.exe', 'shellexperiencehost.exe', '<unknown>']);
// Apps that present frames but usually aren't the game you're playing.
const DESKTOP_APPS = new Set(['chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe', 'discord.exe', 'steamwebhelper.exe', 'obs64.exe', 'spotify.exe', 'code.exe', 'msedgewebview2.exe', 'epicgameslauncher.exe', 'battle.net.exe']);

class FpsReader {
  constructor() {
    this.proc = null;
    this.frames = new Map(); // app -> [{t, ms}]
    this.cols = null;
  }

  start(exe) {
    if (this.proc || !exe) return;
    this.proc = spawn(
      exe,
      ['--output_stdout', '--no_console_stats', '--stop_existing_session', '--session_name', SESSION, '--v1_metrics', '--no_track_input'],
      { windowsHide: true }
    );
    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.onLine(line));
    this.proc.on('exit', () => {
      this.proc = null;
      this.cols = null;
    });
    this.proc.on('error', () => {
      this.proc = null;
    });
  }

  onLine(line) {
    const parts = line.split(',');
    if (parts[0] === 'Application') {
      const idx = (n) => parts.indexOf(n);
      this.cols = {
        app: 0,
        ms: idx('MsBetweenPresents') >= 0 ? idx('MsBetweenPresents') : idx('MsBetweenDisplayChange'),
      };
      return;
    }
    if (!this.cols || this.cols.ms < 0) return;
    const name = parts[this.cols.app] || '';
    const app = name.toLowerCase();
    if (IGNORE.has(app)) return;
    const ms = parseFloat(parts[this.cols.ms]);
    if (!(ms > 0 && ms < 2000)) return;
    this.push(app, ms, Date.now(), name);
  }

  /** Store one frame time. Keeps ~10 seconds of frames per app (measured in frame time, not arrival time). */
  push(app, ms, now, name = app) {
    let rec = this.frames.get(app);
    if (!rec) this.frames.set(app, (rec = { ms: [], sum: 0, last: 0, name }));
    rec.ms.push(ms);
    rec.sum += ms;
    rec.last = now;
    while (rec.sum > 10000 && rec.ms.length > 1) rec.sum -= rec.ms.shift();
  }

  /**
   * { app, fps, low1, frametime } for the game on screen, or null.
   * FPS = frames presented in the most recent 1 second of frame time (same method as RTSS / Afterburner).
   * 1% low = based on the slowest 1% of frames over the last ~10 seconds.
   */
  read(now = Date.now()) {
    let best = null;
    for (const [app, rec] of this.frames) {
      if (now - rec.last > 2000) {
        this.frames.delete(app); // stopped rendering (closed or minimized)
        continue;
      }
      const score = rec.ms.length + (DESKTOP_APPS.has(app) ? 0 : 1e6);
      if (!best || score > best.score) best = { app, rec, score };
    }
    if (!best) return null;
    const arr = best.rec.ms;
    let sum = 0;
    let n = 0;
    for (let i = arr.length - 1; i >= 0 && sum < 1000; i--) {
      sum += arr[i];
      n++;
    }
    const fps = (n * 1000) / sum;
    // 1% low = FPS of the average of the slowest 1% of frames (what reviewers and CapFrameX call "1% low").
    const sorted = [...arr].sort((a, b) => b - a);
    const worst = sorted.slice(0, Math.max(1, Math.round(sorted.length / 100)));
    const worstAvg = worst.reduce((a, b) => a + b, 0) / worst.length;
    return {
      app: best.rec.name.replace(/\.exe$/i, ''),
      fps: Math.round(fps),
      low1: Math.round(Math.min(fps, 1000 / worstAvg)),
      frametime: Math.round((sum / n) * 10) / 10,
    };
  }

  async stop(exe) {
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.frames.clear();
    if (exe) await run(exe, ['--terminate_existing_session', '--session_name', SESSION]);
  }

  get running() {
    return !!this.proc;
  }
}

module.exports = { FpsReader };
