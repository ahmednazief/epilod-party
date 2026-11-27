export type CustomAvatarId = `c1-${string}`;

export type AvatarBase = "girl" | "boy";

export interface SkinToneOption {
  id: string;
  label: string;
  base: string;
  shadow: string;
  mouthStroke: string;
}

export type HairCategory = "short" | "long" | "hijab";

export interface HairStyleOption {
  id: string;
  label: string;
  category: HairCategory;
  /** Covers ears naturally (e.g. hijab or full bob), so side ears are hidden */
  hidesEars?: boolean;
}

export interface ColorOption {
  id: string;
  label: string;
  hex: string;
  accent?: string;
}

export interface BgThemeOption {
  id: string;
  label: string;
  base: string;
  glow: string;
}

export interface LabeledOption {
  id: string;
  label: string;
}

export interface EyewearOption {
  id: string;
  label: string;
  kind: "none" | "optical" | "sun" | "party";
}

export interface HeadwearOption {
  id: string;
  label: string;
  hijabCompatible: boolean;
}

export interface CustomAvatarRecipe {
  base: number; // 0: girl, 1: boy
  skinTone: number; // 0..9
  hairStyle: number; // 0..19
  hairOrHijabColor: number; // 0..15
  eyeStyle: number; // 0..9
  eyeColor: number; // 0..11
  browStyle: number; // 0..5
  mouthAndBlush: number; // 0..11
  facialHair: number; // 0..5
  outfitStyle: number; // 0..11
  outfitColor: number; // 0..15
  eyewear: number; // 0..11
  headwear: number; // 0..9
  accColor: number; // 0..11
  bgTheme: number; // 0..15
}

export const CUSTOM_AVATAR_PREFIX = "c1-";
export const CUSTOM_AVATAR_SLOT_COUNT = 15;
export const CUSTOM_AVATARS_STORAGE_KEY = "ep.customAvatars";
export const MAX_SAVED_CUSTOM_AVATARS = 4;

export const SKIN_TONES: readonly SkinToneOption[] = [
  { id: "porcelain", label: "Porcelain", base: "#FFE7DA", shadow: "#F4CBB6", mouthStroke: "#9D4E59" },
  { id: "ivory", label: "Warm Ivory", base: "#FDE2CE", shadow: "#F0C3A4", mouthStroke: "#9F584A" },
  { id: "peach", label: "Soft Peach", base: "#FCDAC2", shadow: "#EAB896", mouthStroke: "#8D5144" },
  { id: "tan", label: "Light Tan", base: "#F7CFAF", shadow: "#E3B28B", mouthStroke: "#854E3E" },
  { id: "honey", label: "Golden Honey", base: "#F3C19D", shadow: "#DDA37B", mouthStroke: "#85453A" },
  { id: "olive", label: "Warm Olive", base: "#E5B48A", shadow: "#CE976B", mouthStroke: "#7A4236" },
  { id: "caramel", label: "Caramel", base: "#D99E78", shadow: "#C0815A", mouthStroke: "#6B3A2E" },
  { id: "bronze", label: "Warm Bronze", base: "#B87A56", shadow: "#9D6140", mouthStroke: "#5C2E23" },
  { id: "espresso", label: "Rich Espresso", base: "#8D563B", shadow: "#724129", mouthStroke: "#462018" },
  { id: "umber", label: "Deep Umber", base: "#673B28", shadow: "#502B1B", mouthStroke: "#361812" },
] as const;

export const HAIR_STYLES: readonly HairStyleOption[] = [
  // 8 Short / Boy (0..7)
  { id: "fade", label: "Clean Fade", category: "short" },
  { id: "spiky", label: "Tousled Spiky", category: "short" },
  { id: "curly", label: "Curly Crown", category: "short" },
  { id: "swept", label: "Side Swept", category: "short" },
  { id: "parted", label: "Soft Parted", category: "short" },
  { id: "buzz", label: "Neat Buzz", category: "short" },
  { id: "wavy-short", label: "Wavy Fringe", category: "short" },
  { id: "undercut", label: "Flow Undercut", category: "short" },
  // 8 Long / Girl (8..15)
  { id: "space-buns", label: "Space Buns", category: "long" },
  { id: "long-wave", label: "Long Waves", category: "long" },
  { id: "bob", label: "Classic Bob", category: "long", hidesEars: true },
  { id: "ponytail", label: "High Ponytail", category: "long" },
  { id: "braids", label: "Twin Braids", category: "long", hidesEars: true },
  { id: "half-up", label: "Half-Up", category: "long" },
  { id: "long-curly", label: "Long Curls", category: "long", hidesEars: true },
  { id: "straight-long", label: "Sleek Long", category: "long" },
  // 4 Hijab (16..19)
  { id: "hijab-classic", label: "Classic Hijab", category: "hijab", hidesEars: true },
  { id: "hijab-modern", label: "Modern Wrap", category: "hijab", hidesEars: true },
  { id: "hijab-sport", label: "Sport Hijab", category: "hijab", hidesEars: true },
  { id: "hijab-pleated", label: "Pleated Hijab", category: "hijab", hidesEars: true },
] as const;

export const HAIR_COLORS: readonly ColorOption[] = [
  { id: "midnight", label: "Midnight Black", hex: "#18121E", accent: "#31263D" },
  { id: "espresso", label: "Dark Espresso", hex: "#2A1815", accent: "#452924" },
  { id: "chestnut", label: "Warm Chestnut", hex: "#68331B", accent: "#8A4626" },
  { id: "caramel", label: "Caramel", hex: "#9A541C", accent: "#BA6B2B" },
  { id: "amber", label: "Golden Amber", hex: "#D97706", accent: "#F59E0B" },
  { id: "honey-blonde", label: "Honey Blonde", hex: "#EAB308", accent: "#FDE047" },
  { id: "platinum", label: "Silver Platinum", hex: "#CBD5E1", accent: "#E2E8F0" },
  { id: "auburn", label: "Rich Auburn", hex: "#881337", accent: "#BE123C" },
  { id: "plum", label: "Deep Plum", hex: "#3B1A2B", accent: "#582841" },
  { id: "violet", label: "Amethyst Violet", hex: "#5B21B6", accent: "#7C3AED" },
  { id: "lavender", label: "Pastel Lavender", hex: "#A78BFA", accent: "#C4B5FD" },
  { id: "sakura", label: "Sakura Rose", hex: "#F472B6", accent: "#F9A8D4" },
  { id: "crimson", label: "Crimson Red", hex: "#DC2626", accent: "#F87171" },
  { id: "teal", label: "Ocean Teal", hex: "#0F766E", accent: "#2DD4BF" },
  { id: "cobalt", label: "Cobalt Blue", hex: "#1D4ED8", accent: "#60A5FA" },
  { id: "slate", label: "Charcoal Slate", hex: "#334155", accent: "#64748B" },
] as const;

export const HIJAB_COLORS: readonly ColorOption[] = [
  { id: "pearl-cream", label: "Pearl Cream", hex: "#F5EFE6", accent: "#D9CEBE" },
  { id: "warm-sand", label: "Warm Sand", hex: "#D9C3A9", accent: "#B89E82" },
  { id: "mocha-taupe", label: "Mocha Taupe", hex: "#9B7B69", accent: "#7A5D4D" },
  { id: "dusty-rose", label: "Dusty Rose", hex: "#D48494", accent: "#B06171" },
  { id: "berry-mauve", label: "Berry Mauve", hex: "#8D4A67", accent: "#69314A" },
  { id: "burgundy", label: "Burgundy", hex: "#7F1D3A", accent: "#5E1228" },
  { id: "sage-olive", label: "Sage Olive", hex: "#7A937E", accent: "#59705D" },
  { id: "deep-emerald", label: "Deep Emerald", hex: "#0F5E4D", accent: "#094235" },
  { id: "slate-blue", label: "Slate Blue", hex: "#56708E", accent: "#3E546E" },
  { id: "midnight-navy", label: "Midnight Navy", hex: "#1E294A", accent: "#121A33" },
  { id: "lavender-mist", label: "Lavender Mist", hex: "#A898D6", accent: "#8372B5" },
  { id: "terracotta", label: "Terracotta", hex: "#B95C42", accent: "#91412B" },
  { id: "soft-blush", label: "Soft Blush", hex: "#F3C5CE", accent: "#D49BA6" },
  { id: "ivory", label: "Pure Ivory", hex: "#FAF8F5", accent: "#DCD6CC" },
  { id: "charcoal", label: "Charcoal", hex: "#374151", accent: "#1F2937" },
  { id: "obsidian", label: "Obsidian Black", hex: "#181822", accent: "#0E0E14" },
] as const;

export const EYE_STYLES: readonly LabeledOption[] = [
  { id: "sparkle", label: "Cute Sparkle" },
  { id: "wink", label: "Playful Wink" },
  { id: "lashes", label: "Soft Lashes" },
  { id: "calm", label: "Calm Half-Lid" },
  { id: "happy-arcs", label: "Happy Arcs" },
  { id: "starry", label: "Starry Eyes" },
  { id: "confident", label: "Cool Confident" },
  { id: "cat", label: "Cat Cute" },
  { id: "focused", label: "Focused" },
  { id: "cozy", label: "Cozy Smile" },
] as const;

export const EYE_COLORS: readonly ColorOption[] = [
  { id: "obsidian", label: "Obsidian", hex: "#1D1632" },
  { id: "espresso", label: "Espresso", hex: "#3B1D0E" },
  { id: "hazel", label: "Warm Hazel", hex: "#784421" },
  { id: "amber", label: "Honey Amber", hex: "#B45309" },
  { id: "emerald", label: "Emerald", hex: "#047857" },
  { id: "teal", label: "Teal", hex: "#0F766E" },
  { id: "sky", label: "Sky Blue", hex: "#0284C7" },
  { id: "sapphire", label: "Sapphire", hex: "#1E40AF" },
  { id: "amethyst", label: "Amethyst", hex: "#6D28D9" },
  { id: "rose", label: "Rose", hex: "#BE185D" },
  { id: "silver", label: "Silver", hex: "#475569" },
  { id: "crimson", label: "Crimson", hex: "#991B1B" },
] as const;

export const BROW_STYLES: readonly LabeledOption[] = [
  { id: "soft", label: "Soft Natural" },
  { id: "arched", label: "Clean Arched" },
  { id: "straight", label: "Straight Cool" },
  { id: "thick", label: "Expressive" },
  { id: "gentle", label: "Cute Gentle" },
  { id: "none", label: "None" },
] as const;

export const MOUTH_STYLES: readonly LabeledOption[] = [
  { id: "smile-blush", label: "Warm + Blush" },
  { id: "smile", label: "Warm Smile" },
  { id: "grin-blush", label: "Happy + Blush" },
  { id: "grin", label: "Happy Grin" },
  { id: "cat-blush", label: "Cute :3" },
  { id: "smirk", label: "Smirk" },
  { id: "o-blush", label: "Surprised o" },
  { id: "calm", label: "Calm Subtle" },
  { id: "playful", label: "Playful" },
  { id: "pout-blush", label: "Soft Pout" },
  { id: "cheerful", label: "Cheerful" },
  { id: "neutral", label: "Cool Neutral" },
] as const;

export const FACIAL_HAIR_STYLES: readonly LabeledOption[] = [
  { id: "none", label: "Clean Shaven" },
  { id: "stubble", label: "Soft Stubble" },
  { id: "mustache", label: "Cute Mustache" },
  { id: "goatee", label: "Clean Goatee" },
  { id: "boxed-beard", label: "Neat Beard" },
  { id: "chin-tuft", label: "Chin Tuft" },
] as const;

export const OUTFIT_STYLES: readonly LabeledOption[] = [
  { id: "hoodie", label: "Cozy Hoodie" },
  { id: "varsity", label: "Varsity Jacket" },
  { id: "sweater", label: "Crewneck" },
  { id: "scarf", label: "Sweater + Scarf" },
  { id: "preppy", label: "Preppy Collar" },
  { id: "tech-zip", label: "Zip Jacket" },
  { id: "tee", label: "Graphic Tee" },
  { id: "cardigan", label: "Cardigan" },
  { id: "streetwear", label: "Streetwear" },
  { id: "vest", label: "Cinema Vest" },
  { id: "astro", label: "Space Suit" },
  { id: "turtleneck", label: "Turtleneck" },
] as const;

export const OUTFIT_COLORS: readonly ColorOption[] = [
  { id: "amethyst", label: "Amethyst", hex: "#8B5CF6", accent: "#EDE9FE" },
  { id: "indigo", label: "Indigo", hex: "#6366F1", accent: "#E0E7FF" },
  { id: "cobalt", label: "Cobalt", hex: "#3B82F6", accent: "#DBEAFE" },
  { id: "teal", label: "Teal", hex: "#14B8A6", accent: "#CCFBF1" },
  { id: "emerald", label: "Emerald", hex: "#10B981", accent: "#ECFDF5" },
  { id: "rose", label: "Rose Pink", hex: "#F472B6", accent: "#FDF2F8" },
  { id: "crimson", label: "Crimson", hex: "#E11D48", accent: "#FFE4E6" },
  { id: "amber", label: "Amber", hex: "#F59E0B", accent: "#FEF3C7" },
  { id: "slate", label: "Charcoal", hex: "#334155", accent: "#CBD5E1" },
  { id: "cream", label: "Pearl Cream", hex: "#F3EFEA", accent: "#475569" },
  { id: "lavender", label: "Lavender", hex: "#A855F7", accent: "#F5F3FF" },
  { id: "coral", label: "Coral", hex: "#FB7185", accent: "#FFF1F2" },
  { id: "forest", label: "Forest", hex: "#047857", accent: "#D1FAE5" },
  { id: "mint", label: "Mint", hex: "#2DD4BF", accent: "#F0FDFA" },
  { id: "mocha", label: "Mocha", hex: "#78350F", accent: "#FEF3C7" },
  { id: "obsidian", label: "Obsidian", hex: "#18181B", accent: "#A1A1AA" },
] as const;

export const EYEWEAR_OPTIONS: readonly EyewearOption[] = [
  { id: "none", label: "No Glasses", kind: "none" },
  { id: "rx-round", label: "Round Optical", kind: "optical" },
  { id: "rx-rect", label: "Square Optical", kind: "optical" },
  { id: "rx-browline", label: "Browline Optical", kind: "optical" },
  { id: "rx-cat-eye", label: "Cat-Eye Optical", kind: "optical" },
  { id: "rx-oversized", label: "Oversized Optical", kind: "optical" },
  { id: "sun-wayfarer", label: "Wayfarer Shades", kind: "sun" },
  { id: "sun-aviator", label: "Aviator Shades", kind: "sun" },
  { id: "sun-round", label: "Round Shades", kind: "sun" },
  { id: "sun-rose-gradient", label: "Tinted Shades", kind: "sun" },
  { id: "sun-cyber-visor", label: "Cyber Visor", kind: "sun" },
  { id: "cinema-3d", label: "3D Cinema", kind: "party" },
] as const;

export const HEADWEAR_OPTIONS: readonly HeadwearOption[] = [
  { id: "none", label: "None", hijabCompatible: true },
  { id: "headphones", label: "Headphones", hijabCompatible: true },
  { id: "cat-headset", label: "Cat Headset", hijabCompatible: true },
  { id: "beanie", label: "Knit Beanie", hijabCompatible: false },
  { id: "cap-forward", label: "Baseball Cap", hijabCompatible: false },
  { id: "cap-back", label: "Backwards Cap", hijabCompatible: false },
  { id: "beret", label: "Velvet Beret", hijabCompatible: false },
  { id: "clip-star", label: "Star Clip", hijabCompatible: true },
  { id: "clip-flower", label: "Flower Clip", hijabCompatible: true },
  { id: "crown-mini", label: "Mini Crown", hijabCompatible: true },
] as const;

export const ACC_COLORS: readonly ColorOption[] = [
  { id: "obsidian", label: "Obsidian", hex: "#1E293B", accent: "#475569" },
  { id: "gold", label: "Gold", hex: "#F59E0B", accent: "#FDE047" },
  { id: "silver", label: "Silver", hex: "#CBD5E1", accent: "#F8FAFC" },
  { id: "rose-gold", label: "Rose Gold", hex: "#F472B6", accent: "#FBCFE8" },
  { id: "amethyst", label: "Amethyst", hex: "#8B5CF6", accent: "#C4B5FD" },
  { id: "amber", label: "Amber", hex: "#EA580C", accent: "#FDBA74" },
  { id: "cyan", label: "Cyan", hex: "#06B6D4", accent: "#67E8F9" },
  { id: "pearl", label: "Pearl White", hex: "#F1F5F9", accent: "#FFFFFF" },
  { id: "tortoise", label: "Tortoiseshell", hex: "#78350F", accent: "#D97706" },
  { id: "crimson", label: "Crimson", hex: "#E11D48", accent: "#FDA4AF" },
  { id: "mint", label: "Mint", hex: "#10B981", accent: "#6EE7B7" },
  { id: "cobalt", label: "Cobalt", hex: "#2563EB", accent: "#93C5FD" },
] as const;

export const BG_THEMES: readonly BgThemeOption[] = [
  { id: "violet-night", label: "Violet Night", base: "#3B1D6E", glow: "#6D28D9" },
  { id: "indigo-dusk", label: "Indigo Dusk", base: "#1E1B4B", glow: "#4338CA" },
  { id: "sakura-velvet", label: "Sakura Velvet", base: "#50183D", glow: "#BE185D" },
  { id: "royal-plum", label: "Royal Plum", base: "#2E1065", glow: "#7C3AED" },
  { id: "midnight-blue", label: "Midnight Blue", base: "#172554", glow: "#2563EB" },
  { id: "deep-teal", label: "Deep Teal", base: "#0F3A42", glow: "#0D9488" },
  { id: "emerald-dark", label: "Emerald", base: "#132F28", glow: "#059669" },
  { id: "amber-cinema", label: "Warm Amber", base: "#2B190E", glow: "#EA580C" },
  { id: "crimson-noir", label: "Crimson Noir", base: "#31101C", glow: "#E11D48" },
  { id: "obsidian-slate", label: "Obsidian", base: "#0F172A", glow: "#475569" },
  { id: "rose-berry", label: "Rose Berry", base: "#3B1228", glow: "#EC4899" },
  { id: "mint-lagoon", label: "Mint Lagoon", base: "#0B2E33", glow: "#2DD4BF" },
  { id: "aurora-sky", label: "Aurora Sky", base: "#0F2933", glow: "#0EA5E9" },
  { id: "espresso-gold", label: "Espresso Gold", base: "#261A12", glow: "#D97706" },
  { id: "amethyst-haze", label: "Amethyst Haze", base: "#321A4A", glow: "#9333EA" },
  { id: "starlight", label: "Starlight", base: "#18122B", glow: "#6366F1" },
] as const;

export function isHijabStyle(hairStyleIdx: number): boolean {
  const style = HAIR_STYLES[clampIndex(hairStyleIdx, HAIR_STYLES.length)];
  return style.category === "hijab";
}

export function isHeadwearCompatibleWithHijab(headwearIdx: number): boolean {
  const hw = HEADWEAR_OPTIONS[clampIndex(headwearIdx, HEADWEAR_OPTIONS.length)];
  return hw.hijabCompatible;
}

export function clampIndex(value: number, length: number): number {
  if (!Number.isFinite(value) || length <= 0) return 0;
  return Math.abs(Math.floor(value)) % length;
}

export function isValidCustomAvatarId(raw: string): raw is CustomAvatarId {
  return /^c1-[0-9a-z]{14,18}$/.test(raw);
}

const SLOT_LIMITS: readonly number[] = [
  2, // 0: base
  SKIN_TONES.length, // 1: skinTone
  HAIR_STYLES.length, // 2: hairStyle
  HAIR_COLORS.length, // 3: hairOrHijabColor (16 for both hair & hijab)
  EYE_STYLES.length, // 4: eyeStyle
  EYE_COLORS.length, // 5: eyeColor
  BROW_STYLES.length, // 6: browStyle
  MOUTH_STYLES.length, // 7: mouthAndBlush
  FACIAL_HAIR_STYLES.length, // 8: facialHair
  OUTFIT_STYLES.length, // 9: outfitStyle
  OUTFIT_COLORS.length, // 10: outfitColor
  EYEWEAR_OPTIONS.length, // 11: eyewear
  HEADWEAR_OPTIONS.length, // 12: headwear
  ACC_COLORS.length, // 13: accColor
  BG_THEMES.length, // 14: bgTheme
];

export function encodeCustomAvatar(recipe: CustomAvatarRecipe): CustomAvatarId {
  const slots = [
    recipe.base,
    recipe.skinTone,
    recipe.hairStyle,
    recipe.hairOrHijabColor,
    recipe.eyeStyle,
    recipe.eyeColor,
    recipe.browStyle,
    recipe.mouthAndBlush,
    recipe.facialHair,
    recipe.outfitStyle,
    recipe.outfitColor,
    recipe.eyewear,
    recipe.headwear,
    recipe.accColor,
    recipe.bgTheme,
  ];
  const encoded = slots
    .map((val, idx) => clampIndex(val, SLOT_LIMITS[idx]).toString(36))
    .join("");
  return `${CUSTOM_AVATAR_PREFIX}${encoded}` as CustomAvatarId;
}

export function decodeCustomAvatar(raw: string): CustomAvatarRecipe {
  const body = raw.startsWith(CUSTOM_AVATAR_PREFIX)
    ? raw.slice(CUSTOM_AVATAR_PREFIX.length)
    : "";
  const slot = (idx: number, fallback = 0): number => {
    const ch = body[idx];
    if (!ch) return fallback;
    const parsed = Number.parseInt(ch, 36);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return clampIndex(parsed, SLOT_LIMITS[idx]);
  };
  return {
    base: slot(0, 0),
    skinTone: slot(1, 1),
    hairStyle: slot(2, 8),
    hairOrHijabColor: slot(3, 0),
    eyeStyle: slot(4, 0),
    eyeColor: slot(5, 0),
    browStyle: slot(6, 0),
    mouthAndBlush: slot(7, 0),
    facialHair: slot(8, 0),
    outfitStyle: slot(9, 0),
    outfitColor: slot(10, 0),
    eyewear: slot(11, 0),
    headwear: slot(12, 0),
    accColor: slot(13, 0),
    bgTheme: slot(14, 0),
  };
}

export function presetToStartingRecipe(presetId: string): CustomAvatarRecipe {
  const baseRecipe: CustomAvatarRecipe = {
    base: 0,
    skinTone: 1,
    hairStyle: 8,
    hairOrHijabColor: 0,
    eyeStyle: 0,
    eyeColor: 0,
    browStyle: 0,
    mouthAndBlush: 0,
    facialHair: 0,
    outfitStyle: 0,
    outfitColor: 0,
    eyewear: 0,
    headwear: 0,
    accColor: 4,
    bgTheme: 0,
  };

  switch (presetId) {
    case "nova":
      return { ...baseRecipe, base: 0, skinTone: 1, hairStyle: 8, hairOrHijabColor: 0, outfitStyle: 0, outfitColor: 0, bgTheme: 0 };
    case "nova-star":
      return { ...baseRecipe, base: 0, skinTone: 0, hairStyle: 8, hairOrHijabColor: 9, eyeStyle: 1, outfitStyle: 0, outfitColor: 2, headwear: 7, accColor: 1, bgTheme: 1 };
    case "luna":
      return { ...baseRecipe, base: 0, skinTone: 0, hairStyle: 9, hairOrHijabColor: 9, outfitStyle: 2, outfitColor: 1, headwear: 2, accColor: 4, bgTheme: 1 };
    case "luna-mint":
      return { ...baseRecipe, base: 0, skinTone: 0, hairStyle: 9, hairOrHijabColor: 6, eyeColor: 5, outfitStyle: 2, outfitColor: 3, headwear: 2, accColor: 10, bgTheme: 12 };
    case "sakura":
      return { ...baseRecipe, base: 0, skinTone: 0, hairStyle: 10, hairOrHijabColor: 8, outfitStyle: 4, outfitColor: 5, eyewear: 1, headwear: 8, accColor: 3, bgTheme: 2 };
    case "sakura-gold":
      return { ...baseRecipe, base: 0, skinTone: 0, hairStyle: 10, hairOrHijabColor: 3, eyeStyle: 1, eyeColor: 1, outfitStyle: 4, outfitColor: 11, headwear: 8, accColor: 1, bgTheme: 2 };
    case "maya":
      return { ...baseRecipe, base: 0, skinTone: 4, hairStyle: 11, hairOrHijabColor: 0, eyeStyle: 1, mouthAndBlush: 2, outfitStyle: 6, outfitColor: 10, bgTheme: 3 };
    case "aria-beret":
      return { ...baseRecipe, base: 0, skinTone: 3, hairStyle: 12, hairOrHijabColor: 3, eyeColor: 1, outfitStyle: 3, outfitColor: 9, headwear: 6, accColor: 9, bgTheme: 10 };
    case "leo":
      return { ...baseRecipe, base: 1, skinTone: 2, hairStyle: 1, hairOrHijabColor: 15, outfitStyle: 0, outfitColor: 2, headwear: 1, accColor: 4, bgTheme: 4 };
    case "leo-amber":
      return { ...baseRecipe, base: 1, skinTone: 2, hairStyle: 1, hairOrHijabColor: 4, eyeStyle: 1, outfitStyle: 0, outfitColor: 8, headwear: 1, accColor: 5, bgTheme: 7 };
    case "kai":
      return { ...baseRecipe, base: 1, skinTone: 4, hairStyle: 3, hairOrHijabColor: 0, outfitStyle: 5, outfitColor: 3, eyewear: 2, headwear: 3, accColor: 0, bgTheme: 5 };
    case "kai-crimson":
      return { ...baseRecipe, base: 1, skinTone: 4, hairStyle: 3, hairOrHijabColor: 0, outfitStyle: 5, outfitColor: 6, eyewear: 8, headwear: 3, accColor: 2, bgTheme: 8 };
    case "omar":
      return { ...baseRecipe, base: 1, skinTone: 6, hairStyle: 2, hairOrHijabColor: 0, mouthAndBlush: 2, outfitStyle: 1, outfitColor: 4, bgTheme: 6 };
    case "omar-cobalt":
      return { ...baseRecipe, base: 1, skinTone: 6, hairStyle: 0, hairOrHijabColor: 0, outfitStyle: 1, outfitColor: 2, bgTheme: 9 };
    case "zayd":
      return { ...baseRecipe, base: 1, skinTone: 3, hairStyle: 3, hairOrHijabColor: 1, outfitStyle: 8, outfitColor: 0, headwear: 5, accColor: 1, bgTheme: 14 };
    case "milo-gamer":
      return { ...baseRecipe, base: 1, skinTone: 1, hairStyle: 6, hairOrHijabColor: 1, outfitStyle: 8, outfitColor: 4, eyewear: 10, headwear: 4, accColor: 4, bgTheme: 11 };
    default:
      return baseRecipe;
  }
}

export function randomizeCustomRecipe(base: AvatarBase = "girl"): CustomAvatarRecipe {
  const pick = <T,>(arr: readonly T[]) => Math.floor(Math.random() * arr.length);
  const isBoy = base === "boy";

  const shortIndices = HAIR_STYLES.map((h, i) => (h.category === "short" ? i : -1)).filter((i) => i >= 0);
  const girlIndices = HAIR_STYLES.map((h, i) => (h.category !== "short" ? i : -1)).filter((i) => i >= 0);
  const hairPool = isBoy ? shortIndices : girlIndices;
  const hairStyle = hairPool[Math.floor(Math.random() * hairPool.length)];
  const hijab = isHijabStyle(hairStyle);

  // Harmonious hair/hijab colors
  const naturalHairPool = [0, 1, 2, 3, 4, 5, 8, 9, 10, 15];
  const hairOrHijabColor = hijab
    ? pick(HIJAB_COLORS)
    : naturalHairPool[Math.floor(Math.random() * naturalHairPool.length)];

  // 45% chance of eyewear, 40% chance of headwear
  const eyewear = Math.random() < 0.45 ? 1 + Math.floor(Math.random() * (EYEWEAR_OPTIONS.length - 1)) : 0;
  const compatibleHeadwear = HEADWEAR_OPTIONS.map((h, i) =>
    !hijab || h.hijabCompatible ? i : -1,
  ).filter((i) => i > 0);
  const headwear =
    Math.random() < 0.42
      ? compatibleHeadwear[Math.floor(Math.random() * compatibleHeadwear.length)]
      : 0;

  const facialHair = isBoy && !hijab && Math.random() < 0.28 ? 1 + Math.floor(Math.random() * 5) : 0;

  return {
    base: isBoy ? 1 : 0,
    skinTone: pick(SKIN_TONES),
    hairStyle,
    hairOrHijabColor,
    eyeStyle: Math.random() < 0.55 ? 0 : pick(EYE_STYLES),
    eyeColor: Math.floor(Math.random() * 9),
    browStyle: Math.floor(Math.random() * 5),
    mouthAndBlush: Math.floor(Math.random() * 6),
    facialHair,
    outfitStyle: pick(OUTFIT_STYLES),
    outfitColor: pick(OUTFIT_COLORS),
    eyewear,
    headwear,
    accColor: pick(ACC_COLORS),
    bgTheme: pick(BG_THEMES),
  };
}

export function loadSavedCustomAvatars(): CustomAvatarId[] {
  try {
    if (typeof localStorage === "undefined") return [];
    const raw = localStorage.getItem(CUSTOM_AVATARS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: CustomAvatarId[] = [];
    for (const item of parsed) {
      if (typeof item === "string" && isValidCustomAvatarId(item) && !seen.has(item)) {
        seen.add(item);
        out.push(item);
        if (out.length >= MAX_SAVED_CUSTOM_AVATARS) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function saveCustomAvatarsList(list: CustomAvatarId[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(
        CUSTOM_AVATARS_STORAGE_KEY,
        JSON.stringify(list.slice(0, MAX_SAVED_CUSTOM_AVATARS)),
      );
    }
  } catch {
    // Ignore storage write restrictions
  }
}

export function upsertSavedCustomAvatar(
  list: CustomAvatarId[],
  nextId: CustomAvatarId,
  replaceId?: CustomAvatarId | null,
): CustomAvatarId[] {
  const filtered = list.filter((id) => id !== nextId && id !== replaceId);
  return [nextId, ...filtered].slice(0, MAX_SAVED_CUSTOM_AVATARS);
}

export function removeSavedCustomAvatar(
  list: CustomAvatarId[],
  targetId: CustomAvatarId,
): CustomAvatarId[] {
  return list.filter((id) => id !== targetId);
}
