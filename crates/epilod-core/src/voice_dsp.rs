use std::collections::{BTreeMap, VecDeque};
use std::time::Duration;

use dfn3_rs::{Denoiser as Dfn3Denoiser, Model as Dfn3Model, WEIGHTS_SIZE as DFN3_WEIGHTS_SIZE};

#[repr(C, align(64))]
struct AlignedAuraWeights([u8; DFN3_WEIGHTS_SIZE]);

static EPILOD_AURA_WEIGHTS: AlignedAuraWeights =
    AlignedAuraWeights(*include_bytes!("../weights/epilod_aura.bin"));
use sonora::config::{
    AdaptiveDigital as SonoraAdaptiveDigitalConfig, EchoCanceller as SonoraEchoCancellerConfig,
    FixedDigital as SonoraFixedDigitalConfig, GainController2 as SonoraGainController2Config,
    MaxProcessingRate as SonoraMaxProcessingRate,
    NoiseSuppression as SonoraNoiseSuppressionConfig,
    NoiseSuppressionLevel as SonoraNoiseSuppressionLevel, Pipeline as SonoraPipelineConfig,
};
use sonora::{AudioProcessing, Config as SonoraConfig, StreamConfig as SonoraStreamConfig};
use sonora_agc2::vad_wrapper::VoiceActivityDetectorWrapper;

pub const VOICE_SAMPLE_RATE: usize = 48_000;
pub const VOICE_FRAME_10MS: usize = 480;
pub const VOICE_FRAME_20MS: usize = 960;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoiseSuppressionMode {
    Off,
    Balanced,
    Strong,
}

/// 2nd-order Butterworth high-pass filter (80 Hz @ 48 kHz) to remove rumble/plosives.
#[derive(Debug, Clone)]
pub struct BiquadHighPass {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl BiquadHighPass {
    pub fn new_80hz_48k() -> Self {
        Self::new(
            80.0,
            VOICE_SAMPLE_RATE as f32,
            std::f32::consts::FRAC_1_SQRT_2,
        )
    }

    pub fn new(cutoff_hz: f32, sample_rate_hz: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * cutoff_hz / sample_rate_hz;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        let b0 = ((1.0 + cos_w0) * 0.5) / a0;
        let b1 = (-(1.0 + cos_w0)) / a0;
        let b2 = ((1.0 + cos_w0) * 0.5) / a0;
        let a1 = (-2.0 * cos_w0) / a0;
        let a2 = (1.0 - alpha) / a0;
        Self {
            b0,
            b1,
            b2,
            a1,
            a2,
            z1: 0.0,
            z2: 0.0,
        }
    }

    pub fn process_in_place(&mut self, samples: &mut [f32]) {
        for x in samples.iter_mut() {
            let input = *x;
            let y = self.b0 * input + self.z1;
            self.z1 = self.b1 * input - self.a1 * y + self.z2;
            self.z2 = self.b2 * input - self.a2 * y;
            *x = y;
        }
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// Transposed Direct-Form II peaking EQ biquad for transparent studio vocal shaping.
#[derive(Debug, Clone)]
pub struct BiquadPeakingEq {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl BiquadPeakingEq {
    pub fn new(freq_hz: f32, q: f32, gain_db: f32, sample_rate_hz: f32) -> Self {
        let a = 10.0f32.powf(gain_db / 40.0);
        let w0 = 2.0 * std::f32::consts::PI * freq_hz / sample_rate_hz;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha / a;
        Self {
            b0: (1.0 + alpha * a) / a0,
            b1: (-2.0 * cos_w0) / a0,
            b2: (1.0 - alpha * a) / a0,
            a1: (-2.0 * cos_w0) / a0,
            a2: (1.0 - alpha / a) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    pub fn process_sample(&mut self, input: f32) -> f32 {
        let y = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * y + self.z2;
        self.z2 = self.b2 * input - self.a2 * y;
        y
    }

    pub fn reset(&mut self) {
        self.z1 = 0.0;
        self.z2 = 0.0;
    }
}

/// Optional echo cancellation trait so v1.1 can drop in WASAPI loopback AEC3/SpeexDSP cleanly.
pub trait EchoCanceller: Send {
    fn process_10ms(
        &mut self,
        mic_48k: &[f32; VOICE_FRAME_10MS],
        ref_48k: Option<&[f32; VOICE_FRAME_10MS]>,
        out_48k: &mut [f32; VOICE_FRAME_10MS],
    );
    fn reset(&mut self);
}

#[derive(Debug, Default)]
pub struct NoopEchoCanceller;

impl EchoCanceller for NoopEchoCanceller {
    fn process_10ms(
        &mut self,
        mic_48k: &[f32; VOICE_FRAME_10MS],
        _ref_48k: Option<&[f32; VOICE_FRAME_10MS]>,
        out_48k: &mut [f32; VOICE_FRAME_10MS],
    ) {
        out_48k.copy_from_slice(mic_48k);
    }

    fn reset(&mut self) {}
}

/// Pure-Rust adaptive Normalized LMS acoustic echo canceller (48 kHz mono, 1024 taps ≈ 21.3 ms tail)
/// with coarse delay alignment (0..=160 ms) so hardware render/capture buffering stays inside the filter window.
pub struct AdaptiveNlmsEchoCanceller {
    ref_hist: [f32; Self::TAPS],
    weights: [f32; Self::TAPS],
    head: usize,
    mu: f32,
    delay_ring: VecDeque<[f32; VOICE_FRAME_10MS]>,
    delay_frames: usize,
}

impl Default for AdaptiveNlmsEchoCanceller {
    fn default() -> Self {
        Self::new()
    }
}

impl AdaptiveNlmsEchoCanceller {
    pub const TAPS: usize = 1024;
    pub const MAX_DELAY_FRAMES: usize = 16;
    const EPS: f32 = 1e-4;

    pub fn new() -> Self {
        Self {
            ref_hist: [0.0; Self::TAPS],
            weights: [0.0; Self::TAPS],
            head: 0,
            mu: 0.45,
            delay_ring: VecDeque::with_capacity(Self::MAX_DELAY_FRAMES + 4),
            delay_frames: 0,
        }
    }

    /// Sets the coarse bulk delay in 10 ms frames so `TAPS` centers on the active room echo peak.
    pub fn set_delay_frames(&mut self, frames: usize) {
        let clamped = frames.min(Self::MAX_DELAY_FRAMES);
        if self.delay_frames != clamped {
            self.delay_frames = clamped;
            // Re-center weights gently on coarse shift rather than diverging on an old lag
            self.weights.fill(0.0);
        }
    }

    pub fn delay_frames(&self) -> usize {
        self.delay_frames
    }
}

impl EchoCanceller for AdaptiveNlmsEchoCanceller {
    fn process_10ms(
        &mut self,
        mic_48k: &[f32; VOICE_FRAME_10MS],
        ref_48k: Option<&[f32; VOICE_FRAME_10MS]>,
        out_48k: &mut [f32; VOICE_FRAME_10MS],
    ) {
        let Some(far_now) = ref_48k else {
            out_48k.copy_from_slice(mic_48k);
            return;
        };

        while self.delay_ring.len() >= Self::MAX_DELAY_FRAMES + 4 {
            self.delay_ring.pop_front();
        }
        self.delay_ring.push_back(*far_now);
        let far = if self.delay_frames > 0 {
            self.delay_ring
                .len()
                .checked_sub(1 + self.delay_frames)
                .map_or([0.0; VOICE_FRAME_10MS], |i| self.delay_ring[i])
        } else {
            *far_now
        };

        for idx in 0..VOICE_FRAME_10MS {
            self.head = if self.head == 0 {
                Self::TAPS - 1
            } else {
                self.head - 1
            };
            self.ref_hist[self.head] = far[idx];

            // Split slice into [head..] and [..head] so inner loops optimize cleanly without modulo
            let first_len = Self::TAPS - self.head;
            let (w_first, w_second) = self.weights.split_at(first_len);
            let r_first = &self.ref_hist[self.head..];
            let r_second = &self.ref_hist[..self.head];

            let mut y_hat = 0.0f32;
            let mut power = Self::EPS;
            for (&w, &r) in w_first.iter().zip(r_first.iter()) {
                y_hat += w * r;
                power += r * r;
            }
            for (&w, &r) in w_second.iter().zip(r_second.iter()) {
                y_hat += w * r;
                power += r * r;
            }

            let err = mic_48k[idx] - y_hat;
            out_48k[idx] = err.clamp(-1.0, 1.0);

            // Simple double-talk guard: slow adaptation when near-end dwarfs estimated echo
            let ref_rms_ok = power > 1e-3;
            if ref_rms_ok {
                let dtd_scale = if err.abs() > y_hat.abs() * 2.5 + 0.08 {
                    0.15
                } else {
                    1.0
                };
                let step = (self.mu * dtd_scale * err) / power;
                let (wf, ws) = self.weights.split_at_mut(first_len);
                for (w, &r) in wf.iter_mut().zip(r_first.iter()) {
                    *w = (*w + step * r).clamp(-2.0, 2.0);
                }
                for (w, &r) in ws.iter_mut().zip(r_second.iter()) {
                    *w = (*w + step * r).clamp(-2.0, 2.0);
                }
            }
        }
    }

    fn reset(&mut self) {
        self.ref_hist.fill(0.0);
        self.weights.fill(0.0);
        self.head = 0;
        self.delay_ring.clear();
    }
}

/// WebRTC AEC3 acoustic echo canceller backed by pure-Rust `sonora` (48 kHz mono, 10 ms frames).
pub struct WebRtcAec3Canceller {
    apm: AudioProcessing,
    render_scratch: [f32; VOICE_FRAME_10MS],
}

impl Default for WebRtcAec3Canceller {
    fn default() -> Self {
        Self::new()
    }
}

impl WebRtcAec3Canceller {
    fn build_apm() -> AudioProcessing {
        let cfg = SonoraConfig {
            echo_canceller: Some(SonoraEchoCancellerConfig::default()),
            ..Default::default()
        };
        let stream_cfg = SonoraStreamConfig::new(VOICE_SAMPLE_RATE as u32, 1);
        AudioProcessing::builder()
            .config(cfg)
            .capture_config(stream_cfg)
            .render_config(stream_cfg)
            .build()
    }

    pub fn new() -> Self {
        Self {
            apm: Self::build_apm(),
            render_scratch: [0.0; VOICE_FRAME_10MS],
        }
    }

    /// Supplies estimated render-to-capture delay in milliseconds (`[0, 500]`).
    pub fn set_delay_ms(&mut self, delay_ms: i32) {
        let _ = self.apm.set_stream_delay_ms(delay_ms.clamp(0, 500));
    }
}

impl EchoCanceller for WebRtcAec3Canceller {
    fn process_10ms(
        &mut self,
        mic_48k: &[f32; VOICE_FRAME_10MS],
        ref_48k: Option<&[f32; VOICE_FRAME_10MS]>,
        out_48k: &mut [f32; VOICE_FRAME_10MS],
    ) {
        if let Some(far) = ref_48k {
            let _ = self
                .apm
                .process_render_f32(&[far.as_slice()], &mut [&mut self.render_scratch[..]]);
        }
        if self
            .apm
            .process_capture_f32(&[mic_48k.as_slice()], &mut [&mut out_48k[..]])
            .is_err()
        {
            out_48k.copy_from_slice(mic_48k);
        }
    }

    fn reset(&mut self) {
        self.apm = Self::build_apm();
        self.render_scratch.fill(0.0);
    }
}

/// WebRTC AGC2 adaptive digital gain controller + saturation protector + limiter backed by
/// pure-Rust `sonora` (48 kHz mono, 10 ms frames).
///
/// Lifts quiet/distant laptop microphones up to +32 dB during speech while refusing to amplify
/// background noise (`max_output_noise_level_dbfs = -52 dBFS`) and smoothly taming close-up peaks.
#[derive(Debug, Clone, Copy)]
pub struct WebRtcAgc2Params {
    pub headroom_db: f32,
    pub max_gain_db: f32,
    pub initial_gain_db: f32,
    pub max_gain_change_db_per_second: f32,
    pub max_output_noise_level_dbfs: f32,
    pub fixed_gain_db: f32,
}

impl Default for WebRtcAgc2Params {
    fn default() -> Self {
        Self {
            headroom_db: 4.0,
            max_gain_db: 34.0,
            initial_gain_db: 15.0,
            max_gain_change_db_per_second: 12.0,
            max_output_noise_level_dbfs: -52.0,
            fixed_gain_db: 4.0,
        }
    }
}

impl WebRtcAgc2Params {
    /// Aura preset: bounded +14 dB leveling (+4 dB startup, 0 dB fixed), 8 dB/s response, and -52 dBFS noise floor cap.
    pub fn aura() -> Self {
        Self {
            headroom_db: 9.0,
            max_gain_db: 14.0,
            initial_gain_db: 4.0,
            max_gain_change_db_per_second: 8.0,
            max_output_noise_level_dbfs: -52.0,
            fixed_gain_db: 0.0,
        }
    }
}

pub struct WebRtcAgc2Leveler {
    apm: AudioProcessing,
    params: WebRtcAgc2Params,
    in_scratch: [f32; VOICE_FRAME_10MS],
}

impl Default for WebRtcAgc2Leveler {
    fn default() -> Self {
        Self::new()
    }
}

impl WebRtcAgc2Leveler {
    fn build_apm(params: WebRtcAgc2Params) -> AudioProcessing {
        let cfg = SonoraConfig {
            pipeline: SonoraPipelineConfig {
                maximum_internal_processing_rate: SonoraMaxProcessingRate::Rate48kHz,
                multi_channel_render: false,
                multi_channel_capture: false,
                ..Default::default()
            },
            gain_controller2: Some(SonoraGainController2Config {
                input_volume_controller: false,
                adaptive_digital: Some(SonoraAdaptiveDigitalConfig {
                    headroom_db: params.headroom_db,
                    max_gain_db: params.max_gain_db,
                    initial_gain_db: params.initial_gain_db,
                    max_gain_change_db_per_second: params.max_gain_change_db_per_second,
                    max_output_noise_level_dbfs: params.max_output_noise_level_dbfs,
                }),
                fixed_digital: SonoraFixedDigitalConfig {
                    gain_db: params.fixed_gain_db,
                },
            }),
            ..Default::default()
        };
        let stream_cfg = SonoraStreamConfig::new(VOICE_SAMPLE_RATE as u32, 1);
        AudioProcessing::builder()
            .config(cfg)
            .capture_config(stream_cfg)
            .render_config(stream_cfg)
            .build()
    }

    pub fn new() -> Self {
        Self::with_params(WebRtcAgc2Params::default())
    }

    pub fn with_params(params: WebRtcAgc2Params) -> Self {
        Self {
            apm: Self::build_apm(params),
            params,
            in_scratch: [0.0; VOICE_FRAME_10MS],
        }
    }

    pub fn reset(&mut self) {
        self.apm = Self::build_apm(self.params);
        self.in_scratch.fill(0.0);
    }

    /// Processes a 10 ms 48 kHz mono frame in `[-1.0, 1.0]`.
    pub fn process_10ms(
        &mut self,
        input: &[f32; VOICE_FRAME_10MS],
        out: &mut [f32; VOICE_FRAME_10MS],
        enabled: bool,
    ) {
        if !enabled {
            out.copy_from_slice(input);
            return;
        }
        for (dst, &src) in self.in_scratch.iter_mut().zip(input.iter()) {
            *dst = if src.is_finite() {
                src.clamp(-1.0, 1.0)
            } else {
                0.0
            };
        }
        if self
            .apm
            .process_capture_f32(&[self.in_scratch.as_slice()], &mut [&mut out[..]])
            .is_err()
        {
            out.copy_from_slice(&self.in_scratch);
            return;
        }
        for s in out.iter_mut() {
            if !s.is_finite() {
                *s = 0.0;
            } else {
                *s = s.clamp(-0.98, 0.98);
            }
        }
    }
}

/// Detects speaker-to-mic acoustic leak by correlating 10 ms RMS envelopes across 0..160 ms lags.
#[derive(Debug, Clone)]
pub struct SpeakerEchoDetector {
    far_env: [f32; Self::WIN],
    near_env: [f32; Self::WIN],
    write_idx: usize,
    filled: usize,
    active_ticks: usize,
    detected: bool,
    last_corr: f32,
    best_lag_frames: usize,
}

impl Default for SpeakerEchoDetector {
    fn default() -> Self {
        Self::new()
    }
}

impl SpeakerEchoDetector {
    const WIN: usize = 80; // 800 ms envelope history @ 10 ms
    const MAX_LAG: usize = 16; // 160 ms acoustic delay window

    pub fn new() -> Self {
        Self {
            far_env: [0.0; Self::WIN],
            near_env: [0.0; Self::WIN],
            write_idx: 0,
            filled: 0,
            active_ticks: 0,
            detected: false,
            last_corr: 0.0,
            best_lag_frames: 0,
        }
    }

    pub fn reset(&mut self) {
        self.far_env.fill(0.0);
        self.near_env.fill(0.0);
        self.write_idx = 0;
        self.filled = 0;
        self.active_ticks = 0;
        self.detected = false;
        self.last_corr = 0.0;
        self.best_lag_frames = 0;
    }

    pub fn detected(&self) -> bool {
        self.detected
    }

    pub fn peak_correlation(&self) -> f32 {
        self.last_corr
    }

    pub fn best_lag_frames(&self) -> usize {
        self.best_lag_frames
    }

    /// Feed synchronous 10 ms playback reference RMS and captured mic RMS.
    pub fn push_10ms_rms(&mut self, far_rms: f32, near_rms: f32) -> bool {
        self.far_env[self.write_idx] = far_rms;
        self.near_env[self.write_idx] = near_rms;
        self.write_idx = (self.write_idx + 1) % Self::WIN;
        if self.filled < Self::WIN {
            self.filled += 1;
            return self.detected;
        }
        if !self.write_idx.is_multiple_of(10) {
            return self.detected;
        }

        // Reconstruct oldest->newest views for clean mean-removed Pearson correlation
        let mut far = [0.0f32; Self::WIN];
        let mut near = [0.0f32; Self::WIN];
        for i in 0..Self::WIN {
            let idx = (self.write_idx + i) % Self::WIN;
            far[i] = self.far_env[idx];
            near[i] = self.near_env[idx];
        }

        let eval_len = Self::WIN - Self::MAX_LAG;
        let near_slice = &near[Self::MAX_LAG..];
        let near_mean = near_slice.iter().sum::<f32>() / eval_len as f32;
        let mut near_var = 0.0f32;
        for &v in near_slice {
            let d = v - near_mean;
            near_var += d * d;
        }
        if near_var < 1e-6 {
            self.last_corr = 0.0;
            return self.detected;
        }

        let mut best_corr = 0.0f32;
        let mut best_lag = 0usize;
        for lag in 1..=Self::MAX_LAG {
            let start = Self::MAX_LAG - lag;
            let far_slice = &far[start..start + eval_len];
            let far_mean = far_slice.iter().sum::<f32>() / eval_len as f32;
            let mut far_var = 0.0f32;
            let mut cov = 0.0f32;
            for (&f, &n) in far_slice.iter().zip(near_slice.iter()) {
                let df = f - far_mean;
                let dn = n - near_mean;
                far_var += df * df;
                cov += df * dn;
            }
            if far_var >= 1e-5 {
                let corr = cov / (far_var * near_var).sqrt();
                if corr > best_corr {
                    best_corr = corr;
                    best_lag = lag;
                }
            }
        }
        self.last_corr = best_corr;
        if best_corr >= 0.50 {
            self.best_lag_frames = best_lag;
        }
        if best_corr >= 0.72 {
            self.active_ticks = (self.active_ticks + 1).min(8);
            if self.active_ticks >= 4 {
                self.detected = true;
            }
        } else {
            self.active_ticks = self.active_ticks.saturating_sub(2);
            if self.active_ticks == 0 {
                self.detected = false;
            }
        }
        self.detected
    }
}

/// 3-second quiet-then-speak calibrator computing an optimal gate threshold.
#[derive(Debug, Clone, Default)]
pub struct VoiceCalibrator {
    quiet_dbs: Vec<f32>,
    speak_dbs: Vec<f32>,
}

impl VoiceCalibrator {
    pub fn push_quiet_db(&mut self, db: f32) {
        if db.is_finite() {
            self.quiet_dbs.push(db.clamp(-90.0, 0.0));
        }
    }

    pub fn push_speak_db(&mut self, db: f32) {
        if db.is_finite() {
            self.speak_dbs.push(db.clamp(-90.0, 0.0));
        }
    }

    /// Returns `(noise_floor_db, speech_peak_db, recommended_threshold_db)`.
    pub fn finalize(&self) -> (f32, f32, f32) {
        let mut quiet = self.quiet_dbs.clone();
        quiet.sort_by(|a, b| a.total_cmp(b));
        let noise_floor = if quiet.is_empty() {
            -60.0
        } else {
            quiet[((quiet.len() * 75) / 100).min(quiet.len() - 1)]
        };

        let mut speak = self.speak_dbs.clone();
        speak.sort_by(|a, b| a.total_cmp(b));
        let speech_level = if speak.is_empty() {
            noise_floor + 14.0
        } else {
            speak[((speak.len() * 80) / 100).min(speak.len() - 1)]
        };

        let spread = (speech_level - noise_floor).max(6.0);
        let recommended = (noise_floor + spread * 0.35)
            .max(noise_floor + 4.0)
            .clamp(-65.0, -18.0);
        (noise_floor, speech_level, recommended.round())
    }
}

/// Ablation toggles for isolating VoiceDenoiser wrapper stages in `epilod_voice_lab`.
/// All stages default to `true` so live runtime behavior is unchanged.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VoiceDenoiserOptions {
    pub stage_a: bool,
    pub pre_gain: bool,
    pub stage_c: bool,
}

impl Default for VoiceDenoiserOptions {
    fn default() -> Self {
        Self {
            stage_a: true,
            pre_gain: true,
            stage_c: true,
        }
    }
}

impl VoiceDenoiserOptions {
    pub const BARE: Self = Self {
        stage_a: false,
        pre_gain: false,
        stage_c: false,
    };
}

/// Local DeepFilterNet3 + WebRTC 24 kHz RNN-VAD wrapper:
/// - Stage A: 2.5 ms sub-frame transient de-clicker (rejects sharp keyboard/mouse clicks pre-denoiser)
/// - Stage B: Quiet-mic pre-leveled 48 kHz DeepFilterNet3 neural core (32 dB Balanced / 60 dB Strong)
/// - Stage C: WebRTC 24 kHz Neural RNN-VAD fused with DFN3 LSNR + gentle silence-only floor smoother
pub struct VoiceDenoiser {
    dfn: Dfn3Denoiser,
    aura_post_ns: Option<AudioProcessing>,
    rnn_vad: VoiceActivityDetectorWrapper,
    options: VoiceDenoiserOptions,
    aura_mode: bool,
    last_mode: NoiseSuppressionMode,
    stage_a_buf: [f32; VOICE_FRAME_10MS],
    in_scaled: [f32; VOICE_FRAME_10MS],
    out_scaled: [f32; VOICE_FRAME_10MS],
    post_ns_scratch: [f32; VOICE_FRAME_10MS],
    vad_pcm_buf: [f32; VOICE_FRAME_10MS],
    speech_rms_env: f32,
    noise_rms_env: f32,
    prob_smooth: f32,
    hangover_frames: u8,
    post_gain_smooth: f32,
    prev_sub_rms: f32,
}

impl Default for VoiceDenoiser {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceDenoiser {
    const SPEECH_HANGOVER_FRAMES: u8 = 24; // 240 ms tail protection against word-end clipping
    const TARGET_INPUT_RMS: f32 = 0.075; // ~ -22.5 dBFS pre-leveling sweet spot for distant laptop mics
    const MAX_PRE_GAIN: f32 = 4.0; // +12 dB SNR-guarded lift for quiet mics without amplifying loud fans
    const SUBFRAME_LEN: usize = 120; // 2.5 ms @ 48 kHz
    const BALANCED_ATTEN_LIMIT_DB: f32 = 28.0;
    const STRONG_ATTEN_LIMIT_DB: f32 = 45.0; // Deep Krisp-class neural suppression while preserving low-SNR speech
    const AURA_BALANCED_ATTEN_LIMIT_DB: f32 = 38.0;
    const AURA_STRONG_ATTEN_LIMIT_DB: f32 = 52.0;

    pub fn new() -> Self {
        Self::with_options(VoiceDenoiserOptions::default())
    }

    pub fn new_aura() -> Self {
        Self::with_options_and_aura(VoiceDenoiserOptions::default(), true)
    }

    pub fn with_options(options: VoiceDenoiserOptions) -> Self {
        Self::with_options_and_aura(options, false)
    }

    fn aura_post_ns_config(mode: NoiseSuppressionMode) -> SonoraConfig {
        let ns_cfg = match mode {
            NoiseSuppressionMode::Off => None,
            NoiseSuppressionMode::Balanced => Some(SonoraNoiseSuppressionConfig {
                level: SonoraNoiseSuppressionLevel::Low,
                analyze_linear_aec_output_when_available: false,
            }),
            NoiseSuppressionMode::Strong => Some(SonoraNoiseSuppressionConfig {
                level: SonoraNoiseSuppressionLevel::High,
                analyze_linear_aec_output_when_available: false,
            }),
        };
        SonoraConfig {
            pipeline: SonoraPipelineConfig {
                maximum_internal_processing_rate: SonoraMaxProcessingRate::Rate48kHz,
                multi_channel_render: false,
                multi_channel_capture: false,
                ..Default::default()
            },
            noise_suppression: ns_cfg,
            ..Default::default()
        }
    }

    fn build_aura_post_ns(mode: NoiseSuppressionMode) -> AudioProcessing {
        let stream_cfg = SonoraStreamConfig::new(VOICE_SAMPLE_RATE as u32, 1);
        AudioProcessing::builder()
            .config(Self::aura_post_ns_config(mode))
            .capture_config(stream_cfg)
            .render_config(stream_cfg)
            .build()
    }

    pub fn with_options_and_aura(options: VoiceDenoiserOptions, use_aura_weights: bool) -> Self {
        let mut dfn = if use_aura_weights {
            let mut d = match Dfn3Model::from_bytes(&EPILOD_AURA_WEIGHTS.0) {
                Ok(model) => Dfn3Denoiser::with_model(model),
                Err(_) => Dfn3Denoiser::new(),
            };
            // Disable LSNR-based stage skipping so Aura never leaks raw noise at low SNR or quiet mics
            d.set_thresholds(-100.0, 100.0, 100.0);
            d
        } else {
            Dfn3Denoiser::new()
        };
        dfn.set_attenuation_limit(if use_aura_weights {
            Self::AURA_BALANCED_ATTEN_LIMIT_DB
        } else {
            Self::BALANCED_ATTEN_LIMIT_DB
        });
        let aura_post_ns = if use_aura_weights {
            Some(Self::build_aura_post_ns(NoiseSuppressionMode::Balanced))
        } else {
            None
        };
        let rnn_vad = VoiceActivityDetectorWrapper::new(
            sonora_simd::detect_backend(),
            VOICE_SAMPLE_RATE as i32,
        );
        Self {
            dfn,
            aura_post_ns,
            rnn_vad,
            options,
            aura_mode: use_aura_weights,
            last_mode: NoiseSuppressionMode::Balanced,
            stage_a_buf: [0.0; VOICE_FRAME_10MS],
            in_scaled: [0.0; VOICE_FRAME_10MS],
            out_scaled: [0.0; VOICE_FRAME_10MS],
            post_ns_scratch: [0.0; VOICE_FRAME_10MS],
            vad_pcm_buf: [0.0; VOICE_FRAME_10MS],
            speech_rms_env: Self::TARGET_INPUT_RMS,
            noise_rms_env: 0.003,
            prob_smooth: 0.0,
            hangover_frames: 0,
            post_gain_smooth: 1.0,
            prev_sub_rms: 0.005,
        }
    }

    pub fn reset(&mut self) {
        self.dfn.reset();
        if self.aura_mode {
            self.aura_post_ns = Some(Self::build_aura_post_ns(self.last_mode));
        }
        self.rnn_vad = VoiceActivityDetectorWrapper::new(
            sonora_simd::detect_backend(),
            VOICE_SAMPLE_RATE as i32,
        );
        self.stage_a_buf.fill(0.0);
        self.in_scaled.fill(0.0);
        self.out_scaled.fill(0.0);
        self.post_ns_scratch.fill(0.0);
        self.vad_pcm_buf.fill(0.0);
        self.speech_rms_env = Self::TARGET_INPUT_RMS;
        self.noise_rms_env = 0.003;
        self.prob_smooth = 0.0;
        self.hangover_frames = 0;
        self.post_gain_smooth = 1.0;
        self.prev_sub_rms = 0.005;
    }

    /// Processes a 10 ms 48 kHz mono frame in [-1.0, 1.0].
    /// Returns smoothed speech probability [0.0, 1.0] (1.0 in Off mode).
    pub fn process_10ms(
        &mut self,
        mode: NoiseSuppressionMode,
        dry: &[f32; VOICE_FRAME_10MS],
        out: &mut [f32; VOICE_FRAME_10MS],
    ) -> f32 {
        if mode == NoiseSuppressionMode::Off {
            out.copy_from_slice(dry);
            return 1.0;
        }

        // Stage A: Lookahead-verified 2.5 ms sub-frame impulse de-clicker.
        // Mechanical switches and mouse clicks spike sharply for 1 sub-window and either decay
        // immediately or stay ultra-HF, whereas vocal plosives/fricatives transition into sustained speech.
        self.stage_a_buf.copy_from_slice(dry);
        let mut had_click_transient = false;
        if self.options.stage_a {
            let spike_mult = match mode {
                NoiseSuppressionMode::Strong => 3.4,
                _ => 4.4,
            };
            const NUM_SUB: usize = VOICE_FRAME_10MS / VoiceDenoiser::SUBFRAME_LEN;
            let mut sub_rms_arr = [0.0f32; NUM_SUB];
            let mut hf_ratio_arr = [0.0f32; NUM_SUB];
            for w in 0..NUM_SUB {
                let start = w * Self::SUBFRAME_LEN;
                let win = &self.stage_a_buf[start..start + Self::SUBFRAME_LEN];
                let mut sum_sq = 0.0f32;
                let mut diff_sum = 0.0f32;
                let mut prev_s = win[0];
                for &s in win.iter() {
                    sum_sq += s * s;
                    diff_sum += (s - prev_s).abs();
                    prev_s = s;
                }
                let sub_rms = (sum_sq / Self::SUBFRAME_LEN as f32).sqrt();
                sub_rms_arr[w] = sub_rms;
                hf_ratio_arr[w] = if sub_rms > 1e-5 {
                    (diff_sum / Self::SUBFRAME_LEN as f32) / sub_rms
                } else {
                    0.0
                };
            }

            for w in 0..NUM_SUB {
                let sub_rms = sub_rms_arr[w];
                let hf_ratio = hf_ratio_arr[w];
                let looks_sustained_speech = if w + 1 < NUM_SUB {
                    sub_rms_arr[w + 1] >= sub_rms * 0.68 && hf_ratio_arr[w + 1] < 0.40
                } else {
                    hf_ratio < 0.48
                };
                let is_click_transient = self.hangover_frames == 0
                    && sub_rms > (self.prev_sub_rms * spike_mult).max(0.015)
                    && hf_ratio > 0.36
                    && !looks_sustained_speech;
                if is_click_transient {
                    had_click_transient = true;
                    let start = w * Self::SUBFRAME_LEN;
                    let win = &mut self.stage_a_buf[start..start + Self::SUBFRAME_LEN];
                    let target_rms = (self.prev_sub_rms * 1.4).max(0.004);
                    let atten = (target_rms / sub_rms.max(1e-5)).clamp(0.08, 0.45);
                    for s in win.iter_mut() {
                        *s *= atten;
                    }
                } else {
                    let alpha = if sub_rms > self.prev_sub_rms {
                        0.12
                    } else {
                        0.25
                    };
                    self.prev_sub_rms += alpha * (sub_rms - self.prev_sub_rms);
                }
            }
        }

        // Stage B: SNR-guarded pre-gain so quiet mics enter Classic DeepFilterNet3 near -24 dBFS without boosting loud fans.
        // Aura weights are trained directly across -42..-13 dBFS whispers + reverb, so DFN3 receives unity level while RNN-VAD still gets pre-leveled audio.
        if mode != self.last_mode {
            let limit_db = match (self.aura_mode, mode) {
                (true, NoiseSuppressionMode::Strong) => Self::AURA_STRONG_ATTEN_LIMIT_DB,
                (true, NoiseSuppressionMode::Balanced | NoiseSuppressionMode::Off) => {
                    Self::AURA_BALANCED_ATTEN_LIMIT_DB
                }
                (false, NoiseSuppressionMode::Strong) => Self::STRONG_ATTEN_LIMIT_DB,
                (false, NoiseSuppressionMode::Balanced | NoiseSuppressionMode::Off) => {
                    Self::BALANCED_ATTEN_LIMIT_DB
                }
            };
            self.dfn
                .set_attenuation_limit_smooth(limit_db, Duration::from_millis(20));
            if let Some(ref mut post_ns) = self.aura_post_ns {
                post_ns.apply_config(Self::aura_post_ns_config(mode));
            }
            self.last_mode = mode;
        }

        let dry_rms =
            (self.stage_a_buf.iter().map(|s| s * s).sum::<f32>() / VOICE_FRAME_10MS as f32).sqrt();
        let noise_cap_gain = if self.noise_rms_env > 1e-4 {
            (0.018 / self.noise_rms_env).clamp(1.0, Self::MAX_PRE_GAIN)
        } else {
            Self::MAX_PRE_GAIN
        };
        let vad_pre_gain = if self.speech_rms_env > 1e-4 {
            (Self::TARGET_INPUT_RMS / self.speech_rms_env)
                .clamp(1.0, Self::MAX_PRE_GAIN)
                .min(noise_cap_gain)
        } else {
            1.0
        };
        let dfn_pre_gain = if !self.options.pre_gain || self.aura_mode {
            1.0
        } else {
            vad_pre_gain
        };
        for (dst, &src) in self.in_scaled.iter_mut().zip(self.stage_a_buf.iter()) {
            *dst = if src.is_finite() {
                (src * dfn_pre_gain).clamp(-1.0, 1.0)
            } else {
                0.0
            };
        }

        let lsnr = self.dfn.process(&self.in_scaled, &mut self.out_scaled);
        if let Some(ref mut post_ns) = self.aura_post_ns {
            if post_ns
                .process_capture_f32(
                    &[self.out_scaled.as_slice()],
                    &mut [&mut self.post_ns_scratch[..]],
                )
                .is_ok()
            {
                for (dst, &src) in self.out_scaled.iter_mut().zip(self.post_ns_scratch.iter()) {
                    *dst = if src.is_finite() {
                        src.clamp(-1.0, 1.0)
                    } else {
                        0.0
                    };
                }
            }
        }
        let lsnr_prob = if lsnr.is_finite() {
            ((lsnr + 6.0) / 14.0).clamp(0.0, 1.0)
        } else {
            0.0
        };

        // In Aura mode, run WebRTC 24 kHz RNN-VAD on the leveled post-denoiser frame so steady
        // fans/clicks are already suppressed before VAD while soft whispers get pre-leveled lift.
        if self.aura_mode {
            for (dst, &src) in self.vad_pcm_buf.iter_mut().zip(self.out_scaled.iter()) {
                *dst = if src.is_finite() {
                    (src * vad_pre_gain * 32768.0).clamp(-32768.0, 32767.0)
                } else {
                    0.0
                };
            }
        } else {
            for (dst, &s) in self.vad_pcm_buf.iter_mut().zip(self.out_scaled.iter()) {
                *dst = if s.is_finite() {
                    (s * 32768.0).clamp(-32768.0, 32767.0)
                } else {
                    0.0
                };
            }
        }
        let rnn_prob = self.rnn_vad.analyze(&self.vad_pcm_buf).clamp(0.0, 1.0);
        let raw_prob = if had_click_transient && rnn_prob < 0.25 {
            rnn_prob.min(0.12)
        } else if rnn_prob >= 0.45 {
            rnn_prob.max(lsnr_prob)
        } else if rnn_prob < 0.08 && lsnr_prob < 0.92 {
            (rnn_prob * 0.70 + lsnr_prob * 0.30).min(0.18)
        } else if rnn_prob < 0.12 && lsnr_prob < 0.72 {
            (rnn_prob * 0.65 + lsnr_prob * 0.35).min(0.24)
        } else if self.aura_mode && rnn_prob < 0.25 {
            (rnn_prob * 0.70 + lsnr_prob * 0.30).min(0.24)
        } else {
            (rnn_prob * 0.60 + lsnr_prob * 0.40).clamp(0.0, 1.0)
        };

        if raw_prob >= 0.62 && dry_rms > 0.0020 {
            self.speech_rms_env = (self.speech_rms_env * 0.94 + dry_rms * 0.06).clamp(0.012, 0.25);
        } else if raw_prob < 0.20 {
            self.noise_rms_env = (self.noise_rms_env * 0.98 + dry_rms * 0.02).clamp(0.0005, 0.08);
        }

        let prob_alpha = if raw_prob > self.prob_smooth {
            0.65
        } else {
            0.24
        };
        self.prob_smooth += prob_alpha * (raw_prob - self.prob_smooth);
        if self.prob_smooth >= 0.38 {
            self.hangover_frames = Self::SPEECH_HANGOVER_FRAMES;
        } else if self.hangover_frames > 0 {
            self.hangover_frames -= 1;
        }

        // Stage C: Gentle silence-only residual floor smoother (no HF muffling low-pass;
        // keeps Aura's silence floor gentle so AGC2 estimates stationary noise accurately without +34 dB jumps).
        let floor_gain = match mode {
            NoiseSuppressionMode::Off => 1.0,
            NoiseSuppressionMode::Balanced => if self.aura_mode { 0.65 } else { 0.22 },
            NoiseSuppressionMode::Strong => if self.aura_mode { 0.50 } else { 0.08 },
        };
        let unity_thresh = if self.aura_mode { 0.12 } else { 0.20 };
        let target_post_gain = if self.hangover_frames > 0 || self.prob_smooth >= unity_thresh {
            1.0
        } else {
            let t = (self.prob_smooth / unity_thresh).clamp(0.0, 1.0);
            floor_gain + (1.0 - floor_gain) * (t * t)
        };

        let inv_pre_gain = 1.0 / dfn_pre_gain;
        let post_coeff = if target_post_gain > self.post_gain_smooth {
            0.045
        } else {
            0.0007
        };

        for (dst, &clean_s) in out.iter_mut().zip(self.out_scaled.iter()) {
            self.post_gain_smooth += post_coeff * (target_post_gain - self.post_gain_smooth);
            let clean = (clean_s * inv_pre_gain).clamp(-1.0, 1.0);
            *dst = if self.options.stage_c {
                clean * self.post_gain_smooth
            } else {
                clean
            };
        }

        raw_prob.max(self.prob_smooth)
    }
}

pub fn frame_dbfs(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -90.0;
    }
    let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
    let rms = (sum_sq / samples.len() as f32).sqrt();
    if rms <= 1e-6 {
        -90.0
    } else {
        (20.0 * rms.log10()).clamp(-90.0, 0.0)
    }
}

/// Hysteresis VAD gate with 20 ms pre-roll, 200 ms hangover, and click-free 5 ms ramps.
#[derive(Debug, Clone)]
pub struct VoiceGate {
    pre_roll: [[f32; VOICE_FRAME_10MS]; 2],
    pre_roll_len: usize,
    pre_roll_head: usize,
    is_open: bool,
    hangover_frames: usize,
    speech_streak: u8,
    current_gain: f32,
}

impl Default for VoiceGate {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceGate {
    const HANGOVER_TARGET_FRAMES: usize = 20; // 20 * 10 ms = 200 ms snappy release (Classic)
    const AURA_HANGOVER_TARGET_FRAMES: usize = 42; // 42 * 10 ms = 420 ms natural Discord-like pause hold
    const RAMP_SAMPLES: usize = 384; // 8 ms @ 48 kHz smooth S-curve ramp inside 10 ms frame
    const AURA_RELEASE_RAMP_SAMPLES: usize = 1200; // 25 ms @ 48 kHz soft fade-out without abrupt cut

    pub fn new() -> Self {
        Self {
            pre_roll: [[0.0; VOICE_FRAME_10MS]; 2],
            pre_roll_len: 0,
            pre_roll_head: 0,
            is_open: false,
            hangover_frames: 0,
            speech_streak: 0,
            current_gain: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.pre_roll_len = 0;
        self.pre_roll_head = 0;
        self.is_open = false;
        self.hangover_frames = 0;
        self.speech_streak = 0;
        self.current_gain = 0.0;
    }

    pub fn is_open(&self) -> bool {
        self.is_open || self.current_gain > 0.001
    }

    fn apply_ramp(
        &mut self,
        frame: &mut [f32; VOICE_FRAME_10MS],
        target_gain: f32,
        ramp_samples: usize,
    ) {
        let step = 1.0 / (ramp_samples.max(1) as f32);
        for s in frame.iter_mut() {
            if (self.current_gain - target_gain).abs() <= step {
                self.current_gain = target_gain;
            } else if self.current_gain < target_gain {
                self.current_gain += step;
            } else {
                self.current_gain -= step;
            }
            let g = self.current_gain;
            // Smoothstep S-curve avoids linear slope discontinuities (zero click artifacts)
            let smooth_g = g * g * (3.0 - 2.0 * g);
            *s *= smooth_g;
        }
    }

    /// Processes one 10 ms denoised frame in Classic mode.
    #[allow(clippy::too_many_arguments)]
    pub fn process_10ms(
        &mut self,
        frame: &[f32; VOICE_FRAME_10MS],
        speech_prob: f32,
        threshold_db: f32,
        vad_assisted: bool,
        ptt_active: Option<bool>,
        muted: bool,
        out_frames: &mut [[f32; VOICE_FRAME_10MS]; 3],
    ) -> (usize, bool, f32) {
        self.process_10ms_with_mode(
            frame,
            speech_prob,
            threshold_db,
            vad_assisted,
            ptt_active,
            muted,
            false,
            out_frames,
        )
    }

    /// Processes one 10 ms denoised frame in Aura mode (Discord-like neural-VAD sensitivity + 420 ms hangover + 25 ms soft release).
    #[allow(clippy::too_many_arguments)]
    pub fn process_10ms_aura(
        &mut self,
        frame: &[f32; VOICE_FRAME_10MS],
        speech_prob: f32,
        threshold_db: f32,
        vad_assisted: bool,
        ptt_active: Option<bool>,
        muted: bool,
        out_frames: &mut [[f32; VOICE_FRAME_10MS]; 3],
    ) -> (usize, bool, f32) {
        self.process_10ms_with_mode(
            frame,
            speech_prob,
            threshold_db,
            vad_assisted,
            ptt_active,
            muted,
            true,
            out_frames,
        )
    }

    /// Processes one 10 ms denoised frame. Writes 0..=3 output frames into `out_frames` and returns count.
    /// Zero heap allocations.
    #[allow(clippy::too_many_arguments)]
    pub fn process_10ms_with_mode(
        &mut self,
        frame: &[f32; VOICE_FRAME_10MS],
        speech_prob: f32,
        threshold_db: f32,
        vad_assisted: bool,
        ptt_active: Option<bool>,
        muted: bool,
        aura_mode: bool,
        out_frames: &mut [[f32; VOICE_FRAME_10MS]; 3],
    ) -> (usize, bool, f32) {
        let db = frame_dbfs(frame);
        let hangover_target = if aura_mode {
            Self::AURA_HANGOVER_TARGET_FRAMES
        } else {
            Self::HANGOVER_TARGET_FRAMES
        };
        let wants_open = if muted {
            self.speech_streak = 0;
            false
        } else if let Some(ptt) = ptt_active {
            self.speech_streak = 0;
            ptt
        } else if self.is_open {
            self.speech_streak = 0;
            let hold_ok = if aura_mode && vad_assisted {
                // Keep open on neural speech activity (even soft whispers down to -62 dBFS),
                // but never hold open on pure non-speech fan/room noise when speech_prob < 0.14.
                (speech_prob >= 0.22 && db >= -62.0)
                    || (speech_prob >= 0.14 && db >= (threshold_db - 4.0))
            } else if vad_assisted {
                (speech_prob >= 0.35 && db >= (threshold_db - 4.0))
                    || (speech_prob >= 0.20 && db >= (threshold_db + 2.0))
                    || (speech_prob >= 0.58 && db >= (threshold_db - 9.5))
            } else {
                db >= (threshold_db - 4.0)
            };
            if hold_ok {
                self.hangover_frames = hangover_target;
                true
            } else if self.hangover_frames > 0 {
                self.hangover_frames -= 1;
                true
            } else {
                false
            }
        } else if !vad_assisted {
            self.speech_streak = 0;
            db >= threshold_db
        } else if aura_mode {
            // Discord-style Auto-Sensitivity: neural VAD opens immediately for confident speech even on whispers,
            // rescues soft speech resuming during the 25 ms release fade, or opens after 20 ms confirmation for softer onsets
            // while rejecting single-frame 10 ms keyboard/mouse clicks.
            if (speech_prob >= 0.62 && db >= -60.0)
                || (self.current_gain > 0.05 && speech_prob >= 0.28 && db >= -60.0)
            {
                self.speech_streak = 0;
                true
            } else if (speech_prob >= 0.30 && db >= -62.0)
                || (speech_prob >= 0.24 && db >= threshold_db)
            {
                self.speech_streak = self.speech_streak.saturating_add(1);
                if self.speech_streak >= 2 {
                    self.speech_streak = 0;
                    true
                } else {
                    false
                }
            } else {
                self.speech_streak = 0;
                false
            }
        } else if (speech_prob >= 0.65 && db >= (threshold_db + 2.0))
            || (speech_prob >= 0.76 && db >= (threshold_db - 1.5))
        {
            // Immediate open on confident speech onset (still rejects 10 ms clicks)
            self.speech_streak = 0;
            true
        } else if speech_prob >= 0.40 && db >= (threshold_db - 4.0) {
            // 20 ms confirmation rejects 10 ms keyboard/mouse clicks while catching soft/quiet mics
            self.speech_streak = self.speech_streak.saturating_add(1);
            if self.speech_streak >= 2 {
                self.speech_streak = 0;
                true
            } else {
                false
            }
        } else {
            self.speech_streak = 0;
            false
        };

        let mut out_count = 0usize;

        if muted || ptt_active == Some(false) {
            // Fast, click-free close when muted or PTT released
            if self.is_open || self.current_gain > 0.0 {
                self.is_open = false;
                self.hangover_frames = 0;
                out_frames[0].copy_from_slice(frame);
                self.apply_ramp(&mut out_frames[0], 0.0, Self::RAMP_SAMPLES);
                out_count = 1;
            }
            self.pre_roll_len = 0;
            return (out_count, self.is_open(), db);
        }

        if wants_open && !self.is_open {
            self.is_open = true;
            self.hangover_frames = if ptt_active.is_some() {
                0
            } else {
                hangover_target
            };
            // Flush pre-roll frames on VAD open so consonant onsets aren't clipped
            if ptt_active.is_none() && self.pre_roll_len > 0 {
                let start = (self.pre_roll_head + 2 - self.pre_roll_len) % 2;
                for i in 0..self.pre_roll_len {
                    let idx = (start + i) % 2;
                    out_frames[out_count].copy_from_slice(&self.pre_roll[idx]);
                    self.apply_ramp(&mut out_frames[out_count], 1.0, Self::RAMP_SAMPLES);
                    out_count += 1;
                }
                self.pre_roll_len = 0;
            }
            out_frames[out_count].copy_from_slice(frame);
            self.apply_ramp(&mut out_frames[out_count], 1.0, Self::RAMP_SAMPLES);
            out_count += 1;
        } else if wants_open && self.is_open {
            out_frames[0].copy_from_slice(frame);
            self.apply_ramp(&mut out_frames[0], 1.0, Self::RAMP_SAMPLES);
            out_count = 1;
        } else if !wants_open && (self.is_open || self.current_gain > 0.0) {
            self.is_open = false;
            out_frames[0].copy_from_slice(frame);
            let rel_ramp = if aura_mode {
                Self::AURA_RELEASE_RAMP_SAMPLES
            } else {
                Self::RAMP_SAMPLES
            };
            self.apply_ramp(&mut out_frames[0], 0.0, rel_ramp);
            out_count = 1;
            // Frame was already emitted in `out_frames[0]`; never push it into pre-roll or re-opening would duplicate 10 ms!
            self.pre_roll_len = 0;
        } else {
            self.push_pre_roll(frame);
        }

        (out_count, self.is_open(), db)
    }

    fn push_pre_roll(&mut self, frame: &[f32; VOICE_FRAME_10MS]) {
        self.pre_roll[self.pre_roll_head].copy_from_slice(frame);
        self.pre_roll_head = (self.pre_roll_head + 1) % 2;
        if self.pre_roll_len < 2 {
            self.pre_roll_len += 1;
        }
    }
}

/// Studio broadcast vocal processor:
/// - Stage 1: Transparent surgical EQ (-1.8 dB @ 360 Hz boxiness trim + +1.6 dB @ 3.0 kHz articulation bell)
/// - Stage 2: SNR-guarded speech-gated AGC & soft-knee downward compressor (lifts quiet -52 dBFS mics cleanly)
/// - Stage 3: Split-band >5.5 kHz dynamic sibilance de-esser + fast peak compressor + -1 dBFS ceiling limiter
#[derive(Debug, Clone)]
pub struct VoiceCompressor {
    env_rms: f32,
    noise_floor_rms: f32,
    gain_smooth: f32,
    peak_env: f32,
    mud_eq: BiquadPeakingEq,
    presence_eq: BiquadPeakingEq,
    deess_lp: f32,
    body_env: f32,
    sibilance_env: f32,
}

impl Default for VoiceCompressor {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceCompressor {
    const TARGET_RMS_DB: f32 = -18.0;
    const COMP_THRESH_DB: f32 = -22.0;
    const COMP_RATIO: f32 = 3.5;
    const COMP_KNEE_DB: f32 = 6.0;
    const MAX_AGC_GAIN_DB: f32 = 14.0;
    const PEAK_THRESH: f32 = 0.3548; // -9.0 dBFS fast peak knee
    const LIMITER_CEILING: f32 = 0.89125; // -1 dBFS

    pub fn new() -> Self {
        Self {
            env_rms: 0.015,
            noise_floor_rms: 0.0012,
            gain_smooth: 1.0,
            peak_env: 0.0,
            mud_eq: BiquadPeakingEq::new(360.0, 1.1, -1.8, VOICE_SAMPLE_RATE as f32),
            presence_eq: BiquadPeakingEq::new(3000.0, 0.85, 1.6, VOICE_SAMPLE_RATE as f32),
            deess_lp: 0.0,
            body_env: 0.01,
            sibilance_env: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.env_rms = 0.015;
        self.noise_floor_rms = 0.0012;
        self.gain_smooth = 1.0;
        self.peak_env = 0.0;
        self.mud_eq.reset();
        self.presence_eq.reset();
        self.deess_lp = 0.0;
        self.body_env = 0.01;
        self.sibilance_env = 0.0;
    }

    pub fn process_in_place(&mut self, samples: &mut [f32], enabled: bool) {
        self.process_with_speech_prob(samples, 1.0, enabled);
    }

    /// Transparent -1 dBFS safety limiter without additional AGC, EQ, or compression (used in Aura mode when AGC2 handles leveling).
    pub fn process_limiter_only(&mut self, samples: &mut [f32]) {
        for s in samples.iter_mut() {
            *s = soft_limit(*s, Self::LIMITER_CEILING);
        }
    }

    /// Transparent Aura broadcast dynamics: 2.0:1 soft-knee crest compressor (-15 dBFS, 8 dB knee,
    /// 10 ms attack / 150 ms release) + -1 dBFS soft-limiter, without coloring EQ/de-esser.
    /// Freezes envelope updates during non-speech (`speech_prob < 0.35`) so reverb tails are never pumped.
    pub fn process_aura_broadcast(&mut self, samples: &mut [f32], speech_prob: f32) {
        if samples.is_empty() {
            return;
        }
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        let frame_rms = (sum_sq / samples.len() as f32).sqrt();
        if speech_prob >= 0.35 && frame_rms > 0.002 {
            // 20 ms step: ~10 ms attack (alpha ~0.85), ~150 ms release (alpha ~0.12)
            let alpha = if frame_rms > self.env_rms { 0.85 } else { 0.12 };
            self.env_rms = (1.0 - alpha) * self.env_rms + alpha * frame_rms;
        }
        let env_db = if self.env_rms <= 1e-5 {
            -70.0
        } else {
            20.0 * self.env_rms.log10()
        };
        const AURA_THRESH_DB: f32 = -15.0;
        const AURA_RATIO: f32 = 2.0;
        const AURA_KNEE_DB: f32 = 8.0;
        let over = env_db - AURA_THRESH_DB;
        let half_knee = AURA_KNEE_DB * 0.5;
        let comp_db = if over <= -half_knee {
            0.0
        } else if over >= half_knee {
            (AURA_THRESH_DB + over / AURA_RATIO) - env_db
        } else {
            let t = over + half_knee;
            ((1.0 / AURA_RATIO) - 1.0) * (t * t) / (2.0 * AURA_KNEE_DB)
        };
        let target_gain = 10.0f32.powf(comp_db / 20.0);
        let gain_step = (target_gain - self.gain_smooth) / (samples.len() as f32);
        for s in samples.iter_mut() {
            self.gain_smooth += gain_step;
            *s = soft_limit(*s * self.gain_smooth, Self::LIMITER_CEILING);
        }
    }

    pub fn process_with_speech_prob(
        &mut self,
        samples: &mut [f32],
        speech_prob: f32,
        enabled: bool,
    ) {
        if !enabled {
            for s in samples.iter_mut() {
                *s = soft_limit(*s, Self::LIMITER_CEILING);
            }
            return;
        }
        if samples.is_empty() {
            return;
        }
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        let frame_rms = (sum_sq / samples.len() as f32).sqrt();

        // Track speech down to -52 dBFS (0.0025) so very quiet mics still get leveled,
        // while tracking residual noise floor during non-speech to cap hiss amplification.
        if speech_prob >= 0.50 && frame_rms > 0.0025 {
            let alpha = if frame_rms > self.env_rms { 0.25 } else { 0.07 };
            self.env_rms = (1.0 - alpha) * self.env_rms + alpha * frame_rms;
        } else if speech_prob < 0.20 {
            self.noise_floor_rms =
                (0.96 * self.noise_floor_rms + 0.04 * frame_rms).clamp(0.0003, 0.04);
        }
        let env_db = if self.env_rms <= 1e-5 {
            -70.0
        } else {
            20.0 * self.env_rms.log10()
        };
        let noise_db = 20.0 * self.noise_floor_rms.max(1e-5).log10();
        let snr_db = (env_db - noise_db).max(0.0);

        // Soft-knee downward compression above COMP_THRESH_DB
        let over = env_db - Self::COMP_THRESH_DB;
        let half_knee = Self::COMP_KNEE_DB * 0.5;
        let compressed_db = if over <= -half_knee {
            env_db
        } else if over >= half_knee {
            Self::COMP_THRESH_DB + over / Self::COMP_RATIO
        } else {
            let t = over + half_knee;
            env_db + ((1.0 / Self::COMP_RATIO) - 1.0) * (t * t) / (2.0 * Self::COMP_KNEE_DB)
        };
        let comp_reduction_db = compressed_db - env_db;

        // SNR-bounded speech-only AGC lift toward -18 dBFS (up to +10.5 dB on clean quiet mics,
        // automatically scaled back if mic has high analog static floor).
        let max_safe_boost_db = (snr_db * 0.65).clamp(2.0, 10.5);
        let agc_boost_db = if speech_prob >= 0.50 && env_db > -54.0 {
            ((Self::TARGET_RMS_DB - env_db).clamp(-6.0, Self::MAX_AGC_GAIN_DB) * 0.75)
                .min(max_safe_boost_db)
        } else {
            0.0
        };

        let target_gain = if speech_prob >= 0.50 || self.gain_smooth <= 1.0 {
            10.0f32.powf((comp_reduction_db + agc_boost_db) / 20.0)
        } else {
            self.gain_smooth
        };
        let gain_step = (target_gain - self.gain_smooth) / (samples.len() as f32);

        for s in samples.iter_mut() {
            self.gain_smooth += gain_step;
            let leveled = *s * self.gain_smooth;

            // Subtle studio EQ: clean 360 Hz plastic/room mud + 3.0 kHz vocal articulation
            let mut x = self
                .presence_eq
                .process_sample(self.mud_eq.process_sample(leveled));

            // Split-band >5.5 kHz dynamic sibilance de-esser (engages only when harsh 'S'/'SH' exceeds vocal body)
            self.deess_lp += 0.52 * (x - self.deess_lp);
            let hf = x - self.deess_lp;
            let body_abs = self.deess_lp.abs();
            let hf_abs = hf.abs();
            self.body_env += 0.008 * (body_abs - self.body_env);
            let sib_alpha = if hf_abs > self.sibilance_env {
                0.05
            } else {
                0.0025
            };
            self.sibilance_env += sib_alpha * (hf_abs - self.sibilance_env);
            let sib_thresh = (self.body_env * 0.62).max(0.085);
            if self.sibilance_env > sib_thresh {
                let deess = (sib_thresh / self.sibilance_env).clamp(0.42, 1.0);
                x = self.deess_lp + hf * deess;
            }

            // Fast ~0.5 ms attack / ~50 ms release peak compressor + -1 dBFS true ceiling limiter
            let x_abs = x.abs();
            let pk_alpha = if x_abs > self.peak_env { 0.04 } else { 0.0004 };
            self.peak_env += pk_alpha * (x_abs - self.peak_env);
            if self.peak_env > Self::PEAK_THRESH {
                let target_mag = Self::PEAK_THRESH + (self.peak_env - Self::PEAK_THRESH) * 0.25;
                x *= (target_mag / self.peak_env.max(1e-5)).clamp(0.25, 1.0);
            }

            *s = soft_limit(x, Self::LIMITER_CEILING);
        }
    }
}

/// Per-peer receiver loudness normalizer so quiet and loud friends arrive at uniform baseline level.
#[derive(Debug, Clone)]
pub struct PeerRxLeveler {
    env_rms: f32,
    gain_smooth: f32,
}

impl Default for PeerRxLeveler {
    fn default() -> Self {
        Self::new()
    }
}

impl PeerRxLeveler {
    const TARGET_RMS: f32 = 0.10; // ~ -20 dBFS comfortable conversation baseline
    const MIN_GAIN: f32 = 0.50; // -6 dB
    const MAX_GAIN: f32 = 2.50; // +8 dB

    pub fn new() -> Self {
        Self {
            env_rms: Self::TARGET_RMS,
            gain_smooth: 1.0,
        }
    }

    pub fn process_in_place(&mut self, samples: &mut [f32]) {
        self.process_in_place_with_plc(samples, false, false);
    }

    pub fn process_in_place_with_plc(
        &mut self,
        samples: &mut [f32],
        is_plc: bool,
        aura_mode: bool,
    ) {
        if samples.is_empty() {
            return;
        }
        if is_plc {
            for s in samples.iter_mut() {
                *s = (*s * self.gain_smooth).clamp(-1.0, 1.0);
            }
            return;
        }
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        let frame_rms = (sum_sq / samples.len() as f32).sqrt();
        // Track only active speech frames (> -45 dBFS) so silence never skews gain
        if frame_rms > 0.0056 {
            let alpha = if frame_rms > self.env_rms { 0.08 } else { 0.03 };
            self.env_rms += alpha * (frame_rms - self.env_rms);
        }
        let (target_rms, min_gain, max_gain) = if aura_mode {
            (0.08, 0.75, 1.35)
        } else {
            (Self::TARGET_RMS, Self::MIN_GAIN, Self::MAX_GAIN)
        };
        let target_gain = if self.env_rms > 1e-4 {
            (target_rms / self.env_rms).clamp(min_gain, max_gain)
        } else {
            1.0
        };
        let step = (target_gain - self.gain_smooth) / (samples.len() as f32);
        for s in samples.iter_mut() {
            self.gain_smooth += step;
            *s = (*s * self.gain_smooth).clamp(-1.0, 1.0);
        }
    }
}

/// Receive-side echo suppressor. Detects when a remote peer's audio is just OUR OWN transmitted
/// voice coming back (through their speakers -> their mic) by correlating loudness envelopes at
/// 10 ms resolution, then ducks only those moments. Independent of the peer's app version / AEC.
pub struct RxEchoSuppressor {
    peer_env: VecDeque<f32>,
    lag: usize,
    hold: u32,
    ratio: f32,
    gain: f32,
    cand_lag: usize,
    confirm: u32,
}

impl Default for RxEchoSuppressor {
    fn default() -> Self {
        Self::new()
    }
}

impl RxEchoSuppressor {
    const WIN: usize = 100; // 1 s correlation window
    const LAG_MIN: usize = 8; // 80 ms
    const LAG_MAX: usize = 90; // 900 ms
    const CORR_MIN: f32 = 0.91;
    const CONFIRM_TICKS: u32 = 15; // 300 ms of consistent lag
    const HOLD_TICKS: u32 = 100; // 2 s of 20 ms ticks

    pub fn new() -> Self {
        Self {
            peer_env: VecDeque::with_capacity(256),
            lag: 0,
            hold: 0,
            ratio: 0.0,
            gain: 1.0,
            cand_lag: 0,
            confirm: 0,
        }
    }

    pub fn is_suppressing(&self) -> bool {
        self.hold > 0
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|s| s * s).sum::<f32>() / x.len().max(1) as f32).sqrt()
    }

    /// `own_env`: oldest -> newest 10 ms RMS of what we transmitted (newest ~= now).
    /// `pcm`: one decoded 20 ms peer frame (modified in place).
    pub fn process_20ms(&mut self, own_env: &[f32], pcm: &mut [f32]) {
        let half = pcm.len() / 2;
        if half == 0 {
            return;
        }
        let pe = [Self::rms(&pcm[..half]), Self::rms(&pcm[half..])];
        for v in pe {
            if self.peer_env.len() >= 256 {
                self.peer_env.pop_front();
            }
            self.peer_env.push_back(v);
        }

        let n = own_env.len();
        let pl = self.peer_env.len();
        if pl >= Self::WIN && n >= Self::WIN + Self::LAG_MIN {
            let own_max = own_env[n - Self::WIN.min(n)..]
                .iter()
                .cloned()
                .fold(0.0f32, f32::max);
            let _ = own_max;
            let p: Vec<f32> = self.peer_env.iter().skip(pl - Self::WIN).copied().collect();
            let pmean = p.iter().sum::<f32>() / Self::WIN as f32;
            let pvar: f32 = p.iter().map(|x| (x - pmean) * (x - pmean)).sum();
            let pmax = p.iter().cloned().fold(0.0f32, f32::max);
            if pvar > 1e-8 && pmax > 0.002 {
                let mut best_corr = 0.0f32;
                let mut best_lag = 0usize;
                let mut best_ratio = 0.0f32;
                let max_lag = Self::LAG_MAX.min(n - Self::WIN);
                for lag in Self::LAG_MIN..=max_lag {
                    let start = n - Self::WIN - lag;
                    let o = &own_env[start..start + Self::WIN];
                    let omean = o.iter().sum::<f32>() / Self::WIN as f32;
                    let omax = o.iter().cloned().fold(0.0f32, f32::max);
                    if omax < 0.004 {
                        continue;
                    }
                    let mut cov = 0.0f32;
                    let mut ovar = 0.0f32;
                    let mut po = 0.0f32;
                    let mut oo = 0.0f32;
                    for j in 0..Self::WIN {
                        let dp = p[j] - pmean;
                        let dop = o[j] - omean;
                        cov += dp * dop;
                        ovar += dop * dop;
                        po += p[j] * o[j];
                        oo += o[j] * o[j];
                    }
                    if ovar < 1e-9 {
                        continue;
                    }
                    let corr = cov / (pvar.sqrt() * ovar.sqrt() + 1e-12);
                    if corr > best_corr {
                        best_corr = corr;
                        best_lag = lag;
                        best_ratio = po / (oo + 1e-12);
                    }
                }
                if best_corr >= Self::CORR_MIN && best_ratio > 0.01 && best_ratio < 12.0 {
                    if best_lag.abs_diff(self.cand_lag) <= 1 {
                        self.confirm += 1;
                    } else {
                        self.cand_lag = best_lag;
                        self.confirm = 1;
                    }
                    if self.confirm >= Self::CONFIRM_TICKS {
                        self.lag = best_lag;
                        self.ratio = best_ratio;
                        self.hold = Self::HOLD_TICKS;
                    }
                } else {
                    self.confirm = self.confirm.saturating_sub(2);
                }
            }
        }

        let active = self.hold > 0;
        if active {
            self.hold -= 1;
        }
        let prev_gain = self.gain;
        let mut gains = [1.0f32; 2];
        for h in 0..2 {
            let mut target = 1.0f32;
            if active && n > self.lag + 4 {
                let idx = (n as isize) - 2 + h as isize - self.lag as isize;
                let lo = (idx - 2).max(0) as usize;
                let hi = ((idx + 2) as usize).min(n - 1);
                let own_v = own_env[lo..=hi].iter().cloned().fold(0.0f32, f32::max);
                if own_v > 0.004 {
                    let predicted = self.ratio * own_v;
                    target = if pe[h] > 2.5 * predicted + 0.01 {
                        0.7
                    } else {
                        0.06
                    };
                }
            }
            let coef = if target < self.gain { 0.6 } else { 0.12 };
            self.gain += (target - self.gain) * coef;
            gains[h] = self.gain;
        }
        if (prev_gain - 1.0).abs() < 1e-4 && (gains[0] - 1.0).abs() < 1e-4 && (gains[1] - 1.0).abs() < 1e-4 {
            return;
        }
        let mut g_prev = prev_gain;
        for h in 0..2 {
            let g_new = gains[h];
            let seg = if h == 0 { &mut pcm[..half] } else { &mut pcm[half..] };
            let len = seg.len() as f32;
            for (i, s) in seg.iter_mut().enumerate() {
                let t = (i + 1) as f32 / len;
                *s *= g_prev + (g_new - g_prev) * t;
            }
            g_prev = g_new;
        }
    }
}

#[inline]
pub fn soft_limit(x: f32, ceiling: f32) -> f32 {
    let abs = x.abs();
    if abs <= ceiling * 0.85 {
        x
    } else {
        let knee = ceiling * 0.85;
        let headroom = ceiling - knee;
        let over = abs - knee;
        let compressed = knee + headroom * (over / (over + headroom));
        x.signum() * compressed.min(ceiling)
    }
}

/// Token bucket capping per-peer voice packet rate (DoS protection).
#[derive(Debug, Clone)]
pub struct PeerTokenBucket {
    tokens: f64,
    capacity: f64,
    refill_per_sec: f64,
    last_ms: u64,
}

impl PeerTokenBucket {
    pub fn new(capacity: f64, refill_per_sec: f64, now_ms: u64) -> Self {
        Self {
            tokens: capacity,
            capacity,
            refill_per_sec,
            last_ms: now_ms,
        }
    }

    pub fn new_voice_default(now_ms: u64) -> Self {
        Self::new(24.0, 65.0, now_ms)
    }

    /// Per-hop outer bucket allowing 1 direct talker + up to 4 relayed voice streams concurrently.
    pub fn new_relay_hop(now_ms: u64) -> Self {
        Self::new(48.0, 300.0, now_ms)
    }

    pub fn allow(&mut self, now_ms: u64) -> bool {
        if now_ms > self.last_ms {
            let dt = (now_ms - self.last_ms) as f64 / 1000.0;
            self.tokens = (self.tokens + dt * self.refill_per_sec).min(self.capacity);
            self.last_ms = now_ms;
        }
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JitterPacket {
    pub seq: u16,
    pub epoch: u8,
    pub ts_48k: u32,
    pub end_of_talk: bool,
    pub opus: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JitterPop<'a> {
    Packet(&'a [u8]),
    Fec(&'a [u8]),
    Plc,
    Silence,
}

/// Per-peer drift-aware adaptive jitter buffer (20 ms frames).
#[derive(Debug)]
pub struct PeerJitterBuffer {
    epoch: Option<u8>,
    highest_ext_seq: u64,
    next_play_seq: u64,
    started: bool,
    in_talkspurt: bool,
    last_eot_seen: bool,
    target_frames: usize,
    min_target_frames: usize,
    stall_cushion_frames: usize,
    frames: BTreeMap<u64, JitterPacket>,
    interarrival_jitter_ms: f64,
    last_arrival_ms: Option<u64>,
    last_pkt_ts_ms: Option<u64>,
    drift_sample_acc: i64,
    drift_sample_count: usize,
    total_pushed: u64,
    total_lost: u64,
    underrun_count: u64,
    consecutive_underruns: u32,
    current_gap_frames: u32,
    max_gap_frames: u32,
    clean_frames_since_stall: u32,
}

impl Default for PeerJitterBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl PeerJitterBuffer {
    pub fn new() -> Self {
        Self {
            epoch: None,
            highest_ext_seq: 0,
            next_play_seq: 0,
            started: false,
            in_talkspurt: false,
            last_eot_seen: false,
            target_frames: 2, // 40 ms initial cushion prevents micro-cutoffs on talkspurt start
            min_target_frames: 1,
            stall_cushion_frames: 0,
            frames: BTreeMap::new(),
            interarrival_jitter_ms: 0.0,
            last_arrival_ms: None,
            last_pkt_ts_ms: None,
            drift_sample_acc: 0,
            drift_sample_count: 0,
            total_pushed: 0,
            total_lost: 0,
            underrun_count: 0,
            consecutive_underruns: 0,
            current_gap_frames: 0,
            max_gap_frames: 0,
            clean_frames_since_stall: 0,
        }
    }

    pub fn flush(&mut self) {
        self.highest_ext_seq = 0;
        self.next_play_seq = 0;
        self.started = false;
        self.in_talkspurt = false;
        self.frames.clear();
        self.drift_sample_acc = 0;
        self.drift_sample_count = 0;
        self.consecutive_underruns = 0;
        self.current_gap_frames = 0;
    }

    pub fn current_delay_ms(&self) -> usize {
        self.frames.len() * 20
    }

    pub fn set_min_target_frames(&mut self, min_frames: usize) {
        self.min_target_frames = min_frames.clamp(1, 4);
    }

    pub fn target_delay_ms(&self) -> usize {
        self.effective_target_frames() * 20
    }

    pub fn interarrival_jitter_ms(&self) -> f64 {
        self.interarrival_jitter_ms
    }

    pub fn underrun_count(&self) -> u64 {
        self.underrun_count
    }

    pub fn max_gap_frames(&self) -> u32 {
        self.max_gap_frames
    }

    pub fn loss_pct(&self) -> f32 {
        let total = self.total_pushed + self.total_lost;
        if total == 0 {
            0.0
        } else {
            ((self.total_lost as f64 / total as f64) * 100.0) as f32
        }
    }

    /// Returns true while a talkspurt is active or queued frames remain in the buffer.
    pub fn is_active(&self) -> bool {
        self.in_talkspurt || !self.frames.is_empty()
    }

    fn effective_target_frames(&self) -> usize {
        (self.target_frames.max(self.min_target_frames) + self.stall_cushion_frames)
            .clamp(self.min_target_frames, 6)
    }

    fn unwrap_seq(reference: u64, seq_u16: u16) -> u64 {
        let high = reference & !0xFFFFu64;
        let cand = high | (seq_u16 as u64);
        if cand + 32768 < reference {
            cand + 65536
        } else if reference + 32768 < cand && cand >= 65536 {
            cand - 65536
        } else {
            cand
        }
    }

    pub fn push(&mut self, pkt: JitterPacket, arrival_ms: u64) {
        if self.epoch != Some(pkt.epoch) {
            self.flush();
            self.epoch = Some(pkt.epoch);
        }

        let ext_seq = if !self.started && self.frames.is_empty() && self.highest_ext_seq == 0 {
            pkt.seq as u64
        } else {
            Self::unwrap_seq(self.highest_ext_seq, pkt.seq)
        };

        if self.started && ext_seq < self.next_play_seq {
            return; // Too late; already played past this seq
        }

        if ext_seq > self.highest_ext_seq {
            self.highest_ext_seq = ext_seq;
        }

        let pkt_ts_ms = (pkt.ts_48k as u64) / 48;
        let was_active = self.in_talkspurt;
        if let (Some(prev_arr), Some(prev_ts)) = (self.last_arrival_ms, self.last_pkt_ts_ms) {
            let d_arr = arrival_ms as i64 - prev_arr as i64;
            let d_ts = pkt_ts_ms as i64 - prev_ts as i64;
            // Ignore silence-suppression (DTX) gaps between talkspurts so paused speech
            // timestamps do not inflate interarrival jitter and lock depth at 80 ms.
            let is_dtx_gap = !was_active || (d_arr > 250 && d_ts <= 120);
            if !is_dtx_gap {
                let d = (d_arr - d_ts).unsigned_abs() as f64;
                self.interarrival_jitter_ms += (d - self.interarrival_jitter_ms) / 16.0;
                self.target_frames = if self.interarrival_jitter_ms < 6.0 {
                    1
                } else if self.interarrival_jitter_ms < 28.0 {
                    2
                } else if self.interarrival_jitter_ms < 50.0 {
                    3
                } else {
                    4
                };
            }
        }
        self.last_arrival_ms = Some(arrival_ms);
        self.last_pkt_ts_ms = Some(pkt_ts_ms);

        self.last_eot_seen = pkt.end_of_talk;
        if self.frames.len() < 16 {
            if !self.frames.contains_key(&ext_seq) {
                self.total_pushed += 1;
            }
            self.frames.insert(ext_seq, pkt);
        }
        self.in_talkspurt = true;
    }

    /// Pops one 20 ms step for playback. Caller should decode immediately before the next push.
    pub fn pop_step(&mut self) -> (Option<Vec<u8>>, bool /* fec */, bool /* plc */) {
        let eff_target = self.effective_target_frames();
        if !self.started {
            if self.frames.len() < eff_target {
                return (None, false, false);
            }
            if let Some(&first_seq) = self.frames.keys().next() {
                self.next_play_seq = first_seq;
                self.started = true;
            } else {
                return (None, false, false);
            }
        }

        // Fast backlog catch-up when an OS/CPU stall queues excess talkspurt frames (> 40 ms over target)
        if self.frames.len() > eff_target + 2 {
            let to_drop = if self.frames.len() > eff_target + 4 {
                2
            } else {
                1
            };
            for _ in 0..to_drop {
                if let Some((&oldest_seq, _)) = self.frames.iter().next() {
                    self.frames.remove(&oldest_seq);
                    self.next_play_seq = oldest_seq + 1;
                }
            }
            self.drift_sample_acc = 0;
            self.drift_sample_count = 0;
        }

        // Drift tracking over 1 s (50 ticks of 20 ms)
        let depth = self.frames.len() as i64;
        self.drift_sample_acc += depth - (eff_target as i64);
        self.drift_sample_count += 1;
        if self.drift_sample_count >= 50 {
            let acc = self.drift_sample_acc;
            let count = self.drift_sample_count as i64;
            self.drift_sample_acc = 0;
            self.drift_sample_count = 0;
            // Beyond +20 ms (+1 frame) sustained drift, drop one oldest frame smoothly
            if acc >= count && self.frames.len() > eff_target {
                if let Some((&oldest_seq, _)) = self.frames.iter().next() {
                    self.frames.remove(&oldest_seq);
                    self.next_play_seq = oldest_seq + 1;
                }
            }
        }

        if let Some(pkt) = self.frames.remove(&self.next_play_seq) {
            self.next_play_seq += 1;
            self.consecutive_underruns = 0;
            self.current_gap_frames = 0;
            self.clean_frames_since_stall = self.clean_frames_since_stall.saturating_add(1);
            if self.clean_frames_since_stall >= 75 && self.stall_cushion_frames > 0 {
                // Decay extra stall cushion after >= 1.5 s clean playback
                self.clean_frames_since_stall = 0;
                self.stall_cushion_frames -= 1;
            }
            if pkt.end_of_talk {
                if self.frames.is_empty() {
                    // Snap back cleanly after talkspurt ends so drift never accumulates
                    self.started = false;
                    self.in_talkspurt = false;
                }
                if pkt.opus.is_empty() {
                    return (None, false, false);
                }
            }
            return (Some(pkt.opus), false, false);
        }

        // Missing packet at next_play_seq
        let drained_cleanly =
            self.frames.is_empty() && (self.last_eot_seen || self.current_gap_frames >= 2);
        if !self.in_talkspurt || drained_cleanly {
            // Talkspurt ended cleanly or extended dead air -> wait for effective_target_frames cushion on resume
            self.started = false;
            self.in_talkspurt = false;
            return (None, false, false);
        }

        self.total_lost += 1;
        self.underrun_count += 1;
        self.consecutive_underruns = self.consecutive_underruns.saturating_add(1);
        self.current_gap_frames = self.current_gap_frames.saturating_add(1);
        self.max_gap_frames = self.max_gap_frames.max(self.current_gap_frames);
        self.clean_frames_since_stall = 0;
        if self.consecutive_underruns >= 2 && self.stall_cushion_frames < 2 {
            // Grow target jitter cushion after repeated underruns to absorb Wi-Fi stalls
            self.stall_cushion_frames += 1;
            self.consecutive_underruns = 0;
        }

        let lookahead_seq = self.next_play_seq + 1;
        self.next_play_seq += 1;
        if let Some(next_pkt) = self.frames.get(&lookahead_seq) {
            if !next_pkt.opus.is_empty() {
                self.current_gap_frames = 0;
                return (Some(next_pkt.opus.clone()), true, false);
            }
        }
        (None, false, true)
    }
}

/// Dynamic bitrate + FEC controller based on packet loss, RTT, and room upload budget.
#[derive(Debug, Clone)]
pub struct AdaptiveBitrateController {
    bitrate_bps: i32,
    fec_enabled: bool,
    expected_loss_pct: i32,
    clean_ticks: u32,
    upshift_probe_ticks: u16,
    hold_ticks_req: u32,
}

impl Default for AdaptiveBitrateController {
    fn default() -> Self {
        Self::new()
    }
}

impl AdaptiveBitrateController {
    pub fn new() -> Self {
        Self {
            bitrate_bps: 64_000,
            fec_enabled: true,
            expected_loss_pct: 5,
            clean_ticks: 0,
            upshift_probe_ticks: 0,
            hold_ticks_req: 500,
        }
    }

    pub fn bitrate_bps(&self) -> i32 {
        self.bitrate_bps
    }

    pub fn fec_enabled(&self) -> bool {
        self.fec_enabled
    }

    pub fn expected_loss_pct(&self) -> i32 {
        self.expected_loss_pct
    }

    /// Computes a per-stream bitrate ceiling (24..=64 kbps) from active upload peers and budget.
    pub fn room_bitrate_cap_bps(active_tx_peers: usize, est_upload_kbps: u32) -> i32 {
        Self::room_bitrate_cap_bps_for_mode(active_tx_peers, est_upload_kbps, false)
    }

    /// Computes a per-stream bitrate ceiling (up to 64 kbps speech, 72 kbps raw music) from peer count and upload budget.
    pub fn room_bitrate_cap_bps_for_mode(
        active_tx_peers: usize,
        est_upload_kbps: u32,
        raw_music_mode: bool,
    ) -> i32 {
        let top_cap = if raw_music_mode && active_tx_peers <= 2 {
            72_000
        } else {
            64_000
        };
        if active_tx_peers <= 1 {
            return if est_upload_kbps > 0 && est_upload_kbps < 80 {
                24_000
            } else if est_upload_kbps > 0 && est_upload_kbps < 120 {
                48_000
            } else {
                top_cap
            };
        }
        if est_upload_kbps > 0 {
            let per_stream_kbps = ((est_upload_kbps as f32) * 0.75) / (active_tx_peers as f32);
            if per_stream_kbps < 36.0 {
                return 24_000;
            }
            if per_stream_kbps < 52.0 {
                return 32_000;
            }
            if per_stream_kbps < 76.0 {
                return 48_000;
            }
        }
        match active_tx_peers {
            0..=3 => top_cap,
            4..=5 => 32_000,
            _ => 24_000,
        }
    }

    pub fn update(&mut self, max_loss_pct: f32, max_rtt_ms: u32) -> bool {
        self.update_with_room_cap(max_loss_pct, max_rtt_ms, 64_000)
    }

    /// Fast downshift on loss spikes and slower, probed upshift capped by room upload budget.
    pub fn update_with_room_cap(
        &mut self,
        max_loss_pct: f32,
        max_rtt_ms: u32,
        room_cap_bps: i32,
    ) -> bool {
        let cap = room_cap_bps.clamp(24_000, 72_000);
        let prev = (self.bitrate_bps, self.fec_enabled, self.expected_loss_pct);
        if max_loss_pct >= 8.0 || max_rtt_ms > 400 {
            // Severe burst/stall: immediate fast downshift + strong FEC redundancy
            if self.upshift_probe_ticks > 0 {
                self.hold_ticks_req = (self.hold_ticks_req * 2).min(1500);
            }
            self.bitrate_bps = 24_000;
            self.fec_enabled = true;
            self.expected_loss_pct = 12;
            self.clean_ticks = 0;
            self.upshift_probe_ticks = 0;
        } else if max_loss_pct > 4.0 || max_rtt_ms > 300 {
            if self.upshift_probe_ticks > 0 {
                self.hold_ticks_req = (self.hold_ticks_req * 2).min(1500);
            }
            self.bitrate_bps = 24_000;
            self.fec_enabled = true;
            self.expected_loss_pct = 8;
            self.clean_ticks = 0;
            self.upshift_probe_ticks = 0;
        } else if max_loss_pct > 2.0 || max_rtt_ms > 180 {
            if self.upshift_probe_ticks > 0 {
                self.hold_ticks_req = (self.hold_ticks_req * 2).min(1500);
            }
            self.bitrate_bps = self.bitrate_bps.min(32_000).min(cap);
            self.fec_enabled = true;
            self.expected_loss_pct = 4;
            self.clean_ticks = 0;
            self.upshift_probe_ticks = 0;
        } else {
            self.upshift_probe_ticks = self.upshift_probe_ticks.saturating_sub(1);
            if self.bitrate_bps > cap {
                self.bitrate_bps = cap;
                self.clean_ticks = 0;
            } else {
                self.clean_ticks = self.clean_ticks.saturating_add(1);
                if self.clean_ticks >= self.hold_ticks_req {
                    self.clean_ticks = 0;
                    let next = match self.bitrate_bps {
                        0..=24_000 => 32_000,
                        24_001..=32_000 => 48_000,
                        32_001..=48_000 => 64_000,
                        _ => 72_000,
                    }
                    .min(cap);
                    if next > self.bitrate_bps {
                        self.bitrate_bps = next;
                        // Monitor next 2 s closely in case upshift triggers congestion again
                        self.upshift_probe_ticks = 100;
                    }
                    self.expected_loss_pct = 5;
                    self.hold_ticks_req = 500;
                }
            }
        }
        prev != (self.bitrate_bps, self.fec_enabled, self.expected_loss_pct)
    }
}

/// Passive serverless uplink bandwidth estimator driven by UDP WouldBlock signals,
/// aggregate outbound packet loss, and simultaneous RTT inflation across voice targets.
#[derive(Debug, Clone)]
pub struct UplinkBandwidthTracker {
    est_kbps: u32,
    clean_ticks: u32,
}

impl Default for UplinkBandwidthTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl UplinkBandwidthTracker {
    pub const INITIAL_KBPS: u32 = 1000;
    pub const MIN_KBPS: u32 = 80;
    pub const MAX_KBPS: u32 = 2400;

    pub fn new() -> Self {
        Self {
            est_kbps: Self::INITIAL_KBPS,
            clean_ticks: 0,
        }
    }

    pub fn est_kbps(&self) -> u32 {
        self.est_kbps
    }

    pub fn record_would_block(&mut self) {
        self.clean_ticks = 0;
        self.est_kbps = ((self.est_kbps * 3) / 4).max(Self::MIN_KBPS);
    }

    /// Updates passive upload estimate from periodic peer loss & RTT telemetry.
    pub fn observe_network(
        &mut self,
        active_tx_peers: usize,
        avg_loss_pct: f32,
        max_loss_pct: f32,
        max_rtt_ms: u32,
        baseline_rtt_ms: u32,
    ) -> u32 {
        let rtt_inflated = baseline_rtt_ms > 0 && max_rtt_ms > baseline_rtt_ms.saturating_add(75);
        let congested =
            avg_loss_pct >= 3.0 || (active_tx_peers >= 2 && (max_loss_pct >= 5.0 || rtt_inflated));
        if congested {
            self.clean_ticks = 0;
            self.est_kbps = ((self.est_kbps * 4) / 5).max(Self::MIN_KBPS);
        } else if active_tx_peers > 0 && max_loss_pct < 1.0 && !rtt_inflated {
            self.clean_ticks = self.clean_ticks.saturating_add(1);
            if self.clean_ticks >= 3 {
                self.clean_ticks = 0;
                self.est_kbps = (self.est_kbps + 120).min(Self::MAX_KBPS);
            }
        }
        self.est_kbps
    }
}

/// Mixes mono 48 kHz peer frames into interleaved stereo with per-peer gain, optional pan, and soft master limit.
pub fn mix_mono_peers_to_stereo(
    sources: &[(&[f32], f32 /* gain 0..=2 */, f32 /* pan -1..=1 */)],
    stereo_out: &mut [f32],
) {
    stereo_out.fill(0.0);
    let frames = stereo_out.len() / 2;
    for &(mono, gain, pan) in sources {
        let g = gain.clamp(0.0, 2.0);
        if g <= 0.0001 {
            continue;
        }
        let p = pan.clamp(-1.0, 1.0);
        // Constant-power-ish gentle pan
        let left_g = g * ((1.0 - p) * 0.5).sqrt() * std::f32::consts::SQRT_2;
        let right_g = g * ((1.0 + p) * 0.5).sqrt() * std::f32::consts::SQRT_2;
        let n = frames.min(mono.len());
        for i in 0..n {
            let s = mono[i];
            stereo_out[i * 2] += s * left_g;
            stereo_out[i * 2 + 1] += s * right_g;
        }
    }
    for s in stereo_out.iter_mut() {
        *s = soft_limit(*s, 0.98);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn burst_env(len: usize, seed: u32) -> Vec<f32> {
        let mut rng = seed;
        let mut out = Vec::with_capacity(len);
        let mut on = true;
        while out.len() < len {
            rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
            let seg = 20 + ((rng >> 16) % 40) as usize;
            rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
            let amp = 0.05 + ((rng >> 16) % 150) as f32 / 1000.0;
            for k in 0..seg {
                let wobble = 1.0 + 0.3 * ((k as f32) * 0.7).sin();
                out.push(if on { amp * wobble } else { 0.0 });
            }
            on = !on;
        }
        out.truncate(len);
        out
    }

    fn noise_frame(rng: &mut u32, rms: f32, n: usize) -> Vec<f32> {
        (0..n)
            .map(|_| {
                *rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
                let u = ((*rng >> 16) as f32 / 32768.0) - 1.0;
                u * rms * 1.732
            })
            .collect()
    }

    #[test]
    fn rx_echo_suppressor_ducks_own_voice_returning_from_peer() {
        let total_halves = 800usize;
        let lag = 35usize; // 350 ms round trip
        let own = burst_env(total_halves, 7);
        let mut sup = RxEchoSuppressor::new();
        let mut rng = 99u32;
        let (mut in_e, mut out_e) = (0.0f32, 0.0f32);
        for t in 0..total_halves / 2 {
            let n = (t + 1) * 2;
            let own_slice = &own[..n];
            let mut pcm = Vec::new();
            for h in 0..2 {
                let k = t * 2 + h;
                let e = if k >= lag { 0.3 * own[k - lag] } else { 0.0 };
                pcm.extend(noise_frame(&mut rng, e, 480));
            }
            let before = pcm.iter().map(|s| s * s).sum::<f32>();
            sup.process_20ms(own_slice, &mut pcm);
            let after = pcm.iter().map(|s| s * s).sum::<f32>();
            if t > 250 {
                in_e += before;
                out_e += after;
            }
        }
        let atten_db = 10.0 * (in_e / (out_e + 1e-12)).log10();
        assert!(atten_db >= 12.0, "echo attenuation too weak: {atten_db:.1} dB");
    }

    #[test]
    fn rx_echo_suppressor_leaves_independent_peer_speech_untouched() {
        let total_halves = 800usize;
        let own = burst_env(total_halves, 7);
        let peer = burst_env(total_halves, 12345);
        let mut sup = RxEchoSuppressor::new();
        let mut rng = 5u32;
        let (mut in_e, mut out_e) = (0.0f32, 0.0f32);
        for t in 0..total_halves / 2 {
            let n = (t + 1) * 2;
            let mut pcm = Vec::new();
            for h in 0..2 {
                pcm.extend(noise_frame(&mut rng, peer[t * 2 + h], 480));
            }
            let before = pcm.iter().map(|s| s * s).sum::<f32>();
            sup.process_20ms(&own[..n], &mut pcm);
            let after = pcm.iter().map(|s| s * s).sum::<f32>();
            in_e += before;
            out_e += after;
        }
        let loss_db = 10.0 * (in_e / (out_e + 1e-12)).log10();
        assert!(loss_db < 1.5, "independent speech must not be ducked: {loss_db:.2} dB");
    }

    #[test]
    fn rx_echo_suppressor_catches_agc_boosted_compressed_echo() {
        let total_halves = 800usize;
        let lag = 35usize; // 350 ms round trip
        let own = burst_env(total_halves, 7);
        let mut sup = RxEchoSuppressor::new();
        let mut rng = 123u32;
        let (mut in_e, mut out_e) = (0.0f32, 0.0f32);
        for t in 0..total_halves / 2 {
            let n = (t + 1) * 2;
            let own_slice = &own[..n];
            let mut pcm = Vec::new();
            for h in 0..2 {
                let k = t * 2 + h;
                // Peer AGC2 boosts & nonlinearly compresses our leaked voice
                let e = if k >= lag && own[k - lag] > 0.001 {
                    (2.5 * own[k - lag].powf(0.65)).min(0.65)
                } else {
                    0.0
                };
                pcm.extend(noise_frame(&mut rng, e, 480));
            }
            let before = pcm.iter().map(|s| s * s).sum::<f32>();
            sup.process_20ms(own_slice, &mut pcm);
            let after = pcm.iter().map(|s| s * s).sum::<f32>();
            if t > 250 {
                in_e += before;
                out_e += after;
            }
        }
        let atten_db = 10.0 * (in_e / (out_e + 1e-12)).log10();
        assert!(
            atten_db >= 12.0,
            "AGC-boosted/compressed returning echo attenuation too weak: {atten_db:.1} dB"
        );
    }

    #[test]
    fn rnnoise_scaling_actually_attenuates_synthetic_noise() {
        let mut denoiser = VoiceDenoiser::new();
        let mut out = [0.0f32; VOICE_FRAME_10MS];
        let mut rng = 0x1234_5678u32;
        let mut final_rms = 0.0f32;
        // Feed 30 frames of steady low-level white noise (~ -32 dBFS) so RNN adapts
        for _ in 0..30 {
            let mut noise = [0.0f32; VOICE_FRAME_10MS];
            for sample in &mut noise {
                rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
                let u = ((rng >> 16) as f32 / 32768.0) - 1.0;
                *sample = u * 0.025;
            }
            let _ = denoiser.process_10ms(NoiseSuppressionMode::Strong, &noise, &mut out);
            final_rms = (out.iter().map(|s| s * s).sum::<f32>() / out.len() as f32).sqrt();
        }
        assert!(
            final_rms < 0.006,
            "RNNoise must significantly attenuate steady noise when scaled to +/-32768; got rms={final_rms}"
        );
    }

    #[test]
    fn voice_gate_hysteresis_preroll_hangover_and_click_free_ramps() {
        let mut gate = VoiceGate::new();
        let mut out = [[0.0f32; VOICE_FRAME_10MS]; 3];
        let quiet = [0.0005f32; VOICE_FRAME_10MS];
        let loud = [0.25f32; VOICE_FRAME_10MS];

        // 2 quiet frames fill pre-roll without opening
        assert_eq!(
            gate.process_10ms(&quiet, 0.1, -40.0, true, None, false, &mut out)
                .0,
            0
        );
        assert_eq!(
            gate.process_10ms(&quiet, 0.1, -40.0, true, None, false, &mut out)
                .0,
            0
        );

        // Loud speech opens gate and flushes 2 pre-roll frames + current frame = 3 frames
        let (cnt, open, _) = gate.process_10ms(&loud, 0.9, -40.0, true, None, false, &mut out);
        assert_eq!(cnt, 3);
        assert!(open);
        // Smooth ramp: very first pre-roll sample is near 0 (click-free), end is ramped up
        assert!(out[0][0].abs() < 0.001);
        assert!(out[0][VOICE_FRAME_10MS - 1].abs() > 0.0);

        // Dropping below threshold stays open for 20 hangover frames (200 ms)
        for _ in 0..20 {
            let (c, is_open, _) =
                gate.process_10ms(&quiet, 0.0, -40.0, true, None, false, &mut out);
            assert_eq!(c, 1);
            assert!(is_open);
        }
        // 21st quiet frame starts closing with ramp-down, then goes silent
        let (c_close, _, _) = gate.process_10ms(&quiet, 0.0, -40.0, true, None, false, &mut out);
        assert_eq!(c_close, 1);
        let (c_closed, is_open_after, _) =
            gate.process_10ms(&quiet, 0.0, -40.0, true, None, false, &mut out);
        assert_eq!(c_closed, 0);
        assert!(!is_open_after);

        // Background room noise (0 speech_prob at -44 dB) or faint residual speech_prob (0.28)
        // must NOT hold the VAD-assisted gate stuck open after speech ends.
        let (_, open2, _) = gate.process_10ms(&loud, 0.9, -40.0, true, None, false, &mut out);
        assert!(open2);
        let room_noise = [0.0063f32; VOICE_FRAME_10MS]; // ~-44 dBFS (within 4 dB of -40 dB)
        for _ in 0..22 {
            gate.process_10ms(&room_noise, 0.05, -40.0, true, None, false, &mut out);
        }
        let (_, still_open_noise, _) =
            gate.process_10ms(&room_noise, 0.05, -40.0, true, None, false, &mut out);
        assert!(!still_open_noise, "Room noise must not hold VAD gate open");

        let (_, open3, _) = gate.process_10ms(&loud, 0.9, -40.0, true, None, false, &mut out);
        assert!(open3);
        for _ in 0..22 {
            gate.process_10ms(&quiet, 0.28, -40.0, true, None, false, &mut out);
        }
        let (_, still_open_prob, _) =
            gate.process_10ms(&quiet, 0.28, -40.0, true, None, false, &mut out);
        assert!(
            !still_open_prob,
            "Quiet residual speech_prob=0.28 must not hold VAD gate open"
        );
    }

    #[test]
    fn compressor_and_limiter_respect_ceiling() {
        let mut comp = VoiceCompressor::new();
        let mut loud = vec![1.8f32; VOICE_FRAME_20MS];
        comp.process_in_place(&mut loud, true);
        let max_sample = loud.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(
            max_sample <= VoiceCompressor::LIMITER_CEILING + 1e-4,
            "max_sample={max_sample}"
        );
    }

    #[test]
    fn jitter_buffer_reorders_handles_loss_epoch_and_drift() {
        let mut jb = PeerJitterBuffer::new();
        // Target initial is 2 frames; push seq 2 then seq 1 out of order
        jb.push(
            JitterPacket {
                seq: 2,
                epoch: 1,
                ts_48k: 960 * 2,
                end_of_talk: false,
                opus: vec![2],
            },
            40,
        );
        jb.push(
            JitterPacket {
                seq: 1,
                epoch: 1,
                ts_48k: 960,
                end_of_talk: false,
                opus: vec![1],
            },
            42,
        );

        let (p1, fec1, plc1) = jb.pop_step();
        assert_eq!(p1.as_deref(), Some(&[1u8][..]));
        assert!(!fec1 && !plc1);

        let (p2, _, _) = jb.pop_step();
        assert_eq!(p2.as_deref(), Some(&[2u8][..]));

        // Simulate missing seq 3 while seq 4 is present -> triggers FEC on seq 4
        jb.push(
            JitterPacket {
                seq: 4,
                epoch: 1,
                ts_48k: 960 * 4,
                end_of_talk: false,
                opus: vec![4],
            },
            80,
        );
        let (p3, fec3, plc3) = jb.pop_step();
        assert_eq!(p3.as_deref(), Some(&[4u8][..]));
        assert!(fec3 && !plc3);

        // Epoch change flushes old stream cleanly
        jb.push(
            JitterPacket {
                seq: 0,
                epoch: 2,
                ts_48k: 0,
                end_of_talk: false,
                opus: vec![9],
            },
            100,
        );
        assert_eq!(jb.frames.len(), 1);
    }

    #[test]
    fn token_bucket_enforces_burst_and_refill() {
        let mut tb = PeerTokenBucket::new_voice_default(0);
        for _ in 0..24 {
            assert!(tb.allow(0));
        }
        assert!(!tb.allow(0));
        assert!(tb.allow(20)); // +1.3 tokens @ 65 pps

        let mut relay_tb = PeerTokenBucket::new_relay_hop(0);
        for _ in 0..48 {
            assert!(relay_tb.allow(0));
        }
        assert!(!relay_tb.allow(0));
        assert!(relay_tb.allow(20)); // +6 tokens @ 300 pps
    }

    #[test]
    fn peer_rx_leveler_ignores_plc_and_jitter_buffer_respects_min_target_frames() {
        let mut lvl = PeerRxLeveler::new();
        let mut loud = [0.4f32; VOICE_FRAME_20MS];
        lvl.process_in_place_with_plc(&mut loud, false, true);
        let gain_before_plc = lvl.gain_smooth;
        let env_before_plc = lvl.env_rms;

        let mut plc_frame = [0.0001f32; VOICE_FRAME_20MS];
        for _ in 0..10 {
            lvl.process_in_place_with_plc(&mut plc_frame, true, true);
        }
        assert!((lvl.gain_smooth - gain_before_plc).abs() < 1e-6);
        assert!((lvl.env_rms - env_before_plc).abs() < 1e-6);

        let mut jb = PeerJitterBuffer::new();
        jb.set_min_target_frames(2);
        for seq in 0u16..10 {
            jb.push(
                JitterPacket {
                    seq,
                    epoch: 1,
                    ts_48k: (seq as u32) * 960,
                    end_of_talk: false,
                    opus: vec![1, 2, 3],
                },
                (seq as u64) * 20, // 0 ms jitter -> raw target_frames=1, clamped to min_target_frames=2
            );
        }
        assert_eq!(jb.target_delay_ms(), 40);
    }

    #[test]
    fn adaptive_nlms_echo_canceller_achieves_15db_erle_on_synthetic_echo_path() {
        let mut aec = AdaptiveNlmsEchoCanceller::new();
        let mut rng = 0x55AA_1234u32;
        let mut far_history = vec![0.0f32; 200 * VOICE_FRAME_10MS];
        for s in &mut far_history {
            rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
            *s = (((rng >> 16) as f32 / 32768.0) - 1.0) * 0.35;
        }

        // Synthetic 3-tap room impulse response inside 10 ms (~120..310 samples delay)
        let mut echo_pow_last = 0.0f64;
        let mut resid_pow_last = 0.0f64;
        let mut out = [0.0f32; VOICE_FRAME_10MS];
        for frame_idx in 0..200usize {
            let base = frame_idx * VOICE_FRAME_10MS;
            let mut far_frame = [0.0f32; VOICE_FRAME_10MS];
            let mut mic_frame = [0.0f32; VOICE_FRAME_10MS];
            for i in 0..VOICE_FRAME_10MS {
                let g = base + i;
                far_frame[i] = far_history[g];
                let d1 = g.checked_sub(140).map_or(0.0, |k| far_history[k] * 0.55);
                let d2 = g.checked_sub(260).map_or(0.0, |k| far_history[k] * 0.25);
                let d3 = g.checked_sub(420).map_or(0.0, |k| far_history[k] * 0.12);
                mic_frame[i] = d1 + d2 + d3;
            }
            aec.process_10ms(&mic_frame, Some(&far_frame), &mut out);
            if frame_idx >= 160 {
                for (&m, &r) in mic_frame.iter().zip(out.iter()) {
                    echo_pow_last += (m as f64) * (m as f64);
                    resid_pow_last += (r as f64) * (r as f64);
                }
            }
        }
        let erle_db = 10.0 * (echo_pow_last / resid_pow_last.max(1e-12)).log10();
        assert!(
            erle_db >= 15.0,
            "Adaptive NLMS AEC must reach >= 15 dB ERLE on synthetic echo path; got {erle_db:.2} dB"
        );
    }

    #[test]
    fn speaker_echo_detector_discriminates_echo_vs_independent_speech() {
        let mut det = SpeakerEchoDetector::new();
        // Feed correlated delayed playback -> mic envelope (lag 40 ms = 4 frames)
        let mut far_hist = Vec::new();
        for t in 0..160usize {
            let far = if (t / 8) % 2 == 0 { 0.22 } else { 0.02 };
            far_hist.push(far);
            let near = if t >= 4 {
                far_hist[t - 4] * 0.6 + 0.01
            } else {
                0.01
            };
            det.push_10ms_rms(far, near);
        }
        assert!(
            det.detected(),
            "Should detect correlated speaker leak; corr={}",
            det.peak_correlation()
        );

        // Reset and feed independent non-periodic near-end talk while far-end is different
        det.reset();
        for t in 0..160usize {
            let far = if t % 30 < 10 { 0.25 } else { 0.0 };
            let near = if (95..130).contains(&t) { 0.22 } else { 0.0 };
            det.push_10ms_rms(far, near);
        }
        assert!(
            !det.detected(),
            "Must not falsely flag independent near-end speech as speaker echo; corr={}",
            det.peak_correlation()
        );
    }

    #[test]
    fn golden_dsp_corpus_fan_music_quiet_speaker_and_calibrator() {
        // 1. Steady fan noise must have near-zero false gate opens at calibrated threshold
        let mut gate = VoiceGate::new();
        let mut denoiser = VoiceDenoiser::new();
        let mut out = [[0.0f32; VOICE_FRAME_10MS]; 3];
        let mut ns = [0.0f32; VOICE_FRAME_10MS];
        let mut rng = 0xCAFE_BABEu32;
        let mut fan_opens = 0usize;
        let mut cal = VoiceCalibrator::default();
        for i in 0..150usize {
            let mut fan = [0.0f32; VOICE_FRAME_10MS];
            for s in &mut fan {
                rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
                *s = (((rng >> 16) as f32 / 32768.0) - 1.0) * 0.015; // ~ -40 dBFS fan
            }
            let prob = denoiser.process_10ms(NoiseSuppressionMode::Balanced, &fan, &mut ns);
            cal.push_quiet_db(frame_dbfs(&ns));
            if i >= 20 {
                let (_, open, _) = gate.process_10ms(&ns, prob, -38.0, true, None, false, &mut out);
                if open {
                    fan_opens += 1;
                }
            }
        }
        assert!(fan_opens <= 2, "Fan false-open count too high: {fan_opens}");

        // 2. Music preservation in Off mode stays bit-exact and quiet speaker opens with pre-roll
        let mut music = [0.0f32; VOICE_FRAME_10MS];
        for (i, s) in music.iter_mut().enumerate() {
            *s = 0.2 * ((2.0 * std::f32::consts::PI * 220.0 * (i as f32) / 48_000.0).sin());
        }
        denoiser.process_10ms(NoiseSuppressionMode::Off, &music, &mut ns);
        assert_eq!(music, ns, "Off mode must preserve music bit-for-bit");

        // Quiet speech (~ -32 dBFS harmonic speech signal) opens within 1 frame and flushes pre-roll
        let mut speech = [0.0f32; VOICE_FRAME_10MS];
        for (i, s) in speech.iter_mut().enumerate() {
            let t = (i as f32) / 48_000.0;
            *s = 0.045
                * ((2.0 * std::f32::consts::PI * 185.0 * t).sin()
                    + 0.4 * (2.0 * std::f32::consts::PI * 370.0 * t).sin());
        }
        cal.push_speak_db(frame_dbfs(&speech));
        gate.reset();
        gate.process_10ms(
            &[0.001; VOICE_FRAME_10MS],
            0.1,
            -36.0,
            false,
            None,
            false,
            &mut out,
        );
        let (cnt, is_open, _) =
            gate.process_10ms(&speech, 0.9, -36.0, false, None, false, &mut out);
        assert!(
            is_open && cnt >= 2,
            "Quiet speaker must open immediately with pre-roll (cnt={cnt})"
        );

        let (noise_floor, speech_peak, rec) = cal.finalize();
        assert!(rec > noise_floor && rec < speech_peak, "Calibrator midpoint out of range: noise={noise_floor}, speech={speech_peak}, rec={rec}");
    }

    #[test]
    fn abr_fast_downshift_slow_probed_upshift_and_jitter_stall_growth() {
        let mut abr = AdaptiveBitrateController::new();
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps(7, 0),
            24_000
        );
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps(4, 0),
            32_000
        );

        // Spike drops immediately to 24 kbps
        assert!(abr.update(9.5, 90));
        assert_eq!(abr.bitrate_bps(), 24_000);
        assert_eq!(abr.expected_loss_pct(), 12);

        // Slow recovery: 100 clean ticks must NOT upshift yet
        for _ in 0..100 {
            assert!(!abr.update(0.0, 40));
        }
        assert_eq!(abr.bitrate_bps(), 24_000);

        // 400 more clean ticks probe 32 kbps
        let mut changed = false;
        for _ in 0..400 {
            if abr.update(0.0, 40) {
                changed = true;
            }
        }
        assert!(changed);
        assert_eq!(abr.bitrate_bps(), 32_000);

        // Burst stall grows PeerJitterBuffer target cushion above 40 ms
        let mut jb = PeerJitterBuffer::new();
        jb.push(
            JitterPacket {
                seq: 1,
                epoch: 1,
                ts_48k: 960,
                end_of_talk: false,
                opus: vec![1],
            },
            20,
        );
        jb.push(
            JitterPacket {
                seq: 2,
                epoch: 1,
                ts_48k: 1920,
                end_of_talk: false,
                opus: vec![2],
            },
            40,
        );
        jb.push(
            JitterPacket {
                seq: 10,
                epoch: 1,
                ts_48k: 9600,
                end_of_talk: false,
                opus: vec![10],
            },
            200,
        );
        assert!(jb.pop_step().0.is_some()); // seq 1
        assert!(jb.pop_step().0.is_some()); // seq 2
                                            // Repeated missing packets trigger underruns & grow target_delay_ms
        for _ in 0..4 {
            let _ = jb.pop_step();
        }
        assert!(jb.underrun_count() >= 2);
        assert!(
            jb.target_delay_ms() > 40,
            "Expected stall cushion growth, got {} ms",
            jb.target_delay_ms()
        );
    }

    #[test]
    fn nlms_aec_cancels_echo_across_60ms_driver_bulk_delay() {
        let mut aec = AdaptiveNlmsEchoCanceller::new();
        aec.set_delay_frames(6); // 60 ms bulk driver buffering delay
        let mut rng = 0xAA11_2233u32;
        let bulk_samples = 6 * VOICE_FRAME_10MS;
        let total_frames = 220usize;
        let mut far_history = vec![0.0f32; total_frames * VOICE_FRAME_10MS];
        for s in &mut far_history {
            rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
            *s = (((rng >> 16) as f32 / 32768.0) - 1.0) * 0.35;
        }

        let mut echo_pow_last = 0.0f64;
        let mut resid_pow_last = 0.0f64;
        let mut out = [0.0f32; VOICE_FRAME_10MS];
        for frame_idx in 0..total_frames {
            let base = frame_idx * VOICE_FRAME_10MS;
            let mut far_frame = [0.0f32; VOICE_FRAME_10MS];
            let mut mic_frame = [0.0f32; VOICE_FRAME_10MS];
            for i in 0..VOICE_FRAME_10MS {
                let g = base + i;
                far_frame[i] = far_history[g];
                let d1 = g
                    .checked_sub(bulk_samples + 120)
                    .map_or(0.0, |k| far_history[k] * 0.52);
                let d2 = g
                    .checked_sub(bulk_samples + 280)
                    .map_or(0.0, |k| far_history[k] * 0.24);
                mic_frame[i] = d1 + d2;
            }
            aec.process_10ms(&mic_frame, Some(&far_frame), &mut out);
            if frame_idx >= 180 {
                for (&m, &r) in mic_frame.iter().zip(out.iter()) {
                    echo_pow_last += (m as f64) * (m as f64);
                    resid_pow_last += (r as f64) * (r as f64);
                }
            }
        }
        let erle_db = 10.0 * (echo_pow_last / resid_pow_last.max(1e-12)).log10();
        assert!(
            erle_db >= 15.0,
            "Delay-aligned NLMS AEC must reach >= 15 dB ERLE across 60 ms bulk delay; got {erle_db:.2} dB"
        );
    }

    #[test]
    fn jitter_buffer_sheds_240ms_os_stall_backlog_within_100ms() {
        let mut jb = PeerJitterBuffer::new();
        jb.push(
            JitterPacket {
                seq: 1,
                epoch: 1,
                ts_48k: 960,
                end_of_talk: false,
                opus: vec![1],
            },
            20,
        );
        jb.push(
            JitterPacket {
                seq: 2,
                epoch: 1,
                ts_48k: 1920,
                end_of_talk: false,
                opus: vec![2],
            },
            40,
        );
        assert!(jb.pop_step().0.is_some());

        // Simulate 240 ms OS stall dumping 12 queued packets at once (seqs 3..=14)
        for seq in 3..=14u16 {
            jb.push(
                JitterPacket {
                    seq,
                    epoch: 1,
                    ts_48k: (seq as u32) * 960,
                    end_of_talk: false,
                    opus: vec![seq as u8],
                },
                280,
            );
        }
        // Within 5 ticks (100 ms), excess backlog must shed down without waiting 25 seconds
        for _ in 0..5 {
            let _ = jb.pop_step();
        }
        assert!(
            jb.current_delay_ms() <= jb.target_delay_ms() + 60,
            "240 ms backlog failed to drain quickly: current={} ms, target={} ms",
            jb.current_delay_ms(),
            jb.target_delay_ms()
        );
    }

    #[test]
    fn uplink_bandwidth_tracker_detects_saturation_and_triggers_low_room_cap() {
        let mut tr = UplinkBandwidthTracker::new();
        assert_eq!(tr.est_kbps(), UplinkBandwidthTracker::INITIAL_KBPS);

        tr.record_would_block();
        let after_wb = tr.est_kbps();
        assert!(after_wb < UplinkBandwidthTracker::INITIAL_KBPS);

        for _ in 0..6 {
            tr.observe_network(6, 4.5, 6.0, 210, 60);
        }
        assert!(tr.est_kbps() <= 200);
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps(6, tr.est_kbps()),
            24_000
        );

        for _ in 0..12 {
            tr.observe_network(3, 0.0, 0.2, 55, 50);
        }
        assert!(tr.est_kbps() > after_wb || tr.est_kbps() > 200);
    }

    #[test]
    fn discord_grade_denoiser_eliminates_dry_bleed_and_rejects_10ms_clicks() {
        let mut balanced = VoiceDenoiser::new();
        let mut strong = VoiceDenoiser::new();
        let mut out_bal = [0.0f32; VOICE_FRAME_10MS];
        let mut out_str = [0.0f32; VOICE_FRAME_10MS];
        let mut rng = 0x51A7_900Du32;

        // 80 frames (800 ms) of steady room fan noise (low-passed broadband rumble, ~ -34 dBFS)
        let mut lp = 0.0f32;
        let mut bal_sum = 0.0f32;
        let mut str_sum = 0.0f32;
        let mut measured = 0usize;
        for frame_idx in 0..80usize {
            let mut fan = [0.0f32; VOICE_FRAME_10MS];
            for s in &mut fan {
                rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
                let white = (((rng >> 16) as f32 / 32768.0) - 1.0) * 0.04;
                lp = lp * 0.72 + white * 0.28;
                *s = lp;
            }
            let _ = balanced.process_10ms(NoiseSuppressionMode::Balanced, &fan, &mut out_bal);
            let _ = strong.process_10ms(NoiseSuppressionMode::Strong, &fan, &mut out_str);
            if frame_idx >= 50 {
                bal_sum +=
                    (out_bal.iter().map(|s| s * s).sum::<f32>() / VOICE_FRAME_10MS as f32).sqrt();
                str_sum +=
                    (out_str.iter().map(|s| s * s).sum::<f32>() / VOICE_FRAME_10MS as f32).sqrt();
                measured += 1;
            }
        }
        let bal_rms = bal_sum / measured as f32;
        let str_rms = str_sum / measured as f32;
        // Speech-adaptive Balanced + post-RNNoise floor must crush steady fan noise with zero dry bleed
        assert!(
            bal_rms < 0.0012,
            "Balanced mode must not leak raw fan noise during silence; got rms={bal_rms}"
        );
        assert!(
            str_rms <= bal_rms + 1e-4,
            "Strong mode should suppress residual noise at least as deeply as Balanced (str={str_rms}, bal={bal_rms})"
        );

        // VoiceGate rejects a single 10 ms keyboard/mouse click (prob=0.55) but opens on 20 ms soft speech
        let mut gate = VoiceGate::new();
        let mut gout = [[0.0f32; VOICE_FRAME_10MS]; 3];
        let click = [0.012f32; VOICE_FRAME_10MS]; // ~ -38.4 dBFS
        let quiet = [0.0002f32; VOICE_FRAME_10MS];
        let (_, open_click, _) =
            gate.process_10ms(&click, 0.55, -40.0, true, None, false, &mut gout);
        assert!(!open_click, "Single 10ms click must not open VAD gate");
        let (_, open_after_click, _) =
            gate.process_10ms(&quiet, 0.10, -40.0, true, None, false, &mut gout);
        assert!(!open_after_click);

        // 2 consecutive soft-speech frames (20 ms) open the gate cleanly
        let (_, open_f1, _) = gate.process_10ms(&click, 0.52, -40.0, true, None, false, &mut gout);
        assert!(!open_f1);
        let (_, open_f2, _) = gate.process_10ms(&click, 0.54, -40.0, true, None, false, &mut gout);
        assert!(open_f2, "20ms soft speech should open VAD gate cleanly");
    }

    #[test]
    fn stage_a_declicker_tames_sharp_keyboard_impulse_pre_rnnoise() {
        let mut denoiser = VoiceDenoiser::new();
        let mut out = [0.0f32; VOICE_FRAME_10MS];
        let silence = [0.0f32; VOICE_FRAME_10MS];
        for _ in 0..10 {
            let _ = denoiser.process_10ms(NoiseSuppressionMode::Strong, &silence, &mut out);
        }
        // Inject a sharp 2.5 ms broadband mechanical switch transient in sub-window 1
        let mut frame = [0.0f32; VOICE_FRAME_10MS];
        for (i, slot) in frame.iter_mut().enumerate().take(240).skip(120) {
            *slot = if i % 2 == 0 { 0.35 } else { -0.35 };
        }
        let _ = denoiser.process_10ms(NoiseSuppressionMode::Strong, &frame, &mut out);
        let peak_out = out[120..240].iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(
            peak_out < 0.08,
            "Stage A + RNNoise must heavily attenuate sharp 2.5ms click transients; peak_out={peak_out}"
        );
    }

    #[test]
    fn speech_gated_compressor_avoids_noise_pumping_and_levels_peer_rx() {
        let mut comp = VoiceCompressor::new();
        // Low-prob noise pause must not crank up gain
        let mut noise = vec![0.008f32; VOICE_FRAME_20MS];
        comp.process_with_speech_prob(&mut noise, 0.05, true);
        let noise_rms_after =
            (noise.iter().map(|s| s * s).sum::<f32>() / noise.len() as f32).sqrt();
        assert!(
            noise_rms_after < 0.012,
            "Low speech_prob pauses must not pump room noise; got rms={noise_rms_after}"
        );

        // Loud sudden laugh peak is held safely under -1 dBFS ceiling
        let mut laugh = vec![1.6f32; VOICE_FRAME_20MS];
        comp.process_with_speech_prob(&mut laugh, 0.95, true);
        let max_s = laugh.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(
            max_s <= VoiceCompressor::LIMITER_CEILING + 1e-4,
            "max_s={max_s}"
        );

        // PeerRxLeveler pulls a quiet mic (~0.025 RMS) and loud mic (~0.35 RMS) closer together
        let mut quiet_lvl = PeerRxLeveler::new();
        let mut loud_lvl = PeerRxLeveler::new();
        let mut q_rms = 0.025f32;
        let mut l_rms = 0.35f32;
        for _ in 0..40 {
            let mut q_buf = vec![0.025f32; VOICE_FRAME_20MS];
            let mut l_buf = vec![0.35f32; VOICE_FRAME_20MS];
            quiet_lvl.process_in_place(&mut q_buf);
            loud_lvl.process_in_place(&mut l_buf);
            q_rms = (q_buf.iter().map(|s| s * s).sum::<f32>() / q_buf.len() as f32).sqrt();
            l_rms = (l_buf.iter().map(|s| s * s).sum::<f32>() / l_buf.len() as f32).sqrt();
        }
        assert!(
            q_rms > 0.045 && l_rms < 0.22,
            "PeerRxLeveler should lift quiet peer ({q_rms}) and tame loud peer ({l_rms})"
        );
    }

    #[test]
    fn abr_supports_64kbps_speech_and_72kbps_raw_music_for_small_rooms() {
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps(2, 0),
            64_000
        );
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps_for_mode(2, 0, true),
            72_000
        );
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps(4, 0),
            32_000
        );
    }

    #[test]
    fn jitter_buffer_ignores_dtx_silence_gaps_and_trims_drift_fast() {
        let mut jb = PeerJitterBuffer::new();
        assert_eq!(jb.target_delay_ms(), 40);

        // Talkspurt 1: 4 packets spaced by 20 ms
        for i in 1..=4u16 {
            jb.push(
                JitterPacket {
                    seq: i,
                    epoch: 1,
                    ts_48k: (i as u32) * 960,
                    end_of_talk: i == 4,
                    opus: vec![i as u8],
                },
                (i as u64) * 20,
            );
            let _ = jb.pop_step();
        }
        // Drain the initial 2-frame (40 ms) jitter cushion to reach end-of-talk
        let _ = jb.pop_step();
        assert!(!jb.is_active());

        // 5-second natural pause before Talkspurt 2 (ts_48k stayed frozen during silence)
        jb.push(
            JitterPacket {
                seq: 5,
                epoch: 1,
                ts_48k: 5 * 960,
                end_of_talk: false,
                opus: vec![5],
            },
            5080,
        );
        jb.push(
            JitterPacket {
                seq: 6,
                epoch: 1,
                ts_48k: 6 * 960,
                end_of_talk: false,
                opus: vec![6],
            },
            5100,
        );
        assert!(
            jb.interarrival_jitter_ms() < 5.0,
            "DTX silence gap must not pollute jitter: {}",
            jb.interarrival_jitter_ms()
        );
        assert_eq!(jb.target_delay_ms(), 20);

        // Inject +1 extra buffered packet (sustained +20 ms clock drift) and verify it trims within ~1s (55 ticks)
        let _ = jb.pop_step(); // consumes 5; leaves 6 queued
        let mut next_seq = 7u16;
        for tick in 0..55u64 {
            jb.push(
                JitterPacket {
                    seq: next_seq,
                    epoch: 1,
                    ts_48k: (next_seq as u32) * 960,
                    end_of_talk: false,
                    opus: vec![next_seq as u8],
                },
                5120 + tick * 20,
            );
            next_seq = next_seq.wrapping_add(1);
            let _ = jb.pop_step();
        }
        assert!(
            jb.current_delay_ms() <= jb.target_delay_ms(),
            "Sustained +20ms drift should drain to target_delay_ms (current={}, target={})",
            jb.current_delay_ms(),
            jb.target_delay_ms()
        );
    }

    #[test]
    fn webrtc_aec3_cancels_delayed_synthetic_echo() {
        let mut aec = WebRtcAec3Canceller::new();
        aec.set_delay_ms(60);
        let mut rng = 0x9933_4411u32;
        let delay_samples = 6 * VOICE_FRAME_10MS; // 60 ms render-to-capture delay
        let total_frames = 150usize;
        let mut far_history = vec![0.0f32; total_frames * VOICE_FRAME_10MS];
        for (i, s) in far_history.iter_mut().enumerate() {
            rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
            let noise = (((rng >> 16) as f32 / 32768.0) - 1.0) * 0.25;
            let t = i as f32 / VOICE_SAMPLE_RATE as f32;
            let tone = 0.15 * (2.0 * std::f32::consts::PI * 330.0 * t).sin();
            *s = noise + tone;
        }

        let mut echo_pow_last = 0.0f64;
        let mut resid_pow_last = 0.0f64;
        let mut out = [0.0f32; VOICE_FRAME_10MS];
        for frame_idx in 0..total_frames {
            let base = frame_idx * VOICE_FRAME_10MS;
            let mut far_frame = [0.0f32; VOICE_FRAME_10MS];
            let mut mic_frame = [0.0f32; VOICE_FRAME_10MS];
            for i in 0..VOICE_FRAME_10MS {
                let g = base + i;
                far_frame[i] = far_history[g];
                let d1 = g
                    .checked_sub(delay_samples + 96)
                    .map_or(0.0, |k| far_history[k] * 0.50);
                let d2 = g
                    .checked_sub(delay_samples + 240)
                    .map_or(0.0, |k| far_history[k] * 0.22);
                mic_frame[i] = d1 + d2;
            }
            aec.process_10ms(&mic_frame, Some(&far_frame), &mut out);
            if frame_idx >= total_frames - 50 {
                for (&m, &r) in mic_frame.iter().zip(out.iter()) {
                    echo_pow_last += (m as f64) * (m as f64);
                    resid_pow_last += (r as f64) * (r as f64);
                }
            }
        }
        let erle_db = 10.0 * (echo_pow_last / resid_pow_last.max(1e-12)).log10();
        assert!(
            erle_db >= 12.0,
            "WebRTC AEC3 must achieve >= 12 dB ERLE on delayed synthetic echo; got {erle_db:.2} dB"
        );
    }

    #[test]
    fn dfn3_denoiser_suppresses_delayed_impulse_and_preserves_off_mode() {
        let mut denoiser = VoiceDenoiser::new();
        let mut out = [0.0f32; VOICE_FRAME_10MS];

        // Off mode must be bit-exact pass-through with prob=1.0
        let mut dry = [0.0f32; VOICE_FRAME_10MS];
        for (i, s) in dry.iter_mut().enumerate() {
            *s = ((i as f32) * 0.05).sin() * 0.4;
        }
        let prob_off = denoiser.process_10ms(NoiseSuppressionMode::Off, &dry, &mut out);
        assert_eq!(prob_off, 1.0);
        assert_eq!(out, dry);

        denoiser.reset();
        let silence = [0.0f32; VOICE_FRAME_10MS];
        for _ in 0..10 {
            let _ = denoiser.process_10ms(NoiseSuppressionMode::Strong, &silence, &mut out);
        }

        // Inject sharp 2.5 ms click impulse in frame 0, then feed silence through frames 1..=4
        // so the 30 ms DeepFilterNet3 algorithmic delay window is fully observed.
        let mut click_frame = [0.0f32; VOICE_FRAME_10MS];
        for (i, slot) in click_frame.iter_mut().enumerate().take(240).skip(120) {
            *slot = if i % 2 == 0 { 0.35 } else { -0.35 };
        }
        let mut max_peak_across_delay = 0.0f32;
        for f in 0..=4 {
            let inp = if f == 0 { &click_frame } else { &silence };
            let _ = denoiser.process_10ms(NoiseSuppressionMode::Strong, inp, &mut out);
            let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
            max_peak_across_delay = max_peak_across_delay.max(peak);
        }
        assert!(
            max_peak_across_delay < 0.08,
            "DeepFilterNet3 + Stage A must keep 2.5ms click suppressed across 30 ms delay; max_peak={max_peak_across_delay}"
        );
    }

    #[test]
    fn calibrator_finalize_handles_short_quiet_samples_without_panic() {
        for count in 1..=80usize {
            let mut cal = VoiceCalibrator::default();
            for i in 0..count {
                cal.push_quiet_db(-65.0 + (i % 5) as f32);
            }
            cal.push_speak_db(-22.0);
            let (noise, speak, threshold) = cal.finalize();
            assert!(noise <= -59.0);
            assert!(speak >= -25.0);
            assert!(threshold.is_finite());
        }
    }

    #[test]
    fn quiet_mic_leveling_studio_eq_and_soft_trailing_syllable_retention() {
        // 1. Very quiet -48 dBFS speech (~0.004 RMS) gets lifted cleanly by VoiceCompressor
        let mut comp = VoiceCompressor::new();
        let mut quiet_rms = 0.004f32;
        for f_idx in 0..30usize {
            let mut frame = vec![0.0f32; VOICE_FRAME_20MS];
            for (i, s) in frame.iter_mut().enumerate() {
                let t = ((f_idx * VOICE_FRAME_20MS + i) as f32) / (VOICE_SAMPLE_RATE as f32);
                *s = 0.0055 * (2.0 * std::f32::consts::PI * 220.0 * t).sin();
            }
            comp.process_with_speech_prob(&mut frame, 0.88, true);
            quiet_rms = (frame.iter().map(|s| s * s).sum::<f32>() / (frame.len() as f32)).sqrt();
        }
        assert!(
            quiet_rms > 0.009,
            "Quiet -48 dBFS mic must be lifted cleanly by SNR-bounded AGC; got rms={quiet_rms}"
        );

        // 2. Soft trailing words (speech_prob = 0.68 at threshold - 8 dB) stay held open without mid-sentence chop
        let mut gate = VoiceGate::new();
        let mut gout = [[0.0f32; VOICE_FRAME_10MS]; 3];
        let normal_speech = [0.05f32; VOICE_FRAME_10MS]; // ~-26 dBFS
        let soft_tail = [0.004f32; VOICE_FRAME_10MS]; // ~-48 dBFS (8 dB below -40 dB threshold)
        let (_, opened, _) =
            gate.process_10ms(&normal_speech, 0.90, -40.0, true, None, false, &mut gout);
        assert!(opened);
        for _ in 0..35 {
            let (cnt, still_open, _) =
                gate.process_10ms(&soft_tail, 0.68, -40.0, true, None, false, &mut gout);
            assert!(
                still_open && cnt == 1,
                "Confident soft trailing syllables must not cut out mid-sentence"
            );
        }
    }

    #[test]
    fn bad_audio_laptop_mic_secret_sauce_benchmark() {
        use std::time::Instant;

        // Synthesizes a realistic human voiced speech frame (pitch ~135 Hz with pitch contour
        // + vowel formants F1/F2/F3 + natural 4 Hz syllable envelope) scaled to target RMS.
        fn synth_speech_frame(frame_idx: usize, target_rms: f32) -> [f32; VOICE_FRAME_10MS] {
            let mut out = [0.0f32; VOICE_FRAME_10MS];
            let mut sq = 0.0f32;
            for (i, s) in out.iter_mut().enumerate() {
                let n = frame_idx * VOICE_FRAME_10MS + i;
                let t = (n as f32) / (VOICE_SAMPLE_RATE as f32);
                let f0 = 135.0 + 18.0 * (2.0 * std::f32::consts::PI * 1.6 * t).sin();
                let syllable = 0.55 + 0.45 * (2.0 * std::f32::consts::PI * 3.8 * t).sin().abs();
                let mut v = 0.0f32;
                for h in 1..=12usize {
                    let freq = f0 * (h as f32);
                    // Vowel-like formant envelope around 500 Hz, 1450 Hz, 2600 Hz
                    let w1 = (-((freq - 500.0) / 260.0).powi(2)).exp();
                    let w2 = 0.75 * (-((freq - 1450.0) / 420.0).powi(2)).exp();
                    let w3 = 0.35 * (-((freq - 2600.0) / 600.0).powi(2)).exp();
                    let amp = (w1 + w2 + w3 + 0.08) / (h as f32).sqrt();
                    v += amp * (2.0 * std::f32::consts::PI * freq * t).sin();
                }
                *s = v * syllable;
                sq += (*s) * (*s);
            }
            let rms = (sq / VOICE_FRAME_10MS as f32).sqrt().max(1e-6);
            let scale = target_rms / rms;
            for s in out.iter_mut() {
                *s *= scale;
            }
            out
        }

        // Deterministic colored laptop fan + room hum noise generator.
        fn synth_fan_noise_frame(
            seed: &mut u64,
            lp: &mut f32,
            target_rms: f32,
        ) -> [f32; VOICE_FRAME_10MS] {
            let mut out = [0.0f32; VOICE_FRAME_10MS];
            let mut sq = 0.0f32;
            for s in out.iter_mut() {
                *seed = seed
                    .wrapping_mul(6364136223846793005)
                    .wrapping_add(1442695040888963407);
                let u = (((*seed >> 33) as u32) as f32 / (u32::MAX as f32)) * 2.0 - 1.0;
                *lp = *lp * 0.72 + u * 0.28;
                *s = *lp;
                sq += (*s) * (*s);
            }
            let rms = (sq / VOICE_FRAME_10MS as f32).sqrt().max(1e-6);
            let scale = target_rms / rms;
            for s in out.iter_mut() {
                *s *= scale;
            }
            out
        }

        let run_chain =
            |frames: &[[f32; VOICE_FRAME_10MS]], mode: NoiseSuppressionMode, threshold_db: f32| {
                let mut hpf = BiquadHighPass::new_80hz_48k();
                let mut denoiser = VoiceDenoiser::new();
                let mut agc2 = WebRtcAgc2Leveler::new();
                let mut gate = VoiceGate::new();
                let mut comp = VoiceCompressor::new();
                let mut ns_out = [0.0f32; VOICE_FRAME_10MS];
                let mut leveled = [0.0f32; VOICE_FRAME_10MS];
                let mut gate_out = [[0.0f32; VOICE_FRAME_10MS]; 3];

                let start = Instant::now();
                let mut open_frames = 0usize;
                let mut peak_abs = 0.0f32;
                let mut db_sum = 0.0f32;
                let mut db_count = 0usize;
                let mut prob_sum = 0.0f32;
                let warmup = frames.len() / 3;

                for (idx, raw) in frames.iter().enumerate() {
                    let mut f = *raw;
                    hpf.process_in_place(&mut f);
                    let prob = denoiser.process_10ms(mode, &f, &mut ns_out);
                    agc2.process_10ms(&ns_out, &mut leveled, true);
                    let (cnt, is_open, _) = gate.process_10ms(
                        &leveled,
                        prob,
                        threshold_db,
                        true,
                        None,
                        false,
                        &mut gate_out,
                    );
                    if idx >= warmup {
                        prob_sum += prob;
                        if is_open {
                            open_frames += 1;
                        }
                        let mut final_frame = leveled;
                        if cnt > 0 {
                            final_frame = gate_out[cnt - 1];
                            comp.process_with_speech_prob(&mut final_frame, prob, true);
                        }
                        for &s in &final_frame {
                            peak_abs = peak_abs.max(s.abs());
                        }
                        db_sum += frame_dbfs(&final_frame);
                        db_count += 1;
                    }
                }
                let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
                let avg_db = db_sum / (db_count.max(1) as f32);
                let open_pct = (open_frames as f32) * 100.0 / (db_count.max(1) as f32);
                let avg_prob = prob_sum / (db_count.max(1) as f32);
                let ms_per_frame = elapsed_ms / (frames.len() as f64);
                (avg_db, open_pct, avg_prob, peak_abs, ms_per_frame)
            };

        let mut seed = 0xCAFE_BABE_1234_5678u64;
        let mut lp = 0.0f32;

        // Scenario 1: Distant laptop mic (-34 dBFS ~ 0.020 RMS) buried in louder fan (-30 dBFS ~ 0.032 RMS, -4 dB SNR)
        let s1: Vec<_> = (0..180)
            .map(|i| {
                let sp = synth_speech_frame(i, 0.020);
                let nz = synth_fan_noise_frame(&mut seed, &mut lp, 0.032);
                let mut mix = [0.0f32; VOICE_FRAME_10MS];
                for j in 0..VOICE_FRAME_10MS {
                    mix[j] = (sp[j] + nz[j]).clamp(-1.0, 1.0);
                }
                mix
            })
            .collect();
        let (s1_db, s1_open, s1_prob, s1_peak, s1_ms) =
            run_chain(&s1, NoiseSuppressionMode::Strong, -42.0);
        println!(
            "[S1 Distant -34dB + Louder Fan -30dB (-4dB SNR)] out={s1_db:.1} dBFS open={s1_open:.1}% prob={s1_prob:.2} peak={s1_peak:.3} cpu={s1_ms:.2} ms/10ms"
        );

        // Scenario 2: Distance swing — Close-up loud (-6 dBFS ~ 0.50) vs Far quiet (-38 dBFS ~ 0.0126)
        let s2_close: Vec<_> = (0..150).map(|i| synth_speech_frame(i, 0.45)).collect();
        let s2_far: Vec<_> = (0..150).map(|i| synth_speech_frame(i, 0.0126)).collect();
        let (c_db, c_open, _, c_peak, _) =
            run_chain(&s2_close, NoiseSuppressionMode::Balanced, -42.0);
        let (f_db, f_open, _, f_peak, _) =
            run_chain(&s2_far, NoiseSuppressionMode::Balanced, -42.0);
        let swing_diff = (c_db - f_db).abs();
        println!(
            "[S2 Distance Swing 31dB input delta] close={c_db:.1} dBFS ({c_open:.0}% open, peak={c_peak:.3}) | far={f_db:.1} dBFS ({f_open:.0}% open, peak={f_peak:.3}) | out_delta={swing_diff:.1} dB"
        );

        // Scenario 3: Whisper-level quiet speech (-45 dBFS ~ 0.0056 RMS) in quiet room
        let s3: Vec<_> = (0..150).map(|i| synth_speech_frame(i, 0.0056)).collect();
        let (s3_db, s3_open, s3_prob, _, _) = run_chain(&s3, NoiseSuppressionMode::Balanced, -42.0);
        println!(
            "[S3 Soft Whisper -45dB] out={s3_db:.1} dBFS open={s3_open:.1}% prob={s3_prob:.2}"
        );

        // Scenario 4: Pure heavy noise (loud fan -24 dBFS + keyboard click impulses every 15 frames, NO speech)
        let s4: Vec<_> = (0..180)
            .map(|i| {
                let mut nz = synth_fan_noise_frame(&mut seed, &mut lp, 0.06);
                if i % 15 == 5 {
                    for j in 20..36 {
                        nz[j] = if j % 2 == 0 { 0.72 } else { -0.68 };
                    }
                }
                nz
            })
            .collect();
        let (s4_db, s4_open, s4_prob, _, _) = run_chain(&s4, NoiseSuppressionMode::Strong, -42.0);
        println!(
            "[S4 Pure Fan -24dB + Keyboard Clicks] out={s4_db:.1} dBFS false_open={s4_open:.1}% prob={s4_prob:.2}"
        );

        assert!(
            s1_open >= 70.0,
            "Distant speech in loud fan must open gate reliably; got {s1_open:.1}%"
        );
        assert!(
            swing_diff <= 14.0,
            "31 dB distance swing should compress to <= 14 dB output delta; got {swing_diff:.1} dB"
        );
        assert!(
            c_peak <= 0.99,
            "Close-up speech must never clip; got peak={c_peak}"
        );
        assert!(
            s3_open >= 80.0,
            "Soft -45 dBFS speech should open gate reliably; got {s3_open:.1}%"
        );
        assert!(
            s4_open <= 5.0,
            "Pure heavy fan + keyboard clicks must not false-trigger gate; got {s4_open:.1}%"
        );
        assert!(
            s4_db <= -45.0,
            "Pure heavy noise floor must be suppressed deeply; got {s4_db:.1} dBFS"
        );
    }

    #[test]
    fn aura_weights_load_and_denoise_cleanly() {
        let mut aura = VoiceDenoiser::new_aura();
        let mut seed = 0x9E37_79B9u32;
        let mut lp = 0.0f32;
        let mut out = [0.0f32; VOICE_FRAME_10MS];
        let mut max_out_db = -120.0f32;
        for i in 0..80 {
            let mut nz = [0.0f32; VOICE_FRAME_10MS];
            for s in &mut nz {
                seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
                let white = ((seed >> 9) as f32 / ((1u32 << 23) as f32)) * 2.0 - 1.0;
                lp = lp * 0.85 + white * 0.15;
                *s = lp * 0.04;
            }
            let _ = aura.process_10ms(NoiseSuppressionMode::Balanced, &nz, &mut out);
            if i >= 40 {
                max_out_db = max_out_db.max(frame_dbfs(&out));
            }
        }
        assert!(
            max_out_db < -35.0,
            "Aura-trained model should suppress stationary fan noise cleanly, got {max_out_db:.1} dBFS"
        );
    }

    #[test]
    fn aura_rust_vs_pytorch_parity_diagnostic() {
        let noisy_path =
            std::path::Path::new("C:/epilod-aura-lab/ablation_pairs/dry_n573_snr0.wav");
        let clean_path =
            std::path::Path::new("C:/epilod-aura-lab/samples/clean_freesound_33711.wav");
        if !noisy_path.exists() || !clean_path.exists() {
            return;
        }
        let (_, noisy) = crate::wav_io::read_wav_mono_f32(noisy_path).unwrap();
        let (_, clean) = crate::wav_io::read_wav_mono_f32(clean_path).unwrap();
        let si_sdr = |est: &[f32], ref_s: &[f32]| -> f32 {
            let n = est.len().min(ref_s.len());
            let me = est[..n].iter().sum::<f32>() / n as f32;
            let mr = ref_s[..n].iter().sum::<f32>() / n as f32;
            let mut dot = 0.0f64;
            let mut re = 0.0f64;
            for i in 0..n {
                let e = (est[i] - me) as f64;
                let r = (ref_s[i] - mr) as f64;
                dot += e * r;
                re += r * r;
            }
            let scale = dot / (re + 1e-10);
            let mut s_en = 0.0f64;
            let mut n_en = 0.0f64;
            for i in 0..n {
                let e = (est[i] - me) as f64;
                let r = (ref_s[i] - mr) as f64;
                let st = scale * r;
                let en = e - st;
                s_en += st * st;
                n_en += en * en;
            }
            (10.0 * ((s_en + 1e-10) / (n_en + 1e-10)).log10()) as f32
        };

        for (label, use_aura, no_thresh) in [
            ("Classic default-thresh", false, false),
            ("Classic no-thresh(-100,100,100)", false, true),
            ("Aura default-thresh", true, false),
            ("Aura no-thresh(-100,100,100)", true, true),
        ] {
            let mut d = if use_aura {
                Dfn3Denoiser::with_model(Dfn3Model::from_bytes(&EPILOD_AURA_WEIGHTS.0).unwrap())
            } else {
                Dfn3Denoiser::new()
            };
            d.set_attenuation_limit(100.0);
            if no_thresh {
                d.set_thresholds(-100.0, 100.0, 100.0);
            }
            let mut out = Vec::with_capacity(noisy.len());
            let mut frame_out = [0.0f32; VOICE_FRAME_10MS];
            for chunk in noisy.chunks_exact(VOICE_FRAME_10MS) {
                d.process(chunk.try_into().unwrap(), &mut frame_out);
                out.extend_from_slice(&frame_out);
            }
            let sdr = si_sdr(&out[1440..], &clean[..out.len() - 1440]);
            println!("[PARITY] {label:32}: SI-SDR = {sdr:.2} dB");
        }
    }

    #[test]
    fn aura_gate_holds_through_420ms_pause_and_opens_on_whisper() {
        let mut gate = VoiceGate::new();
        let mut out = [[0.0f32; VOICE_FRAME_10MS]; 3];
        // Soft whisper at -55 dBFS (~0.00178 RMS) with 20 ms neural VAD confirmation (rejects 10 ms clicks)
        let whisper = [0.00178f32; VOICE_FRAME_10MS];
        let _ = gate.process_10ms_aura(&whisper, 0.55, -42.0, true, None, false, &mut out);
        let (cnt, is_open, _) =
            gate.process_10ms_aura(&whisper, 0.55, -42.0, true, None, false, &mut out);
        assert!(
            is_open && cnt >= 1,
            "Aura gate must open on 20 ms -55 dBFS whisper"
        );

        // 300 ms mid-sentence pause (30 frames of silence) must stay open (< 420 ms hangover)
        let silence = [0.0f32; VOICE_FRAME_10MS];
        for _ in 0..30 {
            let (_, open_now, _) =
                gate.process_10ms_aura(&silence, 0.05, -42.0, true, None, false, &mut out);
            assert!(
                open_now,
                "Aura gate must not chop during 300 ms mid-sentence pause"
            );
        }
    }

    #[test]
    fn aura_broadcast_compressor_freezes_on_silence_and_limits_peaks() {
        let mut comp = VoiceCompressor::new();
        let mut quiet_tail = [0.005f32; VOICE_FRAME_20MS];
        let before = frame_dbfs(&quiet_tail);
        // Non-speech (speech_prob = 0.1): must NOT boost/pump tail
        comp.process_aura_broadcast(&mut quiet_tail, 0.1);
        let after = frame_dbfs(&quiet_tail);
        assert!(
            after <= before + 0.5,
            "Aura broadcast compressor must not pump reverb/noise tails: {before:.2} -> {after:.2}"
        );

        let mut loud = [0.95f32; VOICE_FRAME_20MS];
        for _ in 0..5 {
            comp.process_aura_broadcast(&mut loud, 0.9);
        }
        let peak = loud.iter().fold(0.0f32, |m, &s| m.max(s.abs()));
        assert!(
            peak <= 0.90,
            "Aura broadcast compressor must soft-limit peaks <= -1 dBFS, got {peak}"
        );
    }

    #[test]
    fn gate_release_never_duplicates_emitted_frames_on_immediate_reopen() {
        let mut gate = VoiceGate::new();
        let mut out = [[0.0f32; VOICE_FRAME_10MS]; 3];
        let speech = [0.05f32; VOICE_FRAME_10MS];
        let silence = [0.0f32; VOICE_FRAME_10MS];

        let (cnt, open, _) =
            gate.process_10ms_aura(&speech, 0.85, -42.0, true, None, false, &mut out);
        assert!(open && cnt == 1);

        // Drain the 42-frame hangover so the next silent frame enters release fade-out (`out_cnt == 1`)
        for _ in 0..42 {
            let (c, _, _) =
                gate.process_10ms_aura(&silence, 0.01, -42.0, true, None, false, &mut out);
            assert_eq!(c, 1);
        }
        // Frame 43: `wants_open == false`, emits 1 release-ramp frame
        let release_marker = [0.0001f32; VOICE_FRAME_10MS];
        let (rel_cnt, _, _) =
            gate.process_10ms_aura(&release_marker, 0.01, -42.0, true, None, false, &mut out);
        assert_eq!(rel_cnt, 1, "Release ramp frame is emitted once");

        // Immediately resume speech on the very next frame: must emit ONLY the new speech frame (`cnt == 1`),
        // NOT re-emit `release_marker` from pre-roll!
        let (reopen_cnt, reopen, _) =
            gate.process_10ms_aura(&speech, 0.85, -42.0, true, None, false, &mut out);
        assert!(reopen);
        assert_eq!(
            reopen_cnt, 1,
            "Re-opening right after an emitted release frame must never duplicate the release frame via pre-roll"
        );
    }
}
