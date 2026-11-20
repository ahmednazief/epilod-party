import {
  AppAppearanceCategoryIcon,
  AppCheckIcon,
  AppChevronIcon,
  AppCloseIcon,
  AppDownloadIcon,
  AppHeadphonesIcon,
  AppLogsIcon,
  AppMicIcon,
  AppPartyPrivacyCategoryIcon,
  AppPlaybackCategoryIcon,
  AppProfileCategoryIcon,
  AppResetIcon,
  AppShieldIcon,
  AppSlidersIcon,
  AppSpeakerVolumeIcon,
  AppVoiceCategoryIcon,
  AppVoiceWaveIcon,
  AppWrenchIcon,
} from "./ui/AppIcons";
import { PlayerPauseIcon } from "./ui/PlayerIcons";
import { MenuEncodingIcon } from "./ui/MenuIcons";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { clearLocalMatchCache } from "../hooks/usePartyFileMismatch";
import { isDesktop, safeInvoke } from "../lib/bridge";
import { getLogsSnapshot, type LogEntry } from "../lib/logger";
import { mpvSetSubStyle, safeMpvCall, setAllowNetworkShares } from "../lib/mpv";
import {
  CLOUD_ENDPOINT,
  DEFAULT_ENDPOINT,
  SYNCPLAY_ENDPOINT,
} from "../lib/syncStatusDisplay";
import { playSoundCue } from "../lib/soundEffects";
import { createLeadingTrailingThrottle } from "../lib/throttle";
import {
  formatBytesCompact,
  formatTransferSpeed,
  parseReleaseNotes,
} from "../lib/updater";
import { validateServerEndpointInput } from "../lib/webviewHardening";
import {
  useAppStore,
  type AutoFetchSubtitleMode,
  type ChatTriggerPlacement,
  type OutroNextMode,
  type SettingsTab,
  type SkipIntroMode,
} from "../store/useAppStore";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import { useRecentRoomsStore } from "../store/useRecentRoomsStore";
import { useResumeStore } from "../store/useResumeStore";
import { useSeriesProgressStore } from "../store/useSeriesProgressStore";
import {
  buildSubStyleParams,
  PREFERRED_SUBTITLE_LANG_OPTIONS,
  useSubtitleStore,
} from "../store/useSubtitleStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
import {
  acquireMicMonitorSurface,
  domEventModifiersMask,
  domEventToWindowsVk,
  formatVoiceHotkey,
  onVoiceCalibration,
  onVoiceDevicesChanged,
  onVoiceLevel,
  releaseMicMonitorSurface,
  validateVoiceHotkey,
  voiceGetDiagnostics,
  voiceGetReport,
  voiceListDevices,
  voiceStartCalibration,
  voiceStartMicMonitor,
  voiceStopMicMonitor,
  type VoiceDiagnosticsDto,
  type VoiceDuckingMode,
  type VoiceInputMode,
  type VoiceNoiseMode,
} from "../lib/voice";
import { useVoiceStore } from "../store/useVoiceStore";
import { AnimatedCollapse } from "./ui/AnimatedCollapse";
import { Button } from "./ui/Button";
import { GlassSwitchTrack } from "./ui/GlassSwitch";
import { AvatarPicker, ProfileAvatar } from "./ui/ProfileAvatar";
import { Scrubber } from "./ui/Scrubber";
import { SegmentedTabs } from "./ui/SegmentedTabs";
import { SelectMenu } from "./ui/SelectMenu";
import { TextField } from "./ui/TextField";

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onApplyServerConfig?: (endpoint: string, password: string) => void;
}

const PRIMARY_NAV: ReadonlyArray<{ value: SettingsTab; label: string }> = [
  { value: "profile", label: "Profile" },
  { value: "appearance", label: "Appearance" },
  { value: "playback", label: "Playback" },
  { value: "party", label: "Party & Privacy" },
  { value: "voice", label: "Voice & Audio" },
  { value: "updates", label: "Updates" },
];

const ADVANCED_NAV: ReadonlyArray<{ value: SettingsTab; label: string }> = [
  { value: "server", label: "Connection & Server" },
  { value: "logs", label: "Diagnostics" },
];

const NAV_HEADINGS: Record<SettingsTab, string> = {
  profile: "Profile & Avatar",
  appearance: "Appearance & Motion",
  playback: "Playback & Subtitles",
  party: "Watch Party & Privacy",
  voice: "Voice & Audio",
  updates: "App Updates",
  server: "Connection & Shared Folders",
  logs: "Session Diagnostics",
};

function renderCategoryIcon(tabValue: SettingsTab, active: boolean) {
  switch (tabValue) {
    case "profile":
      return <AppProfileCategoryIcon size={16} active={active} className="shrink-0" />;
    case "appearance":
      return <AppAppearanceCategoryIcon size={16} active={active} className="shrink-0" />;
    case "playback":
      return <AppPlaybackCategoryIcon size={16} active={active} className="shrink-0" />;
    case "party":
      return <AppPartyPrivacyCategoryIcon size={16} active={active} className="shrink-0" />;
    case "voice":
      return <AppVoiceCategoryIcon size={16} active={active} className="shrink-0" />;
    case "updates":
      return <AppDownloadIcon size={16} active={active} className="shrink-0" />;
    case "server":
      return <AppSlidersIcon size={16} active={active} className="shrink-0" />;
    case "logs":
      return <AppLogsIcon size={16} active={active} className="shrink-0" />;
  }
}

function ComfortSwitchRow({
  title,
  description,
  checked,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="ep-menu-row ep-press w-full px-3 py-3 flex items-center justify-between gap-4 text-left cursor-pointer"
    >
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-white">{title}</div>
        <div className="text-xs text-secondary leading-relaxed mt-0.5">{description}</div>
      </div>
      <GlassSwitchTrack checked={checked} size="md" />
    </button>
  );
}

export function SettingsModal({ open, onClose, onApplyServerConfig }: SettingsModalProps) {
  const rawTab = useAppStore((s) => s.settingsTab);
  const tab: SettingsTab = (rawTab as string) === "prefs" ? "profile" : rawTab;
  const setTab = useAppStore((s) => s.setSettingsTab);

  const username = useAppStore((s) => s.username);
  const avatarId = useAppStore((s) => s.avatarId);
  const serverEndpoint = useAppStore((s) => s.serverEndpoint);
  const serverPassword = useAppStore((s) => s.serverPassword);
  const allowNetworkShares = useAppStore((s) => s.allowNetworkShares);
  const hideParticipants = useAppStore((s) => s.hideParticipants);
  const hashFilenames = useAppStore((s) => s.hashFilenames);
  const autoFixFileMismatch = useAppStore((s) => s.autoFixFileMismatch);
  const rememberPlaybackPosition = useAppStore((s) => s.rememberPlaybackPosition);
  const trackWatchedEpisodes = useAppStore((s) => s.trackWatchedEpisodes);
  const fixArabicPunctuation = useAppStore((s) => s.fixArabicPunctuation);
  const globalShortcutsEnabled = useAppStore((s) => s.globalShortcutsEnabled);
  const osdEnabled = useAppStore((s) => s.osdEnabled);
  const startWhenAllReady = useAppStore((s) => s.startWhenAllReady);
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const soundEffectsEnabled = useAppStore((s) => s.soundEffectsEnabled);
  const skipIntroMode = useAppStore((s) => s.skipIntroMode);
  const outroNextMode = useAppStore((s) => s.outroNextMode);
  const autoFetchSubtitles = useAppStore((s) => s.autoFetchSubtitles);
  const preferredSubtitleLangs = useAppStore((s) => s.preferredSubtitleLangs);
  const openSubtitlesApiKey = useAppStore((s) => s.openSubtitlesApiKey);
  const reactionsEnabled = useAppStore((s) => s.reactionsEnabled);
  const chatPeeksEnabled = useAppStore((s) => s.chatPeeksEnabled);
  const chatTriggerPlacement = useAppStore((s) => s.chatTriggerPlacement);
  const fullWidthPlayBar = useAppStore((s) => s.fullWidthPlayBar);
  const playBarOpacity = useAppStore((s) => s.playBarOpacity);
  const autoCheckUpdates = useAppStore((s) => s.autoCheckUpdates);
  const autoDownloadUpdates = useAppStore((s) => s.autoDownloadUpdates);

  const setUsername = useAppStore((s) => s.setUsername);
  const setAvatarId = useAppStore((s) => s.setAvatarId);
  const setServerEndpoint = useAppStore((s) => s.setServerEndpoint);
  const setServerPassword = useAppStore((s) => s.setServerPassword);
  const setStoreAllowShares = useAppStore((s) => s.setAllowNetworkShares);
  const setHideParticipants = useAppStore((s) => s.setHideParticipants);
  const setHashFilenames = useAppStore((s) => s.setHashFilenames);
  const setAutoFixFileMismatch = useAppStore((s) => s.setAutoFixFileMismatch);
  const setRememberPlaybackPosition = useAppStore((s) => s.setRememberPlaybackPosition);
  const setTrackWatchedEpisodes = useAppStore((s) => s.setTrackWatchedEpisodes);
  const setFixArabicPunctuation = useAppStore((s) => s.setFixArabicPunctuation);
  const setGlobalShortcutsEnabled = useAppStore((s) => s.setGlobalShortcutsEnabled);
  const setOsdEnabled = useAppStore((s) => s.setOsdEnabled);
  const setStartWhenAllReady = useAppStore((s) => s.setStartWhenAllReady);
  const setReducedMotion = useAppStore((s) => s.setReducedMotion);
  const setLowPowerMode = useAppStore((s) => s.setLowPowerMode);
  const setSoundEffectsEnabled = useAppStore((s) => s.setSoundEffectsEnabled);
  const setSkipIntroMode = useAppStore((s) => s.setSkipIntroMode);
  const setOutroNextMode = useAppStore((s) => s.setOutroNextMode);
  const setAutoFetchSubtitles = useAppStore((s) => s.setAutoFetchSubtitles);
  const setPreferredSubtitleLangs = useAppStore((s) => s.setPreferredSubtitleLangs);
  const setOpenSubtitlesApiKey = useAppStore((s) => s.setOpenSubtitlesApiKey);
  const setReactionsEnabled = useAppStore((s) => s.setReactionsEnabled);
  const setChatPeeksEnabled = useAppStore((s) => s.setChatPeeksEnabled);
  const setChatTriggerPlacement = useAppStore((s) => s.setChatTriggerPlacement);
  const setFullWidthPlayBar = useAppStore((s) => s.setFullWidthPlayBar);
  const setPlayBarOpacity = useAppStore((s) => s.setPlayBarOpacity);
  const setAutoCheckUpdates = useAppStore((s) => s.setAutoCheckUpdates);
  const setAutoDownloadUpdates = useAppStore((s) => s.setAutoDownloadUpdates);
  const customLibraryFolders = useAppStore((s) => s.customLibraryFolders);
  const addCustomLibraryFolder = useAppStore((s) => s.addCustomLibraryFolder);
  const removeCustomLibraryFolder = useAppStore((s) => s.removeCustomLibraryFolder);
  const boldSubtitles = useSubtitleStore((s) => s.bold);
  const setBoldSubtitles = useSubtitleStore((s) => s.setBold);
  const overrideAssStyle = useSubtitleStore((s) => s.overrideAssStyle);
  const setOverrideAssStyle = useSubtitleStore((s) => s.setOverrideAssStyle);
  const subPos = useSubtitleStore((s) => s.pos);
  const setSubPos = useSubtitleStore((s) => s.setPos);
  const throttledApplySubStyle = useMemo(
    () =>
      createLeadingTrailingThrottle(() => {
        if (usePlayerStore.getState().loaded) {
          safeMpvCall(
            mpvSetSubStyle(buildSubStyleParams(useSubtitleStore.getState())),
            "settings:mpvSetSubStyle",
          );
        }
      }, 60),
    [],
  );
  useEffect(() => () => throttledApplySubStyle.cancel(), [throttledApplySubStyle]);
  const pushNote = useNotificationStore((s) => s.push);

  const updateStatus = useUpdaterStore((s) => s.status);
  const updateProgress = useUpdaterStore((s) => s.progress);
  const isCheckingUpdates = useUpdaterStore((s) => s.isChecking);
  const isDownloadingUpdate = useUpdaterStore((s) => s.isDownloading);
  const isUpdatePaused = useUpdaterStore((s) => s.isPaused);
  const isApplyingUpdate = useUpdaterStore((s) => s.isApplying);
  const updateError = useUpdaterStore((s) => s.error);
  const initUpdater = useUpdaterStore((s) => s.init);
  const checkForUpdates = useUpdaterStore((s) => s.checkForUpdates);
  const startUpdateDownload = useUpdaterStore((s) => s.startDownload);
  const cancelUpdateDownload = useUpdaterStore((s) => s.cancelDownload);
  const applyAndRestartUpdate = useUpdaterStore((s) => s.applyAndRestart);

  const [endpointDraft, setEndpointDraft] = useState(serverEndpoint);
  const [customEndpointOpen, setCustomEndpointOpen] = useState(() => {
    const low = serverEndpoint.trim().toLowerCase();
    return (
      low !== SYNCPLAY_ENDPOINT.toLowerCase() &&
      low !== CLOUD_ENDPOINT.toLowerCase()
    );
  });
  const [passwordDraft, setPasswordDraft] = useState(serverPassword);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsPath, setLogsPath] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [historyCleared, setHistoryCleared] = useState(false);
  const [reportCopied, setReportCopied] = useState(false);
  const historyTimerRef = useRef<number | null>(null);
  const reportCopyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (historyTimerRef.current !== null) window.clearTimeout(historyTimerRef.current);
      if (reportCopyTimerRef.current !== null) window.clearTimeout(reportCopyTimerRef.current);
    };
  }, []);

  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const voiceInputDevice = useVoiceStore((s) => s.inputDevice);
  const voiceOutputDevice = useVoiceStore((s) => s.outputDevice);
  const voiceInputMode = useVoiceStore((s) => s.inputMode);
  const voicePttVk = useVoiceStore((s) => s.pttVk);
  const voicePttMod = useVoiceStore((s) => s.pttMod);
  const voiceMuteVk = useVoiceStore((s) => s.muteVk);
  const voiceMuteMod = useVoiceStore((s) => s.muteMod);
  const voiceDeafenVk = useVoiceStore((s) => s.deafenVk);
  const voiceDeafenMod = useVoiceStore((s) => s.deafenMod);
  const voiceHotkeyScope = useVoiceStore((s) => s.hotkeyScope);
  const voiceSensitivityDb = useVoiceStore((s) => s.sensitivityDb);
  const voiceAutoSensitivity = useVoiceStore((s) => s.autoSensitivity);
  const voiceNoiseMode = useVoiceStore((s) => s.noiseMode);
  const voiceCompression = useVoiceStore((s) => s.compressionEnabled);
  const voiceDuckingMode = useVoiceStore((s) => s.duckingMode);
  const voiceCinemaTightGate = useVoiceStore((s) => s.cinemaTightGate);
  const voiceSpatialPan = useVoiceStore((s) => s.spatialPan);
  const voiceEchoGuard = useVoiceStore((s) => s.echoGuardEnabled);
  const voiceAecEnabled = useVoiceStore((s) => s.aecEnabled);
  const voiceAllowRelayForOthers = useVoiceStore((s) => s.allowRelayForOthers);
  const voiceAllowRelayedVoice = useVoiceStore((s) => s.allowRelayedVoice);
  const voiceMasterVolume = useVoiceStore((s) => s.masterVolume);
  const voiceDevices = useVoiceStore((s) => s.devices);
  const voiceJoined = useVoiceStore((s) => s.joined);
  const voiceMicTestActive = useVoiceStore((s) => s.micTestActive);
  const voiceCalibration = useVoiceStore((s) => s.calibration);
  const setVoiceCalibration = useVoiceStore((s) => s.setCalibration);
  const voiceSpeakerLeak = useVoiceStore((s) => s.speakerLeakDetected);
  const voiceBtHfpDropped = useVoiceStore((s) => s.bluetoothHfpDropped);
  const voiceStreamStatus = useVoiceStore((s) => s.streamStatus);
  const voiceStreamError = useVoiceStore((s) => s.streamError);
  const voiceLevelDb = useVoiceStore((s) => s.localLevelDb);
  const voiceGateOpen = useVoiceStore((s) => s.localGateOpen);
  const updateVoiceConfig = useVoiceStore((s) => s.updateConfig);
  const setVoiceDevices = useVoiceStore((s) => s.setDevices);
  const setVoiceMicTestActive = useVoiceStore((s) => s.setMicTestActive);
  const [capturingBind, setCapturingBind] = useState<"ptt" | "mute" | "deafen" | null>(null);
  const [hotkeyMessage, setHotkeyMessage] = useState<{ kind: "error" | "warn"; text: string } | null>(
    null,
  );
  const [voiceDiag, setVoiceDiag] = useState<VoiceDiagnosticsDto | null>(null);
  const [voiceAdvancedOpen, setVoiceAdvancedOpen] = useState(false);
  const navTrackRef = useRef<HTMLDivElement | null>(null);
  const navButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const prevNavTabRef = useRef<SettingsTab>(tab);
  const [navIndicator, setNavIndicator] = useState<{ top: number; height: number; visible: boolean }>({
    top: 0,
    height: 0,
    visible: false,
  });
  const [navMorphing, setNavMorphing] = useState(false);
  const { mounted, exiting } = useAnimatedPresence(open, 200);

  useLayoutEffect(() => {
    const wrap = navTrackRef.current;
    if (!wrap || !mounted) return;
    const isCollapsedTab = !advancedOpen && (tab === "server" || tab === "logs");
    const measure = () => {
      if (isCollapsedTab) {
        setNavIndicator((prev) => ({ ...prev, visible: false }));
        return;
      }
      const btn = navButtonRefs.current[tab];
      if (!btn || !wrap) return;
      const wRect = wrap.getBoundingClientRect();
      const bRect = btn.getBoundingClientRect();
      if (bRect.height < 8) {
        setNavIndicator((prev) => ({ ...prev, visible: false }));
        return;
      }
      setNavIndicator({
        top: Math.round(bRect.top - wRect.top + wrap.scrollTop),
        height: Math.round(bRect.height),
        visible: true,
      });
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(wrap);
    const timer = window.setTimeout(measure, 260);
    return () => {
      ro?.disconnect();
      window.clearTimeout(timer);
    };
  }, [tab, advancedOpen, mounted]);

  useEffect(() => {
    if (prevNavTabRef.current !== tab) {
      setNavMorphing(true);
      const timer = window.setTimeout(() => setNavMorphing(false), 210);
      prevNavTabRef.current = tab;
      return () => window.clearTimeout(timer);
    }
  }, [tab]);

  useEffect(() => {
    if (open) {
      setEndpointDraft(serverEndpoint);
      const low = serverEndpoint.trim().toLowerCase();
      setCustomEndpointOpen(
        low !== SYNCPLAY_ENDPOINT.toLowerCase() &&
          low !== CLOUD_ENDPOINT.toLowerCase(),
      );
      setPasswordDraft(serverPassword);
      setEndpointError(null);
      if (tab === "server" || tab === "logs") {
        setAdvancedOpen(true);
      }
      void initUpdater();
    }
  }, [open, serverEndpoint, serverPassword, initUpdater, tab]);

  const wasVoiceTabOpenRef = useRef(false);

  useEffect(() => {
    if (open && tab === "voice") {
      if (!wasVoiceTabOpenRef.current) {
        wasVoiceTabOpenRef.current = true;
        acquireMicMonitorSurface();
      }
      let active = true;
      let unlistenLevel: (() => void) | null = null;
      let unlistenCal: (() => void) | null = null;
      let unlistenDev: (() => void) | null = null;
      void onVoiceLevel((lvl) => {
        if (active) {
          useVoiceStore.getState().setLocalLevel(lvl.db, lvl.speechProb, lvl.gateOpen);
        }
      }).then((fn) => {
        if (active) unlistenLevel = fn;
        else fn();
      });
      void onVoiceDevicesChanged(() => {
        if (!active) return;
        const s = useVoiceStore.getState();
        void voiceListDevices(s.inputDevice, s.outputDevice)
          .then((d) => {
            if (active) setVoiceDevices(d);
          })
          .catch(() => undefined);
      }).then((fn) => {
        if (active) unlistenDev = fn;
        else fn();
      });
      void onVoiceCalibration((cal) => {
        if (!active) return;
        setVoiceCalibration(cal);
        if (cal.phase === "done" && typeof cal.recommendedDb === "number") {
          updateVoiceConfig({ sensitivityDb: Math.round(cal.recommendedDb), autoSensitivity: false });
          pushNote(
            "success",
            `Mic calibrated: threshold set to ${Math.round(cal.recommendedDb)} dB.`,
          );
        }
      }).then((fn) => {
        if (active) unlistenCal = fn;
        else fn();
      });
      void voiceListDevices(voiceInputDevice, voiceOutputDevice)
        .then((d) => {
          if (active) setVoiceDevices(d);
        })
        .catch(() => undefined);
      if (voiceEnabled) {
        void voiceStartMicMonitor(useVoiceStore.getState().micTestActive).catch(() => undefined);
      }
      void voiceGetDiagnostics()
        .then((diag) => {
          if (active) setVoiceDiag(diag);
        })
        .catch(() => undefined);
      const iv = window.setInterval(() => {
        void voiceGetDiagnostics()
          .then((diag) => {
            if (active) setVoiceDiag(diag);
          })
          .catch(() => undefined);
      }, 1000);
      return () => {
        active = false;
        unlistenLevel?.();
        unlistenCal?.();
        unlistenDev?.();
        window.clearInterval(iv);
      };
    } else if (wasVoiceTabOpenRef.current) {
      wasVoiceTabOpenRef.current = false;
      setCapturingBind(null);
      setHotkeyMessage(null);
      if (releaseMicMonitorSurface() === 0) {
        if (useVoiceStore.getState().micTestActive) {
          setVoiceMicTestActive(false);
        }
        void voiceStopMicMonitor().catch(() => undefined);
      }
    }
  }, [
    open,
    tab,
    voiceEnabled,
    voiceInputDevice,
    voiceOutputDevice,
    setVoiceDevices,
    setVoiceMicTestActive,
    setVoiceCalibration,
    updateVoiceConfig,
    pushNote,
  ]);

  useEffect(() => {
    return () => {
      if (wasVoiceTabOpenRef.current) {
        wasVoiceTabOpenRef.current = false;
        if (releaseMicMonitorSurface() === 0) {
          if (useVoiceStore.getState().micTestActive) {
            setVoiceMicTestActive(false);
          }
          void voiceStopMicMonitor().catch(() => undefined);
        }
      }
    };
  }, [setVoiceMicTestActive]);

  useEffect(() => {
    if (!capturingBind) return;
    const applyBind = (vk: number, mod: number) => {
      const check = validateVoiceHotkey(vk, mod, voiceHotkeyScope);
      if (!check.valid) {
        setHotkeyMessage({ kind: "error", text: check.reason ?? "Invalid hotkey." });
        return;
      }
      setHotkeyMessage(
        check.warning ? { kind: "warn", text: check.warning } : null,
      );
      if (capturingBind === "ptt") updateVoiceConfig({ pttVk: vk, pttMod: mod });
      else if (capturingBind === "mute") updateVoiceConfig({ muteVk: vk, muteMod: mod });
      else updateVoiceConfig({ deafenVk: vk, deafenMod: mod });
      setCapturingBind(null);
    };
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturingBind(null);
        setHotkeyMessage(null);
        return;
      }
      if (e.key === "Control" || e.key === "Alt" || e.key === "Shift" || e.key === "Meta") {
        return; // Wait for primary key after modifier press
      }
      if (e.key === "Backspace" || e.key === "Delete") {
        setHotkeyMessage(null);
        if (capturingBind === "ptt") updateVoiceConfig({ pttVk: 0, pttMod: 0 });
        else if (capturingBind === "mute") updateVoiceConfig({ muteVk: 0, muteMod: 0 });
        else updateVoiceConfig({ deafenVk: 0, deafenMod: 0 });
        setCapturingBind(null);
        return;
      }
      const vk = domEventToWindowsVk(e);
      if (vk) {
        applyBind(vk, domEventModifiersMask(e));
      }
    };
    const onMouse = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        const vk = e.button === 3 ? 0x05 : 0x06;
        applyBind(vk, domEventModifiersMask(e));
      }
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onMouse, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onMouse, true);
    };
  }, [capturingBind, voiceHotkeyScope, updateVoiceConfig]);

  const loadLogs = async () => {
    setLogsLoading(true);
    try {
      const snap = await getLogsSnapshot(150);
      setLogs(snap.entries);
      setLogsPath(snap.logFilePath ?? null);
    } finally {
      setLogsLoading(false);
    }
  };

  useEffect(() => {
    if (open && tab === "logs") {
      void loadLogs();
    }
  }, [open, tab]);

  const availableRelease = updateStatus?.availableRelease ?? null;
  const releaseNoteItems = useMemo(
    () => parseReleaseNotes(availableRelease?.notes),
    [availableRelease?.notes],
  );

  if (!mounted) return null;

  const handleSaveServer = () => {
    const check = validateServerEndpointInput(endpointDraft);
    if (!check.ok || !check.endpoint) {
      setEndpointError(check.reason ?? "Invalid server address.");
      return;
    }
    setEndpointError(null);
    setServerEndpoint(check.endpoint);
    setServerPassword(passwordDraft);
    onApplyServerConfig?.(check.endpoint, passwordDraft);
    pushNote("success", `Connection updated to ${check.endpoint}.`);
    onClose();
  };

  const availability = updateStatus?.availability ?? "upToDate";
  const progressFraction = Math.min(1, Math.max(0, (updateProgress?.percent ?? 0) / 100));
  const lastCheckedLabel = updateStatus?.checkedAtUnix
    ? new Date(updateStatus.checkedAtUnix * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Preferences"
    >
      {/* Sibling backdrop scrim so Blink/WebView2 composites .ep-glass-sheet backdrop-filter without nesting into a parent backdrop root. */}
      <div
        aria-hidden="true"
        onClick={() => {
          if (!exiting) onClose();
        }}
        className={`ep-modal-backdrop ${
          exiting ? "anim-backdrop-out pointer-events-none" : "anim-backdrop-in"
        } fixed inset-0`}
      />
      <div
        className={`ep-glass-sheet ep-settings-sheet ${
          exiting ? "anim-modal-out" : "anim-modal-in"
        } relative z-10 w-full max-w-[660px] h-[480px] max-h-[85vh] rounded-[28px] overflow-hidden grid grid-cols-12`}
      >
        {/* Left Navigation Rail — clean smoked-obsidian frosted glass pane */}
        <aside className="col-span-4 ep-settings-sidebar flex flex-col min-h-0 min-w-0 overflow-hidden">
          <div
            ref={navTrackRef}
            onTransitionEnd={(e) => {
              if (e.target === e.currentTarget) return;
              const btn = navButtonRefs.current[tab];
              const wrap = navTrackRef.current;
              const isCollapsedTab = !advancedOpen && (tab === "server" || tab === "logs");
              if (!btn || !wrap || isCollapsedTab) return;
              const bRect = btn.getBoundingClientRect();
              const wRect = wrap.getBoundingClientRect();
              if (bRect.height >= 8) {
                setNavIndicator({
                  top: Math.round(bRect.top - wRect.top + wrap.scrollTop),
                  height: Math.round(bRect.height),
                  visible: true,
                });
              }
            }}
            className="ep-settings-scroll relative z-10 flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-4 py-3 my-1 flex flex-col justify-between gap-3"
          >
            {navIndicator.height > 0 && (
              <span
                aria-hidden="true"
                data-morphing={navMorphing ? "true" : undefined}
                className={`ep-droplet-indicator ep-droplet-nav pointer-events-none absolute left-4 right-4 top-0 rounded-[13px] ${
                  navIndicator.visible ? "opacity-100" : "opacity-0"
                }`}
                style={{
                  height: `${navIndicator.height}px`,
                  transform: `translateY(${navIndicator.top}px)${
                    navMorphing ? " scaleY(1.06) scaleX(0.97)" : ""
                  }`,
                }}
              />
            )}
            <div className="relative z-10 space-y-3">
              <div className="px-3 pt-1 flex items-center justify-between">
                <h2 className="text-sm font-semibold tracking-tight text-white">Preferences</h2>
              </div>

              <nav className="space-y-1" aria-label="Preference sections">
                {PRIMARY_NAV.map((item) => {
                  const active = tab === item.value;
                  return (
                    <button
                      key={item.value}
                      ref={(el) => {
                        navButtonRefs.current[item.value] = el;
                      }}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setTab(item.value)}
                      className={`ep-menu-row ep-press relative z-10 w-full px-3 py-2 flex items-center gap-2.5 text-left text-xs cursor-pointer ${
                        active ? "text-white font-semibold" : "text-secondary hover:text-white"
                      }`}
                    >
                      {renderCategoryIcon(item.value, active)}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </nav>
            </div>

            {/* Tucked-away Advanced section */}
            <div className="relative z-10 space-y-1">
              <button
                type="button"
                onClick={() => setAdvancedOpen((o) => !o)}
                className="ep-press w-full px-2.5 py-1.5 flex items-center justify-between text-[11px] font-medium text-muted hover:text-secondary cursor-pointer"
              >
                <span className="inline-flex items-center gap-1.5">
                  <AppWrenchIcon size={13} active={advancedOpen} />
                  Advanced
                </span>
                <AppChevronIcon
                  direction="down"
                  size={12}
                  className={`transition-transform duration-200 ${
                    advancedOpen ? "rotate-180" : ""
                  }`}
                />
              </button>

              <AnimatedCollapse open={advancedOpen} innerClassName="space-y-1 pt-1">
                {ADVANCED_NAV.map((item) => {
                  const active = tab === item.value;
                  return (
                    <button
                      key={item.value}
                      ref={(el) => {
                        navButtonRefs.current[item.value] = el;
                      }}
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => setTab(item.value)}
                      className={`ep-menu-row ep-press relative z-10 w-full px-3 py-2 flex items-center gap-2.5 text-left text-xs cursor-pointer ${
                        active ? "text-white font-semibold" : "text-muted hover:text-white"
                      }`}
                    >
                      {renderCategoryIcon(item.value, active)}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </AnimatedCollapse>
            </div>
          </div>
        </aside>

        {/* Right Content Pane — Zero boxed cards per row and zero partial lines */}
        <div className="col-span-8 ep-settings-content flex flex-col min-h-0 min-w-0">
          <div className="px-6 pt-4 pb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-muted">
              {NAV_HEADINGS[tab] ?? "Preferences"}
            </span>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close settings"
              className="ep-bar-icon-btn ep-press h-7 w-7 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
            >
              <AppCloseIcon size={16} />
            </button>
          </div>

          <div className="ep-settings-scroll flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden pl-6 pr-[18px] mr-1.5 my-1 py-3">
            {tab === "profile" && (
              <div className="anim-tab-in px-3 py-1 space-y-4">
                <div className="flex items-end gap-3">
                  <ProfileAvatar
                    avatarId={avatarId}
                    size={40}
                    className="ring-2 ring-accent/55 shadow-[0_6px_18px_rgba(124,58,237,0.3)]"
                  />
                  <div className="flex-1 min-w-0">
                    <TextField
                      label="Display Name"
                      value={username}
                      maxLength={32}
                      placeholder="Viewer"
                      onChange={(e) => setUsername(e.target.value)}
                    />
                  </div>
                </div>

                <AvatarPicker
                  value={avatarId}
                  onChange={setAvatarId}
                  compact
                />
              </div>
            )}

            {tab === "appearance" && (
              <div className="anim-tab-in space-y-1">
                <div className="px-3 py-3 space-y-2.5">
                  <div className="space-y-0.5">
                    <div className="text-xs font-medium text-white">
                      Full-Width Bottom Play Bar
                    </div>
                    <p className="text-[11px] text-secondary leading-relaxed">
                      Switch between the floating glass capsule or a full-width bottom bar that auto-hides during playback and fullscreen until the mouse moves.
                    </p>
                  </div>
                  <SegmentedTabs
                    ariaLabel="Full-Width Bottom Play Bar style"
                    size="sm"
                    fullWidth
                    value={fullWidthPlayBar ? "full-width" : "floating"}
                    items={[
                      { value: "floating", label: "Floating Capsule" },
                      { value: "full-width", label: "Full-Width Bar" },
                    ]}
                    onChange={(mode) => setFullWidthPlayBar(mode === "full-width")}
                  />
                </div>

                <div className="px-3 py-3 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="space-y-0.5 min-w-0">
                      <div className="text-xs font-medium text-white">
                        Play Bar Opacity
                      </div>
                      <p className="text-[11px] text-secondary leading-relaxed">
                        Adjust how translucent or solid both the floating and full-width play bars appear over video.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0 pt-0.5">
                      {playBarOpacity !== 60 && (
                        <button
                          type="button"
                          onClick={() => setPlayBarOpacity(60)}
                          className="text-[11px] font-medium text-accent-soft hover:text-white cursor-pointer"
                        >
                          Reset
                        </button>
                      )}
                      <span className="text-xs num text-secondary min-w-[34px] text-right">
                        {playBarOpacity}%
                      </span>
                    </div>
                  </div>
                  <Scrubber
                    ariaLabel="Play Bar Opacity"
                    value={playBarOpacity}
                    min={0}
                    max={100}
                    step={1}
                    alwaysShowThumb
                    formatTooltip={(v) => `${Math.round(v)}%`}
                    onChange={setPlayBarOpacity}
                  />
                  <div className="flex items-center justify-between text-[10px] text-muted select-none">
                    <span>Translucent</span>
                    <span>Solid</span>
                  </div>
                </div>

                <ComfortSwitchRow
                  title="Calm Motion"
                  description="Replace bouncy spring transitions with gentle fades."
                  checked={reducedMotion}
                  onChange={setReducedMotion}
                />

                <ComfortSwitchRow
                  title="Quiet Background Sync"
                  description="Keep subtitle alignment gentle on fans and battery during long movies."
                  checked={lowPowerMode}
                  onChange={setLowPowerMode}
                />
              </div>
            )}

            {tab === "playback" && (
              <div className="anim-tab-in space-y-1">
                <div className="px-3 py-3 space-y-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">Skip Intro</div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Detect opening credits and choose whether to show the Skip Intro button or skip automatically.
                    </div>
                  </div>
                  <SegmentedTabs<SkipIntroMode>
                    ariaLabel="Skip Intro mode"
                    size="sm"
                    fullWidth
                    value={skipIntroMode}
                    onChange={setSkipIntroMode}
                    items={[
                      { value: "off", label: "Off" },
                      { value: "manual", label: "Manual" },
                      { value: "auto", label: "Auto-Skip" },
                    ]}
                  />
                </div>

                <div className="px-3 py-3 space-y-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">Next Episode on Outro</div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Detect ending credits and show the Next Episode pill, or advance automatically.
                    </div>
                  </div>
                  <SegmentedTabs<OutroNextMode>
                    ariaLabel="Next Episode on Outro mode"
                    size="sm"
                    fullWidth
                    value={outroNextMode}
                    onChange={setOutroNextMode}
                    items={[
                      { value: "off", label: "Off" },
                      { value: "manual", label: "Manual" },
                      { value: "auto", label: "Auto-Next" },
                    ]}
                  />
                </div>

                <ComfortSwitchRow
                  title="Remember playback position"
                  description="Save your place for each video and resume automatically when playing solo."
                  checked={rememberPlaybackPosition}
                  onChange={setRememberPlaybackPosition}
                />

                <ComfortSwitchRow
                  title="Track watched episodes"
                  description="Mark episodes as watched after 90% and remember your series progress locally."
                  checked={trackWatchedEpisodes}
                  onChange={setTrackWatchedEpisodes}
                />

                <ComfortSwitchRow
                  title="Fix Arabic punctuation"
                  description="Wrap Arabic SRT/VTT lines with RTL markers so punctuation and mixed numbers render in order."
                  checked={fixArabicPunctuation}
                  onChange={setFixArabicPunctuation}
                />

                <ComfortSwitchRow
                  title="Global shortcuts (Ctrl+Alt+Space / ← / →)"
                  description="Play/pause and seek 10s even when Epilod Party is not in focus."
                  checked={globalShortcutsEnabled}
                  onChange={(enabled) => {
                    setGlobalShortcutsEnabled(enabled);
                    if (!isDesktop()) return;
                    void safeInvoke("set_global_shortcuts_enabled", { enabled }).catch((err) => {
                      setGlobalShortcutsEnabled(!enabled);
                      pushNote("error", err instanceof Error ? err.message : String(err));
                    });
                  }}
                />

                <ComfortSwitchRow
                  title="On-screen video notices (OSD)"
                  description="Show brief overlay notices on the video when friends join, leave, or pause."
                  checked={osdEnabled}
                  onChange={setOsdEnabled}
                />

                <div className="px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">Watch history</div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Clear saved resume positions and watched episode marks.
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      useResumeStore.getState().clearAll();
                      useSeriesProgressStore.getState().clearAll();
                      useRecentRoomsStore.getState().clearSeriesLinks();
                      setHistoryCleared(true);
                      if (historyTimerRef.current !== null) {
                        window.clearTimeout(historyTimerRef.current);
                      }
                      historyTimerRef.current = window.setTimeout(() => {
                        setHistoryCleared(false);
                        historyTimerRef.current = null;
                      }, 2200);
                      pushNote("success", "Watch history cleared.");
                    }}
                    className={`ep-press px-3 h-8 rounded-xl inline-flex items-center gap-1.5 text-xs font-medium shrink-0 cursor-pointer transition-colors duration-200 ${
                      historyCleared
                        ? "bg-ok/15 border border-ok/35 text-ok"
                        : "bg-white/[0.08] hover:bg-white/[0.14] border border-transparent text-secondary hover:text-white"
                    }`}
                  >
                    {historyCleared ? (
                      <>
                        <AppCheckIcon size={13} className="anim-pop-in" />
                        <span>Cleared</span>
                      </>
                    ) : (
                      "Clear watch history"
                    )}
                  </button>
                </div>

                <ComfortSwitchRow
                  title="Bold Subtitle Font"
                  description="Use a bolder caption weight for both Arabic and Latin subtitles."
                  checked={boldSubtitles}
                  onChange={(enabled) => {
                    setBoldSubtitles(enabled);
                    if (usePlayerStore.getState().loaded) {
                      safeMpvCall(
                        mpvSetSubStyle(
                          buildSubStyleParams(useSubtitleStore.getState(), { bold: enabled }),
                        ),
                        "settings:mpvSetSubStyle",
                      );
                    }
                  }}
                />

                <ComfortSwitchRow
                  title="Override Styled Fansubs"
                  description="Apply Epilod's font, size, and color over custom ASS/SSA anime subtitle styles."
                  checked={overrideAssStyle}
                  onChange={(enabled) => {
                    setOverrideAssStyle(enabled);
                    if (usePlayerStore.getState().loaded) {
                      safeMpvCall(
                        mpvSetSubStyle(
                          buildSubStyleParams(useSubtitleStore.getState(), { overrideAss: enabled }),
                        ),
                        "settings:mpvSetSubStyle",
                      );
                    }
                  }}
                />

                <div className="px-3 py-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[13px] font-medium text-white">Subtitle Vertical Position</div>
                    <span className="text-xs num text-secondary">{subPos}%</span>
                  </div>
                  <Scrubber
                    ariaLabel="Subtitle Vertical Position"
                    value={subPos}
                    min={20}
                    max={100}
                    step={1}
                    alwaysShowThumb
                    onChange={(val) => {
                      setSubPos(val);
                      throttledApplySubStyle.call();
                    }}
                    onCommit={() => throttledApplySubStyle.flush()}
                  />
                </div>

                <div className="px-3 py-3 space-y-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">
                      Auto-Fetch Online Subtitles
                    </div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Automatically find and load matching OpenSubtitles tracks when opening a movie or episode.
                    </div>
                  </div>
                  <SegmentedTabs<AutoFetchSubtitleMode>
                    ariaLabel="Auto-Fetch Subtitles mode"
                    size="sm"
                    fullWidth
                    value={autoFetchSubtitles}
                    onChange={setAutoFetchSubtitles}
                    items={[
                      { value: "off", label: "Off" },
                      { value: "missing", label: "Missing Subs" },
                      { value: "language", label: "Preferred Lang" },
                    ]}
                  />
                </div>

                <div className="px-3 py-3 space-y-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">
                      Preferred Subtitle Language
                    </div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Language prioritized for automatic subtitle fetching and online search.
                    </div>
                  </div>
                  <SelectMenu
                    ariaLabel="Preferred Subtitle Language"
                    placement="top"
                    triggerIcon={<MenuEncodingIcon size={13} />}
                    value={preferredSubtitleLangs}
                    options={PREFERRED_SUBTITLE_LANG_OPTIONS}
                    onChange={setPreferredSubtitleLangs}
                  />
                </div>

                <div className="px-3 py-3 space-y-2">
                  <TextField
                    label="OpenSubtitles API Key (Optional)"
                    type="password"
                    value={openSubtitlesApiKey}
                    onChange={(e) => setOpenSubtitlesApiKey(e.target.value)}
                    placeholder="Not required — built-in search works automatically"
                    hint="Optional personal opensubtitles.com REST key for extra hash & query results."
                  />
                </div>
              </div>
            )}

            {tab === "party" && (
              <div className="anim-tab-in space-y-1">
                <ComfortSwitchRow
                  title="Floating Party Reactions"
                  description="Show live floating emoji reactions from Watch Party friends over the video (keys 1–7 or E)."
                  checked={reactionsEnabled}
                  onChange={setReactionsEnabled}
                />

                <ComfortSwitchRow
                  title="Ambient Chat Peeks"
                  description="Briefly surface incoming room messages in soft glass pills over the corner when chat is closed."
                  checked={chatPeeksEnabled}
                  onChange={setChatPeeksEnabled}
                />

                <div className="px-3 py-3 space-y-2.5">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">Chat Button Placement</div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Choose whether to keep the Party Chat button in the bottom play bar or as a slim tab on the right edge.
                    </div>
                  </div>
                  <SegmentedTabs<ChatTriggerPlacement>
                    ariaLabel="Chat Button Placement"
                    size="sm"
                    fullWidth
                    value={chatTriggerPlacement}
                    onChange={setChatTriggerPlacement}
                    items={[
                      { value: "playbar", label: "Play Bar" },
                      { value: "edge", label: "Right Edge" },
                    ]}
                  />
                </div>

                <ComfortSwitchRow
                  title="Subtle Party Sound Cues"
                  description="Play soft acoustic glass tones when friends join, leave, or ready up (automatically quieter during playback)."
                  checked={soundEffectsEnabled}
                  onChange={(enabled) => {
                    setSoundEffectsEnabled(enabled);
                    if (enabled) {
                      playSoundCue("peerJoined", { forcePreview: true });
                    }
                  }}
                />

                <ComfortSwitchRow
                  title="Streamer Mode (Hide Profile Icons)"
                  description="Hide friend names and profile avatars while streaming or sharing your screen."
                  checked={hideParticipants}
                  onChange={setHideParticipants}
                />

                <ComfortSwitchRow
                  title="Private File Titles"
                  description="Keep your local movie filename private from party servers."
                  checked={hashFilenames}
                  onChange={setHashFilenames}
                />

                <ComfortSwitchRow
                  title="Auto-fix file differences"
                  description="Automatically match known frame-rate differences (like 23.976 vs 25 fps) with a one-click Undo."
                  checked={autoFixFileMismatch}
                  onChange={setAutoFixFileMismatch}
                />

                <ComfortSwitchRow
                  title="Start when all ready"
                  description="Automatically start playback 2 seconds after everyone in the room marks Ready."
                  checked={startWhenAllReady}
                  onChange={setStartWhenAllReady}
                />
              </div>
            )}

            {tab === "voice" && (
              <div className="anim-tab-in space-y-2.5">
                <ComfortSwitchRow
                  title="Enable Voice Chat"
                  description="Master switch for P2P voice chat in watch parties. Disable to turn off all voice controls and audio workers."
                  checked={voiceEnabled}
                  onChange={(v) => updateVoiceConfig({ voiceEnabled: v })}
                />

                {voiceDevices?.permissionDenied && (
                  <div className="ep-glass-tray rounded-xl px-3 py-2.5 flex items-center justify-between gap-2 text-xs">
                    <span className="text-bad font-medium">
                      Microphone permission blocked by Windows Privacy Settings.
                    </span>
                    <a
                      href="ms-settings:privacy-microphone"
                      className="ep-bar-pill px-2.5 py-1 rounded-full text-[11px] font-medium text-white shrink-0"
                    >
                      Open Privacy
                    </a>
                  </div>
                )}

                {(voiceStreamStatus === "micBusy" ||
                  voiceStreamStatus === "reconnecting" ||
                  voiceBtHfpDropped ||
                  voiceSpeakerLeak) && (
                  <div className="ep-glass-tray rounded-xl px-3 py-2 space-y-1 text-xs">
                    {voiceStreamStatus === "micBusy" && (
                      <div className="text-bad font-medium">
                        {voiceStreamError ?? "Mic in use by another app."}
                      </div>
                    )}
                    {voiceStreamStatus === "reconnecting" && (
                      <div className="text-warn font-medium">
                        {voiceStreamError ?? "Mic lost, reconnecting…"}
                      </div>
                    )}
                    {voiceBtHfpDropped && (
                      <div className="text-warn">
                        Your headset switched to call quality (HFP). Select a wired/USB mic for HD stereo playback.
                      </div>
                    )}
                    {voiceSpeakerLeak && (
                      <div className="text-warn">
                        It looks like you&apos;re on speakers. Use headphones or switch to push-to-talk.
                      </div>
                    )}
                  </div>
                )}

                {voiceDevices?.bluetoothSplitNotice && (
                  <div className="ep-glass-tray rounded-xl px-3 py-2 text-xs text-accent-soft leading-relaxed">
                    {voiceDevices.bluetoothSplitNotice}
                  </div>
                )}

                {voiceDevices?.activeInputIsBluetooth && (
                  <div className="ep-glass-tray rounded-xl px-3 py-2 text-xs text-warn leading-relaxed">
                    Bluetooth mics switch headsets into low-quality call mode on Windows and degrade movie audio. Use a built-in or USB mic for HD movie sound.
                  </div>
                )}

                <div className="px-3 py-2 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[13px] font-medium text-white">Audio Devices</div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void voiceListDevices(voiceInputDevice, voiceOutputDevice)
                          .then((d) => setVoiceDevices(d))
                          .catch(() => undefined)
                      }
                    >
                      <AppResetIcon size={13} />
                      Refresh
                    </Button>
                  </div>
                  <div className="space-y-1.5">
                    <div className="text-[11px] text-secondary">Microphone (Input)</div>
                    <SelectMenu
                      ariaLabel="Voice Input Device"
                      triggerIcon={<AppMicIcon size={13} />}
                      value={voiceInputDevice}
                      options={[
                        {
                          value: "default",
                          label: voiceDevices?.defaultCommInput
                            ? `Default (Communications · ${voiceDevices.defaultCommInput})`
                            : "Default (Communications)",
                        },
                        ...(voiceDevices?.inputs ?? []).map((d) => ({
                          value: d.id,
                          label: d.isBluetooth ? `${d.label} (Bluetooth)` : d.label,
                        })),
                      ]}
                      onChange={(val) => updateVoiceConfig({ inputDevice: val })}
                    />
                  </div>
                  <div className="space-y-1.5 pt-1">
                    <div className="text-[11px] text-secondary">Headphones / Speakers (Output)</div>
                    <SelectMenu
                      ariaLabel="Voice Output Device"
                      triggerIcon={<AppHeadphonesIcon size={13} />}
                      value={voiceOutputDevice}
                      options={[
                        {
                          value: "default",
                          label: voiceDevices?.defaultCommOutput
                            ? `Default (Communications · ${voiceDevices.defaultCommOutput})`
                            : "Default (Communications)",
                        },
                        ...(voiceDevices?.outputs ?? []).map((d) => ({
                          value: d.id,
                          label: d.isBluetooth ? `${d.label} (Bluetooth)` : d.label,
                        })),
                      ]}
                      onChange={(val) => updateVoiceConfig({ outputDevice: val })}
                    />
                  </div>
                  <div className="space-y-1.5 pt-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-1.5 text-secondary">
                        <AppSpeakerVolumeIcon muted={voiceMasterVolume === 0} size={13} />
                        <span>Master Voice Volume</span>
                      </span>
                      <span className="num font-medium text-white">
                        {Math.round(voiceMasterVolume * 100)}%
                      </span>
                    </div>
                    <Scrubber
                      ariaLabel="Master Voice Volume"
                      min={0}
                      max={200}
                      step={5}
                      value={Math.round(voiceMasterVolume * 100)}
                      alwaysShowThumb
                      formatTooltip={(v) => `${Math.round(v)}%`}
                      onChange={(v) => updateVoiceConfig({ masterVolume: v / 100 })}
                    />
                  </div>
                </div>

                <div className="px-3 py-2 space-y-2.5">
                  <div className="text-[13px] font-medium text-white">Input Mode</div>
                  <SegmentedTabs<VoiceInputMode>
                    ariaLabel="Voice Input Mode"
                    size="sm"
                    fullWidth
                    value={voiceInputMode}
                    onChange={(m) => updateVoiceConfig({ inputMode: m })}
                    items={[
                      { value: "vad", label: "Voice Activity" },
                      { value: "ptt", label: "Push-to-Talk" },
                    ]}
                  />

                  <div className="grid grid-cols-3 gap-2 pt-1">
                    {([
                      {
                        key: "ptt" as const,
                        label: "PTT Key",
                        vk: voicePttVk,
                        mod: voicePttMod,
                        clear: () => updateVoiceConfig({ pttVk: 0, pttMod: 0 }),
                      },
                      {
                        key: "mute" as const,
                        label: "Toggle Mute",
                        vk: voiceMuteVk,
                        mod: voiceMuteMod,
                        clear: () => updateVoiceConfig({ muteVk: 0, muteMod: 0 }),
                      },
                      {
                        key: "deafen" as const,
                        label: "Toggle Deafen",
                        vk: voiceDeafenVk,
                        mod: voiceDeafenMod,
                        clear: () => updateVoiceConfig({ deafenVk: 0, deafenMod: 0 }),
                      },
                    ] as const).map((slot) => {
                      const activeCap = capturingBind === slot.key;
                      return (
                        <div key={slot.key} className="relative">
                          <button
                            type="button"
                            onClick={() => {
                              setHotkeyMessage(null);
                              setCapturingBind(activeCap ? null : slot.key);
                            }}
                            className={`ep-menu-row ep-press w-full px-2.5 py-2 pr-6 rounded-xl text-left cursor-pointer ${
                              activeCap ? "ring-1 ring-accent-soft" : ""
                            }`}
                          >
                            <div className="text-[10.5px] text-muted">{slot.label}</div>
                            <div className="text-xs font-medium text-white truncate">
                              {activeCap ? "Press key…" : formatVoiceHotkey(slot.vk, slot.mod)}
                            </div>
                          </button>
                          {slot.vk > 0 && !activeCap && (
                            <button
                              type="button"
                              aria-label={`Clear ${slot.label}`}
                              title="Unbind hotkey"
                              onClick={(e) => {
                                e.stopPropagation();
                                setHotkeyMessage(null);
                                slot.clear();
                              }}
                              className="ep-bar-icon-btn absolute top-1.5 right-1.5 h-4.5 w-4.5 rounded-full flex items-center justify-center text-muted hover:text-white cursor-pointer"
                            >
                              <AppCloseIcon size={10} />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <div className="text-[10.5px] text-muted">
                    Supports Ctrl/Alt/Shift combos, F-keys, or Mouse 4/5 · Esc cancels binding
                  </div>
                  {hotkeyMessage && (
                    <div
                      className={`text-[11px] leading-snug ${
                        hotkeyMessage.kind === "error" ? "text-bad" : "text-warn"
                      }`}
                    >
                      {hotkeyMessage.text}
                    </div>
                  )}
                </div>

                <ComfortSwitchRow
                  title="Only When Epilod Is Focused"
                  description="Restrict voice hotkeys (PTT, mute, deafen) to when Epilod Party is the active foreground window."
                  checked={voiceHotkeyScope === "focused"}
                  onChange={(v) => updateVoiceConfig({ hotkeyScope: v ? "focused" : "global" })}
                />

                <div className="px-3 py-2 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[13px] font-medium text-white">Input Sensitivity &amp; Mic Test</div>
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={!voiceEnabled || (voiceCalibration !== null && voiceCalibration.phase !== "done" && voiceCalibration.phase !== "error")}
                        onClick={() => {
                          setVoiceCalibration({ phase: "quiet", progress: 0 });
                          void voiceStartCalibration().catch(() => undefined);
                        }}
                      >
                        {voiceCalibration && voiceCalibration.phase !== "done" && voiceCalibration.phase !== "error"
                          ? voiceCalibration.phase === "quiet"
                            ? "Stay quiet…"
                            : "Speak now…"
                          : "Calibrate (3s)"}
                      </Button>
                      <Button
                        variant={voiceMicTestActive ? "primary" : "secondary"}
                        size="sm"
                        disabled={!voiceEnabled}
                        onClick={() => {
                          const next = !voiceMicTestActive;
                          setVoiceMicTestActive(next);
                          void voiceStartMicMonitor(next).catch(() => undefined);
                        }}
                      >
                        <AppVoiceWaveIcon active={voiceMicTestActive} size={13} />
                        {voiceMicTestActive ? "Stop Test" : "Let's Check"}
                      </Button>
                    </div>
                  </div>
                  {voiceJoined && voiceMicTestActive && (
                    <div className="text-[11px] text-warn leading-snug">
                      Local mic test active — friends won&apos;t hear you until you stop testing.
                    </div>
                  )}

                  {/* Live dBFS meter with sensitivity marker */}
                  <div className="relative h-2.5 rounded-full bg-white/10 overflow-hidden">
                    <div
                      className={`h-full transition-[width] duration-75 ${
                        voiceGateOpen ? "bg-ok" : "bg-white/35"
                      }`}
                      style={{
                        width: `${Math.max(0, Math.min(100, ((voiceLevelDb + 75) / 75) * 100))}%`,
                      }}
                    />
                    <div
                      className="absolute top-0 bottom-0 w-0.5 bg-accent-soft"
                      style={{
                        left: `${Math.max(0, Math.min(100, ((voiceSensitivityDb + 75) / 75) * 100))}%`,
                      }}
                    />
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-secondary">
                    <span>Threshold: {voiceSensitivityDb} dB</span>
                    <span className={voiceGateOpen ? "text-ok font-medium" : "text-muted"}>
                      {voiceGateOpen ? "Speaking" : "Gated"} ({Math.round(voiceLevelDb)} dB)
                    </span>
                  </div>

                  <Scrubber
                    ariaLabel="Voice Input Sensitivity"
                    min={-75}
                    max={0}
                    step={1}
                    value={voiceSensitivityDb}
                    alwaysShowThumb
                    formatTooltip={(v) => `${Math.round(v)} dB`}
                    onChange={(val) =>
                      updateVoiceConfig({ sensitivityDb: Math.round(val), autoSensitivity: false })
                    }
                  />
                  <ComfortSwitchRow
                    title="Auto-Sensitivity"
                    description="Continuously adapts threshold to steady room noise."
                    checked={voiceAutoSensitivity}
                    onChange={(v) => updateVoiceConfig({ autoSensitivity: v })}
                  />
                </div>

                <div className="px-3 py-2 space-y-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">AI Noise Cancellation</div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Off preserves raw mic and music bit-for-bit; Balanced removes fans &amp; clicks with natural vocal warmth; Strong applies deep background silence.
                    </div>
                  </div>
                  <SegmentedTabs<VoiceNoiseMode>
                    ariaLabel="Noise Cancellation Mode"
                    size="sm"
                    fullWidth
                    value={voiceNoiseMode}
                    onChange={(m) => updateVoiceConfig({ noiseMode: m })}
                    items={[
                      { value: "off", label: "Off" },
                      { value: "balanced", label: "Balanced" },
                      { value: "strong", label: "Strong" },
                    ]}
                  />
                </div>

                <div className="px-3 py-2 space-y-2">
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium text-white">Movie Auto-Ducking</div>
                    <div className="text-xs text-secondary leading-relaxed mt-0.5">
                      Smoothly lowers movie volume while friends speak without moving your player slider.
                    </div>
                  </div>
                  <SegmentedTabs<VoiceDuckingMode>
                    ariaLabel="Movie Auto-Ducking"
                    size="sm"
                    fullWidth
                    value={voiceDuckingMode}
                    onChange={(m) => updateVoiceConfig({ duckingMode: m })}
                    items={[
                      { value: "off", label: "Off" },
                      { value: "subtle", label: "Subtle (-25%)" },
                      { value: "strong", label: "Strong (-40%)" },
                    ]}
                  />
                </div>

                <div className="pt-1">
                  <button
                    type="button"
                    aria-expanded={voiceAdvancedOpen}
                    onClick={() => setVoiceAdvancedOpen((o) => !o)}
                    className="ep-menu-row ep-press w-full px-3 py-2 rounded-xl flex items-center justify-between gap-2 text-left cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div className="text-[12.5px] font-medium text-white">
                        Advanced Audio &amp; Network
                      </div>
                      <div className="text-[11px] text-muted">
                        Compression, echo protection, P2P relay &amp; Voice Health
                      </div>
                    </div>
                    <AppChevronIcon
                      direction="right"
                      size={14}
                      className={`text-muted shrink-0 transition-transform duration-200 ${
                        voiceAdvancedOpen ? "rotate-90" : ""
                      }`}
                    />
                  </button>

                  <AnimatedCollapse open={voiceAdvancedOpen} innerClassName="pt-2 space-y-2.5">
                    <ComfortSwitchRow
                      title="Dynamic Compression & Loudness Leveling"
                      description="Evens quiet whispers and sudden laughs toward -18 dBFS without clipping."
                      checked={voiceCompression}
                      onChange={(v) => updateVoiceConfig({ compressionEnabled: v })}
                    />

                    <ComfortSwitchRow
                      title="Cinema Mode Tight Gate"
                      description="Tightens mic sensitivity by +3 dB while the movie is playing to block snacking/breathing."
                      checked={voiceCinemaTightGate}
                      onChange={(v) => updateVoiceConfig({ cinemaTightGate: v })}
                    />

                    <ComfortSwitchRow
                      title="Subtle Spatial Separation"
                      description="Gently pans multiple speakers slightly left/right so voices stand apart from center dialogue."
                      checked={voiceSpatialPan}
                      onChange={(v) => updateVoiceConfig({ spatialPan: v })}
                    />

                    <ComfortSwitchRow
                      title="Speaker Half-Duplex Echo Guard"
                      description="Detects speaker playback leaking into your mic and softens capture while friends speak."
                      checked={voiceEchoGuard}
                      onChange={(v) => updateVoiceConfig({ echoGuardEnabled: v })}
                    />

                    <ComfortSwitchRow
                      title="Adaptive Echo Canceller (NLMS)"
                      description="Experimental pure-Rust adaptive echo cancellation when Windows communications AEC is unavailable."
                      checked={voiceAecEnabled}
                      onChange={(v) => updateVoiceConfig({ aecEnabled: v })}
                    />

                    <ComfortSwitchRow
                      title="Relay Voice for Strict-NAT Friends"
                      description="Allow your open network to forward encrypted voice for up to 2 blocked peers (decrypted per hop in RAM)."
                      checked={voiceAllowRelayForOthers}
                      onChange={(v) => updateVoiceConfig({ allowRelayForOthers: v })}
                    />

                    <ComfortSwitchRow
                      title="Allow My Voice to Be Relayed"
                      description="Permit a room peer to forward your voice if direct UDP between you and another friend is blocked."
                      checked={voiceAllowRelayedVoice}
                      onChange={(v) => updateVoiceConfig({ allowRelayedVoice: v })}
                    />

                    <div className="ep-glass-tray rounded-xl px-3 py-2.5 space-y-2 text-[11px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium text-white text-xs">Voice Health</span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            void voiceGetReport()
                              .then((rep) => navigator.clipboard?.writeText(rep))
                              .then(() => pushNote("success", "Copied local voice health report."))
                              .catch(() => pushNote("error", "Could not copy voice report."));
                          }}
                        >
                          Copy Voice Report
                        </Button>
                      </div>
                      {voiceDiag ? (
                        <div className="space-y-1.5">
                          <div className="text-secondary num">
                            NAT: {voiceDiag.natMode} · Stream: {voiceDiag.streamStatus} · AEC:{" "}
                            {voiceDiag.aecBackend} · Bitrate: {voiceDiag.bitrateKbps} kbps · Relays:{" "}
                            {voiceDiag.activeRelayStreams}/{voiceDiag.relayCapacityStreams}
                          </div>
                          <div className="text-secondary num">
                            Targets: {voiceDiag.txTargetCount} · Avg Loss: {voiceDiag.avgLossPct.toFixed(1)}% ·
                            Jitter: {voiceDiag.avgJitterMs} ms · Duck: {Math.round(voiceDiag.duckFactor * 100)}%
                          </div>
                          {voiceDiag.streamError && (
                            <div className="text-bad">{voiceDiag.streamError}</div>
                          )}
                          {voiceDiag.peers.length > 0 && (
                            <div className="space-y-1 pt-1">
                              {voiceDiag.peers.map((peer) => (
                                <div
                                  key={peer.username}
                                  className="rounded-lg bg-white/[0.04] px-2.5 py-1.5 space-y-0.5"
                                >
                                  <div className="flex items-center justify-between gap-2">
                                    <span className="font-medium text-white truncate">
                                      {peer.username}
                                    </span>
                                    <span className="text-secondary num">
                                      {peer.transport === "relayed" && peer.relayVia
                                        ? `Relayed via ${peer.relayVia}`
                                        : peer.transport}{" "}
                                      · {peer.rttMs ?? "—"} ms · {peer.lossPct.toFixed(1)}% loss ·{" "}
                                      {peer.jitterMs} ms jitter · {peer.bitrateKbps} kbps ·{" "}
                                      {peer.qualityBars}/4 bars
                                    </span>
                                  </div>
                                  {peer.healthReason && (
                                    <div className="text-warn">{peer.healthReason}</div>
                                  )}
                                  {peer.healthFix && (
                                    <div className="text-muted">Fix: {peer.healthFix}</div>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ) : (
                        <div className="text-muted">
                          Voice diagnostics ready once connected or mic monitor starts.
                        </div>
                      )}
                    </div>
                  </AnimatedCollapse>
                </div>
              </div>
            )}

            {tab === "updates" && (
              <div className="anim-tab-in space-y-3.5">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-block h-2 w-2 rounded-full ${
                          availability === "downloadedReady"
                            ? "bg-ok"
                            : availability === "updateAvailable"
                              ? "bg-accent"
                              : availability === "unsupportedUpgrade"
                                ? "bg-bad"
                                : "bg-muted"
                        }`}
                      />
                      <span className="text-xs font-medium text-white">
                        Installed: v{updateStatus?.currentVersion ?? "0.1.0"}
                      </span>
                    </div>
                    <span className="text-[11px] text-muted">
                      {lastCheckedLabel ? `Checked at ${lastCheckedLabel}` : "Official GitHub Releases"}
                    </span>
                  </div>

                  <p className="text-xs text-secondary leading-relaxed">
                    {updateStatus?.message ?? "Check GitHub Releases for verified updates."}
                  </p>
                </div>

                {availableRelease && (
                  <div className="ep-glass-well rounded-2xl p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-xs font-semibold text-white truncate">
                          Epilod Party v{availableRelease.version}
                        </span>
                        <span className="text-[11px] font-medium text-accent-soft shrink-0">
                          · What’s New
                        </span>
                      </div>
                      <span className="text-[11px] num text-muted shrink-0">
                        {formatBytesCompact(availableRelease.sizeBytes)}
                      </span>
                    </div>
                    {releaseNoteItems.length > 0 && (
                      <ul className="ep-menu-scroll max-h-32 overflow-y-auto pr-1 space-y-1.5">
                        {releaseNoteItems.map((item, idx) => (
                          <li
                            key={`${idx}-${item.title ?? item.body.slice(0, 16)}`}
                            className="flex items-start gap-2 text-[11.5px] leading-snug text-secondary"
                          >
                            <span
                              className="mt-[6px] h-1.5 w-1.5 rounded-full bg-accent-soft/85 shrink-0"
                              aria-hidden="true"
                            />
                            <span className="min-w-0">
                              {item.title && (
                                <span className="font-semibold text-white">
                                  {item.title}
                                  {item.body ? ": " : ""}
                                </span>
                              )}
                              {item.segments.map((seg, segIdx) =>
                                seg.bold ? (
                                  <strong key={segIdx} className="font-semibold text-white">
                                    {seg.text}
                                  </strong>
                                ) : (
                                  <span key={segIdx}>{seg.text}</span>
                                ),
                              )}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="flex items-center gap-1.5 text-[10.5px] num text-muted">
                      <AppShieldIcon size={12} className="text-ok shrink-0" />
                      <span className="truncate">
                        {updateStatus?.signatureVerified
                          ? `Ed25519 Signed · SHA-256: ${availableRelease.sha256.slice(0, 16)}...`
                          : `SHA-256 Verified: ${availableRelease.sha256.slice(0, 16)}...`}
                      </span>
                    </div>

                    {(isDownloadingUpdate || isUpdatePaused || updateProgress?.stage === "verifying") &&
                      updateProgress && (
                        <div className="pt-2 space-y-1.5">
                          <div className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="text-secondary truncate">{updateProgress.message}</span>
                            <div className="flex items-center gap-2 shrink-0">
                              {updateProgress.speedBps > 0 && (
                                <span className="num text-muted">
                                  {formatTransferSpeed(updateProgress.speedBps)}
                                </span>
                              )}
                              <span className="num text-[11.5px] font-semibold text-accent-soft">
                                {Math.round(updateProgress.percent)}%
                              </span>
                            </div>
                          </div>
                          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/12">
                            <div
                              className="ep-scrubber-fill h-full w-full origin-left transition-transform duration-150 ease-out"
                              style={{ transform: `scaleX(${progressFraction})` }}
                            />
                          </div>
                          {updateProgress.totalBytes > 0 && (
                            <div className="flex justify-between text-[10.5px] num text-muted">
                              <span>{formatBytesCompact(updateProgress.downloadedBytes)}</span>
                              <span>{formatBytesCompact(updateProgress.totalBytes)}</span>
                            </div>
                          )}
                        </div>
                      )}
                  </div>
                )}

                {!availableRelease &&
                  (isDownloadingUpdate || isUpdatePaused || updateProgress?.stage === "verifying") &&
                  updateProgress && (
                    <div className="ep-glass-well rounded-2xl p-3.5 space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="text-secondary truncate">{updateProgress.message}</span>
                        <div className="flex items-center gap-2 shrink-0">
                          {updateProgress.speedBps > 0 && (
                            <span className="num text-muted">
                              {formatTransferSpeed(updateProgress.speedBps)}
                            </span>
                          )}
                          <span className="num text-[11.5px] font-semibold text-accent-soft">
                            {Math.round(updateProgress.percent)}%
                          </span>
                        </div>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/12">
                        <div
                          className="ep-scrubber-fill h-full w-full origin-left transition-transform duration-150 ease-out"
                          style={{ transform: `scaleX(${progressFraction})` }}
                        />
                      </div>
                    </div>
                  )}

                {updateError && (
                  <p className="text-[11px] text-bad bg-bad/10 rounded-xl px-3 py-2">
                    {updateError}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-between gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={isCheckingUpdates || isDownloadingUpdate || isApplyingUpdate}
                      onClick={() => void checkForUpdates(false)}
                    >
                      <AppResetIcon
                        clockwise
                        size={14}
                        className={isCheckingUpdates ? "animate-spin" : ""}
                      />
                      {isCheckingUpdates ? "Checking..." : "Check for Updates"}
                    </Button>

                    <div className="flex items-center gap-2">
                      {isDownloadingUpdate && (
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => void cancelUpdateDownload()}
                        >
                          <PlayerPauseIcon size={14} />
                          Pause
                        </Button>
                      )}

                      {!isDownloadingUpdate && availability === "updateAvailable" && availableRelease && (
                        <Button
                          variant="primary"
                          size="sm"
                          onClick={() => void startUpdateDownload()}
                        >
                          <AppDownloadIcon size={14} />
                          {isUpdatePaused ? "Resume Download" : "Download Update"}
                        </Button>
                      )}

                      {availability === "downloadedReady" && availableRelease && (
                        <Button
                          variant="primary"
                          size="sm"
                          disabled={isApplyingUpdate}
                          onClick={() => void applyAndRestartUpdate()}
                        >
                          <AppResetIcon
                            clockwise
                            size={14}
                            className={isApplyingUpdate ? "animate-spin" : ""}
                          />
                          {isApplyingUpdate
                            ? "Launching Updater..."
                            : `Restart & Update to v${availableRelease.version}`}
                        </Button>
                      )}
                    </div>
                </div>

                <div className="pt-0.5 space-y-0.5">
                  <ComfortSwitchRow
                    title="Automatic updates"
                    description="Automatically download and verify new updates in the background so they are ready to install in one click."
                    checked={autoDownloadUpdates}
                    onChange={setAutoDownloadUpdates}
                  />
                  <ComfortSwitchRow
                    title="Check for updates automatically"
                    description="Quietly check GitHub Releases on launch and periodically while the app is open."
                    checked={autoCheckUpdates}
                    onChange={setAutoCheckUpdates}
                  />
                </div>
              </div>
            )}

            {tab === "server" && (
              <div className="anim-tab-in space-y-4">
                <div className="space-y-1.5">
                  <div className="text-xs font-medium text-white">Sync Backend Preset</div>
                  <div className="grid grid-cols-3 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setEndpointDraft(SYNCPLAY_ENDPOINT);
                        setCustomEndpointOpen(false);
                        setEndpointError(null);
                      }}
                      className={`rounded-lg border px-3 py-2 text-left transition cursor-pointer ${
                        !customEndpointOpen &&
                        endpointDraft.trim().toLowerCase() === SYNCPLAY_ENDPOINT.toLowerCase()
                          ? "border-accent bg-accent/15 text-white"
                          : "border-white/10 bg-white/[0.03] text-secondary hover:border-white/20 hover:text-white"
                      }`}
                    >
                      <div className="text-xs font-medium">Syncplay Public</div>
                      <div className="text-[11px] opacity-75">Default · Port 8999</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEndpointDraft(CLOUD_ENDPOINT);
                        setCustomEndpointOpen(false);
                        setEndpointError(null);
                      }}
                      className={`ep-press rounded-lg border px-3 py-2 text-left transition-all duration-200 cursor-pointer ${
                        !customEndpointOpen &&
                        endpointDraft.trim().toLowerCase() === CLOUD_ENDPOINT.toLowerCase()
                          ? "border-accent bg-accent/15 text-white"
                          : "border-white/10 bg-white/[0.03] text-secondary hover:border-white/20 hover:text-white"
                      }`}
                    >
                      <div className="text-xs font-medium">Epilod Cloud</div>
                      <div className="text-[11px] opacity-75">Cloudflare Edge · TLS</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setCustomEndpointOpen(true);
                        if (
                          endpointDraft.trim().toLowerCase() === CLOUD_ENDPOINT.toLowerCase()
                        ) {
                          setEndpointDraft("");
                        }
                        setEndpointError(null);
                      }}
                      className={`ep-press rounded-lg border px-3 py-2 text-left transition-all duration-200 cursor-pointer ${
                        customEndpointOpen
                          ? "border-accent bg-accent/15 text-white"
                          : "border-white/10 bg-white/[0.03] text-secondary hover:border-white/20 hover:text-white"
                      }`}
                    >
                      <div className="text-xs font-medium">Custom Server</div>
                      <div className="text-[11px] opacity-75">Self-hosted / Other</div>
                    </button>
                  </div>
                </div>

                <AnimatedCollapse open={customEndpointOpen}>
                  <TextField
                    label="Sync Server Address"
                    value={endpointDraft}
                    placeholder={DEFAULT_ENDPOINT}
                    onChange={(e) => {
                      setEndpointDraft(e.target.value);
                      if (endpointError) setEndpointError(null);
                    }}
                    error={endpointError}
                    hint="Syncplay (host:port) or Epilod Cloud (wss://host). Friends in the same room must use the same server."
                  />
                </AnimatedCollapse>
                <AnimatedCollapse open={!customEndpointOpen}>
                  <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-[11.5px] text-secondary">
                    Connected provider:{" "}
                    <span className="font-medium text-white">
                      {endpointDraft.trim().toLowerCase() === CLOUD_ENDPOINT.toLowerCase()
                        ? "Epilod Cloud"
                        : "Syncplay Public"}
                    </span>
                  </div>
                </AnimatedCollapse>

                <TextField
                  label="Server / Room Password (Optional)"
                  type="password"
                  value={passwordDraft}
                  maxLength={128}
                  placeholder="Kept in memory for this session only"
                  onChange={(e) => setPasswordDraft(e.target.value)}
                  hint="Never saved to disk."
                />

                <div className="flex items-center justify-between pt-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEndpointDraft(DEFAULT_ENDPOINT);
                      setEndpointError(null);
                    }}
                  >
                    <AppResetIcon size={13} />
                    Reset Default
                  </Button>
                  <Button variant="primary" size="sm" onClick={handleSaveServer}>
                    <AppCheckIcon size={13} />
                    Save Connection
                  </Button>
                </div>

                <div className="pt-1">
                  <ComfortSwitchRow
                    title="Allow Shared LAN Folders (UNC / SMB)"
                    description="Permit opening movies from mapped network paths on your home Wi-Fi."
                    checked={allowNetworkShares}
                    onChange={(allow) => {
                      setStoreAllowShares(allow);
                      void setAllowNetworkShares(allow);
                    }}
                  />
                </div>

                <div className="pt-2 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-white">Media Library Folders</div>
                      <div className="text-[11px] text-secondary leading-snug">
                        Automatically searched alongside Videos &amp; Downloads when friends load a show or movie.
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        if (!isDesktop()) return;
                        void openDialog({
                          directory: true,
                          multiple: false,
                          title: "Add Media Library Folder",
                        }).then((chosen) => {
                          if (typeof chosen === "string" && chosen) {
                            addCustomLibraryFolder(chosen);
                            clearLocalMatchCache();
                          }
                        });
                      }}
                    >
                      Add Folder…
                    </Button>
                  </div>

                  {customLibraryFolders.length > 0 ? (
                    <div className="space-y-1">
                      {customLibraryFolders.map((folder) => (
                        <div
                          key={folder}
                          className="ep-menu-row rounded-xl px-3 py-1.5 flex items-center justify-between gap-2 text-xs"
                        >
                          <span className="truncate text-primary" title={folder}>
                            {folder}
                          </span>
                          <button
                            type="button"
                            aria-label={`Remove ${folder}`}
                            onClick={() => {
                              removeCustomLibraryFolder(folder);
                              clearLocalMatchCache();
                            }}
                            className="ep-press p-1 rounded-lg text-muted hover:text-bad hover:bg-white/[0.08] shrink-0 cursor-pointer"
                          >
                            <AppCloseIcon size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted">
                      No extra folders added yet (Videos, Downloads, Desktop, and saved series folders are already included).
                    </p>
                  )}
                </div>
              </div>
            )}

            {tab === "logs" && (
              <div className="anim-tab-in space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted truncate">
                    {logsPath || "In-memory session log (latest 150 events)"}
                  </p>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        const redact = (s: string) =>
                          s
                            .replace(/[A-Za-z]:\\Users\\[^\\/\s]+/gi, "C:\\Users\\<redacted>")
                            .replace(/\/(Users|home)\/[^/\s]+/g, "/$1/<redacted>")
                            .replace(/(password\s*[:=]\s*)\S+/gi, "$1<redacted>");
                        const lines = logs
                          .slice(-200)
                          .map(
                            (e) =>
                              `[${new Date(e.tsMs).toISOString()}] [${e.level.toUpperCase()}] [${e.target}] ${redact(e.message)}`,
                          );
                        const report = [
                          `Epilod Party Diagnostic Report`,
                          `App Version: ${updateStatus?.currentVersion ?? "unknown"}`,
                          `Platform: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`,
                          `--- Recent Logs (${lines.length}) ---`,
                          ...lines,
                        ].join("\n");
                        void navigator.clipboard
                          ?.writeText(report)
                          .then(() => {
                            setReportCopied(true);
                            if (reportCopyTimerRef.current !== null) {
                              window.clearTimeout(reportCopyTimerRef.current);
                            }
                            reportCopyTimerRef.current = window.setTimeout(() => {
                              setReportCopied(false);
                              reportCopyTimerRef.current = null;
                            }, 2000);
                            pushNote("success", "Diagnostic report copied (paths & passwords redacted).");
                          })
                          .catch(() => pushNote("error", "Could not copy diagnostic report."));
                      }}
                    >
                      {reportCopied ? (
                        <>
                          <AppCheckIcon size={13} className="text-ok anim-pop-in" />
                          <span className="text-ok">Copied</span>
                        </>
                      ) : (
                        "Copy diagnostic report"
                      )}
                    </Button>
                    <Button variant="secondary" size="sm" onClick={() => void loadLogs()}>
                      <AppResetIcon clockwise size={14} className={logsLoading ? "animate-spin" : ""} />
                      Refresh
                    </Button>
                  </div>
                </div>

                <div className="ep-glass-tray h-64 overflow-hidden rounded-2xl py-2 flex flex-col">
                  <div className="ep-settings-scroll flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-3 py-1 ep-mono-log text-[11px] space-y-1">
                    {logs.length === 0 ? (
                      <p className="text-muted p-2">No diagnostic events recorded yet.</p>
                    ) : (
                      logs.map((entry, idx) => (
                        <div key={`${entry.tsMs}-${idx}`} className="flex items-start gap-2 leading-snug">
                          <span
                            className={`uppercase shrink-0 w-10 ${
                              entry.level === "error"
                                ? "text-bad"
                                : entry.level === "warn"
                                  ? "text-warn"
                                  : "text-muted"
                            }`}
                          >
                            {entry.level}
                          </span>
                          <span className="text-secondary shrink-0">[{entry.target}]</span>
                          <span className="text-primary break-words min-w-0">{entry.message}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
