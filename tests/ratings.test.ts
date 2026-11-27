import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

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

async function loadRatingModules() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-ratings-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * as ratings from "./src/lib/ratings.ts";
          export { useRatingStore } from "./src/store/useRatingStore.ts";
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
    return (await import(`${pathToFileURL(outFile).href}?t=${Date.now()}`)) as {
      ratings: typeof import("../src/lib/ratings");
      useRatingStore: typeof import("../src/store/useRatingStore")["useRatingStore"];
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("Ratings 2.0: getRatingTier and computeConsensusBadge classify scores accurately", async () => {
  installMockLocalStorage();
  const m = await loadRatingModules();

  assert.equal(m.ratings.getRatingTier(1), "low");
  assert.equal(m.ratings.getRatingTier(4), "low");
  assert.equal(m.ratings.getRatingTier(5), "mid");
  assert.equal(m.ratings.getRatingTier(7), "mid");
  assert.equal(m.ratings.getRatingTier(8), "high");
  assert.equal(m.ratings.getRatingTier(9), "high");
  assert.equal(m.ratings.getRatingTier(10), "masterpiece");

  assert.equal(
    m.ratings.computeConsensusBadge([
      { username: "A", score: 9, updatedAt: 1 },
      { username: "B", score: 8, updatedAt: 2 },
    ]).tone,
    "consensus",
  );
  assert.equal(
    m.ratings.computeConsensusBadge([
      { username: "A", score: 9, updatedAt: 1 },
      { username: "B", score: 4, updatedAt: 2 },
    ]).tone,
    "split",
  );
  assert.equal(
    m.ratings.computeConsensusBadge([{ username: "A", score: 8, updatedAt: 1 }]).tone,
    "neutral",
  );
});

test("Ratings 2.0: reopenForKey bypasses dismiss, seeds saved votes, and persists partyByMediaId", async () => {
  const store = installMockLocalStorage();
  const m = await loadRatingModules();
  const rs = m.useRatingStore;

  const fileName = "Frieren.S01E05.1080p.mkv";
  const key = m.ratings.buildRatingKey(fileName, 1440)!;
  const mediaId = m.ratings.buildEpisodeRatingId(fileName)!;
  assert.ok(key);
  assert.ok(mediaId);

  rs.getState().openForKey(key, "Frieren S01E05", fileName);
  rs.getState().castLocalVote(key, "Ahmed", "fox", 9, fileName);
  rs.getState().receivePeerVote(key, "Sara", "luna", 8, fileName);
  rs.getState().close(true);

  assert.equal(rs.getState().open, false);
  // Auto openForKey respects dismiss
  rs.getState().openForKey(key, "Frieren S01E05", fileName);
  assert.equal(rs.getState().open, false);

  // Party summary persisted by mediaId
  const party = rs.getState().partyByMediaId[mediaId];
  assert.ok(party);
  assert.equal(party.totalVotes, 2);
  assert.equal(party.average, 8.5);
  assert.equal(party.voters.length, 2);

  // Reset session clears ephemeral session votes, keeps personal & party summaries
  rs.getState().resetSession();
  assert.equal(Object.keys(rs.getState().votesByKey).length, 0);
  assert.ok(rs.getState().partyByMediaId[mediaId]);
  assert.equal(rs.getState().personalByMediaId[mediaId]?.score, 9);

  // reopenForKey restores personal & party votes into the active rating bar
  rs.getState().reopenForKey(key, "Frieren S01E05", fileName, {
    username: "Ahmed",
    avatarId: "fox",
  });
  assert.equal(rs.getState().open, true);
  assert.equal(rs.getState().manualOpen, true);
  assert.equal(rs.getState().myScoreByKey[key], 9);
  assert.equal(Object.keys(rs.getState().votesByKey[key] ?? {}).length, 2);
  assert.ok(store.get("epilod.v1.partyEpisodeRatings"));
});
