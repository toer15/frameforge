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
