// Finds installed games (Steam + Epic) and the .exe each one runs.
const fs = require('fs');
const path = require('path');
const reg = require('./registry');

const SKIP_EXE = /unins|setup|install|crash|report|redist|vc_?redist|dxsetup|directx|prereq|helper|launcher|updater|easyanticheat|eac|battleye|be(service|launcher)|dotnet|vcredist|physx|cefprocess|webhelper|ue4editor|server|benchmark/i;

function readSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Pick the game's real .exe in a folder: prefer *-Win64-Shipping.exe, otherwise the biggest .exe. */
function mainExe(dir, depth = 0, found = []) {
  if (depth > 4) return found;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!/^(_commonredist|redist|redistributables|directx|support|tools|engine\\extras|__installer)$/i.test(e.name)) mainExe(p, depth + 1, found);
    } else if (/\.exe$/i.test(e.name) && !SKIP_EXE.test(e.name)) {
      let size = 0;
      try {
        size = fs.statSync(p).size;
      } catch {}
      found.push({ p, size, shipping: /-Win64-Shipping\.exe$/i.test(e.name) });
    }
  }
  return found;
}

/** The game's main .exe files (launcher + real game), biggest first, *-Shipping.exe always included. Max 4. */
function gameExes(dir) {
  const list = mainExe(dir).filter((x) => x.size > 40 * 1024);
  const ship = list.filter((x) => x.shipping);
  const rest = list.filter((x) => !x.shipping).sort((a, b) => b.size - a.size);
  return [...ship, ...rest].slice(0, 4).map((x) => x.p);
}

function bestExe(dir) {
  return gameExes(dir)[0] || null;
}

async function steamGames() {
  const r = await reg.get('HKCU\\Software\\Valve\\Steam', 'SteamPath');
  const roots = new Set();
  if (r.exists) roots.add(r.data.replace(/\//g, '\\'));
  roots.add('C:\\Program Files (x86)\\Steam');
  const libs = new Set();
  for (const root of roots) {
    const vdf = readSafe(path.join(root, 'steamapps', 'libraryfolders.vdf'));
    if (!vdf) continue;
    libs.add(root);
    for (const m of vdf.matchAll(/"path"\s+"([^"]+)"/g)) libs.add(m[1].replace(/\\\\/g, '\\'));
  }
  const games = [];
  for (const lib of libs) {
    const apps = path.join(lib, 'steamapps');
    let files = [];
    try {
      files = fs.readdirSync(apps).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const acf = readSafe(path.join(apps, f)) || '';
      const name = (acf.match(/"name"\s+"([^"]+)"/) || [])[1];
      const dir = (acf.match(/"installdir"\s+"([^"]+)"/) || [])[1];
      if (!name || !dir || /Steamworks|Redistributable|Proton|SteamVR|Wallpaper Engine/i.test(name)) continue;
      const exes = gameExes(path.join(apps, 'common', dir));
      if (exes.length) games.push({ name, exes, store: 'Steam' });
    }
  }
  return games;
}

function epicGames() {
  const dir = 'C:\\ProgramData\\Epic\\EpicGamesLauncher\\Data\\Manifests';
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.item'));
  } catch {
    return [];
  }
  const games = [];
  for (const f of files) {
    try {
      const j = JSON.parse(readSafe(path.join(dir, f)));
      if (!j.InstallLocation || !j.LaunchExecutable) continue;
      const exe = path.join(j.InstallLocation, j.LaunchExecutable);
      if (!fs.existsSync(exe)) continue;
      const exes = [...new Set([exe, ...gameExes(j.InstallLocation)])].slice(0, 4);
      games.push({ name: j.DisplayName || path.basename(exe), exes, store: 'Epic' });
    } catch {}
  }
  return games;
}

async function findGames() {
  const all = [...(await steamGames()), ...epicGames()];
  const seen = new Set();
  return all.filter((g) => !seen.has(g.exes[0].toLowerCase()) && seen.add(g.exes[0].toLowerCase())).slice(0, 400);
}

module.exports = { findGames, gameExes, bestExe };
