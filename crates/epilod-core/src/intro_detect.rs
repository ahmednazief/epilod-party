use crate::mpv_ipc::MpvChapter;
use crate::subtitle_sync::{fft_radix2, measure_background_z, parse_subtitles, SubtitleCue};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const INTRO_FP_SAMPLE_RATE: usize = 8_000;
pub const INTRO_FP_HOP_SAMPLES: usize = 1_000; // 8 fps (125 ms)
pub const INTRO_FP_FFT_LEN: usize = 2_048; // 256 ms Hann window (50% overlap)
pub const INTRO_FP_FPS: f64 = INTRO_FP_SAMPLE_RATE as f64 / INTRO_FP_HOP_SAMPLES as f64; // 8.0
pub const INTRO_FP_BANDS: usize = 12;

const MIN_INTRO_SECS: f64 = 12.0;
const MAX_INTRO_SECS: f64 = 175.0;
const MAX_CHAPTER_INTRO_SECS: f64 = 180.0;
const MIN_RECAP_SECS: f64 = 8.0;
const MAX_RECAP_SECS: f64 = 240.0;
const MAX_OPENING_START_SECS: f64 = 780.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntroSegmentKind {
    Intro,
    Recap,
    Outro,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntroSource {
    Chapter,
    AudioMatch,
    SubtitleCue,
    ChapterStructure,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IntroConfidence {
    High,
    Medium,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedIntro {
    pub start_secs: f64,
    pub end_secs: f64,
    pub skip_target_secs: f64,
    pub kind: IntroSegmentKind,
    pub source: IntroSource,
    pub confidence: IntroConfidence,
    pub label: String,
    pub similarity: Option<f64>,
    pub matched_episodes: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntroDetectionOutcome {
    pub segments: Vec<DetectedIntro>,
    pub primary_intro: Option<DetectedIntro>,
    #[serde(default)]
    pub outro: Option<DetectedIntro>,
}

impl IntroDetectionOutcome {
    pub fn empty() -> Self {
        Self {
            segments: Vec::new(),
            primary_intro: None,
            outro: None,
        }
    }

    pub fn from_segments(mut segments: Vec<DetectedIntro>) -> Self {
        segments.sort_by(|a, b| a.start_secs.total_cmp(&b.start_secs));
        link_contiguous_recap_to_intro(&mut segments);
        let primary_intro = segments
            .iter()
            .find(|s| s.kind == IntroSegmentKind::Intro)
            .cloned()
            .or_else(|| {
                segments
                    .iter()
                    .find(|s| s.kind != IntroSegmentKind::Outro)
                    .cloned()
            });
        Self {
            segments,
            primary_intro,
            outro: None,
        }
    }

    pub fn with_outro(mut self, outro: Option<DetectedIntro>) -> Self {
        self.outro = outro;
        self
    }
}

fn link_contiguous_recap_to_intro(segments: &mut [DetectedIntro]) {
    let intro_pos = segments
        .iter()
        .position(|s| s.kind == IntroSegmentKind::Intro);
    let Some(i_idx) = intro_pos else {
        return;
    };
    let intro_start = segments[i_idx].start_secs;
    let intro_end = segments[i_idx].end_secs;
    for (idx, seg) in segments.iter_mut().enumerate() {
        if idx != i_idx
            && seg.kind == IntroSegmentKind::Recap
            && intro_start >= seg.end_secs - 0.5
            && intro_start - seg.end_secs <= 2.5
        {
            seg.skip_target_secs = intro_end;
            seg.label = "Skip Recap & Intro".to_string();
        }
    }
}

pub fn recommended_intro_window_secs(duration_secs: f64) -> f64 {
    if !duration_secs.is_finite() || duration_secs <= 0.0 {
        return 600.0;
    }
    (duration_secs * 0.50)
        .clamp(120.0, 660.0)
        .min(duration_secs.max(45.0))
}

/// Returns `(tail_start_secs, tail_window_secs)` for cross-episode outro/ED fingerprinting.
pub fn recommended_outro_window_secs(duration_secs: f64) -> Option<(f64, f64)> {
    if !duration_secs.is_finite() || duration_secs < 300.0 {
        return None;
    }
    let window = (duration_secs * 0.28).clamp(150.0, 360.0);
    let start = (duration_secs - window).max(0.0);
    Some((start, window.min(duration_secs - start)))
}

fn opening_start_limit(duration_secs: f64) -> f64 {
    if duration_secs.is_finite() && duration_secs > 0.0 {
        (duration_secs * 0.45).min(MAX_OPENING_START_SECS)
    } else {
        MAX_OPENING_START_SECS
    }
}

fn closing_start_min(duration_secs: f64) -> f64 {
    if duration_secs.is_finite() && duration_secs > 0.0 {
        (duration_secs * 0.55).max(duration_secs - 420.0).max(0.0)
    } else {
        0.0
    }
}

fn tokenize_title(raw: &str) -> Vec<String> {
    raw.to_ascii_lowercase()
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_negative_chapter_title(lower: &str, tokens: &[String]) -> bool {
    const NEGATIVE_EXACT: &[&str] = &[
        "end", "ending", "outro", "closing", "ed", "preview", "next", "trailer", "prologue",
        "avant", "part", "act", "epilogue", "post",
    ];
    if tokens.iter().any(|t| NEGATIVE_EXACT.contains(&t.as_str())) {
        return true;
    }
    lower.contains("cold open")
        || lower.contains("end credits")
        || lower.contains("closing credits")
        || lower.contains("next episode")
        || lower.contains("エンディング")
        || lower.contains("予告")
}

fn is_numbered_prefix_token(tok: &str, prefix: &str) -> bool {
    if tok == prefix {
        return true;
    }
    if let Some(rest) = tok.strip_prefix(prefix) {
        return !rest.is_empty() && rest.len() <= 2 && rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

fn is_op_token(tok: &str) -> bool {
    is_numbered_prefix_token(tok, "op")
}

fn is_ed_token(tok: &str) -> bool {
    is_numbered_prefix_token(tok, "ed")
}

fn classify_chapter_title(
    raw_title: &str,
    start_secs: f64,
    len_secs: f64,
    duration_secs: f64,
    has_following_chapters: bool,
) -> Option<IntroSegmentKind> {
    let trimmed = raw_title.trim();
    if trimmed.is_empty() {
        return None;
    }
    let lower = trimmed.to_ascii_lowercase();
    let tokens = tokenize_title(&lower);
    if is_negative_chapter_title(&lower, &tokens) {
        return None;
    }

    let start_limit = opening_start_limit(duration_secs);
    if start_secs > start_limit {
        return None;
    }

    let is_recap = (tokens.iter().any(|t| t == "recap" || t == "previously")
        || lower.contains("previously on")
        || lower.contains("last time on")
        || trimmed.contains("前回"))
        && (MIN_RECAP_SECS..=MAX_RECAP_SECS).contains(&len_secs)
        && start_secs <= start_limit.min(480.0);
    if is_recap {
        return Some(IntroSegmentKind::Recap);
    }

    if !(8.0..=MAX_CHAPTER_INTRO_SECS).contains(&len_secs) {
        return None;
    }

    let explicit_intro = tokens
        .iter()
        .any(|t| t == "intro" || t == "introduction" || t == "opening" || is_op_token(t))
        || lower.contains("main title")
        || lower.contains("main titles")
        || lower.contains("title sequence")
        || lower.contains("theme song")
        || trimmed.contains("オープニング")
        || trimmed.contains("主題歌");

    if explicit_intro {
        // Avoid treating "Introduction" in a very long lecture/documentary without later chapters as a TV intro
        if tokens.iter().any(|t| t == "introduction") && !has_following_chapters && len_secs > 120.0
        {
            return None;
        }
        return Some(IntroSegmentKind::Intro);
    }

    // Ambiguous single words ("credits", "title", "titles", "theme") only count when inside opening
    // half-window, bounded to typical intro duration, and followed by real episode chapters.
    let soft_title = has_following_chapters
        && (10.0..=165.0).contains(&len_secs)
        && tokens
            .iter()
            .any(|t| t == "credits" || t == "title" || t == "titles" || t == "theme");
    if soft_title {
        return Some(IntroSegmentKind::Intro);
    }

    None
}

fn build_chapter_intervals(
    chapters: &[MpvChapter],
    duration_secs: f64,
) -> Vec<(Option<String>, f64, f64)> {
    if chapters.is_empty() {
        return Vec::new();
    }
    let mut sorted = chapters.to_vec();
    sorted.sort_by(|a, b| a.time.total_cmp(&b.time));

    let mut out = Vec::with_capacity(sorted.len());
    for i in 0..sorted.len() {
        let start = sorted[i].time.max(0.0);
        if !start.is_finite() {
            continue;
        }
        let end = if i + 1 < sorted.len() {
            sorted[i + 1].time
        } else if duration_secs.is_finite() && duration_secs > start {
            duration_secs
        } else {
            continue;
        };
        if end.is_finite() && end - start >= 1.0 {
            out.push((sorted[i].title.clone(), start, end));
        }
    }
    out
}

pub fn detect_intro_from_chapters(
    chapters: &[MpvChapter],
    duration_secs: f64,
) -> IntroDetectionOutcome {
    let intervals = build_chapter_intervals(chapters, duration_secs);
    if intervals.is_empty() {
        return IntroDetectionOutcome::empty();
    }

    let mut segments = Vec::new();
    for (idx, (title_opt, start, end)) in intervals.iter().enumerate() {
        let Some(ref title) = title_opt else {
            continue;
        };
        let has_following = idx + 1 < intervals.len();
        if let Some(kind) =
            classify_chapter_title(title, *start, end - start, duration_secs, has_following)
        {
            let label = match kind {
                IntroSegmentKind::Intro => "Skip Intro".to_string(),
                IntroSegmentKind::Recap => "Skip Recap".to_string(),
                IntroSegmentKind::Outro => "Next Episode".to_string(),
            };
            segments.push(DetectedIntro {
                start_secs: *start,
                end_secs: *end,
                skip_target_secs: *end,
                kind,
                source: IntroSource::Chapter,
                confidence: IntroConfidence::High,
                label,
                similarity: None,
                matched_episodes: 1,
            });
        }
    }

    let outro = detect_outro_from_chapters_intervals(&intervals, duration_secs);
    IntroDetectionOutcome::from_segments(segments).with_outro(outro)
}

fn is_explicit_outro_chapter_title(
    raw_title: &str,
    start_secs: f64,
    len_secs: f64,
    duration_secs: f64,
) -> bool {
    let trimmed = raw_title.trim();
    if trimmed.is_empty() || !(15.0..=480.0).contains(&len_secs) {
        return false;
    }
    if duration_secs.is_finite()
        && duration_secs > 0.0
        && start_secs < closing_start_min(duration_secs)
    {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    let tokens = tokenize_title(&lower);
    if tokens
        .iter()
        .any(|t| t == "preview" || t == "next" || t == "trailer")
        || lower.contains("next episode")
        || trimmed.contains("予告")
    {
        return false;
    }
    let explicit = tokens
        .iter()
        .any(|t| t == "outro" || t == "ending" || t == "closing" || is_ed_token(t))
        || lower.contains("end credits")
        || lower.contains("closing credits")
        || lower.contains("ending theme")
        || trimmed.contains("エンディング");
    if explicit {
        return true;
    }
    // Single word "credits" / "end" only in the final 35% of the video.
    let late_enough =
        !duration_secs.is_finite() || duration_secs <= 0.0 || start_secs >= duration_secs * 0.65;
    late_enough && tokens.iter().any(|t| t == "credits")
}

fn detect_outro_from_chapters_intervals(
    intervals: &[(Option<String>, f64, f64)],
    duration_secs: f64,
) -> Option<DetectedIntro> {
    for (title_opt, start, end) in intervals.iter().rev() {
        let Some(ref title) = title_opt else {
            continue;
        };
        if is_explicit_outro_chapter_title(title, *start, end - start, duration_secs) {
            return Some(DetectedIntro {
                start_secs: *start,
                end_secs: *end,
                skip_target_secs: *end,
                kind: IntroSegmentKind::Outro,
                source: IntroSource::Chapter,
                confidence: IntroConfidence::High,
                label: "Next Episode".to_string(),
                similarity: None,
                matched_episodes: 1,
            });
        }
    }
    None
}

/// Detects standalone episodic anime/TV structure from unnamed chapters (e.g. an ~85-95s opening
/// near the start, a long >=4m body chapter, and an ~80-105s ending near the end).
pub fn detect_intro_from_unnamed_chapter_structure(
    chapters: &[MpvChapter],
    duration_secs: f64,
    is_episodic: bool,
) -> IntroDetectionOutcome {
    if !is_episodic || !duration_secs.is_finite() || !(600.0..=3900.0).contains(&duration_secs) {
        return IntroDetectionOutcome::empty();
    }
    let intervals = build_chapter_intervals(chapters, duration_secs);
    if intervals.len() < 4 {
        return IntroDetectionOutcome::empty();
    }

    let early_limit = (duration_secs * 0.30).min(420.0);
    let late_min = duration_secs * 0.65;

    for (i, (_, op_start, op_end)) in intervals.iter().enumerate() {
        let op_len = op_end - op_start;
        if *op_start > early_limit || !(75.0..=105.0).contains(&op_len) {
            continue;
        }
        // Require the OP candidate to sit immediately before the episode body (or a <=15s
        // title card followed by the body) so a ~90s cold open ahead of the OP isn't picked.
        let next = intervals.get(i + 1);
        let after_next = intervals.get(i + 2);
        let precedes_body = next.is_some_and(|(_, bs, be)| *bs < late_min && (be - bs) >= 240.0)
            || (next.is_some_and(|(_, ts, te)| (te - ts) <= 15.0)
                && after_next.is_some_and(|(_, bs, be)| *bs < late_min && (be - bs) >= 240.0));
        if !precedes_body {
            continue;
        }
        if let Some(&(_, ed_start, ed_end)) = intervals.iter().skip(i + 1).find(|(_, es, ee)| {
            let ed_len = ee - es;
            *es >= late_min && (75.0..=115.0).contains(&ed_len)
        }) {
            return IntroDetectionOutcome::from_segments(vec![DetectedIntro {
                start_secs: *op_start,
                end_secs: *op_end,
                skip_target_secs: *op_end,
                kind: IntroSegmentKind::Intro,
                source: IntroSource::ChapterStructure,
                confidence: IntroConfidence::Medium,
                label: "Skip Intro".to_string(),
                similarity: None,
                matched_episodes: 1,
            }])
            .with_outro(Some(DetectedIntro {
                start_secs: ed_start,
                end_secs: ed_end,
                skip_target_secs: ed_end,
                kind: IntroSegmentKind::Outro,
                source: IntroSource::ChapterStructure,
                confidence: IntroConfidence::Medium,
                label: "Next Episode".to_string(),
                similarity: None,
                matched_episodes: 1,
            }));
        }
    }

    IntroDetectionOutcome::empty()
}

pub fn snap_interval_to_chapters(
    start_secs: f64,
    end_secs: f64,
    chapters: &[MpvChapter],
    duration_secs: f64,
) -> (f64, f64) {
    let intervals = build_chapter_intervals(chapters, duration_secs);
    if intervals.is_empty() {
        return (start_secs, end_secs);
    }

    let mut boundaries: Vec<f64> = Vec::with_capacity(intervals.len() + 1);
    for &(_, s, e) in &intervals {
        boundaries.push(s);
        boundaries.push(e);
    }

    let nearest_within = |target: f64, tol: f64| -> Option<f64> {
        boundaries
            .iter()
            .copied()
            .filter(|&b| (b - target).abs() <= tol)
            .min_by(|a, b| (a - target).abs().total_cmp(&(b - target).abs()))
    };

    let snapped_start = nearest_within(start_secs, 4.0).unwrap_or(start_secs);
    let snapped_end = nearest_within(end_secs, 4.0).unwrap_or(end_secs);
    let snapped_len = snapped_end - snapped_start;
    if snapped_end > snapped_start && (MIN_INTRO_SECS..=MAX_INTRO_SECS).contains(&snapped_len) {
        (snapped_start, snapped_end)
    } else {
        (start_secs, end_secs)
    }
}

fn is_ass_op_style_or_actor(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    let tokens = tokenize_title(&lower);
    if tokens.iter().any(|t| {
        t == "ed"
            || t == "ending"
            || t == "outro"
            || t == "sign"
            || t == "signs"
            || t == "default"
            || t == "dialogue"
            || t == "eyecatch"
            || t == "preview"
    }) {
        return false;
    }
    tokens
        .iter()
        .any(|t| is_op_token(t) || t == "opening" || t == "intro")
}

fn is_ass_ed_style_or_actor(raw: &str) -> bool {
    let lower = raw.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    let tokens = tokenize_title(&lower);
    if tokens.iter().any(|t| {
        t == "op"
            || t == "opening"
            || t == "intro"
            || t == "sign"
            || t == "signs"
            || t == "default"
            || t == "dialogue"
            || t == "eyecatch"
            || t == "preview"
    }) {
        return false;
    }
    tokens
        .iter()
        .any(|t| is_ed_token(t) || t == "ending" || t == "outro")
}

fn parse_ass_time_secs(raw: &str) -> Option<f64> {
    let parts: Vec<&str> = raw.trim().split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let s: f64 = parts[2].replace(',', ".").parse().ok()?;
    let total = h * 3600.0 + m * 60.0 + s;
    (total.is_finite() && total >= 0.0).then_some(total)
}

type AssCueSpans = (Option<(f64, f64)>, Option<(f64, f64)>);

fn detect_ass_cue_spans(raw_text: &str, duration_secs: f64) -> AssCueSpans {
    let start_limit = opening_start_limit(duration_secs);
    let end_min = closing_start_min(duration_secs);
    let mut in_events = false;
    let mut format_cols: Option<Vec<String>> = None;
    let mut op_spans: Vec<(f64, f64)> = Vec::new();
    let mut ed_spans: Vec<(f64, f64)> = Vec::new();

    for line in raw_text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            in_events = trimmed.eq_ignore_ascii_case("[Events]");
            continue;
        }
        if !in_events {
            continue;
        }
        if let Some(fmt_rest) = trimmed.strip_prefix("Format:") {
            format_cols = Some(
                fmt_rest
                    .split(',')
                    .map(|c| c.trim().to_ascii_lowercase())
                    .collect(),
            );
            continue;
        }
        let Some(diag_rest) = trimmed.strip_prefix("Dialogue:") else {
            continue;
        };
        let cols = format_cols.as_deref().unwrap_or(&[]);
        let col_count = if cols.is_empty() { 10 } else { cols.len() };
        let fields: Vec<&str> = diag_rest.splitn(col_count, ',').collect();
        if fields.len() < 5 {
            continue;
        }
        let find_col = |name: &str, default_idx: usize| -> Option<&str> {
            let idx = cols.iter().position(|c| c == name).unwrap_or(default_idx);
            fields.get(idx).map(|s| s.trim())
        };

        let Some(start) = find_col("start", 1).and_then(parse_ass_time_secs) else {
            continue;
        };
        let Some(end) = find_col("end", 2).and_then(parse_ass_time_secs) else {
            continue;
        };
        if end <= start {
            continue;
        }
        let style = find_col("style", 3).unwrap_or("");
        let name = find_col("name", 4).unwrap_or("");
        if start <= start_limit
            && (is_ass_op_style_or_actor(style) || is_ass_op_style_or_actor(name))
        {
            op_spans.push((start, end));
        } else if start >= end_min
            && (is_ass_ed_style_or_actor(style) || is_ass_ed_style_or_actor(name))
        {
            ed_spans.push((start, end));
        }
    }

    (
        cluster_cue_spans(&op_spans, 3, 15.0, 15.0, 155.0),
        cluster_cue_spans(&ed_spans, 3, 15.0, 15.0, 180.0),
    )
}

fn cluster_cue_spans(
    spans: &[(f64, f64)],
    min_cues: usize,
    max_gap_secs: f64,
    min_dur_secs: f64,
    max_dur_secs: f64,
) -> Option<(f64, f64)> {
    if spans.len() < min_cues {
        return None;
    }
    let mut sorted = spans.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));

    let mut best: Option<(usize, f64, f64)> = None;
    let mut cur_start = sorted[0].0;
    let mut cur_end = sorted[0].1;
    let mut count = 1usize;

    let mut consider = |cnt: usize, s: f64, e: f64| {
        let len = e - s;
        if cnt >= min_cues
            && (min_dur_secs..=max_dur_secs).contains(&len)
            && best.is_none_or(|(b_cnt, _, _)| cnt > b_cnt)
        {
            best = Some((cnt, s, e));
        }
    };

    for &(s, e) in sorted.iter().skip(1) {
        if s <= cur_end + max_gap_secs {
            cur_end = cur_end.max(e);
            count += 1;
        } else {
            consider(count, cur_start, cur_end);
            cur_start = s;
            cur_end = e;
            count = 1;
        }
    }
    consider(count, cur_start, cur_end);
    best.map(|(_, s, e)| (s, e))
}

fn is_explicit_opening_cue_text(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    lower.contains("opening theme")
        || lower.contains("opening song")
        || lower.contains("opening music")
        || lower.contains("opening credits")
        || lower.contains("theme song playing")
        || lower.contains("intro music")
        || lower.contains("intro theme")
}

fn is_explicit_ending_cue_text(text: &str) -> bool {
    let lower = text.trim().to_ascii_lowercase();
    lower.contains("ending theme")
        || lower.contains("ending song")
        || lower.contains("ending music")
        || lower.contains("ending credits")
        || lower.contains("closing theme")
        || lower.contains("closing song")
        || lower.contains("closing credits")
        || lower.contains("outro music")
        || lower.contains("outro theme")
        || lower.contains("end credits")
}

fn is_music_lyric_cue(cue: &SubtitleCue) -> bool {
    let t = cue.text.trim();
    !t.is_empty() && (t.contains('♪') || t.contains('♫'))
}

fn find_subtitle_span(
    cues: &[SubtitleCue],
    min_start: f64,
    max_start: f64,
    explicit_pred: fn(&str) -> bool,
) -> Option<(f64, f64, IntroConfidence)> {
    for cue in cues {
        let s = cue.start_ms as f64 / 1000.0;
        let e = cue.end_ms as f64 / 1000.0;
        if s >= min_start
            && s <= max_start
            && (MIN_INTRO_SECS..=155.0).contains(&(e - s))
            && explicit_pred(&cue.text)
        {
            return Some((s, e, IntroConfidence::Medium));
        }
    }

    let mut run_start = 0.0f64;
    let mut run_end = 0.0f64;
    let mut run_count = 0usize;
    for cue in cues {
        let s = cue.start_ms as f64 / 1000.0;
        let e = cue.end_ms as f64 / 1000.0;
        if s < min_start {
            continue;
        }
        if s > max_start {
            break;
        }
        if is_music_lyric_cue(cue) && (run_count == 0 || s <= run_end + 12.0) {
            if run_count == 0 {
                run_start = s;
            }
            run_end = run_end.max(e);
            run_count += 1;
        } else {
            if run_count >= 4 && (22.0..=150.0).contains(&(run_end - run_start)) {
                return Some((run_start, run_end, IntroConfidence::Medium));
            }
            if is_music_lyric_cue(cue) {
                run_start = s;
                run_end = e;
                run_count = 1;
            } else {
                run_count = 0;
            }
        }
    }
    if run_count >= 4 && (22.0..=150.0).contains(&(run_end - run_start)) {
        return Some((run_start, run_end, IntroConfidence::Medium));
    }
    None
}

fn make_outro_segment(
    start: f64,
    end: f64,
    source: IntroSource,
    confidence: IntroConfidence,
) -> DetectedIntro {
    DetectedIntro {
        start_secs: start,
        end_secs: end,
        skip_target_secs: end,
        kind: IntroSegmentKind::Outro,
        source,
        confidence,
        label: "Next Episode".to_string(),
        similarity: None,
        matched_episodes: 1,
    }
}

pub fn detect_intro_from_subtitle_text(
    raw_text: &str,
    ext_hint: Option<&str>,
    duration_secs: f64,
) -> IntroDetectionOutcome {
    let is_ass = ext_hint
        .map(|e| matches!(e.trim().to_ascii_lowercase().as_str(), "ass" | "ssa"))
        .unwrap_or_else(|| raw_text.contains("[Events]") && raw_text.contains("Dialogue:"));

    let mut ass_ed_outro: Option<DetectedIntro> = None;
    if is_ass {
        let (op_span, ed_span) = detect_ass_cue_spans(raw_text, duration_secs);
        if let Some((es, ee)) = ed_span {
            ass_ed_outro = Some(make_outro_segment(
                es,
                ee,
                IntroSource::SubtitleCue,
                IntroConfidence::High,
            ));
        }
        if let Some((start, end)) = op_span {
            return IntroDetectionOutcome::from_segments(vec![DetectedIntro {
                start_secs: start,
                end_secs: end,
                skip_target_secs: end,
                kind: IntroSegmentKind::Intro,
                source: IntroSource::SubtitleCue,
                confidence: IntroConfidence::High,
                label: "Skip Intro".to_string(),
                similarity: None,
                matched_episodes: 1,
            }])
            .with_outro(ass_ed_outro);
        }
    }

    let Ok(cues) = parse_subtitles(raw_text) else {
        return IntroDetectionOutcome::empty().with_outro(ass_ed_outro);
    };
    let start_limit = opening_start_limit(duration_secs);
    let end_min = closing_start_min(duration_secs);
    let max_end_pos = if duration_secs.is_finite() && duration_secs > 0.0 {
        duration_secs
    } else {
        f64::INFINITY
    };

    let intro_seg = find_subtitle_span(&cues, 0.0, start_limit, is_explicit_opening_cue_text).map(
        |(s, e, confidence)| DetectedIntro {
            start_secs: s,
            end_secs: e,
            skip_target_secs: e,
            kind: IntroSegmentKind::Intro,
            source: IntroSource::SubtitleCue,
            confidence,
            label: "Skip Intro".to_string(),
            similarity: None,
            matched_episodes: 1,
        },
    );

    let outro = ass_ed_outro.or_else(|| {
        find_subtitle_span(&cues, end_min, max_end_pos, is_explicit_ending_cue_text).map(
            |(s, e, confidence)| make_outro_segment(s, e, IntroSource::SubtitleCue, confidence),
        )
    });

    if let Some(intro) = intro_seg {
        IntroDetectionOutcome::from_segments(vec![intro]).with_outro(outro)
    } else {
        IntroDetectionOutcome::empty().with_outro(outro)
    }
}

/// Compact multi-band whitened spectral fingerprint at 8 fps (125 ms) for fast cross-episode
/// opening theme matching.
#[derive(Debug, Clone, PartialEq)]
pub struct SpectralIntroFingerprint {
    pub frames: Vec<[f32; INTRO_FP_BANDS]>,
    pub active: Vec<bool>,
}

impl SpectralIntroFingerprint {
    pub fn len(&self) -> usize {
        self.frames.len()
    }

    pub fn is_empty(&self) -> bool {
        self.frames.is_empty()
    }

    pub fn active_count(&self) -> usize {
        self.active.iter().filter(|&&a| a).count()
    }

    pub fn from_pcm_s16le_8k(pcm_bytes: &[u8]) -> Option<Self> {
        let total_samples = pcm_bytes.len() / 2;
        if total_samples < INTRO_FP_SAMPLE_RATE * 20 {
            return None;
        }
        let mut samples = Vec::with_capacity(total_samples);
        for chunk in pcm_bytes.chunks_exact(2) {
            let s = i16::from_le_bytes([chunk[0], chunk[1]]) as f32 / 32_768.0;
            samples.push(s);
        }
        Self::from_mono_8k_samples(&samples)
    }

    pub fn from_mono_8k_samples(samples: &[f32]) -> Option<Self> {
        if samples.len() < INTRO_FP_FFT_LEN + INTRO_FP_HOP_SAMPLES * 100 {
            return None;
        }
        let num_frames = (samples.len() - INTRO_FP_FFT_LEN) / INTRO_FP_HOP_SAMPLES + 1;
        if num_frames < 120 {
            return None;
        }

        // Precompute Hann window
        let mut hann = vec![0.0f64; INTRO_FP_FFT_LEN];
        for (n, w) in hann.iter_mut().enumerate() {
            let phase = 2.0 * std::f64::consts::PI * (n as f64) / ((INTRO_FP_FFT_LEN - 1) as f64);
            *w = 0.5 * (1.0 - phase.cos());
        }

        // 12 log-spaced frequency bands from 80 Hz to 3800 Hz (bin resolution = 8000 / 2048 = 3.90625 Hz)
        let f_min = 80.0f64;
        let f_max = 3800.0f64;
        let df = INTRO_FP_SAMPLE_RATE as f64 / INTRO_FP_FFT_LEN as f64;
        let mut band_bins = [(0usize, 0usize); INTRO_FP_BANDS];
        for (b, slot) in band_bins.iter_mut().enumerate() {
            let f0 = f_min * (f_max / f_min).powf(b as f64 / INTRO_FP_BANDS as f64);
            let f1 = f_min * (f_max / f_min).powf((b + 1) as f64 / INTRO_FP_BANDS as f64);
            let k0 = ((f0 / df).floor() as usize).max(1);
            let k1 = ((f1 / df).ceil() as usize).clamp(k0 + 1, INTRO_FP_FFT_LEN / 2);
            *slot = (k0, k1);
        }

        let mut raw_bands = vec![[0.0f64; INTRO_FP_BANDS]; num_frames];
        let mut frame_rms = vec![0.0f64; num_frames];
        let mut re = vec![0.0f64; INTRO_FP_FFT_LEN];
        let mut im = vec![0.0f64; INTRO_FP_FFT_LEN];

        for t in 0..num_frames {
            let start = t * INTRO_FP_HOP_SAMPLES;
            let mut sum_sq = 0.0f64;
            for i in 0..INTRO_FP_FFT_LEN {
                let s = samples[start + i] as f64;
                sum_sq += s * s;
                re[i] = s * hann[i];
                im[i] = 0.0;
            }
            frame_rms[t] = (sum_sq / INTRO_FP_FFT_LEN as f64).sqrt();
            fft_radix2(&mut re, &mut im, false);

            let mut band_mean_e = [0.0f64; INTRO_FP_BANDS];
            let mut total_band_e = 0.0f64;
            for (b, &(k0, k1)) in band_bins.iter().enumerate() {
                let mut e = 0.0f64;
                for k in k0..k1 {
                    e += re[k] * re[k] + im[k] * im[k];
                }
                let mean_e = e / ((k1 - k0) as f64);
                band_mean_e[b] = mean_e;
                total_band_e += mean_e;
            }
            // Volume-invariant floor + frame-mean subtraction removes arbitrary gain factor.
            let eps_floor = (total_band_e / INTRO_FP_BANDS as f64) * 1e-4 + 1e-18;
            let mut log_e = [0.0f64; INTRO_FP_BANDS];
            let mut band_sum = 0.0f64;
            for b in 0..INTRO_FP_BANDS {
                let lv = (band_mean_e[b] + eps_floor).ln();
                log_e[b] = lv;
                band_sum += lv;
            }
            let frame_mean = band_sum / INTRO_FP_BANDS as f64;
            for b in 0..INTRO_FP_BANDS {
                raw_bands[t][b] = log_e[b] - frame_mean;
            }
        }

        // Silence gating relative to non-zero episode median RMS
        let mut nonzero_rms: Vec<f64> = frame_rms.iter().copied().filter(|&r| r > 0.001).collect();
        if nonzero_rms.len() < 50 {
            return None;
        }
        nonzero_rms.sort_unstable_by(|a, b| a.total_cmp(b));
        let median_rms = nonzero_rms[nonzero_rms.len() / 2];
        let rms_thresh = (median_rms * 0.08).max(0.0035);
        let active: Vec<bool> = frame_rms.iter().map(|&r| r >= rms_thresh).collect();

        // Prefix sums over active frames for O(T * B) local 10s temporal whitening (suppresses rain/drones)
        let mut pref_band = vec![[0.0f64; INTRO_FP_BANDS]; num_frames + 1];
        let mut pref_cnt = vec![0usize; num_frames + 1];
        for t in 0..num_frames {
            pref_band[t + 1] = pref_band[t];
            pref_cnt[t + 1] = pref_cnt[t];
            if active[t] {
                pref_cnt[t + 1] += 1;
                for b in 0..INTRO_FP_BANDS {
                    pref_band[t + 1][b] += raw_bands[t][b];
                }
            }
        }
        let global_cnt = pref_cnt[num_frames];
        if global_cnt < 50 {
            return None;
        }
        let mut global_mean = [0.0f64; INTRO_FP_BANDS];
        for b in 0..INTRO_FP_BANDS {
            global_mean[b] = pref_band[num_frames][b] / global_cnt as f64;
        }

        const LOCAL_RADIUS: usize = 40; // +/- 5s at 8 fps
        let mut frames = vec![[0.0f32; INTRO_FP_BANDS]; num_frames];
        for t in 0..num_frames {
            if !active[t] {
                continue;
            }
            let lo = t.saturating_sub(LOCAL_RADIUS);
            let hi = (t + LOCAL_RADIUS + 1).min(num_frames);
            let win_cnt = pref_cnt[hi] - pref_cnt[lo];

            let mut norm_sq = 0.0f64;
            let mut vec_f = [0.0f64; INTRO_FP_BANDS];
            for b in 0..INTRO_FP_BANDS {
                let mu = if win_cnt >= 8 {
                    (pref_band[hi][b] - pref_band[lo][b]) / win_cnt as f64
                } else {
                    global_mean[b]
                };
                let val = raw_bands[t][b] - mu;
                vec_f[b] = val;
                norm_sq += val * val;
            }
            let norm = norm_sq.sqrt();
            if norm > 1e-6 {
                for b in 0..INTRO_FP_BANDS {
                    frames[t][b] = (vec_f[b] / norm) as f32;
                }
            }
        }

        Some(Self { frames, active })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PairwiseIntroMatch {
    pub a_start_secs: f64,
    pub a_end_secs: f64,
    pub b_start_secs: f64,
    pub b_end_secs: f64,
    pub mean_similarity: f64,
    pub kadane_score: f64,
    pub z_score: f64,
}

#[inline]
fn dot_frame(a: &[f32; INTRO_FP_BANDS], b: &[f32; INTRO_FP_BANDS]) -> f64 {
    let mut s = 0.0f64;
    for i in 0..INTRO_FP_BANDS {
        s += (a[i] as f64) * (b[i] as f64);
    }
    s
}

fn evaluate_lag_segment(
    fp_a: &SpectralIntroFingerprint,
    fp_b: &SpectralIntroFingerprint,
    lag_b_minus_a: isize,
    z_score_global: f64,
) -> Option<PairwiseIntroMatch> {
    let ta_len = fp_a.len();
    let tb_len = fp_b.len();
    let start_a = (-lag_b_minus_a).max(0) as usize;
    let end_a = ta_len.min((tb_len as isize - lag_b_minus_a).max(0) as usize);
    if end_a <= start_a + 80 {
        return None;
    }
    let len = end_a - start_a;
    let mut sim = Vec::with_capacity(len);
    let mut act = Vec::with_capacity(len);
    for k in 0..len {
        let ia = start_a + k;
        let ib = (ia as isize + lag_b_minus_a) as usize;
        let active_pair = fp_a.active[ia] && fp_b.active[ib];
        act.push(active_pair);
        sim.push(if active_pair {
            dot_frame(&fp_a.frames[ia], &fp_b.frames[ib])
        } else {
            0.0
        });
    }

    // Duplicate-file protection: if more than 55% of overlap matches continuously with >150s span,
    // two files are copies of the same episode rather than sharing an intro.
    let high_match_frames = sim.iter().filter(|&&v| v >= 0.48).count();

    const BIAS: f64 = 0.42;
    let mut best_sum = 0.0f64;
    let mut best_range: Option<(usize, usize)> = None;
    let mut cur_sum = 0.0f64;
    let mut cur_start = 0usize;
    let mut low_run = 0usize;

    for (k, &s) in sim.iter().enumerate() {
        if s < 0.24 {
            low_run += 1;
        } else {
            low_run = 0;
        }
        // Extra penalty after >= 2s of consecutive mismatch so distant bumpers never merge across gaps
        let step = if low_run >= 16 { -0.85 } else { s - BIAS };
        if cur_sum <= 0.0 {
            cur_sum = step;
            cur_start = k;
        } else {
            cur_sum += step;
        }
        if cur_sum > best_sum {
            best_sum = cur_sum;
            best_range = Some((cur_start, k));
        }
    }

    let (mut i0, mut i1) = best_range?;
    while i0 < i1 && (!act[i0] || sim[i0] < 0.42) {
        i0 += 1;
    }
    while i1 > i0 && (!act[i1] || sim[i1] < 0.42) {
        i1 -= 1;
    }
    // Trim weak edge tails where the local 2s window mean similarity sits below threshold
    let edge_win = 16usize;
    while i0 + edge_win <= i1 {
        let win_mean = sim[i0..i0 + edge_win].iter().sum::<f64>() / edge_win as f64;
        if win_mean >= 0.48 {
            break;
        }
        i0 += 1;
    }
    while i1 >= i0 + edge_win {
        let win_mean = sim[i1 + 1 - edge_win..=i1].iter().sum::<f64>() / edge_win as f64;
        if win_mean >= 0.48 {
            break;
        }
        i1 -= 1;
    }
    while i0 < i1 && (!act[i0] || sim[i0] < 0.42) {
        i0 += 1;
    }
    while i1 > i0 && (!act[i1] || sim[i1] < 0.42) {
        i1 -= 1;
    }
    if i1 <= i0 {
        return None;
    }

    let seg_frames = i1 - i0 + 1;
    let dur = seg_frames as f64 / INTRO_FP_FPS;
    if !(MIN_INTRO_SECS..=MAX_INTRO_SECS).contains(&dur) {
        return None;
    }
    if dur > 140.0 && (high_match_frames as f64) > 0.55 * (ta_len.min(tb_len) as f64) {
        return None;
    }

    let mut active_cnt = 0usize;
    let mut active_sim_sum = 0.0f64;
    for k in i0..=i1 {
        if act[k] {
            active_cnt += 1;
            active_sim_sum += sim[k];
        }
    }
    let active_frac = active_cnt as f64 / seg_frames as f64;
    if active_cnt < 56 || active_frac < 0.55 {
        return None;
    }

    let mean_sim = active_sim_sum / active_cnt as f64;
    let min_mean_sim = if dur < 22.0 { 0.52 } else { 0.44 };
    if mean_sim < min_mean_sim || best_sum < 16.0 {
        return None;
    }

    // Lag-peak sharpness check: rejects stationary drones, rain, pink noise, and room tone
    // whose similarity stays flat across neighboring lags (+/- 2s, +/- 3.5s).
    let mut max_neighbor_sim = f64::NEG_INFINITY;
    for shift in [-28isize, -16, 16, 28] {
        let n_lag = lag_b_minus_a + shift;
        let mut n_sum = 0.0f64;
        let mut n_cnt = 0usize;
        for k in i0..=i1 {
            let ia = start_a + k;
            let ib = ia as isize + n_lag;
            if ib >= 0 && (ib as usize) < tb_len {
                let ibu = ib as usize;
                if fp_a.active[ia] && fp_b.active[ibu] {
                    n_sum += dot_frame(&fp_a.frames[ia], &fp_b.frames[ibu]);
                }
                n_cnt += 1;
            }
        }
        if n_cnt >= active_cnt / 2 && n_cnt > 0 {
            let mean_n = n_sum / n_cnt as f64;
            if mean_n > max_neighbor_sim {
                max_neighbor_sim = mean_n;
            }
        }
    }
    if max_neighbor_sim.is_finite() && (mean_sim - max_neighbor_sim) < 0.16 {
        return None;
    }

    let mut a_start_idx = start_a + i0;
    let mut b_start_idx = (a_start_idx as isize + lag_b_minus_a) as usize;
    // Snap 0:00 fade-in silence cleanly to 0.0 if nothing active precedes the intro
    if a_start_idx <= (2.5 * INTRO_FP_FPS) as usize
        && !fp_a.active[..a_start_idx].iter().any(|&x| x)
    {
        a_start_idx = 0;
    }
    if b_start_idx <= (2.5 * INTRO_FP_FPS) as usize
        && !fp_b.active[..b_start_idx].iter().any(|&x| x)
    {
        b_start_idx = 0;
    }

    let a_end_idx = start_a + i1 + 1;
    let b_end_idx = (start_a as isize + i1 as isize + 1 + lag_b_minus_a) as usize;

    Some(PairwiseIntroMatch {
        a_start_secs: a_start_idx as f64 / INTRO_FP_FPS,
        a_end_secs: a_end_idx as f64 / INTRO_FP_FPS,
        b_start_secs: b_start_idx as f64 / INTRO_FP_FPS,
        b_end_secs: b_end_idx as f64 / INTRO_FP_FPS,
        mean_similarity: mean_sim,
        kadane_score: best_sum,
        z_score: z_score_global,
    })
}

pub fn match_intro_between_episodes(
    fp_a: &SpectralIntroFingerprint,
    fp_b: &SpectralIntroFingerprint,
) -> Option<PairwiseIntroMatch> {
    if fp_a.len() < 120 || fp_b.len() < 120 || fp_a.active_count() < 50 || fp_b.active_count() < 50
    {
        return None;
    }

    let ta = fp_a.len();
    let tb = fp_b.len();
    let min_overlap = 80isize; // 10s
    let min_lag = -(ta as isize - min_overlap);
    let max_lag = tb as isize - min_overlap;
    if min_lag > max_lag {
        return None;
    }

    let n_fft = (ta + tb + 4).next_power_of_two();
    let mut acc_re = vec![0.0f64; n_fft];
    let mut acc_im = vec![0.0f64; n_fft];
    let mut a_re = vec![0.0f64; n_fft];
    let mut a_im = vec![0.0f64; n_fft];
    let mut b_re = vec![0.0f64; n_fft];
    let mut b_im = vec![0.0f64; n_fft];

    for band in 0..INTRO_FP_BANDS {
        a_re.fill(0.0);
        a_im.fill(0.0);
        b_re.fill(0.0);
        b_im.fill(0.0);
        for (dst, frame) in a_re.iter_mut().zip(fp_a.frames.iter()).take(ta) {
            *dst = frame[band] as f64;
        }
        for (dst, frame) in b_re.iter_mut().zip(fp_b.frames.iter()).take(tb) {
            *dst = frame[band] as f64;
        }
        fft_radix2(&mut a_re, &mut a_im, false);
        fft_radix2(&mut b_re, &mut b_im, false);
        for k in 0..n_fft {
            // conj(FFT(A)) * FFT(B) -> index lag gives sum_t A[t] * B[t + lag]
            let ar = a_re[k];
            let ai = a_im[k];
            let br = b_re[k];
            let bi = b_im[k];
            acc_re[k] += ar * br + ai * bi;
            acc_im[k] += ar * bi - ai * br;
        }
    }
    fft_radix2(&mut acc_re, &mut acc_im, true);

    let mut lag_scores: Vec<(isize, f64)> = Vec::with_capacity((max_lag - min_lag + 1) as usize);
    for lag in min_lag..=max_lag {
        let idx = if lag >= 0 {
            lag as usize
        } else {
            (n_fft as isize + lag) as usize
        };
        lag_scores.push((lag, acc_re[idx]));
    }

    let mut ranked = lag_scores.clone();
    ranked.sort_unstable_by(|a, b| b.1.total_cmp(&a.1));

    let mut peak_lags: Vec<isize> = Vec::with_capacity(18);
    for &(lag, _) in &ranked {
        if peak_lags.iter().all(|&p| (p - lag).abs() >= 20) {
            peak_lags.push(lag);
            if peak_lags.len() == 16 {
                break;
            }
        }
    }
    if !peak_lags.iter().any(|&p| p.abs() < 4) {
        peak_lags.push(0);
    }

    let mut best: Option<PairwiseIntroMatch> = None;
    for peak in peak_lags {
        let raw_peak_score = lag_scores
            .get((peak - min_lag) as usize)
            .map(|x| x.1)
            .unwrap_or(0.0);
        let z_global = measure_background_z(&lag_scores, peak, raw_peak_score, 24);
        if z_global < 2.2 {
            continue;
        }
        for delta in -1isize..=1isize {
            let cand_lag = peak + delta;
            if cand_lag < min_lag || cand_lag > max_lag {
                continue;
            }
            if let Some(m) = evaluate_lag_segment(fp_a, fp_b, cand_lag, z_global) {
                if best
                    .as_ref()
                    .is_none_or(|b| m.kadane_score > b.kadane_score)
                {
                    best = Some(m);
                }
            }
        }
    }

    best
}

struct CrossEpisodeMatchResult {
    start_secs: f64,
    end_secs: f64,
    similarity: f64,
    matched_episodes: usize,
    confidence: IntroConfidence,
    sibling_ranges: Vec<(String, f64, f64, f64)>,
}

fn match_corroborated_across_episodes(
    target_fp: &SpectralIntroFingerprint,
    target_offset_secs: f64,
    siblings: &[(&str, &SpectralIntroFingerprint, f64)],
    target_chapters: &[MpvChapter],
    target_duration_secs: f64,
) -> Option<CrossEpisodeMatchResult> {
    let mut target_matches: Vec<(usize, PairwiseIntroMatch)> = Vec::new();

    for (idx, (_sib_path, sib_fp, _sib_off)) in siblings.iter().enumerate() {
        if let Some(m) = match_intro_between_episodes(target_fp, sib_fp) {
            target_matches.push((idx, m));
        }
    }

    if target_matches.is_empty() {
        return None;
    }

    // Check if sibling matches corroborate the same segment on target (within +/-4s or >=70% overlap)
    let mut agreeing_indices: HashSet<usize> = HashSet::new();
    let (raw_start, raw_end, sim, matched_eps, confidence) = if target_matches.len() >= 2 {
        let best = target_matches
            .iter()
            .max_by(|a, b| a.1.kadane_score.total_cmp(&b.1.kadane_score))
            .map(|x| &x.1)
            .unwrap();
        let agreeing: Vec<(usize, &PairwiseIntroMatch)> = target_matches
            .iter()
            .filter(|(_, m)| {
                let inter_s = m.a_start_secs.max(best.a_start_secs);
                let inter_e = m.a_end_secs.min(best.a_end_secs);
                let overlap = (inter_e - inter_s).max(0.0);
                let min_len = (m.a_end_secs - m.a_start_secs)
                    .min(best.a_end_secs - best.a_start_secs)
                    .max(1.0);
                overlap / min_len >= 0.70
            })
            .map(|(i, m)| (*i, m))
            .collect();

        if agreeing.len() >= 2 {
            for &(i, _) in &agreeing {
                agreeing_indices.insert(i);
            }
            let close_all = agreeing.iter().all(|(_, m)| {
                (m.a_start_secs - best.a_start_secs).abs() <= 4.0
                    && (m.a_end_secs - best.a_end_secs).abs() <= 4.0
            });
            let (cand_s, cand_e) = if close_all {
                let avg_s = agreeing.iter().map(|(_, m)| m.a_start_secs).sum::<f64>()
                    / agreeing.len() as f64;
                let avg_e =
                    agreeing.iter().map(|(_, m)| m.a_end_secs).sum::<f64>() / agreeing.len() as f64;
                (avg_s, avg_e)
            } else {
                // Tight intersection isolates the shared theme when one pair matched an adjacent tail
                let inter_s = agreeing
                    .iter()
                    .map(|(_, m)| m.a_start_secs)
                    .fold(f64::NEG_INFINITY, f64::max);
                let inter_e = agreeing
                    .iter()
                    .map(|(_, m)| m.a_end_secs)
                    .fold(f64::INFINITY, f64::min);
                if (inter_e - inter_s) >= MIN_INTRO_SECS {
                    (inter_s, inter_e)
                } else {
                    (best.a_start_secs, best.a_end_secs)
                }
            };
            let avg_sim = agreeing.iter().map(|(_, m)| m.mean_similarity).sum::<f64>()
                / agreeing.len() as f64;
            (
                cand_s,
                cand_e,
                avg_sim,
                agreeing.len() + 1,
                IntroConfidence::High,
            )
        } else {
            let best_idx = target_matches
                .iter()
                .max_by(|a, b| a.1.kadane_score.total_cmp(&b.1.kadane_score))
                .map(|x| x.0)
                .unwrap();
            agreeing_indices.insert(best_idx);
            let conf =
                if best.mean_similarity >= 0.62 && (best.a_end_secs - best.a_start_secs) >= 22.0 {
                    IntroConfidence::High
                } else {
                    IntroConfidence::Medium
                };
            (
                best.a_start_secs,
                best.a_end_secs,
                best.mean_similarity,
                2,
                conf,
            )
        }
    } else {
        agreeing_indices.insert(target_matches[0].0);
        let m = &target_matches[0].1;
        let dur = m.a_end_secs - m.a_start_secs;
        let conf = if m.mean_similarity >= 0.62 && dur >= 22.0 {
            IntroConfidence::High
        } else {
            IntroConfidence::Medium
        };
        (m.a_start_secs, m.a_end_secs, m.mean_similarity, 2, conf)
    };

    let mut sibling_ranges: Vec<(String, f64, f64, f64)> = Vec::with_capacity(target_matches.len());
    for (idx, m) in &target_matches {
        let (sib_path, _, sib_offset) = siblings[*idx];
        let (sib_s, sib_e) = if agreeing_indices.contains(idx) {
            let s = (m.b_start_secs + (raw_start - m.a_start_secs)).max(0.0);
            let e = m.b_end_secs + (raw_end - m.a_end_secs);
            if e - s >= MIN_INTRO_SECS {
                (s, e)
            } else {
                (m.b_start_secs, m.b_end_secs)
            }
        } else {
            (m.b_start_secs, m.b_end_secs)
        };
        sibling_ranges.push((
            sib_path.to_string(),
            sib_offset + sib_s,
            sib_offset + sib_e,
            m.mean_similarity,
        ));
    }

    let (start_secs, end_secs) = snap_interval_to_chapters(
        target_offset_secs + raw_start,
        target_offset_secs + raw_end,
        target_chapters,
        target_duration_secs,
    );

    Some(CrossEpisodeMatchResult {
        start_secs,
        end_secs,
        similarity: sim,
        matched_episodes: matched_eps,
        confidence,
        sibling_ranges,
    })
}

pub fn detect_intro_across_episodes(
    target_fp: &SpectralIntroFingerprint,
    siblings: &[(&str, &SpectralIntroFingerprint)],
    target_chapters: &[MpvChapter],
    target_duration_secs: f64,
) -> (IntroDetectionOutcome, Vec<(String, f64, f64, f64)>) {
    let wrapped: Vec<(&str, &SpectralIntroFingerprint, f64)> =
        siblings.iter().map(|&(p, fp)| (p, fp, 0.0)).collect();
    let Some(res) = match_corroborated_across_episodes(
        target_fp,
        0.0,
        &wrapped,
        target_chapters,
        target_duration_secs,
    ) else {
        return (IntroDetectionOutcome::empty(), Vec::new());
    };
    let outcome = IntroDetectionOutcome::from_segments(vec![DetectedIntro {
        start_secs: res.start_secs,
        end_secs: res.end_secs,
        skip_target_secs: res.end_secs,
        kind: IntroSegmentKind::Intro,
        source: IntroSource::AudioMatch,
        confidence: res.confidence,
        label: "Skip Intro".to_string(),
        similarity: Some(res.similarity),
        matched_episodes: res.matched_episodes,
    }]);
    (outcome, res.sibling_ranges)
}

pub type SiblingOutroSpan = (String, f64, f64, f64);

pub fn detect_outro_across_episodes(
    target_fp: &SpectralIntroFingerprint,
    target_offset_secs: f64,
    siblings: &[(&str, &SpectralIntroFingerprint, f64)],
    target_chapters: &[MpvChapter],
    target_duration_secs: f64,
) -> (Option<DetectedIntro>, Vec<SiblingOutroSpan>) {
    let Some(res) = match_corroborated_across_episodes(
        target_fp,
        target_offset_secs,
        siblings,
        target_chapters,
        target_duration_secs,
    ) else {
        return (None, Vec::new());
    };
    if res.start_secs < closing_start_min(target_duration_secs) {
        return (None, Vec::new());
    }
    let outro = DetectedIntro {
        start_secs: res.start_secs,
        end_secs: res.end_secs,
        skip_target_secs: res.end_secs,
        kind: IntroSegmentKind::Outro,
        source: IntroSource::AudioMatch,
        confidence: res.confidence,
        label: "Next Episode".to_string(),
        similarity: Some(res.similarity),
        matched_episodes: res.matched_episodes,
    };
    (Some(outro), res.sibling_ranges)
}

pub fn pick_sibling_episode_paths(
    active_path: &str,
    playlist_paths: &[String],
    max_siblings: usize,
) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let active_key = active_path.trim().to_ascii_lowercase();
    seen.insert(active_key.clone());

    let active_idx = playlist_paths
        .iter()
        .position(|p| p.trim().to_ascii_lowercase() == active_key);

    let mut ordered: Vec<String> = Vec::new();
    if let Some(idx) = active_idx {
        // Interleave nearby episodes: +1, -1, +2, -2...
        for offset in 1..playlist_paths.len() {
            if idx + offset < playlist_paths.len() {
                ordered.push(playlist_paths[idx + offset].clone());
            }
            if idx >= offset {
                ordered.push(playlist_paths[idx - offset].clone());
            }
        }
    } else {
        ordered.extend(playlist_paths.iter().cloned());
    }

    let mut picked = Vec::with_capacity(max_siblings);
    for path in ordered {
        let key = path.trim().to_ascii_lowercase();
        if !key.is_empty() && seen.insert(key) {
            picked.push(path);
            if picked.len() >= max_siblings {
                break;
            }
        }
    }
    picked
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chap(title: Option<&str>, time: f64) -> MpvChapter {
        MpvChapter {
            title: title.map(str::to_string),
            time,
        }
    }

    fn synth_theme_samples(
        seed: u64,
        dur_secs: usize,
        sample_rate: usize,
        amplitude: f32,
    ) -> Vec<f32> {
        // Rich musical motif: chord progression + melodic notes changing every 0.35s
        let note_freqs = [
            220.0f32, 261.63, 293.66, 329.63, 392.0, 440.0, 493.88, 523.25, 587.33, 659.25,
        ];
        let total = dur_secs * sample_rate;
        let mut out = Vec::with_capacity(total);
        let mut rng = seed ^ 0x9E37_79B9_7F4A_7C15;
        let mut step_freqs = [220.0f32; 3];
        let step_len = (sample_rate as f32 * 0.35) as usize;

        for i in 0..total {
            if i % step_len == 0 {
                for slot in &mut step_freqs {
                    rng = rng
                        .wrapping_mul(6364136223846793005)
                        .wrapping_add(1442695040888963407);
                    let idx = ((rng >> 33) as usize) % note_freqs.len();
                    *slot = note_freqs[idx];
                }
            }
            let t = i as f32 / sample_rate as f32;
            let env = 0.65 + 0.35 * (2.0 * std::f32::consts::PI * 2.8 * t).sin();
            let val = (2.0 * std::f32::consts::PI * step_freqs[0] * t).sin() * 0.45
                + (2.0 * std::f32::consts::PI * step_freqs[1] * 1.5 * t).sin() * 0.32
                + (2.0 * std::f32::consts::PI * step_freqs[2] * 2.0 * t).sin() * 0.23;
            out.push(val * env * amplitude);
        }
        out
    }

    fn synth_dialogue_samples(seed: u64, dur_secs: usize, sample_rate: usize) -> Vec<f32> {
        // Speech-like intermittent bursts with pauses & varied formants (distinct per seed)
        let total = dur_secs * sample_rate;
        let mut out = vec![0.0f32; total];
        let mut rng = seed ^ 0xBF58_476D_1CE4_E5B9;
        let mut pos = 0usize;
        while pos < total {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let burst_len = (sample_rate / 3) + (((rng >> 32) as usize) % (sample_rate * 2));
            let pause_len = (sample_rate / 4) + (((rng >> 40) as usize) % sample_rate);
            let f0 = 110.0 + (((rng >> 24) % 180) as f32);
            let f1 = 500.0 + (((rng >> 16) % 900) as f32);
            let end = (pos + burst_len).min(total);
            for (offset, sample) in out[pos..end].iter_mut().enumerate() {
                let t = (pos + offset) as f32 / sample_rate as f32;
                *sample = 0.25
                    * ((2.0 * std::f32::consts::PI * f0 * t).sin() * 0.6
                        + (2.0 * std::f32::consts::PI * f1 * t).sin() * 0.4);
            }
            pos = end + pause_len;
        }
        out
    }

    fn synth_rain_drone(seed: u64, dur_secs: usize, sample_rate: usize) -> Vec<f32> {
        let total = dur_secs * sample_rate;
        let mut out = Vec::with_capacity(total);
        let mut rng = seed ^ 0x94D0_49BB_1331_11EB;
        for _ in 0..total {
            rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1);
            let white = (((rng >> 32) as u32) as f32 / (u32::MAX as f32)) * 2.0 - 1.0;
            out.push(white * 0.18);
        }
        out
    }

    fn build_episode_audio(
        cold_open_seed: u64,
        cold_open_secs: usize,
        intro_theme: &[f32],
        body_seed: u64,
        total_secs: usize,
    ) -> Vec<f32> {
        let mut buf = Vec::with_capacity(total_secs * INTRO_FP_SAMPLE_RATE);
        if cold_open_secs > 0 {
            buf.extend_from_slice(&synth_dialogue_samples(
                cold_open_seed,
                cold_open_secs,
                INTRO_FP_SAMPLE_RATE,
            ));
        }
        buf.extend_from_slice(intro_theme);
        let used = buf.len() / INTRO_FP_SAMPLE_RATE;
        if total_secs > used {
            buf.extend_from_slice(&synth_dialogue_samples(
                body_seed,
                total_secs - used,
                INTRO_FP_SAMPLE_RATE,
            ));
        }
        buf.truncate(total_secs * INTRO_FP_SAMPLE_RATE);
        buf
    }

    #[test]
    fn test_chapter_detection_handles_op_recap_and_rejects_false_positives() {
        let chaps = vec![
            chap(Some("Recap"), 0.0),
            chap(Some("OP 1"), 32.0),
            chap(Some("Part A: Open Door"), 122.0),
            chap(Some("Top Secret"), 720.0),
            chap(Some("Ending"), 1320.0),
        ];
        let res = detect_intro_from_chapters(&chaps, 1420.0);
        assert_eq!(res.segments.len(), 2);
        assert_eq!(res.segments[0].kind, IntroSegmentKind::Recap);
        assert_eq!(res.segments[0].start_secs, 0.0);
        assert_eq!(res.segments[0].end_secs, 32.0);
        // Contiguous Recap + Intro skips both to 122.0!
        assert_eq!(res.segments[0].skip_target_secs, 122.0);
        assert_eq!(res.segments[0].label, "Skip Recap & Intro");

        let primary = res.primary_intro.unwrap();
        assert_eq!(primary.kind, IntroSegmentKind::Intro);
        assert_eq!(primary.start_secs, 32.0);
        assert_eq!(primary.end_secs, 122.0);
        assert_eq!(primary.source, IntroSource::Chapter);

        // False positive test: "Open Door", "Top Secret", "End Credits" must NOT match
        let movie_chaps = vec![
            chap(Some("Open Door"), 0.0),
            chap(Some("Top Secret"), 90.0),
            chap(Some("Operation Storm"), 180.0),
            chap(Some("End Credits"), 5000.0),
        ];
        assert!(detect_intro_from_chapters(&movie_chaps, 5400.0)
            .primary_intro
            .is_none());
    }

    #[test]
    fn test_unnamed_chapter_structure_detects_anime_op_ed_and_rejects_uniform_chapters() {
        let anime_chaps = vec![
            chap(Some("Chapter 01"), 0.0),
            chap(Some("Chapter 02"), 95.0),
            chap(Some("Chapter 03"), 185.0), // 90s OP!
            chap(Some("Chapter 04"), 780.0),
            chap(Some("Chapter 05"), 1320.0), // 90s ED!
            chap(Some("Chapter 06"), 1410.0),
        ];
        let res = detect_intro_from_unnamed_chapter_structure(&anime_chaps, 1440.0, true);
        let p = res
            .primary_intro
            .expect("should detect OP from OP+ED structure");
        assert_eq!(p.start_secs, 95.0);
        assert_eq!(p.end_secs, 185.0);
        assert_eq!(p.source, IntroSource::ChapterStructure);

        // Uniform 90s chapters without a >=240s body chapter must NOT trigger
        let uniform: Vec<MpvChapter> = (0..16)
            .map(|i| chap(Some(&format!("Chapter {}", i + 1)), i as f64 * 90.0))
            .collect();
        assert!(
            detect_intro_from_unnamed_chapter_structure(&uniform, 1440.0, true)
                .primary_intro
                .is_none()
        );
    }

    #[test]
    fn test_subtitle_intro_detection_ass_and_srt() {
        let ass = "\
[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:12.00,0:00:15.00,Default,,0,0,0,,Cold open line
Dialogue: 0,0:01:10.00,0:01:28.00,OP-Romaji,,0,0,0,,First lyric line
Dialogue: 0,0:01:30.00,0:01:55.00,OP-Romaji,,0,0,0,,Second lyric line
Dialogue: 0,0:01:58.00,0:02:38.00,OP-Romaji,,0,0,0,,Final lyric line
Dialogue: 0,0:03:00.00,0:03:05.00,Default,,0,0,0,,Back to episode
Dialogue: 0,0:21:30.00,0:22:55.00,ED-Romaji,,0,0,0,,Ending lyric
";
        let res = detect_intro_from_subtitle_text(ass, Some("ass"), 1440.0);
        let intro = res.primary_intro.expect("ASS OP style detected");
        assert_eq!(intro.source, IntroSource::SubtitleCue);
        assert!((intro.start_secs - 70.0).abs() < 0.01);
        assert!((intro.end_secs - 158.0).abs() < 0.01);

        let srt = "\
1
00:00:05,000 --> 00:00:08,000
Wait for it...

2
00:00:40,000 --> 00:01:26,000
[Opening theme playing]

3
00:01:30,000 --> 00:01:34,000
Hello!
";
        let srt_res = detect_intro_from_subtitle_text(srt, Some("srt"), 1400.0);
        let srt_intro = srt_res
            .primary_intro
            .expect("SRT explicit opening cue detected");
        assert!((srt_intro.start_secs - 40.0).abs() < 0.01);
        assert!((srt_intro.end_secs - 86.0).abs() < 0.01);
    }

    #[test]
    fn test_cross_episode_audio_fingerprinting_handles_shifted_cold_opens_and_volume() {
        let theme_a = synth_theme_samples(42, 85, INTRO_FP_SAMPLE_RATE, 0.45);
        // Same theme scaled down by 0.35x in Episode 2 & shifted by a 92s cold open!
        let theme_b: Vec<f32> = theme_a.iter().map(|&s| s * 0.35).collect();

        let ep1 = build_episode_audio(101, 18, &theme_a, 201, 300); // intro: 18s .. 103s
        let ep2 = build_episode_audio(102, 92, &theme_b, 202, 300); // intro: 92s .. 177s
        let ep3 = build_episode_audio(103, 55, &theme_a, 203, 300); // intro: 55s .. 140s

        let fp1 = SpectralIntroFingerprint::from_mono_8k_samples(&ep1).unwrap();
        let fp2 = SpectralIntroFingerprint::from_mono_8k_samples(&ep2).unwrap();
        let fp3 = SpectralIntroFingerprint::from_mono_8k_samples(&ep3).unwrap();

        let (outcome, sibs) = detect_intro_across_episodes(
            &fp1,
            &[("ep2.mkv", &fp2), ("ep3.mkv", &fp3)],
            &[],
            1400.0,
        );
        let intro = outcome.primary_intro.expect("should detect shared intro");
        assert_eq!(intro.source, IntroSource::AudioMatch);
        assert_eq!(intro.confidence, IntroConfidence::High);
        assert_eq!(intro.matched_episodes, 3);
        assert!(
            (intro.start_secs - 18.0).abs() <= 2.0,
            "expected ~18s start, got {}",
            intro.start_secs
        );
        assert!(
            (intro.end_secs - 103.0).abs() <= 2.0,
            "expected ~103s end, got {}",
            intro.end_secs
        );
        assert_eq!(sibs.len(), 2);
        assert!((sibs[0].1 - 92.0).abs() <= 2.0);
        assert!((sibs[0].2 - 177.0).abs() <= 2.0);
        assert!((sibs[1].1 - 55.0).abs() <= 2.0);
        assert!((sibs[1].2 - 140.0).abs() <= 2.0);
    }

    #[test]
    fn test_cross_episode_audio_snaps_to_unnamed_chapters_and_ignores_short_bumper() {
        let bumper = synth_theme_samples(7, 5, INTRO_FP_SAMPLE_RATE, 0.5);
        let theme = synth_theme_samples(88, 86, INTRO_FP_SAMPLE_RATE, 0.4);

        // Both episodes start with a 5s studio bumper at 0:00, then different cold opens, then 86s intro
        let mut ep1 = Vec::new();
        ep1.extend_from_slice(&bumper);
        ep1.extend_from_slice(&synth_dialogue_samples(11, 35, INTRO_FP_SAMPLE_RATE)); // 5..40
        ep1.extend_from_slice(&theme); // 40..126
        ep1.extend_from_slice(&synth_dialogue_samples(12, 160, INTRO_FP_SAMPLE_RATE));

        let mut ep2 = Vec::new();
        ep2.extend_from_slice(&bumper);
        ep2.extend_from_slice(&synth_dialogue_samples(21, 70, INTRO_FP_SAMPLE_RATE)); // 5..75
        ep2.extend_from_slice(&theme); // 75..161
        ep2.extend_from_slice(&synth_dialogue_samples(22, 130, INTRO_FP_SAMPLE_RATE));

        let fp1 = SpectralIntroFingerprint::from_mono_8k_samples(&ep1).unwrap();
        let fp2 = SpectralIntroFingerprint::from_mono_8k_samples(&ep2).unwrap();

        let unnamed_chaps = vec![
            chap(Some("Chapter 1"), 0.0),
            chap(Some("Chapter 2"), 40.125),
            chap(Some("Chapter 3"), 126.25),
        ];

        let (outcome, _) =
            detect_intro_across_episodes(&fp1, &[("ep2.mkv", &fp2)], &unnamed_chaps, 1400.0);
        let intro = outcome
            .primary_intro
            .expect("must pick 86s intro over 5s bumper");
        assert!((intro.start_secs - 40.125).abs() < 0.01);
        assert!((intro.end_secs - 126.25).abs() < 0.01);
    }

    #[test]
    fn test_cross_episode_audio_rejects_unrelated_movies_rain_drones_and_duplicates() {
        // 1. Unrelated episodes/movies
        let mov1 = synth_dialogue_samples(1001, 240, INTRO_FP_SAMPLE_RATE);
        let mov2 = synth_dialogue_samples(2002, 240, INTRO_FP_SAMPLE_RATE);
        let fp_m1 = SpectralIntroFingerprint::from_mono_8k_samples(&mov1).unwrap();
        let fp_m2 = SpectralIntroFingerprint::from_mono_8k_samples(&mov2).unwrap();
        assert!(match_intro_between_episodes(&fp_m1, &fp_m2).is_none());

        // 2. Stationary rain / noise scenes across two unrelated movies
        let mut rain1 = synth_dialogue_samples(301, 30, INTRO_FP_SAMPLE_RATE);
        rain1.extend_from_slice(&synth_rain_drone(11, 70, INTRO_FP_SAMPLE_RATE));
        rain1.extend_from_slice(&synth_dialogue_samples(302, 120, INTRO_FP_SAMPLE_RATE));

        let mut rain2 = synth_dialogue_samples(401, 50, INTRO_FP_SAMPLE_RATE);
        rain2.extend_from_slice(&synth_rain_drone(22, 70, INTRO_FP_SAMPLE_RATE));
        rain2.extend_from_slice(&synth_dialogue_samples(402, 100, INTRO_FP_SAMPLE_RATE));

        let fp_r1 = SpectralIntroFingerprint::from_mono_8k_samples(&rain1).unwrap();
        let fp_r2 = SpectralIntroFingerprint::from_mono_8k_samples(&rain2).unwrap();
        assert!(
            match_intro_between_episodes(&fp_r1, &fp_r2).is_none(),
            "stationary rain/noise must not trigger false intro match"
        );

        // 3. Duplicate file (identical 240s audio) must NOT report a fake intro
        let dup = build_episode_audio(
            501,
            20,
            &synth_theme_samples(501, 80, INTRO_FP_SAMPLE_RATE, 0.4),
            502,
            240,
        );
        let fp_dup = SpectralIntroFingerprint::from_mono_8k_samples(&dup).unwrap();
        assert!(
            match_intro_between_episodes(&fp_dup, &fp_dup).is_none(),
            "identical audio copy must not be misclassified as an intro"
        );
    }

    #[test]
    fn test_outro_detection_across_chapters_unnamed_subtitles_and_audio() {
        // 1. Named chapters return outro cleanly alongside intro/recap
        let chaps = vec![
            chap(Some("OP 1"), 30.0),
            chap(Some("Part A"), 120.0),
            chap(Some("Ending"), 1320.0),
            chap(Some("Next Episode Preview"), 1410.0),
        ];
        let chap_res = detect_intro_from_chapters(&chaps, 1440.0);
        let chap_outro = chap_res.outro.expect("named Ending chapter detected");
        assert_eq!(chap_outro.kind, IntroSegmentKind::Outro);
        assert_eq!(chap_outro.start_secs, 1320.0);
        assert_eq!(chap_outro.end_secs, 1410.0);

        // 2. Unnamed anime OP+Body+ED chapters detect ED cleanly
        let unnamed = vec![
            chap(Some("Chapter 01"), 0.0),
            chap(Some("Chapter 02"), 90.0),
            chap(Some("Chapter 03"), 180.0),
            chap(Some("Chapter 04"), 780.0),
            chap(Some("Chapter 05"), 1320.0),
            chap(Some("Chapter 06"), 1410.0),
        ];
        let unnamed_res = detect_intro_from_unnamed_chapter_structure(&unnamed, 1440.0, true);
        let unnamed_outro = unnamed_res.outro.expect("unnamed ED structure detected");
        assert_eq!(unnamed_outro.kind, IntroSegmentKind::Outro);
        assert_eq!(unnamed_outro.start_secs, 1320.0);
        assert_eq!(unnamed_outro.end_secs, 1410.0);

        // 3. ASS ED-Romaji subtitle cue cluster
        let ass = "\
[Script Info]
ScriptType: v4.00+

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:01:10.00,0:01:28.00,OP-Romaji,,0,0,0,,OP line 1
Dialogue: 0,0:01:30.00,0:01:55.00,OP-Romaji,,0,0,0,,OP line 2
Dialogue: 0,0:01:58.00,0:02:38.00,OP-Romaji,,0,0,0,,OP line 3
Dialogue: 0,0:21:30.00,0:21:55.00,ED-Romaji,,0,0,0,,ED line 1
Dialogue: 0,0:21:58.00,0:22:25.00,ED-Romaji,,0,0,0,,ED line 2
Dialogue: 0,0:22:28.00,0:22:55.00,ED-Romaji,,0,0,0,,ED line 3
";
        let sub_res = detect_intro_from_subtitle_text(ass, Some("ass"), 1440.0);
        let sub_outro = sub_res.outro.expect("ASS ED style detected");
        assert!((sub_outro.start_secs - 1290.0).abs() < 0.01);
        assert!((sub_outro.end_secs - 1375.0).abs() < 0.01);

        // 4. Cross-episode tail audio matching shifted by offset
        let ed_theme = synth_theme_samples(77, 85, INTRO_FP_SAMPLE_RATE, 0.42);
        let tail_a = build_episode_audio(701, 40, &ed_theme, 702, 220); // offset 1100 -> ED 1140..1225
        let tail_b = build_episode_audio(801, 75, &ed_theme, 802, 220); // offset 1120 -> ED 1195..1280
        let fp_a = SpectralIntroFingerprint::from_mono_8k_samples(&tail_a).unwrap();
        let fp_b = SpectralIntroFingerprint::from_mono_8k_samples(&tail_b).unwrap();
        let (audio_outro, _) =
            detect_outro_across_episodes(&fp_a, 1100.0, &[("ep2.mkv", &fp_b, 1120.0)], &[], 1360.0);
        let found = audio_outro.expect("cross-episode ED detected");
        assert_eq!(found.kind, IntroSegmentKind::Outro);
        assert!((found.start_secs - 1140.0).abs() <= 2.5);
        assert!((found.end_secs - 1225.0).abs() <= 2.5);
    }
}
