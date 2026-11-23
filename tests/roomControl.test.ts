import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadModules<T = Record<string, any>>(entryRelPath: string): Promise<T> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-ctrl-test-"));
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

test("getControllerLockState respects Epilod host-only lock, admin grants, and revoke", async () => {
  const { getControllerLockState, formatControllerLockReason, formatControlNoticeMessage } =
    await loadModules<typeof import("../src/lib/syncController")>("src/lib/syncController.ts");

  const basePeers = [
    {
      username: "Alice",
      room: "ep-1",
      position: 10,
      isReady: true,
      isController: true,
      isHost: true,
      isAdmin: false,
      fileMatch: "matched" as const,
    },
    {
      username: "Bob",
      room: "ep-1",
      position: 10,
      isReady: true,
      isController: false,
      isHost: false,
      isAdmin: false,
      fileMatch: "matched" as const,
    },
  ];

  // Guest Bob is locked when host-only control is active and Bob has no admin.
  const lockedBob = getControllerLockState(true, basePeers, "Bob", {
    hostControlActive: true,
    localIsHost: false,
    localIsAdmin: false,
    hostUsername: "Alice",
    adminUsernames: [],
  });
  assert.equal(lockedBob.hasControllers, true);
  assert.equal(lockedBob.hostControlActive, true);
  assert.equal(lockedBob.localIsHost, false);
  assert.equal(lockedBob.localIsAdmin, false);
  assert.equal(lockedBob.localIsController, false);
  assert.equal(lockedBob.lockedForLocalUser, true);
  assert.equal(formatControllerLockReason(lockedBob), "Only Alice (and admins) can control playback.");

  // Granting Admin to Bob unlocks playback for Bob immediately.
  const adminBob = getControllerLockState(true, basePeers, "Bob", {
    hostControlActive: true,
    localIsHost: false,
    localIsAdmin: true,
    hostUsername: "Alice",
    adminUsernames: ["Bob"],
  });
  assert.equal(adminBob.localIsAdmin, true);
  assert.equal(adminBob.localIsHost, false);
  assert.equal(adminBob.localIsController, true);
  assert.equal(adminBob.lockedForLocalUser, false);

  // Disconnected players are never locally locked even before participants refresh.
  const disconnectedBob = getControllerLockState(false, basePeers, "Bob", {
    hostControlActive: true,
    localIsHost: false,
    localIsAdmin: false,
    hostUsername: "Alice",
    adminUsernames: [],
  });
  assert.equal(disconnectedBob.lockedForLocalUser, false);

  // Existing 3-arg call signature stays backwards compatible.
  const serverManaged = getControllerLockState(true, basePeers, "Bob");
  assert.equal(serverManaged.lockedForLocalUser, true);
  assert.equal(serverManaged.hostControlActive, false);

  assert.equal(
    formatControlNoticeMessage({ kind: "adminGranted", actor: "Alice" })?.level,
    "success",
  );
  assert.equal(
    formatControlNoticeMessage({ kind: "adminRevoked", actor: "Alice" })?.level,
    "warn",
  );
  assert.equal(
    formatControlNoticeMessage({ kind: "hostReconnected", actor: "Alice" })?.text,
    "Alice reconnected as room host.",
  );
  assert.equal(
    formatControlNoticeMessage(
      { kind: "guestBlocked", actor: "Alice" },
      { hostControlActive: true, localIsHost: false, localIsAdmin: false },
    )?.text,
    "Only Alice (room host) can control playback.",
  );
});

test("useAppStore and useSyncStore manage hostOnlyRoom and roomControl lifecycles cleanly", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-ctrl-stores-"));
  const outFile = path.join(outDir, "stores.mjs");
  buildSync({
    stdin: {
      contents: `export { useAppStore } from "./src/store/useAppStore.ts"; export { useSyncStore } from "./src/store/useSyncStore.ts";`,
      resolveDir: REPO_ROOT,
      loader: "ts",
    },
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  const { useAppStore, useSyncStore } = (await import(pathToFileURL(outFile).href)) as {
    useAppStore: typeof import("../src/store/useAppStore")["useAppStore"];
    useSyncStore: typeof import("../src/store/useSyncStore")["useSyncStore"];
  };

  assert.equal(useAppStore.getState().hostOnlyRoom, false);
  useAppStore.getState().enterRoom("482915", false, true);
  assert.equal(useAppStore.getState().screen, "room");
  assert.equal(useAppStore.getState().roomCode, "482915");
  assert.equal(useAppStore.getState().hostOnlyRoom, true);

  useSyncStore.getState().setRoomControl({
    hostControlActive: true,
    localIsHost: true,
    localIsAdmin: false,
    hostUsername: "Alice",
    adminUsernames: ["Bob"],
  });
  assert.equal(useSyncStore.getState().roomControl.hostControlActive, true);
  assert.deepEqual(useSyncStore.getState().roomControl.adminUsernames, ["Bob"]);

  useAppStore.getState().leaveRoom();
  assert.equal(useAppStore.getState().hostOnlyRoom, false);
  assert.equal(useAppStore.getState().creatingRoom, false);
  assert.equal(useAppStore.getState().screen, "home");
  assert.equal(useSyncStore.getState().roomControl.hostControlActive, false);
  assert.equal(useSyncStore.getState().roomControl.localIsHost, false);
  assert.deepEqual(useSyncStore.getState().roomControl.adminUsernames, []);

  useAppStore.getState().enterRoom("482915", false, false, true);
  assert.equal(useAppStore.getState().creatingRoom, true);
  assert.equal(useAppStore.getState().roomCode, "482915");

  useAppStore.getState().applyRerolledRoomCode("739204");
  assert.equal(useAppStore.getState().roomCode, "739204");
  assert.equal(useAppStore.getState().creatingRoom, false);
  assert.equal(useAppStore.getState().screen, "room");

  // Literal room names never enter claim-on-create mode
  useAppStore.getState().enterRoom("MovieNight", true, false, true);
  assert.equal(useAppStore.getState().creatingRoom, false);
});
