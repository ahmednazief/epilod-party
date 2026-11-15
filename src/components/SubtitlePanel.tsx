import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  Captions,
  Check,
  ChevronRight,
  FolderOpen,
  RotateCcw,
  SlidersHorizontal,
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
    try {
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
      const appState = useAppStore.getState();
      const pState = usePlayerStore.getState();
      void mpvSetVisible(!appState.settingsOpen && !appState.shortcutsOpen && !pState.playerError);
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

  const subTracks = tracks.filter((t) => t.type === "sub");
  const subsActive = visible && selectedSub !== null;

  return (
    <div role="menu" aria-label="Subtitle options" className="flex flex-col">
      {/* Top Quick Actions */}
      <button
        type="button"
        role="menuitemcheckbox"
        aria-checked={subsActive}
        disabled={!loaded}
        onClick={() => {
          if (subsActive) {
            setVisible(false);
            void mpvSetSubStyle({
              font,
              fontSize,
              color,
              borderSize,
              pos,
              visible: false,
              overrideAss: overrideAssStyle,
            });
          } else if (selectedSub !== null) {
            setVisible(true);
            void mpvSetSubStyle({
              font,
              fontSize,
              color,
              borderSize,
              pos,
              visible: true,
              overrideAss: overrideAssStyle,
            });
          } else if (subTracks.length > 0) {
            void selectSubTrack(subTracks[0].id, tracks, {
              mpvSetSubTrack,
              mpvSetSubDelay,
              setDelaySecs,
              setSubtitleVisible: setVisible,
              clearExternalTrackState: clearLoadedTrack,
            }).then(() => applyStyleNow());
          } else {
            pushNote("info", "No subtitle tracks in this video yet — choose a subtitle file.");
            void handleLoadExternalSubtitle();
          }
        }}
        className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs text-primary/95 hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
            <Captions className="h-3.5 w-3.5" />
          </span>
          <span className="truncate">{subsActive ? "Show Subtitles" : "Subtitles Off"}</span>
        </span>
        <span
          className={`ep-switch-track w-7.5 h-4 rounded-full p-0.5 flex items-center transition-colors shrink-0 ${
            subsActive ? "bg-accent justify-end" : "bg-white/20 justify-start"
          }`}
        >
          <span className="ep-switch-thumb h-3 w-3 rounded-full bg-white shadow" />
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        disabled={!loaded}
        onClick={() => void handleLoadExternalSubtitle()}
        className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs text-primary/95 hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
            <FolderOpen className="h-3.5 w-3.5" />
          </span>
          <span className="truncate">Add Subtitle File…</span>
        </span>
      </button>

      <div className="ep-hairline-divider my-1.5 mx-1.5" role="separator" />

      {/* Subtitle Track List */}
      <div className="px-2.5 pt-0.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
        Subtitle Track
      </div>

      {!loaded ? (
        <div className="px-2.5 py-1.5 text-xs text-muted">
          Open a video to select subtitles
        </div>
      ) : (
        <div className="max-h-36 overflow-y-auto space-y-0.5">
          {subOptions.map((opt) => {
            const active = opt.value === currentSubVal;
            const t = opt.track;
            const primaryLabel = t
              ? t.title?.trim() ||
                (t.external
                  ? loadedFilePath
                    ? getFileDisplayName(loadedFilePath)
                    : "External Subtitles"
                  : t.lang
                    ? `${t.lang.trim().toUpperCase()} Subtitles`
                    : `Subtitle ${t.id}`)
              : "Off";
            const metaTags: string[] = [];
            if (t?.title?.trim() && t.lang?.trim()) {
              metaTags.push(t.lang.trim().toUpperCase());
            }
            if (t?.external) {
              metaTags.push("External");
            } else if (t?.codec?.trim()) {
              metaTags.push(t.codec.trim().toUpperCase());
            }
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                data-active={active}
                onClick={() => {
                  const sid = opt.value === "none" ? null : Number(opt.value);
                  void selectSubTrack(sid, tracks, {
                    mpvSetSubTrack,
                    mpvSetSubDelay,
                    setDelaySecs,
                    setSubtitleVisible: setVisible,
                    clearExternalTrackState: clearLoadedTrack,
                  });
                }}
                className={`ep-menu-row ep-press w-full flex items-center justify-between gap-2.5 px-2.5 py-1.5 text-left text-xs cursor-pointer ${
                  active ? "text-white font-medium" : "text-primary/90 hover:text-white"
                }`}
              >
                <span className="flex items-center gap-2.5 min-w-0">
                  <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
                    {active ? (
                      <Check className="h-3.5 w-3.5 text-ok" />
                    ) : t ? (
                      <Captions className="h-3.5 w-3.5 opacity-70" />
                    ) : null}
                  </span>
                  <span className="truncate">{primaryLabel}</span>
                </span>
                {metaTags.length > 0 && (
                  <span className="text-[10px] font-mono text-muted shrink-0">
                    {metaTags.join(" · ")}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {(subIsBitmap || autoSyncError) && (
        <div className="px-2.5 pt-1 text-[10.5px] space-y-0.5">
          {subIsBitmap && (
            <div className="inline-flex items-center gap-1.5 text-warn">
              <AlertCircle className="h-3 w-3 shrink-0" />
              <span>Image subtitles ({selectedSub?.codec}) keep built-in style &amp; timing.</span>
            </div>
          )}
          {autoSyncError && <div className="text-bad">{autoSyncError}</div>}
        </div>
      )}

      <div className="ep-hairline-divider my-1.5 mx-1.5" role="separator" />

      {/* Timing & Magic Sync */}
      <div className="px-2.5 pt-0.5 pb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span>Timing &amp; Sync</span>
        <span
          className={`normal-case font-medium num ${
            Math.abs(delaySecs) < 0.005 ? "text-muted" : "text-accent-soft"
          }`}
        >
          {Math.abs(delaySecs) < 0.005 ? "In sync" : formatDelayLabel(delaySecs)}
        </span>
      </div>

      {autoSyncBusy ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => void handleCancelAutoSync()}
          className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs font-medium text-bad cursor-pointer"
        >
          <span className="flex items-center gap-2.5 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              <Square className="h-3 w-3 fill-current" />
            </span>
            <span className="truncate">Cancel Magic Sync</span>
          </span>
        </button>
      ) : (
        <button
          type="button"
          role="menuitem"
          disabled={!canAutoSync}
          onClick={() => void handleAutoSync()}
          title="Automatically align subtitles to speech"
          className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs font-medium text-accent-soft hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
        >
          <span className="flex items-center gap-2.5 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              <Sparkles className="h-3.5 w-3.5" />
            </span>
            <span className="truncate">{autoSyncOutcome ? "Magic Sync Matched" : "Magic Sync"}</span>
          </span>
          <span className="text-[10px] font-normal text-muted shrink-0">Auto-align</span>
        </button>
      )}

      <div className="px-1.5 pt-1 pb-1">
        <div className="ep-glass-input p-0.5 rounded-xl grid grid-cols-5 gap-0.5 text-[11px]">
          <button
            type="button"
            disabled={!loaded}
            onClick={() => handleNudge(-0.5)}
            className="ep-press h-7 rounded-[10px] num text-secondary hover:text-white hover:bg-white/[0.08] disabled:opacity-35 cursor-pointer"
          >
            -0.5s
          </button>
          <button
            type="button"
            disabled={!loaded}
            onClick={() => handleNudge(-0.1)}
            className="ep-press h-7 rounded-[10px] num text-secondary hover:text-white hover:bg-white/[0.08] disabled:opacity-35 cursor-pointer"
          >
            -0.1s
          </button>
          <button
            type="button"
            disabled={!loaded || delaySecs === 0}
            onClick={() => {
              setDelaySecs(0);
              void mpvSetSubDelay(0);
            }}
            className="ep-press h-7 rounded-[10px] text-muted hover:text-white hover:bg-white/[0.08] disabled:opacity-30 cursor-pointer"
          >
            Reset
          </button>
          <button
            type="button"
            disabled={!loaded}
            onClick={() => handleNudge(0.1)}
            className="ep-press h-7 rounded-[10px] num text-secondary hover:text-white hover:bg-white/[0.08] disabled:opacity-35 cursor-pointer"
          >
            +0.1s
          </button>
          <button
            type="button"
            disabled={!loaded}
            onClick={() => handleNudge(0.5)}
            className="ep-press h-7 rounded-[10px] num text-secondary hover:text-white hover:bg-white/[0.08] disabled:opacity-35 cursor-pointer"
          >
            +0.5s
          </button>
        </div>
      </div>

      <div className="ep-hairline-divider my-1.5 mx-1.5" role="separator" />

      {/* Quick Size & Colors */}
      <div className="px-2.5 pt-0.5 pb-1 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted">
        <span>Appearance</span>
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
                className={`ep-press h-3.5 w-3.5 rounded-full border border-white/25 cursor-pointer transition-transform ${
                  active ? "ring-2 ring-white scale-110" : "opacity-75 hover:opacity-100"
                }`}
                style={{ backgroundColor: c.hex }}
              />
            );
          })}
        </div>
      </div>

      <div className="px-1.5 pb-1">
        <div className="ep-glass-input p-0.5 rounded-xl grid grid-cols-3 gap-0.5">
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
                className={`ep-press h-7 rounded-[10px] text-[11px] font-medium cursor-pointer ${
                  active ? "ep-droplet-indicator text-white" : "text-secondary hover:text-white"
                }`}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Expandable More Style & Encoding */}
      <button
        type="button"
        role="menuitem"
        aria-expanded={showTools}
        onClick={() => setShowTools((s) => !s)}
        className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs text-secondary hover:text-white cursor-pointer"
      >
        <span className="flex items-center gap-2.5 min-w-0">
          <span className="w-4 h-4 flex items-center justify-center shrink-0">
            <SlidersHorizontal className="h-3.5 w-3.5" />
          </span>
          <span className="truncate">Fine-tune Style &amp; Encoding</span>
        </span>
        <ChevronRight
          className={`h-3.5 w-3.5 text-muted shrink-0 transition-transform duration-200 ${
            showTools ? "rotate-90" : ""
          }`}
        />
      </button>

      {showTools && (
        <div className="anim-fade-slide-up px-2 pb-1.5 pt-1.5 space-y-2.5 border-t border-white/[0.07] mt-1">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-secondary">Font Family</span>
              <button
                type="button"
                onClick={() => {
                  resetDefaults();
                  applyStyleNow();
                }}
                className="inline-flex items-center gap-1 text-muted hover:text-white cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
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
          </div>

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={overrideAssStyle}
            onClick={() => {
              const next = !overrideAssStyle;
              setOverrideAssStyle(next);
              void mpvSetSubStyle({
                font,
                fontSize,
                color,
                borderSize,
                pos,
                visible,
                overrideAss: next,
              });
            }}
            className="ep-menu-row ep-press w-full px-1.5 py-1.5 flex items-center justify-between gap-2 text-xs text-secondary hover:text-white cursor-pointer"
          >
            <span>Override styled fansubs</span>
            <span
              className={`ep-switch-track w-7.5 h-4 rounded-full p-0.5 flex items-center transition-colors shrink-0 ${
                overrideAssStyle ? "bg-accent justify-end" : "bg-white/20 justify-start"
              }`}
            >
              <span className="ep-switch-thumb h-3 w-3 rounded-full bg-white shadow" />
            </span>
          </button>

          <div className="space-y-1.5">
            <div>
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

            <div>
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

            <div>
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

          <div className="ep-hairline-divider" role="separator" />

          <div className="space-y-2">
            <div className="space-y-1">
              <span className="text-[11px] text-secondary block">Text Encoding</span>
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
