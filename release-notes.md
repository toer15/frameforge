**Fix mode was waiting for a game that wasn’t there**

- **The cause.** With the FPS counter on, FrameForge treated any app that draws on screen — a browser, Discord, Spotify — as a running game. Most automatic fixes wait until no game is running, so they waited all day. A game is now an app that isn’t a known desktop app and draws 20+ frames a second for 10 seconds (or, with the FPS counter off, a busy graphics card).
- **Same fix for Game Booster and scheduled virus scans**, which used the same wrong signal.
- **The list now reaches zero.** A tweak Windows refuses three times is set aside as “not available on this PC” (you can try it again from the Tweaks tab) instead of staying a problem forever. BIOS and hardware advice sits in its own section, “Only you can do these”, and no longer counts as an open problem.
- **You can see it working.** The Fix tab lists what Fix mode did by itself and when, and says so when it is holding back because a game is running.
