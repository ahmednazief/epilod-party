import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadBundle() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-source-align-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * as sourceAlignment from "./src/lib/sourceAlignment.ts";
          export * as syncHealth from "./src/lib/syncHealth.ts";
          export * as syncSpeedGuard from "./src/lib/syncSpeedGuard.ts";
          export * as playlist from "./src/lib/playlist.ts";
          export * as playerActions from "./src/lib/playerActions.ts";
          export { useAppStore } from "./src/store/useAppStore.ts";
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
      sourceAlignment: typeof import("../src/lib/sourceAlignment");
      syncHealth: typeof import("../src/lib/syncHealth");
      syncSpeedGuard: typeof import("../src/lib/syncSpeedGuard");
      playlist: typeof import("../src/lib/playlist");
      playerActions: typeof import("../src/lib/playerActions");
      useAppStore: typeof import("../src/store/useAppStore")["useAppStore"];
      usePlayerStore: typeof import("../src/store/usePlayerStore")["usePlayerStore"];
      useSyncStore: typeof import("../src/store/useSyncStore")["useSyncStore"];
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("sourceAlignment converts timelines, snaps two-point FPS fits, and persists per file pair", async () => {
  const { sourceAlignment } = await loadBundle();
  const palScale = (24000 / 1001) / 25;

  const localPos = sourceAlignment.roomToLocalSecs(1000, 6.5, palScale);
  assert.ok(Math.abs(localPos - (1000 * palScale + 6.5)) < 1e-6);
  assert.ok(Math.abs(sourceAlignment.localToRoomSecs(localPos, 6.5, palScale) - 1000) < 1e-6);

  assert.equal(sourceAlignment.formatSignedOffset(0.01), "0.0s");
  assert.equal(sourceAlignment.formatSignedOffset(6.5), "+6.5s");
  assert.equal(sourceAlignment.formatSignedOffset(-75.2), "−1m 15.2s");

  const fit = sourceAlignment.fitTwoPointAlignment(
    { roomSecs: 60, localSecs: 60 * palScale + 8.0 },
    { roomSecs: 1860, localSecs: 1860 * palScale + 8.2 },
  );
  assert.ok(fit);
  assert.ok(Math.abs(fit.scale - palScale) < 1e-9);
  assert.ok(Math.abs(fit.offsetSecs - 8.1) < 0.05);

  const mem = new Map<string, string>();
  const prevStorage = (globalThis as Record<string, unknown>).localStorage;
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => mem.set(k, v),
  };

  try {
    const key = sourceAlignment.buildAlignmentPairKey(
      "Movie.BluRay.mkv",
      5408.2,
      "Movie.WEBRip.mp4",
      5400.1,
    );
    assert.ok(key);
    sourceAlignment.saveSourceAlignment(key, { offsetSecs: 8.1, scale: palScale });
    const loaded = sourceAlignment.loadSavedSourceAlignment(key);
    assert.ok(loaded);
    assert.ok(Math.abs(loaded.offsetSecs - 8.1) < 1e-6);
    assert.ok(Math.abs(loaded.scale - palScale) < 1e-6);

    sourceAlignment.saveSourceAlignment(key, { offsetSecs: 0, scale: 1.0 });
    assert.equal(sourceAlignment.loadSavedSourceAlignment(key), null);
  } finally {
    if (prevStorage === undefined) {
      delete (globalThis as Record<string, unknown>).localStorage;
    } else {
      (globalThis as Record<string, unknown>).localStorage = prevStorage;
    }
  }
});

test("computeRoomSyncHealth maps offset/FPS-scaled local position to room time and tracks aligned sources", async () => {
  const { syncHealth, syncSpeedGuard } = await loadBundle();
  const palScale = (24000 / 1001) / 25;

  // Local file has +8.0s extra intro and runs at 25fps while peer runs at 23.976fps
  const localPosAtRoom1000 = 1000 * palScale + 8.0;
  const alignedHealth = syncHealth.computeRoomSyncHealth({
    syncStatus: { state: "connected", endpoint: "syncplay.pl:8999", tls: true, username: "Bob" },
    participants: [
      {
        username: "Alice",
        room: "r",
        position: 1000.4,
        fileName: "Movie.BluRay.mkv",
        fileDuration: 5400,
        isReady: true,
        isController: true,
        fileMatch: "durationMismatch",
        sourceRelation: "fpsMismatch",
      },
    ],
    localUsername: "Bob",
    localLoaded: true,
    localPositionSecs: localPosAtRoom1000,
    timelineOffsetSecs: 8.0,
    timelineScale: palScale,
  });
  assert.equal(alignedHealth.needsResync, false);
  assert.equal(alignedHealth.statusLabel, "In sync");

  assert.equal(syncSpeedGuard.canChangePlaybackSpeed(true, palScale, palScale), true);
  assert.equal(syncSpeedGuard.canChangePlaybackSpeed(true, 1.5, palScale), false);
  assert.equal(syncSpeedGuard.shouldResetSpeedForSync(true, palScale, palScale), false);
  assert.equal(syncSpeedGuard.shouldResetSpeedForSync(true, 1.0, palScale), true);
});

test("matchPeerEpisodeInPlaylist matches across WEBRip .mp4 and BluRay .mkv movie titles", async () => {
  const { playlist } = await loadBundle();
  const scan = playlist.buildClientPlaylistFromPaths([
    "D:\\Movies\\Arrival.2016.1080p.BluRay.mkv",
    "D:\\Movies\\Dune.Part.Two.2024.1080p.BluRay.x265.mkv",
  ]);
  assert.equal(
    playlist.matchPeerEpisodeInPlaylist("Dune Part Two (2024) [WEBRip] [720p].mp4", scan.items),
    1,
  );
});

test("alignMode allows local play/pause/seek without broadcasting or triggering controller lock", async () => {
  const { playerActions, useAppStore, usePlayerStore, useSyncStore } = await loadBundle();
  const calls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        return undefined;
      },
    },
  };

  try {
    useAppStore.getState().setUsername("Guest");
    usePlayerStore.getState().reset();
    useSyncStore.getState().reset();

    usePlayerStore.getState().setLoaded(true);
    usePlayerStore.getState().setPaused(true);
    usePlayerStore.getState().setPositionSecs(50);
    usePlayerStore.getState().setDurationSecs(1440);
    useSyncStore.getState().setStatus({
      state: "connected",
      endpoint: "syncplay.pl:8999",
      tls: true,
      username: "Guest",
    });
    useSyncStore.getState().setParticipants([
      {
        username: "Host",
        room: "r",
        position: 50,
        fileName: "Movie.WEBRip.mp4",
        isReady: false,
        isController: true,
        fileMatch: "durationMismatch",
        sourceRelation: "differentCut",
      },
      {
        username: "Guest",
        room: "r",
        position: 50,
        fileName: "Movie.BluRay.mkv",
        isReady: true,
        isController: false,
        fileMatch: "matched",
      },
    ]);
    useSyncStore.getState().setAlignMode(true);

    playerActions.seekPlaybackRelative(10);
    playerActions.togglePlayback({ showFeedback: true });
    await Promise.resolve();

    assert.equal(usePlayerStore.getState().positionSecs, 60);
    assert.equal(usePlayerStore.getState().paused, false);
    assert.ok(calls.some((c) => c.cmd === "mpv_seek"));
    assert.ok(calls.some((c) => c.cmd === "mpv_set_pause"));
    assert.equal(
      calls.some((c) => c.cmd.startsWith("sync_user_")),
      false,
      "alignMode must not broadcast seeks/play/pause to Syncplay",
    );
  } finally {
    usePlayerStore.getState().clearFeedback();
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});

test("piecewise timelineSegments map local cut positions to room time and reset cleanly", async () => {
  const { sourceAlignment, syncHealth, useSyncStore } = await loadBundle();
  const segments = [
    { roomStartSecs: 0, offsetSecs: 5, scale: 1 },
    { roomStartSecs: 1000, offsetSecs: 65, scale: 1 },
  ];
  assert.ok(Math.abs(sourceAlignment.localToRoomSecs(505, 5, 1, segments) - 500) < 1e-6);
  assert.ok(Math.abs(sourceAlignment.localToRoomSecs(1265, 5, 1, segments) - 1200) < 1e-6);

  const health = syncHealth.computeRoomSyncHealth({
    syncStatus: { state: "connected", endpoint: "syncplay.pl:8999", tls: true, username: "Bob" },
    participants: [
      {
        username: "Alice",
        room: "r",
        position: 1200,
        fileName: "Movie.Theatrical.mp4",
        fileDuration: 5000,
        isReady: true,
        isController: false,
        fileMatch: "durationMismatch",
        sourceRelation: "differentCut",
      },
    ],
    localUsername: "Bob",
    localLoaded: true,
    localPositionSecs: 1265.2,
    timelineOffsetSecs: 5,
    timelineScale: 1,
    timelineSegments: segments,
  });
  assert.equal(health.needsResync, false);
  assert.equal(health.statusLabel, "In sync");

  useSyncStore.getState().reset();
  useSyncStore.getState().setTimelineSegments(segments);
  useSyncStore.getState().setP2pStatus({
    natMode: "cone",
    peers: [{ username: "Alice", transport: "directWan", rttMs: 28, autoAlignState: "alignedPiecewise" }],
  });
  assert.equal(useSyncStore.getState().timelineSegments.length, 2);
  assert.equal(useSyncStore.getState().p2pStatus?.peers[0]?.transport, "directWan");
  useSyncStore.getState().resetTimelineAlignment();
  assert.equal(useSyncStore.getState().timelineSegments.length, 0);
});
