**FrameForge 1.17.2: fix blank live FPS**

- The FPS reader now normalizes PresentMon CSV headers before parsing, including UTF-8 markers, quotes and whitespace.
- This prevents valid game-frame samples from being dropped, leaving a dash instead of the measured FPS.
