// Game Booster: while a game runs, the game's process gets High priority and background browsers, launcher
// web helpers and sync apps drop to Below Normal, so the CPU serves the game first. When the game closes (or the
// switch goes off) every process FrameForge touched gets its old priority back.
//
// What it never does: Realtime priority (starves Windows itself), anything to voice chat, streaming or audio
// apps, or anything to a process it didn't change itself.
//
// Cost: nothing while no game runs. During a game it starts one short, low-priority PowerShell pass per minute
// to catch helper processes that browsers and launchers keep spawning.
const path = require('path');
const { ps, DEMO } = require('./util');

/** Presenting apps that are never "the game" (same idea as fps.js' desktop apps). */
const NOT_GAMES = new Set([
  'chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi', 'msedgewebview2', 'discord', 'steamwebhelper', 'steam',
  'obs64', 'obs32', 'streamlabs obs', 'spotify', 'code', 'epicgameslauncher', 'epicwebhelper', 'battle.net',
  'explorer', 'dwm', 'frameforge', 'electron', 'powershell', 'cmd', 'windowsterminal', 'taskmgr', 'teams', 'ms-teams',
  'vlc', 'mpc-hc64', 'photoshop', 'premiere pro', 'afterfx', 'blender', 'resolve', 'devenv', 'unityhub', 'unity',
  'unrealeditor', 'riotclientux', 'riotclientuxrender', 'leagueclientux', 'leagueclientuxrender', 'eadesktop',
  'upc', 'ubisoftconnect', 'galaxyclient', 'nvidia app', 'nvidia overlay', 'radeonsoftware', 'searchhost', 'slack', 'zoom',
]);

/**
 * Background apps slowed to Below Normal during a game. Deliberately short and boring: browsers, launcher web
 * views and file sync. Voice chat (Discord, TeamSpeak), streaming (OBS), music and anti-cheat are left alone —
 * slowing those is what makes audio crackle or a stream drop frames.
 */
const BACKGROUND = [
  'chrome', 'msedge', 'firefox', 'opera', 'brave', 'vivaldi', 'msedgewebview2',
  'steamwebhelper', 'epicwebhelper', 'epicgameslauncher', 'eadesktop', 'eabackgroundservice', 'upc', 'ubisoftconnect',
  'galaxyclient', 'galaxyclient helper', 'riotclientux', 'riotclientuxrender', 'leagueclientux', 'leagueclientuxrender',
  'onedrive', 'dropbox', 'googledrivefs', 'teams', 'ms-teams', 'widgets', 'widgetservice', 'phoneexperiencehost',
  'searchapp', 'yourphone', 'cortana', 'microsoft.photos', 'gamebar', 'gamebarftserver', 'xboxpcappft',
];

const CLASSES = new Set(['Idle', 'BelowNormal', 'Normal', 'AboveNormal', 'High', 'RealTime']);

/** A process name safe to put inside a PowerShell single-quoted string, lower-case, no ".exe". Null if odd. */
function cleanName(n) {
  const s = String(n || '').trim().replace(/\.exe$/i, '').toLowerCase();
  return /^[a-z0-9 ._+()&-]{1,64}$/.test(s) ? s : null;
}

function psList(names) {
  return `@(${names.map((n) => `'${n}'`).join(',')})`;
}

/** One pass: raise games, slow background apps, print what changed as "G|pid|name|previous" lines. */
function boostScript(games, background) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "try { (Get-Process -Id $PID).PriorityClass = 'BelowNormal' } catch {}", // this helper itself stays out of the game's way
    `$games = ${psList(games)}`,
    `$bg = ${psList(background)}`,
    '$all = @(Get-Process)',
    '$hit = @($all | Where-Object { $games -contains $_.ProcessName.ToLower() })',
    'if ($hit.Count -gt 0) {', // no game running → touch nothing at all
    '  foreach ($p in $hit) {',
    '    $n = $p.ProcessName.ToLower()',
    '    try {',
    '      $prev = "$($p.PriorityClass)"',
    "      if ($prev -ne 'High' -and $prev -ne 'RealTime') { $p.PriorityClass = 'High' }",
    '      "G|$($p.Id)|$n|$prev"',
    '    } catch { "X|$($p.Id)|$n|" }', // anti-cheat protects the process: nothing changed, and that is fine
    '  }',
    '  foreach ($p in $all) {',
    '    $n = $p.ProcessName.ToLower()',
    '    if ($bg -contains $n) {',
    '      try {',
    "        if (\"$($p.PriorityClass)\" -eq 'Normal') { $p.PriorityClass = 'BelowNormal'; \"B|$($p.Id)|$n|Normal\" }",
    '      } catch {}',
    '    }',
    '  }',
    '}',
  ].join('\n');
}

/** Put back only what FrameForge changed: same PID, same name, and still at the priority FrameForge set. */
function restoreScript(entries) {
  const rows = entries
    .filter((e) => Number.isInteger(e.pid) && cleanName(e.name) && CLASSES.has(e.prev) && CLASSES.has(e.set))
    .map((e) => `@{i=${e.pid};n='${cleanName(e.name)}';p='${e.prev}';s='${e.set}'}`);
  if (!rows.length) return null;
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `foreach ($e in @(${rows.join(',')})) {`,
    '  $p = Get-Process -Id $e.i',
    '  if ($p -and $p.ProcessName.ToLower() -eq $e.n -and "$($p.PriorityClass)" -eq $e.s) { try { $p.PriorityClass = $e.p } catch {} }',
    '}',
  ].join('\n');
}

/** "G|1234|eldenring|Normal" lines → [{ kind, pid, name, prev }] */
function parseBoost(stdout) {
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const m = line.trim().match(/^([GBX])\|(\d+)\|([^|]+)\|([A-Za-z]*)$/);
    if (!m) continue;
    out.push({ kind: m[1], pid: Number(m[2]), name: m[3], prev: CLASSES.has(m[4]) ? m[4] : null });
  }
  return out;
}

class Booster {
  /**
   * @param {object} o
   * @param {(script: string) => Promise<{stdout: string}>} [o.exec] runs PowerShell (tests pass their own)
   * @param {() => Promise<string[]>} [o.knownGames] .exe paths of installed games, for when the FPS counter is off
   * @param {boolean} [o.demo]
   * @param {string[]} [o.background] process names to slow during a game (tests pass their own)
   */
  constructor({ exec = (s) => ps(s, { timeout: 20000 }), knownGames = async () => [], demo = DEMO, interval = 60000, background = BACKGROUND } = {}) {
    this.exec = exec;
    this.background = background.map(cleanName).filter(Boolean);
    this.knownGames = knownGames;
    this.demo = demo;
    this.interval = interval;
    this.touched = new Map(); // pid -> { pid, name, prev, set, kind }
    this.game = null; // name of the game being boosted
    this.protected = false; // the game's process refused the change (anti-cheat)
    this.lastPass = 0;
    this.lastSeen = 0;
    this.working = false;
    this.since = 0;
  }

  /** What Home shows. */
  status() {
    if (!this.game) return { active: false };
    let slowed = 0;
    for (const e of this.touched.values()) if (e.kind === 'B') slowed++;
    return { active: true, game: this.game, protected: this.protected, slowed, since: this.since };
  }

  /**
   * Call about once a second.
   * @param {object} o
   * @param {boolean} o.enabled   the Game Booster switch
   * @param {string|null} o.app   the app PresentMon sees presenting frames (no ".exe"), if the FPS counter runs
   * @param {boolean} o.gaming    something keeps the graphics card busy
   * @returns {Promise<boolean>}  true when the status changed
   */
  async tick({ enabled, app, gaming, now = Date.now() }) {
    if (this.working) return false;
    const fpsGame = cleanName(app);
    const seen = enabled && ((fpsGame && !NOT_GAMES.has(fpsGame)) || gaming);
    if (seen) this.lastSeen = now;

    // Switched off, or no game for 15 seconds → put everything back.
    if (!enabled || (this.game && now - this.lastSeen > 15000)) {
      if (!this.game && !this.touched.size) return false;
      await this.restore();
      return true;
    }
    if (!seen || (this.lastPass && now - this.lastPass < this.interval)) return false;

    this.working = true;
    try {
      this.lastPass = now;
      let games = fpsGame && !NOT_GAMES.has(fpsGame) ? [fpsGame] : [];
      if (!games.length) {
        // FPS counter off: look for the installed games' own .exe files instead.
        const exes = await this.knownGames().catch(() => []);
        games = [...new Set(exes.map((p) => cleanName(path.win32.basename(String(p)))).filter((n) => n && !NOT_GAMES.has(n)))].slice(0, 400);
      }
      // Always re-check the game being boosted, so its exit is noticed even when nothing names it any more.
      if (this.game && !games.includes(this.game)) games.push(this.game);
      if (!games.length) return false;
      const before = JSON.stringify(this.status());
      const rows = this.demo ? [{ kind: 'G', pid: 4242, name: games[0], prev: 'Normal' }, { kind: 'B', pid: 5001, name: 'chrome', prev: 'Normal' }, { kind: 'B', pid: 5002, name: 'steamwebhelper', prev: 'Normal' }] : parseBoost((await this.exec(boostScript(games, this.background))).stdout);
      const found = rows.filter((r) => r.kind === 'G' || r.kind === 'X');
      if (!found.length) {
        // No game is running (any more): put back whatever an earlier pass changed.
        if (!this.game && !this.touched.size) return false;
        await this.restore();
        return true;
      }
      for (const r of rows) {
        if (this.touched.has(r.pid)) continue; // keep the first "previous" value: later passes see FrameForge's own change
        if (r.kind === 'G' && r.prev && r.prev !== 'High' && r.prev !== 'RealTime') this.touched.set(r.pid, { ...r, set: 'High' });
        if (r.kind === 'B') this.touched.set(r.pid, { ...r, set: 'BelowNormal' });
      }
      const first = found.find((r) => r.kind === 'G') || found[0];
      if (!this.game) this.since = now;
      this.game = first.name;
      this.protected = !found.some((r) => r.kind === 'G');
      return JSON.stringify(this.status()) !== before;
    } finally {
      this.working = false;
    }
  }

  /** Give every process FrameForge changed its old priority back. */
  async restore() {
    const entries = [...this.touched.values()];
    this.touched.clear();
    this.game = null;
    this.protected = false;
    this.lastPass = 0;
    const script = restoreScript(entries);
    if (script && !this.demo) await this.exec(script).catch(() => {});
  }

  /** For app quit: the restore script to fire without waiting, or null when nothing was changed. */
  quitScript() {
    const script = restoreScript([...this.touched.values()]);
    this.touched.clear();
    this.game = null;
    return this.demo ? null : script;
  }
}

module.exports = { Booster, boostScript, restoreScript, parseBoost, cleanName, NOT_GAMES, BACKGROUND };
