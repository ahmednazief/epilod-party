export interface ShortcutSpec {
  keys: string[];
  label: string;
  category: "Playback" | "Subtitles" | "Room & Window";
}

export const SHORTCUT_CATEGORIES: ShortcutSpec["category"][] = [
  "Playback",
  "Subtitles",
  "Room & Window",
];

export const PLAYER_SHORTCUTS: ShortcutSpec[] = [
  { keys: ["Space", "K"], label: "Play / Pause", category: "Playback" },
  { keys: ["←", "→"], label: "Seek ±5 seconds", category: "Playback" },
  { keys: ["J", "L"], label: "Seek ±10 seconds", category: "Playback" },
  { keys: ["↑", "↓"], label: "Volume ±5%", category: "Playback" },
  { keys: ["M"], label: "Mute / Unmute", category: "Playback" },
  { keys: ["[", "]"], label: "Playback speed ±0.1× (when un-synced)", category: "Playback" },
  { keys: ["V"], label: "Toggle subtitle visibility", category: "Subtitles" },
  { keys: ["S"], label: "Cycle subtitle track", category: "Subtitles" },
  { keys: ["Z", "X"], label: "Subtitle timing −0.1s / +0.1s", category: "Subtitles" },
  { keys: ["F"], label: "Toggle fullscreen", category: "Room & Window" },
  { keys: ["Esc"], label: "Exit fullscreen or close dialog", category: "Room & Window" },
  { keys: ["R"], label: "Toggle Ready state in room", category: "Room & Window" },
  { keys: ["?"], label: "Open keyboard shortcuts", category: "Room & Window" },
];

export function isTextEntryElement(target: EventTarget | null): boolean {
  if (!target || typeof target !== "object") {
    return false;
  }
  const el = target as { tagName?: string; isContentEditable?: boolean; getAttribute?: (k: string) => string | null };
  if (el.isContentEditable) {
    return true;
  }
  const tag = (el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
    return true;
  }
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "combobox";
}
