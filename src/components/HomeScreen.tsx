import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ClipboardPaste,
  Copy,
  Download,
  Film,
  KeyRound,
  RefreshCw,
  Settings,
  Users,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { isDesktop } from "../lib/bridge";
import { getFileDisplayName } from "../lib/fileDrop";
import { sanitizeRoomCodeInput, sanitizeUsername } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import { TitleBar } from "./TitleBar";
import { LogoMark } from "./ui/LogoMark";

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
  const openSettings = useAppStore((s) => s.openSettings);
  const enterRoom = useAppStore((s) => s.enterRoom);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);

  const updateStatus = useUpdaterStore((s) => s.status);
  const initUpdater = useUpdaterStore((s) => s.init);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);

  const [lobbyView, setLobbyView] = useState<"entry" | "party">("entry");
  const [draftRoomCode, setDraftRoomCode] = useState(() => generateRoomCode());
  const [copiedDraft, setCopiedDraft] = useState(false);
  const [joinInput, setJoinInput] = useState("");
  const [standardRoomName, setStandardRoomName] = useState(literalRoomStored);
  const [showOptions, setShowOptions] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingMedia, setOpeningMedia] = useState(false);

  useEffect(() => {
    void (async () => {
      await initUpdater();
      if (autoCheckUpdates) {
        await checkForUpdates(true);
      }
    })();
  }, [initUpdater, checkForUpdates, autoCheckUpdates]);

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

  const handleOpenMediaSolo = async () => {
    if (openingMedia) return;
    setError(null);
    if (!isDesktop()) {
      enterRoom("", false);
      return;
    }
    setOpeningMedia(true);
    try {
      const chosen = await open({
        multiple: false,
        title: "Open Media File",
        filters: [
          {
            name: "Video Files",
            extensions: [
              "mkv",
              "mp4",
              "ts",
              "m2ts",
              "avi",
              "webm",
              "flv",
              "wmv",
              "ogv",
              "3gp",
              "*",
            ],
          },
        ],
      });
      if (typeof chosen === "string" && chosen) {
        setSelectedFile(chosen, getFileDisplayName(chosen));
        enterRoom("", false);
      }
    } catch {
      enterRoom("", false);
    } finally {
      setOpeningMedia(false);
    }
  };

  const handleCopyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draftRoomCode);
      setCopiedDraft(true);
      setTimeout(() => setCopiedDraft(false), 1600);
    } catch {
      // Clipboard may be restricted outside secure focus
    }
  };

  const handlePasteJoin = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (clip) {
        setJoinInput(sanitizeRoomCodeInput(clip, standardRoomName));
        if (error) setError(null);
      }
    } catch {
      // Ignore clipboard read error
    }
  };

  const handleCreateRoom = () => {
    if (!ensureValidName()) return;
    try {
      void navigator.clipboard?.writeText(draftRoomCode).catch(() => undefined);
    } catch {
      // ignore
    }
    enterRoom(draftRoomCode, false);
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
  const hasJoinCode = joinInput.trim().length > 0;

  return (
    <div className="ep-amethyst-canvas min-h-full w-full flex flex-col justify-between text-primary select-none">
      {/* Subtle luminous contours behind glass surfaces so liquid lens distortion melts shapes cleanly */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0" aria-hidden="true">
        <div className="ep-ambient-orb-purple absolute left-[24%] top-[28%] h-72 w-72 rounded-full" />
        <div className="ep-ambient-orb-silver absolute right-[24%] top-[34%] h-72 w-72 rounded-full" />
      </div>

      {/* Borderless frameless titlebar with floating profile & preferences pills */}
      <div className="relative z-10">
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
                  className="ep-press h-6 w-6 rounded-full bg-accent/35 hover:bg-accent/55 text-accent-soft flex items-center justify-center cursor-pointer"
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
      </div>

      {/* Main Centered Lobby */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-5 py-6">
        {lobbyView === "entry" ? (
          <div className="anim-fade-slide-up w-full max-w-[460px] flex flex-col items-center gap-7">
            <div className="flex flex-col items-center text-center gap-2.5">
              <LogoMark size={44} />
              <div className="space-y-1">
                <h1 className="text-[22px] font-semibold tracking-tight text-white">
                  Epilod Party
                </h1>
                <p className="text-xs text-secondary">
                  Private cinema on your desktop — watch solo or in effortless sync
                </p>
              </div>
            </div>

            {/* Strictly 2 differentiated Liquid Glass buttons */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full">
              <button
                type="button"
                onClick={() => {
                  setDraftRoomCode(generateRoomCode());
                  setError(null);
                  setLobbyView("party");
                }}
                className="ep-glass-btn-party ep-press rounded-[26px] p-5 text-left flex flex-col justify-between min-h-[146px] cursor-pointer group"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="h-10 w-10 rounded-2xl bg-accent/28 text-accent-soft flex items-center justify-center">
                    <Users className="h-5 w-5" />
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full bg-accent/25 text-accent-soft text-[10px] font-semibold tracking-wider uppercase">
                    Sync
                  </span>
                </div>
                <div className="space-y-1 pt-5">
                  <div className="text-[15px] font-semibold text-white">
                    Watch Party
                  </div>
                  <p className="text-xs text-secondary leading-relaxed">
                    Create a room or enter a friend&apos;s code
                  </p>
                </div>
              </button>

              <button
                type="button"
                disabled={openingMedia}
                onClick={() => void handleOpenMediaSolo()}
                className="ep-glass-btn-media ep-press rounded-[26px] p-5 text-left flex flex-col justify-between min-h-[146px] cursor-pointer disabled:opacity-60 group"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="h-10 w-10 rounded-2xl bg-white/10 text-white flex items-center justify-center">
                    <Film className="h-5 w-5" />
                  </span>
                  <span className="px-2.5 py-0.5 rounded-full bg-white/10 text-secondary text-[10px] font-semibold tracking-wider uppercase">
                    Player
                  </span>
                </div>
                <div className="space-y-1 pt-5">
                  <div className="text-[15px] font-semibold text-white">
                    {openingMedia ? "Opening..." : "Open Media"}
                  </div>
                  <p className="text-xs text-secondary leading-relaxed">
                    Pick a movie or video file and play locally
                  </p>
                </div>
              </button>
            </div>
          </div>
        ) : (
          <div className="anim-fade-slide-up w-full max-w-[440px] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  setLobbyView("entry");
                  setError(null);
                }}
                className="ep-glass-pill ep-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-secondary hover:text-white cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back</span>
              </button>

              <div className="inline-flex items-center gap-2 text-xs text-secondary">
                <Users className="h-3.5 w-3.5 text-accent-soft" />
                <span className="font-medium text-white">Watch Party</span>
              </div>
            </div>

            <div className="ep-glass-sheet w-full rounded-[28px] p-3.5 space-y-3">
              {/* Instant Host Room Pass well */}
              <div className="ep-glass-well rounded-[20px] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-white">Host a New Room</div>
                    <div className="text-[11px] text-secondary">
                      Instant invite pass ready to share
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] pl-2.5 pr-1 py-1 shrink-0">
                    <span className="font-mono text-[11px] font-medium text-accent-soft tracking-wide">
                      {draftRoomCode}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDraftRoomCode(generateRoomCode())}
                      aria-label="Shuffle room code"
                      title="Generate new code"
                      className="ep-press h-6 w-6 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyDraft()}
                      aria-label="Copy room code"
                      title="Copy invite code"
                      className="ep-press h-6 w-6 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer"
                    >
                      {copiedDraft ? (
                        <Check className="h-3 w-3 text-ok" />
                      ) : (
                        <Copy className="h-3 w-3" />
                      )}
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCreateRoom}
                  className="ep-glass-primary-pill ep-press w-full h-10 rounded-2xl text-xs font-medium text-white inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <span>Create Room &amp; Copy Invite</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              </div>

              {/* Join Friend's Room well */}
              <div className="ep-glass-well rounded-[20px] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-medium text-white">
                    Join a Friend&apos;s Room
                  </div>
                  <button
                    type="button"
                    onClick={() => void handlePasteJoin()}
                    className="ep-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.07] hover:bg-white/[0.12] text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
                  >
                    <ClipboardPaste className="h-3 w-3" />
                    <span>Paste Code</span>
                  </button>
                </div>

                <form onSubmit={handleJoinRoom} className="flex items-center gap-2">
                  <input
                    type="text"
                    value={joinInput}
                    aria-label={standardRoomName ? "Syncplay Room Name" : "Room Code"}
                    placeholder={
                      standardRoomName ? "Exact Syncplay room name…" : "XXXX-XXXX-XXXX"
                    }
                    onChange={(e) => {
                      setJoinInput(sanitizeRoomCodeInput(e.target.value, standardRoomName));
                      if (error) setError(null);
                    }}
                    className="ep-glass-input flex-1 h-10 px-3.5 rounded-xl text-sm font-mono tracking-wider text-primary placeholder:font-sans placeholder:tracking-normal placeholder:text-muted focus:outline-none min-w-0"
                  />
                  <button
                    type="submit"
                    className={`ep-press h-10 px-4 rounded-xl text-xs font-medium inline-flex items-center gap-1.5 shrink-0 cursor-pointer ${
                      hasJoinCode
                        ? "ep-glass-primary-pill text-white"
                        : "bg-white/[0.08] text-secondary hover:text-white hover:bg-white/[0.14]"
                    }`}
                  >
                    <span>Join</span>
                    <ArrowRight className="h-3.5 w-3.5" />
                  </button>
                </form>
              </div>
            </div>

            {error && (
              <p role="alert" className="anim-pop-in text-xs text-bad text-center">
                {error}
              </p>
            )}

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
                <div className="anim-fade-slide-up ep-glass-sheet w-full rounded-[22px] p-3.5 space-y-2.5">
                  <input
                    type="password"
                    value={serverPassword}
                    maxLength={128}
                    placeholder="Optional room password (kept only this session)"
                    aria-label="Room password"
                    onChange={(e) => setServerPassword(e.target.value)}
                    className="ep-glass-input w-full h-9.5 px-3.5 rounded-xl text-xs text-primary placeholder:text-muted focus:outline-none"
                  />
                  <label className="ep-menu-row flex items-center justify-between gap-3 px-2.5 py-1.5 text-xs text-secondary cursor-pointer">
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
        )}
      </main>

      <div className="h-4 relative z-10" aria-hidden="true" />
    </div>
  );
}
