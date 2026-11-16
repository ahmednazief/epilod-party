import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildSync } from "esbuild";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

async function loadModules<T = Record<string, any>>(entryRelPath: string): Promise<T> {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-test-"));
  const outFile = path.join(outDir, "bundle.mjs");
  buildSync({
    entryPoints: [path.join(REPO_ROOT, entryRelPath)],
    outfile: outFile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
  });
  return (await import(pathToFileURL(outFile).href)) as T;
}

test("Fix 02: syncFileAnnounce invalidates key on disconnect and deduplicates jitter", async () => {
  const mod = await loadModules<typeof import("../src/lib/syncFileAnnounce")>(
    "src/lib/syncFileAnnounce.ts",
  );
  const base = {
    syncConnected: true,
    endpoint: "syncplay.pl:8999",
    username: "Ahmed",
    roomCode: "AAAA-BBBB-CCCC",
    fileName: "movie.mkv",
    loaded: true,
    durationSecs: 5400.2,
  };
  const first = mod.shouldAnnounceFile(null, base);
  assert.equal(first.announce, true);
  assert.ok(first.nextKey);

  // Jitter within same second must not re-announce
  const jitter = mod.shouldAnnounceFile(first.nextKey, { ...base, durationSecs: 5400.4 });
  assert.equal(jitter.announce, false);

  // Disconnect clears key so reconnect re-announces the file cleanly
  const dis = mod.shouldAnnounceFile(first.nextKey, { ...base, syncConnected: false });
  assert.equal(dis.announce, false);
  assert.equal(dis.nextKey, null);

  const reconn = mod.shouldAnnounceFile(dis.nextKey, base);
  assert.equal(reconn.announce, true);
});

test("Fix 04: syncStatusDisplay reflects live active endpoint and backup 8998 notice", async () => {
  const mod = await loadModules<typeof import("../src/lib/syncStatusDisplay")>(
    "src/lib/syncStatusDisplay.ts",
  );
  const backup = mod.describeSyncEndpoint(
    {
      state: "connected",
      endpoint: "syncplay.pl:8998",
      tls: true,
      username: "Ahmed",
    },
    "syncplay.pl:8999",
  );
  assert.equal(backup.activeEndpoint, "syncplay.pl:8998");
  assert.equal(backup.isBackupServer, true);
  assert.match(backup.detailText || "", /:8998/);

  const reconnecting = mod.describeSyncEndpoint(
    {
      state: "reconnecting",
      endpoint: "syncplay.pl:8999",
      attempt: 3,
      retryInSecs: 4,
      suggestBackup: true,
    },
    "syncplay.pl:8999",
  );
  assert.match(reconnecting.detailText || "", /backup/i);
});

test("Fix 05 & 06: webviewHardening validates endpoints and preserves literal Syncplay rooms", async () => {
  const mod = await loadModules<typeof import("../src/lib/webviewHardening")>(
    "src/lib/webviewHardening.ts",
  );
  assert.equal(mod.sanitizeRoomCodeInput("My Anime Room (Ep 01)", true), "My Anime Room (Ep 01)");
  assert.equal(mod.sanitizeRoomCodeInput("ab-12!\u202E", false), "AB-12");

  const ok = mod.validateServerEndpointInput("https://syncplay.pl:8998/path");
  assert.equal(ok.ok, true);
  assert.equal(ok.endpoint, "syncplay.pl:8998");

  const defPort = mod.validateServerEndpointInput("syncplay.example.org");
  assert.equal(defPort.ok, true);
  assert.equal(defPort.endpoint, "syncplay.example.org:8999");

  const badPort = mod.validateServerEndpointInput("syncplay.pl:99999");
  assert.equal(badPort.ok, false);
});

test("Fix 08: syncReady requires loaded video and transitions cleanly", async () => {
  const ready = await loadModules<typeof import("../src/lib/syncReady")>("src/lib/syncReady.ts");
  assert.equal(ready.canToggleReady(false), false);
  assert.equal(ready.resolveReadyToggleTarget(false, false), null);
  assert.equal(ready.canToggleReady(true), true);
  assert.equal(ready.resolveReadyToggleTarget(true, false), true);
  assert.equal(
    ready.shouldAutoReadyOnFileLoad({ syncConnected: true, loaded: true, alreadyAutoMarked: false }),
    true,
  );
  assert.equal(
    ready.shouldAutoReadyOnFileLoad({ syncConnected: true, loaded: true, alreadyAutoMarked: true }),
    false,
  );
});

test("Fix 09: syncSpeedGuard locks speed to 1.0x when connected", async () => {
  const guard = await loadModules<typeof import("../src/lib/syncSpeedGuard")>(
    "src/lib/syncSpeedGuard.ts",
  );
  assert.equal(guard.canChangePlaybackSpeed(false, 1.5), true);
  assert.equal(guard.canChangePlaybackSpeed(true, 1.5), false);
  assert.equal(guard.canChangePlaybackSpeed(true, 1.0), true);
  assert.equal(guard.shouldResetSpeedForSync(true, 1.25), true);
  assert.equal(guard.getLockedPlaybackSpeed(true, 2.0), 1.0);
});

test("Fix 10: syncController identifies managed rooms and restricts non-controllers", async () => {
  const ctrl = await loadModules<typeof import("../src/lib/syncController")>(
    "src/lib/syncController.ts",
  );
  const participants = [
    {
      username: "HostUser",
      room: "r",
      position: 10,
      isReady: true,
      isController: true,
      fileMatch: "matched" as const,
    },
    {
      username: "Guest",
      room: "r",
      position: 10,
      isReady: true,
      isController: false,
      fileMatch: "matched" as const,
    },
  ];

  const guestState = ctrl.getControllerLockState(true, participants, "Guest");
  assert.equal(guestState.hasControllers, true);
  assert.equal(guestState.localIsController, false);
  assert.equal(guestState.lockedForLocalUser, true);

  const hostState = ctrl.getControllerLockState(true, participants, "HostUser");
  assert.equal(hostState.localIsController, true);
  assert.equal(hostState.lockedForLocalUser, false);
});

test("Fix 11: playbackEnd distinguishes EOF vs fatal error and handles replay-from-0", async () => {
  const pb = await loadModules<typeof import("../src/lib/playbackEnd")>("src/lib/playbackEnd.ts");
  assert.deepEqual(pb.classifyMpvEnd({ reason: "eof" }), { kind: "eof" });
  assert.deepEqual(pb.classifyMpvEnd({ reason: "stop" }), { kind: "ignore" });
  assert.deepEqual(pb.classifyMpvEnd({ reason: "error", error: "Codec failed" }), {
    kind: "error",
    message: "Codec failed",
  });
  assert.equal(
    pb.shouldReplayFromStart({ endedAtEof: true, paused: true, positionSecs: 10, durationSecs: 100 }),
    true,
  );
  assert.equal(
    pb.shouldReplayFromStart({ endedAtEof: false, paused: false, positionSecs: 100, durationSecs: 100 }),
    false,
  );
});

test("Fix 14 & 15: fullscreenUi & viewportSync handle fullscreen chrome and minimize/restore", async () => {
  const fsUi = await loadModules<typeof import("../src/lib/fullscreenUi")>(
    "src/lib/fullscreenUi.ts",
  );
  assert.deepEqual(fsUi.resolveFullscreenChromeState({ isFullscreen: true, panelOpen: false, modalsOpen: false }), {
    showTopBar: false,
    showPanel: false,
    showTransportBar: true,
  });

  const vp = await loadModules<typeof import("../src/lib/viewportSync")>("src/lib/viewportSync.ts");
  const tracker = new vp.ViewportSyncTracker();
  const bounds = { x: 0, y: 44, width: 1280, height: 720 };
  assert.deepEqual(tracker.planResize(bounds), { send: true, forceFlag: false });
  assert.deepEqual(tracker.planResize(bounds), { send: false, forceFlag: false });

  // Minimize to 0x0 must invalidate cached rect so restoring to identical bounds forces HWND resize
  assert.deepEqual(tracker.planResize({ x: 0, y: 0, width: 0, height: 0 }), {
    send: true,
    forceFlag: false,
  });
  assert.deepEqual(tracker.planResize(bounds), { send: true, forceFlag: true });
});

test("Fix 19: fileDrop reports multi-file counts, folders, and unsupported files", async () => {
  const fd = await loadModules<typeof import("../src/lib/fileDrop")>("src/lib/fileDrop.ts");
  const res = fd.splitDroppedFiles([
    "C:\\Movies\\film.mkv",
    "C:\\Movies\\other.mp4",
    "C:\\Subs\\arabic.srt",
    "C:\\Movies\\FolderName",
    "C:\\Notes\\readme.txt",
  ]);
  assert.equal(res.videoPath, "C:\\Movies\\film.mkv");
  assert.equal(res.subtitlePath, "C:\\Subs\\arabic.srt");
  assert.equal(res.extraVideoCount, 1);
  assert.equal(res.directorySuspected, true);
  assert.deepEqual(res.unsupportedFiles, ["FolderName", "readme.txt"]);
});

test("Fix 20 & 21: shortcut focus guard and SeekAccumulator coalescing window", async () => {
  const sc = await loadModules<typeof import("../src/lib/shortcuts")>("src/lib/shortcuts.ts");
  assert.equal(sc.isTextEntryElement({ tagName: "INPUT" } as unknown as EventTarget), true);
  assert.equal(sc.isTextEntryElement({ tagName: "TEXTAREA" } as unknown as EventTarget), true);
  assert.equal(
    sc.isTextEntryElement({ tagName: "DIV", getAttribute: () => "combobox" } as unknown as EventTarget),
    true,
  );
  assert.equal(sc.isTextEntryElement({ tagName: "BUTTON" } as unknown as EventTarget), false);

  const sk = await loadModules<typeof import("../src/lib/seekCoalesce")>("src/lib/seekCoalesce.ts");
  const acc = new sk.SeekAccumulator(450);
  const t1 = acc.step(5, 100, 300, 1000);
  const t2 = acc.step(5, 100, 300, 1150);
  const t3 = acc.step(5, 100, 300, 1300);
  assert.equal(t1, 105);
  assert.equal(t2, 110);
  assert.equal(t3, 115);

  // Outside coalescing window reads latest reported player position
  const t4 = acc.step(-10, 115, 300, 2000);
  assert.equal(t4, 105);
});

test("Fix 24: tracks.selectSubTrack resets delay cleanly and differentiates embedded/external", async () => {
  const tr = await loadModules<typeof import("../src/lib/tracks")>("src/lib/tracks.ts");
  const calls: string[] = [];
  let savedDelay = 2.4;
  let clearedExt = false;

  await tr.selectSubTrack(
    2,
    [
      { id: 1, type: "sub", title: "Arabic Ext", external: true },
      { id: 2, type: "sub", title: "English", codec: "subrip", external: false },
    ],
    {
      mpvSetSubTrack: async (sid) => {
        calls.push(`sid:${sid}`);
      },
      mpvSetSubDelay: async (d) => {
        calls.push(`delay:${d}`);
      },
      setDelaySecs: (d) => {
        savedDelay = d;
      },
      clearExternalTrackState: () => {
        clearedExt = true;
      },
    },
  );
  assert.deepEqual(calls, ["sid:2", "delay:0"]);
  assert.equal(savedDelay, 0);
  assert.equal(clearedExt, true);
  assert.equal(tr.isBitmapSubtitleTrack({ id: 3, type: "sub", codec: "hdmv_pgs_subtitle" }), true);
});

test("Stores keep RAM-only serverPassword, default localReady=false, and reset transient state cleanly", async () => {
  const appStoreMod = await loadModules<typeof import("../src/store/useAppStore")>(
    "src/store/useAppStore.ts",
  );
  const syncStoreMod = await loadModules<typeof import("../src/store/useSyncStore")>(
    "src/store/useSyncStore.ts",
  );
  const subStoreMod = await loadModules<typeof import("../src/store/useSubtitleStore")>(
    "src/store/useSubtitleStore.ts",
  );

  assert.equal(syncStoreMod.useSyncStore.getState().localReady, false);
  assert.equal(subStoreMod.useSubtitleStore.getState().overrideAssStyle, false);
  assert.equal(subStoreMod.useSubtitleStore.getState().encodingHint, "auto");

  appStoreMod.useAppStore.getState().setServerPassword("secret-pass");
  assert.equal(appStoreMod.useAppStore.getState().serverPassword, "secret-pass");

  appStoreMod.useAppStore.getState().enterRoom("My Literal Room", true);
  assert.equal(appStoreMod.useAppStore.getState().screen, "room");
  assert.equal(appStoreMod.useAppStore.getState().literalRoom, true);
  assert.equal(appStoreMod.useAppStore.getState().roomCode, "My Literal Room");

  subStoreMod.useSubtitleStore.getState().nudgeDelay(0.15);
  assert.equal(subStoreMod.useSubtitleStore.getState().delaySecs, 0.15);
});

test("Fix 16 & 17: dialog drop gate and mid-movie mpv crash Syncplay recovery", async () => {
  const pl = await loadModules<typeof import("../src/lib/playerLifecycle")>(
    "src/lib/playerLifecycle.ts",
  );
  assert.equal(pl.checkDropDuringDialog(false).allowed, true);
  const blocked = pl.checkDropDuringDialog(true);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.notice || "", /dialog/i);

  const calls: string[] = [];
  let localReady = true;
  let cleared = false;
  await pl.handlePlayerCrashSync({
    syncConnected: true,
    wasPaused: false,
    positionSecs: 142.5,
    setLocalReady: (r) => {
      localReady = r;
    },
    syncSetReady: async (r, manual) => {
      calls.push(`ready:${r}:${manual}`);
    },
    syncUserPause: async (pos) => {
      calls.push(`pause:${pos}`);
    },
    clearAnnouncementCache: () => {
      cleared = true;
    },
  });

  assert.equal(localReady, false);
  assert.equal(cleared, true);
  assert.deepEqual(calls, ["ready:false:false", "pause:142.5"]);
});

test("Fix 20 & 21: usePlayerShortcuts source uses physical e.code and 100ms seek throttle", async () => {
  const hookSrc = fs.readFileSync(
    path.join(REPO_ROOT, "src/hooks/usePlayerShortcuts.ts"),
    "utf8",
  );
  // Physical e.code ensures Arabic keyboard layouts (e.key='ب','ئ','س') trigger identical bindings
  for (const code of [
    "KeyF",
    "KeyR",
    "Space",
    "KeyK",
    "KeyJ",
    "KeyL",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "KeyM",
    "KeyV",
    "KeyS",
    "KeyZ",
    "KeyX",
    "BracketLeft",
    "BracketRight",
    "Escape",
  ]) {
    assert.equal(hookSrc.includes(`"${code}"`), true, `Missing physical code ${code}`);
  }
  assert.equal(hookSrc.includes("createLeadingTrailingThrottle"), true);

  const th = await loadModules<typeof import("../src/lib/throttle")>("src/lib/throttle.ts");
  const sk = await loadModules<typeof import("../src/lib/seekCoalesce")>("src/lib/seekCoalesce.ts");
  const sent: number[] = [];
  const throttled = th.createLeadingTrailingThrottle((target: number) => {
    sent.push(target);
  }, 100);
  const acc = new sk.SeekAccumulator(450);

  let latest = 0;
  for (let i = 0; i < 10; i++) {
    latest = acc.step(5, 100, 600, 1000 + i * 10);
    throttled.call(latest);
  }
  throttled.flush();
  assert.equal(latest, 150);
  assert.equal(sent.length, 2);
  assert.equal(sent[sent.length - 1], 150);
});

test("Watch-room hardening: resolveEffectiveUsername, store resets, and zero-duration announcement", async () => {
  const ctrl = await loadModules<typeof import("../src/lib/syncController")>(
    "src/lib/syncController.ts",
  );
  assert.equal(
    ctrl.resolveEffectiveUsername(
      {
        state: "connected",
        endpoint: "syncplay.pl:8999",
        tls: true,
        username: "Ahmed_1",
      },
      "Ahmed",
    ),
    "Ahmed_1",
  );
  assert.equal(ctrl.resolveEffectiveUsername({ state: "disconnected" }, "Ahmed"), "Ahmed");

  const playerStoreMod = await loadModules<typeof import("../src/store/usePlayerStore")>(
    "src/store/usePlayerStore.ts",
  );
  playerStoreMod.usePlayerStore.getState().setLoaded(true);
  playerStoreMod.usePlayerStore.getState().setPaused(false);
  playerStoreMod.usePlayerStore.getState().setPositionSecs(42);
  playerStoreMod.usePlayerStore.getState().setDurationSecs(1200);
  playerStoreMod.usePlayerStore.getState().resetForNewFile();
  assert.equal(playerStoreMod.usePlayerStore.getState().loaded, false);
  assert.equal(playerStoreMod.usePlayerStore.getState().paused, true);
  assert.equal(playerStoreMod.usePlayerStore.getState().positionSecs, 0);
  assert.equal(playerStoreMod.usePlayerStore.getState().durationSecs, 0);

  const subStoreMod = await loadModules<typeof import("../src/store/useSubtitleStore")>(
    "src/store/useSubtitleStore.ts",
  );
  const prevGen = subStoreMod.useSubtitleStore.getState().sessionGen;
  subStoreMod.useSubtitleStore.getState().setAutoSyncBusy(true);
  subStoreMod.useSubtitleStore.getState().clearLoadedTrack();
  assert.equal(subStoreMod.useSubtitleStore.getState().sessionGen, prevGen + 1);
  assert.equal(subStoreMod.useSubtitleStore.getState().autoSyncBusy, false);

  const announceMod = await loadModules<typeof import("../src/lib/syncFileAnnounce")>(
    "src/lib/syncFileAnnounce.ts",
  );
  const zeroDur = announceMod.shouldAnnounceFile(null, {
    syncConnected: true,
    endpoint: "syncplay.pl:8999",
    username: "Ahmed",
    roomCode: "ROOM-1",
    fileName: "episode_02.mkv",
    loaded: true,
    durationSecs: 0,
  });
  assert.equal(zeroDur.announce, true);
  assert.ok(zeroDur.nextKey);

  const unloaded = announceMod.shouldAnnounceFile(zeroDur.nextKey, {
    syncConnected: true,
    endpoint: "syncplay.pl:8999",
    username: "Ahmed",
    roomCode: "ROOM-1",
    fileName: "episode_02.mkv",
    loaded: false,
    durationSecs: 0,
  });
  assert.equal(unloaded.announce, false);
  assert.equal(unloaded.nextKey, null);
});

test("Responsiveness invariants: lazy mpvStart, throttled playback/subtitle ticks, and ErrorBoundary", () => {
  const watchRoomSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.match(watchRoomSrc, /const ensureMpvStarted = useCallback/);
  assert.match(watchRoomSrc, /await ensureMpvStarted\(\)/);
  assert.doesNotMatch(watchRoomSrc, /useEffect\([\s\S]{0,160}mpvStart\(rect\)/);
  assert.match(watchRoomSrc, /window\.setTimeout\(\(\) => \{\s*roomSessionStartedRef\.current = true;/);

  const transportSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/TransportBar.tsx"), "utf8");
  const transportBody = transportSrc.slice(transportSrc.indexOf("export const TransportBar = memo("));
  assert.match(transportSrc, /export const TransportBar = memo\(/);
  assert.doesNotMatch(transportBody, /const positionSecs = usePlayerStore\(\(s\) => s\.positionSecs\)/);
  assert.match(transportBody, /seekPlaybackRelative\(/);
  const playerActionsSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/playerActions.ts"), "utf8");
  assert.match(playerActionsSrc, /const player = usePlayerStore\.getState\(\);\s*if \(!player\.loaded\) return;/);

  const subtitleSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"), "utf8");
  assert.match(subtitleSrc, /export const SubtitlePanel = memo\(/);
  assert.match(subtitleSrc, /createLeadingTrailingThrottle/);
  assert.match(subtitleSrc, /throttledApplyStyle\.flush\(\)/);
  assert.match(subtitleSrc, /Advanced Options/);
  assert.match(subtitleSrc, /Exact Size/);
  assert.match(subtitleSrc, /Vertical Position/);
  assert.match(subtitleSrc, /Outline Weight/);
  assert.match(subtitleSrc, /Font Family/);

  const settingsSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/SettingsModal.tsx"), "utf8");
  assert.match(settingsSrc, /createLeadingTrailingThrottle/);
  assert.match(settingsSrc, /throttledApplySubStyle\.flush\(\)/);

  const viewportHookSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/useViewportRect.ts"), "utf8");
  assert.match(viewportHookSrc, /scheduleMeasure/);
  assert.doesNotMatch(viewportHookSrc, /window\.addEventListener\("focus"/);

  const mainSrc = fs.readFileSync(path.join(REPO_ROOT, "src/main.tsx"), "utf8");
  assert.match(mainSrc, /<ErrorBoundary>/);
  assert.match(mainSrc, /window\.addEventListener\("unhandledrejection"/);
});



test("Installer packaging bundles everything the app needs and embeds both frontends", () => {
  const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");

  // Both Tauri binaries must expose + be built with custom-protocol, otherwise release builds load
  // http://localhost:1420 / :1421 instead of the embedded UI.
  assert.match(read("src-tauri/Cargo.toml"), /custom-protocol\s*=\s*\["tauri\/custom-protocol"\]/);
  assert.match(read("src-installer/Cargo.toml"), /custom-protocol\s*=\s*\["tauri\/custom-protocol"\]/);

  const build = read("scripts/build-installer.ps1");
  assert.match(build, /cargo build --release -p epilod-party --features custom-protocol/);
  assert.match(build, /cargo build --release -p epilod-setup --features custom-protocol/);
  for (const required of [
    "resources\\mpv\\mpv.exe",
    "resources\\mpv\\ffmpeg.exe",
    "Inter-Regular.ttf",
    "Inter-Bold.ttf",
    "NotoSansArabic-Regular.ttf",
    "NotoSansArabic-Bold.ttf",
    "GPL-3.0.txt",
    "SOURCE_OFFER.txt",
  ]) {
    assert.ok(build.includes(required), `build-installer.ps1 must hard-require ${required}`);
  }

  // ffmpeg must be pinned with a real SHA-256 alongside mpv and fetched by the fetch script.
  const lock = JSON.parse(read("scripts/mpv.lock"));
  for (const key of ["mpv", "ffmpeg"]) {
    assert.match(lock[key].url, /^https:\/\/github\.com\/.+\.7z$/);
    assert.match(lock[key].sha256, /^[0-9a-f]{64}$/);
  }
  const fetchScript = read("scripts/fetch-mpv.ps1");
  assert.match(fetchScript, /lock\.ffmpeg\.url/);
  assert.match(fetchScript, /ffmpeg\.exe/);

  // Every file the Tauri bundle config lists must be staged into the custom installer payload too.
  const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
  for (const res of conf.bundle.resources as string[]) {
    const dir = res.replace(/\/\*$/, "").replace(/\//g, "\\");
    assert.ok(
      build.includes(`resources\\${dir.replace(/^resources\\/, "")}`),
      `installer staging must include ${res}`,
    );
  }
});

test("Transparent backdrop invariant: engineSurfaceVisible and mpv lifecycle guards", async () => {
  const playerStoreMod = await loadModules<typeof import("../src/store/usePlayerStore")>(
    "src/store/usePlayerStore.ts",
  );
  const store = playerStoreMod.usePlayerStore;
  store.getState().reset();
  assert.equal(store.getState().engineSurfaceVisible, false);

  store.getState().setLoaded(true);
  store.getState().setEngineSurfaceVisible(true);
  assert.equal(store.getState().engineSurfaceVisible, true);

  store.getState().resetForNewFile();
  assert.equal(store.getState().loaded, false);
  assert.equal(store.getState().engineSurfaceVisible, false);

  store.getState().setEngineSurfaceVisible(true);
  store.getState().reset();
  assert.equal(store.getState().engineSurfaceVisible, false);

  const mpvMod = await loadModules<typeof import("../src/lib/mpv")>("src/lib/mpv.ts");
  assert.equal(mpvMod.isMpvNotRunningError("Video player is not running."), true);
  assert.equal(mpvMod.isMpvNotRunningError(new Error("Video player is not running.")), true);
  assert.equal(mpvMod.isMpvNotRunningError("Something else"), false);

  const lostEvents: string[] = [];
  const unsub = mpvMod.subscribeMpvRuntimeLost((msg) => {
    lostEvents.push(msg);
  });
  await mpvMod.safeMpvCall(Promise.reject(new Error("Video player is not running.")), "testSeek");
  await mpvMod.safeMpvCall(Promise.reject(new Error("Unrelated transient warning")), "testWarn");
  unsub();
  assert.deepEqual(lostEvents, ["Video player is not running."]);

  const watchRoomSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/WatchRoom.tsx"), "utf8");
  assert.match(
    watchRoomSrc,
    /const showVideoBackdrop =\s*loaded &&\s*!playerError &&\s*!modalBlockingVideo &&\s*\(!desktopRuntime \|\| engineSurfaceVisible\);/,
  );
  assert.match(watchRoomSrc, /onMpvSurfaceState\(/);
  assert.match(watchRoomSrc, /mpvGetSurfaceState\(/);
  assert.match(watchRoomSrc, /subscribeMpvRuntimeLost\(/);
  assert.match(watchRoomSrc, /enqueueMpvLifecycle\(async \(\) => \{\s*await mpvStop\(\)/);
  assert.doesNotMatch(
    watchRoomSrc,
    /enqueueSyncLifecycle\(async \(\) => \{[^}]*mpvStop\(\)/,
  );
});

test("Embedded caption track normalization, closed-caption detection, and cross-file auto-enable", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-sub-test-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export { normalizeMpvTracks, subtitleTwoAnchorSync } from "./src/lib/mpv.ts";
          export { buildAudioTrackOptions, buildSubTrackOptions, formatCompactClockSecs, isClosedCaptionTrack, parseFlexibleTimestampSecs } from "./src/lib/tracks.ts";
          export { autoEnableEmbeddedSubtitle, resetAutoSubtitleState } from "./src/lib/playerActions.ts";
          export { useAppStore } from "./src/store/useAppStore.ts";
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
    });
    const mod = await import(pathToFileURL(outFile).href);

    // 1. Normalize both legacy `kind` payloads and canonical `type` payloads
    const normalized = mod.normalizeMpvTracks([
      { id: 1, kind: "audio", lang: "jpn", codec: "aac", selected: true, external: false },
      { id: 2, kind: "sub", codec: "subrip", lang: "eng", selected: false, external: false },
      { id: 3, type: "sub", codec: "eia_608", title: "CC1", selected: false, external: false },
    ]);
    assert.equal(mod.buildAudioTrackOptions(normalized).length, 2);
    assert.equal(mod.buildSubTrackOptions(normalized).length, 3);
    assert.equal(mod.isClosedCaptionTrack(normalized[2]), true);
    assert.equal(mod.isClosedCaptionTrack(normalized[1]), false);
    assert.equal(mod.parseFlexibleTimestampSecs("12.5"), 12.5);
    assert.equal(mod.parseFlexibleTimestampSecs("1:30"), 90);
    assert.equal(mod.parseFlexibleTimestampSecs("1:02:03.5"), 3723.5);
    assert.equal(mod.parseFlexibleTimestampSecs("1:75"), null);
    assert.equal(mod.parseFlexibleTimestampSecs("bad"), null);
    assert.equal(mod.formatCompactClockSecs(90), "1:30");
    assert.equal(mod.formatCompactClockSecs(3723.5), "1:02:03.5");

    // 2. Test autoEnableEmbeddedSubtitle across episode changes and manual Off
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
      mod.resetAutoSubtitleState();
      mod.useAppStore.getState().setSelectedFile("D:\\Shows\\Ep01.mkv", "Ep01.mkv");
      mod.useSubtitleStore.getState().setVisible(false);

      // Should prefer non-forced default text track (id: 2) over forced/bitmap track (id: 1)
      const ep1Tracks = mod.normalizeMpvTracks([
        { id: 1, type: "sub", codec: "subrip", forced: true, selected: false, external: false },
        { id: 2, type: "sub", codec: "subrip", default: true, forced: false, selected: false, external: false },
      ]);
      mod.autoEnableEmbeddedSubtitle(ep1Tracks);
      assert.equal(mod.useSubtitleStore.getState().visible, true);
      assert.ok(calls.some((c) => c.cmd === "mpv_set_sub_track" && c.args.sid === 2));
      assert.ok(calls.some((c) => c.cmd === "mpv_set_sub_style" && c.args.visible === true));

      // Turning subs off on the same file must NOT be overridden by subsequent track-list updates
      calls.length = 0;
      mod.useSubtitleStore.getState().setVisible(false);
      mod.autoEnableEmbeddedSubtitle(ep1Tracks);
      assert.equal(mod.useSubtitleStore.getState().visible, false);
      assert.equal(calls.length, 0);

      // Opening Episode 2 with identical track IDs (`1:i|2:i`) must re-enable subtitles cleanly
      mod.resetAutoSubtitleState();
      mod.useAppStore.getState().setSelectedFile("D:\\Shows\\Ep02.mkv", "Ep02.mkv");
      mod.autoEnableEmbeddedSubtitle(ep1Tracks);
      assert.equal(mod.useSubtitleStore.getState().visible, true);
      assert.ok(calls.some((c) => c.cmd === "mpv_set_sub_track" && c.args.sid === 2));

      // Opening Episode 3 where mpv auto-selected a bitmap ENG track should switch to a
      // same-language text track when present, while leaving foreign-only text tracks untouched.
      calls.length = 0;
      mod.resetAutoSubtitleState();
      mod.useAppStore.getState().setSelectedFile("D:\\Shows\\Ep03.mkv", "Ep03.mkv");
      const bitmapPlusText = mod.normalizeMpvTracks([
        { id: 1, type: "sub", codec: "dvd_subtitle", lang: "eng", selected: true, external: false },
        { id: 2, type: "sub", codec: "subrip", lang: "eng", selected: false, external: false },
      ]);
      mod.autoEnableEmbeddedSubtitle(bitmapPlusText);
      assert.ok(calls.some((c) => c.cmd === "mpv_set_sub_track" && c.args.sid === 2));

      calls.length = 0;
      mod.resetAutoSubtitleState();
      mod.useAppStore.getState().setSelectedFile("D:\\Shows\\Ep04.mkv", "Ep04.mkv");
      const bitmapPlusForeignText = mod.normalizeMpvTracks([
        { id: 1, type: "sub", codec: "dvd_subtitle", lang: "eng", selected: true, external: false },
        { id: 2, type: "sub", codec: "subrip", lang: "fra", selected: false, external: false },
      ]);
      mod.autoEnableEmbeddedSubtitle(bitmapPlusForeignText);
      assert.ok(!calls.some((c) => c.cmd === "mpv_set_sub_track"));

      // 3. Two-point manual anchor sync passes embedded track fallback when no external file exists
      calls.length = 0;
      await mod.subtitleTwoAnchorSync({
        subtitlePath: null,
        videoPath: "D:\\Shows\\Ep02.mkv",
        embeddedSubIdx: 1,
        embeddedSubCodec: "ass",
        srcASecs: 10,
        dstASecs: 12,
        srcBSecs: 600,
        dstBSecs: 602,
        encodingHint: "auto",
      });
      const twoAnchorCall = calls.find((c) => c.cmd === "subtitle_two_anchor_sync");
      assert.ok(twoAnchorCall);
      assert.equal(twoAnchorCall.args.subtitlePath, null);
      assert.equal(twoAnchorCall.args.videoPath, "D:\\Shows\\Ep02.mkv");
      assert.equal(twoAnchorCall.args.embeddedSubIdx, 1);
      assert.equal(twoAnchorCall.args.embeddedSubCodec, "ass");

      const subtitlePanelSrc = fs.readFileSync(
        path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"),
        "utf8",
      );
      assert.equal(subtitlePanelSrc.includes("2-Point Manual Sync"), false);
      assert.equal(subtitlePanelSrc.includes("Open 2-Point Manual Sync"), false);
      assert.match(subtitlePanelSrc, /embeddedSubIdx:\s*\n\s*!originalFilePath && !loadedFilePath/);
      assert.doesNotMatch(subtitlePanelSrc, /cannot be auto-synced;\s*nudge/i);
      assert.match(subtitlePanelSrc, /subIsClosedCaption\s*\?\s*0/);
    } finally {
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});

test("Bold subtitle option preserves original defaults and propagates sub-bold cleanly", async () => {
  const subMod = await loadModules<typeof import("../src/store/useSubtitleStore")>(
    "src/store/useSubtitleStore.ts",
  );
  const store = subMod.useSubtitleStore;
  store.getState().resetDefaults();
  const initial = store.getState();
  assert.equal(initial.font, "Noto Sans Arabic");
  assert.equal(initial.fontSize, 44);
  assert.equal(initial.borderSize, 2.5);
  assert.equal(initial.bold, false);
  assert.equal(subMod.buildSubStyleParams(initial).bold, false);

  store.getState().setBold(true);
  assert.equal(store.getState().bold, true);
  assert.equal(subMod.buildSubStyleParams(store.getState()).bold, true);

  store.getState().resetDefaults();
  assert.equal(store.getState().bold, false);

  const settingsSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/SettingsModal.tsx"), "utf8");
  const subtitleSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"), "utf8");
  assert.match(settingsSrc, /Bold Subtitle Font/);
  assert.match(settingsSrc, /Override Styled Fansubs/);
  assert.match(settingsSrc, /Subtitle Vertical Position/);
  assert.match(subtitleSrc, /Advanced Options/);
  assert.match(subtitleSrc, /Bold font/);
  assert.match(subtitleSrc, /Override styled fansubs/);

  const tracksSrc = fs.readFileSync(path.join(REPO_ROOT, "src/lib/tracks.ts"), "utf8");
  assert.match(tracksSrc, /parseFlexibleTimestampSecs/);

  const mpvIpcSrc = fs.readFileSync(
    path.join(REPO_ROOT, "crates/epilod-core/src/mpv_ipc.rs"),
    "utf8",
  );
  for (const flag of [
    "--sub-hinting=light",
    "--sub-blur=0.08",
    "--sub-outline-color=#E6000000",
    "--sub-shadow-offset=1.15",
    "--sub-back-color=#78000000",
  ]) {
    assert.ok(mpvIpcSrc.includes(flag), `mpv_ipc.rs must include subtitle quality flag ${flag}`);
  }
});

test("Sudden seek coalescing: monotonic clientSeekSeq rejects stale mpv://time and avoids scrubber double-seek", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "epilod-seek-test-"));
  const outFile = path.join(outDir, "bundle.mjs");
  try {
    buildSync({
      stdin: {
        contents: `
          export * from "./src/lib/seekCoalesce.ts";
          export * from "./src/lib/playerActions.ts";
          export { usePlayerStore } from "./src/store/usePlayerStore.ts";
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
    const mod = (await import(pathToFileURL(outFile).href)) as typeof import("../src/lib/seekCoalesce") &
      typeof import("../src/lib/playerActions") & {
        usePlayerStore: typeof import("../src/store/usePlayerStore")["usePlayerStore"];
      };

    mod.resetSharedRelativeSeek();
    const s1 = mod.nextClientSeekSeq();
    const s2 = mod.nextClientSeekSeq();
    assert.ok(s2 > s1);
    assert.equal(mod.shouldAcceptMpvTimeEvent(s1, s2), false);
    assert.equal(mod.shouldAcceptMpvTimeEvent(s2, s2), true);
    assert.equal(mod.shouldAcceptMpvTimeEvent(undefined, s2), true);

    // Mock Tauri IPC bridge cleanly to inspect dispatched mpv_seek invocations
    const ipcCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
    const prevWindow = (globalThis as Record<string, unknown>).window;
    (globalThis as Record<string, unknown>).window = {
      __TAURI_INTERNALS__: {
        invoke: async (cmd: string, args?: Record<string, unknown>) => {
          ipcCalls.push({ cmd, args });
          return null;
        },
      },
    };
    try {
      mod.usePlayerStore.getState().setLoaded(true);
      mod.usePlayerStore.getState().setDurationSecs(1200);
      mod.usePlayerStore.getState().setPositionSecs(100);
      mod.resetSharedRelativeSeek();

      mod.seekPlaybackRelative(10);
      mod.seekPlaybackRelative(10);
      await Promise.resolve();

      const seekCalls = ipcCalls.filter((c) => c.cmd === "mpv_seek");
      assert.equal(seekCalls.length, 2);
      assert.equal(seekCalls[0].args?.seconds, 110);
      assert.equal(seekCalls[1].args?.seconds, 120);
      assert.equal(seekCalls[0].args?.preview, false);
      assert.ok(
        Number(seekCalls[1].args?.clientSeekSeq) > Number(seekCalls[0].args?.clientSeekSeq),
        "Sequential seeks must bump clientSeekSeq monotonically",
      );
    } finally {
      mod.resetSharedRelativeSeek();
      if (prevWindow === undefined) {
        delete (globalThis as Record<string, unknown>).window;
      } else {
        (globalThis as Record<string, unknown>).window = prevWindow;
      }
    }
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }

  const scrubberSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/Scrubber.tsx"), "utf8");
  const transportSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/TransportBar.tsx"), "utf8");
  assert.match(scrubberSrc, /onPointerCancel=\{finishPointerDrag\}/);
  assert.match(scrubberSrc, /phase:\s*dragMovedRef\.current\s*\?\s*"move"\s*:\s*"start"/);
  assert.match(transportSrc, /meta\?\.phase\s*===\s*"commit"\s*\|\|\s*meta\?\.phase\s*===\s*"key"/);
  assert.match(transportSrc, /mpvSeek\(secs,\s*\{\s*preview:\s*true/);
  assert.match(transportSrc, /mpvSeek\(val,\s*\{\s*preview:\s*false/);
});

test("Magic Sync embedded track resolution never crosses languages and uses exact ff-index", async () => {
  const tr = await loadModules<typeof import("../src/lib/tracks")>("src/lib/tracks.ts");
  const mpvMod = await loadModules<typeof import("../src/lib/mpv")>("src/lib/mpv.ts");

  // 1. Language code normalization (ISO 639-1, 639-2, BCP-47, full name, undetermined)
  assert.equal(tr.languagesMatch("en", "eng"), true);
  assert.equal(tr.languagesMatch("en-US", "English"), true);
  assert.equal(tr.languagesMatch("ara", "ar"), true);
  assert.equal(tr.languagesMatch("und", "und"), false);
  assert.equal(tr.languagesMatch("eng", "ara"), false);

  // 2. Embedded English bitmap sub with ONLY a foreign (Arabic) text track must NOT fall back to Arabic
  const bitmapOnlyForeign = tr.resolveEmbeddedSyncTarget([
    { id: 1, type: "sub", lang: "ara", codec: "subrip", selected: false, external: false, "ff-index": 2 },
    { id: 2, type: "sub", lang: "eng", codec: "hdmv_pgs_subtitle", selected: true, external: false, "ff-index": 3 },
  ]);
  assert.equal(bitmapOnlyForeign.subIsBitmap, true);
  assert.equal(bitmapOnlyForeign.fallbackEmbeddedSub, null);
  assert.equal(bitmapOnlyForeign.syncTargetEmbedded, null);
  assert.equal(bitmapOnlyForeign.embeddedSubIdx, null);
  assert.equal(bitmapOnlyForeign.ffIndex, null);
  assert.equal(bitmapOnlyForeign.crossLangBlocked, true);

  // 3. Embedded English bitmap sub falls back ONLY to a same-language English text track
  const bitmapWithEnMatch = tr.resolveEmbeddedSyncTarget([
    { id: 1, type: "sub", lang: "ara", codec: "subrip", selected: false, external: false, "ff-index": 2 },
    { id: 2, type: "sub", lang: "eng", codec: "hdmv_pgs_subtitle", selected: true, external: false, "ff-index": 3 },
    { id: 3, type: "sub", lang: "en-US", codec: "ass", selected: false, external: false, "ff-index": 4 },
  ]);
  assert.equal(bitmapWithEnMatch.fallbackEmbeddedSub?.id, 3);
  assert.equal(bitmapWithEnMatch.syncTargetEmbedded?.id, 3);
  assert.equal(bitmapWithEnMatch.ffIndex, 4);
  assert.equal(bitmapWithEnMatch.embeddedSubIdx, 2);
  assert.equal(bitmapWithEnMatch.crossLangBlocked, false);

  // 4. Container stream + virtual CC track + non-contiguous ff-index preserves exact FFmpeg target
  const mixedCcAndContainer = tr.resolveEmbeddedSyncTarget([
    { id: 1, type: "sub", lang: "spa", codec: "eia_608", selected: false, external: false }, // virtual CC (no ff-index)
    { id: 2, type: "sub", lang: "ara", codec: "eia_608", selected: false, external: false, "ff-index": 2 }, // container CC
    { id: 3, type: "sub", lang: "eng", codec: "subrip", selected: true, external: false, "ff-index": 5 },
  ]);
  assert.equal(mixedCcAndContainer.syncTargetEmbedded?.id, 3);
  assert.equal(mixedCcAndContainer.ffIndex, 5);
  assert.equal(mixedCcAndContainer.embeddedSubIdx, 1);

  // 5. selectSubTrack clears stale external track state if tracks list is empty/stale
  let clearedOnStale = false;
  await tr.selectSubTrack(7, [], {
    mpvSetSubTrack: async () => {},
    mpvSetSubDelay: async () => {},
    setDelaySecs: () => {},
    clearExternalTrackState: () => {
      clearedOnStale = true;
    },
  });
  assert.equal(clearedOnStale, true);

  // 6. selectSubTrack does NOT clear external track state when selecting a known external track
  let clearedOnExternal = false;
  await tr.selectSubTrack(
    9,
    [{ id: 9, type: "sub", external: true, codec: "subrip" }],
    {
      mpvSetSubTrack: async () => {},
      mpvSetSubDelay: async () => {},
      setDelaySecs: () => {},
      clearExternalTrackState: () => {
        clearedOnExternal = true;
      },
    },
  );
  assert.equal(clearedOnExternal, false);

  // 7. subtitleAutoSync forwards embeddedSubFfIdx to Tauri IPC
  const ipcCalls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  const prevWindow = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = {
    __TAURI_INTERNALS__: {
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        ipcCalls.push({ cmd, args });
        return {
          offsetSecs: 0,
          scale: 1,
          confidenceZ: 8,
          correlation: 0.9,
          driftApplied: false,
          segmentsApplied: 1,
          syncedSubtitlePath: "C:\\tmp\\synced.srt",
          sourceSubtitlePath: "C:\\tmp\\source.srt",
          audioDurationSecs: 100,
          elapsedMs: 120,
        };
      },
    },
  };
  try {
    await mpvMod.subtitleAutoSync({
      videoPath: "C:\\video.mkv",
      subtitlePath: null,
      audioTrackId: 1,
      embeddedSubIdx: 1,
      embeddedSubFfIdx: 5,
      embeddedSubCodec: "subrip",
    });
    const call = ipcCalls.find((c) => c.cmd === "subtitle_auto_sync");
    assert.ok(call);
    assert.equal(call.args?.embeddedSubIdx, 1);
    assert.equal(call.args?.embeddedSubFfIdx, 5);
  } finally {
    if (prevWindow === undefined) {
      delete (globalThis as Record<string, unknown>).window;
    } else {
      (globalThis as Record<string, unknown>).window = prevWindow;
    }
  }
});

test("Scrubber pointer handling guards secondary clicks, fast taps via draggingRef, click release drift, and zero-coord pointercancel", () => {
  const scrubberSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/ui/Scrubber.tsx"), "utf8");
  const transportSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/TransportBar.tsx"), "utf8");
  const syncplayRs = fs.readFileSync(path.join(REPO_ROOT, "crates/epilod-core/src/syncplay.rs"), "utf8");
  const syncplayModRs = fs.readFileSync(path.join(REPO_ROOT, "src-tauri/src/syncplay/mod.rs"), "utf8");

  assert.match(scrubberSrc, /draggingRef\.current/);
  assert.match(scrubberSrc, /e\.button !== 0/);
  assert.match(scrubberSrc, /pointerDownValRef\.current/);
  assert.match(scrubberSrc, /lastValRef\.current/);
  assert.match(scrubberSrc, /e\.type === "pointercancel"\s*\|\|\s*e\.type === "lostpointercapture"/);
  assert.match(scrubberSrc, />=\s*6/);
  assert.match(scrubberSrc, /onLostPointerCapture=\{finishPointerDrag\}/);

  assert.match(transportSrc, /scrubbingRef\.current = false;[\s\S]*void syncUserSeek\(val\);/);
  assert.doesNotMatch(syncplayRs, /\|\|\s*server_ignored\s*\);/);
  assert.match(syncplayRs, /server_ignored && ps\.set_by\.is_none\(\)/);
  assert.match(syncplayModRs, /SyncCommand::UserSeek\(pos\)[\s\S]{0,360}is_scrubbing = false;/);
});
