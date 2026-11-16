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
  EMOJI_CATEGORY_TABS,
  filterEmojiCatalog,
  PRESET_REACTIONS,
  triggerPartyReaction,
  type EmojiCategory,
} from "../lib/reactions";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { useAppStore } from "../store/useAppStore";
import { AppCloseIcon, AppSearchIcon } from "./ui/AppIcons";
import { PlayerReactionPickerIcon } from "./ui/PlayerIcons";
import { SegmentedTabs } from "./ui/SegmentedTabs";

interface HoldTimerState {
  delayTimer: number | null;
  repeatTimer: number | null;
}

function isDirectEmojiInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 24 || /^[\x00-\x7F]+$/.test(trimmed)) {
    return false;
  }
  return !/\s/.test(trimmed);
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
  const [pickerOpen, setPickerOpen] = useState(false);
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
    window.dispatchEvent(new Event("ep:glass-layout"));
    const t = window.setTimeout(() => {
      window.dispatchEvent(new Event("ep:glass-layout"));
    }, 65);
    return () => window.clearTimeout(t);
  }, [pickerOpen, sheetPresence.mounted]);

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
      ? PRESET_REACTIONS[hoveredIdx]
      : displayHintIdx !== null
        ? PRESET_REACTIONS[displayHintIdx]
        : null;
  const hintVisible = hoveredIdx !== null;

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
          <div className="relative flex items-center">
            <AppSearchIcon
              size={13}
              className="pointer-events-none absolute left-3 text-white/60"
            />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search or paste any emoji (Win + .)"
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

          {customPasteEmoji && (
            <button
              type="button"
              onClick={() => fireEmoji(customPasteEmoji, true)}
              className="ep-glass-primary-pill ep-press w-full h-8.5 px-3.5 rounded-full flex items-center justify-between text-xs font-medium text-white cursor-pointer"
            >
              <span>Send custom emoji</span>
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
                    title={`${emoji} — Click or hold`}
                    recordRecent
                    dataPulsing={pulsingEmoji === emoji}
                    onStartHold={startHold}
                    onStopHold={stopHold}
                    onKeyboardFire={fireEmoji}
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

          <div className="ep-menu-scroll max-h-44 overflow-y-auto overflow-x-hidden pr-1">
            {filteredCatalog.length > 0 ? (
              <div className="grid grid-cols-7 gap-1">
                {filteredCatalog.map((item) => (
                  <EmojiHoldButton
                    key={`${item.category}-${item.emoji}-${item.name}`}
                    emoji={item.emoji}
                    label={item.name}
                    title={`${item.name} — Click or hold`}
                    recordRecent
                    dataPulsing={pulsingEmoji === item.emoji}
                    onStartHold={startHold}
                    onStopHold={stopHold}
                    onKeyboardFire={fireEmoji}
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
                  hoveredIdx !== null && pulsingEmoji === PRESET_REACTIONS[hoveredIdx]?.emoji
                    ? "true"
                    : "false"
                }
                className="ep-reaction-droplet ep-droplet-core block w-full h-full rounded-full"
              />
            </span>

            {PRESET_REACTIONS.map((item, idx) => {
              const isHovered = hoveredIdx === idx;
              const isPulsing = pulsingEmoji === item.emoji;
              return (
                <button
                  key={item.emoji}
                  ref={(el) => {
                    presetBtnRefs.current[idx] = el;
                  }}
                  type="button"
                  aria-label={`React ${item.label} (${item.shortcut})`}
                  title={`${item.label} (${item.shortcut}) — Click or hold to stream`}
                  onMouseEnter={() => enterHoveredIdx(idx)}
                  onFocus={() => enterHoveredIdx(idx)}
                  onBlur={() => {
                    if (hoveredIdx === idx) clearHoveredIdx();
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    enterHoveredIdx(idx);
                    startHold(item.emoji, false);
                  }}
                  onPointerUp={stopHold}
                  onPointerLeave={stopHold}
                  onPointerCancel={stopHold}
                  onClick={(e) => {
                    if (e.detail !== 0) return;
                    fireEmoji(item.emoji, false);
                  }}
                  className="relative z-[1] h-10 w-10 rounded-full flex items-center justify-center cursor-pointer focus:outline-none"
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
