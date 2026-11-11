// "Biggest FPS gains for your PC": the few things that raise frame rates the most on this exact hardware.
//
// Registry tweaks free up a few percent. The large gains — frame generation, upscaling, RAM at its rated speed —
// depend on which graphics card, processor and memory the PC has, and most of them are switched on in the
// driver app or in each game. So this builds a short list for the detected parts: what to turn on, where it is,
// what it realistically gives, and a button when FrameForge can do it itself. No invented numbers: every "gain"
// is the range the maker or independent tests report, worded as a range.

/** Which family of graphics card this is — it decides which features exist. */
function gpuFamily(gpu = {}) {
  const n = String(gpu.name || '').toUpperCase();
  if (gpu.vendor === 'nvidia') {
    if (/RTX\s*50\d\d/.test(n)) return 'rtx50';
    if (/RTX\s*40\d\d/.test(n)) return 'rtx40';
    if (/RTX/.test(n)) return 'rtx';
    return 'nvidia-old';
  }
  if (gpu.vendor === 'amd') {
    if (/RX\s*9\d{3}/.test(n)) return 'rx9000';
    if (/RX\s*7\d{3}/.test(n)) return 'rx7000';
    if (/RX\s*6\d{3}/.test(n)) return 'rx6000';
    if (/RX\s*5[5-7]\d\d/.test(n)) return 'rx5000';
    if (/\b[78][0-9]0M\b/.test(n)) return 'radeon-igpu'; // Radeon 700M / 800M built-in graphics
    return 'amd-old';
  }
  if (gpu.vendor === 'intel') return /ARC/.test(n) ? 'arc' : 'intel-igpu';
  return 'unknown';
}

/** Intel chips with fast and slow cores (12th gen and newer, Core Ultra). */
function isHybridIntel(cpu = {}) {
  if (cpu.vendor !== 'intel' && !/intel/i.test(cpu.name || '')) return false;
  if (/Core\(TM\) Ultra|Core Ultra/i.test(cpu.name || '')) return true;
  const { cores, threads } = cpu;
  return !!cores && !!threads && threads > cores && threads < cores * 2; // some cores have two threads, some one
}

function heightOf(display = {}) {
  const m = String(display.resolution || '').match(/(\d{3,5})\s*[×x]\s*(\d{3,5})/);
  return m ? Number(m[2]) : null;
}

/**
 * @param {object} rig       hardware.scan() result
 * @param {object} [state]   { on: { tweakId: true } } — boosts FrameForge already switched on
 * @returns {{ id, gain, title, body, where?, action? }[]} biggest first
 */
function plan(rig, state = {}) {
  if (!rig || !rig.gpu) return [];
  const on = state.on || {};
  const fam = gpuFamily(rig.gpu);
  const gpu = rig.gpu.name || 'graphics card';
  const app = (rig.vendorApp && rig.vendorApp.name) || null;
  const open = app ? { type: 'vendor', label: `Open ${app.split(':')[0].trim()}` } : null;
  const h = heightOf(rig.display);
  const hz = rig.display && rig.display.refreshHz;
  const out = [];

  // ---- 1. Frame generation: the only thing that can roughly double the frames on screen ----
  const fgNote = 'It works best when the game already runs at 50–60 FPS or more, and it adds a little input delay — leave it off in competitive shooters.';
  if (fam === 'rtx50' || fam === 'rtx40') {
    out.push({
      id: 'framegen',
      gain: 'About 2× the frames you see',
      title: 'Turn on NVIDIA Smooth Motion for your games',
      body: `Your ${gpu} can add a generated frame between every two it renders, in almost any DirectX 11 or 12 game. You switch it on per game. ${fgNote} Where a game has its own DLSS Frame Generation, use that instead — it looks cleaner.`,
      where: 'NVIDIA app › Graphics › Program Settings › pick the game › Smooth Motion → On',
      action: open,
    });
  } else if (fam === 'rx9000' || fam === 'rx7000' || fam === 'rx6000' || fam === 'radeon-igpu') {
    out.push({
      id: 'framegen',
      gain: 'About 2× the frames you see',
      title: 'Turn on AMD Fluid Motion Frames 2',
      body: `Your ${gpu} can add a generated frame between every two it renders, in DirectX 11/12, Vulkan and OpenGL games — one switch for all of them. ${fgNote}${fam === 'rx6000' ? ' On RX 6000 cards it needs the game in exclusive fullscreen, not borderless.' : ''}`,
      where: 'AMD Software › Gaming › Graphics › AMD Fluid Motion Frames 2 → On',
      action: open,
    });
  } else {
    out.push({
      id: 'framegen',
      gain: 'Up to about 2× in games that have it',
      title: 'Use the frame generation built into your games',
      body: `Your ${gpu} has no driver switch for frame generation, but many newer games include AMD FSR 3 Frame Generation${fam === 'arc' ? ' or Intel XeSS Frame Generation' : ''} in their own graphics menu, and it runs on any graphics card. ${fgNote}`,
      where: 'In each game: Graphics settings › Frame Generation',
    });
  }

  // ---- 2. Upscaling: render fewer pixels, show a sharp picture ----
  const small = h && h <= 1080;
  const mode = small ? 'Quality (lower modes look soft at 1080p)' : 'Quality, or Balanced for more';
  if (fam === 'rtx50' || fam === 'rtx40' || fam === 'rtx') {
    out.push({
      id: 'upscale',
      gain: small ? 'Typically 20–40% more FPS' : 'Typically 30–60% more FPS',
      title: 'Turn on DLSS in games that have it',
      body: `DLSS renders the game at a lower resolution and rebuilds a sharp ${rig.display && rig.display.resolution ? rig.display.resolution.replace(/\s/g, '') + ' ' : ''}picture with your RTX card’s AI hardware. On your screen, start with ${mode}.`,
      where: 'In each game: Graphics settings › DLSS (Super Resolution)',
    });
  } else if (fam === 'rx9000' || fam === 'rx7000' || fam === 'rx6000' || fam === 'rx5000') {
    out.push({
      id: 'upscale',
      gain: small ? 'Typically 20–40% more FPS' : 'Typically 30–60% more FPS',
      title: fam === 'rx9000' ? 'Turn on FSR 4 in games that have it' : 'Turn on FSR in games — and Radeon Super Resolution for the rest',
      body: `FSR renders the game at a lower resolution and sharpens it back up. On your screen, start with ${mode}. For games without FSR, Radeon Super Resolution does the same from the driver: switch it on, then lower the game’s resolution one step.`,
      where: 'In each game: Graphics settings › FSR. Driver: AMD Software › Gaming › Graphics › Radeon Super Resolution',
      action: open,
    });
  } else if (fam === 'arc') {
    out.push({
      id: 'upscale',
      gain: 'Typically 30–60% more FPS',
      title: 'Turn on XeSS in games that have it',
      body: `XeSS renders the game at a lower resolution and rebuilds the picture with your Arc card’s AI hardware. Start with ${mode}. FSR works too where a game has no XeSS.`,
      where: 'In each game: Graphics settings › XeSS',
    });
  } else {
    out.push({
      id: 'upscale',
      gain: 'Typically 30–60% more FPS',
      title: 'Turn on FSR in games that have it',
      body: `FSR renders the game at a lower resolution and sharpens it back up, and it runs on any graphics card including your ${gpu}. This is the biggest single gain on older or built-in graphics. Start with Balanced.`,
      where: 'In each game: Graphics settings › FSR (FidelityFX Super Resolution)',
    });
  }

  // ---- 3. Hardware set up below what it can do ----
  if (fam === 'arc') {
    out.push({
      id: 'rebar',
      gain: 'Large — Arc is built around it',
      title: 'Check that Resizable BAR is on',
      body: 'Intel Arc cards lose a big part of their speed, and stutter, when Resizable BAR is off. It is a BIOS setting (often next to “Above 4G decoding”). Intel’s graphics software shows whether it is on.',
      where: 'BIOS › Resizable BAR / Above 4G decoding → Enabled',
      action: open,
    });
  }
  const ram = rig.ram || {};
  const ddr = String(ram.type || '').toUpperCase();
  if ((ddr.includes('DDR4') && ram.speedMTs && ram.speedMTs <= 2666) || (ddr.includes('DDR5') && ram.speedMTs && ram.speedMTs <= 4800)) {
    out.push({
      id: 'ram_speed',
      gain: 'Often 10–20% in CPU-heavy games',
      title: `Run your RAM at full speed (it’s at ${ram.speedMTs} MT/s)`,
      body: `Your memory is running at the slow default instead of the speed printed on the box. One BIOS switch — ${rig.cpu && rig.cpu.vendor === 'amd' ? 'EXPO' : 'XMP'} — fixes it, and it lifts the lowest frame rates the most, which is what stutter is.`,
      where: `BIOS › ${rig.cpu && rig.cpu.vendor === 'amd' ? 'EXPO / DOCP' : 'XMP'} → Profile 1`,
      action: { type: 'goto', view: 'fix', label: 'Show me how' },
    });
  }
  if (ram.sticks === 1) {
    out.push({
      id: 'single_stick',
      gain: 'Often 20% or more with built-in graphics',
      title: 'Add a second RAM stick',
      body: 'One stick runs in single-channel mode, which halves how fast the processor can reach memory. Two matching sticks fix it. This is hardware, so no app can do it for you.',
    });
  }

  // ---- 4. What FrameForge can switch on right now for these parts ----
  if (isHybridIntel(rig.cpu) && !on.hybrid_pcores) {
    out.push({
      id: 'hybrid_pcores',
      gain: 'Steadier frames, fewer hitches',
      title: 'Keep games on your fast cores',
      body: `Your ${rig.cpu.name} mixes fast performance cores with slower efficiency cores. This tells Windows to prefer the fast ones, so a game’s threads don’t land on a slow core mid-fight. It helps most on Windows 10 and in older games.`,
      action: { type: 'tweak', id: 'hybrid_pcores', label: 'Turn it on' },
    });
  }
  if (!on.game_priority_boost) {
    out.push({
      id: 'booster',
      gain: 'Steadier frames with other apps open',
      title: 'Turn on Game Booster',
      body: 'While a game runs, the game gets the processor first and browsers and launchers wait. The more you leave open while playing, the more it helps.',
      action: { type: 'tweak', id: 'game_priority_boost', label: 'Turn it on' },
    });
  }
  if (hz && hz > 60) {
    out.push({
      id: 'cap',
      gain: 'No tearing, lowest delay',
      title: `Cap your frame rate at ${hz - 3} FPS`,
      body: `On a ${hz} Hz FreeSync or G-SYNC screen, holding the frame rate just under the refresh rate keeps every frame in the screen’s smooth range: no tearing, and no V-Sync delay. FrameForge’s FPS limiter does it for every game.`,
      where: `Settings › Overlay › FPS limiter → ${hz - 3}`,
      action: { type: 'goto', view: 'settings', label: 'Open the FPS limiter' },
    });
  }
  return out;
}

module.exports = { plan, gpuFamily, isHybridIntel };
