import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppChevronIcon,
  AppFolderIcon,
  AppKeyboardIcon,
} from "./ui/AppIcons";
import { WatchPartyIcon } from "./ui/LobbyIcons";
import {
  PartyLeaveIcon,
  PlayerAudioIcon,
  PlayerCaptionsIcon,
  PlayerEpisodesIcon,
  PlayerEyeIcon,
  PlayerFullscreenIcon,
  PlayerPauseIcon,
  PlayerPlayIcon,
  PlayerReadyIcon,
  PlayerResyncIcon,
  PlayerSeekIcon,
  PlayerSettingsIcon,
  PlayerSkipEpisodeIcon,
  PlayerVolumeIcon,
} from "./ui/PlayerIcons";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { usePlayerShortcuts } from "../hooks/usePlayerShortcuts";
import { isDesktop } from "../lib/bridge";
import { formatUserError } from "../lib/errors";
import { getFileDisplayName, splitDroppedFiles } from "../lib/fileDrop";
import { resolveFullscreenChromeState } from "../lib/fullscreenUi";
import { logFrontendEvent } from "../lib/logger";
import {
  enqueueMpvLifecycle,
  isMpvNotRunningError,
  mpvAddSubtitle,
  mpvGetSurfaceState,
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
  onMpvSurfaceState,
  onMpvTime,
  onMpvTracks,
  onWindowFullscreen,
  onWindowRestored,
  safeMpvCall,
  setAllowNetworkShares,
  subscribeMpvRuntimeLost,
  subtitleCancelAutoSync,
  windowIsFullscreen,
  windowSetFullscreen,
} from "../lib/mpv";
import { classifyMpvEnd, shouldReplayFromStart } from "../lib/playbackEnd";
import {
  autoEnableEmbeddedSubtitle,
  ensureSubtitlesOn,
  cycleAudioTrack,
  cycleSubtitleTrack,
  seekPlaybackRelative,
  toggleMutePlayback,
  toggleReadyStatus,
  toggleSubtitlesVisibility,
} from "../lib/playerActions";
import { checkDropDuringDialog, handlePlayerCrashSync } from "../lib/playerLifecycle";
import { resetMpvPlaybackDefaults } from "../lib/playbackReset";
import {
  formatDisplayMediaTitle,
  matchPeerEpisodeInPlaylist,
  naturalCompare,
  scanMediaPaths,
  type PlaylistItem,
} from "../lib/playlist";
import { isTextEntryElement } from "../lib/shortcuts";
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
  syncForceResync,
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
import {
  useAnimatedPresence,
  usePresencePayload,
} from "../lib/useAnimatedPresence";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useSubtitleStore } from "../store/useSubtitleStore";
import { useSyncStore } from "../store/useSyncStore";
import { EpisodesPanel } from "./EpisodesPanel";
import { formatRoomCodeDisplay } from "./HomeScreen";
import { PlaybackPanel } from "./PlaybackPanel";
import { RoomPanel } from "./RoomPanel";
import { SettingsModal } from "./SettingsModal";
import { ShortcutsModal } from "./ShortcutsModal";
import { SubtitlePanel } from "./SubtitlePanel";
import { TitleBar } from "./TitleBar";
import { TransportBar, type CapsuleTab } from "./TransportBar";
import { VideoGlassBackdrop } from "./VideoGlassBackdrop";
import { ViewportPlaceholder } from "./ViewportPlaceholder";
import { ContextMenu, type ContextMenuEntry } from "./ui/ContextMenu";
import { NotificationStrip } from "./ui/NotificationStrip";
import { StatusDot } from "./ui/StatusDot";

type SideTab = CapsuleTab;

interface CapsulePopoverLayout {
  left: number;
  bottom: number;
  width: number;
}

/**
 * Anchors play bar menus (Watch Party, Episodes, CC, Audio) centered directly above
 * their trigger button and clamped inside the play bar's horizontal footprint.
 */
function computeCapsulePopoverLayout(tab: SideTab): CapsulePopoverLayout {
  const winW = window.innerWidth;
  const maxWidth = tab === "room" ? 352 : tab === "episodes" ? 344 : 304;
  const width = Math.min(maxWidth, Math.max(240, winW - 32));
  const barEl = document.querySelector<HTMLElement>('[data-capsule-bar="true"]');
  const anchorEl = document.querySelector<HTMLElement>(`[data-capsule-anchor="${tab}"]`);

  const barRect = barEl?.getBoundingClientRect();
  const barHeight = barEl ? Math.max(barEl.offsetHeight, barRect?.height ?? 0) : 104;
  // Measure from both resting bottom padding (16px) and live rect top so menus always float ~18px above the bar.
  const barTopDist = Math.max(
    barHeight + 16,
    barRect && barRect.height > 0 ? window.innerHeight - barRect.top : 0,
  );
  const bottom = Math.max(136, Math.round(barTopDist + 18));

  const minLeft = barRect && barRect.width > 0 ? Math.max(16, Math.round(barRect.left)) : 16;
  const maxRight =
    barRect && barRect.width > 0 ? Math.min(winW - 16, Math.round(barRect.right)) : winW - 16;
  const maxLeft = Math.max(minLeft, maxRight - width);

  const btnRect = anchorEl?.getBoundingClientRect();
  const desiredLeft =
    btnRect && btnRect.width > 0
      ? btnRect.left + btnRect.width / 2 - width / 2
      : (minLeft + maxRight) / 2 - width / 2;

  return {
    left: Math.round(Math.max(minLeft, Math.min(desiredLeft, maxLeft))),
    bottom,
    width,
  };
}

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
  const openSettings = useAppStore((s) => s.openSettings);
  const closeShortcuts = useAppStore((s) => s.closeShortcuts);
  const openShortcuts = useAppStore((s) => s.openShortcuts);
  const leaveRoom = useAppStore((s) => s.leaveRoom);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);

  const loaded = usePlayerStore((s) => s.loaded);
  const engineSurfaceVisible = usePlayerStore((s) => s.engineSurfaceVisible);
  const paused = usePlayerStore((s) => s.paused);
  const muted = usePlayerStore((s) => s.muted);
  const durationSecs = usePlayerStore((s) => s.durationSecs);
  const speed = usePlayerStore((s) => s.speed);
  const isFullscreen = usePlayerStore((s) => s.isFullscreen);
  const playerError = usePlayerStore((s) => s.playerError);

  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const localReady = useSyncStore((s) => s.localReady);
  const subVisible = useSubtitleStore((s) => s.visible);
  const pushNote = useNotificationStore((s) => s.push);

  const playlistItems = usePlaylistStore((s) => s.items);
  const playlistIndex = usePlaylistStore((s) => s.currentIndex);
  const folderName = usePlaylistStore((s) => s.folderName);
  const hasFolderEpisodes = Boolean(folderName) || playlistItems.length > 1;
  const followPartyEpisode = usePlaylistStore((s) => s.followPartyEpisode);
  const activePlaylistItem =
    playlistIndex >= 0 && playlistIndex < playlistItems.length
      ? playlistItems[playlistIndex]
      : null;
  const displayMedia = formatDisplayMediaTitle(selectedFileName || "");
  const cleanHeaderTitle = selectedFileName
    ? displayMedia.subtitle
      ? `${displayMedia.subtitle} — ${displayMedia.title}`
      : displayMedia.title || selectedFileName
    : roomCode
      ? "Watch Theater"
      : "Media Player";

  const [sideTab, setSideTab] = useState<SideTab>("room");
  const [panelOpen, setPanelOpen] = useState(false);
  const [chromeIdle, setChromeIdle] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [viewportTick, setViewportTick] = useState(0);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [popoverPos, setPopoverPos] = useState<CapsulePopoverLayout | null>(null);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const viewportTrackerRef = useRef(new ViewportSyncTracker());
  const soundTrackerRef = useRef(new RoomSoundTracker());
  const mountedRef = useRef(true);
  const mpvLifecycleActiveRef = useRef(false);
  const mpvStartedRef = useRef(false);
  const mpvStartPromiseRef = useRef<Promise<void> | null>(null);
  const listenersReadyPromiseRef = useRef<Promise<void>>(Promise.resolve());
  const loadInFlightRef = useRef(false);
  const roomSessionStartedRef = useRef(false);
  const panelOpenRef = useRef(false);
  const contextMenuOpenRef = useRef(false);
  const idleTimerRef = useRef<number | null>(null);
  const announcedFileKeyRef = useRef<string | null>(null);
  const autoReadyMarkedRef = useRef(false);
  const dialogOpenRef = useRef(false);
  const leavingRef = useRef(false);
  const loadGenRef = useRef(0);
  const autoLoadedPathRef = useRef<string | null>(null);
  const pendingPairedSubRef = useRef<{ videoPath: string; subPath: string } | null>(null);
  const loadSubtitlePathRef = useRef<((path: string) => Promise<void>) | null>(null);
  const selectEpisodeAtIndexRef = useRef<((index: number) => Promise<void>) | null>(null);
  const lastPeerFileRef = useRef<string | null>(null);
  const surfaceClickTimerRef = useRef<number | null>(null);

  panelOpenRef.current = panelOpen;
  contextMenuOpenRef.current = contextMenu !== null;

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
      !contextMenuOpenRef.current &&
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

  const toggleViewportPlayback = useCallback(() => {
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
      safeMpvCall(mpvSeek(0), "mpvSeek:replay");
      safeMpvCall(mpvSetPause(false), "mpvSetPause:replay");
      if (connected) {
        void syncUserSeek(0);
        void syncUserPlay(0);
      }
      return;
    }
    const nextPaused = !p.paused;
    p.setPaused(nextPaused);
    safeMpvCall(mpvSetPause(nextPaused), "mpvSetPause");
    if (connected) {
      if (nextPaused) void syncUserPause(p.positionSecs);
      else void syncUserPlay(p.positionSecs);
    }
  }, []);

  usePlayerShortcuts({
    onToggleFullscreen: toggleFullscreen,
    onExitFullscreen: exitFullscreen,
  });

  const ensureMpvStarted = useCallback(async () => {
    if (!isDesktop() || !mountedRef.current || mpvStartedRef.current) return;
    if (mpvStartPromiseRef.current) {
      await mpvStartPromiseRef.current;
      return;
    }

    const startPromise = enqueueMpvLifecycle(async () => {
      await listenersReadyPromiseRef.current;
      if (!mountedRef.current || mpvStartedRef.current) return;

      const rawRect = measurePhysicalRect(viewportRef.current);
      const initialRect = {
        x: rawRect.x,
        y: rawRect.y,
        width: Math.max(1, rawRect.width),
        height: Math.max(1, rawRect.height),
      };

      mpvLifecycleActiveRef.current = true;
      try {
        await mpvStart(initialRect);
      } catch (err) {
        mpvLifecycleActiveRef.current = false;
        throw err;
      }

      if (!mountedRef.current) {
        return;
      }

      mpvStartedRef.current = true;
      viewportTrackerRef.current.markInvalidated();
      setViewportTick((t) => t + 1);
      const appState = useAppStore.getState();
      const playerErr = usePlayerStore.getState().playerError;
      safeMpvCall(
        mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !playerErr),
        "mpvSetVisible:start",
      );
    }).finally(() => {
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
      loadInFlightRef.current = true;
      const displayName = getFileDisplayName(path);
      autoLoadedPathRef.current = path;
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
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        await mpvLoad(path);
        if (loadGenRef.current !== gen) return;
        usePlayerStore.getState().setLoaded(true);
        if (!mountedRef.current) return;
        usePlayerStore.getState().setPlayerError(null);
        const subState = useSubtitleStore.getState();
        await resetMpvPlaybackDefaults(useSyncStore.getState().status.state === "connected");
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        await mpvSetSubStyle({
          font: subState.font,
          fontSize: subState.fontSize,
          color: subState.color,
          borderSize: subState.borderSize,
          pos: subState.pos,
          visible: subState.visible,
          overrideAss: subState.overrideAssStyle,
        });
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        const appNow = useAppStore.getState();
        if (!useAppStore.getState().roomCode) {
          usePlayerStore.getState().setPaused(false);
          await mpvSetPause(false);
          if (loadGenRef.current !== gen || !mountedRef.current) return;
        } else {
          const syncNow = useSyncStore.getState();
          const syncConnNow = syncNow.status.state === "connected";
          const effUserNow = resolveEffectiveUsername(syncNow.status, appNow.username);
          const lockNow = getControllerLockState(syncConnNow, syncNow.participants, effUserNow);
          const otherPeersWithFile = syncNow.participants.filter(
            (p) =>
              p.username.trim().toLowerCase() !== effUserNow.trim().toLowerCase() &&
              Boolean(p.fileName),
          );
          if (!lockNow.lockedForLocalUser && otherPeersWithFile.length === 0) {
            usePlayerStore.getState().setPaused(false);
            await mpvSetPause(false);
            if (loadGenRef.current !== gen || !mountedRef.current) return;
            if (syncConnNow) {
              useSyncStore.getState().setLocalReady(true);
              void syncSetReady(true, true);
              void syncUserPlay(0);
            }
          }
        }
        if (!isDesktop()) {
          const pendingSub = pendingPairedSubRef.current;
          if (pendingSub && pendingSub.videoPath.toLowerCase() === path.toLowerCase()) {
            pendingPairedSubRef.current = null;
            await loadSubtitlePath(pendingSub.subPath);
          }
        }
        usePlayerStore.getState().flashFeedback(`Loaded ${displayName}`);
      } catch (err) {
        if (loadGenRef.current !== gen || !mountedRef.current) return;
        pendingPairedSubRef.current = null;
        if (isMpvNotRunningError(err)) {
          mpvStartedRef.current = false;
          mpvStartPromiseRef.current = null;
          mpvLifecycleActiveRef.current = false;
        }
        usePlayerStore.getState().setEngineSurfaceVisible(false);
        const msg = formatUserError(err, "Failed opening video file.");
        usePlayerStore.getState().setPlayerError(msg);
        pushNote("error", msg);
        void logFrontendEvent("error", "player.load", msg, "ERR_LOAD");
      } finally {
        if (loadGenRef.current === gen) {
          loadInFlightRef.current = false;
        }
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
      let scan: Awaited<ReturnType<typeof scanMediaPaths>>;
      try {
        scan = await scanMediaPaths(clean);
      } catch {
        await loadVideoPath(clean[0]);
        return;
      }

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
          try {
          await mpvSetVisible(false);
        } catch {
          // Engine may not be alive if runtime exited.
        }
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
          safeMpvCall(
          mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !pState.playerError),
          "mpvSetVisible",
        );
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
        try {
          await mpvSetVisible(false);
        } catch {
          // Engine may not be alive if runtime exited.
        }
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
        safeMpvCall(
          mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !pState.playerError),
          "mpvSetVisible",
        );
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
      !selectedFilePath ||
      !isDesktop() ||
      usePlayerStore.getState().loaded ||
      autoLoadedPathRef.current === selectedFilePath
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      autoLoadedPathRef.current = selectedFilePath;
      const pState = usePlaylistStore.getState();
      const activeItem =
        pState.items.find((it) => it.path.toLowerCase() === selectedFilePath.toLowerCase()) ??
        (pState.currentIndex >= 0 ? pState.items[pState.currentIndex] : undefined);
      if (activeItem) {
        void loadVideoPath(selectedFilePath, activeItem.subtitlePath);
      } else {
        void scanMediaPaths([selectedFilePath])
          .then((scan) => {
            if (scan.items.length > 0) {
              const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
              usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
              const matched = scan.items[idx];
              void loadVideoPath(matched.path, matched.subtitlePath);
            } else {
              void loadVideoPath(selectedFilePath);
            }
          })
          .catch(() => {
            void loadVideoPath(selectedFilePath);
          });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [loadVideoPath, selectedFilePath, recoveryTick]);

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
      if (!roomSessionStartedRef.current) {
        return;
      }
      roomSessionStartedRef.current = false;
      void enqueueSyncLifecycle(async () => {
        await syncDisconnect();
      });
    };
    // Initial room mount + room transition lifecycle; server config changes use onApplyServerConfig
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  // Stop embedded mpv child HWND only when leaving WatchRoom completely
  // Tear down any remaining Syncplay/mpv session when leaving WatchRoom entirely (HMR / ErrorBoundary / route switch)
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const hadMpv = mpvLifecycleActiveRef.current || mpvStartedRef.current;
      mpvLifecycleActiveRef.current = false;
      mpvStartedRef.current = false;
      mpvStartPromiseRef.current = null;
      usePlayerStore.getState().setEngineSurfaceVisible(false);
      if (roomSessionStartedRef.current) {
        roomSessionStartedRef.current = false;
        void enqueueSyncLifecycle(async () => {
          await syncDisconnect();
        });
      }
      if (hadMpv && isDesktop()) {
        void enqueueMpvLifecycle(async () => {
          await mpvStop().catch(() => undefined);
        });
      }
    };
  }, []);

  // Reconcile frontend loaded state with actual backend mpv surface state after mount / HMR / ErrorBoundary recovery
  useEffect(() => {
    if (!isDesktop()) return;
    let cancelled = false;
    const reconcile = async () => {
      await listenersReadyPromiseRef.current;
      if (cancelled || !mountedRef.current) return;
      try {
        const st = await mpvGetSurfaceState();
        if (cancelled || !mountedRef.current) return;
        const p = usePlayerStore.getState();
        p.setEngineSurfaceVisible(st.surfaceVisible);
        if (st.running) {
          mpvStartedRef.current = true;
          mpvLifecycleActiveRef.current = true;
          viewportTrackerRef.current.markInvalidated();
          setViewportTick((t) => t + 1);
          const appState = useAppStore.getState();
          safeMpvCall(
            mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !p.playerError),
            "mpvSetVisible:reconcile",
          );
          if (!st.hasMedia && p.loaded && !loadInFlightRef.current) {
            p.resetForNewFile();
            autoLoadedPathRef.current = null;
            setRecoveryTick((n) => n + 1);
          }
        } else {
          mpvStartedRef.current = false;
          mpvStartPromiseRef.current = null;
          mpvLifecycleActiveRef.current = false;
          if (p.loaded && !loadInFlightRef.current) {
            p.resetForNewFile();
            autoLoadedPathRef.current = null;
            setRecoveryTick((n) => n + 1);
          }
        }
      } catch {
        // Ignore outside Tauri runtime or transient unmount.
      }
    };
    void reconcile();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to mpv, window, and syncplay backend events
  useEffect(() => {
    let active = true;
    const unlisteners: Array<() => void> = [];
    let settled = false;
    let resolveReady!: () => void;
    listenersReadyPromiseRef.current = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const markListenersReady = () => {
      if (!settled) {
        settled = true;
        resolveReady();
      }
    };

    const unsubRuntimeLost = subscribeMpvRuntimeLost((reason) => {
      if (!active || leavingRef.current || loadInFlightRef.current) return;
      const p = usePlayerStore.getState();
      if (!p.loaded && !mpvStartedRef.current) return;
      mpvStartedRef.current = false;
      mpvStartPromiseRef.current = null;
      mpvLifecycleActiveRef.current = false;
      p.setEngineSurfaceVisible(false);
      if (p.loaded && !p.playerError) {
        const msg = "Playback engine stopped unexpectedly.";
        p.setPlayerError(msg);
        pushNote("error", msg);
        void logFrontendEvent("error", "player.runtime_lost", reason, "ERR_MPV_RUNTIME_LOST");
        const s = useSyncStore.getState();
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
    });
    unlisteners.push(unsubRuntimeLost);

    const setup = async () => {
      try {
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
          onMpvSurfaceState((st) => {
            if (!active) return;
            const p = usePlayerStore.getState();
            p.setEngineSurfaceVisible(st.surfaceVisible);
            if (!st.running) {
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              mpvLifecycleActiveRef.current = false;
            } else {
              mpvStartedRef.current = true;
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
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              mpvLifecycleActiveRef.current = false;
              const p = usePlayerStore.getState();
              const s = useSyncStore.getState();
              p.setEngineSurfaceVisible(false);
              p.setPlayerError(decision.message);
              pushNote("error", decision.message);
              void logFrontendEvent("error", "player.ended", decision.message, "ERR_MPV_ENDED");
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
            if (!active) return;
            usePlayerStore.getState().setTracks(tracks);
            autoEnableEmbeddedSubtitle(tracks);
          }),
          onMpvCommandWarning((msg) => {
            if (active) pushNote("warn", msg);
          }),
          onMpvError((msg) => {
            if (!active) return;
            mpvStartedRef.current = false;
            mpvStartPromiseRef.current = null;
            mpvLifecycleActiveRef.current = false;
            const p = usePlayerStore.getState();
            const s = useSyncStore.getState();
            p.setEngineSurfaceVisible(false);
            p.setPlayerError(msg);
            pushNote("error", msg);
            void logFrontendEvent("error", "player.error", msg, "ERR_MPV");
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
            if (active) toggleViewportPlayback();
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
      } finally {
        markListenersReady();
      }

      // Sync initial fullscreen state if OS entered fullscreen externally
      const initialFs = await windowIsFullscreen();
      if (active) usePlayerStore.getState().setIsFullscreen(initialFs);
    };

    void setup();

    return () => {
      active = false;
      markListenersReady();
      if (surfaceClickTimerRef.current !== null) {
        window.clearTimeout(surfaceClickTimerRef.current);
        surfaceClickTimerRef.current = null;
      }
      unlisteners.forEach((fn) => fn());
    };
  }, [pushNote, toggleFullscreen, toggleViewportPlayback]);

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
      safeMpvCall(mpvResize(rect, plan.forceFlag), "mpvResize");
    }
  }, [rect]);

  // Hide child HWND whenever fullscreen modals overlay live video or player fails (Fix 16)
  useEffect(() => {
    if (!isDesktop() || !mpvStartedRef.current) return;
    safeMpvCall(mpvSetVisible(!settingsOpen && !shortcutsOpen && !playerError), "mpvSetVisible");
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
  }, [loaded, paused, panelOpen, contextMenu, settingsOpen, shortcutsOpen, playerError, wakeChrome]);

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
      safeMpvCall(mpvSetSpeed(1.0), "mpvSetSpeed");
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
  const desktopRuntime = isDesktop();
  const showVideoBackdrop =
    loaded &&
    !playerError &&
    !settingsOpen &&
    !shortcutsOpen &&
    (!desktopRuntime || engineSurfaceVisible);

  useEffect(() => {
    const rootEl = document.documentElement;
    rootEl.classList.toggle("ep-video-active", showVideoBackdrop);
    return () => {
      rootEl.classList.remove("ep-video-active");
    };
  }, [showVideoBackdrop]);

  useEffect(() => {
    if (!hasFolderEpisodes && panelOpen && sideTab === "episodes") {
      setPanelOpen(false);
    }
  }, [hasFolderEpisodes, panelOpen, sideTab]);

  useLayoutEffect(() => {
    if (!panelOpen || (sideTab === "episodes" && !hasFolderEpisodes)) {
      setPopoverPos(null);
      return;
    }
    const updatePosition = () => setPopoverPos(computeCapsulePopoverLayout(sideTab));
    updatePosition();
    window.addEventListener("resize", updatePosition);
    return () => window.removeEventListener("resize", updatePosition);
  }, [
    panelOpen,
    sideTab,
    hasFolderEpisodes,
    playlistItems.length,
    loaded,
    roomCode,
    syncStatus.state,
    isFullscreen,
  ]);

  const activePopover =
    panelOpen &&
    popoverPos &&
    (sideTab === "room" ||
      sideTab === "playback" ||
      sideTab === "subtitles" ||
      (sideTab === "episodes" && hasFolderEpisodes))
      ? { tab: sideTab, pos: popoverPos }
      : null;
  const popover = usePresencePayload(activePopover, 200);
  const backdropPresence = useAnimatedPresence(
    Boolean(showFloatingCapsule || showWindowBar || popover.mounted || contextMenu),
    420,
  );

  const handleToggleCapsuleTab = (tab: SideTab) => {
    wakeChrome();
    if (panelOpen && sideTab === tab) {
      setPanelOpen(false);
    } else {
      setSideTab(tab);
      setPanelOpen(true);
      // CC button: open the menu AND make sure subtitles are on.
      if (tab === "subtitles") ensureSubtitlesOn();
    }
  };

  const handleLeaveRoom = () => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    autoLoadedPathRef.current = null;
    soundTrackerRef.current.reset();
    pendingPairedSubRef.current = null;
    lastPeerFileRef.current = null;
    announcedFileKeyRef.current = null;
    autoReadyMarkedRef.current = false;
    leaveRoom();
  };

  const syncConnectedNow = syncStatus.state === "connected";
  const effectiveUserNow = resolveEffectiveUsername(syncStatus, username);
  const ctrlLockNow = getControllerLockState(syncConnectedNow, participants, effectiveUserNow);
  const hasPrevEpisodeNow = playlistItems.length > 1 && playlistIndex > 0;
  const hasNextEpisodeNow =
    playlistItems.length > 1 && playlistIndex >= 0 && playlistIndex < playlistItems.length - 1;

  const contextMenuEntries: ContextMenuEntry[] = [
    {
      id: "play-pause",
      label: paused ? "Play" : "Pause",
      shortcut: "Space",
      icon: paused ? <PlayerPlayIcon size={14} /> : <PlayerPauseIcon size={14} />,
      disabled: !loaded || ctrlLockNow.lockedForLocalUser,
      onSelect: toggleViewportPlayback,
    },
    {
      id: "seek-back",
      label: "Seek Backward 10s",
      shortcut: "J",
      icon: <PlayerSeekIcon direction="back" size={14} />,
      disabled: !loaded || ctrlLockNow.lockedForLocalUser,
      onSelect: () => seekPlaybackRelative(-10),
    },
    {
      id: "seek-forward",
      label: "Seek Forward 10s",
      shortcut: "L",
      icon: <PlayerSeekIcon direction="forward" size={14} />,
      disabled: !loaded || ctrlLockNow.lockedForLocalUser,
      onSelect: () => seekPlaybackRelative(10),
    },
    ...(hasFolderEpisodes && playlistItems.length > 1
      ? ([
          {
            id: "prev-ep",
            label: "Previous Episode",
            icon: <PlayerSkipEpisodeIcon direction="prev" size={14} />,
            disabled: !hasPrevEpisodeNow || ctrlLockNow.lockedForLocalUser,
            onSelect: handlePrevEpisode,
          },
          {
            id: "next-ep",
            label: "Next Episode",
            icon: <PlayerSkipEpisodeIcon direction="next" size={14} />,
            disabled: !hasNextEpisodeNow || ctrlLockNow.lockedForLocalUser,
            onSelect: handleNextEpisode,
          },
        ] satisfies ContextMenuEntry[])
      : []),
    { type: "divider", id: "div-media" },
    {
      id: "open-file",
      label: "Open Video File(s)…",
      icon: <AppFolderIcon size={14} />,
      onSelect: () => void handleChooseFile(),
    },
    {
      id: "open-folder",
      label: "Open Season Folder…",
      icon: <PlayerEpisodesIcon size={14} />,
      onSelect: () => void handleChooseSeasonFolder(),
    },
    ...(hasFolderEpisodes
      ? ([
          {
            id: "open-episodes",
            label: "Episodes Queue",
            icon: <PlayerEpisodesIcon active size={14} className="text-accent-soft" />,
            accent: true,
            onSelect: () => {
              setSideTab("episodes");
              setPanelOpen(true);
            },
          },
        ] satisfies ContextMenuEntry[])
      : []),
    { type: "divider", id: "div-tracks" },
    {
      id: "toggle-subs",
      label: subVisible ? "Hide Subtitles" : "Show Subtitles",
      shortcut: "V",
      checked: loaded && subVisible,
      icon: <PlayerCaptionsIcon size={14} />,
      disabled: !loaded,
      onSelect: toggleSubtitlesVisibility,
    },
    {
      id: "cycle-sub",
      label: "Cycle Subtitle Track",
      shortcut: "S",
      icon: <PlayerCaptionsIcon size={14} />,
      disabled: !loaded,
      onSelect: cycleSubtitleTrack,
    },
    {
      id: "open-subtitles",
      label: "Subtitles & Sync…",
      icon: <PlayerCaptionsIcon active size={14} className="text-accent-soft" />,
      onSelect: () => {
        setSideTab("subtitles");
        setPanelOpen(true);
      },
    },
    {
      id: "cycle-audio",
      label: "Cycle Audio Track",
      icon: <PlayerAudioIcon size={14} />,
      disabled: !loaded,
      onSelect: cycleAudioTrack,
    },
    {
      id: "open-audio",
      label: "Audio & Speed…",
      icon: <PlayerAudioIcon active size={14} className="text-accent-soft" />,
      onSelect: () => {
        setSideTab("playback");
        setPanelOpen(true);
      },
    },
    {
      id: "mute-toggle",
      label: muted ? "Unmute" : "Mute",
      shortcut: "M",
      icon: <PlayerVolumeIcon muted={!muted} size={14} />,
      onSelect: toggleMutePlayback,
    },
    { type: "divider", id: "div-party" },
    ...(roomCode
      ? ([
          {
            id: "toggle-ready",
            label: localReady && loaded ? "Mark Not Ready" : "Mark Ready",
            shortcut: "R",
            checked: localReady && loaded,
            icon: <PlayerReadyIcon ready={localReady && loaded} size={14} />,
            disabled: !loaded,
            onSelect: toggleReadyStatus,
          },
          {
            id: "force-resync",
            label: "Resync With Party",
            icon: <PlayerResyncIcon tone="ok" size={14} />,
            disabled: !syncConnectedNow,
            onSelect: () => {
              void syncForceResync().then(() => {
                usePlayerStore.getState().flashFeedback("Resynced with room");
              });
            },
          },
        ] satisfies ContextMenuEntry[])
      : []),
    {
      id: "party-lounge",
      label: roomCode ? "Party Lounge…" : "Start Watch Party…",
      icon: <WatchPartyIcon bare size={14} />,
      onSelect: () => {
        setSideTab("room");
        setPanelOpen(true);
      },
    },
    {
      id: "toggle-fullscreen",
      label: isFullscreen ? "Exit Fullscreen" : "Fullscreen",
      shortcut: "F",
      icon: <PlayerFullscreenIcon isFullscreen={isFullscreen} size={14} />,
      onSelect: toggleFullscreen,
    },
    ...(loaded
      ? ([
          {
            id: "hide-chrome",
            label: "Hide Player Controls",
            icon: <PlayerEyeIcon hidden size={14} />,
            onSelect: () => setChromeIdle(true),
          },
        ] satisfies ContextMenuEntry[])
      : []),
    { type: "divider", id: "div-app" },
    {
      id: "shortcuts",
      label: "Keyboard Shortcuts…",
      shortcut: "?",
      icon: <AppKeyboardIcon size={14} />,
      onSelect: openShortcuts,
    },
    {
      id: "preferences",
      label: "Preferences…",
      icon: <PlayerSettingsIcon size={14} />,
      onSelect: () => openSettings("prefs"),
    },
    {
      id: "leave-room",
      label: roomCode ? "Leave Watch Party" : "Back to Lobby",
      icon: <PartyLeaveIcon size={14} />,
      onSelect: handleLeaveRoom,
    },
  ];

  return (
    <div
      onMouseMove={wakeChrome}
      onPointerDown={wakeChrome}
      onContextMenu={(e) => {
        if (isTextEntryElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        wakeChrome();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
      className={`relative h-full w-full text-primary overflow-hidden ${
        showVideoBackdrop ? "bg-transparent" : "bg-canvas"
      }`}
    >
      <VideoGlassBackdrop
        active={showVideoBackdrop}
        visible={backdropPresence.mounted}
        playing={!paused}
        viewportRef={viewportRef}
        layoutKey={`${showFloatingCapsule}:${showWindowBar}:${popover.mounted}:${popover.exiting}:${popover.value?.tab ?? sideTab}:${popover.value?.pos.left ?? 0}:${popover.value?.pos.bottom ?? 0}:${popover.value?.pos.width ?? 0}:${Boolean(contextMenu)}:${contextMenu?.x ?? 0}:${contextMenu?.y ?? 0}:${viewportTick}`}
      />
      <NotificationStrip />

      <div
        aria-hidden={!showWindowBar}
        className={`ep-top-scrim absolute top-0 inset-x-0 z-30 ep-chrome-transition origin-top ${
          showWindowBar
            ? "opacity-100 translate-y-0 scale-100"
            : "opacity-0 -translate-y-3 scale-[0.988] pointer-events-none"
        }`}
      >
        <TitleBar
          leftSlot={
            <div className="inline-flex items-center gap-2.5 min-w-0 max-w-[60vw] pl-1">
              <button
                type="button"
                onClick={handleLeaveRoom}
                aria-label={roomCode ? "Leave room" : "Back to lobby"}
                title={roomCode ? "Leave room" : "Back to lobby"}
                className="ep-bar-icon-btn h-7 w-7 rounded-full flex items-center justify-center text-white/80 hover:text-white cursor-pointer shrink-0"
              >
                <AppChevronIcon direction="left" size={16} />
              </button>
              <span
                data-tauri-drag-region
                className="text-[13px] font-medium text-white/90 truncate max-w-[360px]"
              >
                {cleanHeaderTitle}
              </span>
              {activePlaylistItem?.episodeBadge && (
                <span
                  data-tauri-drag-region
                  className="shrink-0 num text-[11px] font-medium text-white/60"
                >
                  {activePlaylistItem.episodeBadge}
                </span>
              )}
              {roomCode && (
                <button
                  type="button"
                  onClick={() => handleToggleCapsuleTab("room")}
                  aria-label="Open Watch Party panel"
                  title="Watch Party room · Click to view invite & viewers"
                  className="ep-press shrink-0 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] text-white/80 hover:text-white hover:bg-white/[0.12] num cursor-pointer"
                >
                  <StatusDot
                    tone={
                      syncStatus.state === "connected"
                        ? "ok"
                        : syncStatus.state === "error"
                          ? "bad"
                          : "warn"
                    }
                    pulse={
                      syncStatus.state === "connecting" || syncStatus.state === "reconnecting"
                    }
                  />
                  <span>{formatRoomCodeDisplay(roomCode)}</span>
                </button>
              )}
            </div>
          }
        />
      </div>
      {!showWindowBar && !isFullscreen && (
        <div
          data-tauri-drag-region
          onMouseEnter={wakeChrome}
          onMouseMove={wakeChrome}
          onClick={wakeChrome}
          title="Move mouse here to show window controls"
          className="absolute top-0 inset-x-0 h-2.5 z-20 cursor-pointer"
        />
      )}

      {/* Full-window video viewport: title bar and glass play bar float directly over the film */}
      <div
        ref={viewportRef}
        className={`absolute inset-0 z-0 ${
          showVideoBackdrop ? "bg-transparent" : "bg-canvas"
        }`}
      >
        <ViewportPlaceholder
          loaded={loaded}
          isDragActive={isDragActive}
          playerError={playerError}
          clearanceBottom={
            showFloatingCapsule
              ? panelOpen && sideTab === "room"
                ? "extended"
                : "bar"
              : "none"
          }
          onChooseFile={() => void handleChooseFile()}
          onChooseFolder={() => void handleChooseSeasonFolder()}
          onRetryPlayer={() => {
            void (async () => {
              usePlayerStore.getState().setPlayerError(null);
              usePlayerStore.getState().setEngineSurfaceVisible(false);
              await enqueueMpvLifecycle(async () => {
                await mpvStop().catch(() => undefined);
              });
              viewportTrackerRef.current.markInvalidated();
              mpvStartedRef.current = false;
              mpvStartPromiseRef.current = null;
              mpvLifecycleActiveRef.current = false;
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
        {showVideoBackdrop && !panelOpen && (
          <div
            className={`absolute inset-0 z-10 ${
              chromeIdle ? "cursor-none" : "cursor-default"
            }`}
            onClick={(e) => {
              if (e.detail > 1) return;
              if (surfaceClickTimerRef.current !== null) {
                window.clearTimeout(surfaceClickTimerRef.current);
              }
              surfaceClickTimerRef.current = window.setTimeout(() => {
                surfaceClickTimerRef.current = null;
                toggleViewportPlayback();
              }, 180);
            }}
            onDoubleClick={() => {
              if (surfaceClickTimerRef.current !== null) {
                window.clearTimeout(surfaceClickTimerRef.current);
                surfaceClickTimerRef.current = null;
              }
              toggleFullscreen();
            }}
            aria-hidden="true"
          />
        )}
        {panelOpen && (
          <div
            className="absolute inset-0 z-20"
            onClick={() => setPanelOpen(false)}
            aria-hidden="true"
          />
        )}
      </div>

      {popover.mounted && popover.value && (
        <aside
          key="capsule-popover"
          aria-label={
            popover.value.tab === "room"
              ? "Watch Party"
              : popover.value.tab === "episodes"
                ? "Season episodes"
                : popover.value.tab === "playback"
                  ? "Audio and playback menu"
                  : "Subtitles menu"
          }
          data-glass-region="true"
          style={{
            left: popover.value.pos.left,
            bottom: popover.value.pos.bottom,
            width: popover.value.pos.width,
            maxHeight: `calc(100vh - ${popover.value.pos.bottom + 58}px)`,
          }}
          className={`ep-glass-capsule ep-capsule-morph fixed z-40 select-none ${
            popover.exiting
              ? "ep-popover-bloom-out pointer-events-none"
              : "ep-popover-bloom"
          } ${
            popover.value.tab === "room" || popover.value.tab === "episodes"
              ? "flex flex-col overflow-hidden rounded-[22px] p-3"
              : "overflow-y-auto overflow-x-hidden rounded-[20px] p-1.5"
          }`}
        >
          <div
            key={popover.value.tab}
            className={
              popover.value.tab === "room" || popover.value.tab === "episodes"
                ? "flex flex-col flex-1 min-h-0 anim-tab-in"
                : "anim-tab-in"
            }
          >
            {popover.value.tab === "room" && (
              <RoomPanel onClose={() => setPanelOpen(false)} />
            )}
            {popover.value.tab === "episodes" && (
              <EpisodesPanel
                onSelectEpisode={(idx) => void selectEpisodeAtIndex(idx)}
                onOpenSeasonFolder={() => void handleChooseSeasonFolder()}
                onAddEpisodes={() => void handleChooseFile(true)}
                onClose={() => setPanelOpen(false)}
              />
            )}
            {popover.value.tab === "playback" && <PlaybackPanel />}
            {popover.value.tab === "subtitles" && <SubtitlePanel />}
          </div>
        </aside>
      )}

      <div className="absolute bottom-0 inset-x-0 z-30 pointer-events-none">
        <TransportBar
          visible={showFloatingCapsule}
          activeTab={panelOpen ? sideTab : null}
          onToggleTab={handleToggleCapsuleTab}
          onCloseDrawer={() => setPanelOpen(false)}
          onChooseFile={() => void handleChooseFile()}
          onLeaveRoom={handleLeaveRoom}
          onHideControls={() => setChromeIdle(true)}
          onToggleFullscreen={toggleFullscreen}
          onPrevEpisode={handlePrevEpisode}
          onNextEpisode={handleNextEpisode}
          drawerTabs={null}
          expandedDrawer={null}
        />
      </div>
      {!showFloatingCapsule && (
        <div
          onMouseEnter={wakeChrome}
          onMouseMove={wakeChrome}
          onClick={wakeChrome}
          title="Move mouse here to show controls"
          className="absolute bottom-0 inset-x-0 h-3 z-20 cursor-pointer"
        />
      )}

      <ContextMenu
        position={contextMenu}
        entries={contextMenuEntries}
        onClose={() => setContextMenu(null)}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
        onApplyServerConfig={(endpoint, password) => connectRoom(endpoint, password)}
      />
      <ShortcutsModal open={shortcutsOpen} onClose={closeShortcuts} />
    </div>
  );
}
