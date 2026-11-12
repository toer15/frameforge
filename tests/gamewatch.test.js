const { test } = require('node:test');
const assert = require('node:assert/strict');
const { GameWatch, isDesktopApp } = require('../src/gamewatch');

/** Feed one reading a second for `secs` seconds; returns the time afterwards. */
function feed(w, from, secs, reading) {
  for (let i = 0; i < secs; i++) w.update({ ...reading, now: from + i * 1000 });
  return from + secs * 1000;
}

test('browsers, chat, music and the desktop are never a game', () => {
  for (const n of ['chrome', 'msedge', 'Discord', 'Spotify', 'explorer', 'steamwebhelper', 'wallpaper64', 'WindowsTerminal', 'obs64', '']) assert.equal(isDesktopApp(n), true, n);
  for (const n of ['eldenring', 'cs2', 'FortniteClient-Win64-Shipping', 'RobloxPlayerBeta', 'javaw']) assert.equal(isDesktopApp(n), false, n);
});

test('a browser drawing frames all day is not a game — this is what kept Fix mode waiting forever', () => {
  const w = new GameWatch();
  let now = 1000000;
  now = feed(w, now, 600, { fps: { app: 'chrome', fps: 60 }, gpuLoad: 85 }); // ten minutes of 4K video
  assert.equal(w.running(now), false);
  now = feed(w, now, 600, { fps: { app: 'Discord', fps: 30 }, gpuLoad: 10 });
  assert.equal(w.running(now), false);
});

test('a real game counts after 10 steady seconds, and for 60 seconds after it closes', () => {
  const w = new GameWatch();
  let now = 1000000;
  now = feed(w, now, 9, { fps: { app: 'eldenring', fps: 120 }, gpuLoad: 95 });
  assert.equal(w.running(now), false, 'not yet: could be a loading splash or a launcher');
  now = feed(w, now, 5, { fps: { app: 'eldenring', fps: 120 }, gpuLoad: 95 });
  assert.equal(w.running(now), true);
  assert.equal(w.name, 'eldenring');
  now = feed(w, now, 30, { fps: null, gpuLoad: 5 }); // closed
  assert.equal(w.running(now), true, 'still within the minute after');
  now = feed(w, now, 40, { fps: null, gpuLoad: 5 });
  assert.equal(w.running(now), false);
});

test('a short burst of frames from some app is not a game', () => {
  const w = new GameWatch();
  let now = 1000000;
  for (let i = 0; i < 20; i++) {
    now = feed(w, now, 4, { fps: { app: 'someapp', fps: 60 }, gpuLoad: 20 }); // scrolling
    now = feed(w, now, 3, { fps: { app: 'someapp', fps: 3 }, gpuLoad: 5 }); // reading
  }
  assert.equal(w.running(now), false);
});

test('without FPS data the graphics card decides: 70 % for 20 seconds', () => {
  const w = new GameWatch();
  let now = 1000000;
  now = feed(w, now, 15, { gpuLoad: 90 });
  assert.equal(w.running(now), false);
  now = feed(w, now, 10, { gpuLoad: 90 });
  assert.equal(w.running(now), true);
  const idle = new GameWatch();
  assert.equal(idle.running(feed(idle, 1000000, 300, { gpuLoad: 30 })), false);
});
