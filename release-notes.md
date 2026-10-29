**Cleaner: the startup switches really work now, and the Full check covers every drive**

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

- Open **Cleaner** in the sidebar and FrameForge looks through your PC for files you don't need: temp files, old Windows Update downloads, the Delivery Optimization cache, crash dumps (some are several GB), old Windows logs, the thumbnail cache, the driver installers AMD and NVIDIA leave in C:\AMD and C:\NVIDIA, the Recycle Bin, browser caches (Chrome, Edge, Firefox, Brave, Opera, Opera GX, Vivaldi), app caches (Discord, Steam, Epic Games Launcher, Spotify) and graphics shader caches.
- It also lists **your own files** you might not need any more: installers and archives in Downloads older than a month, and the biggest files in Downloads, Desktop, Documents and Videos. You tick them one by one, and they go to the **Recycle Bin**, so you can still get them back.
- Every item shows how much space it takes, what it is, and whether it's **Safe to delete** (ticked for you) or something to **Check first**. See how full drive C: is at the top — a nearly full drive is one of the most common reasons a PC gets slow.
- Nothing is deleted until you press **Delete selected** and confirm. Files from the last 24 hours, files an app is using, and caches of apps that are open are left alone. Browser logins, history, bookmarks and passwords are never touched.
- Fix mode's "Drive C: is almost full" card now has an **Open Cleaner** button.

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
- **Home's live figures** only redraw when a value really changes, so the tab no longer re-lays-out for nothing every second.
- **Background work starts within seconds of opening FrameForge** instead of up to a minute later: the fix pass, your animations choice, the FPS limiter, the protection check and the scheduled-scan check are all set up far sooner.
- **The animation watcher does a third of the registry reads** it used to, and still does a full check every minute.
- **Shorter waits throughout:** pausing and resuming a scan, noticing that RTSS started, noticing that your local AI started, and confirming a tweak really applied are now about twice as fast.

**Controller tab: pick your exact controller, see it move live**

- Pick your controller from a list: Xbox Series X|S, Xbox Elite Series 2, Xbox One, Xbox 360, DualSense, DualSense Edge, DualShock 4, Switch Pro Controller, and Joy-Con (L, R or both).
- FrameForge draws that controller with its own buttons and lights up every button as you press it. Sticks move exactly as you move them, triggers fill up as you squeeze, and fingers on the DualSense/DualShock touchpad show up.
- Tilt a DualSense, DualShock 4, Switch Pro Controller or Joy-Con and the controller on screen tilts with it. Each Joy-Con moves on its own. Use **Re-centre motion** to set the straight position.
- Works straight away on every PC: FrameForge reads the controller itself, no driver or extra program needed.

**New: Controller tab**

- A new **Controller** tab finds the controller you have plugged in (Xbox, DualSense, DualShock 4 and others) and shows its buttons with the right logos: A B X Y for Xbox, ✕ ○ □ △ for PlayStation.
- Pick **Automatic**, **Xbox** or **PlayStation**. You see where the usual actions (jump, shoot, aim, menu…) sit on that controller.
- Test your controller live: press buttons and move the sticks and they light up.
- It tells you which logos your games will really show, based on what Windows hands them.

**New: FPS limiter**

- Settings now has an **FPS limiter**: type the FPS you want and switch it on. Games are capped at that number.
- It uses RivaTuner Statistics Server (RTSS), the standard frame limiter. FrameForge installs it for you the first time, keeps it running, and puts your number back if something changes it.
- If the cap can't be applied, the switch turns back off and tells you why.

**Uninstall a local AI model from AI Chat**

- A red **Uninstall AI model** button now appears beside **Installed · runs on your PC** at the top of AI Chat.
- It unloads and removes the selected downloaded model, then checks that removal succeeded. Other models and your chat history are kept.
- The Install button returns afterwards, so you can download the model again. Uninstall waits while an AI reply or another model operation is running, and failures show a clear message.

**AI Chat message menu: red text on black**

- **Edit message** and **Delete message** now use red text on a black background, including when hovered or focused. Removed the default white button backgrounds.

**AI Chat: edit and delete your messages**

- Each of your sent messages now has a **three-dot menu** beside it, with **Edit message** and **Delete message**.
- Edit opens an inline editor with **Save changes** and **Cancel**. You can also save with Ctrl+Enter or cancel with Escape. Edits save in place and keep the existing AI replies.
- Delete removes your message from the chat and removes its original text from saved history. Existing replies stay visible, and future AI requests use your revised conversation.
- Changes persist after restarting the app. Message actions wait while the AI is replying; messages from failed or stopped requests stay available to edit or delete.
- Fixed an early-startup error that could stop the AI replying while FrameForge was still checking the PC.

**Auto update toggle in Settings**

- **Auto update** now sits directly under the update button. Turn it on to check for new versions automatically and show the update popup while you use FrameForge.
- Checks run at startup, every five minutes while the app is in use, and when you return (at most once a minute on focus). Tray checks remain every 30 minutes.
- Turn it off to stop automatic checks and popups; you can still check and update manually. Your existing automatic-check preference is preserved.
- Choosing **Later** dismisses that version for the session, including its download progress and ready-to-install popup. A newer version can announce itself. Updates found while the app is hidden are shown when you return.

**FrameForge opens on screen after an update**

- After an update installs, FrameForge restarts and opens its main window automatically, even if it normally starts hidden in the tray.
- This applies to both **Update now** and downloaded updates installed when FrameForge quits. The installer also reopens updates started by older versions.
- A one-time update handoff helps the new version show its window. Ordinary **Start with Windows** launches still stay in the tray.

**Virus scan: Delete all acts immediately**

- Clicking **Delete all** in the scan results now starts deleting all available threats immediately. You no longer need to click **Do it** afterwards.
- Progress appears while files are handled, and completed detections leave the pending list. Failures stay visible and can be retried; locked files may need a restart.
- False positives, already handled detections and items in Defender's quarantine are left alone. Other selected actions are not run by Delete all.
- Repeat clicks are blocked while deletion runs, and stale requests skip detections that have already been handled.

**Windows animations: live window dragging and missing effects restored**

- **On now enables live window contents while dragging**, plus Windows animations, shadows, smooth fonts, selection effects and thumbnail previews. Previously the switch could say On while moving a window still showed only its outline.
- **Off also disables live window dragging** along with the Windows animations. Static effects such as font smoothing stay as they are; transparency remains under its own tweak.
- The switch now checks each controlled effect and names anything Windows refused to enable. Failed changes no longer appear as successful in the change history.
- Auto Mode skips its conflicting Performance visual effects boost while animations are On. FrameForge watches the dragging and visual-effect settings as well as animations to keep your choice.
- Animation and dragging changes apply immediately. Some Explorer effects may need sign-out; apps with their own effects may have separate settings.

**Everything does what its name says: a full check of the app**

- **Performance visual effects** now really does what Windows' "Adjust for best performance" does — animations, window shadows, the translucent selection box and showing window contents while dragging are switched off, and it applies right away. Before, it only set a flag Windows doesn't act on.
- **Run every game on the gaming graphics card** now finds games from GOG, Ubisoft Connect, the EA app, Battle.net, Xbox and games folders on any drive (not just Steam and Epic), shows its real state, and Fix mode picks up games you install later.
- **Downloads are verified:** PresentMon, LibreHardwareMonitor and the Chris Titus tool are checked against the SHA-256 fingerprint GitHub publishes for each release file; a file that doesn't match is thrown away.
- **Reset network** now says so when Windows refuses a step, instead of always reporting success.
- **Start with Windows** and the **overlay shortcut** now tell you when Windows refused them (no admin rights / shortcut taken by another program) instead of silently showing the switch as on. The start-up task is also refreshed each time FrameForge starts, so it always points at the installed copy.

**Windows animations: your choice sticks, within seconds**

- **FrameForge now notices within about 8 seconds** when another app, a tweak tool, Windows Settings or a Windows update changes the animations, and puts your choice back (On = every animation on, Off = every animation off). Before, it only re-checked every 2 minutes.
- It also checks for changes that never reach the registry once a minute, and covers the Peek hover preview too.
- **No more fighting with the Performance visual effects boost:** when animations are On, that boost is switched off and Fix mode leaves it alone.
- If another program keeps undoing your choice again and again, FrameForge backs off to one check a minute instead of looping.

**Fix mode: two problems that could never be fixed now are**

- **Memory compression** now turns off even when Windows' SysMain (Superfetch) service is disabled — which made the command fail with "The service cannot be started". FrameForge starts the service just long enough for the change, then puts it back exactly as it was.
- **Settings your PC doesn't have** (for example "Aggressive CPU boost" when your power plan lacks that setting) are no longer applied and then reported as "Windows switched it off" forever. FrameForge detects them, undoes the empty change and sets them aside as not available on this PC — and the problem leaves Fix mode.
- **Tweaks that need a restart** no longer show as problems while they're waiting for the restart.
- Every fix now checks that Windows really reports the setting as on afterwards; if it can't be made to work, you get the reason instead of a problem that comes back.

**Fix mode: problems really go away when they're fixed**

- **A "Fix it" button on every problem FrameForge can fix.** It tries every fix it knows, in order, checks after each one that the problem is truly gone, and then the problem leaves the list and shows under "Fixed just now". Before, some problems (a hot CPU or graphics card, a laptop on battery) had no button at all or stayed on the list after they were handled.
- **If a fix doesn't work**, you see what happened and exact steps for the part only you can do — no silent failures.
- **The AI chat now really fixes things.** "Fix this" fixes one problem the same way, with a check; the new "Fix everything" action does what the button in Fix mode does. Fix mode and the changes list refresh right after the AI acts, and the AI tells you honestly whether the problem is gone.
- **Fix everything automatically** can now quarantine clear-cut virus-scan threats (only confirmed malware families — never "probably" or unwanted programs). Quarantined files can be restored from the Virus scan tab. Background fixing never does this on its own.
- The problem list no longer flickers or loses track of what was fixed when several refreshes overlap.
**Virus scan: smarter, safer, easier to follow**

- **Protection banner.** One glance tells you if the PC is protected, has detections waiting for you, or has Windows protection problems — with a button to fix or review them. There's also an **Update definitions** button.
- **Live detections.** Threats show up in the scan window the moment they're found, not just at the end.
- **Pause and resume** a scan any time. A scheduled scan pauses by itself while you use the PC or play, and carries on when you're away. Scans keep Windows awake so a long full scan isn't cut short by sleep.
- **Scan a single file, or a whole drive in one click** — including USB sticks and external drives.
- **Scheduled scans you control.** Pick quick scans daily / weekly / every 2 weeks / monthly and an optional scheduled full scan (Settings › Virus scan). They run only when you're away, never during a game, and on laptops only on the charger. They run at low priority and no longer depend on Fix mode being on.
- **More Defender checks:** behaviour monitoring, downloaded-file and script scanning, cloud-delivered protection, blocking of unwanted programs, Tamper Protection and optional ransomware protection — each with a one-click fix.
- **Scan history** and a **Save report** button (a plain-text file with every detection and the reasons behind each verdict).
- Results open on what needs your decision, with filters (threats, unwanted, false positives, found before). A scheduled scan that finds nothing no longer pops a window up.
- The false-positive check now says honestly when the known-software database was off or couldn't be reached, instead of "not listed".
**New: Virus scan tab**

- **Quick scan, Full scan and Custom scan.** Uses Microsoft Defender's antivirus engine, which is built into Windows and updated by Microsoft several times a day. It finds viruses, trojans, ransomware, spyware, password stealers, crypto-miners and unwanted programs.
  - **Quick scan** checks running programs, startup items, scheduled tasks, services, Downloads, Desktop, Temp, AppData and browser extensions, plus Defender's memory and boot check.
  - **Full scan** checks every file on every internal drive.
  - **Custom scan** checks any folder you pick.
- **Estimated time before you start, and a live count while it runs.** For example: 312,455 of 1,204,880 files checked, about 18 min left. The estimate learns how fast your PC scans.
- **False-positive check.** Every detection is checked for whether it's a real threat or a false alarm:
  - Is the file digitally signed?
  - Is it a known, legitimate file? FrameForge looks up its fingerprint in NIST's software database. Only the fingerprint is sent, never the file.
  - Is the detection a known malware family, or just a machine-learning guess?
  - Where does the file sit?
  You see how many **real threats** and how many **false positives** were found, and why for each one.
- **Results window when the scan is done.** It shows every detection, including ones Windows' antivirus found on your PC before. For each one: what it is, where it is, who signed it, whether it's running, and a link to a VirusTotal second opinion. You pick **Quarantine**, **Delete** or **Keep** for each, press **Do it**, and FrameForge does it. Running threats are stopped first. Locked files are removed at the next restart.
- **Quarantine.** Files are stored encoded so they can't run, and can be restored or deleted for good.
- **Windows protection checks.** FrameForge checks for things malware switches off or changes: real-time protection, policies that turn Defender off, risky Defender exclusions, hijacked hosts files, proxies, the firewall and UAC. Each one can be fixed with one click or from Fix mode.
- **Weekly quick scan.** It runs by itself while you're away from the PC. Nothing is removed until you choose.

**New: Windows animations switch (Settings)**
- **Off** turns every Windows animation off: windows opening, closing, minimizing and maximizing, menus, tooltips, the taskbar and the "Animation effects" switch. **On** brings them all back. Takes effect right away.
- FrameForge keeps your choice. If the Chris Titus tool, Windows Settings or another app changes it, FrameForge switches it back.
