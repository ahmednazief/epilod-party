import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type { MpvTrack } from "../src/lib/mpv";

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

async function loadTestModules() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-new-features-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * as playerActions from "./src/lib/playerActions.ts";
          export * as seriesTrackPrefs from "./src/lib/seriesTrackPrefs.ts";
          export * as persist from "./src/lib/persist.ts";
          export { normalizeMpvTracks } from "./src/lib/mpv.ts";
          export { useAppStore } from "./src/store/useAppStore.ts";
          export { usePlayerStore } from "./src/store/usePlayerStore.ts";
          export { useSubtitleStore } from "./src/store/useSubtitleStore.ts";
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
      playerActions: typeof import("../src/lib/playerActions");
      seriesTrackPrefs: typeof import("../src/lib/seriesTrackPrefs");
      persist: typeof import("../src/lib/persist");
      normalizeMpvTracks: typeof import("../src/lib/mpv")["normalizeMpvTracks"];
      useAppStore: typeof import("../src/store/useAppStore")["useAppStore"];
      usePlayerStore: typeof import("../src/store/usePlayerStore")["usePlayerStore"];
      useSubtitleStore: typeof import("../src/store/useSubtitleStore")["useSubtitleStore"];
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("Dialogue Boost persists across files and toggles via playerActions", async () => {
  const store = installMockLocalStorage({ "ep.dialogueBoost": "true" });
  const m = await loadTestModules();

  assert.equal(m.usePlayerStore.getState().dialogueBoost, true);

  const calls: boolean[] = [];
  const deps = {
    mpvSetDialogueBoost: async (enabled: boolean) => {
      calls.push(enabled);
    },
  };

  m.playerActions.toggleDialogueBoost(deps);
  assert.equal(m.usePlayerStore.getState().dialogueBoost, false);
  assert.equal(store.get("ep.dialogueBoost"), "false");
  assert.deepEqual(calls, [false]);
  assert.equal(m.usePlayerStore.getState().feedback?.text, "Dialogue Boost Off");

  m.playerActions.setDialogueBoostPlayback(true, { flash: true, deps });
  assert.equal(m.usePlayerStore.getState().dialogueBoost, true);
  assert.equal(store.get("ep.dialogueBoost"), "true");
  assert.deepEqual(calls, [false, true]);
  assert.equal(m.usePlayerStore.getState().feedback?.text, "Dialogue Boost On");

  // Resetting player for a new file or leaving room keeps listening preference intact.
  m.usePlayerStore.getState().resetForNewFile();
  assert.equal(m.usePlayerStore.getState().dialogueBoost, true);
  m.usePlayerStore.getState().reset();
  assert.equal(m.usePlayerStore.getState().dialogueBoost, true);
});

test("seriesTrackPrefs persists per series folder and picks matching audio and sub tracks", async () => {
  const store = installMockLocalStorage();
  const m = await loadTestModules();

  const ep1 = "D:\\Anime\\Frieren\\Season 1\\Frieren.S01E01.mkv";
  const ep2 = "D:\\Anime\\Frieren\\Season 1\\Frieren.S01E02.mkv";
  const other = "D:\\Movies\\Inception\\Inception.2010.mkv";

  const k1 = m.seriesTrackPrefs.deriveSeriesKeyForFile(ep1);
  const k2 = m.seriesTrackPrefs.deriveSeriesKeyForFile(ep2);
  const kOther = m.seriesTrackPrefs.deriveSeriesKeyForFile(other);
  assert.ok(k1.startsWith("series_"));
  assert.equal(k1, k2);
  assert.notEqual(k1, kOther);

  m.seriesTrackPrefs.saveSeriesTrackPref(k1, {
    audioLang: "jpn",
    subLang: "ara",
    secondarySubLang: "eng",
  });
  const saved = m.seriesTrackPrefs.getSeriesTrackPref(k2);
  assert.equal(saved?.audioLang, "jpn");
  assert.equal(saved?.subLang, "ara");
  assert.equal(saved?.secondarySubLang, "eng");

  // Ensure local folder path is hashed and not persisted raw.
  const rawPersist = store.get(m.persist.versionedKey("seriesTrackPrefs")) ?? "";
  assert.equal(rawPersist.includes("Frieren"), false);

  const tracks: MpvTrack[] = [
    { id: 1, type: "audio", lang: "en", default: true, selected: true },
    { id: 2, type: "audio", lang: "ja", default: false, selected: false },
    { id: 1, type: "sub", lang: "eng", default: true, forced: false, selected: false },
    { id: 2, type: "sub", lang: "ar", default: false, forced: true, selected: false },
    { id: 3, type: "sub", lang: "und", default: false, forced: false, selected: false },
  ];

  const audioMatch = m.seriesTrackPrefs.pickMatchingAudioTrack(tracks, "jpn");
  assert.equal(audioMatch?.id, 2);

  // Forced vs non-forced + FFmpeg detected fallback for "und" track #3.
  const subMatch = m.seriesTrackPrefs.pickMatchingSubTrack(tracks, "ara", { 3: "ara" });
  assert.equal(subMatch?.id, 3);

  // Secondary subtitle skips primary track id.
  const secMatch = m.seriesTrackPrefs.pickMatchingSubTrack(tracks, "eng", undefined, 3);
  assert.equal(secMatch?.id, 1);

  // "off" preference is preserved explicitly.
  m.seriesTrackPrefs.saveSeriesTrackPref(k1, { subLang: "off" });
  assert.equal(m.seriesTrackPrefs.getSeriesTrackPref(k2)?.subLang, "off");
});

test("useSubtitleStore manages RAM-only sharedSubtitles deduplication, cap, and room leave cleanup", async () => {
  const store = installMockLocalStorage();
  const m = await loadTestModules();

  const subStore = m.useSubtitleStore.getState();
  subStore.clearSharedSubtitles();

  assert.equal(
    subStore.addSharedSubtitle({
      id: "sub_1",
      sender: "Omar",
      fileName: "Show.E04.ar.srt",
      ext: "srt",
      lang: "ara",
      content: "1\n00:00:01,000 --> 00:00:03,000\nHello\n",
      sizeBytes: 38,
    }),
    true,
  );
  // Duplicate id is ignored.
  assert.equal(
    subStore.addSharedSubtitle({
      id: "sub_1",
      sender: "Omar",
      fileName: "Show.E04.ar.srt",
      ext: "srt",
      lang: "ara",
      content: "1\n00:00:01,000 --> 00:00:03,000\nHello\n",
      sizeBytes: 38,
    }),
    false,
  );
  assert.equal(m.useSubtitleStore.getState().sharedSubtitles.length, 1);
  assert.equal(m.useSubtitleStore.getState().sharedSubtitles[0].applied, false);

  m.useSubtitleStore.getState().markSharedSubtitleApplied("sub_1");
  assert.equal(m.useSubtitleStore.getState().sharedSubtitles[0].applied, true);

  // clearLoadedTrack preserves room shared subtitles for the session.
  m.useSubtitleStore.getState().clearLoadedTrack();
  assert.equal(m.useSubtitleStore.getState().sharedSubtitles.length, 1);

  // Exceeding cap of 10 keeps the newest 10.
  for (let i = 2; i <= 12; i++) {
    m.useSubtitleStore.getState().addSharedSubtitle({
      id: `sub_${i}`,
      sender: "Omar",
      fileName: `Ep${i}.srt`,
      ext: "srt",
      lang: "eng",
      content: "1\n00:00:01,000 --> 00:00:02,000\nLine\n",
      sizeBytes: 37,
    });
  }
  assert.equal(m.useSubtitleStore.getState().sharedSubtitles.length, 10);
  assert.equal(m.useSubtitleStore.getState().sharedSubtitles[0].id, "sub_12");

  // Leaving room clears sharedSubtitles; nothing was ever written to localStorage.
  m.useAppStore.getState().leaveRoom();
  assert.equal(m.useSubtitleStore.getState().sharedSubtitles.length, 0);
  assert.equal(
    Array.from(store.keys()).some((k) => k.toLowerCase().includes("sharedsub")),
    false,
  );
});

test("autoEnableEmbeddedSubtitle respects seriesTrackPrefs off and preferred language", async () => {
  installMockLocalStorage();
  const m = await loadTestModules();

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
    const epPath = "D:\\Shows\\Andor\\Andor.S01E02.mkv";
    const seriesKey = m.seriesTrackPrefs.deriveSeriesKeyForFile(epPath);
    const tracks = m.normalizeMpvTracks([
      { id: 1, type: "sub", codec: "subrip", lang: "eng", default: true, selected: true, external: false },
      { id: 2, type: "sub", codec: "subrip", lang: "ara", default: false, selected: false, external: false },
    ]);

    // 1. Explicit "off" preference suppresses auto-enable and hides subtitles.
    m.seriesTrackPrefs.saveSeriesTrackPref(seriesKey, { subLang: "off" });
    m.playerActions.resetAutoSubtitleState();
    m.useAppStore.getState().setSelectedFile(epPath, "Andor.S01E02.mkv");
    m.useSubtitleStore.getState().setVisible(true);
    calls.length = 0;

    m.playerActions.autoEnableEmbeddedSubtitle(tracks);
    assert.equal(m.useSubtitleStore.getState().visible, false);
    assert.ok(calls.some((c) => c.cmd === "mpv_set_sub_track" && c.args.sid === null));
    assert.ok(calls.some((c) => c.cmd === "mpv_set_sub_style" && c.args.visible === false));

    // 2. Explicit language preference selects matching track.
    m.seriesTrackPrefs.saveSeriesTrackPref(seriesKey, { subLang: "ara" });
    m.playerActions.resetAutoSubtitleState();
    calls.length = 0;

    m.playerActions.autoEnableEmbeddedSubtitle(tracks);
    assert.equal(m.useSubtitleStore.getState().visible, true);
    assert.ok(calls.some((c) => c.cmd === "mpv_set_sub_track" && c.args.sid === 2));
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});
