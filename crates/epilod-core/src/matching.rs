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
}
