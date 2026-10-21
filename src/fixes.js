// Repair tools for Fix mode. Each one reports what it did, line by line, while it runs.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ps, DEMO, sleep } = require('./util');

/** Run a program and pass each output line to onLine. sfc/DISM print UTF-16 when piped, so decode either way. */
function runLines(file, args, onLine, timeout = 60 * 60 * 1000) {
  return new Promise((resolve) => {
    const p = spawn(file, args, { windowsHide: true });
    let buf = '';
    const feed = (chunk) => {
      const b = Buffer.from(chunk);
      const utf16 = b.length > 4 && b.filter((x, i) => i % 2 === 1 && x === 0).length > b.length / 4;
      buf += utf16 ? b.toString('utf16le') : b.toString('utf8');
      const parts = buf.split(/\r\n|\n|\r/);
      buf = parts.pop();
      parts.map((l) => l.replace(/\0/g, '').trim()).filter(Boolean).forEach(onLine);
    };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    const t = setTimeout(() => p.kill(), timeout);
    p.on('close', (code) => {
      clearTimeout(t);
      if (buf.trim()) onLine(buf.trim());
      resolve(code);
    });
    p.on('error', () => {
      clearTimeout(t);
      resolve(-1);
    });
  });
}

function folderSize(dir) {
  let total = 0;
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      try {
        total += e.isDirectory() ? folderSize(p) : fs.statSync(p).size;
      } catch {}
    }
  } catch {}
  return total;
}

function clearFolder(dir) {
  try {
    for (const e of fs.readdirSync(dir)) {
      try {
        fs.rmSync(path.join(dir, e), { recursive: true, force: true });
      } catch {}
    }
  } catch {}
}

const mb = (b) => (b >= 1024 ** 3 ? (b / 1024 ** 3).toFixed(1) + ' GB' : Math.round(b / 1024 ** 2) + ' MB');

const REPAIRS = {
  shader_cache: {
    name: 'Clear shader caches',
    desc: 'Fixes stutter and crashes after a driver update by clearing the DirectX, NVIDIA and AMD shader caches. Games rebuild them the first time you play (a few seconds of stutter once).',
    async run(onLine) {
      const L = process.env.LOCALAPPDATA || '';
      const P = process.env.ProgramData || 'C:\\ProgramData';
      const dirs = [
        path.join(L, 'D3DSCache'),
        path.join(L, 'NVIDIA', 'DXCache'),
        path.join(L, 'NVIDIA', 'GLCache'),
        path.join(P, 'NVIDIA Corporation', 'NV_Cache'),
        path.join(L, 'AMD', 'DxCache'),
        path.join(L, 'AMD', 'DxcCache'),
        path.join(L, 'AMD', 'VkCache'),
        path.join(L, 'AMD', 'GLCache'),
        path.join(L, 'Intel', 'ShaderCache'),
      ];
      let freed = 0;
      const details = [];
      for (const d of dirs) {
        if (DEMO) {
          await sleep(200);
          onLine(`Cleared ${d}`);
          continue;
        }
        if (!fs.existsSync(d)) continue;
        const before = folderSize(d);
        clearFolder(d);
        const gone = Math.max(0, before - folderSize(d));
        freed += gone;
        onLine(`Cleared ${d} (${mb(gone)})`);
        details.push(`Cleared ${d}: ${mb(gone)}`);
      }
      if (DEMO) return { ok: true, message: 'Cleared 1.2 GB of shader caches.', details: ['Cleared %LOCALAPPDATA%\\D3DSCache: 640 MB', 'Cleared %LOCALAPPDATA%\\AMD\\DxCache: 580 MB'] };
      return { ok: true, message: freed ? `Cleared ${mb(freed)} of shader caches.` : 'Shader caches were already empty.', details };
    },
  },
  network: {
    name: 'Reset network',
    desc: 'Fixes lag spikes, “no internet” and connection problems by flushing DNS and resetting Winsock and TCP/IP to Windows defaults. Needs a restart. Custom DNS or VPN adapters may need setting up again.',
    reboot: true,
    async run(onLine) {
      const steps = [
        ['ipconfig', ['/flushdns'], 'Flushed the DNS cache'],
        ['netsh', ['winsock', 'reset'], 'Reset Winsock'],
        ['netsh', ['int', 'ip', 'reset'], 'Reset TCP/IP'],
      ];
      const details = [];
      let failed = 0;
      for (const [f, a, label] of steps) {
        if (DEMO) {
          await sleep(500);
          onLine(label);
          details.push(label);
          continue;
        }
        const code = await runLines(f, a, onLine, 120000);
        if (code !== 0) failed++;
        details.push(`${label}${code === 0 ? '' : ` — FAILED (exit code ${code})`}`);
      }
      if (failed === steps.length) return { ok: false, message: 'Windows refused every network reset step (FrameForge needs to run as administrator for this).', details };
      return { ok: !failed, warn: !!failed, message: failed ? `Network reset, but ${failed} of ${steps.length} steps failed — see the details. Restart your PC to finish.` : 'Network reset. Restart your PC to finish.', details };
    },
  },
  system_files: {
    name: 'Repair Windows system files',
    desc: 'Runs DISM /RestoreHealth then SFC /scannow — Microsoft’s own tools for fixing corrupted Windows files that cause crashes and errors. Takes 10–30 minutes.',
    async run(onLine) {
      if (DEMO) {
        for (const l of ['Deployment Image Servicing and Management tool', '[==========================100.0%==========================]', 'The restore operation completed successfully.', 'Beginning system scan.  This process will take some time.', 'Verification 100% complete.', 'Windows Resource Protection did not find any integrity violations.']) {
          await sleep(500);
          onLine(l);
        }
        return { ok: true, message: 'DISM and SFC finished. No problems found.', details: ['DISM /Online /Cleanup-Image /RestoreHealth: completed', 'SFC /scannow: no integrity violations'] };
      }
      const lastOf = (arr, re) => [...arr].reverse().find((l) => re.test(l));
      const dl = [];
      onLine('Running DISM /Online /Cleanup-Image /RestoreHealth…');
      const d = await runLines('DISM.exe', ['/Online', '/Cleanup-Image', '/RestoreHealth'], (l) => {
        dl.push(l);
        onLine(l);
      });
      const sl = [];
      onLine('Running SFC /scannow…');
      const sc = await runLines('sfc.exe', ['/scannow'], (l) => {
        sl.push(l);
        onLine(l);
      });
      const sfcResult = lastOf(sl, /Windows Resource Protection/i) || `exit code ${sc}`;
      const ok = d === 0 && sc === 0;
      return {
        ok,
        warn: !ok,
        message: /did not find any integrity violations/i.test(sfcResult) ? 'DISM and SFC finished. No problems found.' : /successfully repaired/i.test(sfcResult) ? 'Found and repaired corrupted Windows files. Restart your PC.' : `Finished: ${sfcResult}`,
        details: [`DISM /RestoreHealth: ${lastOf(dl, /operation completed|Error/i) || `exit code ${d}`}`, `SFC /scannow: ${sfcResult}`],
      };
    },
  },
  restore_points: {
    name: 'Turn on System Protection',
    desc: 'Turns on restore points for drive C: so FrameForge (and you) can make a safety snapshot before changes.',
    async run(onLine) {
      if (DEMO) {
        await sleep(600);
        onLine('System Protection turned on for C:');
        return { ok: true, message: 'System Protection is on for C:.', details: ['Enable-ComputerRestore -Drive C:\\', 'Restore point space: 5%'] };
      }
      const r = await ps("Enable-ComputerRestore -Drive \"$env:SystemDrive\\\" -ErrorAction Stop; vssadmin Resize ShadowStorage /For=$env:SystemDrive /On=$env:SystemDrive /MaxSize=5% | Out-Null; 'ok'");
      onLine(r.code === 0 ? 'System Protection turned on.' : (r.stderr || r.stdout).trim());
      return r.code === 0 ? { ok: true, message: 'System Protection is on for your system drive.', details: ['Enable-ComputerRestore on the system drive', 'Restore point space: 5% of the drive'] } : { ok: false, message: (r.stderr || r.stdout).trim().slice(0, 200) };
    },
  },
};

module.exports = { REPAIRS, runLines };
