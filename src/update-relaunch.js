// One-use handoff from the old version to the updated app, alongside NSIS's --updated flag.
const fs = require('fs');
const path = require('path');
const markerPath = (app) => path.join(app.getPath('userData'), 'update-relaunch.json');

function clear(app) {
  fs.rmSync(markerPath(app), { force: true });
}

function prepare(app, version) {
  if (!version) throw new Error('The downloaded update has no version.');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(markerPath(app), JSON.stringify({ version, at: Date.now() }));
}

function consume(app, args = process.argv) {
  let pending = false;
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath(app), 'utf8'));
    const age = Date.now() - marker.at;
    const fresh = Number.isFinite(age) && age >= 0 && age < 24 * 60 * 60 * 1000;
    pending = fresh && marker.version === app.getVersion();
    // Keep the handoff if an old version launches before the installer has finished.
    if (pending || !fresh) clear(app);
  } catch {}
  return args.includes('--updated') || pending;
}

module.exports = { prepare, consume, clear };
