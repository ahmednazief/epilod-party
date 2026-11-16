import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";
import type { Participant, SyncStatusPayload } from "../src/lib/syncplay";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function bundleAndImport<T>(entryRel: string): Promise<T> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-sfx-test-"));
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

function makePeer(username: string, isReady = false): Participant {
  return {
    username,
    room: "ep-123456",
    position: 0,
    fileName: "Movie.mkv",
    fileDuration: 5400,
    isReady,
    isController: false,
    fileMatch: "matched",
  };
}

const CONNECTED_STATUS: SyncStatusPayload = {
  state: "connected",
  endpoint: "syncplay.pl:8999",
  tls: true,
  username: "Me",
};

test("RoomSoundTracker emits roomConnected without spamming initial peers, and tracks joins/leaves", async () => {
  const { RoomSoundTracker } = await bundleAndImport<typeof import("../src/lib/soundEffects")>(
    "src/lib/soundEffects.ts",
  );

  const tracker = new RoomSoundTracker();

  assert.deepEqual(
    tracker.update({ state: "connecting", endpoint: "syncplay.pl:8999", attempt: 1 }, [], "Me", 1000),
    [],
  );

  // Connecting fires roomConnected once
  assert.deepEqual(tracker.update(CONNECTED_STATUS, [], "Me", 1100), ["roomConnected"]);

  // First roster snapshot seeds baseline peers silently
  assert.deepEqual(
    tracker.update(CONNECTED_STATUS, [makePeer("Me", false), makePeer("Alice", false)], "Me", 1200),
    [],
  );

  // Friend joins after room is established
  assert.deepEqual(
    tracker.update(
      CONNECTED_STATUS,
      [makePeer("Me", false), makePeer("Alice", false), makePeer("Bob", false)],
      "Me",
      2500,
    ),
    ["peerJoined"],
  );

  // Friend leaves
  assert.deepEqual(
    tracker.update(CONNECTED_STATUS, [makePeer("Me", false), makePeer("Alice", false)], "Me", 4000),
    ["peerLeft"],
  );
});

test("RoomSoundTracker suppresses rapid reconnect flaps and emits peerReady vs allReady cleanly", async () => {
  const { RoomSoundTracker } = await bundleAndImport<typeof import("../src/lib/soundEffects")>(
    "src/lib/soundEffects.ts",
  );

  const tracker = new RoomSoundTracker();
  tracker.update(CONNECTED_STATUS, [makePeer("Me", true), makePeer("Alice", false)], "Me", 1000);

  // Alice drops briefly and reconnects within 4000ms -> peerLeft fires, rejoin chime is suppressed
  assert.deepEqual(tracker.update(CONNECTED_STATUS, [makePeer("Me", true)], "Me", 3000), [
    "peerLeft",
  ]);
  assert.deepEqual(
    tracker.update(CONNECTED_STATUS, [makePeer("Me", true), makePeer("Alice", false)], "Me", 5000),
    [],
  );

  // When Bob joins fresh at t=8000 (not flapping), peerJoined fires
  assert.deepEqual(
    tracker.update(
      CONNECTED_STATUS,
      [makePeer("Me", true), makePeer("Alice", false), makePeer("Bob", false)],
      "Me",
      8000,
    ),
    ["peerJoined"],
  );

  // Alice readies while Bob is not ready yet -> peerReady fires
  assert.deepEqual(
    tracker.update(
      CONNECTED_STATUS,
      [makePeer("Me", true), makePeer("Alice", true), makePeer("Bob", false)],
      "Me",
      10000,
    ),
    ["peerReady"],
  );

  // Bob readies last -> everyone in the room is now Ready -> allReady shimmer fires alone
  assert.deepEqual(
    tracker.update(
      CONNECTED_STATUS,
      [makePeer("Me", true), makePeer("Alice", true), makePeer("Bob", true)],
      "Me",
      11500,
    ),
    ["allReady"],
  );

  // Own connection drop never emits peerLeft for remaining friends
  assert.deepEqual(
    tracker.update(
      {
        state: "reconnecting",
        endpoint: "syncplay.pl:8999",
        attempt: 1,
        retryInSecs: 1,
        suggestBackup: false,
      },
      [],
      "Me",
      13000,
    ),
    [],
  );
});

test("useAppStore soundEffectsEnabled defaults true and SettingsModal exposes Subtle Party Sound Cues", async () => {
  const { useAppStore } = await bundleAndImport<typeof import("../src/store/useAppStore")>(
    "src/store/useAppStore.ts",
  );

  assert.equal(useAppStore.getState().soundEffectsEnabled, true);
  useAppStore.getState().setSoundEffectsEnabled(false);
  assert.equal(useAppStore.getState().soundEffectsEnabled, false);
  useAppStore.getState().setSoundEffectsEnabled(true);
  assert.equal(useAppStore.getState().soundEffectsEnabled, true);

  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8",
  );
  assert.equal(settingsSrc.includes("Subtle Party Sound Cues"), true);
});

test("playReactionSoundCue synthesizes throttled subtle liquid pops, ducks during playback, and respects soundEffectsEnabled", async () => {
  const { playReactionSoundCue } = await bundleAndImport<typeof import("../src/lib/soundEffects")>(
    "src/lib/soundEffects.ts",
  );
  const reactionsSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/reactions.ts"), "utf8");
  assert.equal(reactionsSrc.includes("playReactionSoundCue"), true);
  assert.equal(reactionsSrc.includes("soundMode"), true);

  let oscStarts = 0;
  const recordedPeaks: number[] = [];
  const recordedCutoffs: number[] = [];

  class MockAudioContext {
    state = "running";
    currentTime = 1.0;
    destination = {};
    createBiquadFilter() {
      return {
        type: "lowpass",
        frequency: {
          setValueAtTime: (val: number) => {
            recordedCutoffs.push(val);
          },
        },
        Q: { setValueAtTime: () => undefined },
        connect: () => undefined,
      };
    }
    createGain() {
      return {
        gain: {
          setValueAtTime: () => undefined,
          exponentialRampToValueAtTime: (val: number) => {
            if (val > 0.001) recordedPeaks.push(val);
          },
        },
        connect: () => undefined,
      };
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: {
          setValueAtTime: () => undefined,
          exponentialRampToValueAtTime: () => undefined,
        },
        connect: () => undefined,
        start: () => {
          oscStarts += 1;
        },
        stop: () => undefined,
      };
    }
  }

  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = { AudioContext: MockAudioContext };

  try {
    playReactionSoundCue("❤️", { moviePlaying: false });
    assert.equal(oscStarts, 2, "primary click should create fundamental + crystal overtone");
    const idlePeak = recordedPeaks[0];
    const idleCutoff = recordedCutoffs[0];
    assert.ok(idlePeak < 0.04, "idle reaction SFX must remain subtle");

    // Immediate hold repeat within 145ms throttle should be suppressed
    playReactionSoundCue("❤️", { moviePlaying: false, repeat: true });
    assert.equal(oscStarts, 2);

    // Wait >30ms for manual click while movie is actively playing -> ducked peak & cutoff
    await new Promise((r) => setTimeout(r, 40));
    playReactionSoundCue("😱", { moviePlaying: true });
    assert.equal(oscStarts, 4);
    assert.ok(recordedPeaks[recordedPeaks.length - 1] < idlePeak, "playback should duck SFX gain");
    assert.ok(
      recordedCutoffs[recordedCutoffs.length - 1] < idleCutoff,
      "playback should soften lowpass cutoff",
    );
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as { window?: unknown }).window;
    } else {
      (globalThis as { window?: unknown }).window = prevWindow;
    }
  }
});
