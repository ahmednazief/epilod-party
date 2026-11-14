import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ChevronRight,
  Eye,
  EyeOff,
  FolderOpen,
  RotateCcw,
  Sparkles,
  Square,
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

  const [showAdvanced, setShowAdvanced] = useState(false);
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
      pushNote("info", "Open a video before loading a subtitle file.");
      return;
    }
    if (!isDesktop()) {
      pushNote("warn", "File dialog requires the Windows desktop app.");
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
        pushNote("info", "Updated subtitle text encoding.");
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
      pushNote("success", "Subtitles synced to audio.");
    } catch (err) {
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      const msg = formatUserError(err, "Could not auto-sync subtitles automatically.");
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
      pushNote("success", "Applied manual 2-point timing.");
    } catch (err) {
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      pushNote("error", formatUserError(err, "Manual timing calibration failed."));
    }
  };

  const handleNudge = (delta: number) => {
    const next = nudgeDelay(delta);
    void mpvSetSubDelay(next);
  };

  const hasTrack = currentSubVal !== "none" || Boolean(loadedFilePath);

  return (
    <div className="anim-tab-in p-3.5 space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            disabled={!loaded}
            onClick={() => void handleLoadExternalSubtitle()}
            className="flex-1"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            Load Subtitle
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
            title="Show/Hide subtitles (V)"
          >
            {visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          </Button>
        </div>

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
            {getFileDisplayName(loadedFilePath)}
          </p>
        )}
      </div>

      {subIsBitmap && (
        <div className="p-3 bg-canvas border border-warn/35 rounded-xl flex items-start gap-2 text-[11px] text-warn">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>
            This track uses image-based subtitles, so font styling and auto-sync aren&apos;t available.
          </span>
        </div>
      )}

      <div className="p-3.5 bg-canvas border border-hairline rounded-xl space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-primary">Timing</span>
          <span className="num text-[11px] text-muted">
            {!hasTrack
              ? "No subtitle active"
              : autoSyncOutcome && Math.abs(delaySecs) < 0.01
                ? "Synced to audio"
                : delaySecs === 0
                  ? "On time"
                  : formatDelayLabel(delaySecs)}
          </span>
        </div>

        {autoSyncBusy ? (
          <Button
            variant="danger"
            size="sm"
            className="w-full"
            onClick={() => void handleCancelAutoSync()}
          >
            <Square className="h-3 w-3" />
            Cancel Auto-Sync
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            className="w-full"
            disabled={!canAutoSync}
            onClick={() => void handleAutoSync()}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Auto-Sync to Audio
          </Button>
        )}

        {autoSyncError && <p className="text-[11px] text-bad">{autoSyncError}</p>}

        <div className="grid grid-cols-5 gap-1 pt-0.5">
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

      <div className="p-3.5 bg-canvas border border-hairline rounded-xl space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-primary">Look</span>
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

        <div className="space-y-1.5">
          <div className="flex justify-between text-[11px] text-secondary">
            <span>Text Size</span>
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

        <div className="flex items-center justify-between pt-0.5">
          <span className="text-[11px] text-secondary">Color</span>
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
                  className={`h-5 w-5 rounded-full border cursor-pointer transition-transform ${
                    active ? "border-accent ring-2 ring-accent/40 scale-110" : "border-hairline"
                  }`}
                  style={{ backgroundColor: c.hex }}
                />
              );
            })}
          </div>
        </div>
      </div>

      <div>
        <button
          type="button"
          onClick={() => setShowAdvanced((v) => !v)}
          className="w-full flex items-center justify-between px-1 py-1.5 text-xs text-muted hover:text-secondary transition-colors cursor-pointer"
        >
          <span>Advanced timing &amp; encoding</span>
          <ChevronRight
            className={`h-3.5 w-3.5 transition-transform duration-150 ${
              showAdvanced ? "rotate-90" : ""
            }`}
          />
        </button>

        {showAdvanced && (
          <div className="mt-2 p-3.5 bg-canvas border border-hairline rounded-xl space-y-3.5">
            <div className="space-y-1.5">
              <span className="text-[11px] font-medium text-secondary block">Text Encoding</span>
              <SelectMenu
                ariaLabel="Subtitle Encoding"
                value={encodingHint}
                options={SUBTITLE_ENCODING_OPTIONS}
                onChange={(val) => void handleEncodingChange(val)}
              />
            </div>

            <div className="space-y-1.5">
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

            <div className="space-y-1.5">
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

            <label className="flex items-start justify-between gap-2 pt-1 text-xs cursor-pointer">
              <div>
                <span className="text-secondary block">Override styled .ass/.ssa subtitles</span>
                <span className="text-[11px] text-muted">
                  Force the font and color above on stylized fansubs.
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

            {autoSyncOutcome && (
              <p className="num text-[11px] text-ok pt-1 border-t border-hairline">
                Shift {autoSyncOutcome.offsetSecs >= 0 ? "+" : ""}
                {autoSyncOutcome.offsetSecs.toFixed(2)}s · z={autoSyncOutcome.confidenceZ.toFixed(1)}
                {autoSyncOutcome.driftApplied ? ` · ${autoSyncOutcome.scale.toFixed(4)}×` : ""}
              </p>
            )}

            <div className="pt-2 border-t border-hairline space-y-2">
              <p className="text-[11px] text-secondary">
                2-Point Manual Timing (seconds)
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
                Apply 2-Point Timing
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
