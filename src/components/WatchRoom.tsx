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
  matchPeerEpisodeInPlaylist,
  naturalCompare,
  scanMediaPaths,
  type PlaylistItem,
} from "../lib/playlist";
import {
  formatControllerOverrideNotice,
  getControllerLockState,
  resolveEffectiveUsername,
} from "../lib/syncController";
import { shouldAnnounceFile } from "../lib/syncFileAnnounce";
import { shouldAutoReadyOnFileLoad } from "../lib/syncReady";
import { shouldResetSpeedForSync } from "../lib/syncSpeedGuard";
import { playSoundCue, RoomSoundTracker } from "../lib/soundEffects";
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
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";
import { EpisodesPanel } from "./EpisodesPanel";
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
  const participants = useSyncStore((s) => s.participants);
  const pushNote = useNotificationStore((s) => s.push);

  const playlistItems = usePlaylistStore((s) => s.items);
  const playlistIndex = usePlaylistStore((s) => s.currentIndex);
  const followPartyEpisode = usePlaylistStore((s) => s.followPartyEpisode);
  const activePlaylistItem =
    playlistIndex >= 0 && playlistIndex < playlistItems.length
      ? playlistItems[playlistIndex]
      : null;

  const [sideTab, setSideTab] = useState<SideTab>("room");
  const [panelOpen, setPanelOpen] = useState(false);
  const [chromeIdle, setChromeIdle] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [viewportTick, setViewportTick] = useState(0);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportTrackerRef = useRef(new ViewportSyncTracker());
  const soundTrackerRef = useRef(new RoomSoundTracker());
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
  const initialAutoLoadedRef = useRef(false);
  const pendingPairedSubRef = useRef<{ videoPath: string; subPath: string } | null>(null);
  const loadSubtitlePathRef = useRef<((path: string) => Promise<void>) | null>(null);
  const selectEpisodeAtIndexRef = useRef<((index: number) => Promise<void>) | null>(null);
  const lastPeerFileRef = useRef<string | null>(null);

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
        void mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !playerErr);
      })
      .finally(() => {
        mpvStartPromiseRef.current = null;
      });

    mpvStartPromiseRef.current = startPromise;
    await startPromise;
  }, []);

  // Load media + subtitle files safely
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
  loadSubtitlePathRef.current = loadSubtitlePath;

  const loadVideoPath = useCallback(
    async (path: string, pairedSubPath?: string | null) => {
      const gen = ++loadGenRef.current;
      const displayName = getFileDisplayName(path);
      void subtitleCancelAutoSync().catch(() => undefined);
      setSelectedFile(path, displayName);
      usePlaylistStore.getState().selectByPath(path);
      useSubtitleStore.getState().clearLoadedTrack();
      pendingPairedSubRef.current = pairedSubPath
        ? { videoPath: path, subPath: pairedSubPath }
        : null;
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
          const pendingSub = pendingPairedSubRef.current;
          if (pendingSub && pendingSub.videoPath.toLowerCase() === path.toLowerCase()) {
            pendingPairedSubRef.current = null;
            await loadSubtitlePath(pendingSub.subPath);
          }
        }
        usePlayerStore.getState().setPlayerError(null);
        usePlayerStore.getState().flashFeedback(`Loaded ${displayName}`);
      } catch (err) {
        if (loadGenRef.current !== gen) return;
        pendingPairedSubRef.current = null;
        const msg = formatUserError(err, "Failed opening video file.");
        usePlayerStore.getState().setPlayerError(msg);
        pushNote("error", msg);
        void logFrontendEvent("error", "player.load", msg, "ERR_LOAD");
      }
    },
    [ensureMpvStarted, loadSubtitlePath, pushNote, setSelectedFile],
  );

  const selectEpisodeAtIndex = useCallback(
    async (index: number) => {
      const pState = usePlaylistStore.getState();
      if (index < 0 || index >= pState.items.length) return;
      const s = useSyncStore.getState();
      const connected = s.status.state === "connected";
      const ctrlLock = getControllerLockState(
        connected,
        s.participants,
        resolveEffectiveUsername(s.status, useAppStore.getState().username),
      );
      if (ctrlLock.lockedForLocalUser) {
        pushNote("warn", "Episode selection is locked to the room controller.");
        return;
      }
      const target = pState.items[index];
      pState.setCurrentIndex(index);
      await loadVideoPath(target.path, target.subtitlePath);
    },
    [loadVideoPath, pushNote],
  );
  selectEpisodeAtIndexRef.current = selectEpisodeAtIndex;

  const handlePrevEpisode = useCallback(() => {
    const { currentIndex } = usePlaylistStore.getState();
    if (currentIndex > 0) {
      void selectEpisodeAtIndex(currentIndex - 1);
    }
  }, [selectEpisodeAtIndex]);

  const handleNextEpisode = useCallback(() => {
    const { currentIndex, items } = usePlaylistStore.getState();
    if (currentIndex >= 0 && currentIndex < items.length - 1) {
      void selectEpisodeAtIndex(currentIndex + 1);
    }
  }, [selectEpisodeAtIndex]);

  const loadMediaInputs = useCallback(
    async (paths: string[], options?: { append?: boolean }) => {
      const clean = paths.map((p) => p.trim()).filter(Boolean);
      if (clean.length === 0) return;
      const scan = await scanMediaPaths(clean);

      if (scan.items.length > 0) {
        const pStore = usePlaylistStore.getState();
        if (options?.append && pStore.items.length > 0) {
          const mergedMap = new Map<string, PlaylistItem>();
          for (const it of pStore.items) mergedMap.set(it.path.toLowerCase(), it);
          let addedCount = 0;
          for (const it of scan.items) {
            const key = it.path.toLowerCase();
            if (!mergedMap.has(key)) {
              mergedMap.set(key, it);
              addedCount += 1;
            }
          }
          const merged = Array.from(mergedMap.values()).sort((a, b) => {
            const sa = a.season ?? Number.MAX_SAFE_INTEGER;
            const sb = b.season ?? Number.MAX_SAFE_INTEGER;
            if (sa !== sb) return sa - sb;
            const ea = a.episode ?? Number.MAX_SAFE_INTEGER;
            const eb = b.episode ?? Number.MAX_SAFE_INTEGER;
            if (ea !== eb) return ea - eb;
            return naturalCompare(a.fileName, b.fileName);
          });
          const curPath = useAppStore.getState().selectedFilePath?.toLowerCase() ?? "";
          const keepIdx = merged.findIndex((it) => it.path.toLowerCase() === curPath);
          const nextIdx = keepIdx !== -1 ? keepIdx : 0;
          pStore.setPlaylist(merged, nextIdx, scan.folderName ?? pStore.folderName);
          if (addedCount > 0) {
            pushNote("success", `Added ${addedCount} episode${addedCount === 1 ? "" : "s"} to queue.`);
          }
          if (!usePlayerStore.getState().loaded && merged.length > 0) {
            await loadVideoPath(merged[nextIdx].path, merged[nextIdx].subtitlePath);
          }
          return;
        }

        let targetIndex = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
        const sState = useSyncStore.getState();
        if (sState.status.state === "connected" && pStore.followPartyEpisode) {
          const myName = resolveEffectiveUsername(sState.status, useAppStore.getState().username).toLowerCase();
          const leader =
            sState.participants.find((p) => p.isController && p.fileName) ??
            sState.participants.find((p) => p.username.toLowerCase() !== myName && p.fileName);
          if (leader?.fileName) {
            const peerMatch = matchPeerEpisodeInPlaylist(leader.fileName, scan.items);
            if (peerMatch !== -1) {
              targetIndex = peerMatch;
              lastPeerFileRef.current = leader.fileName.trim();
            }
          }
        }

        pStore.setPlaylist(scan.items, targetIndex, scan.folderName);
        const target = scan.items[targetIndex];
        const explicitMultiOrFolder = clean.length > 1 || splitDroppedFiles(clean).directorySuspected;
        if (scan.items.length > 1 && explicitMultiOrFolder) {
          pushNote(
            "success",
            `Queued ${scan.items.length} episodes${scan.folderName ? ` from ${scan.folderName}` : ""}`,
          );
        }
        await loadVideoPath(target.path, target.subtitlePath);
        if (scan.looseSubtitlePath && !target.subtitlePath) {
          pendingPairedSubRef.current = { videoPath: target.path, subPath: scan.looseSubtitlePath };
        }
        return;
      }

      if (scan.looseSubtitlePath) {
        await loadSubtitlePath(scan.looseSubtitlePath);
        return;
      }

      const split = splitDroppedFiles(clean);
      if (split.unsupportedFiles.length > 0) {
        pushNote("warn", `Unsupported file type: ${split.unsupportedFiles.join(", ")}`);
      } else {
        pushNote("warn", "No playable video or subtitle files found.");
      }
    },
    [loadSubtitlePath, loadVideoPath, pushNote],
  );

  const handleChooseFile = useCallback(
    async (append = false) => {
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
          multiple: true,
          title: append ? "Add Episode Files" : "Choose Video File(s)",
          filters: [
            {
              name: "Video Files",
              extensions: ["mkv", "mp4", "ts", "m2ts", "avi", "webm", "flv", "wmv", "ogv", "3gp", "*"],
            },
          ],
        });
        const picked = Array.isArray(chosen)
          ? chosen
          : typeof chosen === "string" && chosen
            ? [chosen]
            : [];
        if (picked.length > 0) {
          await loadMediaInputs(picked, append ? { append: true } : undefined);
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
    },
    [loadMediaInputs, pushNote],
  );

  const handleChooseSeasonFolder = useCallback(async () => {
    if (!isDesktop()) {
      pushNote("warn", "Folder picker requires the Windows desktop app.");
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
        directory: true,
        multiple: false,
        title: "Choose Season Folder",
      });
      if (typeof chosen === "string" && chosen) {
        await loadMediaInputs([chosen]);
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
  }, [loadMediaInputs, pushNote]);

  // Sync network share policy on mount
  useEffect(() => {
    void setAllowNetworkShares(allowNetworkShares);
  }, [allowNetworkShares]);

  // Connect / tear down Syncplay lifecycle serialized via FIFO queue (Fix 03 / Fix 17)
  const connectRoom = useCallback(
    (endpoint: string, password: string) => {
      if (!isDesktop() || !roomCode) return;
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

  // Auto-play preselected file or season folder when entering WatchRoom
  useEffect(() => {
    if (
      initialAutoLoadedRef.current ||
      !selectedFilePath ||
      !isDesktop() ||
      usePlayerStore.getState().loaded
    ) {
      return;
    }
    initialAutoLoadedRef.current = true;
    const timer = window.setTimeout(() => {
      const pState = usePlaylistStore.getState();
      const activeItem =
        pState.items.find((it) => it.path.toLowerCase() === selectedFilePath.toLowerCase()) ??
        (pState.currentIndex >= 0 ? pState.items[pState.currentIndex] : undefined);
      if (activeItem) {
        void loadVideoPath(selectedFilePath, activeItem.subtitlePath);
      } else {
        void scanMediaPaths([selectedFilePath]).then((scan) => {
          if (scan.items.length > 0) {
            const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
            usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
            const matched = scan.items[idx];
            void loadVideoPath(matched.path, matched.subtitlePath);
          } else {
            void loadVideoPath(selectedFilePath);
          }
        });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [loadVideoPath, selectedFilePath]);

  useEffect(() => {
    const timer = roomCode
      ? window.setTimeout(() => {
          roomSessionStartedRef.current = true;
          connectRoom(serverEndpoint, serverPassword);
        }, 0)
      : null;
    return () => {
      if (timer !== null) {
        window.clearTimeout(timer);
      }
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
          const pendingSub = pendingPairedSubRef.current;
          const activePath = useAppStore.getState().selectedFilePath;
          if (
            pendingSub &&
            activePath &&
            activePath.toLowerCase() === pendingSub.videoPath.toLowerCase()
          ) {
            pendingPairedSubRef.current = null;
            void loadSubtitlePathRef.current?.(pendingSub.subPath);
          }
        }),
        onMpvEnded((payload) => {
          if (!active) return;
          const decision = classifyMpvEnd(payload);
          if (decision.kind === "eof") {
            usePlayerStore.getState().setEndedAtEof(true);
            usePlayerStore.getState().setPaused(true);
            const playlist = usePlaylistStore.getState();
            if (
              playlist.autoPlayNext &&
              playlist.currentIndex >= 0 &&
              playlist.currentIndex < playlist.items.length - 1
            ) {
              const nextIdx = playlist.currentIndex + 1;
              const nextEp = playlist.items[nextIdx];
              pushNote("info", `Up next: ${nextEp.episodeBadge ?? nextEp.cleanTitle}`);
              void selectEpisodeAtIndexRef.current?.(nextIdx);
            }
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
            await loadMediaInputs(payload.paths || []);
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
  }, [loadMediaInputs, pushNote]);

  // Resize child mpv HWND inside the viewport container once started (Fix 15)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    const plan = viewportTrackerRef.current.planResize(rect);
    if (plan.send) {
      void mpvResize(rect, plan.forceFlag);
    }
  }, [rect]);

  // Hide child HWND whenever fullscreen modals overlay live video or player fails (Fix 16)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    void mpvSetVisible(!settingsOpen && !shortcutsOpen && !playerError);
  }, [settingsOpen, shortcutsOpen, playerError, loaded]);

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

  // Subtle room audio cues when joining, peers entering/leaving, or all viewers ready
  useEffect(() => {
    soundTrackerRef.current.reset();
    return () => {
      soundTrackerRef.current.reset();
    };
  }, [roomCode]);

  useEffect(() => {
    const cues = soundTrackerRef.current.update(syncStatus, participants, username);
    if (cues.length === 0) return;
    const player = usePlayerStore.getState();
    const moviePlaying = player.loaded && !player.paused;
    for (const cue of cues) {
      playSoundCue(cue, { moviePlaying });
    }
  }, [participants, syncStatus, username]);

  // Follow controller / party member when switching episodes within a loaded season queue
  useEffect(() => {
    if (syncStatus.state !== "connected" || !followPartyEpisode || playlistItems.length === 0) {
      if (syncStatus.state !== "connected") {
        lastPeerFileRef.current = null;
      }
      return;
    }
    const myName = resolveEffectiveUsername(syncStatus, username).toLowerCase();
    const otherPeers = participants.filter(
      (p) => p.username.toLowerCase() !== myName && Boolean(p.fileName),
    );
    if (otherPeers.length === 0) {
      lastPeerFileRef.current = null;
      return;
    }
    const leader = otherPeers.find((p) => p.isController) ?? otherPeers[0];
    const peerFile = leader.fileName?.trim() || null;
    if (!peerFile || peerFile === lastPeerFileRef.current) {
      return;
    }
    lastPeerFileRef.current = peerFile;
    const matchedIdx = matchPeerEpisodeInPlaylist(peerFile, playlistItems);
    if (matchedIdx !== -1 && matchedIdx !== playlistIndex) {
      const target = playlistItems[matchedIdx];
      pushNote(
        "info",
        `Following ${leader.username} to ${target.episodeBadge ?? target.cleanTitle}`,
      );
      void selectEpisodeAtIndex(matchedIdx);
    }
  }, [
    followPartyEpisode,
    participants,
    playlistIndex,
    playlistItems,
    pushNote,
    selectEpisodeAtIndex,
    syncStatus,
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
    soundTrackerRef.current.reset();
    pendingPairedSubRef.current = null;
    lastPeerFileRef.current = null;
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
              {activePlaylistItem?.episodeBadge && (
                <span className="shrink-0 rounded-full bg-accent/18 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-accent-soft border border-accent/30">
                  {activePlaylistItem.episodeBadge}
                </span>
              )}
              <span className="text-xs font-medium text-primary truncate max-w-[300px]">
                {selectedFileName || (roomCode ? "Watch Theater" : "Media Player")}
              </span>
              {roomCode ? (
                <span className="text-[11px] text-secondary bg-white/[0.06] px-2 py-0.5 rounded-full truncate max-w-[140px]">
                  {roomCode}
                </span>
              ) : (
                <span className="text-[11px] text-secondary bg-white/[0.06] px-2 py-0.5 rounded-full">
                  Solo
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
          onChooseFolder={() => void handleChooseSeasonFolder()}
          onRetryPlayer={() => {
            void (async () => {
              usePlayerStore.getState().setPlayerError(null);
              await mpvStop().catch(() => undefined);
              viewportTrackerRef.current.markInvalidated();
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              const currentFile = useAppStore.getState().selectedFilePath;
              if (currentFile) {
                const matchItem = usePlaylistStore
                  .getState()
                  .items.find((it) => it.path.toLowerCase() === currentFile.toLowerCase());
                await loadVideoPath(currentFile, matchItem?.subtitlePath);
              }
            })();
          }}
        />
        {panelOpen && (
          <div
            className="absolute inset-0 z-20"
            onClick={() => setPanelOpen(false)}
            aria-hidden="true"
          />
        )}
      </div>

      {showFloatingCapsule ? (
        <TransportBar
          activeTab={panelOpen ? sideTab : null}
          onToggleTab={handleToggleCapsuleTab}
          onChooseFile={() => void handleChooseFile()}
          onLeaveRoom={handleLeaveRoom}
          onHideControls={() => setChromeIdle(true)}
          onToggleFullscreen={toggleFullscreen}
          onPrevEpisode={handlePrevEpisode}
          onNextEpisode={handleNextEpisode}
          expandedDrawer={
            panelOpen ? (
              <div className="space-y-2.5">
                <div className="flex items-center justify-between gap-3 px-1">
                  <SegmentedTabs
                    ariaLabel="Inspector panel"
                    value={sideTab}
                    onChange={setSideTab}
                    className="w-full max-w-[380px]"
                    items={[
                      { value: "room", label: "Party" },
                      { value: "episodes", label: "Episodes" },
                      { value: "playback", label: "Playback" },
                      { value: "subtitles", label: "Subtitles" },
                    ]}
                  />
                  <button
                    type="button"
                    onClick={() => setPanelOpen(false)}
                    aria-label="Close popover"
                    title="Collapse play bar (Esc)"
                    className="ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white hover:bg-white/10 cursor-pointer shrink-0"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <div className="max-h-[42vh] overflow-visible">
                  {sideTab === "room" && <RoomPanel />}
                  {sideTab === "episodes" && (
                    <EpisodesPanel
                      onSelectEpisode={(idx) => void selectEpisodeAtIndex(idx)}
                      onOpenSeasonFolder={() => void handleChooseSeasonFolder()}
                      onAddEpisodes={() => void handleChooseFile(true)}
                    />
                  )}
                  {sideTab === "playback" && <PlaybackPanel />}
                  {sideTab === "subtitles" && <SubtitlePanel />}
                </div>
              </div>
            ) : null
          }
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
