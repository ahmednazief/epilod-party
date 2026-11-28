#![cfg(windows)]

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use audiopus::coder::{Decoder as OpusDecoder, Encoder as OpusEncoder};
use audiopus::packet::Packet as OpusPacket;
use audiopus::{Application, Bitrate, Channels, MutSignals, SampleRate, Signal};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use epilod_core::logging::{sanitize_log_text, LogEntry};
use epilod_core::mpv_ipc::set_volume_cmd;
use epilod_core::p2p::MAX_VOICE_OPUS_BYTES;
use epilod_core::voice_dsp::{
    frame_dbfs, mix_mono_peers_to_stereo, soft_limit, AdaptiveBitrateController, BiquadHighPass,
    EchoCanceller, JitterPacket, NoiseSuppressionMode, NoopEchoCanceller, PeerJitterBuffer,
    PeerRxLeveler, RxEchoSuppressor, SpeakerEchoDetector, VoiceCalibrator, VoiceCompressor, VoiceDenoiser, VoiceGate,
    WebRtcAec3Canceller, WebRtcAgc2Leveler, WebRtcAgc2Params, VOICE_FRAME_10MS, VOICE_FRAME_20MS,
    VOICE_SAMPLE_RATE,
};
use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::HeapRb;
use rubato::{FastFixedIn, PolynomialDegree, Resampler};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use wasapi::{
    initialize_mta, AudioClientProperties, DeviceEnumerator, DeviceEventCallbacks, Direction, Role,
    SampleType, StreamCategory, StreamMode, WaveFormat,
};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
use windows_sys::Win32::System::Threading::{
    CreateWaitableTimerExW, GetCurrentThread, SetThreadPriority, SetWaitableTimer,
    WaitForSingleObject, CREATE_WAITABLE_TIMER_HIGH_RESOLUTION, INFINITE, THREAD_PRIORITY_HIGHEST,
    TIMER_ALL_ACCESS,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, VK_CONTROL, VK_MENU, VK_SHIFT,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};

use crate::mpv::MpvController;
use crate::p2p::{VoicePeerRosterDto, VoiceTransportHandle};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InputModeWire {
    Vad,
    Ptt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoiseModeWire {
    Off,
    Balanced,
    Strong,
}

impl NoiseModeWire {
    fn into_core(self) -> NoiseSuppressionMode {
        match self {
            Self::Off => NoiseSuppressionMode::Off,
            Self::Balanced => NoiseSuppressionMode::Balanced,
            Self::Strong => NoiseSuppressionMode::Strong,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DuckingModeWire {
    Off,
    Subtle,
    Strong,
}

impl DuckingModeWire {
    fn target_factor(self) -> f64 {
        match self {
            Self::Off => 1.0,
            Self::Subtle => 0.75,
            Self::Strong => 0.60,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VoiceEngineModeWire {
    Aura,
    Classic,
}

fn default_engine_mode() -> VoiceEngineModeWire {
    VoiceEngineModeWire::Aura
}

fn default_true() -> bool {
    true
}

fn default_one() -> f32 {
    1.0
}

fn default_hotkey_scope() -> String {
    "global".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceConfigDto {
    #[serde(default = "default_true")]
    pub voice_enabled: bool,
    pub input_device: String,
    pub output_device: String,
    pub input_mode: InputModeWire,
    pub ptt_vk: i32,
    #[serde(default)]
    pub ptt_mod: u8,
    pub mute_vk: i32,
    #[serde(default)]
    pub mute_mod: u8,
    pub deafen_vk: i32,
    #[serde(default)]
    pub deafen_mod: u8,
    #[serde(default = "default_hotkey_scope")]
    pub hotkey_scope: String,
    pub sensitivity_db: f32,
    #[serde(default = "default_true")]
    pub auto_sensitivity: bool,
    pub noise_mode: NoiseModeWire,
    pub compression_enabled: bool,
    pub ducking_mode: DuckingModeWire,
    pub cinema_tight_gate: bool,
    pub spatial_pan: bool,
    #[serde(default = "default_true")]
    pub echo_guard_enabled: bool,
    #[serde(default = "default_true")]
    pub aec_enabled: bool,
    #[serde(default = "default_engine_mode")]
    pub engine_mode: VoiceEngineModeWire,
    #[serde(default = "default_true")]
    pub use_windows_comm_aec: bool,
    pub allow_relay_for_others: bool,
    pub allow_relayed_voice: bool,
    #[serde(default = "default_one")]
    pub master_volume: f32,
}

impl Default for VoiceConfigDto {
    fn default() -> Self {
        Self {
            voice_enabled: true,
            input_device: "default".to_string(),
            output_device: "default".to_string(),
            input_mode: InputModeWire::Vad,
            ptt_vk: 0x77, // F8 safe default
            ptt_mod: 0,
            mute_vk: 0,
            mute_mod: 0,
            deafen_vk: 0,
            deafen_mod: 0,
            hotkey_scope: "global".to_string(),
            sensitivity_db: -42.0,
            auto_sensitivity: true,
            noise_mode: NoiseModeWire::Balanced,
            compression_enabled: true,
            ducking_mode: DuckingModeWire::Subtle,
            cinema_tight_gate: true,
            spatial_pan: false,
            echo_guard_enabled: true,
            aec_enabled: true,
            engine_mode: VoiceEngineModeWire::Aura,
            use_windows_comm_aec: true,
            allow_relay_for_others: true,
            allow_relayed_voice: true,
            master_volume: 1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDeviceDto {
    pub id: String,
    pub label: String,
    pub is_default_comm: bool,
    pub is_default_console: bool,
    pub is_bluetooth: bool,
    pub sample_rate: u32,
    pub channels: u16,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDeviceListDto {
    pub inputs: Vec<VoiceDeviceDto>,
    pub outputs: Vec<VoiceDeviceDto>,
    pub default_comm_input: Option<String>,
    pub default_comm_output: Option<String>,
    pub active_input_is_bluetooth: bool,
    pub active_output_is_bluetooth: bool,
    pub bluetooth_split_notice: Option<String>,
    pub permission_denied: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceDiagnosticsDto {
    pub voice_enabled: bool,
    pub in_voice: bool,
    pub mic_monitor: bool,
    pub mic_test_loopback: bool,
    pub active_input_name: Option<String>,
    pub active_output_name: Option<String>,
    pub active_input_is_bluetooth: bool,
    pub active_output_is_bluetooth: bool,
    pub bluetooth_hfp_dropped: bool,
    pub windows_comm_aec_active: bool,
    pub aec_backend: String,
    pub capture_backend: String,
    pub speaker_leak_detected: bool,
    pub low_bandwidth_warning: bool,
    pub nat_mode: String,
    pub est_upload_kbps: u32,
    pub relay_capacity_streams: usize,
    pub active_relay_streams: usize,
    pub stream_status: String,
    pub bitrate_kbps: u32,
    pub tx_target_count: usize,
    pub avg_loss_pct: f32,
    pub avg_jitter_ms: usize,
    pub duck_factor: f64,
    pub permission_denied: bool,
    pub stream_error: Option<String>,
    pub peers: Vec<VoicePeerRosterDto>,
    pub tx_fifo_dropped_frames: u64,
    pub dsp_overrun_frames: u64,
    pub dsp_avg_frame_us: u64,
    pub dsp_max_frame_us: u64,
    pub gate_transitions: u64,
    pub rx_jitter_underruns: u64,
    pub rx_rate_limited_drops: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticCaptureResultDto {
    pub raw_path: String,
    pub processed_path: String,
    pub duration_sec: f32,
    pub sample_rate: u32,
}

#[derive(Debug, Clone, Default)]
struct PeerMixOverride {
    volume: f32, // 0.0..=2.0
    muted: bool,
}

#[derive(Debug, Clone)]
struct DuckState {
    user_volume: f64,
    duck_factor: f64,
    last_sent_effective: f64,
    duck_mode: DuckingModeWire,
    remote_speaking: bool,
    last_speech_at: Option<Instant>,
}

impl Default for DuckState {
    fn default() -> Self {
        Self {
            user_volume: 100.0,
            duck_factor: 1.0,
            last_sent_effective: 100.0,
            duck_mode: DuckingModeWire::Subtle,
            remote_speaking: false,
            last_speech_at: None,
        }
    }
}

/// Rust-side multiplier for mpv volume (`effective = user_volume * duck_factor`).
/// Sends commands directly to MpvController, keeping the UI volume slider invariant.
pub struct DuckController {
    mpv: Arc<MpvController>,
    state: Mutex<DuckState>,
}

impl DuckController {
    const HOLD_MIN_MS: u64 = 550;

    pub fn new(mpv: Arc<MpvController>) -> Self {
        Self {
            mpv,
            state: Mutex::new(DuckState::default()),
        }
    }

    pub fn set_user_volume(&self, volume: f64) -> f64 {
        let clamped = volume.clamp(0.0, 130.0);
        let effective = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            g.user_volume = clamped;
            let eff = (g.user_volume * g.duck_factor).clamp(0.0, 130.0);
            g.last_sent_effective = eff;
            eff
        };
        effective
    }

    pub fn set_mode(&self, mode: DuckingModeWire) {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        g.duck_mode = mode;
        if mode == DuckingModeWire::Off {
            g.remote_speaking = false;
            g.last_speech_at = None;
        }
    }

    pub fn set_remote_speaking(&self, speaking: bool) {
        let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if speaking {
            g.remote_speaking = true;
            g.last_speech_at = Some(Instant::now());
        } else {
            // Minimum hold hysteresis prevents movie volume pumping on flickering VAD gates
            let hold_elapsed = g
                .last_speech_at
                .is_none_or(|t| t.elapsed() >= Duration::from_millis(Self::HOLD_MIN_MS));
            if hold_elapsed {
                g.remote_speaking = false;
            }
        }
    }

    pub fn is_remote_speaking(&self) -> bool {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remote_speaking
    }

    pub fn current_factor(&self) -> f64 {
        self.state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .duck_factor
    }

    pub fn reassert_effective_volume(&self) {
        let eff = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let eff = (g.user_volume * g.duck_factor).clamp(0.0, 130.0);
            g.last_sent_effective = eff;
            eff
        };
        let req = self.mpv.next_request_id();
        let _ = self.mpv.send_command(set_volume_cmd(req, eff));
    }

    /// Advances smooth attack (~80 ms) / release (~700 ms) every 20 ms tick.
    pub fn tick_20ms(&self) {
        let cmd_vol = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if g.remote_speaking
                && g.last_speech_at
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(Self::HOLD_MIN_MS + 100))
                && g.duck_mode == DuckingModeWire::Off
            {
                g.remote_speaking = false;
            }
            let target = if g.remote_speaking {
                g.duck_mode.target_factor()
            } else {
                1.0
            };
            let prev_eff = g.last_sent_effective;
            if (g.duck_factor - target).abs() < 0.002 {
                g.duck_factor = target;
            } else if target < g.duck_factor {
                // ~80 ms attack (4 ticks of 20 ms)
                g.duck_factor += (target - g.duck_factor) * 0.45;
            } else {
                // ~700 ms release (~35 ticks of 20 ms)
                g.duck_factor += (target - g.duck_factor) * 0.085;
            }
            let eff = (g.user_volume * g.duck_factor).clamp(0.0, 130.0);
            if (eff - prev_eff).abs() >= 0.4 || (g.duck_factor == 1.0 && prev_eff != g.user_volume)
            {
                g.last_sent_effective = eff;
                Some(eff)
            } else {
                None
            }
        };
        if let Some(eff) = cmd_vol {
            let req = self.mpv.next_request_id();
            let _ = self.mpv.send_command(set_volume_cmd(req, eff));
        }
    }

    pub fn restore_full(&self) {
        let eff = {
            let mut g = self.state.lock().unwrap_or_else(|e| e.into_inner());
            g.remote_speaking = false;
            g.last_speech_at = None;
            g.duck_factor = 1.0;
            g.last_sent_effective = g.user_volume;
            g.user_volume
        };
        let req = self.mpv.next_request_id();
        let _ = self.mpv.send_command(set_volume_cmd(req, eff));
    }
}

fn is_bluetooth_name(name: &str, iface: Option<&str>, desc: Option<&str>) -> bool {
    let check = |s: &str| {
        let lower = s.to_ascii_lowercase();
        lower.contains("bluetooth")
            || lower.contains("hands-free")
            || lower.contains("hfp")
            || lower.contains("headset")
            || lower.contains("bt speaker")
            || lower.contains("airpods")
            || lower.contains("bthhfenum")
            || lower.contains("bthenum")
    };
    check(name) || iface.is_some_and(check) || desc.is_some_and(check)
}

type WasapiDeviceMetaMap = HashMap<String, (Option<String>, Option<String>)>;

fn query_wasapi_metadata(dir: Direction) -> (Option<String>, Option<String>, WasapiDeviceMetaMap) {
    let _ = initialize_mta();
    let Ok(en) = DeviceEnumerator::new() else {
        return (None, None, HashMap::new());
    };
    let comm = en
        .get_default_device_for_role(dir, Role::Communications)
        .ok()
        .and_then(|d| d.get_friendlyname().ok());
    let cons = en
        .get_default_device_for_role(dir, Role::Console)
        .ok()
        .and_then(|d| d.get_friendlyname().ok());
    let mut meta = HashMap::new();
    if let Ok(col) = en.get_device_collection(dir) {
        let n = col.get_nbr_devices().unwrap_or(0);
        for i in 0..n {
            if let Ok(dev) = col.get_device_at_index(i) {
                if let Ok(fname) = dev.get_friendlyname() {
                    let iface = dev.get_interface_friendlyname().ok();
                    let desc = dev.get_description().ok();
                    meta.insert(fname, (iface, desc));
                }
            }
        }
    }
    (comm, cons, meta)
}

pub fn list_voice_devices(selected_input: &str, selected_output: &str) -> VoiceDeviceListDto {
    let host = cpal::default_host();
    let (comm_in, cons_in, meta_in) = query_wasapi_metadata(Direction::Capture);
    let (comm_out, cons_out, meta_out) = query_wasapi_metadata(Direction::Render);

    let mut inputs = Vec::new();
    let mut perm_denied = false;
    match host.input_devices() {
        Ok(devs) => {
            for dev in devs {
                let Ok(name) = dev.name() else { continue };
                let cfg = dev.default_input_config().ok();
                let (iface, desc) = meta_in.get(&name).cloned().unwrap_or((None, None));
                let is_bt = is_bluetooth_name(&name, iface.as_deref(), desc.as_deref());
                inputs.push(VoiceDeviceDto {
                    is_default_comm: comm_in.as_deref() == Some(name.as_str()),
                    is_default_console: cons_in.as_deref() == Some(name.as_str()),
                    is_bluetooth: is_bt,
                    sample_rate: cfg.as_ref().map_or(48_000, |c| c.sample_rate().0),
                    channels: cfg.as_ref().map_or(1, |c| c.channels()),
                    id: name.clone(),
                    label: name,
                });
            }
        }
        Err(_) => {
            perm_denied = true;
        }
    }

    let mut outputs = Vec::new();
    if let Ok(devs) = host.output_devices() {
        for dev in devs {
            let Ok(name) = dev.name() else { continue };
            let cfg = dev.default_output_config().ok();
            let (iface, desc) = meta_out.get(&name).cloned().unwrap_or((None, None));
            let is_bt = is_bluetooth_name(&name, iface.as_deref(), desc.as_deref());
            outputs.push(VoiceDeviceDto {
                is_default_comm: comm_out.as_deref() == Some(name.as_str()),
                is_default_console: cons_out.as_deref() == Some(name.as_str()),
                is_bluetooth: is_bt,
                sample_rate: cfg.as_ref().map_or(48_000, |c| c.sample_rate().0),
                channels: cfg.as_ref().map_or(2, |c| c.channels()),
                id: name.clone(),
                label: name,
            });
        }
    }

    let active_in = resolve_input_device_choice(selected_input, &inputs);
    let active_out = resolve_output_device_choice(selected_output, &outputs);
    let active_input_is_bluetooth = active_in.is_some_and(|d| d.is_bluetooth);
    let active_output_is_bluetooth = active_out.is_some_and(|d| d.is_bluetooth);
    let bluetooth_split_notice = if active_output_is_bluetooth && !active_input_is_bluetooth {
        active_in.map(|mic| {
            let out_name = active_out.map_or("Bluetooth headphones", |o| o.label.as_str());
            format!(
                "Using '{}' for mic capture so '{}' stays in HD stereo output.",
                mic.label, out_name
            )
        })
    } else {
        None
    };

    VoiceDeviceListDto {
        inputs,
        outputs,
        default_comm_input: comm_in,
        default_comm_output: comm_out,
        active_input_is_bluetooth,
        active_output_is_bluetooth,
        bluetooth_split_notice,
        permission_denied: perm_denied,
    }
}

fn is_likely_headphone_name(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.contains("headphone")
        || l.contains("headset")
        || l.contains("earphone")
        || l.contains("airpods")
        || l.contains("buds")
        || l.contains("hd ")
        || l.contains("arctis")
        || l.contains("cloud ")
}

fn is_hfp_profile_name(name: &str) -> bool {
    let l = name.to_ascii_lowercase();
    l.contains("hands-free") || l.contains("hfp") || l.contains("ag audio")
}

/// Watchdog state machine detecting dead audio streams (1.5 s callback stall) with bounded backoff.
#[derive(Debug, Clone)]
pub struct StreamWatchdogState {
    last_cb_ms: Option<u64>,
    stream_opened_ms: Option<u64>,
    fail_streak: u32,
    next_retry_at_ms: u64,
}

impl Default for StreamWatchdogState {
    fn default() -> Self {
        Self::new()
    }
}

impl StreamWatchdogState {
    const STALL_MS: u64 = 1500;
    const BACKOFF_MS: [u64; 5] = [0, 500, 1000, 2000, 5000];

    pub fn new() -> Self {
        Self {
            last_cb_ms: None,
            stream_opened_ms: None,
            fail_streak: 0,
            next_retry_at_ms: 0,
        }
    }

    pub fn on_stream_opened(&mut self, now_ms: u64) {
        self.stream_opened_ms = Some(now_ms);
        self.last_cb_ms = Some(now_ms);
        self.fail_streak = 0;
        self.next_retry_at_ms = 0;
    }

    pub fn record_callback(&mut self, now_ms: u64) {
        self.last_cb_ms = Some(now_ms);
        self.fail_streak = 0;
    }

    pub fn on_open_failure(&mut self, now_ms: u64) -> u64 {
        let idx = (self.fail_streak as usize).min(Self::BACKOFF_MS.len() - 1);
        let delay = Self::BACKOFF_MS[idx];
        self.fail_streak = self.fail_streak.saturating_add(1);
        self.next_retry_at_ms = now_ms.saturating_add(delay);
        delay
    }

    pub fn can_attempt_open(&self, now_ms: u64) -> bool {
        now_ms >= self.next_retry_at_ms
    }

    pub fn is_stalled(&self, now_ms: u64) -> bool {
        self.stream_opened_ms.is_some()
            && self
                .last_cb_ms
                .is_some_and(|t| now_ms.saturating_sub(t) >= Self::STALL_MS)
    }

    pub fn on_stream_closed(&mut self) {
        self.last_cb_ms = None;
        self.stream_opened_ms = None;
    }
}

pub fn classify_audio_open_error(raw: &str) -> (&'static str, bool, String) {
    let lower = raw.to_ascii_lowercase();
    if lower.contains("0x8889000a") || lower.contains("in use") || lower.contains("exclusive") {
        (
            "micBusy",
            false,
            "Mic in use by another app (exclusive mode or busy device).".to_string(),
        )
    } else if lower.contains("0x80070005")
        || lower.contains("access is denied")
        || lower.contains("privacy")
    {
        (
            "permissionDenied",
            true,
            "Microphone access denied by Windows Privacy Settings.".to_string(),
        )
    } else {
        ("reconnecting", false, raw.to_string())
    }
}

pub fn validate_voice_hotkey_binding(vk: i32, modifiers: u8) -> Result<(), String> {
    if vk == 0 {
        return Ok(()); // Unbound
    }
    if modifiers == 0 {
        // Reject plain Space, plain 0-9, plain A-Z so typing never toggles mute accidentally
        if vk == 0x20 || (0x30..=0x39).contains(&vk) || (0x41..=0x5A).contains(&vk) {
            return Err(
                "Plain letters, numbers, and Space need a modifier (Ctrl/Alt/Shift). Use an F-key, Mouse 4/5, or modifier combo."
                    .to_string(),
            );
        }
    }
    Ok(())
}

fn query_windows_on_battery() -> bool {
    let mut status = SYSTEM_POWER_STATUS {
        ACLineStatus: 1,
        BatteryFlag: 0,
        BatteryLifePercent: 255,
        SystemStatusFlag: 0,
        BatteryLifeTime: u32::MAX,
        BatteryFullLifeTime: u32::MAX,
    };
    let ok = unsafe { GetSystemPowerStatus(&mut status) };
    ok != 0 && status.ACLineStatus == 0
}

fn is_epilod_foreground_window() -> bool {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.is_null() {
        return false;
    }
    let mut pid: u32 = 0;
    unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
    pid != 0 && pid == std::process::id()
}

fn probe_windows_comm_aec() -> bool {
    let _ = initialize_mta();
    let Ok(en) = DeviceEnumerator::new() else {
        return false;
    };
    let Ok(dev) = en.get_default_device_for_role(Direction::Capture, Role::Communications) else {
        return false;
    };
    let Ok(client) = dev.get_iaudioclient() else {
        return false;
    };
    let props = AudioClientProperties::new().set_category(StreamCategory::Communications);
    let _ = client.set_properties(props);
    client.is_aec_supported().unwrap_or(false)
}

fn resolve_input_device_choice<'a>(
    selected: &str,
    inputs: &'a [VoiceDeviceDto],
) -> Option<&'a VoiceDeviceDto> {
    if selected != "default" && !selected.trim().is_empty() {
        if let Some(exact) = inputs.iter().find(|d| d.id == selected) {
            return Some(exact);
        }
    }
    let comm = inputs.iter().find(|d| d.is_default_comm);
    let cons = inputs.iter().find(|d| d.is_default_console);
    let preferred = comm.or(cons).or_else(|| inputs.first())?;
    // Never auto-select a Bluetooth HFP mic if a wired/built-in mic exists
    if preferred.is_bluetooth {
        if let Some(non_bt) = cons
            .filter(|d| !d.is_bluetooth)
            .or_else(|| inputs.iter().find(|d| !d.is_bluetooth))
        {
            return Some(non_bt);
        }
    }
    Some(preferred)
}

fn resolve_output_device_choice<'a>(
    selected: &str,
    outputs: &'a [VoiceDeviceDto],
) -> Option<&'a VoiceDeviceDto> {
    if selected != "default" && !selected.trim().is_empty() {
        if let Some(exact) = outputs.iter().find(|d| d.id == selected) {
            return Some(exact);
        }
    }
    outputs
        .iter()
        .find(|d| d.is_default_comm)
        .or_else(|| outputs.iter().find(|d| d.is_default_console))
        .or_else(|| outputs.first())
}

struct SharedVoiceRuntime {
    config: RwLock<VoiceConfigDto>,
    peer_overrides: RwLock<HashMap<String, PeerMixOverride>>,
    transport: RwLock<Option<Arc<VoiceTransportHandle>>>,
    app_handle: RwLock<Option<AppHandle>>,
    in_voice: AtomicBool,
    mic_monitor: AtomicBool,
    mic_test_loopback: AtomicBool,
    calibrate_requested: AtomicBool,
    muted: AtomicBool,
    deafened: AtomicBool,
    pre_deafen_muted: AtomicBool,
    ptt_held: AtomicBool,
    movie_playing: AtomicBool,
    input_device_dirty: AtomicBool,
    output_device_dirty: AtomicBool,
    loopback_device_dirty: AtomicBool,
    hotplug_watcher_started: AtomicBool,
    hotplug_stop: AtomicBool,
    stop_flag: AtomicBool,
    epoch: AtomicU8,
    bitrate_kbps: AtomicU32,
    avg_loss_x10: AtomicU32,
    avg_jitter_ms: AtomicU32,
    permission_denied: AtomicBool,
    active_input_is_bt: AtomicBool,
    active_output_is_bt: AtomicBool,
    bluetooth_hfp_dropped: AtomicBool,
    windows_comm_aec: AtomicBool,
    speaker_leak_detected: AtomicBool,
    low_bandwidth_warning: AtomicBool,
    stream_status: RwLock<String>,
    aec_backend: RwLock<String>,
    capture_backend: RwLock<String>,
    active_input_name: RwLock<Option<String>>,
    active_output_name: RwLock<Option<String>>,
    stream_error: RwLock<Option<String>>,
    last_in_cb_ms: AtomicU64,
    last_out_cb_ms: AtomicU64,
    runtime_epoch: Instant,
    far_end_rms_bits: AtomicU32,
    far_end_ref_fifo: Mutex<VecDeque<[f32; VOICE_FRAME_10MS]>>,
    own_tx_env: Mutex<VecDeque<f32>>,
    voice_logs: Mutex<VecDeque<String>>,
    test_loopback_tx: Mutex<Option<std::sync::mpsc::SyncSender<Vec<f32>>>>,
    duck: Arc<DuckController>,
    tx_fifo_dropped_frames: AtomicU64,
    dsp_frame_count: AtomicU64,
    dsp_total_frame_us: AtomicU64,
    dsp_max_frame_us: AtomicU64,
    dsp_overrun_frames: AtomicU64,
    gate_transitions: AtomicU64,
    rx_jitter_underruns: AtomicU64,
    diag_capture_active: AtomicBool,
    diag_capture_tx: Mutex<
        Option<std::sync::mpsc::SyncSender<([f32; VOICE_FRAME_10MS], [f32; VOICE_FRAME_10MS])>>,
    >,
    diag_capture_worker: Mutex<
        Option<(
            std::thread::JoinHandle<Result<DiagnosticCaptureResultDto, String>>,
            Arc<AtomicBool>,
        )>,
    >,
}

impl SharedVoiceRuntime {
    fn now_ms(&self) -> u64 {
        self.runtime_epoch.elapsed().as_millis() as u64
    }

    fn reset_diag_counters(&self) {
        self.tx_fifo_dropped_frames.store(0, Ordering::Relaxed);
        self.dsp_frame_count.store(0, Ordering::Relaxed);
        self.dsp_total_frame_us.store(0, Ordering::Relaxed);
        self.dsp_max_frame_us.store(0, Ordering::Relaxed);
        self.dsp_overrun_frames.store(0, Ordering::Relaxed);
        self.gate_transitions.store(0, Ordering::Relaxed);
        self.rx_jitter_underruns.store(0, Ordering::Relaxed);
    }

    fn mark_config_device_changes(&self, input_changed: bool, output_changed: bool) {
        if input_changed {
            self.input_device_dirty.store(true, Ordering::Release);
        }
        if output_changed {
            self.output_device_dirty.store(true, Ordering::Release);
            self.loopback_device_dirty.store(true, Ordering::Release);
        }
    }

    fn record_log(&self, line: &str) {
        let clean = sanitize_log_text(line);
        let ts = epilod_core::logging::format_utc_timestamp(SystemTime::now());
        let mut logs = self.voice_logs.lock().unwrap_or_else(|e| e.into_inner());
        while logs.len() >= 200 {
            logs.pop_front();
        }
        logs.push_back(format!("[{ts}] {clean}"));
    }

    fn set_stream_status(&self, status: &str, error: Option<String>) {
        let mut st_changed = false;
        {
            let mut st = self
                .stream_status
                .write()
                .unwrap_or_else(|e| e.into_inner());
            if *st != status {
                *st = status.to_string();
                st_changed = true;
            }
        }
        let mut err_changed = false;
        {
            let mut er = self.stream_error.write().unwrap_or_else(|e| e.into_inner());
            if *er != error {
                *er = error.clone();
                err_changed = true;
            }
        }
        if st_changed || err_changed {
            if let Some(ref e) = error {
                self.record_log(&format!("voice.{status}: {e}"));
            } else {
                self.record_log(&format!("voice.status -> {status}"));
            }
            self.emit_status_snapshot();
        }
    }

    fn emit_local_state(&self, source: &str) {
        if let Some(ref app) = *self.app_handle.read().unwrap_or_else(|e| e.into_inner()) {
            let _ = app.emit(
                "voice://local-state",
                serde_json::json!({
                    "muted": self.muted.load(Ordering::Acquire),
                    "deafened": self.deafened.load(Ordering::Acquire),
                    "pttActive": self.ptt_held.load(Ordering::Acquire),
                    "source": source,
                }),
            );
        }
    }

    fn apply_mute_transition(&self, next_muted: bool) {
        self.muted.store(next_muted, Ordering::Release);
        if !next_muted && self.deafened.load(Ordering::Acquire) {
            self.deafened.store(false, Ordering::Release);
            self.pre_deafen_muted.store(false, Ordering::Release);
        }
    }

    fn apply_deafen_transition(&self, next_deafened: bool) {
        let was_deafened = self.deafened.load(Ordering::Acquire);
        if next_deafened == was_deafened {
            return;
        }
        self.deafened.store(next_deafened, Ordering::Release);
        if next_deafened {
            let prior_muted = self.muted.load(Ordering::Acquire);
            self.pre_deafen_muted.store(prior_muted, Ordering::Release);
            self.muted.store(true, Ordering::Release);
        } else {
            let restore_muted = self.pre_deafen_muted.load(Ordering::Acquire);
            self.muted.store(restore_muted, Ordering::Release);
        }
    }

    fn emit_status_snapshot(&self) {
        if let Some(ref app) = *self.app_handle.read().unwrap_or_else(|e| e.into_inner()) {
            let _ = app.emit(
                "voice://status",
                serde_json::json!({
                    "streamStatus": *self.stream_status.read().unwrap_or_else(|e| e.into_inner()),
                    "streamError": *self.stream_error.read().unwrap_or_else(|e| e.into_inner()),
                    "speakerLeakDetected": self.speaker_leak_detected.load(Ordering::Relaxed),
                    "bluetoothHfpDropped": self.bluetooth_hfp_dropped.load(Ordering::Relaxed),
                    "lowBandwidthWarning": self.low_bandwidth_warning.load(Ordering::Relaxed),
                    "windowsCommAecActive": self.windows_comm_aec.load(Ordering::Relaxed),
                    "aecBackend": *self.aec_backend.read().unwrap_or_else(|e| e.into_inner()),
                }),
            );
        }
    }
}

pub struct VoiceController {
    shared: Arc<SharedVoiceRuntime>,
    worker_lock: Mutex<Option<WorkerHandles>>,
}

struct WorkerHandles {
    dsp_thread: Option<std::thread::JoinHandle<()>>,
    mix_thread: Option<std::thread::JoinHandle<()>>,
    ptt_thread: Option<std::thread::JoinHandle<()>>,
}

impl VoiceController {
    pub fn new(mpv: Arc<MpvController>) -> Self {
        let duck = Arc::new(DuckController::new(Arc::clone(&mpv)));
        let duck_cb = Arc::clone(&duck);
        mpv.set_volume_reassert_callback(Arc::new(move || {
            duck_cb.reassert_effective_volume();
        }));
        let shared = Arc::new(SharedVoiceRuntime {
            config: RwLock::new(VoiceConfigDto::default()),
            peer_overrides: RwLock::new(HashMap::new()),
            transport: RwLock::new(None),
            app_handle: RwLock::new(None),
            in_voice: AtomicBool::new(false),
            mic_monitor: AtomicBool::new(false),
            mic_test_loopback: AtomicBool::new(false),
            calibrate_requested: AtomicBool::new(false),
            muted: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
            pre_deafen_muted: AtomicBool::new(false),
            ptt_held: AtomicBool::new(false),
            movie_playing: AtomicBool::new(false),
            input_device_dirty: AtomicBool::new(false),
            output_device_dirty: AtomicBool::new(false),
            loopback_device_dirty: AtomicBool::new(false),
            hotplug_watcher_started: AtomicBool::new(false),
            hotplug_stop: AtomicBool::new(false),
            stop_flag: AtomicBool::new(false),
            epoch: AtomicU8::new(1),
            bitrate_kbps: AtomicU32::new(48),
            avg_loss_x10: AtomicU32::new(0),
            avg_jitter_ms: AtomicU32::new(40),
            permission_denied: AtomicBool::new(false),
            active_input_is_bt: AtomicBool::new(false),
            active_output_is_bt: AtomicBool::new(false),
            bluetooth_hfp_dropped: AtomicBool::new(false),
            windows_comm_aec: AtomicBool::new(false),
            speaker_leak_detected: AtomicBool::new(false),
            low_bandwidth_warning: AtomicBool::new(false),
            stream_status: RwLock::new("idle".to_string()),
            aec_backend: RwLock::new("none".to_string()),
            capture_backend: RwLock::new("none".to_string()),
            active_input_name: RwLock::new(None),
            active_output_name: RwLock::new(None),
            stream_error: RwLock::new(None),
            last_in_cb_ms: AtomicU64::new(0),
            last_out_cb_ms: AtomicU64::new(0),
            runtime_epoch: Instant::now(),
            far_end_rms_bits: AtomicU32::new(0.0f32.to_bits()),
            far_end_ref_fifo: Mutex::new(VecDeque::with_capacity(16)),
            own_tx_env: Mutex::new(VecDeque::with_capacity(256)),
            voice_logs: Mutex::new(VecDeque::with_capacity(200)),
            test_loopback_tx: Mutex::new(None),
            duck,
            tx_fifo_dropped_frames: AtomicU64::new(0),
            dsp_frame_count: AtomicU64::new(0),
            dsp_total_frame_us: AtomicU64::new(0),
            dsp_max_frame_us: AtomicU64::new(0),
            dsp_overrun_frames: AtomicU64::new(0),
            gate_transitions: AtomicU64::new(0),
            rx_jitter_underruns: AtomicU64::new(0),
            diag_capture_active: AtomicBool::new(false),
            diag_capture_tx: Mutex::new(None),
            diag_capture_worker: Mutex::new(None),
        });
        Self {
            shared,
            worker_lock: Mutex::new(None),
        }
    }

    pub fn duck(&self) -> &Arc<DuckController> {
        &self.shared.duck
    }

    pub fn attach_p2p(&self, transport: Arc<VoiceTransportHandle>) {
        let cfg = self
            .shared
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let in_v = self.shared.in_voice.load(Ordering::Acquire) && cfg.voice_enabled;
        let epoch = if in_v {
            self.shared
                .epoch
                .fetch_add(1, Ordering::AcqRel)
                .wrapping_add(1)
                .max(1)
        } else {
            self.shared.epoch.load(Ordering::Acquire)
        };
        transport.update_battery_state(query_windows_on_battery());
        transport.notify_local_state(
            in_v,
            epoch,
            self.shared.muted.load(Ordering::Acquire),
            self.shared.deafened.load(Ordering::Acquire),
            cfg.allow_relay_for_others,
            cfg.allow_relayed_voice,
        );
        self.shared
            .record_log("voice.p2p attached to room transport");
        *self
            .shared
            .transport
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(transport);
    }

    pub fn detach_p2p(&self) {
        if let Some(tr) = self
            .shared
            .transport
            .write()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            tr.notify_local_state(false, 1, false, false, false, false);
            self.shared
                .record_log("voice.p2p detached from room transport");
        }
    }

    pub fn set_movie_playing(&self, playing: bool) {
        self.shared.movie_playing.store(playing, Ordering::Release);
    }

    fn bind_app_handle(&self, app: AppHandle) {
        *self
            .shared
            .app_handle
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(app);
        self.ensure_hotplug_watcher();
    }

    fn ensure_hotplug_watcher(&self) {
        if self
            .shared
            .hotplug_watcher_started
            .swap(true, Ordering::AcqRel)
        {
            return;
        }
        let shared = Arc::clone(&self.shared);
        let _ = std::thread::Builder::new()
            .name("epilod-voice-hotplug".to_string())
            .spawn(move || {
                let dirty = Arc::new(AtomicBool::new(false));
                let Some(_reg) = register_wasapi_flag_notifier(Arc::clone(&dirty)) else {
                    shared
                        .hotplug_watcher_started
                        .store(false, Ordering::Release);
                    return;
                };
                while !shared.hotplug_stop.load(Ordering::Acquire) {
                    std::thread::sleep(Duration::from_millis(350));
                    if shared.hotplug_stop.load(Ordering::Acquire) {
                        break;
                    }
                    if dirty.swap(false, Ordering::AcqRel) {
                        shared.mark_config_device_changes(true, true);
                        if let Some(ref app) =
                            *shared.app_handle.read().unwrap_or_else(|e| e.into_inner())
                        {
                            let _ = app.emit("voice://devices-changed", serde_json::json!({}));
                        }
                    }
                }
                shared
                    .hotplug_watcher_started
                    .store(false, Ordering::Release);
            });
    }

    pub fn set_config(&self, app: AppHandle, cfg: VoiceConfigDto) {
        self.bind_app_handle(app);
        let (in_changed, out_changed, was_disabled) = {
            let mut prev = self
                .shared
                .config
                .write()
                .unwrap_or_else(|e| e.into_inner());
            let in_c = prev.input_device != cfg.input_device
                || prev.engine_mode != cfg.engine_mode
                || prev.use_windows_comm_aec != cfg.use_windows_comm_aec;
            let out_c = prev.output_device != cfg.output_device;
            let dis = !cfg.voice_enabled && self.shared.in_voice.load(Ordering::Acquire);
            *prev = cfg.clone();
            (in_c, out_c, dis)
        };
        self.shared.duck.set_mode(cfg.ducking_mode);
        if was_disabled {
            self.leave_voice();
        }
        if in_changed || out_changed {
            self.shared
                .mark_config_device_changes(in_changed, out_changed);
            if in_changed {
                self.shared
                    .bluetooth_hfp_dropped
                    .store(false, Ordering::Release);
            }
        }
        self.sync_transport_flags();
    }

    pub fn join_voice(&self, app: AppHandle, start_muted: Option<bool>) -> Result<(), String> {
        self.bind_app_handle(app);
        if !self
            .shared
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .voice_enabled
        {
            return Err("Voice chat is turned off in Voice & Audio settings.".to_string());
        }
        if let Some(muted) = start_muted {
            self.shared.muted.store(muted, Ordering::Release);
            self.shared.deafened.store(false, Ordering::Release);
            self.shared.pre_deafen_muted.store(muted, Ordering::Release);
        }
        self.shared
            .mic_test_loopback
            .store(false, Ordering::Release);
        self.shared
            .bluetooth_hfp_dropped
            .store(false, Ordering::Release);
        self.shared
            .speaker_leak_detected
            .store(false, Ordering::Release);
        let was_idle = !self.shared.in_voice.load(Ordering::Acquire)
            && !self.shared.mic_monitor.load(Ordering::Acquire);
        if was_idle {
            self.shared.reset_diag_counters();
        }
        let epoch = self
            .shared
            .epoch
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1)
            .max(1);
        self.shared.in_voice.store(true, Ordering::Release);
        self.shared.record_log(&format!("voice.join epoch={epoch}"));
        self.transition_stream_status_for_join();
        self.ensure_workers_running();
        self.sync_transport_flags_with_epoch(epoch);
        Ok(())
    }

    fn transition_stream_status_for_join(&self) {
        let already_live = self
            .worker_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .is_some()
            && *self
                .shared
                .stream_status
                .read()
                .unwrap_or_else(|e| e.into_inner())
                == "live";
        if already_live {
            self.shared.emit_status_snapshot();
        } else {
            self.shared.set_stream_status("reconnecting", None);
        }
    }

    pub fn leave_voice(&self) {
        self.shared.in_voice.store(false, Ordering::Release);
        self.shared.muted.store(false, Ordering::Release);
        self.shared.deafened.store(false, Ordering::Release);
        self.shared.pre_deafen_muted.store(false, Ordering::Release);
        self.shared.ptt_held.store(false, Ordering::Release);
        self.shared.duck.restore_full();
        self.shared.record_log("voice.leave");
        self.sync_transport_flags();
        if !self.shared.mic_monitor.load(Ordering::Acquire)
            && !self.shared.mic_test_loopback.load(Ordering::Acquire)
            && !self.shared.calibrate_requested.load(Ordering::Acquire)
        {
            self.stop_workers();
            self.shared.set_stream_status("idle", None);
        }
    }

    pub fn start_mic_monitor(&self, app: AppHandle, loopback: bool) {
        self.bind_app_handle(app);
        let was_idle = !self.shared.in_voice.load(Ordering::Acquire)
            && !self.shared.mic_monitor.load(Ordering::Acquire);
        if was_idle {
            self.shared.reset_diag_counters();
        }
        self.shared.mic_monitor.store(true, Ordering::Release);
        self.shared
            .mic_test_loopback
            .store(loopback, Ordering::Release);
        self.ensure_workers_running();
    }

    pub fn stop_mic_monitor(&self) {
        self.shared.mic_monitor.store(false, Ordering::Release);
        self.shared
            .mic_test_loopback
            .store(false, Ordering::Release);
        self.shared
            .calibrate_requested
            .store(false, Ordering::Release);
        if !self.shared.in_voice.load(Ordering::Acquire) {
            self.stop_workers();
            self.shared.set_stream_status("idle", None);
        }
    }

    pub fn start_calibration(&self, app: AppHandle) {
        self.bind_app_handle(app);
        self.shared.mic_monitor.store(true, Ordering::Release);
        self.shared
            .mic_test_loopback
            .store(false, Ordering::Release);
        self.shared
            .calibrate_requested
            .store(true, Ordering::Release);
        self.shared.record_log("voice.calibration started (3s)");
        self.ensure_workers_running();
    }

    pub fn set_mute(&self, muted: bool) {
        self.shared.apply_mute_transition(muted);
        self.sync_transport_flags();
    }

    pub fn set_deafen(&self, deafened: bool) {
        self.shared.apply_deafen_transition(deafened);
        self.sync_transport_flags();
    }

    pub fn set_peer_volume(&self, username: &str, volume: f32, muted: bool) {
        let key = username.trim().to_ascii_lowercase();
        if key.is_empty() {
            return;
        }
        let mut g = self
            .shared
            .peer_overrides
            .write()
            .unwrap_or_else(|e| e.into_inner());
        g.insert(
            key,
            PeerMixOverride {
                volume: volume.clamp(0.0, 2.0),
                muted,
            },
        );
    }

    pub fn diagnostics(&self) -> VoiceDiagnosticsDto {
        let cfg = self
            .shared
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let tr_opt = self
            .shared
            .transport
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let (tx_target_count, nat_mode, est_upload_kbps, relay_cap, active_relays, peers) =
            if let Some(ref tr) = tr_opt {
                let (up, rcap, ract) = tr.relay_stats();
                (
                    tr.tx_target_count(),
                    tr.nat_mode(),
                    up,
                    rcap,
                    ract,
                    tr.roster_snapshot(),
                )
            } else {
                (0, "disconnected".to_string(), 0, 0, 0, Vec::new())
            };
        let dsp_frames = self.shared.dsp_frame_count.load(Ordering::Relaxed);
        let dsp_total_us = self.shared.dsp_total_frame_us.load(Ordering::Relaxed);
        VoiceDiagnosticsDto {
            voice_enabled: cfg.voice_enabled,
            in_voice: self.shared.in_voice.load(Ordering::Relaxed),
            mic_monitor: self.shared.mic_monitor.load(Ordering::Relaxed),
            mic_test_loopback: self.shared.mic_test_loopback.load(Ordering::Relaxed),
            active_input_name: self
                .shared
                .active_input_name
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            active_output_name: self
                .shared
                .active_output_name
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            active_input_is_bluetooth: self.shared.active_input_is_bt.load(Ordering::Relaxed),
            active_output_is_bluetooth: self.shared.active_output_is_bt.load(Ordering::Relaxed),
            bluetooth_hfp_dropped: self.shared.bluetooth_hfp_dropped.load(Ordering::Relaxed),
            windows_comm_aec_active: self.shared.windows_comm_aec.load(Ordering::Relaxed),
            aec_backend: self
                .shared
                .aec_backend
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            capture_backend: self
                .shared
                .capture_backend
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            speaker_leak_detected: self.shared.speaker_leak_detected.load(Ordering::Relaxed),
            low_bandwidth_warning: self.shared.low_bandwidth_warning.load(Ordering::Relaxed),
            nat_mode,
            est_upload_kbps,
            relay_capacity_streams: relay_cap,
            active_relay_streams: active_relays,
            stream_status: self
                .shared
                .stream_status
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            bitrate_kbps: self.shared.bitrate_kbps.load(Ordering::Relaxed),
            tx_target_count,
            avg_loss_pct: (self.shared.avg_loss_x10.load(Ordering::Relaxed) as f32) / 10.0,
            avg_jitter_ms: self.shared.avg_jitter_ms.load(Ordering::Relaxed) as usize,
            duck_factor: self.shared.duck.current_factor(),
            permission_denied: self.shared.permission_denied.load(Ordering::Relaxed),
            stream_error: self
                .shared
                .stream_error
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone(),
            peers,
            tx_fifo_dropped_frames: self.shared.tx_fifo_dropped_frames.load(Ordering::Relaxed),
            dsp_overrun_frames: self.shared.dsp_overrun_frames.load(Ordering::Relaxed),
            dsp_avg_frame_us: dsp_total_us / dsp_frames.max(1),
            dsp_max_frame_us: self.shared.dsp_max_frame_us.load(Ordering::Relaxed),
            gate_transitions: self.shared.gate_transitions.load(Ordering::Relaxed),
            rx_jitter_underruns: self.shared.rx_jitter_underruns.load(Ordering::Relaxed),
            rx_rate_limited_drops: tr_opt
                .as_ref()
                .map_or(0, |tr| tr.rx_rate_limited_drops.load(Ordering::Relaxed)),
        }
    }

    pub fn build_voice_report(&self, app_version: &str, app_logs: &[LogEntry]) -> String {
        let diag = self.diagnostics();
        let mut combined_logs: Vec<String> = self
            .shared
            .voice_logs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .cloned()
            .collect();
        for entry in app_logs {
            if entry.target.contains("voice") || entry.target.contains("p2p") {
                combined_logs.push(format!(
                    "[{}] [{}] {}",
                    entry.timestamp, entry.target, entry.message
                ));
            }
        }
        if combined_logs.len() > 200 {
            combined_logs.drain(..combined_logs.len() - 200);
        }
        let report = serde_json::json!({
            "reportKind": "epilod-party-voice-health-v1",
            "generatedAtUtc": epilod_core::logging::format_utc_timestamp(SystemTime::now()),
            "appVersion": app_version,
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "diagnostics": diag,
            "voiceLogs": combined_logs,
        });
        serde_json::to_string_pretty(&report).unwrap_or_else(|_| "{}".to_string())
    }

    pub fn start_diagnostic_capture(&self, app: AppHandle, max_seconds: u32) -> Result<(), String> {
        self.bind_app_handle(app.clone());
        if !self.shared.in_voice.load(Ordering::Acquire)
            && !self.shared.mic_monitor.load(Ordering::Acquire)
        {
            return Err(
                "Join voice or open Voice settings mic monitor before recording a diagnostic sample."
                    .to_string(),
            );
        }

        let mut worker_guard = self
            .shared
            .diag_capture_worker
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some((handle, stop_req)) = worker_guard.take() {
            if handle.is_finished() {
                let _ = handle.join();
            } else {
                *worker_guard = Some((handle, stop_req));
                return Err("A diagnostic voice recording is already in progress.".to_string());
            }
        }

        let base_dir = app
            .path()
            .app_data_dir()
            .ok()
            .or_else(crate::storage::local_epilod_root_dir)
            .ok_or_else(|| "Unable to determine local app data directory".to_string())?;
        let ts_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let capture_dir = base_dir
            .join("voice-captures")
            .join(format!("capture-{ts_ms}"));
        std::fs::create_dir_all(&capture_dir)
            .map_err(|e| format!("Failed creating voice capture directory: {e}"))?;

        let raw_path = capture_dir.join("raw_mic.wav");
        let proc_path = capture_dir.join("processed_tx.wav");
        let max_frames = (max_seconds.clamp(5, 120) as usize) * 100;

        let (tx, rx) = std::sync::mpsc::sync_channel::<(
            [f32; VOICE_FRAME_10MS],
            [f32; VOICE_FRAME_10MS],
        )>(256);
        *self
            .shared
            .diag_capture_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(tx);

        let stop_req = Arc::new(AtomicBool::new(false));
        let stop_worker = Arc::clone(&stop_req);
        let shared_worker = Arc::clone(&self.shared);
        self.shared
            .diag_capture_active
            .store(true, Ordering::Release);
        self.shared.record_log(&format!(
            "voice.diag-capture started max={}s",
            max_seconds.clamp(5, 120)
        ));

        let raw_path_clone = raw_path.clone();
        let proc_path_clone = proc_path.clone();
        let handle = std::thread::Builder::new()
            .name("epilod-voice-diag-cap".to_string())
            .spawn(move || -> Result<DiagnosticCaptureResultDto, String> {
                let mut raw_samples = Vec::with_capacity(max_frames.min(12_000) * VOICE_FRAME_10MS);
                let mut proc_samples =
                    Vec::with_capacity(max_frames.min(12_000) * VOICE_FRAME_10MS);
                let mut frames = 0usize;

                while frames < max_frames && !stop_worker.load(Ordering::Acquire) {
                    match rx.recv_timeout(Duration::from_millis(40)) {
                        Ok((raw_f, proc_f)) => {
                            raw_samples.extend_from_slice(&raw_f);
                            proc_samples.extend_from_slice(&proc_f);
                            frames += 1;
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                }
                while frames < max_frames {
                    match rx.try_recv() {
                        Ok((raw_f, proc_f)) => {
                            raw_samples.extend_from_slice(&raw_f);
                            proc_samples.extend_from_slice(&proc_f);
                            frames += 1;
                        }
                        Err(_) => break,
                    }
                }

                shared_worker
                    .diag_capture_active
                    .store(false, Ordering::Release);
                *shared_worker
                    .diag_capture_tx
                    .lock()
                    .unwrap_or_else(|e| e.into_inner()) = None;

                epilod_core::wav_io::write_wav_mono_i16(
                    &raw_path_clone,
                    VOICE_SAMPLE_RATE as u32,
                    &raw_samples,
                )?;
                epilod_core::wav_io::write_wav_mono_i16(
                    &proc_path_clone,
                    VOICE_SAMPLE_RATE as u32,
                    &proc_samples,
                )?;

                let dto = DiagnosticCaptureResultDto {
                    raw_path: raw_path_clone.to_string_lossy().into_owned(),
                    processed_path: proc_path_clone.to_string_lossy().into_owned(),
                    duration_sec: (frames as f32) * 0.01,
                    sample_rate: VOICE_SAMPLE_RATE as u32,
                };
                shared_worker.record_log(&format!(
                    "voice.diag-capture saved {:.2}s to {}",
                    dto.duration_sec, dto.raw_path
                ));
                if let Some(ref app) = *shared_worker
                    .app_handle
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                {
                    let _ = app.emit("voice://diagnostic-capture-finished", &dto);
                }
                Ok(dto)
            })
            .map_err(|e| format!("Failed starting diagnostic capture thread: {e}"))?;

        *worker_guard = Some((handle, stop_req));
        Ok(())
    }

    pub fn stop_diagnostic_capture(&self) -> Result<DiagnosticCaptureResultDto, String> {
        self.shared
            .diag_capture_active
            .store(false, Ordering::Release);
        *self
            .shared
            .diag_capture_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        let worker = self
            .shared
            .diag_capture_worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        let Some((handle, stop_req)) = worker else {
            return Err("No diagnostic voice recording is currently active.".to_string());
        };
        stop_req.store(true, Ordering::Release);
        handle
            .join()
            .map_err(|_| "Diagnostic voice capture thread panicked".to_string())?
    }

    pub fn shutdown(&self) {
        self.shared.hotplug_stop.store(true, Ordering::Release);
        self.shared.in_voice.store(false, Ordering::Release);
        self.shared.mic_monitor.store(false, Ordering::Release);
        self.shared
            .mic_test_loopback
            .store(false, Ordering::Release);
        self.shared
            .calibrate_requested
            .store(false, Ordering::Release);
        self.shared
            .diag_capture_active
            .store(false, Ordering::Release);
        *self
            .shared
            .diag_capture_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        if let Some((handle, stop_req)) = self
            .shared
            .diag_capture_worker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            stop_req.store(true, Ordering::Release);
            let _ = handle.join();
        }
        self.detach_p2p();
        self.shared.duck.restore_full();
        self.stop_workers();
    }

    fn sync_transport_flags(&self) {
        let epoch = self.shared.epoch.load(Ordering::Acquire);
        self.sync_transport_flags_with_epoch(epoch);
    }

    fn sync_transport_flags_with_epoch(&self, epoch: u8) {
        let cfg = self
            .shared
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(ref tr) = *self
            .shared
            .transport
            .read()
            .unwrap_or_else(|e| e.into_inner())
        {
            tr.notify_local_state(
                self.shared.in_voice.load(Ordering::Acquire),
                epoch,
                self.shared.muted.load(Ordering::Acquire),
                self.shared.deafened.load(Ordering::Acquire),
                cfg.allow_relay_for_others,
                cfg.allow_relayed_voice,
            );
        }
    }

    fn ensure_workers_running(&self) {
        let mut guard = self.worker_lock.lock().unwrap_or_else(|e| e.into_inner());
        if guard.is_some() {
            return;
        }
        self.shared.stop_flag.store(false, Ordering::Release);

        let (lb_tx, lb_rx) = std::sync::mpsc::sync_channel::<Vec<f32>>(32);
        *self
            .shared
            .test_loopback_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = Some(lb_tx);

        let s_dsp = Arc::clone(&self.shared);
        let dsp_thread = std::thread::Builder::new()
            .name("epilod-voice-dsp".to_string())
            .spawn(move || run_dsp_tx_thread(s_dsp))
            .ok();

        let s_mix = Arc::clone(&self.shared);
        let mix_thread = std::thread::Builder::new()
            .name("epilod-voice-mix".to_string())
            .spawn(move || run_mix_rx_thread(s_mix, lb_rx))
            .ok();

        let s_ptt = Arc::clone(&self.shared);
        let ptt_thread = std::thread::Builder::new()
            .name("epilod-voice-ptt".to_string())
            .spawn(move || run_hotkey_poller(s_ptt))
            .ok();

        *guard = Some(WorkerHandles {
            dsp_thread,
            mix_thread,
            ptt_thread,
        });
    }

    fn stop_workers(&self) {
        self.shared.stop_flag.store(true, Ordering::Release);
        *self
            .shared
            .test_loopback_tx
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
        let handles = self
            .worker_lock
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
        if let Some(h) = handles {
            if let Some(t) = h.dsp_thread {
                let _ = t.join();
            }
            if let Some(t) = h.mix_thread {
                let _ = t.join();
            }
            if let Some(t) = h.ptt_thread {
                let _ = t.join();
            }
        }
    }
}

impl Drop for VoiceController {
    fn drop(&mut self) {
        self.shared.hotplug_stop.store(true, Ordering::Release);
    }
}

enum ActiveCaptureBackend {
    Cpal(#[allow(dead_code)] cpal::Stream),
    Wasapi {
        stop: Arc<AtomicBool>,
        join: Option<std::thread::JoinHandle<()>>,
    },
}

impl Drop for ActiveCaptureBackend {
    fn drop(&mut self) {
        if let Self::Wasapi { stop, join } = self {
            stop.store(true, Ordering::Release);
            if let Some(h) = join.take() {
                let _ = h.join();
            }
        }
    }
}

struct OpenedInputStream {
    stream: ActiveCaptureBackend,
    cons: ringbuf::HeapCons<f32>,
    sample_rate: u32,
    device_name: String,
    is_bt: bool,
    comm_aec_active: bool,
    capture_backend: &'static str,
}

struct VoiceResamplerState {
    resampler: FastFixedIn<f32>,
    in_buf: Vec<Vec<f32>>,
    out_buf: Vec<Vec<f32>>,
}

fn register_wasapi_flag_notifier(flag: Arc<AtomicBool>) -> Option<wasapi::DeviceEventRegistration> {
    let _ = initialize_mta();
    let en = DeviceEnumerator::new().ok()?;
    let mut cbs = DeviceEventCallbacks::default();
    let f1 = Arc::clone(&flag);
    cbs.set_default_device_callback(move |_dir, _role, _id| {
        f1.store(true, Ordering::Release);
    });
    let f2 = Arc::clone(&flag);
    cbs.set_device_removed_callback(move |_id| {
        f2.store(true, Ordering::Release);
    });
    let f3 = flag;
    cbs.set_device_state_callback(move |_id, _state| {
        f3.store(true, Ordering::Release);
    });
    en.register_notification_callback(cbs).ok()
}

fn push_pcm_to_mono_rb<T: Copy>(
    data: &[T],
    channels: usize,
    prod: &mut ringbuf::HeapProd<f32>,
    convert: fn(T) -> f32,
) {
    if channels <= 1 {
        for &s in data {
            let _ = prod.try_push(convert(s));
        }
    } else {
        let inv = 1.0 / (channels as f32);
        for frame in data.chunks_exact(channels) {
            let mut sum = 0.0f32;
            for &s in frame {
                sum += convert(s);
            }
            let _ = prod.try_push(sum * inv);
        }
    }
}

fn pop_stereo_from_rb<T: Copy>(
    data: &mut [T],
    channels: usize,
    cons: &mut ringbuf::HeapCons<f32>,
    last_l: &mut f32,
    last_r: &mut f32,
    convert: fn(f32) -> T,
) {
    for frame in data.chunks_mut(channels.max(1)) {
        match (cons.try_pop(), cons.try_pop()) {
            (Some(lv), Some(rv)) => {
                *last_l = lv;
                *last_r = rv;
            }
            _ => {
                // Fade smoothly to 0 on underrun so WASAPI never pops
                *last_l *= 0.9;
                *last_r *= 0.9;
            }
        }
        if channels <= 1 {
            frame[0] = convert((*last_l + *last_r) * 0.5);
        } else {
            frame[0] = convert(*last_l);
            frame[1] = convert(*last_r);
            for extra in &mut frame[2..] {
                *extra = convert(0.0);
            }
        }
    }
}

#[inline]
fn f32_to_i16(s: f32) -> i16 {
    (s.clamp(-1.0, 1.0) * 32767.0) as i16
}

#[inline]
fn f32_to_u16(s: f32) -> u16 {
    ((s.clamp(-1.0, 1.0) * 32767.0) + 32768.0).clamp(0.0, 65535.0) as u16
}

#[inline]
fn f32_to_i32(s: f32) -> i32 {
    (s.clamp(-1.0, 1.0) * 2_147_483_647.0) as i32
}

fn find_wasapi_device_by_name(
    enumerator: &DeviceEnumerator,
    dir: Direction,
    friendly_name: &str,
) -> Option<wasapi::Device> {
    let target = friendly_name.trim().to_ascii_lowercase();
    let col = enumerator.get_device_collection(dir).ok()?;
    let count = col.get_nbr_devices().ok()?;
    for idx in 0..count {
        if let Ok(dev) = col.get_device_at_index(idx) {
            if let Ok(name) = dev.get_friendlyname() {
                if name.trim().to_ascii_lowercase() == target {
                    return Some(dev);
                }
            }
        }
    }
    None
}

#[allow(clippy::too_many_arguments)]
fn setup_and_run_wasapi_comm_capture(
    selected_input: &str,
    chosen_name: &str,
    selected_output: &str,
    use_comm_category: bool,
    mut prod: ringbuf::HeapProd<f32>,
    stop_worker: Arc<AtomicBool>,
    err_worker: Arc<AtomicBool>,
    shared_worker: Arc<SharedVoiceRuntime>,
    ready_tx: &mut Option<std::sync::mpsc::SyncSender<bool>>,
) {
    let _ = initialize_mta();
    let open_res = (|| -> Option<(
        wasapi::AudioClient,
        wasapi::AudioCaptureClient,
        wasapi::Handle,
        usize,
        bool,
    )> {
        let enumerator = DeviceEnumerator::new().ok()?;
        let input_dev = if !chosen_name.trim().is_empty() {
            find_wasapi_device_by_name(&enumerator, Direction::Capture, chosen_name).or_else(
                || {
                    if selected_input == "default" || selected_input.trim().is_empty() {
                        enumerator
                            .get_default_device_for_role(Direction::Capture, Role::Communications)
                            .or_else(|_| enumerator.get_default_device(Direction::Capture))
                            .ok()
                    } else {
                        None
                    }
                },
            )?
        } else {
            enumerator
                .get_default_device_for_role(Direction::Capture, Role::Communications)
                .or_else(|_| enumerator.get_default_device(Direction::Capture))
                .ok()?
        };

        let mut audio_client = input_dev.get_iaudioclient().ok()?;
        let (_def_time, min_time) = audio_client.get_device_period().ok()?;
        if use_comm_category {
            let properties =
                AudioClientProperties::new().set_category(StreamCategory::Communications);
            let _ = audio_client.set_properties(properties);
        }

        let desired_format =
            WaveFormat::new(32, 32, SampleType::Float, VOICE_SAMPLE_RATE, 1, None);
        let mode = StreamMode::EventsShared {
            autoconvert: true,
            buffer_duration_hns: min_time.max(100_000),
        };
        audio_client
            .initialize_client(&desired_format, Direction::Capture, mode, None)
            .ok()?;

        let mut aec_active = false;
        if use_comm_category && audio_client.is_aec_supported().unwrap_or(false) {
            if let Ok(aec_ctrl) = audio_client.get_aec_control() {
                let out_dev_opt = if selected_output == "default" || selected_output.trim().is_empty() {
                    enumerator
                        .get_default_device_for_role(Direction::Render, Role::Communications)
                        .or_else(|_| enumerator.get_default_device(Direction::Render))
                        .ok()
                } else {
                    find_wasapi_device_by_name(&enumerator, Direction::Render, selected_output)
                        .or_else(|| enumerator.get_default_device(Direction::Render).ok())
                };
                if let Some(out_dev) = out_dev_opt {
                    if let Ok(render_id) = out_dev.get_id() {
                        if aec_ctrl
                            .set_echo_cancellation_render_endpoint(Some(render_id))
                            .is_ok()
                        {
                            aec_active = true;
                        }
                    }
                }
            }
        }

        let h_event = audio_client.set_get_eventhandle().ok()?;
        let buffer_frames = audio_client.get_buffer_size().ok()?.max(480) as usize;
        let capture_client = audio_client.get_audiocaptureclient().ok()?;
        audio_client.start_stream().ok()?;
        Some((
            audio_client,
            capture_client,
            h_event,
            buffer_frames,
            aec_active,
        ))
    })();

    let Some((audio_client, capture_client, h_event, buffer_frames, aec_active)) = open_res else {
        return; // Drops ready_tx -> caller detects disconnect & falls back to cpal
    };
    if let Some(tx) = ready_tx.take() {
        let _ = tx.send(aec_active);
    }

    let mut byte_buf = vec![0u8; buffer_frames * 4 * 4];
    while !stop_worker.load(Ordering::Acquire) {
        match capture_client.read_from_device(&mut byte_buf) {
            Ok((frames_read, info)) => {
                if frames_read > 0 {
                    shared_worker
                        .last_in_cb_ms
                        .store(shared_worker.now_ms(), Ordering::Relaxed);
                    if info.flags.silent {
                        for _ in 0..frames_read {
                            let _ = prod.try_push(0.0);
                        }
                    } else {
                        let byte_len = (frames_read as usize * 4).min(byte_buf.len());
                        for chunk in byte_buf[..byte_len].chunks_exact(4) {
                            let sample = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                            let _ = prod.try_push(sample);
                        }
                    }
                }
            }
            Err(_) => {
                err_worker.store(true, Ordering::Release);
                break;
            }
        }
        let _ = h_event.wait_for_event(100);
    }
    let _ = audio_client.stop_stream();
}

/// Opens a live WASAPI `StreamCategory::Communications` capture stream at 48 kHz mono f32
/// so Windows hardware/driver Acoustic Echo Cancellation (AEC APO) cancels speaker movie playback.
fn try_open_wasapi_comm_input_stream(
    selected_input: &str,
    chosen_name: &str,
    selected_output: &str,
    is_bt: bool,
    use_comm_category: bool,
    err_flag: Arc<AtomicBool>,
    shared: Arc<SharedVoiceRuntime>,
) -> Option<OpenedInputStream> {
    let rb = HeapRb::<f32>::new(VOICE_SAMPLE_RATE);
    let (prod, cons) = rb.split();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_worker = Arc::clone(&stop);
    let err_worker = Arc::clone(&err_flag);
    let shared_worker = Arc::clone(&shared);
    let sel_in = selected_input.to_string();
    let ch_name = chosen_name.to_string();
    let sel_out = selected_output.to_string();

    let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel::<bool>(1);
    let mut ready_tx_opt = Some(ready_tx);
    let join = std::thread::Builder::new()
        .name("epilod-voice-wasapi-in".to_string())
        .spawn(move || {
            setup_and_run_wasapi_comm_capture(
                &sel_in,
                &ch_name,
                &sel_out,
                use_comm_category,
                prod,
                stop_worker,
                err_worker,
                shared_worker,
                &mut ready_tx_opt,
            );
        })
        .ok()?;

    let Ok(aec_active) = ready_rx.recv() else {
        let _ = join.join();
        return None;
    };

    let capture_backend = if use_comm_category {
        "wasapi-comm"
    } else {
        "wasapi-raw"
    };
    shared.record_log(&format!(
        "voice.{capture_backend} capture opened: '{chosen_name}' aec={aec_active}"
    ));

    Some(OpenedInputStream {
        stream: ActiveCaptureBackend::Wasapi {
            stop,
            join: Some(join),
        },
        cons,
        sample_rate: VOICE_SAMPLE_RATE as u32,
        device_name: chosen_name.to_string(),
        is_bt,
        comm_aec_active: aec_active,
        capture_backend,
    })
}

fn open_input_stream(
    selected: &str,
    selected_output: &str,
    use_comm_category: bool,
    err_flag: Arc<AtomicBool>,
    shared: Arc<SharedVoiceRuntime>,
) -> Result<OpenedInputStream, (&'static str, bool, String)> {
    let host = cpal::default_host();
    let list = list_voice_devices(selected, selected_output);
    if list.permission_denied {
        return Err((
            "permissionDenied",
            true,
            "Microphone access denied by Windows privacy settings.".to_string(),
        ));
    }
    let Some(chosen) = resolve_input_device_choice(selected, &list.inputs) else {
        return Err((
            "reconnecting",
            false,
            "No microphone input device found.".to_string(),
        ));
    };
    let chosen_name = chosen.id.clone();
    let is_bt = chosen.is_bluetooth;

    if !is_bt {
        let out_name = resolve_output_device_choice(selected_output, &list.outputs)
            .map(|d| d.id.clone())
            .unwrap_or_else(|| "default".to_string());
        if let Some(opened) = try_open_wasapi_comm_input_stream(
            selected,
            &chosen_name,
            &out_name,
            is_bt,
            use_comm_category,
            Arc::clone(&err_flag),
            Arc::clone(&shared),
        ) {
            return Ok(opened);
        }
    }

    let dev = host
        .input_devices()
        .map_err(|e| classify_audio_open_error(&format!("Input enumeration error: {e}")))?
        .find(|d| d.name().ok().as_deref() == Some(chosen_name.as_str()))
        .ok_or_else(|| {
            (
                "reconnecting",
                false,
                "Selected microphone is no longer connected.".to_string(),
            )
        })?;

    let def_cfg = dev
        .default_input_config()
        .map_err(|e| classify_audio_open_error(&format!("Input config error: {e}")))?;
    let sample_rate = def_cfg.sample_rate().0;
    let channels = def_cfg.channels().max(1) as usize;
    let fmt = def_cfg.sample_format();
    let default_stream_cfg = def_cfg.config();
    let low_latency_cfg = low_latency_stream_config(&def_cfg, 10);

    let cb_shared = Arc::clone(&shared);
    let err_cb = move |_err| {
        err_flag.store(true, Ordering::Release);
    };

    let (stream, cons) = if let Some(ref ll_cfg) = low_latency_cfg {
        build_cpal_input_stream(
            &dev,
            ll_cfg,
            fmt,
            channels,
            Arc::clone(&cb_shared),
            err_cb.clone(),
        )
        .or_else(|_| {
            build_cpal_input_stream(&dev, &default_stream_cfg, fmt, channels, cb_shared, err_cb)
        })
    } else {
        build_cpal_input_stream(&dev, &default_stream_cfg, fmt, channels, cb_shared, err_cb)
    }
    .map_err(|e| classify_audio_open_error(&format!("Failed opening microphone: {e}")))?;

    stream.play().map_err(|e| {
        classify_audio_open_error(&format!("Failed starting microphone stream: {e}"))
    })?;

    Ok(OpenedInputStream {
        stream: ActiveCaptureBackend::Cpal(stream),
        cons,
        sample_rate,
        device_name: chosen_name,
        is_bt,
        comm_aec_active: false,
        capture_backend: "cpal",
    })
}

/// Captures system render loopback (movie audio + peer voices) for echo guard & WebRTC AEC3.
fn open_loopback_stream(
    selected_output: &str,
    err_flag: Arc<AtomicBool>,
) -> Option<(cpal::Stream, ringbuf::HeapCons<f32>, u32)> {
    let host = cpal::default_host();
    let list = list_voice_devices("default", selected_output);
    let chosen = resolve_output_device_choice(selected_output, &list.outputs)?;
    if chosen.is_bluetooth {
        return None;
    }
    let dev = host
        .output_devices()
        .ok()?
        .find(|d| d.name().ok().as_deref() == Some(chosen.id.as_str()))?;
    let def_cfg = dev.default_output_config().ok()?;
    let sample_rate = def_cfg.sample_rate().0;
    let channels = def_cfg.channels().max(1) as usize;
    let fmt = def_cfg.sample_format();
    let stream_cfg = def_cfg.config();

    let rb = HeapRb::<f32>::new(VOICE_SAMPLE_RATE);
    let (mut prod, cons) = rb.split();
    let err_cb = move |_err| {
        err_flag.store(true, Ordering::Release);
    };

    let stream = match fmt {
        cpal::SampleFormat::F32 => dev
            .build_input_stream(
                &stream_cfg,
                move |data: &[f32], _| {
                    push_pcm_to_mono_rb(data, channels, &mut prod, |s| s);
                },
                err_cb,
                None,
            )
            .ok()?,
        cpal::SampleFormat::I16 => dev
            .build_input_stream(
                &stream_cfg,
                move |data: &[i16], _| {
                    push_pcm_to_mono_rb(data, channels, &mut prod, |s| (s as f32) / 32768.0);
                },
                err_cb,
                None,
            )
            .ok()?,
        cpal::SampleFormat::U16 => dev
            .build_input_stream(
                &stream_cfg,
                move |data: &[u16], _| {
                    push_pcm_to_mono_rb(data, channels, &mut prod, |s| {
                        ((s as f32) - 32768.0) / 32768.0
                    });
                },
                err_cb,
                None,
            )
            .ok()?,
        cpal::SampleFormat::I32 => dev
            .build_input_stream(
                &stream_cfg,
                move |data: &[i32], _| {
                    push_pcm_to_mono_rb(data, channels, &mut prod, |s| {
                        (s as f32) / 2_147_483_648.0
                    });
                },
                err_cb,
                None,
            )
            .ok()?,
        _ => return None,
    };

    stream.play().ok()?;
    Some((stream, cons, sample_rate))
}

fn open_output_stream(
    selected: &str,
    err_flag: Arc<AtomicBool>,
    shared: Arc<SharedVoiceRuntime>,
) -> Result<(cpal::Stream, ringbuf::HeapProd<f32>, u32, String, bool), String> {
    let host = cpal::default_host();
    let list = list_voice_devices("default", selected);
    let Some(chosen) = resolve_output_device_choice(selected, &list.outputs) else {
        return Err("No speaker/headphone output device found.".to_string());
    };
    let chosen_name = chosen.id.clone();
    let out_is_bt = chosen.is_bluetooth;

    let dev = host
        .output_devices()
        .map_err(|e| format!("Output enumeration error: {e}"))?
        .find(|d| d.name().ok().as_deref() == Some(chosen_name.as_str()))
        .ok_or_else(|| "Selected output device is no longer connected.".to_string())?;

    let def_cfg = dev
        .default_output_config()
        .map_err(|e| format!("Output config error: {e}"))?;
    let sample_rate = def_cfg.sample_rate().0;
    let channels = def_cfg.channels().max(1) as usize;
    let fmt = def_cfg.sample_format();
    let default_stream_cfg = def_cfg.config();
    let low_latency_cfg = low_latency_stream_config(&def_cfg, 10);

    let (stream, prod) = if let Some(ref ll_cfg) = low_latency_cfg {
        build_cpal_output_stream(
            &dev,
            ll_cfg,
            fmt,
            channels,
            Arc::clone(&shared),
            Arc::clone(&err_flag),
        )
        .or_else(|_| {
            build_cpal_output_stream(&dev, &default_stream_cfg, fmt, channels, shared, err_flag)
        })
    } else {
        build_cpal_output_stream(&dev, &default_stream_cfg, fmt, channels, shared, err_flag)
    }
    .map_err(|e| format!("Failed opening playback device: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Failed starting playback stream: {e}"))?;

    Ok((stream, prod, sample_rate, chosen_name, out_is_bt))
}

/// High-resolution waitable-timer sleeper for sub-millisecond voice pacing on Windows,
/// avoiding the default 15.625 ms OS timer tick quantization.
struct HighResSleeper {
    handle: HANDLE,
}

impl HighResSleeper {
    fn new() -> Self {
        let handle = unsafe {
            CreateWaitableTimerExW(
                std::ptr::null(),
                std::ptr::null(),
                CREATE_WAITABLE_TIMER_HIGH_RESOLUTION,
                TIMER_ALL_ACCESS,
            )
        };
        Self { handle }
    }

    fn sleep(&self, dur: Duration) {
        if dur.is_zero() {
            return;
        }
        if !self.handle.is_null() {
            let ticks_100ns = -((dur.as_nanos() / 100).max(1).min(i64::MAX as u128) as i64);
            let ok = unsafe {
                SetWaitableTimer(self.handle, &ticks_100ns, 0, None, std::ptr::null(), 0)
            };
            if ok != 0 {
                unsafe {
                    WaitForSingleObject(self.handle, INFINITE);
                }
                return;
            }
        }
        std::thread::sleep(dur);
    }
}

impl Drop for HighResSleeper {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

fn low_latency_stream_config(
    def_cfg: &cpal::SupportedStreamConfig,
    target_ms: u32,
) -> Option<cpal::StreamConfig> {
    let mut cfg = def_cfg.config();
    match def_cfg.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } if *min <= *max => {
            let desired = ((def_cfg.sample_rate().0 as u64 * target_ms as u64) / 1000)
                .clamp(*min as u64, *max as u64) as u32;
            cfg.buffer_size = cpal::BufferSize::Fixed(desired);
            Some(cfg)
        }
        _ => None,
    }
}

fn build_cpal_input_stream<E>(
    dev: &cpal::Device,
    stream_cfg: &cpal::StreamConfig,
    fmt: cpal::SampleFormat,
    channels: usize,
    cb_shared: Arc<SharedVoiceRuntime>,
    err_cb: E,
) -> Result<(cpal::Stream, ringbuf::HeapCons<f32>), String>
where
    E: FnMut(cpal::StreamError) + Send + 'static,
{
    let rb = HeapRb::<f32>::new(VOICE_SAMPLE_RATE); // 1 second cushion
    let (mut prod, cons) = rb.split();
    let stream = match fmt {
        cpal::SampleFormat::F32 => dev.build_input_stream(
            stream_cfg,
            move |data: &[f32], _| {
                cb_shared
                    .last_in_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                push_pcm_to_mono_rb(data, channels, &mut prod, |s| s);
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I16 => dev.build_input_stream(
            stream_cfg,
            move |data: &[i16], _| {
                cb_shared
                    .last_in_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                push_pcm_to_mono_rb(data, channels, &mut prod, |s| (s as f32) / 32768.0);
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::U16 => dev.build_input_stream(
            stream_cfg,
            move |data: &[u16], _| {
                cb_shared
                    .last_in_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                push_pcm_to_mono_rb(data, channels, &mut prod, |s| {
                    ((s as f32) - 32768.0) / 32768.0
                });
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I32 => dev.build_input_stream(
            stream_cfg,
            move |data: &[i32], _| {
                cb_shared
                    .last_in_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                push_pcm_to_mono_rb(data, channels, &mut prod, |s| (s as f32) / 2_147_483_648.0);
            },
            err_cb,
            None,
        ),
        other => return Err(format!("Unsupported microphone sample format: {other:?}")),
    }
    .map_err(|e| format!("{e}"))?;
    Ok((stream, cons))
}

fn build_cpal_output_stream(
    dev: &cpal::Device,
    stream_cfg: &cpal::StreamConfig,
    fmt: cpal::SampleFormat,
    channels: usize,
    cb_shared: Arc<SharedVoiceRuntime>,
    err_flag: Arc<AtomicBool>,
) -> Result<(cpal::Stream, ringbuf::HeapProd<f32>), String> {
    let rb = HeapRb::<f32>::new(VOICE_SAMPLE_RATE * 2);
    let (prod, mut cons) = rb.split();
    let mut last_l = 0.0f32;
    let mut last_r = 0.0f32;
    let err_cb = move |_err| {
        err_flag.store(true, Ordering::Release);
    };

    let stream = match fmt {
        cpal::SampleFormat::F32 => dev.build_output_stream(
            stream_cfg,
            move |data: &mut [f32], _| {
                cb_shared
                    .last_out_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                pop_stereo_from_rb(data, channels, &mut cons, &mut last_l, &mut last_r, |s| s);
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I16 => dev.build_output_stream(
            stream_cfg,
            move |data: &mut [i16], _| {
                cb_shared
                    .last_out_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                pop_stereo_from_rb(
                    data,
                    channels,
                    &mut cons,
                    &mut last_l,
                    &mut last_r,
                    f32_to_i16,
                );
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::U16 => dev.build_output_stream(
            stream_cfg,
            move |data: &mut [u16], _| {
                cb_shared
                    .last_out_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                pop_stereo_from_rb(
                    data,
                    channels,
                    &mut cons,
                    &mut last_l,
                    &mut last_r,
                    f32_to_u16,
                );
            },
            err_cb,
            None,
        ),
        cpal::SampleFormat::I32 => dev.build_output_stream(
            stream_cfg,
            move |data: &mut [i32], _| {
                cb_shared
                    .last_out_cb_ms
                    .store(cb_shared.now_ms(), Ordering::Relaxed);
                pop_stereo_from_rb(
                    data,
                    channels,
                    &mut cons,
                    &mut last_l,
                    &mut last_r,
                    f32_to_i32,
                );
            },
            err_cb,
            None,
        ),
        other => return Err(format!("Unsupported playback sample format: {other:?}")),
    }
    .map_err(|e| format!("{e}"))?;
    Ok((stream, prod))
}

/// Adjusts mixer sleep period slightly (19..=22 ms) around a tight 25..40 ms output cushion so
/// hardware DAC crystal drift never underruns or builds stale latency.
pub fn compute_output_pacing_delay_ms(
    occupied_samples: usize,
    stereo_frame_samples: usize,
    active_audio: bool,
) -> i64 {
    let low_samples = (stereo_frame_samples * 5) / 4; // 25 ms minimum skew headroom
    let high_samples = stereo_frame_samples * 2; // 40 ms target ceiling
    if active_audio && occupied_samples < low_samples {
        19
    } else if occupied_samples > stereo_frame_samples * 3 {
        22
    } else if occupied_samples > high_samples {
        21
    } else {
        20
    }
}

fn build_mono_48k_resampler(src_rate: u32) -> Option<VoiceResamplerState> {
    if src_rate == VOICE_SAMPLE_RATE as u32 || src_rate == 0 {
        return None;
    }
    let chunk_in = ((src_rate as usize) / 100).max(128);
    let rs = FastFixedIn::<f32>::new(
        VOICE_SAMPLE_RATE as f64 / src_rate as f64,
        1.0,
        PolynomialDegree::Cubic,
        chunk_in,
        1,
    )
    .ok()?;
    let in_buf = vec![vec![0.0f32; chunk_in]];
    let out_buf = rs.output_buffer_allocate(true);
    Some(VoiceResamplerState {
        resampler: rs,
        in_buf,
        out_buf,
    })
}

fn drain_mono_stream_to_48k(
    cons: &mut ringbuf::HeapCons<f32>,
    raw_accum: &mut Vec<f32>,
    resampler: &mut Option<VoiceResamplerState>,
    out_fifo: &mut VecDeque<f32>,
) {
    let avail = cons.occupied_len();
    if avail == 0 {
        return;
    }
    let start_len = raw_accum.len();
    raw_accum.resize(start_len + avail, 0.0);
    let n = cons.pop_slice(&mut raw_accum[start_len..]);
    raw_accum.truncate(start_len + n);

    if let Some(ref mut rs_state) = resampler {
        let needed = rs_state.resampler.input_frames_next();
        while raw_accum.len() >= needed {
            rs_state.in_buf[0].copy_from_slice(&raw_accum[..needed]);
            raw_accum.drain(..needed);
            if let Ok((_, out_n)) = rs_state.resampler.process_into_buffer(
                &rs_state.in_buf,
                &mut rs_state.out_buf,
                None,
            ) {
                out_fifo.extend(&rs_state.out_buf[0][..out_n]);
            }
        }
    } else {
        out_fifo.extend(raw_accum.drain(..));
    }
}

struct DiagCaptureAligner {
    raw_hold: VecDeque<[f32; VOICE_FRAME_10MS]>,
    proc_hold: VecDeque<[f32; VOICE_FRAME_10MS]>,
}

impl DiagCaptureAligner {
    fn new() -> Self {
        Self {
            raw_hold: VecDeque::with_capacity(8),
            proc_hold: VecDeque::with_capacity(8),
        }
    }

    fn clear(&mut self) {
        self.raw_hold.clear();
        self.proc_hold.clear();
    }

    fn push_raw(&mut self, frame: &[f32; VOICE_FRAME_10MS]) {
        if self.raw_hold.len() >= 8 {
            self.raw_hold.pop_front();
        }
        self.raw_hold.push_back(*frame);
    }

    fn push_compressed_20ms(&mut self, pcm20: &[f32; VOICE_FRAME_20MS], skip_second_half: bool) {
        let mut p0 = [0.0f32; VOICE_FRAME_10MS];
        p0.copy_from_slice(&pcm20[..VOICE_FRAME_10MS]);
        if self.proc_hold.len() < 8 {
            self.proc_hold.push_back(p0);
        }
        if !skip_second_half && self.proc_hold.len() < 8 {
            let mut p1 = [0.0f32; VOICE_FRAME_10MS];
            p1.copy_from_slice(&pcm20[VOICE_FRAME_10MS..VOICE_FRAME_20MS]);
            self.proc_hold.push_back(p1);
        }
    }

    fn drain_aligned<F>(&mut self, is_gate_open: bool, encode_accum_len: usize, mut emit_pair: F)
    where
        F: FnMut([f32; VOICE_FRAME_10MS], [f32; VOICE_FRAME_10MS]),
    {
        let rem_chunks = encode_accum_len / VOICE_FRAME_10MS;
        while self.proc_hold.len() + rem_chunks > self.raw_hold.len() && !self.proc_hold.is_empty()
        {
            self.proc_hold.pop_front();
        }
        while !self.raw_hold.is_empty() && !self.proc_hold.is_empty() {
            if let (Some(r), Some(p)) = (self.raw_hold.pop_front(), self.proc_hold.pop_front()) {
                emit_pair(r, p);
            }
        }
        if !is_gate_open && encode_accum_len == 0 {
            while self.raw_hold.len() > 2 {
                if let Some(r) = self.raw_hold.pop_front() {
                    emit_pair(r, [0.0f32; VOICE_FRAME_10MS]);
                }
            }
        }
    }
}

fn run_dsp_tx_thread(shared: Arc<SharedVoiceRuntime>) {
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    }
    let mut hpf = BiquadHighPass::new_80hz_48k();
    let mut noop_aec = NoopEchoCanceller;
    let mut webrtc_aec3 = WebRtcAec3Canceller::new();
    let mut echo_detector = SpeakerEchoDetector::new();
    let mut calibrator: Option<(VoiceCalibrator, Instant, u8)> = None;
    let initial_engine_mode = shared
        .config
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .engine_mode;
    let mut last_engine_mode = initial_engine_mode;
    let mut denoiser = if initial_engine_mode == VoiceEngineModeWire::Aura {
        VoiceDenoiser::new_aura()
    } else {
        VoiceDenoiser::new()
    };
    let mut agc2 =
        WebRtcAgc2Leveler::with_params(if initial_engine_mode == VoiceEngineModeWire::Aura {
            WebRtcAgc2Params::aura()
        } else {
            WebRtcAgc2Params::default()
        });
    let mut lb_empty_ticks: u32 = 0;
    let mut gate = VoiceGate::new();
    let mut comp = VoiceCompressor::new();
    let mut abr = AdaptiveBitrateController::new();

    let Ok(mut encoder) = OpusEncoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip)
    else {
        return;
    };
    let _ = encoder.set_bitrate(Bitrate::BitsPerSecond(64_000));
    let _ = encoder.set_complexity(9);
    let _ = encoder.set_inband_fec(true);
    let _ = encoder.set_packet_loss_perc(5);
    let _ = encoder.set_dtx(false);
    let _ = encoder.set_signal(Signal::Voice);
    let mut last_signal_is_auto = false;

    let Ok(mut test_decoder) = OpusDecoder::new(SampleRate::Hz48000, Channels::Mono) else {
        return;
    };

    let err_flag = Arc::new(AtomicBool::new(false));
    let _wasapi_notif = register_wasapi_flag_notifier(Arc::clone(&err_flag));
    let lb_err_flag = Arc::new(AtomicBool::new(false));
    let mut watchdog = StreamWatchdogState::new();
    let comm_aec_supported = probe_windows_comm_aec();
    shared
        .windows_comm_aec
        .store(comm_aec_supported, Ordering::Relaxed);

    let mut active_stream: Option<(ActiveCaptureBackend, ringbuf::HeapCons<f32>, u32)> = None;
    let mut live_comm_aec = false;
    let mut resampler: Option<VoiceResamplerState> = None;
    let mut raw_accum: Vec<f32> = Vec::with_capacity(4096);
    let mut mono_48k_fifo: VecDeque<f32> = VecDeque::with_capacity(4096);
    let sleeper = HighResSleeper::new();

    let mut active_loopback: Option<(cpal::Stream, ringbuf::HeapCons<f32>, u32)> = None;
    let mut lb_resampler: Option<VoiceResamplerState> = None;
    let mut lb_raw_accum: Vec<f32> = Vec::with_capacity(4096);
    let mut lb_mono_48k_fifo: VecDeque<f32> = VecDeque::with_capacity(4096);
    let mut loopback_attempted = false;

    let mut frame_10ms = [0.0f32; VOICE_FRAME_10MS];
    let mut aec_out = [0.0f32; VOICE_FRAME_10MS];
    let mut ns_out = [0.0f32; VOICE_FRAME_10MS];
    let mut leveled_out = [0.0f32; VOICE_FRAME_10MS];
    let mut gate_out = [[0.0f32; VOICE_FRAME_10MS]; 3];
    let mut encode_accum: Vec<f32> = Vec::with_capacity(VOICE_FRAME_20MS * 2);
    let mut opus_out = [0u8; MAX_VOICE_OPUS_BYTES];
    let mut test_pcm_out = vec![0.0f32; VOICE_FRAME_20MS];

    let mut seq: u16 = 0;
    let mut ts_48k: u32 = 0;
    let mut eot_remaining: u8 = 0;
    let mut was_gate_open = false;
    let mut auto_noise_floor_db: f32 = -54.0;
    let mut last_level_emit = Instant::now();
    let mut last_dev_check = Instant::now();
    let mut last_power_check = Instant::now();
    let mut last_wall_clock = SystemTime::now();
    let mut last_mono_clock = Instant::now();
    let mut last_comm_default: Option<String> = None;
    let mut prev_cb_ms = 0u64;
    let mut diag_aligner = DiagCaptureAligner::new();
    let mut diag_prev_active = false;
    let mut diag_raw_10ms = [0.0f32; VOICE_FRAME_10MS];

    while !shared.stop_flag.load(Ordering::Acquire) {
        let cfg = shared
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let now_ms = shared.now_ms();

        // Update active AEC backend label cleanly
        let backend_label = if cfg.aec_enabled {
            "webrtc-aec3"
        } else if live_comm_aec || comm_aec_supported {
            "windows-comm"
        } else if cfg.echo_guard_enabled {
            "webrtc-aec3+guard"
        } else {
            "none"
        };
        {
            let mut ab = shared
                .aec_backend
                .write()
                .unwrap_or_else(|e| e.into_inner());
            if *ab != backend_label {
                *ab = backend_label.to_string();
            }
        }

        // Sleep/resume wall-clock jump detector + periodic Windows default/power checks
        if last_dev_check.elapsed() >= Duration::from_millis(1500) {
            last_dev_check = Instant::now();
            if let Ok(wall_elapsed) = last_wall_clock.elapsed() {
                let mono_elapsed = last_mono_clock.elapsed();
                if wall_elapsed > mono_elapsed + Duration::from_millis(2500) {
                    shared.record_log("voice.sleep-resume jump detected; reopening mic");
                    err_flag.store(true, Ordering::Release);
                }
            }
            last_wall_clock = SystemTime::now();
            last_mono_clock = Instant::now();

            if cfg.input_device == "default" {
                let (comm, _, _) = query_wasapi_metadata(Direction::Capture);
                if last_comm_default.is_some() && comm != last_comm_default {
                    err_flag.store(true, Ordering::Release);
                }
                last_comm_default = comm;
            }
        }

        if last_power_check.elapsed() >= Duration::from_secs(10) {
            last_power_check = Instant::now();
            let on_bat = query_windows_on_battery();
            if let Some(ref tr) = *shared.transport.read().unwrap_or_else(|e| e.into_inner()) {
                tr.update_battery_state(on_bat);
            }
        }

        // Watchdog: detect stalled capture stream (> 1.5 s without any callback)
        let latest_cb = shared.last_in_cb_ms.load(Ordering::Relaxed);
        if latest_cb != prev_cb_ms {
            prev_cb_ms = latest_cb;
            watchdog.record_callback(now_ms);
        } else if active_stream.is_some() && watchdog.is_stalled(now_ms) {
            shared.record_log("voice.input watchdog stall (>1500ms); reopening mic");
            shared.set_stream_status("reconnecting", Some("Mic lost, reconnecting…".to_string()));
            err_flag.store(true, Ordering::Release);
        }

        if shared.input_device_dirty.swap(false, Ordering::AcqRel)
            || err_flag.swap(false, Ordering::AcqRel)
        {
            active_stream = None;
            live_comm_aec = false;
            watchdog.on_stream_closed();
            resampler = None;
            raw_accum.clear();
            mono_48k_fifo.clear();
            hpf.reset();
            noop_aec.reset();
            webrtc_aec3.reset();
            echo_detector.reset();
            denoiser.reset();
            agc2.reset();
            gate.reset();
            comp.reset();
        }

        if shared.loopback_device_dirty.swap(false, Ordering::AcqRel)
            || lb_err_flag.swap(false, Ordering::AcqRel)
        {
            active_loopback = None;
            loopback_attempted = false;
            lb_resampler = None;
            lb_raw_accum.clear();
            lb_mono_48k_fifo.clear();
            webrtc_aec3.reset();
        }

        if active_loopback.is_none() && !loopback_attempted {
            loopback_attempted = true;
            if let Some((lb_stream, lb_cons, lb_rate)) =
                open_loopback_stream(&cfg.output_device, Arc::clone(&lb_err_flag))
            {
                lb_resampler = build_mono_48k_resampler(lb_rate);
                active_loopback = Some((lb_stream, lb_cons, lb_rate));
            }
        }

        if active_stream.is_none() {
            if !watchdog.can_attempt_open(now_ms) {
                std::thread::sleep(Duration::from_millis(25));
                continue;
            }
            let use_comm_category = cfg.engine_mode == VoiceEngineModeWire::Classic
                || (cfg.use_windows_comm_aec && (cfg.aec_enabled || cfg.echo_guard_enabled));
            match open_input_stream(
                &cfg.input_device,
                &cfg.output_device,
                use_comm_category,
                Arc::clone(&err_flag),
                Arc::clone(&shared),
            ) {
                Ok(opened) => {
                    watchdog.on_stream_opened(now_ms);
                    live_comm_aec = opened.comm_aec_active;
                    shared
                        .windows_comm_aec
                        .store(live_comm_aec || comm_aec_supported, Ordering::Relaxed);
                    shared.permission_denied.store(false, Ordering::Release);
                    shared
                        .active_input_is_bt
                        .store(opened.is_bt, Ordering::Release);
                    *shared
                        .active_input_name
                        .write()
                        .unwrap_or_else(|e| e.into_inner()) = Some(opened.device_name);
                    *shared
                        .capture_backend
                        .write()
                        .unwrap_or_else(|e| e.into_inner()) = opened.capture_backend.to_string();
                    shared.set_stream_status("live", None);
                    resampler = build_mono_48k_resampler(opened.sample_rate);
                    active_stream = Some((opened.stream, opened.cons, opened.sample_rate));
                }
                Err((status_code, denied, msg)) => {
                    let _delay = watchdog.on_open_failure(now_ms);
                    shared.permission_denied.store(denied, Ordering::Release);
                    shared.set_stream_status(status_code, Some(msg.clone()));
                    if shared.calibrate_requested.swap(false, Ordering::AcqRel) {
                        if let Some(ref app) =
                            *shared.app_handle.read().unwrap_or_else(|e| e.into_inner())
                        {
                            let _ = app.emit(
                                "voice://calibration",
                                serde_json::json!({
                                    "phase": "error",
                                    "progress": 0,
                                    "message": msg,
                                }),
                            );
                        }
                    }
                    std::thread::sleep(Duration::from_millis(50));
                    continue;
                }
            }
        }

        if shared.calibrate_requested.swap(false, Ordering::AcqRel) {
            calibrator = Some((VoiceCalibrator::default(), Instant::now(), 0));
        }

        if let Some((_, ref mut cons, _)) = active_stream {
            drain_mono_stream_to_48k(cons, &mut raw_accum, &mut resampler, &mut mono_48k_fifo);
            // Keep capture mic latency bounded (max 120 ms) while absorbing OS scheduling spikes without dropping speech
            let max_tx_fifo = VOICE_FRAME_10MS * 12;
            if mono_48k_fifo.len() > max_tx_fifo {
                let excess_frames = (mono_48k_fifo.len() - max_tx_fifo) / VOICE_FRAME_10MS;
                if excess_frames > 0 {
                    mono_48k_fifo.drain(..excess_frames * VOICE_FRAME_10MS);
                    shared
                        .tx_fifo_dropped_frames
                        .fetch_add(excess_frames as u64, Ordering::Relaxed);
                }
            }
        }
        if let Some((_, ref mut lb_cons, _)) = active_loopback {
            drain_mono_stream_to_48k(
                lb_cons,
                &mut lb_raw_accum,
                &mut lb_resampler,
                &mut lb_mono_48k_fifo,
            );
            // Keep render loopback latency tightly bounded in whole 10 ms frames so FFT phase stays aligned
            while lb_mono_48k_fifo.len() > VOICE_FRAME_10MS * 8 {
                lb_mono_48k_fifo.drain(..VOICE_FRAME_10MS);
            }
        }

        let mut processed_any = false;
        while mono_48k_fifo.len() >= VOICE_FRAME_10MS {
            processed_any = true;
            let t_dsp0 = Instant::now();
            for s in &mut frame_10ms {
                *s = mono_48k_fifo.pop_front().unwrap_or(0.0);
            }

            let diag_active = shared.diag_capture_active.load(Ordering::Relaxed);
            if diag_active != diag_prev_active {
                diag_aligner.clear();
                diag_prev_active = diag_active;
            }
            if diag_active {
                diag_raw_10ms.copy_from_slice(&frame_10ms);
                diag_aligner.push_raw(&diag_raw_10ms);
            }

            hpf.process_in_place(&mut frame_10ms);

            let is_aura = cfg.engine_mode == VoiceEngineModeWire::Aura;
            // Feed playback far-end reference: prefer system WASAPI render loopback (covers mpv movie + voice)
            // and fall back immediately to mixed peer voices (far_end_ref_fifo) whenever loopback has < 10 ms.
            let mut popped_peer_ref = None;
            let far_frame = if active_loopback.is_some() && lb_mono_48k_fifo.len() >= VOICE_FRAME_10MS
            {
                lb_empty_ticks = 0;
                let mut f = [0.0f32; VOICE_FRAME_10MS];
                for dst in &mut f {
                    *dst = lb_mono_48k_fifo.pop_front().unwrap_or(0.0);
                }
                // Keep peer FIFO drained in lockstep while loopback is live so fallback stays fresh.
                let _ = shared
                    .far_end_ref_fifo
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .pop_front();
                Some(f)
            } else {
                lb_empty_ticks = lb_empty_ticks.saturating_add(1);
                popped_peer_ref = shared
                    .far_end_ref_fifo
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .pop_front();
                popped_peer_ref
            };
            let _ = (lb_empty_ticks, popped_peer_ref);
            let far_rms = if let Some(ref f) = far_frame {
                (f.iter().map(|s| s * s).sum::<f32>() / VOICE_FRAME_10MS as f32).sqrt()
            } else {
                f32::from_bits(shared.far_end_rms_bits.load(Ordering::Relaxed))
            };
            let near_rms =
                (frame_10ms.iter().map(|s| s * s).sum::<f32>() / VOICE_FRAME_10MS as f32).sqrt();
            let out_is_headphone = shared.active_output_is_bt.load(Ordering::Relaxed)
                || shared
                    .active_output_name
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_deref()
                    .is_some_and(is_likely_headphone_name);
            let detected_leak = if out_is_headphone {
                echo_detector.reset();
                false
            } else {
                echo_detector.push_10ms_rms(far_rms, near_rms)
            };
            if shared
                .speaker_leak_detected
                .swap(detected_leak, Ordering::Relaxed)
                != detected_leak
            {
                shared.emit_status_snapshot();
            }

            let use_aec = cfg.aec_enabled || cfg.echo_guard_enabled;
            if use_aec {
                let ref_slice = far_frame.unwrap_or([0.0; VOICE_FRAME_10MS]);
                webrtc_aec3.process_10ms(&frame_10ms, Some(&ref_slice), &mut aec_out);
            } else {
                noop_aec.process_10ms(&frame_10ms, None, &mut aec_out);
            }

            // Gentle speaker-echo guard: runs only when neither hardware Comm AEC nor WebRTC AEC3
            // is actively cancelling the far-end signal.
            let half_duplex_guard = cfg.echo_guard_enabled
                && detected_leak
                && !live_comm_aec
                && !use_aec
                && (shared.duck.is_remote_speaking() || far_rms > 0.025);
            if half_duplex_guard {
                for s in &mut aec_out {
                    *s *= 0.55;
                }
            }

            if cfg.engine_mode != last_engine_mode {
                last_engine_mode = cfg.engine_mode;
                denoiser = if is_aura {
                    VoiceDenoiser::new_aura()
                } else {
                    VoiceDenoiser::new()
                };
                agc2 = WebRtcAgc2Leveler::with_params(if is_aura {
                    WebRtcAgc2Params::aura()
                } else {
                    WebRtcAgc2Params::default()
                });
            }

            let ns_mode = cfg.noise_mode.into_core();
            let speech_prob = denoiser.process_10ms(ns_mode, &aec_out, &mut ns_out);
            let use_agc2 = cfg.compression_enabled && ns_mode != NoiseSuppressionMode::Off;
            agc2.process_10ms(&ns_out, &mut leveled_out, use_agc2);

            // Handle 3-second mic calibration onboarding if active
            if let Some((ref mut cal, started_at, ref mut last_pct)) = calibrator {
                let elapsed_ms = started_at.elapsed().as_millis() as u64;
                let db_now = frame_dbfs(&leveled_out);
                if elapsed_ms < 1200 {
                    cal.push_quiet_db(db_now);
                    let pct = ((elapsed_ms * 40) / 1200).min(40) as u8;
                    if pct >= *last_pct + 8 {
                        *last_pct = pct;
                        if let Some(ref app) =
                            *shared.app_handle.read().unwrap_or_else(|e| e.into_inner())
                        {
                            let _ = app.emit(
                                "voice://calibration",
                                serde_json::json!({ "phase": "quiet", "progress": pct }),
                            );
                        }
                    }
                } else if elapsed_ms < 3000 {
                    cal.push_speak_db(db_now);
                    let pct = (40 + ((elapsed_ms - 1200) * 60) / 1800).min(99) as u8;
                    if pct >= *last_pct + 8 {
                        *last_pct = pct;
                        if let Some(ref app) =
                            *shared.app_handle.read().unwrap_or_else(|e| e.into_inner())
                        {
                            let _ = app.emit(
                                "voice://calibration",
                                serde_json::json!({ "phase": "speak", "progress": pct }),
                            );
                        }
                    }
                } else {
                    let (noise_floor, speech_peak, recommended) = cal.finalize();
                    shared.record_log(&format!(
                        "voice.calibration done: floor={noise_floor:.1} dB peak={speech_peak:.1} dB rec={recommended:.1} dB"
                    ));
                    if let Some(ref app) =
                        *shared.app_handle.read().unwrap_or_else(|e| e.into_inner())
                    {
                        let _ = app.emit(
                            "voice://calibration",
                            serde_json::json!({
                                "phase": "done",
                                "progress": 100,
                                "noiseFloorDb": noise_floor,
                                "speechPeakDb": speech_peak,
                                "recommendedDb": recommended,
                            }),
                        );
                    }
                    calibrator = None;
                }
            }

            // Smooth slow ambient noise floor tracking when Auto-Sensitivity is on
            let base_thresh = if cfg.auto_sensitivity {
                let raw_db = if is_aura {
                    frame_dbfs(&ns_out)
                } else {
                    frame_dbfs(&leveled_out)
                };
                if speech_prob < 0.3 && raw_db < -25.0 {
                    auto_noise_floor_db = auto_noise_floor_db * 0.992 + raw_db * 0.008;
                }
                let auto_th = if is_aura {
                    (auto_noise_floor_db + 8.0).clamp(-60.0, -34.0)
                } else {
                    (auto_noise_floor_db + 8.0).clamp(-58.0, -32.0)
                };
                (cfg.sensitivity_db * 0.35 + auto_th * 0.65).clamp(-75.0, 0.0)
            } else {
                cfg.sensitivity_db
            };

            let tight_boost =
                if cfg.cinema_tight_gate && shared.movie_playing.load(Ordering::Relaxed) {
                    0.75
                } else {
                    0.0
                } + if half_duplex_guard { 1.25 } else { 0.0 };
            let eff_thresh = (base_thresh + tight_boost).clamp(-75.0, 0.0);
            let ptt_opt = match cfg.input_mode {
                InputModeWire::Vad => None,
                InputModeWire::Ptt => Some(shared.ptt_held.load(Ordering::Relaxed)),
            };
            let muted = shared.muted.load(Ordering::Acquire);
            let mic_test = shared.mic_test_loopback.load(Ordering::Acquire);
            let eff_ptt = if mic_test { None } else { ptt_opt };
            let eff_muted = if mic_test { false } else { muted };
            let vad_assisted = ns_mode != NoiseSuppressionMode::Off;

            let (out_cnt, is_open, db) = if is_aura {
                gate.process_10ms_aura(
                    &leveled_out,
                    speech_prob,
                    eff_thresh,
                    vad_assisted,
                    eff_ptt,
                    eff_muted,
                    &mut gate_out,
                )
            } else {
                gate.process_10ms(
                    &leveled_out,
                    speech_prob,
                    eff_thresh,
                    vad_assisted,
                    eff_ptt,
                    eff_muted,
                    &mut gate_out,
                )
            };

            if is_open != was_gate_open {
                shared.gate_transitions.fetch_add(1, Ordering::Relaxed);
            }
            if is_open != was_gate_open || last_level_emit.elapsed() >= Duration::from_millis(50) {
                last_level_emit = Instant::now();
                if let Some(ref app) = *shared.app_handle.read().unwrap_or_else(|e| e.into_inner())
                {
                    let _ = app.emit(
                        "voice://level",
                        serde_json::json!({
                            "db": db,
                            "speechProb": speech_prob,
                            "gateOpen": is_open && !eff_muted,
                        }),
                    );
                }
            }

            if was_gate_open && !is_open {
                eot_remaining = 3; // 3x end-of-talk markers
            }
            was_gate_open = is_open;

            {
                // Loudness envelope of what we actually transmit, used by the RX echo suppressor.
                let env = if out_cnt > 0 && !eff_muted {
                    (gate_out[out_cnt - 1].iter().map(|s| s * s).sum::<f32>()
                        / VOICE_FRAME_10MS as f32)
                        .sqrt()
                } else {
                    0.0
                };
                let mut q = shared.own_tx_env.lock().unwrap_or_else(|e| e.into_inner());
                if q.len() >= 256 {
                    q.pop_front();
                }
                q.push_back(env);
            }
            for frame in gate_out.iter().take(out_cnt) {
                encode_accum.extend_from_slice(frame);
            }
            // Zero-pad and flush any leftover 10 ms tail when gate closes so it does not shift
            // the next talkspurt by +10 ms or cause a double-packet jitter burst on onset.
            let mut padded_tail = false;
            if !is_open && mono_48k_fifo.len() < VOICE_FRAME_10MS && !encode_accum.is_empty() {
                encode_accum.resize(VOICE_FRAME_20MS, 0.0);
                padded_tail = true;
            }

            while encode_accum.len() >= VOICE_FRAME_20MS {
                let mut pcm20 = [0.0f32; VOICE_FRAME_20MS];
                pcm20.copy_from_slice(&encode_accum[..VOICE_FRAME_20MS]);
                encode_accum.drain(..VOICE_FRAME_20MS);

                if is_aura {
                    if cfg.compression_enabled {
                        comp.process_aura_broadcast(&mut pcm20, speech_prob);
                    } else {
                        comp.process_limiter_only(&mut pcm20);
                    }
                } else {
                    comp.process_with_speech_prob(&mut pcm20, speech_prob, cfg.compression_enabled);
                }

                if diag_active {
                    diag_aligner
                        .push_compressed_20ms(&pcm20, padded_tail && encode_accum.is_empty());
                }

                // Switch Opus signal hint dynamically so Off mode preserves raw music/instruments cleanly
                let want_auto_signal = cfg.noise_mode == NoiseModeWire::Off;
                if want_auto_signal != last_signal_is_auto {
                    last_signal_is_auto = want_auto_signal;
                    let _ = encoder.set_signal(if want_auto_signal {
                        Signal::Auto
                    } else {
                        Signal::Voice
                    });
                }

                // Adaptive bitrate update from peer feedback + room upload budget (5-8 peers)
                let (max_loss, max_rtt, tx_targets, est_up) = shared
                    .transport
                    .read()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .map(|t| {
                        let roster = t.roster_snapshot();
                        let l = roster
                            .iter()
                            .filter(|r| r.in_voice)
                            .map(|r| r.loss_pct)
                            .fold(0.0f32, f32::max);
                        let rtt = roster
                            .iter()
                            .filter(|r| r.in_voice)
                            .filter_map(|r| r.rtt_ms)
                            .max()
                            .unwrap_or(0);
                        let (up, _, _) = t.relay_stats();
                        (l, rtt, t.tx_target_count(), up)
                    })
                    .unwrap_or((0.0, 0, 1, 2000));

                let room_cap = AdaptiveBitrateController::room_bitrate_cap_bps_for_mode(
                    tx_targets,
                    est_up,
                    want_auto_signal,
                );
                let low_bw =
                    tx_targets >= 5 && (room_cap <= 24_000 && est_up < (tx_targets as u32) * 40);
                if shared.low_bandwidth_warning.swap(low_bw, Ordering::Relaxed) != low_bw {
                    shared.emit_status_snapshot();
                }

                if abr.update_with_room_cap(max_loss, max_rtt, room_cap) {
                    let bps = abr.bitrate_bps();
                    let _ = encoder.set_bitrate(Bitrate::BitsPerSecond(bps));
                    let _ = encoder.set_inband_fec(abr.fec_enabled());
                    let _ =
                        encoder.set_packet_loss_perc(abr.expected_loss_pct().clamp(0, 100) as u8);
                    let kbps = (bps / 1000) as u32;
                    shared.bitrate_kbps.store(kbps, Ordering::Relaxed);
                    if let Some(ref tr) =
                        *shared.transport.read().unwrap_or_else(|e| e.into_inner())
                    {
                        tr.local_bitrate_kbps.store(kbps, Ordering::Relaxed);
                    }
                }

                if let Ok(n) = encoder.encode_float(&pcm20, &mut opus_out) {
                    let pkt_bytes = &opus_out[..n];
                    if shared.mic_test_loopback.load(Ordering::Acquire) {
                        if let (Ok(pkt), Ok(sig)) = (
                            OpusPacket::try_from(pkt_bytes),
                            MutSignals::try_from(&mut test_pcm_out),
                        ) {
                            if let Ok(dec_n) = test_decoder.decode_float(Some(pkt), sig, false) {
                                if let Some(ref tx) = *shared
                                    .test_loopback_tx
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                {
                                    let _ = tx.try_send(test_pcm_out[..dec_n].to_vec());
                                }
                            }
                        }
                    } else if shared.in_voice.load(Ordering::Acquire) {
                        if let Some(ref tr) =
                            *shared.transport.read().unwrap_or_else(|e| e.into_inner())
                        {
                            tr.send_voice_frame(seq, ts_48k, false, pkt_bytes);
                        }
                        seq = seq.wrapping_add(1);
                        ts_48k = ts_48k.wrapping_add(VOICE_FRAME_20MS as u32);
                    }
                }
            }

            if !is_open && eot_remaining > 0 && mono_48k_fifo.is_empty() {
                // Space 3x end-of-talk packets at 20 ms
                if encode_accum.is_empty() {
                    if shared.in_voice.load(Ordering::Acquire) {
                        if let Some(ref tr) =
                            *shared.transport.read().unwrap_or_else(|e| e.into_inner())
                        {
                            tr.send_voice_frame(seq, ts_48k, true, &[]);
                        }
                        seq = seq.wrapping_add(1);
                        ts_48k = ts_48k.wrapping_add(VOICE_FRAME_20MS as u32);
                    }
                    eot_remaining -= 1;
                }
            }

            if diag_active {
                if let Ok(guard) = shared.diag_capture_tx.try_lock() {
                    if let Some(ref tx) = *guard {
                        diag_aligner.drain_aligned(is_open, encode_accum.len(), |r, p| {
                            let _ = tx.try_send((r, p));
                        });
                    }
                }
            }

            let dsp_us = t_dsp0.elapsed().as_micros() as u64;
            shared.dsp_frame_count.fetch_add(1, Ordering::Relaxed);
            shared
                .dsp_total_frame_us
                .fetch_add(dsp_us, Ordering::Relaxed);
            shared.dsp_max_frame_us.fetch_max(dsp_us, Ordering::Relaxed);
            if dsp_us > 8_000 {
                shared.dsp_overrun_frames.fetch_add(1, Ordering::Relaxed);
            }
        }

        if !processed_any {
            if eot_remaining > 0 && shared.in_voice.load(Ordering::Acquire) {
                if let Some(ref tr) = *shared.transport.read().unwrap_or_else(|e| e.into_inner()) {
                    tr.send_voice_frame(seq, ts_48k, true, &[]);
                }
                seq = seq.wrapping_add(1);
                ts_48k = ts_48k.wrapping_add(VOICE_FRAME_20MS as u32);
                eot_remaining -= 1;
                sleeper.sleep(Duration::from_millis(16));
            } else {
                sleeper.sleep(Duration::from_millis(2));
            }
        }
    }
}

struct PeerDecoderState {
    username: String,
    jitter: PeerJitterBuffer,
    decoder: OpusDecoder,
    leveler: PeerRxLeveler,
    echo_sup: RxEchoSuppressor,
    last_speaking_at: Option<Instant>,
    is_speaking: bool,
}

fn run_mix_rx_thread(
    shared: Arc<SharedVoiceRuntime>,
    test_lb_rx: std::sync::mpsc::Receiver<Vec<f32>>,
) {
    unsafe {
        let _ = SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_HIGHEST);
    }
    let err_flag = Arc::new(AtomicBool::new(false));
    let _wasapi_notif = register_wasapi_flag_notifier(Arc::clone(&err_flag));
    let mut out_watchdog = StreamWatchdogState::new();
    let mut prev_out_cb_ms = 0u64;
    let mut active_out: Option<(cpal::Stream, ringbuf::HeapProd<f32>, u32)> = None;
    let mut out_resampler: Option<VoiceResamplerState> = None;
    let mut peers: HashMap<String, PeerDecoderState> = HashMap::new();
    let mut test_delay_queue: VecDeque<Vec<f32>> = VecDeque::with_capacity(24);
    let mut stereo_48k = vec![0.0f32; VOICE_FRAME_20MS * 2];
    let mut decoded_buf = vec![0.0f32; VOICE_FRAME_20MS];
    let mut last_transport_ptr: usize = 0;
    let mut lb_idle_ticks: u32 = 0;
    let mut last_speaking_set: Vec<String> = Vec::new();
    let mut last_speaking_emit = Instant::now();
    let mut last_dev_check = Instant::now();
    let mut last_telem_push = Instant::now();
    let mut last_comm_out: Option<String> = None;
    let mut last_duck_tick = Instant::now();
    let mut last_rx_notify_seq: u64 = 0;
    let sleeper = HighResSleeper::new();

    let mut next_tick = Instant::now() + Duration::from_millis(20);

    while !shared.stop_flag.load(Ordering::Acquire) {
        let cfg = shared
            .config
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let now_ms = shared.now_ms();

        if cfg.output_device == "default" && last_dev_check.elapsed() >= Duration::from_millis(1500)
        {
            last_dev_check = Instant::now();
            let (comm, _, _) = query_wasapi_metadata(Direction::Render);
            if let Some(ref c) = comm {
                if is_hfp_profile_name(c)
                    && !shared.bluetooth_hfp_dropped.swap(true, Ordering::Relaxed)
                {
                    shared.record_log(&format!("voice.bluetooth hfp profile detected: {c}"));
                    shared.emit_status_snapshot();
                }
            }
            if last_comm_out.is_some() && comm != last_comm_out {
                err_flag.store(true, Ordering::Release);
                shared.loopback_device_dirty.store(true, Ordering::Release);
            }
            last_comm_out = comm;
        }

        let latest_out_cb = shared.last_out_cb_ms.load(Ordering::Relaxed);
        if latest_out_cb != prev_out_cb_ms {
            prev_out_cb_ms = latest_out_cb;
            out_watchdog.record_callback(now_ms);
        } else if active_out.is_some() && out_watchdog.is_stalled(now_ms) {
            shared.record_log("voice.output watchdog stall (>1500ms); reopening output");
            err_flag.store(true, Ordering::Release);
        }

        if shared.output_device_dirty.swap(false, Ordering::AcqRel)
            || err_flag.swap(false, Ordering::AcqRel)
        {
            active_out = None;
            out_watchdog.on_stream_closed();
            out_resampler = None;
        }

        if active_out.is_none() && out_watchdog.can_attempt_open(now_ms) {
            match open_output_stream(
                &cfg.output_device,
                Arc::clone(&err_flag),
                Arc::clone(&shared),
            ) {
                Ok((stream, prod, rate, name, out_bt)) => {
                    out_watchdog.on_stream_opened(now_ms);
                    shared.active_output_is_bt.store(out_bt, Ordering::Relaxed);
                    if out_bt
                        && (rate <= 16_000 || is_hfp_profile_name(&name))
                        && !shared.bluetooth_hfp_dropped.swap(true, Ordering::Relaxed)
                    {
                        shared.emit_status_snapshot();
                    }
                    *shared
                        .active_output_name
                        .write()
                        .unwrap_or_else(|e| e.into_inner()) = Some(name);
                    if rate != VOICE_SAMPLE_RATE as u32 {
                        if let Ok(rs) = FastFixedIn::<f32>::new(
                            rate as f64 / VOICE_SAMPLE_RATE as f64,
                            1.0,
                            PolynomialDegree::Cubic,
                            VOICE_FRAME_20MS,
                            2,
                        ) {
                            let in_buf = vec![vec![0.0f32; VOICE_FRAME_20MS]; 2];
                            let out_buf = rs.output_buffer_allocate(true);
                            out_resampler = Some(VoiceResamplerState {
                                resampler: rs,
                                in_buf,
                                out_buf,
                            });
                        }
                    } else {
                        out_resampler = None;
                    }
                    active_out = Some((stream, prod, rate));
                }
                Err(msg) => {
                    let _ = out_watchdog.on_open_failure(now_ms);
                    shared.record_log(&format!("voice.output open error: {msg}"));
                }
            }
        }

        // Drain incoming network packets from the active P2P transport without consuming ownership
        let transport_opt = shared
            .transport
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(ref tr) = transport_opt {
            let ptr = Arc::as_ptr(tr) as usize;
            if ptr != last_transport_ptr {
                last_transport_ptr = ptr;
                peers.clear();
            }
            if shared.in_voice.load(Ordering::Acquire) {
                tr.drain_rx_packets(|pkt| {
                    if !peers.contains_key(&pkt.origin_key) && peers.len() >= 8 {
                        return; // Cap total decoders at 8
                    }
                    if !peers.contains_key(&pkt.origin_key) {
                        // Never panic here: release builds use panic = "abort".
                        let Ok(decoder) = OpusDecoder::new(SampleRate::Hz48000, Channels::Mono)
                        else {
                            return;
                        };
                        let mut jitter = PeerJitterBuffer::new();
                        jitter.set_min_target_frames(
                            if cfg.engine_mode == VoiceEngineModeWire::Aura {
                                2
                            } else {
                                1
                            },
                        );
                        peers.insert(
                            pkt.origin_key.clone(),
                            PeerDecoderState {
                                username: pkt.origin_username.clone(),
                                jitter,
                                decoder,
                                leveler: PeerRxLeveler::new(),
                                echo_sup: RxEchoSuppressor::new(),
                                last_speaking_at: None,
                                is_speaking: false,
                            },
                        );
                    }
                    if let Some(entry) = peers.get_mut(&pkt.origin_key) {
                        entry.jitter.push(
                            JitterPacket {
                                seq: pkt.seq,
                                epoch: pkt.epoch,
                                ts_48k: pkt.ts_48k,
                                end_of_talk: pkt.end_of_talk,
                                opus: pkt.opus,
                            },
                            pkt.arrival_ms,
                        );
                    }
                });
            } else {
                tr.clear_rx_packets();
                peers.clear();
            }
        } else {
            last_transport_ptr = 0;
            peers.clear();
        }

        // Handle Mic Test delayed loopback (~240 ms cushion, plus tail drain after short utterances)
        let mic_test = shared.mic_test_loopback.load(Ordering::Acquire);
        let mut received_lb = false;
        while let Ok(frame) = test_lb_rx.try_recv() {
            if mic_test {
                received_lb = true;
                test_delay_queue.push_back(frame);
                while test_delay_queue.len() > 24 {
                    test_delay_queue.pop_front();
                }
            }
        }
        if received_lb {
            lb_idle_ticks = 0;
        } else {
            lb_idle_ticks = lb_idle_ticks.saturating_add(1);
        }
        if !mic_test {
            test_delay_queue.clear();
            lb_idle_ticks = 0;
        }

        let deafened = shared.deafened.load(Ordering::Acquire);
        let overrides = shared
            .peer_overrides
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();

        let mut peer_pcm: Vec<(String, Vec<f32>, f32, f32)> = Vec::new();
        let mut active_speakers: Vec<String> = Vec::new();
        let mut loss_sum = 0.0f32;
        let mut jitter_sum = 0usize;
        let mut peer_cnt = 0usize;
        let mut underrun_sum = 0u64;

        // Prune stale peer decoders whenever P2P roster changes (including last peer leaving!)
        if let Some(ref tr) = *shared.transport.read().unwrap_or_else(|e| e.into_inner()) {
            let active_set: HashSet<String> = tr
                .roster_snapshot()
                .into_iter()
                .filter(|r| r.in_voice)
                .map(|r| r.username.to_ascii_lowercase())
                .collect();
            peers.retain(|k, _| active_set.contains(k));
        }

        let is_aura = cfg.engine_mode == VoiceEngineModeWire::Aura;
        let total_peers = peers.len().max(1);
        for (idx, (key, state)) in peers.iter_mut().enumerate() {
            state
                .jitter
                .set_min_target_frames(if is_aura { 2 } else { 1 });
            loss_sum += state.jitter.loss_pct();
            jitter_sum += state.jitter.target_delay_ms();
            peer_cnt += 1;

            let (pkt_opt, fec, plc) = state.jitter.pop_step();
            underrun_sum += state.jitter.underrun_count();
            let mut has_audio = false;
            if let Some(ref bytes) = pkt_opt {
                if let (Ok(pkt), Ok(sig)) = (
                    OpusPacket::try_from(bytes.as_slice()),
                    MutSignals::try_from(&mut decoded_buf),
                ) {
                    if state.decoder.decode_float(Some(pkt), sig, fec).is_ok() {
                        has_audio = true;
                    }
                }
            } else if plc {
                if let Ok(sig) = MutSignals::try_from(&mut decoded_buf) {
                    if state.decoder.decode_float(None, sig, false).is_ok() {
                        has_audio = true;
                    }
                }
            }

            let ov = overrides.get(key);
            let peer_muted = ov.is_some_and(|o| o.muted);

            if has_audio && !peer_muted && !deafened {
                // Remove our own voice coming back from this peer's speakers (works regardless of their app version).
                let own_env: Vec<f32> = shared
                    .own_tx_env
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .iter()
                    .copied()
                    .collect();
                state.echo_sup.process_20ms(&own_env, &mut decoded_buf);
                let db = frame_dbfs(&decoded_buf);
                if db > -52.0 {
                    state.last_speaking_at = Some(Instant::now());
                    state.is_speaking = true;
                }
            }
            if peer_muted
                || deafened
                || !state.jitter.is_active()
                || state
                    .last_speaking_at
                    .is_some_and(|t| t.elapsed() >= Duration::from_millis(80))
            {
                state.is_speaking = false;
            }
            if state.is_speaking {
                active_speakers.push(state.username.clone());
            }

            if has_audio && !deafened {
                if peer_muted {
                    continue;
                }
                state.leveler.process_in_place_with_plc(
                    &mut decoded_buf,
                    plc && pkt_opt.is_none(),
                    is_aura,
                );
                let master = cfg.master_volume.clamp(0.0, 2.0);
                let gain = (ov.map_or(1.0, |o| o.volume) * master).clamp(0.0, 2.0);
                let pan = if cfg.spatial_pan && total_peers > 1 {
                    let t = (idx as f32) / ((total_peers - 1) as f32);
                    (t * 2.0 - 1.0) * 0.15
                } else {
                    0.0
                };
                peer_pcm.push((key.clone(), decoded_buf.clone(), gain, pan));
            }
        }

        if peer_cnt > 0 {
            let avg_loss = loss_sum / (peer_cnt as f32);
            shared
                .avg_loss_x10
                .store((avg_loss * 10.0).round() as u32, Ordering::Relaxed);
            shared
                .avg_jitter_ms
                .store((jitter_sum / peer_cnt) as u32, Ordering::Relaxed);
            if let Some(ref tr) = *shared.transport.read().unwrap_or_else(|e| e.into_inner()) {
                tr.local_loss_pct_x10
                    .store((avg_loss * 10.0).round() as u16, Ordering::Relaxed);
                if last_telem_push.elapsed() >= Duration::from_millis(500) {
                    last_telem_push = Instant::now();
                    let metrics: Vec<(String, u32, f32)> = peers
                        .iter()
                        .map(|(k, st)| {
                            (
                                k.clone(),
                                st.jitter.target_delay_ms() as u32,
                                st.jitter.loss_pct(),
                            )
                        })
                        .collect();
                    tr.report_peer_rx_telemetry(metrics);
                }
            }
        } else {
            shared.avg_loss_x10.store(0, Ordering::Relaxed);
            shared.avg_jitter_ms.store(0, Ordering::Relaxed);
        }
        shared
            .rx_jitter_underruns
            .store(underrun_sum, Ordering::Relaxed);

        // Update movie ducking on remote speech (~20 ms cadence)
        shared.duck.set_remote_speaking(!active_speakers.is_empty());
        if last_duck_tick.elapsed() >= Duration::from_millis(18) {
            last_duck_tick = Instant::now();
            shared.duck.tick_20ms();
        }

        // Emit speaking roster when changed or every 250 ms
        active_speakers.sort();
        if active_speakers != last_speaking_set
            || last_speaking_emit.elapsed() >= Duration::from_millis(250)
        {
            last_speaking_set = active_speakers.clone();
            last_speaking_emit = Instant::now();
            if let Some(ref app) = *shared.app_handle.read().unwrap_or_else(|e| e.into_inner()) {
                let _ = app.emit("voice://speaking", &active_speakers);
            }
        }

        // Mix audio to playback ringbuf
        let mut test_frame: Option<Vec<f32>> = None;
        if mic_test
            && !test_delay_queue.is_empty()
            && (test_delay_queue.len() >= 12 || lb_idle_ticks >= 12)
        {
            if let Some(mut f) = test_delay_queue.pop_front() {
                for s in &mut f {
                    *s = soft_limit(*s, 0.5); // -6 dBFS safety cap
                }
                test_frame = Some(f);
            }
        }

        if !peer_pcm.is_empty() || test_frame.is_some() {
            let mut refs: Vec<(&[f32], f32, f32)> = peer_pcm
                .iter()
                .map(|(_, pcm, g, p)| (pcm.as_slice(), *g, *p))
                .collect();
            if let Some(ref tf) = test_frame {
                refs.push((tf.as_slice(), cfg.master_volume.clamp(0.25, 2.0), 0.0));
            }
            mix_mono_peers_to_stereo(&refs, &mut stereo_48k);

            // Push mono downmix into far-end echo reference (two 10 ms slices) + RMS
            let mut ref_sum_sq = 0.0f32;
            let mut f0 = [0.0f32; VOICE_FRAME_10MS];
            let mut f1 = [0.0f32; VOICE_FRAME_10MS];
            for (dst, ch) in f0
                .iter_mut()
                .zip(stereo_48k[..VOICE_FRAME_10MS * 2].chunks_exact(2))
            {
                let m = (ch[0] + ch[1]) * 0.5;
                *dst = m;
                ref_sum_sq += m * m;
            }
            for (dst, ch) in f1
                .iter_mut()
                .zip(stereo_48k[VOICE_FRAME_10MS * 2..].chunks_exact(2))
            {
                let m = (ch[0] + ch[1]) * 0.5;
                *dst = m;
                ref_sum_sq += m * m;
            }
            let far_rms = (ref_sum_sq / (VOICE_FRAME_20MS as f32)).sqrt();
            shared
                .far_end_rms_bits
                .store(far_rms.to_bits(), Ordering::Relaxed);
            {
                let mut q = shared
                    .far_end_ref_fifo
                    .lock()
                    .unwrap_or_else(|e| e.into_inner());
                while q.len() >= 6 {
                    q.pop_front();
                }
                q.push_back(f0);
                q.push_back(f1);
            }

            if let Some((_, ref mut prod, out_rate)) = active_out {
                let stereo_frame_samples = ((out_rate as usize) * 2 / 50).max(640);
                // Hard-cap output ringbuffer occupancy (<= 80 ms) so OS scheduling stalls cannot build lag
                if prod.occupied_len() <= stereo_frame_samples * 4 {
                    if let Some(ref mut rs_state) = out_resampler {
                        for i in 0..VOICE_FRAME_20MS {
                            rs_state.in_buf[0][i] = stereo_48k[i * 2];
                            rs_state.in_buf[1][i] = stereo_48k[i * 2 + 1];
                        }
                        if let Ok((_, out_n)) = rs_state.resampler.process_into_buffer(
                            &rs_state.in_buf,
                            &mut rs_state.out_buf,
                            None,
                        ) {
                            if prod.vacant_len() >= out_n * 2 {
                                for (&l, &r) in rs_state.out_buf[0]
                                    .iter()
                                    .zip(rs_state.out_buf[1].iter())
                                    .take(out_n)
                                {
                                    let _ = prod.try_push(l);
                                    let _ = prod.try_push(r);
                                }
                            }
                        }
                    } else if prod.vacant_len() >= stereo_48k.len() {
                        let _ = prod.push_slice(&stereo_48k);
                    }
                }
            }
        } else {
            shared
                .far_end_rms_bits
                .store(0.0f32.to_bits(), Ordering::Relaxed);
            // Keep fallback reference advancing continuously during silence so WebRTC AEC3 ref stays time-aligned
            let mut q = shared
                .far_end_ref_fifo
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            while q.len() >= 6 {
                q.pop_front();
            }
            q.push_back([0.0f32; VOICE_FRAME_10MS]);
            q.push_back([0.0f32; VOICE_FRAME_10MS]);
        }

        let pace_ms = if let Some((_, ref prod, out_rate)) = active_out {
            let stereo_frame_samples = ((out_rate as usize) * 2 / 50).max(640);
            compute_output_pacing_delay_ms(
                prod.occupied_len(),
                stereo_frame_samples,
                !peer_pcm.is_empty() || test_frame.is_some(),
            )
        } else {
            20
        };

        let any_peer_active = peers.values().any(|st| st.jitter.is_active());
        if !any_peer_active && !mic_test && test_delay_queue.is_empty() {
            let woke_on_pkt = if let Some(ref tr) = transport_opt {
                tr.wait_for_rx_packet(&mut last_rx_notify_seq, Duration::from_millis(20))
            } else {
                sleeper.sleep(Duration::from_millis(20));
                false
            };
            // Sync 20 ms playback cadence right after incoming talkspurt onset packet arrives
            next_tick = Instant::now() + Duration::from_millis(if woke_on_pkt { 21 } else { 20 });
            continue;
        }

        let now = Instant::now();
        if next_tick > now {
            sleeper.sleep(next_tick - now);
        } else {
            next_tick = now;
        }
        next_tick += Duration::from_millis(pace_ms as u64);
    }
}

fn is_key_combo_down(vk: i32, mods: u8) -> bool {
    if vk <= 0 {
        return false;
    }
    let key_down = unsafe { GetAsyncKeyState(vk) } < 0;
    if !key_down {
        return false;
    }
    if (mods & 1) != 0 && unsafe { GetAsyncKeyState(VK_CONTROL as i32) } >= 0 {
        return false;
    }
    if (mods & 2) != 0 && unsafe { GetAsyncKeyState(VK_MENU as i32) } >= 0 {
        return false;
    }
    if (mods & 4) != 0 && unsafe { GetAsyncKeyState(VK_SHIFT as i32) } >= 0 {
        return false;
    }
    true
}

fn run_hotkey_poller(shared: Arc<SharedVoiceRuntime>) {
    let mut prev_mute_down = false;
    let mut prev_deaf_down = false;
    let mut prev_ptt_held = false;

    while !shared.stop_flag.load(Ordering::Acquire) {
        if shared.in_voice.load(Ordering::Acquire) {
            let cfg = shared
                .config
                .read()
                .unwrap_or_else(|e| e.into_inner())
                .clone();
            let focus_ok = cfg.hotkey_scope != "focused" || is_epilod_foreground_window();
            if !focus_ok {
                shared.ptt_held.store(false, Ordering::Release);
                if prev_ptt_held {
                    prev_ptt_held = false;
                    shared.emit_local_state("ptt");
                }
                prev_mute_down = false;
                prev_deaf_down = false;
                std::thread::sleep(Duration::from_millis(16));
                continue;
            }

            let next_ptt = if cfg.input_mode == InputModeWire::Ptt && cfg.ptt_vk > 0 {
                is_key_combo_down(cfg.ptt_vk, cfg.ptt_mod)
            } else {
                false
            };
            shared.ptt_held.store(next_ptt, Ordering::Release);
            if next_ptt != prev_ptt_held {
                prev_ptt_held = next_ptt;
                shared.emit_local_state("ptt");
            }

            if cfg.mute_vk > 0 {
                let down = is_key_combo_down(cfg.mute_vk, cfg.mute_mod);
                if down && !prev_mute_down {
                    let next = !shared.muted.load(Ordering::Acquire);
                    shared.apply_mute_transition(next);
                    let epoch = shared.epoch.load(Ordering::Acquire);
                    if let Some(ref tr) =
                        *shared.transport.read().unwrap_or_else(|e| e.into_inner())
                    {
                        tr.notify_local_state(
                            true,
                            epoch,
                            shared.muted.load(Ordering::Acquire),
                            shared.deafened.load(Ordering::Acquire),
                            cfg.allow_relay_for_others,
                            cfg.allow_relayed_voice,
                        );
                    }
                    shared.emit_local_state("hotkey");
                }
                prev_mute_down = down;
            }

            if cfg.deafen_vk > 0 {
                let down = is_key_combo_down(cfg.deafen_vk, cfg.deafen_mod);
                if down && !prev_deaf_down {
                    let next = !shared.deafened.load(Ordering::Acquire);
                    shared.apply_deafen_transition(next);
                    let epoch = shared.epoch.load(Ordering::Acquire);
                    let muted = shared.muted.load(Ordering::Acquire);
                    let deafened = shared.deafened.load(Ordering::Acquire);
                    if let Some(ref tr) =
                        *shared.transport.read().unwrap_or_else(|e| e.into_inner())
                    {
                        tr.notify_local_state(
                            true,
                            epoch,
                            muted,
                            deafened,
                            cfg.allow_relay_for_others,
                            cfg.allow_relayed_voice,
                        );
                    }
                    shared.emit_local_state("hotkey");
                }
                prev_deaf_down = down;
            }
        } else {
            shared.ptt_held.store(false, Ordering::Release);
            prev_ptt_held = false;
            prev_mute_down = false;
            prev_deaf_down = false;
        }
        std::thread::sleep(Duration::from_millis(12));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bluetooth_detection_table_catches_real_device_names_and_wired_mics() {
        let cases = [
            ("Headphones (6- BT SPEAKER)", None, None, true),
            ("Headset (AirPods Pro Hands-Free)", None, None, true),
            ("Headset (WH-1000XM5 Hands-Free AG Audio)", None, None, true),
            ("Headphones (Galaxy Buds2 Pro)", Some("BthEnum"), None, true),
            (
                "Headphones (Jabra Link 380)",
                Some("Bluetooth Audio"),
                None,
                true,
            ),
            ("HFP Ear-Piece", None, Some("BthHfEnum"), true),
            ("Headphones (Realtek(R) Audio)", None, None, false),
            (
                "Microphone (PD200X Podcast Microphone)",
                Some("USB Audio"),
                Some("Microphone"),
                false,
            ),
            (
                "Microphone (Blue Yeti Stereo Microphone)",
                Some("Yeti"),
                None,
                false,
            ),
            ("Speakers (Focusrite USB Audio)", None, None, false),
            ("Line In (NVIDIA Broadcast)", None, None, false),
            (
                "Microphone Array (Intel Smart Sound Technology)",
                None,
                None,
                false,
            ),
        ];
        for (name, iface, desc, expected_bt) in cases {
            assert_eq!(
                is_bluetooth_name(name, iface, desc),
                expected_bt,
                "failed for {name}"
            );
        }
    }

    #[test]
    fn resolve_input_skips_bluetooth_when_wired_mic_exists() {
        let inputs = vec![
            VoiceDeviceDto {
                id: "Headset (AirPods Hands-Free)".to_string(),
                label: "Headset (AirPods Hands-Free)".to_string(),
                is_default_comm: true,
                is_default_console: false,
                is_bluetooth: true,
                sample_rate: 16_000,
                channels: 1,
            },
            VoiceDeviceDto {
                id: "Microphone (USB Mic)".to_string(),
                label: "Microphone (USB Mic)".to_string(),
                is_default_comm: false,
                is_default_console: true,
                is_bluetooth: false,
                sample_rate: 48_000,
                channels: 1,
            },
        ];
        let picked = resolve_input_device_choice("default", &inputs).unwrap();
        assert_eq!(picked.id, "Microphone (USB Mic)");
    }

    #[test]
    fn stream_watchdog_stall_backoff_and_error_classification() {
        let mut wd = StreamWatchdogState::new();
        wd.on_stream_opened(1_000);
        assert!(!wd.is_stalled(2_400));
        assert!(wd.is_stalled(2_500));

        assert_eq!(wd.on_open_failure(3_000), 0);
        assert!(wd.can_attempt_open(3_000));
        assert_eq!(wd.on_open_failure(3_000), 500);
        assert!(!wd.can_attempt_open(3_400));
        assert!(wd.can_attempt_open(3_500));
        assert_eq!(wd.on_open_failure(3_500), 1000);
        assert_eq!(wd.on_open_failure(5_000), 2000);
        assert_eq!(wd.on_open_failure(8_000), 5000);
        assert_eq!(wd.on_open_failure(14_000), 5000); // Capped at 5 s

        let (st_busy, denied_busy, msg_busy) = classify_audio_open_error(
            "Failed opening microphone: 0x8889000A AUDCLNT_E_DEVICE_IN_USE",
        );
        assert_eq!(st_busy, "micBusy");
        assert!(!denied_busy);
        assert!(msg_busy.contains("another app"));

        let (st_perm, denied_perm, _) = classify_audio_open_error("0x80070005 Access is denied");
        assert_eq!(st_perm, "permissionDenied");
        assert!(denied_perm);
    }

    #[test]
    fn hotkey_validator_blocks_plain_typing_keys_and_allows_combos() {
        assert!(validate_voice_hotkey_binding(0, 0).is_ok());
        assert!(validate_voice_hotkey_binding(0x56, 0).is_err()); // Plain 'V'
        assert!(validate_voice_hotkey_binding(0x20, 0).is_err()); // Plain Space
        assert!(validate_voice_hotkey_binding(0x31, 0).is_err()); // Plain '1'
        assert!(validate_voice_hotkey_binding(0x56, 1).is_ok()); // Ctrl+V
        assert!(validate_voice_hotkey_binding(0x77, 0).is_ok()); // F8
        assert!(validate_voice_hotkey_binding(0x05, 0).is_ok()); // Mouse XButton1
    }

    #[test]
    fn duck_controller_hysteresis_reassert_and_restore_work_across_mpv_hooks() {
        let mpv = Arc::new(MpvController::new());
        let reassert_hits = Arc::new(AtomicU32::new(0));
        let hits_clone = Arc::clone(&reassert_hits);
        mpv.set_volume_reassert_callback(Arc::new(move || {
            hits_clone.fetch_add(1, Ordering::Relaxed);
        }));

        let vc = VoiceController::new(Arc::clone(&mpv));
        let duck = vc.duck();
        assert_eq!(duck.set_user_volume(80.0), 80.0);
        duck.set_mode(DuckingModeWire::Subtle);
        duck.set_remote_speaking(true);
        for _ in 0..12 {
            duck.tick_20ms();
        }
        let f = duck.current_factor();
        assert!((f - 0.75).abs() < 0.03, "expected ~0.75, got {f}");

        // Hysteresis holds ducking briefly if remote speech flickers false immediately
        duck.set_remote_speaking(false);
        assert!(duck.is_remote_speaking());

        // Reassert keeps effective volume consistent across mpv events
        duck.reassert_effective_volume();
        let eff = duck.set_user_volume(100.0);
        assert!((eff - 75.0).abs() < 3.0, "expected ~75.0, got {eff}");

        // Leave & shutdown both restore full factor 1.0 cleanly
        vc.leave_voice();
        assert_eq!(duck.current_factor(), 1.0);
        duck.set_remote_speaking(true);
        for _ in 0..10 {
            duck.tick_20ms();
        }
        assert!(duck.current_factor() < 0.9);
        vc.shutdown();
        assert_eq!(duck.current_factor(), 1.0);
    }

    #[test]
    fn pre_deafen_mute_state_is_preserved_across_deafen_and_undeafen() {
        let mpv = Arc::new(MpvController::new());
        let vc = VoiceController::new(mpv);

        // Case 1: unmuted -> deafen -> undeafen keeps mic unmuted
        vc.set_mute(false);
        vc.set_deafen(true);
        assert!(vc.shared.muted.load(Ordering::Acquire));
        assert!(vc.shared.deafened.load(Ordering::Acquire));
        vc.set_deafen(false);
        assert!(!vc.shared.muted.load(Ordering::Acquire));
        assert!(!vc.shared.deafened.load(Ordering::Acquire));

        // Case 2: already muted -> deafen -> undeafen keeps mic muted
        vc.set_mute(true);
        vc.set_deafen(true);
        assert!(vc.shared.muted.load(Ordering::Acquire));
        assert!(vc.shared.deafened.load(Ordering::Acquire));
        vc.set_deafen(false);
        assert!(vc.shared.muted.load(Ordering::Acquire));
        assert!(!vc.shared.deafened.load(Ordering::Acquire));

        // Case 3: unmuting while deafened clears deafen and prior-mute flag
        vc.set_deafen(true);
        vc.set_mute(false);
        assert!(!vc.shared.muted.load(Ordering::Acquire));
        assert!(!vc.shared.deafened.load(Ordering::Acquire));
    }

    #[test]
    fn device_dirty_flags_reopen_input_and_output_independently() {
        let mpv = Arc::new(MpvController::new());
        let vc = VoiceController::new(mpv);

        // Changing output only must not clear output_device_dirty when input thread polls input_device_dirty
        vc.shared.mark_config_device_changes(false, true);
        assert!(!vc.shared.input_device_dirty.swap(false, Ordering::AcqRel));
        assert!(vc.shared.output_device_dirty.load(Ordering::Acquire));
        assert!(vc.shared.loopback_device_dirty.load(Ordering::Acquire));
        assert!(vc.shared.output_device_dirty.swap(false, Ordering::AcqRel));

        // Changing input only must set input_device_dirty without disturbing output
        vc.shared.mark_config_device_changes(true, false);
        assert!(vc.shared.input_device_dirty.swap(false, Ordering::AcqRel));
        assert!(!vc.shared.output_device_dirty.load(Ordering::Acquire));
    }

    #[test]
    fn sample_format_helpers_convert_i16_and_u16_streams_cleanly() {
        let rb_in = HeapRb::<f32>::new(64);
        let (mut prod_in, mut cons_in) = rb_in.split();
        let stereo_i16: [i16; 4] = [16384, -16384, 32767, 32767];
        push_pcm_to_mono_rb(&stereo_i16, 2, &mut prod_in, |s| (s as f32) / 32768.0);
        assert!((cons_in.try_pop().unwrap()).abs() < 0.01);
        assert!((cons_in.try_pop().unwrap() - 1.0).abs() < 0.01);

        let rb_u16 = HeapRb::<f32>::new(64);
        let (mut prod_u16, mut cons_u16) = rb_u16.split();
        let mono_u16: [u16; 2] = [32768, 49152];
        push_pcm_to_mono_rb(&mono_u16, 1, &mut prod_u16, |s| {
            ((s as f32) - 32768.0) / 32768.0
        });
        assert!((cons_u16.try_pop().unwrap()).abs() < 0.001);
        assert!((cons_u16.try_pop().unwrap() - 0.5).abs() < 0.001);

        let rb_out = HeapRb::<f32>::new(64);
        let (mut prod_out, mut cons_out) = rb_out.split();
        let _ = prod_out.try_push(0.5);
        let _ = prod_out.try_push(-0.5);
        let mut out_i16 = [0i16; 4];
        let mut last_l = 0.0;
        let mut last_r = 0.0;
        pop_stereo_from_rb(
            &mut out_i16,
            2,
            &mut cons_out,
            &mut last_l,
            &mut last_r,
            f32_to_i16,
        );
        assert!((out_i16[0] - 16383).abs() <= 2);
        assert!((out_i16[1] + 16383).abs() <= 2);
        assert!(out_i16[2] < out_i16[0]);
    }

    #[test]
    fn movie_loopback_reference_triggers_echo_detector_and_sets_delay_lag() {
        let mut det = SpeakerEchoDetector::new();
        let mut far_hist = Vec::new();
        // Simulate mpv movie dialogue playing out speakers even when peer voices are silent,
        // leaking back to open mic 60 ms (6 x 10 ms frames) later
        for t in 0..160usize {
            let far = if (t / 7) % 2 == 0 { 0.25 } else { 0.01 };
            far_hist.push(far);
            let near = if t >= 6 {
                far_hist[t - 6] * 0.55 + 0.005
            } else {
                0.005
            };
            det.push_10ms_rms(far, near);
        }
        assert!(det.detected(), "Movie loopback must flag speaker echo leak");
        assert!(
            (det.best_lag_frames() as i32 - 6).abs() <= 1,
            "Expected lag ~6 frames (60 ms), got {}",
            det.best_lag_frames()
        );
    }

    #[test]
    fn output_ringbuffer_pacing_absorbs_clock_skew() {
        let frame_samples = 1920usize; // 20 ms @ 48 kHz stereo
        let rb_cap = VOICE_SAMPLE_RATE * 2;

        // Simulate +/- 1040 ppm DAC clock skew (1918 vs 1922 stereo samples consumed per 20 ms)
        for dac_samples_per_20ms in [1918usize, 1922usize] {
            let mut occupied = frame_samples * 2;
            let mut underruns = 0usize;
            let mut overflows = 0usize;
            for _ in 0..1500usize {
                let pace_ms = compute_output_pacing_delay_ms(occupied, frame_samples, true);
                let consumed = (dac_samples_per_20ms * (pace_ms as usize)) / 20;
                if occupied < consumed {
                    underruns += 1;
                    occupied = 0;
                } else {
                    occupied -= consumed;
                }
                if occupied + frame_samples > rb_cap {
                    overflows += 1;
                } else {
                    occupied += frame_samples;
                }
            }
            assert_eq!(underruns, 0, "skew={dac_samples_per_20ms} underrun");
            assert_eq!(overflows, 0, "skew={dac_samples_per_20ms} overflow");
            assert!(
                occupied <= frame_samples * 2 + 128,
                "skew={dac_samples_per_20ms} held excessive cushion: {occupied}"
            );
        }
    }

    #[test]
    fn high_res_sleeper_respects_short_intervals() {
        let sleeper = HighResSleeper::new();
        let t0 = Instant::now();
        sleeper.sleep(Duration::from_millis(2));
        let elapsed = t0.elapsed();
        assert!(
            elapsed < Duration::from_millis(12),
            "2ms high-res sleep took too long: {elapsed:?}"
        );
    }

    #[test]
    fn opus_roundtrip_and_output_resampler_preserve_audio_energy() {
        let encoder =
            OpusEncoder::new(SampleRate::Hz48000, Channels::Mono, Application::Voip).unwrap();
        let mut decoder = OpusDecoder::new(SampleRate::Hz48000, Channels::Mono).unwrap();
        let mut opus_out = [0u8; MAX_VOICE_OPUS_BYTES];
        let mut decoded = vec![0.0f32; VOICE_FRAME_20MS];
        let mut stereo_48k = vec![0.0f32; VOICE_FRAME_20MS * 2];

        // Prime encoder/decoder with 5 frames of a clean 440 Hz vocal tone
        let mut max_out_rms = 0.0f32;
        for f_idx in 0..5usize {
            let mut pcm20 = [0.0f32; VOICE_FRAME_20MS];
            for (i, s) in pcm20.iter_mut().enumerate() {
                let t = ((f_idx * VOICE_FRAME_20MS + i) as f32) / (VOICE_SAMPLE_RATE as f32);
                *s = 0.35 * (2.0 * std::f32::consts::PI * 440.0 * t).sin();
            }
            let n = encoder.encode_float(&pcm20, &mut opus_out).unwrap();
            let pkt = OpusPacket::try_from(&opus_out[..n]).unwrap();
            let sig = MutSignals::try_from(&mut decoded).unwrap();
            let dec_n = decoder.decode_float(Some(pkt), sig, false).unwrap();
            assert_eq!(dec_n, VOICE_FRAME_20MS);
            mix_mono_peers_to_stereo(&[(&decoded, 1.0, 0.0)], &mut stereo_48k);
            let rms =
                (stereo_48k.iter().map(|s| s * s).sum::<f32>() / (stereo_48k.len() as f32)).sqrt();
            if rms > max_out_rms {
                max_out_rms = rms;
            }
        }
        assert!(
            max_out_rms > 0.15,
            "Opus roundtrip + stereo mixer must preserve audio energy; rms={max_out_rms}"
        );

        // Verify non-48 kHz Windows output resampler (44.1 kHz & 96 kHz)
        for rate in [44_100u32, 96_000u32] {
            let mut rs = FastFixedIn::<f32>::new(
                (rate as f64) / (VOICE_SAMPLE_RATE as f64),
                1.0,
                PolynomialDegree::Cubic,
                VOICE_FRAME_20MS,
                2,
            )
            .unwrap();
            let mut in_buf = vec![vec![0.0f32; VOICE_FRAME_20MS]; 2];
            for i in 0..VOICE_FRAME_20MS {
                in_buf[0][i] = stereo_48k[i * 2];
                in_buf[1][i] = stereo_48k[i * 2 + 1];
            }
            let mut out_buf = rs.output_buffer_allocate(true);
            let (_, out_n) = rs.process_into_buffer(&in_buf, &mut out_buf, None).unwrap();
            assert!(out_n > 0);
            let out_rms =
                (out_buf[0][..out_n].iter().map(|s| s * s).sum::<f32>() / (out_n as f32)).sqrt();
            assert!(
                out_rms > 0.05,
                "Output resampler rate={rate} must preserve energy; rms={out_rms}"
            );
        }

        // Verify I32 conversion path (f32 has 24 mantissa bits)
        assert!((f32_to_i32(0.5) - 1_073_741_824).abs() <= 2);
        assert!((f32_to_i32(-0.5) + 1_073_741_824).abs() <= 2);
    }

    #[test]
    fn windows_audio_output_smoke_when_device_present() {
        let _ = initialize_mta();
        let list = list_voice_devices("default", "default");
        if list.outputs.is_empty() {
            return;
        }
        let mpv = Arc::new(MpvController::new());
        let vc = VoiceController::new(mpv);
        let err_flag = Arc::new(AtomicBool::new(false));
        let opened = open_output_stream("default", err_flag, Arc::clone(&vc.shared));
        assert!(
            opened.is_ok(),
            "open_output_stream('default') failed on Windows host: {:?}",
            opened.err()
        );
        let (_stream, mut prod, rate, name, _) = opened.unwrap();
        let pushed = ((rate as usize) / 25).max(320) * 2;
        for _ in 0..pushed {
            let _ = prod.try_push(0.0);
        }
        std::thread::sleep(Duration::from_millis(250));
        let cb_ms = vc.shared.last_out_cb_ms.load(Ordering::Relaxed);
        let remaining = prod.occupied_len();
        assert!(
            cb_ms > 0,
            "CPAL output callback never fired for '{name}' (rate={rate})"
        );
        assert!(
            remaining < pushed,
            "CPAL output stream '{name}' did not consume samples from ringbuf (pushed={pushed}, remaining={remaining})"
        );
    }

    #[test]
    fn join_preserves_live_monitor_status_and_leave_clears_mute_deafen() {
        let mpv = Arc::new(MpvController::new());
        let vc = VoiceController::new(mpv);

        // Fresh join with no running workers sets "reconnecting" until stream opens
        vc.transition_stream_status_for_join();
        assert_eq!(
            *vc.shared.stream_status.read().unwrap(),
            "reconnecting".to_string()
        );

        // Simulate pre-join Mic Monitor already running and "live"
        *vc.worker_lock.lock().unwrap() = Some(WorkerHandles {
            dsp_thread: None,
            mix_thread: None,
            ptt_thread: None,
        });
        vc.shared.set_stream_status("live", None);
        vc.transition_stream_status_for_join();
        assert_eq!(*vc.shared.stream_status.read().unwrap(), "live".to_string());

        // Leaving voice resets muted, deafened, pre_deafen_muted, and ptt_held
        vc.set_deafen(true);
        vc.shared.ptt_held.store(true, Ordering::Release);
        vc.leave_voice();
        assert!(!vc.shared.muted.load(Ordering::Acquire));
        assert!(!vc.shared.deafened.load(Ordering::Acquire));
        assert!(!vc.shared.pre_deafen_muted.load(Ordering::Acquire));
        assert!(!vc.shared.ptt_held.load(Ordering::Acquire));
    }

    #[test]
    fn diag_capture_aligner_keeps_raw_and_processed_aligned_across_preroll_and_reopen() {
        let mut gate = VoiceGate::new();
        let mut comp = VoiceCompressor::new();
        let mut aligner = DiagCaptureAligner::new();
        let mut encode_accum: Vec<f32> = Vec::with_capacity(VOICE_FRAME_20MS * 2);
        let mut gate_out = [[0.0f32; VOICE_FRAME_10MS]; 3];

        // 180 x 10 ms frames: silence (0..30), tone 1 (30..60), silence (60..110), tone 2 (110..140), silence (140..180)
        let total_frames = 180usize;
        let mut raw_emitted = Vec::with_capacity(total_frames);
        let mut proc_emitted = Vec::with_capacity(total_frames);

        for f_idx in 0..total_frames {
            let mut raw = [0.0f32; VOICE_FRAME_10MS];
            let active = (30..60).contains(&f_idx) || (110..140).contains(&f_idx);
            if active {
                for (i, s) in raw.iter_mut().enumerate() {
                    let t = ((f_idx * VOICE_FRAME_10MS + i) as f32) / (VOICE_SAMPLE_RATE as f32);
                    *s = 0.25 * (2.0 * std::f32::consts::PI * 300.0 * t).sin();
                }
            }
            aligner.push_raw(&raw);

            let (out_cnt, is_open, _) =
                gate.process_10ms(&raw, 1.0, -38.0, false, None, false, &mut gate_out);
            for frame in gate_out.iter().take(out_cnt) {
                encode_accum.extend_from_slice(frame);
            }
            let mut padded_tail = false;
            if !is_open && !encode_accum.is_empty() && encode_accum.len() < VOICE_FRAME_20MS {
                encode_accum.resize(VOICE_FRAME_20MS, 0.0);
                padded_tail = true;
            }
            while encode_accum.len() >= VOICE_FRAME_20MS {
                let mut pcm20 = [0.0f32; VOICE_FRAME_20MS];
                pcm20.copy_from_slice(&encode_accum[..VOICE_FRAME_20MS]);
                encode_accum.drain(..VOICE_FRAME_20MS);
                comp.process_with_speech_prob(&mut pcm20, 1.0, true);
                aligner.push_compressed_20ms(&pcm20, padded_tail && encode_accum.is_empty());
            }

            aligner.drain_aligned(is_open, encode_accum.len(), |r, p| {
                raw_emitted.push(r);
                proc_emitted.push(p);
            });
        }

        assert_eq!(raw_emitted.len(), proc_emitted.len());
        assert!(
            raw_emitted.len() >= total_frames - 2,
            "at most 2 trailing silent pre-roll frames may remain held: got {}",
            raw_emitted.len()
        );

        let raw_active: Vec<usize> = raw_emitted
            .iter()
            .enumerate()
            .filter_map(|(i, f)| (frame_dbfs(f) > -40.0).then_some(i))
            .collect();
        let proc_active: Vec<usize> = proc_emitted
            .iter()
            .enumerate()
            .filter_map(|(i, f)| (frame_dbfs(f) > -40.0).then_some(i))
            .collect();

        assert!(!raw_active.is_empty() && !proc_active.is_empty());
        assert_eq!(
            raw_active[0], proc_active[0],
            "burst 1 onset misaligned between raw and processed"
        );
        let raw_b2 = raw_active.iter().copied().find(|&i| i >= 100).unwrap();
        let proc_b2 = proc_active.iter().copied().find(|&i| i >= 100).unwrap();
        assert_eq!(
            raw_b2, proc_b2,
            "burst 2 onset misaligned between raw and processed after gate reopen"
        );
    }

    #[test]
    fn aura_continuous_aec3_hmm_preserves_near_end_and_cancels_echo_tail() {
        let mut aec3_clean = WebRtcAec3Canceller::new();
        let zero_ref = [0.0f32; VOICE_FRAME_10MS];
        let mut near = [0.0f32; VOICE_FRAME_10MS];
        for (i, s) in near.iter_mut().enumerate() {
            let t = i as f32 / VOICE_SAMPLE_RATE as f32;
            *s = 0.25 * (2.0 * std::f32::consts::PI * 300.0 * t).sin();
        }
        let mut aec_out = [0.0f32; VOICE_FRAME_10MS];
        for _ in 0..10 {
            aec3_clean.process_10ms(&near, Some(&zero_ref), &mut aec_out);
        }
        assert!(
            (frame_dbfs(&aec_out) - frame_dbfs(&near)).abs() < 1.5,
            "Continuous HMM AEC3 with silent render must preserve near-end speech: in={:.2}, out={:.2}",
            frame_dbfs(&near),
            frame_dbfs(&aec_out)
        );

        // Converge AEC3 on a 20 ms delayed speech-like harmonic echo path, then cut far-end to zero and confirm the tail cancels
        let mut aec3_tail = WebRtcAec3Canceller::new();
        let delay_len = VOICE_FRAME_10MS * 2; // 20 ms tail
        let mut delay_ring = vec![0.0f32; delay_len];
        let mut ring_idx = 0usize;
        let mut far = [0.0f32; VOICE_FRAME_10MS];
        let mut mic = [0.0f32; VOICE_FRAME_10MS];
        for f_idx in 0..60 {
            for (i, s) in far.iter_mut().enumerate() {
                let t = ((f_idx * VOICE_FRAME_10MS + i) as f32) / (VOICE_SAMPLE_RATE as f32);
                *s = 0.35
                    * (0.6 * (2.0 * std::f32::consts::PI * 240.0 * t).sin()
                        + 0.4 * (2.0 * std::f32::consts::PI * 520.0 * t).sin());
            }
            for i in 0..VOICE_FRAME_10MS {
                let delayed = delay_ring[ring_idx];
                delay_ring[ring_idx] = far[i];
                ring_idx = (ring_idx + 1) % delay_len;
                mic[i] = delayed * 0.35;
            }
            aec3_tail.process_10ms(&mic, Some(&far), &mut aec_out);
        }

        // Far-end stops abruptly; remaining 20 ms echo tail arrives while far reference is zero
        let mut tail_in_pow = 0.0f64;
        let mut tail_out_pow = 0.0f64;
        for _ in 0..2 {
            for i in 0..VOICE_FRAME_10MS {
                let delayed = delay_ring[ring_idx];
                delay_ring[ring_idx] = 0.0;
                ring_idx = (ring_idx + 1) % delay_len;
                mic[i] = delayed * 0.35;
            }
            aec3_tail.process_10ms(&mic, Some(&zero_ref), &mut aec_out);
            for (&m, &o) in mic.iter().zip(aec_out.iter()) {
                tail_in_pow += (m as f64) * (m as f64);
                tail_out_pow += (o as f64) * (o as f64);
            }
        }
        let tail_erle_db = 10.0 * (tail_in_pow / tail_out_pow.max(1e-12)).log10();
        assert!(
            tail_erle_db >= 10.0,
            "Continuous AEC3 must cancel 20 ms room echo tail even after far-end drops to zero; got {tail_erle_db:.2} dB"
        );
    }

    #[test]
    fn webrtc_aec3_cancels_far_end_echo_even_with_headset_crosstalk() {
        let mut aec3 = WebRtcAec3Canceller::new();
        let mut far = [0.0f32; VOICE_FRAME_10MS];
        let mut near_echo_only = [0.0f32; VOICE_FRAME_10MS];
        let mut out = [0.0f32; VOICE_FRAME_10MS];

        // Feed 60 frames (600ms) of far-end peer speech-like harmonic + acoustic echo (20ms delayed, 0.35x gain)
        let mut delay_ring = vec![0.0f32; VOICE_FRAME_10MS * 2];
        let mut ring_idx = 0usize;
        let mut last_out_db = 0.0f32;
        let mut echo_in_db = -90.0f32;
        for f_idx in 0..60 {
            for (i, s) in far.iter_mut().enumerate() {
                let t = ((f_idx * VOICE_FRAME_10MS + i) as f32) / (VOICE_SAMPLE_RATE as f32);
                *s = 0.35
                    * (0.6 * (2.0 * std::f32::consts::PI * 240.0 * t).sin()
                        + 0.4 * (2.0 * std::f32::consts::PI * 520.0 * t).sin());
            }
            for i in 0..VOICE_FRAME_10MS {
                let delayed = delay_ring[ring_idx];
                delay_ring[ring_idx] = far[i];
                ring_idx = (ring_idx + 1) % delay_ring.len();
                near_echo_only[i] = delayed * 0.35;
            }
            aec3.process_10ms(&near_echo_only, Some(&far), &mut out);
            if f_idx >= 45 {
                echo_in_db = frame_dbfs(&near_echo_only);
                last_out_db = frame_dbfs(&out);
            }
        }
        assert!(
            echo_in_db - last_out_db >= 12.0,
            "AEC3 must strongly attenuate leaked peer echo: in={echo_in_db:.1} dBFS, out={last_out_db:.1} dBFS"
        );
    }
}
