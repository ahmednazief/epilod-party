import { useEffect, useRef, useState } from "react";
import {
  AppArrowIcon,
  AppCheckIcon,
  AppExtrasIcon,
  AppEyeIcon,
  AppGlassesIcon,
  AppHairIcon,
  AppOutfitIcon,
  AppResetIcon,
  AppShuffleIcon,
  AppSkinIcon,
  AppSmileIcon,
} from "../AppIcons";
import { SegmentedTabs } from "../SegmentedTabs";
import { CustomAvatarSvgContent } from "./CustomAvatarRenderer";
import {
  ACC_COLORS,
  BG_THEMES,
  BROW_STYLES,
  decodeCustomAvatar,
  encodeCustomAvatar,
  EYE_COLORS,
  EYE_STYLES,
  EYEWEAR_OPTIONS,
  FACIAL_HAIR_STYLES,
  HAIR_COLORS,
  HAIR_STYLES,
  HEADWEAR_OPTIONS,
  HIJAB_COLORS,
  isHijabStyle,
  MOUTH_STYLES,
  OUTFIT_COLORS,
  OUTFIT_STYLES,
  randomizeCustomRecipe,
  SKIN_TONES,
  type AvatarBase,
  type ColorOption,
  type CustomAvatarId,
  type CustomAvatarRecipe,
  type HairCategory,
} from "./customAvatarSchema";

type StudioTab =
  | "skin"
  | "hair"
  | "eyes"
  | "face"
  | "glasses"
  | "outfit"
  | "extras";

const STUDIO_ICON_TABS: ReadonlyArray<{
  id: StudioTab;
  label: string;
  Icon: typeof AppSkinIcon;
}> = [
  { id: "skin", label: "Skin Tone", Icon: AppSkinIcon },
  { id: "hair", label: "Hair & Hijab", Icon: AppHairIcon },
  { id: "eyes", label: "Eyes & Brows", Icon: AppEyeIcon },
  { id: "face", label: "Expression & Beard", Icon: AppSmileIcon },
  { id: "glasses", label: "Glasses & Shades", Icon: AppGlassesIcon },
  { id: "outfit", label: "Outfit", Icon: AppOutfitIcon },
  { id: "extras", label: "Headwear & Backdrop", Icon: AppExtrasIcon },
];

function MiniRecipePreview({
  recipe,
  size = 48,
}: {
  recipe: CustomAvatarRecipe;
  size?: number;
}) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full overflow-hidden shrink-0"
      style={{ width: size, height: size }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 64 64"
        className="w-full h-full block"
        aria-hidden="true"
      >
        <CustomAvatarSvgContent recipeOverride={recipe} />
      </svg>
    </span>
  );
}

function ColorSwatchStrip({
  label,
  colors,
  selectedIdx,
  onSelect,
}: {
  label: string;
  colors: readonly ColorOption[];
  selectedIdx: number;
  onSelect: (idx: number) => void;
}) {
  const colsClass = colors.length === 12 ? "grid-cols-6" : "grid-cols-8";
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <span className="text-[11px] font-medium text-secondary">{label}</span>
        <span className="text-[10.5px] font-medium text-muted">
          {colors[selectedIdx]?.label ?? ""}
        </span>
      </div>
      <div className="flex justify-center py-0.5">
        <div className={`inline-grid ${colsClass} gap-2.5`}>
          {colors.map((c, idx) => {
            const active = idx === selectedIdx;
            const isLight =
              c.id === "cream" ||
              c.id === "pearl-cream" ||
              c.id === "ivory" ||
              c.id === "pearl" ||
              c.id === "silver" ||
              c.id === "platinum" ||
              c.id === "soft-blush";
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(idx)}
                aria-label={c.label}
                aria-pressed={active}
                title={c.label}
                style={{ backgroundColor: c.hex }}
                className={`ep-press relative w-6 h-6 rounded-full flex items-center justify-center cursor-pointer transition-[transform,box-shadow] duration-200 ease-[cubic-bezier(0.22,1.3,0.36,1)] ${
                  active
                    ? "ring-2 ring-white ring-offset-2 ring-offset-[#12111c] scale-110 shadow-[0_4px_12px_rgba(0,0,0,0.45)]"
                    : "ring-1 ring-white/20 hover:scale-110"
                }`}
              >
                {active && (
                  <AppCheckIcon
                    size={11}
                    className={`anim-pop-in ${
                      isLight
                        ? "text-slate-900"
                        : "text-white drop-shadow-[0_1px_2px_rgba(0,0,0,0.65)]"
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface AvatarCustomizerStudioProps {
  initialId: CustomAvatarId;
  onChange: (nextId: CustomAvatarId) => void;
  onBack: () => void;
  compact?: boolean;
}

export function AvatarCustomizerStudio({
  initialId,
  onChange,
  onBack,
  compact = false,
}: AvatarCustomizerStudioProps) {
  const initialRecipeRef = useRef<CustomAvatarRecipe>(decodeCustomAvatar(initialId));
  const [recipe, setRecipe] = useState<CustomAvatarRecipe>(() =>
    decodeCustomAvatar(initialId),
  );
  const [activeTab, setActiveTab] = useState<StudioTab>("hair");
  const [hairFilter, setHairFilter] = useState<HairCategory>(() => {
    const start = HAIR_STYLES[decodeCustomAvatar(initialId).hairStyle];
    return start?.category ?? "long";
  });
  const [eyesSubTab, setEyesSubTab] = useState<"shape" | "brows">("shape");
  const [faceSubTab, setFaceSubTab] = useState<"mood" | "beard">("mood");
  const [eyewearFilter, setEyewearFilter] = useState<"optical" | "sun">("optical");
  const [extrasSubTab, setExtrasSubTab] = useState<"headwear" | "backdrop">("headwear");
  const [popSeq, setPopSeq] = useState(0);
  const [shuffleSpin, setShuffleSpin] = useState(false);

  const draftGirlHairRef = useRef<number>(
    recipe.base === 0 ? recipe.hairStyle : 8,
  );
  const draftBoyHairRef = useRef<number>(
    recipe.base === 1 ? recipe.hairStyle : 1,
  );
  const draftHairColorRef = useRef<number>(
    isHijabStyle(recipe.hairStyle) ? 0 : recipe.hairOrHijabColor,
  );
  const draftHijabColorRef = useRef<number>(
    isHijabStyle(recipe.hairStyle) ? recipe.hairOrHijabColor : 0,
  );
  const draftFacialHairRef = useRef<number>(recipe.facialHair);

  const spinTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (spinTimerRef.current !== null) window.clearTimeout(spinTimerRef.current);
    };
  }, []);

  const triggerStagePop = () => {
    setPopSeq((n) => n + 1);
  };

  const commitRecipe = (next: CustomAvatarRecipe) => {
    setRecipe(next);
    triggerStagePop();
    onChange(encodeCustomAvatar(next));
  };

  const updateField = <K extends keyof CustomAvatarRecipe>(
    key: K,
    val: CustomAvatarRecipe[K],
  ) => {
    const next = { ...recipe, [key]: val };
    if (key === "hairOrHijabColor") {
      if (isHijabStyle(recipe.hairStyle)) {
        draftHijabColorRef.current = val;
      } else {
        draftHairColorRef.current = val;
      }
    }
    if (key === "facialHair") {
      draftFacialHairRef.current = val;
    }
    commitRecipe(next);
  };

  const handleBaseSwitch = (nextBase: AvatarBase) => {
    const nextBaseNum = nextBase === "boy" ? 1 : 0;
    if (nextBaseNum === recipe.base) return;

    const currentHijab = isHijabStyle(recipe.hairStyle);
    if (recipe.base === 0) {
      draftGirlHairRef.current = recipe.hairStyle;
    } else {
      draftBoyHairRef.current = recipe.hairStyle;
    }

    const targetHair =
      nextBase === "boy" ? draftBoyHairRef.current : draftGirlHairRef.current;
    const targetHijab = isHijabStyle(targetHair);
    const targetColor = targetHijab
      ? draftHijabColorRef.current
      : currentHijab
        ? draftHairColorRef.current
        : recipe.hairOrHijabColor;

    const nextFacialHair =
      nextBase === "boy" && !targetHijab ? draftFacialHairRef.current : 0;

    const targetCategory = HAIR_STYLES[targetHair]?.category ?? (nextBase === "boy" ? "short" : "long");
    setHairFilter(targetCategory);
    if (nextBase === "girl") setFaceSubTab("mood");

    commitRecipe({
      ...recipe,
      base: nextBaseNum,
      hairStyle: targetHair,
      hairOrHijabColor: targetColor,
      facialHair: nextFacialHair,
    });
  };

  const handleSelectHair = (hairIdx: number) => {
    const wasHijab = isHijabStyle(recipe.hairStyle);
    const nowHijab = isHijabStyle(hairIdx);

    if (wasHijab !== nowHijab) {
      if (wasHijab) {
        draftHijabColorRef.current = recipe.hairOrHijabColor;
      } else {
        draftHairColorRef.current = recipe.hairOrHijabColor;
      }
    }

    if (recipe.base === 0) {
      draftGirlHairRef.current = hairIdx;
    } else {
      draftBoyHairRef.current = hairIdx;
    }

    const nextColor = nowHijab
      ? draftHijabColorRef.current
      : draftHairColorRef.current;

    commitRecipe({
      ...recipe,
      hairStyle: hairIdx,
      hairOrHijabColor: nextColor,
      facialHair: nowHijab ? 0 : recipe.facialHair,
    });
  };

  const handleRandomize = () => {
    setShuffleSpin(true);
    if (spinTimerRef.current !== null) window.clearTimeout(spinTimerRef.current);
    spinTimerRef.current = window.setTimeout(() => setShuffleSpin(false), 260);

    const next = randomizeCustomRecipe(recipe.base === 1 ? "boy" : "girl");
    if (isHijabStyle(next.hairStyle)) {
      draftHijabColorRef.current = next.hairOrHijabColor;
    } else {
      draftHairColorRef.current = next.hairOrHijabColor;
    }
    draftFacialHairRef.current = next.facialHair;
    const cat = HAIR_STYLES[next.hairStyle]?.category;
    if (cat) setHairFilter(cat);
    commitRecipe(next);
  };

  const handleReset = () => {
    const base = initialRecipeRef.current;
    const cat = HAIR_STYLES[base.hairStyle]?.category;
    if (cat) setHairFilter(cat);
    commitRecipe(base);
  };

  const isHijab = isHijabStyle(recipe.hairStyle);
  const activeBg = BG_THEMES[recipe.bgTheme] ?? BG_THEMES[0];
  const activeTabIdx = Math.max(
    0,
    STUDIO_ICON_TABS.findIndex((t) => t.id === activeTab),
  );
  const tileAvatarSize = compact ? 48 : 52;
  const heroSize = compact ? 96 : 104;
  const gridGapClass = compact ? "gap-1.5" : "gap-2";

  const renderTileButton = (
    key: string,
    label: string,
    active: boolean,
    candidate: CustomAvatarRecipe,
    onClick: () => void,
    disabled = false,
    disabledTip?: string,
  ) => (
    <button
      key={key}
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-label={label}
      aria-pressed={active}
      title={disabled && disabledTip ? disabledTip : label}
      className={`ep-press rounded-2xl py-1.5 px-1 flex items-center justify-center transition-all duration-150 ${
        disabled
          ? "opacity-30 cursor-not-allowed bg-white/[0.02]"
          : active
            ? "bg-accent/25 ring-2 ring-accent-soft text-white shadow-[0_6px_18px_rgba(124,58,237,0.3)] cursor-pointer"
            : "bg-white/[0.045] hover:bg-white/[0.09] text-secondary hover:text-white cursor-pointer"
      }`}
    >
      <MiniRecipePreview recipe={candidate} size={tileAvatarSize} />
    </button>
  );

  return (
    <div className="anim-tab-in flex-1 min-h-0 flex flex-col gap-2.5">
      {/* Top Action Bar + Prominent Hero Character Stage */}
      <div className="shrink-0 space-y-2.5">
        <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
          <div className="justify-self-start">
            <button
              type="button"
              onClick={onBack}
              title="Back to Presets"
              aria-label="Back to Presets"
              className="ep-glass-pill ep-press h-8 px-2.5 rounded-full inline-flex items-center gap-1 text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
            >
              <AppArrowIcon direction="left" size={12} />
              <span>Presets</span>
            </button>
          </div>

          <div className="w-[116px] justify-self-center">
            <SegmentedTabs
              ariaLabel="Character base style"
              size="sm"
              fullWidth
              value={recipe.base === 1 ? "boy" : "girl"}
              items={[
                { value: "girl", label: "Girl" },
                { value: "boy", label: "Boy" },
              ]}
              onChange={handleBaseSwitch}
            />
          </div>

          <div className="flex items-center gap-1 justify-self-end">
            <button
              type="button"
              onClick={handleRandomize}
              title="Randomize look"
              aria-label="Randomize look"
              className="ep-glass-pill ep-press h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer"
            >
              <AppShuffleIcon
                size={12}
                className={`transition-transform duration-250 ${
                  shuffleSpin ? "rotate-180" : ""
                }`}
              />
            </button>
            <button
              type="button"
              onClick={handleReset}
              title="Reset changes"
              aria-label="Reset changes"
              className="ep-glass-pill ep-press h-8 w-8 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer"
            >
              <AppResetIcon size={12} />
            </button>
            <button
              type="button"
              onClick={onBack}
              className="ep-glass-pill-active ep-press h-7 px-2.5 rounded-full text-[11px] font-semibold text-white cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>

        {/* Centered Hero Stage */}
        <div className="relative flex items-center justify-center py-1">
          <div
            aria-hidden="true"
            style={{ backgroundColor: activeBg.glow }}
            className="pointer-events-none absolute w-28 h-28 rounded-full blur-2xl opacity-25 transition-colors duration-300"
          />
          <div
            key={popSeq}
            style={{ width: heroSize, height: heroSize }}
            className={`relative z-10 inline-flex items-center justify-center rounded-full ring-2 ring-accent/75 shadow-[0_10px_28px_rgba(124,58,237,0.42)] ${
              popSeq > 0 ? "anim-studio-pop" : ""
            }`}
          >
            <MiniRecipePreview recipe={recipe} size={heroSize} />
          </div>
        </div>

        {/* Single-Row Custom Icon Category Rail with Sliding Droplet Indicator */}
        <div
          role="tablist"
          aria-label="Character customization categories"
          className="ep-glass-tray relative grid grid-cols-7 gap-1 p-1 rounded-full"
        >
          <span
            aria-hidden="true"
            className="pointer-events-none absolute top-1 bottom-1 left-1 transition-transform duration-[380ms] ease-[cubic-bezier(0.22,1.28,0.36,1)]"
            style={{
              width: "calc((100% - 8px) / 7)",
              transform: `translateX(${activeTabIdx * 100}%)`,
            }}
          >
            <span className="ep-droplet-indicator ep-droplet-core block h-full w-full rounded-full" />
          </span>
          {STUDIO_ICON_TABS.map(({ id, label, Icon }) => {
            const active = activeTab === id;
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={active}
                aria-label={label}
                title={label}
                onClick={() => setActiveTab(id)}
                className={`ep-press relative z-10 h-7.5 rounded-full flex items-center justify-center cursor-pointer transition-colors duration-200 ${
                  active
                    ? "text-white"
                    : "ep-tray-option text-secondary hover:text-white"
                }`}
              >
                <Icon size={15} />
              </button>
            );
          })}
        </div>
      </div>

      {/* Concise Scrollable Options Area with Smooth Edge Fade */}
      <div
        key={activeTab}
        className="anim-tab-in flex-1 min-h-0 overflow-y-auto overflow-x-hidden pr-1 pt-1.5 pb-2.5 [mask-image:linear-gradient(to_bottom,transparent,black_8px,black_calc(100%-10px),transparent)]"
      >
        {activeTab === "skin" && (
          <div className="space-y-2">
            <div className="flex items-center justify-between px-0.5">
              <span className="text-[11px] font-medium text-secondary">Skin Tone</span>
              <span className="text-[10.5px] font-medium text-muted">
                {SKIN_TONES[recipe.skinTone]?.label ?? ""}
              </span>
            </div>
            <div className={`grid grid-cols-4 ${gridGapClass}`}>
              {SKIN_TONES.map((tone, idx) =>
                renderTileButton(
                  tone.id,
                  tone.label,
                  recipe.skinTone === idx,
                  { ...recipe, skinTone: idx },
                  () => updateField("skinTone", idx),
                ),
              )}
            </div>
          </div>
        )}

        {activeTab === "hair" && (
          <div className="space-y-2.5">
            <SegmentedTabs
              ariaLabel="Hair and Hijab style type"
              size="sm"
              fullWidth
              value={hairFilter}
              items={[
                { value: "short", label: "Short" },
                { value: "long", label: "Long" },
                { value: "hijab", label: "Hijab" },
              ]}
              onChange={setHairFilter}
            />

            <ColorSwatchStrip
              label={hairFilter === "hijab" || isHijab ? "Hijab Color" : "Hair Color"}
              colors={hairFilter === "hijab" || isHijab ? HIJAB_COLORS : HAIR_COLORS}
              selectedIdx={recipe.hairOrHijabColor}
              onSelect={(idx) => updateField("hairOrHijabColor", idx)}
            />

            <div className="space-y-1.5">
              <div className="flex items-center justify-between px-0.5">
                <span className="text-[11px] font-medium text-secondary">
                  {hairFilter === "hijab" ? "Hijab Style" : "Hair Style"}
                </span>
                <span className="text-[10.5px] font-medium text-muted">
                  {HAIR_STYLES[recipe.hairStyle]?.label ?? ""}
                </span>
              </div>
              <div className={`grid grid-cols-4 ${gridGapClass}`}>
                {HAIR_STYLES.map((style, idx) => {
                  if (style.category !== hairFilter) return null;
                  return renderTileButton(
                    style.id,
                    style.label,
                    recipe.hairStyle === idx,
                    {
                      ...recipe,
                      hairStyle: idx,
                      hairOrHijabColor:
                        style.category === "hijab"
                          ? isHijab
                            ? recipe.hairOrHijabColor
                            : draftHijabColorRef.current
                          : isHijab
                            ? draftHairColorRef.current
                            : recipe.hairOrHijabColor,
                    },
                    () => handleSelectHair(idx),
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {activeTab === "eyes" && (
          <div className="space-y-2.5">
            <SegmentedTabs
              ariaLabel="Eyes sub-category"
              size="sm"
              fullWidth
              value={eyesSubTab}
              items={[
                { value: "shape", label: "Eye Shape" },
                { value: "brows", label: "Eyebrows" },
              ]}
              onChange={setEyesSubTab}
            />

            {eyesSubTab === "shape" ? (
              <>
                <ColorSwatchStrip
                  label="Eye Color"
                  colors={EYE_COLORS}
                  selectedIdx={recipe.eyeColor}
                  onSelect={(idx) => updateField("eyeColor", idx)}
                />
                <div className={`grid grid-cols-4 ${gridGapClass}`}>
                  {EYE_STYLES.map((eye, idx) =>
                    renderTileButton(
                      eye.id,
                      eye.label,
                      recipe.eyeStyle === idx,
                      { ...recipe, eyeStyle: idx },
                      () => updateField("eyeStyle", idx),
                    ),
                  )}
                </div>
              </>
            ) : (
              <div className={`grid grid-cols-4 ${gridGapClass}`}>
                {BROW_STYLES.map((brow, idx) =>
                  renderTileButton(
                    brow.id,
                    brow.label,
                    recipe.browStyle === idx,
                    { ...recipe, browStyle: idx },
                    () => updateField("browStyle", idx),
                  ),
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "face" && (
          <div className="space-y-2.5">
            {recipe.base === 1 && !isHijab && (
              <SegmentedTabs
                ariaLabel="Face sub-category"
                size="sm"
                fullWidth
                value={faceSubTab}
                items={[
                  { value: "mood", label: "Expression" },
                  { value: "beard", label: "Facial Hair" },
                ]}
                onChange={setFaceSubTab}
              />
            )}

            {faceSubTab === "beard" && recipe.base === 1 && !isHijab ? (
              <div className={`grid grid-cols-4 ${gridGapClass}`}>
                {FACIAL_HAIR_STYLES.map((fh, idx) =>
                  renderTileButton(
                    fh.id,
                    fh.label,
                    recipe.facialHair === idx,
                    { ...recipe, facialHair: idx },
                    () => updateField("facialHair", idx),
                  ),
                )}
              </div>
            ) : (
              <div className={`grid grid-cols-4 ${gridGapClass}`}>
                {MOUTH_STYLES.map((mouth, idx) =>
                  renderTileButton(
                    mouth.id,
                    mouth.label,
                    recipe.mouthAndBlush === idx,
                    { ...recipe, mouthAndBlush: idx },
                    () => updateField("mouthAndBlush", idx),
                  ),
                )}
              </div>
            )}
          </div>
        )}

        {activeTab === "glasses" && (
          <div className="space-y-2.5">
            <SegmentedTabs
              ariaLabel="Eyewear category"
              size="sm"
              fullWidth
              value={eyewearFilter}
              items={[
                { value: "optical", label: "Optical" },
                { value: "sun", label: "Sunglasses" },
              ]}
              onChange={setEyewearFilter}
            />

            <ColorSwatchStrip
              label="Frame Color"
              colors={ACC_COLORS}
              selectedIdx={recipe.accColor}
              onSelect={(idx) => updateField("accColor", idx)}
            />

            <div className={`grid grid-cols-4 ${gridGapClass}`}>
              {EYEWEAR_OPTIONS.map((ew, idx) => {
                if (
                  ew.kind !== "none" &&
                  ew.kind !== eyewearFilter &&
                  !(eyewearFilter === "sun" && ew.kind === "party")
                ) {
                  return null;
                }
                return renderTileButton(
                  ew.id,
                  ew.label,
                  recipe.eyewear === idx,
                  { ...recipe, eyewear: idx },
                  () => updateField("eyewear", idx),
                );
              })}
            </div>
          </div>
        )}

        {activeTab === "outfit" && (
          <div className="space-y-2.5">
            <ColorSwatchStrip
              label="Outfit Color"
              colors={OUTFIT_COLORS}
              selectedIdx={recipe.outfitColor}
              onSelect={(idx) => updateField("outfitColor", idx)}
            />

            <div className={`grid grid-cols-4 ${gridGapClass}`}>
              {OUTFIT_STYLES.map((outfit, idx) =>
                renderTileButton(
                  outfit.id,
                  outfit.label,
                  recipe.outfitStyle === idx,
                  { ...recipe, outfitStyle: idx },
                  () => updateField("outfitStyle", idx),
                ),
              )}
            </div>
          </div>
        )}

        {activeTab === "extras" && (
          <div className="space-y-2.5">
            <SegmentedTabs
              ariaLabel="Extras sub-category"
              size="sm"
              fullWidth
              value={extrasSubTab}
              items={[
                { value: "headwear", label: "Headwear" },
                { value: "backdrop", label: "Backdrop" },
              ]}
              onChange={setExtrasSubTab}
            />

            {extrasSubTab === "headwear" ? (
              <>
                <ColorSwatchStrip
                  label="Accessory Color"
                  colors={ACC_COLORS}
                  selectedIdx={recipe.accColor}
                  onSelect={(idx) => updateField("accColor", idx)}
                />
                <div className={`grid grid-cols-4 ${gridGapClass}`}>
                  {HEADWEAR_OPTIONS.map((hw, idx) => {
                    const blocked = isHijab && !hw.hijabCompatible;
                    return renderTileButton(
                      hw.id,
                      hw.label,
                      recipe.headwear === idx,
                      { ...recipe, headwear: idx },
                      () => updateField("headwear", idx),
                      blocked,
                      "Not available with Hijab",
                    );
                  })}
                </div>
              </>
            ) : (
              <div className={`grid grid-cols-4 ${gridGapClass}`}>
                {BG_THEMES.map((bg, idx) =>
                  renderTileButton(
                    bg.id,
                    bg.label,
                    recipe.bgTheme === idx,
                    { ...recipe, bgTheme: idx },
                    () => updateField("bgTheme", idx),
                  ),
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
