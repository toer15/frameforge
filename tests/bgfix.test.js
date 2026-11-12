const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Attempts, whenFixed, momentOk, delayAfter, IDLE_MIN } = require('../src/bgfix');

const MIN = 60 * 1000;
const item = (o = {}) => ({ id: 'step_x', strategies: [{ id: 'retry:x' }], bg: 'quiet', ...o });
const ctx = (o = {}) => ({ autoFix: true, autoRestart: true, mayRestart: true, admin: true, game: false, idleMin: 0, attempt: null, now: 1000000, ...o });

test('a fix that doesn’t stick is retried after 5 minutes, then 30, then every 6 hours', () => {
  assert.deepEqual([1, 2, 3, 4, 9].map(delayAfter), [5 * MIN, 30 * MIN, 360 * MIN, 360 * MIN, 360 * MIN]);
  const a = new Attempts();
  let now = 0;
  assert.equal(a.due('p', now), true, 'never tried: due at once');
  a.record('p', false, now);
  assert.equal(a.due('p', now + 4 * MIN), false);
  assert.equal(a.due('p', now + 5 * MIN), true);
  now += 5 * MIN;
  a.record('p', false, now);
  assert.equal(a.due('p', now + 29 * MIN), false);
  assert.equal(a.due('p', now + 30 * MIN), true);
  now += 30 * MIN;
  a.record('p', false, now);
  assert.equal(a.due('p', now + 359 * MIN), false, 'no loop: third and later failures wait 6 hours');
  assert.equal(a.due('p', now + 360 * MIN), true);
});

test('fixed problems and problems that went away are forgotten, so they start fresh next time', () => {
  const a = new Attempts();
  a.record('p', false, 0);
  a.record('q', false, 0);
  a.record('p', true, 1);
  assert.equal(a.get('p'), null);
  assert.equal(a.due('p', 2), true);
  a.keepOnly(['other']);
  assert.equal(a.get('q'), null);
  assert.equal(a.due('q', 2), true);
});

test('the right moment: any time, not during a game, or only while away', () => {
  assert.equal(momentOk(item({ bg: 'game' }), { game: true, idleMin: 0 }), true);
  assert.equal(momentOk(item({ bg: 'quiet' }), { game: true, idleMin: 0 }), false);
  assert.equal(momentOk(item({ bg: 'quiet' }), { game: false, idleMin: 0 }), true);
  assert.equal(momentOk(item({ bg: 'idle' }), { game: false, idleMin: IDLE_MIN - 1 }), false);
  assert.equal(momentOk(item({ bg: 'idle' }), { game: false, idleMin: IDLE_MIN }), true);
  assert.equal(momentOk(item({ bg: 'idle' }), { game: true, idleMin: 60 }), false);
  assert.equal(momentOk(item({ bg: false }), { game: false, idleMin: 60 }), false, 'never without asking');
  assert.equal(momentOk(item({ strategies: [] }), { game: false, idleMin: 60 }), false, 'nothing FrameForge can do');
});

test('every problem says what it is waiting for', () => {
  assert.equal(whenFixed(item(), ctx()).kind, 'soon');
  assert.match(whenFixed(item(), ctx({ game: true })).text, /until your game is closed/);
  assert.equal(whenFixed(item({ bg: 'game' }), ctx({ game: true })).kind, 'soon');
  assert.match(whenFixed(item({ bg: 'idle' }), ctx()).text, /away for 5 minutes/);
  assert.equal(whenFixed(item({ bg: 'idle' }), ctx({ idleMin: 6 })).kind, 'soon');
  assert.match(whenFixed(item(), ctx({ autoFix: false })).text, /switched off/);
  assert.match(whenFixed(item(), ctx({ admin: false })).text, /administrator rights/);
  assert.match(whenFixed(item({ bg: undefined }), ctx()).text, /asks first/);
  assert.match(whenFixed(item({ strategies: [], manual: ['a'] }), ctx()).text, /Needs you/);
  assert.match(whenFixed(item({ strategies: [] }), ctx()).text, /for your information/);
  assert.match(whenFixed({ id: 'not_admin', strategies: [{ id: 'admin' }] }, ctx()).text, /Restart as administrator/);

  const tried = whenFixed(item(), ctx({ attempt: { n: 1, at: 1000000 - 2 * MIN } }));
  assert.equal(tried.kind, 'wait');
  assert.match(tried.text, /tried once .* in 3 minutes/);
  assert.match(whenFixed(item(), ctx({ attempt: { n: 3, at: 1000000 - 60 * MIN } })).text, /tried 3 times .* in 5 hours/);
  assert.equal(whenFixed(item(), ctx({ attempt: { n: 1, at: 1000000 - 6 * MIN } })).kind, 'soon', 'the wait is over');

  const restart = { id: 'restart', restartItem: true, strategies: [] };
  assert.match(whenFixed(restart, ctx()).text, /away for 20 minutes/);
  assert.equal(whenFixed(restart, ctx({ autoRestart: false })).kind, 'you');
  assert.match(whenFixed(restart, ctx({ mayRestart: false })).text, /last 3 hours/);
});
