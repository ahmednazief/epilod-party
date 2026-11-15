use crate::validation::{
    validate_local_path_syntax_with_options, LocalPathOptions,
};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

pub const VIDEO_EXTENSIONS: &[&str] = &[
    "mkv", "mp4", "ts", "m2ts", "avi", "webm", "flv", "wmv", "ogv", "3gp", "mov", "m4v",
    "mpg", "mpeg", "vob",
];

pub const SUBTITLE_EXTENSIONS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub", "idx"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodeCode {
    pub season: Option<u32>,
    pub episode: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistItemDto {
    pub path: String,
    pub file_name: String,
    pub clean_title: String,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub episode_badge: Option<String>,
    pub subtitle_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaScanResultDto {
    pub items: Vec<PlaylistItemDto>,
    pub active_index: usize,
    pub folder_name: Option<String>,
    pub loose_subtitle_path: Option<String>,
}

fn extension_lower(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default()
}

pub fn is_video_path(path: &Path) -> bool {
    let ext = extension_lower(path);
    VIDEO_EXTENSIONS.iter().any(|candidate| *candidate == ext)
}

pub fn is_subtitle_path(path: &Path) -> bool {
    let ext = extension_lower(path);
    SUBTITLE_EXTENSIONS
        .iter()
        .any(|candidate| *candidate == ext)
}

fn strip_ext(file_name: &str) -> &str {
    match file_name.rfind('.') {
        Some(idx) if idx > 0 => &file_name[..idx],
        _ => file_name,
    }
}

fn is_token_boundary(b: u8) -> bool {
    !b.is_ascii_alphanumeric()
}

fn parse_u32_run(bytes: &[u8], start: usize, max_digits: usize) -> Option<(u32, usize)> {
    let mut end = start;
    while end < bytes.len() && bytes[end].is_ascii_digit() && end - start < max_digits + 1 {
        end += 1;
    }
    let len = end - start;
    if len == 0 || len > max_digits {
        return None;
    }
    let num = std::str::from_utf8(&bytes[start..end])
        .ok()?
        .parse::<u32>()
        .ok()?;
    Some((num, end))
}

/// Extract season & episode numbers from common media release filenames while avoiding false
/// positives like `1920x1080`, `2160p`, `x265`, or audio codecs (`EAC3`, `H264`).
pub fn parse_episode_code(file_name: &str) -> Option<EpisodeCode> {
    let stem = strip_ext(file_name);
    let lower = stem.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    // 1. S01E02 / s1e2 / S01.E02 / S01_E02 / S01-E02 / S01 E02
    for i in 0..bytes.len() {
        if bytes[i] == b's' && (i == 0 || is_token_boundary(bytes[i - 1])) {
            if let Some((season, mut pos)) = parse_u32_run(bytes, i + 1, 2) {
                while pos < bytes.len() && matches!(bytes[pos], b'.' | b'_' | b'-' | b' ') {
                    pos += 1;
                }
                if pos < bytes.len() && bytes[pos] == b'e' {
                    if let Some((episode, after)) = parse_u32_run(bytes, pos + 1, 3) {
                        if episode > 0 && (after == bytes.len() || is_token_boundary(bytes[after]))
                        {
                            return Some(EpisodeCode {
                                season: Some(season),
                                episode,
                            });
                        }
                    }
                }
            }
        }
    }

    // 2. 1x02 / 01x02 (filter out screen resolutions like 1920x1080 or 1280x720 or 3840x2160)
    for i in 0..bytes.len() {
        if bytes[i].is_ascii_digit() && (i == 0 || is_token_boundary(bytes[i - 1])) {
            if let Some((season, xpos)) = parse_u32_run(bytes, i, 2) {
                if season <= 30 && xpos < bytes.len() && bytes[xpos] == b'x' {
                    if let Some((episode, after)) = parse_u32_run(bytes, xpos + 1, 3) {
                        if episode > 0
                            && episode <= 300
                            && (after == bytes.len() || is_token_boundary(bytes[after]))
                        {
                            return Some(EpisodeCode {
                                season: Some(season),
                                episode,
                            });
                        }
                    }
                }
            }
        }
    }

    // 3. "Episode 02" / "Ep 02" / "Ep.02" / "E02"
    let mut parsed_season: Option<u32> = None;
    if let Some(s_pos) = lower.find("season") {
        let mut idx = s_pos + "season".len();
        while idx < bytes.len() && matches!(bytes[idx], b' ' | b'.' | b'_' | b'-') {
            idx += 1;
        }
        if let Some((s, _)) = parse_u32_run(bytes, idx, 2) {
            parsed_season = Some(s);
        }
    }

    for kw in ["episode", "ep"] {
        let mut search_from = 0usize;
        while let Some(rel) = lower[search_from..].find(kw) {
            let start = search_from + rel;
            let boundary_ok = start == 0 || is_token_boundary(bytes[start - 1]);
            let mut pos = start + kw.len();
            while pos < bytes.len() && matches!(bytes[pos], b' ' | b'.' | b'_' | b'-') {
                pos += 1;
            }
            if boundary_ok {
                if let Some((episode, after)) = parse_u32_run(bytes, pos, 3) {
                    if episode > 0 && (after == bytes.len() || is_token_boundary(bytes[after])) {
                        return Some(EpisodeCode {
                            season: parsed_season,
                            episode,
                        });
                    }
                }
            }
            search_from = start + kw.len();
        }
    }

    // Standalone "E02" token
    for i in 0..bytes.len() {
        if bytes[i] == b'e' && (i == 0 || is_token_boundary(bytes[i - 1])) {
            if let Some((episode, after)) = parse_u32_run(bytes, i + 1, 3) {
                if episode > 0
                    && episode <= 400
                    && (after == bytes.len() || is_token_boundary(bytes[after]))
                {
                    return Some(EpisodeCode {
                        season: parsed_season,
                        episode,
                    });
                }
            }
        }
    }

    // 4. Anime naming: " - 02 " / " - 02[" / "[02]" / "(02)"
    for i in 0..bytes.len() {
        if i + 3 < bytes.len() && bytes[i] == b' ' && bytes[i + 1] == b'-' && bytes[i + 2] == b' '
        {
            if let Some((episode, after)) = parse_u32_run(bytes, i + 3, 3) {
                let before_str = &lower[..i];
                let after_ok = after == bytes.len()
                    || matches!(
                        bytes[after],
                        b' ' | b'[' | b'(' | b'.' | b'_' | b'v' | b'V'
                    );
                if episode > 0
                    && episode <= 400
                    && !before_str.trim().is_empty()
                    && after_ok
                {
                    return Some(EpisodeCode {
                        season: parsed_season,
                        episode,
                    });
                }
            }
        }
    }

    None
}

pub fn format_episode_badge(code: EpisodeCode) -> String {
    match code.season {
        Some(season) => format!("S{season:02}E{:02}", code.episode),
        None => format!("EP {:02}", code.episode),
    }
}

pub fn clean_episode_title(file_name: &str) -> String {
    let mut s = strip_ext(file_name).trim().to_string();
    // Replace dots/underscores with spaces when the name doesn't naturally use spaces
    if !s.contains(' ') {
        s = s.replace(['.', '_'], " ");
    } else {
        s = s.replace('_', " ");
    }

    // Remove bracketed tags like [SubsPlease] or [1080p] when meaningful title text remains
    let mut cleaned = String::with_capacity(s.len());
    let mut bracket_depth: i32 = 0;
    for ch in s.chars() {
        match ch {
            '[' => bracket_depth += 1,
            ']' => bracket_depth = (bracket_depth - 1).max(0),
            _ if bracket_depth == 0 => cleaned.push(ch),
            _ => {}
        }
    }
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        strip_ext(file_name).trim().to_string()
    } else {
        collapsed
    }
}

/// Natural human comparator so `Episode 2` comes before `Episode 10`.
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let mut ia = 0usize;
    let mut ib = 0usize;

    while ia < ab.len() && ib < bb.len() {
        if ab[ia].is_ascii_digit() && bb[ib].is_ascii_digit() {
            let start_a = ia;
            while ia < ab.len() && ab[ia].is_ascii_digit() {
                ia += 1;
            }
            let start_b = ib;
            while ib < bb.len() && bb[ib].is_ascii_digit() {
                ib += 1;
            }
            let num_a = std::str::from_utf8(&ab[start_a..ia])
                .ok()
                .and_then(|s| s.parse::<u128>().ok())
                .unwrap_or(0);
            let num_b = std::str::from_utf8(&bb[start_b..ib])
                .ok()
                .and_then(|s| s.parse::<u128>().ok())
                .unwrap_or(0);
            match num_a.cmp(&num_b) {
                Ordering::Equal => match (ia - start_a).cmp(&(ib - start_b)) {
                    Ordering::Equal => {}
                    ord => return ord,
                },
                ord => return ord,
            }
        } else {
            let ca = ab[ia].to_ascii_lowercase();
            let cb = bb[ib].to_ascii_lowercase();
            match ca.cmp(&cb) {
                Ordering::Equal => {
                    ia += 1;
                    ib += 1;
                }
                ord => return ord,
            }
        }
    }

    ab.len().cmp(&bb.len())
}

fn collect_dir_entries(
    dir: &Path,
    max_depth: usize,
    max_entries: usize,
    videos: &mut Vec<PathBuf>,
    subtitles: &mut Vec<PathBuf>,
    seen: &mut HashSet<String>,
) {
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    let mut visited_count = 0usize;

    while let Some((current, depth)) = stack.pop() {
        let Ok(read_dir) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in read_dir.flatten() {
            if visited_count >= max_entries {
                return;
            }
            visited_count += 1;
            let p = entry.path();
            if p.is_dir() {
                if depth < max_depth {
                    stack.push((p, depth + 1));
                }
                continue;
            }
            if !p.is_file() {
                continue;
            }
            let key = p.to_string_lossy().to_ascii_lowercase();
            if is_video_path(&p) && seen.insert(key.clone()) {
                videos.push(p);
            } else if is_subtitle_path(&p) && seen.insert(key) {
                subtitles.push(p);
            }
        }
    }
}

fn score_subtitle_for_video(video_name: &str, video_code: Option<EpisodeCode>, sub_path: &Path) -> i32 {
    let sub_name = sub_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    let video_stem = strip_ext(video_name).to_ascii_lowercase();
    let sub_stem = strip_ext(sub_name).to_ascii_lowercase();

    if sub_stem == video_stem {
        return 100;
    }
    if !video_stem.is_empty() && sub_stem.starts_with(&video_stem) {
        return 85;
    }
    if !video_stem.is_empty() && sub_stem.contains(&video_stem) {
        return 60;
    }
    if let (Some(vc), Some(sc)) = (video_code, parse_episode_code(sub_name)) {
        if vc.episode == sc.episode && (vc.season.is_none() || sc.season.is_none() || vc.season == sc.season) {
            return 50;
        }
    }
    0
}

pub fn scan_media_paths(
    raw_paths: &[String],
    opts: LocalPathOptions,
) -> Result<MediaScanResultDto, String> {
    if raw_paths.is_empty() {
        return Err("No media paths supplied.".to_string());
    }

    let mut validated: Vec<PathBuf> = Vec::with_capacity(raw_paths.len());
    for raw in raw_paths {
        let clean = validate_local_path_syntax_with_options(raw, opts)
            .map_err(|e| e.to_string())?;
        validated.push(PathBuf::from(clean));
    }

    let mut videos: Vec<PathBuf> = Vec::new();
    let mut subtitles: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut primary_video: Option<PathBuf> = None;
    let mut folder_name: Option<String> = None;

    for p in &validated {
        let Ok(meta) = std::fs::metadata(p) else {
            continue;
        };
        if meta.is_dir() {
            if folder_name.is_none() {
                folder_name = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string());
            }
            collect_dir_entries(p, 2, 500, &mut videos, &mut subtitles, &mut seen);
        } else if meta.is_file() {
            let key = p.to_string_lossy().to_ascii_lowercase();
            if is_video_path(p) {
                if primary_video.is_none() {
                    primary_video = Some(p.clone());
                }
                if seen.insert(key) {
                    videos.push(p.clone());
                }
            } else if is_subtitle_path(p) && seen.insert(key) {
                subtitles.push(p.clone());
            }
        }
    }

    // Auto-discover sibling season episodes when user opens a single episodic video file
    let dir_dropped = validated.iter().any(|p| p.is_dir());
    if !dir_dropped && videos.len() == 1 {
        if let Some(ref single_vid) = primary_video {
            let fname = single_vid
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default();
            if parse_episode_code(fname).is_some() {
                if let Some(parent) = single_vid.parent() {
                    let mut sibling_videos = Vec::new();
                    let mut sibling_subs = Vec::new();
                    let mut sib_seen = seen.clone();
                    collect_dir_entries(
                        parent,
                        1,
                        300,
                        &mut sibling_videos,
                        &mut sibling_subs,
                        &mut sib_seen,
                    );
                    let episodic_siblings: Vec<PathBuf> = sibling_videos
                        .into_iter()
                        .filter(|p| {
                            p.file_name()
                                .and_then(|n| n.to_str())
                                .and_then(parse_episode_code)
                                .is_some()
                        })
                        .collect();
                    if !episodic_siblings.is_empty() {
                        videos.extend(episodic_siblings);
                        subtitles.extend(sibling_subs);
                        if folder_name.is_none() {
                            folder_name = parent
                                .file_name()
                                .and_then(|n| n.to_str())
                                .map(|s| s.to_string());
                        }
                    }
                }
            }
        }
    }

    // Also inspect sibling `Subs`/`Subtitles` folder for a video's parent folder when user selected explicit multiple videos
    if videos.len() > 1 && subtitles.is_empty() {
        if let Some(parent) = videos[0].parent() {
            let mut dummy_videos = Vec::new();
            let mut sib_subs = Vec::new();
            let mut sub_seen = HashSet::new();
            collect_dir_entries(parent, 1, 200, &mut dummy_videos, &mut sib_subs, &mut sub_seen);
            subtitles.extend(sib_subs);
            if folder_name.is_none() {
                folder_name = parent
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string());
            }
        }
    }

    // Sort videos deterministically by (season, episode, natural_cmp(file_name))
    let mut enriched: Vec<(Option<EpisodeCode>, PlaylistItemDto)> = videos
        .into_iter()
        .map(|p| {
            let file_name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("video")
                .to_string();
            let code = parse_episode_code(&file_name);
            let mut best_sub: Option<(i32, String)> = None;
            for sub in &subtitles {
                let score = score_subtitle_for_video(&file_name, code, sub);
                if score > 0 {
                    let sub_str = sub.to_string_lossy().into_owned();
                    if best_sub.as_ref().is_none_or(|(best, _)| score > *best) {
                        best_sub = Some((score, sub_str));
                    }
                }
            }
            let dto = PlaylistItemDto {
                path: p.to_string_lossy().into_owned(),
                clean_title: clean_episode_title(&file_name),
                season: code.and_then(|c| c.season),
                episode: code.map(|c| c.episode),
                episode_badge: code.map(format_episode_badge),
                subtitle_path: best_sub.map(|(_, s)| s),
                file_name,
            };
            (code, dto)
        })
        .collect();

    enriched.sort_by(|(ca, a), (cb, b)| {
        let sa = ca.and_then(|c| c.season).unwrap_or(u32::MAX);
        let sb = cb.and_then(|c| c.season).unwrap_or(u32::MAX);
        sa.cmp(&sb)
            .then_with(|| {
                ca.map(|c| c.episode)
                    .unwrap_or(u32::MAX)
                    .cmp(&cb.map(|c| c.episode).unwrap_or(u32::MAX))
            })
            .then_with(|| natural_cmp(&a.file_name, &b.file_name))
    });

    let mut items: Vec<PlaylistItemDto> = enriched.into_iter().map(|(_, item)| item).collect();
    let active_index = primary_video
        .as_ref()
        .and_then(|pv| {
            let pv_str = pv.to_string_lossy();
            items
                .iter()
                .position(|item| item.path.eq_ignore_ascii_case(&pv_str))
        })
        .unwrap_or(0);

    // If user dropped 1 video + 1 explicit subtitle file with an unrelated filename, still pair it cleanly
    let loose_subtitle_path = if items.len() == 1 && validated.iter().any(|p| p.is_file() && is_subtitle_path(p)) {
        let explicit_sub = validated
            .iter()
            .find(|p| p.is_file() && is_subtitle_path(p))
            .map(|p| p.to_string_lossy().into_owned());
        if let Some(ref es) = explicit_sub {
            if items[0].subtitle_path.is_none() {
                items[0].subtitle_path = Some(es.clone());
            }
        }
        explicit_sub
    } else if items.is_empty() {
        subtitles.first().map(|p| p.to_string_lossy().into_owned())
    } else {
        items
            .get(active_index)
            .and_then(|item| item.subtitle_path.clone())
    };

    Ok(MediaScanResultDto {
        items,
        active_index,
        folder_name,
        loose_subtitle_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn test_parse_episode_code_variants_and_resolution_filter() {
        assert_eq!(
            parse_episode_code("Dark.S01E03.1080p.WEB-DL.mkv"),
            Some(EpisodeCode {
                season: Some(1),
                episode: 3
            })
        );
        assert_eq!(
            parse_episode_code("Breaking.Bad.2x07.HDTV.mkv"),
            Some(EpisodeCode {
                season: Some(2),
                episode: 7
            })
        );
        assert_eq!(
            parse_episode_code("[SubsPlease] Frieren - 12 (1080p) [ABC123].mkv"),
            Some(EpisodeCode {
                season: None,
                episode: 12
            })
        );
        assert_eq!(
            parse_episode_code("Documentary.1920x1080.x265.mkv"),
            None
        );
        assert_eq!(
            parse_episode_code("Movie.2024.3840x2160.HDR.mp4"),
            None
        );
    }

    #[test]
    fn test_natural_cmp_orders_episodes_numerically() {
        let mut names = vec!["Ep 10.mkv", "Ep 2.mkv", "Ep 1.mkv"];
        names.sort_by(|a, b| natural_cmp(a, b));
        assert_eq!(names, vec!["Ep 1.mkv", "Ep 2.mkv", "Ep 10.mkv"]);
    }

    #[test]
    fn test_scan_season_folder_and_sibling_discovery_pairs_subs() {
        let uniq = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("epilod-season-{uniq}"));
        let season_dir = root.join("Severance Season 1");
        let subs_dir = season_dir.join("Subs");
        fs::create_dir_all(&subs_dir).unwrap();

        let ep10 = season_dir.join("Severance.S01E10.1080p.mkv");
        let ep2 = season_dir.join("Severance.S01E02.1080p.mkv");
        let ep1 = season_dir.join("Severance.S01E01.1080p.mkv");
        let sub1 = subs_dir.join("Severance.S01E01.1080p.ara.srt");
        let sub2 = season_dir.join("Severance.S01E02.1080p.srt");

        for f in [&ep10, &ep2, &ep1, &sub1, &sub2] {
            fs::write(f, b"dummy").unwrap();
        }

        // Scanning folder returns all 3 episodes sorted numerically with paired subtitles
        let folder_scan = scan_media_paths(
            &[season_dir.to_string_lossy().into_owned()],
            LocalPathOptions::default(),
        )
        .unwrap();
        assert_eq!(folder_scan.items.len(), 3);
        assert_eq!(folder_scan.items[0].episode_badge.as_deref(), Some("S01E01"));
        assert_eq!(folder_scan.items[1].episode_badge.as_deref(), Some("S01E02"));
        assert_eq!(folder_scan.items[2].episode_badge.as_deref(), Some("S01E10"));
        assert_eq!(
            folder_scan.items[0].subtitle_path.as_deref(),
            Some(sub1.to_string_lossy().as_ref())
        );
        assert_eq!(
            folder_scan.items[1].subtitle_path.as_deref(),
            Some(sub2.to_string_lossy().as_ref())
        );
        assert_eq!(folder_scan.folder_name.as_deref(), Some("Severance Season 1"));

        // Opening only Ep2 directly still auto-discovers the whole season & selects Ep2 (index 1)
        let ep2_scan = scan_media_paths(
            &[ep2.to_string_lossy().into_owned()],
            LocalPathOptions::default(),
        )
        .unwrap();
        assert_eq!(ep2_scan.items.len(), 3);
        assert_eq!(ep2_scan.active_index, 1);

        let _ = fs::remove_dir_all(&root);
    }
}
