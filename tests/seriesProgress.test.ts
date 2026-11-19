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

async function loadSeriesBundle() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-series-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * from "./src/lib/seriesProgress.ts";
          export * from "./src/lib/autoNext.ts";
          export * from "./src/store/useSeriesProgressStore.ts";
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

test("buildEpisodeKey normalizes S01E02 and falls back to clean title", async () => {
  const mod = await loadSeriesBundle();
  assert.equal(mod.buildEpisodeKey("Show.Name.S01E02.1080p.WEB.mkv"), "S01E02");
  assert.equal(mod.buildEpisodeKey("Show Name - 07 [1080p].mkv"), "EP 07");
  assert.equal(mod.buildEpisodeKey("OVA Special Bonus.mkv"), "ova special bonus");
});

test("pickNextUnwatchedIndex and autoNext skip watched episodes including gaps and uncoded titles", async () => {
  const mod = await loadSeriesBundle();
  const items = [
    { path: "/s/01.mkv", fileName: "Show.S01E01.mkv", cleanTitle: "Ep 1", season: 1, episode: 1, episodeBadge: "S01E01", subtitlePath: null },
    { path: "/s/02.mkv", fileName: "Show.S01E02.mkv", cleanTitle: "Ep 2", season: 1, episode: 2, episodeBadge: "S01E02", subtitlePath: null },
    { path: "/s/04.mkv", fileName: "Show.S01E04.mkv", cleanTitle: "Ep 4", season: 1, episode: 4, episodeBadge: "S01E04", subtitlePath: null },
    { path: "/s/ova.mkv", fileName: "Bonus OVA.mkv", cleanTitle: "Bonus OVA", season: null, episode: null, episodeBadge: null, subtitlePath: null },
  ];

  // Ep 2 is already watched -> from Ep 1 (index 0) should jump to Ep 4 (index 2)
  assert.equal(mod.pickNextUnwatchedIndex(items, 0, ["S01E02"]), 2);

  const eof = mod.canTriggerAutoNextOnEof({
    autoPlayNext: true,
    currentIndex: 0,
    itemsLength: items.length,
    loadInFlight: false,
    eofHandledForGen: 0,
    currentLoadGen: 1,
    lockedForLocalUser: false,
    items,
    watchedKeys: ["S01E02"],
  });
  assert.deepEqual(eof, { advance: true, nextIndex: 2 });

  // If all remaining are watched, advance is false
  const eofNone = mod.canTriggerAutoNextOnEof({
    autoPlayNext: true,
    currentIndex: 0,
    itemsLength: items.length,
    loadInFlight: false,
    eofHandledForGen: 0,
    currentLoadGen: 1,
    lockedForLocalUser: false,
    items,
    watchedKeys: ["S01E02", "S01E04", "bonus ova"],
  });
  assert.deepEqual(eofNone, { advance: false, nextIndex: null });
});

test("useSeriesProgressStore enforces LRU 20 and preserves watchedKeys on relocateSeriesFolder", async () => {
  installMockLocalStorage();
  const mod = await loadSeriesBundle();
  mod.useSeriesProgressStore.getState().clearAll();

  const key = mod.useSeriesProgressStore.getState().upsertSeries({
    folderPath: "D:\\Anime\\Frieren",
    folderName: "Frieren",
    lastEpisodeKey: "S01E03",
  });
  assert.ok(key);
  mod.useSeriesProgressStore.getState().markWatched(key, "S01E01", true);
  mod.useSeriesProgressStore.getState().markWatched(key, "S01E02", true);

  const newKey = mod.useSeriesProgressStore
    .getState()
    .relocateSeriesFolder(key, "E:\\Shows\\Frieren", "Frieren");
  assert.ok(newKey);
  assert.deepEqual(mod.useSeriesProgressStore.getState().getSeries(newKey)?.watchedKeys, [
    "S01E01",
    "S01E02",
  ]);
  assert.equal(mod.useSeriesProgressStore.getState().getSeries(key), null);

  for (let i = 0; i < 25; i++) {
    mod.useSeriesProgressStore.getState().upsertSeries({
      folderPath: `D:\\Series\\Show${i}`,
      folderName: `Show${i}`,
    });
  }
  assert.equal(Object.keys(mod.useSeriesProgressStore.getState().series).length, 20);
});

test("useSeriesProgressStore survives corrupted non-object and malformed localStorage data", async () => {
  const store = installMockLocalStorage();
  store.set("epilod.v1.seriesProgress", JSON.stringify(["not", "an", "object"]));
  let mod = await loadSeriesBundle();
  assert.deepEqual(mod.useSeriesProgressStore.getState().series, {});

  store.set(
    "epilod.v1.seriesProgress",
    JSON.stringify({
      bad: null,
      missingPath: { folderName: "Broken" },
      valid: {
        folderPath: "D:\\Anime\\Test",
        folderName: "Test",
        watchedKeys: ["S01E01", 42],
        updatedAt: "bad",
      },
    }),
  );
  mod = await loadSeriesBundle();
  const series = mod.useSeriesProgressStore.getState().series;
  assert.deepEqual(Object.keys(series), ["valid"]);
  assert.deepEqual(series.valid.watchedKeys, ["S01E01"]);
  assert.equal(series.valid.updatedAt, 0);
});
