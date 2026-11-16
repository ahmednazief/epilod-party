import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type { PlaylistItem } from "../src/lib/playlist";
import type { Participant } from "../src/lib/syncplay";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadBundle() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-autonext-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * as autoNext from "./src/lib/autoNext.ts";
          export * as playlist from "./src/lib/playlist.ts";
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
      autoNext: typeof import("../src/lib/autoNext");
      playlist: typeof import("../src/lib/playlist");
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function ep(index: number, fileName: string, badge: string): PlaylistItem {
  return {
    path: `D:\\Shows\\Series\\${fileName}`,
    fileName,
    cleanTitle: fileName.replace(/\.[^.]+$/, ""),
    season: 1,
    episode: index + 1,
    episodeBadge: badge,
    subtitlePath: null,
  };
}

function peer(overrides: Partial<Participant> & { username: string }): Participant {
  return {
    room: "123456",
    position: 0,
    fileName: null,
    fileDuration: null,
    isReady: true,
    isController: false,
    fileMatch: "matched",
    ...overrides,
  };
}

test("canTriggerAutoNextOnEof deduplicates EOF events, guards loadInFlight, and respects controller lock", async () => {
  const { autoNext } = await loadBundle();

  assert.deepEqual(
    autoNext.canTriggerAutoNextOnEof({
      autoPlayNext: true,
      currentIndex: 0,
      itemsLength: 3,
      loadInFlight: false,
      eofHandledForGen: -1,
      currentLoadGen: 1,
      lockedForLocalUser: false,
    }),
    { advance: true, nextIndex: 1 },
  );

  // Duplicate EOF for the exact same file generation must NOT double-skip Ep 2 -> Ep 3
  assert.deepEqual(
    autoNext.canTriggerAutoNextOnEof({
      autoPlayNext: true,
      currentIndex: 1,
      itemsLength: 3,
      loadInFlight: false,
      eofHandledForGen: 1,
      currentLoadGen: 1,
      lockedForLocalUser: false,
    }),
    { advance: false, nextIndex: null },
  );

  // In-flight load must suppress concurrent EOF triggers
  assert.deepEqual(
    autoNext.canTriggerAutoNextOnEof({
      autoPlayNext: true,
      currentIndex: 1,
      itemsLength: 3,
      loadInFlight: true,
      eofHandledForGen: -1,
      currentLoadGen: 2,
      lockedForLocalUser: false,
    }),
    { advance: false, nextIndex: null },
  );

  // Non-controller guest at EOF stays put cleanly until controller switches episodes
  assert.deepEqual(
    autoNext.canTriggerAutoNextOnEof({
      autoPlayNext: true,
      currentIndex: 0,
      itemsLength: 3,
      loadInFlight: false,
      eofHandledForGen: -1,
      currentLoadGen: 1,
      lockedForLocalUser: true,
    }),
    { advance: false, nextIndex: null },
  );

  // Last episode never advances past bounds
  assert.deepEqual(
    autoNext.canTriggerAutoNextOnEof({
      autoPlayNext: true,
      currentIndex: 2,
      itemsLength: 3,
      loadInFlight: false,
      eofHandledForGen: -1,
      currentLoadGen: 3,
      lockedForLocalUser: false,
    }),
    { advance: false, nextIndex: null },
  );
});

test("resolveEpisodeLoadSyncPlan resets room playhead when first to reach Ep 2 and joins live peer if already on Ep 2", async () => {
  const { autoNext, playlist } = await loadBundle();
  const items = [
    ep(0, "Frieren.S01E01.1080p.mkv", "S01E01"),
    ep(1, "Frieren.S01E02.1080p.mkv", "S01E02"),
  ];

  assert.equal(
    autoNext.peerMatchesTargetEpisode("Frieren.S01E01.mkv", "Frieren.S01E02.1080p.mkv", items[1].path, items),
    false,
  );
  assert.equal(
    autoNext.peerMatchesTargetEpisode("Frieren.S01E02.720p.mp4", "Frieren.S01E02.1080p.mkv", items[1].path, items),
    true,
  );
  assert.equal(
    autoNext.peerMatchesTargetEpisode(
      playlist.hashFilenameForMatch("Frieren.S01E02.1080p.mkv"),
      "Frieren.S01E02.1080p.mkv",
      items[1].path,
      items,
    ),
    true,
  );

  // Friend is STILL on Ep 1 (24:00) while Alice auto-nexts to Ep 2 -> reset room to 0:00 and play
  const firstToEp2 = autoNext.resolveEpisodeLoadSyncPlan({
    roomCode: "123456",
    syncConnected: true,
    syncReconnectingOrError: false,
    lockedForLocalUser: false,
    participants: [
      peer({ username: "Alice", fileName: "Frieren.S01E02.1080p.mkv" }),
      peer({ username: "Bob", fileName: "Frieren.S01E01.mkv", position: 1439.5, isReady: true }),
    ],
    localUsername: "Alice",
    targetFileName: "Frieren.S01E02.1080p.mkv",
    targetPath: items[1].path,
    playlistItems: items,
    trigger: "autoNext",
    wasPlayingBeforeLoad: true,
    manuallyNotReadyBlocked: false,
  });
  assert.equal(firstToEp2.compatiblePeerCount, 0);
  assert.equal(firstToEp2.shouldResetRoomToZero, true);
  assert.equal(firstToEp2.shouldAutoPlay, true);

  // Friend Bob marked Not Ready -> reset room to 0:00 cleanly paused
  const notReadyPause = autoNext.resolveEpisodeLoadSyncPlan({
    roomCode: "123456",
    syncConnected: true,
    syncReconnectingOrError: false,
    lockedForLocalUser: false,
    participants: [
      peer({ username: "Bob", fileName: "Frieren.S01E01.mkv", isReady: false }),
    ],
    localUsername: "Alice",
    targetFileName: "Frieren.S01E02.1080p.mkv",
    targetPath: items[1].path,
    playlistItems: items,
    trigger: "autoNext",
    wasPlayingBeforeLoad: true,
    manuallyNotReadyBlocked: true,
  });
  assert.equal(notReadyPause.shouldResetRoomToZero, true);
  assert.equal(notReadyPause.shouldAutoPlay, false);
  assert.equal(notReadyPause.shouldSendPauseToRoom, true);

  // Friend Alice ALREADY switched to Ep 2 -> Bob follows to Ep 2 without resetting Alice to 0:00
  const secondToEp2 = autoNext.resolveEpisodeLoadSyncPlan({
    roomCode: "123456",
    syncConnected: true,
    syncReconnectingOrError: false,
    lockedForLocalUser: false,
    participants: [
      peer({ username: "Alice", fileName: "Frieren.S01E02.mkv", position: 2.5, isReady: true }),
    ],
    localUsername: "Bob",
    targetFileName: "Frieren.S01E02.1080p.mkv",
    targetPath: items[1].path,
    playlistItems: items,
    trigger: "follow",
    wasPlayingBeforeLoad: true,
  });
  assert.equal(secondToEp2.compatiblePeerCount, 1);
  assert.equal(secondToEp2.shouldResetRoomToZero, false);
  assert.equal(secondToEp2.shouldAutoPlay, false);
});

test("resolveFollowPartyEpisode avoids mid-load interruptions and prevents bouncing back to previous episode", async () => {
  const { autoNext } = await loadBundle();
  const items = [
    ep(0, "Frieren.S01E01.mkv", "S01E01"),
    ep(1, "Frieren.S01E02.mkv", "S01E02"),
  ];

  // Follows controller cleanly to Ep 2
  const follow = autoNext.resolveFollowPartyEpisode({
    syncConnected: true,
    followPartyEpisode: true,
    participants: [
      peer({ username: "Host", isController: true, fileName: "Frieren.S01E02.mkv" }),
    ],
    localUsername: "Guest",
    playlistItems: items,
    playlistIndex: 0,
    loadInFlight: false,
    previousPeerFile: "Frieren.S01E01.mkv",
    justAdvancedFromPath: null,
  });
  assert.equal(follow.action, "follow");
  if (follow.action === "follow") {
    assert.equal(follow.targetIndex, 1);
  }

  // While loadInFlight, defer without dropping previousPeerFile
  const midLoad = autoNext.resolveFollowPartyEpisode({
    syncConnected: true,
    followPartyEpisode: true,
    participants: [
      peer({ username: "Host", isController: true, fileName: "Frieren.S01E02.mkv" }),
    ],
    localUsername: "Guest",
    playlistItems: items,
    playlistIndex: 0,
    loadInFlight: true,
    previousPeerFile: "Frieren.S01E01.mkv",
    justAdvancedFromPath: null,
  });
  assert.equal(midLoad.action, "noop");
  assert.equal(midLoad.nextPeerFile, "Frieren.S01E01.mkv");

  // If peer file list fluctuates after we just auto-nexted Ep 1 -> Ep 2, don't pull back to Ep 1
  const noBounceBack = autoNext.resolveFollowPartyEpisode({
    syncConnected: true,
    followPartyEpisode: true,
    participants: [
      peer({ username: "Host", fileName: "Frieren.S01E01.mkv" }),
    ],
    localUsername: "Me",
    playlistItems: items,
    playlistIndex: 1,
    loadInFlight: false,
    previousPeerFile: null,
    justAdvancedFromPath: items[0].path,
  });
  assert.equal(noBounceBack.action, "noop");
});

test("mpv IPC, SyncStateMachine, and WatchRoom uphold auto-next loading and sync invariants", () => {
  const ipcRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/mpv/ipc.rs"), "utf8");
  assert.equal(
    ipcRs.includes('reason.as_deref() != Some("replace")'),
    false,
    'ipc.rs must not clear loading_media on end-file reason: "stop"',
  );
  assert.equal(ipcRs.includes("eof_emitted"), true);
  assert.equal(ipcRs.includes("deferred_load.lock()"), true);

  const coreSyncRs = fs.readFileSync(
    path.join(REPO_ROOT, "crates/epilod-core/src/syncplay.rs"),
    "utf8",
  );
  const resetMatch =
    coreSyncRs.match(/pub fn reset_for_new_file\(&mut self\)[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.ok(resetMatch.includes("self.last_server_playstate = None;"));
  assert.ok(resetMatch.includes("self.last_server_state_at = None;"));

  const syncModRs = fs.readFileSync(
    path.join(REPO_ROOT, "src-tauri/src/syncplay/mod.rs"),
    "utf8",
  );
  assert.equal(syncModRs.includes("summarize_peer_compatibility"), true);
  assert.equal(syncModRs.includes("seed_server_playstate_from_compatible_peer_if_missing"), true);
  assert.equal(syncModRs.includes("all_peers_incompatible"), true);

  const watchRoomSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  assert.equal(watchRoomSrc.includes("canTriggerAutoNextOnEof"), true);
  assert.equal(watchRoomSrc.includes("resolveEpisodeLoadSyncPlan"), true);
  assert.equal(watchRoomSrc.includes("resolveFollowPartyEpisode"), true);
  assert.equal(watchRoomSrc.includes("switchToPartyEpisode(decision.targetIndex"), true);
});
