// Runs a virus scan from start to finish: count files → scan with Defender's engine → Defender's memory/system
// check → false-positive analysis → results. Also applies what the user picked for each detection.
const fs = require('fs');
const path = require('path');
const { app, powerSaveBlocker } = require('electron');
const { ps, IS_WIN, DEMO } = require('./util');
const { settings, changes } = require('./store');
const scanner = require('./scanner');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (n) => path.join(app.getPath('userData'), n);
const readJson = (n, d) => {
  try {
    return JSON.parse(fs.readFileSync(file(n), 'utf8'));
  } catch {
    return d;
  }
};
const writeJson = (n, v) => {
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  fs.writeFileSync(file(n), JSON.stringify(v));
};

const DEFAULT_RATE = 450; // files per second — replaced by what this PC really does after the first scan
let job = null;
let send = () => {};
let onFinished = () => {};

function init(opts) {
  send = opts.send;
  onFinished = opts.onFinished || (() => {});
}

// ---------------------------------------------------------------- Estimates
function rate() {
  return settings.get().scanRate || DEFAULT_RATE;
}
async function usedGB() {
  try {
    const si = require('systeminformation');
    const all = await si.fsSize();
    return Math.round(all.filter((f) => /^[a-z]:/i.test(f.mount || f.fs || '') || !IS_WIN).reduce((a, f) => a + (f.used || 0), 0) / 1024 ** 3);
  } catch {
    return 300;
  }
}
async function estimates() {
  const st = settings.get().scanStats || {};
  const gb = DEMO ? 512 : await usedGB();
  const fullFiles = st.full && st.full.files ? st.full.files * (gb / Math.max(1, st.full.gb || gb)) : gb * 2400; // ~2,400 files per GB on a typical gaming PC
  return {
    quick: { sec: st.quick ? st.quick.sec : 180, learned: !!st.quick },
    full: { sec: st.full ? st.full.sec * (gb / Math.max(1, st.full.gb || gb)) : fullFiles / rate() + 120, learned: !!st.full, files: Math.round(fullFiles), gb },
  };
}

// ---------------------------------------------------------------- Progress
/** Milliseconds this scan has spent paused (so pausing doesn't wreck the elapsed time or the speed estimate). */
function pausedMs(now = Date.now()) {
  return (job.pausedMs || 0) + (job.paused ? now - job.pauseStarted : 0);
}
function snapshot() {
  if (!job) return null;
  const now = Date.now();
  const scanSec = job.scanStart ? Math.max(0, now - job.scanStart - pausedMs(now)) / 1000 : 0;
  // Live speed: blend this PC's learned speed with what this scan measures, trusting the measurement more over time.
  const measured = scanSec > 10 && job.filesDone > 0 ? job.filesDone / scanSec : null;
  const w = measured ? Math.min(1, scanSec / 90) : 0;
  const r = measured ? measured * w + rate() * (1 - w) : rate();
  job.liveRate = r;
  // Files in scans that are running right now count as they go.
  let inFlight = 0;
  for (const c of job.running.values()) inFlight += Math.min(c.count * 0.95, (Math.max(0, now - c.at - (job.paused ? now - job.pauseStarted : 0)) / 1000) * (r / Math.max(1, job.running.size)));
  const done = Math.min(job.filesTotal, job.filesDone + inFlight);
  const left = Math.max(0, job.filesTotal - done);
  const extra = job.memoryPending ? 90 : job.phase === 'memory' ? Math.max(10, 90 - (now - job.memoryAt) / 1000) : job.phase === 'analyze' ? 10 : 0;
  const eta = job.phase === 'count' || job.phase === 'update' ? null : Math.round(left / r + extra);
  const total = job.filesTotal + (job.memoryWeight || 0);
  const pct = job.phase === 'count' || job.phase === 'update' ? 0 : job.phase === 'analyze' ? 0.99 : Math.min(0.99, (done + (job.phase === 'memory' ? Math.min(job.memoryWeight, ((now - job.memoryAt) / 90000) * job.memoryWeight) : 0)) / Math.max(1, total));
  return {
    type: job.type,
    background: job.background,
    phase: job.phase,
    phaseText: job.phaseText,
    filesDone: Math.round(done),
    filesTotal: job.filesTotal,
    counted: job.counted,
    pct,
    elapsedSec: Math.round(Math.max(0, now - job.startedAt - pausedMs(now)) / 1000),
    etaSec: eta,
    current: job.current,
    counts: job.counts,
    found: job.detections.size,
    paused: !!job.paused,
    autoPaused: !!job.autoPaused,
    pausable: job.phase === 'scan' && !job.cancelled,
    recent: job.recent,
  };
}
function setPhase(phase, text) {
  job.phase = phase;
  job.phaseText = text;
  send('scan:progress', snapshot());
}

// ---------------------------------------------------------------- Detections
function addDetection(d) {
  const key = `${(d.file || '').toLowerCase()}|${d.threat}`;
  if (job.detections.has(key)) return;
  job.detections.set(key, d);
  // Live counter by quick verdict from the name alone; the full analysis runs at the end.
  const k = scanner.kindOf(d.threat);
  const quick = k === 'test' ? 'test' : k === 'unwanted' ? 'pua' : 'real';
  job.counts[quick] = (job.counts[quick] || 0) + 1;
  // The newest few, shown live while the scan runs.
  job.recent = [{ threat: d.threat, file: d.file || (d.other || [])[0] || '', kind: quick }, ...(job.recent || [])].slice(0, 6);
}

/** Wait while the scan is paused (the scan jobs already running finish first). */
async function whilePaused() {
  while (job && job.paused && !job.cancelled) await sleep(300);
}

async function runJobs(list, concurrency) {
  let i = 0;
  const worker = async () => {
    while (i < list.length && !job.cancelled) {
      await whilePaused();
      if (job.cancelled) break;
      const j = list[i++];
      const token = {};
      job.running.set(token, { count: j.count, at: Date.now() });
      job.current = j.path;
      const r = await scanner.runMp(['-Scan', '-ScanType', '3', '-File', j.path, '-DisableRemediation'], { lowPriority: job.background });
      job.running.delete(token);
      if (job.cancelled) break;
      const { dets, hr } = scanner.parseMp(r.out);
      if (hr && /0x800106ba/i.test(hr)) {
        job.fatal = scanner.HR_TEXT['0x800106ba'];
        job.cancelled = true;
        break;
      }
      if (r.error && !job.errorNoted) {
        job.errorNoted = true;
        job.notes.push(r.error);
      }
      for (const d of dets) for (const f of d.files.length ? d.files : [null]) addDetection({ threat: d.threat, file: f ? scanner.resolvePath(f) : null, other: d.other, source: 'scan' });
      job.filesDone += j.count;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
}

async function fixedDrives() {
  if (!IS_WIN) return [];
  const r = await ps("@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | %{ $_.DeviceID }) -join ','");
  return r.stdout
    .trim()
    .split(',')
    .filter((d) => /^[A-Z]:$/i.test(d))
    .map((d) => d + '\\');
}

// ---------------------------------------------------------------- Demo (Mac/Linux, or FRAMEFORGE_DEMO=1)
const DEMO_FOUND = [
  { at: 0.18, threat: 'Trojan:Win32/Lumma.GA!MTB', file: 'C:\\Users\\Tommy\\Downloads\\FreeRobux_Generator_v3.exe', s: { exists: true, signed: false, size: 4404019 } },
  { at: 0.34, threat: 'Trojan:Win32/CoinMiner!MTB', file: 'C:\\Users\\Tommy\\AppData\\Roaming\\svchosts.exe', s: { exists: true, signed: false, running: true, size: 2621440 } },
  { at: 0.52, threat: 'Trojan:Win32/Wacatac.B!ml', file: 'C:\\Program Files\\PixelForge Studio\\PixelForge.exe', s: { exists: true, signed: true, signer: 'PixelForge Software Ltd', known: { source: 'NIST NSRL' }, size: 18350080 } },
  { at: 0.67, threat: 'Program:Win32/Contebrew.A!ml', file: 'C:\\Games\\SteamLibrary\\steamapps\\common\\Hollow Drift\\HollowDrift.exe', s: { exists: true, signed: true, signer: 'Driftwood Games AB', size: 96468992 } },
  { at: 0.81, threat: 'HackTool:Win32/Winring0', file: 'C:\\Program Files\\RGB Fusion Tool\\WinRing0x64.sys', s: { exists: true, signed: true, signer: 'Noriyuki MIYAZAKI', size: 14544 } },
];
const demoSignals = new Map(DEMO_FOUND.map((d) => [d.file.toLowerCase(), d.s]));

async function demoRun() {
  const quick = job.type === 'quick';
  setPhase('update', 'Updating virus definitions…');
  await sleep(1200);
  setPhase('count', quick ? 'Finding running programs, startup items and risky folders…' : 'Counting every file on your drives…');
  const total = quick ? 48213 : job.type === 'custom' ? 9120 : 1284551;
  for (let i = 1; i <= 10 && !job.cancelled; i++) {
    job.counted = Math.round((total * i) / 10);
    send('scan:progress', snapshot());
    await sleep(quick ? 120 : 260);
  }
  job.filesTotal = total;
  job.memoryWeight = quick || job.type === 'full' ? Math.round(total * 0.05) : 0;
  job.memoryPending = job.memoryWeight > 0;
  setPhase('scan', 'Scanning files with Microsoft Defender’s engine…');
  job.scanStart = Date.now();
  const steps = quick ? 40 : 90;
  const folders = quick ? ['C:\\Users\\Tommy\\Downloads', 'C:\\Users\\Tommy\\AppData\\Roaming', 'C:\\Users\\Tommy\\Desktop', 'C:\\Program Files\\Discord'] : ['C:\\Program Files', 'C:\\Games\\SteamLibrary\\steamapps\\common', 'C:\\Users\\Tommy\\AppData', 'C:\\Windows\\System32', 'D:\\Games'];
  settings.set({ scanRate: settings.get().scanRate || total / (steps * 0.25) });
  for (let i = 1; i <= steps && !job.cancelled; i++) {
    await whilePaused();
    job.filesDone = Math.round((total * i) / steps);
    job.current = `${folders[i % folders.length]}\\…`;
    for (const d of DEMO_FOUND) if (Math.abs(d.at - i / steps) < 0.5 / steps && (!quick || !d.file.includes('SteamLibrary'))) addDetection({ threat: d.threat, file: d.file, source: 'scan' });
    send('scan:progress', snapshot());
    await sleep(250);
  }
  if (job.memoryPending && !job.cancelled) {
    job.memoryPending = false;
    job.memoryAt = Date.now();
    setPhase('memory', 'Microsoft Defender is checking memory, boot sectors and startup entries…');
    await sleep(2200);
  }
}

// ---------------------------------------------------------------- The real scan
async function realRun() {
  const eng = await scanner.engineStatus();
  if (!eng.available) {
    job.fatal = eng.reason;
    return;
  }
  if (eng.sigAgeHours == null || eng.sigAgeHours > 6) {
    setPhase('update', 'Updating virus definitions from Microsoft…');
    const u = await scanner.runMp(['-SignatureUpdate'], { timeout: 5 * 60 * 1000 });
    if (u.code !== 0) job.notes.push('Virus definitions couldn’t be updated (offline?) — scanned with the ones already on the PC.');
  }
  if (job.cancelled) return;
  setPhase('count', job.type === 'quick' ? 'Finding running programs, startup items and risky folders…' : job.type === 'full' ? 'Counting every file on your drives…' : 'Counting the files in that folder…');
  const st = { files: 0, dirs: 0, cancelled: false, onTick: () => {
    job.counted = st.files;
    st.cancelled = job.cancelled;
    send('scan:progress', snapshot());
  } };
  const fileJobs = [];
  const folderJobs = [];
  if (job.type === 'quick') {
    const a = await scanner.autostartFiles();
    job.runningFiles = a.running;
    for (const f of a.files) fileJobs.push({ path: f, count: 1 });
    for (const dir of scanner.quickFolders()) {
      const node = await scanner.walk(dir, st);
      scanner.planChunks(node, 20000, folderJobs);
    }
  } else if (job.type === 'custom' && fs.existsSync(job.folder) && fs.statSync(job.folder).isFile()) {
    fileJobs.push({ path: job.folder, count: 1 }); // one file picked
  } else {
    const roots = job.type === 'full' ? await fixedDrives() : [job.folder];
    let nodes = [];
    for (const r of roots) nodes.push(await scanner.walk(r, st));
    const total = nodes.reduce((a, n) => a + n.total, 0);
    const limit = Math.max(15000, Math.ceil(total / 120));
    for (const n of nodes) scanner.planChunks(n, limit, folderJobs);
    nodes = null;
  }
  const all = [...fileJobs, ...folderJobs];
  job.filesTotal = all.reduce((a, j) => a + j.count, 0);
  job.counted = job.filesTotal;
  job.memoryWeight = job.type === 'custom' ? 0 : Math.max(2000, Math.round(job.filesTotal * 0.04));
  job.memoryPending = job.memoryWeight > 0;
  if (job.cancelled) return;
  setPhase('scan', 'Scanning files with Microsoft Defender’s engine…');
  job.scanStart = Date.now();
  await runJobs(fileJobs, job.background ? 2 : 4); // a background scan uses fewer scan processes and runs at low priority
  await runJobs(folderJobs, job.background ? 1 : 2);
  if (job.memoryPending && !job.cancelled) {
    // Defender's own quick scan covers what file scans can't: programs in memory, boot sectors, registry startup
    // entries. It removes active threats in memory right away; they're listed with the results.
    job.memoryPending = false;
    job.memoryAt = Date.now();
    setPhase('memory', 'Microsoft Defender is checking memory, boot sectors and startup entries…');
    const since = Date.now() - 5000;
    job.current = 'Memory, boot sectors and startup entries';
    await scanner.runMp(['-Scan', '-ScanType', '1'], { timeout: 60 * 60 * 1000, lowPriority: job.background });
    for (const h of await scanner.history()) if (Date.parse(h.at) >= since) addDetection({ ...h, source: 'memory' });
  }
}

// ---------------------------------------------------------------- Analysis: real or false positive?
async function analyze(dets) {
  const items = [];
  const files = [...new Set(dets.map((d) => d.file).filter((f) => f && (DEMO ? demoSignals.has(f.toLowerCase()) : fs.existsSync(f))))];
  const sigs = DEMO ? {} : await scanner.signatures(files);
  const running = job && job.runningFiles ? job.runningFiles : DEMO ? new Set() : (await scanner.autostartFiles().catch(() => ({ running: new Set() }))).running;
  const facts = {};
  let k = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (k < files.length) {
        const f = files[k++];
        if (DEMO) {
          const s = demoSignals.get(f.toLowerCase());
          facts[f.toLowerCase()] = { ...s, sha256: require('crypto').createHash('sha256').update(f).digest('hex'), lookup: s.known ? 'listed' : 'notlisted' };
          continue;
        }
        let size = 0;
        try {
          size = fs.statSync(f).size;
        } catch {}
        const hash = size < 2 * 1024 ** 3 ? await scanner.sha256(f) : null;
        const sig = sigs[f.toLowerCase()] || {};
        const look = await scanner.knownLookup(hash);
        facts[f.toLowerCase()] = { exists: fs.existsSync(f), size, sha256: hash, signed: sig.status === 'Valid', signer: sig.signer, sigStatus: sig.status || '', known: look.info, lookup: look.state, running: running.has(f.toLowerCase()) };
      }
    })
  );
  for (const d of dets) {
    const f = d.file;
    const fact = (f && facts[f.toLowerCase()]) || { exists: false };
    const status = d.status || (fact.exists ? 'active' : 'gone');
    const v = scanner.verdict(d.threat, f || '', { ...fact, exists: !!fact.exists && status === 'active' });
    const n = scanner.parseName(d.threat);
    const kind = scanner.kindOf(d.threat);
    const typeKey = kind === 'test' ? 'test' : n.type.toLowerCase();
    let actions = [];
    let def = 'keep';
    if (status === 'active') {
      actions = ['quarantine', 'delete', 'keep'];
      if (['fp', 'unsure', 'pua'].includes(v.verdict)) actions.push('allow');
      def = v.verdict === 'fp' ? 'keep' : v.verdict === 'test' ? 'delete' : 'quarantine';
    } else if (status === 'quarantined') {
      actions = ['keepq', 'restore'];
      def = 'keepq';
    }
    items.push({
      id: require('crypto').createHash('sha1').update(`${(f || '').toLowerCase()}|${d.threat}|${d.source === 'defender' ? d.at : ''}`).digest('hex').slice(0, 16),
      threat: d.threat,
      type: n.type || 'Threat',
      platform: n.platform,
      family: n.family,
      kind,
      typeInfo: scanner.TYPE_INFO[typeKey] || 'Something Microsoft Defender flags as harmful.',
      verdict: v.verdict,
      score: v.score,
      reasons: v.reasons,
      file: f,
      other: d.other || [],
      status,
      running: !!fact.running,
      size: fact.size || 0,
      sha256: fact.sha256 || null,
      signer: fact.signed ? fact.signer || 'a valid publisher' : '',
      sigStatus: fact.sigStatus || (fact.signed ? 'Valid' : fact.exists ? 'NotSigned' : ''),
      known: fact.known || null,
      lookup: fact.lookup || (fact.known ? 'listed' : fact.sha256 ? 'notlisted' : 'nohash'),
      source: d.source,
      detectedAt: d.at || new Date().toISOString(),
      actions,
      defaultAction: def,
      done: null,
    });
  }
  const order = { real: 0, unsure: 1, pua: 2, test: 3, fp: 4 };
  items.sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || order[a.verdict] - order[b.verdict]);
  return items;
}
function countsOf(items) {
  const c = { real: 0, fp: 0, pua: 0, unsure: 0, test: 0 };
  for (const it of items) c[it.verdict] = (c[it.verdict] || 0) + 1;
  return c;
}

/** Everything FrameForge and Defender have ever found on this PC, by verdict. */
function remember(items) {
  const seen = readJson('scan-seen.json', {});
  for (const it of items) seen[`${(it.file || '').toLowerCase()}|${it.threat}`] = { verdict: it.verdict, threat: it.threat, file: it.file, at: it.detectedAt };
  writeJson('scan-seen.json', seen);
  return seen;
}
function totals() {
  const c = { real: 0, fp: 0, pua: 0, unsure: 0, test: 0, all: 0 };
  for (const v of Object.values(readJson('scan-seen.json', {}))) {
    c[v.verdict] = (c[v.verdict] || 0) + 1;
    c.all++;
  }
  return c;
}

// ---------------------------------------------------------------- Start / cancel / results
async function start(type, { folder = null, background = false } = {}) {
  if (job) return { busy: true, message: 'A scan is already running.' };
  if (type === 'custom' && (!folder || (!DEMO && !fs.existsSync(folder)))) return { ok: false, message: 'Pick a folder to scan.' };
  job = { type, folder, background, startedAt: Date.now(), cancelled: false, paused: false, pausedMs: 0, phase: 'prepare', phaseText: 'Getting ready…', filesTotal: 0, filesDone: 0, counted: 0, current: '', counts: { real: 0, fp: 0, pua: 0, unsure: 0, test: 0 }, detections: new Map(), running: new Map(), recent: [], notes: [], memoryWeight: 0 };
  const tick = setInterval(() => send('scan:progress', snapshot()), 700);
  // A long scan must not be cut short by Windows going to sleep.
  let blocker = null;
  try {
    blocker = powerSaveBlocker.start('prevent-app-suspension');
  } catch {}
  send('scan:progress', snapshot());
  (async () => {
    try {
      if (DEMO) await demoRun();
      else await realRun();
      if (job.fatal) {
        send('scan:done', { ok: false, message: job.fatal });
        return;
      }
      setPhase('analyze', 'Checking every detection: real threat or false positive?');
      const scanItems = await analyze([...job.detections.values()]);
      // Everything Defender found before, too — so the results show all threats this PC has had.
      const hist = [];
      for (const h of await scanner.history().catch(() => [])) {
        if (job.detections.has(`${(h.file || '').toLowerCase()}|${h.threat}`)) continue;
        hist.push({ ...h, source: 'defender' });
      }
      const histItems = await analyze(hist);
      const items = [...scanItems, ...histItems];
      remember(items);
      const sec = Math.round((Date.now() - job.startedAt) / 1000);
      const scanSec = job.scanStart ? (Date.now() - job.scanStart) / 1000 : 0;
      if (!job.cancelled && job.filesTotal > 5000 && scanSec > 30 && !DEMO) {
        const measured = job.filesTotal / scanSec;
        settings.set({ scanRate: Math.round(settings.get().scanRate ? settings.get().scanRate * 0.5 + measured * 0.5 : measured) });
      }
      if (!job.cancelled && type !== 'custom') {
        const stats = { ...(settings.get().scanStats || {}) };
        stats[type] = { sec, files: job.filesTotal, gb: DEMO ? 512 : await usedGB(), at: Date.now() };
        settings.set({ scanStats: stats, lastScanAt: Date.now() });
      }
      const result = {
        type,
        folder,
        cancelled: job.cancelled,
        startedAt: job.startedAt,
        endedAt: Date.now(),
        durationSec: sec,
        filesChecked: Math.min(job.filesDone, job.filesTotal),
        filesTotal: job.filesTotal,
        items,
        counts: countsOf(scanItems),
        historyCounts: countsOf(histItems),
        notes: job.notes,
        background,
      };
      writeJson('scan-last.json', result);
      addHistory(result);
      send('scan:done', { ok: true, ...summary(result) });
      onFinished(result);
    } catch (e) {
      send('scan:done', { ok: false, message: String(e.message || e) });
    } finally {
      clearInterval(tick);
      if (blocker != null) {
        try {
          powerSaveBlocker.stop(blocker);
        } catch {}
      }
      job = null;
    }
  })();
  return { ok: true };
}
/** Pause: no new scan jobs start (the ones running finish first); resume carries on. */
function pause(auto = false) {
  if (!job || job.paused || job.cancelled || job.phase !== 'scan') return false;
  job.paused = true;
  job.autoPaused = auto;
  job.pauseStarted = Date.now();
  send('scan:progress', snapshot());
  return true;
}
function resume(onlyAuto = false) {
  if (!job || !job.paused || (onlyAuto && !job.autoPaused)) return false;
  job.pausedMs += Date.now() - job.pauseStarted;
  job.paused = false;
  job.autoPaused = false;
  send('scan:progress', snapshot());
  return true;
}
/** What a running background scan should be doing right now (set by main.js from game / idle checks). */
function autoPause(shouldPause) {
  if (!job || !job.background) return;
  if (shouldPause) pause(true);
  else resume(true);
}
async function cancel() {
  if (!job) return false;
  if (job.paused) resume();
  job.cancelled = true;
  scanner.killAll();
  if (job.phase === 'memory' && !DEMO) await scanner.runMp(['-Scan', '-Cancel'], { timeout: 30000 });
  send('scan:progress', { ...snapshot(), phaseText: 'Stopping — finishing up what was found so far…' });
  return true;
}
function summary(r) {
  const open = r.items.filter((i) => i.status === 'active' && ['real', 'unsure', 'pua', 'test'].includes(i.verdict) && !i.done).length;
  return { type: r.type, cancelled: r.cancelled, durationSec: r.durationSec, filesChecked: r.filesChecked, counts: r.counts, historyCounts: r.historyCounts, found: r.items.length, open, endedAt: r.endedAt, background: r.background };
}
function last() {
  return readJson('scan-last.json', null);
}

// ---------------------------------------------------------------- History of scans
function history() {
  return readJson('scan-history.json', []);
}
function addHistory(r) {
  const found = r.items.filter((i) => i.source !== 'defender');
  const list = history();
  list.unshift({
    type: r.type,
    folder: r.folder,
    background: !!r.background,
    cancelled: !!r.cancelled,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    durationSec: r.durationSec,
    filesChecked: r.filesChecked,
    found: found.length,
    threats: (r.counts.real || 0) + (r.counts.unsure || 0),
    unwanted: r.counts.pua || 0,
  });
  writeJson('scan-history.json', list.slice(0, 40));
}

// ---------------------------------------------------------------- Report (plain text, to save or send to support)
const VERDICT_TEXT = { real: 'REAL THREAT', unsure: 'PROBABLY A THREAT', pua: 'UNWANTED PROGRAM', fp: 'FALSE POSITIVE', test: 'TEST FILE' };
function report(engine) {
  const r = last();
  if (!r) return null;
  const e = engine || {};
  const L = [];
  const date = (t) => new Date(t).toLocaleString();
  L.push('FrameForge virus scan report', '============================');
  L.push(`Scan:      ${{ quick: 'Quick scan', full: 'Full scan', custom: 'Custom scan' }[r.type] || r.type}${r.folder ? ` (${r.folder})` : ''}${r.background ? ' — scheduled, in the background' : ''}${r.cancelled ? ' — stopped early' : ''}`);
  L.push(`Finished:  ${date(r.endedAt)} (took ${Math.floor(r.durationSec / 60)} min ${r.durationSec % 60} s)`);
  L.push(`Files:     ${r.filesChecked.toLocaleString('en-US')} checked`);
  if (e.engine) L.push(`Engine:    Microsoft Defender engine ${e.engine}, definitions ${e.sigVersion || '?'}`);
  const c = r.counts || {};
  L.push(`This scan: ${(c.real || 0) + (c.unsure || 0)} threats · ${c.pua || 0} unwanted programs · ${c.fp || 0} false positives · ${c.test || 0} test files`);
  L.push('');
  if (!r.items.length) L.push('No detections. Microsoft Defender found nothing and has no earlier detections on this PC.');
  r.items.forEach((it, i) => {
    L.push(`${i + 1}. [${VERDICT_TEXT[it.verdict] || it.verdict}] ${it.threat}`);
    L.push(`   What it is: ${it.typeInfo}`);
    if (it.file) L.push(`   File:       ${it.file}`);
    else if ((it.other || []).length) L.push(`   Where:      ${it.other.join(' · ')}`);
    L.push(`   Status:     ${it.status}${it.running ? ' (running)' : ''}${it.done ? ` — you chose: ${it.done}${it.doneMessage ? ` (${it.doneMessage})` : ''}` : ''}`);
    L.push(`   Signed by:  ${it.signer || 'nobody / unknown'}   Size: ${it.size || 0} bytes`);
    if (it.sha256) L.push(`   SHA-256:    ${it.sha256}`);
    L.push(`   Found:      ${it.source === 'defender' ? `by Defender on ${new Date(it.detectedAt).toLocaleDateString()}` : it.source === 'memory' ? 'by Defender’s memory check' : 'by this scan'}`);
    for (const x of it.reasons) L.push(`     ${x}`);
    L.push('');
  });
  return L.join('\r\n');
}

// ---------------------------------------------------------------- Do what the user picked
async function apply(choices) {
  const r = last();
  if (!r) return { ok: false, message: 'No scan results.' };
  const results = [];
  let reboot = false;
  for (const it of r.items) {
    const a = choices[it.id];
    if (!a || !it.actions.includes(a)) continue;
    send('scan:applying', { id: it.id, action: a });
    let res;
    try {
      if (a === 'quarantine') res = await scanner.quarantineFile(it.file, { threat: it.threat, verdict: it.verdict, size: it.size, sha256: it.sha256 });
      else if (a === 'delete') res = await scanner.deleteFile(it.file);
      else if (a === 'allow') res = await scanner.allowFile(it.file);
      else if (a === 'restore') res = await scanner.restoreDefender(it, { allow: true });
      else res = { ok: true, message: a === 'keepq' ? 'Left in Defender’s quarantine — it can’t run.' : 'Kept.' };
    } catch (e) {
      res = { ok: false, message: String(e.message || e) };
    }
    if (res.pendingRestart) reboot = true;
    if (res.ok) {
      it.done = a;
      it.status = a === 'quarantine' ? 'ffquarantined' : a === 'delete' ? 'deleted' : a === 'allow' ? 'allowed' : a === 'restore' ? 'active' : it.status;
      if (a === 'restore') it.actions = ['quarantine', 'delete', 'keep', 'allow'];
    }
    it.doneMessage = res.message;
    results.push({ id: it.id, action: a, ok: !!res.ok, message: res.message });
    send('scan:applied', { id: it.id, action: a, ok: !!res.ok, message: res.message, status: it.status });
  }
  writeJson('scan-last.json', r);
  const n = (a) => results.filter((x) => x.ok && x.action === a).length;
  const parts = [n('quarantine') && `${n('quarantine')} quarantined`, n('delete') && `${n('delete')} deleted`, n('allow') && `${n('allow')} kept and allowed`, n('restore') && `${n('restore')} restored`].filter(Boolean);
  if (parts.length) {
    changes.put(`scan_actions_${Date.now()}`, {
      name: 'Virus scan: handled detections',
      summary: `${parts.join(', ')}.${reboot ? ' A locked file is removed at the next restart.' : ''}`,
      details: results.map((x) => `${x.ok ? '✓' : '✗'} ${x.action}: ${(r.items.find((i) => i.id === x.id) || {}).file || ''} — ${x.message}`),
      at: Date.now(),
      preset: settings.get().preset,
      undoable: false,
      reboot,
    });
  }
  return { ok: results.every((x) => x.ok), results, reboot, summary: summary(r) };
}

module.exports = { init, start, cancel, pause: () => pause(false), resume: () => resume(false), autoPause, background: () => !!(job && job.background), history, report, snapshot: () => snapshot(), running: () => !!job, last, summary, estimates, totals, remember, apply, analyze };
