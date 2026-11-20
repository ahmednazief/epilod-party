#![cfg(windows)]

use crate::mpv::MpvController;
use crate::p2p::{P2pAutoAlignment, P2pControlCmd, P2pLocalMedia, P2pSessionHandle};
use crate::syncplay::{LocalFileMeta, ParticipantDto, RoomOccupancyDto, SyncCommand};
use crate::voice::VoiceController;
use epilod_core::cloud_sync::{
    build_cloud_peek_path, build_cloud_ws_url, decode_http_response_body, hash_room_password,
    ClockSyncEstimator, CloudClientMsg, CloudParticipant, CloudPeekResponse, CloudPlaybackState,
    CloudRoomControl, CloudServerMsg, CLOUD_DRIFT_SEEK_THRESHOLD_SECS,
    CLOUD_DRIFT_SPEED_THRESHOLD_SECS,
};
use epilod_core::matching::{analyze_files, FileIdentity};
use epilod_core::mpv_ipc::{set_pause_cmd, set_speed_cmd};
use epilod_core::p2p::{ChatFallbackPacket, ChatReactFallbackPacket, ReactionFallbackPacket};
use epilod_core::room_code::{generate as generate_room_code, resolve_syncplay_room};
use epilod_core::room_control::RoomControlSummary;
use epilod_core::syncplay::{
    hash_filename, hash_filesize, ReconnectPolicy, TimelineSegment, TimelineTransform, WireFileInfo,
};
use epilod_core::validation::LocalPathOptions;
use futures_util::{SinkExt, StreamExt};
use native_tls::TlsConnector as NativeTlsConnector;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_native_tls::TlsConnector;
use tokio_tungstenite::tungstenite::Message;

const MAX_CLAIM_REROLLS: u8 = 5;
const ECHO_SUPPRESSION_MS: u64 = 1200;

fn now_epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn reroll_distinct_six_digit_code(current: Option<&str>) -> Option<(String, String)> {
    for _ in 0..8 {
        if let Ok(code) = generate_room_code() {
            if current.is_some_and(|prev| prev == code) {
                continue;
            }
            if let Ok(wire_room) = resolve_syncplay_room(&code, false) {
                return Some((code, wire_room));
            }
        }
    }
    None
}

fn to_wire_file(meta: &LocalFileMeta) -> WireFileInfo {
    if meta.hash_identity {
        WireFileInfo {
            name: hash_filename(&meta.name),
            size: None,
            size_hash: meta.size_bytes.map(hash_filesize),
            duration: (meta.duration_secs > 0.0).then_some(meta.duration_secs),
        }
    } else {
        WireFileInfo {
            name: meta.name.clone(),
            size: meta.size_bytes,
            size_hash: None,
            duration: (meta.duration_secs > 0.0).then_some(meta.duration_secs),
        }
    }
}

fn build_local_file_identity(
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
) -> Option<FileIdentity> {
    let guard = local_file.lock().ok()?;
    let meta = guard.as_ref()?;
    if meta.hash_identity {
        Some(FileIdentity {
            name: hash_filename(&meta.name),
            size_bytes: None,
            size_hash: meta.size_bytes.map(hash_filesize),
            duration_secs: (meta.duration_secs > 0.0).then_some(meta.duration_secs),
            is_hashed: true,
        })
    } else {
        Some(FileIdentity {
            name: meta.name.clone(),
            size_bytes: meta.size_bytes,
            size_hash: None,
            duration_secs: (meta.duration_secs > 0.0).then_some(meta.duration_secs),
            is_hashed: false,
        })
    }
}

fn build_peer_file_identity(file: &WireFileInfo) -> FileIdentity {
    let is_hashed = file.size.is_none() && file.size_hash.is_some();
    FileIdentity {
        name: file.name.clone(),
        size_bytes: file.size,
        size_hash: file.size_hash.clone(),
        duration_secs: file.duration,
        is_hashed,
    }
}

fn build_p2p_local_media(
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    local_media_path: &Arc<Mutex<Option<PathBuf>>>,
    has_user_alignment: &Arc<Mutex<bool>>,
) -> Option<P2pLocalMedia> {
    let id = build_local_file_identity(local_file)?;
    let path = local_media_path.lock().ok().and_then(|g| g.clone());
    let user_aligned = has_user_alignment.lock().ok().map(|g| *g).unwrap_or(false);
    let file_sig = format!(
        "{}|{:?}|{:?}|{:?}",
        id.name,
        id.size_bytes,
        id.size_hash,
        id.duration_secs.map(|d| (d * 10.0).round() as i64)
    );
    Some(P2pLocalMedia {
        file_sig,
        identity: id,
        path,
        has_user_alignment: user_aligned,
    })
}

fn map_room_to_local(room_pos: f64, tx: TimelineTransform, segments: &[TimelineSegment]) -> f64 {
    if !segments.is_empty() {
        for seg in segments.iter().rev() {
            if room_pos >= seg.room_start_secs {
                return (room_pos * seg.scale + seg.offset_secs).max(0.0);
            }
        }
        let first = &segments[0];
        return (room_pos * first.scale + first.offset_secs).max(0.0);
    }
    tx.room_to_local(room_pos, None)
}

fn map_local_to_room(local_pos: f64, tx: TimelineTransform, segments: &[TimelineSegment]) -> f64 {
    if !segments.is_empty() {
        for seg in segments.iter().rev() {
            let seg_local_start = seg.room_start_secs * seg.scale + seg.offset_secs;
            if local_pos >= seg_local_start && seg.scale > 0.1 {
                return ((local_pos - seg.offset_secs) / seg.scale).max(0.0);
            }
        }
        let first = &segments[0];
        if first.scale > 0.1 {
            return ((local_pos - first.offset_secs) / first.scale).max(0.0);
        }
    }
    tx.local_to_room(local_pos)
}

fn emit_cloud_participants(
    app: &AppHandle,
    participants: &[CloudParticipant],
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
) {
    let local_id = build_local_file_identity(local_file);
    let mut list: Vec<ParticipantDto> = participants
        .iter()
        .map(|p| {
            let peer_id = p.file.as_ref().map(build_peer_file_identity);
            let cmp = analyze_files(local_id.as_ref(), peer_id.as_ref());
            ParticipantDto {
                username: p.username.clone(),
                room: p.room.clone(),
                position: p.position,
                file_name: p.file.as_ref().map(|f| f.name.clone()),
                file_duration: p.file.as_ref().and_then(|f| f.duration),
                is_ready: p.is_ready,
                is_controller: p.is_controller || p.is_host || p.is_admin,
                is_host: p.is_host,
                is_admin: p.is_admin,
                file_match: cmp.status,
                source_relation: cmp.source_relation,
                duration_delta_secs: cmp.duration_delta_secs,
                suggested_fps_scale: cmp.suggested_fps_scale,
                suggested_fps_label: cmp.suggested_fps_label,
            }
        })
        .collect();
    list.sort_by(|a, b| a.username.cmp(&b.username));
    let _ = app.emit("sync://participants", list);
}

enum CloudSessionExit {
    Clean,
    RoomOccupiedCollision,
    QuotaExceeded {
        message: String,
    },
    FatalAuth {
        message: String,
    },
    Error {
        message: String,
        was_connected: bool,
    },
}

#[allow(clippy::too_many_arguments)]
pub async fn run_cloud_sync_loop(
    app: AppHandle,
    mpv: Arc<MpvController>,
    endpoint: String,
    username: String,
    initial_wire_room: String,
    shared_wire_room: Arc<Mutex<String>>,
    initial_six_digit: Option<String>,
    initial_claim_empty: bool,
    password: Option<String>,
    host_only: bool,
    network_opts: LocalPathOptions,
    mut rx: mpsc::Receiver<SyncCommand>,
    local_file: Arc<Mutex<Option<LocalFileMeta>>>,
    local_media_path: Arc<Mutex<Option<PathBuf>>>,
    local_ready: Arc<Mutex<bool>>,
    timeline_transform: Arc<Mutex<TimelineTransform>>,
    timeline_segments: Arc<Mutex<Vec<TimelineSegment>>>,
    has_user_alignment: Arc<Mutex<bool>>,
    align_mode: Arc<Mutex<bool>>,
    voice: Arc<Mutex<Option<Arc<VoiceController>>>>,
) {
    let mut policy = ReconnectPolicy::new();
    let mut current_wire_room = initial_wire_room;
    let mut current_six_digit = initial_six_digit;
    let mut claim_empty = initial_claim_empty;
    let mut claim_rerolls: u8 = 0;
    let mut rerolled_code_to_emit: Option<String> = None;
    let mut persisted_host_token: Option<String> = None;

    loop {
        let attempt = policy.attempt + 1;
        let _ = app.emit(
            "sync://status",
            serde_json::json!({
                "state": "connecting",
                "endpoint": endpoint,
                "attempt": attempt,
            }),
        );

        let exit = run_single_cloud_session(
            &app,
            &mpv,
            &endpoint,
            &username,
            &current_wire_room,
            rerolled_code_to_emit.as_deref(),
            claim_empty,
            password.as_deref(),
            host_only,
            &mut persisted_host_token,
            network_opts,
            &mut rx,
            &local_file,
            &local_media_path,
            &local_ready,
            &timeline_transform,
            &timeline_segments,
            &has_user_alignment,
            &align_mode,
            &voice,
        )
        .await;

        match exit {
            CloudSessionExit::Clean => break,
            CloudSessionExit::RoomOccupiedCollision => {
                if claim_rerolls < MAX_CLAIM_REROLLS {
                    if let Some((new_code, new_wire)) =
                        reroll_distinct_six_digit_code(current_six_digit.as_deref())
                    {
                        claim_rerolls += 1;
                        current_six_digit = Some(new_code.clone());
                        current_wire_room = new_wire.clone();
                        rerolled_code_to_emit = Some(new_code);
                        if let Ok(mut guard) = shared_wire_room.lock() {
                            *guard = new_wire;
                        }
                        continue;
                    }
                }
                let _ = app.emit(
                    "sync://status",
                    serde_json::json!({
                        "state": "error",
                        "endpoint": endpoint,
                        "message": "Could not find an empty 6-digit room code. Please try again.",
                        "suggestBackup": false,
                        "circuitOpen": true,
                    }),
                );
                break;
            }
            CloudSessionExit::QuotaExceeded { message } => {
                let _ = app.emit("sync://error", serde_json::json!({ "message": message }));
                let _ = app.emit(
                    "sync://status",
                    serde_json::json!({
                        "state": "error",
                        "endpoint": endpoint,
                        "message": message,
                        "suggestBackup": true,
                        "circuitOpen": true,
                    }),
                );
                // Stop hammering the Worker; wait for ManualRetry or disconnect.
                let mut retry = false;
                while let Some(cmd) = rx.recv().await {
                    if matches!(cmd, SyncCommand::ManualRetry | SyncCommand::ForceResync) {
                        policy.manual_retry();
                        retry = true;
                        break;
                    }
                }
                if !retry {
                    break;
                }
            }
            CloudSessionExit::FatalAuth { message } => {
                let _ = app.emit("sync://error", serde_json::json!({ "message": message }));
                let _ = app.emit(
                    "sync://status",
                    serde_json::json!({
                        "state": "error",
                        "endpoint": endpoint,
                        "message": message,
                        "suggestBackup": false,
                        "circuitOpen": true,
                    }),
                );
                break;
            }
            CloudSessionExit::Error {
                message,
                was_connected,
            } => {
                if was_connected {
                    policy.on_connected();
                    claim_empty = false;
                    rerolled_code_to_emit = None;
                } else {
                    claim_empty = false;
                }
                let Some(wait_secs) = policy.next_delay_secs() else {
                    let _ = app.emit(
                        "sync://status",
                        serde_json::json!({
                            "state": "error",
                            "endpoint": endpoint,
                            "message": format!("Disconnected after retries: {message}"),
                            "suggestBackup": true,
                            "circuitOpen": true,
                        }),
                    );
                    let mut retry = false;
                    while let Some(cmd) = rx.recv().await {
                        if matches!(cmd, SyncCommand::ManualRetry | SyncCommand::ForceResync) {
                            policy.manual_retry();
                            retry = true;
                            break;
                        }
                    }
                    if !retry {
                        break;
                    }
                    continue;
                };

                let suggest_backup = policy.suggest_backup();
                let _ = app.emit(
                    "sync://status",
                    serde_json::json!({
                        "state": "reconnecting",
                        "endpoint": endpoint,
                        "attempt": policy.attempt,
                        "retryInSecs": wait_secs,
                        "suggestBackup": suggest_backup,
                    }),
                );

                let sleep = tokio::time::sleep(Duration::from_secs(wait_secs));
                tokio::pin!(sleep);
                let mut should_exit = false;
                loop {
                    tokio::select! {
                        _ = &mut sleep => break,
                        cmd = rx.recv() => {
                            match cmd {
                                None => { should_exit = true; break; }
                                Some(SyncCommand::ManualRetry) => {
                                    policy.manual_retry();
                                    break;
                                }
                                Some(_) => {}
                            }
                        }
                    }
                }
                if should_exit {
                    break;
                }
            }
        }
    }

    let _ = app.emit(
        "sync://status",
        serde_json::json!({ "state": "disconnected" }),
    );
}

#[allow(clippy::too_many_arguments)]
async fn run_single_cloud_session(
    app: &AppHandle,
    mpv: &Arc<MpvController>,
    endpoint: &str,
    username: &str,
    wire_room: &str,
    rerolled_code: Option<&str>,
    claim_empty: bool,
    password: Option<&str>,
    host_only: bool,
    persisted_host_token: &mut Option<String>,
    network_opts: LocalPathOptions,
    rx: &mut mpsc::Receiver<SyncCommand>,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    local_media_path: &Arc<Mutex<Option<PathBuf>>>,
    local_ready: &Arc<Mutex<bool>>,
    timeline_transform: &Arc<Mutex<TimelineTransform>>,
    timeline_segments: &Arc<Mutex<Vec<TimelineSegment>>>,
    has_user_alignment: &Arc<Mutex<bool>>,
    align_mode: &Arc<Mutex<bool>>,
    voice: &Arc<Mutex<Option<Arc<VoiceController>>>>,
) -> CloudSessionExit {
    let ws_url = build_cloud_ws_url(endpoint, wire_room);
    let tls_active = endpoint.to_ascii_lowercase().starts_with("wss://");

    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(64 * 1024),
        max_frame_size: Some(64 * 1024),
        ..Default::default()
    };

    let connect_res = tokio::time::timeout(
        Duration::from_secs(10),
        tokio_tungstenite::connect_async_with_config(&ws_url, Some(ws_config), false),
    )
    .await;

    let ws_stream = match connect_res {
        Ok(Ok((stream, _resp))) => stream,
        Ok(Err(tokio_tungstenite::tungstenite::Error::Http(resp))) => {
            let status = resp.status().as_u16();
            if status == 429 || status == 503 {
                return CloudSessionExit::QuotaExceeded {
                    message: "Epilod Cloud is currently at capacity or rate-limited. You can switch to Syncplay (syncplay.pl:8999) in Settings.".to_string(),
                };
            }
            return CloudSessionExit::Error {
                message: format!("Cloud server HTTP {status}"),
                was_connected: false,
            };
        }
        Ok(Err(e)) => {
            return CloudSessionExit::Error {
                message: e.to_string(),
                was_connected: false,
            };
        }
        Err(_) => {
            return CloudSessionExit::Error {
                message: "Connection timed out".to_string(),
                was_connected: false,
            };
        }
    };

    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    let send_msg = |msg: &CloudClientMsg| -> Option<Message> {
        serde_json::to_string(msg).ok().map(Message::Text)
    };

    // Send hello + 3 fast clock-sync pings immediately.
    let initial_file = local_file
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(to_wire_file));
    let initial_ready = local_ready.lock().ok().map(|g| *g).unwrap_or(false);
    let password_hash = password
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| hash_room_password(wire_room, p));

    let hello = CloudClientMsg::Hello {
        username: username.to_string(),
        claim_empty,
        host_only,
        password_hash,
        host_token: persisted_host_token.clone(),
        file: initial_file,
        is_ready: initial_ready,
    };
    if let Some(frame) = send_msg(&hello) {
        if let Err(e) = ws_tx.send(frame).await {
            return CloudSessionExit::Error {
                message: e.to_string(),
                was_connected: false,
            };
        }
    }
    if let Some(frame) = send_msg(&CloudClientMsg::Ping {
        client_ms: now_epoch_ms(),
    }) {
        let _ = ws_tx.send(frame).await;
    }

    // Spawn P2P engine (voice, sparse audio alignment, direct chat/reactions).
    let (p2p_beacon_tx, mut p2p_beacon_rx) = mpsc::channel::<String>(16);
    let (p2p_align_tx, mut p2p_align_rx) = mpsc::channel::<P2pAutoAlignment>(8);
    let (p2p_reaction_fallback_tx, mut p2p_reaction_fallback_rx) =
        mpsc::channel::<ReactionFallbackPacket>(64);
    let (p2p_chat_fallback_tx, mut p2p_chat_fallback_rx) = mpsc::channel::<ChatFallbackPacket>(32);
    let (p2p_chat_react_fallback_tx, mut p2p_chat_react_fallback_rx) =
        mpsc::channel::<ChatReactFallbackPacket>(32);
    let room_psk = password
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(|p| epilod_core::p2p::derive_p2p_room_psk(wire_room, p));
    let p2p = P2pSessionHandle::spawn(
        app.clone(),
        username.to_string(),
        room_psk,
        network_opts,
        p2p_beacon_tx,
        p2p_align_tx,
        p2p_reaction_fallback_tx,
        p2p_chat_fallback_tx,
        p2p_chat_react_fallback_tx,
    );
    if let Ok(guard) = voice.lock() {
        if let Some(ref vc) = *guard {
            vc.attach_p2p(Arc::clone(&p2p.voice));
        }
    }

    let mut clock = ClockSyncEstimator::new();
    let mut active_username = username.to_string();
    let mut was_connected = false;
    let mut needs_initial_media_sync = false;
    let mut last_state: Option<CloudPlaybackState> = None;
    let mut last_participants: Vec<CloudParticipant> = Vec::new();
    let mut known_peers: HashSet<String> = HashSet::new();
    let mut current_control = CloudRoomControl {
        host_control_active: host_only,
        local_is_host: host_only,
        local_is_admin: false,
        host_username: host_only.then(|| username.to_string()),
        admin_usernames: Vec::new(),
    };
    let mut is_scrubbing = false;
    let mut soft_speed_active = false;
    let mut last_local_action_at: Option<Instant> = None;
    let mut force_snap_next_state = false;
    let mut extra_pings_left: u8 = 2;

    // Local-only 1s drift monitor (does NOT send network traffic — keeps DO hibernating!).
    let mut local_drift_tick = tokio::time::interval(Duration::from_secs(1));
    local_drift_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Lightweight edge ping every 45s (handled by DO auto-response with 0 compute wake-up!).
    let mut keepalive_tick = tokio::time::interval(Duration::from_secs(45));
    keepalive_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    keepalive_tick.tick().await; // skip immediate tick

    let exit_reason = loop {
        tokio::select! {
            _ = local_drift_tick.tick() => {
                if is_scrubbing || mpv.is_loading_media() {
                    continue;
                }
                if align_mode.lock().ok().map(|g| *g).unwrap_or(false) {
                    continue;
                }
                let Some(ref st) = last_state else { continue };
                let server_now = clock.estimated_server_ms(now_epoch_ms());
                let room_pos = st.projected_position(server_now);
                let _ = app.emit(
                    "sync://room-state",
                    serde_json::json!({ "position": room_pos, "paused": st.paused }),
                );
                if needs_initial_media_sync && local_file.lock().ok().is_some_and(|g| g.is_some()) {
                    needs_initial_media_sync = false;
                    apply_remote_playback_state(
                        app,
                        mpv,
                        st,
                        &clock,
                        timeline_transform,
                        timeline_segments,
                    );
                    continue;
                }
                if st.paused {
                    if soft_speed_active {
                        soft_speed_active = false;
                        let req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(req, 1.0));
                    }
                    continue;
                }
                if last_local_action_at.is_some_and(|t| t.elapsed() < Duration::from_millis(ECHO_SUPPRESSION_MS)) {
                    continue;
                }
                let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                let target_local = map_room_to_local(room_pos, tx, &segs);
                let snap = mpv.snapshot();
                let drift = target_local - snap.position;
                let abs_drift = drift.abs();

                if abs_drift >= CLOUD_DRIFT_SEEK_THRESHOLD_SECS {
                    if soft_speed_active {
                        soft_speed_active = false;
                        let req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(req, 1.0));
                    }
                    let _ = mpv.dispatch_seek(target_local, false, None);
                } else if abs_drift >= CLOUD_DRIFT_SPEED_THRESHOLD_SECS {
                    let speed = if drift > 0.0 { 1.04 } else { 0.96 };
                    soft_speed_active = true;
                    let req = mpv.next_request_id();
                    let _ = mpv.send_command(set_speed_cmd(req, speed));
                } else if soft_speed_active {
                    soft_speed_active = false;
                    let req = mpv.next_request_id();
                    let _ = mpv.send_command(set_speed_cmd(req, 1.0));
                }
            }

            _ = keepalive_tick.tick() => {
                // Zero-compute edge auto-response ("ping" -> "pong") keeps NAT/TLS alive.
                if let Err(e) = ws_tx.send(Message::Text("ping".to_string())).await {
                    break CloudSessionExit::Error { message: e.to_string(), was_connected };
                }
            }

            Some(beacon) = p2p_beacon_rx.recv() => {
                if let Some(frame) = send_msg(&CloudClientMsg::P2pSignal { payload: beacon }) {
                    let _ = ws_tx.send(frame).await;
                }
            }

            Some(auto_align) = p2p_align_rx.recv() => {
                if let Ok(mut guard) = timeline_transform.lock() {
                    *guard = auto_align.transform;
                }
                if let Ok(mut guard) = timeline_segments.lock() {
                    *guard = auto_align.segments.clone();
                }
                let _ = app.emit("sync://timeline-transform", auto_align.transform);
                let _ = app.emit("sync://timeline-segments", &auto_align.segments);
                let _ = app.emit(
                    "sync://auto-aligned",
                    serde_json::json!({
                        "offsetSecs": auto_align.transform.offset_secs,
                        "scale": auto_align.transform.scale,
                        "segmentCount": auto_align.segments.len(),
                        "confidence": auto_align.confidence,
                        "summary": auto_align.summary,
                    }),
                );
            }

            Some(pkt) = p2p_reaction_fallback_rx.recv() => {
                if let Some(frame) = send_msg(&CloudClientMsg::Reaction {
                    emoji: pkt.emoji,
                    avatar_id: pkt.avatar_id,
                    count: pkt.count,
                }) {
                    let _ = ws_tx.send(frame).await;
                }
            }

            Some(pkt) = p2p_chat_fallback_rx.recv() => {
                let msg = if pkt.is_edit {
                    CloudClientMsg::ChatEdit {
                        target_msg_id: pkt.msg_id,
                        text: pkt.text,
                    }
                } else {
                    CloudClientMsg::Chat {
                        id: pkt.msg_id,
                        text: pkt.text,
                        avatar_id: pkt.avatar_id,
                        reply_to_id: pkt.reply_to_id,
                    }
                };
                if let Some(frame) = send_msg(&msg) {
                    let _ = ws_tx.send(frame).await;
                }
            }

            Some(pkt) = p2p_chat_react_fallback_rx.recv() => {
                if let Some(frame) = send_msg(&CloudClientMsg::ChatReact {
                    target_msg_id: pkt.msg_id,
                    emoji: pkt.emoji,
                }) {
                    let _ = ws_tx.send(frame).await;
                }
            }

            ws_item = ws_rx.next() => {
                match ws_item {
                    None => break CloudSessionExit::Error {
                        message: "Server closed connection".to_string(),
                        was_connected,
                    },
                    Some(Err(e)) => break CloudSessionExit::Error {
                        message: e.to_string(),
                        was_connected,
                    },
                    Some(Ok(Message::Close(frame))) => {
                        let code = frame.as_ref().map(|f| u16::from(f.code)).unwrap_or(1000);
                        if code == 4009 {
                            break CloudSessionExit::RoomOccupiedCollision;
                        }
                        if code == 4003 {
                            break CloudSessionExit::FatalAuth {
                                message: "Incorrect room password.".to_string(),
                            };
                        }
                        break CloudSessionExit::Error {
                            message: format!("Connection closed ({code})"),
                            was_connected,
                        };
                    }
                    Some(Ok(Message::Text(text))) => {
                        if text == "pong" {
                            continue;
                        }
                        let Ok(parsed) = serde_json::from_str::<CloudServerMsg>(&text) else {
                            continue;
                        };
                        match parsed {
                            CloudServerMsg::Welcome {
                                username: assigned,
                                host_token,
                                state,
                                participants,
                                room_control,
                                ..
                            } => {
                                was_connected = true;
                                active_username = assigned.clone();
                                if let Some(tok) = host_token {
                                    *persisted_host_token = Some(tok);
                                }
                                current_control = room_control.clone();
                                last_participants = participants.clone();
                                known_peers = participants
                                    .iter()
                                    .map(|p| p.username.to_ascii_lowercase())
                                    .collect();
                                last_state = Some(state.clone());

                                if let Some(code) = rerolled_code {
                                    let _ = app.emit(
                                        "sync://room-rerolled",
                                        serde_json::json!({ "roomCode": code }),
                                    );
                                }
                                let _ = app.emit(
                                    "sync://status",
                                    serde_json::json!({
                                        "state": "connected",
                                        "endpoint": endpoint,
                                        "tls": tls_active,
                                        "username": active_username,
                                    }),
                                );
                                let _ = app.emit(
                                    "sync://room-control",
                                    RoomControlSummary::from(room_control),
                                );
                                emit_cloud_participants(app, &participants, local_file);
                                let _ = app.emit(
                                    "sync://room-state",
                                    serde_json::json!({ "position": state.position, "paused": state.paused }),
                                );

                                // Sync P2P session with local username, media, and peers.
                                p2p.try_send(P2pControlCmd::UpdateLocalUsername(active_username.clone()));
                                p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_local_media(
                                    local_file,
                                    local_media_path,
                                    has_user_alignment,
                                )));
                                p2p.try_send(P2pControlCmd::UpdateParticipants(
                                    participants.iter().map(CloudParticipant::to_room_participant).collect(),
                                ));

                                // Apply initial room playback state if someone else is already in room.
                                if participants.len() > 1 {
                                    let has_media = local_file.lock().ok().is_some_and(|g| g.is_some());
                                    if has_media && !mpv.is_loading_media() {
                                        apply_remote_playback_state(
                                            app,
                                            mpv,
                                            &state,
                                            &clock,
                                            timeline_transform,
                                            timeline_segments,
                                        );
                                    } else {
                                        needs_initial_media_sync = true;
                                    }
                                }
                            }
                            CloudServerMsg::Pong { client_ms, server_time_ms } => {
                                clock.record_pong(client_ms, now_epoch_ms(), server_time_ms);
                                if extra_pings_left > 0 {
                                    extra_pings_left -= 1;
                                    if let Some(frame) = send_msg(&CloudClientMsg::Ping {
                                        client_ms: now_epoch_ms(),
                                    }) {
                                        let _ = ws_tx.send(frame).await;
                                    }
                                }
                            }
                            CloudServerMsg::State {
                                position,
                                paused,
                                seq,
                                server_time_ms,
                                set_by,
                                do_seek,
                            } => {
                                if last_state.as_ref().is_some_and(|prev| seq < prev.seq)
                                    && !force_snap_next_state
                                {
                                    continue;
                                }
                                let forced_snap = std::mem::take(&mut force_snap_next_state);
                                let is_self = set_by
                                    .as_deref()
                                    .is_some_and(|u| u.eq_ignore_ascii_case(&active_username));
                                let prev_pos = last_state.as_ref().map(|s| s.position).unwrap_or(position);
                                let next_state = CloudPlaybackState {
                                    position,
                                    paused,
                                    seq,
                                    server_time_ms,
                                    set_by: set_by.clone(),
                                    do_seek,
                                };
                                last_state = Some(next_state.clone());
                                let _ = app.emit(
                                    "sync://room-state",
                                    serde_json::json!({ "position": position, "paused": paused }),
                                );

                                let in_align_mode = align_mode.lock().ok().map(|g| *g).unwrap_or(false);
                                if !is_self || forced_snap {
                                    if do_seek && !is_self {
                                        if let Some(ref actor) = set_by {
                                            let _ = app.emit(
                                                "sync://peer-seek",
                                                serde_json::json!({
                                                    "username": actor,
                                                    "deltaSecs": position - prev_pos,
                                                    "positionSecs": position,
                                                }),
                                            );
                                        }
                                    }
                                    if (!is_scrubbing && !in_align_mode && !mpv.is_loading_media())
                                        || forced_snap
                                    {
                                        apply_remote_playback_state(
                                            app,
                                            mpv,
                                            &next_state,
                                            &clock,
                                            timeline_transform,
                                            timeline_segments,
                                        );
                                    }
                                }
                            }
                            CloudServerMsg::Participants { participants } => {
                                let mut next_known = HashSet::with_capacity(participants.len());
                                for p in &participants {
                                    let low = p.username.to_ascii_lowercase();
                                    if !known_peers.contains(&low)
                                        && !p.username.eq_ignore_ascii_case(&active_username)
                                    {
                                        p2p.try_send(P2pControlCmd::PeerJoined(p.username.clone()));
                                    }
                                    next_known.insert(low);
                                }
                                known_peers = next_known;
                                last_participants = participants.clone();
                                emit_cloud_participants(app, &participants, local_file);
                                p2p.try_send(P2pControlCmd::UpdateParticipants(
                                    participants.iter().map(CloudParticipant::to_room_participant).collect(),
                                ));
                            }
                            CloudServerMsg::RoomControl { room_control, notice } => {
                                current_control = room_control.clone();
                                let _ = app.emit(
                                    "sync://room-control",
                                    RoomControlSummary::from(room_control),
                                );
                                if let Some(n) = notice {
                                    if n.kind == "guestBlocked" {
                                        force_snap_next_state = true;
                                        last_local_action_at = None;
                                        let _ = app.emit(
                                            "sync://server-override",
                                            serde_json::json!({
                                                "setBy": n.actor.clone().unwrap_or_else(|| "Host".to_string())
                                            }),
                                        );
                                    }
                                    let _ = app.emit("sync://control-notice", n);
                                }
                            }
                            CloudServerMsg::PeerLeft { username: departed } => {
                                let _ = app.emit(
                                    "sync://peer-left",
                                    serde_json::json!({ "username": departed }),
                                );
                            }
                            CloudServerMsg::PeerNotReady { username: peer, manual } => {
                                let _ = app.emit(
                                    "sync://peer-not-ready",
                                    serde_json::json!({
                                        "username": peer,
                                        "manual": manual,
                                    }),
                                );
                            }
                            CloudServerMsg::P2pSignal { username: sender, payload } => {
                                p2p.try_send(P2pControlCmd::RemoteBeacon {
                                    username: sender,
                                    raw_message: payload,
                                });
                            }
                            CloudServerMsg::Chat {
                                id,
                                username: sender,
                                avatar_id,
                                text,
                                reply_to_id,
                            } => {
                                let _ = app.emit(
                                    "sync://chat",
                                    serde_json::json!({
                                        "id": id,
                                        "username": sender,
                                        "avatarId": avatar_id,
                                        "text": text,
                                        "replyToId": reply_to_id,
                                        "via": "syncplay",
                                    }),
                                );
                            }
                            CloudServerMsg::ChatEdit {
                                target_msg_id,
                                username: sender,
                                text,
                            } => {
                                let _ = app.emit(
                                    "sync://chat-edit",
                                    serde_json::json!({
                                        "targetMsgId": target_msg_id,
                                        "username": sender,
                                        "text": text,
                                        "via": "syncplay",
                                    }),
                                );
                            }
                            CloudServerMsg::ChatReact {
                                target_msg_id,
                                username: sender,
                                emoji,
                            } => {
                                let _ = app.emit(
                                    "sync://chat-react",
                                    serde_json::json!({
                                        "targetMsgId": target_msg_id,
                                        "username": sender,
                                        "emoji": emoji,
                                        "via": "syncplay",
                                    }),
                                );
                            }
                            CloudServerMsg::Reaction {
                                username: sender,
                                avatar_id,
                                emoji,
                                count,
                            } => {
                                let _ = app.emit(
                                    "sync://reaction",
                                    serde_json::json!({
                                        "username": sender,
                                        "avatarId": avatar_id,
                                        "emoji": emoji,
                                        "count": count,
                                        "via": "syncplay",
                                    }),
                                );
                            }
                            CloudServerMsg::Typing { username: sender, is_typing } => {
                                let _ = app.emit(
                                    "sync://chat-typing",
                                    serde_json::json!({
                                        "username": sender,
                                        "isTyping": is_typing,
                                    }),
                                );
                            }
                            CloudServerMsg::Error { code, message } => {
                                if code == "ROOM_OCCUPIED" {
                                    break CloudSessionExit::RoomOccupiedCollision;
                                }
                                if code == "BAD_PASSWORD" {
                                    break CloudSessionExit::FatalAuth { message };
                                }
                                let _ = app.emit("sync://error", serde_json::json!({ "message": message }));
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                }
            }

            cmd = rx.recv() => {
                let Some(cmd) = cmd else {
                    break CloudSessionExit::Clean;
                };
                match cmd {
                    SyncCommand::SetFile(meta) => {
                        let wire = meta.as_ref().map(to_wire_file);
                        if let Some(frame) = send_msg(&CloudClientMsg::File { file: wire }) {
                            let _ = ws_tx.send(frame).await;
                        }
                        emit_cloud_participants(app, &last_participants, local_file);
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_local_media(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                    }
                    SyncCommand::SetReady { is_ready, manual } => {
                        if let Some(frame) = send_msg(&CloudClientMsg::Ready { is_ready, manual }) {
                            let _ = ws_tx.send(frame).await;
                        }
                    }
                    SyncCommand::UserPlay(local_pos) => {
                        let locked_out = current_control.host_control_active
                            && !current_control.local_is_host
                            && !current_control.local_is_admin;
                        if locked_out {
                            if let Some(ref st) = last_state {
                                apply_remote_playback_state(
                                    app,
                                    mpv,
                                    st,
                                    &clock,
                                    timeline_transform,
                                    timeline_segments,
                                );
                            }
                            continue;
                        }
                        is_scrubbing = false;
                        // Ready-Play Gate: block Play if any peer manually marked Not Ready.
                        let blocked_users: Vec<String> = last_participants
                            .iter()
                            .filter(|p| {
                                !p.username.eq_ignore_ascii_case(&active_username)
                                    && p.manual_not_ready
                                    && !p.is_ready
                            })
                            .map(|p| p.username.clone())
                            .collect();
                        if !blocked_users.is_empty() {
                            if !mpv.note_paused(true) {
                                let req = mpv.next_request_id();
                                let _ = mpv.send_command(set_pause_cmd(req, true));
                                let _ = app.emit("mpv://paused", serde_json::json!({ "paused": true }));
                            }
                            let _ = app.emit(
                                "sync://play-blocked",
                                serde_json::json!({ "usernames": blocked_users }),
                            );
                            continue;
                        }
                        if let Ok(mut guard) = local_ready.lock() {
                            *guard = true;
                        }
                        if !mpv.note_paused(false) {
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_pause_cmd(req, false));
                            let _ = app.emit("mpv://paused", serde_json::json!({ "paused": false }));
                        }
                        last_local_action_at = Some(Instant::now());
                        let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                        let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                        let room_pos = map_local_to_room(local_pos, tx, &segs);
                        if let Some(frame) = send_msg(&CloudClientMsg::Ready {
                            is_ready: true,
                            manual: true,
                        }) {
                            if let Err(e) = ws_tx.send(frame).await {
                                break CloudSessionExit::Error {
                                    message: e.to_string(),
                                    was_connected,
                                };
                            }
                        }
                        if let Some(frame) = send_msg(&CloudClientMsg::Play { position: room_pos }) {
                            if let Err(e) = ws_tx.send(frame).await {
                                break CloudSessionExit::Error {
                                    message: e.to_string(),
                                    was_connected,
                                };
                            }
                        }
                    }
                    SyncCommand::UserPause(local_pos) => {
                        let locked_out = current_control.host_control_active
                            && !current_control.local_is_host
                            && !current_control.local_is_admin;
                        if locked_out {
                            if let Some(ref st) = last_state {
                                apply_remote_playback_state(
                                    app,
                                    mpv,
                                    st,
                                    &clock,
                                    timeline_transform,
                                    timeline_segments,
                                );
                            }
                            continue;
                        }
                        if !mpv.note_paused(true) {
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_pause_cmd(req, true));
                            let _ = app.emit("mpv://paused", serde_json::json!({ "paused": true }));
                        }
                        last_local_action_at = Some(Instant::now());
                        let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                        let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                        let room_pos = map_local_to_room(local_pos, tx, &segs);
                        if let Some(frame) = send_msg(&CloudClientMsg::Pause { position: room_pos }) {
                            if let Err(e) = ws_tx.send(frame).await {
                                break CloudSessionExit::Error {
                                    message: e.to_string(),
                                    was_connected,
                                };
                            }
                        }
                    }
                    SyncCommand::UserSeek(local_pos) => {
                        let locked_out = current_control.host_control_active
                            && !current_control.local_is_host
                            && !current_control.local_is_admin;
                        if locked_out {
                            if let Some(ref st) = last_state {
                                apply_remote_playback_state(
                                    app,
                                    mpv,
                                    st,
                                    &clock,
                                    timeline_transform,
                                    timeline_segments,
                                );
                            }
                            continue;
                        }
                        last_local_action_at = Some(Instant::now());
                        let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                        let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                        let room_pos = map_local_to_room(local_pos, tx, &segs);
                        if let Some(frame) = send_msg(&CloudClientMsg::Seek { position: room_pos }) {
                            if let Err(e) = ws_tx.send(frame).await {
                                break CloudSessionExit::Error {
                                    message: e.to_string(),
                                    was_connected,
                                };
                            }
                        }
                    }
                    SyncCommand::ResetForNewFile => {
                        if let Ok(mut g) = timeline_transform.lock() {
                            *g = TimelineTransform::default();
                        }
                        if let Ok(mut g) = timeline_segments.lock() {
                            g.clear();
                        }
                        let _ = app.emit("sync://timeline-transform", TimelineTransform::default());
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                    }
                    SyncCommand::ForceResync => {
                        if let Some(frame) = send_msg(&CloudClientMsg::Resync) {
                            let _ = ws_tx.send(frame).await;
                        }
                    }
                    SyncCommand::SetScrubbing(s) => {
                        is_scrubbing = s;
                    }
                    SyncCommand::SetTimelineTransform(tx) => {
                        if let Ok(mut g) = timeline_transform.lock() {
                            *g = tx;
                        }
                        if let Ok(mut g) = timeline_segments.lock() {
                            g.clear();
                        }
                    }
                    SyncCommand::NudgeTimelineOffset(delta) => {
                        let next_tx = if let Ok(mut g) = timeline_transform.lock() {
                            g.offset_secs = (g.offset_secs + delta).clamp(-600.0, 600.0);
                            *g
                        } else {
                            TimelineTransform::default()
                        };
                        if let Ok(mut g) = timeline_segments.lock() {
                            g.clear();
                        }
                        let _ = app.emit("sync://timeline-transform", next_tx);
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                    }
                    SyncCommand::SetAlignMode(_) => {}
                    SyncCommand::AlignSceneHere { local_pos_secs, reply } => {
                        let local_pos = local_pos_secs.unwrap_or_else(|| mpv.snapshot().position);
                        let room_pos = last_state
                            .as_ref()
                            .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())))
                            .unwrap_or(local_pos);
                        let next_tx = if let Ok(mut g) = timeline_transform.lock() {
                            g.offset_secs = (local_pos - room_pos * g.scale).clamp(-600.0, 600.0);
                            *g
                        } else {
                            TimelineTransform::default()
                        };
                        if let Ok(mut g) = timeline_segments.lock() {
                            g.clear();
                        }
                        let _ = app.emit("sync://timeline-transform", next_tx);
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        let _ = reply.send(next_tx);
                    }
                    SyncCommand::TriggerP2pRealign { force } => {
                        p2p.try_send(P2pControlCmd::TriggerRealign { force });
                    }
                    SyncCommand::SetAdmin { username: target, grant, reply } => {
                        if !current_control.local_is_host {
                            let _ = reply.send(Err("Only the room host can manage admins.".to_string()));
                        } else {
                            if let Some(frame) = send_msg(&CloudClientMsg::SetAdmin {
                                username: target,
                                grant,
                            }) {
                                let _ = ws_tx.send(frame).await;
                            }
                            let _ = reply.send(Ok(()));
                        }
                    }
                    SyncCommand::ReleaseHostControlOnLeave { reply } => {
                        if current_control.local_is_host {
                            if let Some(frame) = send_msg(&CloudClientMsg::ReleaseHost) {
                                let _ = ws_tx.send(frame).await;
                            }
                        }
                        let _ = reply.send(());
                    }
                    SyncCommand::SendReaction { emoji, avatar_id, count } => {
                        p2p.try_send(P2pControlCmd::SendReaction { emoji, avatar_id, count });
                    }
                    SyncCommand::SendChat { id, text, avatar_id, reply_to_id } => {
                        p2p.try_send(P2pControlCmd::SendChat {
                            id,
                            text,
                            avatar_id,
                            reply_to_id,
                        });
                    }
                    SyncCommand::SendChatEdit { target_msg_id, text } => {
                        p2p.try_send(P2pControlCmd::SendChatEdit { target_msg_id, text });
                    }
                    SyncCommand::SendChatReact { target_msg_id, emoji } => {
                        p2p.try_send(P2pControlCmd::SendChatReact { target_msg_id, emoji });
                    }
                    SyncCommand::SendTyping { is_typing } => {
                        p2p.try_send(P2pControlCmd::SendTyping { is_typing });
                        if let Some(frame) = send_msg(&CloudClientMsg::Typing { is_typing }) {
                            let _ = ws_tx.send(frame).await;
                        }
                    }
                    SyncCommand::ManualRetry => {}
                }
            }
        }
    };

    p2p.try_send(P2pControlCmd::Shutdown);
    let _ = ws_tx.send(Message::Close(None)).await;
    exit_reason
}

fn apply_remote_playback_state(
    app: &AppHandle,
    mpv: &Arc<MpvController>,
    state: &CloudPlaybackState,
    clock: &ClockSyncEstimator,
    timeline_transform: &Arc<Mutex<TimelineTransform>>,
    timeline_segments: &Arc<Mutex<Vec<TimelineSegment>>>,
) {
    let server_now = clock.estimated_server_ms(now_epoch_ms());
    let room_pos = state.projected_position(server_now);
    let tx = timeline_transform
        .lock()
        .ok()
        .map(|g| *g)
        .unwrap_or_default();
    let segs = timeline_segments
        .lock()
        .ok()
        .map(|g| g.clone())
        .unwrap_or_default();
    let target_local = map_room_to_local(room_pos, tx, &segs);

    if !mpv.note_paused(state.paused) {
        let req = mpv.next_request_id();
        let _ = mpv.send_command(set_pause_cmd(req, state.paused));
        let _ = app.emit(
            "mpv://paused",
            serde_json::json!({ "paused": state.paused }),
        );
    }

    let snap = mpv.snapshot();
    if state.do_seek || (target_local - snap.position).abs() >= CLOUD_DRIFT_SEEK_THRESHOLD_SECS {
        let _ = mpv.dispatch_seek(target_local, false, None);
    }
}

/// Fast batched HTTPS `/peek` for Cloudflare endpoints (replaces `__ep_peek_` ghost TCP joins).
pub async fn probe_cloud_rooms(
    endpoint: &str,
    targets: &[(String, String)],
    checked_at: u64,
) -> Vec<RoomOccupancyDto> {
    let empty_all = || {
        targets
            .iter()
            .map(|(id, _)| RoomOccupancyDto {
                id: id.clone(),
                ok: false,
                online_count: 0,
                usernames_preview: Vec::new(),
                active_media_hint: None,
                checked_at,
            })
            .collect::<Vec<_>>()
    };

    let lower = endpoint.trim().to_ascii_lowercase();
    let is_tls = lower.starts_with("wss://");
    let rest = if is_tls {
        &endpoint.trim()[6..]
    } else if lower.starts_with("ws://") {
        &endpoint.trim()[5..]
    } else {
        return empty_all();
    };
    let host_port = rest.split('/').next().unwrap_or("");
    if host_port.is_empty()
        || host_port
            .bytes()
            .any(|b| b <= 0x20 || b >= 0x7F || matches!(b, b'@' | b'#' | b'\\'))
    {
        return empty_all();
    }
    let (host, port) = if let Some(colon) = host_port.rfind(':') {
        let p = host_port[colon + 1..]
            .parse::<u16>()
            .unwrap_or(if is_tls { 443 } else { 80 });
        (&host_port[..colon], p)
    } else {
        (host_port, if is_tls { 443 } else { 80 })
    };

    const MAX_PEEK_RESPONSE_BYTES: usize = 64 * 1024;
    let wire_rooms: Vec<String> = targets.iter().map(|(_, w)| w.clone()).collect();
    let path = build_cloud_peek_path(&wire_rooms);
    let http_req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: EpilodParty/1\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );

    let body_res = tokio::time::timeout(Duration::from_secs(5), async {
        let tcp = TcpStream::connect((host, port)).await.ok()?;
        let mut buf = Vec::with_capacity(4096);
        if is_tls {
            let connector = TlsConnector::from(NativeTlsConnector::new().ok()?);
            let mut tls = connector.connect(host, tcp).await.ok()?;
            tls.write_all(http_req.as_bytes()).await.ok()?;
            tls.flush().await.ok()?;
            tls.take((MAX_PEEK_RESPONSE_BYTES as u64) + 1)
                .read_to_end(&mut buf)
                .await
                .ok()?;
        } else {
            let mut tcp = tcp;
            tcp.write_all(http_req.as_bytes()).await.ok()?;
            tcp.flush().await.ok()?;
            tcp.take((MAX_PEEK_RESPONSE_BYTES as u64) + 1)
                .read_to_end(&mut buf)
                .await
                .ok()?;
        }
        if buf.len() > MAX_PEEK_RESPONSE_BYTES {
            return None;
        }
        let (status, decoded_body) = decode_http_response_body(&buf)?;
        if status != 200 {
            return None;
        }
        serde_json::from_slice::<CloudPeekResponse>(&decoded_body).ok()
    })
    .await;

    let Ok(Some(parsed)) = body_res else {
        return empty_all();
    };
    if !parsed.ok {
        return empty_all();
    }

    let map: HashMap<String, _> = parsed.rooms;
    targets
        .iter()
        .map(|(id, wire_room)| {
            if let Some(info) = map.get(wire_room) {
                RoomOccupancyDto {
                    id: id.clone(),
                    ok: true,
                    online_count: info.online_count,
                    usernames_preview: info.usernames_preview.clone(),
                    active_media_hint: info.active_media_hint.clone(),
                    checked_at,
                }
            } else {
                RoomOccupancyDto {
                    id: id.clone(),
                    ok: true,
                    online_count: 0,
                    usernames_preview: Vec::new(),
                    active_media_hint: None,
                    checked_at,
                }
            }
        })
        .collect()
}
