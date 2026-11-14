const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FpsReader } = require('../src/fps');

/** Feed `count` frames of `ms` milliseconds each, ending at `at`. */
function feed(reader, app, ms, count, at, name = app) {
  for (let i = 0; i < count; i++) reader.push(app, ms, at, name);
}

test('PresentMon headers are read however they are quoted, padded or marked', () => {
  const r = new FpsReader();
  r.onLine('\uFEFF Application , ProcessID , MsBetweenPresents , MsBetweenDisplayChange ');
  r.onLine(' FortniteClient-Win64-Shipping.exe ,4242, 8.333 , 8.333 ');
  const s = r.read();
  assert.equal(s.app, 'FortniteClient-Win64-Shipping');
  assert.equal(s.fps, 120);
  assert.equal(s.live, true);
});

test('FPS is measured from frame times, and the last second is what counts', () => {
  const r = new FpsReader();
  feed(r, 'game.exe', 16.667, 60, 1000);
  let s = r.read(1000);
  assert.equal(s.fps, 60);
  assert.equal(s.frametime, 16.7);
  assert.equal(s.live, true);
  // A new 1-second window at 144 FPS: the old 60 FPS frames must not water it down.
  feed(r, 'game.exe', 6.944, 145, 2000);
  s = r.read(2000);
  assert.equal(s.fps, 144);
  assert.ok(s.low1 <= s.fps);
});

test('a lobby at a low frame rate still shows its live FPS', () => {
  const r = new FpsReader();
  // 30 FPS menu. gamewatch would need 10 s at 20+ FPS to call this a game; the counter must not wait.
  feed(r, 'fortniteclient-win64-shipping.exe', 33.333, 30, 5000);
  const s = r.read(5000);
  assert.equal(s.fps, 30);
  assert.equal(s.live, true);
});

test('the game beats browsers and launchers, even when they draw more frames', () => {
  const r = new FpsReader();
  feed(r, 'chrome.exe', 3.333, 300, 1000);
  feed(r, 'riotclientservices.exe', 5, 200, 1000);
  feed(r, 'valorant-win64-shipping.exe', 16.667, 60, 1000);
  const s = r.read(1000);
  assert.equal(s.app, 'valorant-win64-shipping');
  assert.equal(s.fps, 60);
});

test('the last real reading bridges loading screens, then stops rather than inventing one', () => {
  const r = new FpsReader();
  feed(r, 'game.exe', 16.667, 60, 1000);
  const held = r.read(4000); // 3 s later: last real measurement, marked as not live
  assert.equal(held.fps, 60);
  assert.equal(held.live, false);
  assert.equal(r.read(7000), null, 'after five seconds with no frames there is nothing honest to show');
});

test('a live app beats a game that stopped presenting (alt-tabbed to the desktop)', () => {
  const r = new FpsReader();
  feed(r, 'game.exe', 3.33, 300, 1000);
  feed(r, 'msedge.exe', 16.667, 60, 4000);
  const s = r.read(4000);
  assert.equal(s.app, 'msedge', 'the browser is what is drawing now');
  assert.equal(s.live, true);
});

test('1% low follows the slowest frames, not the average', () => {
  const r = new FpsReader();
  // 99 fast frames and one 100 ms hitch: average stays high, the 1% low must not.
  feed(r, 'game.exe', 8, 99, 1000);
  r.push('game.exe', 100, 1000);
  const s = r.read(1000);
  assert.ok(s.fps > 100, `live FPS ${s.fps}`);
  assert.ok(s.low1 < s.fps, `1% low ${s.low1} should be below ${s.fps}`);
});

test('the reader stops cleanly without PresentMon', async () => {
  const r = new FpsReader();
  feed(r, 'game.exe', 16.667, 10, 1000);
  await r.stop(null);
  assert.equal(r.running, false);
  assert.equal(r.read(1000), null);
});
