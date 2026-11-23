import { useEffect, useState } from "react";
import type { PartyFileMismatch } from "../lib/fileMismatch";
import type { LocalMatchCandidate } from "../lib/localLibrary";
import { usePresencePayload } from "../lib/useAnimatedPresence";
import { useNotificationStore } from "../store/useNotificationStore";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import {
  AppAlertIcon,
  AppChevronIcon,
  AppCloseIcon,
  AppFolderIcon,
  AppSeasonFolderIcon,
} from "./ui/AppIcons";
import {
  PartyAlignSceneIcon,
  PartyFpsMatchIcon,
  PartyMismatchIcon,
  PlayerPlayIcon,
} from "./ui/PlayerIcons";

interface FileMismatchBannerProps {
  mismatch: PartyFileMismatch | null;
  localMatches?: LocalMatchCandidate[];
  searchingLocalMatches?: boolean;
  showWindowBar: boolean;
  inline?: boolean;
  onChooseFile: () => void;
  onChooseFolder?: () => void;
  onSwitchEpisode?: (index: number) => void;
  onOpenLocalMatch?: (candidate: LocalMatchCandidate) => void;
  onMatchFps?: (scale: number, label: string | null) => void;
  onAlignScene?: () => void;
  onDismiss: () => void;
}

export function FileMismatchBanner({
  mismatch,
  localMatches = [],
  searchingLocalMatches = false,
  showWindowBar,
  inline = false,
  onChooseFile,
  onChooseFolder,
  onSwitchEpisode,
  onOpenLocalMatch,
  onMatchFps,
  onAlignScene,
  onDismiss,
}: FileMismatchBannerProps) {
  const notificationCount = useNotificationStore((s) => s.items.length);
  const presence = usePresencePayload(mismatch, 180);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);

  const mismatchSig = mismatch?.signature ?? null;
  useEffect(() => {
    setSelectedIdx(0);
    setPickerOpen(false);
    setDetailsOpen(false);
  }, [mismatchSig, localMatches.length]);

  if (!presence.mounted || !presence.value) {
    return null;
  }

  const item = presence.value;
  const activeLocalMatch =
    !item.matchedPlaylistItem && localMatches.length > 0
      ? localMatches[Math.min(selectedIdx, localMatches.length - 1)]
      : null;
  const topClass =
    notificationCount >= 2
      ? "top-28"
      : notificationCount === 1
        ? "top-16"
        : showWindowBar
          ? "top-14"
          : "top-5";

  const showFpsButton =
    item.kind === "fpsMismatch" &&
    typeof item.suggestedFpsScale === "number" &&
    Boolean(onMatchFps);
  const showAlignButton =
    item.kind === "durationMismatch" &&
    item.sourceRelation === "differentCut" &&
    Boolean(onAlignScene);

  const hasPrimaryFix = Boolean(
    item.matchedPlaylistItem || activeLocalMatch || showFpsButton || showAlignButton,
  );
  const showInlineSeasonFolder =
    !hasPrimaryFix && item.kind === "notOpenOnPc" && Boolean(onChooseFolder);
  const hasSecondaryDetails = Boolean(
    (item.localChip && item.peerChip) || activeLocalMatch || hasPrimaryFix,
  );

  return (
    <div
      role="alert"
      aria-live="polite"
      className={
        inline
          ? "w-full max-w-[500px] pointer-events-none select-none"
          : `fixed left-1/2 -translate-x-1/2 z-30 max-w-[500px] w-[calc(100vw-2rem)] transition-[top] duration-300 ${topClass} pointer-events-none select-none`
      }
    >
      <div
        data-glass-region="true"
        className={`ep-glass-warning rounded-[20px] px-3.5 py-2.5 flex items-start gap-3 ${
          presence.exiting
            ? "pointer-events-none anim-fade-slide-down"
            : "pointer-events-auto anim-fade-slide-up"
        }`}
      >
        <div className="ep-warning-badge h-7 w-7 rounded-full flex items-center justify-center text-warn shrink-0 mt-0.5">
          <AppAlertIcon variant="warn" size={15} />
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-[12.5px] font-semibold tracking-tight text-white">
                  {item.title}
                </span>
                {item.deltaBadge && (
                  <span className="num text-[10.5px] font-semibold px-1.5 py-0.5 rounded-full bg-warn/15 text-warn border border-warn/25">
                    {item.deltaBadge}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-secondary leading-snug mt-0.5 truncate">{item.message}</p>
            </div>

            <button
              type="button"
              onClick={onDismiss}
              aria-label="Dismiss mismatch warning"
              title="Dismiss warning"
              className="ep-bar-icon-btn h-6 w-6 -mr-1 -mt-0.5 rounded-full flex items-center justify-center text-muted hover:text-white shrink-0 cursor-pointer"
            >
              <AppCloseIcon size={13} />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {item.matchedPlaylistItem && onSwitchEpisode && (
              <button
                type="button"
                onClick={() => onSwitchEpisode(item.matchedPlaylistItem!.index)}
                className="ep-warning-action ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-semibold text-white cursor-pointer"
              >
                <PlayerPlayIcon size={11} />
                <span>Open {item.matchedPlaylistItem.label}</span>
              </button>
            )}

            {activeLocalMatch && onOpenLocalMatch && (
              <>
                <button
                  type="button"
                  title={`${activeLocalMatch.path}\n${activeLocalMatch.reason}`}
                  onClick={() => onOpenLocalMatch(activeLocalMatch)}
                  className="ep-warning-action ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-semibold text-white cursor-pointer max-w-[260px]"
                >
                  <PlayerPlayIcon size={11} className="shrink-0" />
                  <span className="truncate">
                    {activeLocalMatch.isCloudPlaceholder
                      ? `Download & Sync: ${activeLocalMatch.fileName}`
                      : `Open & Sync: ${activeLocalMatch.fileName}`}
                  </span>
                </button>
                {localMatches.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setPickerOpen((v) => !v)}
                    aria-expanded={pickerOpen}
                    className="ep-bar-pill ep-press h-6.5 px-2 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium text-secondary hover:text-white cursor-pointer"
                  >
                    <span>{localMatches.length} matches</span>
                    <AppChevronIcon
                      direction="right"
                      size={10}
                      className={`transition-transform duration-150 ${pickerOpen ? "rotate-90" : ""}`}
                    />
                  </button>
                )}
              </>
            )}

            {!activeLocalMatch && searchingLocalMatches && !item.matchedPlaylistItem && (
              <span className="text-[10.5px] text-muted px-1">Searching your PC…</span>
            )}

            {showFpsButton && (
              <button
                type="button"
                onClick={() =>
                  onMatchFps?.(item.suggestedFpsScale!, item.suggestedFpsLabel)
                }
                className="ep-warning-action ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-semibold text-white cursor-pointer"
              >
                <PartyFpsMatchIcon size={12} />
                <span>
                  {item.suggestedFpsLabel ? `Match ${item.suggestedFpsLabel}` : "Match FPS"}
                </span>
              </button>
            )}

            {showAlignButton && (
              <button
                type="button"
                onClick={onAlignScene}
                className="ep-warning-action ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-semibold text-white cursor-pointer"
              >
                <PartyAlignSceneIcon size={12} />
                <span>Align Scene…</span>
              </button>
            )}

            {!hasPrimaryFix && (
              <>
                <button
                  type="button"
                  onClick={onChooseFile}
                  className="ep-warning-action ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-semibold text-white cursor-pointer"
                >
                  <AppFolderIcon size={12} />
                  <span>{item.kind === "notOpenOnPc" ? "Open Video…" : "Choose Different Video…"}</span>
                </button>
                {showInlineSeasonFolder && (
                  <button
                    type="button"
                    onClick={onChooseFolder}
                    className="ep-bar-pill ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
                  >
                    <AppSeasonFolderIcon size={12} />
                    <span>Season Folder…</span>
                  </button>
                )}
              </>
            )}

            {hasSecondaryDetails && (
              <button
                type="button"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen((v) => !v)}
                className="ep-bar-pill ep-press h-6.5 px-2 rounded-full inline-flex items-center gap-1 text-[10.5px] font-medium text-secondary hover:text-white cursor-pointer"
              >
                <span>{detailsOpen ? "Less" : "Details"}</span>
                <AppChevronIcon
                  direction="right"
                  size={10}
                  className={`transition-transform duration-150 ${detailsOpen ? "rotate-90" : ""}`}
                />
              </button>
            )}
          </div>

          <AnimatedCollapse open={detailsOpen} innerClassName="pt-1 space-y-1.5">
            {item.localChip && item.peerChip && (
              <div className="flex items-center gap-1.5 text-[10.5px] min-w-0">
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-white/[0.06] border border-white/[0.08] text-secondary min-w-0 max-w-[46%]">
                  <span className="text-muted shrink-0">Your PC:</span>
                  <span
                    className="truncate text-primary/90 font-medium"
                    title={item.localChipTitle ?? undefined}
                  >
                    {item.localChip}
                  </span>
                </span>
                <span className="inline-flex items-center text-muted/75 shrink-0" aria-hidden="true">
                  <PartyMismatchIcon size={13} />
                </span>
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-warn/10 border border-warn/25 text-warn min-w-0 max-w-[48%]">
                  <span className="opacity-80 shrink-0">{item.peerChipOwner}:</span>
                  <span className="truncate font-medium" title={item.peerChipTitle ?? undefined}>
                    {item.peerChip}
                  </span>
                </span>
              </div>
            )}

            {activeLocalMatch && (
              <div className="text-[10.5px] text-secondary/90 truncate">
                Found in <span className="text-primary">{activeLocalMatch.folderLabel}</span> ·{" "}
                {activeLocalMatch.reason}
              </div>
            )}

            {hasPrimaryFix && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={onChooseFile}
                  className="ep-bar-pill ep-press h-6.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
                >
                  <AppFolderIcon size={12} />
                  <span>
                    {item.kind === "notOpenOnPc" ? "Open Video…" : "Choose Different Video…"}
                  </span>
                </button>
              </div>
            )}
          </AnimatedCollapse>

          <AnimatedCollapse
            open={pickerOpen && localMatches.length > 1}
            innerClassName="pt-1 space-y-1"
          >
            {localMatches.map((cand, idx) => (
              <button
                key={cand.path}
                type="button"
                onClick={() => {
                  setSelectedIdx(idx);
                  setPickerOpen(false);
                  onOpenLocalMatch?.(cand);
                }}
                className={`ep-menu-row ep-press w-full text-left rounded-xl px-2.5 py-1.5 text-[11px] flex items-center justify-between gap-2 cursor-pointer ${
                  idx === selectedIdx
                    ? "bg-white/[0.12] text-white"
                    : "bg-white/[0.04] text-secondary hover:bg-white/[0.09] hover:text-white"
                }`}
              >
                <span className="truncate font-medium">{cand.fileName}</span>
                <span className="text-[10px] text-muted shrink-0">
                  {cand.folderLabel} · {cand.reason}
                </span>
              </button>
            ))}
          </AnimatedCollapse>
        </div>
      </div>
    </div>
  );
}
