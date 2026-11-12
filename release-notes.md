**Fix mode now really works through its list by itself**

- **Quicker retries.** A fix that didn’t stick was only tried again after 6 hours. Now it is tried again after 5 minutes, then 30 minutes, then every 6 hours.
- **No more lost attempts.** If FrameForge was busy at the moment of a check (for example Auto Mode running at start-up), the attempt was skipped and the 6-hour wait started anyway. Now it comes back 15 seconds later, and only real attempts count.
- **Starts sooner.** Fixing begins right after Auto Mode finishes and whenever you open the Fix tab, not only at the 2-minute check. Clean-ups that keep the processor busy start after 5 minutes away instead of 10.
- **Every problem says what it is waiting for**: fixing itself now, waiting for your game to close, waiting until you’re away, trying again in a few minutes, or needing a click from you. “Can fix automatically” used to be shown on problems FrameForge deliberately leaves to you (such as Windows protection settings); those now say “One click fixes it”.
- **No restart request for small tweaks.** “Turn off Widgets” and “Faster Start menu search” from 1.14.0 no longer put “A restart is needed” in Fix mode; signing out is enough.
