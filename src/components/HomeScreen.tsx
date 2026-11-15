import {
  ArrowRight,
  Check,
  ChevronRight,
  Download,
  KeyRound,
  Play,
  Settings,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { sanitizeRoomCodeInput, sanitizeUsername } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import { LogoMark } from "./ui/LogoMark";
import { TitleBar } from "./TitleBar";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(): string {
  const randomBytes = new Uint8Array(12);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < 12; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  const seg = (start: number) =>
    Array.from(randomBytes.slice(start, start + 4))
      .map((b) => CODE_CHARS[b % CODE_CHARS.length])
      .join("");
  return `${seg(0)}-${seg(4)}-${seg(8)}`;
}

export function HomeScreen() {
  const username = useAppStore((s) => s.username);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const literalRoomStored = useAppStore((s) => s.literalRoom);
  const autoCheckUpdates = useAppStore((s) => s.autoCheckUpdates);
  const setUsername = useAppStore((s) => s.setUsername);
  const setServerPassword = useAppStore((s) => s.setServerPassword);
  const enterRoom = useAppStore((s) => s.enterRoom);
  const openSettings = useAppStore((s) => s.openSettings);

  const updateStatus = useUpdaterStore((s) => s.status);
  const hasCheckedStartup = useUpdaterStore((s) => s.hasCheckedStartup);
  const initUpdater = useUpdaterStore((s) => s.init);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);

  const [joinInput, setJoinInput] = useState("");
  const [standardRoomName, setStandardRoomName] = useState(literalRoomStored);
  const [showOptions, setShowOptions] = useState(Boolean(serverPassword));
  const [editingName, setEditingName] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let checkTimer: ReturnType<typeof setTimeout> | null = null;
    void (async () => {
      await initUpdater();
      if (active && autoCheckUpdates && !hasCheckedStartup) {
        checkTimer = setTimeout(() => {
          if (active) {
            void checkForUpdates(true);
          }
        }, 2500);
      }
    })();
    return () => {
      active = false;
      if (checkTimer !== null) {
        clearTimeout(checkTimer);
      }
    };
  }, [autoCheckUpdates, hasCheckedStartup, initUpdater, checkForUpdates]);

  const ensureValidName = (): boolean => {
    const clean = sanitizeUsername(username);
    if (!clean) {
      setEditingName(true);
      setError("Enter a display name first so friends recognize you.");
      return false;
    }
    setError(null);
    return true;
  };

  const handleCreateRoom = () => {
    if (!ensureValidName()) return;
    const code = generateRoomCode();
    enterRoom(code, false);
  };

  const handleJoinRoom = (e: FormEvent) => {
    e.preventDefault();
    if (!ensureValidName()) return;
    const cleaned = sanitizeRoomCodeInput(joinInput, standardRoomName);
    if (cleaned.length < (standardRoomName ? 1 : 4)) {
      setError(
        standardRoomName
          ? "Enter the exact Syncplay room name to join."
          : "Enter a room code (e.g. ABCD-EFGH-JKLM).",
      );
      return;
    }
    enterRoom(cleaned, standardRoomName);
  };

  const hasPendingUpdate =
    updateStatus?.availability === "updateAvailable" ||
    updateStatus?.availability === "downloadedReady";

  const avatarInitial = (sanitizeUsername(username) || "V").slice(0, 1).toUpperCase();

  return (
    <div className="ep-amethyst-canvas min-h-full w-full flex flex-col justify-between text-primary select-none">
      {/* Borderless frameless titlebar with floating profile & preferences pills */}
      <TitleBar
        leftSlot={
          editingName ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setEditingName(false);
              }}
              className="ep-glass-pill anim-pop-in inline-flex items-center gap-2 pl-1.5 pr-1.5 py-1 rounded-full"
            >
              <span className="h-6 w-6 rounded-full bg-accent text-white text-xs font-semibold flex items-center justify-center shrink-0">
                {avatarInitial}
              </span>
              <input
                type="text"
                autoFocus
                value={username}
                maxLength={32}
                placeholder="Your name"
                aria-label="Your display name"
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setEditingName(false);
                }}
                className="w-32 bg-transparent text-xs font-medium text-white placeholder:text-muted focus:outline-none"
              />
              <button
                type="submit"
                aria-label="Save display name"
                className="ep-press h-6 w-6 rounded-full bg-accent/30 hover:bg-accent/45 text-accent-soft flex items-center justify-center cursor-pointer"
              >
                <Check className="h-3.5 w-3.5" />
              </button>
            </form>
          ) : (
            <button
              type="button"
              onClick={() => setEditingName(true)}
              title="Click to change your display name"
              className="ep-glass-pill ep-press inline-flex items-center gap-2.5 pl-1.5 pr-3.5 py-1 rounded-full cursor-pointer"
            >
              <span className="h-6 w-6 rounded-full bg-accent text-white text-xs font-semibold flex items-center justify-center shrink-0">
                {avatarInitial}
              </span>
              <span className="text-xs font-medium text-primary max-w-[140px] truncate">
                {username || "Viewer"}
              </span>
              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            </button>
          )
        }
        rightActions={
          <>
            {hasPendingUpdate && updateStatus?.availableRelease && (
              <button
                type="button"
                onClick={() => openSettings("updates")}
                className="ep-glass-pill ep-press inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium text-accent-soft hover:text-white cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                <span>
                  {updateStatus.availability === "downloadedReady"
                    ? `Restart to v${updateStatus.availableRelease.version}`
                    : `Update v${updateStatus.availableRelease.version}`}
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={() => openSettings("prefs")}
              aria-label="Preferences"
              className="ep-glass-pill ep-press inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium text-secondary hover:text-white cursor-pointer"
            >
              <Settings className="h-3.5 w-3.5" />
              <span>Preferences</span>
            </button>
          </>
        }
      />

      {/* Centered IINA/Raycast-style single unified console (zero boxed cards) */}
      <main className="flex-1 flex flex-col items-center justify-center px-5 py-6">
        <div className="anim-fade-slide-up w-full max-w-[440px] flex flex-col items-center gap-6">
          <div className="flex flex-col items-center text-center gap-2.5">
            <LogoMark size={42} />
            <div className="space-y-1">
              <h1 className="text-[22px] font-semibold tracking-tight text-white">
                Epilod Party
              </h1>
              <p className="text-xs text-secondary">
                Watch local movies together in quiet, effortless sync
              </p>
            </div>
          </div>

          <div className="ep-glass-sheet w-full rounded-[24px] p-2.5 space-y-1.5">
            {/* Primary Action Row: Create Theater */}
            <button
              type="button"
              onClick={handleCreateRoom}
              className="ep-menu-row ep-press w-full px-3.5 py-3 flex items-center justify-between gap-3 text-left cursor-pointer group"
            >
              <div className="flex items-center gap-3.5 min-w-0">
                <span className="h-9 w-9 rounded-full bg-accent/25 text-accent-soft flex items-center justify-center shrink-0">
                  <Play className="h-4 w-4 fill-current ml-0.5" />
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-white">
                    Start a Private Theater
                  </div>
                  <div className="text-xs text-secondary truncate">
                    Create a room code and invite friends in one click
                  </div>
                </div>
              </div>
              <ChevronRight className="h-4 w-4 text-muted group-hover:text-accent-soft transition-colors shrink-0" />
            </button>

            <div className="ep-hairline-divider mx-3" />

            {/* Secondary Action Row: Join with Code */}
            <form onSubmit={handleJoinRoom} className="px-2 py-1.5 flex items-center gap-2">
              <input
                type="text"
                value={joinInput}
                aria-label={standardRoomName ? "Syncplay Room Name" : "Room Code"}
                placeholder={
                  standardRoomName
                    ? "Exact Syncplay room name…"
                    : "Enter or paste room code…"
                }
                onChange={(e) => {
                  setJoinInput(sanitizeRoomCodeInput(e.target.value, standardRoomName));
                  if (error) setError(null);
                }}
                className="ep-glass-input flex-1 h-10 px-3.5 rounded-xl text-sm text-primary placeholder:text-muted focus:outline-none min-w-0"
              />
              <button
                type="submit"
                className="ep-glass-primary-pill ep-press h-10 px-4 rounded-xl text-xs font-medium text-white inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
              >
                <span>Join</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </form>
          </div>

          {error && (
            <p role="alert" className="anim-pop-in text-xs text-bad text-center">
              {error}
            </p>
          )}

          {/* Quiet disclosure for optional room password or standard Syncplay naming */}
          <div className="w-full flex flex-col items-center gap-3">
            <button
              type="button"
              onClick={() => setShowOptions((o) => !o)}
              className="ep-press inline-flex items-center gap-1.5 text-xs text-muted hover:text-secondary cursor-pointer"
            >
              <KeyRound className="h-3 w-3" />
              <span>{showOptions ? "Hide room options" : "Room password & options"}</span>
            </button>

            {showOptions && (
              <div className="anim-fade-slide-up ep-glass-sheet w-full rounded-2xl p-3.5 space-y-3">
                <input
                  type="password"
                  value={serverPassword}
                  maxLength={128}
                  placeholder="Optional room password (kept only this session)"
                  aria-label="Room password"
                  onChange={(e) => setServerPassword(e.target.value)}
                  className="ep-glass-input w-full h-9.5 px-3.5 rounded-xl text-xs text-primary placeholder:text-muted focus:outline-none"
                />
                <label className="ep-menu-row flex items-center justify-between gap-3 px-2 py-1.5 text-xs text-secondary cursor-pointer">
                  <span>Use exact Syncplay room name</span>
                  <input
                    type="checkbox"
                    checked={standardRoomName}
                    onChange={(e) => {
                      const checked = e.target.checked;
                      setStandardRoomName(checked);
                      setJoinInput((prev) => sanitizeRoomCodeInput(prev, checked));
                    }}
                    className="accent-[var(--color-accent)] h-3.5 w-3.5"
                  />
                </label>
              </div>
            )}
          </div>
        </div>
      </main>

      <div className="h-4" aria-hidden="true" />
    </div>
  );
}
