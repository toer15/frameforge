**Install RTSS straight from the FPS limiter tab, with the rest of 1.15.0's fixes**

- **There is now an Install RTSS automatically button.** It works even while the limiter switch is off, so anyone can
  set up the one thing the limiter needs from inside FrameForge. Download progress and any failure stay on the tab,
  with the real error from Microsoft's winget store and a button to try again. Once RTSS is installed, turn the
  limiter on and FrameForge starts it and applies the cap.
- **FPS limiter is now its own tab.** It moved out of Settings. The tab shows whether RTSS is installed, whether
  its background helper is running, the cap RTSS is actually applying and how many game profiles are covered.
  **Set up and apply** retries the whole setup; **Check again** refreshes the status.
- **It installs what it needs by itself.** RivaTuner Statistics Server (RTSS) is fetched from Microsoft's winget
  store the first time the limiter is switched on, and FrameForge waits for both RTSS.exe and its hook DLL before
  applying the cap. If winget itself is missing, the tab says exactly what to install instead of failing silently.
- **The cap now reaches the games that ignored it.** RTSS's SDK global profile is the unnamed profile, not the
  “Global” template. Writing to the wrong one was why a game's own saved profile (often “no limit”) won. FrameForge
  now writes the real global profile and every existing game profile that has no cap of its own. A cap you set in
  RTSS is never overwritten, and switching the limiter off puts back exactly the profiles FrameForge changed.
- **RTSS's own limiter is switched back on.** Some installs have the framerate limiter disabled in RTSS's hooks
  flags, so the number is saved but nothing is capped. FrameForge clears that one flag, reads it back, and does the
  same in RTSS's 32-bit hook context so 32-bit games and launchers are covered too.
- **“Fixes itself” now means it really will.** The Fix tab no longer labels a click-only problem or a Windows-update
  restart as automatic. The background fixer processes exactly the same set of problems the tab calls automatic,
  and it no longer records “tried and failed” for problems it never actually ran. If automatic fixes are off, or
  FrameForge doesn't have administrator rights, the card says it needs you instead of promising a fix that won't come.
- **Virus scan results are only this scan.** The results popup no longer merges Defender's whole history, so threats
  you handled last week cannot come back on every run. Detections you already quarantined, deleted, kept or allowed
  are filtered out; a quarantined or deleted file that is active on disk again is shown again. Old unhandled threats
  still appear, because they genuinely still need a decision.

A small number of anti-cheat-protected games block every overlay and hook, RTSS included. Those games need their own
in-game FPS cap — FrameForge can't inject into a protected process.
