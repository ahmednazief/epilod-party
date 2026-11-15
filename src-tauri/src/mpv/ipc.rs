#![cfg(windows)]

use epilod_core::mpv_ipc::{encode_observe, parse_line, MpvEvent, MpvMessage, TimePosThrottle};
use epilod_core::syncplay::PlayerSnapshot;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc;

pub async fn connect_and_run_ipc(
    pipe_name: String,
    app: AppHandle,
    mut cmd_rx: mpsc::Receiver<String>,
    snapshot: Arc<Mutex<PlayerSnapshot>>,
    loading_media: Arc<AtomicBool>,
    pending_seek: Arc<Mutex<Option<(f64, Instant)>>>,
) {
    let full_pipe = format!(r"\\.\pipe\{pipe_name}");
    let mut client = None;
    for _ in 0..200 {
        match ClientOptions::new().open(&full_pipe) {
            Ok(c) => {
                client = Some(c);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }

    let Some(stream) = client else {
        let _ = app.emit(
            "mpv://error",
            serde_json::json!({ "message": "Timed out connecting to mpv IPC pipe." }),
        );
        return;
    };

    let (reader_half, mut writer_half) = tokio::io::split(stream);

    // Observe key properties immediately on connect
    let init_cmds = [
        encode_observe(1, 1, "time-pos"),
        encode_observe(2, 2, "duration"),
        encode_observe(3, 3, "pause"),
        encode_observe(4, 4, "track-list"),
        encode_observe(5, 5, "eof-reached"),
    ];
    for c in init_cmds {
        if writer_half.write_all(c.as_bytes()).await.is_err() {
            let _ = app.emit(
                "mpv://error",
                serde_json::json!({ "message": "mpv IPC write error during initialization." }),
            );
            return;
        }
    }

    let writer_task = tokio::spawn(async move {
        while let Some(cmd) = cmd_rx.recv().await {
            if writer_half.write_all(cmd.as_bytes()).await.is_err() {
                break;
            }
        }
    });

    let mut ui_time_throttle = TimePosThrottle::ui_default();
    let mut lines = BufReader::new(reader_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match parse_line(&line) {
            Ok(MpvMessage::Event(ev)) => match ev {
                MpvEvent::TimePos(position) => {
                    if loading_media.load(Ordering::SeqCst) {
                        continue;
                    }
                    let skip_stale_seek = {
                        let mut ps = pending_seek.lock().unwrap_or_else(|e| e.into_inner());
                        if let Some((target, at)) = *ps {
                            if at.elapsed() < Duration::from_millis(2500)
                                && (position - target).abs() > 1.0
                            {
                                true
                            } else {
                                *ps = None;
                                false
                            }
                        } else {
                            false
                        }
                    };
                    if skip_stale_seek {
                        continue;
                    }
                    {
                        let mut snap = snapshot.lock().unwrap_or_else(|e| e.into_inner());
                        snap.position = position;
                    }
                    if ui_time_throttle.should_emit(position, Instant::now()) {
                        let _ = app.emit("mpv://time", serde_json::json!({ "position": position }));
                    }
                }
                MpvEvent::Duration(duration) => {
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
                    if eof && !loading_media.load(Ordering::SeqCst) {
                        let _ = app.emit(
                            "mpv://ended",
                            serde_json::json!({ "reason": "eof", "error": serde_json::Value::Null }),
                        );
                    }
                }
                MpvEvent::FileLoaded => {
                    loading_media.store(false, Ordering::SeqCst);
                    ui_time_throttle.reset();
                    let _ = app.emit("mpv://file-loaded", ());
                }
                MpvEvent::EndFile { reason, file_error } => {
                    if reason.as_deref() != Some("replace") && reason.as_deref() != Some("redirect")
                    {
                        loading_media.store(false, Ordering::SeqCst);
                    }
                    let error = if reason.as_deref() == Some("error") {
                        Some(
                            file_error
                                .map(|e| format!("Media playback failed: {e}"))
                                .unwrap_or_else(|| "Media playback failed.".to_string()),
                        )
                    } else {
                        None
                    };
                    let _ = app.emit(
                        "mpv://ended",
                        serde_json::json!({ "reason": reason, "error": error }),
                    );
                }
                MpvEvent::TrackList(tracks) => {
                    let _ = app.emit("mpv://tracks", tracks);
                }
                MpvEvent::Other => {}
            },
            Ok(MpvMessage::Reply(rep)) => {
                if rep.error != "success"
                    && !rep.error.is_empty()
                    && rep.error != "property unavailable"
                {
                    let _ = app.emit(
                        "mpv://command-warning",
                        serde_json::json!({ "message": format!("mpv command warning: {}", rep.error) }),
                    );
                }
            }
            Err(_) => {}
        }
    }

    writer_task.abort();
}
