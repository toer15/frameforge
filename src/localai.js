// Free AI that runs on this PC, through Ollama. FrameForge finds Ollama, installs it, starts it and downloads
// the model you pick — so the AI chat works after one click on "Install".
//
// Installs only from verified sources:
//   1. Microsoft's winget store (package Ollama.Ollama — every download is checked against its SHA-256)
//   2. Otherwise Ollama's official GitHub release, checked against the SHA-256 GitHub publishes for it
// Models come from Ollama's own library, downloaded by Ollama itself (it checks every part's SHA-256).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { net, app } = require('electron');
const { run, IS_WIN, DEMO } = require('./util');
const { settings } = require('./store');
const tools = require('./tools');

const LOCAL_MODELS = [
  { id: 'llama3.1', name: 'Llama 3.1 8B', size: '4.9 GB', note: 'Best all-round answers' },
  { id: 'llama3.2', name: 'Llama 3.2 3B', size: '2.0 GB', note: 'Small and fast — fine on any PC' },
  { id: 'qwen2.5', name: 'Qwen 2.5 7B', size: '4.7 GB', note: 'Strong at technical questions' },
  { id: 'gemma3', name: 'Gemma 3 4B', size: '3.3 GB', note: 'Google’s small model' },
  { id: 'mistral', name: 'Mistral 7B', size: '4.1 GB', note: 'Quick and solid' },
];

const base = () => (settings.get().ollamaUrl || 'http://127.0.0.1:11434').replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Demo mode (Mac/Linux, or FRAMEFORGE_DEMO=1): pretends to install so the UI can be tried.
const demo = { installed: false, models: [] };

/** Where Ollama lives once installed (per-user install is the default; winget uses it too). */
function findOllama() {
  if (!IS_WIN) return null;
  const la = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dirs = [path.join(la, 'Programs', 'Ollama'), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama')];
  for (const d of dirs) {
    const exe = path.join(d, 'ollama.exe');
    if (fs.existsSync(exe)) {
      const tray = path.join(d, 'ollama app.exe');
      return { exe, tray: fs.existsSync(tray) ? tray : null };
    }
  }
  return null;
}

async function running() {
  if (DEMO) return demo.installed;
  try {
    const r = await net.fetch(`${base()}/api/version`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

async function installedModels() {
  if (DEMO) return demo.models.slice();
  const r = await net.fetch(`${base()}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`Couldn’t read Ollama’s installed models (${r.status}).`);
  const j = await r.json();
  if (!Array.isArray(j.models)) throw new Error('Ollama returned an invalid installed-model list.');
  return (j.models || []).map((m) => m.name);
}

/** "llama3.1" matches "llama3.1:latest"; "llama3.1:70b" only matches itself. */
function hasModel(list, id) {
  const want = id.includes(':') ? id : `${id}:latest`;
  return list.some((n) => n === id || n === want);
}

/** Start Ollama in the background if it's installed but not running. */
async function start() {
  if (DEMO) return demo.installed;
  if (await running()) return true;
  const o = findOllama();
  if (!o) return false;
  const { spawn } = require('child_process');
  // Ollama's own tray app starts the server and keeps it running; the plain server is the backup.
  const child = o.tray ? spawn(o.tray, [], { detached: true, stdio: 'ignore' }) : spawn(o.exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 75; i++) {
    await sleep(200);
    if (await running()) return true;
  }
  return false;
}

/** What the AI chat needs to know: is Ollama there, is it running, is the chosen model downloaded? */
async function status({ start: startIt = true } = {}) {
  const model = settings.get().ollamaModel || 'llama3.1';
  let up = await running();
  const found = DEMO ? demo.installed : !!findOllama();
  if (!up && found && startIt) up = await start();
  const models = up ? await installedModels().catch(() => []) : [];
  return { installed: found || up, running: up, model, ready: up && hasModel(models, model), models, catalog: LOCAL_MODELS, busy: !!(installing || removing) };
}

/** Install Ollama itself. */
async function installApp(progress, signal) {
  if (DEMO) {
    for (let i = 1; i <= 10; i++) {
      await sleep(60);
      progress({ stage: 'app', pct: i / 10, text: `Installing Ollama… ${i * 10}%` });
    }
    demo.installed = true;
    return;
  }
  if (await tools.hasWinget()) {
    progress({ stage: 'app', pct: null, text: 'Installing Ollama from Microsoft’s verified app store (about 1 GB — takes a few minutes)…' });
    if (await tools.wingetKnows('Ollama.Ollama')) {
      const r = await tools.wingetInstall('Ollama.Ollama');
      if (r.ok && findOllama()) return;
    }
  }
  // Backup: Ollama's official installer from its GitHub release, checked against GitHub's SHA-256 for it.
  progress({ stage: 'app', pct: 0, text: 'Downloading Ollama from its official GitHub release…' });
  const rel = await net.fetch('https://api.github.com/repos/ollama/ollama/releases/latest', { headers: { 'User-Agent': 'FrameForge', Accept: 'application/vnd.github+json' } });
  if (!rel.ok) throw new Error(`GitHub answered ${rel.status} when looking up Ollama.`);
  const j = await rel.json();
  const asset = (j.assets || []).find((a) => a.name === 'OllamaSetup.exe');
  if (!asset) throw new Error('The latest Ollama release has no Windows installer.');
  const sha = /^sha256:/.test(asset.digest || '') ? asset.digest.slice(7) : null;
  const file = path.join(app.getPath('temp'), 'FrameForge', 'OllamaSetup.exe');
  await tools.downloadFile(asset.browser_download_url, file, { signal, sha256: sha, onProgress: (p) => p != null && progress({ stage: 'app', pct: p, text: `Downloading Ollama ${j.tag_name || ''}… ${Math.round(p * 100)}%` }) });
  if (!sha) {
    const sig = await tools.verifySignature(file, /Ollama/i);
    if (!sig.ok) {
      fs.rmSync(file, { force: true });
      throw new Error('Ollama’s installer couldn’t be verified (no fingerprint and no valid signature), so it wasn’t run.');
    }
  }
  progress({ stage: 'app', pct: null, text: 'Installing Ollama…' });
  await run(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], { timeout: 15 * 60 * 1000 });
  fs.rmSync(file, { force: true });
  if (!findOllama()) throw new Error('Ollama’s installer finished, but Ollama wasn’t found afterwards.');
}

/** Download a model with Ollama, reporting overall progress across all its parts. */
async function pull(model, progress, signal) {
  if (DEMO) {
    for (let i = 1; i <= 20; i++) {
      if (signal && signal.aborted) throw new Error('Stopped.');
      await sleep(60);
      progress({ stage: 'model', pct: i / 20, text: `${(i * 0.1).toFixed(1)} of 2.0 GB · every part is checked against its fingerprint` });
    }
    demo.models.push(model.includes(':') ? model : `${model}:latest`);
    return;
  }
  const res = await net.fetch(`${base()}/api/pull`, { method: 'POST', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
  if (!res.ok) throw new Error(`Ollama answered with an error (${res.status}).`);
  const parts = new Map(); // digest -> { total, completed }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let ok = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.error) throw new Error(/file does not exist|not found/i.test(e.error) ? `Ollama’s library has no model called “${model}”. Check the name on ollama.com/library.` : `Ollama: ${e.error}`);
      if (e.digest && e.total) parts.set(e.digest, { total: e.total, completed: e.completed || 0 });
      const total = [...parts.values()].reduce((a, p) => a + p.total, 0);
      const got = [...parts.values()].reduce((a, p) => a + p.completed, 0);
      const gb = (n) => (n / 1024 ** 3).toFixed(1);
      if (e.status === 'success') ok = true;
      progress({
        stage: 'model',
        pct: total ? got / total : null,
        text: total && /pulling/i.test(e.status || '') ? `${gb(got)} of ${gb(total)} GB · every part is checked against its fingerprint` : /verifying/i.test(e.status || '') ? 'Checking the download’s fingerprint…' : `${(e.status || 'Working').replace(/^./, (c) => c.toUpperCase())}…`,
      });
    }
  }
  if (!ok) throw new Error('The download stopped before it finished — press Install to carry on where it left off.');
}

let installing = null;
let removing = null;
/** Everything the chosen model needs: Ollama itself, running, and the model downloaded. */
async function install(model, progress = () => {}) {
  if (installing || removing) return { ok: false, busy: true, message: 'Another model operation is still running.' };
  installing = new AbortController();
  try {
    if (!(DEMO ? demo.installed : findOllama() || (await running()))) await installApp(progress, installing.signal);
    progress({ stage: 'start', pct: null, text: 'Starting Ollama…' });
    if (!(await start())) throw new Error('Ollama is installed but didn’t start. Restart the PC and press Install again.');
    const have = await installedModels().catch(() => []);
    if (!hasModel(have, model)) await pull(model, progress, installing.signal);
    const name = (LOCAL_MODELS.find((m) => m.id === model) || { name: model }).name;
    progress({ stage: 'done', pct: 1, text: `${name} is installed and ready.` });
    return { ok: true, message: `${name} is installed — the AI runs on your PC, free.` };
  } catch (e) {
    const msg = installing && installing.signal.aborted ? 'Install stopped.' : String(e.message || e);
    progress({ stage: 'error', pct: null, text: msg });
    return { ok: false, message: msg };
  } finally {
    installing = null;
  }
}
function cancel() {
  if (installing) installing.abort();
  return true;
}

/** Remove exactly the selected model/tag through Ollama and verify that it is gone. */
async function uninstall(model) {
  if (installing || removing) return { ok: false, busy: true, message: 'Another model operation is still running.' };
  if (typeof model !== 'string' || !/^[a-z0-9][a-z0-9._\-/:]{0,80}$/i.test(model)) return { ok: false, message: 'That doesn’t look like an Ollama model name.' };
  removing = model;
  try {
    if (!(await start())) throw new Error('Ollama couldn’t start. Start it and try uninstalling again.');
    const have = await installedModels();
    const target = have.find((name) => name === model || name === (model.includes(':') ? model : `${model}:latest`));
    if (!target) return { ok: true, message: 'That AI model is already uninstalled.' };
    if (DEMO) demo.models = have.filter((name) => name !== target);
    else {
      const unloaded = await net.fetch(`${base()}/api/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: target, keep_alive: 0, stream: false }), signal: AbortSignal.timeout(30000),
      });
      if (!unloaded.ok && unloaded.status !== 404) throw new Error(`Ollama couldn’t unload the model (${unloaded.status}).`);
      const removed = await net.fetch(`${base()}/api/delete`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: target }), signal: AbortSignal.timeout(30000),
      });
      if (!removed.ok && removed.status !== 404) throw new Error(`Ollama couldn’t uninstall the model (${removed.status}).`);
    }
    if (hasModel(await installedModels(), model)) throw new Error('Ollama still lists this model as installed. Please try again.');
    const name = (LOCAL_MODELS.find((m) => m.id === model) || { name: model }).name;
    return { ok: true, message: `${name} is uninstalled. You can install it again any time.` };
  } catch (e) {
    return { ok: false, message: String(e.message || e) };
  } finally {
    removing = null;
  }
}

module.exports = { LOCAL_MODELS, status, install, uninstall, removing: () => !!removing, cancel, start, findOllama, hasModel };
