// Step-by-step instructions for problems no app can fix from Windows (BIOS settings, hardware, cables).
// Tailored to the PC: motherboard brand, CPU brand, graphics card brand.

function brandOf(rig) {
  const m = ((rig && rig.board && rig.board.manufacturer) || '').toLowerCase();
  if (/asus/.test(m)) return 'asus';
  if (/micro-star|msi/.test(m)) return 'msi';
  if (/gigabyte|aorus/.test(m)) return 'gigabyte';
  if (/asrock/.test(m)) return 'asrock';
  return 'other';
}

const BOARD_NAME = { asus: 'ASUS', msi: 'MSI', gigabyte: 'Gigabyte', asrock: 'ASRock', other: 'your' };

/** Turn on XMP / EXPO so RAM runs at its rated speed. */
function ramSpeed(rig) {
  const b = brandOf(rig);
  const profile = rig && rig.cpu && rig.cpu.vendor === 'amd' ? 'EXPO' : 'XMP';
  const where = {
    asus: `In EZ Mode, set “AI Overclock Tuner” (or the D.O.C.P / XMP / EXPO box) to “${profile} I”. In Advanced Mode it’s under Ai Tweaker › Ai Overclock Tuner.`,
    msi: `In EZ Mode, click the “${profile === 'EXPO' ? 'EXPO' : 'XMP'}” button at the top left and pick Profile 1. In Advanced Mode it’s under OC › Extreme Memory Profile.`,
    gigabyte: `In Easy Mode, set “${profile === 'EXPO' ? 'XMP/EXPO' : 'X.M.P.'}” to Profile 1. In Advanced Mode it’s under Tweaker › Extreme Memory Profile.`,
    asrock: `Go to OC Tweaker › DRAM Configuration and set “Load ${profile} Setting” to Profile 1.`,
    other: `Look for “${profile}”, “XMP”, “EXPO”, “DOCP” or “Memory Profile” — usually under Overclocking, Tweaker or Advanced › Memory — and pick Profile 1.`,
  }[b];
  return [
    `Restart the PC and tap Delete (or F2) as soon as the screen turns on, to open the ${BOARD_NAME[b]} BIOS.`,
    where,
    'Press F10 and choose Yes to save and restart.',
    'The first start can take 1–2 minutes while the RAM is tested — that’s normal. Don’t switch it off.',
    'If the PC doesn’t start after 3 tries, it goes back to safe settings by itself. Then try Profile 2, or update the BIOS first.',
    'Back in Windows, open FrameForge — Fix mode checks the new speed by itself.',
  ];
}

function singleStick(rig) {
  const ram = (rig && rig.ram) || {};
  return [
    `Buy a kit of 2 matching sticks${ram.type ? ` (${ram.type}${ram.speedMTs ? `, the same speed as on the box of your current one` : ''})` : ''}. A 2-stick kit is better than adding one random stick.`,
    'Switch the PC off and unplug it. Touch the metal case to discharge static.',
    'Put the two sticks in slots A2 and B2 — usually the 2nd and 4th slots counting from the CPU. Your motherboard manual shows the exact slots.',
    'Start the PC, then turn on XMP/EXPO in the BIOS so they run at full speed.',
  ];
}

function hotCpu(rig, temp) {
  return [
    `${temp ? `${temp} °C is high. ` : ''}First check the CPU cooler fan spins while gaming (look through the side panel).`,
    'Clean dust from the CPU cooler, case fans and filters with compressed air — hold fans still while you blow on them.',
    `In the BIOS, set the CPU fan curve to “Performance” or “Turbo”${brandOf(rig) === 'asus' ? ' (ASUS: Q-Fan Control)' : brandOf(rig) === 'msi' ? ' (MSI: Hardware Monitor)' : brandOf(rig) === 'gigabyte' ? ' (Gigabyte: Smart Fan 6)' : ''}.`,
    'Make sure the case has at least one fan pulling air in at the front and one pushing it out at the back.',
    'If the cooler is more than 3–4 years old, replace the thermal paste between the CPU and the cooler.',
  ];
}

function hotGpu(rig, temp) {
  const v = rig && rig.gpu && rig.gpu.vendor;
  return [
    `${temp ? `${temp} °C is high. ` : ''}Clean dust from the graphics card fans and heatsink with compressed air.`,
    v === 'amd'
      ? 'Undervolt it safely: AMD Software › Performance › Tuning › Auto Undervolt GPU. It runs cooler with the same or better performance.'
      : v === 'nvidia'
        ? 'Undervolt it safely: NVIDIA app › System › Performance › Automatic Tuning, or lower the power limit to 85–90% in MSI Afterburner.'
        : 'Lower the power limit slightly in your graphics driver app.',
    'Give the card room to breathe: no cables in front of its fans, and a case fan pulling fresh air in.',
    'Turn on a frame-rate cap a little above your monitor’s refresh rate — the card stops running flat out for frames you can’t see.',
  ];
}

function displayCable(info) {
  return [
    'Plug the monitor into the graphics card (the ports low on the back of the PC), not the motherboard ports higher up.',
    `Use a DisplayPort cable, or an HDMI 2.1 cable, for high refresh rates${info && info.res ? ` at ${info.res}` : ''}. Older HDMI cables cap many monitors at 60 Hz.`,
    'Check the monitor’s own menu: some have the high refresh rate (or “overclock”) switched off by default.',
    'Then press “Fix everything automatically” again — FrameForge picks the highest rate by itself.',
  ];
}

function laptop() {
  return [
    'Plug in the charger while gaming — most laptops cut graphics power by half or more on battery.',
    'Click the battery icon in the taskbar and set Power mode to “Best performance”.',
    'Put the laptop on a hard, flat surface so air can get in underneath. A laptop stand helps a lot.',
  ];
}

function amdDriverApp() {
  return [
    'FrameForge opened AMD’s official download page.',
    'Under “Auto-Detect and Install”, download and run the installer.',
    'Choose “Full Install” so you get AMD Software (Adrenalin Edition) with the driver.',
    'Restart when it asks, then open FrameForge — Fix mode checks it by itself.',
  ];
}

function restartPending() {
  return ['Save anything you have open.', 'Restart the PC (Start › Power › Restart) to finish the changes waiting for it.'];
}

function diskFull(disk) {
  return [
    `Drive C: still has only ${disk ? `${disk.freeGB} GB` : 'a little space'} free after the cleanup.`,
    'Uninstall games you don’t play: Settings › Apps › Installed apps, sort by size.',
    'Move big games to another drive: Steam › Settings › Storage lets you move a game to another drive without re-downloading.',
    'Turn on Storage Sense: Settings › System › Storage › Storage Sense.',
  ];
}

module.exports = { brandOf, ramSpeed, singleStick, hotCpu, hotGpu, displayCable, laptop, amdDriverApp, restartPending, diskFull };
