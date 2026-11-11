const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const { Booster, boostScript, restoreScript, parseBoost, cleanName, NOT_GAMES, BACKGROUND } = require('../src/booster');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A pretend PC: processes with priorities, changed only through the scripts' own rules. */
function fakePc(procs) {
  const scripts = [];
  const exec = async (script) => {
    scripts.push(script);
    const out = [];
    if (script.includes('$games = ')) {
      const list = (name) => [...script.match(new RegExp(`\\$${name} = @\\(([^)]*)\\)`))[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
      const games = list('games');
      const bg = list('bg');
      const hit = procs.filter((p) => games.includes(p.name));
      if (hit.length) {
        for (const p of hit) {
          if (p.locked) out.push(`X|${p.pid}|${p.name}|`);
          else {
            out.push(`G|${p.pid}|${p.name}|${p.prio}`);
            if (p.prio !== 'High' && p.prio !== 'RealTime') p.prio = 'High';
          }
        }
        for (const p of procs) if (bg.includes(p.name) && p.prio === 'Normal') { p.prio = 'BelowNormal'; out.push(`B|${p.pid}|${p.name}|Normal`); }
      }
    } else {
      for (const m of script.matchAll(/@\{i=(\d+);n='([^']*)';p='(\w+)';s='(\w+)'\}/g)) {
        const p = procs.find((x) => x.pid === Number(m[1]));
        if (p && p.name === m[2] && p.prio === m[4]) p.prio = m[3];
      }
    }
    return { stdout: out.join('\r\n') };
  };
  return { exec, scripts };
}

test('process names are cleaned before they reach PowerShell', () => {
  assert.equal(cleanName('EldenRing.exe'), 'eldenring');
  assert.equal(cleanName('Cyberpunk2077'), 'cyberpunk2077');
  assert.equal(cleanName("evil'; Remove-Item C:\\ -Recurse; '"), null);
  assert.equal(cleanName('a`b'), null);
  assert.equal(cleanName('$(calc)'), null);
  assert.equal(cleanName(''), null);
  assert.equal(cleanName(null), null);
  assert.ok(!/PriorityClass = 'RealTime'/.test(boostScript(['a'], ['b'])), 'Realtime priority is never set');
});

test('voice chat, streaming and music apps are never slowed, and never treated as the game', () => {
  for (const n of ['discord', 'obs64', 'spotify', 'teamspeak', 'ts3client_win64', 'audiodg', 'steam', 'vgc', 'easyanticheat'])
    assert.ok(!BACKGROUND.includes(n), `${n} must not be slowed`);
  for (const n of ['chrome', 'msedge', 'discord', 'obs64', 'explorer', 'dwm', 'frameforge'])
    assert.ok(NOT_GAMES.has(n), `${n} must not count as a game`);
  for (const n of BACKGROUND) assert.equal(cleanName(n), n, `${n} is a clean name`);
});

test('boost output is parsed strictly', () => {
  assert.deepEqual(parseBoost('G|10|eldenring|Normal\r\nB|11|chrome|Normal\r\nX|12|valorant|\r\nnoise\r\nG|x|y|Normal\r\nB|13|a|Weird'), [
    { kind: 'G', pid: 10, name: 'eldenring', prev: 'Normal' },
    { kind: 'B', pid: 11, name: 'chrome', prev: 'Normal' },
    { kind: 'X', pid: 12, name: 'valorant', prev: null },
    { kind: 'B', pid: 13, name: 'a', prev: null },
  ]);
  assert.equal(restoreScript([]), null);
  assert.equal(restoreScript([{ pid: 1, name: "x'y", prev: 'Normal', set: 'High' }]), null, 'odd names never reach a script');
  assert.equal(restoreScript([{ pid: 1, name: 'x', prev: 'Bogus', set: 'High' }]), null, 'only real priority classes');
});

test('a game is boosted, background apps are slowed, and everything is put back when it closes', async () => {
  const procs = [
    { pid: 10, name: 'eldenring', prio: 'Normal' },
    { pid: 11, name: 'chrome', prio: 'Normal' },
    { pid: 12, name: 'chrome', prio: 'Idle' }, // already lowered by something else: not FrameForge's to change
    { pid: 13, name: 'discord', prio: 'Normal' },
    { pid: 14, name: 'obs64', prio: 'AboveNormal' },
  ];
  const pc = fakePc(procs);
  const b = new Booster({ exec: pc.exec, demo: false, interval: 60000 });
  let now = 1000000;
  assert.equal(await b.tick({ enabled: true, app: 'EldenRing', gaming: true, now }), true);
  assert.deepEqual(procs.map((p) => p.prio), ['High', 'BelowNormal', 'Idle', 'Normal', 'AboveNormal']);
  assert.deepEqual(b.status(), { active: true, game: 'eldenring', protected: false, slowed: 1, since: now });

  // Within the interval nothing runs again.
  now += 5000;
  assert.equal(await b.tick({ enabled: true, app: 'EldenRing', gaming: true, now }), false);
  assert.equal(pc.scripts.length, 1);

  // A browser helper started mid-game is caught by the next pass.
  procs.push({ pid: 15, name: 'chrome', prio: 'Normal' });
  now += 60000;
  assert.equal(await b.tick({ enabled: true, app: 'EldenRing', gaming: true, now }), true);
  assert.equal(procs[5].prio, 'BelowNormal');
  assert.equal(b.status().slowed, 2);

  // The game closes while the graphics card still looks busy: the next pass notices and restores.
  procs.splice(0, 1);
  now += 60000;
  assert.equal(await b.tick({ enabled: true, app: null, gaming: true, now }), true);
  assert.deepEqual(b.status(), { active: false });
  assert.deepEqual(procs.map((p) => `${p.name}:${p.prio}`), ['chrome:Normal', 'chrome:Idle', 'discord:Normal', 'obs64:AboveNormal', 'chrome:Normal']);
});

test('switching the booster off mid-game restores the game too', async () => {
  const procs = [{ pid: 10, name: 'cs2', prio: 'Normal' }, { pid: 11, name: 'msedge', prio: 'Normal' }];
  const pc = fakePc(procs);
  const b = new Booster({ exec: pc.exec, demo: false });
  await b.tick({ enabled: true, app: 'cs2', gaming: true, now: 1 });
  assert.deepEqual(procs.map((p) => p.prio), ['High', 'BelowNormal']);
  assert.equal(await b.tick({ enabled: false, app: 'cs2', gaming: true, now: 2 }), true);
  assert.deepEqual(procs.map((p) => p.prio), ['Normal', 'Normal']);
  assert.equal(await b.tick({ enabled: false, app: 'cs2', gaming: true, now: 3 }), false, 'nothing left to do');
});

test('a priority the user set by hand is not overwritten on restore, and a reused PID is left alone', async () => {
  const procs = [{ pid: 10, name: 'cs2', prio: 'Normal' }, { pid: 11, name: 'firefox', prio: 'Normal' }, { pid: 12, name: 'onedrive', prio: 'Normal' }];
  const pc = fakePc(procs);
  const b = new Booster({ exec: pc.exec, demo: false });
  await b.tick({ enabled: true, app: 'cs2', gaming: true, now: 1 });
  procs[1].prio = 'Idle'; // the user changed it in Task Manager meanwhile
  procs[2] = { pid: 12, name: 'notepad', prio: 'BelowNormal' }; // OneDrive exited, Windows reused its PID
  await b.tick({ enabled: false, app: null, gaming: false, now: 2 });
  assert.deepEqual(procs.map((p) => p.prio), ['Normal', 'Idle', 'BelowNormal']);
});

test('nothing is touched without a game: browsers, the desktop and an unknown busy app', async () => {
  const procs = [{ pid: 11, name: 'chrome', prio: 'Normal' }, { pid: 12, name: 'blender', prio: 'Normal' }];
  const pc = fakePc(procs);
  const b = new Booster({ exec: pc.exec, demo: false, knownGames: async () => ['C:\\Games\\Elden Ring\\eldenring.exe', 'D:\\x\\chrome.exe'] });
  // PresentMon sees Chrome presenting (a video): not a game.
  assert.equal(await b.tick({ enabled: true, app: 'chrome', gaming: false, now: 1 }), false);
  assert.equal(pc.scripts.length, 0);
  // The graphics card is busy (rendering) with the FPS counter off: installed games are looked for, none runs.
  assert.equal(await b.tick({ enabled: true, app: null, gaming: true, now: 2 }), false);
  assert.equal(pc.scripts.length, 1);
  assert.ok(pc.scripts[0].includes("@('eldenring')"), 'installed games by .exe name, never a browser');
  assert.deepEqual(procs.map((p) => p.prio), ['Normal', 'Normal']);
  assert.deepEqual(b.status(), { active: false });
  // Switch off: nothing to restore, nothing run.
  assert.equal(await b.tick({ enabled: false, app: null, gaming: true, now: 3 }), false);
  assert.equal(pc.scripts.length, 1);
});

test('an anti-cheat protected game is reported, and background apps are still slowed', async () => {
  const procs = [{ pid: 10, name: 'valorant-win64-shipping', prio: 'Normal', locked: true }, { pid: 11, name: 'chrome', prio: 'Normal' }];
  const pc = fakePc(procs);
  const b = new Booster({ exec: pc.exec, demo: false });
  assert.equal(await b.tick({ enabled: true, app: 'VALORANT-Win64-Shipping', gaming: true, now: 1 }), true);
  assert.deepEqual(b.status(), { active: true, game: 'valorant-win64-shipping', protected: true, slowed: 1, since: 1 });
  assert.deepEqual(procs.map((p) => p.prio), ['Normal', 'BelowNormal']);
  const quit = b.quitScript();
  assert.ok(quit.includes("i=11;n='chrome';p='Normal';s='BelowNormal'"));
  assert.ok(!quit.includes('i=10;'), 'the protected game was never changed, so it is not restored');
});

// The real thing: Windows PowerShell against two harmless copies of PING.EXE. Runs in the release build.
test('real Windows: priorities really change and really come back', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-booster-'));
  const names = ['ffboostgame', 'ffboostbg', 'ffboostvoice'];
  const kids = names.map((n) => {
    const exe = path.join(dir, `${n}.exe`);
    fs.copyFileSync(path.join(process.env.WINDIR, 'System32', 'PING.EXE'), exe);
    return spawn(exe, ['-n', '90', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
  });
  const exec = (script) => new Promise((resolve) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { windowsHide: true }, (error, stdout, stderr) => resolve({ stdout: String(stdout), stderr: String(stderr) })));
  const prios = async () => (await exec(`${kids.map((k) => `"$((Get-Process -Id ${k.pid}).PriorityClass)"`).join('; ')}`)).stdout.trim().split(/\r?\n/).map((s) => s.trim());
  try {
    await delay(1500);
    // A build machine may run everything at Below Normal, and children inherit that: start from a known state.
    await exec(kids.map((k) => `(Get-Process -Id ${k.pid}).PriorityClass = 'Normal'`).join('; '));
    assert.deepEqual(await prios(), ['Normal', 'Normal', 'Normal']);
    const b = new Booster({ exec, demo: false, background: ['ffboostbg'] });
    assert.equal(await b.tick({ enabled: true, app: 'FFBoostGame', gaming: true, now: 1 }), true);
    assert.deepEqual(await prios(), ['High', 'BelowNormal', 'Normal']);
    assert.deepEqual(b.status(), { active: true, game: 'ffboostgame', protected: false, slowed: 1, since: 1 });
    assert.equal(await b.tick({ enabled: false, app: 'FFBoostGame', gaming: true, now: 2 }), true);
    assert.deepEqual(await prios(), ['Normal', 'Normal', 'Normal']);
    // And the "game closed" path.
    await b.tick({ enabled: true, app: 'FFBoostGame', gaming: true, now: 3 });
    assert.deepEqual(await prios(), ['High', 'BelowNormal', 'Normal']);
    kids[0].kill();
    await delay(1500);
    assert.equal(await b.tick({ enabled: true, app: null, gaming: true, now: 100000 }), true);
    assert.equal((await prios())[1], 'Normal');
  } finally {
    for (const k of kids) k.kill();
    await delay(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
