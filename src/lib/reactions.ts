import {
  DEFAULT_REACTION_EMOJIS,
  isValidReactionEmoji,
  PRESET_REACTIONS,
  REACTION_PRESET_COUNT,
  reorderReactionPresets,
  replaceReactionPresetAt,
  sanitizeReactionPresets,
  type PresetReaction,
} from "./reactionPresets";
import { playReactionSoundCue } from "./soundEffects";
import { resolveEffectiveUsername } from "./syncController";
import { syncSendReaction } from "./syncplay";
import { useAppStore } from "../store/useAppStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { enqueueReactionBurst } from "../store/useReactionStore";
import { useSyncStore } from "../store/useSyncStore";

export {
  DEFAULT_REACTION_EMOJIS,
  isValidReactionEmoji,
  PRESET_REACTIONS,
  REACTION_PRESET_COUNT,
  reorderReactionPresets,
  replaceReactionPresetAt,
  sanitizeReactionPresets,
  type PresetReaction,
};

export type EmojiCategory = "faces" | "hype" | "cinema" | "hands";

export interface EmojiCatalogItem {
  emoji: string;
  name: string;
  keywords: string;
  category: EmojiCategory;
}

export const EMOJI_CATEGORY_TABS: ReadonlyArray<{
  value: "all" | EmojiCategory;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "faces", label: "Faces" },
  { value: "hype", label: "Hype" },
  { value: "cinema", label: "Cinema" },
  { value: "hands", label: "Hands" },
] as const;

export const EMOJI_CATALOG: readonly EmojiCatalogItem[] = [
  // Faces & Emotions
  { emoji: "😱", name: "Scared Scream", keywords: "scared scream fear horror omg shock", category: "faces" },
  { emoji: "😂", name: "Tears of Joy", keywords: "laugh funny lol haha comedy", category: "faces" },
  { emoji: "😭", name: "Loudly Crying", keywords: "cry sob sad emotional heartbreak", category: "faces" },
  { emoji: "😮", name: "Surprised", keywords: "whoa wow shocked plot twist gasp", category: "faces" },
  { emoji: "😢", name: "Crying Face", keywords: "sad tear emotional", category: "faces" },
  { emoji: "🤯", name: "Mind Blown", keywords: "mind blown shock crazy plot twist", category: "faces" },
  { emoji: "😍", name: "Heart Eyes", keywords: "love crush cute adorable", category: "faces" },
  { emoji: "🥺", name: "Pleading", keywords: "puppy eyes cute please emotional", category: "faces" },
  { emoji: "🤣", name: "ROFL", keywords: "laugh rolling hilarious lol", category: "faces" },
  { emoji: "😨", name: "Fearful", keywords: "scared fear anxious tense", category: "faces" },
  { emoji: "😰", name: "Anxious Sweat", keywords: "nervous tense scary suspense", category: "faces" },
  { emoji: "🫣", name: "Peeking Eye", keywords: "scary horror peek shy suspense", category: "faces" },
  { emoji: "😳", name: "Flushed", keywords: "embarrassed blush awkward", category: "faces" },
  { emoji: "🫠", name: "Melting", keywords: "cringe melt awkward", category: "faces" },
  { emoji: "💀", name: "Skull", keywords: "dead funny lmao rip", category: "faces" },
  { emoji: "☠️", name: "Skull & Bones", keywords: "dead spooky pirate danger", category: "faces" },
  { emoji: "👻", name: "Ghost", keywords: "spooky scary horror halloween boo", category: "faces" },
  { emoji: "😈", name: "Smiling Devil", keywords: "evil villain mischief hype", category: "faces" },
  { emoji: "😠", name: "Angry", keywords: "mad angry villain rage", category: "faces" },
  { emoji: "🤬", name: "Cursing", keywords: "rage furious angry mad", category: "faces" },
  { emoji: "🙄", name: "Eye Roll", keywords: "annoyed whatever cliché", category: "faces" },
  { emoji: "🤨", name: "Raised Eyebrow", keywords: "suspicious sus doubt", category: "faces" },
  { emoji: "🧐", name: "Monocle", keywords: "detective clue inspect curious", category: "faces" },
  { emoji: "😴", name: "Sleeping", keywords: "boring sleepy yawn tired", category: "faces" },
  { emoji: "🤢", name: "Nauseated", keywords: "gross eww sick disgust", category: "faces" },
  { emoji: "🤮", name: "Vomiting", keywords: "gross disgusting eww", category: "faces" },
  { emoji: "😎", name: "Cool Sunglasses", keywords: "cool badass smooth swag", category: "faces" },
  { emoji: "🥳", name: "Party Face", keywords: "celebrate party birthday hype", category: "faces" },
  { emoji: "🤩", name: "Star Struck", keywords: "amazing awesome excited stars", category: "faces" },
  { emoji: "😏", name: "Smirk", keywords: "smug sly clever", category: "faces" },
  { emoji: "😬", name: "Grimacing", keywords: "awkward yikes oof tense", category: "faces" },
  { emoji: "🤫", name: "Shushing", keywords: "quiet secret spoiler shh", category: "faces" },
  { emoji: "🤡", name: "Clown", keywords: "clown fool silly funny", category: "faces" },
  { emoji: "😵", name: "Dizzy", keywords: "knocked out stunned confused", category: "faces" },
  { emoji: "🥲", name: "Smiling Tear", keywords: "bittersweet proud emotional", category: "faces" },

  // Hearts & Hype
  { emoji: "❤️", name: "Red Heart", keywords: "love heart romance like", category: "hype" },
  { emoji: "❤️‍🔥", name: "Heart on Fire", keywords: "passion love epic fire", category: "hype" },
  { emoji: "💔", name: "Broken Heart", keywords: "sad heartbreak betrayal", category: "hype" },
  { emoji: "💜", name: "Purple Heart", keywords: "love epilod amethyst purple", category: "hype" },
  { emoji: "💖", name: "Sparkling Heart", keywords: "love sparkle cute", category: "hype" },
  { emoji: "🔥", name: "Fire", keywords: "lit hot hype epic action", category: "hype" },
  { emoji: "⚡", name: "Lightning", keywords: "fast shock twist electric", category: "hype" },
  { emoji: "💥", name: "Boom", keywords: "explosion action boom impact", category: "hype" },
  { emoji: "✨", name: "Sparkles", keywords: "magic pretty aesthetic shine", category: "hype" },
  { emoji: "💯", name: "100", keywords: "perfect truth facts peak", category: "hype" },
  { emoji: "🎉", name: "Party Popper", keywords: "celebrate finale yay congrats", category: "hype" },
  { emoji: "👑", name: "Crown", keywords: "king queen goat boss royalty", category: "hype" },
  { emoji: "🏆", name: "Trophy", keywords: "win champion oscar best", category: "hype" },
  { emoji: "🌟", name: "Glowing Star", keywords: "star favorite peak masterpiece", category: "hype" },
  { emoji: "💢", name: "Anger Symbol", keywords: "anime rage mad vein", category: "hype" },
  { emoji: "💫", name: "Dizzy Star", keywords: "magic dreamy sparkle", category: "hype" },
  { emoji: "🚨", name: "Siren", keywords: "alert danger twist spoiler", category: "hype" },
  { emoji: "⚠️", name: "Warning", keywords: "careful jump scare danger", category: "hype" },
  { emoji: "❓", name: "Question", keywords: "what confused huh mystery", category: "hype" },
  { emoji: "❗", name: "Exclamation", keywords: "alert surprise sudden", category: "hype" },

  // Cinema & Watch Party
  { emoji: "🍿", name: "Popcorn", keywords: "movie cinema snack drama watch", category: "cinema" },
  { emoji: "🎬", name: "Clapper Board", keywords: "cinema film action movie scene", category: "cinema" },
  { emoji: "🎥", name: "Movie Camera", keywords: "film cinematography shot", category: "cinema" },
  { emoji: "🎭", name: "Theater Masks", keywords: "drama acting tragedy comedy", category: "cinema" },
  { emoji: "🎧", name: "Headphones", keywords: "soundtrack ost music audio", category: "cinema" },
  { emoji: "🎶", name: "Music Notes", keywords: "theme song soundtrack op", category: "cinema" },
  { emoji: "🗡️", name: "Sword", keywords: "fight battle duel anime fantasy", category: "cinema" },
  { emoji: "🩸", name: "Blood Drop", keywords: "horror gore vampire fight", category: "cinema" },
  { emoji: "🕷️", name: "Spider", keywords: "creepy scary horror bug", category: "cinema" },
  { emoji: "🦇", name: "Bat", keywords: "vampire night spooky gothic", category: "cinema" },
  { emoji: "🚀", name: "Rocket", keywords: "scifi space launch hype", category: "cinema" },
  { emoji: "🛸", name: "UFO", keywords: "alien scifi space", category: "cinema" },
  { emoji: "🐉", name: "Dragon", keywords: "fantasy anime epic fire", category: "cinema" },
  { emoji: "🐈", name: "Cat", keywords: "kitty cute pet", category: "cinema" },
  { emoji: "🐐", name: "GOAT", keywords: "greatest goat legend", category: "cinema" },
  { emoji: "🍕", name: "Pizza", keywords: "food snack party", category: "cinema" },
  { emoji: "☕", name: "Coffee", keywords: "cozy tea chill", category: "cinema" },
  { emoji: "🥤", name: "Soda Cup", keywords: "drink snack theater", category: "cinema" },
  { emoji: "🌹", name: "Rose", keywords: "romance love beauty", category: "cinema" },
  { emoji: "🌙", name: "Crescent Moon", keywords: "night vibe aesthetic", category: "cinema" },

  // Hands & Gestures
  { emoji: "👏", name: "Clapping", keywords: "applause bravo standing ovation", category: "hands" },
  { emoji: "🫶", name: "Heart Hands", keywords: "love thank you cute", category: "hands" },
  { emoji: "👍", name: "Thumbs Up", keywords: "good nice yes approve", category: "hands" },
  { emoji: "👎", name: "Thumbs Down", keywords: "bad boo dislike", category: "hands" },
  { emoji: "🙌", name: "Raising Hands", keywords: "hallelujah praise celebrate", category: "hands" },
  { emoji: "🙏", name: "Folded Hands", keywords: "please pray hope thank", category: "hands" },
  { emoji: "🤝", name: "Handshake", keywords: "deal respect team alliance", category: "hands" },
  { emoji: "🫡", name: "Salute", keywords: "respect yes sir honor", category: "hands" },
  { emoji: "💪", name: "Flexed Bicep", keywords: "strong power gym hype", category: "hands" },
  { emoji: "✌️", name: "Victory Peace", keywords: "peace bye chill", category: "hands" },
  { emoji: "🤞", name: "Crossed Fingers", keywords: "hope luck suspense", category: "hands" },
  { emoji: "🫰", name: "Finger Heart", keywords: "love korean cute", category: "hands" },
  { emoji: "🤦", name: "Facepalm", keywords: "dumb mistake smh why", category: "hands" },
  { emoji: "🤷", name: "Shrug", keywords: "idk whatever confused", category: "hands" },
  { emoji: "👀", name: "Eyes", keywords: "look watching tea suspicious", category: "hands" },
  { emoji: "🧠", name: "Brain", keywords: "smart 200iq genius plot", category: "hands" },
] as const;

const LABEL_BY_EMOJI: Map<string, string> = (() => {
  const map = new Map<string, string>();
  for (const preset of PRESET_REACTIONS) {
    map.set(preset.emoji, preset.label);
  }
  for (const item of EMOJI_CATALOG) {
    if (!map.has(item.emoji)) {
      map.set(item.emoji, item.name);
    }
  }
  return map;
})();

export function resolvePresetReactions(emojis: readonly string[]): PresetReaction[] {
  return sanitizeReactionPresets(emojis).map((emoji, idx) => ({
    emoji,
    label: LABEL_BY_EMOJI.get(emoji) ?? "Reaction",
    shortcut: String(idx + 1),
  }));
}

const pendingWireCounts = new Map<string, number>();
let wireFlushTimer: number | null = null;
let lastImmediateSentAt = 0;

function flushWireReactions(): void {
  wireFlushTimer = null;
  if (pendingWireCounts.size === 0) return;

  const sync = useSyncStore.getState();
  const app = useAppStore.getState();
  if (sync.status.state !== "connected") {
    pendingWireCounts.clear();
    return;
  }

  for (const [emoji, total] of pendingWireCounts.entries()) {
    let rem = total;
    while (rem > 0) {
      const batch = Math.min(25, rem);
      rem -= batch;
      void syncSendReaction(emoji, app.avatarId, batch).catch(() => undefined);
    }
  }
  pendingWireCounts.clear();
}

export function triggerPartyReaction(
  emoji: string,
  options?: { recordRecent?: boolean; soundMode?: "tap" | "repeat" | "none" },
): void {
  const clean = emoji.trim();
  if (!clean) return;

  const app = useAppStore.getState();
  if (!app.reactionsEnabled) return;

  const sync = useSyncStore.getState();
  const effectiveUser = resolveEffectiveUsername(sync.status, app.username);

  // Instant zero-latency local spawn
  enqueueReactionBurst({
    username: effectiveUser,
    avatarId: app.avatarId,
    emoji: clean,
    count: 1,
    isSelf: true,
  });

  if (options?.soundMode !== "none") {
    const player = usePlayerStore.getState();
    playReactionSoundCue(clean, {
      moviePlaying: player.loaded && !player.paused,
      repeat: options?.soundMode === "repeat",
    });
  }

  if (options?.recordRecent && !app.reactionPresets.includes(clean)) {
    app.pushRecentEmoji(clean);
  }

  if (sync.status.state !== "connected") {
    return;
  }

  const now = performance.now();
  if (pendingWireCounts.size === 0 && now - lastImmediateSentAt >= 36) {
    lastImmediateSentAt = now;
    void syncSendReaction(clean, app.avatarId, 1).catch(() => undefined);
    return;
  }

  pendingWireCounts.set(clean, Math.min(200, (pendingWireCounts.get(clean) ?? 0) + 1));
  if (wireFlushTimer === null) {
    wireFlushTimer = globalThis.setTimeout(flushWireReactions, 42) as unknown as number;
  }
}

export function filterEmojiCatalog(
  query: string,
  category: "all" | EmojiCategory,
): EmojiCatalogItem[] {
  const q = query.trim().toLowerCase();
  return EMOJI_CATALOG.filter((item) => {
    if (category !== "all" && item.category !== category) {
      return false;
    }
    if (!q) return true;
    return (
      item.name.toLowerCase().includes(q) ||
      item.keywords.toLowerCase().includes(q) ||
      item.emoji === q
    );
  });
}
