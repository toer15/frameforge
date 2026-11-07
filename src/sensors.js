// Live CPU/GPU temperature and load — only from real sensors.
//
// Sources, best first:
//   1. LibreHardwareMonitor (reads the actual CPU die and GPU sensors on AMD, Intel and NVIDIA)
//      — via its WMI namespace, or its local web server if WMI isn't available
//   2. nvidia-smi (NVIDIA's own driver tool) for NVIDIA GPU temperature and load
//   3. Windows performance counters for CPU and GPU load
// Windows' "thermal zone" reading is NOT used for CPU temperature: on most PCs it's a motherboard
// sensor that can be 20–30 °C off, so FrameForge shows "—" instead of a wrong number.
const { spawn } = require('child_process');
const readline = require('readline');
const http = require('http');
const si = require('systeminformation');
const os = require('os');
const { run, DEMO } = require('./util');

const LHM_LOOP = `
$ErrorActionPreference='SilentlyContinue'
while($true){
  $s = Get-CimInstance -Namespace root/LibreHardwareMonitor -ClassName Sensor -ErrorAction SilentlyContinue |
       Where-Object { $_.SensorType -eq 'Temperature' -or $_.SensorType -eq 'Load' -or ($_.SensorType -eq 'SmallData' -and $_.Name -like 'GPU Memory Total') } |
       Select-Object Name,SensorType,Value,Identifier
  if($s){ @{ok=$true; s=@($s)} | ConvertTo-Json -Compress -Depth 4 } else { '{"ok":false}' }
  Start-Sleep -Milliseconds 1000
}`;

// Windows' own GPU engine counter (same number Task Manager shows), used when no other GPU load source exists.
const GPU_LOAD_LOOP = `
$ErrorActionPreference='SilentlyContinue'
while($true){
  $c = (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples
  if($c){ $v = ($c | Measure-Object CookedValue -Sum).Sum; [math]::Round([math]::Min(100,$v)) } else { '-1' }
  Start-Sleep -Milliseconds 1000
}`;

const isCpuId = (id) => /^\/(amdcpu|intelcpu|cpu)/i.test(id || '');
const isGpuId = (id) => /^\/gpu-/i.test(id || '');
const isDedicatedGpuId = (id) => /^\/gpu-(nvidia|amd)/i.test(id || '');

/**
 * Pick the right sensors out of LibreHardwareMonitor's list.
 * list: [{ Name, SensorType: 'Temperature'|'Load', Value, Identifier }]
 */
function pickSensors(list) {
  const pick = (arr, prefs) => {
    for (const p of prefs) {
      const f = arr.find((s) => p.test(s.Name) && Number.isFinite(s.Value) && (s.SensorType === 'Load' ? s.Value >= 0 : s.Value > 0));
      if (f) return Math.round(f.Value);
    }
    return null;
  };
  const temps = list.filter((s) => s.SensorType === 'Temperature');
  const loads = list.filter((s) => s.SensorType === 'Load');
  // Several GPUs (e.g. a Ryzen/Intel CPU's built-in graphics + a graphics card): use the one with the most
  // video memory, then the one working hardest, then a dedicated NVIDIA/AMD one.
  const gpuKey = (id) => (id || '').split('/').slice(0, 3).join('/');
  const keys = [...new Set(list.filter((s) => isGpuId(s.Identifier)).map((s) => gpuKey(s.Identifier)))];
  const score = (k) => {
    const mem = list.find((s) => gpuKey(s.Identifier) === k && s.SensorType === 'SmallData');
    const load = loads.find((s) => gpuKey(s.Identifier) === k && /^GPU Core$|^D3D 3D$/i.test(s.Name));
    return (mem ? mem.Value : 0) * 1000 + (load ? load.Value : 0) + (isDedicatedGpuId(k) ? 0.5 : 0) - (/integrated/i.test(k) ? 1e9 : 0);
  };
  keys.sort((a, b) => score(b) - score(a));
  const mainGpu = keys[0];
  const gpuTemps = temps.filter((s) => gpuKey(s.Identifier) === mainGpu);
  const gpuLoads = loads.filter((s) => gpuKey(s.Identifier) === mainGpu);
  return {
    // AMD: "Core (Tdie)" / "Core (Tctl/Tdie)" are the real die temperature; plain "Tctl" on older Ryzen has an offset.
    // Intel: "CPU Package" is what HWiNFO and Intel XTU show.
    cpuTemp: pick(temps.filter((s) => isCpuId(s.Identifier)), [/Tdie/i, /^CPU Package$/i, /Package/i, /Tctl/i, /Core Max/i, /Core Average/i]),
    // "GPU Core" is the number AMD Software and the NVIDIA app show as GPU temperature.
    gpuTemp: pick(gpuTemps, [/^GPU Core$/i, /^GPU Edge$/i, /Core/i]),
    cpuLoad: pick(loads.filter((s) => isCpuId(s.Identifier)), [/^CPU Total$/i]),
    gpuLoad: pick(gpuLoads, [/^GPU Core$/i, /^D3D 3D$/i]),
  };
}

/** Flatten LibreHardwareMonitor's web server JSON (data.json) into the same list shape. */
function flattenLhmJson(node, out = []) {
  if (!node) return out;
  if (node.SensorId && node.Type && (node.Type === 'Temperature' || node.Type === 'Load' || (node.Type === 'SmallData' && /GPU Memory Total/i.test(node.Text)))) {
    const v = parseFloat(String(node.Value).replace(',', '.'));
    out.push({ Name: node.Text, SensorType: node.Type, Value: v, Identifier: node.SensorId });
  }
  (node.Children || []).forEach((c) => flattenLhmJson(c, out));
  return out;
}

function fetchLhmJson(port = 8085) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/data.json', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

class Sensors {
  constructor() {
    this.lhm = null;
    this.lhmAt = 0;
    this.procs = [];
    this.nv = null;
    this.nvAt = 0;
    this.nvAttemptAt = 0;
    this.cpuLoad = null;
    this.cpuLoadAt = 0;
    this.winGpuLoad = null;
    this.winGpuLoadAt = 0;
    this.timers = [];
    this.generation = 0;
    this.running = false;
    this.config = null;
    this.performanceMode = false;
    this.pollInterval = 1000;
    this.freshMs = 5000;
    this.warning = null;
  }

  start(vendor, { performanceMode = false } = {}) {
    const enabled = performanceMode === true;
    const config = JSON.stringify([vendor || null, enabled]);
    if (this.running && this.config === config) return;
    this.stop();
    this.running = true;
    this.config = config;
    this.performanceMode = enabled;
    this.pollInterval = enabled ? 3000 : 1000;
    this.freshMs = Math.max(5000, this.pollInterval * 2);
    this.warning = null;
    if (DEMO) return;
    const generation = this.generation;
    const active = () => this.running && this.generation === generation;
    const spawnMonitor = (script, onLine) => {
      try {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script.replace('Start-Sleep -Milliseconds 1000', `Start-Sleep -Milliseconds ${this.pollInterval}`)], { windowsHide: true });
        this.procs.push(child);
        child.on('error', () => {
          if (active()) this.warning = 'A Windows monitoring helper could not start. Available sensor sources are still used.';
        });
        readline.createInterface({ input: child.stdout }).on('line', (line) => {
          if (active()) onLine(line);
        });
        if (enabled && Number.isInteger(child.pid) && child.pid > 0) {
          try {
            os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
          } catch {
            this.warning = 'Windows could not lower the monitoring helpers’ priority. Reduced polling is still active.';
          }
        }
      } catch {
        this.warning = 'A Windows monitoring helper could not start. Available sensor sources are still used.';
      }
    };

    // 1a. LibreHardwareMonitor over WMI
    spawnMonitor(LHM_LOOP, (l) => {
      try {
        const j = JSON.parse(l);
        if (j.ok) this.setLhm(pickSensors(j.s), 'LibreHardwareMonitor');
      } catch {}
    });

    // 2. Windows GPU counter for load (only matters when nothing better is available)
    spawnMonitor(GPU_LOAD_LOOP, (l) => {
      const v = parseInt(l, 10);
      this.winGpuLoad = v >= 0 ? v : null;
      this.winGpuLoadAt = Date.now();
    });

    let ticking = false;
    const nvidiaInterval = enabled ? 6000 : 2000;
    const tick = async () => {
      if (ticking || !active()) return;
      ticking = true;
      try {
      // 1b. LibreHardwareMonitor web server, if WMI has gone quiet
      if (Date.now() - this.lhmAt > Math.max(3000, this.pollInterval * 2)) {
        const j = await fetchLhmJson();
        if (!active()) return;
        if (j) this.setLhm(pickSensors(flattenLhmJson(j)), 'LibreHardwareMonitor');
      }
      // LibreHardwareMonitor already reports CPU load: skip the extra system call that would just duplicate it.
      const fresh = Date.now() - this.lhmAt < this.freshMs;
      if (!fresh || !this.lhm || this.lhm.cpuLoad == null) {
        try {
          const l = await si.currentLoad();
          if (!active()) return;
          this.cpuLoad = Math.round(l.currentLoad);
          this.cpuLoadAt = Date.now();
        } catch {}
      }
      // nvidia-smi is a program of its own, so it only runs when the sensor reader isn't answering, and at most
      // every two seconds, or six seconds in Windows performance mode.
      if (!active()) return;
      if (vendor === 'nvidia' && !fresh && Date.now() - this.nvAttemptAt >= nvidiaInterval) {
        this.nvAttemptAt = Date.now();
        const r = await run('nvidia-smi', ['--query-gpu=temperature.gpu,utilization.gpu', '--format=csv,noheader,nounits'], { timeout: 4000 });
        if (!active()) return;
        if (r.code === 0) {
          const [t, u] = r.stdout.trim().split(/\r?\n/)[0].split(',').map((x) => parseFloat(x));
          this.nv = { temp: Number.isFinite(t) ? t : null, load: Number.isFinite(u) ? u : null };
          this.nvAt = Date.now();
        }
      }
      } catch {
        // A missing sensor source must not stop the remaining sources or leave the poll locked.
      } finally {
        ticking = false;
      }
    };
    tick();
    this.timers.push(setInterval(tick, this.pollInterval));
  }

  setLhm(v, source) {
    if (v.cpuTemp == null && v.gpuTemp == null && v.cpuLoad == null && v.gpuLoad == null) return;
    this.lhm = { ...v, source };
    this.lhmAt = Date.now();
  }

  /** Current readings, each with where it came from. null means "no trustworthy sensor". */
  read() {
    if (DEMO) {
      const w = (b, r) => Math.round(b + (Math.random() - 0.5) * r);
      return { cpuTemp: w(63, 6), gpuTemp: w(71, 5), cpuLoad: w(38, 14), gpuLoad: w(94, 6), sources: { cpuTemp: 'LibreHardwareMonitor', gpuTemp: 'LibreHardwareMonitor' } };
    }
    const l = Date.now() - this.lhmAt < this.freshMs ? this.lhm || {} : {};
    const nv = Date.now() - this.nvAt < Math.max(5000, this.performanceMode ? 12000 : 5000) ? this.nv || {} : {};
    const cpuLoad = Date.now() - this.cpuLoadAt < this.freshMs ? this.cpuLoad : null;
    const winGpuLoad = Date.now() - this.winGpuLoadAt < this.freshMs ? this.winGpuLoad : null;
    const val = (...pairs) => {
      for (const [v, src] of pairs) if (v != null) return [v, src];
      return [null, null];
    };
    const [cpuTemp, cpuTempSrc] = val([l.cpuTemp, 'LibreHardwareMonitor']);
    const [gpuTemp, gpuTempSrc] = val([nv.temp, 'NVIDIA driver'], [l.gpuTemp, 'LibreHardwareMonitor']);
    const [selectedCpuLoad, cpuLoadSrc] = val([l.cpuLoad, 'LibreHardwareMonitor'], [cpuLoad, 'Windows']);
    const [gpuLoad, gpuLoadSrc] = val([nv.load, 'NVIDIA driver'], [l.gpuLoad, 'LibreHardwareMonitor'], [winGpuLoad, 'Windows']);
    return {
      cpuTemp,
      gpuTemp,
      cpuLoad: selectedCpuLoad,
      gpuLoad,
      sources: { cpuTemp: cpuTempSrc, gpuTemp: gpuTempSrc, cpuLoad: cpuLoadSrc, gpuLoad: gpuLoadSrc },
    };
  }

  stop() {
    this.generation++;
    this.running = false;
    this.config = null;
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.procs.forEach((p) => {
      try {
        p.kill();
      } catch {}
    });
    this.procs = [];
  }
}

module.exports = { Sensors, pickSensors, flattenLhmJson };
