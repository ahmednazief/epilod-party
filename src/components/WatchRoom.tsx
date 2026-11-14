import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  LogOut,
  PanelRightClose,
  PanelRightOpen,
  Settings,
} from "lucide-react";
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
  mpvSetPause,
  mpvSetSpeed,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetVisible,
  mpvStart,
  mpvStop,
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
  windowIsFullscreen,
  windowSetFullscreen,
} from "../lib/mpv";
import { classifyMpvEnd } from "../lib/playbackEnd";
import { checkDropDuringDialog, handlePlayerCrashSync } from "../lib/playerLifecycle";
import { resetMpvPlaybackDefaults } from "../lib/playbackReset";
import {
  formatControllerOverrideNotice,
  getControllerLockState,
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
} from "../lib/syncplay";
import { useViewportRect } from "../lib/useViewportRect";
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
import { TransportBar } from "./TransportBar";
import { ViewportPlaceholder } from "./ViewportPlaceholder";
import { Button } from "./ui/Button";
import { LogoMark } from "./ui/LogoMark";
import { NotificationStrip } from "./ui/NotificationStrip";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { StatusDot } from "./ui/StatusDot";

type SideTab = "room" | "playback" | "subtitles";

export function WatchRoom() {
  const {
    username,
    roomCode,
    literalRoom,
    serverEndpoint,
    serverPassword,
    allowNetworkShares,
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
      settingsOpen: s.settingsOpen,
      shortcutsOpen: s.shortcutsOpen,
      selectedFilePath: s.selectedFilePath,
      selectedFileName: s.selectedFileName,
    })),
  );

  const openSettings = useAppStore((s) => s.openSettings);
  const closeSettings = useAppStore((s) => s.closeSettings);
  const closeShortcuts = useAppStore((s) => s.closeShortcuts);
  const leaveRoom = useAppStore((s) => s.leaveRoom);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);

  const loaded = usePlayerStore((s) => s.loaded);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const speed = usePlayerStore((s) => s.speed);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const playerError = usePlayerStore((s) => s.playerError);
  const feedback = usePlayerStore((s) => s.feedback);

  const syncStatus = useSyncStore((s) => s.status);
  const pushNote = useNotificationStore((s) => s.push);

  const [sideTab, setSideTab] = useState<SideTab>("room");
  const [panelOpen, setPanelOpen] = useState(true);
  const [isDragActive, setIsDragActive] = useState(false);
  const [viewportTick, setViewportTick] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportTrackerRef = useRef(new ViewportSyncTracker());
  const mpvStartedRef = useRef(false);
  const announcedFileKeyRef = useRef<string | null>(null);
  const autoReadyMarkedRef = useRef(false);
  const dialogOpenRef = useRef(false);
  const leavingRef = useRef(false);

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

  // Load media + subtitle files safely
  const loadVideoPath = useCallback(
    async (path: string) => {
      const displayName = getFileDisplayName(path);
      setSelectedFile(path, displayName);
      autoReadyMarkedRef.current = false;
      try {
        await mpvLoad(path);
        const subState = useSubtitleStore.getState();
        await resetMpvPlaybackDefaults(useSyncStore.getState().status.state === "connected");
        await mpvSetSubStyle({
          font: subState.font,
          fontSize: subState.fontSize,
          color: subState.color,
          borderSize: subState.borderSize,
          pos: subState.pos,
          visible: subState.visible,
          overrideAss: subState.overrideAssStyle,
        });
        usePlayerStore.getState().setLoaded(true);
        usePlayerStore.getState().setPlayerError(null);
        usePlayerStore.getState().flashFeedback(`Loaded ${displayName}`);
      } catch (err) {
        const msg = formatUserError(err, "Failed opening video file.");
        usePlayerStore.getState().setPlayerError(msg);
        pushNote("error", msg);
        void logFrontendEvent("error", "player.load", msg, "ERR_LOAD");
      }
    },
    [pushNote, setSelectedFile],
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
    connectRoom(serverEndpoint, serverPassword);
    return () => {
      void enqueueSyncLifecycle(async () => {
        await syncDisconnect();
        await mpvStop();
        mpvStartedRef.current = false;
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
          const lock = getControllerLockState(connected, s.participants, app.username);
          if (lock.lockedForLocalUser) return;
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

  // Start / resize child mpv HWND inside the viewport container (Fix 15)
  useEffect(() => {
    if (!isDesktop()) return;
    if (!mpvStartedRef.current) {
      if (rect.width > 0 && rect.height > 0) {
        mpvStartedRef.current = true;
        void mpvStart(rect).catch((err) => {
          mpvStartedRef.current = false;
          const msg = formatUserError(err, "Failed starting mpv playback engine.");
          usePlayerStore.getState().setPlayerError(msg);
        });
      }
      return;
    }

    const plan = viewportTrackerRef.current.planResize(rect);
    if (plan.send) {
      void mpvResize(rect, plan.forceFlag);
    }
  }, [rect]);

  // Hide child HWND whenever modals overlay or player fails (Fix 16)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    void mpvSetVisible(!settingsOpen && !shortcutsOpen && !playerError);
  }, [settingsOpen, shortcutsOpen, playerError]);

  // Fix 02 + Fix 08 + Fix 09: Announce loaded file per session, auto-ready once loaded, and lock speed 1.0x
  useEffect(() => {
    const syncConnected = syncStatus.state === "connected";
    const activeEp =
      syncStatus.state === "disconnected" ? serverEndpoint : syncStatus.endpoint || serverEndpoint;

    const decision = shouldAnnounceFile(announcedFileKeyRef.current, {
      syncConnected,
      endpoint: activeEp,
      username,
      roomCode,
      fileName: selectedFileName,
      loaded,
      durationSecs,
    });
    announcedFileKeyRef.current = decision.nextKey;

    if (decision.announce && selectedFileName) {
      void syncSetFile({
        name: selectedFileName,
        path: selectedFilePath,
        durationSecs,
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
    loaded,
    roomCode,
    selectedFileName,
    selectedFilePath,
    serverEndpoint,
    speed,
    syncStatus,
    username,
  ]);

  const chrome = resolveFullscreenChromeState({
    isFullscreen,
    panelOpen,
    modalsOpen: settingsOpen || shortcutsOpen,
  });

  const handleLeaveRoom = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    announcedFileKeyRef.current = null;
    autoReadyMarkedRef.current = false;
    leaveRoom();
  };

  return (
    <div className="h-full w-full flex flex-col bg-canvas text-primary overflow-hidden">
      {chrome.showTopBar && (
        <header className="h-11 shrink-0 flex items-center justify-between px-3 bg-chrome border-b border-hairline select-none">
          <div className="flex items-center gap-2.5 min-w-0">
            <LogoMark size={24} />
            <div className="flex items-center gap-2 min-w-0">
              <StatusDot
                tone={
                  syncStatus.state === "connected"
                    ? "ok"
                    : syncStatus.state === "error"
                      ? "bad"
                      : "warn"
                }
                pulse={syncStatus.state === "connecting" || syncStatus.state === "reconnecting"}
              />
              <span className="text-xs font-medium text-primary truncate">
                {selectedFileName || `Room ${roomCode}`}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {feedback && (
              <span
                key={feedback.id}
                className="anim-pop-in px-2 py-0.5 text-[11px] font-medium bg-raised text-accent border border-hairline rounded-[var(--radius-ui)]"
              >
                {feedback.text}
              </span>
            )}

            <Button variant="secondary" size="sm" onClick={() => void handleChooseFile()}>
              <FolderOpen className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">Open File</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={openSettings}
              aria-label="Open settings"
              title="Settings"
            >
              <Settings className="h-3.5 w-3.5" />
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPanelOpen((o) => !o)}
              aria-label={panelOpen ? "Collapse side panel" : "Expand side panel"}
              title={panelOpen ? "Hide panel" : "Show panel"}
            >
              {panelOpen ? (
                <PanelRightClose className="h-3.5 w-3.5" />
              ) : (
                <PanelRightOpen className="h-3.5 w-3.5" />
              )}
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleLeaveRoom}
              aria-label="Leave room"
              title="Leave room"
            >
              <LogOut className="h-3.5 w-3.5" />
            </Button>
          </div>
        </header>
      )}

      <NotificationStrip />

      <div className="flex-1 min-h-0 flex">
        <div ref={viewportRef} className="relative flex-1 min-w-0 min-h-0 bg-canvas">
          <ViewportPlaceholder
            loaded={loaded}
            isDragActive={isDragActive}
            playerError={playerError}
            onChooseFile={() => void handleChooseFile()}
            onRetryPlayer={() => {
              usePlayerStore.getState().setPlayerError(null);
              mpvStartedRef.current = false;
              setViewportTick((t) => t + 1);
            }}
          />
        </div>

        {chrome.showPanel && (
          <aside className="anim-drawer-in w-72 shrink-0 flex flex-col bg-chrome border-l border-hairline min-h-0">
            <div className="p-2 border-b border-hairline">
              <SegmentedTabs
                ariaLabel="Inspector panel"
                value={sideTab}
                onChange={setSideTab}
                className="w-full"
                items={[
                  { value: "room", label: "Room" },
                  { value: "playback", label: "Playback" },
                  { value: "subtitles", label: "Subtitles" },
                ]}
              />
            </div>

            <div className="flex-1 overflow-y-auto min-h-0">
              {sideTab === "room" && <RoomPanel />}
              {sideTab === "playback" && <PlaybackPanel />}
              {sideTab === "subtitles" && <SubtitlePanel />}
            </div>
          </aside>
        )}
      </div>

      {chrome.showTransportBar && <TransportBar onToggleFullscreen={toggleFullscreen} />}

      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        onApplyServerConfig={(endpoint, password) => connectRoom(endpoint, password)}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}
