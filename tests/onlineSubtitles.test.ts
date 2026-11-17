import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function bundleAndImport<T>(entryRel: string): Promise<T> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-sub-test-"));
  try {
    const outFile = path.join(outDir, "mod.mjs");
    buildSync({
      entryPoints: [path.join(REPO_ROOT, entryRel)],
      outfile: outFile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    return (await import(pathToFileURL(outFile).href)) as T;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("deriveCleanSearchQuery parses movie, series, and anime filenames cleanly", async () => {
  const { deriveCleanSearchQuery } = await bundleAndImport<typeof import("../src/store/useSubtitleStore")>(
    "src/store/useSubtitleStore.ts",
  );
  assert.equal(
    deriveCleanSearchQuery("D:\\Movies\\Inception.2010.1080p.BluRay.x264-YIFY.mkv"),
    "Inception 2010",
  );
  assert.equal(
    deriveCleanSearchQuery("Breaking.Bad.S02E05.Breakage.720p.WEB-DL.mkv"),
    "Breaking Bad S02E05",
  );
  assert.equal(
    deriveCleanSearchQuery("[SubsPlease] Frieren - 12 (1080p) [ABCDEF12].mkv"),
    "Frieren - 12",
  );
  assert.equal(deriveCleanSearchQuery(null), "");
});

test("hasMatchingSubtitleTrack handles ISO 639-1, ISO 639-2, detectedSubLangs, and multi-language priorities", async () => {
  const { hasMatchingSubtitleTrack } = await bundleAndImport<typeof import("../src/store/useSubtitleStore")>(
    "src/store/useSubtitleStore.ts",
  );
  const tracks = [
    { id: 1, type: "video" as const, selected: true },
    { id: 2, type: "sub" as const, lang: "en", title: "English", selected: true },
  ];
  assert.equal(hasMatchingSubtitleTrack(tracks, "eng"), true);
  assert.equal(hasMatchingSubtitleTrack(tracks, "ara"), false);
  assert.equal(hasMatchingSubtitleTrack(tracks, "ara,eng"), true);

  const untagged = [{ id: 5, type: "sub" as const, lang: "und", selected: true }];
  assert.equal(hasMatchingSubtitleTrack(untagged, "ara"), false);
  assert.equal(hasMatchingSubtitleTrack(untagged, "ara", { 5: "ar" }), true);
});

test("useAppStore and useSubtitleStore manage auto-fetch mode, language preferences, and status cleanly", async () => {
  const { useAppStore } = await bundleAndImport<typeof import("../src/store/useAppStore")>(
    "src/store/useAppStore.ts",
  );
  const { useSubtitleStore } = await bundleAndImport<typeof import("../src/store/useSubtitleStore")>(
    "src/store/useSubtitleStore.ts",
  );

  const app = useAppStore.getState();
  assert.equal(app.autoFetchSubtitles, "missing");
  assert.equal(app.preferredSubtitleLangs, "eng");

  app.setAutoFetchSubtitles("language");
  app.setPreferredSubtitleLangs("ara,eng");
  assert.equal(useAppStore.getState().autoFetchSubtitles, "language");
  assert.equal(useAppStore.getState().preferredSubtitleLangs, "ara,eng");

  app.setAutoFetchSubtitles("missing");
  app.setPreferredSubtitleLangs("eng");

  const sub = useSubtitleStore.getState();
  sub.setAutoFetchState("searching", "Searching online subtitles…");
  assert.equal(useSubtitleStore.getState().autoFetchStatus, "searching");
  sub.clearLoadedTrack();
  assert.equal(useSubtitleStore.getState().autoFetchStatus, "idle");
  assert.equal(useSubtitleStore.getState().autoFetchMessage, null);
});

test("UI and Rust layers wire online subtitle search and automatic subtitle fetching", () => {
  const subPanel = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
    "utf8",
  );
  assert.equal(subPanel.includes("subtitleSearchOnline"), true);
  assert.equal(subPanel.includes("subtitleDownloadOnline"), true);
  assert.equal(subPanel.includes("Search Subtitles Online"), true);

  const watchRoom = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8",
  );
  assert.equal(watchRoom.includes("subtitleAutoFetchOnline"), true);
  assert.equal(watchRoom.includes("autoFetchSubtitles"), true);

  const settings = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  assert.equal(settings.includes("Auto-Fetch Online Subtitles"), true);
  assert.equal(settings.includes("Preferred Subtitle Language"), true);

  const rustLib = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/lib.rs"), "utf8");
  assert.equal(rustLib.includes("subtitle_search_online"), true);
  assert.equal(rustLib.includes("subtitle_download_online"), true);
  assert.equal(rustLib.includes("subtitle_auto_fetch_online"), true);
});
