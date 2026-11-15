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
  assert.match(transportBody, /usePlayerStore\.getState\(\)\.positionSecs/);

  const subtitleSrc = fs.readFileSync(path.join(REPO_ROOT, "src/components/SubtitlePanel.tsx"), "utf8");
  assert.match(subtitleSrc, /export const SubtitlePanel = memo\(/);
  assert.match(subtitleSrc, /createLeadingTrailingThrottle\(applyStyleNow, 60\)/);
  assert.match(subtitleSrc, /throttledApplyStyle\.flush\(\)/);

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
    "NotoSansArabic-Regular.ttf",
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
    /const showVideoBackdrop =\s*loaded &&\s*!playerError &&\s*!settingsOpen &&\s*!shortcutsOpen &&\s*\(!desktopRuntime \|\| engineSurfaceVisible\);/,
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
