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
import {
  buildContinueWatchingItems,
  type ContinueWatchingItem,
} from "../lib/continueWatching";
import {
  formatInviteClipboardText,
  parseInviteLink,
} from "../lib/inviteLinks";
import {
  checkLocalFilesExist,
  dpapiProtectSecret,
  probePinnedRooms,
  type RoomOccupancyDto,
} from "../lib/localLibrary";
import {
  applyDeepLinkInvite,
  loadMediaForRecentRoom as loadMediaForRecentRoomShared,
  resolveSavedRoomPassword,
} from "../lib/roomJoinHelper";
import { scanMediaPaths } from "../lib/playlist";
import {
  buildSeriesKey,
  extractParentFolderPath,
  pickInitialSeriesIndex,
  type SeriesProgressEntry,
} from "../lib/seriesProgress";
import { isTextEntryElement } from "../lib/shortcuts";
import { playSoundCue } from "../lib/soundEffects";
import {
  DEFAULT_ENDPOINT,
  formatServerDisplayName,
} from "../lib/syncStatusDisplay";
import { syncPrewarm } from "../lib/syncplay";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { sanitizeRoomCodeInput, sanitizeUsername } from "../lib/webviewHardening";
import { useAppStore } from "../store/useAppStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { usePlaylistStore } from "../store/usePlaylistStore";
import {
  getRecentRoomMediaLabel,
  normalizeRecentServerHost,
  useRecentRoomsStore,
  type RecentRoomEntry,
} from "../store/useRecentRoomsStore";
import { useResumeStore } from "../store/useResumeStore";
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
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const pendingDeepLinkPasswordRoomId = useAppStore((s) => s.pendingDeepLinkPasswordRoomId);
  const setPendingDeepLinkPasswordRoomId = useAppStore((s) => s.setPendingDeepLinkPasswordRoomId);
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
  const [rememberRoomPassword, setRememberRoomPassword] = useState(false);
  const [pendingRecentHostOnly, setPendingRecentHostOnly] = useState(false);
  const [missingSeriesKey, setMissingSeriesKey] = useState<string | null>(null);
  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);
  const [occupancyById, setOccupancyById] = useState<Record<string, RoomOccupancyDto>>({});
  const [probingPinned, setProbingPinned] = useState(false);
  const [missingFilePaths, setMissingFilePaths] = useState<Record<string, boolean>>({});
  const lastProbeAtRef = useRef(0);
  const verifyTimerRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const draftCopyTimerRef = useRef<number | null>(null);
  const roomCopyTimerRef = useRef<number | null>(null);
  const joiningMediaRef = useRef(false);
  const profileRef = useRef<HTMLDivElement | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);
  const prewarmedEndpointRef = useRef<string | null>(null);
  const prewarmedJoinRef = useRef<string | null>(null);
  const recentRooms = useRecentRoomsStore((s) => s.rooms);
  const recentRoomsStorageError = useRecentRoomsStore((s) => s.storageError);
  const togglePinRecentRoom = useRecentRoomsStore((s) => s.togglePin);
  const setRecentRoomNickname = useRecentRoomsStore((s) => s.setNickname);
  const setRecentRoomSeriesKey = useRecentRoomsStore((s) => s.setSeriesKey);
  const setRecentRoomEncryptedPassword = useRecentRoomsStore((s) => s.setEncryptedPassword);
  const removeRecentRoom = useRecentRoomsStore((s) => s.removeRoom);
  const seriesMap = useSeriesProgressStore((s) => s.series);
  const relocateSeriesFolder = useSeriesProgressStore((s) => s.relocateSeriesFolder);
  const removeSeries = useSeriesProgressStore((s) => s.removeSeries);
  const resumeEntries = useResumeStore((s) => s.entries);
  const removeResumePosition = useResumeStore((s) => s.removePosition);

  const pinnedRooms = recentRooms.filter((r) => r.pinned);
  const unpinnedRooms = recentRooms.filter((r) => !r.pinned);
  const continueItems = buildContinueWatchingItems(seriesMap, resumeEntries, recentRooms, 4);
  const profilePopover = useAnimatedPresence(editingName, 170);
  const dragBanner = useAnimatedPresence(isDragActive, 170);

  useEffect(() => {
    if (lobbyView !== "party" || !isDesktop()) return;
    const ep = (serverEndpoint || DEFAULT_ENDPOINT).trim();
    const key = `${ep}|${draftRoomCode}`;
    if (!ep || prewarmedEndpointRef.current === key) return;
    prewarmedEndpointRef.current = key;
    void syncPrewarm(ep, draftRoomCode);
  }, [lobbyView, serverEndpoint, draftRoomCode]);

  useEffect(() => {
    if (lobbyView !== "party" || !isDesktop() || standardRoomName) return;
    const code = joinInput.trim();
    if (!/^\d{6}$/.test(code)) return;
    const ep = (serverEndpoint || DEFAULT_ENDPOINT).trim();
    const key = `${ep}|${code}`;
    if (!ep || prewarmedJoinRef.current === key) return;
    const timer = window.setTimeout(() => {
      prewarmedJoinRef.current = key;
      void syncPrewarm(ep, code);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [lobbyView, standardRoomName, joinInput, serverEndpoint]);

  const refreshPinnedOccupancy = async (force = false) => {
    if (!isDesktop() || pinnedRooms.length === 0 || probingPinned) return;
    const now = Date.now();
    if (!force && now - lastProbeAtRef.current < 25_000) return;
    lastProbeAtRef.current = now;
    setProbingPinned(true);
    try {
      const results = await probePinnedRooms(
        pinnedRooms.slice(0, 5).map((r) => ({
          id: r.id,
          serverHost: r.serverHost,
          roomName: r.roomName,
          literalRoom: r.literalRoom,
        })),
      );
      setOccupancyById((prev) => {
        const next = { ...prev };
        for (const item of results) {
          next[item.id] = item;
        }
        return next;
      });
    } catch {
      // Probe failures are non-fatal (rate limit or offline)
    } finally {
      setProbingPinned(false);
    }
  };

  useEffect(() => {
    if (!isDesktop() || pinnedRooms.length === 0) return;
    void refreshPinnedOccupancy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pinnedRooms.length]);

  useEffect(() => {
    if (!isDesktop()) return;
    const paths = recentRooms
      .map((r) => r.lastFilePath)
      .filter((p): p is string => Boolean(p));
    if (paths.length === 0) return;
    let active = true;
    void checkLocalFilesExist(paths).then((existsList) => {
      if (!active) return;
      const map: Record<string, boolean> = {};
      paths.forEach((p, idx) => {
        map[p] = !existsList[idx];
      });
      setMissingFilePaths(map);
    });
    return () => {
      active = false;
    };
  }, [recentRooms]);

  useEffect(() => {
    if (!pendingDeepLinkPasswordRoomId) return;
    const targetRoom = recentRooms.find((r) => r.id === pendingDeepLinkPasswordRoomId);
    setPendingDeepLinkPasswordRoomId(null);
    if (!targetRoom) return;
    setServerEndpoint(targetRoom.serverHost);
    setStandardRoomName(targetRoom.literalRoom);
    setJoinInput(targetRoom.roomName);
    setPasswordRoomId(targetRoom.id);
    setRememberRoomPassword(Boolean(targetRoom.encryptedPassword));
    setPendingRecentHostOnly(Boolean(targetRoom.hostOnly));
    setLobbyView("party");
    setShowOptions(true);
    setError("Enter the room password to join.");
    const timer = window.setTimeout(() => {
      passwordInputRef.current?.focus();
    }, 80);
    return () => window.clearTimeout(timer);
  }, [pendingDeepLinkPasswordRoomId, recentRooms, setPendingDeepLinkPasswordRoomId, setServerEndpoint]);

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
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      if (draftCopyTimerRef.current !== null) {
        window.clearTimeout(draftCopyTimerRef.current);
      }
      if (roomCopyTimerRef.current !== null) {
        window.clearTimeout(roomCopyTimerRef.current);
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

  const loadMediaForRecentRoom = async (room: RecentRoomEntry): Promise<boolean> => {
    return loadMediaForRecentRoomShared(room, seriesMap);
  };

  const enterSeriesOrLinkedParty = async (
    linkedRoom: RecentRoomEntry | undefined,
    solo = false,
  ) => {
    if (solo || !linkedRoom) {
      enterRoom("", false, false);
      return;
    }
    if (!ensureValidName()) return;
    const hostOnly = Boolean(linkedRoom.hostOnly);
    setServerEndpoint(linkedRoom.serverHost);
    setStandardRoomName(linkedRoom.literalRoom);
    setJoinInput(linkedRoom.roomName);

    if (!linkedRoom.hasPassword) {
      setServerPassword("");
      setPasswordRoomId(null);
      setPendingRecentHostOnly(false);
      enterRoom(linkedRoom.roomName, linkedRoom.literalRoom, hostOnly);
      return;
    }

    const savedPass = await resolveSavedRoomPassword(linkedRoom);
    if (savedPass) {
      setServerPassword(savedPass);
      setPasswordRoomId(null);
      setPendingRecentHostOnly(false);
      enterRoom(linkedRoom.roomName, linkedRoom.literalRoom, hostOnly);
      return;
    }

    if (passwordRoomId !== linkedRoom.id || !serverPassword) {
      if (passwordRoomId !== linkedRoom.id) {
        setServerPassword("");
      }
      setPasswordRoomId(linkedRoom.id);
      setRememberRoomPassword(Boolean(linkedRoom.encryptedPassword));
      setPendingRecentHostOnly(hostOnly);
      setLobbyView("party");
      setShowOptions(true);
      setError("Enter the room password to join.");
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null;
        passwordInputRef.current?.focus();
      }, 80);
      return;
    }

    setPasswordRoomId(null);
    setPendingRecentHostOnly(false);
    enterRoom(linkedRoom.roomName, linkedRoom.literalRoom, hostOnly);
  };

  const handleContinueMovie = async (
    item: ContinueWatchingItem,
    options?: { solo?: boolean },
  ) => {
    const resumeEntry = item.resumeEntry;
    if (!resumeEntry?.filePath || joiningMediaRef.current) return;
    joiningMediaRef.current = true;
    setError(null);
    try {
      const existsList = await checkLocalFilesExist([resumeEntry.filePath]);
      if (isDesktop() && !existsList[0]) {
        if (item.resumeKey) {
          removeResumePosition(item.resumeKey);
        }
        setError("That movie file was moved or deleted.");
        return;
      }
      const scan = await scanMediaPaths([resumeEntry.filePath]);
      if (scan.items.length > 0) {
        const idx = Math.max(0, Math.min(scan.items.length - 1, scan.activeIndex));
        usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName);
        const target = scan.items[idx];
        setSelectedFile(target.path, target.fileName);
      } else {
        usePlaylistStore.getState().clearPlaylist();
        setSelectedFile(
          resumeEntry.filePath,
          resumeEntry.fileName || getFileDisplayName(resumeEntry.filePath),
        );
      }
      await enterSeriesOrLinkedParty(item.linkedRoom, Boolean(options?.solo));
    } catch {
      setError("Could not open movie file.");
    } finally {
      joiningMediaRef.current = false;
    }
  };

  const handleContinueSeries = async (
    entry: SeriesProgressEntry,
    options?: { solo?: boolean },
  ) => {
    if (joiningMediaRef.current) return;
    joiningMediaRef.current = true;
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
      const linkedRoom = useRecentRoomsStore
        .getState()
        .rooms.find((r) => r.seriesKey === entry.seriesKey);
      await enterSeriesOrLinkedParty(linkedRoom, Boolean(options?.solo));
    } catch {
      setMissingSeriesKey(entry.seriesKey);
    } finally {
      joiningMediaRef.current = false;
    }
  };

  const handleLocateSeriesFolder = async (entry: SeriesProgressEntry) => {
    if (!isDesktop() || joiningMediaRef.current) return;
    joiningMediaRef.current = true;
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
      const prevLinkedRoom = recentRooms.find((r) => r.seriesKey === entry.seriesKey);
      const newKey = relocateSeriesFolder(entry.seriesKey, dir, scan.folderName || entry.folderName);
      if (prevLinkedRoom && newKey) {
        setRecentRoomSeriesKey(prevLinkedRoom.id, newKey);
      }
      const updated = newKey ? useSeriesProgressStore.getState().getSeries(newKey) : entry;
      setMissingSeriesKey(null);
      const idx = pickInitialSeriesIndex(scan.items, updated);
      usePlaylistStore.getState().setPlaylist(scan.items, idx, scan.folderName || entry.folderName);
      const target = scan.items[idx];
      setSelectedFile(target.path, target.fileName);
      const linkedRoom = newKey
        ? useRecentRoomsStore.getState().rooms.find((r) => r.seriesKey === newKey)
        : prevLinkedRoom;
      await enterSeriesOrLinkedParty(linkedRoom, false);
    } catch (err) {
      setError(formatUserError(err));
    } finally {
      joiningMediaRef.current = false;
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
      const text = formatInviteClipboardText(draftRoomCode, false, serverEndpoint);
      await navigator.clipboard.writeText(text);
      setCopiedDraft(true);
      playSoundCue("codeCopied");
      if (draftCopyTimerRef.current !== null) {
        window.clearTimeout(draftCopyTimerRef.current);
      }
      draftCopyTimerRef.current = window.setTimeout(() => {
        draftCopyTimerRef.current = null;
        setCopiedDraft(false);
      }, 1600);
    } catch {
      // Clipboard may be restricted outside secure focus
    }
  };

  const handleCopyRoomInvite = async (room: RecentRoomEntry) => {
    try {
      const text = formatInviteClipboardText(room.roomName, room.literalRoom, room.serverHost);
      await navigator.clipboard.writeText(text);
      setCopiedRoomId(room.id);
      playSoundCue("codeCopied");
      if (roomCopyTimerRef.current !== null) {
        window.clearTimeout(roomCopyTimerRef.current);
      }
      roomCopyTimerRef.current = window.setTimeout(() => {
        roomCopyTimerRef.current = null;
        setCopiedRoomId((prev) => (prev === room.id ? null : prev));
      }, 1600);
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
      const invite = parseInviteLink(clip);
      if (invite) {
        if (!ensureValidName()) return;
        setError(null);
        playSoundCue("codeCopied");
        await applyDeepLinkInvite(invite);
        return;
      }
      if (standardRoomName) {
        setJoinInput(sanitizeRoomCodeInput(clip, true));
        if (error) setError(null);
        return;
      }
      const digits = clip.replace(/\D/g, "").slice(0, 6);
      if (!digits) {
        setError("Clipboard does not contain a 6-digit room code or invite link.");
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
      const text = formatInviteClipboardText(draftRoomCode, false, serverEndpoint);
      void navigator.clipboard?.writeText(text).catch(() => undefined);
    } catch {
      // ignore
    }
    enterRoom(draftRoomCode, false, hostOnlyCreate, true);
  };

  const handleJoinRoom = async (e: FormEvent) => {
    e.preventDefault();
    if (joiningMediaRef.current) return;
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
    const pendingRoom = passwordRoomId
      ? recentRooms.find((r) => r.id === passwordRoomId)
      : undefined;
    const hostOnly = Boolean(passwordRoomId && pendingRecentHostOnly);
    setPasswordRoomId(null);
    setPendingRecentHostOnly(false);
    if (pendingRoom) {
      if (rememberRoomPassword && serverPassword) {
        try {
          const encrypted = await dpapiProtectSecret(serverPassword);
          if (encrypted) {
            setRecentRoomEncryptedPassword(pendingRoom.id, encrypted);
          }
        } catch {
          // Ignore DPAPI failure; password still works for current session
        }
      } else if (!rememberRoomPassword && pendingRoom.encryptedPassword) {
        setRecentRoomEncryptedPassword(pendingRoom.id, undefined);
      }
      if (!useAppStore.getState().selectedFilePath) {
        joiningMediaRef.current = true;
        try {
          const loaded = await loadMediaForRecentRoom(pendingRoom);
          if (!loaded) {
            usePlaylistStore.getState().clearPlaylist();
            setSelectedFile(null, null);
          }
        } finally {
          joiningMediaRef.current = false;
        }
      }
    }
    enterRoom(cleaned, standardRoomName, hostOnly);
  };

  const handleJoinRecentRoom = async (room: RecentRoomEntry) => {
    if (joiningMediaRef.current) return;
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
      joiningMediaRef.current = true;
      try {
        const loaded = await loadMediaForRecentRoom(room);
        if (!loaded) {
          usePlaylistStore.getState().clearPlaylist();
          setSelectedFile(null, null);
        }
      } finally {
        joiningMediaRef.current = false;
      }
      enterRoom(room.roomName, room.literalRoom, hostOnly);
      return;
    }

    const savedPass = await resolveSavedRoomPassword(room);
    if (savedPass) {
      setServerPassword(savedPass);
      setPasswordRoomId(null);
      setPendingRecentHostOnly(false);
      joiningMediaRef.current = true;
      try {
        const loaded = await loadMediaForRecentRoom(room);
        if (!loaded) {
          usePlaylistStore.getState().clearPlaylist();
          setSelectedFile(null, null);
        }
      } finally {
        joiningMediaRef.current = false;
      }
      enterRoom(room.roomName, room.literalRoom, hostOnly);
      return;
    }

    if (passwordRoomId !== room.id || !serverPassword) {
      if (passwordRoomId !== room.id) {
        setServerPassword("");
      }
      setPasswordRoomId(room.id);
      setRememberRoomPassword(Boolean(room.encryptedPassword));
      setPendingRecentHostOnly(hostOnly);
      setLobbyView("party");
      setShowOptions(true);
      setError("Enter the room password to join.");
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
      }
      focusTimerRef.current = window.setTimeout(() => {
        focusTimerRef.current = null;
        passwordInputRef.current?.focus();
      }, 80);
      return;
    }

    setPasswordRoomId(null);
    setPendingRecentHostOnly(false);
    if (rememberRoomPassword && serverPassword) {
      try {
        const encrypted = await dpapiProtectSecret(serverPassword);
        if (encrypted) {
          setRecentRoomEncryptedPassword(room.id, encrypted);
        }
      } catch {
        // Ignore DPAPI failure; password still works for current session
      }
    } else if (!rememberRoomPassword && room.encryptedPassword) {
      setRecentRoomEncryptedPassword(room.id, undefined);
    }
    if (!useAppStore.getState().selectedFilePath) {
      joiningMediaRef.current = true;
      try {
        const loaded = await loadMediaForRecentRoom(room);
        if (!loaded) {
          usePlaylistStore.getState().clearPlaylist();
          setSelectedFile(null, null);
        }
      } finally {
        joiningMediaRef.current = false;
      }
    }
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
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5 min-w-0">
                  <ProfileAvatar
                    avatarId={avatarId}
                    size={38}
                    className="shrink-0 ring-2 ring-accent/60 shadow-[0_6px_18px_rgba(124,58,237,0.35)]"
                  />
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-white truncate">
                      {username || "Viewer"}
                    </div>
                    <div className="text-[11px] text-secondary truncate">
                      Customize how friends see you
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  className="ep-glass-pill-active ep-press shrink-0 h-7 px-3 rounded-full text-[11px] font-semibold text-white cursor-pointer"
                >
                  Done
                </button>
              </div>

              <label className="block space-y-1.5">
                <span className="text-[11px] font-medium text-secondary">
                  Display Name
                </span>
                <input
                  id="profile-display-name"
                  name="displayName"
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

            {continueItems.length > 0 && (
              <div className="w-full max-w-[440px] ep-glass-sheet rounded-[20px] p-3.5 space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wider text-muted px-1">
                  Continue watching
                </div>
                <div className="space-y-1.5">
                  {continueItems.map((item) => {
                    const isSeries = item.kind === "series" && Boolean(item.seriesEntry);
                    const isMissing = isSeries && missingSeriesKey === item.seriesEntry?.seriesKey;
                    const linkedRoomLabel = item.linkedRoom
                      ? item.linkedRoom.nickname ||
                        (item.linkedRoom.literalRoom
                          ? item.linkedRoom.roomName
                          : formatRoomCodeDisplay(item.linkedRoom.roomName))
                      : null;
                    return (
                      <div
                        key={item.id}
                        className="ep-menu-row relative overflow-hidden rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-xs group"
                      >
                        <button
                          type="button"
                          title={
                            linkedRoomLabel
                              ? `Resume in Watch Party (${linkedRoomLabel})`
                              : undefined
                          }
                          onClick={() => {
                            if (item.kind === "series" && item.seriesEntry) {
                              void handleContinueSeries(item.seriesEntry);
                            } else {
                              void handleContinueMovie(item);
                            }
                          }}
                          className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                        >
                          {item.kind === "series" ? (
                            <PlayerEpisodesIcon size={15} className="text-accent-soft shrink-0" />
                          ) : (
                            <MenuMediaDiscIcon size={15} className="text-accent-soft shrink-0" />
                          )}
                          <span className="truncate font-medium text-white">{item.title}</span>
                          {item.badgeText && (
                            <span className="px-1.5 py-0.5 rounded-full bg-white/[0.08] text-[10px] text-secondary num shrink-0">
                              {item.badgeText}
                            </span>
                          )}
                          {item.timeLeftLabel && (
                            <span className="text-[10px] text-muted num shrink-0">
                              {item.timeLeftLabel}
                            </span>
                          )}
                          {linkedRoomLabel && (
                            <span className="px-1.5 py-0.5 rounded-full bg-accent/18 text-[10px] text-accent-soft truncate max-w-[100px] shrink-0">
                              Party · {linkedRoomLabel}
                            </span>
                          )}
                        </button>
                        {!isMissing && item.linkedRoom && (
                          <button
                            type="button"
                            onClick={() => {
                              if (item.kind === "series" && item.seriesEntry) {
                                void handleContinueSeries(item.seriesEntry, { solo: true });
                              } else {
                                void handleContinueMovie(item, { solo: true });
                              }
                            }}
                            title="Watch alone instead"
                            className="ep-press px-2 py-1 rounded-lg bg-white/[0.06] hover:bg-white/[0.12] text-[11px] text-secondary hover:text-white shrink-0 cursor-pointer"
                          >
                            Solo
                          </button>
                        )}
                        {isMissing && item.seriesEntry && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="text-[11px] text-warn">Folder not found</span>
                            <button
                              type="button"
                              onClick={() => void handleLocateSeriesFolder(item.seriesEntry!)}
                              className="ep-press px-2 py-1 rounded-lg bg-white/[0.1] hover:bg-white/[0.16] text-[11px] text-white cursor-pointer"
                            >
                              Locate folder
                            </button>
                          </div>
                        )}
                        {!isMissing && (
                          <button
                            type="button"
                            aria-label={`Remove ${item.title} from continue watching`}
                            title="Remove"
                            onClick={() => {
                              if (item.kind === "series" && item.seriesEntry) {
                                removeSeries(item.seriesEntry.seriesKey);
                              } else if (item.resumeKey) {
                                removeResumePosition(item.resumeKey);
                              }
                            }}
                            className="ep-press p-1 rounded-lg text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-bad hover:bg-white/[0.08] shrink-0 cursor-pointer transition-opacity"
                          >
                            <X size={12} />
                          </button>
                        )}
                        {item.progressRatio !== null && (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-x-0 bottom-0 h-[2px] bg-white/[0.06]"
                          >
                            <div
                              className="h-full bg-accent/85"
                              style={{ width: `${Math.round(item.progressRatio * 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {pinnedRooms.length > 0 && (
              <div className="w-full max-w-[440px] ep-glass-sheet rounded-[20px] p-3.5 space-y-2">
                <div className="flex items-center justify-between px-1">
                  <span className="text-[11px] font-medium uppercase tracking-wider text-muted">
                    Pinned rooms
                  </span>
                  <button
                    type="button"
                    disabled={probingPinned}
                    onClick={() => void refreshPinnedOccupancy(true)}
                    title="Check who is inside pinned rooms"
                    aria-label="Refresh pinned room status"
                    className="ep-press inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-muted hover:text-white hover:bg-white/[0.08] cursor-pointer disabled:opacity-50"
                  >
                    <AppResetIcon
                      clockwise
                      size={11}
                      className={probingPinned ? "animate-spin" : ""}
                    />
                    <span>{probingPinned ? "Checking" : "Check"}</span>
                  </button>
                </div>
                <div className="space-y-1">
                  {pinnedRooms.slice(0, 4).map((room) => {
                    const occ = occupancyById[room.id];
                    const hasPeople = Boolean(occ?.ok && occ.onlineCount > 0);
                    const occTooltip = hasPeople
                      ? `${occ.usernamesPreview.join(", ")}${occ.activeMediaHint ? ` · ${occ.activeMediaHint}` : ""}`
                      : undefined;
                    const codeLabel = room.literalRoom
                      ? room.roomName
                      : formatRoomCodeDisplay(room.roomName);
                    const mediaLabel = getRecentRoomMediaLabel(
                      room,
                      seriesMap,
                      occ?.activeMediaHint,
                    );
                    const roomLabel = room.nickname || mediaLabel || codeLabel;
                    return (
                      <div
                        key={room.id}
                        className="ep-menu-row rounded-xl px-3 py-1.5 flex items-center justify-between gap-2 text-xs group"
                      >
                        <button
                          type="button"
                          onClick={() => void handleJoinRecentRoom(room)}
                          title={
                            occTooltip ||
                            (room.lastFilePath
                              ? `Will open: ${getFileDisplayName(room.lastFilePath)}`
                              : `Join ${roomLabel}`)
                          }
                          className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                        >
                          <Pin size={12} className="text-accent-soft shrink-0" />
                          <span className="truncate font-medium text-white">{roomLabel}</span>
                          {(room.nickname || mediaLabel) && (
                            <span className="text-[11px] text-muted num truncate">
                              {codeLabel}
                            </span>
                          )}
                          {hasPeople && (
                            <span
                              title={occTooltip}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-ok/15 border border-ok/30 text-[10px] font-medium text-ok num shrink-0"
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                              <span>{occ.onlineCount} watching</span>
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
                        <button
                          type="button"
                          onClick={() => void handleCopyRoomInvite(room)}
                          aria-label={`Copy invite for ${roomLabel}`}
                          title="Copy invite link & code"
                          className="ep-press p-1 rounded-lg text-muted hover:text-white hover:bg-white/[0.08] shrink-0 cursor-pointer"
                        >
                          <PartyCopyIcon copied={copiedRoomId === room.id} size={12} />
                        </button>
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
                  if (passwordRoomId) {
                    setPasswordRoomId(null);
                    setPendingRecentHostOnly(false);
                    usePlaylistStore.getState().clearPlaylist();
                    setSelectedFile(null, null);
                  }
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
                  {!standardRoomName && (
                    <button
                      type="button"
                      onClick={() => void handlePasteJoin()}
                      className="ep-press -mr-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium text-secondary hover:text-white hover:bg-white/[0.08] cursor-pointer shrink-0"
                    >
                      <PartyPasteIcon size={13} />
                      <span>Paste Code</span>
                    </button>
                  )}
                </div>

                {standardRoomName ? (
                  <form onSubmit={handleJoinRoom} className="flex items-center gap-2">
                    <input
                      id="join-syncplay-room"
                      name="syncplayRoomName"
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
                      id="room-server-password"
                      name="roomPassword"
                      type="password"
                      autoComplete="new-password"
                      value={serverPassword}
                      maxLength={128}
                      placeholder="Optional room password"
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
                  {passwordRoomId && (
                    <button
                      type="button"
                      role="switch"
                      aria-checked={rememberRoomPassword}
                      onClick={() => setRememberRoomPassword((v) => !v)}
                      className="ep-menu-row ep-press w-full flex items-center justify-between gap-3 px-2.5 py-1.5 text-left text-xs text-secondary hover:text-white cursor-pointer"
                    >
                      <span>Remember password on this PC</span>
                      <GlassSwitchTrack checked={rememberRoomPassword} size="sm" />
                    </button>
                  )}
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
                      {pinnedRooms.length > 0 && unpinnedRooms.length > 0
                        ? "Pinned & recent rooms"
                        : pinnedRooms.length > 0
                          ? "Pinned rooms"
                          : "Recent rooms"}
                    </span>
                    <div className="flex items-center gap-2">
                      {pinnedRooms.length > 0 && (
                        <button
                          type="button"
                          disabled={probingPinned}
                          onClick={() => void refreshPinnedOccupancy(true)}
                          title="Check who is inside pinned rooms"
                          className="ep-press inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] text-muted hover:text-white hover:bg-white/[0.08] cursor-pointer disabled:opacity-50"
                        >
                          <AppResetIcon
                            clockwise
                            size={10}
                            className={probingPinned ? "animate-spin" : ""}
                          />
                          <span>{probingPinned ? "Checking" : "Check"}</span>
                        </button>
                      )}
                      {recentRoomsStorageError && (
                        <span className="text-[10px] text-warn">
                          Could not save changes to disk
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="space-y-1 max-h-44 overflow-y-auto pr-0.5">
                    {recentRooms.map((room: RecentRoomEntry, index: number) => {
                      const isEditing = editingRoomId === room.id;
                      const isCustomHost =
                        normalizeRecentServerHost(room.serverHost).toLowerCase() !==
                        normalizeRecentServerHost(DEFAULT_ENDPOINT).toLowerCase();
                      const lastEpKey = room.seriesKey
                        ? seriesMap[room.seriesKey]?.lastEpisodeKey
                        : undefined;
                      const occ = room.pinned ? occupancyById[room.id] : undefined;
                      const hasPeople = Boolean(occ?.ok && occ.onlineCount > 0);
                      const fileMissing = Boolean(room.lastFilePath && missingFilePaths[room.lastFilePath]);
                      const mediaTooltip = room.lastFilePath
                        ? fileMissing
                          ? `File moved: ${getFileDisplayName(room.lastFilePath)}`
                          : `Will open: ${getFileDisplayName(room.lastFilePath)}`
                        : `Server: ${formatServerDisplayName(room.serverHost)}`;
                      const codeLabel = room.literalRoom
                        ? room.roomName
                        : formatRoomCodeDisplay(room.roomName);
                      const mediaLabel = getRecentRoomMediaLabel(
                        room,
                        seriesMap,
                        occ?.activeMediaHint,
                      );
                      const primaryLabel = room.nickname || mediaLabel || codeLabel;
                      const showSecondaryCode = Boolean(room.nickname || mediaLabel);
                      const showRecentDivider =
                        pinnedRooms.length > 0 &&
                        unpinnedRooms.length > 0 &&
                        index === pinnedRooms.length;
                      return (
                        <div key={room.id}>
                          {showRecentDivider && (
                            <div className="pt-1 pb-0.5 px-1 text-[10px] uppercase tracking-wider text-muted/80">
                              Recent
                            </div>
                          )}
                          <div className="ep-menu-row rounded-xl px-2.5 py-1.5 flex items-center justify-between gap-2 text-xs group">
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
                                  id={`edit-room-nickname-${room.id}`}
                                  name="recentRoomNickname"
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
                                title={
                                  hasPeople
                                    ? `${occ?.usernamesPreview.join(", ")}${occ?.activeMediaHint ? ` · ${occ.activeMediaHint}` : ""}`
                                    : mediaTooltip
                                }
                                onClick={() => void handleJoinRecentRoom(room)}
                                className="flex-1 flex items-center gap-2 min-w-0 text-left cursor-pointer"
                              >
                                <span className="truncate font-medium text-primary group-hover:text-white">
                                  {primaryLabel}
                                </span>
                                {showSecondaryCode && (
                                  <span className="text-[11px] text-muted num truncate">
                                    {codeLabel}
                                  </span>
                                )}
                                {hasPeople && (
                                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-ok/15 border border-ok/30 text-[10px] text-ok num shrink-0">
                                    <span className="h-1.5 w-1.5 rounded-full bg-ok" />
                                    <span>{occ?.onlineCount}</span>
                                  </span>
                                )}
                                {isCustomHost && (
                                  <span className="text-[10px] text-muted truncate max-w-[110px] shrink-0">
                                    {formatServerDisplayName(room.serverHost)}
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
                                {fileMissing && (
                                  <span className="text-[10px] text-warn shrink-0">
                                    File moved
                                  </span>
                                )}
                                {room.hasPassword && (
                                  <Lock
                                    size={11}
                                    className="text-muted shrink-0"
                                    aria-label={
                                      room.encryptedPassword
                                        ? "Password saved on this PC"
                                        : "Password protected"
                                    }
                                  />
                                )}
                              </button>
                            )}

                            {!isEditing && (
                              <div className="flex items-center gap-0.5 shrink-0">
                                <button
                                  type="button"
                                  aria-label="Copy room invite"
                                  title="Copy invite link & code"
                                  onClick={() => void handleCopyRoomInvite(room)}
                                  className="ep-press p-1 rounded-lg text-muted hover:text-white hover:bg-white/[0.08] cursor-pointer"
                                >
                                  <PartyCopyIcon copied={copiedRoomId === room.id} size={12} />
                                </button>
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
