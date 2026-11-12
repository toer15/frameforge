**The FPS limiter now really caps every game, and Fix mode really fixes**

- **FPS limiter installs what it needs by itself.** RivaTuner Statistics Server (RTSS) is fetched from Microsoft's
  winget store the first time you flip the limiter on. FrameForge now finds `winget.exe` even when it is not on
  PATH (the usual reason the install quietly failed), waits for it, and keeps trying later instead of giving up.
- **The cap now reaches games RTSS already knew.** Before, only RTSS's *Global* template got your number, and a game
  with its own saved RTSS profile (often “no limit”) ignored it — so some games and lobbies ran uncapped. Now your
  number is written to Global and to every game profile that has no limit of its own. A cap you set in RTSS yourself
  is never touched, and switching the limiter off puts back exactly the profiles FrameForge changed.
- **Fix mode no longer thinks it has no admin rights.** The old check also failed when the Windows “Server” service
  was stopped, which made FrameForge skip every automatic fix in silence. It now asks Windows for the real answer.
- **“Turn off Widgets” really turns off.** Windows can refuse the machine policy even to administrators (on the
  owner's PC: “Access is denied”), and that single refusal kept the Fix list busy forever. That value is now
  best-effort and the per-user switches do the job, so the item clears.
- **A fix that keeps failing says so.** After three tries the Fix list repeats Windows' own reason and keeps trying
  every few hours, instead of promising “Fixes itself” with nothing happening.
- **Fixes may fetch the tools they need.** With “Fix problems by itself” on, Fix mode can download a missing helper
  (PresentMon, LibreHardwareMonitor) as part of the fix.
- **Virus scan results only show what's new.** When a scan finishes, the results window no longer repeats every
  threat Defender ever recorded — including ones you already quarantined, deleted or allowed. Those stay gone, and
  only new detections come up. Anything genuinely back on disk is still caught and shown.
