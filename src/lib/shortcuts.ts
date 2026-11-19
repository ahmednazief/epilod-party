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
  { keys: ["M"], label: "Mute / Unmute mic (in voice) or audio", category: "Playback" },
  { keys: ["Shift", "M"], label: "Mute / Unmute video audio", category: "Playback" },
  { keys: ["I"], label: "Skip detected intro", category: "Playback" },
  { keys: ["[", "]"], label: "Playback speed ±0.1× (when un-synced)", category: "Playback" },
  { keys: ["V"], label: "Toggle subtitle visibility", category: "Subtitles" },
  { keys: ["S"], label: "Cycle subtitle track", category: "Subtitles" },
  { keys: ["Z", "X"], label: "Subtitle timing −0.1s / +0.1s", category: "Subtitles" },
  { keys: ["F", "Enter"], label: "Toggle fullscreen", category: "Room & Window" },
  { keys: ["Esc"], label: "Exit fullscreen or close dialog", category: "Room & Window" },
  { keys: ["R"], label: "Toggle Ready state in room", category: "Room & Window" },
  { keys: ["C"], label: "Toggle party chat (in room)", category: "Room & Window" },
  { keys: ["E"], label: "Toggle live reaction bar (in party)", category: "Room & Window" },
  { keys: ["1–7"], label: "Send quick emoji reaction (❤️ 😂 😮 😱 😢 🔥 👏)", category: "Room & Window" },
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

const KEYBOARD_ACTIVATION_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
const KEYBOARD_ACTIVATION_ROLES = new Set([
  "button",
  "link",
  "tab",
  "switch",
  "checkbox",
  "radio",
  "menuitem",
  "option",
]);
const MENU_OR_DIALOG_ROLES = new Set(["menu", "listbox", "dialog", "alertdialog"]);

/**
 * Return true when pressing Enter should toggle fullscreen instead of
 * submitting text, selecting a menu option, or activating a keyboard-focused control.
 */
export function shouldEnterToggleFullscreen(
  target: EventTarget | null,
  focusMode?: string,
): boolean {
  if (isTextEntryElement(target)) {
    return false;
  }
  if (!target || typeof target !== "object") {
    return true;
  }
  const el = target as {
    tagName?: string;
    getAttribute?: (k: string) => string | null;
    closest?: (selector: string) => unknown;
  };
  const role = el.getAttribute?.("role")?.toLowerCase() ?? "";
  if (role === "menuitem" || role === "option" || MENU_OR_DIALOG_ROLES.has(role)) {
    return false;
  }
  if (el.closest?.('[role="menu"], [role="listbox"], [role="dialog"], [role="alertdialog"]')) {
    return false;
  }
  if (focusMode === "keyboard") {
    const tag = (el.tagName || "").toUpperCase();
    if (KEYBOARD_ACTIVATION_TAGS.has(tag) || KEYBOARD_ACTIVATION_ROLES.has(role)) {
      return false;
    }
  }
  return true;
}
