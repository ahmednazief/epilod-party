import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppArrowIcon,
  AppDownloadIcon,
  AppEditIcon,
  AppKeyboardIcon,
  AppKeyIcon,
  AppResetIcon,
} from "./ui/AppIcons";
import {
  PartyCopyIcon,
  PartyPasteIcon,
  PlayerEpisodesIcon,
  PlayerPlayIcon,
  PlayerSettingsIcon,
} from "./ui/PlayerIcons";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isDesktop } from "../lib/bridge";
import { formatUserError } from "../lib/errors";
import { getFileDisplayName } from "../lib/fileDrop";
import { scanMediaPaths } from "../lib/playlist";
import { isTextEntryElement } from "../lib/shortcuts";
import { playSoundCue } from "../lib/soundEffects";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { sanitizeRoomCodeInput, sanitizeUsername } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import { TitleBar } from "./TitleBar";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import { ContextMenu, type ContextMenuEntry } from "./ui/ContextMenu";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { OpenMediaIcon, WatchPartyIcon } from "./ui/LobbyIcons";
import { LogoMark } from "./ui/LogoMark";
import { OtpCodeInput } from "./ui/OtpCodeInput";
import { AvatarPicker, ProfileAvatar } from "./ui/ProfileAvatar";

export function generateRoomCode(): string {
  const randomBytes = new Uint8Array(6);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(randomBytes);
  } else {
    for (let i = 0; i < 6; i++) {
      randomBytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(randomBytes)
    .map((b) => String(b % 10))
    .join("");
}

export function formatRoomCodeDisplay(code: string): string {
  const trimmed = code.trim();
  if (/^\d{6}$/.test(trimmed)) {
    return `${trimmed.slice(0, 3)} ${trimmed.slice(3, 6)}`;
  }
  return trimmed;
}

export function HomeScreen() {
  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const literalRoomStored = useAppStore((s) => s.literalRoom);
  const autoCheckUpdates = useAppStore((s) => s.autoCheckUpdates);
  const setUsername = useAppStore((s) => s.setUsername);
  const setAvatarId = useAppStore((s) => s.setAvatarId);
  const setServerPassword = useAppStore((s) => s.setServerPassword);
  const openSettings = useAppStore((s) => s.openSettings);
  const openShortcuts = useAppStore((s) => s.openShortcuts);
  const enterRoom = useAppStore((s) => s.enterRoom);
  const setSelectedFile = useAppStore((s) => s.setSelectedFile);

  const initUpdater = useUpdaterStore((s) => s.init);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);

  const [lobbyView, setLobbyView] = useState<"entry" | "party">("entry");
  const [draftRoomCode, setDraftRoomCode] = useState(() => generateRoomCode());
  const [copiedDraft, setCopiedDraft] = useState(false);
  const [joinInput, setJoinInput] = useState("");
  const [verifyingJoin, setVerifyingJoin] = useState(false);
  const [standardRoomName, setStandardRoomName] = useState(literalRoomStored);
  const [showOptions, setShowOptions] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingMedia, setOpeningMedia] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const verifyTimerRef = useRef<number | null>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const profilePopover = useAnimatedPresence(editingName, 170);
  const dragBanner = useAnimatedPresence(isDragActive, 170);

  useEffect(() => {
    if (!editingName) return;
    const onPointerDown = (e: MouseEvent) => {
      if (profileRef.current && !profileRef.current.contains(e.target as Node)) {
        setEditingName(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setEditingName(false);
      }
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [editingName]);

  useEffect(() => {
    return () => {
      if (verifyTimerRef.current !== null) {
        window.clearTimeout(verifyTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    void (async () => {
      await initUpdater();
      if (autoCheckUpdates) {
        await checkForUpdates(true);
      }
    })();
  }, [initUpdater, checkForUpdates, autoCheckUpdates]);

  useEffect(() => {
    if (!isDesktop()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    const bindDrop = async () => {
      try {
        const win = getCurrentWebviewWindow();
        const fn = await win.onDragDropEvent(async (event) => {
          if (disposed) return;
          const payload = event.payload;
          if (payload.type === "enter" || payload.type === "over") {
            setIsDragActive(true);
            return;
          }
          if (payload.type === "leave") {
            setIsDragActive(false);
            return;
          }
          if (payload.type === "drop") {
            setIsDragActive(false);
            const dropped = payload.paths || [];
            if (dropped.length === 0) return;
            const scan = await scanMediaPaths(dropped);
            if (scan.items.length > 0) {
              const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
              usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
              const target = scan.items[idx];
              setSelectedFile(target.path, target.fileName);
              enterRoom("", false);
            } else {
              setError("No playable video or season folder found in dropped items.");
            }
          }
        });
        if (disposed) fn();
        else unlisten = fn;
      } catch {
        // Ignore outside Tauri webview window
      }
    };

    void bindDrop();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enterRoom, setSelectedFile]);

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
      usePlaylistStore.getState().clearPlaylist();
      setSelectedFile(
        "C:\\Movies\\Cinema.Showcase.2026.2160p.HDR.mkv",
        "Cinema.Showcase.2026.2160p.HDR.mkv",
      );
      usePlayerStore.getState().setLoaded(true);
      usePlayerStore.getState().setPaused(false);
      enterRoom("", false);
      return;
    }
    setOpeningMedia(true);
    try {
      const chosen = await open({
        multiple: true,
        title: "Open Media File(s)",
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
              "mov",
              "m4v",
              "mpg",
              "mpeg",
              "vob",
              "*",
            ],
          },
        ],
      });
      const picked = Array.isArray(chosen)
        ? chosen
        : typeof chosen === "string" && chosen
          ? [chosen]
          : [];
      if (picked.length === 0) {
        return;
      }
      try {
        const scan = await scanMediaPaths(picked);
        if (scan.items.length > 0) {
          const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
          usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
          const target = scan.items[idx];
          setSelectedFile(target.path, target.fileName);
        } else {
          usePlaylistStore.getState().clearPlaylist();
          setSelectedFile(picked[0], getFileDisplayName(picked[0]));
        }
      } catch {
        usePlaylistStore.getState().clearPlaylist();
        setSelectedFile(picked[0], getFileDisplayName(picked[0]));
      }
      enterRoom("", false);
    } catch (err) {
      setError(formatUserError(err, "Could not open media file."));
    } finally {
      setOpeningMedia(false);
    }
  };

  const handleCopyDraft = async () => {
    try {
      await navigator.clipboard.writeText(draftRoomCode);
      setCopiedDraft(true);
      playSoundCue("codeCopied");
      setTimeout(() => setCopiedDraft(false), 1600);
    } catch {
      // Clipboard may be restricted outside secure focus
    }
  };

  const handleAutoVerifyOtp = (sixDigits: string) => {
    if (verifyingJoin) return;
    if (!ensureValidName()) return;
    const cleaned = sixDigits.replace(/\D/g, "").slice(0, 6);
    if (cleaned.length !== 6) return;
    setError(null);
    setVerifyingJoin(true);
    playSoundCue("codeCopied");
    if (verifyTimerRef.current !== null) {
      window.clearTimeout(verifyTimerRef.current);
    }
    verifyTimerRef.current = window.setTimeout(() => {
      verifyTimerRef.current = null;
      setVerifyingJoin(false);
      enterRoom(cleaned, false);
    }, 220);
  };

  const handlePasteJoin = async () => {
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip) return;
      if (standardRoomName) {
        setJoinInput(sanitizeRoomCodeInput(clip, true));
        if (error) setError(null);
        return;
      }
      const digits = clip.replace(/\D/g, "").slice(0, 6);
      if (!digits) {
        setError("Clipboard does not contain a 6-digit room code.");
        return;
      }
      setJoinInput(digits);
      if (error) setError(null);
      if (digits.length === 6) {
        handleAutoVerifyOtp(digits);
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
    if (cleaned.length < (standardRoomName ? 1 : 6)) {
      setError(
        standardRoomName
          ? "Enter the exact Syncplay room name to join."
          : "Enter all 6 digits of your friend's room code.",
      );
      return;
    }
    enterRoom(cleaned, standardRoomName);
  };

  const handleOpenFolderSolo = async () => {
    if (openingMedia) return;
    setError(null);
    if (!isDesktop()) {
      await handleOpenMediaSolo();
      return;
    }
    setOpeningMedia(true);
    try {
      const chosen = await open({
        directory: true,
        multiple: false,
        title: "Choose Season Folder",
      });
      if (typeof chosen !== "string" || !chosen) return;
      const scan = await scanMediaPaths([chosen]);
      if (scan.items.length > 0) {
        const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
        usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
        const target = scan.items[idx];
        setSelectedFile(target.path, target.fileName);
        enterRoom("", false);
      } else {
        setError("No playable video files found inside the selected folder.");
      }
    } catch (err) {
      setError(formatUserError(err, "Could not open season folder."));
    } finally {
      setOpeningMedia(false);
    }
  };

  const hasJoinCode = joinInput.trim().length > 0;

  const lobbyContextEntries: ContextMenuEntry[] = [
    {
      id: "open-media",
      label: "Open Media File(s)…",
      icon: <PlayerPlayIcon size={14} className="text-accent-soft" />,
      accent: true,
      onSelect: () => void handleOpenMediaSolo(),
    },
    {
      id: "open-folder",
      label: "Choose Season Folder…",
      icon: <PlayerEpisodesIcon size={14} />,
      onSelect: () => void handleOpenFolderSolo(),
    },
    {
      id: "party-view",
      label: lobbyView === "party" ? "Back to Main Lobby" : "Start or Join Watch Party",
      icon: <WatchPartyIcon bare size={14} />,
      onSelect: () => setLobbyView(lobbyView === "party" ? "entry" : "party"),
    },
    { type: "divider", id: "lobby-div" },
    {
      id: "edit-profile",
      label: "Edit Profile & Avatar",
      icon: <AppEditIcon size={14} />,
      onSelect: () => setEditingName(true),
    },
    {
      id: "check-updates",
      label: "Check for Updates…",
      icon: <AppDownloadIcon size={14} />,
      onSelect: () => openSettings("updates"),
    },
    {
      id: "shortcuts",
      label: "Keyboard Shortcuts…",
      shortcut: "?",
      icon: <AppKeyboardIcon size={14} />,
      onSelect: openShortcuts,
    },
    {
      id: "preferences",
      label: "Preferences…",
      icon: <PlayerSettingsIcon size={14} />,
      onSelect: () => openSettings("prefs"),
    },
  ];

  return (
    <div
      onContextMenu={(e) => {
        if (isTextEntryElement(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
      className="ep-amethyst-canvas relative h-full w-full overflow-y-auto overflow-x-hidden flex flex-col justify-between text-primary select-none"
    >
      {/* Subtle luminous contours behind glass surfaces so liquid lens distortion melts shapes cleanly */}
      <div className="pointer-events-none fixed inset-0 overflow-hidden z-0" aria-hidden="true">
        <div className="ep-ambient-orb-purple absolute left-[24%] top-[28%] h-72 w-72 rounded-full" />
        <div className="ep-ambient-orb-silver absolute right-[24%] top-[34%] h-72 w-72 rounded-full" />
      </div>

      {/* Borderless frameless titlebar with floating profile & preferences pills */}
      <div ref={profileRef} className="relative z-20">
        <TitleBar
          onOpenUpdates={() => openSettings("updates")}
          leftSlot={
            <button
              type="button"
              onClick={() => setEditingName((v) => !v)}
              title="Edit your display name and profile avatar"
              aria-expanded={editingName}
              className={`ep-glass-pill ep-press inline-flex items-center gap-2.5 pl-1.5 pr-3 py-1 rounded-full cursor-pointer ${
                editingName ? "ring-1 ring-accent/65" : ""
              }`}
            >
              <ProfileAvatar avatarId={avatarId} size={24} className="ring-1 ring-white/20" />
              <span className="text-xs font-medium text-primary max-w-[140px] truncate">
                {username || "Viewer"}
              </span>
              <AppEditIcon size={12} className="text-accent-soft opacity-85" />
            </button>
          }
          rightActions={
            <button
              type="button"
              onClick={() => openSettings("prefs")}
              aria-label="Preferences"
              className="ep-glass-pill ep-press inline-flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium text-secondary hover:text-white cursor-pointer"
            >
              <PlayerSettingsIcon size={14} />
              <span>Preferences</span>
            </button>
          }
        />

        {profilePopover.mounted && (
          <div
            role="dialog"
            aria-label="Edit profile and avatar"
            className={`ep-glass-sheet ${
              profilePopover.exiting ? "anim-pop-out pointer-events-none" : "anim-pop-in"
            } absolute left-4 top-12 z-50 w-[368px] max-w-[calc(100vw-2rem)] rounded-[24px] p-4 space-y-3.5`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <ProfileAvatar
                  avatarId={avatarId}
                  size={38}
                  className="ring-2 ring-accent/60 shadow-[0_6px_18px_rgba(124,58,237,0.35)]"
                />
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white truncate">
                    {username || "Viewer"}
                  </div>
                  <div className="text-[11px] text-secondary">
                    Customize how friends see you
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditingName(false)}
                className="ep-press h-7 px-3 rounded-full text-[11px] font-semibold bg-accent/18 hover:bg-accent/28 text-accent-soft hover:text-white cursor-pointer"
              >
                Done
              </button>
            </div>

            <label className="block space-y-1.5">
              <span className="text-[11px] font-medium text-secondary">
                Display Name
              </span>
              <input
                type="text"
                autoFocus
                value={username}
                maxLength={32}
                placeholder="Enter your name..."
                aria-label="Your display name"
                onChange={(e) => {
                  setUsername(e.target.value);
                  if (error) setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "Escape") {
                    e.preventDefault();
                    setEditingName(false);
                  }
                }}
                className="ep-glass-input w-full h-9 px-3 rounded-xl text-xs text-primary placeholder:text-muted focus:outline-none"
              />
            </label>

            <AvatarPicker value={avatarId} onChange={setAvatarId} compact />
          </div>
        )}
      </div>

      {/* Main Centered Lobby */}
      <main className="relative z-10 flex-1 flex flex-col items-center justify-center px-5 py-6">
        {lobbyView === "entry" ? (
          <div key="entry" className="anim-fade-slide-up flex flex-col items-center gap-6">
            <div className="flex flex-col items-center text-center gap-2.5">
              <LogoMark size={46} />
              <div className="space-y-1">
                <h1 className="text-xl font-semibold tracking-tight text-white">
                  Epilod Party
                </h1>
                <p className="text-xs text-secondary">
                  Watch a movie solo or in sync with friends
                </p>
              </div>
            </div>

            {/* Strictly 2 sleek differentiated Liquid Glass pill buttons */}
            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                type="button"
                onClick={() => {
                  setDraftRoomCode(generateRoomCode());
                  setError(null);
                  setLobbyView("party");
                }}
                className="group ep-glass-btn-party ep-press h-11 pl-3 pr-5 rounded-full inline-flex items-center gap-2.5 text-[13px] font-medium text-white cursor-pointer"
              >
                <WatchPartyIcon size={24} className="shrink-0 transition-transform duration-200 group-hover:scale-105" />
                <span>Watch Party</span>
              </button>

              <button
                type="button"
                disabled={openingMedia}
                onClick={() => void handleOpenMediaSolo()}
                className="group ep-glass-btn-media ep-press h-11 pl-3 pr-5 rounded-full inline-flex items-center gap-2.5 text-[13px] font-medium text-primary hover:text-white cursor-pointer disabled:opacity-60"
              >
                <OpenMediaIcon size={24} className="shrink-0 transition-transform duration-200 group-hover:scale-105" />
                <span>{openingMedia ? "Opening..." : "Open Media"}</span>
              </button>
            </div>
          </div>
        ) : (
          <div key="party" className="anim-fade-slide-up w-full max-w-[440px] flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => {
                  if (verifyTimerRef.current !== null) {
                    window.clearTimeout(verifyTimerRef.current);
                    verifyTimerRef.current = null;
                  }
                  setVerifyingJoin(false);
                  setLobbyView("entry");
                  setError(null);
                }}
                className="ep-glass-pill ep-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium text-secondary hover:text-white cursor-pointer"
              >
                <AppArrowIcon direction="left" size={14} />
                <span>Back</span>
              </button>

              <div className="inline-flex items-center gap-2 text-xs text-secondary">
                <WatchPartyIcon size={18} className="shrink-0" />
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
                      6-digit invite pass ready to share
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-1 rounded-full bg-white/[0.06] pl-3 pr-1 py-1 shrink-0">
                    <span className="num text-xs font-semibold text-accent-soft tracking-[0.16em]">
                      {formatRoomCodeDisplay(draftRoomCode)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDraftRoomCode(generateRoomCode())}
                      aria-label="Shuffle room code"
                      title="Generate new 6-digit code"
                      className="ep-press h-6 w-6 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer"
                    >
                      <AppResetIcon clockwise size={12} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyDraft()}
                      aria-label="Copy room code"
                      title="Copy 6-digit code"
                      className="ep-press h-6 w-6 rounded-full flex items-center justify-center text-secondary hover:text-white hover:bg-white/10 cursor-pointer"
                    >
                      <PartyCopyIcon copied={copiedDraft} size={13} />
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={handleCreateRoom}
                  className="ep-glass-primary-pill ep-press w-full h-10 rounded-2xl text-xs font-medium text-white inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <span>Create Room &amp; Copy Invite</span>
                  <AppArrowIcon direction="right" size={14} />
                </button>
              </div>

              {/* Join Friend's Room well */}
              <div className="ep-glass-well rounded-[20px] p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-medium text-white">
                      {standardRoomName ? "Join Syncplay Room" : "Join with 6-Digit Code"}
                    </div>
                    <div className={`text-[11px] ${verifyingJoin ? "text-ok font-medium" : "text-secondary"}`}>
                      {standardRoomName
                        ? "Enter the exact room name your friends use"
                        : verifyingJoin
                          ? "Verifying 6-digit code…"
                          : "Type or paste all 6 digits to enter right away"}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void handlePasteJoin()}
                    className="ep-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/[0.07] hover:bg-white/[0.12] text-[11px] font-medium text-secondary hover:text-white cursor-pointer shrink-0"
                  >
                    <PartyPasteIcon size={13} />
                    <span>Paste Code</span>
                  </button>
                </div>

                {standardRoomName ? (
                  <form onSubmit={handleJoinRoom} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={joinInput}
                      aria-label="Syncplay Room Name"
                      placeholder="Exact Syncplay room name…"
                      onChange={(e) => {
                        setJoinInput(sanitizeRoomCodeInput(e.target.value, true));
                        if (error) setError(null);
                      }}
                      className="ep-glass-input flex-1 h-10 px-3.5 rounded-xl text-sm num tracking-wide text-primary placeholder:tracking-normal placeholder:text-muted focus:outline-none min-w-0"
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
                      <AppArrowIcon direction="right" size={14} />
                    </button>
                  </form>
                ) : (
                  <OtpCodeInput
                    value={joinInput}
                    verifying={verifyingJoin}
                    onChange={(digits) => {
                      setJoinInput(digits);
                      if (error) setError(null);
                    }}
                    onComplete={handleAutoVerifyOtp}
                  />
                )}
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
                aria-expanded={showOptions}
                onClick={() => setShowOptions((o) => !o)}
                className="ep-press inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs text-muted hover:text-secondary hover:bg-white/[0.06] cursor-pointer"
              >
                <AppKeyIcon size={12} />
                <span>{showOptions ? "Hide room options" : "Room password & options"}</span>
              </button>

              <AnimatedCollapse open={showOptions} className="w-full" innerClassName="pt-0.5">
                <div className="ep-glass-sheet w-full rounded-[22px] p-3.5 space-y-2.5">
                  <input
                    type="password"
                    value={serverPassword}
                    maxLength={128}
                    placeholder="Optional room password (kept only this session)"
                    aria-label="Room password"
                    onChange={(e) => setServerPassword(e.target.value)}
                    className="ep-glass-input w-full h-9.5 px-3.5 rounded-xl text-xs text-primary placeholder:text-muted focus:outline-none"
                  />
                  <button
                    type="button"
                    role="switch"
                    aria-checked={standardRoomName}
                    onClick={() => {
                      const checked = !standardRoomName;
                      setStandardRoomName(checked);
                      setVerifyingJoin(false);
                      setJoinInput((prev) =>
                        checked
                          ? sanitizeRoomCodeInput(prev, true)
                          : prev.replace(/\D/g, "").slice(0, 6),
                      );
                    }}
                    className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs text-secondary hover:text-white cursor-pointer"
                  >
                    <span>Use exact Syncplay room name</span>
                    <GlassSwitchTrack checked={standardRoomName} size="sm" />
                  </button>
                </div>
              </AnimatedCollapse>
            </div>
          </div>
        )}
      </main>

      <div className="h-4 relative z-10" aria-hidden="true" />

      {dragBanner.mounted && (
        <div
          role="status"
          className={`ep-glass-sheet ${
            dragBanner.exiting ? "anim-pop-out" : "anim-pop-in"
          } pointer-events-none fixed bottom-7 left-1/2 -translate-x-1/2 z-40 rounded-full px-5 py-2.5 flex items-center gap-2.5 border border-accent/55`}
        >
          <OpenMediaIcon size={20} className="shrink-0" />
          <span className="text-xs font-medium text-white">
            Drop a video or full season folder to open
          </span>
        </div>
      )}

      <ContextMenu
        position={contextMenu}
        entries={lobbyContextEntries}
        onClose={() => setContextMenu(null)}
      />
    </div>
  );
}
