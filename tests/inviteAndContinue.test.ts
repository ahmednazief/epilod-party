import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadBundle() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-invite-continue-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * from "./src/lib/inviteLinks.ts";
          export * from "./src/lib/continueWatching.ts";
          export * from "./src/lib/seriesProgress.ts";
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
      formatInviteLink: typeof import("../src/lib/inviteLinks").formatInviteLink;
      formatInviteClipboardText: typeof import("../src/lib/inviteLinks").formatInviteClipboardText;
      parseInviteLink: typeof import("../src/lib/inviteLinks").parseInviteLink;
      buildContinueWatchingItems: typeof import("../src/lib/continueWatching").buildContinueWatchingItems;
      formatTimeLeftShort: typeof import("../src/lib/continueWatching").formatTimeLeftShort;
      buildSeriesKey: typeof import("../src/lib/seriesProgress").buildSeriesKey;
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("inviteLinks formats, extracts from pasted text, and rejects invalid URIs", async () => {
  const mod = await loadBundle();

  const link = mod.formatInviteLink("482 915", false, "syncplay.pl:8999");
  assert.equal(link, "epilod://join/482915");

  const clip = mod.formatInviteClipboardText("482915", false, "syncplay.pl:8999");
  assert.equal(clip, "482 915 · epilod://join/482915");

  const parsedFromClip = mod.parseInviteLink(`Come join! ${clip}`);
  assert.deepEqual(parsedFromClip, {
    uri: "epilod://join/482915",
    roomName: "482915",
    literalRoom: false,
    serverHost: null,
  });

  const customLink = mod.formatInviteLink("Friday Anime", true, "party.example.com:9000");
  assert.equal(
    customLink,
    "epilod://join/Friday%20Anime?literal=1&host=party.example.com%3A9000",
  );
  const parsedCustom = mod.parseInviteLink(customLink!);
  assert.deepEqual(parsedCustom, {
    uri: customLink!,
    roomName: "Friday Anime",
    literalRoom: true,
    serverHost: "party.example.com:9000",
  });

  assert.equal(mod.parseInviteLink("epilod://join/../../bad"), null);
  assert.equal(mod.parseInviteLink("epilod://join/notacode"), null);
  assert.equal(mod.parseInviteLink("https://example.com/join/482915"), null);
});

test("buildContinueWatchingItems combines series resume progress and standalone movies without duplicates", async () => {
  const mod = await loadBundle();
  const seriesFolder = "D:\\Shows\\Severance";
  const seriesKey = mod.buildSeriesKey(seriesFolder);

  const items = mod.buildContinueWatchingItems(
    {
      [seriesKey]: {
        seriesKey,
        folderPath: seriesFolder,
        folderName: "Severance",
        lastEpisodeKey: "S01E03",
        watchedKeys: ["S01E01", "S01E02"],
        updatedAt: 1000,
      },
    },
    {
      // Inside Severance folder -> should enrich the series row, NOT create a duplicate movie row
      "sev3::1800": {
        positionSecs: 900,
        durationSecs: 2700,
        updatedAt: 2000,
        filePath: "D:\\Shows\\Severance\\Severance.S01E03.mkv",
        fileName: "Severance.S01E03.mkv",
      },
      // Standalone movie -> should appear as its own Movie row
      "dune2::9960": {
        positionSecs: 3600,
        durationSecs: 9960,
        updatedAt: 3000,
        filePath: "D:\\Movies\\Dune.Part.Two.2024.1080p.mkv",
        fileName: "Dune.Part.Two.2024.1080p.mkv",
      },
    },
    [],
    4,
  );

  assert.equal(items.length, 2);
  assert.equal(items[0].kind, "movie");
  assert.equal(items[0].title, "Dune Part Two 2024");
  assert.equal(items[0].timeLeftLabel, "1h 46m left");
  assert.ok((items[0].progressRatio ?? 0) > 0.35 && (items[0].progressRatio ?? 0) < 0.37);

  assert.equal(items[1].kind, "series");
  assert.equal(items[1].title, "Severance");
  assert.equal(items[1].badgeText, "Resume S01E03");
  assert.equal(items[1].timeLeftLabel, "30m left");
});
