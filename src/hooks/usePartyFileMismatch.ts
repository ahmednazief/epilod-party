import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isDesktop } from "../lib/bridge";
import {
  analyzePartyFileMismatch,
  type PartyFileMismatch,
} from "../lib/fileMismatch";
import {
  findLocalMediaMatches,
  type LocalMatchCandidate,
} from "../lib/localLibrary";
import { extractParentFolderPath } from "../lib/seriesProgress";
import { isIdentityTransform } from "../lib/sourceAlignment";
import { resolveEffectiveUsername } from "../lib/syncController";
import { applyTimelineTransform } from "../lib/timelineActions";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useRecentRoomsStore } from "../store/useRecentRoomsStore";
import { useSeriesProgressStore } from "../store/useSeriesProgressStore";
import { useSyncStore } from "../store/useSyncStore";

const localMatchCache = new Map<string, LocalMatchCandidate[]>();
const localMatchInFlight = new Map<string, Promise<LocalMatchCandidate[]>>();

export function clearLocalMatchCache(): void {
  localMatchCache.clear();
}

async function fetchDeduplicatedLocalMatches(
  cacheKey: string,
  peerFileName: string,
  peerDurationSecs: number | null,
  savedSeriesFolders: string[],
  recentFolders: string[],
  customLibraryFolders: string[],
  forceRefresh: boolean,
): Promise<LocalMatchCandidate[]> {
  if (!forceRefresh && localMatchCache.has(cacheKey)) {
    return localMatchCache.get(cacheKey)!;
  }
  const existing = localMatchInFlight.get(cacheKey);
  if (existing && !forceRefresh) {
    return existing;
  }
  const promise = findLocalMediaMatches({
    peerFileName,
    peerDurationSecs,
    savedSeriesFolders,
    recentFolders,
    customLibraryFolders,
    forceRefresh,
  })
    .then((res) => {
      if (localMatchCache.size > 40) {
        localMatchCache.clear();
      }
      localMatchCache.set(cacheKey, res);
      return res;
    })
    .finally(() => {
      localMatchInFlight.delete(cacheKey);
    });
  localMatchInFlight.set(cacheKey, promise);
  return promise;
}

/**
 * Computes and debounces Watch Party file mismatch state so brief mpv load/duration
 * probing windows never flash transient warnings.
 */
export function usePartyFileMismatch(): {
  mismatch: PartyFileMismatch | null;
  dismissed: boolean;
  dismiss: () => void;
  localMatches: LocalMatchCandidate[];
  searchingLocalMatches: boolean;
  refreshLocalMatches: () => void;
} {
  const syncStatus = useSyncStore((s) => s.status);
  const participants = useSyncStore((s) => s.participants);
  const timelineOffsetSecs = useSyncStore((s) => s.timelineOffsetSecs);
  const timelineScale = useSyncStore((s) => s.timelineScale);
  const dismissedMismatchSig = useSyncStore((s) => s.dismissedMismatchSig);
  const setDismissedMismatchSig = useSyncStore((s) => s.setDismissedMismatchSig);
  const undoneMismatchSigs = useSyncStore((s) => s.undoneMismatchSigs);
  const autoFixedMismatchSigs = useSyncStore((s) => s.autoFixedMismatchSigs);
  const markMismatchSigUndone = useSyncStore((s) => s.markMismatchSigUndone);
  const markMismatchSigAutoFixed = useSyncStore((s) => s.markMismatchSigAutoFixed);

  const username = useAppStore((s) => s.username);
  const selectedFileName = useAppStore((s) => s.selectedFileName);
  const autoFixFileMismatch = useAppStore((s) => s.autoFixFileMismatch);
  const loaded = usePlayerStore((s) => s.loaded);
  const hasDuration = usePlayerStore((s) => s.durationSecs > 0);
  const playerError = usePlayerStore((s) => s.playerError);

  const playlistItems = usePlaylistStore((s) => s.items);
  const playlistIndex = usePlaylistStore((s) => s.currentIndex);

  const syncConnected = syncStatus.state === "connected";
  const effectiveUsername = resolveEffectiveUsername(syncStatus, username);
  const localLoading = Boolean(selectedFileName?.trim()) && !loaded && !playerError;
  const aligned = !isIdentityTransform({
    offsetSecs: timelineOffsetSecs,
    scale: timelineScale,
  });
  const scaleCalibrated = Math.abs(timelineScale - 1.0) > 0.001;

  const rawMismatch = useMemo(
    () =>
      analyzePartyFileMismatch({
        syncConnected,
        participants,
        localUsername: effectiveUsername,
        localLoaded: loaded,
        localFileName: selectedFileName,
        localLoading,
        hasPlayerError: Boolean(playerError),
        aligned,
        scaleCalibrated,
        playlistItems,
        currentPlaylistIndex: playlistIndex,
      }),
    [
      syncConnected,
      participants,
      effectiveUsername,
      loaded,
      selectedFileName,
      localLoading,
      playerError,
      aligned,
      scaleCalibrated,
      playlistItems,
      playlistIndex,
    ],
  );

  const [settledMismatch, setSettledMismatch] = useState<PartyFileMismatch | null>(null);
  const latestRawRef = useRef<PartyFileMismatch | null>(rawMismatch);
  latestRawRef.current = rawMismatch;

  const rawSig = rawMismatch?.signature ?? null;

  useEffect(() => {
    if (!rawSig) {
      setSettledMismatch(null);
      return;
    }

    if (settledMismatch?.signature === rawSig) {
      setSettledMismatch(latestRawRef.current);
      return;
    }

    const delayMs = loaded && !hasDuration ? 750 : 300;
    const timer = window.setTimeout(() => {
      setSettledMismatch(latestRawRef.current);
    }, delayMs);

    return () => window.clearTimeout(timer);
  }, [rawSig, loaded, hasDuration, settledMismatch?.signature]);

  useEffect(() => {
    if (!rawSig && dismissedMismatchSig !== null) {
      setDismissedMismatchSig(null);
    }
  }, [rawSig, dismissedMismatchSig, setDismissedMismatchSig]);

  useEffect(() => {
    if (!settledMismatch || !autoFixFileMismatch) {
      return;
    }
    if (!settledMismatch.autoFixable || settledMismatch.confidence !== "high") {
      return;
    }
    const sig = settledMismatch.signature;
    // This hook is mounted in several components (WatchRoom, RoomPanel, TransportBar), so
    // read the live store state: the first instance marks the signature synchronously and
    // every other instance then bails out, guaranteeing a single auto-fix and a single toast.
    const live = useSyncStore.getState();
    if (live.undoneMismatchSigs.includes(sig) || live.autoFixedMismatchSigs.includes(sig)) {
      return;
    }
    if (
      settledMismatch.kind === "fpsMismatch" &&
      typeof settledMismatch.suggestedFpsScale === "number"
    ) {
      const prevTransform = {
        offsetSecs: timelineOffsetSecs,
        scale: timelineScale,
      };
      const nextScale = settledMismatch.suggestedFpsScale;
      const label = settledMismatch.suggestedFpsLabel ?? "calibrated";
      markMismatchSigAutoFixed(sig);
      void applyTimelineTransform(
        { offsetSecs: prevTransform.offsetSecs, scale: nextScale },
        `Auto-matched FPS (${label})`,
      );
      useNotificationStore.getState().push(
        "info",
        `Auto-matched FPS (${label})`,
        7500,
        `autofix:${sig}`,
        {
          label: "Undo",
          onClick: () => {
            markMismatchSigUndone(sig);
            void applyTimelineTransform(prevTransform, "Reverted auto-fix");
          },
        },
      );
    }
  }, [
    settledMismatch,
    autoFixFileMismatch,
    undoneMismatchSigs,
    autoFixedMismatchSigs,
    timelineOffsetSecs,
    timelineScale,
    markMismatchSigAutoFixed,
    markMismatchSigUndone,
  ]);

  const customLibraryFolders = useAppStore((s) => s.customLibraryFolders);
  const seriesMap = useSeriesProgressStore((s) => s.series);
  const recentRooms = useRecentRoomsStore((s) => s.rooms);

  const [localMatches, setLocalMatches] = useState<LocalMatchCandidate[]>([]);
  const [searchingLocalMatches, setSearchingLocalMatches] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const consumedRefreshNonceRef = useRef(0);
  const searchGenRef = useRef(0);

  const shouldSearchLocal =
    isDesktop() &&
    Boolean(settledMismatch) &&
    (settledMismatch?.kind === "notOpenOnPc" || settledMismatch?.kind === "differentFile") &&
    !settledMismatch?.matchedPlaylistItem &&
    Boolean(settledMismatch?.targetPeerFileName?.trim());

  const targetPeerFileName = shouldSearchLocal ? (settledMismatch?.targetPeerFileName ?? null) : null;
  const targetPeerDurationSecs = shouldSearchLocal
    ? (settledMismatch?.targetPeerDurationSecs ?? null)
    : null;

  const searchFolders = useMemo(() => {
    const savedSeriesFolders = Object.values(seriesMap)
      .map((s) => s.folderPath)
      .filter(Boolean);
    const recentFolders = recentRooms
      .map((r) => (r.lastFilePath ? extractParentFolderPath(r.lastFilePath) : ""))
      .filter(Boolean);
    return {
      savedSeriesFolders,
      recentFolders,
      customLibraryFolders,
      rootsSig: `${savedSeriesFolders.join(";")}|${recentFolders.join(";")}|${customLibraryFolders.join(";")}`,
    };
  }, [seriesMap, recentRooms, customLibraryFolders]);

  useEffect(() => {
    if (!targetPeerFileName) {
      searchGenRef.current += 1;
      setLocalMatches([]);
      setSearchingLocalMatches(false);
      return;
    }

    const gen = ++searchGenRef.current;
    const durBucket =
      typeof targetPeerDurationSecs === "number" && Number.isFinite(targetPeerDurationSecs)
        ? Math.round(targetPeerDurationSecs)
        : 0;
    const cacheKey = `${targetPeerFileName.toLowerCase()}|${durBucket}|${searchFolders.rootsSig}`;
    const forceRefresh = refreshNonce > consumedRefreshNonceRef.current;
    consumedRefreshNonceRef.current = refreshNonce;

    if (!forceRefresh && localMatchCache.has(cacheKey)) {
      setLocalMatches(localMatchCache.get(cacheKey)!);
      setSearchingLocalMatches(false);
      return;
    }

    setSearchingLocalMatches(true);
    const timer = window.setTimeout(() => {
      void fetchDeduplicatedLocalMatches(
        cacheKey,
        targetPeerFileName,
        targetPeerDurationSecs,
        searchFolders.savedSeriesFolders,
        searchFolders.recentFolders,
        searchFolders.customLibraryFolders,
        forceRefresh,
      )
        .then((matches) => {
          if (searchGenRef.current !== gen) return;
          setLocalMatches(matches);
        })
        .catch(() => {
          if (searchGenRef.current !== gen) return;
          setLocalMatches([]);
        })
        .finally(() => {
          if (searchGenRef.current === gen) {
            setSearchingLocalMatches(false);
          }
        });
    }, 450);

    return () => {
      window.clearTimeout(timer);
    };
  }, [targetPeerFileName, targetPeerDurationSecs, searchFolders, refreshNonce]);

  const refreshLocalMatches = useCallback(() => {
    clearLocalMatchCache();
    setRefreshNonce((n) => n + 1);
  }, []);

  const isAutoFixedActive =
    Boolean(settledMismatch) &&
    autoFixedMismatchSigs.includes(settledMismatch?.signature ?? "") &&
    !undoneMismatchSigs.includes(settledMismatch?.signature ?? "");

  const dismissed =
    isAutoFixedActive ||
    (Boolean(settledMismatch) && dismissedMismatchSig === settledMismatch?.signature);

  return {
    mismatch: isAutoFixedActive ? null : settledMismatch,
    dismissed,
    dismiss: () => {
      if (settledMismatch) {
        setDismissedMismatchSig(settledMismatch.signature);
      }
    },
    localMatches: isAutoFixedActive ? [] : localMatches,
    searchingLocalMatches,
    refreshLocalMatches,
  };
}
