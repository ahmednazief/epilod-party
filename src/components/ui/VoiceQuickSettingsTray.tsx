import { useEffect, useRef, useState } from "react";
import {
  acquireMicMonitorSurface,
  formatVoiceHotkey,
  releaseMicMonitorSurface,
  voiceListDevices,
  voiceStartMicMonitor,
  voiceStopMicMonitor,
  type VoiceDuckingMode,
  type VoiceInputMode,
  type VoiceNoiseMode,
} from "../../lib/voice";
import { useVoiceStore } from "../../store/useVoiceStore";
import {
  AppCheckIcon,
  AppChevronIcon,
  AppHeadphonesIcon,
  AppMicIcon,
  AppResetIcon,
  AppSlidersIcon,
  AppSpeakerVolumeIcon,
  AppVoiceWaveIcon,
} from "./AppIcons";
import { GlassHoverTip } from "./GlassHoverTip";
import { Scrubber } from "./Scrubber";
import { SegmentedTabs } from "./SegmentedTabs";

interface VoiceQuickSettingsTrayProps {
  /** Whether the tray is currently open/visible (controls device fetch & mic monitor). */
  open: boolean;
  onOpenFullSettings: () => void;
  className?: string;
}

type TraySubView = "main" | "input" | "output" | "filters";

function shortenDeviceName(label: string): string {
  const clean = label.trim();
  if (clean.length <= 20) return clean;
  return `${clean.slice(0, 18)}…`;
}

/**
 * Compact drill-in Voice & Audio submenu popover for quick mic/output/mode/volume/filter adjustments
 * without replacing the Watch Party panel or cluttering a single column with stacked bars.
 */
export function VoiceQuickSettingsTray({
  open,
  onOpenFullSettings,
  className = "",
}: VoiceQuickSettingsTrayProps) {
  const voiceEnabled = useVoiceStore((s) => s.voiceEnabled);
  const joined = useVoiceStore((s) => s.joined);
  const inputDevice = useVoiceStore((s) => s.inputDevice);
  const outputDevice = useVoiceStore((s) => s.outputDevice);
  const inputMode = useVoiceStore((s) => s.inputMode);
  const pttVk = useVoiceStore((s) => s.pttVk);
  const pttMod = useVoiceStore((s) => s.pttMod);
  const sensitivityDb = useVoiceStore((s) => s.sensitivityDb);
  const masterVolume = useVoiceStore((s) => s.masterVolume);
  const noiseMode = useVoiceStore((s) => s.noiseMode);
  const duckingMode = useVoiceStore((s) => s.duckingMode);
  const localLevelDb = useVoiceStore((s) => s.localLevelDb);
  const localGateOpen = useVoiceStore((s) => s.localGateOpen);
  const micTestActive = useVoiceStore((s) => s.micTestActive);
  const devices = useVoiceStore((s) => s.devices);

  const updateConfig = useVoiceStore((s) => s.updateConfig);
  const setDevices = useVoiceStore((s) => s.setDevices);
  const setMicTestActive = useVoiceStore((s) => s.setMicTestActive);

  const [view, setView] = useState<TraySubView>("main");
  const [navDir, setNavDir] = useState<"none" | "push" | "pop">("none");
  const [refreshing, setRefreshing] = useState(false);
  const wasOpenRef = useRef(false);

  const navigateTo = (nextView: TraySubView, dir: "push" | "pop") => {
    setNavDir(dir);
    setView(nextView);
  };

  useEffect(() => {
    if (!open) {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        if (releaseMicMonitorSurface() === 0) {
          if (useVoiceStore.getState().micTestActive) {
            setMicTestActive(false);
          }
          void voiceStopMicMonitor().catch(() => undefined);
        }
      }
      // Keep the current subview visible while the outer close bloom finishes, then reset.
      const resetTimer = window.setTimeout(() => {
        setNavDir("none");
        setView("main");
      }, 210);
      return () => {
        window.clearTimeout(resetTimer);
      };
    }
    if (!wasOpenRef.current) {
      wasOpenRef.current = true;
      acquireMicMonitorSurface();
    }

    let active = true;
    void voiceListDevices(inputDevice, outputDevice)
      .then((d) => {
        if (active) setDevices(d);
      })
      .catch(() => undefined);
    if (voiceEnabled) {
      void voiceStartMicMonitor(useVoiceStore.getState().micTestActive).catch(() => undefined);
    }

    return () => {
      active = false;
    };
  }, [open, voiceEnabled, inputDevice, outputDevice, setDevices, setMicTestActive]);

  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new Event("ep:glass-layout"));
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event("ep:glass-layout"));
    }, 55);
    return () => window.clearTimeout(timer);
  }, [open, view]);

  useEffect(() => {
    return () => {
      if (wasOpenRef.current) {
        wasOpenRef.current = false;
        if (releaseMicMonitorSurface() === 0) {
          if (useVoiceStore.getState().micTestActive) {
            setMicTestActive(false);
          }
          void voiceStopMicMonitor().catch(() => undefined);
        }
      }
    };
  }, [setMicTestActive]);

  const viewAnimClass =
    navDir === "push"
      ? "anim-submenu-push"
      : navDir === "pop"
        ? "anim-submenu-pop"
        : "";

  const handleRefreshDevices = () => {
    if (refreshing) return;
    setRefreshing(true);
    void voiceListDevices(inputDevice, outputDevice)
      .then((d) => setDevices(d))
      .catch(() => undefined)
      .finally(() => {
        window.setTimeout(() => setRefreshing(false), 300);
      });
  };

  const handleToggleMicTest = () => {
    if (!voiceEnabled) return;
    const next = !micTestActive;
    setMicTestActive(next);
    void voiceStartMicMonitor(next).catch(() => undefined);
  };

  const inputOptions = [
    {
      value: "default",
      label: devices?.defaultCommInput
        ? `Default (${devices.defaultCommInput})`
        : "System Default",
      isBluetooth: false,
    },
    ...(devices?.inputs ?? []).map((d) => ({
      value: d.id,
      label: d.label,
      isBluetooth: d.isBluetooth,
    })),
  ];

  const outputOptions = [
    {
      value: "default",
      label: devices?.defaultCommOutput
        ? `Default (${devices.defaultCommOutput})`
        : "System Default",
      isBluetooth: false,
    },
    ...(devices?.outputs ?? []).map((d) => ({
      value: d.id,
      label: d.label,
      isBluetooth: d.isBluetooth,
    })),
  ];

  const activeInputLabel =
    inputDevice === "default"
      ? "System Default"
      : (devices?.inputs.find((d) => d.id === inputDevice)?.label ?? "Custom Mic");
  const activeOutputLabel =
    outputDevice === "default"
      ? "System Default"
      : (devices?.outputs.find((d) => d.id === outputDevice)?.label ?? "Custom Output");

  const levelPct = Math.max(0, Math.min(100, ((localLevelDb + 75) / 75) * 100));
  const noiseSummary =
    noiseMode === "off" ? "Raw" : noiseMode === "balanced" ? "Balanced" : "Strong NS";
  const duckSummary =
    duckingMode === "off" ? "No Duck" : duckingMode === "subtle" ? "Subtle" : "Strong Duck";

  if (view === "input" || view === "output") {
    const isInput = view === "input";
    const list = isInput ? inputOptions : outputOptions;
    const selected = isInput ? inputDevice : outputDevice;

    return (
      <div key={view} className={`${viewAnimClass} w-full space-y-1.5 ${className}`}>
        <div className="flex items-center justify-between gap-1.5">
          <button
            type="button"
            onClick={() => navigateTo("main", "pop")}
            className="ep-menu-row ep-press px-2 py-1 rounded-full inline-flex items-center gap-1 text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
          >
            <AppChevronIcon direction="left" size={12} />
            <span>{isInput ? "Microphone" : "Speaker / Headphones"}</span>
          </button>
          <GlassHoverTip label="Refresh devices" detail="Rescan mics & headphones">
            <button
              type="button"
              aria-label="Refresh audio devices"
              onClick={handleRefreshDevices}
              className="ep-bar-icon-btn ep-press h-6 w-6 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer shrink-0"
            >
              <AppResetIcon size={11} className={refreshing ? "animate-spin" : ""} />
            </button>
          </GlassHoverTip>
        </div>

        <div className="ep-menu-scroll max-h-[196px] overflow-y-auto overflow-x-hidden flex flex-col gap-0.5 pr-0.5">
          {list.map((opt) => {
            const active = opt.value === selected;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  updateConfig(isInput ? { inputDevice: opt.value } : { outputDevice: opt.value });
                  navigateTo("main", "pop");
                }}
                className={`ep-menu-row ep-press w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between gap-2 text-left text-[11px] cursor-pointer ${
                  active ? "bg-white/[0.08] text-white font-medium" : "text-secondary hover:text-white"
                }`}
              >
                <span className="truncate min-w-0">
                  {opt.label}
                  {opt.isBluetooth ? " · BT" : ""}
                </span>
                {active && <AppCheckIcon size={13} className="text-accent-soft shrink-0" />}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (view === "filters") {
    return (
      <div key="filters" className={`${viewAnimClass} w-full space-y-2.5 ${className}`}>
        <div className="flex items-center justify-between gap-1.5">
          <button
            type="button"
            onClick={() => navigateTo("main", "pop")}
            className="ep-menu-row ep-press px-2 py-1 rounded-full inline-flex items-center gap-1 text-[11px] font-medium text-secondary hover:text-white cursor-pointer"
          >
            <AppChevronIcon direction="left" size={12} />
            <span>Mic &amp; Filters</span>
          </button>
          <GlassHoverTip
            label={micTestActive ? "Stop local test" : "Test microphone"}
            detail={
              joined ? "Pauses outgoing voice while testing" : "Hear yourself to check levels"
            }
            accent={micTestActive ? "warn" : "default"}
          >
            <button
              type="button"
              disabled={!voiceEnabled}
              onClick={handleToggleMicTest}
              className={`ep-press h-6 px-2 rounded-full inline-flex items-center gap-1 text-[10px] font-medium cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
                micTestActive
                  ? "bg-[#38BDF8]/20 text-[#38BDF8]"
                  : "ep-bar-pill text-secondary hover:text-white"
              }`}
            >
              <AppVoiceWaveIcon
                active={joined}
                speaking={micTestActive || (joined && localGateOpen)}
                size={11}
              />
              <span>{micTestActive ? "Stop" : "Test Mic"}</span>
            </button>
          </GlassHoverTip>
        </div>

        <div className="px-1 space-y-1.5">
          <div className="flex items-center justify-between gap-2 text-[10.5px]">
            <span className="text-secondary font-medium">Mic Sensitivity</span>
            <span className="num text-muted">{sensitivityDb} dB</span>
          </div>
          <div className="h-[3px] rounded-full bg-white/10 overflow-hidden mb-1">
            <div
              className={`h-full transition-[width] duration-75 ${
                localGateOpen ? "bg-[#38BDF8]" : "bg-white/35"
              }`}
              style={{ width: `${levelPct}%` }}
            />
          </div>
          <Scrubber
            ariaLabel="Quick mic sensitivity"
            min={-75}
            max={0}
            step={1}
            value={sensitivityDb}
            alwaysShowThumb
            formatTooltip={(v) => `${Math.round(v)} dB`}
            onChange={(v) => updateConfig({ sensitivityDb: Math.round(v) })}
          />
        </div>

        <div className="px-1 space-y-1">
          <span className="block text-[10.5px] font-medium text-secondary">
            Noise Cancellation
          </span>
          <SegmentedTabs<VoiceNoiseMode>
            ariaLabel="Quick noise cancellation"
            size="sm"
            fullWidth
            value={noiseMode}
            onChange={(m) => updateConfig({ noiseMode: m })}
            items={[
              { value: "off", label: "Off" },
              { value: "balanced", label: "Balanced" },
              { value: "strong", label: "Strong" },
            ]}
          />
        </div>

        <div className="px-1 space-y-1">
          <span className="block text-[10.5px] font-medium text-secondary">
            Movie Auto-Ducking
          </span>
          <SegmentedTabs<VoiceDuckingMode>
            ariaLabel="Quick movie auto-ducking"
            size="sm"
            fullWidth
            value={duckingMode}
            onChange={(m) => updateConfig({ duckingMode: m })}
            items={[
              { value: "off", label: "Off" },
              { value: "subtle", label: "Subtle" },
              { value: "strong", label: "Strong" },
            ]}
          />
        </div>
      </div>
    );
  }

  return (
    <div key="main" className={`${viewAnimClass} w-full space-y-2 ${className}`}>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-white/90 whitespace-nowrap">
          <AppSlidersIcon size={12} active />
          <span>Voice Audio</span>
        </span>
        <GlassHoverTip label="All Voice &amp; Audio Settings" detail="Hotkeys, calibration &amp; Voice Health">
          <button
            type="button"
            aria-label="All Voice & Audio Settings"
            onClick={onOpenFullSettings}
            className="ep-menu-row ep-press px-2 py-0.5 rounded-full inline-flex items-center gap-0.5 text-[10px] font-medium text-accent-soft hover:text-white whitespace-nowrap cursor-pointer shrink-0"
          >
            <span>All Settings</span>
            <AppChevronIcon direction="right" size={10} />
          </button>
        </GlassHoverTip>
      </div>

      <div className="space-y-0.5">
        <button
          type="button"
          onClick={() => navigateTo("input", "push")}
          className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center justify-between gap-2 text-left text-[11px] text-secondary hover:text-white cursor-pointer"
        >
          <span className="inline-flex items-center gap-2 shrink-0">
            <AppMicIcon size={12} />
            <span>Input</span>
          </span>
          <span className="inline-flex items-center gap-1 min-w-0 text-[10.5px] text-white/75">
            <span className="truncate">{shortenDeviceName(activeInputLabel)}</span>
            <AppChevronIcon direction="right" size={11} className="text-muted shrink-0" />
          </span>
        </button>

        <button
          type="button"
          onClick={() => navigateTo("output", "push")}
          className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center justify-between gap-2 text-left text-[11px] text-secondary hover:text-white cursor-pointer"
        >
          <span className="inline-flex items-center gap-2 shrink-0">
            <AppHeadphonesIcon size={12} />
            <span>Output</span>
          </span>
          <span className="inline-flex items-center gap-1 min-w-0 text-[10.5px] text-white/75">
            <span className="truncate">{shortenDeviceName(activeOutputLabel)}</span>
            <AppChevronIcon direction="right" size={11} className="text-muted shrink-0" />
          </span>
        </button>

        <button
          type="button"
          onClick={() => navigateTo("filters", "push")}
          className="ep-menu-row ep-press w-full px-2 py-1.5 rounded-xl flex items-center justify-between gap-2 text-left text-[11px] text-secondary hover:text-white cursor-pointer"
        >
          <span className="inline-flex items-center gap-2 shrink-0">
            <AppVoiceWaveIcon active={micTestActive} size={12} />
            <span>Mic &amp; Filters</span>
          </span>
          <span className="inline-flex items-center gap-1 min-w-0 text-[10.5px] text-white/75">
            <span className="truncate">{noiseSummary} · {duckSummary}</span>
            <AppChevronIcon direction="right" size={11} className="text-muted shrink-0" />
          </span>
        </button>
      </div>

      <div className="space-y-1 px-1">
        <div className="flex items-center justify-between gap-2 text-[10.5px]">
          <span className="text-secondary font-medium">Mode</span>
          {inputMode === "ptt" && (
            <span className="text-[10px] font-medium text-accent-soft num">
              Hold {formatVoiceHotkey(pttVk, pttMod)}
            </span>
          )}
        </div>
        <SegmentedTabs<VoiceInputMode>
          ariaLabel="Quick voice input mode"
          size="sm"
          fullWidth
          value={inputMode}
          onChange={(m) => updateConfig({ inputMode: m })}
          items={[
            { value: "vad", label: "Voice Activity" },
            { value: "ptt", label: "Push-to-Talk" },
          ]}
        />
      </div>

      <div className="space-y-1 px-1 pb-0.5">
        <div className="flex items-center justify-between gap-2 text-[10.5px]">
          <span className="inline-flex items-center gap-1.5 font-medium text-secondary">
            <AppSpeakerVolumeIcon muted={masterVolume === 0} size={12} />
            <span>Voice Chat Volume</span>
          </span>
          <span className="num font-medium text-white/90">{Math.round(masterVolume * 100)}%</span>
        </div>
        <Scrubber
          ariaLabel="Master voice chat volume"
          min={0}
          max={200}
          step={5}
          value={Math.round(masterVolume * 100)}
          alwaysShowThumb
          formatTooltip={(v) => `${Math.round(v)}%`}
          onChange={(v) => updateConfig({ masterVolume: v / 100 })}
        />
      </div>
    </div>
  );
}
