export interface PresetReaction {
  emoji: string;
  label: string;
  shortcut: string;
}

export const REACTION_PRESET_COUNT = 7;

export const PRESET_REACTIONS: readonly PresetReaction[] = [
  { emoji: "❤️", label: "Love", shortcut: "1" },
  { emoji: "😂", label: "Laugh", shortcut: "2" },
  { emoji: "😮", label: "Whoa", shortcut: "3" },
  { emoji: "😱", label: "Scared", shortcut: "4" },
  { emoji: "😢", label: "Cry", shortcut: "5" },
  { emoji: "🔥", label: "Fire", shortcut: "6" },
  { emoji: "👏", label: "Clap", shortcut: "7" },
] as const;

export const DEFAULT_REACTION_EMOJIS: readonly string[] = PRESET_REACTIONS.map((p) => p.emoji);

export function isValidReactionEmoji(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const clean = raw.trim();
  return (
    clean.length > 0 &&
    clean.length <= 24 &&
    !/\s/.test(clean) &&
    /[\p{Extended_Pictographic}\u20E3]/u.test(clean)
  );
}

export function sanitizeReactionPresets(raw: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isValidReactionEmoji(item)) continue;
      const clean = item.trim();
      if (!out.includes(clean)) {
        out.push(clean);
      }
      if (out.length >= REACTION_PRESET_COUNT) break;
    }
  }
  for (const fallback of DEFAULT_REACTION_EMOJIS) {
    if (out.length >= REACTION_PRESET_COUNT) break;
    if (!out.includes(fallback)) {
      out.push(fallback);
    }
  }
  return out;
}

export function replaceReactionPresetAt(
  presets: readonly string[],
  index: number,
  emoji: string,
): string[] {
  const normalized = sanitizeReactionPresets(presets);
  if (!Number.isInteger(index) || index < 0 || index >= REACTION_PRESET_COUNT) {
    return normalized;
  }
  if (!isValidReactionEmoji(emoji)) {
    return normalized;
  }
  const clean = emoji.trim();
  const existingIdx = normalized.indexOf(clean);
  const next = [...normalized];
  if (existingIdx !== -1) {
    if (existingIdx === index) return next;
    [next[index], next[existingIdx]] = [next[existingIdx], next[index]];
    return next;
  }
  next[index] = clean;
  return next;
}

export function reorderReactionPresets(
  presets: readonly string[],
  fromIndex: number,
  toIndex: number,
): string[] {
  const normalized = sanitizeReactionPresets(presets);
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    fromIndex >= REACTION_PRESET_COUNT ||
    toIndex < 0 ||
    toIndex >= REACTION_PRESET_COUNT ||
    fromIndex === toIndex
  ) {
    return normalized;
  }
  const next = [...normalized];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
