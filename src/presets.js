// The goals the user can pick in the preset slideshow. Each one decides which boosts Auto Mode
// applies; the PC's own profile can still veto a boost that would hurt this hardware (e.g. a laptop
// never gets the "no power saving" boosts, an old graphics card never gets GPU scheduling).
const profile = require('./profile');

const PRESETS = {
  competitive: {
    id: 'competitive',
    name: 'Competitive',
    tagline: 'Lowest input lag and the steadiest frame times, for shooters and ranked games.',
    changes: [
      'Everything in Best performance',
      'No notification banners or Sticky Keys pop-ups mid-match',
      'Raw mouse aim, games on top CPU/GPU priority',
      'Driver set to Reflex / Anti-Lag with V-Sync off',
      'With overclocking on: graphics card power limit raised',
    ],
    tweaks: {
      restore_point: true,
      power_plan: true,
      game_mode: true,
      game_dvr: true,
      hags: true,
      game_priority: true,
      mouse_precision: true,
      power_throttling: true,
      visual_effects: true,
      temp_cleanup: true,
      ctt_tweaks: true,
      dx_opt: true,
      game_gpu: true,
      no_popups: true,
    },
  },
  performance: {
    id: 'performance',
    name: 'Best performance',
    tagline: 'Highest FPS and lowest input lag. Windows itself looks plainer.',
    changes: [
      'Ultimate Performance power plan, no power throttling',
      'Windows animations and shadows turned off',
      'Chris Titus tweaks: telemetry and background services off',
      'Games get top CPU/GPU priority and the fastest graphics card',
      'Driver set to low latency and high-performance texture filtering',
    ],
    tweaks: {
      restore_point: true,
      power_plan: true,
      game_mode: true,
      game_dvr: true,
      hags: true,
      game_priority: true,
      mouse_precision: true,
      power_throttling: true,
      visual_effects: true,
      temp_cleanup: true,
      ctt_tweaks: true,
      dx_opt: true,
      game_gpu: true,
      no_popups: false,
    },
  },
  balanced: {
    id: 'balanced',
    name: 'Balanced',
    tagline: 'Most of the FPS gain, while Windows keeps looking and working like normal.',
    changes: [
      'Ultimate Performance power plan',
      'Game Mode on, background recording off',
      'Games run on the fastest graphics card',
      'Windows visuals and services left as they are',
      'Driver set to low latency with quality upscaling',
    ],
    tweaks: {
      restore_point: true,
      power_plan: true,
      game_mode: true,
      game_dvr: true,
      hags: true,
      game_priority: true,
      mouse_precision: true,
      power_throttling: false,
      visual_effects: false,
      temp_cleanup: true,
      ctt_tweaks: false,
      dx_opt: true,
      game_gpu: true,
      no_popups: false,
    },
  },
  graphics: {
    id: 'graphics',
    name: 'Best graphics',
    tagline: 'The sharpest, richest picture your PC can hold at a smooth framerate.',
    changes: [
      'Auto HDR on for HDR screens',
      'Full clock speeds so high settings stay smooth',
      'Windows visuals kept on',
      'Games run on the fastest graphics card',
      'Driver set to high-quality textures, sharpening and quality upscaling',
    ],
    tweaks: {
      restore_point: true,
      power_plan: true,
      game_mode: true,
      game_dvr: true,
      hags: true,
      game_priority: true,
      mouse_precision: false,
      power_throttling: false,
      visual_effects: false,
      temp_cleanup: true,
      ctt_tweaks: false,
      dx_opt: true,
      game_gpu: true,
      no_popups: false,
    },
  },
};

// Boosts the PC profile may switch off for hardware reasons, whatever the preset says.
const HARDWARE_VETO = ['power_plan', 'power_throttling', 'hags'];

/** Boost list for this preset on this PC, plus a reason for each. */
function compose(presetId, rig) {
  const preset = PRESETS[presetId] || PRESETS.performance;
  const rec = rig ? profile.recommend(rig) : { tweaks: {}, reasons: {} };
  const tweaks = {};
  const reasons = {};
  for (const [id, on] of Object.entries(preset.tweaks)) {
    const vetoed = on && HARDWARE_VETO.includes(id) && rec.tweaks[id] === false;
    tweaks[id] = on && !vetoed;
    if (vetoed) reasons[id] = rec.reasons[id];
    else if (on) reasons[id] = `${preset.name}: ${rec.reasons[id] || 'part of this preset.'}`;
    else reasons[id] = `Not part of ${preset.name}.`;
  }
  return { tweaks, reasons, preset };
}

function list() {
  return Object.values(PRESETS).map(({ id, name, tagline, changes }) => ({ id, name, tagline, changes }));
}

module.exports = { PRESETS, compose, list };
