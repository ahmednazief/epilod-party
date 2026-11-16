use serde::{Deserialize, Serialize};

use crate::matching::detect_fps_suggestion;
use crate::p2p::{decode_base64_url, encode_base64_url};
use crate::subtitle_sync::{
    downsample_2x, fft_correlate_with_precomputed_y, fft_radix2, measure_background_z,
    AudioEnvelopeBuilder, SubtitleSyncError,
};
use crate::syncplay::{fit_two_point_timeline_transform, TimelineSegment, TimelineTransform};

pub const PROBE_FPS: f64 = 50.0;
pub const PROBE_WINDOW_SECS: f64 = 20.0;
pub const PROBE_MIN_CORR: f64 = 0.24;
pub const PROBE_MIN_Z: f64 = 4.5;
pub const MAX_CUT_BISECT_ROUNDS: usize = 4;

/// Quantized dual-band 50 Hz audio probe extracted from one ~20 s timeline window.
#[derive(Debug, Clone, PartialEq)]
pub struct SparseAudioProbe {
    pub anchor_room_secs: f64,
    pub duration_secs: f64,
    pub speech_50: Vec<u8>,
    pub broadband_50: Vec<u8>,
}

/// Compact wire representation sent between Epilod peers over the direct P2P socket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SparseAudioProbeWire {
    pub anchor_room_secs: f64,
    pub duration_secs: f64,
    pub speech_b64: String,
    pub broadband_b64: String,
}

impl SparseAudioProbe {
    pub fn to_wire(&self) -> SparseAudioProbeWire {
        SparseAudioProbeWire {
            anchor_room_secs: self.anchor_room_secs,
            duration_secs: self.duration_secs,
            speech_b64: encode_base64_url(&self.speech_50),
            broadband_b64: encode_base64_url(&self.broadband_50),
        }
    }

    pub fn from_wire(wire: &SparseAudioProbeWire) -> Option<Self> {
        if !wire.anchor_room_secs.is_finite()
            || wire.anchor_room_secs < 0.0
            || !wire.duration_secs.is_finite()
            || wire.duration_secs < 8.0
            || wire.duration_secs > 45.0
        {
            return None;
        }
        let speech_50 = decode_base64_url(&wire.speech_b64)?;
        let broadband_50 = decode_base64_url(&wire.broadband_b64)?;
        if speech_50.len() < 350 || speech_50.len() != broadband_50.len() || speech_50.len() > 2500
        {
            return None;
        }
        Some(Self {
            anchor_room_secs: wire.anchor_room_secs,
            duration_secs: wire.duration_secs,
            speech_50,
            broadband_50,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DualEnvelope50Hz {
    pub speech: Vec<f64>,
    pub broadband: Vec<f64>,
}

/// Converts raw mono 8000 Hz `s16le` PCM into normalized 50 Hz `(speech, broadband)` vectors.
pub fn extract_dual_envelope_50hz_from_pcm_8k(
    pcm_s16le: &[u8],
) -> Result<DualEnvelope50Hz, SubtitleSyncError> {
    let mut builder = AudioEnvelopeBuilder::with_sample_rate(8_000);
    builder.push_pcm_s16le_bytes(pcm_s16le);
    let (sp_100, br_100) = builder.finish_dual_bands()?;
    Ok(DualEnvelope50Hz {
        speech: downsample_2x(&sp_100),
        broadband: downsample_2x(&br_100),
    })
}

pub fn quantize_u8(env: &[f64]) -> Vec<u8> {
    env.iter()
        .map(|&v| {
            let clamped = if v.is_finite() {
                v.clamp(0.0, 1.0)
            } else {
                0.0
            };
            (clamped * 255.0).round() as u8
        })
        .collect()
}

pub fn dequantize_u8(bytes: &[u8]) -> Vec<f64> {
    bytes.iter().map(|&b| (b as f64) / 255.0).collect()
}

pub fn build_probe_from_pcm_8k(
    anchor_room_secs: f64,
    pcm_s16le: &[u8],
) -> Result<SparseAudioProbe, SubtitleSyncError> {
    let env = extract_dual_envelope_50hz_from_pcm_8k(pcm_s16le)?;
    let bin_len = env.speech.len().min(env.broadband.len());
    if bin_len < 350 {
        return Err(SubtitleSyncError::InsufficientAudio);
    }
    Ok(SparseAudioProbe {
        anchor_room_secs: anchor_room_secs.max(0.0),
        duration_secs: (bin_len as f64) / PROBE_FPS,
        speech_50: quantize_u8(&env.speech[..bin_len]),
        broadband_50: quantize_u8(&env.broadband[..bin_len]),
    })
}

/// Picks up to 4 fast sparse probe windows `(start_secs, duration_secs)` spaced across the media.
pub fn pick_sparse_probe_windows(duration_secs: f64) -> Vec<(f64, f64)> {
    if !duration_secs.is_finite() || duration_secs <= 12.0 {
        return Vec::new();
    }
    if duration_secs < 45.0 {
        let len = (duration_secs - 2.0).clamp(10.0, PROBE_WINDOW_SECS);
        return vec![(0.0, len)];
    }
    if duration_secs < 240.0 {
        let max_start = (duration_secs - PROBE_WINDOW_SECS - 2.0).max(0.0);
        let raw = [
            (duration_secs * 0.08).min(max_start),
            (duration_secs * 0.45).min(max_start),
            (duration_secs * 0.80).min(max_start),
        ];
        return dedup_windows(&raw, PROBE_WINDOW_SECS);
    }

    let max_start = (duration_secs - PROBE_WINDOW_SECS - 4.0).max(0.0);
    let raw = [
        (duration_secs * 0.05).clamp(45.0, 120.0).min(max_start),
        (duration_secs * 0.28).min(max_start),
        (duration_secs * 0.56).min(max_start),
        (duration_secs * 0.84).min(max_start),
    ];
    dedup_windows(&raw, PROBE_WINDOW_SECS)
}

fn dedup_windows(starts: &[f64], win_secs: f64) -> Vec<(f64, f64)> {
    let mut out: Vec<(f64, f64)> = Vec::with_capacity(starts.len());
    for &s in starts {
        if out
            .last()
            .is_none_or(|&(prev, _)| (s - prev).abs() >= win_secs + 5.0)
        {
            out.push((s.max(0.0), win_secs));
        }
    }
    out
}

pub fn candidate_fps_scales(ref_duration_secs: f64, local_duration_secs: f64) -> Vec<f64> {
    let pal = 25.0f64;
    let ntsc_film = 24_000.0 / 1001.0;
    let pal_to_ntsc = ntsc_film / pal;
    let ntsc_to_pal = pal / ntsc_film;
    let mut scales = Vec::with_capacity(3);
    if let Some((hinted, _)) = detect_fps_suggestion(local_duration_secs, ref_duration_secs) {
        // Note: detect_fps_suggestion returns scale `local / room`? Verify direction via ratio.
        let dur_ratio = if ref_duration_secs > 0.0 {
            local_duration_secs / ref_duration_secs
        } else {
            1.0
        };
        let picked = if (hinted - dur_ratio).abs() < (1.0 / hinted - dur_ratio).abs() {
            hinted
        } else {
            1.0 / hinted
        };
        scales.push(picked);
    }
    for cand in [1.0, pal_to_ntsc, ntsc_to_pal] {
        if !scales.iter().any(|&s| (s - cand).abs() < 1e-4) {
            scales.push(cand);
        }
    }
    scales
}

fn resample_linear(src: &[f64], scale: f64) -> Vec<f64> {
    if (scale - 1.0).abs() < 1e-5 || src.len() < 4 {
        return src.to_vec();
    }
    let out_len = ((src.len() as f64) * scale).round().max(4.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src_pos = ((i as f64) / scale).clamp(0.0, (src.len() - 1) as f64);
        let lo = src_pos.floor() as usize;
        let hi = (lo + 1).min(src.len() - 1);
        let frac = src_pos - (lo as f64);
        out.push(src[lo] * (1.0 - frac) + src[hi] * frac);
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProbeMatch {
    pub room_secs: f64,
    pub local_secs: f64,
    pub scale_used: f64,
    pub correlation: f64,
    pub z_score: f64,
}

fn correlate_1d(needle: &[f64], haystack: &[f64]) -> Option<(f64, f64, f64)> {
    let k_len = needle.len();
    if k_len < 120 || haystack.len() <= k_len + 20 {
        return None;
    }

    let nf = k_len as f64;
    let sum_x: f64 = needle.iter().sum();
    let sum_x2: f64 = needle.iter().map(|v| v * v).sum();
    let var_x = nf * sum_x2 - sum_x * sum_x;
    if var_x <= 1e-8 {
        return None;
    }

    let mut pref_y = Vec::with_capacity(haystack.len() + 1);
    let mut pref_y2 = Vec::with_capacity(haystack.len() + 1);
    pref_y.push(0.0);
    pref_y2.push(0.0);
    for &v in haystack {
        let s = pref_y.last().copied().unwrap_or(0.0) + v;
        let s2 = pref_y2.last().copied().unwrap_or(0.0) + v * v;
        pref_y.push(s);
        pref_y2.push(s2);
    }

    let n_fft = (k_len + haystack.len()).max(2).next_power_of_two();
    let mut y_re = vec![0.0f64; n_fft];
    let mut y_im = vec![0.0f64; n_fft];
    y_re[..haystack.len()].copy_from_slice(haystack);
    fft_radix2(&mut y_re, &mut y_im, false);

    let max_shift = (haystack.len() - k_len) as isize;
    let raw = fft_correlate_with_precomputed_y(needle, &y_re, &y_im, 0, max_shift);
    if raw.len() < 30 {
        return None;
    }

    let mut ncc = Vec::with_capacity(raw.len());
    let mut best_idx = 0usize;
    let mut best_r = f64::NEG_INFINITY;
    for (i, (shift, sum_xy)) in raw.into_iter().enumerate() {
        let s = shift as usize;
        let e = s + k_len;
        let sy = pref_y[e] - pref_y[s];
        let sy2 = pref_y2[e] - pref_y2[s];
        let var_y = nf * sy2 - sy * sy;
        let r = if var_y <= 1e-8 {
            0.0
        } else {
            let den = (var_x * var_y).sqrt();
            if den <= 1e-12 {
                0.0
            } else {
                ((nf * sum_xy - sum_x * sy) / den).clamp(-1.0, 1.0)
            }
        };
        if r > best_r {
            best_r = r;
            best_idx = i;
        }
        ncc.push((shift, r));
    }

    if !best_r.is_finite() {
        return None;
    }

    let best_shift = ncc[best_idx].0;
    let z = measure_background_z(&ncc, best_shift, best_r, 75);

    // Parabolic sub-bin interpolation around peak for ~5-10 ms precision
    let mut refined_shift = best_shift as f64;
    if best_idx > 0 && best_idx + 1 < ncc.len() {
        let r0 = ncc[best_idx - 1].1;
        let r1 = ncc[best_idx].1;
        let r2 = ncc[best_idx + 1].1;
        let denom = r0 - 2.0 * r1 + r2;
        if denom.abs() > 1e-8 {
            let delta = (0.5 * (r0 - r2) / denom).clamp(-0.5, 0.5);
            refined_shift += delta;
        }
    }

    Some((refined_shift, best_r, z))
}

/// Locates `probe` inside a local haystack slice extracted from `haystack_start_local_secs`.
pub fn match_probe_in_haystack(
    probe: &SparseAudioProbe,
    haystack_start_local_secs: f64,
    haystack: &DualEnvelope50Hz,
    scales_to_try: &[f64],
) -> Option<ProbeMatch> {
    let needle_sp = dequantize_u8(&probe.speech_50);
    let needle_br = dequantize_u8(&probe.broadband_50);
    let mut best: Option<ProbeMatch> = None;

    for &scale in scales_to_try {
        let sp_scaled = resample_linear(&needle_sp, scale);
        let br_scaled = resample_linear(&needle_br, scale);

        for cand in [
            correlate_1d(&sp_scaled, &haystack.speech),
            correlate_1d(&br_scaled, &haystack.broadband),
        ]
        .into_iter()
        .flatten()
        {
            let (shift_bins, corr, z) = cand;
            if corr < PROBE_MIN_CORR || z < PROBE_MIN_Z {
                continue;
            }
            let local_secs = (haystack_start_local_secs + shift_bins / PROBE_FPS).max(0.0);
            let score = corr * z.min(20.0);
            let replace = best
                .as_ref()
                .is_none_or(|b| score > b.correlation * b.z_score.min(20.0));
            if replace {
                best = Some(ProbeMatch {
                    room_secs: probe.anchor_room_secs,
                    local_secs,
                    scale_used: scale,
                    correlation: corr,
                    z_score: z,
                });
            }
        }
    }

    best
}

#[derive(Debug, Clone, PartialEq)]
pub enum AlignmentAnalysis {
    Linear {
        transform: TimelineTransform,
        confidence: f64,
    },
    NeedsCutBisect {
        provisional_transform: TimelineTransform,
        bisect_room_secs: f64,
        left_room_secs: f64,
        right_room_secs: f64,
    },
    Piecewise {
        transform: TimelineTransform,
        segments: Vec<TimelineSegment>,
        confidence: f64,
    },
    Inconclusive,
}

fn snap_scale_ratio(raw_scale: f64) -> f64 {
    let ntsc_film = 24_000.0 / 1001.0;
    let candidates = [
        (1.0, 0.0012),
        (ntsc_film / 25.0, 0.002),
        (25.0 / ntsc_film, 0.002),
        (24.0 / 25.0, 0.002),
        (25.0 / 24.0, 0.002),
        (ntsc_film / 24.0, 0.0004),
        (24.0 / ntsc_film, 0.0004),
    ];
    let mut best = raw_scale.clamp(0.5, 2.0);
    let mut best_dist = f64::INFINITY;
    for (cand, tol) in candidates {
        let dist = (raw_scale - cand).abs();
        if dist <= tol && dist < best_dist {
            best_dist = dist;
            best = cand;
        }
    }
    best
}

fn median_f64(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut sorted = values.to_vec();
    sorted.sort_unstable_by(|a, b| a.total_cmp(b));
    sorted[sorted.len() / 2]
}

fn eval_linear_residual(matches: &[ProbeMatch], scale: f64) -> (f64, f64) {
    let offsets: Vec<f64> = matches
        .iter()
        .map(|m| m.local_secs - scale * m.room_secs)
        .collect();
    let offset = median_f64(&offsets);
    let max_res = matches
        .iter()
        .map(|m| (m.local_secs - (scale * m.room_secs + offset)).abs())
        .fold(0.0f64, f64::max);
    (offset, max_res)
}

#[derive(Debug, Clone)]
pub struct BisectObservation {
    pub room_secs: f64,
    pub matched: Option<ProbeMatch>,
}

/// Evaluates sparse audio anchor matches across the timeline, returning a Linear fit, a
/// mid-movie cut bisection request, or finalized Piecewise segments.
pub fn analyze_probe_matches(
    matches: &[ProbeMatch],
    unmatched_room_probes: &[f64],
    duration_secs: f64,
    bisect_rounds_done: usize,
) -> AlignmentAnalysis {
    let mut sorted = matches.to_vec();
    sorted.sort_by(|a, b| a.room_secs.total_cmp(&b.room_secs));
    sorted.dedup_by(|a, b| (a.room_secs - b.room_secs).abs() < 1.0);

    if sorted.is_empty() {
        return AlignmentAnalysis::Inconclusive;
    }

    if sorted.len() == 1 {
        let m = &sorted[0];
        let scale = snap_scale_ratio(m.scale_used);
        let tx = TimelineTransform {
            offset_secs: m.local_secs - scale * m.room_secs,
            scale,
        }
        .sanitized();
        if duration_secs < 120.0 {
            return AlignmentAnalysis::Linear {
                transform: tx,
                confidence: m.correlation,
            };
        }
        return AlignmentAnalysis::Linear {
            transform: tx,
            confidence: m.correlation * 0.75,
        };
    }

    // 1. Check linear transform candidates: scale=1.0, dominant scale_used, and outermost two-point slope.
    let mut scale_candidates = vec![1.0, snap_scale_ratio(sorted[0].scale_used)];
    let first = &sorted[0];
    let last = &sorted[sorted.len() - 1];
    if let Some(fitted) = fit_two_point_timeline_transform(
        first.room_secs,
        first.local_secs,
        last.room_secs,
        last.local_secs,
    ) {
        scale_candidates.push(fitted.scale);
    }

    let mut best_linear: Option<(TimelineTransform, f64)> = None;
    for sc in scale_candidates {
        let (off, max_res) = eval_linear_residual(&sorted, sc);
        if best_linear
            .as_ref()
            .is_none_or(|(_, best_res)| max_res < *best_res)
        {
            best_linear = Some((
                TimelineTransform {
                    offset_secs: off,
                    scale: sc,
                }
                .sanitized(),
                max_res,
            ));
        }
    }

    let avg_corr = sorted.iter().map(|m| m.correlation).sum::<f64>() / (sorted.len() as f64);

    if let Some((tx, max_res)) = best_linear {
        if max_res <= 0.45 {
            return AlignmentAnalysis::Linear {
                transform: tx,
                confidence: avg_corr,
            };
        }
    }

    // 2. Mid-movie cut detected: check which dominant scale applies within local segments.
    let consensus_scale = snap_scale_ratio(median_f64(
        &sorted.iter().map(|m| m.scale_used).collect::<Vec<_>>(),
    ));

    let offset_at = |m: &ProbeMatch| -> f64 { m.local_secs - consensus_scale * m.room_secs };

    let provisional = TimelineTransform {
        offset_secs: offset_at(&sorted[0]),
        scale: consensus_scale,
    }
    .sanitized();

    // Find first adjacent confident anchor pair whose offset jumps by > 0.65 s
    let mut bisect_candidate: Option<(usize, f64, f64, f64)> = None;
    for pair_idx in 0..(sorted.len() - 1) {
        let left = &sorted[pair_idx];
        let right = &sorted[pair_idx + 1];
        let jump = (offset_at(right) - offset_at(left)).abs();
        if jump <= 0.65 {
            continue;
        }
        // Account for unmatched (in-cut) probe points between left and right to narrow right half.
        let mut lo = left.room_secs;
        let hi = right.room_secs;
        for &miss in unmatched_room_probes {
            if miss > lo + 5.0 && miss < hi - 5.0 {
                lo = lo.max(miss);
            }
        }
        let span = hi - lo;
        if span > 45.0 {
            let mid = (lo + hi) * 0.5;
            if !unmatched_room_probes
                .iter()
                .any(|&u| (u - mid).abs() < 15.0)
            {
                bisect_candidate = Some((pair_idx, lo, hi, mid));
                break;
            }
        }
    }

    if let Some((_, left_r, right_r, mid)) = bisect_candidate {
        if bisect_rounds_done < MAX_CUT_BISECT_ROUNDS {
            return AlignmentAnalysis::NeedsCutBisect {
                provisional_transform: provisional,
                bisect_room_secs: mid,
                left_room_secs: left_r,
                right_room_secs: right_r,
            };
        }
    }

    // 3. Finalize piecewise segments from sorted anchors.
    let segments = build_piecewise_segments(&sorted, consensus_scale);
    let base_tx = segments
        .first()
        .map(|s| TimelineTransform {
            offset_secs: s.offset_secs,
            scale: s.scale,
        })
        .unwrap_or(provisional);

    AlignmentAnalysis::Piecewise {
        transform: base_tx,
        segments,
        confidence: avg_corr,
    }
}

pub fn build_piecewise_segments(matches: &[ProbeMatch], scale: f64) -> Vec<TimelineSegment> {
    if matches.is_empty() {
        return Vec::new();
    }
    let offset_of = |m: &ProbeMatch| -> f64 { m.local_secs - scale * m.room_secs };

    // Cluster consecutive points sharing the same offset (within 0.65 s)
    let mut clusters: Vec<(f64, f64, Vec<f64>)> = Vec::new(); // (first_room, last_room, offsets)
    for m in matches {
        let off = offset_of(m);
        if let Some(last) = clusters.last_mut() {
            let cur_med = median_f64(&last.2);
            if (off - cur_med).abs() <= 0.65 {
                last.1 = last.1.max(m.room_secs);
                last.2.push(off);
                continue;
            }
        }
        clusters.push((m.room_secs, m.room_secs, vec![off]));
    }

    if clusters.len() <= 1 {
        let off = clusters
            .first()
            .map(|c| median_f64(&c.2))
            .unwrap_or_else(|| offset_of(&matches[0]));
        return vec![TimelineSegment {
            room_start_secs: 0.0,
            offset_secs: off,
            scale,
            hold_room_until_secs: None,
        }
        .sanitized()];
    }

    let mut segments = Vec::with_capacity(clusters.len() * 2);
    let off0 = median_f64(&clusters[0].2);
    segments.push(
        TimelineSegment {
            room_start_secs: 0.0,
            offset_secs: off0,
            scale,
            hold_room_until_secs: None,
        }
        .sanitized(),
    );

    for i in 1..clusters.len() {
        let prev_end_room = clusters[i - 1].1;
        let next_start_room = clusters[i].0;
        let prev_off = median_f64(&clusters[i - 1].2);
        let next_off = median_f64(&clusters[i].2);
        let delta_off = next_off - prev_off;

        if delta_off < -0.65 {
            // Room has an extra scene (`missing_dur = -delta_off / scale`) that local file lacks:
            // Hold locally paused during `[cut_start_room .. resume_room)`.
            let extra_room_dur = (-delta_off / scale).max(1.0);
            let resume_room = next_start_room;
            let cut_start_room = (resume_room - extra_room_dur).max(prev_end_room);
            let hold_local = (cut_start_room * scale + prev_off).max(0.0);
            segments.push(
                TimelineSegment {
                    room_start_secs: cut_start_room,
                    offset_secs: hold_local,
                    scale,
                    hold_room_until_secs: Some(resume_room),
                }
                .sanitized(),
            );
            segments.push(
                TimelineSegment {
                    room_start_secs: resume_room,
                    offset_secs: next_off,
                    scale,
                    hold_room_until_secs: None,
                }
                .sanitized(),
            );
        } else {
            // Local file has an extra scene; jump straight across at boundary midpoint.
            let boundary_room = (prev_end_room + next_start_room) * 0.5;
            segments.push(
                TimelineSegment {
                    room_start_secs: boundary_room,
                    offset_secs: next_off,
                    scale,
                    hold_room_until_secs: None,
                }
                .sanitized(),
            );
        }
    }

    segments
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth_speech_like_pcm_8k(total_secs: f64, seed_offset: f64, speed_scale: f64) -> Vec<u8> {
        // Deterministic bursty speech-band signal (450-1400 Hz modulated at irregular word intervals)
        let sample_rate = 8_000usize;
        let total_samples = (total_secs * sample_rate as f64).round() as usize;
        let mut out = Vec::with_capacity(total_samples * 2);
        for i in 0..total_samples {
            let t_local = (i as f64) / (sample_rate as f64);
            let t_src = (t_local - seed_offset) / speed_scale;
            if t_src < 0.0 {
                out.extend_from_slice(&0i16.to_le_bytes());
                continue;
            }
            // Irregular SplitMix64 syllable gate so lag correlation is sharply peaked like dialogue
            let idx = (t_src * 3.0).floor() as u64;
            let mut h = idx
                .wrapping_mul(0x9E37_79B9_7F4A_7C15)
                .wrapping_add(0xBF58_476D_1CE4_E5B9);
            h = (h ^ (h >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            h = (h ^ (h >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            h ^= h >> 31;
            let active = (h >> 60) > 6;
            let amp = if active { 9000.0 } else { 180.0 };
            let f1 = 520.0 + ((h >> 48) & 0xFF) as f64 * 2.5;
            let val = (amp * (2.0 * std::f64::consts::PI * f1 * t_src).sin())
                .clamp(-32760.0, 32760.0) as i16;
            out.extend_from_slice(&val.to_le_bytes());
        }
        out
    }

    #[test]
    fn sparse_probe_aligns_offset_and_fps_speedup_with_high_precision() {
        // Room (reference) file: 25 fps; Local file: 23.976 fps + 9.5s studio logo at start
        let pal_to_ntsc = (24_000.0 / 1001.0) / 25.0; // ~0.95904
        let ref_pcm_full = synth_speech_like_pcm_8k(600.0, 0.0, 1.0);
        let local_pcm_full = synth_speech_like_pcm_8k(600.0 * pal_to_ntsc + 20.0, 9.5, pal_to_ntsc);

        let sr_bytes = 8_000 * 2;
        let slice_pcm = |buf: &[u8], start_s: f64, dur_s: f64| -> Vec<u8> {
            let s = ((start_s * sr_bytes as f64).round() as usize).min(buf.len());
            let e = (((start_s + dur_s) * sr_bytes as f64).round() as usize).min(buf.len());
            buf[s & !1..e & !1].to_vec()
        };

        let probe_times = [60.0, 220.0, 420.0];
        let mut matches = Vec::new();
        for &rt in &probe_times {
            let needle_pcm = slice_pcm(&ref_pcm_full, rt, 20.0);
            let probe = build_probe_from_pcm_8k(rt, &needle_pcm).expect("probe");
            let hay_start = (rt - 80.0).max(0.0);
            let hay_pcm = slice_pcm(&local_pcm_full, hay_start, 180.0);
            let hay_env = extract_dual_envelope_50hz_from_pcm_8k(&hay_pcm).expect("hay");

            let matched = match_probe_in_haystack(&probe, hay_start, &hay_env, &[1.0, pal_to_ntsc])
                .expect("probe match");
            matches.push(matched);
        }

        let analysis = analyze_probe_matches(&matches, &[], 600.0, 0);
        match analysis {
            AlignmentAnalysis::Linear { transform, .. } => {
                assert!(
                    (transform.scale - pal_to_ntsc).abs() < 1e-4,
                    "scale={}",
                    transform.scale
                );
                assert!(
                    (transform.offset_secs - 9.5).abs() < 0.15,
                    "offset={}",
                    transform.offset_secs
                );
            }
            other => panic!("expected Linear FPS alignment, got {other:?}"),
        }
    }

    #[test]
    fn detects_mid_movie_cut_requests_bisect_and_builds_piecewise_segments() {
        let initial = vec![
            ProbeMatch {
                room_secs: 90.0,
                local_secs: 98.0,
                scale_used: 1.0,
                correlation: 0.72,
                z_score: 12.0,
            },
            ProbeMatch {
                room_secs: 600.0,
                local_secs: 608.0,
                scale_used: 1.0,
                correlation: 0.70,
                z_score: 11.0,
            },
            ProbeMatch {
                room_secs: 1800.0,
                local_secs: 1925.0,
                scale_used: 1.0,
                correlation: 0.71,
                z_score: 12.0,
            },
        ];

        match analyze_probe_matches(&initial, &[], 2400.0, 0) {
            AlignmentAnalysis::NeedsCutBisect {
                bisect_room_secs, ..
            } => {
                assert!((bisect_room_secs - 1200.0).abs() < 1.0);
            }
            other => panic!("expected bisect step, got {other:?}"),
        }

        // After bisection resolves jump around t=1200s (+8 -> +125)
        let refined = vec![
            initial[0].clone(),
            initial[1].clone(),
            ProbeMatch {
                room_secs: 1180.0,
                local_secs: 1188.0,
                scale_used: 1.0,
                correlation: 0.68,
                z_score: 10.0,
            },
            ProbeMatch {
                room_secs: 1215.0,
                local_secs: 1340.0,
                scale_used: 1.0,
                correlation: 0.68,
                z_score: 10.0,
            },
            initial[2].clone(),
        ];
        match analyze_probe_matches(&refined, &[], 2400.0, MAX_CUT_BISECT_ROUNDS) {
            AlignmentAnalysis::Piecewise { segments, .. } => {
                assert_eq!(segments.len(), 2);
                assert!((segments[0].offset_secs - 8.0).abs() < 1e-4);
                assert!((segments[1].offset_secs - 125.0).abs() < 1e-4);
                assert!(
                    segments[1].room_start_secs >= 1180.0 && segments[1].room_start_secs <= 1215.0
                );
            }
            other => panic!("expected Piecewise segments, got {other:?}"),
        }
    }
}
