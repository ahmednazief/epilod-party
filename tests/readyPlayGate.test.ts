import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type { Participant, SyncStatusPayload } from "../src/lib/syncplay";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadSharedActionsHarness() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-ready-gate-"));
  const outFile = path.join(outDir, "harness.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * as syncReady from "./src/lib/syncReady.ts";
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
      syncReady: typeof import("../src/lib/syncReady");
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

function makePeer(username: string, isReady: boolean, isController = false): Participant {
  return {
    username,
    room: "ep-123456",
    position: 0,
    fileName: "Movie.mkv",
    fileDuration: 5400,
    isReady,
    isController,
    fileMatch: "matched",
  };
}

const CONNECTED_ALICE: SyncStatusPayload = {
  state: "connected",
  endpoint: "syncplay.pl:8999",
  tls: true,
  username: "Alice",
};

test("syncReady play-gate helpers format peer names and block status accurately", async () => {
  const { syncReady } = await loadSharedActionsHarness();

  assert.equal(syncReady.formatNotReadyNames(["Bob"]), "Bob");
  assert.equal(syncReady.formatNotReadyNames(["Bob", "bob", "Charlie"]), "Bob and Charlie");
  assert.equal(
    syncReady.formatNotReadyNames(["Bob", "Charlie", "Dana"]),
    "Bob, Charlie, and Dana",
  );
  assert.equal(
    syncReady.formatNotReadyNames(["Bob", "Charlie", "Dana", "Eve"]),
    "Bob, Charlie, and 2 others",
  );
  assert.equal(syncReady.formatPeerNotReadyNotice("Bob"), "Bob is not ready.");
  assert.equal(
    syncReady.formatPlayBlockedByNotReadyMessage(["Bob"]),
    "Cannot play — Bob is not ready.",
  );
  assert.equal(
    syncReady.formatPlayBlockedByNotReadyMessage(["Bob", "Charlie"]),
    "Cannot play — Bob and Charlie are not ready.",
  );
  assert.equal(
    syncReady.formatWaitingForNotReadyPill(["Bob"]),
    "Waiting · Bob is not ready",
  );

  // Disconnected never blocks
  assert.deepEqual(
    syncReady.getPlayBlockState({
      syncConnected: false,
      participants: [makePeer("Alice", true), makePeer("Bob", false)],
      localUsername: "Alice",
    }),
    { blocked: false, notReadyUsernames: [], message: null, feedback: null },
  );

  // Only self not ready does not block local user from pressing Play
  assert.deepEqual(
    syncReady.getPlayBlockState({
      syncConnected: true,
      participants: [makePeer("alice", false), makePeer("Bob", true)],
      localUsername: "Alice",
    }),
    { blocked: false, notReadyUsernames: [], message: null, feedback: null },
  );

  // Other peer not ready blocks playback with peer's name
  const blocked = syncReady.getPlayBlockState({
    syncConnected: true,
    participants: [makePeer("Alice", true), makePeer("Bob", false)],
    localUsername: "alice",
  });
  assert.equal(blocked.blocked, true);
  assert.deepEqual(blocked.notReadyUsernames, ["Bob"]);
  assert.equal(blocked.message, "Cannot play — Bob is not ready.");
  assert.equal(blocked.feedback, "Bob is not ready");
});

test("useNotificationStore deduplicates tagged notices and clears them by tag or prefix", async () => {
  const { syncReady, useNotificationStore } = await loadSharedActionsHarness();
  const store = useNotificationStore.getState();
  store.clearAll();

  const id1 = store.push("warn", "Cannot play — Bob is not ready.", 0, syncReady.PLAY_BLOCKED_TAG);
  const id2 = store.push("warn", "Cannot play — Bob is not ready.", 0, syncReady.PLAY_BLOCKED_TAG);
  assert.equal(id1, id2);
  assert.equal(useNotificationStore.getState().items.length, 1);

  store.push("warn", "Bob is not ready.", 0, syncReady.peerNotReadyTag("Bob"));
  store.push("info", "Subtitles loaded", 0);
  assert.equal(useNotificationStore.getState().items.length, 3);

  store.dismissByTag(syncReady.peerNotReadyTag("Bob"));
  assert.deepEqual(
    useNotificationStore.getState().items.map((i) => i.message),
    ["Cannot play — Bob is not ready.", "Subtitles loaded"],
  );

  store.dismissByTagPrefix(syncReady.NOT_READY_TAG_PREFIX);
  assert.deepEqual(
    useNotificationStore.getState().items.map((i) => i.message),
    ["Subtitles loaded"],
  );
  store.clearAll();
});

test("togglePlayback blocks play with peer name when someone is Not Ready, allows pause, and unblocks once Ready", async () => {
  const { playerActions, syncReady, useAppStore, useNotificationStore, usePlayerStore, useSyncStore } =
    await loadSharedActionsHarness();

  useNotificationStore.getState().clearAll();
  usePlayerStore.getState().reset();
  useSyncStore.getState().reset();

  useAppStore.getState().setUsername("Alice");
  useAppStore.getState().enterRoom("123456");
  usePlayerStore.getState().setLoaded(true);
  usePlayerStore.getState().setPaused(true);
  useSyncStore.getState().setStatus(CONNECTED_ALICE);
  useSyncStore.getState().setLocalReady(false);
  useSyncStore.getState().setParticipants([
    makePeer("Alice", false),
    makePeer("Bob", false),
  ]);

  // Alice tries to play while Bob is Not Ready -> blocked, stays paused, shows Bob's name
  playerActions.togglePlayback({ showFeedback: true });
  assert.equal(usePlayerStore.getState().paused, true);
  assert.equal(useSyncStore.getState().localReady, false);
  assert.equal(usePlayerStore.getState().feedback?.text, "Bob is not ready");
  assert.deepEqual(
    useNotificationStore.getState().items.map((i) => ({ message: i.message, tag: i.tag })),
    [{ message: "Cannot play — Bob is not ready.", tag: syncReady.PLAY_BLOCKED_TAG }],
  );

  // If currently playing while Bob becomes not ready, Alice can still pause
  usePlayerStore.getState().setPaused(false);
  playerActions.togglePlayback();
  assert.equal(usePlayerStore.getState().paused, true);

  // Once Bob is Ready, Alice pressing Play succeeds and marks Alice Ready
  useSyncStore.getState().setParticipants([
    makePeer("Alice", false),
    makePeer("Bob", true),
  ]);
  playerActions.togglePlayback({ showFeedback: true });
  assert.equal(usePlayerStore.getState().paused, false);
  assert.equal(useSyncStore.getState().localReady, true);

  // Marking Not Ready while playing immediately pauses playback
  playerActions.toggleReadyStatus();
  assert.equal(useSyncStore.getState().localReady, false);
  assert.equal(usePlayerStore.getState().paused, true);
  assert.equal(usePlayerStore.getState().feedback?.text, "Paused · Not Ready");

  // Leaving room clears any not-ready notifications
  useNotificationStore
    .getState()
    .push("warn", "Bob is not ready.", 0, syncReady.peerNotReadyTag("Bob"));
  useAppStore.getState().leaveRoom();
  assert.equal(
    useNotificationStore
      .getState()
      .items.some((i) => i.tag?.startsWith(syncReady.NOT_READY_TAG_PREFIX)),
    false,
  );
  useNotificationStore.getState().clearAll();
  usePlayerStore.getState().clearFeedback();
});

test("UI components wire unified play-block & peer-not-ready handlers cleanly", () => {
  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8",
  );
  const shortcutsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/hooks/usePlayerShortcuts.ts"),
    "utf8",
  );
  const watchRoomSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  const roomPanelSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/RoomPanel.tsx"),
    "utf8",
  );

  assert.equal(transportSrc.includes("togglePlayback()"), true);
  assert.equal(transportSrc.includes("toggleReadyStatus()"), true);
  assert.equal(transportSrc.includes("formatWaitingForNotReadyPill"), true);
  assert.equal(transportSrc.includes(" · Not Ready"), true);
  // Play button must NOT disable on playBlock.blocked so clicking it shows who isn't ready
  assert.match(transportSrc, /disabled=\{!loaded \|\| ctrlLock\.lockedForLocalUser\}/);
  assert.match(transportSrc, /\{activeTab === null &&[\s\S]*playBlock\.blocked/);

  assert.equal(shortcutsSrc.includes("toggleReadyStatus()"), true);
  assert.equal(shortcutsSrc.includes("togglePlayback({ showFeedback: true })"), true);

  assert.equal(watchRoomSrc.includes("onSyncPeerNotReady("), true);
  assert.equal(watchRoomSrc.includes("onSyncPeerLeft("), true);
  assert.equal(watchRoomSrc.includes("handlePeerDisconnected("), true);
  assert.equal(watchRoomSrc.includes("SyncDisconnectTracker"), true);
  assert.equal(watchRoomSrc.includes("syncDisconnectedNow"), true);
  assert.equal(watchRoomSrc.includes("onSyncPlayBlocked("), true);
  assert.equal(watchRoomSrc.includes("togglePlayback()"), true);
  assert.match(watchRoomSrc, /onMpvSurfaceClick\(\(\) => \{\s*if \(active\) hideChrome\(\);/);
  assert.match(
    watchRoomSrc,
    /onPointerDown=\{\(e\) => e\.stopPropagation\(\)\}\s*onClick=\{\(\) => \(chromeIdle \? wakeChrome\(\) : hideChrome\(\)\)\}/,
  );

  assert.equal(roomPanelSrc.includes("Not ready"), true);

  const syncplayTs = fs.readFileSync(path.join(REPO_ROOT, "src/lib/syncplay.ts"), "utf8");
  const syncModRs = fs.readFileSync(
    path.join(REPO_ROOT, "src-tauri/src/syncplay/mod.rs"),
    "utf8",
  );
  assert.equal(syncplayTs.includes("onSyncPeerLeft"), true);
  assert.equal(syncplayTs.includes('"sync://peer-left"'), true);
  assert.equal(syncModRs.includes('"sync://peer-left"'), true);
});

test("handlePeerDisconnected and SyncDisconnectTracker pause playback automatically on disconnect", async () => {
  const { playerActions, syncReady, useAppStore, useNotificationStore, usePlayerStore, useSyncStore } =
    await loadSharedActionsHarness();

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
    useNotificationStore.getState().clearAll();
    usePlayerStore.getState().reset();
    useSyncStore.getState().reset();

    // 1. Peer disconnects while playing in a standard room -> pauses locally + syncUserPause
    useAppStore.getState().setUsername("Alice");
    useAppStore.getState().enterRoom("123456");
    usePlayerStore.getState().setLoaded(true);
    usePlayerStore.getState().setPaused(false);
    usePlayerStore.getState().setPositionSecs(84.5);
    useSyncStore.getState().setStatus(CONNECTED_ALICE);
    useSyncStore.getState().setParticipants([makePeer("Alice", true)]);
    useNotificationStore
      .getState()
      .push("warn", "Bob is not ready.", 0, syncReady.peerNotReadyTag("Bob"));

    const pausedOnPeerLeft = playerActions.handlePeerDisconnected("Bob");
    await Promise.resolve();
    assert.equal(pausedOnPeerLeft, true);
    assert.equal(usePlayerStore.getState().paused, true);
    assert.equal(usePlayerStore.getState().feedback?.text, "Paused · Bob disconnected");
    assert.equal(
      useNotificationStore
        .getState()
        .items.some((i) => i.tag === syncReady.peerNotReadyTag("Bob")),
      false,
    );
    assert.equal(
      useNotificationStore
        .getState()
        .items.some(
          (i) =>
            i.tag === syncReady.peerDisconnectedTag("Bob") &&
            i.message === "Bob disconnected — playback paused.",
        ),
      true,
    );
    assert.ok(calls.some((c) => c.cmd === "mpv_set_pause" && c.args.paused === true));
    assert.ok(calls.some((c) => c.cmd === "sync_user_pause" && c.args.position === 84.5));

    // 2. Peer disconnects while locked to a remaining controller -> notifies without fighting controller
    calls.length = 0;
    usePlayerStore.getState().setPaused(false);
    useSyncStore.getState().setParticipants([
      makePeer("Alice", true, false),
      makePeer("Host", true, true),
    ]);
    const pausedWhileLocked = playerActions.handlePeerDisconnected("Charlie");
    await Promise.resolve();
    assert.equal(pausedWhileLocked, false);
    assert.equal(usePlayerStore.getState().paused, false);
    assert.equal(calls.length, 0);

    // 3. Local Syncplay outage (`connected` -> `reconnecting`) pauses once per outage
    const tracker = new playerActions.SyncDisconnectTracker();
    assert.equal(tracker.onStatus(CONNECTED_ALICE, true), false);

    calls.length = 0;
    useNotificationStore.getState().clearAll();
    usePlayerStore.getState().setPaused(false);
    const pausedOnOutage = tracker.onStatus(
      {
        state: "reconnecting",
        endpoint: "syncplay.pl:8999",
        attempt: 1,
        retryInSecs: 1,
        suggestBackup: false,
      },
      true,
    );
    await Promise.resolve();
    assert.equal(pausedOnOutage, true);
    assert.equal(usePlayerStore.getState().paused, true);
    assert.equal(usePlayerStore.getState().feedback?.text, "Disconnected · Paused");
    assert.ok(calls.some((c) => c.cmd === "mpv_set_pause" && c.args.paused === true));
    assert.equal(
      useNotificationStore
        .getState()
        .items.some((i) => i.tag === syncReady.LOCAL_DISCONNECT_TAG),
      true,
    );

    // Repeated retry cycles do not re-pause if the user manually unpaused offline
    calls.length = 0;
    usePlayerStore.getState().setPaused(false);
    assert.equal(
      tracker.onStatus({ state: "connecting", endpoint: "syncplay.pl:8999", attempt: 2 }, true),
      false,
    );
    assert.equal(
      tracker.onStatus(
        {
          state: "reconnecting",
          endpoint: "syncplay.pl:8999",
          attempt: 2,
          retryInSecs: 2,
          suggestBackup: false,
        },
        true,
      ),
      false,
    );
    assert.equal(
      tracker.onStatus(
        {
          state: "error",
          endpoint: "syncplay.pl:8999",
          message: "Lost connection",
          suggestBackup: true,
          circuitOpen: true,
        },
        true,
      ),
      false,
    );
    assert.equal(usePlayerStore.getState().paused, false);
    assert.equal(calls.length, 0);

    // Reconnecting resets tracker and clears disconnect warning; a second drop pauses again
    assert.equal(tracker.onStatus(CONNECTED_ALICE, true), false);
    assert.equal(
      useNotificationStore
        .getState()
        .items.some((i) => i.tag === syncReady.LOCAL_DISCONNECT_TAG),
      false,
    );
    assert.equal(
      tracker.onStatus(
        {
          state: "reconnecting",
          endpoint: "syncplay.pl:8999",
          attempt: 1,
          retryInSecs: 1,
          suggestBackup: false,
        },
        true,
      ),
      true,
    );
    assert.equal(usePlayerStore.getState().paused, true);

    // Solo mode / intentional disconnected never auto-pauses
    usePlayerStore.getState().setPaused(false);
    assert.equal(tracker.onStatus({ state: "disconnected" }, true), false);
    assert.equal(
      tracker.onStatus(
        {
          state: "error",
          endpoint: "syncplay.pl:8999",
          message: "Lost connection",
          suggestBackup: false,
          circuitOpen: false,
        },
        false,
      ),
      false,
    );
    assert.equal(usePlayerStore.getState().paused, false);

    // Leaving room cleans up peer-left and local-disconnect notifications
    useNotificationStore
      .getState()
      .push("info", "Bob disconnected.", 0, syncReady.peerDisconnectedTag("Bob"));
    useNotificationStore
      .getState()
      .push("warn", "Disconnected from Watch Party — playback paused.", 0, syncReady.LOCAL_DISCONNECT_TAG);
    useAppStore.getState().leaveRoom();
    assert.equal(
      useNotificationStore
        .getState()
        .items.some(
          (i) =>
            i.tag?.startsWith(syncReady.PEER_LEFT_TAG_PREFIX) ||
            i.tag === syncReady.LOCAL_DISCONNECT_TAG,
        ),
      false,
    );
  } finally {
    useNotificationStore.getState().clearAll();
    usePlayerStore.getState().clearFeedback();
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});
