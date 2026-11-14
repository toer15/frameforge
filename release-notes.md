**FrameForge 1.18.0: live FPS everywhere, hardware that always detects right**

- The FPS counter now shows live FPS in lobbies, menus and loading screens as well as in matches. It no longer waits for a match to be recognised as “a game”: every app that presents frames is measured.
- The game you are actually playing wins over browsers, Steam/Epic/EA/Ubisoft/Battle.net launchers and Discord, and a live app beats one that stopped drawing — alt-tabbing no longer freezes the counter on old numbers.
- The last real reading is held for five seconds across a lobby → match switch or a loading screen, marked “last reading” on Home; after that the counter shows a dash instead of a stale number.
- PresentMon is restarted by FrameForge if it exits, instead of leaving FPS blank until the app is restarted.
- Hardware detection was rebuilt on Windows’ own WMI: CPU, every graphics chip, 64-bit VRAM, display resolution and current refresh rate, RAM type/speed/sticks, Windows release and motherboard, in about 1.5 seconds instead of ten. Dedicated cards are never mistaken for integrated graphics, and PCs where the old sensor library returned no graphics or display data now still show their full rig.
- CPU and GPU names are cleaned of ®/™ clutter, and the FPS limiter recommendation uses the real current refresh rate.

## Previous release

**FrameForge 1.17.9: lower background overhead**

- Frame timing now trims old samples without shifting the full frame array, and refreshes the 1% low once per second while live FPS stays at four updates per second.
- The Home screen pauses its periodic Fix-list refresh while FrameForge is unfocused, then refreshes as soon as it regains focus.

## Previous release

**FrameForge 1.17.8: keep the driver app closed before restart**

- Auto Mode skips opening AMD Software, the NVIDIA app or Intel Graphics Software while a PC restart is pending. You can open it manually after restarting.

## Previous release

**FrameForge 1.17.7: restart control at the top**

- Moved **Restart PC to finish** into the Home screen’s top Auto Mode card, beneath its status, so it appears where the restart action is needed.

## Previous release

**FrameForge 1.17.6: clearer FPS stability status**

- The red FPS stability status now says “Not consistent.”

## Previous release

**FrameForge 1.17.5: FPS stability switch**

- Added a direct FPS stability graph switch to the FPS limiter tab. It stays in sync with the overlay’s “What it shows” option.

## Previous release

**FrameForge 1.17.4: live FPS stability**

- Added an optional FPS stability box to the overlay. Turn it on or off with the **FPS stability** chip under FPS limiter → What it shows → Frames.
- Its live trace compares current FPS with the recent baseline. It stays green within 5% (or 3 FPS) and turns red when FPS shifts beyond that range.

## Previous release

**FrameForge 1.17.2: fix blank live FPS**

- The FPS reader now normalizes PresentMon CSV headers before parsing, including UTF-8 markers, quotes and whitespace.
- This prevents valid game-frame samples from being dropped, leaving a dash instead of the measured FPS.
