use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum MpvParseError {
    #[error("Invalid JSON from mpv IPC: {0}")]
    InvalidJson(String),
    #[error("Unrecognized mpv IPC message")]
    Unrecognized,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvTrack {
    pub id: u64,
    #[serde(rename = "type")]
    pub kind: String,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub codec: Option<String>,
    pub selected: bool,
    pub external: bool,
    #[serde(default, rename = "default")]
    pub is_default: bool,
    #[serde(default)]
    pub forced: bool,
    #[serde(default, rename = "ff-index", skip_serializing_if = "Option::is_none")]
    pub ff_index: Option<u64>,
    #[serde(
        default,
        rename = "external-filename",
        skip_serializing_if = "Option::is_none"
    )]
    pub external_filename: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvChapter {
    pub title: Option<String>,
    pub time: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MpvEvent {
    TimePos(f64),
    Duration(f64),
    Paused(bool),
    PausedForCache(bool),
    EofReached(bool),
    VoConfigured(bool),
    VideoReconfig,
    Seek,
    PlaybackRestart,
    Seeking(bool),
    FileLoaded,
    EndFile {
        reason: Option<String>,
        file_error: Option<String>,
    },
    TrackList(Vec<MpvTrack>),
    ChapterList(Vec<MpvChapter>),
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MpvReply {
    pub request_id: u64,
    pub error: String,
    pub data: Option<Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MpvMessage {
    Event(MpvEvent),
    Reply(MpvReply),
}

pub fn encode_command(request_id: u64, args: &[Value]) -> String {
    let payload = json!({
        "command": args,
        "request_id": request_id,
    });
    format!("{payload}\n")
}

pub fn encode_observe(request_id: u64, observe_id: u64, property: &str) -> String {
    encode_command(
        request_id,
        &[
            json!("observe_property"),
            json!(observe_id),
            json!(property),
        ],
    )
}

pub fn loadfile_cmd(request_id: u64, path: &str) -> String {
    encode_command(
        request_id,
        &[json!("loadfile"), json!(path), json!("replace")],
    )
}

pub fn set_pause_cmd(request_id: u64, paused: bool) -> String {
    encode_command(
        request_id,
        &[json!("set_property"), json!("pause"), json!(paused)],
    )
}

fn encode_seek_cmd(request_id: u64, seconds: f64, flags: &str) -> String {
    let clamped = if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    };
    encode_command(request_id, &[json!("seek"), json!(clamped), json!(flags)])
}

pub fn seek_absolute_cmd(request_id: u64, seconds: f64) -> String {
    encode_seek_cmd(request_id, seconds, "absolute+exact")
}

/// Fast keyframe-only seek for live scrubber dragging before the final exact commit.
pub fn seek_keyframes_cmd(request_id: u64, seconds: f64) -> String {
    encode_seek_cmd(request_id, seconds, "absolute+keyframes")
}

/// Captures an uncropped, UI-chrome-free video frame directly to a temporary image file.
/// (`mpv` JSON IPC cannot serialize `screenshot-raw`'s byte array, whereas `screenshot-to-file`
/// writes a fast sRGB JPEG cleanly in ~34ms with subtitles preserved.)
pub fn screenshot_to_file_cmd(request_id: u64, path: &str, include_subtitles: bool) -> String {
    let mode = if include_subtitles {
        "subtitles"
    } else {
        "video"
    };
    encode_command(
        request_id,
        &[json!("screenshot-to-file"), json!(path), json!(mode)],
    )
}

pub fn set_property_cmd(request_id: u64, name: &str, value: Value) -> String {
    encode_command(request_id, &[json!("set_property"), json!(name), value])
}

pub fn set_volume_cmd(request_id: u64, volume: f64) -> String {
    let clamped = if volume.is_finite() {
        volume.clamp(0.0, 130.0)
    } else {
        100.0
    };
    set_property_cmd(request_id, "volume", json!(clamped))
}

pub fn set_mute_cmd(request_id: u64, muted: bool) -> String {
    set_property_cmd(request_id, "mute", json!(muted))
}

pub fn set_speed_cmd(request_id: u64, speed: f64) -> String {
    let clamped = if speed.is_finite() {
        speed.clamp(0.25, 4.0)
    } else {
        1.0
    };
    set_property_cmd(request_id, "speed", json!(clamped))
}

pub fn set_loop_cmd(request_id: u64, looping: bool) -> String {
    let val = if looping { "inf" } else { "no" };
    set_property_cmd(request_id, "loop-file", json!(val))
}

pub fn set_aspect_cmd(request_id: u64, aspect: &str) -> String {
    let normalized = match aspect.trim() {
        "16:9" => "16:9",
        "4:3" => "4:3",
        "21:9" => "21:9",
        _ => "-1",
    };
    set_property_cmd(request_id, "video-aspect-override", json!(normalized))
}

pub fn set_aspect_mode_cmds(first_request_id: u64, aspect: &str) -> Vec<String> {
    let is_fill = aspect.trim() == "fill";
    let panscan = if is_fill { 1.0 } else { 0.0 };
    vec![
        set_property_cmd(first_request_id, "panscan", json!(panscan)),
        set_aspect_cmd(first_request_id + 1, aspect),
    ]
}

pub fn set_dialogue_boost_cmd(request_id: u64, enabled: bool) -> String {
    let filter = if enabled {
        "lavfi=[dynaudnorm=f=150:g=15:p=0.9:m=10]"
    } else {
        ""
    };
    set_property_cmd(request_id, "af", json!(filter))
}

fn set_video_margin_cmd(request_id: u64, property: &str, ratio: f64) -> String {
    let clamped = if ratio.is_finite() {
        (ratio.clamp(0.0, 0.75) * 10_000.0).round() / 10_000.0
    } else {
        0.0
    };
    set_property_cmd(request_id, property, json!(clamped))
}

/// Shifts and scales live rendered video + subtitles horizontally on the GPU without resizing
/// the underlying child HWND (`0.0` = full stage, `0.25` = 25% left margin for docked panels).
pub fn set_video_margin_left_cmd(request_id: u64, ratio: f64) -> String {
    set_video_margin_cmd(request_id, "video-margin-ratio-left", ratio)
}

/// Shifts and scales live rendered video + subtitles horizontally on the GPU without resizing
/// the underlying child HWND (`0.0` = full stage, `0.25` = 25% right margin for docked panels).
pub fn set_video_margin_right_cmd(request_id: u64, ratio: f64) -> String {
    set_video_margin_cmd(request_id, "video-margin-ratio-right", ratio)
}

/// Add an external subtitle track and optionally attach a user-facing title so transcoded or
/// auto-synced temp files do not expose internal `decoded_*` / `synced_*` filenames in mpv.
pub fn sub_add_cmd_with_title(request_id: u64, path: &str, title: Option<&str>) -> String {
    let clean_title = title.map(str::trim).filter(|t| !t.is_empty());
    match clean_title {
        Some(t) => encode_command(
            request_id,
            &[json!("sub-add"), json!(path), json!("select"), json!(t)],
        ),
        None => encode_command(
            request_id,
            &[json!("sub-add"), json!(path), json!("select")],
        ),
    }
}

pub fn sub_remove_cmd(request_id: u64, sid: u64) -> String {
    encode_command(request_id, &[json!("sub-remove"), json!(sid)])
}

pub fn set_aid_cmd(request_id: u64, aid: Option<u64>) -> String {
    match aid {
        Some(id) => set_property_cmd(request_id, "aid", json!(id)),
        None => set_property_cmd(request_id, "aid", json!("no")),
    }
}

pub fn set_sid_cmd(request_id: u64, sid: Option<u64>) -> String {
    match sid {
        Some(id) => set_property_cmd(request_id, "sid", json!(id)),
        None => set_property_cmd(request_id, "sid", json!("no")),
    }
}

pub fn set_sub_delay_cmd(request_id: u64, delay_secs: f64) -> String {
    let clamped = if delay_secs.is_finite() {
        delay_secs.clamp(-3600.0, 3600.0)
    } else {
        0.0
    };
    set_property_cmd(request_id, "sub-delay", json!(clamped))
}

pub fn set_secondary_sub_track_cmd(request_id: u64, sid: Option<u64>) -> String {
    match sid {
        Some(id) => set_property_cmd(request_id, "secondary-sid", json!(id)),
        None => set_property_cmd(request_id, "secondary-sid", json!("no")),
    }
}

pub fn set_secondary_sub_pos_cmd(request_id: u64, pos: u32) -> String {
    set_property_cmd(request_id, "secondary-sub-pos", json!(pos.clamp(0, 100)))
}

pub fn set_secondary_sub_delay_cmd(request_id: u64, delay_secs: f64) -> String {
    let clamped = if delay_secs.is_finite() {
        delay_secs.clamp(-3600.0, 3600.0)
    } else {
        0.0
    };
    set_property_cmd(request_id, "secondary-sub-delay", json!(clamped))
}

pub fn show_osd_text_cmd(request_id: u64, text: &str, duration_ms: u32) -> String {
    let clean: String = text
        .chars()
        .filter(|&c| !c.is_control() || c == ' ')
        .take(160)
        .collect();
    let ms = duration_ms.clamp(500, 10_000);
    // Pass OSD level 0 so explicit notifications still appear when --osd-level=0 is configured.
    encode_command(
        request_id,
        &[json!("show-text"), json!(clean), json!(ms), json!(0)],
    )
}

#[allow(clippy::too_many_arguments)]
pub fn set_sub_style_cmds(
    first_request_id: u64,
    font: &str,
    font_size: u32,
    color: &str,
    border_size: f64,
    pos: u32,
    visible: bool,
    override_ass: bool,
) -> Vec<String> {
    let safe_size = font_size.clamp(20, 80);
    let safe_border = if border_size.is_finite() {
        border_size.clamp(0.0, 6.0)
    } else {
        2.0
    };
    let safe_pos = pos.clamp(5, 100);
    let ass_override = if override_ass { "force" } else { "no" };
    vec![
        set_property_cmd(first_request_id, "sub-font", json!(font)),
        set_property_cmd(first_request_id + 1, "sub-font-size", json!(safe_size)),
        set_property_cmd(first_request_id + 2, "sub-color", json!(color)),
        set_property_cmd(first_request_id + 3, "sub-border-size", json!(safe_border)),
        set_property_cmd(first_request_id + 4, "sub-pos", json!(safe_pos)),
        set_property_cmd(first_request_id + 5, "sub-visibility", json!(visible)),
        set_property_cmd(
            first_request_id + 6,
            "sub-ass-override",
            json!(ass_override),
        ),
    ]
}

#[allow(clippy::too_many_arguments)]
pub fn set_sub_style_cmds_with_bold(
    first_request_id: u64,
    font: &str,
    font_size: u32,
    color: &str,
    border_size: f64,
    pos: u32,
    visible: bool,
    override_ass: bool,
    bold: bool,
) -> Vec<String> {
    let mut cmds = set_sub_style_cmds(
        first_request_id,
        font,
        font_size,
        color,
        border_size,
        pos,
        visible,
        override_ass,
    );
    cmds.push(set_property_cmd(
        first_request_id + cmds.len() as u64,
        "sub-bold",
        json!(bold),
    ));
    cmds
}

pub fn parse_line(line: &str) -> Result<MpvMessage, MpvParseError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(MpvParseError::InvalidJson("empty line".to_string()));
    }
    let val: Value =
        serde_json::from_str(trimmed).map_err(|e| MpvParseError::InvalidJson(e.to_string()))?;
    let obj = val
        .as_object()
        .ok_or_else(|| MpvParseError::InvalidJson("expected JSON object".to_string()))?;

    if let Some(event_name) = obj.get("event").and_then(|v| v.as_str()) {
        match event_name {
            "file-loaded" => return Ok(MpvMessage::Event(MpvEvent::FileLoaded)),
            "video-reconfig" => return Ok(MpvMessage::Event(MpvEvent::VideoReconfig)),
            "seek" => return Ok(MpvMessage::Event(MpvEvent::Seek)),
            "playback-restart" => return Ok(MpvMessage::Event(MpvEvent::PlaybackRestart)),
            "end-file" => {
                let reason = obj
                    .get("reason")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                let file_error = obj
                    .get("file_error")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());
                return Ok(MpvMessage::Event(MpvEvent::EndFile { reason, file_error }));
            }
            "property-change" => {
                let name = obj.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let data = obj.get("data");
                if matches!(data, None | Some(Value::Null)) {
                    if name == "chapter-list" {
                        return Ok(MpvMessage::Event(MpvEvent::ChapterList(Vec::new())));
                    }
                    return Ok(MpvMessage::Event(MpvEvent::Other));
                }
                match name {
                    "time-pos" => {
                        if let Some(t) = data.and_then(|v| v.as_f64()).filter(|v| v.is_finite()) {
                            return Ok(MpvMessage::Event(MpvEvent::TimePos(t.max(0.0))));
                        }
                    }
                    "duration" => {
                        if let Some(d) = data.and_then(|v| v.as_f64()).filter(|v| v.is_finite()) {
                            return Ok(MpvMessage::Event(MpvEvent::Duration(d.max(0.0))));
                        }
                    }
                    "pause" => {
                        if let Some(p) = data.and_then(|v| v.as_bool()) {
                            return Ok(MpvMessage::Event(MpvEvent::Paused(p)));
                        }
                    }
                    "paused-for-cache" => {
                        if let Some(b) = data.and_then(|v| v.as_bool()) {
                            return Ok(MpvMessage::Event(MpvEvent::PausedForCache(b)));
                        }
                    }
                    "eof-reached" => {
                        if let Some(eof) = data.and_then(|v| v.as_bool()) {
                            return Ok(MpvMessage::Event(MpvEvent::EofReached(eof)));
                        }
                    }
                    "vo-configured" => {
                        if let Some(configured) = data.and_then(|v| v.as_bool()) {
                            return Ok(MpvMessage::Event(MpvEvent::VoConfigured(configured)));
                        }
                    }
                    "seeking" => {
                        if let Some(seeking) = data.and_then(|v| v.as_bool()) {
                            return Ok(MpvMessage::Event(MpvEvent::Seeking(seeking)));
                        }
                    }
                    "track-list" => {
                        if let Some(arr) = data.and_then(|v| v.as_array()) {
                            let tracks = parse_track_list(arr);
                            return Ok(MpvMessage::Event(MpvEvent::TrackList(tracks)));
                        }
                    }
                    "chapter-list" => {
                        if let Some(arr) = data.and_then(|v| v.as_array()) {
                            let chapters = parse_chapter_list(arr);
                            return Ok(MpvMessage::Event(MpvEvent::ChapterList(chapters)));
                        }
                    }
                    _ => {}
                }
                return Ok(MpvMessage::Event(MpvEvent::Other));
            }
            _ => return Ok(MpvMessage::Event(MpvEvent::Other)),
        }
    }

    if let (Some(req_id), Some(err)) = (
        obj.get("request_id").and_then(|v| v.as_u64()),
        obj.get("error").and_then(|v| v.as_str()),
    ) {
        return Ok(MpvMessage::Reply(MpvReply {
            request_id: req_id,
            error: err.to_string(),
            data: obj.get("data").cloned(),
        }));
    }

    Err(MpvParseError::Unrecognized)
}

fn parse_track_list(arr: &[Value]) -> Vec<MpvTrack> {
    arr.iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let id = obj.get("id")?.as_u64()?;
            let kind = obj.get("type")?.as_str()?.to_string();
            if kind != "audio" && kind != "sub" && kind != "video" {
                return None;
            }
            Some(MpvTrack {
                id,
                kind,
                title: obj
                    .get("title")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                lang: obj
                    .get("lang")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                codec: obj
                    .get("codec")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
                selected: obj
                    .get("selected")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                external: obj
                    .get("external")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                is_default: obj
                    .get("default")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false),
                forced: obj.get("forced").and_then(|v| v.as_bool()).unwrap_or(false),
                ff_index: obj.get("ff-index").and_then(|v| v.as_u64()),
                external_filename: obj
                    .get("external-filename")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string()),
            })
        })
        .collect()
}

fn parse_chapter_list(arr: &[Value]) -> Vec<MpvChapter> {
    let mut chapters: Vec<MpvChapter> = arr
        .iter()
        .filter_map(|item| {
            let obj = item.as_object()?;
            let time = obj
                .get("time")
                .and_then(|v| v.as_f64())
                .filter(|t| t.is_finite() && *t >= 0.0)?;
            let title = obj
                .get("title")
                .and_then(|v| v.as_str())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            Some(MpvChapter { title, time })
        })
        .collect();
    chapters.sort_by(|a, b| a.time.total_cmp(&b.time));
    chapters
}

pub fn launch_args_with_fonts(
    wid: u64,
    pipe_name: &str,
    sub_fonts_dir: Option<&str>,
) -> Vec<String> {
    let mut args = vec![
        "--idle=yes".to_string(),
        "--pause=yes".to_string(),
        format!("--wid={wid}"),
        format!(r"--input-ipc-server=\\.\pipe\{pipe_name}"),
        "--osc=no".to_string(),
        "--osd-level=0".to_string(),
        "--keep-open=yes".to_string(),
        "--input-default-bindings=no".to_string(),
        "--no-input-cursor".to_string(),
        "--no-input-vo-keyboard".to_string(),
        "--hwdec=auto-safe".to_string(),
        "--audio-channels=auto-safe".to_string(),
        "--audio-pitch-correction=yes".to_string(),
        "--embeddedfonts=yes".to_string(),
        // Expose CEA-608/708 closed captions inside video bitstreams as selectable subtitle tracks.
        "--sub-create-cc-track=yes".to_string(),
        "--background=color".to_string(),
        "--background-color=#060608".to_string(),
        "--no-config".to_string(),
        "--load-scripts=no".to_string(),
        "--ytdl=no".to_string(),
        "--access-references=no".to_string(),
        "--msg-level=all=warn".to_string(),
        "--demuxer-max-bytes=150MiB".to_string(),
        "--demuxer-max-back-bytes=50MiB".to_string(),
        // Fast clean JPEG frame capture for seamless resize/modal freeze transitions
        "--screenshot-format=jpg".to_string(),
        "--screenshot-jpeg-quality=90".to_string(),
        "--screenshot-high-bit-depth=no".to_string(),
        // Crisp libass rendering: light stem hinting preserves glyph proportions, micro-blur
        // smooths outer outline stair-stepping without softening text fill, and a subtle
        // translucent border + drop shadow avoids harsh sticker cutouts across bright/dark scenes.
        "--sub-hinting=light".to_string(),
        "--sub-blur=0.08".to_string(),
        "--sub-outline-color=#E6000000".to_string(),
        "--sub-shadow-offset=1.15".to_string(),
        "--sub-back-color=#78000000".to_string(),
        "--sub-border-size=2.5".to_string(),
    ];
    if let Some(dir) = sub_fonts_dir {
        let trimmed = dir.trim();
        if !trimmed.is_empty() {
            args.push(format!("--sub-fonts-dir={trimmed}"));
            args.push("--sub-font=Noto Sans Arabic".to_string());
        }
    }
    args
}

/// Rate-limits high-frequency `time-pos` events sent to the WebView UI while still
/// allowing immediate updates after seeks or resets.
#[derive(Debug, Clone)]
pub struct TimePosThrottle {
    min_interval: std::time::Duration,
    jump_bypass_secs: f64,
    last_emit_at: Option<std::time::Instant>,
    last_emitted_pos: Option<f64>,
}

impl TimePosThrottle {
    pub fn new(min_interval: std::time::Duration, jump_bypass_secs: f64) -> Self {
        Self {
            min_interval,
            jump_bypass_secs,
            last_emit_at: None,
            last_emitted_pos: None,
        }
    }

    pub fn ui_default() -> Self {
        Self::new(std::time::Duration::from_millis(250), 1.5)
    }

    pub fn reset(&mut self) {
        self.last_emit_at = None;
        self.last_emitted_pos = None;
    }

    pub fn should_emit(&mut self, position: f64, now: std::time::Instant) -> bool {
        let Some(last_at) = self.last_emit_at else {
            self.last_emit_at = Some(now);
            self.last_emitted_pos = Some(position);
            return true;
        };
        let jumped = self
            .last_emitted_pos
            .map(|prev| (position - prev).abs() >= self.jump_bypass_secs)
            .unwrap_or(true);
        if jumped || now.duration_since(last_at) >= self.min_interval {
            self.last_emit_at = Some(now);
            self.last_emitted_pos = Some(position);
            return true;
        }
        false
    }
}

/// Result of evaluating an incoming mpv `time-pos` event against any in-flight seek.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TimePosDecision {
    /// No active seek gating is running; apply normal throttling.
    Accept(f64),
    /// First `time-pos` observed once all queued seeks have finished restarting playback;
    /// reset UI throttling and emit immediately so even small (`< 1.5s`) seeks update right away.
    AcceptAfterSeek(f64),
    /// Pre-seek or intermediate `time-pos` while seek/restart is still settling.
    Drop,
}

#[derive(Debug, Clone)]
struct PendingSeekState {
    target: f64,
    started_at: Instant,
    outstanding_seeks: u32,
    active_mpv_seeks: u32,
    saw_seeking_true: bool,
    saw_restart_after_seek: bool,
    latest_req_acked: bool,
    saw_seek_after_latest_ack: bool,
    restarted: bool,
    req_ids: VecDeque<u64>,
}

/// Deterministic tracker matching dispatched mpv seek commands with `"seek"`,
/// `"playback-restart"`, and `"seeking"` events so pre-seek/intermediate frames never
/// snap the UI clock or Watch Party snapshot backward.
#[derive(Debug, Clone, Default)]
pub struct PendingSeekTracker {
    active: Option<PendingSeekState>,
}

impl PendingSeekTracker {
    const TIMEOUT: Duration = Duration::from_millis(1200);
    // Exact seeks on high-bitrate/remote streams can decode longer than 1.2s while mpv
    // actively reports `seeking=true`; keep suppressing stale `time-pos` until restart.
    const SEEKING_TIMEOUT: Duration = Duration::from_millis(4000);

    fn effective_timeout(s: &PendingSeekState) -> Duration {
        if s.saw_seeking_true && !s.restarted {
            Self::SEEKING_TIMEOUT
        } else {
            Self::TIMEOUT
        }
    }

    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.active = None;
    }

    pub fn is_active(&self) -> bool {
        self.active.is_some()
    }

    pub fn is_seeking_at(&self, now: Instant) -> bool {
        self.active.as_ref().is_some_and(|s| {
            !s.restarted && now.duration_since(s.started_at) < Self::effective_timeout(s)
        })
    }

    pub fn note_dispatched_seek(&mut self, target: f64, req_id: Option<u64>, now: Instant) {
        let safe = if target.is_finite() && target >= 0.0 {
            target
        } else {
            0.0
        };
        if let Some(ref mut s) = self.active {
            if now.duration_since(s.started_at) < Self::effective_timeout(s) {
                s.target = safe;
                s.started_at = now;
                s.outstanding_seeks = s.outstanding_seeks.saturating_add(1);
                s.saw_seeking_true = false;
                s.saw_restart_after_seek = false;
                s.latest_req_acked = false;
                s.saw_seek_after_latest_ack = false;
                s.restarted = false;
                if let Some(id) = req_id {
                    s.req_ids.push_back(id);
                }
                return;
            }
        }
        let mut req_ids = VecDeque::with_capacity(4);
        if let Some(id) = req_id {
            req_ids.push_back(id);
        }
        self.active = Some(PendingSeekState {
            target: safe,
            started_at: now,
            outstanding_seeks: 1,
            active_mpv_seeks: 0,
            saw_seeking_true: false,
            saw_restart_after_seek: false,
            latest_req_acked: false,
            saw_seek_after_latest_ack: false,
            restarted: false,
            req_ids,
        });
    }

    /// Records a successful mpv IPC reply for `req_id` so overlapping rapid seeks that mpv
    /// internally coalesced settle on the restart that followed the latest accepted command.
    pub fn on_reply_success(&mut self, req_id: u64) {
        let Some(ref mut s) = self.active else {
            return;
        };
        if s.req_ids.back().copied() == Some(req_id) {
            s.latest_req_acked = true;
            s.saw_seek_after_latest_ack = false;
        }
    }

    pub fn on_reply_error(&mut self, req_id: u64) {
        let Some(ref mut s) = self.active else {
            return;
        };
        if let Some(pos) = s.req_ids.iter().position(|&id| id == req_id) {
            s.req_ids.remove(pos);
            s.outstanding_seeks = s.outstanding_seeks.saturating_sub(1);
            if s.outstanding_seeks == 0 {
                self.active = None;
            }
        }
    }

    pub fn on_seek_event(&mut self) {
        if let Some(ref mut s) = self.active {
            s.active_mpv_seeks = s.active_mpv_seeks.saturating_add(1);
            if s.latest_req_acked {
                s.saw_seek_after_latest_ack = true;
            }
            s.restarted = false;
        }
    }

    /// Returns `true` when all queued seek cycles have completed `seek -> playback-restart`.
    pub fn on_playback_restart(&mut self) -> bool {
        let Some(ref mut s) = self.active else {
            return false;
        };
        if s.active_mpv_seeks > 0 {
            s.active_mpv_seeks -= 1;
            s.saw_restart_after_seek = true;
            let _ = s.req_ids.pop_front();
            s.outstanding_seeks = s.outstanding_seeks.saturating_sub(1);
            if s.outstanding_seeks == 0
                || (s.active_mpv_seeks == 0 && s.latest_req_acked && s.saw_seek_after_latest_ack)
            {
                s.outstanding_seeks = 0;
                s.restarted = true;
                return true;
            }
        }
        false
    }

    /// Tracks mpv's `"seeking"` property; returns `Some(target)` if seeking finished after
    /// restart cleanly without a trailing `time-pos` (e.g. paused seek to identical frame `0.0`).
    pub fn on_seeking_prop(&mut self, seeking: bool) -> Option<f64> {
        let s = self.active.as_mut()?;
        if seeking {
            s.saw_seeking_true = true;
            return None;
        }
        if s.restarted
            || (s.outstanding_seeks == 0
                && s.active_mpv_seeks == 0
                && s.saw_seeking_true
                && s.saw_restart_after_seek)
        {
            let target = s.target;
            self.active = None;
            return Some(target);
        }
        None
    }

    pub fn filter_time_pos(&mut self, position: f64, now: Instant) -> TimePosDecision {
        let Some(ref s) = self.active else {
            return TimePosDecision::Accept(position);
        };
        if now.duration_since(s.started_at) >= Self::effective_timeout(s) || s.restarted {
            self.active = None;
            return TimePosDecision::AcceptAfterSeek(position);
        }
        TimePosDecision::Drop
    }
}

pub fn autosync_extract_args_mpv(
    video_path: &str,
    out_pcm_path: &str,
    audio_track_id: Option<u64>,
) -> Vec<String> {
    let mut args = vec![
        "--no-config".to_string(),
        "--load-scripts=no".to_string(),
        "--ytdl=no".to_string(),
        "--vid=no".to_string(),
        "--sub=no".to_string(),
        // Silence the terminal status line / log spam so an undrained stderr pipe can never fill up.
        "--msg-level=all=error".to_string(),
        "--term-status-msg=".to_string(),
        "--audio-channels=mono".to_string(),
        "--audio-samplerate=16000".to_string(),
        "--of=s16le".to_string(),
        "--oac=pcm_s16le".to_string(),
        format!("--o={out_pcm_path}"),
    ];
    if let Some(aid) = audio_track_id {
        args.push(format!("--aid={aid}"));
    }
    args.push(video_path.to_string());
    args
}

pub fn autosync_extract_args_ffmpeg(
    video_path: &str,
    out_pcm_path: &str,
    audio_stream_idx: Option<usize>,
) -> Vec<String> {
    autosync_extract_args_ffmpeg_dialogue(video_path, out_pcm_path, audio_stream_idx, false)
}

/// Extract mono 16kHz PCM audio via ffmpeg, optionally weighting the center dialogue channel (`FC`)
/// over front stereo and dropping surround/LFE channels on multi-channel 5.1/7.1 tracks.
pub fn autosync_extract_args_ffmpeg_dialogue(
    video_path: &str,
    out_pcm_path: &str,
    audio_stream_idx: Option<usize>,
    prefer_center_mix: bool,
) -> Vec<String> {
    // NOTE: `-vn`/`-sn` are output options and must come AFTER `-i`; before it older ffmpeg builds
    // abort with "cannot be applied to input url".
    let mut args = vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        video_path.to_string(),
        "-vn".to_string(),
        "-sn".to_string(),
    ];
    if let Some(idx) = audio_stream_idx {
        args.push("-map".to_string());
        args.push(format!("0:a:{idx}"));
    } else {
        args.push("-map".to_string());
        args.push("0:a:0".to_string());
    }
    if prefer_center_mix {
        args.extend([
            "-af".to_string(),
            "pan=mono|c0=0.75*FC+0.125*FL+0.125*FR".to_string(),
        ]);
    } else {
        args.extend(["-ac".to_string(), "1".to_string()]);
    }
    args.extend([
        "-ar".to_string(),
        "16000".to_string(),
        "-f".to_string(),
        "s16le".to_string(),
        "-acodec".to_string(),
        "pcm_s16le".to_string(),
        out_pcm_path.to_string(),
    ]);
    args
}

/// Inspects `ffmpeg -i` stderr output to determine whether audio stream `0:a:{audio_stream_idx}`
/// uses a surround/center-channel layout (5.1, 7.1, 6.1, 5.0, 3.0, 4.1) that contains `FC`.
pub fn parse_ffmpeg_audio_stream_has_center(probe_output: &str, audio_stream_idx: usize) -> bool {
    let audio_lines: Vec<&str> = probe_output
        .lines()
        .filter(|line| line.contains("Stream #") && line.contains(": Audio:"))
        .collect();
    let Some(target) = audio_lines.get(audio_stream_idx) else {
        return false;
    };
    // Only inspect the channel-layout field (a whole comma-separated token such as `5.1(side)`),
    // never substrings of bitrates/sample rates. Layouts without an `FC` channel (e.g. 4.1, quad)
    // are excluded so the `FC`-weighted pan filter is never requested for them.
    let Some((_, fields)) = target.split_once(": Audio:") else {
        return false;
    };
    fields.split(',').any(|token| {
        let layout = token
            .trim()
            .split(['(', ' '])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        matches!(layout.as_str(), "5.1" | "7.1" | "6.1" | "5.0" | "3.0")
    })
}

fn autosync_extract_sub_with_map_args_ffmpeg(
    video_path: &str,
    out_sub_path: &str,
    map_spec: String,
) -> Vec<String> {
    vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        video_path.to_string(),
        "-vn".to_string(),
        "-an".to_string(),
        "-dn".to_string(),
        "-map".to_string(),
        map_spec,
        out_sub_path.to_string(),
    ]
}

/// Fix 23: Extract an embedded text subtitle track (`sid`) to an external `.srt`/`.ass` file via `ffmpeg` or `mpv`.
pub fn autosync_extract_sub_args_ffmpeg(
    video_path: &str,
    out_sub_path: &str,
    sub_stream_idx: usize,
) -> Vec<String> {
    autosync_extract_sub_with_map_args_ffmpeg(
        video_path,
        out_sub_path,
        format!("0:s:{sub_stream_idx}"),
    )
}

/// Extract an embedded subtitle stream by its exact FFmpeg container stream index (`0:<ff_index>`),
/// matching `mpv`'s `track-list` `ff-index` property so closed captions or unusual stream layouts never drift.
pub fn autosync_extract_stream_args_ffmpeg(
    video_path: &str,
    out_sub_path: &str,
    ff_stream_idx: u64,
) -> Vec<String> {
    autosync_extract_sub_with_map_args_ffmpeg(
        video_path,
        out_sub_path,
        format!("0:{ff_stream_idx}"),
    )
}

/// Extract packet timestamps (`pts`, `duration`, `size`) from an embedded bitmap subtitle stream
/// (`dvd_subtitle`, `hdmv_pgs_subtitle`, `dvb_subtitle`, `xsub`) using FFmpeg's `framecrc` muxer
/// with zero video/audio decoding so acoustic Magic Sync can align image subtitles directly.
pub fn autosync_extract_bitmap_framecrc_args_ffmpeg(
    video_path: &str,
    out_crc_path: &str,
    ff_stream_idx: Option<u64>,
    sub_stream_idx: usize,
) -> Vec<String> {
    let map_spec = match ff_stream_idx {
        Some(idx) => format!("0:{idx}"),
        None => format!("0:s:{sub_stream_idx}"),
    };
    vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-i".to_string(),
        video_path.to_string(),
        "-vn".to_string(),
        "-an".to_string(),
        "-dn".to_string(),
        "-map".to_string(),
        map_spec,
        "-c:s".to_string(),
        "copy".to_string(),
        "-f".to_string(),
        "framecrc".to_string(),
        out_crc_path.to_string(),
    ]
}

/// Extract a bounded sample (first `max_secs` of media) of an embedded text subtitle stream
/// for fast background language detection while skipping video, audio, and attachment streams.
pub fn probe_extract_sub_sample_args_ffmpeg(
    video_path: &str,
    out_sub_path: &str,
    ff_stream_idx: Option<u64>,
    sub_stream_idx: usize,
    max_secs: u64,
) -> Vec<String> {
    let map_spec = match ff_stream_idx {
        Some(ff) => format!("0:{ff}"),
        None => format!("0:s:{sub_stream_idx}"),
    };
    let mut args = autosync_extract_sub_with_map_args_ffmpeg(video_path, out_sub_path, map_spec);
    let out = args.pop().expect("output path present");
    args.push("-dn".to_string());
    if max_secs > 0 {
        args.push("-t".to_string());
        args.push(max_secs.to_string());
    }
    args.push(out);
    args
}

/// Escape a local filesystem path for use as an unquoted value inside FFmpeg's `lavfi` `movie=...`
/// filtergraph description (two escaping levels: AVOption value, then AVFilterGraph parser).
pub fn escape_ffmpeg_lavfi_movie_path(video_path: &str) -> String {
    let stripped = if let Some(unc) = video_path.strip_prefix(r"\\?\UNC\") {
        format!("//{unc}")
    } else if let Some(local) = video_path.strip_prefix(r"\\?\") {
        local.to_string()
    } else {
        video_path.to_string()
    };
    let normalized = stripped.replace('\\', "/");

    let mut level1 = String::with_capacity(normalized.len() + 8);
    for ch in normalized.chars() {
        if matches!(ch, '\\' | '\'' | ':' | '=') {
            level1.push('\\');
        }
        level1.push(ch);
    }

    let mut level2 = String::with_capacity(level1.len() + 12);
    for ch in level1.chars() {
        if matches!(ch, '\\' | '\'' | '[' | ']' | ',' | ';' | '=' | ' ') {
            level2.push('\\');
        }
        level2.push(ch);
    }
    level2
}

/// Extract embedded CEA-608/708 bitstream closed captions (`eia_608`/`cc_dec`) from the video
/// stream into an `.srt` file via FFmpeg's `lavfi` `movie=...[out0+subcc]` filter.
pub fn autosync_extract_cc_args_ffmpeg(
    video_path: &str,
    out_srt_path: &str,
    video_stream_idx: Option<usize>,
) -> Vec<String> {
    let escaped = escape_ffmpeg_lavfi_movie_path(video_path);
    let movie_expr = match video_stream_idx {
        Some(si) => format!("movie={escaped}:si={si}:dec_threads=0[out0+subcc]"),
        None => format!("movie={escaped}:dec_threads=0[out0+subcc]"),
    };
    vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-y".to_string(),
        "-f".to_string(),
        "lavfi".to_string(),
        "-i".to_string(),
        movie_expr,
        "-map".to_string(),
        "0:s".to_string(),
        "-c:s".to_string(),
        "srt".to_string(),
        out_srt_path.to_string(),
    ]
}

/// Extract a time window of mono 8kHz PCM audio via ffmpeg to stdout (`pipe:1`) for intro/outro detection.
pub fn intro_extract_audio_range_args_ffmpeg(
    video_path: &str,
    start_secs: f64,
    window_secs: f64,
    audio_stream_idx: Option<usize>,
) -> Vec<String> {
    let safe_start = if start_secs.is_finite() && start_secs > 0.0 {
        start_secs
    } else {
        0.0
    };
    let safe_dur = if window_secs.is_finite() {
        window_secs.clamp(5.0, 960.0)
    } else {
        600.0
    };
    let mut args = vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        if safe_start == 0.0 {
            "0".to_string()
        } else {
            format!("{safe_start:.3}")
        },
        "-i".to_string(),
        video_path.to_string(),
        "-t".to_string(),
        format!("{safe_dur:.3}"),
        "-vn".to_string(),
        "-sn".to_string(),
        "-dn".to_string(),
    ];
    if let Some(idx) = audio_stream_idx {
        args.push("-map".to_string());
        args.push(format!("0:a:{idx}"));
    }
    args.extend([
        "-ac".to_string(),
        "1".to_string(),
        "-ar".to_string(),
        "8000".to_string(),
        "-f".to_string(),
        "s16le".to_string(),
        "pipe:1".to_string(),
    ]);
    args
}

/// Extract an opening window of mono 8kHz PCM audio via ffmpeg to stdout (`pipe:1`) for intro detection.
pub fn intro_extract_audio_args_ffmpeg(
    video_path: &str,
    window_secs: f64,
    audio_stream_idx: Option<usize>,
) -> Vec<String> {
    intro_extract_audio_range_args_ffmpeg(video_path, 0.0, window_secs, audio_stream_idx)
}

/// Fallback time-window audio extractor using mpv when ffmpeg.exe is unavailable.
pub fn intro_extract_audio_range_args_mpv(
    video_path: &str,
    out_pcm_path: &str,
    start_secs: f64,
    window_secs: f64,
    audio_track_id: Option<u64>,
) -> Vec<String> {
    let safe_start = if start_secs.is_finite() && start_secs > 0.0 {
        start_secs
    } else {
        0.0
    };
    let safe_dur = if window_secs.is_finite() {
        window_secs.clamp(5.0, 960.0)
    } else {
        600.0
    };
    let mut args = vec![
        "--no-config".to_string(),
        "--load-scripts=no".to_string(),
        "--ytdl=no".to_string(),
        "--vid=no".to_string(),
        "--sub=no".to_string(),
        "--msg-level=all=error".to_string(),
        "--term-status-msg=".to_string(),
        if safe_start == 0.0 {
            "--start=0".to_string()
        } else {
            format!("--start={safe_start:.3}")
        },
        format!("--length={safe_dur:.3}"),
        "--audio-channels=mono".to_string(),
        "--audio-samplerate=8000".to_string(),
        "--of=s16le".to_string(),
        "--oac=pcm_s16le".to_string(),
        format!("--o={out_pcm_path}"),
    ];
    if let Some(aid) = audio_track_id {
        args.push(format!("--aid={aid}"));
    }
    args.push(video_path.to_string());
    args
}

/// Fallback opening-window audio extractor using mpv when ffmpeg.exe is unavailable.
pub fn intro_extract_audio_args_mpv(
    video_path: &str,
    out_pcm_path: &str,
    window_secs: f64,
    audio_track_id: Option<u64>,
) -> Vec<String> {
    intro_extract_audio_range_args_mpv(video_path, out_pcm_path, 0.0, window_secs, audio_track_id)
}

/// Extract an embedded text subtitle track as ASS to stdout (`pipe:1`), optionally seeking near the outro.
pub fn intro_extract_sub_tail_args_ffmpeg(
    video_path: &str,
    start_secs: f64,
    sub_stream_idx: usize,
) -> Vec<String> {
    let safe_start = if start_secs.is_finite() && start_secs > 0.0 {
        start_secs
    } else {
        0.0
    };
    vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-ss".to_string(),
        format!("{safe_start:.3}"),
        "-copyts".to_string(),
        "-i".to_string(),
        video_path.to_string(),
        "-vn".to_string(),
        "-an".to_string(),
        "-dn".to_string(),
        "-map".to_string(),
        format!("0:s:{sub_stream_idx}"),
        "-f".to_string(),
        "ass".to_string(),
        "pipe:1".to_string(),
    ]
}

/// Extract only the opening `window_secs` of an embedded text subtitle track as ASS to stdout (`pipe:1`).
pub fn intro_extract_sub_args_ffmpeg(
    video_path: &str,
    window_secs: f64,
    sub_stream_idx: usize,
) -> Vec<String> {
    let safe_dur = if window_secs.is_finite() {
        window_secs.clamp(5.0, 960.0)
    } else {
        600.0
    };
    vec![
        "-nostdin".to_string(),
        "-hide_banner".to_string(),
        "-nostats".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
        "-i".to_string(),
        video_path.to_string(),
        "-t".to_string(),
        format!("{safe_dur:.3}"),
        "-vn".to_string(),
        "-an".to_string(),
        "-dn".to_string(),
        "-map".to_string(),
        format!("0:s:{sub_stream_idx}"),
        "-f".to_string(),
        "ass".to_string(),
        "pipe:1".to_string(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encode_command() {
        let cmd = encode_command(7, &[json!("set_property"), json!("pause"), json!(true)]);
        let parsed: Value = serde_json::from_str(cmd.trim()).unwrap();
        assert_eq!(parsed["request_id"], 7);
        assert_eq!(parsed["command"][0], "set_property");
        assert_eq!(parsed["command"][2], true);
    }

    #[test]
    fn test_loadfile_cmd_handles_complex_paths() {
        let path = r#"C:\Users\أحمد\Movies\"Demo" [1080p]\file.mkv"#;
        let cmd = loadfile_cmd(1, path);
        let parsed: Value = serde_json::from_str(cmd.trim()).unwrap();
        assert_eq!(parsed["command"][0], "loadfile");
        assert_eq!(parsed["command"][1], path);
        assert_eq!(parsed["command"][2], "replace");
    }

    #[test]
    fn test_parse_property_change_events() {
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":12.5}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::TimePos(12.5))
        );
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":2,"name":"duration","data":3600.0}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::Duration(3600.0))
        );
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":3,"name":"pause","data":false}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::Paused(false))
        );
    }

    #[test]
    fn test_parse_null_property_data() {
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":1,"name":"time-pos","data":null}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::Other)
        );
    }

    #[test]
    fn test_parse_file_loaded_and_end_file() {
        assert_eq!(
            parse_line(r#"{"event":"file-loaded"}"#).unwrap(),
            MpvMessage::Event(MpvEvent::FileLoaded)
        );
        assert_eq!(
            parse_line(r#"{"event":"video-reconfig"}"#).unwrap(),
            MpvMessage::Event(MpvEvent::VideoReconfig)
        );
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":8,"name":"vo-configured","data":true}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::VoConfigured(true))
        );
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":8,"name":"vo-configured","data":false}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::VoConfigured(false))
        );
        assert_eq!(
            parse_line(r#"{"event":"end-file","reason":"error","file_error":"loading failed"}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::EndFile {
                reason: Some("error".to_string()),
                file_error: Some("loading failed".to_string()),
            })
        );
    }

    #[test]
    fn test_parse_reply() {
        let msg = parse_line(r#"{"error":"success","request_id":42,"data":null}"#).unwrap();
        assert_eq!(
            msg,
            MpvMessage::Reply(MpvReply {
                request_id: 42,
                error: "success".to_string(),
                data: Some(Value::Null),
            })
        );
    }

    #[test]
    fn test_parse_malformed_and_empty() {
        assert!(parse_line("").is_err());
        assert!(parse_line("{not json").is_err());
    }

    #[test]
    fn test_launch_args_contain_wid_and_pipe() {
        let args = launch_args_with_fonts(98765, "epilod-mpv-1", Some(r"C:\app\fonts"));
        assert!(args.iter().any(|a| a == "--wid=98765"));
        assert!(args
            .iter()
            .any(|a| a == r"--input-ipc-server=\\.\pipe\epilod-mpv-1"));
        assert!(args.iter().any(|a| a == "--pause=yes"));
        assert!(args.iter().any(|a| a == r"--sub-fonts-dir=C:\app\fonts"));
    }

    #[test]
    fn test_universal_launch_and_autosync_extract_args() {
        let launch = launch_args_with_fonts(123, "p", None);
        for req in [
            "--hwdec=auto-safe",
            "--audio-channels=auto-safe",
            "--audio-pitch-correction=yes",
            "--embeddedfonts=yes",
            "--no-config",
            "--load-scripts=no",
            "--ytdl=no",
            "--access-references=no",
            "--sub-hinting=light",
            "--sub-blur=0.08",
            "--sub-outline-color=#E6000000",
            "--sub-shadow-offset=1.15",
            "--sub-back-color=#78000000",
            "--sub-border-size=2.5",
            "--sub-create-cc-track=yes",
        ] {
            assert!(launch.iter().any(|a| a == req));
        }
        let mpv_ext = autosync_extract_args_mpv("movie.mkv", "out.pcm", Some(2));
        assert!(mpv_ext.iter().any(|a| a == "--aid=2"));
        assert!(mpv_ext.iter().any(|a| a == "--of=s16le"));
        let ff_ext = autosync_extract_args_ffmpeg("movie.mkv", "out.pcm", Some(1));
        assert!(ff_ext.iter().any(|a| a == "0:a:1"));
        let sub_ext = autosync_extract_sub_args_ffmpeg("movie.mkv", "out.srt", 0);
        assert!(sub_ext.iter().any(|a| a == "0:s:0"));
        let stream_ext = autosync_extract_stream_args_ffmpeg("movie.mkv", "out.srt", 4);
        assert!(stream_ext.windows(2).any(|w| w == ["-map", "0:4"]));
        let bmp_crc =
            autosync_extract_bitmap_framecrc_args_ffmpeg("movie.mkv", "crc.txt", Some(3), 0);
        assert!(bmp_crc.windows(2).any(|w| w == ["-map", "0:3"]));
        assert!(bmp_crc.windows(2).any(|w| w == ["-f", "framecrc"]));
        assert!(bmp_crc.windows(2).any(|w| w == ["-c:s", "copy"]));
        let sample_ext =
            probe_extract_sub_sample_args_ffmpeg("movie.mkv", "sample.srt", Some(5), 1, 600);
        assert!(sample_ext.windows(2).any(|w| w == ["-map", "0:5"]));
        assert!(sample_ext.windows(2).any(|w| w == ["-t", "600"]));
        assert!(sample_ext.iter().any(|a| a == "-dn"));

        let cc_ext = autosync_extract_cc_args_ffmpeg(
            r"C:\Dir [1080p]\Test's Show, #1.mp4",
            "out_cc.srt",
            None,
        );
        assert!(cc_ext.windows(2).any(|w| w == ["-f", "lavfi"]));
        assert!(cc_ext
            .iter()
            .any(|a| a.contains("[out0+subcc]") && a.contains(r"C\\:/") && a.contains(r"\'s\ ")));

        let ff_center =
            autosync_extract_args_ffmpeg_dialogue("movie.mkv", "out.pcm", Some(0), true);
        assert!(ff_center
            .iter()
            .any(|a| a.contains("0.75*FC+0.125*FL+0.125*FR")));
        let probe = "  Stream #0:1(jpn): Audio: aac (LC), 48000 Hz, stereo, fltp\n  Stream #0:2(eng): Audio: eac3, 48000 Hz, 5.1(side), fltp\n";
        assert!(!parse_ffmpeg_audio_stream_has_center(probe, 0));
        assert!(parse_ffmpeg_audio_stream_has_center(probe, 1));
        assert!(!parse_ffmpeg_audio_stream_has_center(probe, 2));

        // Layout must be matched as a whole field: bitrates/rates never count, 4.1 has no FC,
        // and `5.1(side)` style annotations still match.
        let tricky = "Stream #0:0: Audio: aac (LC), 48000 Hz, stereo, fltp, 135.1 kb/s\n\
                      Stream #0:1: Audio: eac3, 48000 Hz, 5.1(side), fltp, 640 kb/s\n\
                      Stream #0:2: Audio: ac3, 48000 Hz, 4.1, fltp, 384 kb/s\n";
        assert!(!parse_ffmpeg_audio_stream_has_center(tricky, 0));
        assert!(parse_ffmpeg_audio_stream_has_center(tricky, 1));
        assert!(!parse_ffmpeg_audio_stream_has_center(tricky, 2));
        assert!(!parse_ffmpeg_audio_stream_has_center("", 0));

        // Extractors must be quiet (undrained stderr pipes can deadlock) and keep output-only
        // ffmpeg flags after `-i`.
        assert!(mpv_ext.iter().any(|a| a == "--msg-level=all=error"));
        assert!(mpv_ext.iter().any(|a| a == "--term-status-msg="));
        for args in [&ff_ext, &sub_ext] {
            let i_pos = args.iter().position(|a| a == "-i").unwrap();
            for out_flag in ["-vn", "-sn", "-an"] {
                if let Some(p) = args.iter().position(|a| a == out_flag) {
                    assert!(p > i_pos, "{out_flag} must follow -i");
                }
            }
            assert!(args.iter().any(|a| a == "-nostdin"));
        }
    }

    #[test]
    fn test_volume_and_mute_commands() {
        let v = set_volume_cmd(1, 150.0);
        assert!(v.contains("130"));
        let v_boost = set_volume_cmd(1, 120.0);
        assert!(v_boost.contains("120"));
        let m = set_mute_cmd(2, true);
        assert!(m.contains("\"mute\"") && m.contains("true"));
    }

    #[test]
    fn test_playback_ux_commands() {
        let sp = set_speed_cmd(1, 1.5);
        assert!(sp.contains("\"speed\"") && sp.contains("1.5"));
        let lp = set_loop_cmd(2, true);
        assert!(lp.contains("\"loop-file\"") && lp.contains("\"inf\""));
        let asp = set_aspect_cmd(3, "21:9");
        assert!(asp.contains("\"video-aspect-override\"") && asp.contains("\"21:9\""));
        let fill_cmds = set_aspect_mode_cmds(10, "fill");
        assert_eq!(fill_cmds.len(), 2);
        assert!(fill_cmds[0].contains("\"panscan\"") && fill_cmds[0].contains("1.0"));
        assert!(
            fill_cmds[1].contains("\"video-aspect-override\"") && fill_cmds[1].contains("\"-1\"")
        );
        let wide_cmds = set_aspect_mode_cmds(12, "16:9");
        assert!(wide_cmds[0].contains("\"panscan\"") && wide_cmds[0].contains("0.0"));
        assert!(wide_cmds[1].contains("\"16:9\""));
    }

    #[test]
    fn test_subtitle_commands_and_rtl_paths() {
        let add = sub_add_cmd_with_title(1, r"C:\Subs\العربية.srt", None);
        assert!(add.contains("sub-add"));
        let add_titled = sub_add_cmd_with_title(
            2,
            r"C:\Temp\decoded_164668_2.srt",
            Some("Movie.2025.Arabic.srt"),
        );
        let parsed: serde_json::Value = serde_json::from_str(add_titled.trim()).unwrap();
        assert_eq!(
            parsed["command"],
            json!([
                "sub-add",
                r"C:\Temp\decoded_164668_2.srt",
                "select",
                "Movie.2025.Arabic.srt"
            ])
        );
        let add_blank = sub_add_cmd_with_title(3, r"C:\Temp\decoded_164668_2.srt", Some("   "));
        let parsed_blank: serde_json::Value = serde_json::from_str(add_blank.trim()).unwrap();
        assert_eq!(
            parsed_blank["command"],
            json!(["sub-add", r"C:\Temp\decoded_164668_2.srt", "select"])
        );
        let rem = sub_remove_cmd(2, 4);
        assert!(rem.contains("sub-remove") && rem.contains("4"));
        let cmds_forced =
            set_sub_style_cmds(10, "Noto Sans Arabic", 48, "#FFFFFF", 2.0, 95, true, true);
        assert_eq!(cmds_forced.len(), 7);
        assert!(cmds_forced
            .iter()
            .any(|c| c.contains("sub-ass-override") && c.contains("force")));

        let cmds_unforced =
            set_sub_style_cmds(20, "Noto Sans Arabic", 48, "#FFFFFF", 2.0, 25, true, false);
        assert!(cmds_unforced
            .iter()
            .any(|c| c.contains("sub-ass-override") && c.contains("\"no\"")));
        assert!(cmds_unforced
            .iter()
            .any(|c| c.contains("sub-pos") && c.contains("25")));

        let cmds_bold = set_sub_style_cmds_with_bold(
            30,
            "Noto Sans Arabic",
            44,
            "#FFFFFF",
            2.5,
            95,
            true,
            false,
            true,
        );
        assert_eq!(cmds_bold.len(), 8);
        assert!(cmds_bold
            .iter()
            .any(|c| c.contains("sub-bold") && c.contains("true")));
    }

    #[test]
    fn test_parse_eof_reached_property_change() {
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":5,"name":"eof-reached","data":true}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::EofReached(true))
        );
    }

    #[test]
    fn test_track_list_parsing_and_track_commands() {
        let line = r#"{"event":"property-change","id":4,"name":"track-list","data":[{"id":1,"type":"audio","title":"JP","lang":"jpn","codec":"aac","selected":true,"external":false,"default":true,"forced":false},{"id":2,"type":"sub","title":null,"lang":"ara","codec":"ass","selected":true,"external":true,"external-filename":"C:\\Movies\\Movie.ara.ass","default":false,"forced":false}]}"#;
        match parse_line(line).unwrap() {
            MpvMessage::Event(MpvEvent::TrackList(tracks)) => {
                assert_eq!(tracks.len(), 2);
                assert_eq!(tracks[0].kind, "audio");
                assert!(tracks[0].is_default);
                assert!(!tracks[0].forced);
                assert_eq!(tracks[0].external_filename, None);
                assert_eq!(tracks[1].kind, "sub");
                assert!(tracks[1].external);
                assert_eq!(
                    tracks[1].external_filename.as_deref(),
                    Some(r"C:\Movies\Movie.ara.ass")
                );
                // Ensure JSON serialized to the WebView exposes `"type"` (not `"kind"`).
                let serialized = serde_json::to_value(&tracks).unwrap();
                assert_eq!(serialized[0]["type"], "audio");
                assert!(serialized[0].get("kind").is_none());
                assert_eq!(serialized[0]["default"], true);
                assert_eq!(serialized[1]["type"], "sub");
                assert_eq!(
                    serialized[1]["external-filename"],
                    r"C:\Movies\Movie.ara.ass"
                );
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert!(set_aid_cmd(1, None).contains("\"no\""));
        assert!(set_sid_cmd(2, Some(3)).contains("3"));
    }

    #[test]
    fn test_time_pos_throttle_limits_steady_playback_and_bypasses_seeks() {
        let mut th = TimePosThrottle::ui_default();
        let t0 = std::time::Instant::now();
        assert!(th.should_emit(0.0, t0));
        // Frame-rate updates within 250ms are throttled
        assert!(!th.should_emit(0.016, t0 + std::time::Duration::from_millis(16)));
        assert!(!th.should_emit(0.200, t0 + std::time::Duration::from_millis(200)));
        // After 250ms passes, emit again
        assert!(th.should_emit(0.250, t0 + std::time::Duration::from_millis(250)));
        // A jump >= 1.5s (seek) bypasses throttle immediately
        assert!(th.should_emit(12.0, t0 + std::time::Duration::from_millis(266)));
    }

    #[test]
    fn test_chapter_list_parsing_and_intro_extract_args() {
        let line = r#"{"event":"property-change","id":6,"name":"chapter-list","data":[{"title":"Opening","time":90.5},{"title":null,"time":0.0},{"title":"Part A","time":180}]}"#;
        match parse_line(line).unwrap() {
            MpvMessage::Event(MpvEvent::ChapterList(chaps)) => {
                assert_eq!(chaps.len(), 3);
                assert_eq!(
                    chaps[0],
                    MpvChapter {
                        title: None,
                        time: 0.0
                    }
                );
                assert_eq!(
                    chaps[1],
                    MpvChapter {
                        title: Some("Opening".to_string()),
                        time: 90.5
                    }
                );
                assert_eq!(
                    chaps[2],
                    MpvChapter {
                        title: Some("Part A".to_string()),
                        time: 180.0
                    }
                );
            }
            other => panic!("unexpected: {other:?}"),
        }

        // Null chapter-list clears chapters cleanly
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":6,"name":"chapter-list","data":null}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::ChapterList(Vec::new()))
        );

        let ff_audio = intro_extract_audio_args_ffmpeg("ep01.mkv", 540.0, Some(1));
        assert!(ff_audio.contains(&"-t".to_string()));
        assert!(ff_audio.contains(&"0:a:1".to_string()));
        assert!(ff_audio.contains(&"pipe:1".to_string()));

        let mpv_audio = intro_extract_audio_args_mpv("ep01.mkv", "out.pcm", 540.0, Some(2));
        assert!(mpv_audio.iter().any(|a| a == "--length=540.000"));
        assert!(mpv_audio.iter().any(|a| a == "--aid=2"));

        let ff_sub = intro_extract_sub_args_ffmpeg("ep01.mkv", 600.0, 0);
        assert!(ff_sub.contains(&"0:s:0".to_string()));
        assert!(ff_sub.contains(&"ass".to_string()));
    }

    #[test]
    fn test_seek_events_keyframes_cmd_and_pending_seek_tracker() {
        let exact = seek_absolute_cmd(10, 42.5);
        let preview = seek_keyframes_cmd(11, 42.5);
        assert!(exact.contains("absolute+exact"));
        assert!(preview.contains("absolute+keyframes"));

        assert_eq!(
            parse_line(r#"{"event":"seek"}"#).unwrap(),
            MpvMessage::Event(MpvEvent::Seek)
        );
        assert_eq!(
            parse_line(r#"{"event":"playback-restart"}"#).unwrap(),
            MpvMessage::Event(MpvEvent::PlaybackRestart)
        );
        assert_eq!(
            parse_line(r#"{"event":"property-change","id":7,"name":"seeking","data":true}"#)
                .unwrap(),
            MpvMessage::Event(MpvEvent::Seeking(true))
        );

        let mut tracker = PendingSeekTracker::new();
        let t0 = Instant::now();

        // Small (< 1.0s) seek must still suppress stale pre-seek time-pos before seek/restart
        tracker.note_dispatched_seek(100.5, Some(10), t0);
        assert_eq!(
            tracker.filter_time_pos(100.0, t0 + Duration::from_millis(5)),
            TimePosDecision::Drop
        );
        // Unpaired initial playback-restart before `"seek"` must NOT complete pending seek
        assert!(!tracker.on_playback_restart());
        assert_eq!(
            tracker.filter_time_pos(100.04, t0 + Duration::from_millis(8)),
            TimePosDecision::Drop
        );

        // Actual seek -> playback-restart settles cleanly and returns AcceptAfterSeek
        tracker.on_seek_event();
        assert!(tracker.on_playback_restart());
        assert_eq!(
            tracker.filter_time_pos(100.52, t0 + Duration::from_millis(20)),
            TimePosDecision::AcceptAfterSeek(100.52)
        );
        assert!(!tracker.is_active());

        // Two rapid queued seeks: intermediate 8.5 must be ignored until second restart completes
        tracker.note_dispatched_seek(8.5, Some(20), t0 + Duration::from_millis(100));
        tracker.note_dispatched_seek(14.2, Some(21), t0 + Duration::from_millis(102));
        tracker.on_seek_event();
        assert!(!tracker.on_playback_restart());
        assert_eq!(
            tracker.filter_time_pos(8.5, t0 + Duration::from_millis(110)),
            TimePosDecision::Drop
        );
        tracker.on_seek_event();
        assert!(tracker.on_playback_restart());
        assert_eq!(
            tracker.filter_time_pos(14.21, t0 + Duration::from_millis(120)),
            TimePosDecision::AcceptAfterSeek(14.21)
        );

        // Paused no-op seek without trailing time-pos settles when seeking turns false
        tracker.note_dispatched_seek(0.0, Some(30), t0 + Duration::from_millis(200));
        tracker.on_seek_event();
        let _ = tracker.on_seeking_prop(true);
        assert!(tracker.on_playback_restart());
        assert_eq!(tracker.on_seeking_prop(false), Some(0.0));
        assert!(!tracker.is_active());

        // Timeout fallback prevents wedging on malformed streams
        tracker.note_dispatched_seek(50.0, Some(40), t0);
        assert_eq!(
            tracker.filter_time_pos(50.1, t0 + Duration::from_millis(1300)),
            TimePosDecision::AcceptAfterSeek(50.1)
        );

        // New seek dispatched after seek #1 saw seeking=true & restart must NOT prematurely settle on seek #1's seeking=false
        tracker.clear();
        let t1 = t0 + Duration::from_secs(2);
        tracker.note_dispatched_seek(300.0, Some(50), t1);
        tracker.on_seek_event();
        assert_eq!(tracker.on_seeking_prop(true), None);
        tracker.note_dispatched_seek(900.0, Some(51), t1 + Duration::from_millis(10));
        assert!(!tracker.on_playback_restart());
        assert_eq!(tracker.on_seeking_prop(false), None);
        assert_eq!(
            tracker.filter_time_pos(300.2, t1 + Duration::from_millis(25)),
            TimePosDecision::Drop
        );
        tracker.on_seek_event();
        assert!(tracker.on_playback_restart());
        assert_eq!(
            tracker.filter_time_pos(900.05, t1 + Duration::from_millis(45)),
            TimePosDecision::AcceptAfterSeek(900.05)
        );

        // Two rapid seeks coalesced internally by mpv after replying to both commands settle on the restart following latest ack
        tracker.clear();
        let t2 = t0 + Duration::from_secs(4);
        tracker.note_dispatched_seek(200.0, Some(60), t2);
        tracker.note_dispatched_seek(720.0, Some(61), t2 + Duration::from_millis(8));
        tracker.on_reply_success(60);
        tracker.on_reply_success(61);
        tracker.on_seek_event();
        assert!(tracker.on_playback_restart());
        assert_eq!(
            tracker.filter_time_pos(720.02, t2 + Duration::from_millis(30)),
            TimePosDecision::AcceptAfterSeek(720.02)
        );
    }

    #[test]
    fn test_pending_seek_tracker_extends_window_while_seeking_true() {
        let mut tracker = PendingSeekTracker::new();
        let t0 = Instant::now();
        tracker.note_dispatched_seek(900.0, Some(70), t0);
        tracker.on_reply_success(70);
        tracker.on_seek_event();
        assert_eq!(tracker.on_seeking_prop(true), None);

        // Slow exact seek still decoding past 1200ms must keep dropping stale pre-seek time-pos
        assert_eq!(
            tracker.filter_time_pos(120.0, t0 + Duration::from_millis(1800)),
            TimePosDecision::Drop
        );

        // Once mpv finishes seeking and restarts at the clicked minute, emit the landed position
        assert!(tracker.on_playback_restart());
        assert_eq!(
            tracker.filter_time_pos(900.04, t0 + Duration::from_millis(1850)),
            TimePosDecision::AcceptAfterSeek(900.04)
        );
    }

    #[test]
    fn test_screenshot_to_file_cmd_encodes_mode_and_path() {
        let cmd = screenshot_to_file_cmd(55, r"C:\Temp\epilod_freeze.jpg", true);
        let parsed: Value = serde_json::from_str(cmd.trim()).expect("valid cmd json");
        assert_eq!(parsed["request_id"], 55);
        assert_eq!(
            parsed["command"],
            json!([
                "screenshot-to-file",
                r"C:\Temp\epilod_freeze.jpg",
                "subtitles"
            ])
        );

        let video_only = screenshot_to_file_cmd(56, "/tmp/out.jpg", false);
        let parsed2: Value = serde_json::from_str(video_only.trim()).expect("valid cmd json");
        assert_eq!(
            parsed2["command"],
            json!(["screenshot-to-file", "/tmp/out.jpg", "video"])
        );

        let margin = set_video_margin_right_cmd(57, 0.197916);
        let parsed3: Value = serde_json::from_str(margin.trim()).expect("valid margin json");
        assert_eq!(
            parsed3["command"],
            json!(["set_property", "video-margin-ratio-right", 0.1979])
        );
        let clamped_neg = set_video_margin_right_cmd(58, f64::NAN);
        let parsed4: Value = serde_json::from_str(clamped_neg.trim()).expect("valid nan json");
        assert_eq!(
            parsed4["command"],
            json!(["set_property", "video-margin-ratio-right", 0.0])
        );

        let left_margin = set_video_margin_left_cmd(59, 0.21875);
        let parsed5: Value =
            serde_json::from_str(left_margin.trim()).expect("valid left margin json");
        assert_eq!(
            parsed5["command"],
            json!(["set_property", "video-margin-ratio-left", 0.2188])
        );
        let left_clamped = set_video_margin_left_cmd(60, 1.5);
        let parsed6: Value = serde_json::from_str(left_clamped.trim()).expect("valid clamped json");
        assert_eq!(
            parsed6["command"],
            json!(["set_property", "video-margin-ratio-left", 0.75])
        );
    }

    #[test]
    fn test_set_dialogue_boost_cmd_toggles_dynaudnorm_filter() {
        let on_cmd = set_dialogue_boost_cmd(91, true);
        let on_parsed: Value = serde_json::from_str(on_cmd.trim()).expect("valid on json");
        assert_eq!(on_parsed["request_id"], 91);
        assert_eq!(
            on_parsed["command"],
            json!([
                "set_property",
                "af",
                "lavfi=[dynaudnorm=f=150:g=15:p=0.9:m=10]"
            ])
        );

        let off_cmd = set_dialogue_boost_cmd(92, false);
        let off_parsed: Value = serde_json::from_str(off_cmd.trim()).expect("valid off json");
        assert_eq!(off_parsed["request_id"], 92);
        assert_eq!(off_parsed["command"], json!(["set_property", "af", ""]));
    }
}
