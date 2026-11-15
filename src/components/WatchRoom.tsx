import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import { X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePlayerShortcuts } from "../hooks/usePlayerShortcuts";
import { isDesktop } from "../lib/bridge";
import { formatUserError } from "../lib/errors";
import { getFileDisplayName, splitDroppedFiles } from "../lib/fileDrop";
import { resolveFullscreenChromeState } from "../lib/fullscreenUi";
import { logFrontendEvent } from "../lib/logger";
import {
  mpvAddSubtitle,
  mpvLoad,
  mpvResize,
  mpvSeek,
  mpvSetPause,
  mpvSetSpeed,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetVisible,
  mpvStart,
  mpvStop,
  onMpvCommandWarning,
  onMpvDuration,
  onMpvEnded,
  onMpvError,
  onMpvFileLoaded,
  onMpvPaused,
  onMpvSurfaceClick,
  onMpvSurfaceDblClick,
  onMpvTime,
  onMpvTracks,
  onWindowFullscreen,
  onWindowRestored,
  setAllowNetworkShares,
  subtitleCancelAutoSync,
  windowIsFullscreen,
  windowSetFullscreen,
} from "../lib/mpv";
import { classifyMpvEnd, shouldReplayFromStart } from "../lib/playbackEnd";
import { checkDropDuringDialog, handlePlayerCrashSync } from "../lib/playerLifecycle";
import { resetMpvPlaybackDefaults } from "../lib/playbackReset";
import {
  formatControllerOverrideNotice,
  getControllerLockState,
  resolveEffectiveUsername,
} from "../lib/syncController";
import { shouldAnnounceFile } from "../lib/syncFileAnnounce";
import { shouldAutoReadyOnFileLoad } from "../lib/syncReady";
import { shouldResetSpeedForSync } from "../lib/syncSpeedGuard";
import {
  enqueueSyncLifecycle,
  onSyncError,
  onSyncParticipants,
  onSyncServerOverride,
  onSyncStatus,
  syncConnect,
  syncDisconnect,
  syncSetFile,
  syncSetReady,
  syncUserPause,
  syncUserPlay,
  syncUserSeek,
} from "../lib/syncplay";
import { measurePhysicalRect, useViewportRect } from "../lib/useViewportRect";
import { ViewportSyncTracker } from "../lib/viewportSync";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";
import { PlaybackPanel } from "./PlaybackPanel";
import { RoomPanel } from "./RoomPanel";
import { SettingsModal } from "./SettingsModal";
import { ShortcutsModal } from "./ShortcutsModal";
import { SubtitlePanel } from "./SubtitlePanel";
import { TitleBar } from "./TitleBar";
import { TransportBar, type CapsuleTab } from "./TransportBar";
import { ViewportPlaceholder } from "./ViewportPlaceholder";
import { LogoMark } from "./ui/LogoMark";
import { NotificationStrip } from "./ui/NotificationStrip";
import { SegmentedTabs } from "./ui/SegmentedTabs";

type SideTab = CapsuleTab;

export function WatchRoom() {
  const {
    username,
    roomCode,
    literalRoom,
    serverEndpoint,
    serverPassword,
    allowNetworkShares,
    hashFilenames,
    settingsOpen,
    shortcutsOpen,
    selectedFilePath,
    selectedFileName,
  } = useAppStore(
    useShallow((s) => ({
      username: s.username,
      roomCode: s.roomCode,
      literalRoom: s.literalRoom,
      serverEndpoint: s.serverEndpoint,
      serverPassword: s.serverPassword,
      allowNetworkShares: s.allowNetworkShares,
      hashFilenames: s.hashFilenames,
      settingsOpen: s.settingsOpen,
      shortcutsOpen: s.shortcutsOpen,
      selectedFilePath: s.selectedFilePath,
      selectedFileName: s.selectedFileName,
    })),
  );

  const closeSettings = useAppStore((s) => s.closeSettings);
  const closeShortcuts = useAppStore((s) => s.closeShortcuts);
  const leaveRoom = useAppStore((s) => s.leaveRoom);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);

  const loaded = usePlayerStore((s) => s.loaded);
  const paused = usePlayerStore((s) => s.paused);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const speed = usePlayerStore((s) => s.speed);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const playerError = usePlayerStore((s) => s.playerError);

  const syncStatus = useSyncStore((s) => s.status);
  const pushNote = useNotificationStore((s) => s.push);

  const [sideTab, setSideTab] = useState<SideTab>("room");
  const [panelOpen, setPanelOpen] = useState(false);
  const [chromeIdle, setChromeIdle] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [viewportTick, setViewportTick] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportTrackerRef = useRef(new ViewportSyncTracker());
  const mpvStartedRef = useRef(false);
  const mpvStartPromiseRef = useRef<Promise<void> | null>(null);
  const roomSessionStartedRef = useRef(false);
  const panelOpenRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const announcedFileKeyRef = useRef<string | null>(null);
  const autoReadyMarkedRef = useRef(false);
  const dialogOpenRef = useRef(false);
  const leavingRef = useRef(false);
  const loadGenRef = useRef(0);

  panelOpenRef.current = panelOpen;

  const wakeChrome = useCallback(() => {
    setChromeIdle(false);
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    const p = usePlayerStore.getState();
    const app = useAppStore.getState();
    if (
      p.loaded &&
      !p.paused &&
      !panelOpenRef.current &&
      !app.settingsOpen &&
      !app.shortcutsOpen &&
      !p.playerError
    ) {
      idleTimerRef.current = window.setTimeout(() => {
        setChromeIdle(true);
      }, 2600);
    }
  }, []);

  const rect = useViewportRect(viewportRef, viewportTick);

  const toggleFullscreen = useCallback(() => {
    const next = !usePlayerStore.getState().isFullscreen;
    usePlayerStore.getState().setIsFullscreen(next);
    void windowSetFullscreen(next).catch((err) => {
      pushNote("error", formatUserError(err, "Fullscreen toggle failed."));
    });
  }, [pushNote]);

  const exitFullscreen = useCallback(() => {
    if (!usePlayerStore.getState().isFullscreen) return;
    usePlayerStore.getState().setIsFullscreen(false);
    void windowSetFullscreen(false).catch(() => undefined);
  }, []);

  usePlayerShortcuts({
    onToggleFullscreen: toggleFullscreen,
    onExitFullscreen: exitFullscreen,
  });

  const ensureMpvStarted = useCallback(async () => {
    if (!isDesktop() || mpvStartedRef.current) return;
    if (mpvStartPromiseRef.current) {
      await mpvStartPromiseRef.current;
      return;
    }

    const rawRect = measurePhysicalRect(viewportRef.current);
    const initialRect = {
      x: rawRect.x,
      y: rawRect.y,
      width: Math.max(1, rawRect.width),
      height: Math.max(1, rawRect.height),
    };

    const startPromise = mpvStart(initialRect)
      .then(() => {
        mpvStartedRef.current = true;
        viewportTrackerRef.current.markInvalidated();
        const appState = useAppStore.getState();
        const playerErr = usePlayerStore.getState().playerError;
        if (panelOpenRef.current) {
          void mpvSetVisible(false);
        } else {
          void mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !playerErr);
        }
      })
      .finally(() => {
        mpvStartPromiseRef.current = null;
      });

    mpvStartPromiseRef.current = startPromise;
    await startPromise;
  }, []);

  // Load media + subtitle files safely
  const loadVideoPath = useCallback(
    async (path: string) => {
      const gen = ++loadGenRef.current;
      const displayName = getFileDisplayName(path);
      void subtitleCancelAutoSync().catch(() => undefined);
      setSelectedFile(path, displayName);
      autoReadyMarkedRef.current = false;
      announcedFileKeyRef.current = null;
      try {
        await ensureMpvStarted();
        if (loadGenRef.current !== gen) return;
        await mpvLoad(path);
        if (loadGenRef.current !== gen) return;
        const subState = useSubtitleStore.getState();
        await resetMpvPlaybackDefaults(useSyncStore.getState().status.state === "connected");
        if (loadGenRef.current !== gen) return;
        await mpvSetSubStyle({
          font: subState.font,
          fontSize: subState.fontSize,
          color: subState.color,
          borderSize: subState.borderSize,
          pos: subState.pos,
          visible: subState.visible,
          overrideAss: subState.overrideAssStyle,
        });
        if (loadGenRef.current !== gen) return;
        if (!isDesktop()) {
          usePlayerStore.getState().setLoaded(true);
        }
        usePlayerStore.getState().setPlayerError(null);
        usePlayerStore.getState().flashFeedback(`Loaded ${displayName}`);
      } catch (err) {
        if (loadGenRef.current !== gen) return;
        const msg = formatUserError(err, "Failed opening video file.");
        usePlayerStore.getState().setPlayerError(msg);
        pushNote("error", msg);
        void logFrontendEvent("error", "player.load", msg, "ERR_LOAD");
      }
    },
    [ensureMpvStarted, pushNote, setSelectedFile],
  );

  const loadSubtitlePath = useCallback(
    async (path: string) => {
      if (!usePlayerStore.getState().loaded) {
        pushNote("info", "Open a video file before loading a subtitle.");
        return;
      }
      const subState = useSubtitleStore.getState();
      try {
        await mpvAddSubtitle(path, subState.encodingHint);
        await mpvSetSubDelay(0);
        subState.setDelaySecs(0);
        subState.setLoadedTrack(path, path);
        await mpvSetSubStyle({
          font: subState.font,
          fontSize: subState.fontSize,
          color: subState.color,
          borderSize: subState.borderSize,
          pos: subState.pos,
          visible: true,
          overrideAss: subState.overrideAssStyle,
        });
        pushNote("success", `Loaded subtitle: ${getFileDisplayName(path)}`);
      } catch (err) {
        pushNote("error", formatUserError(err, "Could not load subtitle file."));
      }
    },
    [pushNote],
  );

  const handleChooseFile = useCallback(async () => {
    if (!isDesktop()) {
      pushNote("warn", "File dialog requires the Windows desktop app.");
      return;
    }
    if (dialogOpenRef.current) {
      return;
    }
    dialogOpenRef.current = true;
    try {
      if (mpvStartedRef.current) {
        await mpvSetVisible(false);
      }
      const chosen = await open({
        multiple: false,
        title: "Choose Video File",
        filters: [
          {
            name: "Video Files",
            extensions: ["mkv", "mp4", "ts", "m2ts", "avi", "webm", "flv", "wmv", "ogv", "3gp", "*"],
          },
        ],
      });
      if (typeof chosen === "string" && chosen) {
        await loadVideoPath(chosen);
      }
    } finally {
      dialogOpenRef.current = false;
      if (mpvStartedRef.current) {
        const appState = useAppStore.getState();
        const pState = usePlayerStore.getState();
        if (!panelOpenRef.current || !pState.loaded) {
          void mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !pState.playerError);
        }
      }
    }
  }, [loadVideoPath, pushNote]);

  // Sync network share policy on mount
  useEffect(() => {
    void setAllowNetworkShares(allowNetworkShares);
  }, [allowNetworkShares]);

  // Connect / tear down Syncplay lifecycle serialized via FIFO queue (Fix 03 / Fix 17)
  const connectRoom = useCallback(
    (endpoint: string, password: string) => {
      void enqueueSyncLifecycle(async () => {
        const syncState = useSyncStore.getState();
        syncState.setParticipants([]);
        syncState.setServerOverrideNotice(null);
        syncState.setLastError(null);
        try {
          await syncConnect({
            endpoint,
            username,
            roomCode,
            literalRoom,
            password: password || null,
          });
        } catch (err) {
          pushNote("error", formatUserError(err, "Could not connect to Syncplay server."));
        }
      });
    },
    [literalRoom, pushNote, roomCode, username],
  );

  useEffect(() => {
    if (!roomCode) return;
    const timer = window.setTimeout(() => {
      roomSessionStartedRef.current = true;
      connectRoom(serverEndpoint, serverPassword);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      if (!roomSessionStartedRef.current && !mpvStartedRef.current) {
        return;
      }
      roomSessionStartedRef.current = false;
      void enqueueSyncLifecycle(async () => {
        await syncDisconnect();
        if (mpvStartedRef.current) {
          mpvStartedRef.current = false;
          mpvStartPromiseRef.current = null;
          await mpvStop();
        }
      });
    };
    // Initial room mount + unmount cleanup; server config changes use onApplyServerConfig
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  // Subscribe to mpv, window, and syncplay backend events
  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];

    const setup = async () => {
      const fns = await Promise.all([
        onMpvTime((position) => {
          if (active) usePlayerStore.getState().setPositionSecs(position);
        }),
        onMpvDuration((duration) => {
          if (active) usePlayerStore.getState().setDurationSecs(duration);
        }),
        onMpvPaused((paused) => {
          if (active) usePlayerStore.getState().setPaused(paused);
        }),
        onMpvFileLoaded(() => {
          if (!active) return;
          usePlayerStore.getState().setLoaded(true);
          usePlayerStore.getState().setPlayerError(null);
        }),
        onMpvEnded((payload) => {
          if (!active) return;
          const decision = classifyMpvEnd(payload);
          if (decision.kind === "eof") {
            usePlayerStore.getState().setEndedAtEof(true);
            usePlayerStore.getState().setPaused(true);
          } else if (decision.kind === "error") {
            const p = usePlayerStore.getState();
            const s = useSyncStore.getState();
            p.setPlayerError(decision.message);
            pushNote("error", decision.message);
            void handlePlayerCrashSync({
              syncConnected: s.status.state === "connected",
              wasPaused: p.paused,
              positionSecs: p.positionSecs,
              setLocalReady: s.setLocalReady,
              syncSetReady,
              syncUserPause,
              clearAnnouncementCache: () => {
                announcedFileKeyRef.current = null;
                autoReadyMarkedRef.current = false;
              },
            });
          }
        }),
        onMpvTracks((tracks) => {
          if (active) usePlayerStore.getState().setTracks(tracks);
        }),
        onMpvCommandWarning((msg) => {
          if (active) pushNote("warn", msg);
        }),
        onMpvError((msg) => {
          if (!active) return;
          const p = usePlayerStore.getState();
          const s = useSyncStore.getState();
          p.setPlayerError(msg);
          pushNote("error", msg);
          void handlePlayerCrashSync({
            syncConnected: s.status.state === "connected",
            wasPaused: p.paused,
            positionSecs: p.positionSecs,
            setLocalReady: s.setLocalReady,
            syncSetReady,
            syncUserPause,
            clearAnnouncementCache: () => {
              announcedFileKeyRef.current = null;
              autoReadyMarkedRef.current = false;
            },
          });
        }),
        onMpvSurfaceClick(() => {
          if (!active) return;
          const p = usePlayerStore.getState();
          const s = useSyncStore.getState();
          const app = useAppStore.getState();
          if (!p.loaded) return;
          const connected = s.status.state === "connected";
          const lock = getControllerLockState(
            connected,
            s.participants,
            resolveEffectiveUsername(s.status, app.username),
          );
          if (lock.lockedForLocalUser) return;
          if (
            shouldReplayFromStart({
              endedAtEof: p.endedAtEof,
              paused: p.paused,
              positionSecs: p.positionSecs,
              durationSecs: p.durationSecs,
            })
          ) {
            p.setPositionSecs(0);
            p.setEndedAtEof(false);
            p.setPaused(false);
            void mpvSeek(0);
            void mpvSetPause(false);
            if (connected) {
              void syncUserSeek(0);
              void syncUserPlay(0);
            }
            return;
          }
          const nextPaused = !p.paused;
          p.setPaused(nextPaused);
          void mpvSetPause(nextPaused);
          if (connected) {
            if (nextPaused) void syncUserPause(p.positionSecs);
            else void syncUserPlay(p.positionSecs);
          }
        }),
        onMpvSurfaceDblClick(() => {
          if (active) toggleFullscreen();
        }),
        onWindowFullscreen((fs) => {
          if (active) {
            usePlayerStore.getState().setIsFullscreen(fs);
            setViewportTick((t) => t + 1);
          }
        }),
        onWindowRestored(() => {
          if (active) {
            viewportTrackerRef.current.markInvalidated();
            setViewportTick((t) => t + 1);
          }
        }),
        onSyncStatus((status) => {
          if (active) useSyncStore.getState().setStatus(status);
        }),
        onSyncParticipants((list) => {
          if (active) useSyncStore.getState().setParticipants(list);
        }),
        onSyncError((msg) => {
          if (!active) return;
          useSyncStore.getState().setLastError(msg);
          pushNote("error", msg);
        }),
        onSyncServerOverride((setBy) => {
          if (!active) return;
          const notice = formatControllerOverrideNotice(setBy);
          useSyncStore.getState().setServerOverrideNotice(notice);
          pushNote("info", notice);
        }),
      ]);

      if (!active) {
        fns.forEach((fn) => fn());
      } else {
        unlisteners.push(...fns);
      }

      // Sync initial fullscreen state if OS entered fullscreen externally
      const initialFs = await windowIsFullscreen();
      if (active) usePlayerStore.getState().setIsFullscreen(initialFs);
    };

    void setup();

    return () => {
      active = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [pushNote, toggleFullscreen]);

  // Tauri native drag-and-drop (Fixes 16 & 19)
  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const bindDrop = async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onDragDropEvent(async (event) => {
          if (disposed) return;
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsDragActive(true);
            return;
          }
          if (payload.type === "leave") {
            setIsDragActive(false);
            return;
          }
          if (payload.type === "drop") {
            setIsDragActive(false);
            const dropGate = checkDropDuringDialog(dialogOpenRef.current);
            if (!dropGate.allowed) {
              if (dropGate.notice) pushNote("info", dropGate.notice);
              return;
            }
            const split = splitDroppedFiles(payload.paths || []);
            if (split.directorySuspected) {
              pushNote("warn", "Folders cannot be played directly — drop a video or subtitle file.");
            } else if (split.unsupportedFiles.length > 0 && !split.videoPath && !split.subtitlePath) {
              pushNote("warn", `Unsupported file type: ${split.unsupportedFiles.join(", ")}`);
            }
            if (split.extraVideoCount > 0) {
              pushNote("info", `Loaded first video; ignored ${split.extraVideoCount} extra video(s).`);
            }
            if (split.extraSubtitleCount > 0) {
              pushNote("info", `Loaded first subtitle; ignored ${split.extraSubtitleCount} extra subtitle(s).`);
            }
            if (split.videoPath) {
              await loadVideoPath(split.videoPath);
            }
            if (split.subtitlePath) {
              await loadSubtitlePath(split.subtitlePath);
            }
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch {
        // Ignore if running outside Tauri webview window
      }
    };

    void bindDrop();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadSubtitlePath, loadVideoPath, pushNote]);

  // Resize child mpv HWND inside the viewport container once started (Fix 15)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    const plan = viewportTrackerRef.current.planResize(rect);
    if (plan.send) {
      void mpvResize(rect, plan.forceFlag);
    }
  }, [rect]);

  // Hide child HWND whenever modals/popover overlay live video or player fails (Fix 16)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    if (panelOpen && loaded) {
      void mpvSetVisible(false);
      return;
    }
    void mpvSetVisible(!settingsOpen && !shortcutsOpen && !playerError);
  }, [settingsOpen, shortcutsOpen, playerError, panelOpen, loaded]);

  // Wake/auto-hide floating cinema chrome & allow Escape to close floating popover
  useEffect(() => {
    wakeChrome();
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
        idleTimerRef.current = null;
      }
    };
  }, [loaded, paused, panelOpen, settingsOpen, shortcutsOpen, playerError, wakeChrome]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      wakeChrome();
      if (e.code === "Escape" && panelOpenRef.current && !useAppStore.getState().settingsOpen && !useAppStore.getState().shortcutsOpen) {
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [wakeChrome]);

  const syncStatusState = syncStatus.state;
  const syncActiveEndpoint =
    syncStatus.state === "disconnected" ? serverEndpoint : syncStatus.endpoint || serverEndpoint;

  // Fix 02 + Fix 08 + Fix 09: Announce loaded file per session, auto-ready once loaded, and lock speed 1.0x
  useEffect(() => {
    const syncConnected = syncStatusState === "connected";

    const decision = shouldAnnounceFile(announcedFileKeyRef.current, {
      syncConnected,
      endpoint: syncActiveEndpoint,
      username,
      roomCode,
      fileName: selectedFileName,
      loaded,
      durationSecs,
      hashIdentity: hashFilenames,
    });
    announcedFileKeyRef.current = decision.nextKey;

    if (decision.announce && selectedFileName) {
      void syncSetFile({
        name: selectedFileName,
        path: selectedFilePath,
        durationSecs,
        hashIdentity: hashFilenames,
      });
    }

    if (
      shouldAutoReadyOnFileLoad({
        syncConnected,
        loaded,
        alreadyAutoMarked: autoReadyMarkedRef.current,
      })
    ) {
      autoReadyMarkedRef.current = true;
      useSyncStore.getState().setLocalReady(true);
      void syncSetReady(true, false);
    }

    if (shouldResetSpeedForSync(syncConnected, speed)) {
      usePlayerStore.getState().setSpeed(1.0);
      void mpvSetSpeed(1.0);
    }
  }, [
    durationSecs,
    hashFilenames,
    loaded,
    roomCode,
    selectedFileName,
    selectedFilePath,
    speed,
    syncActiveEndpoint,
    syncStatusState,
    username,
  ]);

  const chrome = resolveFullscreenChromeState({
    isFullscreen,
    panelOpen,
    modalsOpen: settingsOpen || shortcutsOpen,
  });

  const showFloatingCapsule = chrome.showTransportBar && !chromeIdle;
  const showWindowBar = !isFullscreen && !chromeIdle;

  const handleToggleCapsuleTab = (tab: SideTab) => {
    wakeChrome();
    if (panelOpen && sideTab === tab) {
      setPanelOpen(false);
    } else {
      setSideTab(tab);
      setPanelOpen(true);
    }
  };

  const handleLeaveRoom = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    announcedFileKeyRef.current = null;
    autoReadyMarkedRef.current = false;
    leaveRoom();
  };

  return (
    <div
      onMouseMove={wakeChrome}
      onPointerDown={wakeChrome}
      className="h-full w-full flex flex-col bg-canvas text-primary overflow-hidden"
    >
      <NotificationStrip />

      {showWindowBar ? (
        <TitleBar
          leftSlot={
            <div
              data-tauri-drag-region
              className="flex items-center gap-2.5 min-w-0"
            >
              <LogoMark size={20} />
              <span className="text-xs font-medium text-primary truncate max-w-[300px]">
                {selectedFileName || "Watch Theater"}
              </span>
              {roomCode && (
                <span className="text-[11px] text-secondary bg-white/[0.06] px-2 py-0.5 rounded-full truncate max-w-[140px]">
                  {roomCode}
                </span>
              )}
            </div>
          }
        />
      ) : (
        !isFullscreen && (
          <div
            data-tauri-drag-region
            onMouseEnter={wakeChrome}
            onMouseMove={wakeChrome}
            onClick={wakeChrome}
            title="Move mouse here to show window controls"
            className="h-1.5 w-full shrink-0 bg-canvas cursor-pointer"
          />
        )
      )}

      {/* Full-window video viewport (borderless frameless bar hides cleanly during playback for 100% pure video) */}
      <div
        ref={viewportRef}
        className="relative flex-1 min-w-0 min-h-0 bg-canvas"
      >
        <ViewportPlaceholder
          loaded={loaded}
          isDragActive={isDragActive}
          playerError={playerError}
          onChooseFile={() => void handleChooseFile()}
          onRetryPlayer={() => {
            void (async () => {
              usePlayerStore.getState().setPlayerError(null);
              await mpvStop().catch(() => undefined);
              viewportTrackerRef.current.markInvalidated();
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              const currentFile = useAppStore.getState().selectedFilePath;
              if (currentFile) {
                await loadVideoPath(currentFile);
              }
            })();
          }}
        />
      </div>

      {/* Floating Smoked-Amethyst Popover (Party / Playback / Subtitles) */}
      {panelOpen && (
        <>
          <div
            className="fixed inset-0 z-20"
            onClick={() => setPanelOpen(false)}
            aria-hidden="true"
          />
          <div className="fixed inset-x-0 bottom-26 z-30 flex justify-center px-4 pointer-events-none">
            <div className="ep-glass-sheet ep-popover-bloom pointer-events-auto w-full max-w-[390px] max-h-[calc(100vh-145px)] rounded-[24px] flex flex-col overflow-hidden">
              <div className="px-3 pt-3 pb-2 flex items-center justify-between gap-2">
                <SegmentedTabs
                  ariaLabel="Inspector panel"
                  value={sideTab}
                  onChange={setSideTab}
                  className="flex-1"
                  items={[
                    { value: "room", label: "Party" },
                    { value: "playback", label: "Playback" },
                    { value: "subtitles", label: "Subtitles" },
                  ]}
                />
                <button
                  type="button"
                  onClick={() => setPanelOpen(false)}
                  aria-label="Close popover"
                  className="ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              <div className="ep-hairline-divider mx-3" />
              <div className="flex-1 overflow-y-auto min-h-0">
                {sideTab === "room" && <RoomPanel />}
                {sideTab === "playback" && <PlaybackPanel />}
                {sideTab === "subtitles" && <SubtitlePanel />}
              </div>
            </div>
          </div>
        </>
      )}

      {showFloatingCapsule ? (
        <TransportBar
          activeTab={panelOpen ? sideTab : null}
          onToggleTab={handleToggleCapsuleTab}
          onChooseFile={() => void handleChooseFile()}
          onLeaveRoom={handleLeaveRoom}
          onHideControls={() => setChromeIdle(true)}
          onToggleFullscreen={toggleFullscreen}
        />
      ) : (
        <div
          onMouseEnter={wakeChrome}
          onMouseMove={wakeChrome}
          onClick={wakeChrome}
          title="Move mouse here to show controls"
          className="h-2 w-full shrink-0 bg-canvas cursor-pointer"
        />
      )}

      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        onApplyServerConfig={(endpoint, password) => connectRoom(endpoint, password)}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}
