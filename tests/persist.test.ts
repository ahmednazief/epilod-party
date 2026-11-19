import assert from "node:assert/strict";
import test from "node:test";
import { loadJson, saveJson, trimLruMap, versionedKey } from "../src/lib/persist.ts";

function installMockLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));
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

test("loadJson returns fallback when JSON is corrupted or missing", () => {
  const store = installMockLocalStorage({
    [versionedKey("broken")]: "{not-valid-json",
  });
  assert.deepEqual(loadJson("broken", { ok: false }), { ok: false });
  assert.deepEqual(loadJson("missing", [1, 2]), [1, 2]);
  assert.equal(saveJson("good", { a: 42 }), true);
  assert.deepEqual(loadJson("good", { a: 0 }), { a: 42 });
  assert.equal(store.has("epilod.v1.good"), true);
});

test("trimLruMap keeps the newest entries up to maxEntries", () => {
  const input = {
    a: { updatedAt: 100, v: 1 },
    b: { updatedAt: 300, v: 2 },
    c: { updatedAt: 200, v: 3 },
  };
  const trimmed = trimLruMap(input, 2);
  assert.deepEqual(Object.keys(trimmed).sort(), ["b", "c"]);
});
