use std::collections::{BTreeMap, VecDeque};

use nnnoiseless::DenoiseState;

pub const VOICE_SAMPLE_RATE: usize = 48_000;
pub const VOICE_FRAME_10MS: usize = 480;
pub const VOICE_FRAME_20MS: usize = 960;
pub const RNNOISE_SCALE: f32 = 32768.0;

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
            quiet[(quiet.len() * 75) / 100.min(quiet.len().max(1))].min(quiet[quiet.len() - 1])
        };

        let mut speak = self.speak_dbs.clone();
        speak.sort_by(|a, b| a.total_cmp(b));
        let speech_level = if speak.is_empty() {
            noise_floor + 14.0
        } else {
            speak[(speak.len() * 80) / 100]
        };

        let spread = (speech_level - noise_floor).max(6.0);
        let recommended = (noise_floor + spread * 0.35)
            .max(noise_floor + 4.0)
            .clamp(-65.0, -18.0);
        (noise_floor, speech_level, recommended.round())
    }
}

/// Local RNNoise wrapper with Discord-style 3-stage processing:
/// - Stage A: 2.5 ms sub-frame transient de-clicker (rejects keyboard/mouse clicks pre-RNNoise)
/// - Stage B: Quiet-mic pre-leveled 48 kHz RNNoise neural core + speech-adaptive wet/dry warmth
/// - Stage C: Residual floor expander & Strong-mode HF hiss damper
pub struct VoiceDenoiser {
    state: Box<DenoiseState<'static>>,
    stage_a_buf: [f32; VOICE_FRAME_10MS],
    in_scaled: [f32; VOICE_FRAME_10MS],
    out_scaled: [f32; VOICE_FRAME_10MS],
    speech_rms_env: f32,
    prob_smooth: f32,
    hangover_frames: u8,
    wet_smooth: f32,
    post_gain_smooth: f32,
    prev_sub_rms: f32,
    hiss_lp_state: f32,
}

impl Default for VoiceDenoiser {
    fn default() -> Self {
        Self::new()
    }
}

impl VoiceDenoiser {
    const SPEECH_HANGOVER_FRAMES: u8 = 12; // 120 ms tail protection
    const TARGET_RNNOISE_RMS: f32 = 0.063; // ~ -24 dBFS (RNNoise training sweet spot)
    const MAX_PRE_GAIN: f32 = 2.0; // +6 dB bounded lift for quiet mics without amplifying room fans
    const SUBFRAME_LEN: usize = 120; // 2.5 ms @ 48 kHz

    pub fn new() -> Self {
        Self {
            state: DenoiseState::new(),
            stage_a_buf: [0.0; VOICE_FRAME_10MS],
            in_scaled: [0.0; VOICE_FRAME_10MS],
            out_scaled: [0.0; VOICE_FRAME_10MS],
            speech_rms_env: Self::TARGET_RNNOISE_RMS,
            prob_smooth: 0.0,
            hangover_frames: 0,
            wet_smooth: 1.0,
            post_gain_smooth: 1.0,
            prev_sub_rms: 0.005,
            hiss_lp_state: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.state = DenoiseState::new();
        self.stage_a_buf.fill(0.0);
        self.speech_rms_env = Self::TARGET_RNNOISE_RMS;
        self.prob_smooth = 0.0;
        self.hangover_frames = 0;
        self.wet_smooth = 1.0;
        self.post_gain_smooth = 1.0;
        self.prev_sub_rms = 0.005;
        self.hiss_lp_state = 0.0;
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

        // Stage A: Sub-frame transient de-clicker (2.5 ms windows before RNNoise).
        // Mechanical switches and mouse clicks show a sharp broadband RMS spike + high HF derivative
        // energy; attenuating them pre-RNNoise stops the GRU from opening noise bands on clicks.
        self.stage_a_buf.copy_from_slice(dry);
        let spike_mult = match mode {
            NoiseSuppressionMode::Strong => 3.2,
            _ => 4.2,
        };
        for w in 0..(VOICE_FRAME_10MS / Self::SUBFRAME_LEN) {
            let start = w * Self::SUBFRAME_LEN;
            let win = &mut self.stage_a_buf[start..start + Self::SUBFRAME_LEN];
            let mut sum_sq = 0.0f32;
            let mut diff_sum = 0.0f32;
            let mut prev_s = win[0];
            for &s in win.iter() {
                sum_sq += s * s;
                diff_sum += (s - prev_s).abs();
                prev_s = s;
            }
            let sub_rms = (sum_sq / Self::SUBFRAME_LEN as f32).sqrt();
            let hf_ratio = if sub_rms > 1e-5 {
                (diff_sum / Self::SUBFRAME_LEN as f32) / sub_rms
            } else {
                0.0
            };
            let is_click_transient = self.hangover_frames == 0
                && sub_rms > (self.prev_sub_rms * spike_mult).max(0.015)
                && hf_ratio > 0.36;
            if is_click_transient {
                let target_rms = (self.prev_sub_rms * 1.4).max(0.004);
                let atten = (target_rms / sub_rms.max(1e-5)).clamp(0.08, 0.45);
                for (idx, s) in win.iter_mut().enumerate() {
                    // Gentle 8-sample fade in/out inside sub-window avoids sharp step clicks
                    let edge = if idx < 8 {
                        idx as f32 / 8.0
                    } else if idx >= Self::SUBFRAME_LEN - 8 {
                        (Self::SUBFRAME_LEN - 1 - idx) as f32 / 8.0
                    } else {
                        1.0
                    };
                    let g = 1.0 - edge * (1.0 - atten);
                    *s *= g;
                }
            } else {
                let alpha = if sub_rms > self.prev_sub_rms { 0.12 } else { 0.25 };
                self.prev_sub_rms += alpha * (sub_rms - self.prev_sub_rms);
            }
        }

        // Stage B: Bounded pre-gain so quiet mics enter RNNoise near -24 dBFS, then neural core.
        let dry_rms = (self.stage_a_buf.iter().map(|s| s * s).sum::<f32>()
            / VOICE_FRAME_10MS as f32)
            .sqrt();
        let pre_gain = if self.speech_rms_env > 1e-4 {
            (Self::TARGET_RNNOISE_RMS / self.speech_rms_env).clamp(1.0, Self::MAX_PRE_GAIN)
        } else {
            1.0
        };
        let scale_in = RNNOISE_SCALE * pre_gain;
        for (dst, &src) in self.in_scaled.iter_mut().zip(self.stage_a_buf.iter()) {
            *dst = (src * scale_in).clamp(-RNNOISE_SCALE, RNNOISE_SCALE);
        }

        let raw_prob = self
            .state
            .process_frame(&mut self.out_scaled, &self.in_scaled)
            .clamp(0.0, 1.0);

        if raw_prob >= 0.80 && dry_rms > 0.008 {
            self.speech_rms_env = (self.speech_rms_env * 0.96 + dry_rms * 0.04).clamp(0.031, 0.25);
        }

        let prob_alpha = if raw_prob > self.prob_smooth {
            0.55
        } else {
            0.14
        };
        self.prob_smooth += prob_alpha * (raw_prob - self.prob_smooth);
        if self.prob_smooth >= 0.45 {
            self.hangover_frames = Self::SPEECH_HANGOVER_FRAMES;
        } else if self.hangover_frames > 0 {
            self.hangover_frames -= 1;
        }

        let speech_blend = ((self.prob_smooth - 0.35) / 0.50).clamp(0.0, 1.0);
        let target_wet = match mode {
            NoiseSuppressionMode::Off => 0.0,
            NoiseSuppressionMode::Balanced => 1.0 - 0.10 * speech_blend,
            NoiseSuppressionMode::Strong => 1.0,
        };

        // Stage C: Post-RNNoise residual noise-floor expander + Strong-mode HF hiss damper
        let floor_gain = match mode {
            NoiseSuppressionMode::Off => 1.0,
            NoiseSuppressionMode::Balanced => 0.25, // -12 dB residual attenuation
            NoiseSuppressionMode::Strong => 0.08,   // -22 dB deep silence floor
        };
        let target_post_gain = if self.hangover_frames > 0 || self.prob_smooth >= 0.40 {
            1.0
        } else {
            let t = (self.prob_smooth / 0.40).clamp(0.0, 1.0);
            floor_gain + (1.0 - floor_gain) * (t * t)
        };
        let strong_hf_damp = if mode == NoiseSuppressionMode::Strong && raw_prob < 0.72 {
            ((0.72 - raw_prob) / 0.72).clamp(0.0, 0.65)
        } else {
            0.0
        };

        let inv_scale_out = 1.0 / (RNNOISE_SCALE * pre_gain);
        let post_coeff = if target_post_gain > self.post_gain_smooth {
            0.006
        } else {
            0.00045
        };
        let wet_coeff = 0.003;

        for ((dst, &clean_s), &dry_s) in out
            .iter_mut()
            .zip(self.out_scaled.iter())
            .zip(self.stage_a_buf.iter())
        {
            self.wet_smooth += wet_coeff * (target_wet - self.wet_smooth);
            self.post_gain_smooth += post_coeff * (target_post_gain - self.post_gain_smooth);
            let clean = clean_s * inv_scale_out;
            let mut blended = clean * self.wet_smooth + dry_s * (1.0 - self.wet_smooth);
            self.hiss_lp_state += 0.36 * (blended - self.hiss_lp_state);
            if strong_hf_damp > 0.0 {
                blended = blended * (1.0 - strong_hf_damp) + self.hiss_lp_state * strong_hf_damp;
            }
            *dst = blended * self.post_gain_smooth;
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

/// Hysteresis VAD gate with 20 ms pre-roll, 250 ms hangover, and click-free 5 ms ramps.
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
    const HANGOVER_TARGET_FRAMES: usize = 25; // 25 * 10 ms = 250 ms
    const RAMP_SAMPLES: usize = 240; // 5 ms @ 48 kHz

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

    fn apply_ramp(&mut self, frame: &mut [f32; VOICE_FRAME_10MS], target_gain: f32) {
        let step = 1.0 / (Self::RAMP_SAMPLES as f32);
        for s in frame.iter_mut() {
            if (self.current_gain - target_gain).abs() <= step {
                self.current_gain = target_gain;
            } else if self.current_gain < target_gain {
                self.current_gain += step;
            } else {
                self.current_gain -= step;
            }
            *s *= self.current_gain;
        }
    }

    /// Processes one 10 ms denoised frame. Writes 0..=3 output frames into `out_frames` and returns count.
    /// Zero heap allocations.
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
        let db = frame_dbfs(frame);
        let wants_open = if muted {
            self.speech_streak = 0;
            false
        } else if let Some(ptt) = ptt_active {
            self.speech_streak = 0;
            ptt
        } else if self.is_open {
            self.speech_streak = 0;
            let hold_ok = (vad_assisted && speech_prob >= 0.35) || db >= (threshold_db - 4.0);
            if hold_ok {
                self.hangover_frames = Self::HANGOVER_TARGET_FRAMES;
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
        } else if speech_prob >= 0.65 && db >= (threshold_db + 3.0) {
            // Immediate open on clear speech onset
            self.speech_streak = 0;
            true
        } else if speech_prob >= 0.48 && db >= threshold_db {
            // 20 ms confirmation rejects 10 ms keyboard/mouse clicks while catching soft speech
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
                self.apply_ramp(&mut out_frames[0], 0.0);
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
                Self::HANGOVER_TARGET_FRAMES
            };
            // Flush pre-roll frames on VAD open so consonant onsets aren't clipped
            if ptt_active.is_none() && self.pre_roll_len > 0 {
                let start = (self.pre_roll_head + 2 - self.pre_roll_len) % 2;
                for i in 0..self.pre_roll_len {
                    let idx = (start + i) % 2;
                    out_frames[out_count].copy_from_slice(&self.pre_roll[idx]);
                    self.apply_ramp(&mut out_frames[out_count], 1.0);
                    out_count += 1;
                }
                self.pre_roll_len = 0;
            }
            out_frames[out_count].copy_from_slice(frame);
            self.apply_ramp(&mut out_frames[out_count], 1.0);
            out_count += 1;
        } else if wants_open && self.is_open {
            out_frames[0].copy_from_slice(frame);
            self.apply_ramp(&mut out_frames[0], 1.0);
            out_count = 1;
        } else if !wants_open && (self.is_open || self.current_gain > 0.0) {
            self.is_open = false;
            out_frames[0].copy_from_slice(frame);
            self.apply_ramp(&mut out_frames[0], 0.0);
            out_count = 1;
            self.push_pre_roll(frame);
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

/// Two-stage speech-gated dynamic compressor + subtle vocal clarity/de-esser + fast peak limiter.
#[derive(Debug, Clone)]
pub struct VoiceCompressor {
    env_rms: f32,
    gain_smooth: f32,
    peak_env: f32,
    presence_lp: f32,
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
    const MAX_AGC_GAIN_DB: f32 = 12.0;
    const PEAK_THRESH: f32 = 0.3548; // -9.0 dBFS fast peak knee
    const LIMITER_CEILING: f32 = 0.89125; // -1 dBFS

    pub fn new() -> Self {
        Self {
            env_rms: 0.015,
            gain_smooth: 1.0,
            peak_env: 0.0,
            presence_lp: 0.0,
            sibilance_env: 0.0,
        }
    }

    pub fn reset(&mut self) {
        self.env_rms = 0.015;
        self.gain_smooth = 1.0;
        self.peak_env = 0.0;
        self.presence_lp = 0.0;
        self.sibilance_env = 0.0;
    }

    pub fn process_in_place(&mut self, samples: &mut [f32], enabled: bool) {
        self.process_with_speech_prob(samples, 1.0, enabled);
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

        // Stage 1: Speech-gated loudness tracker — freezes AGC during silence/pauses so room noise never pumps.
        if speech_prob >= 0.55 && frame_rms > 0.005 {
            let alpha = if frame_rms > self.env_rms { 0.25 } else { 0.06 };
            self.env_rms = (1.0 - alpha) * self.env_rms + alpha * frame_rms;
        }
        let env_db = if self.env_rms <= 1e-5 {
            -70.0
        } else {
            20.0 * self.env_rms.log10()
        };

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

        // Bounded speech-only AGC lift toward -18 dBFS
        let agc_boost_db = if speech_prob >= 0.55 && env_db > -48.0 {
            (Self::TARGET_RMS_DB - env_db).clamp(-6.0, Self::MAX_AGC_GAIN_DB) * 0.60
        } else {
            0.0
        };

        let target_gain = if speech_prob >= 0.55 || self.gain_smooth <= 1.0 {
            10.0f32.powf((comp_reduction_db + agc_boost_db) / 20.0)
        } else {
            self.gain_smooth
        };
        let gain_step = (target_gain - self.gain_smooth) / (samples.len() as f32);

        for s in samples.iter_mut() {
            self.gain_smooth += gain_step;
            let mut x = *s * self.gain_smooth;

            // Stage 2: Gentle ~2.2 kHz vocal clarity tilt + dynamic sibilance de-esser
            self.presence_lp += 0.24 * (x - self.presence_lp);
            let hf = x - self.presence_lp;
            let hf_abs = hf.abs();
            let sib_alpha = if hf_abs > self.sibilance_env {
                0.04
            } else {
                0.002
            };
            self.sibilance_env += sib_alpha * (hf_abs - self.sibilance_env);
            if self.sibilance_env > 0.14 {
                let deess = (0.14 / self.sibilance_env).clamp(0.45, 1.0);
                x = self.presence_lp + hf * deess;
            } else {
                x += hf * 0.18; // ~ +1.4 dB articulation boost over movie audio
            }

            // Stage 3: Fast ~0.5 ms attack / ~50 ms release peak compressor + -1 dBFS true ceiling limiter
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
        if samples.is_empty() {
            return;
        }
        let sum_sq: f32 = samples.iter().map(|s| s * s).sum();
        let frame_rms = (sum_sq / samples.len() as f32).sqrt();
        // Track only active speech frames (> -45 dBFS) so silence never skews gain
        if frame_rms > 0.0056 {
            let alpha = if frame_rms > self.env_rms { 0.08 } else { 0.03 };
            self.env_rms += alpha * (frame_rms - self.env_rms);
        }
        let target_gain = if self.env_rms > 1e-4 {
            (Self::TARGET_RMS / self.env_rms).clamp(Self::MIN_GAIN, Self::MAX_GAIN)
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
        Self::new(12.0, 60.0, now_ms)
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
            target_frames: 2, // 40 ms initial cushion
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

    pub fn target_delay_ms(&self) -> usize {
        (self.target_frames + self.stall_cushion_frames).min(6) * 20
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

    fn effective_target_frames(&self) -> usize {
        (self.target_frames + self.stall_cushion_frames).clamp(1, 6)
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
        if let (Some(prev_arr), Some(prev_ts)) = (self.last_arrival_ms, self.last_pkt_ts_ms) {
            let d_arr = arrival_ms as i64 - prev_arr as i64;
            let d_ts = pkt_ts_ms as i64 - prev_ts as i64;
            let d = (d_arr - d_ts).unsigned_abs() as f64;
            self.interarrival_jitter_ms += (d - self.interarrival_jitter_ms) / 16.0;
            self.target_frames = if self.interarrival_jitter_ms < 12.0 {
                1
            } else if self.interarrival_jitter_ms < 28.0 {
                2
            } else if self.interarrival_jitter_ms < 50.0 {
                3
            } else {
                4
            };
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

        // Fast backlog catch-up when an OS/CPU stall queues excess talkspurt frames (> 60 ms over target)
        if self.frames.len() > eff_target + 3 {
            let to_drop = if self.frames.len() > eff_target + 6 {
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

        // Drift tracking over 5 s (250 ticks of 20 ms)
        let depth = self.frames.len() as i64;
        self.drift_sample_acc += depth - (eff_target as i64);
        self.drift_sample_count += 1;
        if self.drift_sample_count >= 250 {
            let avg_excess = self.drift_sample_acc / (self.drift_sample_count as i64);
            self.drift_sample_acc = 0;
            self.drift_sample_count = 0;
            // Beyond +40 ms (+2 frames) sustained drift, drop one oldest frame smoothly
            if avg_excess >= 2 && self.frames.len() > eff_target + 1 {
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
            if self.clean_frames_since_stall >= 150 && self.stall_cushion_frames > 0 {
                // Decay extra stall cushion slowly after >= 3 s clean playback
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
        if self.consecutive_underruns >= 2 && self.stall_cushion_frames < 3 {
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
            expected_loss_pct: 1,
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
                        ..=24_000 => 32_000,
                        ..=32_000 => 48_000,
                        ..=48_000 => 64_000,
                        _ => 72_000,
                    }
                    .min(cap);
                    if next > self.bitrate_bps {
                        self.bitrate_bps = next;
                        // Monitor next 2 s closely in case upshift triggers congestion again
                        self.upshift_probe_ticks = 100;
                    }
                    self.expected_loss_pct = 1;
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

        // Dropping below threshold stays open for 25 hangover frames (250 ms)
        for _ in 0..25 {
            let (c, is_open, _) =
                gate.process_10ms(&quiet, 0.0, -40.0, true, None, false, &mut out);
            assert_eq!(c, 1);
            assert!(is_open);
        }
        // 26th quiet frame starts closing with ramp-down, then goes silent
        let (c_close, _, _) = gate.process_10ms(&quiet, 0.0, -40.0, true, None, false, &mut out);
        assert_eq!(c_close, 1);
        let (c_closed, is_open_after, _) =
            gate.process_10ms(&quiet, 0.0, -40.0, true, None, false, &mut out);
        assert_eq!(c_closed, 0);
        assert!(!is_open_after);
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
        for _ in 0..12 {
            assert!(tb.allow(0));
        }
        assert!(!tb.allow(0));
        assert!(tb.allow(20)); // +1.2 tokens

        let mut relay_tb = PeerTokenBucket::new_relay_hop(0);
        for _ in 0..48 {
            assert!(relay_tb.allow(0));
        }
        assert!(!relay_tb.allow(0));
        assert!(relay_tb.allow(20)); // +6 tokens @ 300 pps
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
        let (_, open_click, _) = gate.process_10ms(&click, 0.55, -40.0, true, None, false, &mut gout);
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
        for i in 120..240 {
            frame[i] = if i % 2 == 0 { 0.35 } else { -0.35 };
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
        assert_eq!(AdaptiveBitrateController::room_bitrate_cap_bps(2, 0), 64_000);
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps_for_mode(2, 0, true),
            72_000
        );
        assert_eq!(AdaptiveBitrateController::room_bitrate_cap_bps(4, 0), 32_000);
    }
}
