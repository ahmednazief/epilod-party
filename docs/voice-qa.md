# Epilod Party — Two-PC Voice Chat Hardware & Network QA Matrix

Architecture note: Epilod Party voice chat is **100% serverless peer-to-peer (\$0, zero telemetry, zero TURN servers)**. All connectivity uses direct IPv6/LAN/WAN UDP hole punching plus opt-in peer-mesh 1-hop relay.

Automated unit, DSP, and 500-iteration loopback churn tests cover packet routing, jitter headroom, NLMS/echo gating, bitrate downshift/upshift, roster reconciliation, and mpv ducking reassertion. The scenarios below require real Windows hardware, audio drivers, Bluetooth stacks, or real carrier NATs across two or more PCs.

## Test Matrix

| # | Scenario | Setup & Steps | Pass Criteria | Result (Pass/Fail) | Notes / Build |
| --- | --- | --- | --- | --- | --- |
| 1 | **Clean baseline (headphones)** | Two PCs on same LAN and over WAN with wired/USB headsets. Join room, both click **Join Voice**, watch 10+ minutes of a film with dialogue & quiet scenes. | Direct LAN or Direct P2P path; steady audio without clicks, robotic artifacts, or ghost self-echo; peer avatar rings light up only during real speech. | | |
| 2 | **Open speakers + mic (echo guard & opt-in AEC)** | Mute peer headphones, play movie aloud through PC speakers near a desk mic. Test once with **Speaker Echo Guard** on (default) and once with **Experimental Software Echo Canceller** toggled on. | No runaway feedback howl or room echo loop; half-duplex attenuation engages briefly when speaker playback exceeds speech, and Voice Health shows echo/AEC status accurately. | | |
| 3 | **Bluetooth headset split-device & HFP drop** | Connect Bluetooth headphones with built-in mic (Hands-Free Telephony enabled vs stereo A2DP output). Observe pre-join prompt and live call behavior; toggle mic to Wired or click **Listen Only**. | Pre-join warning explains Windows HFP stereo quality drop and offers **Listen Only** or **Join Anyway**; mid-call HFP drop surfaces warning banner and recovers smoothly when switching to Listen Only or wired mic. | | |
| 4 | **USB mic unplug, sleep/resume, & exclusive-mode conflict** | (a) Unplug USB mic mid-call and plug back in after 5s. (b) Put PC to sleep for 20s and wake. (c) Open another app in WASAPI Exclusive Mode holding the mic, then click **Join Voice**. | (a) Reconnects cleanly without restarting Epilod Party and never silently transmits dead air. (b) Sleep jump triggers capture/playback rebind within a few seconds. (c) Exclusive lock displays *"Mic in exclusive use by another app"* (`micBusy`) instead of claiming "Mic ready". | | |
| 5 | **Carrier/Symmetric NAT & Strict Firewall** | Place PC A on a symmetric mobile hotspot with PC B on home broadband, plus a 3rd relay-capable friend (on AC power) when testing relay; also test 2 PCs both behind strict symmetric NATs with `allowRelayForOthers = false`. | When a relay-eligible peer is in the room, traffic falls back to **Relayed P2P** cleanly and Voice Health shows AC/battery relay score. When blocked by double symmetric NAT, UI explicitly shows *"Strict NAT blocked"* with actionable reason & fix rather than stalling forever. | | |
| 6 | **Poor Wi-Fi + concurrent file/subtitle transfer** | Throttle Wi-Fi or move PC far from router while initiating playlist/chunk sync alongside voice. Inspect Voice Health metrics during and after burst loss. | Adaptive bitrate steps down swiftly under burst loss and recovers conservatively without oscillation; jitter headroom absorbs 200-300 ms bursts; voice priority throttles bulk chunk bursts. | | |
| 7 | **Small -> medium room scaling (2 / 4 / 8 peers) + Listen Only** | Join a 4-8 peer room (including peers on modest upload links). Test Mute, Deafen, and **Listen Only** pill. | Room bitrate cap lowers per-stream kbps cleanly instead of saturating upload; deafened/Listen Only peers avoid uploading audio; **Listen Only** receives full room voices cleanly. | | |
| 8 | **Movie auto-ducking across episode load & mpv restart** | Set **Movie Auto-Ducking** to Subtle or Strong with user volume at 80%. Trigger peer speech, switch episodes mid-speech, pause/unpause, and trigger mpv reload. | Movie playback ducks smoothly without stuttering on rapid voice chatter (hysteresis hold) and returns to **exact** user volume (80%) after speech ends, episode switch, and mpv restart. | | |
| 9 | **Voice hotkeys: global vs focused & chat typing** | Bind PTT/Mute/Deafen with Ctrl/Alt/Shift combos, Mouse 4/5, or F-keys; test **Only When Epilod Is Focused** enabled vs disabled; type in room chat / external Notepad. | Plain single letters cannot accidentally hijack Windows typing; modifier combos (`Ctrl+...`, `Alt+...`) match reliably; when focused-only is enabled, outside apps never trigger Epilod voice hotkeys. | | |
| 10 | **Calibrate (3s), Auto-Sensitivity, & Kill Switch** | Run **Calibrate (3s)** silently for ~1.5s then speaking normally; verify updated threshold. Toggle **Voice Chat Enabled** off mid-call and back on. | Calibration measures noise floor + speech midpoint cleanly and sets threshold. Disabling **Voice Chat Enabled** immediately leaves call, closes audio workers, and hides/locks Join controls cleanly until re-enabled. | | |

## Capturing Failures

If any check above fails:

1. Open **Settings -> Voice & Audio -> Voice Health**.
2. Click **Copy Voice Report** (local JSON snapshot — zero network upload).
3. Attach the copied JSON alongside what step in the matrix failed and your Windows headset/microphone model.
