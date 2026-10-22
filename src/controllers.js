// Which game controllers are plugged in, and what games see them as.
// Games pick their button logos from the device they detect: an XInput pad (Xbox layout) or a PlayStation pad.
// So "what games see" is read from Windows itself: the USB/Bluetooth vendor and product IDs, plus the XInput slots.
const { ps, DEMO } = require('./util');

const SONY = 0x054c;
const MICROSOFT = 0x045e;
const NINTENDO = 0x057e;

// vendor:product (hex) -> [name, family, drawing in the Controller tab]
const MODELS = {
  '054c:05c4': ['DualShock 4', 'playstation', 'dualshock4'],
  '054c:09cc': ['DualShock 4', 'playstation', 'dualshock4'],
  '054c:0ba0': ['DualShock 4 USB adapter', 'playstation', 'dualshock4'],
  '054c:0ce6': ['DualSense', 'playstation', 'dualsense'],
  '054c:0df2': ['DualSense Edge', 'playstation', 'dualsense-edge'],
  '045e:028e': ['Xbox 360 Controller', 'xbox', 'xbox-360'],
  '045e:028f': ['Xbox 360 Wireless Controller', 'xbox', 'xbox-360'],
  '045e:02d1': ['Xbox One Controller', 'xbox', 'xbox-one'],
  '045e:02dd': ['Xbox One Controller', 'xbox', 'xbox-one'],
  '045e:02e0': ['Xbox One Wireless Controller', 'xbox', 'xbox-one'],
  '045e:02ea': ['Xbox One Controller', 'xbox', 'xbox-one'],
  '045e:02fd': ['Xbox One Wireless Controller', 'xbox', 'xbox-one'],
  '045e:0b00': ['Xbox Elite Series 2', 'xbox', 'xbox-elite2'],
  '045e:0b05': ['Xbox Elite Series 2', 'xbox', 'xbox-elite2'],
  '045e:0b12': ['Xbox Series X|S Controller', 'xbox', 'xbox-series'],
  '045e:0b13': ['Xbox Series X|S Controller', 'xbox', 'xbox-series'],
  '045e:0b20': ['Xbox Wireless Controller', 'xbox', 'xbox-series'],
  '045e:0b21': ['Xbox Wireless Controller', 'xbox', 'xbox-series'],
  '045e:0b22': ['Xbox Elite Series 2', 'xbox', 'xbox-elite2'],
  '057e:2009': ['Switch Pro Controller', 'nintendo', 'switch-pro'],
  '057e:2006': ['Joy-Con (L)', 'nintendo', 'joycon-l'],
  '057e:2007': ['Joy-Con (R)', 'nintendo', 'joycon-r'],
};

/** Work out the family and a readable name from IDs and the Windows device name. */
function classify(vid, pid, friendly = '') {
  const known = MODELS[`${vid}:${pid}`];
  if (known) return { name: known[0], family: known[1], model: known[2] };
  const v = parseInt(vid, 16);
  const nice = friendly.replace(/^HID-compliant game controller$/i, '').trim();
  if (v === SONY) return { name: nice || 'PlayStation controller', family: 'playstation', model: 'dualsense' };
  if (v === MICROSOFT || /xbox/i.test(friendly)) return { name: nice || 'Xbox controller', family: 'xbox', model: 'xbox-series' };
  if (v === NINTENDO) return { name: nice || 'Nintendo controller', family: 'nintendo', model: 'switch-pro' };
  return { name: nice || 'Game controller', family: 'other', model: 'generic' };
}

const SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class FFXi {
  [StructLayout(LayoutKind.Sequential)] public struct GP { public ushort b; public byte lt, rt; public short lx, ly, rx, ry; }
  [StructLayout(LayoutKind.Sequential)] public struct ST { public uint pk; public GP g; }
  [StructLayout(LayoutKind.Sequential)] public struct CAP { public byte type, sub; public ushort flags; public GP g; public ushort vl, vr; }
  [DllImport("xinput1_4.dll")] static extern int XInputGetState(int i, ref ST s);
  [DllImport("xinput1_4.dll")] static extern int XInputGetCapabilities(int i, int f, ref CAP c);
  public static string Slots() {
    string o = "";
    for (int i = 0; i < 4; i++) {
      ST s = new ST();
      if (XInputGetState(i, ref s) == 0) { CAP c = new CAP(); XInputGetCapabilities(i, 0, ref c); o += i + ":" + c.sub + ";"; }
    }
    return o;
  }
}
"@
'XI=' + [FFXi]::Slots()
Get-PnpDevice -PresentOnly | Where-Object {
  $_.InstanceId -match 'VID_[0-9A-F]{4}&PID_[0-9A-F]{4}' -and
  (($_.Class -eq 'HIDClass' -and $_.FriendlyName -eq 'HID-compliant game controller') -or $_.FriendlyName -match 'gamepad|xbox|dualsense|dualshock|joy-con|wireless controller')
} | ForEach-Object {
  if ($_.InstanceId -match 'VID_([0-9A-F]{4})&PID_([0-9A-F]{4})') { 'DEV=' + $Matches[1] + ':' + $Matches[2] + '|' + $_.Class + '|' + $_.FriendlyName + '|' + $_.InstanceId }
}
`;

/** Parse the script's output into { devices, xinput }. Exported for tests. */
function parse(out) {
  const xinput = [];
  const byId = new Map();
  for (const line of String(out).split(/\r?\n/)) {
    const xi = /^XI=(.*)$/.exec(line.trim());
    if (xi) {
      for (const slot of xi[1].split(';').filter(Boolean)) xinput.push(Number(slot.split(':')[0]));
      continue;
    }
    const d = /^DEV=([0-9A-F]{4}):([0-9A-F]{4})\|([^|]*)\|([^|]*)\|(.*)$/i.exec(line.trim());
    if (!d) continue;
    const vid = d[1].toLowerCase();
    const pid = d[2].toLowerCase();
    const key = `${vid}:${pid}`;
    const bt = /^BTH/i.test(d[5]);
    const cur = byId.get(key) || { vid, pid, friendly: '', bluetooth: false, usb: false };
    // The game-controller entry has a generic name; keep the most descriptive one.
    if (!cur.friendly || /game controller$/i.test(cur.friendly)) cur.friendly = d[4];
    cur.bluetooth = cur.bluetooth || bt;
    cur.usb = cur.usb || /^USB/i.test(d[5]);
    byId.set(key, cur);
  }
  const devices = [...byId.values()]
    .map((c) => ({ ...classify(c.vid, c.pid, c.friendly), vid: c.vid, pid: c.pid, connection: c.bluetooth ? 'Bluetooth' : c.usb ? 'USB cable' : 'Connected' }))
    // The USB audio/composite interfaces of one pad share its IDs; keep real game controllers only.
    .filter((d) => d.family !== 'other' || !/system|led|lighting|rgb|audio|hub/i.test(d.name));
  return { devices, xinput };
}

const DEMO_STATE = { devices: [{ name: 'DualSense', family: 'playstation', model: 'dualsense', vid: '054c', pid: '0ce6', connection: 'USB cable' }], xinput: [] };

/**
 * { devices: [{ name, family, vid, pid, connection }], xinput: [slot], gamesSee: 'xbox' | 'playstation' | 'nintendo' | 'other' | null }
 * `gamesSee` is what games will show logos for: an XInput pad means Xbox (even a DualSense can look like one when
 * Steam Input or DS4Windows is emulating), otherwise the family of the real pad.
 */
async function detect() {
  let st = DEMO_STATE;
  if (!DEMO) {
    const r = await ps(SCRIPT, { timeout: 30000 });
    st = parse(r.stdout);
  } else if (process.env.FRAMEFORGE_DEMO_PAD) {
    const [family, xinput] = process.env.FRAMEFORGE_DEMO_PAD.split(':');
    const model = { xbox: 'xbox-series', playstation: 'dualsense', nintendo: 'switch-pro' }[family] || 'generic';
    const name = { xbox: 'Xbox Wireless Controller', playstation: 'DualSense', nintendo: 'Switch Pro Controller' }[family] || 'Game controller';
    st = { devices: family === 'none' ? [] : [{ name, family, model, vid: '0000', pid: '0000', connection: 'USB cable' }], xinput: xinput ? [0] : [] };
  }
  let gamesSee = null;
  if (st.xinput.length) gamesSee = 'xbox';
  else if (st.devices.length) gamesSee = st.devices[0].family;
  return { ...st, gamesSee };
}

module.exports = { detect, parse, classify, MODELS };
