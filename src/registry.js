// Thin wrapper around reg.exe so every change can be backed up and undone.
const { run } = require('./util');

/** Read one value. Returns { exists, type, data }. */
async function get(key, name) {
  const r = await run('reg', ['query', key, '/v', name]);
  if (r.code !== 0) return { exists: false };
  const line = r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ' ') || l.toLowerCase().startsWith(name.toLowerCase() + '\t'));
  if (!line) return { exists: false };
  const m = line.match(/^(.+?)\s+(REG_[A-Z_]+)\s*(.*)$/);
  if (!m) return { exists: false };
  return { exists: true, type: m[2], data: m[3] };
}

/** Write one value (creates the key if needed). */
async function set(key, name, type, data) {
  const r = await run('reg', ['add', key, '/v', name, '/t', type, '/d', String(data), '/f']);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'reg add failed').trim());
}

async function del(key, name) {
  await run('reg', ['delete', key, '/v', name, '/f']);
}

/** Every value in one key, with a single reg.exe call: Map(lowercase name → { name, type, data }). */
async function list(key) {
  const out = new Map();
  const r = await run('reg', ['query', key]);
  if (r.code !== 0) return out;
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^ {4}(.+?) {4}(REG_[A-Z_]+) {4}(.*)$/);
    if (m) out.set(m[1].toLowerCase(), { name: m[1], type: m[2], data: m[3] });
  }
  return out;
}

/** Names of the sub-keys of a key (full paths), e.g. every installed GOG game. */
async function subkeys(key) {
  const r = await run('reg', ['query', key]);
  if (r.code !== 0) return [];
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.toLowerCase().startsWith(key.toLowerCase().replace(/\\+$/, '') + '\\'));
}

module.exports = { get, set, del, list, subkeys };
