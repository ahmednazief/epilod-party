import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  DEFAULT_REACTION_EMOJIS,
  EMOJI_CATEGORY_TABS,
  filterEmojiCatalog,
  REACTION_PRESET_COUNT,
  resolvePresetReactions,
  triggerPartyReaction,
  type EmojiCategory,
} from "../lib/reactions";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { useAppStore } from "../store/useAppStore";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import {
  AppCheckIcon,
  AppChevronIcon,
  AppCloseIcon,
  AppEditIcon,
  AppResetIcon,
  AppSearchIcon,
} from "./ui/AppIcons";
import { PlayerReactionPickerIcon } from "./ui/PlayerIcons";
import { SegmentedTabs } from "./ui/SegmentedTabs";

interface HoldTimerState {
  delayTimer: number | null;
  repeatTimer: number | null;
}

function isDirectEmojiInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 24 || /\s/.test(trimmed)) {
    return false;
  }
  return /[\p{Extended_Pictographic}\u20E3]/u.test(trimmed);
}

interface EmojiHoldButtonProps {
  emoji: string;
  label: string;
  title: string;
  recordRecent: boolean;
  className: string;
  onStartHold: (emoji: string, recordRecent: boolean) => void;
  onStopHold: () => void;
  onKeyboardFire: (emoji: string, recordRecent: boolean) => void;
  onHoverEnter?: () => void;
  dataPulsing?: boolean;
  children?: ReactNode;
}

function EmojiHoldButton({
  emoji,
  label,
  title,
  recordRecent,
  className,
  onStartHold,
  onStopHold,
  onKeyboardFire,
  onHoverEnter,
  dataPulsing,
  children,
}: EmojiHoldButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title}
      data-pulsing={dataPulsing ? "true" : undefined}
      onMouseEnter={onHoverEnter}
      onFocus={onHoverEnter}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        onStartHold(emoji, recordRecent);
      }}
      onPointerUp={onStopHold}
      onPointerLeave={onStopHold}
      onPointerCancel={onStopHold}
      onClick={(e) => {
        // Mouse pointer taps already fire on pointerdown (and repeat while held);
        // detail === 0 handles keyboard Enter/Space activation cleanly.
        if (e.detail !== 0) return;
        onKeyboardFire(emoji, recordRecent);
      }}
      className={className}
    >
      {children}
    </button>
  );
}

export const ReactionPopover = memo(function ReactionPopover() {
  const recentEmojis = useAppStore((s) => s.recentEmojis);
  const reactionPresets = useAppStore((s) => s.reactionPresets);
  const setReactionPresetAt = useAppStore((s) => s.setReactionPresetAt);
  const reorderReactionPresets = useAppStore((s) => s.reorderReactionPresets);
  const resetReactionPresets = useAppStore((s) => s.resetReactionPresets);

  const presetReactions = useMemo(
    () => resolvePresetReactions(reactionPresets),
    [reactionPresets],
  );
  const isDefaultPresets = useMemo(
    () =>
      reactionPresets.length === DEFAULT_REACTION_EMOJIS.length &&
      reactionPresets.every((emoji, i) => emoji === DEFAULT_REACTION_EMOJIS[i]),
    [reactionPresets],
  );

  const [pickerOpen, setPickerOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState(0);
  const [draggingSlot, setDraggingSlot] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | EmojiCategory>("all");
  const [pulsingEmoji, setPulsingEmoji] = useState<string | null>(null);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const [displayHintIdx, setDisplayHintIdx] = useState<number | null>(null);
  const [dropletMorphing, setDropletMorphing] = useState(false);

  const sheetPresence = useAnimatedPresence(pickerOpen, 190);
  const holdRef = useRef<HoldTimerState>({ delayTimer: null, repeatTimer: null });
  const pulseTimerRef = useRef<number | null>(null);
  const morphTimerRef = useRef<number | null>(null);
  const prevHoveredIdxRef = useRef<number | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const presetBtnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const slotBtnRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const slotDragRef = useRef<{
    activeIdx: number;
    startX: number;
    moved: boolean;
  } | null>(null);
  const [dropletBox, setDropletBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
    hintCenterX: number;
  }>({
    left: 0,
    top: 0,
    width: 40,
    height: 40,
    hintCenterX: 27,
  });
  const [dropletSlideReady, setDropletSlideReady] = useState(false);

  const stopHold = useCallback(() => {
    if (holdRef.current.delayTimer !== null) {
      window.clearTimeout(holdRef.current.delayTimer);
      holdRef.current.delayTimer = null;
    }
    if (holdRef.current.repeatTimer !== null) {
      window.clearInterval(holdRef.current.repeatTimer);
      holdRef.current.repeatTimer = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      stopHold();
      if (pulseTimerRef.current !== null) window.clearTimeout(pulseTimerRef.current);
      if (morphTimerRef.current !== null) window.clearTimeout(morphTimerRef.current);
    };
  }, [stopHold]);

  useEffect(() => {
    if (!pickerOpen) {
      setCustomizing(false);
      setDraggingSlot(null);
      slotDragRef.current = null;
    }
  }, [pickerOpen]);

  useEffect(() => {
    window.dispatchEvent(new Event("ep:glass-layout"));
    const t = window.setTimeout(() => {
      window.dispatchEvent(new Event("ep:glass-layout"));
    }, 65);
    return () => window.clearTimeout(t);
  }, [pickerOpen, sheetPresence.mounted, customizing]);

  const enterHoveredIdx = useCallback((idx: number) => {
    const btn = presetBtnRefs.current[idx];
    const track = trackRef.current;
    if (btn) {
      const trackLeft = track?.offsetLeft ?? 6;
      const dockBorderLeft =
        track?.offsetParent instanceof HTMLElement ? track.offsetParent.clientLeft : 1;
      setDropletBox({
        left: btn.offsetLeft,
        top: btn.offsetTop,
        width: btn.offsetWidth,
        height: btn.offsetHeight,
        hintCenterX: dockBorderLeft + trackLeft + btn.offsetLeft + btn.offsetWidth / 2,
      });
    }
    const hadPrev = prevHoveredIdxRef.current !== null;
    setDropletSlideReady(hadPrev);
    if (hadPrev && prevHoveredIdxRef.current !== idx) {
      setDropletMorphing(true);
      if (morphTimerRef.current !== null) window.clearTimeout(morphTimerRef.current);
      morphTimerRef.current = window.setTimeout(() => setDropletMorphing(false), 180);
    }
    prevHoveredIdxRef.current = idx;
    setHoveredIdx(idx);
    setDisplayHintIdx(idx);
  }, []);

  const clearHoveredIdx = useCallback(() => {
    prevHoveredIdxRef.current = null;
    setDropletSlideReady(false);
    setHoveredIdx(null);
  }, []);

  const fireEmoji = useCallback(
    (emoji: string, recordRecent = false, isRepeat = false) => {
      triggerPartyReaction(emoji, {
        recordRecent,
        soundMode: isRepeat ? "repeat" : "tap",
      });
      setPulsingEmoji(emoji);
      if (pulseTimerRef.current !== null) {
        window.clearTimeout(pulseTimerRef.current);
      }
      pulseTimerRef.current = window.setTimeout(() => setPulsingEmoji(null), 165);
    },
    [],
  );

  const startHold = useCallback(
    (emoji: string, recordRecent = false) => {
      stopHold();
      fireEmoji(emoji, recordRecent, false);
      holdRef.current.delayTimer = window.setTimeout(() => {
        holdRef.current.repeatTimer = window.setInterval(() => {
          fireEmoji(emoji, false, true);
        }, 95);
      }, 220);
    },
    [fireEmoji, stopHold],
  );

  const filteredCatalog = useMemo(
    () => filterEmojiCatalog(query, category),
    [query, category],
  );

  const customPasteEmoji = useMemo(() => {
    const trimmed = query.trim();
    if (!isDirectEmojiInput(trimmed)) return null;
    const alreadyListed = filteredCatalog.some((item) => item.emoji === trimmed);
    return alreadyListed ? null : trimmed;
  }, [query, filteredCatalog]);

  const hintItem =
    hoveredIdx !== null
      ? presetReactions[hoveredIdx]
      : displayHintIdx !== null
        ? presetReactions[displayHintIdx]
        : null;
  const hintVisible = hoveredIdx !== null;

  const flashPulse = useCallback((emoji: string) => {
    setPulsingEmoji(emoji);
    if (pulseTimerRef.current !== null) {
      window.clearTimeout(pulseTimerRef.current);
    }
    pulseTimerRef.current = window.setTimeout(() => setPulsingEmoji(null), 165);
  }, []);

  const assignEmojiToSelectedSlot = useCallback(
    (emoji: string) => {
      setReactionPresetAt(selectedSlot, emoji);
      flashPulse(emoji);
      setSelectedSlot((prev) => (prev + 1) % REACTION_PRESET_COUNT);
    },
    [flashPulse, selectedSlot, setReactionPresetAt],
  );

  const handleCatalogStartHold = useCallback(
    (emoji: string, recordRecent = false) => {
      if (customizing) {
        stopHold();
        assignEmojiToSelectedSlot(emoji);
        return;
      }
      startHold(emoji, recordRecent);
    },
    [assignEmojiToSelectedSlot, customizing, startHold, stopHold],
  );

  const handleCatalogKeyboardFire = useCallback(
    (emoji: string, recordRecent = false) => {
      if (customizing) {
        assignEmojiToSelectedSlot(emoji);
        return;
      }
      fireEmoji(emoji, recordRecent);
    },
    [assignEmojiToSelectedSlot, customizing, fireEmoji],
  );

  const moveSelectedSlot = useCallback(
    (delta: -1 | 1) => {
      const target = selectedSlot + delta;
      if (target < 0 || target >= REACTION_PRESET_COUNT) return;
      reorderReactionPresets(selectedSlot, target);
      setSelectedSlot(target);
    },
    [reorderReactionPresets, selectedSlot],
  );

  useEffect(() => {
    if (draggingSlot === null) return;
    const onPointerMove = (e: PointerEvent) => {
      const drag = slotDragRef.current;
      if (!drag) return;
      if (!drag.moved && Math.abs(e.clientX - drag.startX) < 6) {
        return;
      }
      drag.moved = true;
      let targetIdx = drag.activeIdx;
      for (let i = 0; i < REACTION_PRESET_COUNT; i++) {
        const el = slotBtnRefs.current[i];
        if (!el) continue;
        const r = el.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx !== drag.activeIdx) {
        reorderReactionPresets(drag.activeIdx, targetIdx);
        drag.activeIdx = targetIdx;
        setDraggingSlot(targetIdx);
        setSelectedSlot(targetIdx);
      }
    };
    const onPointerUp = () => {
      slotDragRef.current = null;
      setDraggingSlot(null);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };
  }, [draggingSlot, reorderReactionPresets]);

  return (
    <div className="flex flex-col items-center gap-2.5 select-none pointer-events-none">
      {/* Upper Expandable Liquid-Glass Emoji Sheet */}
      {sheetPresence.mounted && (
        <div
          data-glass-region="true"
          className={`ep-glass-reaction-sheet pointer-events-auto w-full rounded-[24px] p-3 space-y-2.5 ${
            sheetPresence.exiting
              ? "ep-popover-bloom-out pointer-events-none"
              : "ep-popover-bloom"
          }`}
        >
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1 flex items-center min-w-0">
              <AppSearchIcon
                size={13}
                className="pointer-events-none absolute left-3 text-white/60"
              />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={
                  customizing
                    ? `Pick or paste emoji for slot ${selectedSlot + 1}…`
                    : "Search or paste any emoji (Win + .)"
                }
                aria-label="Search emojis"
                className="ep-glass-input w-full h-8.5 pl-8.5 pr-8 text-xs text-primary placeholder:text-white/45 rounded-full focus:outline-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  aria-label="Clear search"
                  className="ep-bar-icon-btn absolute right-1.5 h-6 w-6 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
                >
                  <AppCloseIcon size={12} />
                </button>
              )}
            </div>

            <button
              type="button"
              onClick={() => setCustomizing((v) => !v)}
              aria-pressed={customizing}
              title={customizing ? "Done editing quick bar" : "Change & reorder the 7 quick emojis"}
              className={`ep-press h-8.5 px-2.5 rounded-full inline-flex items-center gap-1.5 text-[11px] font-medium shrink-0 cursor-pointer transition-colors ${
                customizing
                  ? "ep-glass-primary-pill text-white"
                  : "bg-white/[0.08] hover:bg-white/[0.14] text-secondary hover:text-white"
              }`}
            >
              {customizing ? <AppCheckIcon size={12} /> : <AppEditIcon size={12} />}
              <span>{customizing ? "Done" : "Edit 1–7"}</span>
            </button>
          </div>

          <AnimatedCollapse open={customizing}>
            <div className="ep-glass-tray rounded-2xl p-2 space-y-2">
              <div className="flex items-center justify-between gap-2 px-0.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-white/65">
                  Drag or ← → to reorder · Tap slot to replace
                </span>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    disabled={selectedSlot <= 0}
                    onClick={() => moveSelectedSlot(-1)}
                    aria-label="Move slot left"
                    title="Move left"
                    className="ep-press h-6 w-6 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] disabled:opacity-30 flex items-center justify-center text-white cursor-pointer disabled:cursor-default"
                  >
                    <AppChevronIcon direction="left" size={11} />
                  </button>
                  <button
                    type="button"
                    disabled={selectedSlot >= REACTION_PRESET_COUNT - 1}
                    onClick={() => moveSelectedSlot(1)}
                    aria-label="Move slot right"
                    title="Move right"
                    className="ep-press h-6 w-6 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] disabled:opacity-30 flex items-center justify-center text-white cursor-pointer disabled:cursor-default"
                  >
                    <AppChevronIcon direction="right" size={11} />
                  </button>
                  <button
                    type="button"
                    disabled={isDefaultPresets}
                    onClick={resetReactionPresets}
                    aria-label="Reset quick emojis to defaults"
                    title="Reset to default 7 emojis"
                    className="ep-press h-6 px-2 rounded-lg bg-white/[0.08] hover:bg-white/[0.15] disabled:opacity-30 inline-flex items-center gap-1 text-[10px] font-medium text-secondary hover:text-white cursor-pointer disabled:cursor-default"
                  >
                    <AppResetIcon size={10} />
                    <span>Reset</span>
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-1 touch-none">
                {presetReactions.map((item, idx) => {
                  const isSelected = selectedSlot === idx;
                  const isDragging = draggingSlot === idx;
                  return (
                    <button
                      key={`slot-${idx}`}
                      ref={(el) => {
                        slotBtnRefs.current[idx] = el;
                      }}
                      type="button"
                      aria-label={`Slot ${idx + 1}: ${item.label}`}
                      aria-pressed={isSelected}
                      title={`Slot ${idx + 1} (${item.label}) — Click to replace or drag to reorder`}
                      onPointerDown={(e) => {
                        if (e.button !== 0) return;
                        e.preventDefault();
                        setSelectedSlot(idx);
                        slotDragRef.current = {
                          activeIdx: idx,
                          startX: e.clientX,
                          moved: false,
                        };
                        setDraggingSlot(idx);
                      }}
                      onClick={(e) => {
                        if (e.detail === 0) setSelectedSlot(idx);
                      }}
                      className={`relative h-10 rounded-xl flex flex-col items-center justify-center transition-all cursor-grab active:cursor-grabbing ${
                        isSelected
                          ? "bg-accent/25 ring-1.5 ring-accent-soft text-white"
                          : "bg-white/[0.06] hover:bg-white/[0.12] text-white/90"
                      } ${isDragging ? "scale-105 opacity-90" : ""}`}
                    >
                      <span className="ep-reaction-emoji-glyph text-[18px] leading-none">
                        {item.emoji}
                      </span>
                      <span className="text-[9px] font-semibold text-white/55 leading-none mt-0.5 num">
                        {idx + 1}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </AnimatedCollapse>

          {customPasteEmoji && (
            <button
              type="button"
              onClick={() =>
                customizing
                  ? assignEmojiToSelectedSlot(customPasteEmoji)
                  : fireEmoji(customPasteEmoji, true)
              }
              className="ep-glass-primary-pill ep-press w-full h-8.5 px-3.5 rounded-full flex items-center justify-between text-xs font-medium text-white cursor-pointer"
            >
              <span>
                {customizing
                  ? `Set slot ${selectedSlot + 1} to custom emoji`
                  : "Send custom emoji"}
              </span>
              <span className="text-lg leading-none">{customPasteEmoji}</span>
            </button>
          )}

          {!query.trim() && recentEmojis.length > 0 && (
            <div className="ep-glass-tray rounded-2xl p-1.5 space-y-1">
              <div className="px-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/55">
                Recent
              </div>
              <div className="flex flex-wrap gap-0.5">
                {recentEmojis.map((emoji) => (
                  <EmojiHoldButton
                    key={`recent-${emoji}`}
                    emoji={emoji}
                    label={`Recent emoji ${emoji}`}
                    title={
                      customizing
                        ? `${emoji} — Assign to slot ${selectedSlot + 1}`
                        : `${emoji} — Click or hold`
                    }
                    recordRecent
                    dataPulsing={pulsingEmoji === emoji}
                    onStartHold={handleCatalogStartHold}
                    onStopHold={stopHold}
                    onKeyboardFire={handleCatalogKeyboardFire}
                    className="ep-reaction-tile h-8 w-8 rounded-xl flex items-center justify-center text-[18px] leading-none cursor-pointer"
                  >
                    <span className="ep-reaction-emoji-glyph">{emoji}</span>
                  </EmojiHoldButton>
                ))}
              </div>
            </div>
          )}

          <SegmentedTabs
            ariaLabel="Emoji category"
            size="sm"
            fullWidth
            value={category}
            items={EMOJI_CATEGORY_TABS}
            onChange={setCategory}
          />

          <div
            className={`ep-menu-scroll ${
              customizing ? "max-h-36" : "max-h-44"
            } overflow-y-auto overflow-x-hidden pr-1`}
          >
            {filteredCatalog.length > 0 ? (
              <div className="grid grid-cols-7 gap-1 touch-none">
                {filteredCatalog.map((item) => (
                  <EmojiHoldButton
                    key={`${item.category}-${item.emoji}-${item.name}`}
                    emoji={item.emoji}
                    label={item.name}
                    title={
                      customizing
                        ? `${item.name} — Assign to slot ${selectedSlot + 1}`
                        : `${item.name} — Click or hold`
                    }
                    recordRecent
                    dataPulsing={pulsingEmoji === item.emoji}
                    onStartHold={handleCatalogStartHold}
                    onStopHold={stopHold}
                    onKeyboardFire={handleCatalogKeyboardFire}
                    className="ep-reaction-tile h-9 w-full rounded-xl flex items-center justify-center text-[20px] leading-none cursor-pointer"
                  >
                    <span className="ep-reaction-emoji-glyph">{item.emoji}</span>
                  </EmojiHoldButton>
                ))}
              </div>
            ) : (
              <div className="py-5 text-center text-xs text-white/55">
                No matching emojis — paste any emoji directly above (Win + .)
              </div>
            )}
          </div>
        </div>
      )}

      {/* Lower iOS Liquid-Glass Tapback Capsule & Floating Shortcut Hint */}
      <div className="relative pointer-events-auto w-fit">
        {hintItem && (
          <div
            aria-hidden="true"
            style={{
              transform: `translate3d(${dropletBox.hintCenterX}px, 0, 0)`,
            }}
            className={`pointer-events-none absolute left-0 bottom-full mb-2.5 z-20 ${
              dropletSlideReady
                ? "transition-[transform,opacity] duration-200 ease-[var(--spring-fluid)]"
                : "transition-opacity duration-150 ease-out"
            } ${hintVisible ? "opacity-100" : "opacity-0"}`}
          >
            <div className="-translate-x-1/2">
              <div
                className={`ep-glass-reaction-hint h-7 px-2.5 rounded-full flex items-center gap-1.5 whitespace-nowrap transition-transform duration-150 ease-[var(--spring-fluid)] ${
                  hintVisible ? "scale-100 translate-y-0" : "scale-95 translate-y-1"
                }`}
              >
                <span className="text-[11px] font-medium tracking-tight text-white/95">
                  {hintItem.label}
                </span>
                <span className="text-[10px] text-white/30">·</span>
                <span className="text-[10px] font-medium text-white/55">Press</span>
                <kbd
                  data-pressing={pulsingEmoji === hintItem.emoji ? "true" : "false"}
                  className="ep-reaction-kbd"
                >
                  {hintItem.shortcut}
                </kbd>
              </div>
            </div>
          </div>
        )}

        <div
          data-glass-region="true"
          className="ep-glass-reaction-dock w-fit rounded-full p-1.5 flex items-center"
        >
          <div
            ref={trackRef}
            onMouseLeave={clearHoveredIdx}
            className="relative z-[1] flex items-center gap-0.5"
          >
            {/* Sliding liquid-glass droplet lens */}
            <span
              aria-hidden="true"
              style={{
                width: dropletBox.width,
                height: dropletBox.height,
                transform: `translate3d(${dropletBox.left}px, ${dropletBox.top}px, 0)`,
              }}
              className={`pointer-events-none absolute top-0 left-0 ${
                dropletSlideReady
                  ? "transition-[transform,width,height,opacity] duration-200 ease-[var(--spring-fluid)]"
                  : "transition-opacity duration-150"
              } ${hoveredIdx !== null ? "opacity-100" : "opacity-0"}`}
            >
              <span
                data-morphing={dropletMorphing ? "true" : "false"}
                data-pressing={
                  hoveredIdx !== null && pulsingEmoji === presetReactions[hoveredIdx]?.emoji
                    ? "true"
                    : "false"
                }
                className="ep-reaction-droplet ep-droplet-core block w-full h-full rounded-full"
              />
            </span>

            {presetReactions.map((item, idx) => {
              const isHovered = hoveredIdx === idx;
              const isPulsing = pulsingEmoji === item.emoji;
              const isSelectedForEdit = customizing && selectedSlot === idx;
              return (
                <button
                  key={`dock-${idx}`}
                  ref={(el) => {
                    presetBtnRefs.current[idx] = el;
                  }}
                  type="button"
                  aria-label={`React ${item.label} (${item.shortcut})`}
                  title={
                    customizing
                      ? `Slot ${idx + 1} (${item.label}) — Click to select for editing`
                      : `${item.label} (${item.shortcut}) — Click or hold to stream`
                  }
                  onMouseEnter={() => enterHoveredIdx(idx)}
                  onFocus={() => enterHoveredIdx(idx)}
                  onBlur={() => {
                    if (hoveredIdx === idx) clearHoveredIdx();
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    enterHoveredIdx(idx);
                    if (customizing) {
                      setSelectedSlot(idx);
                    } else {
                      startHold(item.emoji, false);
                    }
                  }}
                  onPointerUp={stopHold}
                  onPointerLeave={stopHold}
                  onPointerCancel={stopHold}
                  onClick={(e) => {
                    if (e.detail !== 0) return;
                    if (customizing) {
                      setSelectedSlot(idx);
                    } else {
                      fireEmoji(item.emoji, false);
                    }
                  }}
                  className={`relative z-[1] h-10 w-10 rounded-full flex items-center justify-center cursor-pointer focus:outline-none ${
                    isSelectedForEdit ? "ring-1.5 ring-accent-soft bg-accent/15" : ""
                  }`}
                >
                  <span
                    className={`ep-reaction-emoji-glyph text-[21px] transition-transform duration-150 ease-[var(--spring-fluid)] ${
                      isPulsing
                        ? "scale-[1.28]"
                        : isHovered
                          ? "scale-[1.18]"
                          : "scale-100"
                    }`}
                  >
                    {item.emoji}
                  </span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            data-open={pickerOpen ? "true" : "false"}
            onClick={() => setPickerOpen((v) => !v)}
            aria-expanded={pickerOpen}
            aria-label={pickerOpen ? "Close full emoji picker" : "Browse all emojis"}
            title={pickerOpen ? "Close emoji picker" : "Browse all emojis"}
            className="ep-glass-reaction-orb ep-press relative z-[1] ml-1.5 h-10 w-10 rounded-full flex items-center justify-center text-white/90 hover:text-white cursor-pointer shrink-0"
          >
            <PlayerReactionPickerIcon
              size={15}
              className={`transition-transform duration-200 ${
                pickerOpen ? "rotate-45" : "rotate-0"
              }`}
            />
          </button>
        </div>
      </div>
    </div>
  );
});
