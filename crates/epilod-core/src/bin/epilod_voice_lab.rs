use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::time::Instant;

use epilod_core::voice_dsp::{
    frame_dbfs, BiquadHighPass, NoiseSuppressionMode, VoiceCompressor, VoiceDenoiser,
    VoiceDenoiserOptions, VoiceGate, WebRtcAgc2Leveler, WebRtcAgc2Params, VOICE_FRAME_10MS,
    VOICE_FRAME_20MS, VOICE_SAMPLE_RATE,
};
use epilod_core::wav_io::{read_wav_mono_f32, write_wav_mono_i16};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Profile {
    Current,
    V017,
}

impl Profile {
    fn parse(s: &str) -> Result<Self, String> {
        match s.trim().to_ascii_lowercase().as_str() {
            "current" => Ok(Self::Current),
            "v017" => Ok(Self::V017),
            other => Err(format!(
                "Unknown --profile '{other}' (expected current|v017)"
            )),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Current => "current",
            Self::V017 => "v017",
        }
    }
}

fn parse_noise_mode(s: &str) -> Result<(NoiseSuppressionMode, &'static str), String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "off" => Ok((NoiseSuppressionMode::Off, "off")),
        "balanced" => Ok((NoiseSuppressionMode::Balanced, "balanced")),
        "strong" => Ok((NoiseSuppressionMode::Strong, "strong")),
        other => Err(format!(
            "Unknown --mode '{other}' (expected off|balanced|strong)"
        )),
    }
}

fn parse_bool(flag: &str, s: &str) -> Result<bool, String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" => Ok(true),
        "false" | "0" | "no" => Ok(false),
        other => Err(format!(
            "Invalid boolean for {flag}: '{other}' (expected true|false)"
        )),
    }
}

fn peak_dbfs(samples: &[f32]) -> f32 {
    let peak = samples.iter().fold(
        0.0f32,
        |acc, &s| if s.is_finite() { acc.max(s.abs()) } else { acc },
    );
    if peak <= 1e-6 {
        -90.0
    } else {
        (20.0 * peak.log10()).clamp(-90.0, 0.0)
    }
}

fn default_output_path(input: &Path) -> PathBuf {
    let stem = input
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("voice");
    let file_name = format!("{stem}_processed.wav");
    match input.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.join(file_name),
        _ => PathBuf::from(file_name),
    }
}

fn parse_denoiser_opts(s: &str) -> Result<(VoiceDenoiserOptions, &'static str), String> {
    match s.trim().to_ascii_lowercase().as_str() {
        "full" => Ok((VoiceDenoiserOptions::default(), "full")),
        "bare" => Ok((VoiceDenoiserOptions::BARE, "bare")),
        "no-stage-a" => Ok((
            VoiceDenoiserOptions {
                stage_a: false,
                pre_gain: true,
                stage_c: true,
            },
            "no-stage-a",
        )),
        "no-pre-gain" => Ok((
            VoiceDenoiserOptions {
                stage_a: true,
                pre_gain: false,
                stage_c: true,
            },
            "no-pre-gain",
        )),
        "no-stage-c" => Ok((
            VoiceDenoiserOptions {
                stage_a: true,
                pre_gain: true,
                stage_c: false,
            },
            "no-stage-c",
        )),
        other => Err(format!(
            "Unknown --denoiser '{other}' (expected full|bare|no-stage-a|no-pre-gain|no-stage-c)"
        )),
    }
}

fn print_usage() {
    eprintln!(
        "Usage: epilod_voice_lab --input <path.wav> [--output <path.wav>] [--profile current|v017] \
         [--mode off|balanced|strong] [--denoiser full|bare|no-stage-a|no-pre-gain|no-stage-c] \
         [--agc2-initial-db <f32>] [--agc2-fixed-db <f32>] [--agc2-max-noise-dbfs <f32>] \
         [--sensitivity-db <f32>] [--auto-sensitivity true|false] \
         [--compression true|false] [--dump-stages <dir>]\n\
         Note: Runs the offline TX DSP chain only (HPF, Denoiser, optional AGC2, Gate, Compressor).\n\
         It does NOT include AEC3, speaker echo guard, or movie-playing tight-gate boosts."
    );
}

struct CliArgs {
    input: PathBuf,
    output: Option<PathBuf>,
    profile: Profile,
    mode: NoiseSuppressionMode,
    mode_label: &'static str,
    denoiser_opts: VoiceDenoiserOptions,
    denoiser_label: &'static str,
    aura_weights: bool,
    agc2_params: WebRtcAgc2Params,
    sensitivity_db: f32,
    auto_sensitivity: bool,
    compression: bool,
    dump_stages: Option<PathBuf>,
}

fn parse_args() -> Result<CliArgs, String> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() || args.iter().any(|a| a == "-h" || a == "--help") {
        print_usage();
        std::process::exit(if args.is_empty() { 2 } else { 0 });
    }

    let mut input: Option<PathBuf> = None;
    let mut output: Option<PathBuf> = None;
    let mut profile = Profile::Current;
    let mut mode = NoiseSuppressionMode::Balanced;
    let mut mode_label: &'static str = "balanced";
    let mut denoiser_opts = VoiceDenoiserOptions::default();
    let mut denoiser_label: &'static str = "full";
    let mut aura_weights = false;
    let mut agc2_initial_override: Option<f32> = None;
    let mut agc2_fixed_override: Option<f32> = None;
    let mut agc2_max_noise_override: Option<f32> = None;
    let mut sensitivity_db: f32 = -42.0;
    let mut auto_sensitivity = true;
    let mut compression = true;
    let mut dump_stages: Option<PathBuf> = None;

    let mut i = 0usize;
    while i < args.len() {
        let key = args[i].as_str();
        let next_val = |idx: &mut usize, flag: &str| -> Result<String, String> {
            *idx += 1;
            args.get(*idx)
                .cloned()
                .ok_or_else(|| format!("Missing value for {flag}"))
        };
        match key {
            "--input" => input = Some(PathBuf::from(next_val(&mut i, "--input")?)),
            "--output" => output = Some(PathBuf::from(next_val(&mut i, "--output")?)),
            "--profile" => profile = Profile::parse(&next_val(&mut i, "--profile")?)?,
            "--mode" => {
                let val = next_val(&mut i, "--mode")?;
                let parsed = parse_noise_mode(&val)?;
                mode = parsed.0;
                mode_label = parsed.1;
            }
            "--denoiser" => {
                let val = next_val(&mut i, "--denoiser")?;
                let parsed = parse_denoiser_opts(&val)?;
                denoiser_opts = parsed.0;
                denoiser_label = parsed.1;
            }
            "--agc2-initial-db" => {
                let val = next_val(&mut i, "--agc2-initial-db")?;
                agc2_initial_override = Some(
                    val.parse::<f32>()
                        .map_err(|_| format!("Invalid --agc2-initial-db '{val}'"))?
                        .clamp(0.0, 50.0),
                );
            }
            "--agc2-fixed-db" => {
                let val = next_val(&mut i, "--agc2-fixed-db")?;
                agc2_fixed_override = Some(
                    val.parse::<f32>()
                        .map_err(|_| format!("Invalid --agc2-fixed-db '{val}'"))?
                        .clamp(0.0, 30.0),
                );
            }
            "--agc2-max-noise-dbfs" => {
                let val = next_val(&mut i, "--agc2-max-noise-dbfs")?;
                agc2_max_noise_override = Some(
                    val.parse::<f32>()
                        .map_err(|_| format!("Invalid --agc2-max-noise-dbfs '{val}'"))?
                        .clamp(-90.0, 0.0),
                );
            }
            "--sensitivity-db" => {
                let val = next_val(&mut i, "--sensitivity-db")?;
                sensitivity_db = val
                    .parse::<f32>()
                    .map_err(|_| format!("Invalid --sensitivity-db '{val}'"))?
                    .clamp(-75.0, 0.0);
            }
            "--auto-sensitivity" => {
                auto_sensitivity = parse_bool(
                    "--auto-sensitivity",
                    &next_val(&mut i, "--auto-sensitivity")?,
                )?;
            }
            "--compression" => {
                compression = parse_bool("--compression", &next_val(&mut i, "--compression")?)?;
            }
            "--aura-weights" => {
                aura_weights = parse_bool("--aura-weights", &next_val(&mut i, "--aura-weights")?)?;
            }
            "--dump-stages" => {
                dump_stages = Some(PathBuf::from(next_val(&mut i, "--dump-stages")?));
            }
            other => {
                return Err(format!("Unknown argument: {other}"));
            }
        }
        i += 1;
    }

    let mut agc2_params = if aura_weights {
        WebRtcAgc2Params::aura()
    } else {
        WebRtcAgc2Params::default()
    };
    if let Some(v) = agc2_initial_override {
        agc2_params.initial_gain_db = v;
    }
    if let Some(v) = agc2_fixed_override {
        agc2_params.fixed_gain_db = v;
    }
    if let Some(v) = agc2_max_noise_override {
        agc2_params.max_output_noise_level_dbfs = v;
    }

    let input = input.ok_or_else(|| "Missing required --input <path.wav>".to_string())?;
    Ok(CliArgs {
        input,
        output,
        profile,
        mode,
        mode_label,
        denoiser_opts,
        denoiser_label,
        aura_weights,
        agc2_params,
        sensitivity_db,
        auto_sensitivity,
        compression,
        dump_stages,
    })
}

struct LabRunResult {
    frames_10ms: usize,
    stage_hpf: Vec<f32>,
    stage_denoised: Vec<f32>,
    stage_agc2: Vec<f32>,
    stage_gated: Vec<f32>,
    final_samples: Vec<f32>,
    gate_open_frames: usize,
    gate_transitions: u64,
    eff_thresh_min_db: f32,
    eff_thresh_max_db: f32,
    eff_thresh_avg_db: f32,
    avg_frame_us: f64,
    max_frame_us: u64,
    overrun_frames_gt_8ms: u64,
}

fn process_samples(
    raw_mono: &[f32],
    profile: Profile,
    mode: NoiseSuppressionMode,
    denoiser_opts: VoiceDenoiserOptions,
    aura_weights: bool,
    agc2_params: WebRtcAgc2Params,
    sensitivity_db: f32,
    auto_sensitivity: bool,
    compression: bool,
    want_stages: bool,
) -> LabRunResult {
    let frames_10ms = raw_mono.len().div_ceil(VOICE_FRAME_10MS);
    let mut padded_input = Vec::with_capacity(frames_10ms * VOICE_FRAME_10MS);
    padded_input.extend_from_slice(raw_mono);
    padded_input.resize(frames_10ms * VOICE_FRAME_10MS, 0.0);

    let mut hpf = BiquadHighPass::new_80hz_48k();
    let mut denoiser = VoiceDenoiser::with_options_and_aura(denoiser_opts, aura_weights);
    let mut agc2 = WebRtcAgc2Leveler::with_params(agc2_params);
    let mut gate = VoiceGate::new();
    let mut comp = VoiceCompressor::new();

    let mut auto_noise_floor_db: f32 = -54.0;
    let mut was_gate_open = false;
    let mut gate_open_frames: usize = 0;
    let mut gate_transitions: u64 = 0;
    let mut eff_thresh_min_db = f32::INFINITY;
    let mut eff_thresh_max_db = f32::NEG_INFINITY;
    let mut eff_thresh_sum_db = 0.0f64;

    let mut total_frame_us: u64 = 0;
    let mut max_frame_us: u64 = 0;
    let mut overrun_frames_gt_8ms: u64 = 0;

    let mut stage_hpf = if want_stages {
        Vec::with_capacity(padded_input.len())
    } else {
        Vec::new()
    };
    let mut stage_denoised = if want_stages {
        Vec::with_capacity(padded_input.len())
    } else {
        Vec::new()
    };
    let mut stage_agc2 = if want_stages {
        Vec::with_capacity(padded_input.len())
    } else {
        Vec::new()
    };
    let mut gated_frames: Vec<[f32; VOICE_FRAME_10MS]> = if want_stages {
        Vec::with_capacity(frames_10ms)
    } else {
        Vec::new()
    };

    // Tracks timeline indices for 1:1 aligned post-compressor output.
    let mut final_timeline: Vec<[f32; VOICE_FRAME_10MS]> =
        vec![[0.0; VOICE_FRAME_10MS]; frames_10ms];
    let mut active_slot_indices: VecDeque<usize> = VecDeque::with_capacity(16);
    let mut encode_accum: Vec<f32> = Vec::with_capacity(VOICE_FRAME_20MS * 2);

    let mut frame_10ms = [0.0f32; VOICE_FRAME_10MS];
    let mut ns_out = [0.0f32; VOICE_FRAME_10MS];
    let mut leveled_out = [0.0f32; VOICE_FRAME_10MS];
    let mut gate_out = [[0.0f32; VOICE_FRAME_10MS]; 3];

    let use_agc2 = profile == Profile::Current && compression && mode != NoiseSuppressionMode::Off;
    let vad_assisted = mode != NoiseSuppressionMode::Off;
    let is_aura = aura_weights;

    for frame_idx in 0..frames_10ms {
        let start = frame_idx * VOICE_FRAME_10MS;
        frame_10ms.copy_from_slice(&padded_input[start..start + VOICE_FRAME_10MS]);

        let t0 = Instant::now();

        hpf.process_in_place(&mut frame_10ms);
        if want_stages {
            stage_hpf.extend_from_slice(&frame_10ms);
        }

        let speech_prob = denoiser.process_10ms(mode, &frame_10ms, &mut ns_out);
        if want_stages {
            stage_denoised.extend_from_slice(&ns_out);
        }

        agc2.process_10ms(&ns_out, &mut leveled_out, use_agc2);
        if want_stages {
            stage_agc2.extend_from_slice(&leveled_out);
        }

        // Mirrors the auto_sensitivity threshold update in voice.rs (without movie/echo-guard boosts).
        let base_thresh = if auto_sensitivity {
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
            (sensitivity_db * 0.35 + auto_th * 0.65).clamp(-75.0, 0.0)
        } else {
            sensitivity_db
        };
        let eff_thresh = base_thresh.clamp(-75.0, 0.0);
        eff_thresh_min_db = eff_thresh_min_db.min(eff_thresh);
        eff_thresh_max_db = eff_thresh_max_db.max(eff_thresh);
        eff_thresh_sum_db += eff_thresh as f64;

        let (out_cnt, is_open, _db) = if is_aura {
            gate.process_10ms_aura(
                &leveled_out,
                speech_prob,
                eff_thresh,
                vad_assisted,
                None,
                false,
                &mut gate_out,
            )
        } else {
            gate.process_10ms(
                &leveled_out,
                speech_prob,
                eff_thresh,
                vad_assisted,
                None,
                false,
                &mut gate_out,
            )
        };

        if is_open {
            gate_open_frames += 1;
        }
        if is_open != was_gate_open {
            gate_transitions += 1;
        }
        was_gate_open = is_open;

        if want_stages {
            match out_cnt {
                0 => gated_frames.push([0.0; VOICE_FRAME_10MS]),
                1 => gated_frames.push(gate_out[0]),
                _ => {
                    let pre_cnt = out_cnt - 1;
                    let len = gated_frames.len();
                    let back = pre_cnt.min(len);
                    for j in 0..back {
                        gated_frames[len - back + j] = gate_out[pre_cnt - back + j];
                    }
                    gated_frames.push(gate_out[out_cnt - 1]);
                }
            }
        }

        if out_cnt > 1 {
            let pre_cnt = out_cnt - 1;
            let back = pre_cnt.min(frame_idx);
            for offset in (1..=back).rev() {
                let slot_idx = frame_idx - offset;
                if !active_slot_indices.contains(&slot_idx) {
                    active_slot_indices.push_back(slot_idx);
                }
            }
            active_slot_indices.push_back(frame_idx);
        } else if out_cnt == 1 {
            active_slot_indices.push_back(frame_idx);
        }

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

            if is_aura {
                if compression {
                    comp.process_aura_broadcast(&mut pcm20, speech_prob);
                } else {
                    comp.process_limiter_only(&mut pcm20);
                }
            } else {
                comp.process_with_speech_prob(&mut pcm20, speech_prob, compression);
            }

            let valid_halves = if padded_tail && encode_accum.is_empty() {
                1
            } else {
                2
            };
            while active_slot_indices.len() < valid_halves {
                active_slot_indices.push_front(frame_idx);
            }
            for h in 0..valid_halves {
                if let Some(slot_idx) = active_slot_indices.pop_front() {
                    let src = &pcm20[h * VOICE_FRAME_10MS..(h + 1) * VOICE_FRAME_10MS];
                    final_timeline[slot_idx].copy_from_slice(src);
                }
            }
            let rem_chunks = encode_accum.len() / VOICE_FRAME_10MS;
            while active_slot_indices.len() > rem_chunks {
                active_slot_indices.pop_front();
            }
        }

        let elapsed_us = t0.elapsed().as_micros() as u64;
        total_frame_us += elapsed_us;
        if elapsed_us > max_frame_us {
            max_frame_us = elapsed_us;
        }
        if elapsed_us > 8_000 {
            overrun_frames_gt_8ms += 1;
        }
    }

    if !encode_accum.is_empty() {
        let orig_chunks = (encode_accum.len() / VOICE_FRAME_10MS).max(1);
        encode_accum.resize(VOICE_FRAME_20MS, 0.0);
        let mut pcm20 = [0.0f32; VOICE_FRAME_20MS];
        pcm20.copy_from_slice(&encode_accum[..VOICE_FRAME_20MS]);
        if is_aura {
            if compression {
                comp.process_aura_broadcast(&mut pcm20, 0.0);
            } else {
                comp.process_limiter_only(&mut pcm20);
            }
        } else {
            comp.process_with_speech_prob(&mut pcm20, 0.0, compression);
        }
        for h in 0..orig_chunks.min(2) {
            if let Some(slot_idx) = active_slot_indices.pop_front() {
                let src = &pcm20[h * VOICE_FRAME_10MS..(h + 1) * VOICE_FRAME_10MS];
                final_timeline[slot_idx].copy_from_slice(src);
            }
        }
    }

    let final_samples: Vec<f32> = final_timeline
        .iter()
        .flat_map(|f| f.iter().copied())
        .collect();
    let stage_gated: Vec<f32> = gated_frames
        .iter()
        .flat_map(|f| f.iter().copied())
        .collect();
    LabRunResult {
        frames_10ms,
        stage_hpf,
        stage_denoised,
        stage_agc2,
        stage_gated,
        final_samples,
        gate_open_frames,
        gate_transitions,
        eff_thresh_min_db,
        eff_thresh_max_db,
        eff_thresh_avg_db: (eff_thresh_sum_db / (frames_10ms as f64)) as f32,
        avg_frame_us: (total_frame_us as f64) / (frames_10ms as f64),
        max_frame_us,
        overrun_frames_gt_8ms,
    }
}

fn run() -> Result<(), String> {
    let cli = parse_args()?;
    let (sample_rate, raw_mono) = read_wav_mono_f32(&cli.input)?;
    if sample_rate != VOICE_SAMPLE_RATE as u32 {
        return Err(format!(
            "Unsupported WAV sample rate {sample_rate} Hz (expected {VOICE_SAMPLE_RATE} Hz)"
        ));
    }
    if raw_mono.is_empty() {
        return Err("Input WAV contains zero audio frames".to_string());
    }

    let output_path = cli
        .output
        .clone()
        .unwrap_or_else(|| default_output_path(&cli.input));

    let want_stages = cli.dump_stages.is_some();
    let res = process_samples(
        &raw_mono,
        cli.profile,
        cli.mode,
        cli.denoiser_opts,
        cli.aura_weights,
        cli.agc2_params,
        cli.sensitivity_db,
        cli.auto_sensitivity,
        cli.compression,
        want_stages,
    );

    write_wav_mono_i16(&output_path, VOICE_SAMPLE_RATE as u32, &res.final_samples)?;

    if let Some(ref stage_dir) = cli.dump_stages {
        std::fs::create_dir_all(stage_dir)
            .map_err(|e| format!("Failed creating stage dir {}: {e}", stage_dir.display()))?;
        write_wav_mono_i16(
            &stage_dir.join("01_hpf.wav"),
            VOICE_SAMPLE_RATE as u32,
            &res.stage_hpf,
        )?;
        write_wav_mono_i16(
            &stage_dir.join("02_denoised.wav"),
            VOICE_SAMPLE_RATE as u32,
            &res.stage_denoised,
        )?;
        write_wav_mono_i16(
            &stage_dir.join("03_agc2.wav"),
            VOICE_SAMPLE_RATE as u32,
            &res.stage_agc2,
        )?;
        write_wav_mono_i16(
            &stage_dir.join("04_gated.wav"),
            VOICE_SAMPLE_RATE as u32,
            &res.stage_gated,
        )?;
        write_wav_mono_i16(
            &stage_dir.join("05_final.wav"),
            VOICE_SAMPLE_RATE as u32,
            &res.final_samples,
        )?;
    }

    let duration_sec = (res.frames_10ms as f64) * 0.01;
    let input_rms_dbfs = frame_dbfs(&raw_mono);
    let input_peak_dbfs = peak_dbfs(&raw_mono);
    let output_rms_dbfs = frame_dbfs(&res.final_samples);
    let output_peak_dbfs = peak_dbfs(&res.final_samples);
    let clipped_samples = res
        .final_samples
        .iter()
        .filter(|&&s| s.is_finite() && s.abs() >= 0.99)
        .count();
    let gate_open_pct = ((res.gate_open_frames as f64) / (res.frames_10ms as f64)) * 100.0;
    let realtime_cpu_pct = res.avg_frame_us / 100.0;

    println!("=== Epilod Voice Lab Report ===");
    println!(
        "Scope             : Offline TX DSP only (excludes AEC3, echo guard, movie tight gate)"
    );
    println!("Input             : {}", cli.input.display());
    println!("Output            : {}", output_path.display());
    println!("Profile           : {}", cli.profile.as_str());
    println!(
        "Mode              : {} (denoiser={})",
        cli.mode_label, cli.denoiser_label
    );
    println!(
        "Duration          : {:.2} s ({} x 10 ms frames)",
        duration_sec, res.frames_10ms
    );
    println!(
        "Input RMS / Peak  : {:.2} dBFS / {:.2} dBFS",
        input_rms_dbfs, input_peak_dbfs
    );
    println!(
        "Output RMS / Peak : {:.2} dBFS / {:.2} dBFS",
        output_rms_dbfs, output_peak_dbfs
    );
    println!("Clipped (>=0.99)  : {} samples", clipped_samples);
    println!(
        "Gate Open / Toggle: {:.1}% ({} transitions)",
        gate_open_pct, res.gate_transitions
    );
    println!(
        "Eff Thresh dB     : min {:.2} / avg {:.2} / max {:.2}",
        res.eff_thresh_min_db, res.eff_thresh_avg_db, res.eff_thresh_max_db
    );
    println!(
        "DSP Frame Time    : avg {:.1} us / max {} us / overruns(>8ms) {} / RT CPU {:.2}%",
        res.avg_frame_us, res.max_frame_us, res.overrun_frames_gt_8ms, realtime_cpu_pct
    );

    let summary_json = serde_json::json!({
        "profile": cli.profile.as_str(),
        "mode": cli.mode_label,
        "duration_sec": (duration_sec * 1000.0).round() / 1000.0,
        "frames_10ms": res.frames_10ms,
        "input_rms_dbfs": (input_rms_dbfs * 100.0).round() / 100.0,
        "input_peak_dbfs": (input_peak_dbfs * 100.0).round() / 100.0,
        "output_rms_dbfs": (output_rms_dbfs * 100.0).round() / 100.0,
        "output_peak_dbfs": (output_peak_dbfs * 100.0).round() / 100.0,
        "clipped_samples": clipped_samples,
        "gate_open_pct": (gate_open_pct * 100.0).round() / 100.0,
        "gate_transitions": res.gate_transitions,
        "eff_thresh_min_db": (res.eff_thresh_min_db * 100.0).round() / 100.0,
        "eff_thresh_max_db": (res.eff_thresh_max_db * 100.0).round() / 100.0,
        "eff_thresh_avg_db": (res.eff_thresh_avg_db * 100.0).round() / 100.0,
        "avg_frame_us": (res.avg_frame_us * 100.0).round() / 100.0,
        "max_frame_us": res.max_frame_us,
        "overrun_frames_gt_8ms": res.overrun_frames_gt_8ms,
        "realtime_cpu_pct": (realtime_cpu_pct * 100.0).round() / 100.0,
    });
    println!("JSON_SUMMARY: {summary_json}");
    Ok(())
}

fn main() {
    if let Err(err) = run() {
        eprintln!("epilod_voice_lab error: {err}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame_rms_db(samples: &[f32], frame_idx: usize) -> f32 {
        let start = frame_idx * VOICE_FRAME_10MS;
        frame_dbfs(&samples[start..start + VOICE_FRAME_10MS])
    }

    #[test]
    fn final_timeline_stays_aligned_across_gate_open_preroll_and_reopen() {
        // 180 x 10 ms frames = 1.8 s @ 48 kHz:
        // - 0..30: silence
        // - 30..60: vocal-like tone burst 1
        // - 60..110: 500 ms silence (exceeds 200 ms gate hangover so gate closes)
        // - 110..140: vocal-like tone burst 2 (80 frames after burst 1)
        // - 140..180: silence
        let total_frames = 180usize;
        let mut input = vec![0.0f32; total_frames * VOICE_FRAME_10MS];
        for (start_f, end_f) in [(30usize, 60usize), (110usize, 140usize)] {
            for i in (start_f * VOICE_FRAME_10MS)..(end_f * VOICE_FRAME_10MS) {
                let t = (i as f32) / (VOICE_SAMPLE_RATE as f32);
                input[i] = 0.20 * (2.0 * std::f32::consts::PI * 160.0 * t).sin()
                    + 0.12 * (2.0 * std::f32::consts::PI * 650.0 * t).sin()
                    + 0.06 * (2.0 * std::f32::consts::PI * 1900.0 * t).sin();
            }
        }

        // Test with NoiseSuppressionMode::Off so zero algorithmic delay isolates gate pre-roll alignment.
        let res = process_samples(
            &input,
            Profile::Current,
            NoiseSuppressionMode::Off,
            VoiceDenoiserOptions::default(),
            false,
            WebRtcAgc2Params::default(),
            -38.0,
            false,
            true,
            true,
        );

        assert_eq!(res.final_samples.len(), input.len());
        assert_eq!(res.stage_gated.len(), input.len());
        assert!(res.gate_transitions >= 4, "expected 2 open+close cycles");

        // Leading silence must stay silent (allowing at most 2 pre-roll frames before frame 30)
        for f in 0..28 {
            assert!(
                frame_rms_db(&res.final_samples, f) < -70.0,
                "expected silence at frame {f}"
            );
        }

        let burst1_start = (28..50)
            .find(|&f| frame_rms_db(&res.final_samples, f) > -40.0)
            .expect("burst 1 should appear in 05_final");
        assert!(
            (burst1_start as i32 - 30).abs() <= 2,
            "burst 1 misaligned: got frame {burst1_start}, expected ~30"
        );

        // Silence gap after hangover must stay silent
        for f in 85..108 {
            assert!(
                frame_rms_db(&res.final_samples, f) < -70.0,
                "expected silence in gap at frame {f}"
            );
        }

        let burst2_start = (108..130)
            .find(|&f| frame_rms_db(&res.final_samples, f) > -40.0)
            .expect("burst 2 should appear in 05_final");
        assert!(
            (burst2_start as i32 - 110).abs() <= 2,
            "burst 2 drifted after burst 1 pre-roll: got frame {burst2_start}, expected ~110"
        );
    }
}
