use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const ENVELOPE_FPS: f64 = 100.0; // 10 ms per bin
const MIN_SPOKEN_CUES: usize = 5;
/// Extra correlation a non-1.0 frame-rate scale must earn over the unscaled alignment.
const DRIFT_CANDIDATE_MARGIN: f64 = 0.03;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SubtitleSyncError {
    #[error("Subtitle file is empty or contains too few dialogue cues.")]
    TooFewCues,
    #[error("Malformed subtitle timestamp or numerical overflow.")]
    InvalidTimestamp,
    #[error("Could not decode subtitle bytes.")]
    DecodeError,
    #[error("Audio track appears silent or too short for alignment.")]
    InsufficientAudio,
    #[error("Could not find a confident alignment ({0}). Try 2-point manual anchor sync.")]
    LowConfidence(String),
    #[error("Invalid anchor timestamps for two-point calibration.")]
    InvalidAnchors,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubtitleEncodingHint {
    #[default]
    Auto,
    Utf8,
    Windows1256,
    Windows1252,
    Windows1251,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubtitleCue {
    pub index: usize,
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct AutoSyncConfig {
    pub max_offset_secs: f64,
    pub check_framerate_drift: bool,
    pub min_z_score: f64,
    pub min_correlation: f64,
}

impl Default for AutoSyncConfig {
    fn default() -> Self {
        Self {
            max_offset_secs: 180.0,
            check_framerate_drift: true,
            min_z_score: 4.5,
            min_correlation: 0.18,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AutoSyncOutcome {
    pub offset_ms: i64,
    pub scale: f64,
    pub anchor_ms: u64,
    pub drift_applied: bool,
    pub confidence_z: f64,
    pub correlation: f64,
}

// Windows-1256 (Arabic) 0x80..=0xFF mapping to Unicode
const CP1256_UPPER: [char; 128] = [
    '\u{20AC}', '\u{067E}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0679}', '\u{2039}', '\u{0152}', '\u{0686}', '\u{0698}', '\u{0688}',
    '\u{06AF}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{06A9}', '\u{2122}', '\u{0691}', '\u{203A}', '\u{0153}', '\u{200C}', '\u{200D}', '\u{06BA}',
    '\u{00A0}', '\u{060C}', '\u{00A2}', '\u{00A3}', '\u{00A4}', '\u{00A5}', '\u{00A6}', '\u{00A7}',
    '\u{00A8}', '\u{00A9}', '\u{06BE}', '\u{00AB}', '\u{00AC}', '\u{00AD}', '\u{00AE}', '\u{00AF}',
    '\u{00B0}', '\u{00B1}', '\u{00B2}', '\u{00B3}', '\u{00B4}', '\u{00B5}', '\u{00B6}', '\u{00B7}',
    '\u{00B8}', '\u{00B9}', '\u{061B}', '\u{00BB}', '\u{00BC}', '\u{00BD}', '\u{00BE}', '\u{061F}',
    '\u{06C1}', '\u{0621}', '\u{0622}', '\u{0623}', '\u{0624}', '\u{0625}', '\u{0626}', '\u{0627}',
    '\u{0628}', '\u{0629}', '\u{062A}', '\u{062B}', '\u{062C}', '\u{062D}', '\u{062E}', '\u{062F}',
    '\u{0630}', '\u{0631}', '\u{0632}', '\u{0633}', '\u{0634}', '\u{0635}', '\u{0636}', '\u{00D7}',
    '\u{0637}', '\u{0638}', '\u{0639}', '\u{063A}', '\u{0640}', '\u{0641}', '\u{0642}', '\u{0643}',
    '\u{00E0}', '\u{0644}', '\u{00E2}', '\u{0645}', '\u{0646}', '\u{0647}', '\u{0648}', '\u{00E7}',
    '\u{00E8}', '\u{00E9}', '\u{00EA}', '\u{00EB}', '\u{0649}', '\u{064A}', '\u{00EE}', '\u{00EF}',
    '\u{064B}', '\u{064C}', '\u{064D}', '\u{064E}', '\u{00F4}', '\u{064F}', '\u{0650}', '\u{00F7}',
    '\u{0651}', '\u{00F9}', '\u{0652}', '\u{00FB}', '\u{00FC}', '\u{200E}', '\u{200F}', '\u{06D2}',
];

// Windows-1252 (Western European) 0x80..=0x9F overrides (0xA0..=0xFF matches Unicode U+00A0..=U+00FF)
const CP1252_80_9F: [char; 32] = [
    '\u{20AC}', '\u{FFFD}', '\u{201A}', '\u{0192}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{02C6}', '\u{2030}', '\u{0160}', '\u{2039}', '\u{0152}', '\u{FFFD}', '\u{017D}', '\u{FFFD}',
    '\u{FFFD}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{02DC}', '\u{2122}', '\u{0161}', '\u{203A}', '\u{0153}', '\u{FFFD}', '\u{017E}', '\u{0178}',
];

// Windows-1251 (Cyrillic) 0x80..=0xBF
const CP1251_80_BF: [char; 64] = [
    '\u{0402}', '\u{0403}', '\u{201A}', '\u{0453}', '\u{201E}', '\u{2026}', '\u{2020}', '\u{2021}',
    '\u{20AC}', '\u{2030}', '\u{0409}', '\u{2039}', '\u{040A}', '\u{040C}', '\u{040B}', '\u{040F}',
    '\u{0452}', '\u{2018}', '\u{2019}', '\u{201C}', '\u{201D}', '\u{2022}', '\u{2013}', '\u{2014}',
    '\u{FFFD}', '\u{2122}', '\u{0459}', '\u{203A}', '\u{045A}', '\u{045C}', '\u{045B}', '\u{045F}',
    '\u{00A0}', '\u{040E}', '\u{045E}', '\u{0408}', '\u{00A4}', '\u{0490}', '\u{00A6}', '\u{00A7}',
    '\u{0401}', '\u{00A9}', '\u{0404}', '\u{00AB}', '\u{00AC}', '\u{00AD}', '\u{00AE}', '\u{0407}',
    '\u{00B0}', '\u{00B1}', '\u{0406}', '\u{0456}', '\u{0491}', '\u{00B5}', '\u{00B6}', '\u{00B7}',
    '\u{0451}', '\u{2116}', '\u{0454}', '\u{00BB}', '\u{0458}', '\u{0405}', '\u{0455}', '\u{0457}',
];

fn decode_cp1256(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if b < 0x80 {
                b as char
            } else {
                CP1256_UPPER[(b - 0x80) as usize]
            }
        })
        .collect()
}

fn decode_cp1252(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if b < 0x80 {
                b as char
            } else if b < 0xA0 {
                CP1252_80_9F[(b - 0x80) as usize]
            } else {
                b as char
            }
        })
        .collect()
}

fn decode_cp1251(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|&b| {
            if b < 0x80 {
                b as char
            } else if b < 0xC0 {
                CP1251_80_BF[(b - 0x80) as usize]
            } else {
                char::from_u32(0x0410 + (b - 0xC0) as u32).unwrap_or('\u{FFFD}')
            }
        })
        .collect()
}

pub fn decode_subtitle_bytes(bytes: &[u8]) -> Result<String, SubtitleSyncError> {
    decode_subtitle_bytes_with_hint(bytes, SubtitleEncodingHint::Auto)
}

/// Fix 25: Decode UTF-8, UTF-16 LE/BE, Windows-1256 (Arabic), Windows-1252 (Western), and Windows-1251 (Cyrillic).
pub fn decode_subtitle_bytes_with_hint(
    bytes: &[u8],
    hint: SubtitleEncodingHint,
) -> Result<String, SubtitleSyncError> {
    if bytes.is_empty() {
        return Err(SubtitleSyncError::DecodeError);
    }
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return std::str::from_utf8(&bytes[3..])
            .map(|s| s.to_string())
            .map_err(|_| SubtitleSyncError::DecodeError);
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        for &pair in bytes[2..].as_chunks::<2>().0 {
            units.push(u16::from_le_bytes(pair));
        }
        return String::from_utf16(&units).map_err(|_| SubtitleSyncError::DecodeError);
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let mut units = Vec::with_capacity((bytes.len() - 2) / 2);
        for &pair in bytes[2..].as_chunks::<2>().0 {
            units.push(u16::from_be_bytes(pair));
        }
        return String::from_utf16(&units).map_err(|_| SubtitleSyncError::DecodeError);
    }

    match hint {
        SubtitleEncodingHint::Utf8 => {
            return std::str::from_utf8(bytes)
                .map(|s| s.to_string())
                .map_err(|_| SubtitleSyncError::DecodeError);
        }
        SubtitleEncodingHint::Windows1256 => return Ok(decode_cp1256(bytes)),
        SubtitleEncodingHint::Windows1252 => return Ok(decode_cp1252(bytes)),
        SubtitleEncodingHint::Windows1251 => return Ok(decode_cp1251(bytes)),
        SubtitleEncodingHint::Auto => {}
    }

    if let Ok(utf8) = std::str::from_utf8(bytes) {
        return Ok(utf8.to_string());
    }

    // Heuristic scoring across Windows-1256 (Arabic), Windows-1251 (Cyrillic), Windows-1252 (Latin)
    let high_bytes: Vec<u8> = bytes.iter().copied().filter(|&b| b >= 0x80).collect();
    if high_bytes.is_empty() {
        return Ok(String::from_utf8_lossy(bytes).into_owned());
    }

    let mut arabic_hits = 0usize;
    let mut cyrillic_hits = 0usize;
    let mut latin_hits = 0usize;
    for &b in &high_bytes {
        // Common Arabic letters in CP1256 sit in 0xC1..=0xDA and 0xE1..=0xF2
        if matches!(b, 0xC1..=0xDA | 0xE1 | 0xE3..=0xE6 | 0xEC..=0xED) {
            arabic_hits += 1;
        }
        // Common Russian lowercase letters in CP1251 sit in 0xE0..=0xFF
        if matches!(b, 0xE0..=0xFF) {
            cyrillic_hits += 1;
        }
        // Common Western accented letters in CP1252 (é, è, ê, à, ç, ñ, ö, ü, etc.)
        if matches!(
            b,
            0xC0..=0xC4 | 0xC7..=0xCF | 0xD1..=0xD6 | 0xDC | 0xE0..=0xE4 | 0xE7..=0xEF | 0xF1..=0xF6 | 0xFC
        ) {
            latin_hits += 1;
        }
    }

    // Arabic text has heavy density in 0xC7..0xDA + 0xE1..0xED (alef/lam/meem/noon/ya),
    // while Western European text rarely uses 0xC1..0xDA uppercase diacritics densely.
    let arabic_distinct = high_bytes
        .iter()
        .filter(|&&b| {
            matches!(
                b,
                0xC7 | 0xC8
                    | 0xCA
                    | 0xCD
                    | 0xCF
                    | 0xD1
                    | 0xD3
                    | 0xD9
                    | 0xE1
                    | 0xE3
                    | 0xE4
                    | 0xE5
                    | 0xE6
                    | 0xED
            )
        })
        .count();

    if arabic_distinct * 3 >= high_bytes.len() && arabic_hits >= latin_hits {
        Ok(decode_cp1256(bytes))
    } else if latin_hits > arabic_distinct * 2 {
        Ok(decode_cp1252(bytes))
    } else if cyrillic_hits > arabic_hits {
        Ok(decode_cp1251(bytes))
    } else {
        Ok(decode_cp1256(bytes))
    }
}

pub fn parse_timestamp_ms(raw: &str) -> Result<u64, SubtitleSyncError> {
    let trimmed = raw.split_whitespace().next().unwrap_or("");
    let normalized = trimmed.replace(',', ".");
    let parts: Vec<&str> = normalized.split(':').collect();
    let (h, m, sec_part) = match parts.as_slice() {
        [h, m, s] => (
            h.parse::<u64>()
                .map_err(|_| SubtitleSyncError::InvalidTimestamp)?,
            m.parse::<u64>()
                .map_err(|_| SubtitleSyncError::InvalidTimestamp)?,
            *s,
        ),
        [m, s] => (
            0u64,
            m.parse::<u64>()
                .map_err(|_| SubtitleSyncError::InvalidTimestamp)?,
            *s,
        ),
        _ => return Err(SubtitleSyncError::InvalidTimestamp),
    };
    if m >= 60 {
        return Err(SubtitleSyncError::InvalidTimestamp);
    }
    let sec_split: Vec<&str> = sec_part.split('.').collect();
    let (s_str, frac_str) = match sec_split.as_slice() {
        [s] => (*s, "0"),
        [s, f] => (*s, *f),
        _ => return Err(SubtitleSyncError::InvalidTimestamp),
    };
    let s = s_str
        .parse::<u64>()
        .map_err(|_| SubtitleSyncError::InvalidTimestamp)?;
    if s >= 60 {
        return Err(SubtitleSyncError::InvalidTimestamp);
    }
    let ms = match frac_str.len() {
        0 => 0,
        1 => {
            frac_str
                .parse::<u64>()
                .map_err(|_| SubtitleSyncError::InvalidTimestamp)?
                * 100
        }
        2 => {
            frac_str
                .parse::<u64>()
                .map_err(|_| SubtitleSyncError::InvalidTimestamp)?
                * 10
        }
        _ => frac_str[..3]
            .parse::<u64>()
            .map_err(|_| SubtitleSyncError::InvalidTimestamp)?,
    };
    h.checked_mul(3_600_000)
        .and_then(|v| v.checked_add(m.checked_mul(60_000)?))
        .and_then(|v| v.checked_add(s.checked_mul(1_000)?))
        .and_then(|v| v.checked_add(ms))
        .ok_or(SubtitleSyncError::InvalidTimestamp)
}

pub fn format_srt_timestamp(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let rem = ms % 1_000;
    format!("{h:02}:{m:02}:{s:02},{rem:03}")
}

pub fn format_vtt_timestamp(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let rem = ms % 1_000;
    format!("{h:02}:{m:02}:{s:02}.{rem:03}")
}

fn format_ass_timestamp(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1_000;
    let cs = (ms % 1_000) / 10;
    format!("{h}:{m:02}:{s:02}.{cs:02}")
}

fn is_ass_vector_drawing(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    lower.contains("{\\p1") || lower.contains("\\p1}") || lower.contains("\\p2")
}

fn is_non_spoken_ass_style_or_actor(style: &str, actor: &str) -> bool {
    const MARKERS: &[&str] = &[
        "sign",
        "signs",
        "typeset",
        "typesetting",
        "title",
        "titles",
        "credit",
        "credits",
        "karaoke",
        "op",
        "ed",
        "opening",
        "ending",
        "eyecatch",
        "insert",
        "fx",
        "logo",
    ];
    for field in [style, actor] {
        for raw_tok in field.split(|c: char| !c.is_alphanumeric()) {
            let tok = raw_tok
                .to_ascii_lowercase()
                .trim_end_matches(|c: char| c.is_ascii_digit())
                .to_string();
            if !tok.is_empty() && MARKERS.contains(&tok.as_str()) {
                return true;
            }
        }
    }
    false
}

fn strip_delimiters(input: &str, open: char, close: char) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for ch in input.chars() {
        if ch == open {
            depth += 1;
        } else if ch == close && depth > 0 {
            depth -= 1;
        } else if depth == 0 {
            out.push(ch);
        }
    }
    out
}

/// Returns true when a cue likely represents actual spoken dialogue rather than SDH descriptions
/// (`[Music]`, `(sighs)`), song lyrics (`♪`), watermarks, or empty typesetting tags.
pub fn is_spoken_dialogue_text(raw: &str) -> bool {
    let no_ass = strip_delimiters(raw, '{', '}');
    let no_html = strip_delimiters(&no_ass, '<', '>');
    let no_tags = no_html.replace("\\N", " ").replace("\\n", " ");
    let trimmed = no_tags.trim();
    if trimmed.is_empty() || trimmed.contains('♪') || trimmed.contains('♫') {
        return false;
    }
    if trimmed.starts_with('#') && trimmed.ends_with('#') {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if [
        "opensubtitles",
        "subscene",
        "subtitles by",
        "synced by",
        "www.",
        "http://",
        "https://",
    ]
    .iter()
    .any(|wm| lower.contains(wm))
    {
        return false;
    }

    let s1 = strip_delimiters(trimmed, '[', ']');
    let s2 = strip_delimiters(&s1, '(', ')');
    let s3 = strip_delimiters(&s2, '（', '）');
    let s4 = strip_delimiters(&s3, '【', '】');
    s4.chars().any(|c| c.is_alphanumeric())
}

fn filter_spoken_cues(cues: &[SubtitleCue]) -> Vec<SubtitleCue> {
    let mut sorted = cues.to_vec();
    sorted.sort_unstable_by_key(|c| (c.start_ms, c.end_ms, c.index));
    let filtered: Vec<SubtitleCue> = sorted
        .iter()
        .filter(|c| {
            let dur = c.end_ms.saturating_sub(c.start_ms);
            (100..=15_000).contains(&dur) && is_spoken_dialogue_text(&c.text)
        })
        .cloned()
        .collect();
    if filtered.len() >= MIN_SPOKEN_CUES {
        filtered
    } else {
        sorted
    }
}

pub fn parse_subtitles(input: &str) -> Result<Vec<SubtitleCue>, SubtitleSyncError> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let trimmed = normalized.trim_start_matches('\u{FEFF}');
    if trimmed.contains("[Events]") && trimmed.contains("Dialogue:") {
        return parse_ass_dialogue(trimmed);
    }

    // Group into blocks separated by whitespace-only lines so `.srt` / `.vtt` files with
    // spaces or tabs on separator lines do not merge adjacent cues.
    let mut blocks: Vec<Vec<&str>> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    for line in trimmed.lines() {
        let line_clean = line.trim_end();
        if line_clean.trim().is_empty() {
            if !current.is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
        } else {
            current.push(line_clean);
        }
    }
    if !current.is_empty() {
        blocks.push(current);
    }

    let mut cues = Vec::new();
    let mut seq = 1usize;
    for lines in blocks {
        let first = lines[0].trim();
        if first.starts_with("WEBVTT")
            || first.starts_with("NOTE")
            || first.starts_with("STYLE")
            || first.starts_with("REGION")
        {
            continue;
        }
        let arrow_positions: Vec<usize> = lines
            .iter()
            .enumerate()
            .filter_map(|(i, l)| if l.contains("-->") { Some(i) } else { None })
            .collect();
        if arrow_positions.is_empty() {
            continue;
        }
        for (pos_i, &idx) in arrow_positions.iter().enumerate() {
            let timing_line = lines[idx];
            let Some((lhs, rhs)) = timing_line.split_once("-->") else {
                continue;
            };
            let start_ms = parse_timestamp_ms(lhs)?;
            let end_ms = parse_timestamp_ms(rhs)?;
            let next_arrow = arrow_positions.get(pos_i + 1).copied();
            let text_end = match next_arrow {
                Some(na)
                    if na > idx + 1
                        && !lines[na - 1].trim().is_empty()
                        && lines[na - 1].trim().chars().all(|c| c.is_ascii_digit()) =>
                {
                    na - 1
                }
                Some(na) => na,
                None => lines.len(),
            };
            let text = lines[idx + 1..text_end].join("\n").trim().to_string();
            if text.is_empty() {
                continue;
            }
            cues.push(SubtitleCue {
                index: seq,
                start_ms,
                end_ms: end_ms.max(start_ms),
                text,
            });
            seq += 1;
        }
    }

    if cues.is_empty() {
        return Err(SubtitleSyncError::TooFewCues);
    }
    Ok(cues)
}

fn parse_ass_dialogue(input: &str) -> Result<Vec<SubtitleCue>, SubtitleSyncError> {
    let mut spoken_cues = Vec::new();
    let mut all_cues = Vec::new();
    let mut seq = 1usize;
    for line in input.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("Dialogue:") {
            let fields: Vec<&str> = rest.splitn(10, ',').collect();
            if fields.len() < 10 {
                continue;
            }
            let start_ms = parse_timestamp_ms(fields[1])?;
            let end_ms = parse_timestamp_ms(fields[2])?;
            let raw_text = fields[9].trim();
            if raw_text.is_empty() || is_ass_vector_drawing(raw_text) {
                continue;
            }
            let cue = SubtitleCue {
                index: seq,
                start_ms,
                end_ms: end_ms.max(start_ms),
                text: raw_text.to_string(),
            };
            seq += 1;
            if !is_non_spoken_ass_style_or_actor(fields[3], fields[4]) {
                spoken_cues.push(cue.clone());
            }
            all_cues.push(cue);
        }
    }
    let result = if !spoken_cues.is_empty() {
        spoken_cues
    } else {
        all_cues
    };
    if result.is_empty() {
        return Err(SubtitleSyncError::TooFewCues);
    }
    Ok(result)
}

pub fn render_srt(cues: &[SubtitleCue]) -> String {
    let mut out = String::new();
    for (i, cue) in cues.iter().enumerate() {
        if i > 0 {
            out.push('\n');
        }
        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n",
            i + 1,
            format_srt_timestamp(cue.start_ms),
            format_srt_timestamp(cue.end_ms.max(cue.start_ms)),
            cue.text
        ));
    }
    out
}

fn transform_ms(
    ms: u64,
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
) -> Result<u64, SubtitleSyncError> {
    if !scale.is_finite() || scale <= 0.0 {
        return Err(SubtitleSyncError::InvalidAnchors);
    }
    let delta = (ms as f64) - (anchor_ms as f64);
    let scaled = (anchor_ms as f64) + delta * scale + (offset_ms as f64);
    if !scaled.is_finite() {
        return Err(SubtitleSyncError::InvalidTimestamp);
    }
    Ok(scaled.round().max(0.0) as u64)
}

/// Fix 26: Preserve WebVTT header, `NOTE` / `STYLE` blocks, cue IDs, and cue settings when rescaling `.vtt`.
pub fn render_vtt(
    original_vtt: &str,
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
) -> Result<String, SubtitleSyncError> {
    let normalized = original_vtt.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = Vec::new();
    for line in normalized.lines() {
        if line.contains("-->") {
            let Some((lhs, rhs)) = line.split_once("-->") else {
                out.push(line.to_string());
                continue;
            };
            let start_ms = parse_timestamp_ms(lhs)?;
            let rhs_trim = rhs.trim_start();
            let mut rhs_parts = rhs_trim.splitn(2, char::is_whitespace);
            let end_tok = rhs_parts.next().unwrap_or("");
            let cue_settings = rhs_parts.next().unwrap_or("");
            let end_ms = parse_timestamp_ms(end_tok)?;

            let ns = transform_ms(start_ms, scale, anchor_ms, offset_ms)?;
            let ne = transform_ms(end_ms, scale, anchor_ms, offset_ms)?.max(ns);
            if cue_settings.trim().is_empty() {
                out.push(format!(
                    "{} --> {}",
                    format_vtt_timestamp(ns),
                    format_vtt_timestamp(ne)
                ));
            } else {
                out.push(format!(
                    "{} --> {} {}",
                    format_vtt_timestamp(ns),
                    format_vtt_timestamp(ne),
                    cue_settings.trim()
                ));
            }
        } else {
            out.push(line.to_string());
        }
    }
    let mut res = out.join("\n");
    if !res.ends_with('\n') {
        res.push('\n');
    }
    Ok(res)
}

pub fn shift_cues(cues: &mut [SubtitleCue], offset_ms: i64) {
    for cue in cues.iter_mut() {
        let s = (cue.start_ms as i128 + offset_ms as i128).max(0) as u64;
        let e = (cue.end_ms as i128 + offset_ms as i128).max(s as i128) as u64;
        cue.start_ms = s;
        cue.end_ms = e;
    }
}

pub fn rescale_cues(
    cues: &mut [SubtitleCue],
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
) -> Result<(), SubtitleSyncError> {
    for cue in cues.iter_mut() {
        let ns = transform_ms(cue.start_ms, scale, anchor_ms, offset_ms)?;
        let ne = transform_ms(cue.end_ms, scale, anchor_ms, offset_ms)?.max(ns);
        cue.start_ms = ns;
        cue.end_ms = ne;
    }
    Ok(())
}

pub fn rescale_ass_text(
    input: &str,
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
) -> Result<String, SubtitleSyncError> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines_out = Vec::new();
    for line in normalized.lines() {
        if let Some(rest) = line.strip_prefix("Dialogue:") {
            let fields: Vec<&str> = rest.splitn(10, ',').collect();
            if fields.len() == 10 {
                let start_ms = parse_timestamp_ms(fields[1])?;
                let end_ms = parse_timestamp_ms(fields[2])?;
                let ns = transform_ms(start_ms, scale, anchor_ms, offset_ms)?;
                let ne = transform_ms(end_ms, scale, anchor_ms, offset_ms)?.max(ns);
                lines_out.push(format!(
                    "Dialogue:{},{},{},{},{},{},{},{},{},{}",
                    fields[0],
                    format_ass_timestamp(ns),
                    format_ass_timestamp(ne),
                    fields[3],
                    fields[4],
                    fields[5],
                    fields[6],
                    fields[7],
                    fields[8],
                    fields[9],
                ));
                continue;
            }
        }
        lines_out.push(line.to_string());
    }
    let mut joined = lines_out.join("\n");
    if !joined.ends_with('\n') {
        joined.push('\n');
    }
    Ok(joined)
}

pub fn fit_two_anchor_transform(
    src_a_ms: u64,
    dst_a_ms: u64,
    src_b_ms: u64,
    dst_b_ms: u64,
) -> Result<(f64, i64), SubtitleSyncError> {
    if src_b_ms <= src_a_ms || dst_b_ms <= dst_a_ms {
        return Err(SubtitleSyncError::InvalidAnchors);
    }
    let scale = (dst_b_ms - dst_a_ms) as f64 / (src_b_ms - src_a_ms) as f64;
    if !scale.is_finite() || !(0.8..=1.25).contains(&scale) {
        return Err(SubtitleSyncError::InvalidAnchors);
    }
    let offset_ms = (dst_a_ms as f64 - src_a_ms as f64).round() as i64;
    Ok((scale, offset_ms))
}

/// Streaming PCM s16le mono 16kHz -> 100 Hz speech-band energy envelope builder.
/// Applies a 250 Hz – 3200 Hz band-pass filter so low-frequency rumble/music and high-frequency
/// SFX/hiss do not mask speech cadence, followed by adaptive baseline subtraction and robust
/// active-speech normalization + log compression.
pub struct AudioEnvelopeBuilder {
    samples_per_bin: usize,
    alpha_hp: f32,
    alpha_lp: f32,
    bin_energy_sum: f64,
    bin_count: usize,
    bins: Vec<f32>,
    prev_x: f32,
    prev_y: f32,
    prev_lp: f32,
    pending_byte: Option<u8>,
}

impl Default for AudioEnvelopeBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl AudioEnvelopeBuilder {
    pub fn new() -> Self {
        Self::with_sample_rate(16_000)
    }

    pub fn with_sample_rate(sample_rate: usize) -> Self {
        let sr = sample_rate.max(8_000);
        let dt = 1.0 / sr as f32;
        let rc_hp = 1.0 / (2.0 * std::f32::consts::PI * 250.0);
        let alpha_hp = rc_hp / (rc_hp + dt);
        let rc_lp = 1.0 / (2.0 * std::f32::consts::PI * 3200.0);
        let alpha_lp = dt / (rc_lp + dt);
        Self {
            samples_per_bin: (sr as f64 / ENVELOPE_FPS).round().max(1.0) as usize,
            alpha_hp,
            alpha_lp,
            bin_energy_sum: 0.0,
            bin_count: 0,
            bins: Vec::new(),
            prev_x: 0.0,
            prev_y: 0.0,
            prev_lp: 0.0,
            pending_byte: None,
        }
    }

    pub fn push_pcm_s16le_bytes(&mut self, bytes: &[u8]) {
        let mut iter = bytes.iter().copied();
        if let Some(prev) = self.pending_byte.take() {
            if let Some(hi) = iter.next() {
                self.push_sample(i16::from_le_bytes([prev, hi]));
            } else {
                self.pending_byte = Some(prev);
                return;
            }
        }
        while let Some(lo) = iter.next() {
            if let Some(hi) = iter.next() {
                self.push_sample(i16::from_le_bytes([lo, hi]));
            } else {
                self.pending_byte = Some(lo);
                break;
            }
        }
    }

    fn push_sample(&mut self, sample: i16) {
        let x = sample as f32 / 32768.0;
        let y_hp = self.alpha_hp * (self.prev_y + x - self.prev_x);
        self.prev_x = x;
        self.prev_y = y_hp;
        let y_lp = self.prev_lp + self.alpha_lp * (y_hp - self.prev_lp);
        self.prev_lp = y_lp;

        self.bin_energy_sum += (y_lp as f64) * (y_lp as f64);
        self.bin_count += 1;
        if self.bin_count >= self.samples_per_bin {
            let rms = (self.bin_energy_sum / self.bin_count as f64).sqrt() as f32;
            self.bins.push(rms);
            self.bin_energy_sum = 0.0;
            self.bin_count = 0;
        }
    }

    pub fn finish(mut self) -> Result<Vec<f32>, SubtitleSyncError> {
        if self.bin_count > 0 {
            let rms = (self.bin_energy_sum / self.bin_count as f64).sqrt() as f32;
            self.bins.push(rms);
        }
        if self.bins.len() < 1000 {
            return Err(SubtitleSyncError::InsufficientAudio);
        }
        let peak = self.bins.iter().copied().fold(0.0f32, f32::max);
        if peak < 1e-4 {
            return Err(SubtitleSyncError::InsufficientAudio);
        }

        // Estimate the steady background music/noise floor across 20s windows so continuous
        // low-level ambience does not wash out quiet speech cadence.
        let mut sorted_all = self.bins.clone();
        sorted_all.sort_unstable_by(|a, b| a.total_cmp(b));
        let global_p25 = sorted_all[(sorted_all.len() * 25 / 100).min(sorted_all.len() - 1)];

        const FLOOR_CHUNK_BINS: usize = 2_000;
        let mut subtracted = Vec::with_capacity(self.bins.len());
        let mut scratch = Vec::with_capacity(FLOOR_CHUNK_BINS);
        for chunk in self.bins.chunks(FLOOR_CHUNK_BINS) {
            scratch.clear();
            scratch.extend_from_slice(chunk);
            scratch.sort_unstable_by(|a, b| a.total_cmp(b));
            let chunk_p15 = scratch[(scratch.len() * 15 / 100).min(scratch.len() - 1)];
            let floor = chunk_p15.min(global_p25 * 1.5);
            for &b in chunk {
                subtracted.push((b - 0.85 * floor).max(0.0));
            }
        }

        let sub_peak = subtracted.iter().copied().fold(0.0f32, f32::max);
        let work = if sub_peak >= peak * 0.02 && sub_peak >= 1e-6 {
            subtracted
        } else {
            self.bins
        };

        // Normalize to the 90th percentile of active (above-median) bins rather than raw max peak
        // so single loud explosions/gunshots cannot crush hours of quiet dialogue near zero.
        let work_peak = work.iter().copied().fold(0.0f32, f32::max);
        let mut work_sorted = work.clone();
        work_sorted.sort_unstable_by(|a, b| a.total_cmp(b));
        let median = work_sorted[work_sorted.len() / 2];
        let active_thresh = median + work_peak * 1e-4;
        let first_active = work_sorted.partition_point(|&v| v <= active_thresh);
        let active = &work_sorted[first_active..];
        let ref_raw = if active.len() >= 20 {
            active[(active.len() * 90 / 100).min(active.len() - 1)]
        } else {
            work_peak
        };
        let ref_level = ref_raw.max(work_peak * 0.02).max(1e-6);

        let log_denom = (1.0f32 + 4.0).ln();
        let mut out = work;
        for b in &mut out {
            let u = (*b / ref_level).clamp(0.0, 1.5);
            *b = ((1.0 + 4.0 * u).ln() / log_denom).clamp(0.0, 1.0);
        }
        Ok(out)
    }
}

fn build_merged_cue_intervals(
    cues: &[SubtitleCue],
    max_cue_bins: usize,
    scale: f64,
    anchor_ms: u64,
) -> Vec<(usize, usize)> {
    let mut raw: Vec<(usize, usize)> = Vec::with_capacity(cues.len());
    for cue in cues {
        let s =
            ((anchor_ms as f64) + ((cue.start_ms as f64) - (anchor_ms as f64)) * scale).max(0.0);
        let e = ((anchor_ms as f64) + ((cue.end_ms as f64) - (anchor_ms as f64)) * scale).max(s);
        let b0 = ((s / 10.0).floor() as isize).clamp(0, max_cue_bins as isize) as usize;
        let b1 = ((e / 10.0).ceil() as isize).clamp(0, max_cue_bins as isize) as usize;
        if b1 > b0 {
            raw.push((b0, b1));
        }
    }
    raw.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::with_capacity(raw.len());
    for (b0, b1) in raw {
        if let Some(last) = merged.last_mut() {
            if b0 <= last.1 {
                last.1 = last.1.max(b1);
                continue;
            }
        }
        merged.push((b0, b1));
    }
    merged
}

fn score_alignment_fast(
    pref_y: &[f64],
    sum_y_all: f64,
    var_y_term: f64,
    total_bins: usize,
    merged: &[(usize, usize)],
    total_cue_bins: usize,
    lag_bins: isize,
) -> Option<f64> {
    if total_bins < 500 || total_cue_bins == 0 || var_y_term <= 1e-12 {
        return None;
    }
    let start_i = 0isize.max(-lag_bins);
    let end_i = total_bins as isize - lag_bins;
    if end_i <= start_i {
        return None;
    }
    let lo = start_i as usize;
    let hi = end_i as usize;

    let idx = merged.partition_point(|&(_, b1)| b1 <= lo);
    let mut sum_x = 0.0f64;
    let mut sum_xy = 0.0f64;
    for &(b0, b1) in &merged[idx..] {
        if b0 >= hi {
            break;
        }
        let cb0 = b0.max(lo);
        let cb1 = b1.min(hi);
        if cb1 > cb0 {
            sum_x += (cb1 - cb0) as f64;
            let ca0 = (cb0 as isize + lag_bins) as usize;
            let ca1 = (cb1 as isize + lag_bins) as usize;
            sum_xy += pref_y[ca1] - pref_y[ca0];
        }
    }

    if sum_x < (total_cue_bins as f64 * 0.50) {
        return None;
    }

    let nf = total_bins as f64;
    let var_x_term = nf * sum_x - sum_x * sum_x;
    if var_x_term <= 1e-12 {
        return Some(0.0);
    }
    let num = nf * sum_xy - sum_x * sum_y_all;
    let den = (var_x_term * var_y_term).sqrt();
    if den <= 1e-12 {
        Some(0.0)
    } else {
        Some(num / den)
    }
}

pub fn auto_align_subtitles(
    cues: &[SubtitleCue],
    audio_envelope: &[f32],
    config: &AutoSyncConfig,
) -> Result<AutoSyncOutcome, SubtitleSyncError> {
    if cues.len() < MIN_SPOKEN_CUES {
        return Err(SubtitleSyncError::TooFewCues);
    }
    if audio_envelope.len() < 1000 {
        return Err(SubtitleSyncError::InsufficientAudio);
    }

    let spoken_cues = filter_spoken_cues(cues);
    let max_lag = (config.max_offset_secs * ENVELOPE_FPS).round() as isize;
    let total_bins = audio_envelope.len();
    let max_cue_bins = total_bins.saturating_add(max_lag.max(0) as usize);

    let mut pref_y = Vec::with_capacity(total_bins + 1);
    let mut pref_y2 = Vec::with_capacity(total_bins + 1);
    pref_y.push(0.0f64);
    pref_y2.push(0.0f64);
    let (mut acc_y, mut acc_y2) = (0.0f64, 0.0f64);
    for &v in audio_envelope {
        let y = if v.is_finite() {
            v.max(0.0) as f64
        } else {
            0.0
        };
        acc_y += y;
        acc_y2 += y * y;
        pref_y.push(acc_y);
        pref_y2.push(acc_y2);
    }
    let sum_y_all = pref_y[total_bins];
    let var_y_term = (total_bins as f64) * pref_y2[total_bins] - sum_y_all * sum_y_all;

    // Candidate scales: 1.0 plus common PAL/NTSC framerate ratios if enabled and timeline >= 90s
    let mut candidate_scales = vec![1.0f64];
    if config.check_framerate_drift && total_bins >= 9_000 {
        candidate_scales.extend([23.976 / 25.0, 25.0 / 23.976, 24.0 / 25.0, 25.0 / 24.0]);
    }

    let anchor_ms = spoken_cues[0].start_ms;
    let mut best_scale = 1.0f64;
    let mut best_lag: isize = 0;
    let mut best_corr = f64::NEG_INFINITY;
    let mut best_adjusted = f64::NEG_INFINITY;
    let mut best_z = 0.0f64;

    const COARSE_STEP: isize = 2;
    // Coarse search at 20 ms step, then 10 ms fine search around the top 4 distinct coarse peaks
    for &scale in &candidate_scales {
        let merged = build_merged_cue_intervals(&spoken_cues, max_cue_bins, scale, anchor_ms);
        if merged.is_empty() {
            continue;
        }
        let total_cue_bins: usize = merged.iter().map(|&(a, b)| b - a).sum();

        let mut coarse_points: Vec<(isize, f64)> = Vec::new();
        let mut lag = -max_lag;
        while lag <= max_lag {
            if let Some(r) = score_alignment_fast(
                &pref_y,
                sum_y_all,
                var_y_term,
                total_bins,
                &merged,
                total_cue_bins,
                lag,
            ) {
                coarse_points.push((lag, r));
            }
            lag += COARSE_STEP;
        }
        if coarse_points.is_empty() {
            continue;
        }

        let mut ranked = coarse_points.clone();
        ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
        let mut peak_lags: Vec<isize> = Vec::with_capacity(4);
        for &(cand_lag, _) in &ranked {
            if peak_lags.iter().all(|&p| (p - cand_lag).abs() >= 20) {
                peak_lags.push(cand_lag);
                if peak_lags.len() == 4 {
                    break;
                }
            }
        }

        let mut local_best_lag = ranked[0].0;
        let mut local_best_corr = ranked[0].1;
        for peak_lag in peak_lags {
            let fine_lo = (peak_lag - 6).max(-max_lag);
            let fine_hi = (peak_lag + 6).min(max_lag);
            for f_lag in fine_lo..=fine_hi {
                if let Some(r) = score_alignment_fast(
                    &pref_y,
                    sum_y_all,
                    var_y_term,
                    total_bins,
                    &merged,
                    total_cue_bins,
                    f_lag,
                ) {
                    if r > local_best_corr {
                        local_best_corr = r;
                        local_best_lag = f_lag;
                    }
                }
            }
        }

        // Measure background mean/std excluding the peak's own ±2.5s shoulder so a wide
        // dialogue peak does not inflate the background variance against itself on short clips.
        let bg_count = coarse_points
            .iter()
            .filter(|&&(l, _)| (l - local_best_lag).abs() > 250)
            .count();
        let (mean, std) = if bg_count >= 40 {
            let n = bg_count as f64;
            let m = coarse_points
                .iter()
                .filter(|&&(l, _)| (l - local_best_lag).abs() > 250)
                .map(|&(_, r)| r)
                .sum::<f64>()
                / n;
            let v = coarse_points
                .iter()
                .filter(|&&(l, _)| (l - local_best_lag).abs() > 250)
                .map(|&(_, r)| (r - m) * (r - m))
                .sum::<f64>()
                / n;
            (m, v.sqrt().max(1e-6))
        } else {
            let n = coarse_points.len() as f64;
            let m = coarse_points.iter().map(|&(_, r)| r).sum::<f64>() / n;
            let v = coarse_points
                .iter()
                .map(|&(_, r)| (r - m) * (r - m))
                .sum::<f64>()
                / n;
            (m, v.sqrt().max(1e-6))
        };

        let z = (local_best_corr - mean) / std;
        // A frame-rate-drift candidate must clearly beat the unscaled fit; otherwise random noise
        // could make a wrong scale win by a hair and visibly stretch an already-correct subtitle.
        let adjusted = if (scale - 1.0).abs() > 1e-9 {
            local_best_corr - DRIFT_CANDIDATE_MARGIN
        } else {
            local_best_corr
        };
        if adjusted > best_adjusted {
            best_adjusted = adjusted;
            best_corr = local_best_corr;
            best_lag = local_best_lag;
            best_scale = scale;
            best_z = z;
        }
    }

    if !best_corr.is_finite() || best_corr < config.min_correlation || best_z < config.min_z_score {
        return Err(SubtitleSyncError::LowConfidence(format!(
            "r={:.2}, Z={:.1}",
            best_corr.max(0.0),
            best_z.max(0.0)
        )));
    }

    let drift_applied = (best_scale - 1.0).abs() > 1e-4;
    Ok(AutoSyncOutcome {
        offset_ms: (best_lag as i64) * 10,
        scale: best_scale,
        anchor_ms,
        drift_applied,
        confidence_z: best_z,
        correlation: best_corr,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_windows1256_arabic_and_utf16_bom() {
        // UTF-16 LE BOM + "Hi"
        let utf16_le = [0xFF, 0xFE, b'H', 0x00, b'i', 0x00];
        assert_eq!(decode_subtitle_bytes(&utf16_le).unwrap(), "Hi");

        // Windows-1256 "مرحبا" => 0xE3, 0xD1, 0xCD, 0xC8, 0xC7
        let cp1256 = [0xE3, 0xD1, 0xCD, 0xC8, 0xC7];
        let decoded = decode_subtitle_bytes(&cp1256).unwrap();
        assert_eq!(decoded, "مرحبا");

        // Fix 25: Windows-1252 explicit & heuristic Western decoding ("Café résumé")
        let cp1252 = [
            b'C', b'a', b'f', 0xE9, b' ', b'r', 0xE9, b's', b'u', b'm', 0xE9,
        ];
        assert_eq!(
            decode_subtitle_bytes_with_hint(&cp1252, SubtitleEncodingHint::Windows1252).unwrap(),
            "Café résumé"
        );
        assert_eq!(decode_subtitle_bytes(&cp1252).unwrap(), "Café résumé");

        // Fix 25: Windows-1251 Cyrillic ("Привет")
        let cp1251 = [0xCF, 0xF0, 0xE8, 0xE2, 0xE5, 0xF2];
        assert_eq!(
            decode_subtitle_bytes_with_hint(&cp1251, SubtitleEncodingHint::Windows1251).unwrap(),
            "Привет"
        );
    }

    #[test]
    fn test_parse_srt_and_vtt_and_round_trip() {
        let srt = "1\n00:00:01,500 --> 00:00:03,000\nLine one\n\n2\n00:00:05,000 --> 00:00:06,250\nLine two\n";
        let cues = parse_subtitles(srt).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_ms, 1500);
        assert_eq!(render_srt(&cues), srt);

        let vtt = "WEBVTT\n\nNOTE comment\n\ncue-1\n00:01.000 --> 00:03.500 align:start position:10%\nHello\n";
        let vtt_cues = parse_subtitles(vtt).unwrap();
        assert_eq!(vtt_cues[0].start_ms, 1000);
        // Fix 26: render_vtt preserves WebVTT header, NOTE, cue id, and cue settings
        let shifted_vtt = render_vtt(vtt, 1.0, 0, 2000).unwrap();
        assert!(shifted_vtt.starts_with("WEBVTT"));
        assert!(shifted_vtt.contains("NOTE comment"));
        assert!(shifted_vtt.contains("00:00:03.000 --> 00:00:05.500 align:start position:10%"));
    }

    #[test]
    fn test_parse_and_rescale_ass_preserves_styles_and_filters_drawings() {
        let ass = "[Script Info]\nTitle: T\n\n[V4+ Styles]\nStyle: Default,Arial,20\n\n[Events]\nDialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\p1}m 0 0 l 10 10{\\p0}\nDialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,Hello\n";
        let cues = parse_subtitles(ass).unwrap();
        assert_eq!(cues.len(), 1);
        let rescaled = rescale_ass_text(ass, 1.0, 0, 1000).unwrap();
        assert!(rescaled.contains("[V4+ Styles]"));
        assert!(rescaled.contains("0:00:06.00,0:00:08.00"));
        assert!(rescaled.contains("{\\p1}"));
    }

    #[test]
    fn test_overflow_and_malformed_timestamps_return_err_without_panic() {
        assert_eq!(
            parse_timestamp_ms("bad"),
            Err(SubtitleSyncError::InvalidTimestamp)
        );
        assert_eq!(
            parse_timestamp_ms("999999999999999999:00:00,000"),
            Err(SubtitleSyncError::InvalidTimestamp)
        );
    }

    #[test]
    fn test_shift_clamps_at_zero_and_two_anchor_framerate_fix() {
        let mut cues = vec![SubtitleCue {
            index: 1,
            start_ms: 1000,
            end_ms: 2000,
            text: "Hi".into(),
        }];
        shift_cues(&mut cues, -5000);
        assert_eq!(cues[0].start_ms, 0);
        assert_eq!(cues[0].end_ms, 0);

        let (scale, offset) = fit_two_anchor_transform(10_000, 12_000, 110_000, 107_904).unwrap();
        assert!((scale - (95_904.0 / 100_000.0)).abs() < 1e-4);
        assert_eq!(offset, 2_000);
    }

    fn make_synthetic_envelope(duration_secs: usize, windows_ms: &[(u64, u64)]) -> Vec<f32> {
        let mut env = vec![0.02f32; duration_secs * 100];
        for &(s, e) in windows_ms {
            let b0 = (s / 10) as usize;
            let b1 = ((e / 10) as usize).min(env.len());
            for slot in &mut env[b0..b1] {
                *slot = 0.95;
            }
        }
        env
    }

    #[test]
    fn test_autosync_constant_negative_and_positive_offsets_from_pcm_stream() {
        let windows = vec![
            (5_000, 7_000),
            (10_200, 12_500),
            (16_100, 18_400),
            (22_500, 25_000),
            (29_000, 31_200),
            (37_000, 39_500),
        ];
        let env = make_synthetic_envelope(50, &windows);
        let cues: Vec<SubtitleCue> = windows
            .iter()
            .enumerate()
            .map(|(i, &(s, e))| SubtitleCue {
                index: i + 1,
                start_ms: s - 3200,
                end_ms: e - 3200,
                text: format!("Line {i}"),
            })
            .collect();
        let res = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default()).unwrap();
        assert!((res.offset_ms - 3200).abs() <= 20);
    }

    #[test]
    fn test_autosync_rejects_silent_audio_wrong_subtitle_and_few_cues() {
        let silent = vec![0u8; 16_000 * 2 * 15];
        let mut builder = AudioEnvelopeBuilder::new();
        builder.push_pcm_s16le_bytes(&silent);
        assert_eq!(builder.finish(), Err(SubtitleSyncError::InsufficientAudio));

        let env = make_synthetic_envelope(
            40,
            &[
                (2_000, 3_600),
                (6_400, 8_200),
                (11_100, 13_000),
                (16_500, 18_100),
                (21_800, 23_500),
                (27_000, 28_700),
                (32_400, 34_100),
            ],
        );
        let wrong_spans: &[(u64, u64)] = &[
            (1_200, 2_200),
            (4_200, 6_000),
            (9_000, 10_200),
            (13_800, 15_400),
            (19_200, 20_900),
            (24_600, 26_100),
            (29_900, 31_700),
            (35_200, 37_000),
        ];
        let wrong: Vec<SubtitleCue> = wrong_spans
            .iter()
            .enumerate()
            .map(|(i, &(s, e))| SubtitleCue {
                index: i + 1,
                start_ms: s,
                end_ms: e,
                text: "x".into(),
            })
            .collect();
        assert_eq!(
            auto_align_subtitles(&wrong[..2], &env, &AutoSyncConfig::default()),
            Err(SubtitleSyncError::TooFewCues)
        );
        assert!(matches!(
            auto_align_subtitles(&wrong, &env, &AutoSyncConfig::default()),
            Err(SubtitleSyncError::LowConfidence(_))
        ));
    }

    #[test]
    fn test_autosync_detects_25_to_23976_framerate_drift() {
        let mut windows = Vec::new();
        let mut t = 6_000u64;
        let mut step = 0u64;
        while t < 290_000 {
            let gap = 4_200 + ((step * 3_137) % 6_500);
            let dur = 1_600 + ((step * 1_777) % 1_900);
            windows.push((t, t + dur));
            t += dur + gap;
            step += 1;
        }
        let env = make_synthetic_envelope(300, &windows);
        let true_scale = 23.976 / 25.0;
        let cues: Vec<SubtitleCue> = windows
            .iter()
            .enumerate()
            .map(|(i, &(s, e))| SubtitleCue {
                index: i + 1,
                start_ms: ((s as f64 / true_scale) as i64 + 2100).max(0) as u64,
                end_ms: ((e as f64 / true_scale) as i64 + 2100).max(0) as u64,
                text: format!("Line {i}"),
            })
            .collect();
        let res = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default()).unwrap();
        assert!(res.drift_applied);
        assert!((res.scale - true_scale).abs() < 0.002);
    }

    /// Deterministic pseudo-random in [0,1) so the noisy test is reproducible.
    fn lcg(state: &mut u64) -> f32 {
        *state = state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        ((*state >> 40) as f32) / ((1u64 << 24) as f32)
    }

    #[test]
    fn test_autosync_survives_noise_loud_spikes_and_does_not_invent_drift() {
        let mut rng = 0x9E3779B97F4A7C15u64;
        let secs = 600usize;
        let mut windows = Vec::new();
        let mut t = 4_000u64;
        let mut step = 0u64;
        while t < 580_000 {
            let gap = 2_500 + ((step * 2_713) % 7_000);
            let dur = 1_200 + ((step * 1_451) % 2_600);
            windows.push((t, t + dur));
            t += dur + gap;
            step += 1;
        }
        // Noisy floor, speech at varying levels, and loud non-speech spikes (explosions/music hits)
        let mut env = vec![0.0f32; secs * 100];
        for slot in env.iter_mut() {
            *slot = 0.03 + 0.20 * lcg(&mut rng);
        }
        for &(s, e) in &windows {
            for slot in &mut env[(s / 10) as usize..((e / 10) as usize).min(secs * 100)] {
                *slot = 0.35 + 0.5 * lcg(&mut rng);
            }
        }
        for spike_start in (30..secs).step_by(40) {
            for slot in &mut env[spike_start * 100..spike_start * 100 + 60] {
                *slot = 1.0;
            }
        }

        for true_offset_ms in [-2_400i64, 0, 7_300, 41_000] {
            let cues: Vec<SubtitleCue> = windows
                .iter()
                .enumerate()
                .map(|(i, &(s, e))| SubtitleCue {
                    index: i + 1,
                    start_ms: (s as i64 - true_offset_ms).max(0) as u64,
                    end_ms: (e as i64 - true_offset_ms).max(0) as u64,
                    text: format!("Line {i}"),
                })
                .collect();
            let res = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default())
                .unwrap_or_else(|e| panic!("offset {true_offset_ms}: {e}"));
            assert!(
                (res.offset_ms - true_offset_ms).abs() <= 30,
                "offset {true_offset_ms}: got {}",
                res.offset_ms
            );
            assert!(
                !res.drift_applied,
                "offset {true_offset_ms}: invented drift scale {}",
                res.scale
            );
        }
    }

    #[test]
    fn test_autosync_extreme_explosions_and_quiet_dialogue_from_pcm() {
        let sr = 16_000usize;
        let secs = 360usize;
        // 20 speech bursts placed in [85s..330s] so shifts from -25s to +80s keep every cue in bounds.
        let mut windows = Vec::new();
        let mut t_ms = 85_000u64;
        for step in 0..20u64 {
            let dur = 1_400 + ((step * 733) % 1_900);
            let gap = 7_500 + ((step * 2_903) % 5_500);
            windows.push((t_ms, t_ms + dur));
            t_ms += dur + gap;
        }
        let explosion_windows = [
            (30_000u64, 31_200u64),
            (120_000, 121_300),
            (195_000, 196_100),
            (265_000, 266_200),
            (345_000, 346_200),
        ];

        let mut pcm = Vec::with_capacity(sr * secs * 2);
        let mut win_idx = 0usize;
        let mut exp_idx = 0usize;
        for n in 0..sr * secs {
            let cur_ms = (n as u64 * 1000) / sr as u64;
            while win_idx < windows.len() && cur_ms >= windows[win_idx].1 {
                win_idx += 1;
            }
            while exp_idx < explosion_windows.len() && cur_ms >= explosion_windows[exp_idx].1 {
                exp_idx += 1;
            }
            let in_speech = win_idx < windows.len() && cur_ms >= windows[win_idx].0;
            let in_explosion =
                exp_idx < explosion_windows.len() && cur_ms >= explosion_windows[exp_idx].0;

            let t = n as f64 / sr as f64;
            let rumble = 8000.0 * (2.0 * std::f64::consts::PI * 90.0 * t).sin();
            let hiss = 5000.0 * (2.0 * std::f64::consts::PI * 5500.0 * t).sin();
            let speech = if in_speech {
                1400.0 * (2.0 * std::f64::consts::PI * 750.0 * t).sin()
            } else {
                0.0
            };
            let boom = if in_explosion {
                20_000.0 * (2.0 * std::f64::consts::PI * 420.0 * t).sin()
                    + 12_000.0 * (2.0 * std::f64::consts::PI * 1100.0 * t).sin()
            } else {
                0.0
            };
            let sample = (rumble + hiss + speech + boom).clamp(-32767.0, 32767.0) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }

        // Feed odd-sized chunks to exercise `pending_byte` across buffer boundaries.
        let mut builder = AudioEnvelopeBuilder::with_sample_rate(sr);
        for chunk in pcm.chunks(4097) {
            builder.push_pcm_s16le_bytes(chunk);
        }
        let env = builder.finish().expect("envelope");

        for true_offset_ms in [-18_400i64, 74_200] {
            let cues: Vec<SubtitleCue> = windows
                .iter()
                .enumerate()
                .map(|(i, &(s, e))| SubtitleCue {
                    index: i + 1,
                    start_ms: (s as i64 - true_offset_ms) as u64,
                    end_ms: (e as i64 - true_offset_ms) as u64,
                    text: format!("Quiet dialogue line {i}"),
                })
                .collect();
            let res = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default())
                .unwrap_or_else(|e| panic!("offset {true_offset_ms}: {e}"));
            assert!(
                (res.offset_ms - true_offset_ms).abs() <= 30,
                "offset {true_offset_ms}: got {} (corr={}, z={})",
                res.offset_ms,
                res.correlation,
                res.confidence_z
            );
            assert!(!res.drift_applied);
        }
    }

    #[test]
    fn test_autosync_polluted_sdh_music_ass_signs_and_whitespace_srt() {
        // Irregular speech windows inside a 50s timeline, with last cue near the tail so a +3.5s
        // delayed subtitle pushes cue end past audio_duration (50s).
        let windows = vec![
            (3_000, 4_800),
            (7_500, 9_200),
            (13_100, 15_400),
            (19_000, 21_200),
            (25_600, 27_900),
            (32_200, 34_800),
            (39_400, 41_900),
            (46_800, 49_200),
        ];
        let env = make_synthetic_envelope(50, &windows);

        // 1) Polluted SRT: spaces/tabs on blank separator lines, missing blank line between cues 1 & 2,
        // SDH cues, song lyrics, watermarks, delayed by +3500 ms (expected offset = -3500 ms).
        let delay_ms = 3_500u64;
        let mut srt = String::new();
        srt.push_str(&format!(
            "1\n{} --> {}\nFirst spoken line\n2\n{} --> {}\nSecond line missing blank\n   \t\n",
            format_srt_timestamp(windows[0].0 + delay_ms),
            format_srt_timestamp(windows[0].1 + delay_ms),
            format_srt_timestamp(windows[1].0 + delay_ms),
            format_srt_timestamp(windows[1].1 + delay_ms),
        ));
        // Add misleading SDH / song / watermark cues at random wrong positions
        srt.push_str("99\n00:00:00,200 --> 00:00:02,000\n[Music]\n \n");
        srt.push_str("100\n00:00:05,500 --> 00:00:07,000\n(door slams loudly)\n\t\n");
        srt.push_str("101\n00:00:11,000 --> 00:00:13,000\n[موسيقى]\n  \n");
        srt.push_str("102\n00:00:16,500 --> 00:00:18,500\n♪ Opening Song ♪\n\n");
        srt.push_str("103\n00:00:43,000 --> 00:00:45,500\nSynced by OpenSubtitles.org\n   \n");
        for (idx, &(s, e)) in windows.iter().enumerate().skip(2) {
            srt.push_str(&format!(
                "{}\n{} --> {}\nLine {idx}\n  \n",
                idx + 200,
                format_srt_timestamp(s + delay_ms),
                format_srt_timestamp(e + delay_ms),
            ));
        }

        let srt_cues = parse_subtitles(&srt).unwrap();
        let srt_res = auto_align_subtitles(&srt_cues, &env, &AutoSyncConfig::default()).unwrap();
        assert!(
            (srt_res.offset_ms - (-(delay_ms as i64))).abs() <= 30,
            "got {} expected -{}",
            srt_res.offset_ms,
            delay_ms
        );

        // 2) Polluted out-of-order ASS: OP/ED/Sign/Karaoke actors + vector drawing + shifted early by 2.4s.
        let early_ms = 2_400u64;
        let mut ass = String::from(
            "[Script Info]\nTitle: Test\n\n[V4+ Styles]\nFormat: Name, Fontname\nStyle: Default,Arial\nStyle: Sign,Arial\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n",
        );
        // Drawing cue must also be rescaled by rescale_ass_text!
        ass.push_str("Dialogue: 0,0:00:10.00,0:00:12.00,Sign,,0,0,0,,{\\p1}m 0 0 l 20 20{\\p0}\n");
        ass.push_str("Dialogue: 0,0:00:00.50,0:00:02.00,OP-Romaji,,0,0,0,,Opening lyric\n");
        ass.push_str("Dialogue: 0,0:00:36.00,0:00:38.50,Default,ED1,0,0,0,,Ending credit\n");
        // Insert spoken cues intentionally out of chronological order
        for &(s, e) in windows.iter().rev() {
            ass.push_str(&format!(
                "Dialogue: 0,{},{},Default,Actor,0,0,0,,{{\\an8}}Spoken line\n",
                format_ass_timestamp(s - early_ms),
                format_ass_timestamp(e - early_ms),
            ));
        }

        let ass_cues = parse_subtitles(&ass).unwrap();
        let ass_res = auto_align_subtitles(&ass_cues, &env, &AutoSyncConfig::default()).unwrap();
        assert!(
            (ass_res.offset_ms - (early_ms as i64)).abs() <= 30,
            "got {} expected +{}",
            ass_res.offset_ms,
            early_ms
        );

        let rescaled =
            rescale_ass_text(&ass, ass_res.scale, ass_res.anchor_ms, ass_res.offset_ms).unwrap();
        // Vector drawing shifted from 10.00->12.00 by +2.4s => 12.40->14.40
        assert!(
            rescaled.contains("0:00:12.40,0:00:14.40,Sign,,0,0,0,,{\\p1}"),
            "drawing not shifted:\n{rescaled}"
        );
    }
}
