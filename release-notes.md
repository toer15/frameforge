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
