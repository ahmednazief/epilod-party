import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function installMockLocalStorage() {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(k: string) {
      return store.get(k) ?? null;
    },
    key(i: number) {
      return Array.from(store.keys())[i] ?? null;
    },
    removeItem(k: string) {
      store.delete(k);
    },
    setItem(k: string, v: string) {
      store.set(k, v);
    },
  };
  return store;
}

async function loadRecentRoomsBundle() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-recent-rooms-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * from "./src/store/useRecentRoomsStore.ts";
          export * from "./src/lib/persist.ts";
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
    return await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("useRecentRoomsStore keeps max 3 unpinned recent rooms, sorts pinned first, and never stores passwords", async () => {
  const store = installMockLocalStorage();
  const mod = await loadRecentRoomsBundle();
  mod.useRecentRoomsStore.getState().clearAll();

  mod.useRecentRoomsStore.getState().recordJoin({
    roomName: "123456",
    serverHost: "syncplay.pl:8999",
    literalRoom: false,
    hasPassword: true,
  });
  const firstId = mod.buildRecentRoomId("123456", "syncplay.pl:8999", false);
  mod.useRecentRoomsStore.getState().togglePin(firstId);
  mod.useRecentRoomsStore.getState().setNickname(firstId, "Friday Night");

  for (let i = 0; i < 12; i++) {
    mod.useRecentRoomsStore.getState().recordJoin({
      roomName: `room-${i}`,
      serverHost: "syncplay.pl:8999",
      literalRoom: true,
      hasPassword: false,
    });
  }

  const rooms = mod.useRecentRoomsStore.getState().rooms;
  assert.equal(rooms.length, 4);
  assert.equal(rooms.filter((r: { pinned: boolean }) => !r.pinned).length, 3);
  assert.equal(rooms[0].id, firstId);
  assert.equal(rooms[0].pinned, true);
  assert.equal(rooms[0].nickname, "Friday Night");

  const rawStored = store.get(mod.versionedKey("recentRooms")) ?? "";
  assert.equal(rawStored.includes("password"), false);
});

test("useRecentRoomsStore survives corrupted non-array and malformed localStorage data", async () => {
  const store = installMockLocalStorage();
  store.set("epilod.v1.recentRooms", JSON.stringify({ corrupt: true }));
  let mod = await loadRecentRoomsBundle();
  assert.deepEqual(mod.useRecentRoomsStore.getState().rooms, []);

  store.set(
    "epilod.v1.recentRooms",
    JSON.stringify([
      null,
      123,
      { roomName: "   ", serverHost: "syncplay.pl" },
      { roomName: "valid-room", serverHost: "syncplay.pl", literalRoom: true, hasPassword: false },
      {
        roomName: "valid-room",
        serverHost: "syncplay.pl:8999",
        literalRoom: true,
        hasPassword: true,
        pinned: true,
        lastJoinedAt: 500,
      },
    ]),
  );
  mod = await loadRecentRoomsBundle();
  const rooms = mod.useRecentRoomsStore.getState().rooms;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].roomName, "valid-room");
  assert.equal(rooms[0].serverHost, "syncplay.pl:8999");
  assert.equal(rooms[0].pinned, true);
});

test("useRecentRoomsStore normalizes default port :8999, keeps unpinned slots when 10+ pinned, preserves hostOnly, and tracks storageError", async () => {
  const store = installMockLocalStorage();
  const mod = await loadRecentRoomsBundle();
  mod.useRecentRoomsStore.getState().clearAll();

  assert.equal(
    mod.buildRecentRoomId("movie-night", "Syncplay.PL", true),
    mod.buildRecentRoomId("movie-night", "syncplay.pl:8999", true),
  );

  // Pin 10 rooms
  for (let i = 0; i < 10; i++) {
    mod.useRecentRoomsStore.getState().recordJoin({
      roomName: `pinned-${i}`,
      serverHost: "syncplay.pl",
      literalRoom: true,
      hasPassword: false,
      hostOnly: i === 0,
      seriesKey: i === 0 ? "series_abc" : undefined,
    });
    const id = mod.buildRecentRoomId(`pinned-${i}`, "syncplay.pl", true);
    mod.useRecentRoomsStore.getState().togglePin(id);
  }

  // Joining a new unpinned room should still be saved even with 10 pinned rooms
  mod.useRecentRoomsStore.getState().recordJoin({
    roomName: "654321",
    serverHost: "syncplay.pl",
    literalRoom: false,
    hasPassword: true,
    hostOnly: true,
  });

  const rooms = mod.useRecentRoomsStore.getState().rooms;
  assert.equal(rooms.filter((r: { pinned: boolean }) => r.pinned).length, 10);
  const newRoom = rooms.find((r: { roomName: string }) => r.roomName === "654321");
  assert.ok(newRoom);
  assert.equal(newRoom.hostOnly, true);

  // clearSeriesLinks removes seriesKey without dropping rooms
  mod.useRecentRoomsStore.getState().clearSeriesLinks();
  assert.equal(
    mod.useRecentRoomsStore.getState().rooms.some((r: { seriesKey?: string }) => Boolean(r.seriesKey)),
    false,
  );

  // Simulate localStorage write failure
  const originalSetItem = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  mod.useRecentRoomsStore.getState().recordJoin({
    roomName: "quota-test",
    serverHost: "syncplay.pl",
    literalRoom: true,
    hasPassword: false,
  });
  assert.equal(mod.useRecentRoomsStore.getState().storageError, true);

  // Restore localStorage and verify storageError clears on next successful write
  globalThis.localStorage.setItem = originalSetItem;
  mod.useRecentRoomsStore.getState().removeRoom(
    mod.buildRecentRoomId("quota-test", "syncplay.pl", true),
  );
  assert.equal(mod.useRecentRoomsStore.getState().storageError, false);
  assert.ok(store.has("epilod.v1.recentRooms"));
});

test("getRecentRoomMediaLabel extracts show, episode, or movie names for room differentiation", async () => {
  installMockLocalStorage();
  const mod = await loadRecentRoomsBundle();

  const seriesMap = {
    series_sev: {
      seriesKey: "series_sev",
      folderPath: "D:\\Shows\\Severance.S02.1080p",
      folderName: "Severance.S02.1080p",
      lastEpisodeKey: "S02E03",
      watchedKeys: ["S02E01", "S02E02"],
      updatedAt: 1000,
    },
  };

  assert.equal(
    mod.getRecentRoomMediaLabel(
      { seriesKey: "series_sev", lastFilePath: "D:\\Shows\\Severance.S02.1080p\\ep3.mkv" },
      seriesMap,
    ),
    "Severance · Season 2",
  );

  assert.equal(
    mod.getRecentRoomMediaLabel(
      { lastFilePath: "D:\\Shows\\Breaking.Bad.S05E14.Ozymandias.1080p.BluRay.mkv" },
      seriesMap,
    ),
    "Breaking Bad · S05E14",
  );

  assert.equal(
    mod.getRecentRoomMediaLabel(
      { lastFilePath: "D:\\Movies\\Inception.2010.1080p.BluRay.x264.mkv" },
      seriesMap,
    ),
    "Inception 2010",
  );

  assert.equal(
    mod.getRecentRoomMediaLabel({}, seriesMap, "Dune.Part.Two.2024.2160p.WEB-DL.mkv"),
    "Dune Part Two 2024",
  );

  assert.equal(mod.getRecentRoomMediaLabel({}, seriesMap), null);
});
