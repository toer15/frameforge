// Builds a profile for the exact PC FrameForge is running on: which tweaks fit it,
// why, and what else on this rig is holding performance back.

function gpuGeneration(gpu) {
  const n = (gpu.name || '').toUpperCase();
  if (gpu.vendor === 'nvidia') {
    if (/RTX|GTX\s?1[06]\d\d/.test(n)) return 'modern';
    return 'old';
  }
  if (gpu.vendor === 'amd') {
    if (/RX\s?(5[5-7]\d\d|6\d{3}|7\d{3}|9\d{3})/.test(n)) return 'modern';
    if (/RADEON\(TM\)|GRAPHICS$|VEGA \d/.test(n) && !/RX/.test(n)) return 'igpu';
    return 'old';
  }
  if (gpu.vendor === 'intel') return /ARC/.test(n) ? 'modern' : 'igpu';
  return 'unknown';
}

function isX3D(cpu) {
  return /X3D/i.test(cpu.name || '');
}

/** Which tweaks to turn on for this PC, each with a short reason. */
function recommend(rig) {
  const gen = gpuGeneration(rig.gpu);
  const lowRam = rig.ramGB && rig.ramGB < 16;
  const r = {
    restore_point: [true, 'Always — it’s your safety net.'],
    power_plan: [!rig.laptop, rig.laptop ? 'Laptop: keeps battery life sane. Use Power mode › Best performance while plugged in.' : 'Desktop: no reason to let clocks drop mid-game.'],
    game_mode: [true, isX3D(rig.cpu) ? 'Your X3D CPU needs Game Mode to put games on the cache cores.' : 'Helps every PC.'],
    game_dvr: [true, 'Background recording costs FPS on every PC.'],
    hags: [gen === 'modern', gen === 'modern' ? 'Your graphics card supports it.' : 'Your graphics card is too old to benefit.'],
    game_priority: [true, 'Helps every PC.'],
    mouse_precision: [true, 'Consistent aim on every PC.'],
    power_throttling: [!rig.laptop, rig.laptop ? 'Laptop: throttling protects battery life.' : 'Desktop: nothing to save power for.'],
    visual_effects: [!!lowRam || gen === 'igpu' || gen === 'old', lowRam ? `${rig.ramGB} GB RAM: every bit of memory counts.` : gen === 'modern' ? 'Your PC is strong enough to keep the nice visuals.' : 'Older graphics: worth the extra headroom.'],
    temp_cleanup: [true, 'Helps every PC.'],
    no_popups: [true, 'Nothing can steal focus from your game.'],
    usb_suspend: [true, 'Stops input hiccups on every PC.'],
    kb_repeat: [false, 'Personal taste — it changes how typing feels, not FPS.'],
    fso_off: [false, 'Only some older games benefit. Try it if a game feels laggy in fullscreen.'],
    timer_res: [/Windows 11|\b11\b/.test(rig.os || ''), /Windows 11|\b11\b/.test(rig.os || '') ? 'Windows 11 changed how game timers work — this restores the old behavior.' : 'Only does something on Windows 11.'],
    core_parking: [
      !rig.laptop && !isX3D(rig.cpu),
      isX3D(rig.cpu) ? 'Not for your X3D CPU — it parks cores on purpose so games stay on the cache cores.' : rig.laptop ? 'Laptop: parking saves battery and heat.' : 'Desktop: every core ready instantly.',
    ],
    cpu_min: [!rig.laptop, rig.laptop ? 'Laptop: low idle clocks keep it cool and quiet.' : 'Desktop: no slow ramp-up between frames.'],
    cpu_boost: [true, 'Faster jumps to boost clocks on every PC.'],
    sys_responsiveness: [true, 'More CPU time for games on every PC.'],
    pcie_lspm: [true, 'No wake-up delays for the graphics card.'],
    net_throttling: [true, 'No network limit while you play.'],
    nagle_off: [true, 'Lower ping in TCP games, harmless for the rest.'],
    bg_apps: [true, 'Fewer things running behind your game.'],
    transparency: [!!lowRam || gen !== 'modern', lowRam || gen !== 'modern' ? 'Saves a little graphics work on your PC.' : 'Your graphics card handles it easily — your choice.'],
    startup_delay: [true, 'Your apps are ready sooner after sign-in.'],
    menu_delay: [true, 'Snappier Windows.'],
    sysmain_off: [false, 'Only worth it if you see high disk use.'],
    mem_compression: [!!rig.ramGB && rig.ramGB >= 16, rig.ramGB && rig.ramGB >= 16 ? `${rig.ramGB} GB RAM is plenty — compression isn’t needed.` : `Keep it with ${rig.ramGB || 'under 16'} GB RAM — Windows needs it.`],
    dx_opt: [true, 'Lower latency for borderless games on every PC.'],
    ctt_tweaks: [true, 'Chris Titus’s Standard preset is built to be safe on every PC.'],
    game_gpu: [
      true,
      (rig.otherGpus && rig.otherGpus.length) || rig.laptop
        ? 'Your PC has more than one graphics chip — games can end up on the slow one without this.'
        : 'Makes sure every game uses your graphics card, even after Windows updates.',
    ],
  };
  const tweaks = {};
  const reasons = {};
  for (const [id, [on, why]] of Object.entries(r)) {
    tweaks[id] = on;
    reasons[id] = why;
  }
  return { tweaks, reasons };
}

/** Things on this rig worth fixing that FrameForge can't change from Windows. */
function insights(rig) {
  const out = [];
  const ram = rig.ram || {};
  const ddr = (ram.type || '').toUpperCase();
  if ((ddr.includes('DDR4') && ram.speedMTs && ram.speedMTs <= 2666) || (ddr.includes('DDR5') && ram.speedMTs && ram.speedMTs <= 4800)) {
    out.push({
      level: 'big',
      title: `Your RAM is running at ${ram.speedMTs} MT/s`,
      body: `That’s the slow default. Turn on ${rig.cpu.vendor === 'amd' ? 'EXPO' : 'XMP'} in your BIOS to run it at the speed on the box — often 10–20% more FPS in CPU-heavy games, for free.`,
    });
  }
  if (ram.sticks === 1) {
    out.push({
      level: 'big',
      title: 'Only one RAM stick detected',
      body: 'One stick runs in single-channel mode and can cost a lot of FPS. Two matching sticks double the memory bandwidth.',
    });
  }
  if (rig.display && rig.display.refreshHz && rig.display.refreshHz <= 60 && rig.gpu.vendor !== 'other') {
    out.push({
      level: 'medium',
      title: 'Your display is set to 60 Hz',
      body: 'If your monitor supports more, pick the highest rate in Settings › System › Display › Advanced display, and use a DisplayPort cable.',
    });
  }
  if (rig.laptop) {
    out.push({
      level: 'medium',
      title: 'Laptop detected',
      body: 'Plug in the charger while gaming — most laptops cut GPU power by half or more on battery.',
    });
  }
  if (isX3D(rig.cpu)) {
    out.push({
      level: 'info',
      title: `${rig.cpu.name} detected`,
      body: 'X3D chips gain little from overclocking. Keep the AMD chipset driver up to date and leave Game Mode on.',
    });
  }
  return out;
}

/** Vendor-specific overclocking plan. Only the vendor’s own auto-tuners touch clocks. */
function overclockPlan(rig, preset = 'performance') {
  const steps = [];
  if (rig.gpu.vendor === 'nvidia') {
    steps.push({ auto: true, title: 'Raise the graphics card power limit to its maximum', body: 'FrameForge does this for you. It resets when you restart, and FrameForge re-applies it.' });
    steps.push({ auto: false, title: 'Run Automatic Tuning in the NVIDIA app', body: 'NVIDIA app › System › Performance › Automatic Tuning. It stress-tests your exact card and finds its stable overclock.' });
  } else if (rig.gpu.vendor === 'amd') {
    const uv = { auto: false, title: 'Run Auto Undervolt GPU', body: 'AMD Software › Performance › Tuning › Tuning Control › Auto Undervolt GPU. AMD tests your exact card. Cooler and quieter, and it holds higher clocks for longer.' };
    const oc = { auto: false, title: 'Run Auto Overclock GPU', body: 'Same screen › Auto Overclock GPU (and Auto Overclock VRAM). AMD stress-tests your card and keeps only a stable clock.' };
    if (preset === 'performance' || preset === 'competitive') steps.push(oc, uv);
    else steps.push(uv);
  } else if (rig.gpu.vendor === 'intel') {
    steps.push({ auto: false, title: 'Use Performance Tuning in Intel Graphics Software', body: 'Raise the power limit slider step by step and test in a game.' });
  }
  if (rig.cpu.vendor === 'amd' && !isX3D(rig.cpu)) {
    steps.push({ auto: false, title: 'CPU: turn on Precision Boost Overdrive', body: 'In your BIOS (or AMD Ryzen Master). It lets the CPU boost higher automatically while staying inside safe limits.' });
  } else if (rig.cpu.vendor === 'intel' && /K\b|KF\b|KS\b/.test(rig.cpu.name)) {
    steps.push({ auto: false, title: 'CPU: use your motherboard’s AI overclocking', body: 'Most Z-series boards (ASUS AI Overclocking, MSI Game Boost) test your CPU and pick a stable clock in the BIOS.' });
  }
  return steps;
}

module.exports = { recommend, insights, overclockPlan, gpuGeneration };
