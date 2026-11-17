import { open } from "@tauri-apps/plugin-dialog";
import {
  AppAlertIcon,
  AppCheckIcon,
  AppChevronIcon,
  AppResetIcon,
  AppSlidersIcon,
  AppSparkleIcon,
  AppStopIcon,
} from "./ui/AppIcons";
import {
  MenuAddFileIcon,
  MenuBoldIcon,
  MenuDownloadIcon,
  MenuEncodingIcon,
  MenuFontIcon,
  MenuOverrideFansubIcon,
  MenuSearchIcon,
  MenuSubtitlesOffIcon,
} from "./ui/MenuIcons";
import { PlayerCaptionsIcon } from "./ui/PlayerIcons";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { isDesktop } from "../lib/bridge";
import { formatUserError } from "../lib/errors";
import { getFileDisplayName } from "../lib/fileDrop";
import {
  mpvAddSubtitle,
  mpvRemoveSubtitle,
  mpvSetSubDelay,
  mpvSetSubStyle,
  mpvSetSubTrack,
  safeMpvCall,
  subtitleAutoSync,
  subtitleCancelAutoSync,
  subtitleDownloadOnline,
  subtitleSearchOnline,
  type OnlineSubtitleCandidate,
  type OnlineSubtitleSearchResult,
  type SubtitleEncodingHint,
} from "../lib/mpv";
import { runWithHiddenMpvSurface } from "../lib/playerActions";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import {
  buildSubTrackOptions,
  formatDelayLabel,
  formatSubtitleTrackDisplay,
  resolveEmbeddedSyncTarget,
  selectSubTrack,
} from "../lib/tracks";
import { useAppStore } from "../store/useAppStore";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import {
  buildSubStyleParams,
  deriveCleanSearchQuery,
  SUBTITLE_COLORS,
  SUBTITLE_ENCODING_OPTIONS,
  SUBTITLE_FONTS,
  SUBTITLE_SEARCH_LANGUAGES,
  useSubtitleStore,
} from "../store/useSubtitleStore";
import { Scrubber } from "./ui/Scrubber";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { SelectMenu } from "./ui/SelectMenu";

const QUICK_SIZES = [
  { label: "Small", px: 36 },
  { label: "Medium", px: 44 },
  { label: "Large", px: 58 },
] as const;

function applyStyleNow(
  overrides?: Parameters<typeof buildSubStyleParams>[1],
): void {
  const s = useSubtitleStore.getState();
  safeMpvCall(mpvSetSubStyle(buildSubStyleParams(s, overrides)), "mpvSetSubStyle");
}

export const SubtitlePanel = memo(function SubtitlePanel() {
  const videoPath = useAppStore((s) => s.selectedFilePath);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const preferredSubtitleLangs = useAppStore((s) => s.preferredSubtitleLangs);
  const setPreferredSubtitleLangs = useAppStore((s) => s.setPreferredSubtitleLangs);
  const openSubtitlesApiKey = useAppStore((s) => s.openSubtitlesApiKey);

  const loaded = usePlayerStore((s) => s.loaded);
  const tracks = usePlayerStore((s) => s.tracks);
  const detectedSubLangs = usePlayerStore((s) => s.detectedSubLangs);

  const loadedFilePath = useSubtitleStore((s) => s.loadedFilePath);
  const originalFilePath = useSubtitleStore((s) => s.originalFilePath);
  const font = useSubtitleStore((s) => s.font);
  const bold = useSubtitleStore((s) => s.bold);
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
  const autoFetchStatus = useSubtitleStore((s) => s.autoFetchStatus);
  const autoFetchMessage = useSubtitleStore((s) => s.autoFetchMessage);

  const setFont = useSubtitleStore((s) => s.setFont);
  const setBold = useSubtitleStore((s) => s.setBold);
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
  const setAutoFetchState = useSubtitleStore((s) => s.setAutoFetchState);

  const pushNote = useNotificationStore((s) => s.push);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showOnlineSearch, setShowOnlineSearch] = useState(false);
  const [searchQuery, setSearchQuery] = useState(() => deriveCleanSearchQuery(videoPath));
  const [searchLang, setSearchLang] = useState<string>(() => preferredSubtitleLangs || "all");
  const [searchBusy, setSearchBusy] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [searchResult, setSearchResult] = useState<OnlineSubtitleSearchResult | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const searchGenRef = useRef(0);
  const lastVideoQueryPathRef = useRef<string | null>(videoPath);

  useEffect(() => {
    if (lastVideoQueryPathRef.current !== videoPath) {
      lastVideoQueryPathRef.current = videoPath;
      setSearchQuery(deriveCleanSearchQuery(videoPath));
      setSearchResult(null);
      setSearchError(null);
    }
  }, [videoPath]);

  const throttledApplyStyle = useMemo(
    () => createLeadingTrailingThrottle(() => applyStyleNow(), 60),
    [],
  );

  useEffect(() => () => throttledApplyStyle.cancel(), [throttledApplyStyle]);

  const subOptions = buildSubTrackOptions(tracks).filter((opt) => opt.track !== null);
  const selectedAudio = tracks.find((t) => t.type === "audio" && t.selected) ?? null;

  const {
    selectedSub,
    subIsBitmap,
    fallbackEmbeddedSub,
    syncTargetEmbedded,
    isClosedCaption: subIsClosedCaption,
    ffIndex: embeddedSubFfIdx,
    embeddedSubIdx: resolvedEmbeddedSubIdx,
  } = resolveEmbeddedSyncTarget(tracks, detectedSubLangs);
  const currentSubVal = selectedSub ? String(selectedSub.id) : "none";
  const isEmbeddedSelected = Boolean(selectedSub && !selectedSub.external);
  const effectiveExternalSubPath = isEmbeddedSelected
    ? null
    : originalFilePath || loadedFilePath || null;
  const hasExternalFile = Boolean(effectiveExternalSubPath);

  const prevSelectedSubRef = useRef<{ id: number; external?: boolean } | null>(
    selectedSub ? { id: selectedSub.id, external: selectedSub.external } : null,
  );
  useEffect(() => {
    const prev = prevSelectedSubRef.current;
    prevSelectedSubRef.current = selectedSub
      ? { id: selectedSub.id, external: selectedSub.external }
      : null;
    const switchedToEmbedded =
      Boolean(selectedSub && !selectedSub.external) &&
      (prev === null || prev.id !== selectedSub?.id || prev.external !== selectedSub?.external);
    if (switchedToEmbedded && (originalFilePath || loadedFilePath)) {
      clearLoadedTrack();
    }
  }, [selectedSub, originalFilePath, loadedFilePath, clearLoadedTrack]);

  const embeddedSubIdx = syncTargetEmbedded
    ? subIsClosedCaption
      ? 0
      : resolvedEmbeddedSubIdx
    : null;

  const canAutoSync = loaded && Boolean(videoPath) && (hasExternalFile || syncTargetEmbedded !== null);

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
    await runWithHiddenMpvSurface(true, async () => {
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
    });
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
        pushNote("info", "Reloaded subtitle encoding.");
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
      const useExternalSub = Boolean(!isEmbeddedSelected && (originalFilePath || loadedFilePath));
      const result = await subtitleAutoSync({
        videoPath,
        subtitlePath: useExternalSub ? originalFilePath || loadedFilePath || null : null,
        audioTrackId: selectedAudio?.id ?? null,
        embeddedSubIdx:
          !originalFilePath && !loadedFilePath && embeddedSubIdx !== null && embeddedSubIdx >= 0
            ? embeddedSubIdx
            : isEmbeddedSelected && embeddedSubIdx !== null && embeddedSubIdx >= 0
              ? embeddedSubIdx
              : null,
        embeddedSubFfIdx: !useExternalSub ? embeddedSubFfIdx : null,
        embeddedSubCodec: !useExternalSub ? (syncTargetEmbedded?.codec ?? null) : null,
        encodingHint,
        lowPower: lowPowerMode,
      });
      if (
        useSubtitleStore.getState().sessionGen !== startGen ||
        useAppStore.getState().selectedFilePath !== startVideoPath
      ) {
        return;
      }
      if (result.bitmapInPlace || !result.syncedSubtitlePath) {
        await mpvSetSubDelay(result.offsetSecs);
        setDelaySecs(result.offsetSecs);
        setAutoSyncResult(result);
        pushNote(
          "success",
          result.driftApplied
            ? `Image subtitles aligned (${formatDelayLabel(result.offsetSecs)}).`
            : `Image subtitles matched cleanly to voice (${formatDelayLabel(result.offsetSecs)}).`,
        );
      } else {
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
          result.segmentsApplied && result.segmentsApplied > 1
            ? `Subtitles matched across ${result.segmentsApplied} timing segments.`
            : "Subtitles matched cleanly to voice.",
        );
      }
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

  const handleNudge = (delta: number) => {
    const next = nudgeDelay(delta);
    safeMpvCall(mpvSetSubDelay(next), "mpvSetSubDelay");
  };

  const handleRunOnlineSearch = async (
    overrideQuery?: string,
    overrideLang?: string,
  ) => {
    if (!isDesktop()) {
      setSearchError("Online subtitle search requires the Windows desktop app.");
      return;
    }
    const q = (overrideQuery ?? searchQuery).trim();
    const lang = overrideLang ?? searchLang;
    if (!q && !videoPath) {
      setSearchError("Type a movie or show title to search.");
      return;
    }
    const gen = ++searchGenRef.current;
    setSearchBusy(true);
    setSearchError(null);
    try {
      const res = await subtitleSearchOnline({
        query: q || null,
        videoPath: videoPath ?? null,
        languages: lang,
        apiKey: openSubtitlesApiKey || null,
      });
      if (searchGenRef.current !== gen) return;
      setSearchResult(res);
      if (res.items.length === 0) {
        setSearchError("No subtitles matched. Try another title or language.");
      }
    } catch (err) {
      if (searchGenRef.current !== gen) return;
      setSearchError(formatUserError(err, "Could not search online subtitles."));
    } finally {
      if (searchGenRef.current === gen) {
        setSearchBusy(false);
      }
    }
  };

  const handleToggleOnlineSearch = () => {
    const next = !showOnlineSearch;
    setShowOnlineSearch(next);
    if (next && !searchResult && !searchBusy && (searchQuery.trim() || videoPath)) {
      void handleRunOnlineSearch();
    }
  };

  const handleDownloadOnlineCandidate = async (item: OnlineSubtitleCandidate) => {
    if (downloadingId) return;
    if (!loaded) {
      pushNote("info", "Open a movie or episode before loading a subtitle.");
      return;
    }
    setDownloadingId(item.id);
    setSearchError(null);
    try {
      const dl = await subtitleDownloadOnline({
        downloadUrl: item.downloadUrl,
        fileId: item.fileId,
        fileName: item.fileName,
        language: item.language,
        matchKind: item.matchKind,
        videoPath: videoPath ?? null,
        apiKey: openSubtitlesApiKey || null,
      });
      const activeSub = usePlayerStore
        .getState()
        .tracks.find((t) => t.type === "sub" && t.selected);
      if (activeSub?.external) {
        await mpvRemoveSubtitle(activeSub.id).catch(() => undefined);
      }
      await mpvAddSubtitle(dl.subtitlePath, "utf8");
      await mpvSetSubDelay(0);
      setDelaySecs(0);
      setLoadedTrack(dl.subtitlePath, dl.subtitlePath);
      setAutoFetchState("loaded", `Loaded ${dl.languageLabel}`);
      applyStyleNow({ visible: true });
      pushNote("success", `Loaded ${dl.languageLabel} subtitle: ${item.releaseName}`);
    } catch (err) {
      const msg = formatUserError(err, "Failed downloading subtitle.");
      setSearchError(msg);
      pushNote("error", msg);
    } finally {
      setDownloadingId(null);
    }
  };

  const nearestSizeLabel = QUICK_SIZES.reduce((best, cur) =>
    Math.abs(cur.px - fontSize) < Math.abs(best.px - fontSize) ? cur : best,
  ).label;

  const subTracks = tracks.filter((t) => t.type === "sub");
  const subsActive = visible && selectedSub !== null;

  return (
    <div role="menu" aria-label="Subtitle options" className="flex flex-col gap-4">
      {/* Top Quick Actions */}
      <div className="space-y-1.5">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={subsActive}
          disabled={!loaded}
          onClick={() => {
            if (subsActive) {
              setVisible(false);
              applyStyleNow({ visible: false });
            } else if (selectedSub !== null) {
              setVisible(true);
              applyStyleNow({ visible: true });
            } else if (subTracks.length > 0) {
              safeMpvCall(
                selectSubTrack(subTracks[0].id, tracks, {
                  mpvSetSubTrack,
                  mpvSetSubDelay,
                  setDelaySecs,
                  setSubtitleVisible: setVisible,
                  clearExternalTrackState: clearLoadedTrack,
                }).then(() => applyStyleNow()),
                "selectSubTrack",
              );
            } else {
              setShowOnlineSearch(true);
              if (!searchResult && !searchBusy && (searchQuery.trim() || videoPath)) {
                void handleRunOnlineSearch();
              }
            }
          }}
          className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs text-primary/95 hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
              {subsActive ? (
                <PlayerCaptionsIcon size={14} />
              ) : (
                <MenuSubtitlesOffIcon size={14} className="opacity-75" />
              )}
            </span>
            <span className="truncate">Show Subtitles</span>
          </span>
          <GlassSwitchTrack checked={subsActive} size="sm" />
        </button>

        <button
          type="button"
          role="menuitem"
          aria-expanded={showOnlineSearch}
          onClick={handleToggleOnlineSearch}
          className={`ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs cursor-pointer ${
            showOnlineSearch ? "text-white font-medium" : "text-accent-soft hover:text-white"
          }`}
          data-active={showOnlineSearch}
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              <MenuSearchIcon size={14} />
            </span>
            <span className="truncate">
              {autoFetchStatus === "searching" ? "Searching Online…" : "Search Subtitles Online"}
            </span>
          </span>
          <AppChevronIcon
            direction="right"
            size={14}
            className={`text-white/60 shrink-0 transition-transform duration-200 ${
              showOnlineSearch ? "rotate-90" : ""
            }`}
          />
        </button>

        <AnimatedCollapse open={showOnlineSearch} innerClassName="pt-1.5 space-y-2.5">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleRunOnlineSearch();
            }}
            className="flex items-center gap-1.5 px-1"
          >
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Movie or show (e.g. Inception)"
              aria-label="Search subtitles query"
              className="flex-1 min-w-0 h-8 px-2.5 rounded-xl bg-white/[0.05] border border-white/12 focus:border-accent-soft/70 focus:outline-none text-xs text-white placeholder:text-white/35"
            />
            <button
              type="submit"
              disabled={searchBusy}
              className="ep-glass-pill ep-press h-8 px-3 rounded-xl text-xs font-medium text-white shrink-0 cursor-pointer disabled:opacity-45"
            >
              {searchBusy ? "…" : "Search"}
            </button>
          </form>

          <div className="px-1">
            <SelectMenu
              ariaLabel="Subtitle Search Language"
              placement="bottom"
              triggerIcon={<MenuEncodingIcon size={13} />}
              value={searchLang}
              options={SUBTITLE_SEARCH_LANGUAGES}
              onChange={(val) => {
                setSearchLang(val);
                if (val !== "all") {
                  setPreferredSubtitleLangs(val);
                }
                if (searchQuery.trim() || videoPath) {
                  void handleRunOnlineSearch(searchQuery, val);
                }
              }}
            />
          </div>

          {searchBusy && (
            <div className="px-3 py-1.5 text-[11px] text-secondary">
              Searching OpenSubtitles &amp; matching file hash…
            </div>
          )}

          {!searchBusy && searchResult?.resolvedTitle && (
            <div className="px-3 flex items-center justify-between gap-2 text-[10.5px] text-white/60">
              <span className="truncate">
                {searchResult.resolvedTitle}
                {searchResult.resolvedYear ? ` (${searchResult.resolvedYear})` : ""}
                {searchResult.parsedSeason && searchResult.parsedEpisode
                  ? ` · S${String(searchResult.parsedSeason).padStart(2, "0")}E${String(
                      searchResult.parsedEpisode,
                    ).padStart(2, "0")}`
                  : ""}
              </span>
              {searchResult.items.some((i) => i.matchKind === "hash") && (
                <span className="text-ok font-medium shrink-0">Exact hash</span>
              )}
            </div>
          )}

          {searchError && (
            <div className="px-3 text-[11px] text-warn leading-relaxed">{searchError}</div>
          )}

          {searchResult && searchResult.items.length > 0 && (
            <div className="ep-menu-scroll max-h-48 overflow-y-auto overflow-x-hidden pr-1 space-y-1.5">
              {searchResult.items.slice(0, 40).map((item) => {
                const isDownloading = downloadingId === item.id;
                const isExact = item.matchKind === "hash";
                const isRelease = item.matchKind === "release";
                return (
                  <button
                    key={item.id}
                    type="button"
                    disabled={Boolean(downloadingId) || !loaded}
                    onClick={() => void handleDownloadOnlineCandidate(item)}
                    title={!loaded ? "Open a video to load subtitles" : item.releaseName}
                    className="ep-menu-row ep-press w-full flex items-center justify-between gap-2.5 px-2.5 py-2 text-left cursor-pointer disabled:opacity-45 disabled:pointer-events-none"
                  >
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-[11.5px] font-medium text-primary/95 truncate">
                        {item.releaseName}
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-white/50">
                        <span className="uppercase font-semibold text-white/75">
                          {item.languageLabel}
                        </span>
                        {isExact && <span className="text-ok font-medium">Exact Match</span>}
                        {!isExact && isRelease && (
                          <span className="text-accent-soft font-medium">Release Match</span>
                        )}
                        {item.fps && <span className="num">{item.fps.toFixed(2)} fps</span>}
                        {item.hearingImpaired && <span>HI</span>}
                      </div>
                    </div>
                    <span className="w-5 h-5 flex items-center justify-center shrink-0 text-accent-soft">
                      {isDownloading ? (
                        <span className="text-[10px] font-semibold">…</span>
                      ) : (
                        <MenuDownloadIcon size={13} />
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </AnimatedCollapse>

        <button
          type="button"
          role="menuitem"
          disabled={!loaded}
          onClick={() => void handleLoadExternalSubtitle()}
          className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs text-primary/95 hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0 text-secondary">
              <MenuAddFileIcon size={14} />
            </span>
            <span className="truncate">Add Subtitle File…</span>
          </span>
        </button>
      </div>

      {/* Subtitle Track List */}
      <div className="space-y-2">
        <div className="px-3 flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-white/45">
          <span>Subtitle Track</span>
          {loaded && subOptions.length > 0 && (
            <span className="num text-white/40">{subOptions.length}</span>
          )}
        </div>

        {!loaded ? (
          <div className="px-3 py-1.5 text-xs text-muted">
            Open a video to select subtitles
          </div>
        ) : subOptions.length === 0 ? (
          <div className="px-3 py-1.5 text-xs text-muted">
            {autoFetchStatus === "searching"
              ? autoFetchMessage ?? "Searching online subtitles automatically…"
              : "No tracks yet — search online or add a file"}
          </div>
        ) : (
          <div className="ep-menu-scroll max-h-40 overflow-y-auto overflow-x-hidden pr-1 space-y-1.5">
            {subOptions.map((opt) => {
              const active = opt.value === currentSubVal;
              const t = opt.track!;
              const { label: primaryLabel, metaTags } = formatSubtitleTrackDisplay(t, {
                detectedLang: detectedSubLangs[t.id],
                externalFileName: loadedFilePath ? getFileDisplayName(loadedFilePath) : null,
              });
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  data-active={active}
                  onClick={() => {
                    void selectSubTrack(t.id, tracks, {
                      mpvSetSubTrack,
                      mpvSetSubDelay,
                      setDelaySecs,
                      setSubtitleVisible: setVisible,
                      clearExternalTrackState: clearLoadedTrack,
                    });
                  }}
                  className={`ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs cursor-pointer ${
                    active ? "text-white font-medium" : "text-primary/90 hover:text-white"
                  }`}
                >
                  <span className="flex items-center gap-3 min-w-0">
                    <span className="w-4 h-4 flex items-center justify-center shrink-0">
                      {active ? (
                        <AppCheckIcon size={14} className="text-ok" />
                      ) : (
                        <span className="h-1.5 w-1.5 rounded-full bg-white/25" aria-hidden="true" />
                      )}
                    </span>
                    <span className="truncate">{primaryLabel}</span>
                  </span>
                  {metaTags.length > 0 && (
                    <span className="text-[10px] num font-medium text-white/55 shrink-0">
                      {metaTags.join(" · ")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {((subIsBitmap && fallbackEmbeddedSub) || autoSyncError) && (
          <div className="px-3 pt-1 text-[10.5px] space-y-1">
            {subIsBitmap && fallbackEmbeddedSub && (
              <div className="flex items-start gap-1.5 text-warn">
                <AppAlertIcon variant="info" size={12} className="shrink-0 mt-0.5" />
                <span>
                  {`Image subtitles (${selectedSub?.codec}) keep built-in timing; Magic Sync will align using ${
                    formatSubtitleTrackDisplay(fallbackEmbeddedSub, {
                      detectedLang: detectedSubLangs[fallbackEmbeddedSub.id],
                    }).label
                  }${fallbackEmbeddedSub.codec ? ` (${fallbackEmbeddedSub.codec.toUpperCase()})` : ""}.`}
                </span>
              </div>
            )}
            {autoSyncError && <div className="text-bad">{autoSyncError}</div>}
          </div>
        )}
      </div>

      {/* Timing & Magic Sync */}
      <div className="space-y-2">
        <div className="px-3 flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-white/45">
          <span>Timing &amp; Sync</span>
          <span
            className={`normal-case tracking-normal font-medium num ${
              Math.abs(delaySecs) < 0.005 ? "text-white/55" : "text-accent-soft"
            }`}
          >
            {Math.abs(delaySecs) < 0.005 ? "In sync" : formatDelayLabel(delaySecs)}
          </span>
        </div>

        <div className="space-y-2">
          {autoSyncBusy ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => void handleCancelAutoSync()}
              className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium text-bad cursor-pointer"
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  <AppStopIcon size={12} />
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
              title={
                !canAutoSync
                  ? "Select a subtitle track above or add a subtitle file first"
                  : "Automatically align subtitles to speech"
              }
              className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs font-medium text-accent-soft hover:text-white cursor-pointer disabled:opacity-35 disabled:pointer-events-none"
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  <AppSparkleIcon size={14} />
                </span>
                <span className="truncate">{autoSyncOutcome ? "Magic Sync Matched" : "Magic Sync"}</span>
              </span>
              <span className="text-[10px] font-normal text-muted shrink-0">Auto-align</span>
            </button>
          )}

          <div className="ep-glass-tray p-1 rounded-full grid grid-cols-5 gap-1 text-[11px]">
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(-0.5)}
              className="ep-press ep-tray-option h-7.5 rounded-full num text-secondary hover:text-white disabled:opacity-35 cursor-pointer"
            >
              -0.5s
            </button>
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(-0.1)}
              className="ep-press ep-tray-option h-7.5 rounded-full num text-secondary hover:text-white disabled:opacity-35 cursor-pointer"
            >
              -0.1s
            </button>
            <button
              type="button"
              disabled={!loaded || delaySecs === 0}
              onClick={() => {
                setDelaySecs(0);
                safeMpvCall(mpvSetSubDelay(0), "mpvSetSubDelay");
              }}
              className="ep-press ep-tray-option h-7.5 rounded-full text-muted hover:text-white disabled:opacity-30 cursor-pointer"
            >
              Reset
            </button>
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(0.1)}
              className="ep-press ep-tray-option h-7.5 rounded-full num text-secondary hover:text-white disabled:opacity-35 cursor-pointer"
            >
              +0.1s
            </button>
            <button
              type="button"
              disabled={!loaded}
              onClick={() => handleNudge(0.5)}
              className="ep-press ep-tray-option h-7.5 rounded-full num text-secondary hover:text-white disabled:opacity-35 cursor-pointer"
            >
              +0.5s
            </button>
          </div>
        </div>
      </div>

      {/* Quick Size & Colors */}
      <div className="space-y-2.5">
        <div className="px-3 flex items-center justify-between gap-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-white/45">
          <span>Appearance</span>
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
                  className={`ep-press h-4 w-4 rounded-full border border-white/25 cursor-pointer ${
                    active
                      ? "ring-2 ring-accent-soft shadow-[0_0_8px_rgba(167,139,250,0.45)] scale-110"
                      : "opacity-80 hover:opacity-100"
                  }`}
                  style={{ backgroundColor: c.hex }}
                />
              );
            })}
          </div>
        </div>

        <SegmentedTabs
          ariaLabel="Subtitle size"
          size="sm"
          fullWidth
          value={nearestSizeLabel}
          items={QUICK_SIZES.map((preset) => ({
            value: preset.label,
            label: preset.label,
          }))}
          onChange={(label) => {
            const found = QUICK_SIZES.find((p) => p.label === label);
            if (found) {
              setFontSize(found.px);
              applyStyleNow();
            }
          }}
        />
      </div>

      {/* Encoding & Advanced Options */}
      <div className="space-y-1.5">
        {hasExternalFile && (
          <SelectMenu
            variant="row"
            label="Text Encoding"
            ariaLabel="Subtitle Encoding"
            placement="top"
            triggerIcon={<MenuEncodingIcon size={14} />}
            value={encodingHint}
            options={SUBTITLE_ENCODING_OPTIONS}
            onChange={(val) => void handleEncodingChange(val)}
          />
        )}

        <button
          type="button"
          role="menuitem"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((open) => !open)}
          className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs text-secondary hover:text-white cursor-pointer"
        >
          <span className="flex items-center gap-3 min-w-0">
            <span className="w-4 h-4 flex items-center justify-center shrink-0">
              <AppSlidersIcon size={14} />
            </span>
            <span className="truncate">Advanced Options</span>
          </span>
          <AppChevronIcon
            direction="right"
            size={14}
            className={`text-white/60 shrink-0 transition-transform duration-200 ${
              showAdvanced ? "rotate-90" : ""
            }`}
          />
        </button>

        <AnimatedCollapse open={showAdvanced} innerClassName="pt-1.5 space-y-2.5">
          <SelectMenu
            variant="row"
            label="Font Family"
            ariaLabel="Subtitle Font Family"
            placement="top"
            triggerIcon={<MenuFontIcon size={14} />}
            value={font}
            options={SUBTITLE_FONTS.map((f) => ({ value: f, label: f }))}
            onChange={(val) => {
              setFont(val);
              applyStyleNow();
            }}
          />

          <div className="space-y-1.5">
            <button
              type="button"
              role="switch"
              aria-checked={bold}
              onClick={() => {
                const next = !bold;
                setBold(next);
                applyStyleNow({ bold: next });
              }}
              className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs text-secondary hover:text-white cursor-pointer"
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  <MenuBoldIcon size={14} />
                </span>
                <span className="truncate">Bold font</span>
              </span>
              <GlassSwitchTrack checked={bold} size="sm" />
            </button>

            <button
              type="button"
              role="switch"
              aria-checked={overrideAssStyle}
              onClick={() => {
                const next = !overrideAssStyle;
                setOverrideAssStyle(next);
                applyStyleNow({ overrideAss: next });
              }}
              className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-xs text-secondary hover:text-white cursor-pointer"
            >
              <span className="flex items-center gap-3 min-w-0">
                <span className="w-4 h-4 flex items-center justify-center shrink-0">
                  <MenuOverrideFansubIcon size={14} />
                </span>
                <span className="truncate">Override styled fansubs</span>
              </span>
              <GlassSwitchTrack checked={overrideAssStyle} size="sm" />
            </button>
          </div>

          <div className="space-y-2.5 pt-0.5">
            <div className="px-3">
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

            <div className="px-3">
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

            <div className="px-3">
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

          <button
            type="button"
            onClick={() => {
              throttledApplyStyle.cancel();
              setFont("Noto Sans Arabic");
              setBold(false);
              setFontSize(44);
              setColor("#FFFFFF");
              setBorderSize(2.5);
              setPos(95);
              setOverrideAssStyle(false);
              applyStyleNow({ bold: false, overrideAss: false });
            }}
            className="ep-menu-row ep-press w-full flex items-center justify-center gap-2 px-3 py-2 text-xs text-muted hover:text-white cursor-pointer"
          >
            <AppResetIcon size={13} />
            <span>Reset Style Defaults</span>
          </button>
        </AnimatedCollapse>
      </div>
    </div>
  );
});
