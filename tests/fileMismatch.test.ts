import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type { Participant } from "../src/lib/syncplay";
import type { PlaylistItem } from "../src/lib/playlist";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadMismatchBundle() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-file-mismatch-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * as fileMismatch from "./src/lib/fileMismatch.ts";
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
      fileMismatch: typeof import("../src/lib/fileMismatch");
      useSyncStore: typeof import("../src/store/useSyncStore")["useSyncStore"];
    };
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

function makeParticipant(overrides: Partial<Participant> & { username: string }): Participant {
  return {
    room: "party",
    position: 0,
    fileName: null,
    fileDuration: null,
    isReady: true,
    isController: false,
    fileMatch: "matched",
    ...overrides,
  };
}

function makePlaylistItem(index: number, fileName: string, episodeBadge: string | null = null): PlaylistItem {
  return {
    path: `/shows/Series/${fileName}`,
    fileName,
    cleanTitle: fileName.replace(/\.[^.]+$/, ""),
    season: 1,
    episode: index + 1,
    episodeBadge,
    subtitlePath: null,
  };
}

test("analyzePartyFileMismatch handles disconnected, empty, and localLoading states without false alarms", async () => {
  const { fileMismatch } = await loadMismatchBundle();

  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: false,
      participants: [makeParticipant({ username: "Alice", fileName: "Show.S01E02.mkv", fileMatch: "noFile" })],
      localUsername: "Me",
      localLoaded: false,
      localFileName: null,
    }),
    null,
  );

  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: true,
      participants: [makeParticipant({ username: "Me", fileName: null, fileMatch: "noFile" })],
      localUsername: "Me",
      localLoaded: false,
      localFileName: null,
    }),
    null,
  );

  // Remote peer has not opened anything yet
  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: true,
      participants: [
        makeParticipant({ username: "Me", fileName: null, fileMatch: "noFile" }),
        makeParticipant({ username: "Alice", fileName: null, fileMatch: "noFile" }),
      ],
      localUsername: "Me",
      localLoaded: false,
      localFileName: null,
    }),
    null,
  );

  // Suppress while local video is mid-load
  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: true,
      participants: [
        makeParticipant({ username: "Me", fileName: null, fileMatch: "noFile" }),
        makeParticipant({ username: "Alice", fileName: "Show.S01E02.mkv", fileMatch: "noFile" }),
      ],
      localUsername: "Me",
      localLoaded: false,
      localFileName: "Show.S01E02.mkv",
      localLoading: true,
    }),
    null,
  );
});

test("analyzePartyFileMismatch detects notOpenOnPc across single, multiple, private-hashed peers, and playlist matches", async () => {
  const { fileMismatch } = await loadMismatchBundle();
  const playlist = [
    makePlaylistItem(0, "Frieren.S01E01.mkv", "S01E01"),
    makePlaylistItem(1, "Frieren.S01E02.mkv", "S01E02"),
  ];

  // Single peer with readable episode and matching local playlist item
  const single = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({ username: "Me", fileName: null, fileMatch: "noFile" }),
      makeParticipant({
        username: "HostAlice",
        isController: true,
        fileName: "Frieren.S01E02.1080p.mkv",
        fileMatch: "noFile",
      }),
    ],
    localUsername: "Me",
    localLoaded: false,
    localFileName: null,
    playlistItems: playlist,
  });
  assert.ok(single);
  assert.equal(single.kind, "notOpenOnPc");
  assert.equal(single.title, "Video not open on your PC");
  assert.match(single.message, /HostAlice opened “.*S01E02.*”, which isn't open on your PC\./);
  assert.equal(single.matchedPlaylistItem?.index, 1);
  assert.equal(single.matchedPlaylistItem?.label, "S01E02");
  assert.ok(single.signature.startsWith("notOpen|"));

  // Multiple peers sharing the same title
  const samePeers = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({ username: "Alice", fileName: "Frieren.S01E02.mkv", fileMatch: "noFile" }),
      makeParticipant({ username: "Bob", fileName: "Frieren.S01E02.mkv", fileMatch: "noFile" }),
    ],
    localUsername: "Me",
    localLoaded: false,
    localFileName: null,
  });
  assert.ok(samePeers);
  assert.equal(samePeers.kind, "notOpenOnPc");
  assert.match(samePeers.message, /^Alice and Bob have “.*” open, which isn't open on your PC\.$/);

  // Multiple peers with different files
  const diffPeers = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({ username: "Alice", isController: true, fileName: "Frieren.S01E02.mkv", fileMatch: "noFile" }),
      makeParticipant({ username: "Bob", fileName: "Dune.Part.Two.mkv", fileMatch: "noFile" }),
    ],
    localUsername: "Me",
    localLoaded: false,
    localFileName: null,
  });
  assert.ok(diffPeers);
  assert.equal(diffPeers.kind, "notOpenOnPc");
  assert.equal(diffPeers.message, "Alice and Bob have videos open that aren't open on your PC.");

  // Privacy-hashed peer filename never leaks raw hash
  const rawHash = "9a4f02c1b8e3";
  assert.equal(fileMismatch.isHashedFileName(rawHash), true);
  assert.equal(fileMismatch.isHashedFileName("Movie.2024.mkv"), false);

  const privatePeer = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({ username: "Zoe", fileName: rawHash, fileMatch: "noFile" }),
    ],
    localUsername: "Me",
    localLoaded: false,
    localFileName: null,
  });
  assert.ok(privatePeer);
  assert.equal(privatePeer.kind, "notOpenOnPc");
  assert.equal(privatePeer.message, "Zoe has a video open that isn't open on your PC.");
  assert.equal(privatePeer.message.includes(rawHash), false);
});

test("analyzePartyFileMismatch detects differentFile, respects controller priority, hashes, playlist index, and noFile race", async () => {
  const { fileMismatch } = await loadMismatchBundle();
  const playlist = [
    makePlaylistItem(0, "Frieren.S01E01.mkv", "S01E01"),
    makePlaylistItem(1, "Frieren.S01E02.mkv", "S01E02"),
  ];

  // Brief roundtrip race: local loaded but peer still reports noFile -> no false alarm
  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: true,
      participants: [
        makeParticipant({ username: "Me", fileName: "Frieren.S01E01.mkv", fileMatch: "matched" }),
        makeParticipant({ username: "Alice", fileName: "Frieren.S01E02.mkv", fileMatch: "noFile" }),
      ],
      localUsername: "Me",
      localLoaded: true,
      localFileName: "Frieren.S01E01.mkv",
    }),
    null,
  );

  // Different file with controller prioritized over non-controller
  const diff = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({ username: "Me", fileName: "Frieren.S01E01.mkv", fileMatch: "matched" }),
      makeParticipant({ username: "Bob", fileName: "Other.Movie.mkv", fileMatch: "differentFile" }),
      makeParticipant({
        username: "HostAlice",
        isController: true,
        fileName: "Frieren.S01E02.mkv",
        fileMatch: "differentFile",
      }),
    ],
    localUsername: "Me",
    localLoaded: true,
    localFileName: "Frieren.S01E01.mkv",
    playlistItems: playlist,
    currentPlaylistIndex: 0,
  });
  assert.ok(diff);
  assert.equal(diff.kind, "differentFile");
  assert.equal(diff.title, "Different video open");
  assert.equal(diff.peerChipOwner, "HostAlice");
  assert.equal(diff.matchedPlaylistItem?.index, 1);
  assert.ok(diff.localChip);
  assert.ok(diff.peerChip);
  assert.match(diff.message, /opened a different video than your/);

  // Same episode already selected on currentPlaylistIndex suppresses duplicate Switch button
  const samePlaylistIdx = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({
        username: "HostAlice",
        isController: true,
        fileName: "Frieren.S01E02.mkv",
        fileMatch: "differentFile",
      }),
    ],
    localUsername: "Me",
    localLoaded: true,
    localFileName: "Frieren.S01E01.mkv",
    playlistItems: playlist,
    currentPlaylistIndex: 1,
  });
  assert.ok(samePlaylistIdx);
  assert.equal(samePlaylistIdx.matchedPlaylistItem, null);

  // Private peer hash in differentFile mode masks hash
  const privHash = "abcdef012345";
  const privDiff = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({
        username: "Zoe",
        fileName: privHash,
        fileMatch: "differentFile",
      }),
    ],
    localUsername: "Me",
    localLoaded: true,
    localFileName: "My.Movie.2024.mkv",
  });
  assert.ok(privDiff);
  assert.equal(privDiff.peerChip, "Private video");
  assert.equal(privDiff.peerChipTitle, "Title hidden by privacy setting");
  assert.equal(privDiff.message.includes(privHash), false);
});

test("analyzePartyFileMismatch respects sourceRelation alignment, calibration, sameLengthDifferentEncode, and differentMedia", async () => {
  const { fileMismatch } = await loadMismatchBundle();

  // sameLengthDifferentEncode does not warn
  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: true,
      participants: [
        makeParticipant({
          username: "Alice",
          fileName: "Movie.x265.mkv",
          fileMatch: "sameLengthDifferentEncode",
          sourceRelation: "differentEncode",
        }),
      ],
      localUsername: "Me",
      localLoaded: true,
      localFileName: "Movie.BluRay.mkv",
    }),
    null,
  );

  // differentCut warns until aligned
  const cutWarning = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({
        username: "Alice",
        fileName: "Movie.Extended.mkv",
        fileMatch: "durationMismatch",
        sourceRelation: "differentCut",
        durationDeltaSecs: 120,
      }),
    ],
    localUsername: "Me",
    localLoaded: true,
    localFileName: "Movie.Theatrical.mkv",
    aligned: false,
  });
  assert.ok(cutWarning);
  assert.equal(cutWarning.kind, "durationMismatch");
  assert.equal(cutWarning.title, "Different cut or video length");
  assert.equal(cutWarning.deltaBadge, "+2m");

  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: true,
      participants: [
        makeParticipant({
          username: "Alice",
          fileName: "Movie.Extended.mkv",
          fileMatch: "durationMismatch",
          sourceRelation: "differentCut",
          durationDeltaSecs: 120,
        }),
      ],
      localUsername: "Me",
      localLoaded: true,
      localFileName: "Movie.Theatrical.mkv",
      aligned: true,
    }),
    null,
  );

  // fpsMismatch warns until scaleCalibrated
  const fpsWarning = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({
        username: "Alice",
        fileName: "Movie.PAL.25fps.mkv",
        fileMatch: "durationMismatch",
        sourceRelation: "fpsMismatch",
        durationDeltaSecs: -185,
        suggestedFpsScale: 0.95904,
        suggestedFpsLabel: "25 -> 23.976 fps",
      }),
    ],
    localUsername: "Me",
    localLoaded: true,
    localFileName: "Movie.NTSC.23976fps.mkv",
    scaleCalibrated: false,
  });
  assert.ok(fpsWarning);
  assert.equal(fpsWarning.kind, "fpsMismatch");
  assert.equal(fpsWarning.title, "Different frame rate or speed");
  assert.equal(fpsWarning.deltaBadge, "−3m 5s");
  assert.equal(fpsWarning.suggestedFpsScale, 0.95904);
  assert.equal(fpsWarning.suggestedFpsLabel, "25 -> 23.976 fps");

  assert.equal(
    fileMismatch.analyzePartyFileMismatch({
      syncConnected: true,
      participants: [
        makeParticipant({
          username: "Alice",
          fileName: "Movie.PAL.25fps.mkv",
          fileMatch: "durationMismatch",
          sourceRelation: "fpsMismatch",
          durationDeltaSecs: -185,
          suggestedFpsScale: 0.95904,
          suggestedFpsLabel: "25 -> 23.976 fps",
        }),
      ],
      localUsername: "Me",
      localLoaded: true,
      localFileName: "Movie.NTSC.23976fps.mkv",
      scaleCalibrated: true,
    }),
    null,
  );

  // durationMismatch + differentMedia elevates to differentFile
  const diffMedia = fileMismatch.analyzePartyFileMismatch({
    syncConnected: true,
    participants: [
      makeParticipant({
        username: "Alice",
        fileName: "Totally.Other.Film.mkv",
        fileMatch: "durationMismatch",
        sourceRelation: "differentMedia",
        durationDeltaSecs: 900,
      }),
    ],
    localUsername: "Me",
    localLoaded: true,
    localFileName: "My.Film.mkv",
  });
  assert.ok(diffMedia);
  assert.equal(diffMedia.kind, "differentFile");
  assert.equal(diffMedia.title, "Different video open");
});

test("formatParticipantMatchBadge, formatDurationDelta, and useSyncStore dismiss state behave accurately", async () => {
  const { fileMismatch, useSyncStore } = await loadMismatchBundle();

  assert.equal(fileMismatch.formatDurationDelta(14.6), "15s");
  assert.equal(fileMismatch.formatDurationDelta(120), "2m");
  assert.equal(fileMismatch.formatDurationDelta(-125), "2m 5s");
  assert.equal(fileMismatch.formatDurationDelta(3900), "1h 5m");

  assert.deepEqual(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({ username: "Me", fileName: null }),
      { localHasFile: false, isSelf: true },
    ),
    { text: "No video open", className: "text-muted", isMismatch: false },
  );
  assert.deepEqual(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({ username: "Me", fileName: "Ep1.mkv" }),
      { localHasFile: true, isSelf: true },
    ),
    { text: "In sync", className: "text-ok", isMismatch: false },
  );
  assert.deepEqual(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({ username: "Alice", fileName: null, fileMatch: "noFile" }),
      { localHasFile: false, isSelf: false },
    ),
    { text: "Picking a video…", className: "text-muted", isMismatch: false },
  );
  assert.deepEqual(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({ username: "Alice", fileName: "Ep1.mkv", fileMatch: "noFile" }),
      { localHasFile: false, isSelf: false },
    ),
    { text: "Not open on your PC", className: "text-warn", isMismatch: true },
  );
  assert.deepEqual(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({ username: "Alice", fileName: "Ep1.mkv", fileMatch: "sameLengthDifferentEncode" }),
      { localHasFile: true, isSelf: false, aligned: false },
    ),
    { text: "Different format", className: "text-secondary", isMismatch: false },
  );
  assert.deepEqual(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({ username: "Alice", fileName: "Ep1.mkv", fileMatch: "sameLengthDifferentEncode" }),
      { localHasFile: true, isSelf: false, aligned: true },
    ),
    { text: "Aligned", className: "text-ok", isMismatch: false },
  );
  assert.equal(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({
        username: "Alice",
        fileName: "Ep1.mkv",
        fileMatch: "durationMismatch",
        sourceRelation: "differentCut",
        durationDeltaSecs: 45,
      }),
      { localHasFile: true, isSelf: false, aligned: false },
    ).isMismatch,
    true,
  );
  assert.equal(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({
        username: "Alice",
        fileName: "Ep1.mkv",
        fileMatch: "durationMismatch",
        sourceRelation: "differentCut",
        durationDeltaSecs: 45,
      }),
      { localHasFile: true, isSelf: false, aligned: true },
    ).text,
    "Aligned",
  );
  assert.equal(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({
        username: "Alice",
        fileName: "Ep1.mkv",
        fileMatch: "durationMismatch",
        sourceRelation: "fpsMismatch",
        suggestedFpsLabel: "25 -> 23.976 fps",
      }),
      { localHasFile: true, isSelf: false, scaleCalibrated: false },
    ).text,
    "25 -> 23.976 fps",
  );
  assert.equal(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({
        username: "Alice",
        fileName: "Ep1.mkv",
        fileMatch: "durationMismatch",
        sourceRelation: "fpsMismatch",
      }),
      { localHasFile: true, isSelf: false, scaleCalibrated: true },
    ).text,
    "FPS matched",
  );
  assert.deepEqual(
    fileMismatch.formatParticipantMatchBadge(
      makeParticipant({ username: "Alice", fileName: "Ep2.mkv", fileMatch: "differentFile" }),
      { localHasFile: true, isSelf: false },
    ),
    { text: "Different video", className: "text-warn", isMismatch: true },
  );

  // Store dismiss signature resets cleanly on reset()
  useSyncStore.getState().setDismissedMismatchSig("notOpen|alice:ep1.mkv");
  assert.equal(useSyncStore.getState().dismissedMismatchSig, "notOpen|alice:ep1.mkv");
  useSyncStore.getState().reset();
  assert.equal(useSyncStore.getState().dismissedMismatchSig, null);
});

test("FileMismatchBanner, RoomPanel, TransportBar, WatchRoom, and globals.css wire liquid glass mismatch warnings", () => {
  const banner = fs.readFileSync(path.join(REPO_ROOT, "src/components/FileMismatchBanner.tsx"), "utf8");
  assert.equal(banner.includes('data-glass-region="true"'), true);
  assert.equal(banner.includes("ep-glass-warning"), true);
  assert.equal(banner.includes("usePresencePayload"), true);
  assert.equal(banner.includes('role="alert"'), true);
  assert.equal(banner.includes('aria-live="polite"'), true);

  const roomPanel = fs.readFileSync(path.join(REPO_ROOT, "src/components/RoomPanel.tsx"), "utf8");
  assert.equal(roomPanel.includes("ep-glass-warning-inline"), true);
  assert.equal(roomPanel.includes("formatParticipantMatchBadge"), true);
  assert.equal(roomPanel.includes("formatReadableMediaName"), true);
  assert.equal(roomPanel.includes("onSwitchEpisode"), true);
  assert.equal(roomPanel.includes("badge.isMismatch"), true);
  assert.equal(roomPanel.includes("max-h-40 overflow-y-auto"), false);

  const transportBar = fs.readFileSync(path.join(REPO_ROOT, "src/components/TransportBar.tsx"), "utf8");
  assert.equal(transportBar.includes("usePartyFileMismatch"), true);
  assert.equal(transportBar.includes("formatParticipantMatchBadge"), true);
  assert.equal(transportBar.includes("bg-warn"), true);

  const watchRoom = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.equal(watchRoom.includes("<FileMismatchBanner"), true);
  assert.equal(watchRoom.includes("usePartyFileMismatch"), true);
  assert.equal(watchRoom.includes("Boolean(visibleFileMismatch)"), true);
  assert.equal(watchRoom.includes("switchToPartyEpisode"), true);
  assert.equal(watchRoom.includes("<NotificationStrip inline />"), true);
  const appSrc = fs.readFileSync(path.join(REPO_ROOT, "src/App.tsx"), "utf8");
  assert.equal(appSrc.includes("<NotificationStrip"), true);
  const notifSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/NotificationStrip.tsx"), "utf8");
  assert.equal(notifSrc.includes('belowTitleBar ? "top-14" : "top-4"'), true);

  const css = fs.readFileSync(path.join(REPO_ROOT, "src/styles/globals.css"), "utf8");
  assert.equal(css.includes(".ep-glass-warning {"), true);
  assert.equal(css.includes(".ep-glass-warning-inline {"), true);
  assert.equal(css.includes(".ep-warning-badge {"), true);
  assert.equal(css.includes(".ep-warning-action {"), true);
});
