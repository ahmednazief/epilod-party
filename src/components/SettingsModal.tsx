import {
  AppAppearanceCategoryIcon,
  AppCheckIcon,
  AppChevronIcon,
  AppCloseIcon,
  AppDownloadIcon,
  AppLogsIcon,
  AppPartyPrivacyCategoryIcon,
  AppPlaybackCategoryIcon,
  AppProfileCategoryIcon,
  AppResetIcon,
  AppShieldIcon,
  AppSlidersIcon,
  AppWrenchIcon,
} from "./ui/AppIcons";
import { PlayerPauseIcon } from "./ui/PlayerIcons";
import { MenuEncodingIcon } from "./ui/MenuIcons";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { getLogsSnapshot, type LogEntry } from "../lib/logger";
import { mpvSetSubStyle, safeMpvCall, setAllowNetworkShares } from "../lib/mpv";
import { DEFAULT_ENDPOINT } from "../lib/syncStatusDisplay";
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
  type SettingsTab,
  type SkipIntroMode,
} from "../store/useAppStore";
import { useAnimatedPresence } from "../lib/useAnimatedPresence";
import { useNotificationStore } from "../store/useNotificationStore";
import { usePlayerStore } from "../store/usePlayerStore";
import {
  buildSubStyleParams,
  PREFERRED_SUBTITLE_LANG_OPTIONS,
  useSubtitleStore,
} from "../store/useSubtitleStore";
import { useUpdaterStore } from "../store/useUpdaterStore";
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
  const reducedMotion = useAppStore((s) => s.reducedMotion);
  const lowPowerMode = useAppStore((s) => s.lowPowerMode);
  const soundEffectsEnabled = useAppStore((s) => s.soundEffectsEnabled);
  const skipIntroMode = useAppStore((s) => s.skipIntroMode);
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
  const setReducedMotion = useAppStore((s) => s.setReducedMotion);
  const setLowPowerMode = useAppStore((s) => s.setLowPowerMode);
  const setSoundEffectsEnabled = useAppStore((s) => s.setSoundEffectsEnabled);
  const setSkipIntroMode = useAppStore((s) => s.setSkipIntroMode);
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
  const [passwordDraft, setPasswordDraft] = useState(serverPassword);
  const [endpointError, setEndpointError] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsPath, setLogsPath] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
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
      setPasswordDraft(serverPassword);
      setEndpointError(null);
      if (tab === "server" || tab === "logs") {
        setAdvancedOpen(true);
      }
      void initUpdater();
    }
  }, [open, serverEndpoint, serverPassword, initUpdater, tab]);

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
                <TextField
                  label="Syncplay Server Address"
                  value={endpointDraft}
                  placeholder={DEFAULT_ENDPOINT}
                  onChange={(e) => {
                    setEndpointDraft(e.target.value);
                    if (endpointError) setEndpointError(null);
                  }}
                  error={endpointError}
                  hint="Default: syncplay.pl:8999 (backup: syncplay.pl:8998)"
                />

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
              </div>
            )}

            {tab === "logs" && (
              <div className="anim-tab-in space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[11px] text-muted truncate">
                    {logsPath || "In-memory session log (latest 150 events)"}
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => void loadLogs()}>
                    <AppResetIcon clockwise size={14} className={logsLoading ? "animate-spin" : ""} />
                    Refresh
                  </Button>
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
