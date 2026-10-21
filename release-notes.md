**Fix: "Use all CPU cores" error on AMD X3D and some other PCs**

- On some PCs, Windows doesn't let apps change certain power settings — for example core parking on AMD X3D chips, whose driver manages it itself. FrameForge showed a raw "value is malformed" error. Now the switch shows **Locked on this PC** with a plain explanation, nothing is changed, and it no longer lands in Fix mode.
- Power tweaks now read the range your PC allows and stay inside it. If your PC caps a setting lower, FrameForge uses the highest value it allows and tells you.
- If one setting in a tweak is refused, anything it already changed is put back right away.
- "Turn on everything recommended" skips locked settings.
- The old core parking warning in Fix mode is cleared by itself.
