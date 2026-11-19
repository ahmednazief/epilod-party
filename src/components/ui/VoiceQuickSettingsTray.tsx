import { useEffect, useState } from "react";
import {
  formatVoiceHotkey,
  voiceListDevices,
  voiceStartMicMonitor,
  voiceStopMicMonitor,
  type VoiceDuckingMode,
  type VoiceInputMode,
  type VoiceNoiseMode,
} from "../../lib/voice";
import { useVoiceStore } from "../../store/useVoiceStore";
import {
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
import { SelectMenu } from "./SelectMenu";

interface VoiceQuickSettingsTrayProps {
  /** Whether the tray is currently open/visible (controls device fetch & mic monitor). */
  open: boolean;
  onOpenFullSettings: () => void;
  className?: string;
}

/**
 * Compact in-menu Voice & Audio setup tray for instant mic/output/mode/ducking adjustments
 * without leaving the video or opening full Preferences.
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

  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!open) {
      if (micTestActive) {
        setMicTestActive(false);
        void voiceStopMicMonitor().catch(() => undefined);
      }
      return;
    }

    let active = true;
    void voiceListDevices(inputDevice, outputDevice)
      .then((d) => {
        if (active) setDevices(d);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, [open, inputDevice, outputDevice, micTestActive, setDevices, setMicTestActive]);

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
    if (next) {
      void voiceStartMicMonitor(true).catch(() => undefined);
    } else {
      void voiceStopMicMonitor().catch(() => undefined);
    }
  };

  const inputOptions = [
    {
      value: "default",
      label: devices?.defaultCommInput
        ? `Default · ${devices.defaultCommInput}`
        : "System Default",
    },
    ...(devices?.inputs ?? []).map((d) => ({
      value: d.id,
      label: d.isBluetooth ? `${d.label} (BT)` : d.label,
    })),
  ];

  const outputOptions = [
    {
      value: "default",
      label: devices?.defaultCommOutput
        ? `Default · ${devices.defaultCommOutput}`
        : "System Default",
    },
    ...(devices?.outputs ?? []).map((d) => ({
      value: d.id,
      label: d.isBluetooth ? `${d.label} (BT)` : d.label,
    })),
  ];

  const levelPct = Math.max(0, Math.min(100, ((localLevelDb + 75) / 75) * 100));
  const thresholdPct = Math.max(0, Math.min(100, ((sensitivityDb + 75) / 75) * 100));

  return (
    <div className={`ep-glass-well rounded-2xl p-2.5 space-y-2.5 ${className}`}>
      <div className="flex items-center justify-between gap-2 px-1">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-white/90">
          <AppSlidersIcon size={12} active />
          <span>Audio &amp; Devices</span>
        </span>
        <GlassHoverTip label="Refresh devices" detail="Rescan mics & headphones">
          <button
            type="button"
            aria-label="Refresh audio devices"
            onClick={handleRefreshDevices}
            className="ep-bar-icon-btn ep-press h-6 w-6 rounded-full flex items-center justify-center text-secondary hover:text-white cursor-pointer"
          >
            <AppResetIcon size={12} className={refreshing ? "animate-spin" : ""} />
          </button>
        </GlassHoverTip>
      </div>

      <div className="space-y-1">
        <SelectMenu
          variant="row"
          ariaLabel="Microphone input device"
          label="Mic"
          triggerIcon={<AppMicIcon size={13} />}
          value={inputDevice}
          options={inputOptions}
          onChange={(val) => updateConfig({ inputDevice: val })}
        />
        <SelectMenu
          variant="row"
          ariaLabel="Headphones or speaker output device"
          label="Output"
          triggerIcon={<AppHeadphonesIcon size={13} />}
          value={outputDevice}
          options={outputOptions}
          onChange={(val) => updateConfig({ outputDevice: val })}
        />
      </div>

      <div className="space-y-1.5 px-0.5">
        <div className="flex items-center justify-between gap-2 text-[10.5px]">
          <span className="text-secondary font-medium">Input Mode</span>
          {inputMode === "ptt" && (
            <span className="text-[10px] font-medium text-accent-soft num">
              Key: {formatVoiceHotkey(pttVk, pttMod)}
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

      <div className="space-y-1.5 px-0.5">
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

      <div className="space-y-1.5 px-0.5">
        <div className="flex items-center justify-between gap-2 text-[10.5px]">
          <GlassHoverTip
            label="Mic Sensitivity"
            detail="Threshold gate before voice transmits"
          >
            <span className="text-secondary font-medium cursor-default">
              Sensitivity{" "}
              <span className="num text-muted">({sensitivityDb} dB)</span>
            </span>
          </GlassHoverTip>
          <GlassHoverTip
            label={micTestActive ? "Stop local test" : "Test microphone"}
            detail={
              joined
                ? "Pauses outgoing voice while testing"
                : "Hear yourself to check levels"
            }
            accent={micTestActive ? "warn" : "default"}
          >
            <button
              type="button"
              disabled={!voiceEnabled}
              onClick={handleToggleMicTest}
              className={`ep-press h-5.5 px-2 rounded-full inline-flex items-center gap-1 text-[10px] font-medium cursor-pointer disabled:opacity-45 disabled:pointer-events-none ${
                micTestActive
                  ? "bg-[#38BDF8]/20 text-[#38BDF8]"
                  : "ep-bar-pill text-secondary hover:text-white"
              }`}
            >
              <AppVoiceWaveIcon active={joined} speaking={micTestActive || (joined && localGateOpen)} size={11} />
              <span>{micTestActive ? "Stop Test" : "Test Mic"}</span>
            </button>
          </GlassHoverTip>
        </div>

        <div className="relative h-1.5 rounded-full bg-white/10 overflow-hidden">
          <div
            className={`h-full transition-[width] duration-75 ${
              localGateOpen ? "bg-[#38BDF8]" : "bg-white/35"
            }`}
            style={{ width: `${levelPct}%` }}
          />
          <div
            className="absolute top-0 bottom-0 w-0.5 bg-accent-soft"
            style={{ left: `${thresholdPct}%` }}
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

      <div className="space-y-1.5 px-0.5">
        <GlassHoverTip
          label="AI Noise Cancellation"
          detail={
            noiseMode === "off"
              ? "Off · Raw unprocessed mic"
              : noiseMode === "balanced"
                ? "Balanced · Natural voice + RNNoise"
                : "Strong · Filters fans & keyboards"
          }
        >
          <span className="inline-block text-[10.5px] font-medium text-secondary cursor-default">
            Noise Cancellation
          </span>
        </GlassHoverTip>
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

      <div className="space-y-1.5 px-0.5">
        <GlassHoverTip
          label="Movie Auto-Ducking"
          detail="Smoothly lowers movie volume while friends speak"
        >
          <span className="inline-block text-[10.5px] font-medium text-secondary cursor-default">
            Movie Auto-Ducking
          </span>
        </GlassHoverTip>
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

      <GlassHoverTip
        label="Open Preferences"
        detail="Keybinds, calibration & Voice Health"
        className="block w-full"
      >
        <button
          type="button"
          onClick={onOpenFullSettings}
          className="ep-menu-row ep-press w-full px-2.5 py-1.5 rounded-xl flex items-center justify-between gap-2 text-[11px] font-medium text-accent-soft hover:text-white cursor-pointer"
        >
          <span>All Voice &amp; Audio Settings…</span>
        </button>
      </GlassHoverTip>
    </div>
  );
}
