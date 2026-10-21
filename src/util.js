// Small helpers for running Windows commands safely from the main process.
const { execFile } = require('child_process');

const IS_WIN = process.platform === 'win32';
const DEMO = !IS_WIN || process.env.FRAMEFORGE_DEMO === '1';

/** Run a program and resolve with { code, stdout, stderr } (never rejects). */
function run(file, args = [], opts = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { windowsHide: true, timeout: opts.timeout || 60000, maxBuffer: 16 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: err || null,
        });
      }
    );
  });
}

/** Run a PowerShell script block. */
function ps(script, opts = {}) {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    opts
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** True when this process is running elevated (admin). */
async function isAdmin() {
  if (!IS_WIN) return true;
  const r = await run('net', ['session']);
  return r.code === 0;
}

module.exports = { run, ps, sleep, isAdmin, IS_WIN, DEMO };
