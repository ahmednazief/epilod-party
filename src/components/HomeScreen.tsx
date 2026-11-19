import { Lock, Pin, X } from "lucide-react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AppArrowIcon,
  AppChevronIcon,
  AppDownloadIcon,
  AppEditIcon,
  AppKeyboardIcon,
  AppKeyIcon,
  AppLogsIcon,
  AppResetIcon,
  AppSlidersIcon,
  AppSparkleIcon,
} from "./ui/AppIcons";
import { MenuMediaDiscIcon } from "./ui/MenuIcons";
import {
  PartyCopyIcon,
  PartyHostIcon,
  PartyPasteIcon,
  PlayerEpisodesIcon,
  PlayerSettingsIcon,
} from "./ui/PlayerIcons";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { isDesktop } from "../lib/bridge";
import { formatUserError } from "../lib/errors";
import { getFileDisplayName } from "../lib/fileDrop";
import { scanMediaPaths } from "../lib/playlist";
import {
  buildSeriesKey,
  extractParentFolderPath,
  pickInitialSeriesIndex,
  type SeriesProgressEntry,
} from "../lib/seriesProgress";
import { isTextEntryElement } from "../lib/shortcuts";
import { playSoundCue } from "../lib/soundEffects";
import { DEFAULT_ENDPOINT } from "../lib/syncStatusDisplay";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { sanitizeRoomCodeInput, sanitizeUsername } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import {
  normalizeRecentServerHost,
  useRecentRoomsStore,
  type RecentRoomEntry,
} from "../store/useRecentRoomsStore";
import { useSeriesProgressStore } from "../store/useSeriesProgressStore";
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
  const digits: string[] = [];
  const randomBytes = new Uint8Array(16);
  while (digits.length < 6) {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(randomBytes);
    } else {
      for (let i = 0; i < randomBytes.length; i++) {
        randomBytes[i] = Math.floor(Math.random() * 256);
      }
    }
    for (const b of randomBytes) {
      if (b < 250) {
        digits.push(String(b % 10));
        if (digits.length === 6) break;
      }
    }
  }
  return digits.join("");
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
  const setServerEndpoint = useAppStore((s) => s.setServerEndpoint);
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
  const [hostOnlyCreate, setHostOnlyCreate] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [openingMedia, setOpeningMedia] = useState(false);
  const [isDragActive, setIsDragActive] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [editingRoomId, setEditingRoomId] = useState<string | null>(null);
  const [editingRoomNickname, setEditingRoomNickname] = useState("");
  const [passwordRoomId, setPasswordRoomId] = useState<string | null>(null);
  const [pendingRecentHostOnly, setPendingRecentHostOnly] = useState(false);
  const [missingSeriesKey, setMissingSeriesKey] = useState<string | null>(null);
  const verifyTimerRef = useRef<number | null>(null);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const recentRooms = useRecentRoomsStore((s) => s.rooms);
  const recentRoomsStorageError = useRecentRoomsStore((s) => s.storageError);
  const togglePinRecentRoom = useRecentRoomsStore((s) => s.togglePin);
  const setRecentRoomNickname = useRecentRoomsStore((s) => s.setNickname);
  const removeRecentRoom = useRecentRoomsStore((s) => s.removeRoom);
  const seriesMap = useSeriesProgressStore((s) => s.series);
  const relocateSeriesFolder = useSeriesProgressStore((s) => s.relocateSeriesFolder);
  const continueSeriesList = Object.values(seriesMap)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3);
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

  const handleContinueSeries = async (entry: SeriesProgressEntry) => {
    setError(null);
    setMissingSeriesKey(null);
    try {
      const scan = await scanMediaPaths([entry.folderPath]);
      if (scan.items.length === 0) {
        setMissingSeriesKey(entry.seriesKey);
        return;
      }
      const idx = pickInitialSeriesIndex(scan.items, entry);
      usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName || entry.folderName);
      const target = scan.items[idx];
      setSelectedFile(target.path, target.fileName);
      enterRoom("", false, false);
    } catch {
      setMissingSeriesKey(entry.seriesKey);
    }
  };

  const handleLocateSeriesFolder = async (entry: SeriesProgressEntry) => {
    if (!isDesktop()) return;
    try {
      const picked = await open({
        directory: true,
        multiple: false,
        title: `Locate "${entry.folderName}"`,
      });
      const dir = typeof picked === "string" ? picked : null;
      if (!dir) return;
      const scan = await scanMediaPaths([dir]);
      if (scan.items.length === 0) {
        setError("No video files found in that folder.");
        return;
      }
      const newKey = relocateSeriesFolder(entry.seriesKey, dir, scan.folderName || entry.folderName);
      const updated = newKey ? useSeriesProgressStore.getState().getSeries(newKey) : entry;
      setMissingSeriesKey(null);
      const idx = pickInitialSeriesIndex(scan.items, updated);
      usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName || entry.folderName);
      const target = scan.items[idx];
      setSelectedFile(target.path, target.fileName);
      enterRoom("", false, false);
    } catch (err) {
      setError(formatUserError(err));
    }
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
      enterRoom("", false, false);
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
      enterRoom(cleaned, false, false);
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
    enterRoom(draftRoomCode, false, hostOnlyCreate, true);
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
    const hostOnly = Boolean(passwordRoomId && pendingRecentHostOnly);
    setPasswordRoomId(null);
    setPendingRecentHostOnly(false);
    enterRoom(cleaned, standardRoomName, hostOnly);
  };

  const handleJoinRecentRoom = (room: RecentRoomEntry) => {
    if (!ensureValidName()) return;
    setError(null);
    setServerEndpoint(room.serverHost);
    setStandardRoomName(room.literalRoom);
    setJoinInput(room.roomName);
    const hostOnly = Boolean(room.hostOnly);

    if (!room.hasPassword) {
      setServerPassword("");
      setPasswordRoomId(null);
      setPendingRecentHostOnly(false);
      enterRoom(room.roomName, room.literalRoom, hostOnly);
      return;
    }

    if (passwordRoomId !== room.id || !serverPassword) {
      if (passwordRoomId !== room.id) {
        setServerPassword("");
      }
      setPasswordRoomId(room.id);
      setPendingRecentHostOnly(hostOnly);
      setShowOptions(true);
      setError("Enter the room password to join.");
      window.setTimeout(() => {
        passwordInputRef.current?.focus();
      }, 80);
      return;
    }

    setPasswordRoomId(null);
    setPendingRecentHostOnly(false);
    enterRoom(room.roomName, room.literalRoom, hostOnly);
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
        let idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
        if (useAppStore.getState().trackWatchedEpisodes) {
          const folderPath = extractParentFolderPath(scan.items[0].path);
          const saved = folderPath
            ? useSeriesProgressStore.getState().getSeries(buildSeriesKey(folderPath))
            : null;
          if (saved) {
            idx = pickInitialSeriesIndex(scan.items, saved);
          }
        }
        usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
        const target = scan.items[idx];
        setSelectedFile(target.path, target.fileName);
        enterRoom("", false, false);
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
      type: "label",
      id: "lobby-lbl-watch",
      text: "Quick Start",
    },
    {
      id: "open-media",
      label: "Open Media File(s)…",
      icon: <MenuMediaDiscIcon size={14} className="text-accent-soft" />,
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
      type: "label",
      id: "lobby-lbl-app",
      text: "System",
    },
    {
      id: "edit-profile",
      label: "Edit Profile & Avatar",
      icon: <AppEditIcon size={14} />,
      onSelect: () => setEditingName(true),
    },
    {
      type: "submenu",
      id: "lobby-sub-prefs",
      label: "Settings & Help",
      icon: <PlayerSettingsIcon size={14} />,
      children: [
        {
          id: "preferences",
          label: "Preferences…",
          icon: <AppSparkleIcon size={14} className="text-accent-soft" />,
          onSelect: () => openSettings("prefs"),
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
        { type: "divider", id: "lobby-prefs-div" },
        {
          id: "server-settings",
          label: "Connection & Server…",
          icon: <AppSlidersIcon size={14} />,
          onSelect: () => openSettings("server"),
        },
        {
          id: "diagnostics",
          label: "Session Diagnostics…",
          icon: <AppLogsIcon size={14} />,
          onSelect: () => openSettings("logs"),
        },
      ],
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
              className={`ep-glass-pill ep-press h-8 inline-flex items-center gap-2.5 pl-[3px] pr-3 rounded-full cursor-pointer ${
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
            } absolute left-4 top-12 z-50 w-[368px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4rem)] overflow-hidden rounded-[24px] py-4 flex flex-col`}
          >
            <div className="ep-menu-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 space-y-3.5">
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
                  className="ep-glass-pill-active ep-press h-7 px-3 rounded-full text-[11px] font-semibold text-white cursor-pointer"
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
                className="ep-glass-btn-party ep-press h-11 pl-3 pr-5 rounded-full inline-flex items-center gap-2.5 text-[13px] font-medium text-white cursor-pointer"
              >
                <WatchPartyIcon size={24} className="shrink-0" />
                <span>Watch Party</span>
              </button>

              <button
                type="button"
                disabled={openingMedia}
                onClick={() => void handleOpenMediaSolo()}
                className="ep-glass-btn-media ep-press h-11 pl-3 pr-5 rounded-full inline-flex items-center gap-2.5 text-[13px] font-medium text-primary hover:text-white cursor-pointer disabled:opacity-60"
              >
                <OpenMediaIcon size={24} className="shrink-0" />
                <span>{openingMedia ? "Opening..." : "Open Media"}</span>
              </button>
            </div>

            {continueSeriesList.length > 0 && (
              <div className="w-full max-w-[440px] ep-glass-sheet rounded-[20px] p-3.5 space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted px-1">
                  Continue watching
                </div>
                <div className="space-y-1.5">
                  {continueSeriesList.map((entry) => {
                    const isMissing = missingSeriesKey === entry.seriesKey;
                    return (
                      <div
                        key={entry.seriesKey}
                        className="ep-menu-row rounded-xl px-3 py-2 flex items-center justify-between gap-2.5 text-xs"
                      >
                        <button
                          type="button"
                          onClick={() => void handleContinueSeries(entry)}
                          className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                        >
                          <PlayerEpisodesIcon size={15} className="text-accent-soft shrink-0" />
                          <span className="truncate font-medium text-white">
                            {entry.folderName}
                          </span>
                          {entry.lastEpisodeKey && (
                            <span className="px-1.5 py-0.5 rounded-full bg-white/[0.08] text-[10px] text-secondary num shrink-0">
                              {entry.lastEpisodeKey}
                            </span>
                          )}
                        </button>
                        {isMissing && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[11px] text-warn">Folder not found</span>
                            <button
                              type="button"
                              onClick={() => void handleLocateSeriesFolder(entry)}
                              className="ep-press px-2 py-1 rounded-lg bg-white/[0.1] hover:bg-white/[0.16] text-[11px] text-white cursor-pointer"
                            >
                              Locate folder
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
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

            <div className="ep-glass-sheet w-full rounded-[24px] p-5 space-y-6">
              {/* Instant Host Room Pass */}
              <section aria-label="Host a New Room" className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">Host a New Room</div>
                    <div className="text-[11px] text-secondary">
                      6-digit invite pass ready to share
                    </div>
                  </div>
                  <div className="inline-flex items-center gap-0.5 shrink-0">
                    <span className="num text-[13px] font-semibold text-accent-soft tracking-[0.16em] pr-1.5 select-all">
                      {formatRoomCodeDisplay(draftRoomCode)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setDraftRoomCode(generateRoomCode())}
                      aria-label="Shuffle room code"
                      title="Generate new 6-digit code"
                      className="ep-press h-7 w-7 rounded-lg flex items-center justify-center text-secondary hover:text-white hover:bg-white/[0.08] cursor-pointer"
                    >
                      <AppResetIcon clockwise size={13} />
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleCopyDraft()}
                      aria-label="Copy room code"
                      title="Copy 6-digit code"
                      className="ep-press h-7 w-7 rounded-lg flex items-center justify-center text-secondary hover:text-white hover:bg-white/[0.08] cursor-pointer"
                    >
                      <PartyCopyIcon copied={copiedDraft} size={13} />
                    </button>
                  </div>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={hostOnlyCreate}
                  onClick={() => setHostOnlyCreate((prev) => !prev)}
                  className="ep-menu-row ep-press -mx-2.5 w-[calc(100%+1.25rem)] flex items-center justify-between gap-3 px-2.5 py-2 text-left cursor-pointer"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <PartyHostIcon size={14} className="shrink-0 text-secondary" />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-white">
                        Only host can control
                      </div>
                      <div className="text-[11px] text-secondary leading-snug">
                        You control playback unless you make someone admin
                      </div>
                    </div>
                  </div>
                  <GlassSwitchTrack checked={hostOnlyCreate} size="sm" />
                </button>

                <button
                  type="button"
                  onClick={handleCreateRoom}
                  className="ep-glass-primary-pill ep-press w-full h-10 rounded-full text-xs font-medium text-white inline-flex items-center justify-center gap-2 cursor-pointer"
                >
                  <span>Create Room &amp; Copy Invite</span>
                  <AppArrowIcon direction="right" size={14} />
                </button>
              </section>

              {/* Join Friend's Room */}
              <section
                aria-label={standardRoomName ? "Join Syncplay Room" : "Join with 6-Digit Code"}
                className="space-y-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">
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
                    className="ep-press -mr-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-secondary hover:text-white hover:bg-white/[0.08] cursor-pointer shrink-0"
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
                        setPasswordRoomId(null);
                        setPendingRecentHostOnly(false);
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
                      setPasswordRoomId(null);
                      setPendingRecentHostOnly(false);
                      if (error) setError(null);
                    }}
                    onComplete={handleAutoVerifyOtp}
                  />
                )}
              </section>

              <div>
                <button
                  type="button"
                  aria-expanded={showOptions}
                  onClick={() => setShowOptions((o) => !o)}
                  className="ep-menu-row ep-press -mx-2.5 w-[calc(100%+1.25rem)] flex items-center justify-between gap-2 px-2.5 py-1.5 text-xs text-muted hover:text-secondary cursor-pointer"
                >
                  <span className="inline-flex items-center gap-2">
                    <AppKeyIcon size={12} />
                    <span>{showOptions ? "Hide room options" : "Room password & options"}</span>
                  </span>
                  <AppChevronIcon
                    direction="right"
                    size={12}
                    className={`transition-transform duration-150 ${showOptions ? "rotate-90 text-secondary" : ""}`}
                  />
                </button>

                <AnimatedCollapse open={showOptions} className="-mx-2.5" innerClassName="pt-2.5 pb-0.5 space-y-2">
                  <form onSubmit={handleJoinRoom} className="px-2.5 flex items-center gap-2">
                    <input
                      ref={passwordInputRef}
                      type="password"
                      value={serverPassword}
                      maxLength={128}
                      placeholder="Optional room password (kept only this session)"
                      aria-label="Room password"
                      onChange={(e) => {
                        setServerPassword(e.target.value);
                        if (error) setError(null);
                      }}
                      className="ep-glass-input flex-1 h-9.5 px-3.5 rounded-xl text-xs text-primary placeholder:text-muted focus:outline-none min-w-0"
                    />
                    {(standardRoomName ? hasJoinCode : /^\d{6}$/.test(joinInput)) && (
                      <button
                        type="submit"
                        className="ep-glass-primary-pill ep-press h-9.5 px-3.5 rounded-xl text-xs font-medium text-white inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
                      >
                        <span>Join</span>
                        <AppArrowIcon direction="right" size={13} />
                      </button>
                    )}
                  </form>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={standardRoomName}
                    onClick={() => {
                      const checked = !standardRoomName;
                      setStandardRoomName(checked);
                      setVerifyingJoin(false);
                      setPasswordRoomId(null);
                      setPendingRecentHostOnly(false);
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
                </AnimatedCollapse>
              </div>

              {recentRooms.length > 0 && (
                <div className="pt-2 border-t border-white/[0.08] space-y-1.5">
                  <div className="flex items-center justify-between px-1">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                      Recent rooms
                    </span>
                    {recentRoomsStorageError && (
                      <span className="text-[10px] text-warn">
                        Could not save changes to disk
                      </span>
                    )}
                  </div>
                  <div className="space-y-1 max-h-40 overflow-y-auto pr-0.5">
                    {recentRooms.map((room: RecentRoomEntry) => {
                      const isEditing = editingRoomId === room.id;
                      const isCustomHost =
                        normalizeRecentServerHost(room.serverHost).toLowerCase() !==
                        normalizeRecentServerHost(DEFAULT_ENDPOINT).toLowerCase();
                      const lastEpKey = room.seriesKey
                        ? seriesMap[room.seriesKey]?.lastEpisodeKey
                        : undefined;
                      return (
                        <div
                          key={room.id}
                          className="ep-menu-row rounded-xl px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs group"
                        >
                          {isEditing ? (
                            <form
                              onSubmit={(e) => {
                                e.preventDefault();
                                setRecentRoomNickname(room.id, editingRoomNickname);
                                setEditingRoomId(null);
                              }}
                              className="flex-1 flex items-center gap-1.5 min-w-0"
                            >
                              <input
                                type="text"
                                autoFocus
                                value={editingRoomNickname}
                                placeholder="Room nickname…"
                                maxLength={40}
                                onChange={(e) => setEditingRoomNickname(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") setEditingRoomId(null);
                                }}
                                className="ep-glass-input flex-1 h-7 px-2 rounded-lg text-xs text-primary min-w-0 focus:outline-none"
                              />
                              <button
                                type="submit"
                                className="ep-press px-2 h-7 rounded-lg bg-white/[0.1] text-[11px] text-white cursor-pointer"
                              >
                                Save
                              </button>
                            </form>
                          ) : (
                            <button
                              type="button"
                              title={`Server: ${room.serverHost}`}
                              onClick={() => handleJoinRecentRoom(room)}
                              className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                            >
                              <span className="truncate font-medium text-primary group-hover:text-white">
                                {room.nickname ||
                                  (room.literalRoom
                                    ? room.roomName
                                    : formatRoomCodeDisplay(room.roomName))}
                              </span>
                              {room.nickname && (
                                <span className="text-[11px] text-muted num truncate">
                                  {room.literalRoom
                                    ? room.roomName
                                    : formatRoomCodeDisplay(room.roomName)}
                                </span>
                              )}
                              {isCustomHost && (
                                <span className="text-[10px] text-muted truncate max-w-[110px] shrink-0">
                                  {room.serverHost}
                                </span>
                              )}
                              {lastEpKey && (
                                <span
                                  title={`Last watched: ${lastEpKey}`}
                                  className="px-1.5 py-0.5 rounded-full bg-white/[0.06] text-[10px] text-accent-soft num shrink-0"
                                >
                                  Last: {lastEpKey}
                                </span>
                              )}
                              {room.hasPassword && (
                                <Lock
                                  size={11}
                                  className="text-muted shrink-0"
                                  aria-label="Password protected"
                                />
                              )}
                            </button>
                          )}

                          {!isEditing && (
                            <div className="flex items-center gap-0.5 shrink-0">
                              <button
                                type="button"
                                aria-label={room.pinned ? "Unpin room" : "Pin room"}
                                title={room.pinned ? "Unpin" : "Pin"}
                                onClick={() => togglePinRecentRoom(room.id)}
                                className={`ep-press p-1 rounded-lg cursor-pointer ${
                                  room.pinned
                                    ? "text-accent-soft bg-white/[0.08]"
                                    : "text-muted hover:text-white hover:bg-white/[0.08]"
                                }`}
                              >
                                <Pin size={12} />
                              </button>
                              <button
                                type="button"
                                aria-label="Rename room"
                                title="Nickname"
                                onClick={() => {
                                  setEditingRoomId(room.id);
                                  setEditingRoomNickname(room.nickname ?? "");
                                }}
                                className="ep-press p-1 rounded-lg text-muted hover:text-white hover:bg-white/[0.08] cursor-pointer"
                              >
                                <AppEditIcon size={12} />
                              </button>
                              <button
                                type="button"
                                aria-label="Remove recent room"
                                title="Remove"
                                onClick={() => removeRecentRoom(room.id)}
                                className="ep-press p-1 rounded-lg text-muted hover:text-bad hover:bg-white/[0.08] cursor-pointer"
                              >
                                <X size={12} />
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {error && (
              <p role="alert" className="anim-pop-in text-xs text-bad text-center">
                {error}
              </p>
            )}
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
