#![cfg(windows)]

use epilod_core::mpv_ipc::{encode_observe, parse_line, MpvEvent, MpvMessage};
use epilod_core::syncplay::PlayerSnapshot;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::windows::named_pipe::ClientOptions;
use tokio::sync::mpsc;

pub async fn connect_and_run_ipc(
    pipe_name: String,
    app: AppHandle,
    mut cmd_rx: mpsc::Receiver<String>,
    snapshot: Arc<Mutex<PlayerSnapshot>>,
) {
    let full_pipe = format!(r"\\.\pipe\{pipe_name}");
    let mut client = None;
    for _ in 0..50 {
        match ClientOptions::new().open(&full_pipe) {
            Ok(c) => {
                client = Some(c);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(100)).await,
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

    let mut lines = BufReader::new(reader_half).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match parse_line(&line) {
            Ok(MpvMessage::Event(ev)) => match ev {
                MpvEvent::TimePos(position) => {
                    if let Ok(mut snap) = snapshot.lock() {
                        snap.position = position;
                    }
                    let _ = app.emit("mpv://time", serde_json::json!({ "position": position }));
                }
                MpvEvent::Duration(duration) => {
                    let _ = app.emit(
                        "mpv://duration",
                        serde_json::json!({ "duration": duration }),
                    );
                }
                MpvEvent::Paused(paused) => {
                    if let Ok(mut snap) = snapshot.lock() {
                        snap.paused = paused;
                    }
                    let _ = app.emit("mpv://paused", serde_json::json!({ "paused": paused }));
                }
                MpvEvent::FileLoaded => {
                    let _ = app.emit("mpv://file-loaded", ());
                }
                MpvEvent::EndFile { reason, file_error } => {
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
                if rep.error != "success" && !rep.error.is_empty() {
                    let _ = app.emit(
                        "mpv://error",
                        serde_json::json!({ "message": format!("mpv command error: {}", rep.error) }),
                    );
                }
            }
            Err(_) => {}
        }
    }

    writer_task.abort();
}
