// Every drive with a letter — internal SSDs and hard drives, external drives, USB sticks and memory cards — with its
// type, size and what Windows reports about its health. The Full check covers all of them.
const { ps, IS_WIN, DEMO } = require('./util');

const GB = 1024 ** 3;

// Drive letter → partition → physical disk through WMI's own links (works without admin rights, and with several
// identical disks), then the Storage module for SSD/HDD, bus and health. Wear and temperature need admin.
const DRIVES_PS = `$ErrorActionPreference = 'SilentlyContinue'
$pd = @{}; $rc = @{}
foreach ($d in Get-PhysicalDisk) { $pd[[string]$d.DeviceId] = $d; $rc[[string]$d.DeviceId] = ($d | Get-StorageReliabilityCounter) }
$out = foreach ($ld in Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -in 2,3 }) {
  $part = Get-CimAssociatedInstance -InputObject $ld -ResultClassName Win32_DiskPartition | Select-Object -First 1
  $dd = if ($part) { Get-CimAssociatedInstance -InputObject $part -ResultClassName Win32_DiskDrive | Select-Object -First 1 }
  $x = if ($dd) { $pd[[string]$dd.Index] }
  $r = if ($dd) { $rc[[string]$dd.Index] }
  [pscustomobject]@{
    letter = $ld.DeviceID; label = [string]$ld.VolumeName; type = [int]$ld.DriveType; size = [int64]$ld.Size; free = [int64]$ld.FreeSpace; fs = [string]$ld.FileSystem
    media = [string]$x.MediaType; rpm = $x.SpindleSpeed; bus = $(if ($x) { [string]$x.BusType } else { [string]$dd.InterfaceType })
    model = $(if ($x) { [string]$x.FriendlyName } else { [string]$dd.Model }); health = [string]$x.HealthStatus; wear = $r.Wear; temp = $r.Temperature
  }
}
@($out) | ConvertTo-Json -Compress`;

const DEMO_DRIVES = [
  { letter: 'C:', label: 'Windows', type: 3, size: 1000 * GB, free: 412 * GB, fs: 'NTFS', media: 'SSD', rpm: 0, bus: 'NVMe', model: 'Samsung SSD 990 PRO 1TB', health: 'Healthy', wear: 3, temp: 41 },
  { letter: 'D:', label: 'Games', type: 3, size: 2000 * GB, free: 640 * GB, fs: 'NTFS', media: 'HDD', rpm: 7200, bus: 'SATA', model: 'ST2000DM008-2UB102', health: 'Healthy', wear: null, temp: 35 },
  { letter: 'E:', label: 'Backup', type: 3, size: 1000 * GB, free: 220 * GB, fs: 'exFAT', media: 'SSD', rpm: 0, bus: 'USB', model: 'Samsung PSSD T7', health: 'Healthy', wear: null, temp: null },
  { letter: 'F:', label: 'USB STICK', type: 2, size: 29 * GB, free: 18 * GB, fs: 'FAT32', media: 'Unspecified', rpm: null, bus: 'USB', model: 'SanDisk Ultra USB 3.0', health: 'Healthy', wear: null, temp: null },
];

function shape(d) {
  const bus = String(d.bus || '');
  const external = /usb|1394|thunderbolt|sd|mmc/i.test(bus);
  const rpm = Number(d.rpm);
  const media = d.media === 'SSD' || d.media === 'HDD' ? d.media : rpm === 0 ? 'SSD' : rpm > 0 && rpm < 100000 ? 'HDD' : '';
  let kind;
  if (d.type === 2) kind = /sd|mmc/i.test(bus) ? 'Memory card' : 'USB stick';
  else {
    kind = media === 'SSD' ? (/nvme/i.test(bus) ? 'NVMe SSD' : 'SSD') : media === 'HDD' ? 'Hard drive (HDD)' : 'Drive';
    if (external) kind = `External ${kind === 'Hard drive (HDD)' ? 'hard drive (HDD)' : kind === 'Drive' ? 'drive' : kind}`;
  }
  const readable = Number(d.size) > 0 && !!d.fs;
  const health = /^(Healthy|Warning|Unhealthy)$/i.test(d.health || '') ? d.health : '';
  const sysDrive = (process.env.SystemDrive || 'C:').toUpperCase();
  return {
    letter: String(d.letter).toUpperCase(), root: `${String(d.letter).toUpperCase()}\\`, label: d.label || '', kind, media, bus, model: (d.model || '').trim(),
    external: d.type === 2 || external, removable: d.type === 2, size: Number(d.size) || 0, free: Number(d.free) || 0, fs: d.fs || '',
    health, wear: d.wear == null || d.wear === '' ? null : Number(d.wear), temp: d.temp == null || d.temp === '' || Number(d.temp) <= 0 ? null : Number(d.temp),
    system: String(d.letter).toUpperCase() === sysDrive, readable,
    // Big files are listed on fixed drives (they have a Recycle Bin); USB sticks and memory cards get the virus scan.
    bigFiles: readable && d.type === 3, virus: readable,
  };
}

let cache = { at: 0, list: null };
/** All drives, cached for a minute (plugging in a USB stick shows up on the next check). */
async function list(refresh = false) {
  if (!refresh && cache.list && Date.now() - cache.at < 60000) return cache.list;
  let raw = [];
  if (DEMO) raw = DEMO_DRIVES;
  else if (IS_WIN) {
    const r = await ps(DRIVES_PS, { timeout: 45000 });
    try {
      raw = [].concat(JSON.parse(r.stdout.trim() || '[]'));
    } catch {
      raw = [];
    }
  }
  const out = raw.map(shape).sort((a, b) => a.letter.localeCompare(b.letter));
  cache = { at: Date.now(), list: out };
  return out;
}

module.exports = { list, shape };
