use crate::subtitle_sync::decode_subtitle_bytes;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use thiserror::Error;

pub const MAX_SUBTITLE_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024;
const ALLOWED_SUB_EXTS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub"];
const OPENSUBTITLES_HASH_CHUNK: usize = 65_536;
const OPENSUBTITLES_MIN_FILE_BYTES: u64 = (OPENSUBTITLES_HASH_CHUNK as u64) * 2;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OpenSubtitlesError {
    #[error("Unsafe archive entry path rejected: {0}")]
    UnsafeArchivePath(String),
    #[error("Unsupported archive entry file type: {0}")]
    UnsupportedExtension(String),
    #[error("Archive entry exceeds 16 MiB safety limit.")]
    PayloadTooLarge,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: Option<String>,
    pub moviehash: Option<String>,
    pub moviebytesize: Option<u64>,
    pub languages: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtitleFileRef {
    pub file_id: u64,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub file_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadResponse {
    pub link: String,
    pub file_name: Option<String>,
    pub remaining: Option<u64>,
}

pub fn build_search_query_string(params: &SearchParams) -> String {
    let mut pairs: Vec<String> = Vec::new();
    if let Some(ref hash) = params.moviehash {
        let clean = hash.trim();
        if !clean.is_empty() {
            pairs.push(format!("moviehash={}", url_encode_component(clean)));
        }
    }
    if let Some(size) = params.moviebytesize {
        if size > 0 {
            pairs.push(format!("moviebytesize={size}"));
        }
    }
    if let Some(ref langs) = params.languages {
        let clean = langs.trim();
        if !clean.is_empty() {
            pairs.push(format!("languages={}", url_encode_component(clean)));
        }
    }
    if let Some(ref query) = params.query {
        let clean = query.trim();
        if !clean.is_empty() {
            pairs.push(format!("query={}", url_encode_component(clean)));
        }
    }
    pairs.join("&")
}

fn url_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b',') {
            out.push(b as char);
        } else if b == b' ' {
            out.push_str("%20");
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn validate_archive_entry_path(
    entry_path: &str,
    uncompressed_bytes: u64,
) -> Result<(), OpenSubtitlesError> {
    if uncompressed_bytes > MAX_SUBTITLE_ARCHIVE_BYTES {
        return Err(OpenSubtitlesError::PayloadTooLarge);
    }
    let trimmed = entry_path.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.contains('\0')
    {
        return Err(OpenSubtitlesError::UnsafeArchivePath(
            entry_path.to_string(),
        ));
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(OpenSubtitlesError::UnsafeArchivePath(
            entry_path.to_string(),
        ));
    }
    for segment in trimmed.split(['/', '\\']) {
        if segment == ".." {
            return Err(OpenSubtitlesError::UnsafeArchivePath(
                entry_path.to_string(),
            ));
        }
    }
    let ext = trimmed
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_SUB_EXTS.contains(&ext.as_str()) {
        return Err(OpenSubtitlesError::UnsupportedExtension(ext));
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedMediaQuery {
    pub title: String,
    pub year: Option<u32>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub is_series: bool,
    pub direct_imdb_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImdbMatch {
    pub imdb_id: String,
    pub title: String,
    pub media_type: String,
    pub year: Option<u32>,
    pub score: i32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSearchCandidate {
    pub id: String,
    pub provider: String,
    pub language: String,
    pub language_label: String,
    pub release_name: String,
    pub file_name: String,
    pub download_url: Option<String>,
    pub file_id: Option<u64>,
    pub match_kind: String,
    pub fps: Option<f64>,
    pub encoding: Option<String>,
    pub download_count: Option<u64>,
    pub hearing_impaired: bool,
    pub score: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct LangMapping {
    iso2: &'static str,
    iso1: &'static str,
    label: &'static str,
    aliases: &'static [&'static str],
}

const LANG_TABLE: &[LangMapping] = &[
    LangMapping {
        iso2: "eng",
        iso1: "en",
        label: "English",
        aliases: &["en", "eng", "english"],
    },
    LangMapping {
        iso2: "ara",
        iso1: "ar",
        label: "Arabic",
        aliases: &["ar", "ara", "arb", "arabic"],
    },
    LangMapping {
        iso2: "fre",
        iso1: "fr",
        label: "French",
        aliases: &["fr", "fre", "fra", "french"],
    },
    LangMapping {
        iso2: "spa",
        iso1: "es",
        label: "Spanish",
        aliases: &["es", "spa", "spanish"],
    },
    LangMapping {
        iso2: "ger",
        iso1: "de",
        label: "German",
        aliases: &["de", "ger", "deu", "german"],
    },
    LangMapping {
        iso2: "tur",
        iso1: "tr",
        label: "Turkish",
        aliases: &["tr", "tur", "turkish"],
    },
    LangMapping {
        iso2: "por",
        iso1: "pt",
        label: "Portuguese",
        aliases: &["pt", "por", "portuguese"],
    },
    LangMapping {
        iso2: "pob",
        iso1: "pt-br",
        label: "Portuguese (BR)",
        aliases: &["pob", "pt-br", "pb"],
    },
    LangMapping {
        iso2: "ita",
        iso1: "it",
        label: "Italian",
        aliases: &["it", "ita", "italian"],
    },
    LangMapping {
        iso2: "rus",
        iso1: "ru",
        label: "Russian",
        aliases: &["ru", "rus", "russian"],
    },
    LangMapping {
        iso2: "jpn",
        iso1: "ja",
        label: "Japanese",
        aliases: &["ja", "jpn", "japanese"],
    },
    LangMapping {
        iso2: "kor",
        iso1: "ko",
        label: "Korean",
        aliases: &["ko", "kor", "korean"],
    },
    LangMapping {
        iso2: "chi",
        iso1: "zh",
        label: "Chinese",
        aliases: &["zh", "chi", "zho", "zhs", "zht", "chinese"],
    },
    LangMapping {
        iso2: "per",
        iso1: "fa",
        label: "Persian",
        aliases: &["fa", "per", "fas", "persian", "farsi"],
    },
    LangMapping {
        iso2: "nld",
        iso1: "nl",
        label: "Dutch",
        aliases: &["nl", "nld", "dut", "dutch"],
    },
    LangMapping {
        iso2: "pol",
        iso1: "pl",
        label: "Polish",
        aliases: &["pl", "pol", "polish"],
    },
    LangMapping {
        iso2: "ind",
        iso1: "id",
        label: "Indonesian",
        aliases: &["id", "ind", "indonesian"],
    },
    LangMapping {
        iso2: "hin",
        iso1: "hi",
        label: "Hindi",
        aliases: &["hi", "hin", "hindi"],
    },
    LangMapping {
        iso2: "heb",
        iso1: "he",
        label: "Hebrew",
        aliases: &["he", "heb", "iw", "hebrew"],
    },
    LangMapping {
        iso2: "ron",
        iso1: "ro",
        label: "Romanian",
        aliases: &["ro", "ron", "rum", "romanian"],
    },
    LangMapping {
        iso2: "ell",
        iso1: "el",
        label: "Greek",
        aliases: &["el", "ell", "gre", "greek"],
    },
    LangMapping {
        iso2: "swe",
        iso1: "sv",
        label: "Swedish",
        aliases: &["sv", "swe", "swedish"],
    },
    LangMapping {
        iso2: "hun",
        iso1: "hu",
        label: "Hungarian",
        aliases: &["hu", "hun", "hungarian"],
    },
    LangMapping {
        iso2: "cze",
        iso1: "cs",
        label: "Czech",
        aliases: &["cs", "cze", "ces", "czech"],
    },
    LangMapping {
        iso2: "vie",
        iso1: "vi",
        label: "Vietnamese",
        aliases: &["vi", "vie", "vietnamese"],
    },
    LangMapping {
        iso2: "ukr",
        iso1: "uk",
        label: "Ukrainian",
        aliases: &["uk", "ukr", "ukrainian"],
    },
];

pub fn normalize_subtitle_lang_code(raw: &str) -> String {
    let low = raw.trim().to_ascii_lowercase();
    if low.is_empty() || low == "all" || low == "*" {
        return "all".to_string();
    }
    let primary = low.split(['-', '_']).next().unwrap_or(&low);
    for entry in LANG_TABLE {
        if entry.aliases.contains(&low.as_str()) || entry.aliases.contains(&primary) {
            return entry.iso2.to_string();
        }
    }
    low
}

pub fn subtitle_lang_to_iso1(raw: &str) -> String {
    let low = raw.trim().to_ascii_lowercase();
    for entry in LANG_TABLE {
        if entry.iso2 == low || entry.iso1 == low || entry.aliases.contains(&low.as_str()) {
            return entry
                .iso1
                .split('-')
                .next()
                .unwrap_or(entry.iso1)
                .to_string();
        }
    }
    if low.len() >= 2 {
        low[..2].to_string()
    } else {
        low
    }
}

pub fn subtitle_lang_display_name(raw: &str) -> String {
    let norm = normalize_subtitle_lang_code(raw);
    for entry in LANG_TABLE {
        if entry.iso2 == norm {
            return entry.label.to_string();
        }
    }
    if norm == "all" {
        return "All Languages".to_string();
    }
    raw.trim().to_ascii_uppercase()
}

pub fn parse_preferred_languages(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    for part in raw.split([',', ';', '|']) {
        let norm = normalize_subtitle_lang_code(part);
        if norm == "all" {
            return Vec::new();
        }
        if !norm.is_empty() && !out.contains(&norm) {
            out.push(norm);
        }
    }
    out
}

/// Computes the canonical OpenSubtitles 64-bit file hash + file size.
pub fn compute_opensubtitles_file_hash(path: &Path) -> Result<(String, u64), String> {
    let mut file = File::open(path).map_err(|e| format!("Failed opening file for hash: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("Failed reading file size for hash: {e}"))?;
    let size = meta.len();
    if size < OPENSUBTITLES_MIN_FILE_BYTES {
        return Err("File is smaller than 128 KiB minimum for OpenSubtitles hash.".to_string());
    }

    let mut head = vec![0u8; OPENSUBTITLES_HASH_CHUNK];
    file.read_exact(&mut head)
        .map_err(|e| format!("Failed reading head chunk for hash: {e}"))?;

    let mut tail = vec![0u8; OPENSUBTITLES_HASH_CHUNK];
    file.seek(SeekFrom::Start(size - OPENSUBTITLES_HASH_CHUNK as u64))
        .map_err(|e| format!("Failed seeking tail chunk for hash: {e}"))?;
    file.read_exact(&mut tail)
        .map_err(|e| format!("Failed reading tail chunk for hash: {e}"))?;

    let mut hash: u64 = size;
    for chunk in head.chunks_exact(8).chain(tail.chunks_exact(8)) {
        let val = u64::from_le_bytes(chunk.try_into().unwrap_or([0; 8]));
        hash = hash.wrapping_add(val);
    }
    Ok((format!("{hash:016x}"), size))
}

fn is_valid_imdb_id(token: &str) -> Option<String> {
    let t = token.trim().to_ascii_lowercase();
    if t.starts_with("tt")
        && t.len() >= 7
        && t.len() <= 12
        && t[2..].bytes().all(|b| b.is_ascii_digit())
    {
        Some(t)
    } else {
        None
    }
}

fn strip_file_extension(name: &str) -> &str {
    if let Some((stem, ext)) = name.rsplit_once('.') {
        let ext_low = ext.to_ascii_lowercase();
        if matches!(
            ext_low.as_str(),
            "mkv"
                | "mp4"
                | "avi"
                | "mov"
                | "wmv"
                | "flv"
                | "webm"
                | "m4v"
                | "ts"
                | "mpg"
                | "mpeg"
                | "srt"
                | "ass"
                | "vtt"
        ) {
            return stem;
        }
    }
    name
}

fn is_release_noise_token(low: &str) -> bool {
    matches!(
        low,
        "2160p"
            | "1080p"
            | "720p"
            | "480p"
            | "360p"
            | "4k"
            | "uhd"
            | "fhd"
            | "hd"
            | "sd"
            | "bluray"
            | "blu"
            | "ray"
            | "bdrip"
            | "brrip"
            | "webrip"
            | "web"
            | "dl"
            | "webdl"
            | "hdrip"
            | "dvdrip"
            | "dvd"
            | "hdtv"
            | "pdtv"
            | "cam"
            | "hdcam"
            | "ts"
            | "telesync"
            | "remux"
            | "repack"
            | "proper"
            | "extended"
            | "uncut"
            | "unrated"
            | "theatrical"
            | "x264"
            | "x265"
            | "h264"
            | "h265"
            | "hevc"
            | "avc"
            | "av1"
            | "xvid"
            | "divx"
            | "10bit"
            | "8bit"
            | "hdr"
            | "hdr10"
            | "hdr10plus"
            | "dv"
            | "dolby"
            | "vision"
            | "atmos"
            | "truehd"
            | "dts"
            | "ddp5"
            | "dd5"
            | "ddp"
            | "ac3"
            | "eac3"
            | "aac"
            | "flac"
            | "mp3"
            | "opus"
            | "5"
            | "1"
            | "7"
            | "2"
            | "ch"
            | "6ch"
            | "2ch"
            | "multi"
            | "dual"
            | "dubbed"
            | "subbed"
            | "eng"
            | "ara"
            | "arabic"
            | "english"
            | "yts"
            | "yify"
            | "rarbg"
            | "etrg"
            | "sparks"
            | "geckos"
            | "tigole"
            | "qxr"
            | "subsplease"
            | "erai"
            | "raws"
            | "horriblesubs"
            | "psa"
            | "galaxy"
            | "galaxyrg"
            | "amzn"
            | "nf"
            | "netflix"
            | "dsnp"
            | "hmax"
            | "atvp"
            | "pcok"
            | "hulu"
    )
}

fn parse_season_episode_token(tok: &str) -> Option<(u32, u32)> {
    let low = tok.trim().to_ascii_lowercase();
    if let Some(rest) = low.strip_prefix('s') {
        if let Some((s_str, e_part)) = rest.split_once('e') {
            let e_digits: String = e_part.chars().take_while(|c| c.is_ascii_digit()).collect();
            if !s_str.is_empty()
                && s_str.bytes().all(|b| b.is_ascii_digit())
                && !e_digits.is_empty()
            {
                if let (Ok(s), Ok(e)) = (s_str.parse::<u32>(), e_digits.parse::<u32>()) {
                    if s <= 99 && e <= 999 {
                        return Some((s, e));
                    }
                }
            }
        }
    }
    if let Some((s_str, e_str)) = low.split_once('x') {
        if !s_str.is_empty()
            && !e_str.is_empty()
            && s_str.bytes().all(|b| b.is_ascii_digit())
            && e_str.bytes().all(|b| b.is_ascii_digit())
        {
            if let (Ok(s), Ok(e)) = (s_str.parse::<u32>(), e_str.parse::<u32>()) {
                if (1..=99).contains(&s) && e <= 999 {
                    return Some((s, e));
                }
            }
        }
    }
    None
}

fn strip_bracketed_segments(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth_sq = 0usize;
    let mut depth_paren = 0usize;
    let chars: Vec<char> = input.chars().collect();
    let mut i = 0usize;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '[' {
            depth_sq += 1;
            i += 1;
            continue;
        }
        if ch == ']' && depth_sq > 0 {
            depth_sq -= 1;
            out.push(' ');
            i += 1;
            continue;
        }
        if depth_sq > 0 {
            i += 1;
            continue;
        }
        if ch == '(' {
            // Preserve year like (2010), strip other parenthetical tags like (1080p)
            if let Some(close_rel) = chars[i + 1..].iter().position(|&c| c == ')') {
                let inner: String = chars[i + 1..i + 1 + close_rel].iter().collect();
                let inner_trim = inner.trim();
                if inner_trim.len() == 4
                    && inner_trim.bytes().all(|b| b.is_ascii_digit())
                    && (1920..=2099).contains(&inner_trim.parse::<u32>().unwrap_or(0))
                {
                    out.push(' ');
                    out.push_str(inner_trim);
                    out.push(' ');
                    i += close_rel + 2;
                    continue;
                }
            }
            depth_paren += 1;
            i += 1;
            continue;
        }
        if ch == ')' && depth_paren > 0 {
            depth_paren -= 1;
            out.push(' ');
            i += 1;
            continue;
        }
        if depth_paren > 0 {
            i += 1;
            continue;
        }
        out.push(ch);
        i += 1;
    }
    out
}

/// Extracts clean media title, optional release year, season/episode, or direct IMDb ID
/// from a video filename or manual user query.
pub fn parse_media_filename(raw_input: &str) -> ParsedMediaQuery {
    let trimmed = raw_input.trim();
    if let Some(imdb) = is_valid_imdb_id(trimmed) {
        return ParsedMediaQuery {
            title: imdb.clone(),
            year: None,
            season: None,
            episode: None,
            is_series: false,
            direct_imdb_id: Some(imdb),
        };
    }

    let base_name = trimmed.rsplit(['/', '\\']).next().unwrap_or(trimmed);
    let stem = strip_file_extension(base_name);
    let cleaned_brackets = strip_bracketed_segments(stem);

    let mut spaced = String::with_capacity(cleaned_brackets.len());
    for ch in cleaned_brackets.chars() {
        if matches!(ch, '.' | '_' | '|') {
            spaced.push(' ');
        } else {
            spaced.push(ch);
        }
    }

    let tokens: Vec<&str> = spaced.split_whitespace().collect();
    let mut title_tokens: Vec<String> = Vec::new();
    let mut year: Option<u32> = None;
    let mut season: Option<u32> = None;
    let mut episode: Option<u32> = None;
    let mut direct_imdb_id: Option<String> = None;

    let mut idx = 0usize;
    while idx < tokens.len() {
        let raw_tok = tokens[idx];
        let tok = raw_tok.trim_matches(|c: char| !c.is_alphanumeric() && c != '-');
        let low = tok.to_ascii_lowercase();

        if let Some(imdb) = is_valid_imdb_id(&low) {
            direct_imdb_id = Some(imdb);
            idx += 1;
            continue;
        }

        if let Some((s, e)) = parse_season_episode_token(&low) {
            season = Some(s);
            episode = Some(e);
            break;
        }

        // Anime pattern: "Title - 12" (bare dash followed by 1..3 digit episode number)
        if raw_tok == "-" && !title_tokens.is_empty() && idx + 1 < tokens.len() {
            let next_clean = tokens[idx + 1].trim_matches(|c: char| !c.is_ascii_digit());
            if (1..=3).contains(&next_clean.len()) {
                if let Ok(ep) = next_clean.parse::<u32>() {
                    if ep > 0 && ep < 2000 {
                        season = Some(1);
                        episode = Some(ep);
                        break;
                    }
                }
            }
        }

        if low.len() == 4 && low.bytes().all(|b| b.is_ascii_digit()) {
            if let Ok(y) = low.parse::<u32>() {
                if (1920..=2099).contains(&y) && !title_tokens.is_empty() {
                    year = Some(y);
                    break;
                }
            }
        }

        if is_release_noise_token(&low) {
            if !title_tokens.is_empty() {
                break;
            }
            idx += 1;
            continue;
        }

        if raw_tok == "-" && !title_tokens.is_empty() {
            // Allow hyphen inside titles (e.g., "Spider-Man") unless followed by noise/episode
            if idx + 1 < tokens.len()
                && is_release_noise_token(&tokens[idx + 1].to_ascii_lowercase())
            {
                break;
            }
            idx += 1;
            continue;
        }

        if !tok.is_empty() {
            title_tokens.push(tok.to_string());
        }
        idx += 1;
    }

    let title = if title_tokens.is_empty() {
        stem.replace(['.', '_'], " ").trim().to_string()
    } else {
        title_tokens.join(" ")
    };

    ParsedMediaQuery {
        title,
        year,
        season,
        episode,
        is_series: season.is_some() || episode.is_some(),
        direct_imdb_id,
    }
}

fn title_similarity_score(candidate: &str, query: &str) -> i32 {
    let norm = |s: &str| -> Vec<String> {
        s.to_ascii_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| !w.is_empty())
            .map(ToString::to_string)
            .collect()
    };
    let q_words = norm(query);
    let c_words = norm(candidate);
    if q_words.is_empty() || c_words.is_empty() {
        return 0;
    }
    if q_words == c_words {
        return 500;
    }
    let mut hits = 0i32;
    for qw in &q_words {
        if c_words.contains(qw) {
            hits += 1;
        }
    }
    let prefix_bonus = if c_words.starts_with(&q_words) {
        120
    } else {
        0
    };
    let extra_penalty = ((c_words.len() as i32 - q_words.len() as i32).abs()) * 15;
    (hits * 90) + prefix_bonus - extra_penalty
}

#[derive(Debug, Deserialize)]
struct CinemetaCatalogResponse {
    #[serde(default)]
    metas: Vec<CinemetaMetaItem>,
}

#[derive(Debug, Deserialize)]
struct CinemetaMetaItem {
    id: Option<String>,
    imdb_id: Option<String>,
    #[serde(rename = "type")]
    media_type: Option<String>,
    name: Option<String>,
    #[serde(rename = "releaseInfo")]
    release_info: Option<String>,
}

fn parse_first_year(raw: Option<&str>) -> Option<u32> {
    let text = raw?;
    for part in text.split(|c: char| !c.is_ascii_digit()) {
        if part.len() == 4 {
            if let Ok(y) = part.parse::<u32>() {
                if (1900..=2099).contains(&y) {
                    return Some(y);
                }
            }
        }
    }
    None
}

pub fn parse_cinemeta_search_results(
    json_str: &str,
    default_media_type: &str,
    parsed: &ParsedMediaQuery,
) -> Vec<ImdbMatch> {
    let Ok(resp) = serde_json::from_str::<CinemetaCatalogResponse>(json_str) else {
        return Vec::new();
    };
    let mut matches: Vec<ImdbMatch> = Vec::new();
    for (idx, meta) in resp.metas.into_iter().take(12).enumerate() {
        let imdb = meta.imdb_id.or(meta.id).and_then(|s| is_valid_imdb_id(&s));
        let Some(imdb_id) = imdb else { continue };
        let Some(name) = meta
            .name
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let mtype = meta
            .media_type
            .unwrap_or_else(|| default_media_type.to_string());
        let year = parse_first_year(meta.release_info.as_deref());
        let mut score = title_similarity_score(&name, &parsed.title);
        if parsed.is_series && mtype == "series" {
            score += 180;
        } else if !parsed.is_series && mtype == "movie" {
            score += 90;
        }
        if let (Some(qy), Some(cy)) = (parsed.year, year) {
            if qy == cy {
                score += 220;
            } else if qy.abs_diff(cy) == 1 {
                score += 80;
            } else {
                score -= 90;
            }
        }
        score -= (idx as i32) * 8;
        matches.push(ImdbMatch {
            imdb_id,
            title: name,
            media_type: mtype,
            year,
            score,
        });
    }
    matches.sort_by_key(|b| std::cmp::Reverse(b.score));
    matches
}

#[derive(Debug, Deserialize)]
struct ImdbSuggestionResponse {
    #[serde(default)]
    d: Vec<ImdbSuggestionItem>,
}

#[derive(Debug, Deserialize)]
struct ImdbSuggestionItem {
    id: Option<String>,
    l: Option<String>,
    qid: Option<String>,
    y: Option<u32>,
}

pub fn parse_imdb_suggestion_results(json_str: &str, parsed: &ParsedMediaQuery) -> Vec<ImdbMatch> {
    let Ok(resp) = serde_json::from_str::<ImdbSuggestionResponse>(json_str) else {
        return Vec::new();
    };
    let mut matches = Vec::new();
    for (idx, item) in resp.d.into_iter().take(12).enumerate() {
        let Some(imdb_id) = item.id.as_deref().and_then(is_valid_imdb_id) else {
            continue;
        };
        let Some(title) = item
            .l
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let qid = item.qid.unwrap_or_default().to_ascii_lowercase();
        let media_type = match qid.as_str() {
            "tvseries" | "tvminiseries" | "tvspecial" => "series".to_string(),
            "movie" | "tvmovie" | "short" | "video" => "movie".to_string(),
            _ => continue,
        };
        let mut score = title_similarity_score(&title, &parsed.title);
        if parsed.is_series && media_type == "series" {
            score += 180;
        } else if !parsed.is_series && media_type == "movie" {
            score += 90;
        }
        if let (Some(qy), Some(cy)) = (parsed.year, item.y) {
            if qy == cy {
                score += 220;
            } else if qy.abs_diff(cy) == 1 {
                score += 80;
            } else {
                score -= 90;
            }
        }
        score -= (idx as i32) * 8;
        matches.push(ImdbMatch {
            imdb_id,
            title,
            media_type,
            year: item.y,
            score,
        });
    }
    matches.sort_by_key(|b| std::cmp::Reverse(b.score));
    matches
}

#[derive(Debug, Deserialize)]
struct StremioSubtitlesResponse {
    #[serde(default)]
    subtitles: Vec<StremioSubtitleItem>,
}

#[derive(Debug, Deserialize)]
struct StremioSubtitleItem {
    id: Option<String>,
    url: Option<String>,
    #[serde(rename = "SubEncoding")]
    sub_encoding: Option<String>,
    lang: Option<String>,
    m: Option<String>,
    #[serde(rename = "subtitleFileName")]
    subtitle_file_name: Option<String>,
    #[serde(rename = "movieReleaseName")]
    movie_release_name: Option<String>,
    #[serde(rename = "releaseGroup")]
    release_group: Option<String>,
    #[serde(rename = "fpsMilli")]
    fps_milli: Option<u64>,
    #[serde(default)]
    hearing_impaired: Option<bool>,
}

fn release_similarity_bonus(release_a: &str, release_b: &str) -> i32 {
    let tokenize = |s: &str| -> HashSet<String> {
        strip_file_extension(s)
            .to_ascii_lowercase()
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() >= 2)
            .map(ToString::to_string)
            .collect()
    };
    let set_a = tokenize(release_a);
    let set_b = tokenize(release_b);
    if set_a.is_empty() || set_b.is_empty() {
        return 0;
    }
    let mut score = 0i32;
    for tok in set_a.intersection(&set_b) {
        if matches!(
            tok.as_str(),
            "bluray"
                | "web"
                | "webdl"
                | "webrip"
                | "bdrip"
                | "brrip"
                | "hdtv"
                | "remux"
                | "yify"
                | "yts"
                | "rarbg"
                | "sparks"
                | "geckos"
                | "subsplease"
                | "erai"
                | "x264"
                | "x265"
                | "hevc"
                | "1080p"
                | "720p"
                | "2160p"
                | "4k"
        ) {
            score += 90;
        } else {
            score += 45;
        }
    }
    score.min(600)
}

#[allow(clippy::too_many_arguments)]
fn score_candidate(
    lang: &str,
    match_kind: &str,
    release_name: &str,
    file_name: &str,
    hearing_impaired: bool,
    download_count: Option<u64>,
    video_name: Option<&str>,
    preferred_langs: &[String],
) -> i32 {
    let mut score = 0i32;
    match match_kind {
        "hash" => score += 2000,
        "release" => score += 450,
        "imdb" => score += 200,
        _ => score += 100,
    }
    if let Some(pos) = preferred_langs.iter().position(|p| p == lang) {
        score += 1000 - (pos as i32 * 200);
    }
    if let Some(vname) = video_name {
        let combined = format!("{release_name} {file_name}");
        score += release_similarity_bonus(&combined, vname);
    }
    if !hearing_impaired {
        score += 15;
    }
    if let Some(dl) = download_count {
        score += ((dl / 400).min(45)) as i32;
    }
    score
}

pub fn parse_stremio_subtitles_response(
    json_str: &str,
    video_name: Option<&str>,
    preferred_langs: &[String],
) -> Vec<SubtitleSearchCandidate> {
    let Ok(resp) = serde_json::from_str::<StremioSubtitlesResponse>(json_str) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for raw in resp.subtitles {
        let Some(url) = raw
            .url
            .map(|u| u.trim().to_string())
            .filter(|u| u.starts_with("https://"))
        else {
            continue;
        };
        let lang = normalize_subtitle_lang_code(raw.lang.as_deref().unwrap_or("eng"));
        if !preferred_langs.is_empty() && !preferred_langs.contains(&lang) {
            continue;
        }
        let file_name = raw
            .subtitle_file_name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("subtitle.{lang}.srt"));
        let release_name = raw
            .movie_release_name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| {
                let stem = strip_file_extension(&file_name);
                if let Some(ref grp) = raw.release_group {
                    if !grp.trim().is_empty() && !stem.contains(grp.trim()) {
                        return format!("{stem} [{}]", grp.trim());
                    }
                }
                stem.to_string()
            });
        let match_kind = if raw.m.as_deref() == Some("h") {
            "hash".to_string()
        } else if video_name.is_some()
            && release_similarity_bonus(&release_name, video_name.unwrap_or("")) >= 90
        {
            "release".to_string()
        } else {
            "imdb".to_string()
        };
        let hi = raw.hearing_impaired.unwrap_or_else(|| {
            let low = format!("{release_name} {file_name}").to_ascii_lowercase();
            low.contains(".hi.")
                || low.contains("_hi")
                || low.contains("[hi]")
                || low.contains("sdh")
        });
        let fps = raw
            .fps_milli
            .filter(|&f| (15_000..=120_000).contains(&f))
            .map(|f| (f as f64) / 1000.0);
        let id = raw
            .id
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| url.clone());
        let score = score_candidate(
            &lang,
            &match_kind,
            &release_name,
            &file_name,
            hi,
            None,
            video_name,
            preferred_langs,
        );
        items.push(SubtitleSearchCandidate {
            id,
            provider: "opensubtitles-v3".to_string(),
            language_label: subtitle_lang_display_name(&lang),
            language: lang,
            release_name,
            file_name,
            download_url: Some(url),
            file_id: None,
            match_kind,
            fps,
            encoding: raw.sub_encoding,
            download_count: None,
            hearing_impaired: hi,
            score,
        });
    }
    rank_and_filter_candidates(items, preferred_langs)
}

#[derive(Debug, Deserialize)]
struct OsV1SearchResponse {
    #[serde(default)]
    data: Vec<OsV1Item>,
}

#[derive(Debug, Deserialize)]
struct OsV1Item {
    id: Option<String>,
    attributes: Option<OsV1Attributes>,
}

#[derive(Debug, Deserialize)]
struct OsV1Attributes {
    language: Option<String>,
    download_count: Option<u64>,
    hearing_impaired: Option<bool>,
    moviehash_match: Option<bool>,
    fps: Option<f64>,
    release: Option<String>,
    #[serde(default)]
    files: Vec<SubtitleFileRef>,
}

pub fn parse_opensubtitles_v1_response(
    json_str: &str,
    video_name: Option<&str>,
    preferred_langs: &[String],
) -> Vec<SubtitleSearchCandidate> {
    let Ok(resp) = serde_json::from_str::<OsV1SearchResponse>(json_str) else {
        return Vec::new();
    };
    let mut items = Vec::new();
    for raw in resp.data {
        let Some(attrs) = raw.attributes else {
            continue;
        };
        let Some(file) = attrs.files.first() else {
            continue;
        };
        let lang = normalize_subtitle_lang_code(attrs.language.as_deref().unwrap_or("en"));
        if !preferred_langs.is_empty() && !preferred_langs.contains(&lang) {
            continue;
        }
        let file_name = file
            .file_name
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| format!("subtitle.{lang}.srt"));
        let release_name = attrs
            .release
            .clone()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| strip_file_extension(&file_name).to_string());
        let match_kind = if attrs.moviehash_match.unwrap_or(false) {
            "hash".to_string()
        } else if video_name.is_some()
            && release_similarity_bonus(&release_name, video_name.unwrap_or("")) >= 90
        {
            "release".to_string()
        } else {
            "query".to_string()
        };
        let hi = attrs.hearing_impaired.unwrap_or(false);
        let score = score_candidate(
            &lang,
            &match_kind,
            &release_name,
            &file_name,
            hi,
            attrs.download_count,
            video_name,
            preferred_langs,
        );
        items.push(SubtitleSearchCandidate {
            id: format!("os1-{}", raw.id.unwrap_or_else(|| file.file_id.to_string())),
            provider: "opensubtitles-api".to_string(),
            language_label: subtitle_lang_display_name(&lang),
            language: lang,
            release_name,
            file_name,
            download_url: None,
            file_id: Some(file.file_id),
            match_kind,
            fps: attrs.fps,
            encoding: Some("UTF-8".to_string()),
            download_count: attrs.download_count,
            hearing_impaired: hi,
            score,
        });
    }
    rank_and_filter_candidates(items, preferred_langs)
}

pub fn rank_and_filter_candidates(
    mut items: Vec<SubtitleSearchCandidate>,
    preferred_langs: &[String],
) -> Vec<SubtitleSearchCandidate> {
    if !preferred_langs.is_empty() {
        items.retain(|it| preferred_langs.contains(&it.language));
    }
    items.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.release_name.cmp(&b.release_name))
    });
    let mut seen_urls = HashSet::new();
    let mut seen_file_ids = HashSet::new();
    items.retain(|it| {
        if let Some(ref url) = it.download_url {
            return seen_urls.insert(url.clone());
        }
        if let Some(fid) = it.file_id {
            return seen_file_ids.insert(fid);
        }
        true
    });
    items
}

pub fn sanitize_subtitle_download_bytes(bytes: &[u8]) -> Result<Vec<u8>, String> {
    if bytes.is_empty() {
        return Err("Downloaded subtitle file was empty.".to_string());
    }
    if bytes.len() as u64 > MAX_SUBTITLE_ARCHIVE_BYTES {
        return Err("Downloaded subtitle file exceeded safety limit.".to_string());
    }
    if bytes.starts_with(b"PK\x03\x04") {
        return Err(
            "ZIP-packaged subtitle payload is not supported from this endpoint.".to_string(),
        );
    }
    let text = decode_subtitle_bytes(bytes)
        .map_err(|e| format!("Failed decoding downloaded subtitle text: {e}"))?;
    let trimmed = text.trim();
    if trimmed.len() < 8 {
        return Err("Downloaded subtitle did not contain valid cues.".to_string());
    }
    let head_low = trimmed
        .chars()
        .take(256)
        .collect::<String>()
        .to_ascii_lowercase();
    if head_low.starts_with("<!doctype html") || head_low.starts_with("<html") {
        return Err(
            "Subtitle provider returned an HTML error page instead of a subtitle file.".to_string(),
        );
    }
    Ok(text.into_bytes())
}

pub fn build_cached_subtitle_filename(
    video_name: Option<&str>,
    preferred_name: Option<&str>,
    language: Option<&str>,
    unique_tag: &str,
) -> String {
    let ext = preferred_name
        .and_then(|n| n.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()))
        .filter(|e| ALLOWED_SUB_EXTS.contains(&e.as_str()))
        .unwrap_or_else(|| "srt".to_string());

    let raw_stem = preferred_name
        .map(strip_file_extension)
        .or_else(|| video_name.map(strip_file_extension))
        .unwrap_or("subtitle");

    let mut clean_stem: String = raw_stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    clean_stem = clean_stem.trim_matches([' ', '.', '_']).to_string();
    if clean_stem.is_empty() {
        clean_stem = "subtitle".to_string();
    }
    if clean_stem.len() > 72 {
        clean_stem.truncate(72);
        clean_stem = clean_stem.trim_end_matches([' ', '.', '_']).to_string();
    }

    let lang = normalize_subtitle_lang_code(language.unwrap_or("und"));
    let clean_tag: String = unique_tag
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(12)
        .collect();
    if clean_tag.is_empty() {
        format!("{clean_stem}.{lang}.{ext}")
    } else {
        format!("{clean_stem}.{lang}.{clean_tag}.{ext}")
    }
}

pub fn short_subtitle_cache_tag(video_path: Option<&str>, url_or_id: &str) -> String {
    let mut hasher = Sha256::new();
    if let Some(vp) = video_path {
        hasher.update(vp.to_ascii_lowercase().as_bytes());
    }
    hasher.update(b"|");
    hasher.update(url_or_id.as_bytes());
    hasher
        .finalize()
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_archive_entry_guard_blocks_zip_slip_and_executables() {
        assert!(validate_archive_entry_path("movie.ar.srt", 4096).is_ok());
        assert!(validate_archive_entry_path("subs/episode.ASS", 4096).is_ok());
        assert!(matches!(
            validate_archive_entry_path("../../evil.srt", 100),
            Err(OpenSubtitlesError::UnsafeArchivePath(_))
        ));
        assert!(matches!(
            validate_archive_entry_path("C:\\Windows\\evil.srt", 100),
            Err(OpenSubtitlesError::UnsafeArchivePath(_))
        ));
        assert!(matches!(
            validate_archive_entry_path("payload.exe", 100),
            Err(OpenSubtitlesError::UnsupportedExtension(_))
        ));
        assert_eq!(
            validate_archive_entry_path("huge.srt", MAX_SUBTITLE_ARCHIVE_BYTES + 1),
            Err(OpenSubtitlesError::PayloadTooLarge)
        );
    }

    #[test]
    fn test_query_builder() {
        let qs = build_search_query_string(&SearchParams {
            moviehash: Some("0123456789abcdef".into()),
            moviebytesize: Some(1_234_567),
            languages: Some("ar,en".into()),
            query: Some("My Movie".into()),
        });
        assert_eq!(
            qs,
            "moviehash=0123456789abcdef&moviebytesize=1234567&languages=ar,en&query=My%20Movie"
        );
    }

    #[test]
    fn test_parse_media_filename_extracts_movies_series_and_anime() {
        let m = parse_media_filename("D:\\Movies\\Inception.2010.1080p.BluRay.x264-YIFY.mkv");
        assert_eq!(m.title, "Inception");
        assert_eq!(m.year, Some(2010));
        assert!(!m.is_series);

        let s = parse_media_filename("Breaking.Bad.S02E05.Breakage.720p.WEB-DL.mkv");
        assert_eq!(s.title, "Breaking Bad");
        assert_eq!(s.season, Some(2));
        assert_eq!(s.episode, Some(5));
        assert!(s.is_series);

        let a = parse_media_filename("[SubsPlease] Frieren - 12 (1080p) [ABCD1234].mkv");
        assert_eq!(a.title, "Frieren");
        assert_eq!(a.season, Some(1));
        assert_eq!(a.episode, Some(12));
        assert!(a.is_series);

        let imdb = parse_media_filename("tt1375666");
        assert_eq!(imdb.direct_imdb_id.as_deref(), Some("tt1375666"));
    }

    #[test]
    fn test_compute_opensubtitles_file_hash_deterministic() {
        let uniq = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let tmp = std::env::temp_dir().join(format!("ep-os-hash-{uniq}.bin"));
        let buf = vec![0x01u8; 256 * 1024];
        std::fs::write(&tmp, &buf).unwrap();
        let (hash, size) = compute_opensubtitles_file_hash(&tmp).unwrap();
        assert_eq!(size, 256 * 1024);
        assert_eq!(hash.len(), 16);
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn test_parse_stremio_subtitles_ranks_hash_and_release_matches() {
        let sample = r#"{
          "subtitles": [
            {
              "id": "1",
              "url": "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/111",
              "lang": "eng",
              "m": "i",
              "subtitleFileName": "Inception.2010.CAM.srt",
              "movieReleaseName": "Inception.2010.CAM"
            },
            {
              "id": "2",
              "url": "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/222",
              "lang": "ara",
              "m": "h",
              "subtitleFileName": "Inception.2010.1080p.BluRay.x264.ara.srt",
              "movieReleaseName": "Inception.2010.1080p.BluRay.x264"
            },
            {
              "id": "3",
              "url": "https://subs5.strem.io/en/download/subencoding-stremio-utf8/src-api/file/333",
              "lang": "eng",
              "m": "i",
              "subtitleFileName": "Inception.2010.1080p.BluRay.YIFY.srt",
              "movieReleaseName": "Inception.2010.1080p.BluRay.YIFY"
            }
          ]
        }"#;
        let preferred = parse_preferred_languages("ara,eng");
        let ranked = parse_stremio_subtitles_response(
            sample,
            Some("Inception.2010.1080p.BluRay.YIFY.mkv"),
            &preferred,
        );
        assert_eq!(ranked.len(), 3);
        assert_eq!(ranked[0].id, "2");
        assert_eq!(ranked[0].match_kind, "hash");
        assert_eq!(ranked[1].id, "3");
    }

    #[test]
    fn test_sanitize_subtitle_download_rejects_html_and_normalizes_text() {
        assert!(sanitize_subtitle_download_bytes(b"<!DOCTYPE html><html>error</html>").is_err());
        let ok = sanitize_subtitle_download_bytes(b"1\r\n00:00:01,000 --> 00:00:02,000\r\nHello")
            .unwrap();
        assert!(String::from_utf8(ok).unwrap().contains("Hello"));
    }
}
