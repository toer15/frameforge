**Fix mode now fixes things for you — no clicking**

- **Fixes problems by itself in the background.** Every 2 minutes FrameForge checks your PC and fixes what it safely can, then tells you with a notification. Examples: tweaks Windows switched off, a display stuck at 60 Hz, a graphics card running hot, missing tools. While you're gaming it only does things you won't notice. Bigger jobs, like cleanup or the Chris Titus tool, wait until you've been away from the PC for 10 minutes. You can turn this off with a switch at the top of Fix mode.
- **Restarts the PC by itself when a fix needs it.** A 60-second countdown shows **Restart now** and **Cancel**. After the restart FrameForge opens by itself, checks that everything worked and finishes the job. Apps with unsaved work can still stop the restart, so nothing gets lost. It never restarts twice within 3 hours.
- **Chris Titus tool failing?** FrameForge finds the one tweak that fails on your PC, leaves it out, and runs the rest of the preset.
- **Graphics card running hot (NVIDIA):** FrameForge lowers the power limit to 90 %. That usually costs only a few percent FPS and runs much cooler. Heat now has to last 30 seconds before it counts, so a quick spike doesn't trigger it, and the limit is higher for CPUs built to run hot (Ryzen 7000/9000, Intel 12th–14th gen).
- **No AMD Software?** FrameForge downloads AMD's own installer from amd.com and has Windows check AMD's digital signature on it. It then starts the installer, so all you do is click Install.
- **RAM at the slow default:** a new **Restart into BIOS** button restarts straight into the BIOS, so you don't have to tap any keys. Back in Windows, FrameForge checks the new RAM speed by itself. The BIOS setting itself can't be changed from Windows, so that one step stays yours.

**AI chat: pick a model, press Install**
- An **AI model** menu at the top right of the chat lists Claude Opus, Sonnet and Haiku, plus free models that run on your PC: Llama 3.1, Llama 3.2, Qwen 2.5, Gemma 3 and Mistral.
- If a free model isn't installed yet, an **Install** button appears beside the menu. FrameForge installs the free Ollama app from Microsoft's verified store, starts it and downloads the model, with a progress bar. Each part of the download is checked against its fingerprint.
