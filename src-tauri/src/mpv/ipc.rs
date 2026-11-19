#![cfg(windows)]

use super::DeferredLoadState;
use epilod_core::mpv_ipc::{
    encode_observe, parse_line, seek_absolute_cmd, set_pause_cmd, MpvEvent, MpvMessage, MpvReply,
    PendingSeekTracker, TimePosDecision, TimePosThrottle,
};
use epilod_core::syncplay::PlayerSnapshot;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::{mpsc, oneshot};

pub type PendingReplyMap = Arc<Mutex<HashMap<u64, oneshot::Sender<MpvReply>>>>;

#[allow(clippy::type_complexity)]
#[allow(clippy::too_many_arguments)]
pub async fn connect_and_run_ipc<F>(
    pipe_name: String,
    app: AppHandle,
    cmd_tx: mpsc::Sender<String>,
    mut cmd_rx: mpsc::Receiver<String>,
    snapshot: Arc<Mutex<PlayerSnapshot>>,
    loading_media: Arc<AtomicBool>,
    deferred_load: Arc<Mutex<DeferredLoadState>>,
    pending_seek: Arc<Mutex<PendingSeekTracker>>,
    pending_replies: PendingReplyMap,
    client_seek_seq: Arc<AtomicU64>,
    volume_reassert_cb: Arc<Mutex<Option<Arc<dyn Fn() + Send + Sync>>>>,
    check_child_exited: F,
) -> String
where
    F: Fn() -> Option<String> + Send,
{
    let full_pipe = format!(r"\\.\pipe\{pipe_name}");
    let mut client = None;
    for _ in 0..200 {
        match ClientOptions::new().open(&full_pipe) {
            Ok(c) => {
                client = Some(c);
                break;
            }
            Err(_) => {
                if let Some(status_msg) = check_child_exited() {
                    return format!("Playback engine exited during startup ({status_msg}).");
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
    }

    let Some(stream) = client else {
        return "Timed out connecting to mpv IPC pipe.".to_string();
    };

    let (reader_half, mut writer_half) = tokio::io::split(stream);

    // Observe key properties immediately on connect
    let init_cmds = [
        encode_observe(1, 1, "time-pos"),
        encode_observe(2, 2, "duration"),
        encode_observe(3, 3, "pause"),
        encode_observe(4, 4, "track-list"),
        encode_observe(5, 5, "eof-reached"),
        encode_observe(6, 6, "chapter-list"),
        encode_observe(7, 7, "seeking"),
    ];
    for c in init_cmds {
        if writer_half.write_all(c.as_bytes()).await.is_err() {
            return "mpv IPC write error during initialization.".to_string();
        }
    }

    let writer_task = tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            if writer_half.write_all(cmd.as_bytes()).await.is_err() {
                break;
            }
        }
    });
    if let Some(cb) = volume_reassert_cb
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
    {
        cb();
    }

    let mut ui_time_throttle = TimePosThrottle::ui_default();
    let mut eof_emitted = false;
    let mut lines = BufReader::new(reader_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match parse_line(&line) {
            Ok(MpvMessage::Event(ev)) => match ev {
                MpvEvent::TimePos(position) => {
                    if loading_media.load(Ordering::SeqCst) {
                        continue;
                    }
                    let decision = {
                        let mut ps = pending_seek.lock().unwrap_or_else(|e| e.into_inner());
                        ps.filter_time_pos(position, Instant::now())
                    };
                    let emit_pos = match decision {
                        TimePosDecision::Drop => continue,
                        TimePosDecision::AcceptAfterSeek(pos) => {
                            ui_time_throttle.reset();
                            let _ = ui_time_throttle.should_emit(pos, Instant::now());
                            snapshot.lock().unwrap_or_else(|e| e.into_inner()).position = pos;
                            Some(pos)
                        }
                        TimePosDecision::Accept(pos) => {
                            snapshot.lock().unwrap_or_else(|e| e.into_inner()).position = pos;
                            if ui_time_throttle.should_emit(pos, Instant::now()) {
                                Some(pos)
                            } else {
                                None
                            }
                        }
                    };
                    if let Some(pos) = emit_pos {
                        let _ = app.emit(
                            "mpv://time",
                            serde_json::json!({
                                "position": pos,
                                "clientSeekSeq": client_seek_seq.load(Ordering::SeqCst),
                            }),
                        );
                    }
                }
                MpvEvent::Seek => {
                    if !loading_media.load(Ordering::SeqCst) {
                        pending_seek
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .on_seek_event();
                    }
                }
                MpvEvent::PlaybackRestart => {
                    if !loading_media.load(Ordering::SeqCst) {
                        let all_restarted = pending_seek
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .on_playback_restart();
                        if all_restarted {
                            ui_time_throttle.reset();
                            let _ = app.emit("mpv://seek-settled", ());
                        }
                    }
                }
                MpvEvent::Seeking(seeking) => {
                    if !loading_media.load(Ordering::SeqCst) {
                        let settled = pending_seek
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .on_seeking_prop(seeking);
                        if let Some(pos) = settled {
                            ui_time_throttle.reset();
                            let _ = ui_time_throttle.should_emit(pos, Instant::now());
                            snapshot.lock().unwrap_or_else(|e| e.into_inner()).position = pos;
                            let _ = app.emit(
                                "mpv://time",
                                serde_json::json!({
                                    "position": pos,
                                    "clientSeekSeq": client_seek_seq.load(Ordering::SeqCst),
                                }),
                            );
                            let _ = app.emit("mpv://seek-settled", ());
                        }
                    }
                }
                MpvEvent::Duration(duration) => {
                    if loading_media.load(Ordering::SeqCst) {
                        continue;
                    }
                    let _ = app.emit(
                        "mpv://duration",
                        serde_json::json!({ "duration": duration }),
                    );
                }
                MpvEvent::Paused(paused) => {
                    if loading_media.load(Ordering::SeqCst) {
                        continue;
                    }
                    {
                        let mut snap = snapshot.lock().unwrap_or_else(|e| e.into_inner());
                        snap.paused = paused;
                    }
                    let _ = app.emit("mpv://paused", serde_json::json!({ "paused": paused }));
                }
                MpvEvent::EofReached(eof) => {
                    if !eof {
                        eof_emitted = false;
                    } else if !loading_media.load(Ordering::SeqCst) && !eof_emitted {
                        eof_emitted = true;
                        let _ = app.emit(
                            "mpv://ended",
                            serde_json::json!({ "reason": "eof", "error": serde_json::Value::Null }),
                        );
                    }
                }
                MpvEvent::FileLoaded => {
                    let (deferred_seek, deferred_pause) = {
                        let mut def = deferred_load.lock().unwrap_or_else(|e| e.into_inner());
                        def.loading = false;
                        loading_media.store(false, Ordering::SeqCst);
                        (def.seek_secs.take(), def.pause.take())
                    };
                    eof_emitted = false;
                    pending_seek
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clear();
                    ui_time_throttle.reset();
                    let _ = app.emit("mpv://file-loaded", ());
                    if let Some(cb) = volume_reassert_cb
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone()
                    {
                        cb();
                    }
                    if let Some(target) = deferred_seek {
                        pending_seek
                            .lock()
                            .unwrap_or_else(|e| e.into_inner())
                            .note_dispatched_seek(target, Some(900_002), Instant::now());
                        snapshot.lock().unwrap_or_else(|e| e.into_inner()).position = target;
                        let _ = cmd_tx.try_send(seek_absolute_cmd(900_002, target));
                    }
                    if let Some(paused) = deferred_pause {
                        snapshot.lock().unwrap_or_else(|e| e.into_inner()).paused = paused;
                        let _ = cmd_tx.try_send(set_pause_cmd(900_001, paused));
                        let _ = app.emit("mpv://paused", serde_json::json!({ "paused": paused }));
                    }
                }
                MpvEvent::EndFile { reason, file_error } => {
                    // Note: `loadfile <next> replace` emits `end-file` with `reason: "stop"` on the
                    // outgoing entry before `file-loaded` of the replacement fires. Never clear
                    // `loading_media` on `"stop"` / `"replace"` / `"redirect"`, or delayed EOF/pause
                    // events from the outgoing episode will leak into the incoming episode.
                    match reason.as_deref() {
                        Some("error") => {
                            {
                                let mut def =
                                    deferred_load.lock().unwrap_or_else(|e| e.into_inner());
                                *def = DeferredLoadState::default();
                                loading_media.store(false, Ordering::SeqCst);
                            }
                            let error = file_error
                                .map(|e| format!("Media playback failed: {e}"))
                                .unwrap_or_else(|| "Media playback failed.".to_string());
                            let _ = app.emit(
                                "mpv://ended",
                                serde_json::json!({ "reason": reason, "error": Some(error) }),
                            );
                        }
                        Some("eof") => {
                            if !loading_media.load(Ordering::SeqCst) && !eof_emitted {
                                eof_emitted = true;
                                pending_seek
                                    .lock()
                                    .unwrap_or_else(|e| e.into_inner())
                                    .clear();
                                let _ = app.emit(
                                    "mpv://ended",
                                    serde_json::json!({ "reason": "eof", "error": serde_json::Value::Null }),
                                );
                            }
                        }
                        _ => {
                            let _ = app.emit(
                                "mpv://ended",
                                serde_json::json!({ "reason": reason, "error": serde_json::Value::Null }),
                            );
                        }
                    }
                }
                MpvEvent::TrackList(tracks) => {
                    let _ = app.emit("mpv://tracks", tracks);
                }
                MpvEvent::ChapterList(chapters) => {
                    let _ = app.emit("mpv://chapters", chapters);
                }
                MpvEvent::Other => {}
            },
            Ok(MpvMessage::Reply(rep)) => {
                let pending_tx = pending_replies
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&rep.request_id);
                if let Some(tx) = pending_tx {
                    let _ = tx.send(rep);
                    continue;
                }
                if rep.error == "success" || rep.error.is_empty() {
                    pending_seek
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .on_reply_success(rep.request_id);
                } else if rep.error != "property unavailable" {
                    pending_seek
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .on_reply_error(rep.request_id);
                    let _ = app.emit(
                        "mpv://command-warning",
                        serde_json::json!({ "message": format!("mpv command warning: {}", rep.error) }),
                    );
                }
            }
            Err(_) => {}
        }
    }

    pending_replies
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clear();
    writer_task.abort();
    "Playback engine stopped unexpectedly.".to_string()
}
