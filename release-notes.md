**Fix mode now handles everything it can by itself**

With “Fix problems by itself” on, FrameForge no longer waits for a click on these:

- **Windows protection problems**: real-time protection, cloud protection, blocking of unwanted programs, the firewall, UAC, old virus definitions, risky Defender exclusions and hosts-file redirects. Each change is listed under “What FrameForge changed”, and the hosts file is backed up first.
- **Confirmed threats from a virus scan** are quarantined (only clear-cut ones; you can restore them from the Virus scan tab). Anything uncertain still waits for your choice.
- **Laptop on battery**: Windows power mode is set to Best performance.
- **AMD Software missing**: downloaded and its installer started while you’re away, if “Download performance tools” is on.

Still left for you, because Windows can’t do them: BIOS settings such as RAM speed, hardware changes, and confirming an administrator prompt.
