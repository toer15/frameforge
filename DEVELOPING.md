# FrameForge

Automatic PC best gaming performance assistant for Windows 10/11 — AMD, NVIDIA and Intel rigs.

Flip **Automatic PC Best Gaming Performance Assistance** on the Home tab and FrameForge:

1. Scans your PC (or uses the parts you picked under *Choose parts myself*)
2. Builds a profile for that exact PC and picks the boosts that fit it
3. Saves a Windows restore point
4. Applies the boosts, one by one, with every step shown live
5. Downloads the free helper tools it needs (if you allow it in Settings)
6. Opens AMD Software / the NVIDIA app and shows the driver checklist for your card
7. If overclocking is on: raises the NVIDIA power limit and shows your card's own auto-tuner steps

Flip it off and every change is put back exactly how it was.

## Install

Run `FrameForge-Setup-1.0.0.exe`. Because the app isn't code-signed yet, Windows SmartScreen will say
"Windows protected your PC" — click **More info → Run anyway**. FrameForge asks for administrator
rights because power plans, GPU scheduling and restore points need them.

## What it changes (all undoable)

| Boost | What it does |
|---|---|
| Restore point | Safety net before anything else |
| Ultimate Performance power plan | Stops CPU clocks dropping and cores parking |
| Windows Game Mode | Game gets priority; updates hold off |
| Xbox background recording off | Frees GPU encoder and disk (OBS unaffected) |
| Hardware-accelerated GPU scheduling | Needed for DLSS Frame Gen / AMD Fluid Motion Frames |
| Game task priority | Higher CPU/GPU priority for the "Games" task class |
| Raw mouse aim | Turns off "Enhance pointer precision" |
| Power throttling off | Desktops only |
| Performance visual effects | Older or low-RAM PCs only |
| Clear temp files | One-time cleanup |
| GPU power limit to max (overclock, NVIDIA) | Uses the max limit the card itself allows |

Backups are stored in `%APPDATA%\FrameForge\backup.json`.

## FPS counter and temperatures

- **FPS**: uses PresentMon by Intel (open source). Works with DirectX, Vulkan and OpenGL. The overlay shows
  on top of games in *borderless* or *windowed* mode — not exclusive fullscreen.
- **FPS math**: counted from the frame times themselves over the last second (the same method as
  RTSS / MSI Afterburner). 1% low = the slowest 1% of frames over the last 10 seconds.
- **Temperatures**: only real sensors. NVIDIA GPU temps come straight from the NVIDIA driver. CPU temps
  and AMD GPU temps come from LibreHardwareMonitor (AMD: Tdie/Tctl die sensor, Intel: CPU Package).
  Windows' own "thermal zone" reading is deliberately not used — it's a motherboard sensor that is often
  20–30 °C off. Each number on Home says where it came from.
- With several graphics chips (e.g. Ryzen built-in graphics + a Radeon card) it reads the card with the
  most video memory.
- Toggle the overlay in-game with **Ctrl+Shift+F** (changeable in Settings).

## Presets (the slideshow on Home)

Pick a goal, then flip Auto Mode on. FrameForge applies that preset — adjusted to the PC it runs on
(a laptop never gets the battery-draining power boosts, an old graphics card never gets GPU scheduling).

| | Competitive | Best performance | Balanced | Best graphics |
|---|---|---|---|---|
| Power plan, game priority, Game Mode, games on fast GPU | ✓ | ✓ | ✓ | ✓ |
| No power throttling, plain Windows visuals, Chris Titus tweaks | ✓ | ✓ | | |
| No notifications / Sticky Keys pop-ups | ✓ | | | |
| Raw mouse aim | ✓ | ✓ | ✓ | |
| Auto HDR | | | | ✓ |
| Driver checklist | Reflex/Anti-Lag, V-Sync off | Low latency, perf upscaling | Quality upscaling | High-quality textures, sharpening |

Switching preset while Auto Mode is on moves the PC over right away, undoing boosts the new preset doesn't use.

## What FrameForge changed

Every change is saved to `%APPDATA%\FrameForge\changes.json` with the time, preset, a plain summary and the
exact before → after value (registry key, power plan, games, etc.), and listed on Home — still there after a
restart. After a PC restart Auto Mode switches itself off and the changes stay active. Turning Auto Mode
off asks: **Keep my changes** or **Undo everything**. "Undo all changes" puts everything back any time.

## The assistant (Auto Mode)

Auto Mode runs as a list of steps in the background. It changes settings directly — it never takes
over your mouse or keyboard — so you can keep using your PC while it works.

- **Stop** any time with the Stop button, by flipping the switch, or from the tray icon. It finishes the
  step it's on (so nothing is left half-changed) and keeps what's done. Use "Undo all changes" to undo it all.
- Downloads come only from verified sources: Microsoft's winget store (hash-checked) and the official
  GitHub pages of PresentMon (Intel) and LibreHardwareMonitor. If a vendor has no verified automatic
  install (AMD's driver app), FrameForge opens the official download page instead.
- It finds your Steam and Epic games and sets each one to run on the high-performance graphics card.
- **Chris Titus Tech's Windows Utility**: downloads winutil from Chris Titus's official GitHub release and
  runs his Minimal / Standard / Advanced preset in winutil's own headless mode (no window). Pick the preset in
  Settings. These tweaks are NOT undone by turning Auto Mode off — use the restore point FrameForge makes
  first, or winutil's own Undo (Settings › "Open Chris Titus tool").

## Fix mode

Lists everything that didn't work or is holding the PC back: failed Auto Mode steps (with winutil's real
error lines and log), missing tools, a missing driver app, high temperatures, RAM running at the slow
default, 60 Hz displays, not running as admin. Each problem has its fix buttons (Try again, Turn on System
Protection, Open Chris Titus tool, Open winutil log, Download it, Open display settings…) and
**Ask AI to explain and fix**. **Fix everything automatically** retries and downloads whatever can be fixed
without you. Repair tools: clear shader caches, reset network, DISM + SFC, turn on System Protection —
each streams its output live and is recorded in "What FrameForge changed".

## AI chat

A chat tab powered by Claude (Anthropic) with your own API key from console.anthropic.com (stored
encrypted with Windows DPAPI), or a free local model through Ollama. Every message carries a live snapshot
of the PC — hardware, sensors, preset, every change with exact before/after values, and the Fix mode list.
With Claude it can also act — switch preset, run or undo Auto Mode, fix a problem, run a repair, open the
Chris Titus tool — and every action that changes the PC shows an **Allow / Don't allow** card first.

## In-app updates

Every copy of FrameForge checks your GitHub repo's Releases. A newer release → popup → download →
SHA-512 fingerprint check (a tampered file is thrown away) → "Restart and update".

**One-time setup**
1. Create a **public** GitHub repo, e.g. `frameforge`, and push this folder to it.
2. In FrameForge: Settings › Updates › *Where updates come from* → type `yourname/frameforge` → Save.
   (Copies built by the GitHub workflow below already point at your repo — no setting needed.)

**Every new version (automatic, recommended)**
```
git tag v1.1.0
git push origin v1.1.0
```
`.github/workflows/release.yml` builds the installer on a real Windows machine and publishes the release
with `latest.yml` attached. Then edit the release on GitHub and write what's new — that text shows in
the popup. Everyone gets the popup within 2 hours, or right away with *Check for updates*.

**Or by hand**: bump `"version"` in package.json, run `npm run dist`, create a GitHub release tagged
`v1.1.0` and upload all three files from `dist/`: the `.exe`, the `.exe.blockmap` and `latest.yml`.

## Develop

```
npm install
npm start          # on Windows: real mode. On Mac/Linux: demo mode with sample data
npm run dist       # builds dist/FrameForge-Setup-<version>.exe
```

Set `FRAMEFORGE_DEMO=1` on Windows to try the UI without touching the system.

## Code map

- `main.js` – app window, tray, overlay, Auto Mode flow, settings
- `src/optimizer.js` – every boost, with apply + undo
- `src/profile.js` – picks boosts for each PC, finds bottlenecks, overclocking plan
- `src/hardware.js` – CPU/GPU/RAM/display detection
- `src/fps.js` – PresentMon FPS reader
- `src/sensors.js` – temperatures and load
- `src/tools.js` – downloads PresentMon and LibreHardwareMonitor from their GitHub releases
- `src/updater.js` – update checks, download, fingerprint check, popup events
- `src/games.js` – finds installed Steam and Epic games
- `.github/workflows/release.yml` – builds and publishes a release when you push a version tag
- `renderer/` – the UI
