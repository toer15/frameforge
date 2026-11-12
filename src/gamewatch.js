// Is a game running right now? Fix mode, scheduled scans and the Game Booster all hold back while one is.
//
// Up to 1.14.2 "a game" was any app the FPS counter saw drawing a frame. With the FPS counter on, something is
// always drawing — a browser tab, Discord, Spotify — so FrameForge believed a game was running all day, and
// every fix that waits for "no game" (most of Fix mode) waited forever.
//
// Now a game is:
//   - an app that is not a known desktop app, drawing 20+ frames a second for 10 seconds in a row; or
//   - with no FPS data at all, the graphics card at 70 %+ for 20 seconds.
// It counts as running until 60 seconds after it was last seen.
const { NOT_GAMES, cleanName } = require('./booster');

/** More apps that draw frames all day and are never the game. */
const ALSO_NOT_GAMES = new Set([
  'wallpaper32', 'wallpaper64', 'lively', 'rainmeter', 'applicationframehost', 'systemsettings', 'notepad', 'video.ui', 'microsoft.media.player',
  'mpv', 'potplayermini64', 'whatsapp', 'signal', 'telegram', 'thunderbird', 'outlook', 'olk', 'winword', 'excel', 'powerpnt', 'onenote', 'acrobat',
  'gameoverlayui', 'steamwebhelper', 'opera_gx', 'arc', 'zen', 'librewolf', 'waterfox', 'notion', 'obsidian', 'figma', 'cursor', 'rider64', 'idea64',
  'pycharm64', 'webstorm64', 'studio64', 'sublime_text', 'notepad++', 'filezilla', 'qbittorrent', 'calculatorapp', 'photos', 'snippingtool', 'mspaint',
  'windowsterminal', 'wt', 'conhost', 'lockapp', 'logioptionsplus', 'icue', 'razer synapse 3', 'armourycrate', 'msiafterburner', 'rtss', 'hwinfo64',
]);

function isDesktopApp(app) {
  const n = cleanName(app);
  return !n || NOT_GAMES.has(n) || ALSO_NOT_GAMES.has(n);
}

class GameWatch {
  constructor() {
    this.app = null; // candidate game and since when it has been drawing steadily
    this.appSince = 0;
    this.gpuSince = 0;
    this.seen = 0;
    this.name = null;
  }
  /**
   * Call once a second.
   * @param {{ fps?: { app: string, fps: number } | null, gpuLoad?: number | null, now?: number }} s
   */
  update({ fps = null, gpuLoad = null, now = Date.now() }) {
    const drawing = fps && fps.fps > 0;
    if (drawing && fps.fps >= 20 && !isDesktopApp(fps.app)) {
      if (this.app !== fps.app) {
        this.app = fps.app;
        this.appSince = now;
      }
      if (now - this.appSince >= 10000) {
        this.seen = now;
        this.name = fps.app;
      }
    } else {
      this.app = null;
    }
    // The graphics card alone only decides when there is no FPS data; a browser playing video can load it too.
    if (!drawing && gpuLoad != null && gpuLoad >= 70) {
      if (!this.gpuSince) this.gpuSince = now;
      if (now - this.gpuSince > 20000) this.seen = now;
    } else {
      this.gpuSince = 0;
    }
  }
  running(now = Date.now()) {
    return now - this.seen < 60000;
  }
}

module.exports = { GameWatch, isDesktopApp };
