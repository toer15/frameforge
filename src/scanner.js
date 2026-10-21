// Virus scan — Quick scan, Full scan and Custom scan.
//
// The detection engine is Microsoft Defender's, the antivirus built into Windows 10/11. Its engine and virus
// definitions are updated by Microsoft several times a day, so FrameForge never relies on a home-made virus
// list. FrameForge drives it through Defender's own command-line tool (MpCmdRun.exe) in "detect only" mode
// (-DisableRemediation), so nothing on the PC is touched until the user picks what to do.
//
// What FrameForge adds on top:
//  - Real file counts, live progress and a time estimate that learns how fast this PC scans
//  - A false-positive check for every detection: digital signature (checked by Windows), the known-software
//    database (NIST NSRL + Windows builds, via CIRCL hashlookup — only the file's SHA-256 fingerprint is sent),
//    what kind of detection it is (a named malware family or a machine-learning guess), and where the file is
//  - Quarantine / Delete / Keep for every detection, including ones Defender found before
//  - Protection checks for things malware likes to switch off or change
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app, net } = require('electron');
const { run, ps, IS_WIN, DEMO } = require('./util');
const { settings } = require('./store');

const UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $ErrorActionPreference="SilentlyContinue"; ';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const q = (s) => `'${String(s).replace(/'/g, "''")}'`; // PowerShell single-quoted string

// ---------------------------------------------------------------- Defender's command-line tool
const cmpVer = (a, b) => {
  const pa = a.split(/[.-]/).map(Number);
  const pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};
/** The newest MpCmdRun.exe (Defender keeps the latest one under ProgramData\…\Platform\<version>). */
function mpCmdRun() {
  if (process.env.FRAMEFORGE_MPCMDRUN) return process.env.FRAMEFORGE_MPCMDRUN; // tests
  if (!IS_WIN) return null;
  const plat = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows Defender', 'Platform');
  try {
    const vers = fs.readdirSync(plat).filter((d) => fs.existsSync(path.join(plat, d, 'MpCmdRun.exe'))).sort(cmpVer);
    if (vers.length) return path.join(plat, vers[vers.length - 1], 'MpCmdRun.exe');
  } catch {}
  const pf = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Windows Defender', 'MpCmdRun.exe');
  return fs.existsSync(pf) ? pf : null;
}

const children = new Set();
/** Decode console output: UTF-16 if it looks like it, else UTF-8, else Latin-1. */
function decode(buf) {
  if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) return buf.toString('utf16le');
  const u = buf.toString('utf8');
  return u.includes('\uFFFD') ? buf.toString('latin1') : u;
}
function runMp(args, { timeout = 12 * 3600 * 1000 } = {}) {
  return new Promise((resolve) => {
    const exe = mpCmdRun();
    if (!exe) return resolve({ code: -1, out: '', error: 'Microsoft Defender’s command-line tool wasn’t found on this PC.' });
    const isScript = /\.(js|cjs)$/i.test(exe); // test stand-in
    const ch = spawn(isScript ? process.execPath : exe, isScript ? [exe, ...args] : args, { windowsHide: true, env: isScript ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env });
    children.add(ch);
    const chunks = [];
    ch.stdout.on('data', (d) => chunks.push(d));
    ch.stderr.on('data', (d) => chunks.push(d));
    const t = setTimeout(() => ch.kill(), timeout);
    const done = (code, error) => {
      clearTimeout(t);
      children.delete(ch);
      resolve({ code, out: decode(Buffer.concat(chunks)), error });
    };
    ch.on('error', (e) => done(-1, String(e.message || e)));
    ch.on('close', (code) => done(code));
  });
}
function killAll() {
  for (const ch of children) {
    try {
      ch.kill();
    } catch {}
  }
}

/** MpCmdRun console output → [{ threat, files: [...] }] */
function parseMp(out) {
  const dets = [];
  let cur = null;
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.replace(/\0/g, '');
    let m;
    if ((m = line.match(/^\s*Threat\s*:\s*(.+?)\s*$/i))) {
      cur = { threat: m[1], files: [], other: [] };
      dets.push(cur);
      continue;
    }
    if (cur && (m = line.match(/^\s*(file|containerfile|process|regkey|regkeyvalue|service|startup|folder|webfile|behavior|amsi|genericfile|bootsector|memory)\s*:\s*(.+?)\s*$/i))) {
      const kind = m[1].toLowerCase();
      if (kind === 'file' || kind === 'containerfile') {
        const f = m[2].split('->')[0].trim(); // a file inside an archive: act on the archive
        if (!cur.files.includes(f)) cur.files.push(f);
      } else cur.other.push(`${kind}: ${m[2]}`);
    }
  }
  const hr = (String(out).match(/failed with hr\s*=\s*(0x[0-9a-f]+)/i) || [])[1] || null;
  return { dets, hr };
}
const HR_TEXT = {
  '0x800106ba': 'Microsoft Defender isn’t running on this PC (another antivirus may be in charge, or it was switched off).',
  '0x80508023': 'The file or folder couldn’t be found.',
  '0x80508026': 'The scan was cancelled.',
};

/**
 * Paths in MpCmdRun's console output can lose non-English letters (æ ø å …). Find the real file by matching
 * each path part with those letters as wildcards.
 */
function resolvePath(p) {
  if (!p || fs.existsSync(p)) return p;
  const parts = p.split('\\');
  let cur = parts[0] + '\\';
  for (const part of parts.slice(1)) {
    if (!part) continue;
    const exact = path.join(cur, part);
    if (fs.existsSync(exact)) {
      cur = exact;
      continue;
    }
    let names = [];
    try {
      names = fs.readdirSync(cur);
    } catch {
      return p;
    }
    const re = new RegExp('^' + [...part].map((c) => (/[\x20-\x7e]/.test(c) ? c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '.{1,2}')).join('') + '$', 'i');
    const hit = names.find((n) => re.test(n));
    if (!hit) return p;
    cur = path.join(cur, hit);
  }
  return cur;
}

// ---------------------------------------------------------------- What a detection name means
// Defender names look like  Type:Platform/Family.Variant!suffix  e.g.  Trojan:Win32/Wacatac.B!ml
const MALWARE_TYPES = new Set(['trojan', 'trojandownloader', 'trojandropper', 'trojanspy', 'trojanclicker', 'trojanproxy', 'backdoor', 'ransom', 'virus', 'worm', 'exploit', 'pws', 'spyware', 'virtool', 'behavior', 'rogue', 'dos', 'ddos', 'spammer', 'constructor']);
const UNWANTED_TYPES = new Set(['pua', 'puadlmanager', 'puabundler', 'puaminer', 'puamisc', 'puaadvertising', 'adware', 'browsermodifier', 'softwarebundler', 'program', 'remoteaccess', 'monitoringtool', 'hacktool', 'tool', 'app', 'misleading', 'joke', 'settingsmodifier', 'tampering']);
// Generic, machine-made family names Defender gives to files it can't pin to a known family — this is where
// most false positives come from (a real one can still hide behind them).
const GENERIC = /^(wacatac|sabsik|bearfoos|casdet|ulise|vigorf|kepavll|phonzy|tiggre|trickler|leonem|znyonm|malgent|woreflint|contebrew|kryptik|tnega|cinjo|hesv|ymacco|pomal|fuery|zpevdo|scar|occamy|tiggre|sonbokli|krypt|wacapew|ludicrouz|mikey|presenoker|gendows|bulta|cloxer|ccleaner|razy)\b/i;
const TYPE_INFO = {
  trojan: 'A trojan: a program that pretends to be something useful while doing something harmful in the background.',
  trojandownloader: 'A downloader trojan: it fetches and installs more malware.',
  trojandropper: 'A dropper: it carries other malware inside it and installs it.',
  trojanspy: 'Spyware: it records what you do — keystrokes, screenshots or files.',
  spyware: 'Spyware: it records what you do — keystrokes, screenshots or files.',
  pws: 'A password stealer: it takes saved logins (browser, Discord, Steam and more).',
  backdoor: 'A backdoor: it lets an attacker control this PC remotely.',
  ransom: 'Ransomware: it encrypts your files and demands money.',
  virus: 'A virus: it infects other files to spread.',
  worm: 'A worm: it spreads by itself to other PCs or USB drives.',
  exploit: 'An exploit: it abuses a security hole in another program.',
  virtool: 'A tool used to build or hide malware.',
  behavior: 'Defender saw a program behave like malware.',
  rogue: 'Fake security software that shows made-up alerts.',
  hacktool: 'A hacking tool — often a game cheat, password cracker, Windows activator, or a hardware tool with a risky driver. Not a virus by itself, but often bundled with one.',
  pua: 'A potentially unwanted app: adware, bundled offers or a pushy download manager. Not a virus.',
  puadlmanager: 'A download manager that bundles unwanted offers. Not a virus.',
  puabundler: 'An installer that bundles unwanted extra apps. Not a virus.',
  puaminer: 'A crypto-miner: it uses your CPU/GPU to make money for someone else.',
  adware: 'Adware: it shows ads.',
  browsermodifier: 'It changes browser settings (home page, search engine) without asking.',
  softwarebundler: 'An installer that bundles unwanted extra apps.',
  program: 'A program Microsoft marks as unwanted or risky (for example a miner, keygen or fake cleaner).',
  remoteaccess: 'Remote-control software. Fine only if you installed it on purpose.',
  monitoringtool: 'A program that records what you do. Fine only if you installed it on purpose.',
  misleading: 'Software that makes false claims, like a fake “PC cleaner”.',
  tool: 'A tool that can be misused.',
  test: 'A harmless test file used to check that antivirus works (EICAR). Not a threat.',
};
function parseName(name) {
  const m = String(name).match(/^([A-Za-z]+):([A-Za-z0-9]+)\/([^.!]+)([^!]*)(?:!(.+))?$/);
  if (!m) return { type: '', platform: '', family: String(name), suffix: '' };
  return { type: m[1], platform: m[2], family: m[3], variant: m[4].replace(/^\./, ''), suffix: (m[5] || '').toLowerCase() };
}
function kindOf(name) {
  if (/eicar/i.test(name)) return 'test';
  const t = parseName(name).type.toLowerCase();
  if (UNWANTED_TYPES.has(t)) return 'unwanted';
  return 'malware';
}

// Where a file lives says a lot.
function locationOf(p) {
  const l = String(p).toLowerCase();
  if (/\\appdata\\local\\temp\\|\\windows\\temp\\|\\\$recycle\.bin\\|\\users\\public\\/.test(l)) return { score: -2, text: 'It sits in a temporary or shared folder — a place malware often hides.' };
  if (/\\appdata\\roaming\\[^\\]+$|\\programdata\\[^\\]+$|\\appdata\\local\\[^\\]+$/.test(l)) return { score: -2, text: 'It sits loose in AppData/ProgramData — a place malware often hides.' };
  if (/\\downloads\\/.test(l)) return { score: -1, text: 'It’s in your Downloads folder.' };
  if (/^[a-z]:\\program files( \(x86\))?\\|\\steamapps\\common\\|\\epic games\\|\\gog games\\|\\xboxgames\\|\\windowsapps\\|\\riot games\\|\\battle\.net\\/.test(l)) return { score: 1, text: 'It’s installed where programs and games normally live.' };
  return { score: 0, text: '' };
}

/**
 * Real threat, false positive, unwanted program or unsure — and why.
 * signals: { exists, signed, signer, known (database hit), running }
 */
function verdict(threat, file, s) {
  const n = parseName(threat);
  const kind = kindOf(threat);
  const reasons = [];
  if (kind === 'test') return { verdict: 'test', score: 0, reasons: ['This is the EICAR test file: a harmless file every antivirus detects on purpose, to prove it works.'] };
  let score = 0;
  if (s.known) {
    score += 3;
    reasons.push(`+ Found in the known-software database (${s.known.source || 'NIST NSRL / Windows builds'}) — a listed, legitimate file.`);
  }
  if (s.signed) {
    score += 2;
    reasons.push(`+ Digitally signed by ${s.signer || 'its publisher'} — Windows checked the signature and it’s valid.`);
  } else if (s.exists && /\.(exe|dll|sys|scr|com|msi)$/i.test(file)) {
    score -= 1;
    reasons.push('− Not digitally signed, so its publisher can’t be confirmed.');
  }
  const generic = ['ml', 'cl', 'pz', 'rfn'].includes(n.suffix) || GENERIC.test(n.family);
  if (generic) {
    score += 1;
    reasons.push(`+ “${threat}” is a generic guess (${n.suffix === 'ml' ? 'machine-learning' : n.suffix === 'cl' ? 'cloud reputation' : 'generic family name'}), not a known virus — this kind of detection causes most false positives.`);
  } else if (kind === 'malware' && n.family) {
    score -= 3;
    reasons.push(`− Matches a known malware family: ${n.family}.`);
  }
  const loc = locationOf(file);
  if (loc.text) reasons.push(`${loc.score > 0 ? '+' : '−'} ${loc.text}`);
  score += loc.score;
  if (s.running) reasons.push('! It’s running right now.');
  if (!s.exists) reasons.push('· The file isn’t on the disk any more (quarantined or removed), so only the detection name could be checked.');
  let v;
  if (kind === 'unwanted') v = score >= 4 ? 'fp' : 'pua';
  else v = score >= 4 ? 'fp' : score >= 2 || (generic && score >= 0) ? 'unsure' : 'real';
  return { verdict: v, score, reasons };
}

// ---------------------------------------------------------------- File facts: hash, signature, known-software database
async function sha256(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    const st = fs.createReadStream(file);
    st.on('data', (d) => h.update(d));
    st.on('error', () => resolve(null)); // Defender may block reading a malicious file — that's fine
    st.on('end', () => resolve(h.digest('hex')));
  });
}
async function signatures(files) {
  const out = {};
  if (!files.length) return out;
  if (DEMO || !IS_WIN) return out;
  const list = path.join(app.getPath('temp'), `ff-sig-${Date.now()}.txt`);
  fs.writeFileSync(list, files.join('\r\n'), 'utf8');
  const r = await ps(`${UTF8}$r = foreach($f in (Get-Content -LiteralPath ${q(list)} -Encoding UTF8)){ $s = Get-AuthenticodeSignature -LiteralPath $f; [pscustomobject]@{ f=$f; st="$($s.Status)"; sub="$($s.SignerCertificate.Subject)" } }; @($r) | ConvertTo-Json -Compress`, { timeout: 180000 });
  fs.rmSync(list, { force: true });
  try {
    for (const x of [].concat(JSON.parse(r.stdout || '[]'))) out[x.f.toLowerCase()] = { status: x.st, signer: ((x.sub || '').match(/O="?([^",]+)/) || (x.sub || '').match(/CN="?([^",]+)/) || [])[1] || '' };
  } catch {}
  return out;
}
const knownCache = new Map();
async function knownGood(hash) {
  if (!hash || !settings.get().scanHashLookup) return null;
  if (knownCache.has(hash)) return knownCache.get(hash);
  let res = null;
  try {
    const r = await net.fetch(`https://hashlookup.circl.lu/lookup/sha256/${hash}`, { headers: { accept: 'application/json', 'User-Agent': 'FrameForge' }, signal: AbortSignal.timeout(8000) });
    if (r.ok) {
      const j = await r.json();
      const trust = Number(j['hashlookup:trust'] || 50);
      if (trust >= 50) res = { source: /nsrl/i.test(JSON.stringify(j.source || j.ProductCode || '')) || j.ProductCode ? 'NIST NSRL' : String(j.source || 'CIRCL hashlookup').split(':')[0], name: j.FileName || '', trust };
    }
  } catch {}
  knownCache.set(hash, res);
  return res;
}

// ---------------------------------------------------------------- Status of Windows' protection
async function engineStatus() {
  if (DEMO) {
    return { available: true, version: '4.18.25090.3009', engine: '1.1.25090.3001', sigVersion: '1.439.112.0', sigAgeHours: 3, rtp: true, tamper: true, mode: 'Normal', otherAv: [], purgeDays: 90, demo: true, exclusions: { path: [], proc: [], ext: [] } };
  }
  if (!IS_WIN && !process.env.FRAMEFORGE_MPCMDRUN) return { available: false, reason: 'Virus scanning works on Windows only.' };
  const r = await ps(
    `${UTF8}$o=@{}; $s=Get-MpComputerStatus; if($s){ $o.am=$s.AMServiceEnabled; $o.av=$s.AntivirusEnabled; $o.rtp=$s.RealTimeProtectionEnabled; $o.mode="$($s.AMRunningMode)"; $o.ver="$($s.AMProductVersion)"; $o.eng="$($s.AMEngineVersion)"; $o.sig="$($s.AntivirusSignatureVersion)"; $o.sigAt=if($s.AntivirusSignatureLastUpdated){$s.AntivirusSignatureLastUpdated.ToString('o')}else{''}; $o.tamper=$s.IsTamperProtected; $o.qs=if($s.QuickScanStartTime){$s.QuickScanStartTime.ToString('o')}else{''}; $o.qe=if($s.QuickScanEndTime){$s.QuickScanEndTime.ToString('o')}else{''}; $o.fs=if($s.FullScanStartTime){$s.FullScanStartTime.ToString('o')}else{''}; $o.fe=if($s.FullScanEndTime){$s.FullScanEndTime.ToString('o')}else{''} }; ` +
      `$p=Get-MpPreference; if($p){ $o.ex=@{path=@($p.ExclusionPath|?{$_}); proc=@($p.ExclusionProcess|?{$_}); ext=@($p.ExclusionExtension|?{$_})}; $o.purge=$p.QuarantinePurgeItemsAfterDelay; $o.pua=$p.PUAProtection }; ` +
      `$o.avs=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | %{ @{name="$($_.displayName)"; state=[int]$_.productState} }); ` +
      `$pol='HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows Defender'; $o.polAS=(Get-ItemProperty $pol -Name DisableAntiSpyware).DisableAntiSpyware; $o.polAV=(Get-ItemProperty $pol -Name DisableAntiVirus).DisableAntiVirus; $o.polRTP=(Get-ItemProperty "$pol\\Real-Time Protection" -Name DisableRealtimeMonitoring).DisableRealtimeMonitoring; ` +
      `$o.fw=@(Get-NetFirewallProfile | %{ @{name="$($_.Name)"; on=("$($_.Enabled)" -ne 'False')} }); ` +
      `$o.uac=(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -Name EnableLUA).EnableLUA; ` +
      `$i=Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; $o.proxy=@{on=$i.ProxyEnable; server="$($i.ProxyServer)"; pac="$($i.AutoConfigURL)"}; ` +
      `$o | ConvertTo-Json -Compress -Depth 4`,
    { timeout: 60000 }
  );
  let o = {};
  try {
    o = JSON.parse(r.stdout || '{}');
  } catch {}
  const otherAv = (o.avs || []).filter((a) => !/defender/i.test(a.name)).map((a) => ({ name: a.name, on: ((a.state >> 12) & 0xf) === 1 }));
  const sigAgeHours = o.sigAt ? Math.round((Date.now() - Date.parse(o.sigAt)) / 3600000) : null;
  const exe = mpCmdRun();
  const available = !!exe && o.am !== false && !/not running/i.test(o.mode || '');
  return {
    available,
    reason: available ? '' : !exe ? 'Microsoft Defender isn’t installed on this PC.' : otherAv.some((a) => a.on) ? `Microsoft Defender’s engine is switched off because ${otherAv.find((a) => a.on).name} is your antivirus.` : 'Microsoft Defender is switched off.',
    version: o.ver || '',
    engine: o.eng || '',
    sigVersion: o.sig || '',
    sigAgeHours,
    rtp: o.rtp !== false,
    tamper: !!o.tamper,
    mode: o.mode || '',
    otherAv,
    purgeDays: o.purge || null,
    exclusions: o.ex || { path: [], proc: [], ext: [] },
    lastQuick: o.qs && o.qe ? { at: o.qe, sec: Math.max(0, (Date.parse(o.qe) - Date.parse(o.qs)) / 1000) } : null,
    lastFull: o.fs && o.fe ? { at: o.fe, sec: Math.max(0, (Date.parse(o.fe) - Date.parse(o.fs)) / 1000) } : null,
    raw: o,
  };
}

// Hosts-file lines that send well-known sites somewhere else (or block security sites) — classic malware tricks.
// Lines that only block Windows telemetry (privacy tools add those) are left alone.
const HOSTS_WATCH = /(^|\.)(microsoft\.com|windowsupdate\.com|windows\.com|live\.com|office\.com|bing\.com|google\.com|youtube\.com|facebook\.com|steampowered\.com|steamcommunity\.com|epicgames\.com|discord\.com|discordapp\.com|github\.com|paypal\.com|virustotal\.com|malwarebytes\.com|kaspersky\.com|eset\.com|avast\.com|avg\.com|bitdefender\.com|norton\.com|mcafee\.com|nvidia\.com|amd\.com|intel\.com)$/i;
const HOSTS_PRIVACY = /telemetry|vortex|watson|settings-win|data\.microsoft|events\.data|activity\.windows|diagnostics|\.ads?\.|adservice|doubleclick/i;
function hostsPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
}
function hostsIssues() {
  if (DEMO || !IS_WIN) return [];
  let txt = '';
  try {
    txt = fs.readFileSync(hostsPath(), 'utf8');
  } catch {
    return [];
  }
  const bad = [];
  for (const line of txt.split(/\r?\n/)) {
    const l = line.replace(/#.*/, '').trim();
    if (!l) continue;
    const [ip, ...names] = l.split(/\s+/);
    if (/^(127\.0\.0\.1|::1)$/.test(ip) && names.every((n) => n === 'localhost')) continue;
    if (names.some((n) => HOSTS_WATCH.test(n) && !HOSTS_PRIVACY.test(n))) bad.push(line.trim());
  }
  return bad;
}

const SUSPICIOUS_EXCL = (p) => /^[a-z]:\\?$/i.test(p) || /\\(users|appdata|temp|programdata|downloads|desktop|windows)\\?$/i.test(p) || /^%?(temp|appdata|userprofile)%?/i.test(p) || /\\appdata\\(local|roaming)(\\temp)?\\?$/i.test(p);
const RISKY_EXT = /^\.?(exe|dll|ps1|bat|cmd|vbs|js|jse|scr|com|hta|msi|lnk|sys)$/i;
const RISKY_PROC = /(powershell|pwsh|cmd|wscript|cscript|mshta|rundll32|regsvr32|svchost|explorer)\.exe$/i;

/** Protection checks: things malware likes to switch off or change. */
async function checks(eng) {
  eng = eng || (await engineStatus());
  const out = [];
  const add = (c) => out.push({ fix: null, fixLabel: '', ...c });
  const o = eng.raw || {};
  const ownAllowed = new Set((settings.get().scanAllowed || []).map((x) => x.toLowerCase()));
  if (eng.demo) {
    add({ id: 'sig_ok', level: 'ok', title: 'Virus definitions are up to date', body: 'Updated 3 hours ago.' });
    add({ id: 'rtp_ok', level: 'ok', title: 'Real-time protection is on', body: 'Microsoft Defender checks every file as it’s opened.' });
    if (!settings.get().demoHostsFixed) add({ id: 'hosts', level: 'big', title: 'Your hosts file redirects 2 well-known sites', body: 'Malware edits the hosts file to send you to fake sites or to block antivirus updates.', details: ['0.0.0.0 www.malwarebytes.com', '185.243.5.12 steamcommunity.com'], fix: 'fix_hosts', fixLabel: 'Remove those lines' });
    add({ id: 'fw_ok', level: 'ok', title: 'Windows Firewall is on', body: 'For all network types.' });
    return out;
  }
  if (!eng.available) {
    add({ id: 'engine', level: (eng.otherAv || []).some((a) => a.on) ? 'info' : 'big', title: eng.reason || 'Microsoft Defender isn’t available', body: (eng.otherAv || []).some((a) => a.on) ? 'Your other antivirus still protects the PC. To let FrameForge scan with Defender’s engine as well, turn on “Periodic scanning” in Windows Security › Virus & threat protection › Microsoft Defender Antivirus options.' : 'No antivirus is protecting this PC.', fix: o.polAS || o.polAV ? 'remove_policies' : 'open_defender', fixLabel: o.polAS || o.polAV ? 'Switch Defender back on' : 'Open Windows Security' });
  }
  if (o.polAS === 1 || o.polAV === 1 || o.polRTP === 1) add({ id: 'policies', level: 'big', title: 'A policy is switching Microsoft Defender off', body: 'Settings in the registry (Group Policy) turn Defender or its real-time protection off. Malware often does this — FrameForge can remove them.', fix: 'remove_policies', fixLabel: 'Remove the policies' });
  if (eng.available && !eng.rtp && !(eng.otherAv || []).some((a) => a.on)) add({ id: 'rtp', level: 'big', title: 'Real-time protection is off', body: 'Defender only checks files when you scan. Real-time protection checks every file as it’s opened.', fix: 'enable_rtp', fixLabel: 'Turn it on' });
  if (eng.available && eng.sigAgeHours != null && eng.sigAgeHours > 48) add({ id: 'sigs', level: 'medium', title: `Virus definitions are ${Math.round(eng.sigAgeHours / 24)} days old`, body: 'New malware appears every day — old definitions miss it.', fix: 'update_sigs', fixLabel: 'Update now' });
  else if (eng.available) add({ id: 'sig_ok', level: 'ok', title: 'Virus definitions are up to date', body: eng.sigAgeHours != null ? `Updated ${eng.sigAgeHours < 1 ? 'less than an hour' : `${eng.sigAgeHours} hour${eng.sigAgeHours === 1 ? '' : 's'}`} ago.` : '' });
  const ex = eng.exclusions || {};
  const badEx = [
    ...(ex.path || []).filter((p) => SUSPICIOUS_EXCL(p) && !ownAllowed.has(p.toLowerCase())).map((p) => ({ kind: 'path', v: p })),
    ...(ex.ext || []).filter((e) => RISKY_EXT.test(e)).map((e) => ({ kind: 'ext', v: e })),
    ...(ex.proc || []).filter((p) => RISKY_PROC.test(p)).map((p) => ({ kind: 'proc', v: p })),
  ];
  if (badEx.length) add({ id: 'exclusions', level: 'big', title: `Defender skips ${badEx.length} risky place${badEx.length === 1 ? '' : 's'}`, body: 'These exclusions make Defender ignore whole folders, file types or programs that malware uses. Malware adds them to hide.', details: badEx.map((b) => `${b.kind === 'path' ? 'Folder' : b.kind === 'ext' ? 'File type' : 'Program'}: ${b.v}`), fix: 'remove_exclusions', fixLabel: 'Remove them', data: badEx });
  const hosts = hostsIssues();
  if (hosts.length) add({ id: 'hosts', level: 'big', title: `Your hosts file redirects ${hosts.length} well-known site${hosts.length === 1 ? '' : 's'}`, body: 'Malware edits the hosts file to send you to fake sites or to block antivirus updates.', details: hosts, fix: 'fix_hosts', fixLabel: 'Remove those lines' });
  if (o.proxy && o.proxy.on === 1 && o.proxy.server) add({ id: 'proxy', level: 'medium', title: `Your internet goes through a proxy (${o.proxy.server})`, body: 'Fine if you set it up (VPN, work, an ad-blocker). If you didn’t, malware may be reading your traffic.', fix: 'proxy_off', fixLabel: 'Turn the proxy off' });
  const fwOff = (o.fw || []).filter((f) => !f.on).map((f) => f.name);
  if (fwOff.length) add({ id: 'firewall', level: (eng.otherAv || []).some((a) => a.on) ? 'info' : 'big', title: `Windows Firewall is off for ${fwOff.join(', ')} networks`, body: (eng.otherAv || []).some((a) => a.on) ? 'Your other security suite may run its own firewall.' : 'Nothing is blocking unwanted connections to this PC.', fix: 'firewall_on', fixLabel: 'Turn it on' });
  else if (o.fw) add({ id: 'fw_ok', level: 'ok', title: 'Windows Firewall is on', body: 'For all network types.' });
  if (o.uac === 0) add({ id: 'uac', level: 'big', title: 'User Account Control is switched off', body: 'Any program can make changes to Windows without asking. Malware loves that.', fix: 'uac_on', fixLabel: 'Turn it on (needs a restart)' });
  return out;
}

async function fixCheck(id, data) {
  if (DEMO) {
    await sleep(600);
    if (id === 'fix_hosts') settings.set({ demoHostsFixed: true });
    return { ok: true, message: 'Fixed.' };
  }
  switch (id) {
    case 'enable_rtp': {
      const r = await ps('Set-MpPreference -DisableRealtimeMonitoring $false');
      return r.code === 0 ? { ok: true, message: 'Real-time protection is on.' } : { ok: false, message: 'Windows blocked the change (Tamper Protection). Turn it on in Windows Security › Virus & threat protection.' };
    }
    case 'remove_policies': {
      const k = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows Defender';
      for (const v of ['DisableAntiSpyware', 'DisableAntiVirus']) await run('reg', ['delete', k, '/v', v, '/f']);
      await run('reg', ['delete', `${k}\\Real-Time Protection`, '/v', 'DisableRealtimeMonitoring', '/f']);
      await ps('Start-Service WinDefend -ErrorAction SilentlyContinue; Set-MpPreference -DisableRealtimeMonitoring $false -ErrorAction SilentlyContinue');
      return { ok: true, message: 'Removed the policies that switched Defender off.', reboot: true };
    }
    case 'update_sigs': {
      const r = await runMp(['-SignatureUpdate'], { timeout: 10 * 60 * 1000 });
      return r.code === 0 ? { ok: true, message: 'Virus definitions updated.' } : { ok: false, message: 'The update didn’t work — check the internet connection.' };
    }
    case 'remove_exclusions': {
      const list = data || [];
      const by = (k) => list.filter((b) => b.kind === k).map((b) => q(b.v)).join(',');
      const parts = [];
      if (by('path')) parts.push(`-ExclusionPath @(${by('path')})`);
      if (by('ext')) parts.push(`-ExclusionExtension @(${by('ext')})`);
      if (by('proc')) parts.push(`-ExclusionProcess @(${by('proc')})`);
      const r = parts.length ? await ps(`Remove-MpPreference ${parts.join(' ')}`) : { code: 0 };
      return r.code === 0 ? { ok: true, message: `Removed ${list.length} exclusion${list.length === 1 ? '' : 's'}.` } : { ok: false, message: 'Windows blocked the change (Tamper Protection). Remove them in Windows Security › Virus & threat protection › Exclusions.' };
    }
    case 'fix_hosts': {
      const hp = hostsPath();
      const txt = fs.readFileSync(hp, 'utf8');
      fs.writeFileSync(`${hp}.frameforge-backup`, txt);
      const bad = new Set(hostsIssues());
      fs.writeFileSync(hp, txt.split(/\r?\n/).filter((l) => !bad.has(l.trim())).join('\r\n'));
      await run('ipconfig', ['/flushdns']);
      return { ok: true, message: `Removed ${bad.size} line${bad.size === 1 ? '' : 's'} (backup saved as hosts.frameforge-backup).` };
    }
    case 'proxy_off':
      await run('reg', ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f']);
      return { ok: true, message: 'The proxy is off.' };
    case 'firewall_on': {
      const r = await ps('Set-NetFirewallProfile -All -Enabled True');
      return r.code === 0 ? { ok: true, message: 'Windows Firewall is on.' } : { ok: false, message: 'Windows didn’t accept the change.' };
    }
    case 'uac_on':
      await run('reg', ['add', 'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', '/v', 'EnableLUA', '/t', 'REG_DWORD', '/d', '1', '/f']);
      return { ok: true, message: 'User Account Control is on after the next restart.', reboot: true };
    case 'open_defender':
      require('electron').shell.openExternal('windowsdefender://threatsettings');
      return { ok: true, message: 'Opened Windows Security.' };
  }
  return { ok: false, message: 'Unknown fix.' };
}

// ---------------------------------------------------------------- What to scan
const EXE_RE = /"([a-z]:\\[^"]+?\.(?:exe|dll|ps1|vbs|vbe|js|jse|bat|cmd|scr|com|jar|hta|wsf|msi|pif|cpl))"|([a-z]:\\[^"*?<>|\r\n]+?\.(?:exe|dll|ps1|vbs|vbe|js|jse|bat|cmd|scr|com|jar|hta|wsf|msi|pif|cpl))(?=$|[\s,"])/gi;
function pathsIn(cmd) {
  const out = [];
  const expanded = String(cmd || '').replace(/%([^%]+)%/g, (m, v) => process.env[v] || process.env[v.toUpperCase()] || m);
  let m;
  EXE_RE.lastIndex = 0;
  while ((m = EXE_RE.exec(expanded))) out.push(m[1] || m[2]);
  return out;
}

/** Running programs, startup entries, scheduled tasks and services (except Windows' own files). */
async function autostartFiles() {
  if (!IS_WIN) return { files: [], running: new Set() };
  const r = await ps(
    `${UTF8}$o=@{}; $o.proc=@(Get-CimInstance Win32_Process | ?{$_.ExecutablePath} | %{$_.ExecutablePath} | Sort-Object -Unique); $o.run=@(); ` +
      `foreach($k in 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Run','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\RunOnce'){ $p=Get-ItemProperty $k; if($p){ $p.PSObject.Properties | ?{ $_.Name -notlike 'PS*' } | %{ $o.run += [string]$_.Value } } }; ` +
      `$o.tasks=@(Get-ScheduledTask | %{ foreach($a in $_.Actions){ if($a.Execute){ "$($a.Execute) $($a.Arguments)" } } }); ` +
      `$o.svc=@(Get-CimInstance Win32_Service | %{ [string]$_.PathName }); $o | ConvertTo-Json -Compress -Depth 3`,
    { timeout: 120000 }
  );
  let o = {};
  try {
    o = JSON.parse(r.stdout || '{}');
  } catch {}
  const win = (process.env.SystemRoot || 'C:\\Windows').toLowerCase() + '\\';
  const seen = new Map();
  const running = new Set((o.proc || []).map((p) => p.toLowerCase()));
  for (const p of [...(o.proc || []), ...[].concat(o.run || [], o.tasks || [], o.svc || []).flatMap(pathsIn)]) {
    const l = p.toLowerCase();
    if (l.startsWith(win) && !l.includes('\\temp\\')) continue; // Windows' own files: covered by Defender's system check
    if (!seen.has(l) && fs.existsSync(p)) seen.set(l, p);
  }
  return { files: [...seen.values()], running };
}

function quickFolders() {
  const env = process.env;
  const home = os.homedir();
  const la = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const ra = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const list = [
    path.join(home, 'Downloads'),
    path.join(home, 'Desktop'),
    env.TEMP || path.join(la, 'Temp'),
    path.join(env.SystemRoot || 'C:\\Windows', 'Temp'),
    ra,
    path.join(env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'StartUp'),
    env.PUBLIC || 'C:\\Users\\Public',
  ];
  // Browser extensions
  for (const [base, sub] of [
    [path.join(la, 'Google', 'Chrome', 'User Data'), 'Extensions'],
    [path.join(la, 'Microsoft', 'Edge', 'User Data'), 'Extensions'],
    [path.join(la, 'BraveSoftware', 'Brave-Browser', 'User Data'), 'Extensions'],
    [path.join(la, 'Vivaldi', 'User Data'), 'Extensions'],
  ]) {
    try {
      for (const prof of fs.readdirSync(base)) if (fs.existsSync(path.join(base, prof, sub))) list.push(path.join(base, prof, sub));
    } catch {}
  }
  const ff = path.join(ra, 'Mozilla', 'Firefox', 'Profiles');
  try {
    for (const prof of fs.readdirSync(ff)) if (fs.existsSync(path.join(ff, prof, 'extensions'))) list.push(path.join(ff, prof, 'extensions'));
  } catch {}
  const existing = [...new Set(list.filter((p) => p && fs.existsSync(p)))];
  // Leave out folders that sit inside another one on the list.
  return existing.filter((p) => !existing.some((o) => o !== p && p.toLowerCase().startsWith(o.toLowerCase() + '\\')));
}

const SKIP_FILE = /^(pagefile|hiberfil|swapfile)\.sys$|^dumpstack\.log(\.tmp)?$/i;
/** Count every file under a folder (skips links/junctions and cloud-only files). Keeps the tree for planning. */
async function walk(root, st) {
  const node = { p: root, files: 0, total: 0, kids: [], names: [] };
  if (st.cancelled) return node;
  let dir;
  try {
    dir = await fsp.opendir(root, { bufferSize: 128 });
  } catch {
    return node;
  }
  const subs = [];
  try {
    for await (const d of dir) {
      if (d.isSymbolicLink()) continue;
      if (d.isDirectory()) subs.push(path.join(root, d.name));
      else if (d.isFile() && !SKIP_FILE.test(d.name)) {
        node.files++;
        if (node.names.length <= 40) node.names.push(d.name);
      }
    }
  } catch {}
  st.files += node.files;
  st.dirs++;
  if (st.dirs % 300 === 0) {
    st.onTick && st.onTick();
    await new Promise((r) => setImmediate(r));
  }
  for (const s of subs) {
    if (st.cancelled) break;
    node.kids.push(await walk(s, st));
  }
  node.total = node.files + node.kids.reduce((a, k) => a + k.total, 0);
  if (node.files > 40) node.names = null;
  return node;
}
/** Split a counted folder tree into scan jobs of a sensible size (each is one Defender scan). */
function planChunks(node, limit, out = []) {
  if (!node.total) return out;
  if (node.total <= limit || !node.kids.length || node.names === null) {
    out.push({ path: node.p, count: node.total });
    return out;
  }
  for (const n of node.names) out.push({ path: path.join(node.p, n), count: 1 });
  for (const k of node.kids) planChunks(k, limit, out);
  return out;
}

// ---------------------------------------------------------------- Defender's history (everything it found before)
const STATUS = { 1: 'active', 2: 'removed', 3: 'quarantined', 4: 'removed', 5: 'allowed', 6: 'blocked', 102: 'active', 103: 'active', 104: 'active', 105: 'active', 107: 'active' };
async function history() {
  if (DEMO) {
    const d = (days) => new Date(Date.now() - days * 86400000).toISOString();
    return [
      { threat: 'Virus:DOS/EICAR_Test_File', file: 'C:\\Users\\Tommy\\Downloads\\eicar_com.zip', status: 'quarantined', at: d(3) },
      { threat: 'PUADlManager:Win32/OfferCore', file: 'C:\\Users\\Tommy\\Downloads\\VLC-setup-free-download.exe', status: 'quarantined', at: d(12) },
    ];
  }
  if (!IS_WIN) return [];
  const r = await ps(
    `${UTF8}$t=@{}; Get-MpThreat | %{ $t[[string]$_.ThreatID]=$_.ThreatName }; $r = Get-MpThreatDetection | %{ [pscustomobject]@{ id=[string]$_.ThreatID; name=$t[[string]$_.ThreatID]; st=[int]$_.ThreatStatusID; res=@($_.Resources); at=$_.InitialDetectionTime.ToString('o') } }; @($r) | ConvertTo-Json -Compress -Depth 4`,
    { timeout: 60000 }
  );
  let list = [];
  try {
    list = [].concat(JSON.parse(r.stdout || '[]'));
  } catch {}
  const out = [];
  for (const x of list) {
    const files = (x.res || []).map((s) => (String(s).match(/^(?:file|containerfile):_(.+)$/i) || [])[1]).filter(Boolean).map((f) => f.split('->')[0]);
    for (const f of files.length ? [...new Set(files)] : [null]) {
      let status = STATUS[x.st] || 'unknown';
      if (f && (status === 'active' || status === 'blocked')) status = fs.existsSync(f) ? 'active' : 'removed';
      out.push({ threat: x.name || `Threat ${x.id}`, threatId: x.id, file: f, status, at: x.at });
    }
  }
  return out;
}

// ---------------------------------------------------------------- FrameForge's own quarantine
// Files are stored encoded (XOR with a random key) in a folder only SYSTEM and Administrators can open, so they
// can't run or be opened by accident. Restore puts the exact original bytes back.
function qDir() {
  const d = DEMO || !IS_WIN ? path.join(app.getPath('userData'), 'quarantine') : path.join(process.env.ProgramData || 'C:\\ProgramData', 'FrameForge', 'Quarantine');
  if (!fs.existsSync(d)) {
    fs.mkdirSync(d, { recursive: true });
    if (IS_WIN && !DEMO) run('icacls', [d, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F']);
  }
  return d;
}
function xor(buf, key) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key[i % key.length];
  return out;
}
function quarantineList() {
  const d = qDir();
  const out = [];
  for (const f of fs.readdirSync(d).filter((n) => n.endsWith('.json'))) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
      delete m.key;
      out.push(m);
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Stop any program that runs from this file. */
async function stopProcesses(file) {
  if (!IS_WIN || DEMO) return 0;
  const r = await ps(`$n=0; Get-CimInstance Win32_Process | ?{ $_.ExecutablePath -and $_.ExecutablePath -ieq ${q(file)} } | %{ Stop-Process -Id $_.ProcessId -Force; $n++ }; $n`);
  return parseInt(r.stdout, 10) || 0;
}
/** Ask Windows to delete a locked file while it restarts. */
async function deleteOnRestart(file) {
  if (!IS_WIN || DEMO) return false;
  const r = await ps(`$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager'; $v=@((Get-ItemProperty -Path $k -Name PendingFileRenameOperations).PendingFileRenameOperations | ?{ $_ -ne $null }); $v += @(('\\??\\' + ${q(file)}), ''); New-ItemProperty -Path $k -Name PendingFileRenameOperations -PropertyType MultiString -Value $v -Force | Out-Null; 'ok'`);
  return /ok/.test(r.stdout);
}

async function quarantineFile(file, meta = {}) {
  if (DEMO && !fs.existsSync(file)) {
    await sleep(500);
    const id = crypto.randomUUID();
    fs.writeFileSync(path.join(qDir(), `${id}.json`), JSON.stringify({ id, file, threat: meta.threat, verdict: meta.verdict, size: meta.size || 0, sha256: meta.sha256 || null, at: Date.now(), demo: true }));
    return { ok: true, message: 'Quarantined — it can’t run any more.', qid: id };
  }
  const stopped = await stopProcesses(file);
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch (e) {
    await sleep(1500);
    if (!fs.existsSync(file)) return { ok: true, message: 'Microsoft Defender quarantined it as soon as FrameForge touched it.', by: 'defender' };
    return { ok: false, message: `Couldn’t read the file (${e.code || e.message}).` };
  }
  const id = crypto.randomUUID();
  const key = crypto.randomBytes(32);
  const d = qDir();
  fs.writeFileSync(path.join(d, `${id}.bin`), xor(buf, key));
  const rec = { id, file, threat: meta.threat || '', verdict: meta.verdict || '', size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), at: Date.now(), key: key.toString('base64') };
  fs.writeFileSync(path.join(d, `${id}.json`), JSON.stringify(rec));
  try {
    fs.rmSync(file, { force: true });
  } catch {
    if (await deleteOnRestart(file)) return { ok: true, pendingRestart: true, qid: id, message: 'Quarantined. The original is locked by Windows, so it’s removed at the next restart.' };
    return { ok: false, qid: id, message: 'A copy is in quarantine, but the original couldn’t be removed.' };
  }
  return { ok: true, qid: id, message: `Quarantined — it can’t run any more.${stopped ? ` Stopped ${stopped} running cop${stopped === 1 ? 'y' : 'ies'} of it first.` : ''}` };
}

async function deleteFile(file) {
  if (DEMO && !fs.existsSync(file)) {
    await sleep(400);
    return { ok: true, message: 'Deleted for good.' };
  }
  const stopped = await stopProcesses(file);
  try {
    fs.rmSync(file, { force: true });
  } catch (e) {
    if (await deleteOnRestart(file)) return { ok: true, pendingRestart: true, message: 'It’s locked by Windows, so it’s deleted at the next restart.' };
    return { ok: false, message: `Couldn’t delete it (${e.code || e.message}).` };
  }
  if (fs.existsSync(file)) return { ok: false, message: 'Windows didn’t let FrameForge delete it.' };
  return { ok: true, message: `Deleted for good.${stopped ? ` Stopped ${stopped} running cop${stopped === 1 ? 'y' : 'ies'} of it first.` : ''}` };
}

async function allowFile(file) {
  const list = [...new Set([...(settings.get().scanAllowed || []), file])];
  settings.set({ scanAllowed: list });
  if (DEMO || !IS_WIN) return { ok: true, message: 'Kept, and Defender won’t flag this exact file again.' };
  const r = await ps(`Add-MpPreference -ExclusionPath ${q(file)}`);
  return r.code === 0 ? { ok: true, message: 'Kept, and Defender won’t flag this exact file again.' } : { ok: true, message: 'Kept. (Windows didn’t accept the exclusion, so Defender may flag it again.)' };
}

async function restoreQuarantined(id, { allow = false } = {}) {
  const d = qDir();
  const mp = path.join(d, `${id}.json`);
  if (!fs.existsSync(mp)) return { ok: false, message: 'That item isn’t in quarantine any more.' };
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (!m.demo) {
    const buf = xor(fs.readFileSync(path.join(d, `${id}.bin`)), Buffer.from(m.key, 'base64'));
    fs.mkdirSync(path.dirname(m.file), { recursive: true });
    if (allow) await allowFile(m.file); // before writing, so real-time protection doesn't grab it straight back
    fs.writeFileSync(m.file, buf);
  } else if (allow) await allowFile(m.file);
  fs.rmSync(path.join(d, `${id}.bin`), { force: true });
  fs.rmSync(mp, { force: true });
  return { ok: true, message: `Restored to ${m.file}.` };
}
function deleteQuarantined(id) {
  const d = qDir();
  fs.rmSync(path.join(d, `${id}.bin`), { force: true });
  fs.rmSync(path.join(d, `${id}.json`), { force: true });
  return { ok: true, message: 'Deleted from quarantine for good.' };
}

/** Restore something Microsoft Defender quarantined (e.g. a false positive). */
async function restoreDefender(item, { allow = true } = {}) {
  if (DEMO) {
    await sleep(500);
    return { ok: true, message: 'Restored from Defender’s quarantine.' };
  }
  if (allow && item.file) await allowFile(item.file);
  const r = item.file ? await runMp(['-Restore', '-FilePath', item.file]) : await runMp(['-Restore', '-Name', item.threat]);
  return r.code === 0 ? { ok: true, message: `Restored${item.file ? ` to ${item.file}` : ''}.` } : { ok: false, message: 'Defender couldn’t restore it (it may already have been cleared from its quarantine).' };
}

module.exports = {
  mpCmdRun,
  runMp,
  killAll,
  parseMp,
  HR_TEXT,
  resolvePath,
  parseName,
  kindOf,
  TYPE_INFO,
  verdict,
  sha256,
  signatures,
  knownGood,
  engineStatus,
  checks,
  fixCheck,
  autostartFiles,
  quickFolders,
  walk,
  planChunks,
  history,
  quarantineList,
  quarantineFile,
  deleteFile,
  allowFile,
  restoreQuarantined,
  deleteQuarantined,
  restoreDefender,
  stopProcesses,
};
