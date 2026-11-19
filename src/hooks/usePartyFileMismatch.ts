import { useEffect, useMemo, useRef, useState } from "react";
import {
  analyzePartyFileMismatch,
  type PartyFileMismatch,
} from "../lib/fileMismatch";
import { isIdentityTransform } from "../lib/sourceAlignment";
import { resolveEffectiveUsername } from "../lib/syncController";
import { applyTimelineTransform } from "../lib/timelineActions";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useSyncStore } from "../store/useSyncStore";

/**
 * Computes and debounces Watch Party file mismatch state so brief mpv load/duration
 * probing windows never flash transient warnings.
 */
export function usePartyFileMismatch(): {
  mismatch: PartyFileMismatch | null;
  dismissed: boolean;
  dismiss: () => void;
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
  };
}
