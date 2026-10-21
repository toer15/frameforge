const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const handoff = require('../src/update-relaunch');

function fixture(version = '1.3.6') {
  const dir = fs.mkdtempSync(path.join(process.env.FRAMEFORGE_TEST_ARTIFACTS || os.tmpdir(), 'frameforge-update-test-'));
  const app = Object.assign(new EventEmitter(), { isPackaged: true, getVersion: () => version, getPath: () => dir });
  return { app, dir };
}

test('updated launch overrides hidden startup and consumes its handoff once', () => {
  const { app } = fixture();
  assert.equal(handoff.consume(app, ['--hidden', '--updated']), true);
  handoff.prepare(app, '1.3.6');
  assert.equal(handoff.consume(app, ['--hidden']), true);
  assert.equal(handoff.consume(app, ['--hidden']), false);
});

test('old version cannot consume the handoff; stale or malformed handoffs do not show the app', () => {
  const { app, dir } = fixture('1.3.5');
  handoff.prepare(app, '1.3.6');
  assert.equal(handoff.consume(app, []), false);
  assert.equal(handoff.consume({ ...app, getVersion: () => '1.3.6' }, []), true);
  fs.writeFileSync(path.join(dir, 'update-relaunch.json'), JSON.stringify({ version: '1.3.5', at: Date.now() - 25 * 60 * 60 * 1000 }));
  assert.equal(handoff.consume(app, []), false);
  fs.writeFileSync(path.join(dir, 'update-relaunch.json'), 'invalid');
  assert.equal(handoff.consume(app, []), false);
});

function updaterFixture() {
  const { app, dir } = fixture('1.3.5');
  const au = new EventEmitter();
  const calls = [];
  au.setFeedURL = () => {};
  au.quitAndInstall = (...args) => calls.push(args);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/updater.js'), 'utf8'), {
    require: (id) => ({ electron: { app }, 'electron-updater': { autoUpdater: au }, './update-relaunch': handoff, '../package.json': require('../package.json') })[id],
    module, process: { env: {} }, setTimeout: () => {}, setInterval: () => {},
  });
  const updater = module.exports.setup({ send: () => {}, getSettings: () => ({}) });
  return { app, dir, au, calls, updater };
}

test('manual update requests silent install and mandatory relaunch only once', () => {
  const { app, au, calls, updater } = updaterFixture();
  assert.equal(updater.install(), false);
  au.emit('update-downloaded', { version: '1.3.6' });
  assert.equal(updater.install(), true);
  assert.deepEqual(calls, [[true, true]]);
  assert.equal(updater.install(), false);
  assert.equal(handoff.consume({ ...app, getVersion: () => '1.3.6' }, []), true);
});

test('installing on quit also forces relaunch, then allows the installer quit through', () => {
  const { app, au, calls } = updaterFixture();
  assert.equal(au.autoInstallOnAppQuit, false);
  assert.equal(au.autoRunAppAfterInstall, true);
  au.emit('update-downloaded', { version: '1.3.6' });
  let prevented = 0;
  app.emit('before-quit', { preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.deepEqual(calls, [[true, true]]);
  app.emit('before-quit', { preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(calls.length, 1);
});

test('failed installer handoff reports an error and clears the pending relaunch', () => {
  const { dir, au, updater } = updaterFixture();
  au.emit('update-downloaded', { version: '1.3.6' });
  au.quitAndInstall = () => { throw Error('Installer could not start'); };
  assert.equal(updater.install(), false);
  assert.equal(updater.state.status, 'error');
  assert.equal(fs.existsSync(path.join(dir, 'update-relaunch.json')), false);
});
