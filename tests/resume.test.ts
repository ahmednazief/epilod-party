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

async function loadResumeBundle() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-resume-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * from "./src/lib/resume.ts";
          export * from "./src/lib/persist.ts";
          export { useResumeStore } from "./src/store/useResumeStore.ts";
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

test("buildMediaFileKey strips path for privacy and normalizes name and duration", async () => {
  const mod = await loadResumeBundle();
  const k1 = mod.buildMediaFileKey("C:\\Users\\Alice\\Movies\\Inception (2010).mkv", 8880.4);
  const k2 = mod.buildMediaFileKey("/mnt/media/Inception (2010).mkv", 8880.1);
  assert.equal(k1, "inception (2010).mkv::8880");
  assert.equal(k1, k2);
  assert.equal(k1?.includes("Alice"), false);
});

test("shouldSaveResumePosition skips <30s, saves middle, clears >95%", async () => {
  const mod = await loadResumeBundle();
  assert.equal(mod.shouldSaveResumePosition(12, 1000), "skip");
  assert.equal(mod.shouldSaveResumePosition(120, 1000), "save");
  assert.equal(mod.shouldSaveResumePosition(960, 1000), "clear");
});

test("useResumeStore saves, clears >95%, and enforces LRU 200 entries", async () => {
  const store = installMockLocalStorage();
  const mod = await loadResumeBundle();
  mod.useResumeStore.getState().clearAll();

  mod.useResumeStore.getState().savePosition("ep1.mkv::1000", 250, 1000);
  assert.equal(mod.useResumeStore.getState().getPosition("ep1.mkv::1000")?.positionSecs, 250);

  // Over 95% clears entry
  mod.useResumeStore.getState().savePosition("ep1.mkv::1000", 960, 1000);
  assert.equal(mod.useResumeStore.getState().getPosition("ep1.mkv::1000"), null);

  // Fill past RESUME_MAX_ENTRIES
  for (let i = 0; i < mod.RESUME_MAX_ENTRIES + 5; i++) {
    mod.useResumeStore.getState().savePosition(`ep${i}.mkv::1000`, 100, 1000);
  }
  assert.equal(Object.keys(mod.useResumeStore.getState().entries).length, mod.RESUME_MAX_ENTRIES);
  assert.equal(store.has(mod.versionedKey("resumePositions")), true);
  assert.equal(mod.formatResumeClock(2530), "42:10");
});
