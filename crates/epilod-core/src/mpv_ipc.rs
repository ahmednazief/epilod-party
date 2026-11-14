use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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
    pub kind: String,
    pub title: Option<String>,
    pub lang: Option<String>,
    pub codec: Option<String>,
    pub selected: bool,
    pub external: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MpvEvent {
    TimePos(f64),
    Duration(f64),
    Paused(bool),
    FileLoaded,
    EndFile {
        reason: Option<String>,
        file_error: Option<String>,
    },
    TrackList(Vec<MpvTrack>),
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

pub fn seek_absolute_cmd(request_id: u64, seconds: f64) -> String {
    let clamped = if seconds.is_finite() {
        seconds.max(0.0)
    } else {
        0.0
    };
    encode_command(
        request_id,
        &[json!("seek"), json!(clamped), json!("absolute+exact")],
    )
}

pub fn stop_cmd(request_id: u64) -> String {
    encode_command(request_id, &[json!("stop")])
}

pub fn set_property_cmd(request_id: u64, name: &str, value: Value) -> String {
    encode_command(request_id, &[json!("set_property"), json!(name), value])
}

pub fn set_volume_cmd(request_id: u64, volume: f64) -> String {
    let clamped = if volume.is_finite() {
        volume.clamp(0.0, 100.0)
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

pub fn sub_add_cmd(request_id: u64, path: &str) -> String {
    encode_command(
        request_id,
        &[json!("sub-add"), json!(path), json!("select")],
    )
}

pub fn sub_reload_cmd(request_id: u64) -> String {
    encode_command(request_id, &[json!("sub-reload")])
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
    let safe_pos = pos.clamp(50, 100);
    let ass_override = if override_ass { "force" } else { "yes" };
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
                    "track-list" => {
                        if let Some(arr) = data.and_then(|v| v.as_array()) {
                            let tracks = parse_track_list(arr);
                            return Ok(MpvMessage::Event(MpvEvent::TrackList(tracks)));
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
            })
        })
        .collect()
}

pub fn launch_args(wid: u64, pipe_name: &str) -> Vec<String> {
    launch_args_with_fonts(wid, pipe_name, None)
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
        "--no-config".to_string(),
        "--load-scripts=no".to_string(),
        "--ytdl=no".to_string(),
        "--force-window=yes".to_string(),
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
    let mut args = vec![
        "-y".to_string(),
        "-vn".to_string(),
        "-sn".to_string(),
        "-i".to_string(),
        video_path.to_string(),
    ];
    if let Some(idx) = audio_stream_idx {
        args.push("-map".to_string());
        args.push(format!("0:a:{idx}"));
    } else {
        args.push("-map".to_string());
        args.push("0:a:0".to_string());
    }
    args.extend([
        "-ac".to_string(),
        "1".to_string(),
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

/// Fix 23: Extract an embedded text subtitle track (`sid`) to an external `.srt`/`.ass` file via `ffmpeg` or `mpv`.
pub fn autosync_extract_sub_args_ffmpeg(
    video_path: &str,
    out_sub_path: &str,
    sub_stream_idx: usize,
) -> Vec<String> {
    vec![
        "-y".to_string(),
        "-vn".to_string(),
        "-an".to_string(),
        "-i".to_string(),
        video_path.to_string(),
        "-map".to_string(),
        format!("0:s:{sub_stream_idx}"),
        out_sub_path.to_string(),
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
        let launch = launch_args(123, "p");
        for req in [
            "--hwdec=auto-safe",
            "--audio-channels=auto-safe",
            "--audio-pitch-correction=yes",
            "--embeddedfonts=yes",
            "--no-config",
            "--load-scripts=no",
            "--ytdl=no",
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
    }

    #[test]
    fn test_volume_and_mute_commands() {
        let v = set_volume_cmd(1, 150.0);
        assert!(v.contains("100"));
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
    }

    #[test]
    fn test_subtitle_commands_and_rtl_paths() {
        let add = sub_add_cmd(1, r"C:\Subs\العربية.srt");
        assert!(add.contains("sub-add"));
        let cmds = set_sub_style_cmds(10, "Noto Sans Arabic", 48, "#FFFFFF", 2.0, 95, true, true);
        assert_eq!(cmds.len(), 7);
        assert!(cmds
            .iter()
            .any(|c| c.contains("sub-ass-override") && c.contains("force")));
    }

    #[test]
    fn test_track_list_parsing_and_track_commands() {
        let line = r#"{"event":"property-change","id":4,"name":"track-list","data":[{"id":1,"type":"audio","title":"JP","lang":"jpn","codec":"aac","selected":true,"external":false},{"id":2,"type":"sub","title":null,"lang":"ara","codec":"ass","selected":true,"external":true}]}"#;
        match parse_line(line).unwrap() {
            MpvMessage::Event(MpvEvent::TrackList(tracks)) => {
                assert_eq!(tracks.len(), 2);
                assert_eq!(tracks[0].kind, "audio");
                assert_eq!(tracks[1].kind, "sub");
                assert!(tracks[1].external);
            }
            other => panic!("unexpected: {other:?}"),
        }
        assert!(set_aid_cmd(1, None).contains("\"no\""));
        assert!(set_sid_cmd(2, Some(3)).contains("3"));
    }
}
