**Extreme Performance mode — every boost on, zero lag in any game** *(1.12.1)*


- **New: Extreme Performance preset** — the most aggressive mode FrameForge has. Everything from Competitive, all turned on, plus:
  - **Windows Search indexing off** — disk and CPU stay free for your game instead of indexing files in the background
  - **Windows Update delivery optimization off** — no background uploads to other PCs mid-match
  - **Windows diagnostics and telemetry off** — less background CPU, disk and network use while you play
  - **Memory compression off** — more RAM available for games, less CPU spent compressing memory
  - **SysMain (Superfetch) off** — no background disk preloading that can cause hitches
  - **Timer resolution, core parking, menu delay, startup delay** — every last millisecond of lag removed
  - **Raw mouse aim, no pop-ups, games on top CPU/GPU priority, Ultimate Performance power plan** — all the Competitive boosts

Pick **Extreme Performance** on the Home tab, flip Auto Mode on, and FrameForge tunes your whole PC for zero-lag gaming. Every change is undoable, and a restore point is made first.

---

**New: Windows performance mode**

- Open **Settings > Windows > Windows performance mode** to reduce FrameForge's background load while you use your PC or play. The switch is saved and takes effect immediately, without a restart.
- Sensor readings refresh every three seconds instead of every second. FrameForge's own Windows sensor helpers run at BelowNormal priority, giving other work precedence. Slow reads no longer overlap, and results from stopped readers cannot replace newer samples.
- **Fixed: switching a program off (or on) in "Programs that start with Windows" didn't change anything in Windows** — the switch flipped back. It now writes exactly what Task Manager writes, reads it back to make sure Windows took it, and Task Manager shows the program as Disabled.
- **FrameForge keeps your choice.** Apps like Spotify or Teams switch themselves back on to start with Windows. FrameForge checks every minute and switches them off again, and tells you when it did.
- **Close it now:** switching off a program that's open right now shows a **Close it now** button, so it stops straight away instead of only after a restart.
- **Full check: every drive, every folder.** It now goes through each SSD and hard drive — internal and external — with no time limit, and the virus scan also covers USB sticks and memory cards. The new **Drives in this PC** list shows each drive's type (NVMe SSD, SSD, hard drive, external, USB stick), model, free space and health from Windows, and after a full check how many files were looked at on each drive and whether the virus scan covered it. A drive Windows reports as failing is marked in red, because a failing drive makes the whole PC slow.

**Cleaner: Quick check and Full check — everything that makes your PC slow or lag in games, viruses included**

- The Cleaner tab now has two buttons: **Quick check** (a few minutes) and **Full check** (every file on every drive). Each one runs three steps and shows them live:
  1. **Junk and big files** — like before. The full check also looks through every folder of Downloads and finds files over 1 GB anywhere on your drives. Files that belong to installed games and programs are never listed, and a file you have twice is marked **Also somewhere else**.
  2. **Startup and background programs** — every program that starts with Windows, with how much memory it uses, and whether it's fine to switch off (security software and sound/touchpad helpers are marked **Keep on**). Switch one off with its switch: it's the same setting as Task Manager's Startup apps, nothing gets uninstalled, and you can switch it back on any time. Programs using a lot of processor or memory right now are listed with a **Close it** button.
  3. **Viruses and harmful files** — a quick or full scan with Microsoft Defender's engine: viruses, trojans, crypto-miners (they make games lag), spyware and unwanted programs. When it's done, **Review and remove** opens the results, where you quarantine or delete each one.
- **Junk files only** still checks just the junk, in seconds.

**New: Cleaner tab — find the junk that slows your PC down and delete it**


**Virus scan: it really scans everything, and it finishes**

- **Scans finish properly now.** Windows' WinSxS folder (and folders like `node_modules`) used to be queued up as one antivirus run per little folder — WinSxS alone was 18,980 separate runs, which could take hours. They're now part of a sensible job: about 120 runs for a full scan, and every file is still covered. A full scan counts and then scans all your drives; a quick scan stays quick.
- **Quarantining a real threat works even when Windows blocks the file.** Windows refuses to let anything open a confirmed threat, so Microsoft Defender now quarantines it — the detection shows as being in Defender's quarantine, with **Restore** available if it was a false alarm.
- **The false-positive check really reads digital signatures now.** It silently came back empty before, so every detection looked unsigned and the check's verdicts were off.
- **Detections Defender reported with an unclear status behave properly:** if the file is still on your disk you can **Quarantine**, **Delete** or **Keep** it; if it's already gone it shows as removed.
- **The Virus scan tab no longer fails to load when FrameForge isn't running as administrator** — quarantine falls back to your own FrameForge folder instead of a Windows folder it can't write to.
- "N/A: Must be an administrator" values are no longer mistaken for real Defender exclusions.

**Fix mode: no surprise downloads**

- With **Download performance tools** switched off in Settings, Fix mode never downloads PresentMon or LibreHardwareMonitor by itself — not in the background, and not from "Fix everything automatically". The card stays with its **Download it** button and says why it's waiting.

**No lag, no delays anywhere**

- The **Controller tab** no longer rebuilds its drawing 60 times a second while a controller is plugged in: buttons, sticks and triggers now update the picture that is already on screen, so movement stays smooth.
- **Sensors** stop running NVIDIA's nvidia-smi once a second in the background — it now only runs while the built-in sensor reader is quiet — and the CPU load figure is no longer fetched twice. FrameForge also stops re-scanning its tools folder every second.
- Open **Cleaner** in the sidebar and FrameForge looks through your PC for files you don't need: temp files, old Windows Update downloads, the Delivery Optimization cache, crash dumps (some are several GB), old Windows logs, the thumbnail cache, the driver installers AMD and NVIDIA leave in C:\AMD and C:\NVIDIA, the Recycle Bin, browser caches (Chrome, Edge, Firefox, Brave, Opera, Opera GX, Vivaldi), app caches (Discord, Steam, Epic Games Launcher, Spotify) and graphics shader caches.
- It also lists **your own files** you might not need any more: installers and archives in Downloads older than a month, and the biggest files in Downloads, Desktop, Documents and Videos. You tick them one by one, and they go to the **Recycle Bin**, so you can still get them back.
- Every item shows how much space it takes, what it is, and whether it's **Safe to delete** (ticked for you) or something to **Check first**. See how full drive C: is at the top — a nearly full drive is one of the most common reasons a PC gets slow.
- Nothing is deleted until you press **Delete selected** and confirm. Files from the last 24 hours, files an app is using, and caches of apps that are open are left alone. Browser logins, history, bookmarks and passwords are never touched.
- Fix mode's "Drive C: is almost full" card now has an **Open Cleaner** button.
- Switching the mode off restores standard monitoring. Your Auto Mode, preset, animations, FPS limit, startup choices and virus protection are preserved.
- This reduces monitoring overhead. Hardware limits, games, drivers and other apps can still cause lag; higher FPS and zero lag are not guaranteed.

---

**Cleaner: the startup switches really work now, and the Full check covers every drive**