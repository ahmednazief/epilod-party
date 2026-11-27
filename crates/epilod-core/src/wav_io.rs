use std::fs;
use std::io::Write;
use std::path::Path;

/// Reads a standard RIFF/WAVE file (PCM 16-bit or IEEE Float 32-bit, including
/// `WAVE_FORMAT_EXTENSIBLE`) and returns `(sample_rate, mono_samples_f32)`.
pub fn read_wav_mono_f32(path: &Path) -> Result<(u32, Vec<f32>), String> {
    let bytes =
        fs::read(path).map_err(|e| format!("Failed reading WAV {}: {e}", path.display()))?;
    parse_wav_bytes_mono_f32(&bytes)
}

/// Parses WAV bytes into `(sample_rate, mono_samples_f32)`.
pub fn parse_wav_bytes_mono_f32(bytes: &[u8]) -> Result<(u32, Vec<f32>), String> {
    if bytes.len() < 12 {
        return Err("WAV file too small for RIFF/WAVE header".to_string());
    }
    if &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err("Invalid WAV header (expected RIFF/WAVE)".to_string());
    }

    let mut fmt_audio_format: Option<u16> = None;
    let mut num_channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut bits_per_sample: u16 = 0;
    let mut data_slice: Option<&[u8]> = None;

    let mut pos = 12usize;
    while pos + 8 <= bytes.len() {
        let chunk_id = &bytes[pos..pos + 4];
        let chunk_size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let data_start = pos + 8;
        let data_end = data_start.saturating_add(chunk_size).min(bytes.len());
        let chunk = &bytes[data_start..data_end];

        if chunk_id == b"fmt " {
            if chunk.len() < 16 {
                return Err("Truncated WAV fmt chunk".to_string());
            }
            let raw_fmt = u16::from_le_bytes([chunk[0], chunk[1]]);
            num_channels = u16::from_le_bytes([chunk[2], chunk[3]]);
            sample_rate = u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]);
            bits_per_sample = u16::from_le_bytes([chunk[14], chunk[15]]);

            let resolved_fmt = if raw_fmt == 0xFFFE {
                if chunk.len() < 26 {
                    return Err("Truncated WAVE_FORMAT_EXTENSIBLE fmt chunk".to_string());
                }
                u16::from_le_bytes([chunk[24], chunk[25]])
            } else {
                raw_fmt
            };
            fmt_audio_format = Some(resolved_fmt);
        } else if chunk_id == b"data" {
            data_slice = Some(chunk);
        }

        // RIFF chunks are word-aligned (even byte boundary)
        pos = data_start
            .saturating_add(chunk_size)
            .saturating_add(chunk_size & 1);
    }

    let audio_format = fmt_audio_format.ok_or_else(|| "WAV missing fmt chunk".to_string())?;
    let raw_data = data_slice.ok_or_else(|| "WAV missing data chunk".to_string())?;
    if num_channels == 0 || sample_rate == 0 {
        return Err(format!(
            "Invalid WAV format: channels={num_channels}, sample_rate={sample_rate}"
        ));
    }
    let ch_count = num_channels as usize;

    let mono = match (audio_format, bits_per_sample) {
        (1, 16) => {
            let bytes_per_frame = ch_count * 2;
            let frame_count = raw_data.len() / bytes_per_frame;
            let mut out = Vec::with_capacity(frame_count);
            let inv_ch = 1.0 / (ch_count as f32);
            for frame in raw_data.chunks_exact(bytes_per_frame) {
                let mut sum = 0.0f32;
                for c in 0..ch_count {
                    let s = i16::from_le_bytes([frame[c * 2], frame[c * 2 + 1]]);
                    sum += (s as f32) / 32768.0;
                }
                out.push(sum * inv_ch);
            }
            out
        }
        (3, 32) => {
            let bytes_per_frame = ch_count * 4;
            let frame_count = raw_data.len() / bytes_per_frame;
            let mut out = Vec::with_capacity(frame_count);
            let inv_ch = 1.0 / (ch_count as f32);
            for frame in raw_data.chunks_exact(bytes_per_frame) {
                let mut sum = 0.0f32;
                for c in 0..ch_count {
                    let s = f32::from_le_bytes([
                        frame[c * 4],
                        frame[c * 4 + 1],
                        frame[c * 4 + 2],
                        frame[c * 4 + 3],
                    ]);
                    sum += if s.is_finite() { s } else { 0.0 };
                }
                out.push(sum * inv_ch);
            }
            out
        }
        _ => {
            return Err(format!(
                "Unsupported WAV encoding: format={audio_format}, bits_per_sample={bits_per_sample} (expected PCM 16-bit or IEEE float 32-bit)"
            ));
        }
    };

    Ok((sample_rate, mono))
}

/// Writes mono floating-point PCM in `[-1.0, 1.0]` as a standard 16-bit PCM RIFF/WAVE file.
pub fn write_wav_mono_i16(path: &Path, sample_rate: u32, samples: &[f32]) -> Result<(), String> {
    if sample_rate == 0 {
        return Err("Sample rate must be non-zero".to_string());
    }
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed creating WAV parent dir {}: {e}", parent.display()))?;
        }
    }

    let data_bytes = samples
        .len()
        .checked_mul(2)
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| "WAV output exceeds 4 GB RIFF size limit".to_string())?;
    let riff_size = data_bytes
        .checked_add(36)
        .ok_or_else(|| "WAV RIFF size overflow".to_string())?;
    let byte_rate = sample_rate.saturating_mul(2);

    let file = fs::File::create(path)
        .map_err(|e| format!("Failed creating WAV {}: {e}", path.display()))?;
    let mut writer = std::io::BufWriter::new(file);

    writer
        .write_all(b"RIFF")
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&riff_size.to_le_bytes())
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(b"WAVE")
        .map_err(|e| format!("WAV write failed: {e}"))?;

    writer
        .write_all(b"fmt ")
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&16u32.to_le_bytes())
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&1u16.to_le_bytes()) // PCM
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&1u16.to_le_bytes()) // mono
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&sample_rate.to_le_bytes())
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&byte_rate.to_le_bytes())
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&2u16.to_le_bytes()) // block align
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&16u16.to_le_bytes()) // bits per sample
        .map_err(|e| format!("WAV write failed: {e}"))?;

    writer
        .write_all(b"data")
        .map_err(|e| format!("WAV write failed: {e}"))?;
    writer
        .write_all(&data_bytes.to_le_bytes())
        .map_err(|e| format!("WAV write failed: {e}"))?;

    for &s in samples {
        let pcm = if s.is_finite() {
            (s.clamp(-1.0, 1.0) * 32767.0).round() as i16
        } else {
            0i16
        };
        writer
            .write_all(&pcm.to_le_bytes())
            .map_err(|e| format!("WAV sample write failed: {e}"))?;
    }
    writer
        .flush()
        .map_err(|e| format!("WAV flush failed: {e}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_wav_path(tag: &str) -> std::path::PathBuf {
        let uniq = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("epilod-wav-{tag}-{uniq}.wav"))
    }

    #[test]
    fn wav_pcm16_roundtrip_preserves_sample_rate_and_values() {
        let path = temp_wav_path("roundtrip");
        let input: Vec<f32> = (0..960)
            .map(|i| 0.4 * (2.0 * std::f32::consts::PI * 300.0 * (i as f32) / 48_000.0).sin())
            .collect();
        write_wav_mono_i16(&path, 48_000, &input).unwrap();
        let (sr, decoded) = read_wav_mono_f32(&path).unwrap();
        let _ = fs::remove_file(&path);

        assert_eq!(sr, 48_000);
        assert_eq!(decoded.len(), input.len());
        for (a, b) in input.iter().zip(decoded.iter()) {
            assert!((a - b).abs() < 1e-4, "mismatch: {a} vs {b}");
        }
    }

    #[test]
    fn wav_stereo_downmix_and_float32_and_extra_chunks_work() {
        // Build IEEE float 32-bit stereo WAV with an odd-sized JUNK chunk before fmt
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&0u32.to_le_bytes()); // patch later
        buf.extend_from_slice(b"WAVE");

        // Odd-sized JUNK chunk (3 bytes + 1 padding byte)
        buf.extend_from_slice(b"JUNK");
        buf.extend_from_slice(&3u32.to_le_bytes());
        buf.extend_from_slice(&[1, 2, 3, 0]);

        // fmt chunk (IEEE float 32-bit, stereo, 48 kHz)
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&3u16.to_le_bytes());
        buf.extend_from_slice(&2u16.to_le_bytes());
        buf.extend_from_slice(&48_000u32.to_le_bytes());
        buf.extend_from_slice(&(48_000u32 * 8).to_le_bytes());
        buf.extend_from_slice(&8u16.to_le_bytes());
        buf.extend_from_slice(&32u16.to_le_bytes());

        // data chunk: 2 stereo frames: (0.6, 0.2) -> 0.4, (-0.5, 0.5) -> 0.0
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&16u32.to_le_bytes());
        for s in [0.6f32, 0.2f32, -0.5f32, 0.5f32] {
            buf.extend_from_slice(&s.to_le_bytes());
        }
        let riff_len = (buf.len() - 8) as u32;
        buf[4..8].copy_from_slice(&riff_len.to_le_bytes());

        let (sr, mono) = parse_wav_bytes_mono_f32(&buf).unwrap();
        assert_eq!(sr, 48_000);
        assert_eq!(mono.len(), 2);
        assert!((mono[0] - 0.4).abs() < 1e-6);
        assert!(mono[1].abs() < 1e-6);
    }
}
