use crate::playlist::{parse_episode_code, strip_known_media_ext, EpisodeCode};
use serde::{Deserialize, Serialize};

pub const DURATION_TOLERANCE_SECS: f64 = 2.5;
const MAX_PLAUSIBLE_CUT_DIFF_SECS: f64 = 300.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub name: String,
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub size_hash: Option<String>,
    pub duration_secs: Option<f64>,
    pub is_hashed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileMatchStatus {
    Matched,
    SameLengthDifferentEncode,
    DurationMismatch,
    DifferentFile,
    NoFile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SourceRelation {
    Exact,
    DifferentEncode,
    DifferentCut,
    FpsMismatch,
    DifferentMedia,
    Missing,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileComparison {
    pub status: FileMatchStatus,
    pub source_relation: SourceRelation,
    pub same_media_by_name: bool,
    pub duration_delta_secs: Option<f64>,
    pub suggested_fps_scale: Option<f64>,
    pub suggested_fps_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedMediaIdentity {
    pub title: String,
    pub year: Option<u32>,
    pub episode: Option<EpisodeCode>,
}

const RELEASE_TAIL_TOKENS: &[&str] = &[
    "2160p",
    "1440p",
    "1080p",
    "720p",
    "576p",
    "480p",
    "360p",
    "4k",
    "uhd",
    "bluray",
    "bdrip",
    "brrip",
    "bdremux",
    "remux",
    "webdl",
    "webrip",
    "web",
    "hdtv",
    "pdtv",
    "dvdrip",
    "hdrip",
    "hdcam",
    "camrip",
    "x264",
    "x265",
    "h264",
    "h265",
    "avc",
    "hevc",
    "av1",
    "vp9",
    "xvid",
    "divx",
    "10bit",
    "8bit",
    "hdr",
    "hdr10",
    "hdr10plus",
    "dovi",
    "sdr",
    "aac",
    "aac2",
    "eac3",
    "ac3",
    "ddp",
    "ddp5",
    "dd5",
    "dts",
    "dtshd",
    "truehd",
    "atmos",
    "flac",
    "mp3",
    "opus",
    "proper",
    "repack",
    "rerip",
    "internal",
    "extended",
    "theatrical",
    "unrated",
    "remastered",
    "uncut",
    "directors",
    "dual",
    "multi",
    "dubbed",
    "subbed",
    "amzn",
    "nf",
    "atvp",
    "dsnp",
    "hmax",
    "hulu",
    "pcok",
    "yts",
    "yify",
    "rarbg",
    "psa",
    "pahe",
    "tgx",
    "galaxyrg",
];

fn strip_media_ext(raw: &str) -> &str {
    strip_known_media_ext(raw)
}

fn strip_square_brackets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut depth = 0usize;
    for ch in input.chars() {
        match ch {
            '[' => depth += 1,
            ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

fn is_episode_marker_token(
    tok: &str,
    next_tok: Option<&str>,
    episode: Option<EpisodeCode>,
) -> bool {
    let Some(ep) = episode else {
        return false;
    };
    if let Some(rest) = tok.strip_prefix('s') {
        if let Some((s_str, e_str)) = rest.split_once('e') {
            if s_str.parse::<u32>().ok() == ep.season
                && e_str.parse::<u32>().ok() == Some(ep.episode)
            {
                return true;
            }
        } else if rest.parse::<u32>().ok() == ep.season {
            if let Some(next_e) = next_tok.and_then(|n| n.strip_prefix('e')) {
                if next_e.parse::<u32>().ok() == Some(ep.episode) {
                    return true;
                }
            }
        }
    }
    if let Some((s_str, e_str)) = tok.split_once('x') {
        if s_str.parse::<u32>().ok() == ep.season && e_str.parse::<u32>().ok() == Some(ep.episode) {
            return true;
        }
    }
    if let Some(rest) = tok.strip_prefix('e') {
        if rest.parse::<u32>().ok() == Some(ep.episode) {
            return true;
        }
    }
    if let Ok(num) = tok.parse::<u32>() {
        if num == ep.episode && ep.season.is_none() {
            return true;
        }
    }
    false
}

pub fn normalize_media_identity(raw_name: &str) -> NormalizedMediaIdentity {
    let episode = parse_episode_code(raw_name);
    let stem = strip_media_ext(raw_name);
    let no_brackets = strip_square_brackets(stem);
    let mut normalized = no_brackets.to_ascii_lowercase();
    for (pat, rep) in [
        ("blu-ray", "bluray"),
        ("web-dl", "webdl"),
        ("web-rip", "webrip"),
        ("h.264", "h264"),
        ("h.265", "h265"),
        ("x.264", "x264"),
        ("x.265", "x265"),
        ("dts-hd", "dtshd"),
        ("ddp5.1", "ddp5"),
        ("dd5.1", "dd5"),
        ("aac2.0", "aac2"),
        ("hdr10+", "hdr10plus"),
    ] {
        normalized = normalized.replace(pat, rep);
    }

    let raw_tokens: Vec<String> = normalized
        .split(|c: char| !c.is_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();

    let mut cut_idx = raw_tokens.len();
    for (i, tok) in raw_tokens.iter().enumerate() {
        let next_tok = raw_tokens.get(i + 1).map(String::as_str);
        if RELEASE_TAIL_TOKENS.contains(&tok.as_str())
            || is_episode_marker_token(tok, next_tok, episode)
            || ((tok == "episode" || tok == "ep" || tok == "season")
                && next_tok.is_some_and(|n| n.chars().all(|c| c.is_ascii_digit())))
        {
            cut_idx = i;
            break;
        }
    }

    let mut title_tokens: Vec<String> = raw_tokens[..cut_idx].to_vec();
    let mut year: Option<u32> = None;
    if title_tokens.len() >= 2 {
        if let Some(last) = title_tokens.last() {
            if last.len() == 4 {
                if let Ok(y) = last.parse::<u32>() {
                    if (1920..=2039).contains(&y) {
                        year = Some(y);
                        title_tokens.pop();
                    }
                }
            }
        }
    }

    if year.is_none() {
        for tok in &raw_tokens[cut_idx..] {
            if tok.len() == 4 {
                if let Ok(y) = tok.parse::<u32>() {
                    if (1920..=2039).contains(&y) {
                        year = Some(y);
                        break;
                    }
                }
            }
        }
    }

    NormalizedMediaIdentity {
        title: title_tokens.join(" "),
        year,
        episode,
    }
}

fn titles_compatible(a: &NormalizedMediaIdentity, b: &NormalizedMediaIdentity) -> (bool, bool) {
    if let (Some(ea), Some(eb)) = (a.episode, b.episode) {
        let season_conflict = matches!((ea.season, eb.season), (Some(sa), Some(sb)) if sa != sb);
        if ea.episode != eb.episode || season_conflict {
            return (false, true);
        }
        if a.title.is_empty() || b.title.is_empty() || a.title == b.title {
            return (true, false);
        }
        if a.title.starts_with(&b.title) || b.title.starts_with(&a.title) {
            return (true, false);
        }
        return (false, true);
    }

    if a.episode.is_some() != b.episode.is_some() {
        return (false, false);
    }

    if let (Some(ya), Some(yb)) = (a.year, b.year) {
        if ya != yb && !a.title.is_empty() && a.title == b.title {
            return (false, true);
        }
    }

    if !a.title.is_empty() && !b.title.is_empty() && a.title == b.title {
        return (true, false);
    }

    (false, false)
}

pub(crate) fn detect_fps_suggestion(local_dur: f64, peer_dur: f64) -> Option<(f64, &'static str)> {
    if !local_dur.is_finite()
        || !peer_dur.is_finite()
        || local_dur < 120.0
        || peer_dur < 120.0
        || (local_dur - peer_dur).abs() <= DURATION_TOLERANCE_SECS
    {
        return None;
    }

    let ntsc_film = 24_000.0 / 1001.0;
    let ratio = local_dur / peer_dur;

    // Only auto-suggest the unmistakable ~4.2% PAL/NTSC speedup ratios; 0.1% (24 vs 23.976)
    // is indistinguishable from a 5-10s intro logo from duration alone.
    let pal_candidates = [
        (ntsc_film / 25.0, "25 → 23.976 fps"),
        (25.0 / ntsc_film, "23.976 → 25 fps"),
        (24.0 / 25.0, "25 → 24 fps"),
        (25.0 / 24.0, "24 → 25 fps"),
    ];
    let mut best: Option<(f64, f64, &'static str)> = None;
    for (scale, label) in pal_candidates {
        let dist = (ratio - scale).abs();
        if dist <= 0.005 && best.is_none_or(|(best_dist, _, _)| dist < best_dist) {
            best = Some((dist, scale, label));
        }
    }
    best.map(|(_, scale, label)| (scale, label))
}

pub fn analyze_files(local: Option<&FileIdentity>, peer: Option<&FileIdentity>) -> FileComparison {
    let (Some(l), Some(p)) = (local, peer) else {
        return FileComparison {
            status: FileMatchStatus::NoFile,
            source_relation: SourceRelation::Missing,
            same_media_by_name: false,
            duration_delta_secs: None,
            suggested_fps_scale: None,
            suggested_fps_label: None,
        };
    };

    let (same_media_by_name, explicit_conflict) = if !l.is_hashed && !p.is_hashed {
        let nl = normalize_media_identity(&l.name);
        let np = normalize_media_identity(&p.name);
        titles_compatible(&nl, &np)
    } else {
        (false, false)
    };

    let durations = match (l.duration_secs, p.duration_secs) {
        (Some(ld), Some(pd)) if ld.is_finite() && pd.is_finite() && ld > 0.0 && pd > 0.0 => {
            Some((ld, pd, ld - pd))
        }
        _ => None,
    };
    let duration_delta_secs = durations.map(|(_, _, d)| d);

    if let Some((ld, pd, delta)) = durations {
        if delta.abs() > DURATION_TOLERANCE_SECS {
            if explicit_conflict {
                return FileComparison {
                    status: FileMatchStatus::DifferentFile,
                    source_relation: SourceRelation::DifferentMedia,
                    same_media_by_name: false,
                    duration_delta_secs,
                    suggested_fps_scale: None,
                    suggested_fps_label: None,
                };
            }

            if let Some((scale, label)) = detect_fps_suggestion(ld, pd) {
                return FileComparison {
                    status: FileMatchStatus::DurationMismatch,
                    source_relation: SourceRelation::FpsMismatch,
                    same_media_by_name,
                    duration_delta_secs,
                    suggested_fps_scale: Some(scale),
                    suggested_fps_label: Some(label.to_string()),
                };
            }

            let plausible_cut = same_media_by_name
                || delta.abs() <= MAX_PLAUSIBLE_CUT_DIFF_SECS
                || (delta.abs() / ld.max(pd) <= 0.10);

            return FileComparison {
                status: FileMatchStatus::DurationMismatch,
                source_relation: if plausible_cut {
                    SourceRelation::DifferentCut
                } else {
                    SourceRelation::DifferentMedia
                },
                same_media_by_name,
                duration_delta_secs,
                suggested_fps_scale: None,
                suggested_fps_label: None,
            };
        }
    }

    let size_matches = match (l.size_bytes, p.size_bytes) {
        (Some(ls), Some(ps)) => ls == ps,
        _ => match (l.size_hash.as_deref(), p.size_hash.as_deref()) {
            (Some(lh), Some(ph)) if !lh.is_empty() => lh.eq_ignore_ascii_case(ph),
            _ => match (l.size_bytes, p.size_hash.as_deref()) {
                (Some(ls), Some(ph)) if !ph.is_empty() => {
                    crate::syncplay::hash_filesize(ls).eq_ignore_ascii_case(ph)
                }
                _ => match (l.size_hash.as_deref(), p.size_bytes) {
                    (Some(lh), Some(ps)) if !lh.is_empty() => {
                        lh.eq_ignore_ascii_case(&crate::syncplay::hash_filesize(ps))
                    }
                    _ => false,
                },
            },
        },
    };

    let name_matches = if l.is_hashed == p.is_hashed {
        l.name.eq_ignore_ascii_case(&p.name)
    } else if l.is_hashed {
        l.name
            .eq_ignore_ascii_case(&crate::syncplay::hash_filename(&p.name))
    } else {
        crate::syncplay::hash_filename(&l.name).eq_ignore_ascii_case(&p.name)
    };

    if size_matches && name_matches {
        return FileComparison {
            status: FileMatchStatus::Matched,
            source_relation: SourceRelation::Exact,
            same_media_by_name: true,
            duration_delta_secs,
            suggested_fps_scale: None,
            suggested_fps_label: None,
        };
    }

    if explicit_conflict {
        return FileComparison {
            status: FileMatchStatus::DifferentFile,
            source_relation: SourceRelation::DifferentMedia,
            same_media_by_name: false,
            duration_delta_secs,
            suggested_fps_scale: None,
            suggested_fps_label: None,
        };
    }

    // When duration matches within tolerance (e.g. .mp4 vs .mkv or WEBRip vs BluRay),
    // report SameLengthDifferentEncode (which the UI labels calmly and allows fine offset nudging on).
    if let Some((_, _, delta)) = durations {
        if delta.abs() <= DURATION_TOLERANCE_SECS {
            return FileComparison {
                status: FileMatchStatus::SameLengthDifferentEncode,
                source_relation: SourceRelation::DifferentEncode,
                same_media_by_name,
                duration_delta_secs,
                suggested_fps_scale: None,
                suggested_fps_label: None,
            };
        }
    }

    if same_media_by_name {
        return FileComparison {
            status: FileMatchStatus::SameLengthDifferentEncode,
            source_relation: SourceRelation::DifferentEncode,
            same_media_by_name: true,
            duration_delta_secs,
            suggested_fps_scale: None,
            suggested_fps_label: None,
        };
    }

    FileComparison {
        status: FileMatchStatus::DifferentFile,
        source_relation: SourceRelation::DifferentMedia,
        same_media_by_name: false,
        duration_delta_secs,
        suggested_fps_scale: None,
        suggested_fps_label: None,
    }
}

pub fn compare_files(local: Option<&FileIdentity>, peer: Option<&FileIdentity>) -> FileMatchStatus {
    analyze_files(local, peer).status
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LocalMatchConfidence {
    High,
    Medium,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalCandidateInput {
    pub path: String,
    pub file_name: String,
    pub parent_folder: Option<String>,
    pub grandparent_folder: Option<String>,
    pub size_bytes: u64,
    pub duration_secs: Option<f64>,
    pub is_cloud_placeholder: bool,
    pub in_saved_series: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalMatchCandidate {
    pub path: String,
    pub file_name: String,
    pub folder_label: String,
    pub score: f64,
    pub title_similarity: f64,
    pub confidence: LocalMatchConfidence,
    pub reason: String,
    pub is_cloud_placeholder: bool,
    pub size_bytes: u64,
    pub duration_secs: Option<f64>,
    pub duration_delta_secs: Option<f64>,
}

const JUNK_CLIP_TOKENS: &[&str] = &[
    "sample",
    "trailer",
    "teaser",
    "ncop",
    "nced",
    "creditless",
    "featurette",
    "extras",
    "deleted",
    "pv",
];

const STOPWORD_TOKENS: &[&str] = &["the", "a", "an", "of", "and"];

fn fold_ascii_char(c: char) -> char {
    match c {
        'á' | 'à' | 'â' | 'ä' | 'ã' | 'å' | 'Á' | 'À' | 'Â' | 'Ä' | 'Ã' | 'Å' => 'a',
        'é' | 'è' | 'ê' | 'ë' | 'É' | 'È' | 'Ê' | 'Ë' => 'e',
        'í' | 'ì' | 'î' | 'ï' | 'Í' | 'Ì' | 'Î' | 'Ï' => 'i',
        'ó' | 'ò' | 'ô' | 'ö' | 'õ' | 'ø' | 'Ó' | 'Ò' | 'Ô' | 'Ö' | 'Õ' | 'Ø' => 'o',
        'ú' | 'ù' | 'û' | 'ü' | 'Ú' | 'Ù' | 'Û' | 'Ü' => 'u',
        'ñ' | 'Ñ' => 'n',
        'ç' | 'Ç' => 'c',
        'ý' | 'ÿ' | 'Ý' => 'y',
        _ => c,
    }
}

fn canonicalize_title_text(raw: &str) -> String {
    let folded: String = raw
        .chars()
        .map(fold_ascii_char)
        .collect::<String>()
        .replace('&', " and ");
    let mut out = Vec::new();
    for tok in folded
        .to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
    {
        let mapped = match tok {
            "ii" => "2",
            "iii" => "3",
            "iv" => "4",
            "vi" => "6",
            "vii" => "7",
            "viii" => "8",
            "ix" => "9",
            "pt" => "part",
            other => other,
        };
        out.push(mapped.to_string());
    }
    out.join(" ")
}

fn is_generic_folder_or_title(norm_title: &str) -> bool {
    if norm_title.is_empty() {
        return true;
    }
    let tokens: Vec<&str> = norm_title.split_whitespace().collect();
    if tokens.is_empty() {
        return true;
    }
    if tokens.iter().all(|t| {
        matches!(
            *t,
            "season"
                | "series"
                | "specials"
                | "extras"
                | "ova"
                | "episode"
                | "ep"
                | "movie"
                | "video"
                | "film"
                | "downloads"
                | "videos"
                | "desktop"
                | "movies"
                | "anime"
                | "shows"
                | "tv"
        ) || t.chars().all(|c| c.is_ascii_digit())
            || (t.starts_with('s') && t[1..].chars().all(|c| c.is_ascii_digit()))
    }) {
        return true;
    }
    false
}

fn parse_season_hint(folder: &str) -> Option<u32> {
    let lower = folder.to_ascii_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    for (i, tok) in tokens.iter().enumerate() {
        if (*tok == "season" || *tok == "s" || *tok == "series") && i + 1 < tokens.len() {
            if let Ok(n) = tokens[i + 1].parse::<u32>() {
                if (1..=99).contains(&n) {
                    return Some(n);
                }
            }
        }
        if let Some(rest) = tok.strip_prefix('s') {
            if !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()) {
                if let Ok(n) = rest.parse::<u32>() {
                    if (1..=99).contains(&n) {
                        return Some(n);
                    }
                }
            }
        }
    }
    None
}

fn parse_bare_episode_in_folder(
    file_name: &str,
    parent_folder: Option<&str>,
) -> Option<EpisodeCode> {
    let parent = parent_folder?;
    if parent.trim().is_empty() {
        return None;
    }
    let base_id = normalize_media_identity(file_name);
    if base_id.year.is_some() {
        // Movies like "300 (2006).mkv" or "12 Angry Men (1957).mkv" must never be treated as episodes.
        return None;
    }
    let season_hint = parse_season_hint(parent);
    let stem = strip_media_ext(file_name).trim();
    let tokens: Vec<&str> = stem
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    let first = *tokens.first()?;
    let bare_number_only = tokens.len() == 1 || is_generic_folder_or_title(&base_id.title);
    if !bare_number_only && season_hint.is_none() {
        return None;
    }
    if first.len() <= 3 && first.chars().all(|c| c.is_ascii_digit()) {
        if let Ok(ep_num) = first.parse::<u32>() {
            if (1..=400).contains(&ep_num) {
                return Some(EpisodeCode {
                    season: season_hint,
                    episode: ep_num,
                });
            }
        }
    }
    None
}

pub fn extract_path_media_identity(
    file_name: &str,
    parent_folder: Option<&str>,
    grandparent_folder: Option<&str>,
) -> NormalizedMediaIdentity {
    let mut id = normalize_media_identity(file_name);
    id.title = canonicalize_title_text(&id.title);

    if id.episode.is_none() {
        if let Some(bare_ep) = parse_bare_episode_in_folder(file_name, parent_folder) {
            id.episode = Some(bare_ep);
            // A file starting with a bare episode number (e.g. "04 - Episode Title.mkv")
            // carries the episode title in its filename and the series title in its parent/grandparent folder.
            id.title.clear();
        }
    }

    if let Some(ep) = id.episode.as_mut() {
        if ep.season.is_none() {
            if let Some(p) = parent_folder {
                ep.season = parse_season_hint(p);
            }
        }
    }

    if is_generic_folder_or_title(&id.title) {
        if let Some(p) = parent_folder {
            let p_id = normalize_media_identity(p);
            let p_title = canonicalize_title_text(&p_id.title);
            if !is_generic_folder_or_title(&p_title) {
                id.title = p_title;
                if id.year.is_none() {
                    id.year = p_id.year;
                }
            } else if let Some(gp) = grandparent_folder {
                let gp_id = normalize_media_identity(gp);
                let gp_title = canonicalize_title_text(&gp_id.title);
                if !is_generic_folder_or_title(&gp_title) {
                    id.title = gp_title;
                    if id.year.is_none() {
                        id.year = gp_id.year;
                    }
                }
            }
        }
    }

    id
}

fn title_numeric_tokens(title: &str) -> Vec<String> {
    title
        .split_whitespace()
        .filter(|t| t.chars().any(|c| c.is_ascii_digit()))
        .map(str::to_string)
        .collect()
}

fn has_junk_clip_token(raw_name: &str) -> Vec<&'static str> {
    let lower = raw_name.to_ascii_lowercase();
    let tokens: Vec<&str> = lower
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .collect();
    JUNK_CLIP_TOKENS
        .iter()
        .copied()
        .filter(|junk| tokens.contains(junk))
        .collect()
}

fn jaro_winkler(a: &str, b: &str) -> f64 {
    if a == b {
        return 1.0;
    }
    let a_chars: Vec<char> = a.chars().collect();
    let b_chars: Vec<char> = b.chars().collect();
    let len_a = a_chars.len();
    let len_b = b_chars.len();
    if len_a == 0 || len_b == 0 {
        return 0.0;
    }
    let match_dist = (len_a.max(len_b) / 2).saturating_sub(1);
    let mut a_matched = vec![false; len_a];
    let mut b_matched = vec![false; len_b];
    let mut matches = 0usize;
    for i in 0..len_a {
        let start = i.saturating_sub(match_dist);
        let end = (i + match_dist + 1).min(len_b);
        for j in start..end {
            if !b_matched[j] && a_chars[i] == b_chars[j] {
                a_matched[i] = true;
                b_matched[j] = true;
                matches += 1;
                break;
            }
        }
    }
    if matches == 0 {
        return 0.0;
    }
    let mut k = 0usize;
    let mut transpositions = 0usize;
    for i in 0..len_a {
        if !a_matched[i] {
            continue;
        }
        while !b_matched[k] {
            k += 1;
        }
        if a_chars[i] != b_chars[k] {
            transpositions += 1;
        }
        k += 1;
    }
    let m = matches as f64;
    let jaro =
        (m / len_a as f64 + m / len_b as f64 + (m - (transpositions as f64) / 2.0) / m) / 3.0;
    let prefix = a_chars
        .iter()
        .zip(b_chars.iter())
        .take(4)
        .take_while(|(ca, cb)| ca == cb)
        .count() as f64;
    (jaro + prefix * 0.1 * (1.0 - jaro)).min(1.0)
}

pub fn compute_title_similarity(a: &str, b: &str) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let a_compact: String = a.chars().filter(|c| !c.is_whitespace()).collect();
    let b_compact: String = b.chars().filter(|c| !c.is_whitespace()).collect();
    if a_compact == b_compact && !a_compact.is_empty() {
        return 0.99;
    }

    let a_tokens: Vec<&str> = a
        .split_whitespace()
        .filter(|t| !STOPWORD_TOKENS.contains(t))
        .collect();
    let b_tokens: Vec<&str> = b
        .split_whitespace()
        .filter(|t| !STOPWORD_TOKENS.contains(t))
        .collect();

    let token_jaccard = if a_tokens.is_empty() || b_tokens.is_empty() {
        0.0
    } else {
        let mut inter = 0usize;
        for t in &a_tokens {
            if b_tokens.contains(t) {
                inter += 1;
            }
        }
        let union = a_tokens.len() + b_tokens.len() - inter;
        if union == 0 {
            0.0
        } else {
            inter as f64 / union as f64
        }
    };

    let jw = jaro_winkler(&a_compact, &b_compact);
    let prefix_bonus = if a.starts_with(b) || b.starts_with(a) {
        0.15
    } else {
        0.0
    };
    ((token_jaccard * 0.62) + (jw * 0.38) + prefix_bonus).min(1.0)
}

fn is_short_title(title: &str) -> bool {
    let alnum_len = title.chars().filter(|c| c.is_ascii_alphanumeric()).count();
    alnum_len < 4
}

pub fn score_local_candidate(
    peer_file_name: &str,
    peer_duration_secs: Option<f64>,
    candidate: &LocalCandidateInput,
) -> Option<LocalMatchCandidate> {
    score_local_candidate_with_options(peer_file_name, peer_duration_secs, candidate, false)
}

pub fn score_local_candidate_with_options(
    peer_file_name: &str,
    peer_duration_secs: Option<f64>,
    candidate: &LocalCandidateInput,
    allow_unprobed_for_probe: bool,
) -> Option<LocalMatchCandidate> {
    let peer_raw_clean = peer_file_name.trim();
    if peer_raw_clean.is_empty() {
        return None;
    }

    // Reject junk clips (sample/trailer/ncop/etc.) unless the peer itself is also one.
    let peer_junk = has_junk_clip_token(peer_raw_clean);
    let local_junk = has_junk_clip_token(&candidate.file_name);
    if local_junk.iter().any(|tok| !peer_junk.contains(tok)) {
        return None;
    }

    let peer_dur = peer_duration_secs.filter(|d| d.is_finite() && *d > 1.0);
    if peer_dur.is_some_and(|d| d >= 600.0)
        && !candidate.is_cloud_placeholder
        && candidate.size_bytes > 0
        && candidate.size_bytes < 15 * 1024 * 1024
        && candidate.duration_secs.is_none_or(|ld| ld < 60.0)
    {
        return None;
    }

    let mut peer_id = normalize_media_identity(peer_raw_clean);
    peer_id.title = canonicalize_title_text(&peer_id.title);
    let local_id = extract_path_media_identity(
        &candidate.file_name,
        candidate.parent_folder.as_deref(),
        candidate.grandparent_folder.as_deref(),
    );

    // Hard episode/season guards
    match (peer_id.episode, local_id.episode) {
        (Some(pe), Some(le)) => {
            if pe.episode != le.episode {
                return None;
            }
            if let (Some(ps), Some(ls)) = (pe.season, le.season) {
                if ps != ls {
                    return None;
                }
            }
        }
        (Some(_), None) | (None, Some(_)) => {
            // Only allow episode-vs-non-episode if duration matches closely (>= 120s).
            let dur_ok = match (peer_dur, candidate.duration_secs) {
                (Some(pd), Some(ld)) if pd >= 120.0 && ld >= 120.0 => (pd - ld).abs() <= 2.5,
                _ => false,
            };
            if !dur_ok {
                return None;
            }
        }
        (None, None) => {}
    }

    // Hard year guard when both have explicit years
    if let (Some(py), Some(ly)) = (peer_id.year, local_id.year) {
        if py != ly {
            return None;
        }
    }

    // Hard sequel / numeric token conflict guard (e.g. "Dune" vs "Dune Part 2")
    let peer_nums = title_numeric_tokens(&peer_id.title);
    let local_nums = title_numeric_tokens(&local_id.title);
    if peer_nums != local_nums {
        return None;
    }

    let title_sim = compute_title_similarity(&peer_id.title, &local_id.title);

    let (dur_exact, dur_fps, dur_delta) = match (peer_dur, candidate.duration_secs) {
        (Some(pd), Some(ld)) if pd > 1.0 && ld > 1.0 => {
            let delta = ld - pd;
            let exact = delta.abs() <= 3.5;
            let fps = !exact && detect_fps_suggestion(ld, pd).is_some();
            // Reject wildly different lengths for the same movie/episode when duration is known
            if delta.abs() > 300.0 && !fps {
                return None;
            }
            (exact, fps, Some(delta))
        }
        _ => (false, false, None),
    };

    let unprobed_can_probe =
        allow_unprobed_for_probe && peer_dur.is_some() && candidate.duration_secs.is_none();

    // Short titles ("Up", "It", "Her") require exact title + (year or duration confirmation)
    if is_short_title(&peer_id.title) {
        let year_confirmed = peer_id.year.is_some() && peer_id.year == local_id.year;
        if title_sim < 0.98 || (!year_confirmed && !dur_exact && !dur_fps && !unprobed_can_probe) {
            return None;
        }
    }

    let both_episodes_match = peer_id.episode.is_some() && local_id.episode.is_some();
    let min_sim = if dur_exact || dur_fps || unprobed_can_probe {
        if both_episodes_match {
            0.25
        } else {
            0.40
        }
    } else if both_episodes_match {
        0.58
    } else {
        0.65
    };

    if title_sim < min_sim {
        return None;
    }

    let mut score = title_sim * 100.0;
    if both_episodes_match {
        score += 20.0;
        if peer_id.episode.and_then(|e| e.season) == local_id.episode.and_then(|e| e.season)
            && peer_id.episode.and_then(|e| e.season).is_some()
        {
            score += 8.0;
        }
    }
    if peer_id.year.is_some() && peer_id.year == local_id.year {
        score += 10.0;
    }
    if dur_exact {
        score += 25.0;
    } else if dur_fps {
        score += 15.0;
    }
    if candidate.in_saved_series {
        score += 6.0;
    }

    let confidence = if (title_sim >= 0.85
        && (both_episodes_match || peer_id.year == local_id.year || dur_exact))
        || (dur_exact && title_sim >= 0.50)
    {
        LocalMatchConfidence::High
    } else {
        LocalMatchConfidence::Medium
    };

    let reason = if candidate.is_cloud_placeholder {
        "Cloud placeholder (OneDrive)".to_string()
    } else if dur_exact && both_episodes_match {
        "Same episode & runtime".to_string()
    } else if dur_exact {
        "Exact runtime match".to_string()
    } else if dur_fps {
        "Same title · FPS differs".to_string()
    } else if both_episodes_match && title_sim >= 0.85 {
        "Same show & episode".to_string()
    } else if both_episodes_match {
        "Similar title & episode".to_string()
    } else {
        "Similar title".to_string()
    };

    let folder_label = candidate
        .parent_folder
        .clone()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Local folder".to_string());

    Some(LocalMatchCandidate {
        path: candidate.path.clone(),
        file_name: candidate.file_name.clone(),
        folder_label,
        score,
        title_similarity: title_sim,
        confidence,
        reason,
        is_cloud_placeholder: candidate.is_cloud_placeholder,
        size_bytes: candidate.size_bytes,
        duration_secs: candidate.duration_secs,
        duration_delta_secs: dur_delta,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str, size: Option<u64>, dur: Option<f64>, hashed: bool) -> FileIdentity {
        FileIdentity {
            name: name.to_string(),
            size_bytes: size,
            size_hash: None,
            duration_secs: dur,
            is_hashed: hashed,
        }
    }

    #[test]
    fn test_missing_local_or_peer_file() {
        let f = id("ep01.mkv", Some(500_000), Some(1440.0), false);
        assert_eq!(compare_files(None, Some(&f)), FileMatchStatus::NoFile);
        assert_eq!(compare_files(Some(&f), None), FileMatchStatus::NoFile);
    }

    #[test]
    fn test_exact_raw_file_match() {
        let a = id("Movie.mkv", Some(1_000_000), Some(5400.0), false);
        let b = id("movie.mkv", Some(1_000_000), Some(5400.5), false);
        assert_eq!(compare_files(Some(&a), Some(&b)), FileMatchStatus::Matched);
    }

    #[test]
    fn test_privacy_hashed_file_match_including_hashed_size() {
        let a = FileIdentity {
            name: crate::syncplay::hash_filename("Show.S01E01.mkv"),
            size_bytes: Some(1_000_000),
            size_hash: Some(crate::syncplay::hash_filesize(1_000_000)),
            duration_secs: Some(1440.0),
            is_hashed: true,
        };
        let b = FileIdentity {
            name: crate::syncplay::hash_filename("Show.S01E01.mkv"),
            size_bytes: None,
            size_hash: Some(crate::syncplay::hash_filesize(1_000_000)),
            duration_secs: Some(1440.0),
            is_hashed: true,
        };
        assert_eq!(compare_files(Some(&a), Some(&b)), FileMatchStatus::Matched);

        // Cross-check hashed local vs unhashed peer
        let c = id("Show.S01E01.mkv", Some(1_000_000), Some(1440.0), false);
        assert_eq!(compare_files(Some(&a), Some(&c)), FileMatchStatus::Matched);
    }

    #[test]
    fn test_duration_mismatch() {
        let a = id("Movie.mkv", Some(1_000_000), Some(5400.0), false);
        let b = id("Movie.mkv", Some(1_000_000), Some(5410.0), false);
        assert_eq!(
            compare_files(Some(&a), Some(&b)),
            FileMatchStatus::DurationMismatch
        );
    }

    #[test]
    fn test_same_length_different_encode_for_differing_size_or_name() {
        let a = id("Movie.1080p.mkv", Some(4_200_000_000), Some(5400.0), false);
        let b = id("Movie.720p.mp4", Some(1_800_000_000), Some(5401.0), false);
        assert_eq!(
            compare_files(Some(&a), Some(&b)),
            FileMatchStatus::SameLengthDifferentEncode
        );
    }

    #[test]
    fn test_different_file_when_size_or_name_differs_without_matching_duration() {
        let a = id("Ep01.mkv", Some(500_000), None, false);
        let b = id("Ep02.mkv", Some(600_000), None, false);
        assert_eq!(
            compare_files(Some(&a), Some(&b)),
            FileMatchStatus::DifferentFile
        );
    }

    #[test]
    fn test_zero_duration_while_probing_does_not_trigger_false_mismatch() {
        let probing = id("Show.S01E01.mkv", Some(1_200_000_000), Some(0.0), false);
        let peer_ready = id("Show.S01E01.mkv", Some(1_200_000_000), Some(1440.0), false);
        assert_eq!(
            compare_files(Some(&probing), Some(&peer_ready)),
            FileMatchStatus::Matched
        );

        let peer_other = id("Show.S01E02.mkv", Some(1_150_000_000), Some(1440.0), false);
        assert_eq!(
            compare_files(Some(&probing), Some(&peer_other)),
            FileMatchStatus::DifferentFile
        );
    }

    #[test]
    fn test_cross_source_webrip_vs_bluray_and_mp4_vs_mkv_analysis() {
        let webrip = id(
            "Dune.Part.Two.2024.1080p.WEBRip.x264.mp4",
            Some(2_100_000_000),
            Some(9960.0),
            false,
        );
        let bluray_same_len = id(
            "Dune Part Two (2024) BluRay 2160p Remux.mkv",
            Some(48_000_000_000),
            Some(9961.5),
            false,
        );
        let enc = analyze_files(Some(&webrip), Some(&bluray_same_len));
        assert_eq!(enc.status, FileMatchStatus::SameLengthDifferentEncode);
        assert_eq!(enc.source_relation, SourceRelation::DifferentEncode);
        assert!(enc.same_media_by_name);

        // 8-second studio-logo difference -> DifferentCut with delta reported
        let bluray_longer = id(
            "Dune Part Two (2024) BluRay 1080p.mkv",
            Some(12_000_000_000),
            Some(9968.0),
            false,
        );
        let cut = analyze_files(Some(&webrip), Some(&bluray_longer));
        assert_eq!(cut.status, FileMatchStatus::DurationMismatch);
        assert_eq!(cut.source_relation, SourceRelation::DifferentCut);
        assert!(cut.same_media_by_name);
        assert_eq!(cut.duration_delta_secs, Some(-8.0));

        // 25 fps PAL vs 23.976 fps BluRay -> FpsMismatch with exact scale suggestion
        let pal_ep = id(
            "Show.S01E03.WEBRip.mp4",
            Some(700_000_000),
            Some(1381.0),
            false,
        );
        let ntsc_ep = id(
            "Show.S01E03.BluRay.mkv",
            Some(1_600_000_000),
            Some(1440.0),
            false,
        );
        let fps = analyze_files(Some(&pal_ep), Some(&ntsc_ep));
        assert_eq!(fps.status, FileMatchStatus::DurationMismatch);
        assert_eq!(fps.source_relation, SourceRelation::FpsMismatch);
        assert!(fps.same_media_by_name);
        let suggested = fps.suggested_fps_scale.expect("fps suggestion");
        assert!((suggested - (24_000.0 / 1001.0) / 25.0).abs() < 1e-6);

        // Conflicting episode numbers with identical length must NOT claim same encode
        let ep1 = id(
            "Show.S01E01.WEBRip.mp4",
            Some(700_000_000),
            Some(1440.0),
            false,
        );
        let ep2 = id(
            "Show.S01E02.BluRay.mkv",
            Some(1_500_000_000),
            Some(1440.5),
            false,
        );
        let conflict = analyze_files(Some(&ep1), Some(&ep2));
        assert_eq!(conflict.status, FileMatchStatus::DifferentFile);
        assert_eq!(conflict.source_relation, SourceRelation::DifferentMedia);

        // Minimal dot-separated episode filenames without release tags must still parse S01E01 vs S01E02
        let minimal_ep1 = id("Show.S01E01.mkv", None, Some(1440.0), false);
        let minimal_ep2 = id("Show.S01E02.mkv", None, Some(1440.0), false);
        let minimal_conflict = analyze_files(Some(&minimal_ep1), Some(&minimal_ep2));
        assert_eq!(minimal_conflict.status, FileMatchStatus::DifferentFile);
        assert_eq!(
            minimal_conflict.source_relation,
            SourceRelation::DifferentMedia
        );

        // Renamed user file with matching duration still stays compatible
        let renamed = id("movie.mp4", Some(1_000_000_000), Some(9960.5), false);
        let renamed_cmp = analyze_files(Some(&renamed), Some(&bluray_same_len));
        assert_eq!(
            renamed_cmp.status,
            FileMatchStatus::SameLengthDifferentEncode
        );
        assert_eq!(renamed_cmp.source_relation, SourceRelation::DifferentEncode);
    }

    #[test]
    fn test_local_candidate_scoring_handles_messy_names_and_rejects_false_positives() {
        let cand = |file_name: &str,
                    parent: Option<&str>,
                    grandparent: Option<&str>,
                    size: u64,
                    dur: Option<f64>| LocalCandidateInput {
            path: format!("D:\\Media\\{file_name}"),
            file_name: file_name.to_string(),
            parent_folder: parent.map(str::to_string),
            grandparent_folder: grandparent.map(str::to_string),
            size_bytes: size,
            duration_secs: dur,
            is_cloud_placeholder: false,
            in_saved_series: false,
        };

        // Folder-context episode match ("Season 2/04.mkv" vs "Breaking Bad S02E04.mkv")
        let ep_match = score_local_candidate(
            "[Release] Breaking.Bad.S02E04.1080p.WEB-DL.mkv",
            Some(2820.0),
            &cand(
                "04.mkv",
                Some("Season 2"),
                Some("Breaking Bad"),
                800_000_000,
                Some(2821.0),
            ),
        )
        .expect("should match via grandparent+parent folder context");
        assert_eq!(ep_match.confidence, LocalMatchConfidence::High);

        // Wrong episode must be hard-rejected
        assert!(score_local_candidate(
            "Breaking.Bad.S02E04.1080p.mkv",
            Some(2820.0),
            &cand(
                "05.mkv",
                Some("Season 2"),
                Some("Breaking Bad"),
                800_000_000,
                Some(2820.0),
            ),
        )
        .is_none());

        // Sequel number mismatch ("Dune" vs "Dune Part Two" / "Dune 2")
        assert!(score_local_candidate(
            "Dune (2021) 1080p.mkv",
            Some(9300.0),
            &cand(
                "Dune.Part.2.2024.1080p.mkv",
                None,
                None,
                4_000_000_000,
                Some(9960.0)
            ),
        )
        .is_none());
        assert!(score_local_candidate(
            "Dune Part Two 2024.mkv",
            Some(9960.0),
            &cand("Dune (2021).mkv", None, None, 4_000_000_000, Some(9300.0)),
        )
        .is_none());

        // Punctuation/Roman numeral equivalence ("Spider-Man" vs "SpiderMan", "Part II" vs "Part 2")
        let spider = score_local_candidate(
            "Spider-Man Into the Spider-Verse (2018) 1080p.mkv",
            Some(7000.0),
            &cand(
                "SpiderMan.Into.The.Spider.Verse.2018.BluRay.mp4",
                None,
                None,
                2_500_000_000,
                Some(7001.0),
            ),
        )
        .expect("should match across punctuation differences");
        assert_eq!(spider.confidence, LocalMatchConfidence::High);

        let roman = score_local_candidate(
            "Dune.Part.II.2024.1080p.mkv",
            Some(9960.0),
            &cand(
                "Dune Part 2 (2024).mkv",
                None,
                None,
                4_000_000_000,
                Some(9960.0),
            ),
        )
        .expect("Roman numeral II should match 2");
        assert_eq!(roman.confidence, LocalMatchConfidence::High);

        // Junk sample/trailer files must be rejected
        assert!(score_local_candidate(
            "Dune.Part.Two.2024.1080p.mkv",
            Some(9960.0),
            &cand(
                "Dune.Part.Two.2024.Sample.mkv",
                None,
                None,
                45_000_000,
                Some(45.0)
            ),
        )
        .is_none());

        // Short title ("It" / "Up") requires year or runtime confirmation
        assert!(score_local_candidate(
            "Up.2009.1080p.mkv",
            Some(5760.0),
            &cand("Up.mkv", None, None, 2_000_000_000, None),
        )
        .is_none());
        assert!(score_local_candidate(
            "Up.2009.1080p.mkv",
            Some(5760.0),
            &cand("Up (2009).mkv", None, None, 2_000_000_000, None),
        )
        .is_some());

        // Movies starting with numbers inside a Movies folder must NOT be misparsed as episodes
        let movie_300 = score_local_candidate(
            "300.2006.1080p.BluRay.mkv",
            Some(7000.0),
            &cand(
                "300 (2006).mkv",
                Some("Movies"),
                None,
                4_000_000_000,
                Some(7000.0),
            ),
        )
        .expect("300 (2006) in Movies folder must match as a movie");
        assert_eq!(movie_300.confidence, LocalMatchConfidence::High);

        let movie_12 = score_local_candidate(
            "12.Angry.Men.1957.1080p.mkv",
            Some(5760.0),
            &cand(
                "12 Angry Men (1957).mkv",
                Some("Movies"),
                None,
                3_000_000_000,
                Some(5760.0),
            ),
        )
        .expect("12 Angry Men (1957) in Movies folder must match as a movie");
        assert_eq!(movie_12.confidence, LocalMatchConfidence::High);

        // Bare episode number + episode subtitle ("04 - Cancer Man.mkv") inside "Breaking Bad/Season 1"
        let ep_with_subtitle = score_local_candidate(
            "Breaking.Bad.S01E04.1080p.mkv",
            Some(2880.0),
            &cand(
                "04 - Cancer Man.mkv",
                Some("Season 1"),
                Some("Breaking Bad"),
                900_000_000,
                Some(2880.0),
            ),
        )
        .expect("04 - Episode Title.mkv inside Show/Season 1 must inherit show title and match");
        assert_eq!(ep_with_subtitle.confidence, LocalMatchConfidence::High);

        // Unprobed short title ("Up.mkv") is eligible for probe in Pass 1, then confirmed by duration in Pass 2
        let unprobed_up = cand("Up.mkv", Some("Movies"), None, 2_000_000_000, None);
        assert!(score_local_candidate("Up.2009.1080p.mkv", Some(5760.0), &unprobed_up).is_none());
        assert!(score_local_candidate_with_options(
            "Up.2009.1080p.mkv",
            Some(5760.0),
            &unprobed_up,
            true
        )
        .is_some());
    }
}
