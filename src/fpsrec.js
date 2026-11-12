// Recommends a frame cap for the detected PC. The display sets the ceiling; the
// graphics card decides how much of that ceiling is realistic to hold.
const MIN_FPS = 20;
const MAX_FPS = 1000;

function gpuClass(name = '') {
  const t = String(name).toLowerCase();
  if (!t || /no graphics|basic display|microsoft basic/.test(t)) return 'unknown';
  if (/intel.*(hd|uhd|iris)|radeon.*(graphics|vega)|\bvega\s*\d|apple m\d|qualcomm|adreno/.test(t)) return 'integrated';
  if (/(rtx\s*(5090|5080|5070\s*ti|4090|4080|4070\s*ti|4070\s*super|3090|3080\s*ti)|rx\s*(7900\s*xtx|7900\s*xt|9070\s*xt))/.test(t)) return 'high';
  if (/(rtx\s*(5070|4070|4060\s*ti|4060|3080|3070|3060\s*ti|3060|2080|2070|1080\s*ti|1080)|rx\s*(9070|9060\s*xt|7800\s*xt|7700\s*xt|7600|6800\s*xt|6700\s*xt|6600\s*xt|6600)|arc\s*(b580|a770|a750|a580))/.test(t)) return 'mid';
  if (/(gtx\s*(1660|1650|1080|1070|1060|1050)|rx\s*(6500|6400|580|570|550|480)|arc\s*a380|\bmx\s*\d|quadro|tesla)/.test(t)) return 'low';
  return 'unknown';
}

function clamp(n) {
  return Math.max(MIN_FPS, Math.min(MAX_FPS, Math.round(Number(n) || 0)));
}

/**
 * Returns { fps, refreshHz, gpuClass, gpu, reason }.
 * A high-refresh display gets a small headroom below its maximum; slower cards
 * are capped at a target they can actually hold instead of chasing the panel.
 */
function recommend(rig) {
  const gpu = (rig && rig.gpu && rig.gpu.name) || '';
  const klass = gpuClass(gpu);
  const refreshHz = Math.round(Number(rig && rig.display && rig.display.refreshHz) || 0);
  const hasRefresh = refreshHz >= 20;
  const hz = hasRefresh ? refreshHz : 60;

  const ceiling = { high: hz, mid: 144, low: 75, integrated: 60, unknown: 60 }[klass];
  const base = Math.min(hz, ceiling);
  // At 100 Hz and above, staying a few frames under the refresh rate leaves
  // room for frame-time spikes and keeps VRR from hitting its ceiling.
  const fps = clamp(base >= 100 ? base - 3 : base);

  let reason;
  if (!hasRefresh) {
    reason = `FrameForge couldn’t read your display’s refresh rate, so ${fps} FPS is a safe starting point. You can type a higher number if your monitor can do more.`;
  } else if (klass === 'integrated') {
    reason = `Your ${gpu || 'integrated graphics'} is built into the processor, so ${fps} FPS is a realistic target that stays smooth. Type a higher number if a particular game runs well.`;
  } else if (klass === 'low') {
    reason = `Your ${gpu} is happiest around 60–75 FPS in modern games. ${fps} FPS will feel steadier than chasing your display’s ${hz} Hz.`;
  } else if (klass === 'mid') {
    reason = `Your ${gpu} and ${hz} Hz display work well together at ${fps} FPS: high enough to feel responsive, with headroom for busy scenes.`;
  } else if (klass === 'high') {
    reason = `Your ${gpu} can drive this ${hz} Hz display, so ${fps} FPS is the sweet spot: just under the refresh rate, with room for frame-time spikes.`;
  } else {
    reason = `FrameForge couldn’t identify your graphics card, so ${fps} FPS is a safe starting point for this ${hz} Hz display.`;
  }

  return { fps, refreshHz: hasRefresh ? hz : null, gpuClass: klass, gpu, reason };
}

module.exports = { recommend, gpuClass, MIN_FPS, MAX_FPS };
