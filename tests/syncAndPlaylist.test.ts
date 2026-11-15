import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadModules<T = Record<string, any>>(entryRelPath: string): Promise<T> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-sync-test-"));
  const outFile = path.join(outDir, "bundle.mjs");
  buildSync({
    entryPoints: [path.join(REPO_ROOT, entryRelPath)],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return (await import(pathToFileURL(outFile).href)) as T;
}

test("computeRoomSyncHealth detects drift, ignores self and mismatched files, and flags error states", async () => {
  const { computeRoomSyncHealth, RESYNC_DRIFT_WARN_SECS } = await loadModules<
    typeof import("../src/lib/syncHealth")
  >("src/lib/syncHealth.ts");

  assert.equal(RESYNC_DRIFT_WARN_SECS, 2.0);

  const errHealth = computeRoomSyncHealth({
    syncStatus: {
      state: "error",
      endpoint: "syncplay.pl:8997",
      message: "Lost connection",
      suggestBackup: false,
      circuitOpen: false,
    },
    participants: [],
    localUsername: "Alice",
    localLoaded: true,
    localPositionSecs: 42,
  });
  assert.equal(errHealth.needsResync, true);
  assert.equal(errHealth.statusLabel, "Reconnect");

  const reconnectingHealth = computeRoomSyncHealth({
    syncStatus: {
      state: "reconnecting",
      endpoint: "syncplay.pl:8997",
      attempt: 2,
      retryInSecs: 3,
      suggestBackup: false,
    },
    participants: [],
    localUsername: "Alice",
    localLoaded: true,
    localPositionSecs: 42,
  });
  assert.equal(reconnectingHealth.needsResync, true);
  assert.equal(reconnectingHealth.statusLabel, "Reconnecting…");

  const connectedStatus = {
    state: "connected" as const,
    endpoint: "syncplay.pl:8997",
    tls: true,
    username: "Alice",
  };

  // Matched peer within threshold + mismatched peer far away -> still In sync (mismatch ignored for drift)
  const healthy = computeRoomSyncHealth({
    syncStatus: connectedStatus,
    participants: [
      {
        username: "alice",
        room: "party",
        position: 999,
        fileName: "Show.S01E01.mkv",
        isReady: true,
        isController: false,
        fileMatch: "matched",
      },
      {
        username: "Bob",
        room: "party",
        position: 101.2,
        fileName: "Show.S01E01.mkv",
        isReady: true,
        isController: true,
        fileMatch: "matched",
      },
      {
        username: "Charlie",
        room: "party",
        position: 400,
        fileName: "OtherMovie.mp4",
        isReady: false,
        isController: false,
        fileMatch: "differentFile",
      },
    ],
    localUsername: "Alice",
    localLoaded: true,
    localPositionSecs: 100.0,
  });
  assert.equal(healthy.needsResync, false);
  assert.ok(Math.abs(healthy.maxDriftSecs - 1.2) < 1e-6);
  assert.equal(healthy.statusLabel, "In sync");
  assert.equal(healthy.peerCount, 3);

  // Peer drifted >= 2.0s triggers needsResync + Drift label
  const drifted = computeRoomSyncHealth({
    syncStatus: connectedStatus,
    participants: [
      {
        username: "Bob",
        room: "party",
        position: 104.5,
        fileName: "Show.S01E01.mp4",
        isReady: true,
        isController: false,
        fileMatch: "sameLengthDifferentEncode",
      },
    ],
    localUsername: "Alice",
    localLoaded: true,
    localPositionSecs: 100.0,
  });
  assert.equal(drifted.needsResync, true);
  assert.ok(Math.abs(drifted.maxDriftSecs - 4.5) < 1e-6);
  assert.equal(drifted.statusLabel, "Drift 4.5s");
});

test("playlist parsing, natural season sorting, subtitle pairing, and cross-encode peer matching", async () => {
  const mod = await loadModules<typeof import("../src/lib/playlist")>("src/lib/playlist.ts");

  assert.deepEqual(mod.parseEpisodeCode("Severance.S02E09.1080p.WEB.mkv"), {
    season: 2,
    episode: 9,
  });
  assert.deepEqual(mod.parseEpisodeCode("Show.1x04.HDTV.mp4"), {
    season: 1,
    episode: 4,
  });
  assert.equal(mod.parseEpisodeCode("Vacation_1920x1080_cut.mp4"), null);
  assert.deepEqual(mod.parseEpisodeCode("[SubGroup] Frieren - 12 [1080p].mkv"), {
    season: null,
    episode: 12,
  });

  assert.equal(mod.formatEpisodeBadge({ season: 1, episode: 3 }), "S01E03");
  assert.equal(mod.formatEpisodeBadge({ season: null, episode: 7 }), "EP 07");
  assert.equal(mod.cleanEpisodeTitle("[Group]_Dark.S01E02.Lies.mkv"), "Dark S01E02 Lies");

  const sorted = ["Ep10.mkv", "Ep2.mkv", "Ep1.mkv"].sort(mod.naturalCompare);
  assert.deepEqual(sorted, ["Ep1.mkv", "Ep2.mkv", "Ep10.mkv"]);

  const scan = mod.buildClientPlaylistFromPaths([
    "D:\\Shows\\Season 1\\Show.S01E10.Finale.mkv",
    "D:\\Shows\\Season 1\\Show.S01E02.Pilot2.mkv",
    "D:\\Shows\\Season 1\\Show.S01E01.Pilot.mkv",
    "D:\\Shows\\Season 1\\Show.S01E02.Pilot2.srt",
    "D:\\Shows\\Season 1\\Subs\\Show.S01E10.Finale.en.ass",
  ]);
  assert.equal(scan.items.length, 3);
  assert.deepEqual(
    scan.items.map((it) => it.episodeBadge),
    ["S01E01", "S01E02", "S01E10"],
  );
  assert.equal(scan.items[0].subtitlePath, null);
  assert.equal(scan.items[1].subtitlePath, "D:\\Shows\\Season 1\\Show.S01E02.Pilot2.srt");
  assert.equal(
    scan.items[2].subtitlePath,
    "D:\\Shows\\Season 1\\Subs\\Show.S01E10.Finale.en.ass",
  );

  // Match peer file by exact name, different container stem, hashed 12-hex ID, or episode code
  assert.equal(mod.matchPeerEpisodeInPlaylist("Show.S01E02.Pilot2.mkv", scan.items), 1);
  assert.equal(mod.matchPeerEpisodeInPlaylist("Show.S01E02.Pilot2.mp4", scan.items), 1);

  const hashE10 = mod.hashFilenameForMatch("Show.S01E10.Finale.mkv");
  assert.match(hashE10, /^[a-f0-9]{12}$/);
  assert.equal(mod.matchPeerEpisodeInPlaylist(hashE10, scan.items), 2);

  assert.equal(
    mod.matchPeerEpisodeInPlaylist("AnotherRelease.S01E10.2160p.WEB-DL.mkv", scan.items),
    2,
  );
  assert.equal(mod.matchPeerEpisodeInPlaylist("Show.S02E01.mkv", scan.items), -1);
});

test("usePlaylistStore manages active episode, preferences, and clearing", async () => {
  const { buildClientPlaylistFromPaths } = await loadModules<
    typeof import("../src/lib/playlist")
  >("src/lib/playlist.ts");
  const { usePlaylistStore } = await loadModules<
    typeof import("../src/store/usePlaylistStore")
  >("src/store/usePlaylistStore.ts");

  const scan = buildClientPlaylistFromPaths([
    "/shows/Ep.S01E01.mkv",
    "/shows/Ep.S01E02.mkv",
    "/shows/Ep.S01E03.mkv",
  ]);

  const store = usePlaylistStore.getState();
  store.setPlaylist(scan.items, 1, "Season 1");
  assert.equal(usePlaylistStore.getState().currentIndex, 1);
  assert.equal(usePlaylistStore.getState().folderName, "Season 1");

  usePlaylistStore.getState().setCurrentIndex(99);
  assert.equal(usePlaylistStore.getState().currentIndex, 2);

  usePlaylistStore.getState().selectByPath("/SHOWS/ep.s01e01.mkv");
  assert.equal(usePlaylistStore.getState().currentIndex, 0);

  usePlaylistStore.getState().setAutoPlayNext(false);
  usePlaylistStore.getState().setFollowPartyEpisode(false);
  assert.equal(usePlaylistStore.getState().autoPlayNext, false);
  assert.equal(usePlaylistStore.getState().followPartyEpisode, false);

  usePlaylistStore.getState().clearPlaylist();
  assert.equal(usePlaylistStore.getState().items.length, 0);
  assert.equal(usePlaylistStore.getState().currentIndex, -1);
  assert.equal(usePlaylistStore.getState().folderName, null);
});
