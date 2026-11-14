import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Eye,
  EyeOff,
  FolderOpen,
  RotateCcw,
  Sparkles,
  Square,
  Wrench,
} from "lucide-react";
import { useState } from "react";
import { isDesktop } from "../lib/bridge";
import { formatUserError } from "../lib/errors";
import { getFileDisplayName } from "../lib/fileDrop";
import {
  mpvAddSubtitle,
  mpvRemoveSubtitle,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetSubTrack,
  mpvSetVisible,
  subtitleAutoSync,
  subtitleCancelAutoSync,
  subtitleTwoAnchorSync,
  type SubtitleEncodingHint,
} from "../lib/mpv";
import {
  buildSubTrackOptions,
  formatDelayLabel,
  formatTimingStatus,
  isBitmapSubtitleTrack,
  selectSubTrack,
} from "../lib/tracks";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import {
  SUBTITLE_COLORS,
  SUBTITLE_ENCODING_OPTIONS,
  SUBTITLE_FONTS,
  useSubtitleStore,
} from "../store/useSubtitleStore";
import { Button } from "./ui/Button";
import { Scrubber } from "./ui/Scrubber";
import { SelectMenu } from "./ui/SelectMenu";
import { TextField } from "./ui/TextField";

function applyStyleNow(): void {
  const s = useSubtitleStore.getState();
  void mpvSetSubStyle({
    font: s.font,
    fontSize: s.fontSize,
    color: s.color,
    borderSize: s.borderSize,
    pos: s.pos,
    visible: s.visible,
    overrideAss: s.overrideAssStyle,
  });
}

export function SubtitlePanel() {
  const videoPath = useAppStore((s) => s.selectedFilePath);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);

  const loaded = usePlayerStore((s) => s.loaded);
  const tracks = usePlayerStore((s) => s.tracks);

  const loadedFilePath = useSubtitleStore((s) => s.loadedFilePath);
  const originalFilePath = useSubtitleStore((s) => s.originalFilePath);
  const font = useSubtitleStore((s) => s.font);
  const fontSize = useSubtitleStore((s) => s.fontSize);
  const color = useSubtitleStore((s) => s.color);
  const borderSize = useSubtitleStore((s) => s.borderSize);
  const pos = useSubtitleStore((s) => s.pos);
  const visible = useSubtitleStore((s) => s.visible);
  const overrideAssStyle = useSubtitleStore((s) => s.overrideAssStyle);
  const encodingHint = useSubtitleStore((s) => s.encodingHint);
  const delaySecs = useSubtitleStore((s) => s.delaySecs);
  const autoSyncBusy = useSubtitleStore((s) => s.autoSyncBusy);
  const autoSyncOutcome = useSubtitleStore((s) => s.autoSyncOutcome);
  const autoSyncError = useSubtitleStore((s) => s.autoSyncError);

  const setFont = useSubtitleStore((s) => s.setFont);
  const setFontSize = useSubtitleStore((s) => s.setFontSize);
  const setColor = useSubtitleStore((s) => s.setColor);
  const setBorderSize = useSubtitleStore((s) => s.setBorderSize);
  const setPos = useSubtitleStore((s) => s.setPos);
  const setVisible = useSubtitleStore((s) => s.setVisible);
  const setOverrideAssStyle = useSubtitleStore((s) => s.setOverrideAssStyle);
  const setEncodingHint = useSubtitleStore((s) => s.setEncodingHint);
  const setDelaySecs = useSubtitleStore((s) => s.setDelaySecs);
  const nudgeDelay = useSubtitleStore((s) => s.nudgeDelay);
  const setLoadedTrack = useSubtitleStore((s) => s.setLoadedTrack);
  const clearLoadedTrack = useSubtitleStore((s) => s.clearLoadedTrack);
  const setAutoSyncBusy = useSubtitleStore((s) => s.setAutoSyncBusy);
  const setAutoSyncResult = useSubtitleStore((s) => s.setAutoSyncResult);
  const setAutoSyncError = useSubtitleStore((s) => s.setAutoSyncError);
  const resetDefaults = useSubtitleStore((s) => s.resetDefaults);

  const pushNote = useNotificationStore((s) => s.push);

  const [showTwoAnchor, setShowTwoAnchor] = useState(false);
  const [srcASecs, setSrcASecs] = useState("10");
  const [dstASecs, setDstASecs] = useState("10");
  const [srcBSecs, setSrcBSecs] = useState("600");
  const [dstBSecs, setDstBSecs] = useState("600");

  const subOptions = buildSubTrackOptions(tracks);
  const selectedSub = tracks.find((t) => t.type === "sub" && t.selected) ?? null;
  const currentSubVal = selectedSub ? String(selectedSub.id) : "none";
  const selectedAudio = tracks.find((t) => t.type === "audio" && t.selected) ?? null;
  const subIsBitmap = isBitmapSubtitleTrack(selectedSub);

  const embeddedSubIdx =
    selectedSub && !selectedSub.external
      ? tracks
          .filter((t) => t.type === "sub" && !t.external)
          .findIndex((t) => t.id === selectedSub.id)
      : null;

  const canAutoSync =
    loaded &&
    Boolean(videoPath) &&
    (Boolean(originalFilePath || loadedFilePath) ||
      (selectedSub !== null && !selectedSub.external && !subIsBitmap));

  const handleLoadExternalSubtitle = async () => {
    if (!loaded) {
      pushNote("info", "Load a video file before loading a subtitle.");
      return;
    }
    if (!isDesktop()) {
      pushNote("warn", "File dialog is only available in the Windows desktop app.");
      return;
    }
    let chosen: string | null = null;
    try {
      await mpvSetVisible(false);
      const picked = await open({
        multiple: false,
        title: "Choose Subtitle File",
        filters: [
          { name: "Subtitles", extensions: ["srt", "ass", "ssa", "vtt", "sub", "idx", "*"] },
        ],
      });
      if (typeof picked === "string" && picked) {
        chosen = picked;
      }
    } finally {
      void mpvSetVisible(true);
    }
    if (!chosen) return;
    try {
      await mpvAddSubtitle(chosen, encodingHint);
      await mpvSetSubDelay(0);
      setDelaySecs(0);
      setLoadedTrack(chosen, chosen);
      applyStyleNow();
      pushNote("success", `Loaded subtitle: ${getFileDisplayName(chosen)}`);
    } catch (err) {
      pushNote("error", formatUserError(err, "Failed loading subtitle file."));
    }
  };

  const handleEncodingChange = async (hint: SubtitleEncodingHint) => {
    setEncodingHint(hint);
    const targetPath = originalFilePath || loadedFilePath;
    if (loaded && targetPath) {
      try {
        if (selectedSub?.external) {
          await mpvRemoveSubtitle(selectedSub.id).catch(() => undefined);
        }
        await mpvAddSubtitle(targetPath, hint);
        applyStyleNow();
        pushNote("info", `Reloaded subtitle with ${hint} encoding.`);
      } catch (err) {
        pushNote("error", formatUserError(err, "Failed re-decoding subtitle."));
      }
    }
  };

  const handleAutoSync = async () => {
    if (!videoPath || autoSyncBusy) return;
    const startGen = useSubtitleStore.getState().sessionGen;
    const startVideoPath = videoPath;
    setAutoSyncBusy(true);
    setAutoSyncError(null);
    try {
      const result = await subtitleAutoSync({
        videoPath,
        subtitlePath: originalFilePath || loadedFilePath || null,
        audioTrackId: selectedAudio?.id ?? null,
        embeddedSubIdx:
          !originalFilePath && !loadedFilePath && embeddedSubIdx !== null && embeddedSubIdx >= 0
            ? embeddedSubIdx
            : null,
        embeddedSubCodec: selectedSub?.codec ?? null,
        encodingHint,
        lowPower: lowPowerMode,
      });
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      const activeSub = usePlayerStore
        .getState()
        .tracks.find((t) => t.type === "sub" && t.selected);
      if (activeSub?.external) {
        await mpvRemoveSubtitle(activeSub.id).catch(() => undefined);
      }
      await mpvAddSubtitle(result.syncedSubtitlePath, "utf8");
      await mpvSetSubDelay(0);
      setDelaySecs(0);
      setLoadedTrack(result.syncedSubtitlePath, result.sourceSubtitlePath);
      setAutoSyncResult(result);
      applyStyleNow();
      pushNote(
        "success",
        `Subtitle auto-synced (offset ${result.offsetSecs >= 0 ? "+" : ""}${result.offsetSecs.toFixed(2)}s, z=${result.confidenceZ.toFixed(1)}).`,
      );
    } catch (err) {
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      const msg = formatUserError(err, "Auto-sync could not find a confident alignment.");
      setAutoSyncError(msg);
      pushNote("error", msg);
    }
  };

  const handleCancelAutoSync = async () => {
    await subtitleCancelAutoSync();
    setAutoSyncBusy(false);
    pushNote("info", "Subtitle auto-sync cancelled.");
  };

  const handleTwoAnchorApply = async () => {
    const targetSub = autoSyncOutcome?.sourceSubtitlePath || originalFilePath || loadedFilePath;
    if (!targetSub) {
      pushNote("warn", "Load an external subtitle file or run Auto-Sync once first.");
      return;
    }
    const a1 = Number.parseFloat(srcASecs);
    const b1 = Number.parseFloat(dstASecs);
    const a2 = Number.parseFloat(srcBSecs);
    const b2 = Number.parseFloat(dstBSecs);
    if (![a1, b1, a2, b2].every((n) => Number.isFinite(n) && n >= 0)) {
      pushNote("error", "Enter valid non-negative second timestamps for both anchor points.");
      return;
    }
    const startGen = useSubtitleStore.getState().sessionGen;
    const startVideoPath = videoPath;
    try {
      const result = await subtitleTwoAnchorSync({
        subtitlePath: targetSub,
        srcASecs: a1,
        dstASecs: b1,
        srcBSecs: a2,
        dstBSecs: b2,
        encodingHint,
      });
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      const activeSub = usePlayerStore
        .getState()
        .tracks.find((t) => t.type === "sub" && t.selected);
      if (activeSub?.external) {
        await mpvRemoveSubtitle(activeSub.id).catch(() => undefined);
      }
      await mpvAddSubtitle(result.syncedSubtitlePath, "utf8");
      await mpvSetSubDelay(0);
      setDelaySecs(0);
      setLoadedTrack(result.syncedSubtitlePath, targetSub);
      setAutoSyncResult(result);
      applyStyleNow();
      pushNote("success", "Applied 2-point subtitle timing calibration.");
    } catch (err) {
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      pushNote("error", formatUserError(err, "Two-anchor calibration failed."));
    }
  };

  const handleNudge = (delta: number) => {
    const next = nudgeDelay(delta);
    void mpvSetSubDelay(next);
  };

  return (
    <div className="anim-tab-in p-3 space-y-4">
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!loaded}
          onClick={() => void handleLoadExternalSubtitle()}
          className="flex-1"
        >
          <FolderOpen className="h-3.5 w-3.5" />
          Load Subtitle File
        </Button>
        <Button
          variant={visible ? "primary" : "secondary"}
          size="sm"
          disabled={!loaded}
          onClick={() => {
            const next = !visible;
            setVisible(next);
            void mpvSetSubStyle({
              font,
              fontSize,
              color,
              borderSize,
              pos,
              visible: next,
              overrideAss: overrideAssStyle,
            });
          }}
          aria-label={visible ? "Hide subtitles" : "Show subtitles"}
          title="Toggle subtitles (V)"
        >
          {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
        </Button>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-secondary block">Active Subtitle Track</span>
        <SelectMenu
          ariaLabel="Subtitle Track"
          disabled={!loaded}
          value={currentSubVal}
          options={subOptions.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(val) => {
            const sid = val === "none" ? null : Number(val);
            void selectSubTrack(sid, tracks, {
              mpvSetSubTrack,
              mpvSetSubDelay,
              setDelaySecs,
              setSubtitleVisible: setVisible,
              clearExternalTrackState: clearLoadedTrack,
            });
          }}
        />
        {loadedFilePath && (
          <p className="text-[11px] text-muted truncate">
            External: {getFileDisplayName(loadedFilePath)}
          </p>
        )}
      </div>

      {subIsBitmap && (
        <div className="p-2.5 bg-canvas border border-warn/40 rounded-[var(--radius-ui)] flex items-start gap-2 text-[11px] text-warn">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            Bitmap subtitle track detected ({selectedSub?.codec}). Font styling and text auto-sync only work with text subtitles (.srt/.ass/.vtt).
          </span>
        </div>
      )}

      <div className="p-3 bg-canvas border border-hairline rounded-[var(--radius-ui)] space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-primary">Auto-Sync to Speech</span>
          <span className="text-[11px] text-muted">
            {formatTimingStatus({
              delaySecs,
              hasTrack: currentSubVal !== "none" || Boolean(loadedFilePath),
              isAutoSynced: Boolean(autoSyncOutcome),
            })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {autoSyncBusy ? (
            <Button
              variant="danger"
              size="sm"
              className="flex-1"
              onClick={() => void handleCancelAutoSync()}
            >
              <Square className="h-3 w-3" />
              Cancel Auto-Sync
            </Button>
          ) : (
            <Button
              variant="primary"
              size="sm"
              className="flex-1"
              disabled={!canAutoSync}
              onClick={() => void handleAutoSync()}
            >
              <Sparkles className="h-3.5 w-3.5" />
              Auto-Sync Subtitles
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowTwoAnchor((v) => !v)}
            title="Manual 2-point sync calibration"
          >
            <Wrench className="h-3.5 w-3.5" />
          </Button>
        </div>

        {autoSyncOutcome && (
          <div className="text-[11px] text-ok space-y-0.5">
            <p className="num">
              Shift: {autoSyncOutcome.offsetSecs >= 0 ? "+" : ""}
              {autoSyncOutcome.offsetSecs.toFixed(2)}s · z={autoSyncOutcome.confidenceZ.toFixed(1)}
              {autoSyncOutcome.driftApplied ? ` · scale=${autoSyncOutcome.scale.toFixed(4)}×` : ""}
            </p>
          </div>
        )}

        {autoSyncError && <p className="text-[11px] text-bad">{autoSyncError}</p>}

        {showTwoAnchor && (
          <div className="pt-2 border-t border-hairline space-y-2">
            <p className="text-[11px] text-secondary">
              2-Point Manual Calibration (seconds): match two subtitle lines to spoken audio timestamps.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <TextField
                label="Early sub (s)"
                value={srcASecs}
                onChange={(e) => setSrcASecs(e.target.value)}
              />
              <TextField
                label="Early audio (s)"
                value={dstASecs}
                onChange={(e) => setDstASecs(e.target.value)}
              />
              <TextField
                label="Late sub (s)"
                value={srcBSecs}
                onChange={(e) => setSrcBSecs(e.target.value)}
              />
              <TextField
                label="Late audio (s)"
                value={dstBSecs}
                onChange={(e) => setDstBSecs(e.target.value)}
              />
            </div>
            <Button variant="secondary" size="sm" className="w-full" onClick={() => void handleTwoAnchorApply()}>
              Apply 2-Point Calibration
            </Button>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-secondary">Manual Delay</span>
          <span className="num text-primary">{formatDelayLabel(delaySecs)}</span>
        </div>
        <div className="grid grid-cols-5 gap-1">
          <Button variant="secondary" size="sm" disabled={!loaded} onClick={() => handleNudge(-0.5)}>
            -0.5s
          </Button>
          <Button variant="secondary" size="sm" disabled={!loaded} onClick={() => handleNudge(-0.1)}>
            -0.1s
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!loaded || delaySecs === 0}
            onClick={() => {
              setDelaySecs(0);
              void mpvSetSubDelay(0);
            }}
          >
            0s
          </Button>
          <Button variant="secondary" size="sm" disabled={!loaded} onClick={() => handleNudge(0.1)}>
            +0.1s
          </Button>
          <Button variant="secondary" size="sm" disabled={!loaded} onClick={() => handleNudge(0.5)}>
            +0.5s
          </Button>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-secondary block">Text Encoding</span>
        <SelectMenu
          ariaLabel="Subtitle Encoding"
          value={encodingHint}
          options={SUBTITLE_ENCODING_OPTIONS}
          onChange={(val) => void handleEncodingChange(val)}
        />
      </div>

      <div className="space-y-3 pt-1 border-t border-hairline">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-secondary">Appearance</span>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              resetDefaults();
              applyStyleNow();
            }}
          >
            <RotateCcw className="h-3 w-3" />
            Reset
          </Button>
        </div>

        <SelectMenu
          ariaLabel="Subtitle Font"
          value={font}
          options={SUBTITLE_FONTS.map((f) => ({ value: f, label: f }))}
          onChange={(val) => {
            setFont(val);
            applyStyleNow();
          }}
        />

        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-secondary">
            <span>Font Size</span>
            <span className="num">{fontSize}px</span>
          </div>
          <Scrubber
            ariaLabel="Subtitle Font Size"
            value={fontSize}
            min={20}
            max={80}
            step={2}
            onChange={(val) => {
              setFontSize(val);
              applyStyleNow();
            }}
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-secondary">
            <span>Vertical Position</span>
            <span className="num">{pos}%</span>
          </div>
          <Scrubber
            ariaLabel="Subtitle Position"
            value={pos}
            min={20}
            max={100}
            step={1}
            onChange={(val) => {
              setPos(val);
              applyStyleNow();
            }}
          />
        </div>

        <div className="space-y-1">
          <div className="flex justify-between text-[11px] text-secondary">
            <span>Outline Thickness</span>
            <span className="num">{borderSize.toFixed(1)}</span>
          </div>
          <Scrubber
            ariaLabel="Subtitle Border Size"
            value={borderSize}
            min={0}
            max={6}
            step={0.5}
            onChange={(val) => {
              setBorderSize(val);
              applyStyleNow();
            }}
          />
        </div>

        <div className="flex items-center gap-2">
          {SUBTITLE_COLORS.map((c) => {
            const active = color.toUpperCase() === c.hex.toUpperCase();
            return (
              <button
                key={c.hex}
                type="button"
                aria-label={`Color ${c.label}`}
                title={c.label}
                onClick={() => {
                  setColor(c.hex);
                  applyStyleNow();
                }}
                className={`h-6 w-6 rounded-full border cursor-pointer ${
                  active ? "border-accent ring-2 ring-accent/40" : "border-hairline"
                }`}
                style={{ backgroundColor: c.hex }}
              />
            );
          })}
        </div>

        <label className="flex items-start justify-between gap-2 pt-1 text-xs cursor-pointer">
          <div>
            <span className="text-secondary block">Override styled .ass/.ssa subtitles</span>
            <span className="text-[11px] text-muted">
              Leave off for anime fansubs; enable to force consistent font/color.
            </span>
          </div>
          <input
            type="checkbox"
            checked={overrideAssStyle}
            onChange={(e) => {
              setOverrideAssStyle(e.target.checked);
              applyStyleNow();
            }}
            className="mt-0.5 accent-[var(--color-accent)] h-4 w-4 shrink-0"
          />
        </label>
      </div>
    </div>
  );
}
