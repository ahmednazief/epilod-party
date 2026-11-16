import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function setupMockLocalStorage(): Map<string, string> {
  const backing = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    get length() {
      return backing.size;
    },
    clear() {
      backing.clear();
    },
    getItem(k: string) {
      return backing.get(k) ?? null;
    },
    key(i: number) {
      return Array.from(backing.keys())[i] ?? null;
    },
    removeItem(k: string) {
      backing.delete(k);
    },
    setItem(k: string, v: string) {
      backing.set(k, String(v));
    },
  };
  return backing;
}

interface BundledIntroModules {
  introActions: typeof import("../src/lib/introActions");
  introStore: typeof import("../src/store/useIntroStore");
  appStore: typeof import("../src/store/useAppStore");
  playerStore: typeof import("../src/store/usePlayerStore");
  syncStore: typeof import("../src/store/useSyncStore");
  shortcuts: typeof import("../src/lib/shortcuts");
}

async function loadBundledIntroModules(): Promise<BundledIntroModules> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-intro-test-"));
  try {
    const entryFile = path.join(outDir, "entry.ts");
    const outFile = path.join(outDir, "bundle.mjs");
    fs.writeFileSync(
      entryFile,
      [
        `export * as introActions from ${JSON.stringify(path.join(REPO_ROOT, "src/lib/introActions.ts"))};`,
        `export * as introStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/useIntroStore.ts"))};`,
        `export * as appStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/useAppStore.ts"))};`,
        `export * as playerStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/usePlayerStore.ts"))};`,
        `export * as syncStore from ${JSON.stringify(path.join(REPO_ROOT, "src/store/useSyncStore.ts"))};`,
        `export * as shortcuts from ${JSON.stringify(path.join(REPO_ROOT, "src/lib/shortcuts.ts"))};`,
      ].join("\n"),
      "utf8"
    );
    buildSync({
      entryPoints: [entryFile],
      outfile: outFile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
    });
    return (await import(pathToFileURL(outFile).href)) as BundledIntroModules;
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

test("useIntroStore caches detected intros per file, handles manual override, and useAppStore persists skipIntroMode", async () => {
  const ls = setupMockLocalStorage();
  const { appStore, introStore } = await loadBundledIntroModules();

  const app = appStore.useAppStore.getState();
  assert.equal(app.skipIntroMode, "manual");

  app.setSkipIntroMode("auto");
  assert.equal(ls.get("ep.skipIntroMode"), "auto");
  assert.equal(appStore.useAppStore.getState().skipIntroMode, "auto");

  app.setSkipIntroMode("off");
  assert.equal(ls.get("ep.skipIntroMode"), "off");
  assert.equal(appStore.useAppStore.getState().skipIntroMode, "off");

  // Legacy localStorage keys migrate seamlessly when ep.skipIntroMode is absent
  ls.clear();
  ls.set("ep.smartIntro", "true");
  ls.set("ep.autoSkipIntro", "true");
  const migratedAuto = await loadBundledIntroModules();
  assert.equal(migratedAuto.appStore.useAppStore.getState().skipIntroMode, "auto");

  ls.clear();
  ls.set("ep.smartIntro", "false");
  const migratedOff = await loadBundledIntroModules();
  assert.equal(migratedOff.appStore.useAppStore.getState().skipIntroMode, "off");

  app.setSelectedFile("D:\\Series\\Show.S01E01.mkv", "Show.S01E01.mkv");
  const intro = introStore.useIntroStore.getState();
  assert.equal(intro.videoKey, "d:\\series\\show.s01e01.mkv");

  intro.setDetectedOutcome("D:\\Series\\Show.S01E01.mkv", {
    segments: [
      {
        startSecs: 18,
        endSecs: 108,
        skipTargetSecs: 108,
        kind: "intro",
        source: "audioMatch",
        confidence: "high",
        label: "Skip Intro",
        similarity: 0.91,
        matchedEpisodes: 3,
      },
    ],
    primaryIntro: {
      startSecs: 18,
      endSecs: 108,
      skipTargetSecs: 108,
      kind: "intro",
      source: "audioMatch",
      confidence: "high",
      label: "Skip Intro",
      similarity: 0.91,
      matchedEpisodes: 3,
    },
  });
  assert.equal(introStore.useIntroStore.getState().segments.length, 1);

  // Manual override supersedes detected intro bounds until cleared
  introStore.useIntroStore.getState().markManualStart(25);
  introStore.useIntroStore.getState().markManualEnd(115);
  let effective = introStore.getEffectiveIntroSegments(
    introStore.useIntroStore.getState().segments,
    introStore.useIntroStore.getState().manualIntro
  );
  assert.equal(effective[0]?.source, "manual");
  assert.equal(effective[0]?.startSecs, 25);
  assert.equal(effective[0]?.skipTargetSecs, 115);

  introStore.useIntroStore.getState().clearManualIntro();
  effective = introStore.getEffectiveIntroSegments(
    introStore.useIntroStore.getState().segments,
    introStore.useIntroStore.getState().manualIntro
  );
  assert.equal(effective[0]?.source, "audioMatch");

  // Switching away & returning restores cached audioMatch intro instantly
  appStore.useAppStore.getState().setSelectedFile("D:\\Series\\Other.mkv", "Other.mkv");
  assert.equal(introStore.useIntroStore.getState().segments.length, 0);

  appStore.useAppStore.getState().setSelectedFile("d:\\series\\show.s01e01.mkv", "Show.S01E01.mkv");
  assert.equal(introStore.useIntroStore.getState().segments.length, 1);
  assert.equal(introStore.useIntroStore.getState().segments[0]?.startSecs, 18);
});

test("introActions skips in Solo and Watch Party, enforces controller lock, and honors alignMode", async () => {
  setupMockLocalStorage();
  const { appStore, introActions, introStore, playerStore, syncStore } =
    await loadBundledIntroModules();

  const introSeg = {
    startSecs: 20,
    endSecs: 110,
    skipTargetSecs: 110,
    kind: "intro" as const,
    source: "chapter" as const,
    confidence: "high" as const,
    label: "Skip Intro",
    similarity: null,
    matchedEpisodes: 1,
  };

  assert.equal(introActions.findActiveIntroAt(18.0, [introSeg]), null);
  assert.equal(introActions.findActiveIntroAt(18.6, [introSeg])?.startSecs, 20);
  assert.equal(introActions.findActiveIntroAt(50, [introSeg])?.endSecs, 110);
  assert.equal(introActions.findActiveIntroAt(109.0, [introSeg]), null);
  assert.equal(introActions.findSkippableIntroAt(5, [introSeg])?.startSecs, 20);

  appStore.useAppStore.getState().setUsername("HostUser");
  appStore.useAppStore.getState().setSelectedFile("D:\\Show\\Ep1.mkv", "Ep1.mkv");
  introStore.useIntroStore.getState().setDetectedOutcome("D:\\Show\\Ep1.mkv", {
    segments: [introSeg],
    primaryIntro: introSeg,
  });

  const calls: { local: number[]; sync: number[] } = { local: [], sync: [] };
  const deps = {
    seekLocal: (s: number) => {
      calls.local.push(s);
    },
    seekSync: (s: number) => {
      calls.sync.push(s);
    },
  };

  // 1. Solo playback
  playerStore.usePlayerStore.getState().setLoaded(true);
  playerStore.usePlayerStore.getState().setDurationSecs(1420);
  playerStore.usePlayerStore.getState().setPositionSecs(24);
  syncStore.useSyncStore.getState().reset();

  const soloOk = await introActions.skipActiveOrUpcomingIntro(deps);
  assert.equal(soloOk, true);
  assert.deepEqual(calls.local, [110]);
  assert.deepEqual(calls.sync, []);
  assert.equal(playerStore.usePlayerStore.getState().positionSecs, 110);
  assert.equal(playerStore.usePlayerStore.getState().feedback?.text, "Skipped intro");

  // 2. Watch Party unlocked host seeks room too
  calls.local.length = 0;
  calls.sync.length = 0;
  playerStore.usePlayerStore.getState().setPositionSecs(30);
  syncStore.useSyncStore.getState().setStatus({
    state: "connected",
    endpoint: "syncplay.pl:8999",
    tls: true,
    username: "HostUser",
  });
  syncStore.useSyncStore.getState().setParticipants([
    {
      username: "HostUser",
      room: "ep-1",
      position: 30,
      fileName: "Ep1.mkv",
      fileDuration: 1420,
      isReady: true,
      isController: true,
      fileMatch: "matched",
    },
    {
      username: "Guest",
      room: "ep-1",
      position: 30,
      fileName: "Ep1.mkv",
      fileDuration: 1420,
      isReady: true,
      isController: false,
      fileMatch: "matched",
    },
  ]);

  const partyOk = await introActions.executeSkipIntro(introSeg, deps);
  assert.equal(partyOk, true);
  assert.deepEqual(calls.local, [110]);
  assert.deepEqual(calls.sync, [110]);

  // 3. Locked Watch Party guest is blocked unless alignMode is enabled
  calls.local.length = 0;
  calls.sync.length = 0;
  playerStore.usePlayerStore.getState().setPositionSecs(32);
  appStore.useAppStore.getState().setUsername("Guest");
  syncStore.useSyncStore.getState().setStatus({
    state: "connected",
    endpoint: "syncplay.pl:8999",
    tls: true,
    username: "Guest",
  });
  syncStore.useSyncStore.getState().setParticipants([
    {
      username: "HostUser",
      room: "ep-1",
      position: 32,
      fileName: "Ep1.mkv",
      fileDuration: 1420,
      isReady: true,
      isController: true,
      fileMatch: "matched",
    },
    {
      username: "Guest",
      room: "ep-1",
      position: 32,
      fileName: "Ep1.mkv",
      fileDuration: 1420,
      isReady: true,
      isController: false,
      fileMatch: "matched",
    },
  ]);

  const blockedOk = await introActions.executeSkipIntro(introSeg, deps);
  assert.equal(blockedOk, false);
  assert.deepEqual(calls.local, []);
  assert.deepEqual(calls.sync, []);
  assert.match(playerStore.usePlayerStore.getState().feedback?.text ?? "", /Controlled by HostUser/);

  // With alignMode on, guest adjusts local timeline without broadcasting sync seek
  syncStore.useSyncStore.getState().setAlignMode(true);
  const alignOk = await introActions.executeSkipIntro(introSeg, deps);
  assert.equal(alignOk, true);
  assert.deepEqual(calls.local, [110]);
  assert.deepEqual(calls.sync, []);
});

test("Shortcuts, UI components, WatchRoom, and Rust IPC wire Smart Skip Intro cleanly", async () => {
  setupMockLocalStorage();
  const { shortcuts } = await loadBundledIntroModules();

  const skipSpec = shortcuts.PLAYER_SHORTCUTS.find((s) => s.keys.includes("I"));
  assert.ok(skipSpec, "PLAYER_SHORTCUTS documents I key for Skip detected intro");
  assert.equal(skipSpec.category, "Playback");

  const overlaySrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SkipIntroOverlay.tsx"),
    "utf8"
  );
  assert.match(overlaySrc, /data-glass-region="true"/);
  assert.match(overlaySrc, /ep:glass-layout/);
  assert.match(overlaySrc, /ep-glass-liquid-pill/);
  assert.match(overlaySrc, /PlayerSkipIntroIcon/);
  assert.match(overlaySrc, /max-w-\[1140px\]/);
  assert.doesNotMatch(overlaySrc, /transition-(colors|all|transform)/);
  assert.doesNotMatch(overlaySrc, /ep-glass-primary-pill|ep-glass-capsule|AppCloseIcon|Cancel|violet/);

  const settingsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/SettingsModal.tsx"),
    "utf8"
  );
  assert.match(settingsSrc, /Skip Intro/);
  assert.match(settingsSrc, /"manual", label: "Manual"/);
  assert.match(settingsSrc, /"auto", label: "Auto-Skip"/);
  assert.doesNotMatch(settingsSrc, /Smart Intro Detection|Auto-Skip Detected Intros/);

  const playbackSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/PlaybackPanel.tsx"),
    "utf8"
  );
  assert.doesNotMatch(playbackSrc, /Smart Intro|Mark Start|Mark End|autoSkipIntro/);

  const iconsSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/ui/PlayerIcons.tsx"),
    "utf8"
  );
  const skipIconSection = iconsSrc.slice(
    iconsSrc.indexOf("export function PlayerSkipIntroIcon"),
    iconsSrc.indexOf("export function PlayerReactionsIcon")
  );
  assert.doesNotMatch(skipIconSection, /#A78BFA|#DDD6FE/i);

  const globalsCss = fs.readFileSync(
    path.join(REPO_ROOT, "src/styles/globals.css"),
    "utf8"
  );
  const liquidPillBlock = globalsCss.slice(
    globalsCss.indexOf(".ep-glass-liquid-pill"),
    globalsCss.indexOf(".ep-glass-tray")
  );
  assert.doesNotMatch(liquidPillBlock, /124,\s*58,\s*237|139,\s*92,\s*246|167,\s*139,\s*250|221,\s*214,\s*254|237,\s*233,\s*254/);

  const shortcutsHookSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/hooks/usePlayerShortcuts.ts"),
    "utf8"
  );
  assert.match(shortcutsHookSrc, /e\.code === "KeyI"/);
  assert.match(shortcutsHookSrc, /skipActiveOrUpcomingIntro/);

  const watchRoomSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/WatchRoom.tsx"),
    "utf8"
  );
  assert.match(watchRoomSrc, /onMpvChapters/);
  assert.match(watchRoomSrc, /detectVideoIntro/);
  assert.match(watchRoomSrc, /<SkipIntroOverlay/);

  const transportSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/components/TransportBar.tsx"),
    "utf8"
  );
  const outerBody = transportSrc.slice(transportSrc.indexOf("export const TransportBar"));
  assert.doesNotMatch(
    outerBody,
    /usePlayerStore\(\s*\(?s\)?\s*=>\s*s\.positionSecs/,
    "TransportBar outer component must never subscribe to high-rate positionSecs"
  );
});
