import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ChevronDown,
  FolderOpen,
  RotateCcw,
  Sparkles,
  Square,
} from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
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
  isBitmapSubtitleTrack,
  selectSubTrack,
} from "../lib/tracks";
import { createLeadingTrailingThrottle } from "../lib/throttle";
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

const QUICK_SIZES = [
  { label: "Small", px: 36 },
  { label: "Medium", px: 48 },
  { label: "Large", px: 60 },
] as const;

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

export const SubtitlePanel = memo(function SubtitlePanel() {
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

  const throttledApplyStyle = useMemo(
    () => createLeadingTrailingThrottle(applyStyleNow, 60),
    [],
  );

  useEffect(() => () => throttledApplyStyle.cancel(), [throttledApplyStyle]);

  const [showTools, setShowTools] = useState(false);
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
      pushNote("info", "Open a movie before loading a subtitle.");
      return;
    }
    if (!isDesktop()) {
      pushNote("warn", "File dialog is only available in the Windows desktop app.");
      return;
    }
    let chosen: string | null = null;
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
        pushNote("info", `Reloaded subtitle encoding.`);
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
      pushNote("success", "Subtitles matched cleanly to voice.");
    } catch (err) {
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      const msg = formatUserError(err, "Could not match subtitles automatically.");
      setAutoSyncError(msg);
      pushNote("error", msg);
    }
  };

  const handleCancelAutoSync = async () => {
    await subtitleCancelAutoSync();
    setAutoSyncBusy(false);
    pushNote("info", "Magic Sync cancelled.");
  };

  const handleTwoAnchorApply = async () => {
    const targetSub = autoSyncOutcome?.sourceSubtitlePath || originalFilePath || loadedFilePath;
    if (!targetSub) {
      pushNote("warn", "Load an external subtitle file or run Magic Sync once first.");
      return;
    }
    const a1 = Number.parseFloat(srcASecs);
    const b1 = Number.parseFloat(dstASecs);
    const a2 = Number.parseFloat(srcBSecs);
    const b2 = Number.parseFloat(dstBSecs);
    if (![a1, b1, a2, b2].every((n) => Number.isFinite(n) && n >= 0)) {
      pushNote("error", "Enter valid non-negative timestamps for both anchor points.");
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
      pushNote("success", "Applied manual timing alignment.");
    } catch (err) {
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      pushNote("error", formatUserError(err, "Manual alignment failed."));
    }
  };

  const handleNudge = (delta: number) => {
    const next = nudgeDelay(delta);
    void mpvSetSubDelay(next);
  };

  const nearestSizeLabel = QUICK_SIZES.reduce((best, cur) =>
    Math.abs(cur.px - fontSize) < Math.abs(best.px - fontSize) ? cur : best,
  ).label;

  return (
    <div className="anim-tab-in space-y-2.5 pt-0.5">
      {/* Primary 3-column horizontal deck */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2.5">
        {/* Card 1: Track selector & Visibility */}
        <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
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
              className="ep-press inline-flex items-center gap-2 text-xs font-medium text-white cursor-pointer disabled:opacity-45"
            >
              <span
                className={`ep-switch-track w-8.5 h-5 rounded-full p-0.5 flex items-center transition-colors ${
                  visible ? "bg-accent justify-end" : "bg-white/20 justify-start"
                }`}
              >
                <span className="ep-switch-thumb h-4 w-4 rounded-full bg-white shadow" />
              </span>
              <span>{visible ? "Subtitles On" : "Subtitles Off"}</span>
            </button>

            <Button
              variant="secondary"
              size="sm"
              disabled={!loaded}
              onClick={() => void handleLoadExternalSubtitle()}
            >
              <FolderOpen className="h-3.5 w-3.5" />
              <span>Add File</span>
            </Button>
          </div>

          <SelectMenu
            ariaLabel="Subtitle Track"
            placement="top"
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
        </div>

        {/* Card 2: Timing & Magic Sync */}
        <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs">
              <span className="font-medium text-secondary">Timing</span>
              <span className="num text-[11px] text-muted">{formatDelayLabel(delaySecs)}</span>
            </div>

            {autoSyncBusy ? (
              <button
                type="button"
                onClick={() => void handleCancelAutoSync()}
                className="ep-press inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-bad/20 hover:bg-bad/30 text-bad text-[11px] font-medium cursor-pointer"
              >
                <Square className="h-3 w-3 fill-current" />
                <span>Cancel</span>
              </button>
            ) : (
              <button
                type="button"
                disabled={!canAutoSync}
                onClick={() => void handleAutoSync()}
                title="Automatically align subtitles to speech"
                className="ep-glass-pill-active ep-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium text-white cursor-pointer disabled:opacity-40 disabled:pointer-events-none"
              >
                <Sparkles className="h-3 w-3 text-accent-soft" />
                <span>{autoSyncOutcome ? "Matched" : "Magic Sync"}</span>
              </button>
            )}
          </div>

          <div className="ep-glass-input p-1 rounded-full grid grid-cols-5 gap-1 text-[11px]">
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(-0.5)}
              className="ep-press py-1 rounded-full text-secondary hover:text-white hover:bg-white/10 disabled:opacity-40 cursor-pointer"
            >
              -0.5s
            </button>
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(-0.1)}
              className="ep-press py-1 rounded-full text-secondary hover:text-white hover:bg-white/10 disabled:opacity-40 cursor-pointer"
            >
              Earlier
            </button>
            <button
              type="button"
              disabled={!loaded || delaySecs === 0}
              onClick={() => {
                setDelaySecs(0);
                void mpvSetSubDelay(0);
              }}
              className="ep-press py-1 rounded-full num text-muted hover:text-white disabled:opacity-40 cursor-pointer"
            >
              Reset
            </button>
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(0.1)}
              className="ep-press py-1 rounded-full text-secondary hover:text-white hover:bg-white/10 disabled:opacity-40 cursor-pointer"
            >
              Later
            </button>
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(0.5)}
              className="ep-press py-1 rounded-full text-secondary hover:text-white hover:bg-white/10 disabled:opacity-40 cursor-pointer"
            >
              +0.5s
            </button>
          </div>
        </div>

        {/* Card 3: Size, Color & More Tools toggle */}
        <div className="ep-glass-well rounded-2xl p-3 flex flex-col justify-between gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
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
                    className={`ep-press h-4.5 w-4.5 rounded-full cursor-pointer transition-transform ${
                      active ? "ring-2 ring-accent-soft scale-110" : "opacity-80 hover:opacity-100"
                    }`}
                    style={{ backgroundColor: c.hex }}
                  />
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setShowTools((s) => !s)}
              aria-expanded={showTools}
              className="ep-press inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.06] hover:bg-white/[0.12] text-[11px] font-medium text-secondary hover:text-white cursor-pointer shrink-0"
            >
              <span>Fine-tune</span>
              <ChevronDown
                className={`h-3 w-3 transition-transform duration-200 ${
                  showTools ? "rotate-180" : ""
                }`}
              />
            </button>
          </div>

          <div className="ep-glass-input p-1 rounded-full grid grid-cols-3 gap-1">
            {QUICK_SIZES.map((preset) => {
              const active = nearestSizeLabel === preset.label;
              return (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => {
                    setFontSize(preset.px);
                    applyStyleNow();
                  }}
                  className={`ep-press py-1 rounded-full text-xs font-medium cursor-pointer ${
                    active ? "ep-droplet-indicator text-white" : "text-muted hover:text-primary"
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Compact inline notices when relevant */}
      {(loadedFilePath || subIsBitmap || autoSyncError) && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-[11px]">
          {loadedFilePath && (
            <span className="text-muted truncate max-w-[320px]">
              File: {getFileDisplayName(loadedFilePath)}
            </span>
          )}
          {subIsBitmap && (
            <span className="inline-flex items-center gap-1.5 text-warn">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              Image subtitles ({selectedSub?.codec}) keep built-in style &amp; timing.
            </span>
          )}
          {autoSyncError && <span className="text-bad">{autoSyncError}</span>}
        </div>
      )}

      {/* Optional compact 3-column advanced drawer */}
      {showTools && (
        <div className="anim-fade-slide-up grid grid-cols-1 md:grid-cols-3 gap-2.5 max-h-56 overflow-y-auto">
          <div className="ep-glass-well rounded-2xl p-3 space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-secondary">Font Family</span>
              <button
                type="button"
                onClick={() => {
                  resetDefaults();
                  applyStyleNow();
                }}
                className="inline-flex items-center gap-1 text-[11px] text-muted hover:text-primary cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                Reset look
              </button>
            </div>
            <SelectMenu
              ariaLabel="Subtitle Font"
              placement="top"
              value={font}
              options={SUBTITLE_FONTS.map((f) => ({ value: f, label: f }))}
              onChange={(val) => {
                setFont(val);
                applyStyleNow();
              }}
            />
            <label className="ep-menu-row px-2 py-1.5 flex items-center justify-between gap-2 text-xs cursor-pointer">
              <span className="text-secondary">Override styled fansubs</span>
              <input
                type="checkbox"
                checked={overrideAssStyle}
                onChange={(e) => {
                  setOverrideAssStyle(e.target.checked);
                  applyStyleNow();
                }}
                className="accent-[var(--color-accent)] h-4 w-4 shrink-0"
              />
            </label>
          </div>

          <div className="ep-glass-well rounded-2xl p-3 space-y-2">
            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-secondary">
                <span>Exact Size</span>
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
                  throttledApplyStyle.call();
                }}
                onCommit={() => throttledApplyStyle.flush()}
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
                  throttledApplyStyle.call();
                }}
                onCommit={() => throttledApplyStyle.flush()}
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-[11px] text-secondary">
                <span>Outline Weight</span>
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
                  throttledApplyStyle.call();
                }}
                onCommit={() => throttledApplyStyle.flush()}
              />
            </div>
          </div>

          <div className="ep-glass-well rounded-2xl p-3 space-y-2">
            <div className="space-y-1">
              <span className="text-[11px] font-medium text-secondary block">Text Encoding</span>
              <SelectMenu
                ariaLabel="Subtitle Encoding"
                placement="top"
                value={encodingHint}
                options={SUBTITLE_ENCODING_OPTIONS}
                onChange={(val) => void handleEncodingChange(val)}
              />
            </div>

            <div className="grid grid-cols-2 gap-1.5">
              <TextField
                label="Early sub (s)"
                value={srcASecs}
                onChange={(e) => setSrcASecs(e.target.value)}
              />
              <TextField
                label="Early voice (s)"
                value={dstASecs}
                onChange={(e) => setDstASecs(e.target.value)}
              />
              <TextField
                label="Late sub (s)"
                value={srcBSecs}
                onChange={(e) => setSrcBSecs(e.target.value)}
              />
              <TextField
                label="Late voice (s)"
                value={dstBSecs}
                onChange={(e) => setDstBSecs(e.target.value)}
              />
            </div>
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
              onClick={() => void handleTwoAnchorApply()}
            >
              Apply 2-Point Alignment
            </Button>
          </div>
        </div>
      )}
    </div>
  );
});
