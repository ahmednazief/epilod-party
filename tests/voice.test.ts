import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function setupMockLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(key: string) {
      return backing.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(backing.keys())[index] ?? null;
    },
    removeItem(key: string) {
      backing.delete(key);
    },
    setItem(key: string, value: string) {
      backing.set(key, String(value));
    },
  };
  return backing;
}

async function bundleAndImport<T>(entryRel: string): Promise<T> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-voice-test-"));
  try {
    const outFile = path.join(outDir, "mod.mjs");
    buildSync({
      entryPoints: [path.join(REPO_ROOT, entryRel)],
      outfile: outFile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    return (await import(pathToFileURL(outFile).href)) as T;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("useVoiceStore persists config, clamps per-peer volumes and sensitivity, and resets session cleanly", async () => {
  const storage = setupMockLocalStorage();
  const { useVoiceStore, clampPeerVolume, clampSensitivityDb, computeEffectiveMpvVolume } =
    await bundleAndImport<typeof import("../src/store/useVoiceStore")>("src/store/useVoiceStore.ts");

  assert.equal(clampPeerVolume(3.5), 2.0);
  assert.equal(clampPeerVolume(-0.2), 0.0);
  assert.equal(clampSensitivityDb(-95), -75);
  assert.equal(clampSensitivityDb(5), 0);

  // Ducking multiplier invariant: UI user volume stays unchanged while effective mpv volume ducks
  const userVol = 80;
  assert.equal(computeEffectiveMpvVolume(userVol, 0.75), 60);
  assert.equal(computeEffectiveMpvVolume(userVol, 1.0), 80);

  const store = useVoiceStore.getState();
  assert.equal(store.joined, false);
  assert.equal(store.noiseMode, "balanced");
  assert.equal(store.allowRelayForOthers, true);

  store.updateConfig({
    noiseMode: "strong",
    sensitivityDb: -36,
    duckingMode: "strong",
    inputMode: "ptt",
    pttVk: 0x05,
  });
  store.setPeerVolume("Alice", 1.75, false);
  store.setJoined(true);
  store.setSpeakingPeers(["Alice"]);

  const after = useVoiceStore.getState();
  assert.equal(after.noiseMode, "strong");
  assert.equal(after.sensitivityDb, -36);
  assert.equal(after.duckingMode, "strong");
  assert.equal(after.inputMode, "ptt");
  assert.equal(after.pttVk, 0x05);
  assert.equal(after.peerOverrides["alice"]?.volume, 1.75);
  assert.equal(storage.get("ep.voice.noiseMode"), "strong");

  after.resetSession();
  const reset = useVoiceStore.getState();
  assert.equal(reset.joined, false);
  assert.deepEqual(reset.speakingPeers, []);
  assert.deepEqual(reset.roster, []);
  // Persisted settings survive session reset
  assert.equal(reset.noiseMode, "strong");
});

test("soundEffects registers voice cues and formats Windows VK labels cleanly", async () => {
  const sfxSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/soundEffects.ts"), "utf8");
  for (const cue of [
    "voiceJoined",
    "voiceLeft",
    "peerVoiceJoined",
    "peerVoiceLeft",
    "micMuted",
    "micUnmuted",
  ]) {
    assert.ok(sfxSrc.includes(`"${cue}"`), `Missing SoundCue ${cue}`);
    assert.ok(sfxSrc.includes(`${cue}:`), `Missing CUE_RECIPES entry ${cue}`);
  }

  const { formatVkLabel } = await bundleAndImport<typeof import("../src/lib/voice")>(
    "src/lib/voice.ts",
  );
  assert.equal(formatVkLabel(0), "Unbound");
  assert.equal(formatVkLabel(0x56), "V");
  assert.equal(formatVkLabel(0x05), "Mouse 4");
  assert.equal(formatVkLabel(0x06), "Mouse 5");
  assert.equal(formatVkLabel(0x74), "F5");
});

test("RoomPanel, SettingsModal, WatchRoom, and AppIcons wire voice controls without violating UX invariants", () => {
  const roomPanel = fs.readFileSync(path.join(REPO_ROOT, "src/components/RoomPanel.tsx"), "utf8");
  const settingsModal = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  const watchRoom = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  const appIcons = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/AppIcons.tsx"), "utf8");

  assert.equal(roomPanel.includes("Join Voice"), true);
  assert.equal(roomPanel.includes("Leave Voice"), true);
  assert.equal(roomPanel.includes("Voice Volume"), true);
  assert.equal(settingsModal.includes("Voice & Audio"), true);
  assert.equal(settingsModal.includes("AI Noise Cancellation"), true);
  assert.equal(settingsModal.includes("Movie Auto-Ducking"), true);
  assert.equal(settingsModal.includes("Let's Check"), true);
  assert.equal(watchRoom.includes("onVoiceRoster"), true);
  assert.equal(watchRoom.includes("voiceSetMoviePlaying"), true);
  for (const icon of [
    "AppVoiceCategoryIcon",
    "AppMicIcon",
    "AppHeadphonesIcon",
    "AppVoiceWaveIcon",
  ]) {
    assert.match(appIcons, new RegExp(`export function ${icon}\\(`));
  }
});

test("hotkey validator rejects plain keys, accepts combos/F-keys/mouse, and flags app conflicts", async () => {
  const {
    validateVoiceHotkey,
    formatVoiceHotkey,
    domEventModifiersMask,
    VOICE_MOD_CTRL,
    VOICE_MOD_ALT,
    VOICE_MOD_SHIFT,
  } = await bundleAndImport<typeof import("../src/lib/voice")>("src/lib/voice.ts");

  assert.equal(validateVoiceHotkey(0x56, 0).valid, false);
  assert.equal(validateVoiceHotkey(0x31, 0).valid, false);
  assert.equal(validateVoiceHotkey(0x20, 0).valid, false);

  assert.equal(validateVoiceHotkey(0x74, 0).valid, true); // F5
  assert.equal(validateVoiceHotkey(0x05, 0).valid, true); // Mouse 4
  assert.equal(validateVoiceHotkey(0x56, VOICE_MOD_CTRL).valid, true);
  assert.equal(validateVoiceHotkey(0x4d, VOICE_MOD_ALT, "focused").valid, true);

  const ctrlO = validateVoiceHotkey(0x4f, VOICE_MOD_CTRL);
  assert.equal(ctrlO.valid, true);
  assert.ok(ctrlO.warning && ctrlO.warning.includes("Ctrl+O"));

  assert.equal(formatVoiceHotkey(0x56, VOICE_MOD_CTRL | VOICE_MOD_SHIFT), "Ctrl+Shift+V");
  assert.equal(
    domEventModifiersMask({ ctrlKey: true, altKey: false, shiftKey: true }),
    VOICE_MOD_CTRL | VOICE_MOD_SHIFT,
  );
});

test("voiceEnabled kill switch resets active call state and H0-H3 UI remains serverless", async () => {
  setupMockLocalStorage();
  const { useVoiceStore } = await bundleAndImport<typeof import("../src/store/useVoiceStore")>(
    "src/store/useVoiceStore.ts",
  );
  const store = useVoiceStore.getState();
  store.updateConfig({ voiceEnabled: true });
  store.setJoined(true);
  store.setSpeakingPeers(["Bob"]);
  assert.equal(useVoiceStore.getState().joined, true);

  useVoiceStore.getState().updateConfig({ voiceEnabled: false });
  const afterKill = useVoiceStore.getState();
  assert.equal(afterKill.voiceEnabled, false);
  assert.equal(afterKill.joined, false);
  assert.deepEqual(afterKill.speakingPeers, []);

  const roomPanel = fs.readFileSync(path.join(REPO_ROOT, "src/components/RoomPanel.tsx"), "utf8");
  const settingsModal = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  const voiceStoreSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/store/useVoiceStore.ts"),
    "utf8",
  );

  assert.equal(settingsModal.includes("Voice Health"), true);
  assert.equal(settingsModal.includes("Copy Voice Report"), true);
  assert.equal(settingsModal.includes("Calibrate (3s)"), true);
  assert.equal(settingsModal.includes("Only When Epilod Is Focused"), true);
  assert.equal(roomPanel.includes("Listen Only"), true);
  assert.equal(roomPanel.includes("Voice Disabled"), true);

  for (const src of [roomPanel, settingsModal, voiceStoreSrc]) {
    assert.equal(src.includes("customRelayUrl"), false);
    assert.equal(/\bTURN server\b/i.test(src), false);
  }
});

test("deafen preserves pre-deafen mute state, masterVolume clamps safely, and default mute/deafen hotkeys allow explicit unbind", async () => {
  const storage = setupMockLocalStorage();
  const { useVoiceStore, clampMasterVolume } = await bundleAndImport<
    typeof import("../src/store/useVoiceStore")
  >("src/store/useVoiceStore.ts");

  assert.equal(clampMasterVolume(2.8), 2.0);
  assert.equal(clampMasterVolume(-0.4), 0.0);

  const initial = useVoiceStore.getState();
  // Fresh storage gets usable Ctrl+Shift+M / Ctrl+Shift+D defaults
  assert.equal(initial.muteVk, 0x4d);
  assert.equal(initial.muteMod, 5);
  assert.equal(initial.deafenVk, 0x44);
  assert.equal(initial.deafenMod, 5);
  assert.equal(initial.masterVolume, 1.0);

  // Explicit clear persists "0" so re-imports honor unbound hotkeys
  initial.updateConfig({ muteVk: 0, muteMod: 0, masterVolume: 1.4 });
  assert.equal(storage.get("ep.voice.muteVk"), "0");
  assert.equal(useVoiceStore.getState().masterVolume, 1.4);

  // Unmuted -> deafen -> undeafen keeps mic unmuted
  useVoiceStore.getState().setMuted(false);
  useVoiceStore.getState().setDeafened(true);
  assert.equal(useVoiceStore.getState().muted, true);
  assert.equal(useVoiceStore.getState().deafened, true);
  useVoiceStore.getState().setDeafened(false);
  assert.equal(useVoiceStore.getState().muted, false);
  assert.equal(useVoiceStore.getState().deafened, false);

  // Already muted -> deafen -> undeafen keeps mic muted (no hot mic leak!)
  useVoiceStore.getState().setMuted(true);
  useVoiceStore.getState().setDeafened(true);
  assert.equal(useVoiceStore.getState().muted, true);
  useVoiceStore.getState().setDeafened(false);
  assert.equal(useVoiceStore.getState().muted, true);
  assert.equal(useVoiceStore.getState().deafened, false);

  // Unmuting while deafened clears both deafen and preDeafenMuted
  useVoiceStore.getState().setDeafened(true);
  useVoiceStore.getState().setMuted(false);
  assert.equal(useVoiceStore.getState().deafened, false);
  assert.equal(useVoiceStore.getState().muted, false);
});

test("diffVoiceRosterPeers suppresses seed snapshot and tracks remote joins/leaves cleanly", async () => {
  setupMockLocalStorage();
  const { diffVoiceRosterPeers } = await bundleAndImport<typeof import("../src/lib/voiceActions")>(
    "src/lib/voiceActions.ts",
  );

  const makePeer = (username: string, inVoice: boolean) => ({
    username,
    voiceId: 1,
    epoch: 1,
    inVoice,
    muted: false,
    deafened: false,
    transport: "directLan",
    relayVia: null,
    rttMs: 12,
    lossPct: 0,
    jitterMs: 5,
    bitrateKbps: 48,
    qualityBars: 4,
    healthReason: null,
    healthFix: null,
  });

  // Initial seed suppresses false notifications
  const seed = diffVoiceRosterPeers(null, [makePeer("Me", false), makePeer("Alice", true)], "Me");
  assert.deepEqual(seed.joinedUsers, []);
  assert.deepEqual(seed.leftUsers, []);

  // Bob enters voice -> triggers join transition
  const step2 = diffVoiceRosterPeers(
    seed.nextMap,
    [makePeer("Me", false), makePeer("Alice", true), makePeer("Bob", true)],
    "Me",
  );
  assert.deepEqual(step2.joinedUsers, ["Bob"]);
  assert.deepEqual(step2.leftUsers, []);

  // Alice drops out of voice -> triggers leave transition
  const step3 = diffVoiceRosterPeers(
    step2.nextMap,
    [makePeer("Me", false), makePeer("Alice", false), makePeer("Bob", true)],
    "Me",
  );
  assert.deepEqual(step3.joinedUsers, []);
  assert.deepEqual(step3.leftUsers, ["Alice"]);
});

test("Voice UX overhaul removes 4-peer Listen Only gate, unlocks in-call mic test, and organizes Settings", () => {
  const roomPanel = fs.readFileSync(path.join(REPO_ROOT, "src/components/RoomPanel.tsx"), "utf8");
  const settingsModal = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  const quickTray = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/VoiceQuickSettingsTray.tsx"),
    "utf8",
  );
  const stageOverlay = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/StageSpeakerOverlay.tsx"),
    "utf8",
  );

  assert.equal(roomPanel.includes("voicePeersInCall.length >= 4"), false);
  assert.equal(roomPanel.includes("Switch to PTT"), false);
  assert.equal(quickTray.includes("Push-to-Talk"), true);
  assert.equal(settingsModal.includes("Push-to-Talk"), true);
  assert.equal(settingsModal.includes("Master Voice Volume"), true);
  assert.equal(settingsModal.includes("Advanced Audio &amp; Network"), true);
  assert.equal(settingsModal.includes("disabled={voiceJoined || !voiceEnabled}"), false);
  assert.equal(quickTray.includes("Voice Chat Volume"), true);
  assert.equal(quickTray.includes("disabled={!voiceEnabled || joined}"), false);
  assert.equal(stageOverlay.includes("localMuted"), true);
});

test("voiceActions speaking predicates and multi-surface Voice UX components are wired cleanly", async () => {
  setupMockLocalStorage();
  const { isLocalVoiceSpeaking, isParticipantSpeaking } = await bundleAndImport<
    typeof import("../src/lib/voiceActions")
  >("src/lib/voiceActions.ts");

  const baseState = {
    joined: true,
    muted: false,
    deafened: false,
    localGateOpen: true,
    streamStatus: "live",
    speakingPeers: ["Maya"],
    roster: [
      { username: "Maya", inVoice: true, muted: false, deafened: false },
      { username: "Tariq", inVoice: true, muted: true, deafened: false },
    ],
    peerOverrides: {},
  };

  assert.equal(isLocalVoiceSpeaking(baseState), true);
  assert.equal(isLocalVoiceSpeaking({ ...baseState, muted: true }), false);
  assert.equal(isLocalVoiceSpeaking({ ...baseState, streamStatus: "micBusy" }), false);
  assert.equal(isParticipantSpeaking("Noor", "Noor", baseState), true);
  assert.equal(isParticipantSpeaking("Maya", "Noor", baseState), true);
  assert.equal(isParticipantSpeaking("Tariq", "Noor", baseState), false);
  assert.equal(
    isParticipantSpeaking("Maya", "Noor", {
      ...baseState,
      peerOverrides: { maya: { volume: 1.0, muted: true } },
    }),
    false,
  );

  const chatSidebar = fs.readFileSync(path.join(REPO_ROOT, "src/components/ChatSidebar.tsx"), "utf8");
  const transportBar = fs.readFileSync(path.join(REPO_ROOT, "src/components/TransportBar.tsx"), "utf8");
  const quickTray = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/VoiceQuickSettingsTray.tsx"),
    "utf8",
  );
  const watchRoom = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  const settingsModal = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );

  const partySidebar = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PartySidebar.tsx"),
    "utf8",
  );
  const roomPanel = fs.readFileSync(path.join(REPO_ROOT, "src/components/RoomPanel.tsx"), "utf8");
  const globalsCss = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");

  assert.equal(partySidebar.includes("VoiceQuickSettingsTray"), true);
  assert.equal(quickTray.includes('navigateTo("input", "push")'), true);
  assert.equal(quickTray.includes('navigateTo("output", "push")'), true);
  assert.equal(quickTray.includes('navigateTo("filters", "push")'), true);
  assert.equal(quickTray.includes("anim-submenu-push"), true);
  assert.equal(quickTray.includes("anim-submenu-pop"), true);
  assert.equal(roomPanel.includes("ep-popover-bloom"), true);
  assert.equal(roomPanel.includes("ep-popover-bloom-out"), true);
  assert.equal(partySidebar.includes("ep-popover-bloom"), true);
  assert.equal(partySidebar.includes("ep-popover-bloom-out"), true);
  assert.equal(globalsCss.includes("@keyframes ep-submenu-push"), true);
  assert.equal(globalsCss.includes("@keyframes ep-submenu-pop"), true);
  assert.equal(transportBar.includes("Auto-ducking movie"), true);
  assert.equal(transportBar.includes("PresenceAvatar"), true);
  assert.equal(transportBar.includes("ep-speaking-ring"), false);
  assert.equal(globalsCss.includes(".ep-presence-ring"), true);
  assert.equal(globalsCss.includes("@keyframes ep-speaking-ring-pulse"), false);
  assert.equal(quickTray.includes('aria-label="All Voice & Audio Settings"'), true);
  assert.equal(quickTray.includes("wasOpenRef"), true);
  assert.equal(settingsModal.includes("wasVoiceTabOpenRef"), true);
  assert.equal(quickTray.includes("acquireMicMonitorSurface"), true);
  assert.equal(quickTray.includes("releaseMicMonitorSurface"), true);
  assert.equal(settingsModal.includes("acquireMicMonitorSurface"), true);
  assert.equal(settingsModal.includes("releaseMicMonitorSurface"), true);
  assert.equal(watchRoom.includes("StageSpeakerOverlay"), true);

  // Verify surface ref-counting keeps mic monitor alive across Tray -> Settings handoff
  const {
    acquireMicMonitorSurface,
    releaseMicMonitorSurface,
    getActiveMicMonitorSurfaces,
  } = await bundleAndImport<typeof import("../src/lib/voice")>("src/lib/voice.ts");
  assert.equal(getActiveMicMonitorSurfaces(), 0);
  assert.equal(acquireMicMonitorSurface(), 1); // Tray opens
  assert.equal(acquireMicMonitorSurface(), 2); // Settings -> Voice opens from tray link
  assert.equal(releaseMicMonitorSurface(), 1); // Tray closes -> monitor must stay alive
  assert.equal(releaseMicMonitorSurface(), 0); // Settings closes -> safe to stop monitor
  assert.equal(releaseMicMonitorSurface(), 0); // Clamps at 0
});

test("toggleVoiceMute flashes fluid micCue for mute/unmute and KeyM routes mic mute when joined", async () => {
  setupMockLocalStorage();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-mic-cue-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export { useVoiceStore } from "./src/store/useVoiceStore.ts";
          export { toggleVoiceMute } from "./src/lib/voiceActions.ts";
        `,
        resolveDir: REPO_ROOT,
        loader: "ts",
      },
      outfile: outFile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    const { useVoiceStore, toggleVoiceMute } = await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
    useVoiceStore.getState().resetSession();
    useVoiceStore.getState().setJoined(true);
    assert.equal(useVoiceStore.getState().micCue, null);

    const mutedNow = toggleVoiceMute();
    assert.equal(mutedNow, true);
    assert.equal(useVoiceStore.getState().micCue?.muted, true);
    assert.equal(useVoiceStore.getState().micCue?.step, 1);

    const unmutedNow = toggleVoiceMute();
    assert.equal(unmutedNow, false);
    assert.equal(useVoiceStore.getState().micCue?.muted, false);
    assert.equal(useVoiceStore.getState().micCue?.step, 2);

    useVoiceStore.getState().clearMicCue();
    assert.equal(useVoiceStore.getState().micCue, null);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  const shortcutsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/hooks/usePlayerShortcuts.ts"),
    "utf8",
  );
  const watchRoomSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  const globalsCss = fs.readFileSync(
    path.join(REPO_ROOT, "src/styles/globals.css"),
    "utf8",
  );

  assert.equal(shortcutsSrc.includes("toggleVoiceMute()"), true);
  assert.equal(watchRoomSrc.includes("micCuePresence"), true);
  assert.equal(watchRoomSrc.includes("ep-glass-mic-cue"), true);
  assert.equal(globalsCss.includes("@keyframes ep-mic-cue-in"), true);
  assert.equal(globalsCss.includes("@keyframes ep-mic-cue-out"), true);
  assert.equal(globalsCss.includes("@keyframes ep-mic-halo-pulse"), true);
});

test("clicking or pressing mute does not wake the hidden play bar", () => {
  const shortcutsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/hooks/usePlayerShortcuts.ts"),
    "utf8",
  );
  const watchRoomSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  const partySidebarSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PartySidebar.tsx"),
    "utf8",
  );
  const chatSidebarSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ChatSidebar.tsx"),
    "utf8",
  );
  const voiceControlsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/VoiceQuickControls.tsx"),
    "utf8",
  );

  // Neither KeyM mic mute nor KeyM video mute should call onWakeChrome
  assert.doesNotMatch(
    shortcutsSrc,
    /if\s*\(e\.code === "KeyM"[\s\S]*?toggleVoiceMute\(\)/m.source
      ? /if\s*\(e\.code === "KeyM" && !e\.shiftKey\)[\s\S]*?onWakeChrome\?\.\(\)[\s\S]*?toggleVoiceMute\(\)/
      : /$^/,
  );
  assert.doesNotMatch(
    shortcutsSrc,
    /if\s*\(e\.code === "KeyM"\)\s*\{[^}]*onWakeChrome\?\.\(\)[^}]*toggleMutePlayback\(\)/,
  );

  // Sidebar surfaces (both docked and floating) are excluded from WatchRoom wakeChrome pointer handlers
  assert.match(partySidebarSrc, /data-sidebar-surface="true"/);
  assert.match(chatSidebarSrc, /data-sidebar-surface="true"/);
  assert.equal(
    watchRoomSrc.split('closest(\'[data-docked-sidebar="true"], [data-sidebar-surface="true"]\')')
      .length - 1,
    2,
  );

  // Mic mute button stops pointerDown propagation
  assert.match(
    voiceControlsSrc,
    /aria-label=\{muted \? "Unmute microphone" : "Mute microphone"\}[\s\S]*?onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}/,
  );
});
