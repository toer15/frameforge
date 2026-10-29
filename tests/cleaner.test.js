const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

// Demo mode: every Cleaner location lives in this sandbox, filled with harmless files below.
const sandbox = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-cleaner-'));
process.env.FRAMEFORGE_DEMO = '1';
process.env.FRAMEFORGE_CLEAN_SANDBOX = sandbox;
process.env.FRAMEFORGE_CLEAN_BIG = String(1024 * 1024);
process.env.FRAMEFORGE_DEMO_RUNNING = 'msedge.exe';
const cleaner = require('../src/cleaner');

const home = path.join(sandbox, 'Users', 'Gamer');
const local = path.join(home, 'AppData', 'Local');
const P = {
  oldTmp: path.join(local, 'Temp', 'old.tmp'),
  oldTmpSub: path.join(local, 'Temp', 'sub', 'deeper', 'old2.tmp'),
  newTmp: path.join(local, 'Temp', 'new.tmp'),
  precious: path.join(sandbox, 'outside', 'precious.txt'),
  junction: path.join(local, 'Temp', 'link-to-outside'),
  winTmp: path.join(sandbox, 'Windows', 'Temp', 'old.log'),
  locked: path.join(sandbox, 'Windows', 'Temp', 'locked.log'),
  cbsOld: path.join(sandbox, 'Windows', 'Logs', 'CBS', 'CbsPersist_1.log'),
  cbsNew: path.join(sandbox, 'Windows', 'Logs', 'CBS', 'CBS.log'),
  chromeCache: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Cache', 'Cache_Data', 'f_1'),
  chromeCache2: path.join(local, 'Google', 'Chrome', 'User Data', 'Profile 1', 'Code Cache', 'js', 'f_2'),
  bookmarks: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Bookmarks'),
  login: path.join(local, 'Google', 'Chrome', 'User Data', 'Default', 'Login Data'),
  edgeCache: path.join(local, 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache', 'Cache_Data', 'f_3'),
  shader: path.join(local, 'NVIDIA', 'DXCache', 's.nvph'),
  oldSetup: path.join(home, 'Downloads', 'old-setup.exe'),
  oldZip: path.join(home, 'Downloads', 'old-mods.zip'),
  recentZip: path.join(home, 'Downloads', 'recent.zip'),
  photo: path.join(home, 'Downloads', 'photo.jpg'),
  big: path.join(home, 'Videos', 'big.mp4'),
  notes: path.join(home, 'Documents', 'notes.txt'),
  bin: path.join(sandbox, '$Recycle.Bin', 'S-1-5-21-0-0-0-1001', '$RABC.txt'),
};
const AGES = { newTmp: 0, cbsNew: 1, recentZip: 3, oldSetup: 90, oldZip: 60, photo: 90 };

test('Cleaner finds junk, deletes only safe picks and never follows links or touches files in use', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  for (const [k, p] of Object.entries(P)) {
    if (k === 'junction') continue;
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(k === 'big' ? 2 * 1024 * 1024 : 2048, 1));
  }
  fs.symlinkSync(path.dirname(P.precious), P.junction, 'junction'); // a link out of Temp must never be followed
  await cleaner.ageFiles(Object.entries(P).filter(([k]) => k !== 'junction').map(([k, p]) => ({ p, days: AGES[k] ?? 10 })));

  const scan = await cleaner.scan({}, () => {});
  assert.equal(scan.ok, true);
  const cat = (id) => scan.result.cats.find((c) => c.id === id);
  const all = scan.result.cats.flatMap((c) => (c.items || []).map((i) => path.join(i.dir, i.name)));
  assert.equal(cat('temp_user').count, 2, 'only the two old temp files');
  assert.match(cat('temp_user').note, /1 newer file/);
  assert.equal(cat('temp_windows').count, 2);
  assert.equal(cat('win_logs').count, 1, 'CBS.log from yesterday is kept');
  assert.equal(cat('chrome').count, 2, 'cache folders of every profile, nothing else');
  assert.equal(cat('edge').status, 'running');
  assert.equal(cat('edge').selectable, false);
  assert.equal(cat('shaders').selected, false, 'review items are not picked by default');
  assert.equal(cat('recycle').selected, false);
  assert.deepEqual(cat('old_downloads').items.map((i) => i.name).sort(), ['old-mods.zip', 'old-setup.exe']);
  assert.deepEqual(cat('big_files').items.map((i) => i.name), ['big.mp4']);
  assert.equal(all.some((p) => p.includes('outside')), false);
  assert.equal(cat('firefox').status, 'missing');

  // Something writes to a cache file after the scan, and another program holds a temp file open.
  fs.appendFileSync(P.chromeCache, 'changed after the scan');
  await cleaner.ageFiles([{ p: P.chromeCache, days: 10 }]);
  const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${P.locked.replace(/'/g, "''")}', 'Open', 'ReadWrite', 'None'); Start-Sleep 60`], { windowsHide: true });
  try {
    for (let i = 0; i < 100; i++) {
      try { fs.closeSync(fs.openSync(P.locked, 'r')); } catch { break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    const picked = scan.result.cats.filter((c) => c.selected).map((c) => c.id);
    assert.deepEqual(picked.sort(), ['chrome', 'temp_user', 'temp_windows', 'win_logs'].sort());
    const setup = cat('old_downloads').items.find((i) => i.name === 'old-setup.exe');
    const r = await cleaner.clean({ cats: [...picked, 'edge'], files: { old_downloads: [setup.id] } }, {}, () => {});
    assert.equal(r.ok, true);
    for (const k of ['oldTmp', 'oldTmpSub', 'winTmp', 'cbsOld', 'chromeCache2']) assert.equal(fs.existsSync(P[k]), false, `${k} must be deleted`);
    for (const k of ['newTmp', 'precious', 'locked', 'cbsNew', 'chromeCache', 'bookmarks', 'login', 'edgeCache', 'shader', 'oldZip', 'recentZip', 'photo', 'big', 'notes', 'bin']) assert.equal(fs.existsSync(P[k]), true, `${k} must be kept`);
    assert.equal(fs.existsSync(P.junction), true, 'the link itself stays');
    assert.equal(fs.existsSync(path.join(local, 'Temp', 'sub')), false, 'emptied folders are removed');
    assert.equal(fs.existsSync(path.join(local, 'Temp')), true, 'the temp folder itself stays');
    assert.equal(fs.existsSync(P.oldSetup), false);
    const binFiles = fs.readdirSync(path.dirname(P.bin));
    assert.equal(binFiles.filter((n) => n.endsWith('.exe')).length, 1, 'the user file went to the (sandbox) Recycle Bin');
    assert.equal(r.deleted, 5);
    assert.equal(r.trashed, 1);
    assert.equal(r.inUse, 2, 'locked file + file changed after the scan');
    assert.deepEqual(r.skippedCats, ['Microsoft Edge cache']);
    const after = (id) => r.result.cats.find((c) => c.id === id);
    assert.equal(after('temp_windows').count, 1, 'the locked file stays listed so it can be retried');
    assert.match(after('temp_windows').last.message, /in use/);
    assert.equal(after('old_downloads').items.length, 1);
    fs.writeFileSync(P.oldTmp, 'A new file at a path that was already cleaned');
    await cleaner.clean({ cats: ['temp_user'] }, {}, () => {});
    assert.equal(fs.existsSync(P.oldTmp), true, 'a stale request deletes nothing new');
  } finally {
    holder.kill();
  }
});

test('Full check finds big files on the whole drive but never inside games, programs or Windows', { skip: process.platform !== 'win32', timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-cleaner-full-'));
  process.env.FRAMEFORGE_CLEAN_SANDBOX = root;
  const h = path.join(root, 'Users', 'Gamer');
  const F = {
    backup: path.join(root, 'Backups', 'old-backup.iso'),
    backupCopy: path.join(h, 'Downloads', 'old-backup.iso'),
    deepZip: path.join(h, 'Downloads', 'mods', 'pack', 'old-pack.zip'),
    epicGame: path.join(root, 'Fortnite', 'FortniteGame', 'Content', 'Paks', 'pakchunk1.ucas'),
    unrealGame: path.join(root, 'MyUE', 'MyGame', 'Content', 'big.pak'),
    portable: path.join(root, 'PortableApp', 'data.bin'),
    windows: path.join(root, 'Windows', 'big.bin'),
    programs: path.join(root, 'Program Files', 'App', 'big.bin'),
    otherUser: path.join(root, 'Users', 'Someone', 'Videos', 'their.mp4'),
    pagefile: path.join(root, 'pagefile.sys'),
  };
  for (const [k, p] of Object.entries(F)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(k === 'deepZip' ? 2048 : 2 * 1024 * 1024, 2));
  }
  fs.mkdirSync(path.join(root, 'Fortnite', '.egstore'));
  fs.mkdirSync(path.join(root, 'MyUE', 'Engine'));
  fs.writeFileSync(path.join(root, 'PortableApp', 'app.exe'), 'not a real program');
  await cleaner.ageFiles(Object.values(F).map((p) => ({ p, days: 90 })));

  const names = (r, id) => r.result.cats.find((c) => c.id === id).items.map((i) => i.name).sort();
  const quick = await cleaner.scan({ mode: 'quick' }, () => {});
  assert.equal(quick.result.mode, 'quick');
  assert.deepEqual(names(quick, 'old_downloads'), ['old-backup.iso'], 'quick: only the top of Downloads');
  assert.deepEqual(names(quick, 'big_files'), [], 'quick: only your main folders');

  const full = await cleaner.scan({ mode: 'full' }, () => {});
  assert.equal(full.result.mode, 'full');
  assert.deepEqual(names(full, 'old_downloads'), ['old-backup.iso', 'old-pack.zip'], 'full: every Downloads subfolder');
  const big = full.result.cats.find((c) => c.id === 'big_files').items;
  assert.deepEqual(big.map((i) => path.join(i.dir, i.name)), [F.backup], 'only the backup outside Downloads — no game, program, Windows, other user or system file');
  assert.equal(big[0].dup, true, 'the same file is also in Downloads');
  assert.equal(full.result.cats.find((c) => c.id === 'old_downloads').items.find((i) => i.name === 'old-backup.iso').dup, true);
});

test('Startup programs can be switched off and on, heavy programs closed (demo)', async () => {
  const startup = require('../src/startup');
  const r = await startup.check();
  assert.equal(r.ok, true);
  const by = (n) => r.startup.find((s) => s.name === n);
  assert.equal(by('Discord').advice, 'off');
  assert.equal(by('SecurityHealth').advice, 'keep');
  assert.equal(by('RtkAudUService').advice, 'keep');
  assert.equal(by('Razer Synapse').advice, 'maybe');
  assert.equal(by('OneDrive').advice, 'maybe');
  assert.equal(by('Spotify').on, false, 'already off in Windows');
  assert.equal(by('Discord').running, true);
  assert.ok(by('Discord').mem > 0);
  assert.ok(r.heavy.some((h) => /chrome/i.test(h.path)), 'Chrome uses a lot');
  assert.equal(r.heavy.some((h) => /wallpaper/i.test(h.path)), false, 'programs in game libraries (the game you play) are not listed');
  const off = await startup.set(by('Discord').id, false);
  assert.equal(off.ok, true);
  assert.equal((await startup.check()).startup.find((s) => s.name === 'Discord').on, false, 'stays off');
  assert.equal((await startup.set(by('Discord').id, true)).on, true);
  const chrome = r.heavy.find((h) => /chrome/i.test(h.path));
  assert.equal((await startup.close(chrome.key)).ok, true);
  assert.equal((await startup.check()).heavy.some((h) => h.key === chrome.key), false);
  assert.equal((await startup.set('nope', false)).ok, false);
});
