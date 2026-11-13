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
