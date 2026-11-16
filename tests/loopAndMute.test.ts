import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type { MpvTrack } from "../src/lib/mpv";
import type { Participant } from "../src/lib/syncplay";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadTestModules() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-loop-mute-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * as playerActions from "./src/lib/playerActions.ts";
          export { useAppStore } from "./src/store/useAppStore.ts";
          export { useNotificationStore } from "./src/store/useNotificationStore.ts";
          export { usePlayerStore } from "./src/store/usePlayerStore.ts";
          export { useSyncStore } from "./src/store/useSyncStore.ts";
        `,
        resolveDir: REPO_ROOT,
        loader: "ts",
      },
      outfile: outFile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    return (await import(pathToFileURL(outFile).href)) as {
      playerActions: typeof import("../src/lib/playerActions");
      useAppStore: typeof import("../src/store/useAppStore")["useAppStore"];
      useNotificationStore: typeof import("../src/store/useNotificationStore")["useNotificationStore"];
      usePlayerStore: typeof import("../src/store/usePlayerStore")["usePlayerStore"];
      useSyncStore: typeof import("../src/store/useSyncStore")["useSyncStore"];
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function makeTracks(options?: { selectedAid?: number | null }): MpvTrack[] {
  const selectedAid = options?.selectedAid === undefined ? 1 : options.selectedAid;
  return [
    { id: 1, type: "video", title: "Main", selected: true },
    { id: 1, type: "audio", title: "Japanese", lang: "jpn", default: false, selected: selectedAid === 1 },
    { id: 2, type: "audio", title: "English", lang: "eng", default: true, selected: selectedAid === 2 },
    { id: 1, type: "sub", title: "English ASS", lang: "eng", default: true, selected: true },
  ];
}

function makeParticipant(overrides: Partial<Participant> & { username: string }): Participant {
  return {
    room: "123456",
    position: 0,
    fileName: "episode.mkv",
    fileDuration: 120,
    isReady: true,
    isController: false,
    fileMatch: "matched",
    ...overrides,
  };
}

function resetStores(m: Awaited<ReturnType<typeof loadTestModules>>) {
  m.usePlayerStore.getState().reset();
  m.usePlayerStore.getState().setMuted(false);
  m.usePlayerStore.getState().setVolume(100);
  m.useSyncStore.getState().reset();
  m.useNotificationStore.getState().clearAll();
  m.useAppStore.getState().setUsername("Alice");
}

test("Audio menu Mute / Off synchronizes muted state, aid, and track restoration", async () => {
  const m = await loadTestModules();
  resetStores(m);

  const player = m.usePlayerStore.getState();
  player.setLoaded(true);
  player.setTracks(makeTracks({ selectedAid: 1 }));

  const muteCalls: boolean[] = [];
  const aidCalls: Array<number | null> = [];
  const deps = {
    mpvSetMute: async (muted: boolean) => {
      muteCalls.push(muted);
    },
    mpvSetAudioTrack: async (aid: number | null) => {
      aidCalls.push(aid);
    },
  };

  // Selecting "Mute / Off" sets aid=null AND muted=true.
  m.playerActions.selectAudioTrackOption(null, deps);
  assert.equal(m.usePlayerStore.getState().muted, true);
  assert.deepEqual(aidCalls, [null]);
  assert.deepEqual(muteCalls, [true]);
  assert.equal(
    m.usePlayerStore.getState().tracks.some((t) => t.type === "audio" && t.selected),
    false,
  );

  // Unmuting via Speaker / KeyM / "Mute Audio" toggle restores the default audio track (id 2).
  m.playerActions.toggleMutePlayback(deps);
  assert.equal(m.usePlayerStore.getState().muted, false);
  assert.deepEqual(muteCalls, [true, false]);
  assert.deepEqual(aidCalls, [null, 2]);
  const restored = m.usePlayerStore.getState().tracks.find((t) => t.type === "audio" && t.selected);
  assert.equal(restored?.id, 2);
});

test("Selecting an audio track while muted automatically unmutes; re-clicking Mute / Off restores audio", async () => {
  const m = await loadTestModules();
  resetStores(m);

  const player = m.usePlayerStore.getState();
  player.setLoaded(true);
  player.setTracks(makeTracks({ selectedAid: 1 }));

  const muteCalls: boolean[] = [];
  const aidCalls: Array<number | null> = [];
  const deps = {
    mpvSetMute: async (muted: boolean) => {
      muteCalls.push(muted);
    },
    mpvSetAudioTrack: async (aid: number | null) => {
      aidCalls.push(aid);
    },
  };

  // Mute via global toggle (keeps track 1 selected, muted=true).
  m.playerActions.toggleMutePlayback(deps);
  assert.equal(m.usePlayerStore.getState().muted, true);
  assert.equal(
    m.usePlayerStore.getState().tracks.find((t) => t.type === "audio" && t.selected)?.id,
    1,
  );

  // Choosing Track 2 in Audio menu switches to Track 2 AND unmutes.
  m.playerActions.selectAudioTrackOption(2, deps);
  assert.equal(m.usePlayerStore.getState().muted, false);
  assert.deepEqual(aidCalls, [2]);
  assert.deepEqual(muteCalls, [true, false]);

  // Clicking "Mute / Off" mutes & clears audio track selection; clicking it again toggles back On.
  m.playerActions.selectAudioTrackOption(null, deps);
  assert.equal(m.usePlayerStore.getState().muted, true);
  m.playerActions.selectAudioTrackOption(null, deps);
  assert.equal(m.usePlayerStore.getState().muted, false);
  assert.equal(
    m.usePlayerStore.getState().tracks.find((t) => t.type === "audio" && t.selected)?.id,
    2,
  );
});

test("Loop Current Video rewinds and replays immediately if enabled while paused at EOF", async () => {
  const m = await loadTestModules();
  resetStores(m);

  const player = m.usePlayerStore.getState();
  player.setLoaded(true);
  player.setDurationSecs(120);
  player.setPositionSecs(120);
  player.setPaused(true);
  player.setEndedAtEof(true);

  const loopCalls: boolean[] = [];
  const seekCalls: number[] = [];
  const pauseCalls: boolean[] = [];
  const deps = {
    mpvSetLoop: async (looping: boolean) => {
      loopCalls.push(looping);
    },
    mpvSeek: async (secs: number) => {
      seekCalls.push(secs);
    },
    mpvSetPause: async (paused: boolean) => {
      pauseCalls.push(paused);
    },
  };

  m.playerActions.toggleLoopPlayback(deps);
  const afterEnable = m.usePlayerStore.getState();
  assert.equal(afterEnable.looping, true);
  assert.equal(afterEnable.endedAtEof, false);
  assert.equal(afterEnable.paused, false);
  assert.equal(afterEnable.positionSecs, 0);
  assert.deepEqual(loopCalls, [true]);
  assert.deepEqual(seekCalls, [0]);
  assert.deepEqual(pauseCalls, [false]);

  // Turning loop off mid-playback does not rewind or pause.
  afterEnable.setPositionSecs(42);
  m.playerActions.toggleLoopPlayback(deps);
  assert.equal(m.usePlayerStore.getState().looping, false);
  assert.equal(m.usePlayerStore.getState().positionSecs, 42);
  assert.deepEqual(loopCalls, [true, false]);
  assert.deepEqual(seekCalls, [0]);
});

test("Loop Current Video respects Watch Party controller lock, readiness, and EOF loop restart", async () => {
  const m = await loadTestModules();
  resetStores(m);

  const sync = m.useSyncStore.getState();
  sync.setStatus({ state: "connected", endpoint: "wss://sync", tls: true, username: "Alice" });

  const player = m.usePlayerStore.getState();
  player.setLoaded(true);
  player.setDurationSecs(90);
  player.setPositionSecs(90);
  player.setPaused(true);
  player.setEndedAtEof(true);

  const loopCalls: boolean[] = [];
  const seekCalls: number[] = [];
  const pauseCalls: boolean[] = [];
  const syncSeeks: number[] = [];
  const syncPlays: number[] = [];
  const deps = {
    mpvSetLoop: async (looping: boolean) => {
      loopCalls.push(looping);
    },
    mpvSeek: async (secs: number) => {
      seekCalls.push(secs);
    },
    mpvSetPause: async (paused: boolean) => {
      pauseCalls.push(paused);
    },
    syncUserSeek: async (pos: number) => {
      syncSeeks.push(pos);
    },
    syncUserPlay: async (pos: number) => {
      syncPlays.push(pos);
    },
  };

  // Managed room where Bob is controller: Alice cannot toggle loop.
  sync.setParticipants([
    makeParticipant({ username: "Alice", isController: false }),
    makeParticipant({ username: "Bob", isController: true }),
  ]);
  m.playerActions.toggleLoopPlayback(deps);
  assert.equal(m.usePlayerStore.getState().looping, false);
  assert.equal(loopCalls.length, 0);
  assert.equal(m.useNotificationStore.getState().items.length, 1);

  // Room without controller lock and all peers ready: enabling loop at EOF syncs seek(0) + play(0).
  sync.setParticipants([
    makeParticipant({ username: "Alice", isController: false, isReady: true }),
    makeParticipant({ username: "Bob", isController: false, isReady: true }),
  ]);
  m.playerActions.toggleLoopPlayback(deps);
  assert.equal(m.usePlayerStore.getState().looping, true);
  assert.deepEqual(syncSeeks, [0]);
  assert.deepEqual(syncPlays, [0]);

  // Simulate EOF reached while loop is ON: handleLoopPlaybackAtEof wraps cleanly without pausing.
  m.playerActions.handleLoopPlaybackAtEof(deps);
  assert.equal(m.usePlayerStore.getState().endedAtEof, false);
  assert.equal(m.usePlayerStore.getState().paused, false);
  assert.deepEqual(syncSeeks, [0, 0]);
  assert.deepEqual(syncPlays, [0, 0]);
});

test("detectAndSyncLoopWrap pushes Syncplay seek/play once when native loop wraps near EOF to 0", async () => {
  const m = await loadTestModules();
  resetStores(m);

  m.useSyncStore.getState().setStatus({
    state: "connected",
    endpoint: "wss://sync",
    tls: true,
    username: "Alice",
  });
  m.useSyncStore.getState().setParticipants([
    makeParticipant({ username: "Alice" }),
    makeParticipant({ username: "Bob" }),
  ]);

  const player = m.usePlayerStore.getState();
  player.setLoaded(true);
  player.setLooping(true);
  player.setPaused(false);
  player.setDurationSecs(60);

  const syncSeeks: number[] = [];
  const syncPlays: number[] = [];
  const deps = {
    syncUserSeek: async (pos: number) => {
      syncSeeks.push(pos);
    },
    syncUserPlay: async (pos: number) => {
      syncPlays.push(pos);
    },
  };

  // Normal progression near middle -> no wrap sync.
  let lastSync = m.playerActions.detectAndSyncLoopWrap(30, 30.25, 0, 5000, deps);
  assert.equal(lastSync, 0);
  assert.equal(syncSeeks.length, 0);

  // Wrap from 59.8s back to 0.04s triggers Syncplay reset.
  lastSync = m.playerActions.detectAndSyncLoopWrap(59.8, 0.04, 0, 10_000, deps);
  assert.equal(lastSync, 10_000);
  assert.deepEqual(syncSeeks, [0.04]);
  assert.deepEqual(syncPlays, [0.04]);

  // Within cooldown -> debounced.
  const withinCooldown = m.playerActions.detectAndSyncLoopWrap(59.8, 0.08, lastSync, 10_500, deps);
  assert.equal(withinCooldown, 10_000);
  assert.equal(syncSeeks.length, 1);
});

test("UI components wire Loop and Audio-menu Mute through shared playerActions cleanly", () => {
  const playbackPanel = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PlaybackPanel.tsx"),
    "utf8",
  );
  const transportBar = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  const shortcuts = fs.readFileSync(
    path.join(REPO_ROOT, "src/hooks/usePlayerShortcuts.ts"),
    "utf8",
  );
  const watchRoom = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );

  assert.match(playbackPanel, /Mute Audio/);
  assert.match(playbackPanel, /toggleMutePlayback\(\)/);
  assert.match(playbackPanel, /selectAudioTrackOption\(aid\)/);
  assert.match(playbackPanel, /toggleLoopPlayback\(\)/);
  assert.match(playbackPanel, /<SegmentedTabs/);

  assert.match(transportBar, /toggleMutePlayback\(\)/);
  assert.match(transportBar, /setMutePlayback\(false/);

  assert.match(shortcuts, /toggleMutePlayback\(\)/);

  assert.match(watchRoom, /mpvSetVolume\(playerNow\.volume\)/);
  assert.match(watchRoom, /mpvSetMute\(playerNow\.muted\)/);
  assert.match(watchRoom, /detectAndSyncLoopWrap/);
  assert.match(watchRoom, /handleLoopPlaybackAtEof\(\)/);
  assert.match(watchRoom, /safeMpvCall\(mpvSetLoop\(true\), "fileLoaded:mpvSetLoop"\)/);
});
