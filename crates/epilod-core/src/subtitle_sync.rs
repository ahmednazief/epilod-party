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
    #[error(
        "Could not find a confident alignment ({0}). Try adjusting timing with the +/- controls."
    )]
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
            max_offset_secs: 900.0,
            check_framerate_drift: true,
            min_z_score: 4.5,
            min_correlation: 0.18,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TimingSegment {
    pub start_src_ms: u64,
    pub scale: f64,
    pub anchor_ms: u64,
    pub offset_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SubtitleTimingTransform {
    Linear {
        scale: f64,
        anchor_ms: u64,
        offset_ms: i64,
    },
    Piecewise {
        segments: Vec<TimingSegment>,
    },
}

impl SubtitleTimingTransform {
    pub fn map_cue(&self, start_ms: u64, end_ms: u64) -> Result<(u64, u64), SubtitleSyncError> {
        let (scale, anchor_ms, offset_ms) = match self {
            Self::Linear {
                scale,
                anchor_ms,
                offset_ms,
            } => (*scale, *anchor_ms, *offset_ms),
            Self::Piecewise { segments } => {
                if segments.is_empty() {
                    return Ok((start_ms, end_ms.max(start_ms)));
                }
                let idx = segments
                    .partition_point(|seg| seg.start_src_ms <= start_ms)
                    .saturating_sub(1);
                let seg = &segments[idx];
                (seg.scale, seg.anchor_ms, seg.offset_ms)
            }
        };
        let ns = transform_ms(start_ms, scale, anchor_ms, offset_ms)?;
        let ne = transform_ms(end_ms, scale, anchor_ms, offset_ms)?.max(ns);
        Ok((ns, ne))
    }

    pub fn segment_count(&self) -> usize {
        match self {
            Self::Linear { .. } => 1,
            Self::Piecewise { segments } => segments.len().max(1),
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
    pub transform: SubtitleTimingTransform,
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

fn is_bidi_or_bom(c: char) -> bool {
    matches!(
        c,
        '\u{FEFF}' | '\u{200E}' | '\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}'
    )
}

pub fn parse_timestamp_ms(raw: &str) -> Result<u64, SubtitleSyncError> {
    let trimmed = raw
        .trim_matches(|c: char| c.is_whitespace() || is_bidi_or_bom(c))
        .split_whitespace()
        .next()
        .unwrap_or("")
        .trim_matches(is_bidi_or_bom);
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
        _ => frac_str
            .get(..3)
            .ok_or(SubtitleSyncError::InvalidTimestamp)?
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
pub fn render_vtt_with_transform(
    original_vtt: &str,
    transform: &SubtitleTimingTransform,
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

            let (ns, ne) = transform.map_cue(start_ms, end_ms)?;
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

pub fn render_vtt(
    original_vtt: &str,
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
) -> Result<String, SubtitleSyncError> {
    render_vtt_with_transform(
        original_vtt,
        &SubtitleTimingTransform::Linear {
            scale,
            anchor_ms,
            offset_ms,
        },
    )
}

pub fn shift_cues(cues: &mut [SubtitleCue], offset_ms: i64) {
    for cue in cues.iter_mut() {
        let s = (cue.start_ms as i128 + offset_ms as i128).max(0) as u64;
        let e = (cue.end_ms as i128 + offset_ms as i128).max(s as i128) as u64;
        cue.start_ms = s;
        cue.end_ms = e;
    }
}

pub fn rescale_cues_with_transform(
    cues: &mut [SubtitleCue],
    transform: &SubtitleTimingTransform,
) -> Result<(), SubtitleSyncError> {
    for cue in cues.iter_mut() {
        let (ns, ne) = transform.map_cue(cue.start_ms, cue.end_ms)?;
        cue.start_ms = ns;
        cue.end_ms = ne;
    }
    Ok(())
}

pub fn rescale_cues(
    cues: &mut [SubtitleCue],
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
) -> Result<(), SubtitleSyncError> {
    rescale_cues_with_transform(
        cues,
        &SubtitleTimingTransform::Linear {
            scale,
            anchor_ms,
            offset_ms,
        },
    )
}

pub fn rescale_ass_text_with_transform(
    input: &str,
    transform: &SubtitleTimingTransform,
) -> Result<String, SubtitleSyncError> {
    let normalized = input.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines_out = Vec::new();
    for line in normalized.lines() {
        if let Some(rest) = line.strip_prefix("Dialogue:") {
            let fields: Vec<&str> = rest.splitn(10, ',').collect();
            if fields.len() == 10 {
                let start_ms = parse_timestamp_ms(fields[1])?;
                let end_ms = parse_timestamp_ms(fields[2])?;
                let (ns, ne) = transform.map_cue(start_ms, end_ms)?;
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

pub fn rescale_ass_text(
    input: &str,
    scale: f64,
    anchor_ms: u64,
    offset_ms: i64,
) -> Result<String, SubtitleSyncError> {
    rescale_ass_text_with_transform(
        input,
        &SubtitleTimingTransform::Linear {
            scale,
            anchor_ms,
            offset_ms,
        },
    )
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

/// Streaming PCM s16le mono 16kHz -> 100 Hz speech-activity envelope builder.
/// Computes 12 dB/oct speech-band energy (260–3100 Hz) alongside low (<220 Hz) and high (>3500 Hz)
/// monitor bands, subtracts each band's adaptive stationary floor, attenuates non-speech bass/hiss
/// transients, applies zero-phase 170 ms smoothing, and normalizes with log compression.
pub struct AudioEnvelopeBuilder {
    samples_per_bin: usize,
    alpha_hp_sp: f32,
    alpha_lp_sp: f32,
    alpha_lp_lo: f32,
    alpha_hp_hi: f32,
    bin_speech_sum: f64,
    bin_low_sum: f64,
    bin_high_sum: f64,
    bin_count: usize,
    bins_sp: Vec<f32>,
    bins_lo: Vec<f32>,
    bins_hi: Vec<f32>,
    sp_x1: f32,
    sp_y1: f32,
    sp_x2: f32,
    sp_y2: f32,
    sp_lp1: f32,
    sp_lp2: f32,
    lo_lp1: f32,
    lo_lp2: f32,
    hi_x1: f32,
    hi_y1: f32,
    hi_x2: f32,
    hi_y2: f32,
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
        let rc_hp_sp = 1.0 / (2.0 * std::f32::consts::PI * 260.0);
        let rc_lp_sp = 1.0 / (2.0 * std::f32::consts::PI * 3100.0);
        let rc_lp_lo = 1.0 / (2.0 * std::f32::consts::PI * 220.0);
        let rc_hp_hi = 1.0 / (2.0 * std::f32::consts::PI * 3500.0);
        Self {
            samples_per_bin: (sr as f64 / ENVELOPE_FPS).round().max(1.0) as usize,
            alpha_hp_sp: rc_hp_sp / (rc_hp_sp + dt),
            alpha_lp_sp: dt / (rc_lp_sp + dt),
            alpha_lp_lo: dt / (rc_lp_lo + dt),
            alpha_hp_hi: rc_hp_hi / (rc_hp_hi + dt),
            bin_speech_sum: 0.0,
            bin_low_sum: 0.0,
            bin_high_sum: 0.0,
            bin_count: 0,
            bins_sp: Vec::new(),
            bins_lo: Vec::new(),
            bins_hi: Vec::new(),
            sp_x1: 0.0,
            sp_y1: 0.0,
            sp_x2: 0.0,
            sp_y2: 0.0,
            sp_lp1: 0.0,
            sp_lp2: 0.0,
            lo_lp1: 0.0,
            lo_lp2: 0.0,
            hi_x1: 0.0,
            hi_y1: 0.0,
            hi_x2: 0.0,
            hi_y2: 0.0,
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

    fn flush_bin(&mut self) {
        if self.bin_count == 0 {
            return;
        }
        let n = self.bin_count as f64;
        self.bins_sp.push((self.bin_speech_sum / n).sqrt() as f32);
        self.bins_lo.push((self.bin_low_sum / n).sqrt() as f32);
        self.bins_hi.push((self.bin_high_sum / n).sqrt() as f32);
        self.bin_speech_sum = 0.0;
        self.bin_low_sum = 0.0;
        self.bin_high_sum = 0.0;
        self.bin_count = 0;
    }

    fn push_sample(&mut self, sample: i16) {
        let x = sample as f32 / 32768.0;

        // Speech band (260–3100 Hz, 2-stage HP + 2-stage LP)
        let hp1 = self.alpha_hp_sp * (self.sp_y1 + x - self.sp_x1);
        self.sp_x1 = x;
        self.sp_y1 = hp1;
        let hp2 = self.alpha_hp_sp * (self.sp_y2 + hp1 - self.sp_x2);
        self.sp_x2 = hp1;
        self.sp_y2 = hp2;
        let lp1 = self.sp_lp1 + self.alpha_lp_sp * (hp2 - self.sp_lp1);
        self.sp_lp1 = lp1;
        let lp2 = self.sp_lp2 + self.alpha_lp_sp * (lp1 - self.sp_lp2);
        self.sp_lp2 = lp2;

        // Low band (<220 Hz)
        let lo1 = self.lo_lp1 + self.alpha_lp_lo * (x - self.lo_lp1);
        self.lo_lp1 = lo1;
        let lo2 = self.lo_lp2 + self.alpha_lp_lo * (lo1 - self.lo_lp2);
        self.lo_lp2 = lo2;

        // High band (>3500 Hz)
        let hi1 = self.alpha_hp_hi * (self.hi_y1 + x - self.hi_x1);
        self.hi_x1 = x;
        self.hi_y1 = hi1;
        let hi2 = self.alpha_hp_hi * (self.hi_y2 + hi1 - self.hi_x2);
        self.hi_x2 = hi1;
        self.hi_y2 = hi2;

        self.bin_speech_sum += (lp2 as f64) * (lp2 as f64);
        self.bin_low_sum += (lo2 as f64) * (lo2 as f64);
        self.bin_high_sum += (hi2 as f64) * (hi2 as f64);
        self.bin_count += 1;
        if self.bin_count >= self.samples_per_bin {
            self.flush_bin();
        }
    }

    fn subtract_adaptive_floor(bins: &[f32], chunk_bins: usize, scale: f32) -> Vec<f32> {
        let mut sorted_all = bins.to_vec();
        sorted_all.sort_unstable_by(|a, b| a.total_cmp(b));
        let global_p25 = sorted_all[(sorted_all.len() * 25 / 100).min(sorted_all.len() - 1)];

        let mut out = Vec::with_capacity(bins.len());
        let mut scratch = Vec::with_capacity(chunk_bins);
        for chunk in bins.chunks(chunk_bins) {
            scratch.clear();
            scratch.extend_from_slice(chunk);
            scratch.sort_unstable_by(|a, b| a.total_cmp(b));
            let chunk_p15 = scratch[(scratch.len() * 15 / 100).min(scratch.len() - 1)];
            let floor = chunk_p15.min(global_p25 * 1.5);
            for &b in chunk {
                out.push((b - scale * floor).max(0.0));
            }
        }
        out
    }

    fn smooth_and_normalize_bins(raw_work: Vec<f32>) -> Vec<f32> {
        // Zero-phase symmetric 170 ms boxcar smoothing bridges natural syllable/word gaps inside
        // spoken dialogue cues and dampens brief transient SFX spikes without shifting peaks.
        const SMOOTH_RADIUS: usize = 8;
        let mut pref = Vec::with_capacity(raw_work.len() + 1);
        pref.push(0.0f64);
        for &v in &raw_work {
            pref.push(pref.last().copied().unwrap_or(0.0) + v as f64);
        }
        let mut work = Vec::with_capacity(raw_work.len());
        for i in 0..raw_work.len() {
            let lo = i.saturating_sub(SMOOTH_RADIUS);
            let hi = (i + SMOOTH_RADIUS + 1).min(raw_work.len());
            work.push(((pref[hi] - pref[lo]) / (hi - lo) as f64) as f32);
        }

        // Normalize to the 75th percentile of active (above-median) bins rather than max/top decile
        // so loud explosions/gunshots (~10-15% of active bins) cannot crush quiet dialogue near zero.
        let work_peak = work.iter().copied().fold(0.0f32, f32::max);
        let mut work_sorted = work.clone();
        work_sorted.sort_unstable_by(|a, b| a.total_cmp(b));
        let median = work_sorted[work_sorted.len() / 2];
        let active_thresh = median + work_peak * 1e-4;
        let first_active = work_sorted.partition_point(|&v| v <= active_thresh);
        let active = &work_sorted[first_active..];
        let ref_raw = if active.len() >= 20 {
            active[(active.len() * 75 / 100).min(active.len() - 1)]
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
        out
    }

    pub fn finish(mut self) -> Result<Vec<f32>, SubtitleSyncError> {
        self.flush_bin();
        if self.bins_sp.len() < 1000 {
            return Err(SubtitleSyncError::InsufficientAudio);
        }
        let peak = self.bins_sp.iter().copied().fold(0.0f32, f32::max);
        if peak < 1e-4 {
            return Err(SubtitleSyncError::InsufficientAudio);
        }

        // Subtract stationary floor independently per band so continuous low-frequency rumble
        // or high-frequency hiss never masks quiet speech, while transient bass/cymbal spikes
        // in non-speech scenes still attenuate non-speech bursts.
        const FLOOR_CHUNK_BINS: usize = 2_000;
        let sp_sub = Self::subtract_adaptive_floor(&self.bins_sp, FLOOR_CHUNK_BINS, 0.85);
        let lo_sub = Self::subtract_adaptive_floor(&self.bins_lo, FLOOR_CHUNK_BINS, 0.95);
        let hi_sub = Self::subtract_adaptive_floor(&self.bins_hi, FLOOR_CHUNK_BINS, 0.95);

        let sub_peak = sp_sub.iter().copied().fold(0.0f32, f32::max);
        let mut raw_work = if sub_peak >= peak * 0.02 && sub_peak >= 1e-6 {
            sp_sub
        } else {
            self.bins_sp
        };

        for i in 0..raw_work.len() {
            let sp = raw_work[i];
            let tot = sp + lo_sub[i] + hi_sub[i];
            if tot > 1e-6 {
                let ratio = (sp / tot).clamp(0.0, 1.0);
                raw_work[i] = sp * (0.45 + 0.55 * ratio);
            }
        }

        Ok(Self::smooth_and_normalize_bins(raw_work))
    }

    /// Produces `(speech_envelope, broadband_envelope)` at 100 Hz for fast sparse peer matching,
    /// preserving non-dialogue score/SFX energy for action scenes or differing audio dubs.
    pub fn finish_dual_bands(mut self) -> Result<(Vec<f32>, Vec<f32>), SubtitleSyncError> {
        self.flush_bin();
        if self.bins_sp.len() < 800 {
            return Err(SubtitleSyncError::InsufficientAudio);
        }
        let sp_peak = self.bins_sp.iter().copied().fold(0.0f32, f32::max);
        let mut total_raw = Vec::with_capacity(self.bins_sp.len());
        let mut tot_peak = 0.0f32;
        for i in 0..self.bins_sp.len() {
            let v = self.bins_sp[i] + 0.6 * self.bins_lo[i] + 0.6 * self.bins_hi[i];
            if v > tot_peak {
                tot_peak = v;
            }
            total_raw.push(v);
        }
        if tot_peak < 1e-4 {
            return Err(SubtitleSyncError::InsufficientAudio);
        }

        const FLOOR_CHUNK_BINS: usize = 2_000;
        let sp_sub = Self::subtract_adaptive_floor(&self.bins_sp, FLOOR_CHUNK_BINS, 0.85);
        let lo_sub = Self::subtract_adaptive_floor(&self.bins_lo, FLOOR_CHUNK_BINS, 0.90);
        let hi_sub = Self::subtract_adaptive_floor(&self.bins_hi, FLOOR_CHUNK_BINS, 0.90);

        let sub_peak = sp_sub.iter().copied().fold(0.0f32, f32::max);
        let mut sp_work = if sp_peak >= 1e-4 && sub_peak >= sp_peak * 0.02 && sub_peak >= 1e-6 {
            sp_sub
        } else {
            self.bins_sp
        };
        for i in 0..sp_work.len() {
            let sp = sp_work[i];
            let tot = sp + lo_sub[i] + hi_sub[i];
            if tot > 1e-6 {
                let ratio = (sp / tot).clamp(0.0, 1.0);
                sp_work[i] = sp * (0.45 + 0.55 * ratio);
            }
        }

        let broad_sub = Self::subtract_adaptive_floor(&total_raw, FLOOR_CHUNK_BINS, 0.75);
        let broad_peak = broad_sub.iter().copied().fold(0.0f32, f32::max);
        let broad_work = if broad_peak >= tot_peak * 0.02 && broad_peak >= 1e-6 {
            broad_sub
        } else {
            total_raw
        };

        Ok((
            Self::smooth_and_normalize_bins(sp_work),
            Self::smooth_and_normalize_bins(broad_work),
        ))
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

pub(crate) fn measure_background_z(
    points: &[(isize, f64)],
    best_lag: isize,
    best_corr: f64,
    shoulder_bins: isize,
) -> f64 {
    if points.is_empty() {
        return 0.0;
    }
    let bg_count = points
        .iter()
        .filter(|&&(l, _)| (l - best_lag).abs() > shoulder_bins)
        .count();
    let use_bg = bg_count >= 40;
    let n = if use_bg { bg_count } else { points.len() } as f64;
    let mean = points
        .iter()
        .filter(|&&(l, _)| !use_bg || (l - best_lag).abs() > shoulder_bins)
        .map(|&(_, r)| r)
        .sum::<f64>()
        / n;
    let var = points
        .iter()
        .filter(|&&(l, _)| !use_bg || (l - best_lag).abs() > shoulder_bins)
        .map(|&(_, r)| (r - mean) * (r - mean))
        .sum::<f64>()
        / n;
    (best_corr - mean) / var.sqrt().max(1e-6)
}

fn is_confident_alignment(r: f64, z: f64, config: &AutoSyncConfig) -> bool {
    r.is_finite()
        && z.is_finite()
        && ((r >= config.min_correlation && z >= config.min_z_score)
            || (z >= config.min_z_score.max(6.5) && r >= (config.min_correlation * 0.67).max(0.12)))
}

pub(crate) fn fft_radix2(re: &mut [f64], im: &mut [f64], inverse: bool) {
    let n = re.len();
    debug_assert_eq!(n, im.len());
    debug_assert!(n.is_power_of_two());
    if n <= 1 {
        return;
    }

    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while (j & bit) != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }

    let sign = if inverse { 1.0 } else { -1.0 };
    let mut len = 2usize;
    while len <= n {
        let half = len >> 1;
        let angle = sign * 2.0 * std::f64::consts::PI / (len as f64);
        let wlen_re = angle.cos();
        let wlen_im = angle.sin();
        for start in (0..n).step_by(len) {
            let (mut w_re, mut w_im) = (1.0f64, 0.0f64);
            for k in 0..half {
                let idx1 = start + k;
                let idx2 = idx1 + half;
                let t_re = re[idx2] * w_re - im[idx2] * w_im;
                let t_im = re[idx2] * w_im + im[idx2] * w_re;
                re[idx2] = re[idx1] - t_re;
                im[idx2] = im[idx1] - t_im;
                re[idx1] += t_re;
                im[idx1] += t_im;
                let next_re = w_re * wlen_re - w_im * wlen_im;
                w_im = w_re * wlen_im + w_im * wlen_re;
                w_re = next_re;
            }
        }
        len <<= 1;
    }

    if inverse {
        let inv_n = 1.0 / (n as f64);
        for v in re.iter_mut() {
            *v *= inv_n;
        }
        for v in im.iter_mut() {
            *v *= inv_n;
        }
    }
}

/// Computes `sum_{i=0..x.len()} x[i] * y[i + lag]` for every `lag` in `min_lag..=max_lag`
/// using precomputed `FFT(y)` of size `n_fft` (power of two >= `x.len() + y.len() + max(|min_lag|, |max_lag|)`).
pub(crate) fn fft_correlate_with_precomputed_y(
    x: &[f64],
    y_fft_re: &[f64],
    y_fft_im: &[f64],
    min_lag: isize,
    max_lag: isize,
) -> Vec<(isize, f64)> {
    let n = y_fft_re.len();
    if x.is_empty() || min_lag > max_lag || n < 2 {
        return Vec::new();
    }
    let mut x_re = vec![0.0f64; n];
    let mut x_im = vec![0.0f64; n];
    x_re[..x.len()].copy_from_slice(x);
    fft_radix2(&mut x_re, &mut x_im, false);

    // Product = conj(X) * Y
    for k in 0..n {
        let xr = x_re[k];
        let xi = x_im[k];
        let yr = y_fft_re[k];
        let yi = y_fft_im[k];
        x_re[k] = xr * yr + xi * yi;
        x_im[k] = xr * yi - xi * yr;
    }
    fft_radix2(&mut x_re, &mut x_im, true);

    let mut out = Vec::with_capacity((max_lag - min_lag + 1).max(0) as usize);
    for lag in min_lag..=max_lag {
        let idx = if lag >= 0 {
            lag as usize
        } else {
            (n as isize + lag) as usize
        };
        out.push((lag, x_re[idx]));
    }
    out
}

pub(crate) fn downsample_2x(env: &[f32]) -> Vec<f64> {
    let len = env.len() / 2;
    let mut out = Vec::with_capacity(len);
    for i in 0..len {
        let a = env[2 * i];
        let b = env[2 * i + 1];
        let va = if a.is_finite() {
            a.max(0.0) as f64
        } else {
            0.0
        };
        let vb = if b.is_finite() {
            b.max(0.0) as f64
        } else {
            0.0
        };
        out.push(0.5 * (va + vb));
    }
    out
}

fn build_mask_50hz_from_merged(
    merged_10ms: &[(usize, usize)],
    max_bins_50: usize,
) -> (Vec<f64>, Vec<f64>, usize) {
    if max_bins_50 == 0 || merged_10ms.is_empty() {
        return (Vec::new(), vec![0.0], 0);
    }
    let mut mask = vec![0.0f64; max_bins_50];
    let mut last_hi = 0usize;
    for &(b0, b1) in merged_10ms {
        let s50 = (b0 / 2).min(max_bins_50);
        let e50 = b1.div_ceil(2).min(max_bins_50);
        if e50 > s50 {
            for slot in &mut mask[s50..e50] {
                *slot = 1.0;
            }
            last_hi = last_hi.max(e50);
        }
    }
    mask.truncate(last_hi);
    let mut pref_x = Vec::with_capacity(mask.len() + 1);
    pref_x.push(0.0f64);
    let mut sum = 0.0f64;
    for &v in &mask {
        sum += v;
        pref_x.push(sum);
    }
    (mask, pref_x, sum.round() as usize)
}

#[derive(Debug, Clone)]
struct GlobalFit {
    scale: f64,
    lag_10ms: isize,
    corr: f64,
    z: f64,
    anchor_ms: u64,
    merged: Vec<(usize, usize)>,
}

fn run_global_fft_align(
    spoken_cues: &[SubtitleCue],
    audio_envelope: &[f32],
    pref_y: &[f64],
    sum_y_all: f64,
    var_y_term: f64,
    config: &AutoSyncConfig,
) -> Option<GlobalFit> {
    let total_bins = audio_envelope.len();
    let max_lag = (config.max_offset_secs * ENVELOPE_FPS).round() as isize;
    let max_cue_bins = total_bins.saturating_add(max_lag.max(0) as usize);

    let y_50 = downsample_2x(audio_envelope);
    let total_bins_50 = y_50.len();
    if total_bins_50 < 250 {
        return None;
    }
    let sum_y_50: f64 = y_50.iter().sum();
    let sum_y2_50: f64 = y_50.iter().map(|v| v * v).sum();
    let nf_50 = total_bins_50 as f64;
    let var_y_50 = nf_50 * sum_y2_50 - sum_y_50 * sum_y_50;
    if var_y_50 <= 1e-12 {
        return None;
    }

    let max_lag_50 = (max_lag / 2).min(total_bins_50 as isize);
    let max_cue_50 = max_cue_bins.div_ceil(2);
    let n_fft = (max_cue_50 + total_bins_50 + max_lag_50.unsigned_abs())
        .max(2)
        .next_power_of_two();
    let mut y_fft_re = vec![0.0f64; n_fft];
    let mut y_fft_im = vec![0.0f64; n_fft];
    y_fft_re[..total_bins_50].copy_from_slice(&y_50);
    fft_radix2(&mut y_fft_re, &mut y_fft_im, false);

    // Candidate scales: 1.0 plus common PAL/NTSC framerate ratios if enabled and timeline >= 90s,
    // plus 23.976 <-> 24.000 (0.1%) drift on feature-length timelines >= 20 min.
    let mut candidate_scales = vec![1.0f64];
    if config.check_framerate_drift && total_bins >= 9_000 {
        candidate_scales.extend([23.976 / 25.0, 25.0 / 23.976, 24.0 / 25.0, 25.0 / 24.0]);
        if total_bins >= 120_000 {
            let ntsc_film = 24_000.0 / 1001.0;
            candidate_scales.extend([ntsc_film / 24.0, 24.0 / ntsc_film]);
        }
    }

    let anchor_ms = spoken_cues[0].start_ms;
    let mut best_fit: Option<GlobalFit> = None;
    let mut best_adjusted = f64::NEG_INFINITY;

    for &scale in &candidate_scales {
        let merged = build_merged_cue_intervals(spoken_cues, max_cue_bins, scale, anchor_ms);
        if merged.is_empty() {
            continue;
        }
        let total_cue_bins: usize = merged.iter().map(|&(a, b)| b - a).sum();
        let (x_50, pref_x_50, total_cue_50) = build_mask_50hz_from_merged(&merged, max_cue_50);
        if total_cue_50 == 0 || x_50.is_empty() {
            continue;
        }

        let min_lag_50 = -(max_lag / 2).min(x_50.len() as isize);
        let pos_lag_50 = (max_lag / 2).min(total_bins_50 as isize);
        let raw_sums =
            fft_correlate_with_precomputed_y(&x_50, &y_fft_re, &y_fft_im, min_lag_50, pos_lag_50);

        let mut coarse_points: Vec<(isize, f64)> = Vec::with_capacity(raw_sums.len());
        for (lag_50, sum_xy) in raw_sums {
            let lo = 0isize.max(-lag_50) as usize;
            let hi = (total_bins_50 as isize - lag_50).min(x_50.len() as isize);
            if hi <= lo as isize {
                continue;
            }
            let sum_x = pref_x_50[hi as usize] - pref_x_50[lo];
            if sum_x < (total_cue_50 as f64) * 0.50 {
                continue;
            }
            let var_x = nf_50 * sum_x - sum_x * sum_x;
            let r = if var_x <= 1e-12 {
                0.0
            } else {
                let den = (var_x * var_y_50).sqrt();
                if den <= 1e-12 {
                    0.0
                } else {
                    (nf_50 * sum_xy - sum_x * sum_y_50) / den
                }
            };
            coarse_points.push((lag_50 * 2, r));
        }
        if coarse_points.is_empty() {
            continue;
        }

        let mut ranked = coarse_points.clone();
        ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
        let mut peak_lags: Vec<isize> = Vec::with_capacity(6);
        for &(cand_lag, _) in &ranked {
            if peak_lags.iter().all(|&p| (p - cand_lag).abs() >= 20) {
                peak_lags.push(cand_lag);
                if peak_lags.len() == 6 {
                    break;
                }
            }
        }

        let mut local_best_lag = ranked[0].0;
        let mut local_best_corr = ranked[0].1;
        for peak_lag in peak_lags {
            let fine_lo = (peak_lag - 8).max(-max_lag);
            let fine_hi = (peak_lag + 8).min(max_lag);
            for f_lag in fine_lo..=fine_hi {
                if let Some(r) = score_alignment_fast(
                    pref_y,
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

        let z = measure_background_z(&coarse_points, local_best_lag, local_best_corr, 250);
        // A frame-rate-drift candidate must clearly beat the unscaled fit; otherwise random noise
        // could make a wrong scale win by a hair and visibly stretch an already-correct subtitle.
        let adjusted = if (scale - 1.0).abs() > 1e-9 {
            local_best_corr - DRIFT_CANDIDATE_MARGIN
        } else {
            local_best_corr
        };
        if adjusted > best_adjusted {
            best_adjusted = adjusted;
            best_fit = Some(GlobalFit {
                scale,
                lag_10ms: local_best_lag,
                corr: local_best_corr,
                z,
                anchor_ms,
                merged,
            });
        }
    }

    best_fit
}

#[derive(Debug, Clone)]
struct BlockCandidate {
    offset_ms: i64,
    corr: f64,
    z: f64,
}

#[derive(Debug, Clone)]
struct CueBlock {
    start_ms: u64,
    end_ms: u64,
    center_ms: u64,
    candidates: Vec<BlockCandidate>,
}

fn score_block_window_10ms(
    pref_y: &[f64],
    pref_y2: &[f64],
    total_bins: usize,
    block_merged_rel: &[(usize, usize)],
    block_len_10ms: usize,
    total_cue_bins: usize,
    start_pos: isize,
) -> Option<f64> {
    if start_pos < 0 {
        return None;
    }
    let s = start_pos as usize;
    let e = s.saturating_add(block_len_10ms);
    if e > total_bins || block_len_10ms < 100 || total_cue_bins == 0 {
        return None;
    }
    let nf = block_len_10ms as f64;
    let sum_y = pref_y[e] - pref_y[s];
    let sum_y2 = pref_y2[e] - pref_y2[s];
    let var_y = nf * sum_y2 - sum_y * sum_y;
    let sum_x = total_cue_bins as f64;
    let var_x = nf * sum_x - sum_x * sum_x;
    if var_y <= 1e-12 || var_x <= 1e-12 {
        return None;
    }
    let mut sum_xy = 0.0f64;
    for &(b0, b1) in block_merged_rel {
        sum_xy += pref_y[s + b1] - pref_y[s + b0];
    }
    let den = (var_x * var_y).sqrt();
    if den <= 1e-12 {
        None
    } else {
        Some((nf * sum_xy - sum_x * sum_y) / den)
    }
}

fn build_cue_blocks(spoken_cues: &[SubtitleCue]) -> Vec<(usize, usize)> {
    let n = spoken_cues.len();
    if n < 12 {
        return Vec::new();
    }
    let block_cues = (n / 10).clamp(8, 20);
    let step = (block_cues / 2).max(4);
    let mut ranges = Vec::new();
    let mut i = 0usize;
    while i < n && ranges.len() < 28 {
        let mut end = (i + block_cues).min(n);
        if end - i < 8 && !ranges.is_empty() {
            break;
        }
        // Keep block span <= 300s when cues are sparse, preserving at least 8 cues
        while end - i > 8 && spoken_cues[end - 1].end_ms - spoken_cues[i].start_ms > 300_000 {
            end -= 1;
        }
        ranges.push((i, end));
        if end == n {
            break;
        }
        i += step;
    }
    ranges
}

fn evaluate_cue_blocks(
    spoken_cues: &[SubtitleCue],
    audio_envelope: &[f32],
    y_50: &[f64],
    pref_y_50: &[f64],
    pref_y2_50: &[f64],
    pref_y: &[f64],
    pref_y2: &[f64],
) -> Vec<CueBlock> {
    let total_bins = audio_envelope.len();
    let total_bins_50 = y_50.len();
    let search_radius_50 = ((total_bins_50 as f64) * 0.45).clamp(15_000.0, 60_000.0) as isize;
    let ranges = build_cue_blocks(spoken_cues);
    let mut blocks = Vec::with_capacity(ranges.len());

    for (c0, c1) in ranges {
        let slice = &spoken_cues[c0..c1];
        let start_ms = slice[0].start_ms;
        let end_ms = slice.iter().map(|c| c.end_ms).max().unwrap_or(start_ms);
        let center_ms = (start_ms + end_ms) / 2;
        let b_start_10 = (start_ms / 10) as usize;
        let b_end_10 = (end_ms.div_ceil(10) as usize).max(b_start_10 + 10);
        let block_len_10 = b_end_10 - b_start_10;
        if block_len_10 >= total_bins {
            continue;
        }

        // Build cue intervals relative to b_start_10
        let mut rel_raw: Vec<(usize, usize)> = slice
            .iter()
            .filter_map(|c| {
                let s = ((c.start_ms / 10) as usize).saturating_sub(b_start_10);
                let e = (c.end_ms.div_ceil(10) as usize)
                    .saturating_sub(b_start_10)
                    .min(block_len_10);
                (e > s).then_some((s, e))
            })
            .collect();
        rel_raw.sort_unstable();
        let mut rel_merged: Vec<(usize, usize)> = Vec::with_capacity(rel_raw.len());
        for (a, b) in rel_raw {
            if let Some(last) = rel_merged.last_mut() {
                if a <= last.1 {
                    last.1 = last.1.max(b);
                    continue;
                }
            }
            rel_merged.push((a, b));
        }
        let total_cue_10: usize = rel_merged.iter().map(|&(a, b)| b - a).sum();
        if total_cue_10 < 50 {
            continue;
        }

        let b_start_50 = b_start_10 / 2;
        let block_len_50 = block_len_10.div_ceil(2);
        if block_len_50 < 50 || block_len_50 >= total_bins_50 {
            continue;
        }
        let (x_block_50, _, total_cue_50) = build_mask_50hz_from_merged(&rel_merged, block_len_50);
        if x_block_50.len() < 40 || total_cue_50 < 20 {
            continue;
        }
        let k_len = x_block_50.len();
        let sum_x = total_cue_50 as f64;
        let nf = k_len as f64;
        let var_x = nf * sum_x - sum_x * sum_x;
        if var_x <= 1e-12 {
            continue;
        }

        let win_lo_50 = (b_start_50 as isize - search_radius_50).max(0) as usize;
        let win_hi_50 =
            ((b_start_50 + k_len) as isize + search_radius_50).min(total_bins_50 as isize) as usize;
        if win_hi_50 <= win_lo_50 + k_len {
            continue;
        }
        let y_win = &y_50[win_lo_50..win_hi_50];
        let n_fft = (k_len + y_win.len()).max(2).next_power_of_two();
        let mut y_fft_re = vec![0.0f64; n_fft];
        let mut y_fft_im = vec![0.0f64; n_fft];
        y_fft_re[..y_win.len()].copy_from_slice(y_win);
        fft_radix2(&mut y_fft_re, &mut y_fft_im, false);

        let max_shift_50 = (y_win.len() - k_len) as isize;
        let raw_sums =
            fft_correlate_with_precomputed_y(&x_block_50, &y_fft_re, &y_fft_im, 0, max_shift_50);

        let mut ncc_points: Vec<(isize, f64)> = Vec::with_capacity(raw_sums.len());
        for (shift_50, sum_xy) in raw_sums {
            let s = win_lo_50 + shift_50 as usize;
            let e = s + k_len;
            let sum_y = pref_y_50[e] - pref_y_50[s];
            let sum_y2 = pref_y2_50[e] - pref_y2_50[s];
            let var_y = nf * sum_y2 - sum_y * sum_y;
            if var_y <= 1e-12 {
                continue;
            }
            let den = (var_x * var_y).sqrt();
            let r = if den <= 1e-12 {
                0.0
            } else {
                (nf * sum_xy - sum_x * sum_y) / den
            };
            let lag_10 = (s as isize - b_start_50 as isize) * 2;
            ncc_points.push((lag_10, r));
        }
        if ncc_points.len() < 30 {
            continue;
        }

        let mut ranked = ncc_points.clone();
        ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));
        let mut peak_lags: Vec<isize> = Vec::with_capacity(4);
        for &(cand_lag, _) in &ranked {
            if peak_lags.iter().all(|&p| (p - cand_lag).abs() >= 100) {
                peak_lags.push(cand_lag);
                if peak_lags.len() == 4 {
                    break;
                }
            }
        }

        let mut candidates = Vec::new();
        for peak_lag in peak_lags {
            let mut best_l = peak_lag;
            let mut best_r = f64::NEG_INFINITY;
            for f_lag in (peak_lag - 8)..=(peak_lag + 8) {
                let start_pos = b_start_10 as isize + f_lag;
                if let Some(r) = score_block_window_10ms(
                    pref_y,
                    pref_y2,
                    total_bins,
                    &rel_merged,
                    block_len_10,
                    total_cue_10,
                    start_pos,
                ) {
                    if r > best_r {
                        best_r = r;
                        best_l = f_lag;
                    }
                }
            }
            if !best_r.is_finite() {
                continue;
            }
            let z = measure_background_z(&ncc_points, best_l, best_r, 250);
            if best_r >= 0.14 && z >= 3.0 {
                candidates.push(BlockCandidate {
                    offset_ms: (best_l as i64) * 10,
                    corr: best_r,
                    z,
                });
            }
        }
        candidates.sort_unstable_by(|a, b| b.z.total_cmp(&a.z));
        blocks.push(CueBlock {
            start_ms,
            end_ms,
            center_ms,
            candidates,
        });
    }
    blocks
}

fn try_ransac_linear_blocks(blocks: &[CueBlock]) -> Option<(AutoSyncOutcome, usize)> {
    let strong: Vec<(usize, &CueBlock)> = blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.candidates.first().is_some_and(|c| c.z >= 3.6))
        .collect();
    if strong.len() < 4 || blocks.len() < 4 {
        return None;
    }

    let first_t = blocks.first()?.center_ms as f64;
    let last_t = blocks.last()?.center_ms as f64;
    let min_sep = (last_t - first_t) * 0.25;

    // Collect candidate (anchor_ms, scale, offset_ms) lines: unscaled + pair-derived linear fits
    let mut lines: Vec<(u64, f64, i64)> = Vec::new();
    for &(_, blk) in &strong {
        for cand in blk.candidates.iter().take(2) {
            lines.push((blk.center_ms, 1.0, cand.offset_ms));
        }
    }
    if min_sep >= 60_000.0 {
        for a_idx in 0..strong.len() {
            let (_, ba) = strong[a_idx];
            for &(_, bb) in strong.iter().skip(a_idx + 1) {
                let dt = (bb.center_ms as f64) - (ba.center_ms as f64);
                if dt < min_sep {
                    continue;
                }
                for ca in ba.candidates.iter().take(2) {
                    for cb in bb.candidates.iter().take(2) {
                        let scale = 1.0 + ((cb.offset_ms - ca.offset_ms) as f64) / dt;
                        if (0.90..=1.12).contains(&scale) {
                            lines.push((ba.center_ms, scale, ca.offset_ms));
                        }
                    }
                }
            }
        }
    }

    let mut best_inliers: Vec<(f64, f64, f64, f64)> = Vec::new(); // (t, target_audio_ms, z, corr)
    let mut best_score = 0.0f64;

    for (anc_ms, scale, off_ms) in lines {
        let mut inliers = Vec::new();
        let mut score = 0.0f64;
        for blk in blocks {
            let pred_off =
                (off_ms as f64) + ((blk.center_ms as f64) - (anc_ms as f64)) * (scale - 1.0);
            if let Some(best_c) = blk
                .candidates
                .iter()
                .filter(|c| ((c.offset_ms as f64) - pred_off).abs() <= 350.0)
                .max_by(|a, b| a.z.total_cmp(&b.z))
            {
                let audio_t = (blk.center_ms as f64) + (best_c.offset_ms as f64);
                inliers.push((blk.center_ms as f64, audio_t, best_c.z, best_c.corr));
                score += best_c.z;
            }
        }
        // Prefer unscaled lines slightly when scores tie
        let adj_score = if (scale - 1.0).abs() > 1e-6 {
            score - 1.0
        } else {
            score
        };
        if inliers.len() >= 4 && adj_score > best_score {
            best_score = adj_score;
            best_inliers = inliers;
        }
    }

    let inlier_count = best_inliers.len();
    if inlier_count < 4 || inlier_count * 2 < strong.len() || inlier_count * 5 < blocks.len() * 2 {
        return None;
    }

    let mean_z = best_inliers.iter().map(|v| v.2).sum::<f64>() / (inlier_count as f64);
    let mean_r = best_inliers.iter().map(|v| v.3).sum::<f64>() / (inlier_count as f64);
    if mean_z < 4.2 || mean_r < 0.17 {
        return None;
    }

    // Weighted linear regression: audio_t = scale * (t - anchor) + (anchor + offset)
    let w_sum: f64 = best_inliers.iter().map(|v| v.2).sum();
    let t_mean = best_inliers.iter().map(|v| v.2 * v.0).sum::<f64>() / w_sum;
    let y_mean = best_inliers.iter().map(|v| v.2 * v.1).sum::<f64>() / w_sum;
    let mut num = 0.0f64;
    let mut den = 0.0f64;
    for &(t, y, w, _) in &best_inliers {
        num += w * (t - t_mean) * (y - y_mean);
        den += w * (t - t_mean) * (t - t_mean);
    }
    let mut scale = if den > 1e-6 { num / den } else { 1.0 };
    if !(0.90..=1.12).contains(&scale) {
        return None;
    }

    // Snap micro-drift near 1.0x when a pure constant offset already fits tightly
    let const_off = y_mean - t_mean;
    let max_const_err = best_inliers
        .iter()
        .map(|&(t, y, _, _)| (y - (t + const_off)).abs())
        .fold(0.0f64, f64::max);
    if (scale - 1.0).abs() < 0.0004 || max_const_err <= 250.0 {
        scale = 1.0;
    }

    let anchor_ms = t_mean.round().max(0.0) as u64;
    let offset_ms = ((y_mean - t_mean).round()) as i64;
    let drift_applied = (scale - 1.0).abs() > 1e-4;
    let transform = SubtitleTimingTransform::Linear {
        scale,
        anchor_ms,
        offset_ms,
    };
    Some((
        AutoSyncOutcome {
            offset_ms,
            scale,
            anchor_ms,
            drift_applied,
            confidence_z: mean_z,
            correlation: mean_r,
            transform,
        },
        inlier_count,
    ))
}

fn find_largest_inter_cue_gap_split(cues: &[SubtitleCue], lo_ms: u64, hi_ms: u64) -> u64 {
    let mid_fallback = (lo_ms + hi_ms) / 2;
    let mut sorted: Vec<(u64, u64)> = cues
        .iter()
        .filter(|c| c.end_ms >= lo_ms && c.start_ms <= hi_ms)
        .map(|c| (c.start_ms, c.end_ms))
        .collect();
    if sorted.len() < 2 {
        return mid_fallback;
    }
    sorted.sort_unstable();
    let mut best_gap = 0u64;
    let mut best_mid = mid_fallback;
    let mut prev_end = sorted[0].1;
    for &(s, e) in sorted.iter().skip(1) {
        if s > prev_end {
            let gap = s - prev_end;
            if gap > best_gap {
                best_gap = gap;
                best_mid = prev_end + gap / 2;
            }
        }
        prev_end = prev_end.max(e);
    }
    if best_gap >= 200 {
        best_mid
    } else {
        mid_fallback
    }
}

fn solve_piecewise_dp(
    cues: &[SubtitleCue],
    blocks: &[CueBlock],
) -> Option<(AutoSyncOutcome, usize)> {
    let m = blocks.len();
    if m < 3 {
        return None;
    }

    // Build filtered candidate list per block (z >= 3.5 && r >= 0.15)
    let filtered: Vec<Vec<&BlockCandidate>> = blocks
        .iter()
        .map(|b| {
            b.candidates
                .iter()
                .filter(|c| c.z >= 3.5 && c.corr >= 0.15)
                .collect()
        })
        .collect();

    // DP over (block_idx, cand_idx) for the best chain of matched blocks
    let mut dp_score: Vec<Vec<f64>> = filtered
        .iter()
        .map(|cands| cands.iter().map(|c| c.z).collect())
        .collect();
    let mut dp_prev: Vec<Vec<Option<(usize, usize)>>> = filtered
        .iter()
        .map(|cands| vec![None; cands.len()])
        .collect();

    for b in 0..m {
        for cb in 0..filtered[b].len() {
            let cand_b = filtered[b][cb];
            let audio_b = (blocks[b].center_ms as i64) + cand_b.offset_ms;
            let mut best_val = cand_b.z;
            let mut best_p: Option<(usize, usize)> = None;

            for p in 0..b {
                let skip_cost = ((b - p - 1) as f64) * 1.0;
                for cp in 0..filtered[p].len() {
                    let cand_p = filtered[p][cp];
                    let audio_p = (blocks[p].center_ms as i64) + cand_p.offset_ms;
                    if audio_b <= audio_p + 2_000 {
                        continue;
                    }
                    let delta = (cand_b.offset_ms - cand_p.offset_ms).abs();
                    let jump_pen = if delta <= 300 {
                        (delta as f64 / 300.0) * 0.4
                    } else {
                        5.5 + 0.001 * ((delta as f64 / 1000.0).min(1.0))
                    };
                    let val = dp_score[p][cp] + cand_b.z - jump_pen - skip_cost;
                    if val > best_val {
                        best_val = val;
                        best_p = Some((p, cp));
                    }
                }
            }
            dp_score[b][cb] = best_val;
            dp_prev[b][cb] = best_p;
        }
    }

    let mut end_node: Option<(usize, usize, f64)> = None;
    for (b, scores) in dp_score.iter().enumerate() {
        for (cb, &s) in scores.iter().enumerate() {
            if end_node.is_none_or(|(_, _, best_s)| s > best_s) {
                end_node = Some((b, cb, s));
            }
        }
    }
    let (mut cur_b, mut cur_c, _) = end_node?;
    let mut path_rev: Vec<(usize, &BlockCandidate)> = Vec::new();
    loop {
        path_rev.push((cur_b, filtered[cur_b][cur_c]));
        if let Some((pb, pc)) = dp_prev[cur_b][cur_c] {
            cur_b = pb;
            cur_c = pc;
        } else {
            break;
        }
    }
    path_rev.reverse();

    let matched_count = path_rev.len();
    let min_matched = if m >= 8 { 4 } else { 3 };
    if matched_count < min_matched || matched_count * 10 < m * 4 {
        return None;
    }
    let mean_z = path_rev.iter().map(|(_, c)| c.z).sum::<f64>() / (matched_count as f64);
    let mean_r = path_rev.iter().map(|(_, c)| c.corr).sum::<f64>() / (matched_count as f64);
    if mean_z < 4.2 || mean_r < 0.17 {
        return None;
    }

    // Group consecutive matched blocks whose offsets stay within ±300 ms into clean segments
    let mut clusters: Vec<Vec<(usize, &BlockCandidate)>> = Vec::new();
    for item in path_rev {
        if let Some(last_cluster) = clusters.last_mut() {
            let ref_off = last_cluster[0].1.offset_ms;
            if (item.1.offset_ms - ref_off).abs() <= 300 {
                last_cluster.push(item);
                continue;
            }
        }
        clusters.push(vec![item]);
    }

    let mut segments: Vec<TimingSegment> = Vec::with_capacity(clusters.len());
    for (idx, cluster) in clusters.iter().enumerate() {
        let w_sum: f64 = cluster.iter().map(|(_, c)| c.z).sum();
        let avg_off = cluster
            .iter()
            .map(|(_, c)| c.z * (c.offset_ms as f64))
            .sum::<f64>()
            / w_sum;
        let offset_ms = ((avg_off / 10.0).round() as i64) * 10;
        let start_src_ms = if idx == 0 {
            0
        } else {
            let prev_last_b = clusters[idx - 1].last()?.0;
            let cur_first_b = cluster.first()?.0;
            let lo = blocks[prev_last_b].end_ms.min(blocks[cur_first_b].start_ms);
            let hi = blocks[prev_last_b].end_ms.max(blocks[cur_first_b].start_ms);
            find_largest_inter_cue_gap_split(cues, lo, hi)
        };
        segments.push(TimingSegment {
            start_src_ms,
            scale: 1.0,
            anchor_ms: start_src_ms,
            offset_ms,
        });
    }

    // `map_cue` binary-searches segment starts, so they must be strictly increasing even when
    // overlapping blocks produced split points that collide or regress.
    for i in 1..segments.len() {
        let floor = segments[i - 1].start_src_ms.saturating_add(1);
        if segments[i].start_src_ms < floor {
            segments[i].start_src_ms = floor;
            segments[i].anchor_ms = floor;
        }
    }

    let first_off = segments[0].offset_ms;
    let transform = if segments.len() == 1 {
        SubtitleTimingTransform::Linear {
            scale: 1.0,
            anchor_ms: 0,
            offset_ms: first_off,
        }
    } else {
        SubtitleTimingTransform::Piecewise { segments }
    };

    Some((
        AutoSyncOutcome {
            offset_ms: first_off,
            scale: 1.0,
            anchor_ms: 0,
            drift_applied: false,
            confidence_z: mean_z,
            correlation: mean_r,
            transform,
        },
        matched_count,
    ))
}

fn align_different_source_segments(
    cues: &[SubtitleCue],
    spoken_cues: &[SubtitleCue],
    audio_envelope: &[f32],
    pref_y: &[f64],
    pref_y2: &[f64],
) -> Option<AutoSyncOutcome> {
    let y_50 = downsample_2x(audio_envelope);
    let total_50 = y_50.len();
    if total_50 < 300 {
        return None;
    }
    let mut pref_y_50 = Vec::with_capacity(total_50 + 1);
    let mut pref_y2_50 = Vec::with_capacity(total_50 + 1);
    pref_y_50.push(0.0);
    pref_y2_50.push(0.0);
    let (mut ay, mut ay2) = (0.0, 0.0);
    for &v in &y_50 {
        ay += v;
        ay2 += v * v;
        pref_y_50.push(ay);
        pref_y2_50.push(ay2);
    }

    let blocks = evaluate_cue_blocks(
        spoken_cues,
        audio_envelope,
        &y_50,
        &pref_y_50,
        &pref_y2_50,
        pref_y,
        pref_y2,
    );
    if blocks.is_empty() {
        return None;
    }

    let ransac = try_ransac_linear_blocks(&blocks);
    let dp = solve_piecewise_dp(cues, &blocks);
    match (ransac, dp) {
        (Some((r_out, r_cnt)), Some((d_out, d_cnt))) => {
            if d_out.transform.segment_count() > 1 && d_cnt >= r_cnt + 2 {
                Some(d_out)
            } else {
                Some(r_out)
            }
        }
        (Some((r_out, _)), None) => Some(r_out),
        (None, Some((d_out, _))) => Some(d_out),
        (None, None) => None,
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
    let total_bins = audio_envelope.len();

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

    let global_fit = run_global_fft_align(
        &spoken_cues,
        audio_envelope,
        &pref_y,
        sum_y_all,
        var_y_term,
        config,
    );

    let global_confident = global_fit
        .as_ref()
        .is_some_and(|g| is_confident_alignment(g.corr, g.z, config));

    let can_try_segmented = spoken_cues.len() >= 18 && total_bins >= 12_000;
    let mut need_segmented = !global_confident;

    // Even if global correlation passes, verify each third of the timeline aligns consistently
    // so mid-episode commercial-break cuts or trimmed scenes don't leave a section out of sync.
    if global_confident && can_try_segmented {
        if let Some(ref g) = global_fit {
            if g.merged.len() >= 18 {
                let t1 = g.merged.len() / 3;
                let t2 = (g.merged.len() * 2) / 3;
                let thirds = [&g.merged[..t1], &g.merged[t1..t2], &g.merged[t2..]];
                let mut rs = [0.0f64; 3];
                for (slot, slice) in rs.iter_mut().zip(thirds.iter()) {
                    let bins: usize = slice.iter().map(|&(a, b)| b - a).sum();
                    *slot = score_alignment_fast(
                        &pref_y, sum_y_all, var_y_term, total_bins, slice, bins, g.lag_10ms,
                    )
                    .unwrap_or(0.0);
                }
                let min_r = rs.iter().copied().fold(f64::INFINITY, f64::min);
                let max_r = rs.iter().copied().fold(f64::NEG_INFINITY, f64::max);
                if min_r < 0.08 || (max_r > 0.12 && min_r < max_r * 0.40) {
                    need_segmented = true;
                }
            }
        }
    }

    if need_segmented && can_try_segmented {
        if let Some(seg_outcome) =
            align_different_source_segments(cues, &spoken_cues, audio_envelope, &pref_y, &pref_y2)
        {
            let prefer_seg = match (&global_fit, global_confident) {
                (_, false) => true,
                (Some(g), true) => {
                    seg_outcome.transform.segment_count() > 1
                        || seg_outcome.correlation > g.corr + 0.04
                }
                (None, true) => true,
            };
            if prefer_seg {
                return Ok(seg_outcome);
            }
        }
    }

    if let Some(g) = global_fit {
        if is_confident_alignment(g.corr, g.z, config) {
            let offset_ms = (g.lag_10ms as i64) * 10;
            let drift_applied = (g.scale - 1.0).abs() > 1e-4;
            return Ok(AutoSyncOutcome {
                offset_ms,
                scale: g.scale,
                anchor_ms: g.anchor_ms,
                drift_applied,
                confidence_z: g.z,
                correlation: g.corr,
                transform: SubtitleTimingTransform::Linear {
                    scale: g.scale,
                    anchor_ms: g.anchor_ms,
                    offset_ms,
                },
            });
        }
        return Err(SubtitleSyncError::LowConfidence(format!(
            "r={:.2}, Z={:.1}",
            g.corr.max(0.0),
            g.z.max(0.0)
        )));
    }

    Err(SubtitleSyncError::LowConfidence(
        "r=0.00, Z=0.0".to_string(),
    ))
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
    fn test_multilingual_utf8_scripts_sdh_and_malformed_unicode_timestamps() {
        // Multi-byte UTF-8 inside fractional seconds must return Err instead of panicking on &[..3]
        assert_eq!(
            parse_timestamp_ms("00:00:05.١٢٣"),
            Err(SubtitleSyncError::InvalidTimestamp)
        );

        // Spoken dialogue preservation across non-Latin scripts vs SDH filtering
        assert!(is_spoken_dialogue_text("「今日はどこへ行くの？」"));
        assert!(is_spoken_dialogue_text("مرحبا بكم جميعاً"));
        assert!(is_spoken_dialogue_text("안녕하세요, 잘 지내셨어요?"));
        assert!(is_spoken_dialogue_text("你好，我们开始吧。"));
        assert!(is_spoken_dialogue_text("नमस्ते, आप कैसे हैं?"));
        assert!(is_spoken_dialogue_text("Привет, как дела?"));
        assert!(is_spoken_dialogue_text("שלום לכולם"));
        assert!(!is_spoken_dialogue_text("（効果音：ドアが開く）"));
        assert!(!is_spoken_dialogue_text("【موسيقى هادئة】"));
        assert!(!is_spoken_dialogue_text("[смех за кадром]"));
        assert!(!is_spoken_dialogue_text("♪ 君の名前を呼んでいる ♪"));

        // UTF-8 BOM + multilingual SRT parse and piecewise rescale round-trip
        let srt = "\u{FEFF}1\n00:00:02,000 --> 00:00:04,500\n「今日はいい天気だね」\n\n2\n00:00:10,000 --> 00:00:12,500\nمرحبا يا صديقي\n";
        let mut cues = parse_subtitles(srt).unwrap();
        assert_eq!(cues.len(), 2);
        rescale_cues_with_transform(
            &mut cues,
            &SubtitleTimingTransform::Linear {
                scale: 1.0,
                anchor_ms: 0,
                offset_ms: 1_500,
            },
        )
        .unwrap();
        let rendered = render_srt(&cues);
        assert!(rendered.contains("「今日はいい天気だね」"));
        assert!(rendered.contains("مرحبا يا صديقي"));
        assert!(rendered.contains("00:00:03,500 --> 00:00:06,000"));

        // Arabic RTL directional mark (U+200F) around cue timestamps must still parse cleanly
        let rtl_srt = "1\n\u{200F}00:00:02,000 --> \u{200F}00:00:04,500\nمرحبا بكم\n";
        let rtl_cues = parse_subtitles(rtl_srt).unwrap();
        assert_eq!(rtl_cues[0].start_ms, 2_000);
        assert_eq!(rtl_cues[0].end_ms, 4_500);
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

    #[test]
    fn test_autosync_large_offset_beyond_180s_and_23976_to_24000_drift() {
        // 1) +235s offset (e.g. recap/intro cut > 3 min) on a 900s timeline
        let mut windows = Vec::new();
        let mut t = 260_000u64;
        let mut step = 0u64;
        while t < 860_000 {
            let dur = 1_500 + ((step * 1_123) % 1_700);
            let gap = 4_800 + ((step * 2_531) % 6_200);
            windows.push((t, t + dur));
            t += dur + gap;
            step += 1;
        }
        let env_large = make_synthetic_envelope(900, &windows);
        let cues_large: Vec<SubtitleCue> = windows
            .iter()
            .enumerate()
            .map(|(i, &(s, e))| SubtitleCue {
                index: i + 1,
                start_ms: s - 235_000,
                end_ms: e - 235_000,
                text: format!("Recap-shifted line {i}"),
            })
            .collect();
        let res_large =
            auto_align_subtitles(&cues_large, &env_large, &AutoSyncConfig::default()).unwrap();
        assert!(
            (res_large.offset_ms - 235_000).abs() <= 40,
            "got {} expected ~235000",
            res_large.offset_ms
        );
        assert!(!res_large.drift_applied);

        // 2) 23.976 fps vs 24.000 fps across a 90-minute (5400s) feature film (~5.4s cumulative drift)
        let secs = 5_400usize;
        let mut film_windows = Vec::new();
        let mut ft = 15_000u64;
        let mut fstep = 0u64;
        while ft < 5_360_000 {
            let dur = 1_600 + ((fstep * 1_451) % 2_000);
            let gap = 7_500 + ((fstep * 3_217) % 9_000);
            film_windows.push((ft, ft + dur));
            ft += dur + gap;
            fstep += 1;
        }
        let env_film = make_synthetic_envelope(secs, &film_windows);
        let true_scale = 24.0 / (24_000.0 / 1001.0);
        let film_cues: Vec<SubtitleCue> = film_windows
            .iter()
            .enumerate()
            .map(|(i, &(s, e))| SubtitleCue {
                index: i + 1,
                start_ms: ((s as f64 / true_scale) as i64 + 4_500).max(0) as u64,
                end_ms: ((e as f64 / true_scale) as i64 + 4_500).max(0) as u64,
                text: format!("Film line {i}"),
            })
            .collect();
        let res_film =
            auto_align_subtitles(&film_cues, &env_film, &AutoSyncConfig::default()).unwrap();
        assert!(
            res_film.drift_applied,
            "expected 23.976->24.000 drift detected"
        );
        assert!(
            (res_film.scale - true_scale).abs() < 1e-4,
            "got scale {} expected {}",
            res_film.scale,
            true_scale
        );
    }

    #[test]
    fn test_autosync_syllable_pauses_linger_jitter_and_background_score_from_pcm() {
        let sr = 16_000usize;
        let secs = 300usize;
        let mut rng = 0x517cc1b727220a95u64;

        let mut speech_cues = Vec::new();
        let mut t_ms = 35_000u64;
        for step in 0..32u64 {
            let dur = 1_800 + ((step * 877) % 1_800);
            let gap = 3_400 + ((step * 2_213) % 4_200);
            speech_cues.push((t_ms, t_ms + dur));
            t_ms += dur + gap;
        }

        // Simulate realistic speech: 180ms syllables separated by 90ms gaps inside the first 65%
        // of each cue (leaving trailing reading linger), plus continuous 180Hz/420Hz music bed
        // and sharp 30ms transient SFX spikes.
        let mut pcm = Vec::with_capacity(sr * secs * 2);
        let mut cue_idx = 0usize;
        let true_offset_ms = 14_300i64;
        for n in 0..sr * secs {
            let cur_ms = (n as u64 * 1000) / sr as u64;
            while cue_idx < speech_cues.len() && cur_ms >= speech_cues[cue_idx].1 {
                cue_idx += 1;
            }
            let in_active_speech =
                if cue_idx < speech_cues.len() && cur_ms >= speech_cues[cue_idx].0 {
                    let rel = cur_ms - speech_cues[cue_idx].0;
                    let span = speech_cues[cue_idx].1 - speech_cues[cue_idx].0;
                    // Slight pre-speech lead (100ms), reading linger (250ms), and 80ms word gaps
                    rel >= 100 && rel + 250 < span && (rel % 260) < 180
                } else {
                    false
                };
            let is_sfx_spike = (cur_ms % 23_000) < 35;

            let t = n as f64 / sr as f64;
            let score_bed = 2_400.0 * (2.0 * std::f64::consts::PI * 180.0 * t).sin()
                + 1_100.0 * (2.0 * std::f64::consts::PI * 420.0 * t).sin();
            let speech = if in_active_speech {
                5_200.0 * (2.0 * std::f64::consts::PI * 820.0 * t).sin()
            } else {
                0.0
            };
            let spike = if is_sfx_spike {
                18_000.0 * (2.0 * std::f64::consts::PI * 1_350.0 * t).sin()
            } else {
                0.0
            };
            let sample = (score_bed + speech + spike).clamp(-32767.0, 32767.0) as i16;
            pcm.extend_from_slice(&sample.to_le_bytes());
        }

        let mut builder = AudioEnvelopeBuilder::with_sample_rate(sr);
        builder.push_pcm_s16le_bytes(&pcm);
        let env = builder.finish().expect("envelope");

        let cues: Vec<SubtitleCue> = speech_cues
            .iter()
            .enumerate()
            .map(|(i, &(s, e))| {
                // Add ±140ms human subtitler jitter
                let jitter = ((lcg(&mut rng) - 0.5) * 280.0) as i64;
                SubtitleCue {
                    index: i + 1,
                    start_ms: (s as i64 - true_offset_ms + jitter).max(0) as u64,
                    end_ms: (e as i64 - true_offset_ms + jitter).max(100) as u64,
                    text: format!("Natural line {i}"),
                }
            })
            .collect();
        let res = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default()).expect("aligned");
        assert!(
            (res.offset_ms - true_offset_ms).abs() <= 150,
            "got {} expected ~{} (r={}, z={})",
            res.offset_ms,
            true_offset_ms,
            res.correlation,
            res.confidence_z
        );

        // Wrong subtitles against the same realistic soundtrack must still reject cleanly
        let wrong_cues: Vec<SubtitleCue> = (0..32u64)
            .map(|i| SubtitleCue {
                index: (i + 1) as usize,
                start_ms: 12_000 + i * 7_100,
                end_ms: 13_600 + i * 7_100,
                text: format!("Wrong line {i}"),
            })
            .collect();
        assert!(matches!(
            auto_align_subtitles(&wrong_cues, &env, &AutoSyncConfig::default()),
            Err(SubtitleSyncError::LowConfidence(_))
        ));
    }

    #[test]
    fn test_fft_correlate_matches_naive_cross_correlation() {
        let mut rng = 0x123456789ABCDEF0u64;
        let x: Vec<f64> = (0..137).map(|_| lcg(&mut rng) as f64).collect();
        let y: Vec<f64> = (0..311).map(|_| lcg(&mut rng) as f64).collect();
        let min_lag = -80isize;
        let max_lag = 150isize;

        let n = (x.len() + y.len() + max_lag.unsigned_abs()).next_power_of_two();
        let mut y_re = vec![0.0f64; n];
        let mut y_im = vec![0.0f64; n];
        y_re[..y.len()].copy_from_slice(&y);
        fft_radix2(&mut y_re, &mut y_im, false);

        let fft_out = fft_correlate_with_precomputed_y(&x, &y_re, &y_im, min_lag, max_lag);
        assert_eq!(fft_out.len(), (max_lag - min_lag + 1) as usize);

        for &(lag, val) in &fft_out {
            let mut naive = 0.0f64;
            for (i, &xv) in x.iter().enumerate() {
                let yi = i as isize + lag;
                if yi >= 0 && (yi as usize) < y.len() {
                    naive += xv * y[yi as usize];
                }
            }
            assert!(
                (val - naive).abs() < 1e-8,
                "lag {lag}: fft={val}, naive={naive}"
            );
        }
    }

    #[test]
    fn test_autosync_different_source_commercial_cuts_forward_and_backward() {
        // 30-minute (1800s) episode with 3 acts separated by silent commercial/scene breaks:
        // Act 1 (0..600s): cue times need +2_400ms
        // Act 2 (600..1200s): cue times need +9_800ms (extra 7.4s commercial fade in video)
        // Act 3 (1200..1800s): cue times need +4_100ms (5.7s trimmed scene in video!)
        let secs = 1_800usize;
        let mut speech_windows = Vec::new();
        let mut cues = Vec::new();
        let mut idx = 1usize;

        let acts: &[(u64, u64, i64)] = &[
            (15_000, 575_000, 2_400),
            (615_000, 1_175_000, 9_800),
            (1_215_000, 1_765_000, 4_100),
        ];
        for &(act_s, act_e, shift_ms) in acts {
            let mut t = act_s;
            let mut step = 0u64;
            while t < act_e {
                let dur = 1_500 + ((step * 1_117) % 1_800);
                let gap = 3_800 + ((step * 2_411) % 4_600);
                let audio_s = (t as i64 + shift_ms) as u64;
                let audio_e = audio_s + dur;
                speech_windows.push((audio_s, audio_e));
                cues.push(SubtitleCue {
                    index: idx,
                    start_ms: t,
                    end_ms: t + dur,
                    text: format!("Act line {idx}"),
                });
                idx += 1;
                t += dur + gap;
                step += 1;
            }
        }

        let env = make_synthetic_envelope(secs, &speech_windows);
        let res = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default())
            .expect("segmented alignment should succeed");
        assert!(
            matches!(res.transform, SubtitleTimingTransform::Piecewise { .. }),
            "expected piecewise transform, got {:?}",
            res.transform
        );
        assert!(res.transform.segment_count() >= 3);

        let mut aligned = cues.clone();
        rescale_cues_with_transform(&mut aligned, &res.transform).unwrap();
        for (aligned_cue, &(exp_s, _)) in aligned.iter().zip(speech_windows.iter()) {
            assert!(
                (aligned_cue.start_ms as i64 - exp_s as i64).abs() <= 150,
                "cue {} got {} expected {}",
                aligned_cue.index,
                aligned_cue.start_ms,
                exp_s
            );
        }
    }

    #[test]
    fn test_autosync_different_source_missing_recap_and_arbitrary_drift() {
        // 40-minute (2400s) episode:
        // - First 110s of subtitle is a "Previously on..." recap NOT in the video (mismatched cues).
        // - Main body (120s..2280s) has an arbitrary 1.0035x speed/clock drift + 48_000ms shift.
        let secs = 2_400usize;
        let mut speech_windows = Vec::new();
        let mut cues = Vec::new();
        let mut idx = 1usize;

        // Unmatched recap cues in subtitle [5s..105s]
        for k in 0..14u64 {
            let s = 5_000 + k * 7_000;
            cues.push(SubtitleCue {
                index: idx,
                start_ms: s,
                end_ms: s + 2_200,
                text: format!("Previously on {k}"),
            });
            idx += 1;
        }

        let true_scale = 1.0035f64;
        let anchor_src = 130_000.0f64;
        let shift_at_anchor = 48_000.0f64;
        let mut t = 130_000u64;
        let mut step = 0u64;
        let mut expected_main_starts = Vec::new();
        while t < 2_250_000 {
            let dur = 1_500 + ((step * 1_237) % 1_900);
            let gap = 4_200 + ((step * 2_777) % 4_800);
            let audio_s = (anchor_src + ((t as f64) - anchor_src) * true_scale + shift_at_anchor)
                .round() as u64;
            let audio_e = audio_s + dur;
            if audio_e < (secs as u64) * 1000 {
                speech_windows.push((audio_s, audio_e));
                expected_main_starts.push(audio_s);
                cues.push(SubtitleCue {
                    index: idx,
                    start_ms: t,
                    end_ms: t + dur,
                    text: format!("Main body {idx}"),
                });
                idx += 1;
            }
            t += dur + gap;
            step += 1;
        }

        let env = make_synthetic_envelope(secs, &speech_windows);
        let res = auto_align_subtitles(&cues, &env, &AutoSyncConfig::default())
            .expect("recap + arbitrary drift should align");
        assert!(
            (res.scale - true_scale).abs() < 0.001,
            "got scale {} expected ~{true_scale}",
            res.scale
        );

        let mut aligned = cues.clone();
        rescale_cues_with_transform(&mut aligned, &res.transform).unwrap();
        for (cue, exp_s) in aligned.iter().skip(14).zip(expected_main_starts.iter()) {
            assert!(
                (cue.start_ms as i64 - *exp_s as i64).abs() <= 250,
                "cue {} got {} expected {}",
                cue.index,
                cue.start_ms,
                exp_s
            );
        }
    }

    #[test]
    fn test_autosync_different_source_rejects_wrong_episode_in_segmented_mode() {
        let secs = 1_800usize;
        let mut speech_windows = Vec::new();
        let mut t = 20_000u64;
        let mut step = 0u64;
        while t < 1_750_000 {
            let dur = 1_500 + ((step * 1_013) % 1_700);
            let gap = 4_500 + ((step * 2_909) % 5_000);
            speech_windows.push((t, t + dur));
            t += dur + gap;
            step += 1;
        }
        let env = make_synthetic_envelope(secs, &speech_windows);

        // Completely unrelated episode timings (different rhythm/spacing)
        let wrong_cues: Vec<SubtitleCue> = (0..180u64)
            .map(|i| {
                let s = 15_000 + i * 9_550 + ((i * 733) % 1_900);
                SubtitleCue {
                    index: (i + 1) as usize,
                    start_ms: s,
                    end_ms: s + 1_400 + ((i * 311) % 900),
                    text: format!("Unrelated cue {i}"),
                }
            })
            .collect();

        assert!(matches!(
            auto_align_subtitles(&wrong_cues, &env, &AutoSyncConfig::default()),
            Err(SubtitleSyncError::LowConfidence(_))
        ));
    }
}
