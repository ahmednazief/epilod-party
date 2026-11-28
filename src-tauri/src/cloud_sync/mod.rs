#![cfg(windows)]

use crate::mpv::MpvController;
use crate::p2p::{P2pAutoAlignment, P2pControlCmd, P2pLocalMedia, P2pSessionHandle};
use crate::syncplay::{
    build_local_file_identity, build_peer_file_identity, reroll_distinct_six_digit_code,
    LocalFileMeta, ParticipantDto, RoomOccupancyDto, SyncCommand,
};
use crate::voice::VoiceController;
use epilod_core::cloud_sync::{
    build_cloud_http_base, build_cloud_peek_path_with_proofs, build_cloud_ws_url,
    compute_echo_suppression_ms, compute_playback_action, compute_welcome_playback_action,
    decode_http_response_body, default_peek_secret, hash_room_password, peek_proof_for_room,
    sha256_hex, should_apply_welcome_state, ClockSyncEstimator, CloudClientMsg, CloudParticipant,
    CloudPeekResponse, CloudPlaybackState, CloudResumeHint, CloudRoomControl, CloudServerMsg,
    DriftAction, DriftController,
};
use epilod_core::matching::analyze_files;
use epilod_core::mpv_ipc::{set_pause_cmd, set_speed_cmd};
use epilod_core::p2p::{ChatFallbackPacket, ChatReactFallbackPacket, ReactionFallbackPacket};
use epilod_core::room_code::resolve_syncplay_room;
use epilod_core::room_control::RoomControlSummary;
use epilod_core::syncplay::{
    hash_filename, hash_filesize, map_local_to_room_piecewise, map_room_to_local_piecewise,
    ReconnectPolicy, TimelineSegment, TimelineTransform, WireFileInfo,
};
use epilod_core::validation::LocalPathOptions;
use futures_util::{SinkExt, StreamExt};
use native_tls::TlsConnector as NativeTlsConnector;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_native_tls::TlsConnector;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};

const MAX_CLAIM_REROLLS: u8 = 5;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const WS_SEND_TIMEOUT: Duration = Duration::from_secs(10);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(12);
const PING_RETRY_AFTER: Duration = Duration::from_secs(4);
const PONG_DEADLINE: Duration = Duration::from_secs(10);
const STALL_RECOVERY_THRESHOLD: Duration = Duration::from_secs(4);
const FAST_CLOCK_CALIBRATION_INTERVAL: Duration = Duration::from_secs(15);
const CLOCK_RESYNC_INTERVAL: Duration = Duration::from_secs(180);
const HEALTH_EMIT_INTERVAL: Duration = Duration::from_secs(5);
const STATUS_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(30);
const SEEK_COOLDOWN: Duration = Duration::from_secs(4);
const POST_SEEK_SETTLE: Duration = Duration::from_millis(1500);
const REMOTE_SEEK_COALESCE: Duration = Duration::from_millis(150);
const SEEK_TAP_DEBOUNCE: Duration = Duration::from_millis(40);
const SEEK_SCRUB_DEBOUNCE: Duration = Duration::from_millis(180);

static SHARED_TLS_CONNECTOR: LazyLock<Option<TlsConnector>> =
    LazyLock::new(|| NativeTlsConnector::new().ok().map(TlsConnector::from));

fn shared_tls_connector() -> Option<TlsConnector> {
    SHARED_TLS_CONNECTOR.clone()
}

fn client_caps() -> Vec<String> {
    vec![
        "readygate".to_string(),
        "clientts".to_string(),
        "status".to_string(),
        "outbox".to_string(),
        "peekproof".to_string(),
    ]
}

#[derive(Debug, Clone)]
enum OutboxPlayback {
    Play(f64),
    Pause(f64),
    Seek(f64),
}

#[derive(Default)]
struct CloudOutbox {
    playback: Option<OutboxPlayback>,
    latest_seek: Option<f64>,
    file: Option<Option<LocalFileMeta>>,
    ready: Option<(bool, bool)>,
    chats: VecDeque<SyncCommand>,
}

impl CloudOutbox {
    fn push(&mut self, cmd: SyncCommand) {
        match cmd {
            SyncCommand::SetFile(meta) => self.file = Some(meta),
            SyncCommand::SetReady { is_ready, manual } => self.ready = Some((is_ready, manual)),
            SyncCommand::UserPlay(p) => self.playback = Some(OutboxPlayback::Play(p)),
            SyncCommand::UserPause(p) => self.playback = Some(OutboxPlayback::Pause(p)),
            SyncCommand::UserSeek(p) => {
                self.latest_seek = Some(p);
                if self.playback.is_none() {
                    self.playback = Some(OutboxPlayback::Seek(p));
                }
            }
            c @ (SyncCommand::SendChat { .. }
            | SyncCommand::SendChatEdit { .. }
            | SyncCommand::SendChatReact { .. }
            | SyncCommand::SendChatSeen { .. }
            | SyncCommand::SendReaction { .. }
            | SyncCommand::SendRatingVote { .. }
            | SyncCommand::SendSubtitleShare { .. }) => {
                if self.chats.len() >= 20 {
                    self.chats.pop_front();
                }
                self.chats.push_back(c);
            }
            _ => {}
        }
    }

    fn is_empty(&self) -> bool {
        self.playback.is_none()
            && self.latest_seek.is_none()
            && self.file.is_none()
            && self.ready.is_none()
            && self.chats.is_empty()
    }
}

fn parse_endpoint_host_port(endpoint: &str) -> Option<(bool, String, u16)> {
    let trimmed = endpoint.trim();
    let lower = trimmed.to_ascii_lowercase();
    let (is_tls, rest) = if lower.starts_with("wss://") {
        (true, &trimmed[6..])
    } else if lower.starts_with("ws://") {
        (false, &trimmed[5..])
    } else if lower.starts_with("https://") {
        (true, &trimmed[8..])
    } else if lower.starts_with("http://") {
        (false, &trimmed[7..])
    } else {
        return None;
    };
    let host_port = rest.split('/').next().unwrap_or("");
    if host_port.is_empty()
        || host_port
            .bytes()
            .any(|b| b <= 0x20 || b >= 0x7F || matches!(b, b'@' | b'#' | b'\\'))
    {
        return None;
    }
    let (host, port) = if let Some(colon) = host_port.rfind(':') {
        let p = host_port[colon + 1..]
            .parse::<u16>()
            .unwrap_or(if is_tls { 443 } else { 80 });
        (host_port[..colon].to_string(), p)
    } else {
        (host_port.to_string(), if is_tls { 443 } else { 80 })
    };
    Some((is_tls, host, port))
}

pub async fn fetch_cloud_health(endpoint: &str) -> bool {
    fetch_cloud_path(endpoint, "/health").await
}

pub async fn prewarm_cloud(endpoint: &str, room_code: Option<&str>) -> bool {
    let path = room_code
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .and_then(|code| resolve_syncplay_room(code, false).ok())
        .map(|wire_room| build_cloud_peek_path_with_proofs(&[wire_room], &[]))
        .unwrap_or_else(|| "/health".to_string());
    fetch_cloud_path(endpoint, &path).await
}

async fn fetch_cloud_path(endpoint: &str, path: &str) -> bool {
    let Some((is_tls, host, port)) = parse_endpoint_host_port(&build_cloud_http_base(endpoint))
    else {
        return false;
    };
    let req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: EpilodParty/1\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    let res = tokio::time::timeout(Duration::from_secs(4), async {
        let tcp = TcpStream::connect((host.as_str(), port)).await.ok()?;
        let _ = tcp.set_nodelay(true);
        let mut buf = Vec::with_capacity(1024);
        if is_tls {
            let connector = shared_tls_connector()?;
            let mut tls = connector.connect(&host, tcp).await.ok()?;
            tls.write_all(req.as_bytes()).await.ok()?;
            tls.flush().await.ok()?;
            tls.take(4096).read_to_end(&mut buf).await.ok()?;
        } else {
            let mut tcp = tcp;
            tcp.write_all(req.as_bytes()).await.ok()?;
            tcp.flush().await.ok()?;
            tcp.take(4096).read_to_end(&mut buf).await.ok()?;
        }
        let (status, _) = decode_http_response_body(&buf)?;
        Some(status == 200)
    })
    .await;
    matches!(res, Ok(Some(true)))
}

async fn connect_ws_nodelay(
    ws_url: &str,
    ws_config: tokio_tungstenite::tungstenite::protocol::WebSocketConfig,
) -> Result<WebSocketStream<MaybeTlsStream<TcpStream>>, CloudSessionExit> {
    let Some((_, host, port)) = parse_endpoint_host_port(ws_url) else {
        return Err(CloudSessionExit::Error {
            message: "Invalid cloud endpoint URL".to_string(),
            was_connected: false,
        });
    };
    let connect_fut = async {
        let tcp = TcpStream::connect((host.as_str(), port))
            .await
            .map_err(|e| CloudSessionExit::Error {
                message: e.to_string(),
                was_connected: false,
            })?;
        let _ = tcp.set_nodelay(true);
        match tokio_tungstenite::client_async_tls_with_config(ws_url, tcp, Some(ws_config), None)
            .await
        {
            Ok((stream, _)) => Ok(stream),
            Err(tokio_tungstenite::tungstenite::Error::Http(resp)) => {
                let status = resp.status().as_u16();
                if status == 409 {
                    return Err(CloudSessionExit::RoomFull);
                }
                if status == 429 || status == 503 {
                    return Err(CloudSessionExit::QuotaExceeded {
                        message: "Epilod Cloud is currently at capacity or rate-limited. Please retry in a moment.".to_string(),
                    });
                }
                Err(CloudSessionExit::Error {
                    message: format!("Cloud server HTTP {status}"),
                    was_connected: false,
                })
            }
            Err(e) => Err(CloudSessionExit::Error {
                message: e.to_string(),
                was_connected: false,
            }),
        }
    };
    match tokio::time::timeout(CONNECT_TIMEOUT, connect_fut).await {
        Ok(res) => res,
        Err(_) => Err(CloudSessionExit::Error {
            message: "Connection timed out".to_string(),
            was_connected: false,
        }),
    }
}

async fn send_ws_bounded<S>(ws_tx: &mut S, frame: Message) -> Result<(), String>
where
    S: futures_util::Sink<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin,
{
    match tokio::time::timeout(WS_SEND_TIMEOUT, ws_tx.send(frame)).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err("WebSocket send timed out".to_string()),
    }
}

fn now_epoch_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
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
                // Cloud participants snapshots are only broadcast on discrete events (join,
                // ready, file, lag-delta), so `p.position` freezes between broadcasts. Emit 0.0
                // (matching Syncplay's List convention) and rely on `lag_secs` for peer drift.
                position: 0.0,
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
                buffering: p.buffering,
                lag_secs: p.lag_secs,
            }
        })
        .collect();
    list.sort_by(|a, b| a.username.cmp(&b.username));
    let _ = app.emit("sync://participants", list);
}

enum CloudSessionExit {
    Clean,
    RoomFull,
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
    let mut last_known_room_state: Option<(f64, bool)> = None;
    let mut clock = ClockSyncEstimator::new();
    let mut outbox = CloudOutbox::default();
    let mut reconnects: u32 = 0;

    // Hoist P2P engine outside the WS reconnect loop so voice & direct channels survive blips (T2.2).
    let (p2p_beacon_tx, mut p2p_beacon_rx) = mpsc::channel::<String>(16);
    let (p2p_align_tx, mut p2p_align_rx) = mpsc::channel::<P2pAutoAlignment>(8);
    let (p2p_reaction_fallback_tx, mut p2p_reaction_fallback_rx) =
        mpsc::channel::<ReactionFallbackPacket>(64);
    let (p2p_chat_fallback_tx, mut p2p_chat_fallback_rx) = mpsc::channel::<ChatFallbackPacket>(32);
    let (p2p_chat_react_fallback_tx, mut p2p_chat_react_fallback_rx) =
        mpsc::channel::<ChatReactFallbackPacket>(32);
    let room_psk_for_wire = |wire: &str| {
        password
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(|p| epilod_core::p2p::derive_p2p_room_psk(wire, p))
    };
    let mut p2p = P2pSessionHandle::spawn(
        app.clone(),
        username.clone(),
        room_psk_for_wire(&current_wire_room),
        network_opts,
        p2p_beacon_tx.clone(),
        p2p_align_tx.clone(),
        p2p_reaction_fallback_tx.clone(),
        p2p_chat_fallback_tx.clone(),
        p2p_chat_react_fallback_tx.clone(),
    );
    if let Ok(guard) = voice.lock() {
        if let Some(ref vc) = *guard {
            vc.attach_p2p(Arc::clone(&p2p.voice));
        }
    }

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
            current_six_digit.as_deref(),
            rerolled_code_to_emit.as_deref(),
            claim_empty,
            password.as_deref(),
            host_only,
            &mut persisted_host_token,
            &mut last_known_room_state,
            &mut clock,
            &mut outbox,
            reconnects,
            &mut rx,
            &local_file,
            &local_media_path,
            &local_ready,
            &timeline_transform,
            &timeline_segments,
            &has_user_alignment,
            &align_mode,
            &p2p,
            &mut p2p_beacon_rx,
            &mut p2p_align_rx,
            &mut p2p_reaction_fallback_rx,
            &mut p2p_chat_fallback_rx,
            &mut p2p_chat_react_fallback_rx,
        )
        .await;

        match exit {
            CloudSessionExit::Clean => break,
            CloudSessionExit::RoomFull => {
                let msg = "This room is full (16/16).".to_string();
                let _ = app.emit("sync://error", serde_json::json!({ "message": msg }));
                let _ = app.emit(
                    "sync://status",
                    serde_json::json!({
                        "state": "error",
                        "endpoint": endpoint,
                        "message": msg,
                        "suggestBackup": false,
                        "circuitOpen": false,
                    }),
                );
                break;
            }
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
                            *guard = new_wire.clone();
                        }
                        if let Some(new_psk) = room_psk_for_wire(&new_wire) {
                            p2p.try_send(P2pControlCmd::Shutdown);
                            p2p = P2pSessionHandle::spawn(
                                app.clone(),
                                username.clone(),
                                Some(new_psk),
                                network_opts,
                                p2p_beacon_tx.clone(),
                                p2p_align_tx.clone(),
                                p2p_reaction_fallback_tx.clone(),
                                p2p_chat_fallback_tx.clone(),
                                p2p_chat_react_fallback_tx.clone(),
                            );
                            if let Ok(guard) = voice.lock() {
                                if let Some(ref vc) = *guard {
                                    vc.attach_p2p(Arc::clone(&p2p.voice));
                                }
                            }
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
                let mut retry = false;
                while let Some(cmd) = rx.recv().await {
                    if matches!(cmd, SyncCommand::ManualRetry | SyncCommand::ForceResync) {
                        policy.manual_retry();
                        retry = true;
                        break;
                    }
                    outbox.push(cmd);
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
                reconnects = reconnects.saturating_add(1);
                if was_connected {
                    policy.on_connected();
                    claim_empty = false;
                    rerolled_code_to_emit = None;
                }
                let Some(wait_ms) = policy.next_delay_millis() else {
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
                    let mut health_probe = tokio::time::interval(Duration::from_secs(30));
                    health_probe.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
                    health_probe.tick().await;
                    let mut retry = false;
                    loop {
                        tokio::select! {
                            _ = health_probe.tick() => {
                                if fetch_cloud_health(&endpoint).await {
                                    policy.manual_retry();
                                    retry = true;
                                    break;
                                }
                            }
                            cmd = rx.recv() => {
                                match cmd {
                                    None => break,
                                    Some(SyncCommand::ManualRetry | SyncCommand::ForceResync) => {
                                        policy.manual_retry();
                                        retry = true;
                                        break;
                                    }
                                    Some(other) => outbox.push(other),
                                }
                            }
                        }
                    }
                    if !retry {
                        break;
                    }
                    continue;
                };

                let suggest_backup = policy.suggest_backup();
                let wait_secs_rounded = wait_ms.div_ceil(1000).max(1);
                let _ = app.emit(
                    "sync://status",
                    serde_json::json!({
                        "state": "reconnecting",
                        "endpoint": endpoint,
                        "attempt": policy.attempt,
                        "retryInSecs": wait_secs_rounded,
                        "suggestBackup": suggest_backup,
                    }),
                );

                let sleep = tokio::time::sleep(Duration::from_millis(wait_ms));
                tokio::pin!(sleep);
                let mut should_exit = false;
                loop {
                    tokio::select! {
                        _ = &mut sleep => break,
                        cmd = rx.recv() => {
                            match cmd {
                                None => { should_exit = true; break; }
                                Some(SyncCommand::ManualRetry | SyncCommand::ForceResync) => {
                                    policy.manual_retry();
                                    break;
                                }
                                Some(other) => outbox.push(other),
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

    p2p.try_send(P2pControlCmd::Shutdown);
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
    six_digit: Option<&str>,
    rerolled_code: Option<&str>,
    claim_empty: bool,
    password: Option<&str>,
    host_only: bool,
    persisted_host_token: &mut Option<String>,
    last_known_room_state: &mut Option<(f64, bool)>,
    clock: &mut ClockSyncEstimator,
    outbox: &mut CloudOutbox,
    reconnects: u32,
    rx: &mut mpsc::Receiver<SyncCommand>,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    local_media_path: &Arc<Mutex<Option<PathBuf>>>,
    local_ready: &Arc<Mutex<bool>>,
    timeline_transform: &Arc<Mutex<TimelineTransform>>,
    timeline_segments: &Arc<Mutex<Vec<TimelineSegment>>>,
    has_user_alignment: &Arc<Mutex<bool>>,
    align_mode: &Arc<Mutex<bool>>,
    p2p: &P2pSessionHandle,
    p2p_beacon_rx: &mut mpsc::Receiver<String>,
    p2p_align_rx: &mut mpsc::Receiver<P2pAutoAlignment>,
    p2p_reaction_fallback_rx: &mut mpsc::Receiver<ReactionFallbackPacket>,
    p2p_chat_fallback_rx: &mut mpsc::Receiver<ChatFallbackPacket>,
    p2p_chat_react_fallback_rx: &mut mpsc::Receiver<ChatReactFallbackPacket>,
) -> CloudSessionExit {
    let ws_url = build_cloud_ws_url(endpoint, wire_room);
    let tls_active = endpoint.to_ascii_lowercase().starts_with("wss://");

    let ws_config = tokio_tungstenite::tungstenite::protocol::WebSocketConfig {
        max_message_size: Some(64 * 1024),
        max_frame_size: Some(64 * 1024),
        ..Default::default()
    };

    let ws_stream = match connect_ws_nodelay(&ws_url, ws_config).await {
        Ok(stream) => stream,
        Err(exit) => return exit,
    };

    let (mut ws_tx, mut ws_rx) = ws_stream.split();

    let send_msg = |msg: &CloudClientMsg| -> Option<Message> {
        serde_json::to_string(msg).ok().map(Message::Text)
    };

    // Send hello + initial clock-sync ping immediately.
    let initial_file = local_file
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(to_wire_file));
    let initial_ready = local_ready.lock().ok().map(|g| *g).unwrap_or(false);
    let trimmed_pw = password.map(str::trim).filter(|p| !p.is_empty());
    let password_hash = trimmed_pw.map(|p| hash_room_password(wire_room, p));
    let peek_secret = default_peek_secret(wire_room, six_digit, trimmed_pw);
    let peek_proof = peek_proof_for_room(wire_room, peek_secret);
    let peek_proof_hash = sha256_hex(&peek_proof);
    let resume_hint =
        last_known_room_state.map(|(position, paused)| CloudResumeHint { position, paused });

    let hello_sent_at_ms = now_epoch_ms();
    let hello = CloudClientMsg::Hello {
        username: username.to_string(),
        claim_empty,
        host_only,
        password_hash,
        host_token: persisted_host_token.clone(),
        file: initial_file,
        is_ready: initial_ready,
        resume: resume_hint,
        caps: Some(client_caps()),
        client_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        peek_proof_hash: Some(peek_proof_hash),
        client_ms: Some(hello_sent_at_ms),
    };
    if let Some(frame) = send_msg(&hello) {
        if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
            return CloudSessionExit::Error {
                message,
                was_connected: false,
            };
        }
    }
    // Always send an initial clock-sync Ping right after Hello so ClockSyncEstimator
    // calibrates rapidly even against workers that do not echo clientMs/recvMs in Welcome.
    if let Some(frame) = send_msg(&CloudClientMsg::Ping {
        client_ms: now_epoch_ms(),
    }) {
        let _ = send_ws_bounded(&mut ws_tx, frame).await;
    }

    let drift_ctrl = DriftController::cloud_resilient();
    let mut active_username = username.to_string();
    let mut was_connected = false;
    let mut needs_initial_media_sync = false;
    let mut last_state: Option<CloudPlaybackState> = None;
    let mut last_participants: Vec<CloudParticipant> = Vec::new();
    let mut known_peers: HashSet<String> = HashSet::new();
    let mut server_caps: HashSet<String> = HashSet::new();
    let mut current_control = CloudRoomControl {
        host_control_active: host_only,
        local_is_host: host_only,
        local_is_admin: false,
        host_username: host_only.then(|| username.to_string()),
        admin_usernames: Vec::new(),
    };
    let mut is_scrubbing = false;
    let mut soft_speed_active = false;
    let mut last_speed: f64 = 1.0;
    let mut last_applied_mpv_speed: f64 = 1.0;
    let mut last_local_action_at: Option<Instant> = None;
    let mut awaiting_self_echo = false;
    let mut last_seek_dispatched_at: Option<Instant> = None;
    let mut pause_mismatch_ticks: u8 = 0;
    let mut drift_breach_ticks: u8 = 0;
    let mut seek_breach_ticks: u8 = 0;
    let mut force_snap_next_state = false;
    let mut extra_pings_left: u8 = 2;
    let mut awaiting_pong_since: Option<Instant> = None;
    let mut sent_ping_retry = false;
    let mut last_ping_sent_at: Option<Instant> = None;
    let mut last_buffering_sent = mpv.is_buffering();
    let mut unparseable_count: u32 = 0;
    let mut unparseable_window_start = Instant::now();
    let mut warned_newer_server = false;
    let mut last_drift_secs: f64 = 0.0;
    let mut last_reported_drift_secs: Option<f64> = None;
    let mut last_status_sent_at: Option<Instant> = None;
    let mut pending_seek_pos: Option<f64> = None;
    let mut pending_seek_deadline: Option<tokio::time::Instant> = None;
    let mut last_seek_sent_at: Option<Instant> = None;
    let mut pending_remote_state: Option<CloudPlaybackState> = None;
    let mut pending_remote_deadline: Option<tokio::time::Instant> = None;
    let mut last_remote_seek_applied_at: Option<Instant> = None;
    let build_seek_frame =
        |local_pos: f64, clock: &ClockSyncEstimator, hint_room: Option<f64>| -> Option<Message> {
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
            let room_pos = map_local_to_room_piecewise(local_pos, tx, &segs, hint_room);
            send_msg(&CloudClientMsg::Seek {
                position: room_pos,
                client_server_ms: Some(clock.estimated_server_ms(now_epoch_ms())),
            })
        };

    // Local-only 500ms drift monitor (does NOT send network traffic — keeps DO hibernating!).
    let mut local_drift_tick = tokio::time::interval(Duration::from_millis(500));
    local_drift_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    // Lightweight edge ping every 20s (handled by DO auto-response with 0 compute wake-up!).
    let mut keepalive_tick = tokio::time::interval(KEEPALIVE_INTERVAL);
    keepalive_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    keepalive_tick.tick().await;

    // Fast 15s clock calibration while only high-RTT / cold-start samples are available.
    let mut fast_clock_tick = tokio::time::interval(FAST_CLOCK_CALIBRATION_INTERVAL);
    fast_clock_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    fast_clock_tick.tick().await;

    // Periodic JSON ping every 3 min to keep ClockSyncEstimator calibrated across route changes.
    let mut clock_resync_tick = tokio::time::interval(CLOCK_RESYNC_INTERVAL);
    clock_resync_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    clock_resync_tick.tick().await;

    // 5s health telemetry & sparse peer status tick.
    let mut health_status_tick = tokio::time::interval(HEALTH_EMIT_INTERVAL);
    health_status_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    health_status_tick.tick().await;

    let exit_reason = loop {
        let seek_sleep = async {
            match pending_seek_deadline {
                Some(dl) => tokio::time::sleep_until(dl).await,
                None => std::future::pending::<()>().await,
            }
        };
        let remote_seek_sleep = async {
            match pending_remote_deadline {
                Some(dl) => tokio::time::sleep_until(dl).await,
                None => std::future::pending::<()>().await,
            }
        };
        tokio::select! {
            _ = remote_seek_sleep => {
                pending_remote_deadline = None;
                if let Some(st) = pending_remote_state.take() {
                    let in_align_mode = align_mode.lock().ok().map(|g| *g).unwrap_or(false);
                    if !is_scrubbing && !in_align_mode && !mpv.is_loading_media()
                        && apply_remote_playback_state(
                            app,
                            mpv,
                            &st,
                            &clock,
                            &drift_ctrl,
                            timeline_transform,
                            timeline_segments,
                        )
                    {
                        let now_inst = Instant::now();
                        last_seek_dispatched_at = Some(now_inst);
                        last_remote_seek_applied_at = Some(now_inst);
                    }
                }
            }

            _ = seek_sleep => {
                pending_seek_deadline = None;
                if let Some(local_pos) = pending_seek_pos.take() {
                    awaiting_self_echo = true;
                    last_local_action_at = Some(Instant::now());
                    let hint_room = last_state
                        .as_ref()
                        .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())));
                    if let Some(frame) = build_seek_frame(local_pos, clock, hint_room) {
                        last_seek_sent_at = Some(Instant::now());
                        if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                            break CloudSessionExit::Error {
                                message,
                                was_connected,
                            };
                        }
                    }
                }
            }

            _ = local_drift_tick.tick() => {
                if let Some(since) = awaiting_pong_since {
                    let elapsed = since.elapsed();
                    if elapsed >= PONG_DEADLINE {
                        break CloudSessionExit::Error {
                            message: "Connection stalled (keepalive timeout)".to_string(),
                            was_connected,
                        };
                    }
                    if elapsed >= PING_RETRY_AFTER && !sent_ping_retry {
                        sent_ping_retry = true;
                        last_ping_sent_at = Some(Instant::now());
                        if let Err(message) =
                            send_ws_bounded(&mut ws_tx, Message::Text("ping".to_string())).await
                        {
                            break CloudSessionExit::Error {
                                message,
                                was_connected,
                            };
                        }
                    }
                }
                if is_scrubbing || mpv.is_loading_media() || mpv.is_seeking() {
                    continue;
                }
                if align_mode.lock().ok().map(|g| *g).unwrap_or(false) {
                    continue;
                }
                let Some(ref st) = last_state else { continue };
                let server_now = clock.estimated_server_ms(now_epoch_ms());
                let room_pos = st.projected_position(server_now);
                *last_known_room_state = Some((room_pos, st.paused));
                let _ = app.emit(
                    "sync://room-state",
                    serde_json::json!({ "position": room_pos, "paused": st.paused }),
                );
                if needs_initial_media_sync && local_file.lock().ok().is_some_and(|g| g.is_some()) {
                    needs_initial_media_sync = false;
                    let did_seek = apply_welcome_playback_state(
                        app,
                        mpv,
                        st,
                        clock,
                        timeline_transform,
                        timeline_segments,
                        reconnects > 0,
                    );
                    if did_seek {
                        last_seek_dispatched_at = Some(Instant::now());
                    }
                    continue;
                }
                let echo_ms = compute_echo_suppression_ms(
                    clock.last_rtt_ms().or_else(|| clock.best_rtt_ms()),
                    awaiting_self_echo,
                );
                let in_echo = last_local_action_at
                    .is_some_and(|t| t.elapsed() < Duration::from_millis(echo_ms));
                if in_echo {
                    continue;
                }
                awaiting_self_echo = false;
                let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                let target_local = map_room_to_local_piecewise(room_pos, tx, &segs);
                let snap = mpv.snapshot();

                // T3.2: Reconcile paused/playing state continuously if mismatched for 2 consecutive ticks.
                if snap.paused != st.paused {
                    pause_mismatch_ticks = pause_mismatch_ticks.saturating_add(1);
                    if pause_mismatch_ticks >= 2 {
                        pause_mismatch_ticks = 0;
                        if !mpv.note_paused(st.paused) {
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_pause_cmd(req, st.paused));
                            let _ = app.emit(
                                "mpv://paused",
                                serde_json::json!({ "paused": st.paused }),
                            );
                        }
                    }
                } else {
                    pause_mismatch_ticks = 0;
                }

                let drift = target_local - snap.position;
                last_drift_secs = drift;
                let seek_on_cooldown = last_seek_dispatched_at
                    .is_some_and(|t| t.elapsed() < SEEK_COOLDOWN);
                let in_post_seek_settle = last_seek_dispatched_at
                    .is_some_and(|t| t.elapsed() < POST_SEEK_SETTLE);

                if st.paused {
                    seek_breach_ticks = 0;
                    drift_breach_ticks = 0;
                    let base_speed = tx.effective_speed(1.0);
                    if soft_speed_active || (last_applied_mpv_speed - base_speed).abs() > 0.0005 {
                        soft_speed_active = false;
                        last_speed = 1.0;
                        last_applied_mpv_speed = base_speed;
                        let req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                    }
                    if drift.abs() > 0.25 && !seek_on_cooldown {
                        last_seek_dispatched_at = Some(Instant::now());
                        let _ = mpv.dispatch_seek(target_local.max(0.0), false, None);
                    }
                    continue;
                }

                let jitter_secs = clock.jitter_ms() / 1000.0;
                match drift_ctrl.decide(drift, jitter_secs, soft_speed_active, last_speed) {
                    DriftAction::Seek => {
                        seek_breach_ticks = seek_breach_ticks.saturating_add(1);
                        drift_breach_ticks = 0;
                        if seek_breach_ticks >= 2 {
                            seek_breach_ticks = 0;
                            let base_speed = tx.effective_speed(1.0);
                            if soft_speed_active || (last_applied_mpv_speed - base_speed).abs() > 0.0005 {
                                soft_speed_active = false;
                                last_speed = 1.0;
                                last_applied_mpv_speed = base_speed;
                                let req = mpv.next_request_id();
                                let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                            }
                            if !seek_on_cooldown {
                                last_seek_dispatched_at = Some(Instant::now());
                                let lead = mpv.seek_lead_secs();
                                let _ = mpv.dispatch_seek((target_local + lead).max(0.0), false, None);
                            }
                        }
                    }
                    DriftAction::SetSpeed(speed) if !in_post_seek_settle => {
                        seek_breach_ticks = 0;
                        drift_breach_ticks = drift_breach_ticks.saturating_add(1);
                        if soft_speed_active || drift_breach_ticks >= 2 {
                            soft_speed_active = true;
                            last_speed = speed;
                            let effective_speed = tx.effective_speed(speed);
                            last_applied_mpv_speed = effective_speed;
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_speed_cmd(req, effective_speed));
                        }
                    }
                    DriftAction::SetSpeed(_) => {
                        seek_breach_ticks = 0;
                    }
                    DriftAction::ResetSpeed => {
                        seek_breach_ticks = 0;
                        drift_breach_ticks = 0;
                        soft_speed_active = false;
                        last_speed = 1.0;
                        let base_speed = tx.effective_speed(1.0);
                        last_applied_mpv_speed = base_speed;
                        let req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                    }
                    DriftAction::None => {
                        seek_breach_ticks = 0;
                        if !soft_speed_active {
                            drift_breach_ticks = 0;
                            let base_speed = tx.effective_speed(1.0);
                            if (last_applied_mpv_speed - base_speed).abs() > 0.0005 {
                                last_applied_mpv_speed = base_speed;
                                let req = mpv.next_request_id();
                                let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                            }
                        }
                    }
                }

                // Immediate buffering flip report (T3.7) & post-buffering catch-up snap
                let cur_buf = mpv.is_buffering();
                if cur_buf != last_buffering_sent {
                    if !cur_buf && !st.paused && drift.abs() >= 0.80 && !seek_on_cooldown {
                        soft_speed_active = false;
                        last_speed = 1.0;
                        let base_speed = tx.effective_speed(1.0);
                        if (last_applied_mpv_speed - base_speed).abs() > 0.0005 {
                            last_applied_mpv_speed = base_speed;
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                        }
                        last_seek_dispatched_at = Some(Instant::now());
                        let lead = mpv.seek_lead_secs();
                        let _ = mpv.dispatch_seek((target_local + lead).max(0.0), false, None);
                    }
                    last_buffering_sent = cur_buf;
                    if server_caps.contains("status") {
                        last_reported_drift_secs = Some(last_drift_secs);
                        last_status_sent_at = Some(Instant::now());
                        let mapped_pos =
                            map_local_to_room_piecewise(snap.position, tx, &segs, Some(room_pos));
                        if let Some(frame) = send_msg(&CloudClientMsg::Status {
                            position: mapped_pos,
                            buffering: cur_buf,
                        }) {
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
                                    was_connected,
                                };
                            }
                        }
                    }
                }
            }

            _ = keepalive_tick.tick() => {
                // Zero-compute edge auto-response ("ping" -> "pong") keeps NAT/TLS alive & detects dead sockets.
                let now_inst = Instant::now();
                last_ping_sent_at = Some(now_inst);
                if awaiting_pong_since.is_none() {
                    awaiting_pong_since = Some(now_inst);
                    sent_ping_retry = false;
                }
                if let Err(message) =
                    send_ws_bounded(&mut ws_tx, Message::Text("ping".to_string())).await
                {
                    break CloudSessionExit::Error { message, was_connected };
                }
            }

            _ = fast_clock_tick.tick() => {
                if was_connected && clock.needs_fast_calibration() {
                    if let Some(frame) = send_msg(&CloudClientMsg::Ping {
                        client_ms: now_epoch_ms(),
                    }) {
                        let _ = send_ws_bounded(&mut ws_tx, frame).await;
                    }
                }
            }

            _ = clock_resync_tick.tick() => {
                if was_connected {
                    if let Some(frame) = send_msg(&CloudClientMsg::Ping {
                        client_ms: now_epoch_ms(),
                    }) {
                        let _ = send_ws_bounded(&mut ws_tx, frame).await;
                    }
                }
            }

            _ = health_status_tick.tick() => {
                if was_connected {
                    let _ = app.emit(
                        "sync://health",
                        serde_json::json!({
                            "rttMs": clock.last_rtt_ms().or_else(|| clock.best_rtt_ms()),
                            "jitterMs": clock.jitter_ms(),
                            "offsetMs": clock.offset_ms(),
                            "driftSecs": last_drift_secs,
                            "seekLeadMs": (mpv.seek_lead_secs() * 1000.0).round(),
                            "endpoint": endpoint,
                            "seq": last_state.as_ref().map(|s| s.seq).unwrap_or(0),
                            "reconnects": reconnects,
                        }),
                    );
                    if server_caps.contains("status")
                        && last_state.as_ref().is_some_and(|s| !s.paused)
                    {
                        let drift_changed = last_reported_drift_secs
                            .is_none_or(|prev| (last_drift_secs - prev).abs() >= 0.4);
                        let heartbeat_due = last_status_sent_at
                            .is_none_or(|t| t.elapsed() >= STATUS_HEARTBEAT_INTERVAL);
                        if drift_changed || heartbeat_due {
                            let snap = mpv.snapshot();
                            let cur_buf = mpv.is_buffering();
                            last_buffering_sent = cur_buf;
                            last_reported_drift_secs = Some(last_drift_secs);
                            last_status_sent_at = Some(Instant::now());
                            let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                            let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                            let hint_room = last_state
                                .as_ref()
                                .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())));
                            let mapped_pos =
                                map_local_to_room_piecewise(snap.position, tx, &segs, hint_room);
                            if let Some(frame) = send_msg(&CloudClientMsg::Status {
                                position: mapped_pos,
                                buffering: cur_buf,
                            }) {
                                if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                    break CloudSessionExit::Error {
                                        message,
                                        was_connected,
                                    };
                                }
                            }
                        }
                    }
                }
            }

            Some(beacon) = p2p_beacon_rx.recv() => {
                if let Some(frame) = send_msg(&CloudClientMsg::P2pSignal { payload: beacon }) {
                    let _ = send_ws_bounded(&mut ws_tx, frame).await;
                }
            }

            Some(auto_align) = p2p_align_rx.recv() => {
                let current_sig = build_p2p_local_media(
                    local_file,
                    local_media_path,
                    has_user_alignment,
                )
                .map(|m| m.file_sig);
                let user_locked = has_user_alignment.lock().map(|g| *g).unwrap_or(false);
                if current_sig.as_deref() == Some(auto_align.file_sig.as_str()) && !user_locked {
                    let next_tx = auto_align.transform.sanitized();
                    let seg_count = auto_align.segments.len();
                    if let Ok(mut guard) = timeline_transform.lock() {
                        *guard = next_tx;
                    }
                    if let Ok(mut guard) = timeline_segments.lock() {
                        *guard = auto_align.segments.clone();
                    }
                    let _ = app.emit("sync://timeline-transform", next_tx);
                    let _ = app.emit("sync://timeline-segments", &auto_align.segments);
                    let _ = app.emit(
                        "sync://auto-aligned",
                        serde_json::json!({
                            "offsetSecs": next_tx.offset_secs,
                            "scale": next_tx.scale,
                            "segmentCount": seg_count.max(1),
                            "confidence": auto_align.confidence,
                            "summary": auto_align.summary,
                        }),
                    );
                    let in_align_mode = align_mode.lock().ok().map(|g| *g).unwrap_or(false);
                    if !in_align_mode && !is_scrubbing {
                        let base_speed = next_tx.effective_speed(1.0);
                        soft_speed_active = false;
                        last_speed = 1.0;
                        last_applied_mpv_speed = base_speed;
                        let req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                        if let Some(ref st) = last_state {
                            let mut snap_st = st.clone();
                            snap_st.do_seek = true;
                            if apply_remote_playback_state(
                                app,
                                mpv,
                                &snap_st,
                                &clock,
                                &drift_ctrl,
                                timeline_transform,
                                timeline_segments,
                            ) {
                                last_seek_dispatched_at = Some(Instant::now());
                            }
                        }
                    }
                }
            }

            Some(pkt) = p2p_reaction_fallback_rx.recv() => {
                if let Some(frame) = send_msg(&CloudClientMsg::Reaction {
                    emoji: pkt.emoji,
                    avatar_id: pkt.avatar_id,
                    count: pkt.count,
                }) {
                    let _ = send_ws_bounded(&mut ws_tx, frame).await;
                }
            }

            Some(pkt) = p2p_chat_fallback_rx.recv() => {
                let is_edit = pkt.is_edit;
                let msg = if is_edit {
                    CloudClientMsg::ChatEdit {
                        target_msg_id: pkt.msg_id.clone(),
                        text: pkt.text.clone(),
                    }
                } else {
                    CloudClientMsg::Chat {
                        id: pkt.msg_id.clone(),
                        text: pkt.text.clone(),
                        avatar_id: pkt.avatar_id.clone(),
                        reply_to_id: pkt.reply_to_id.clone(),
                    }
                };
                if let Some(frame) = send_msg(&msg) {
                    if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                        if !is_edit {
                            outbox.push(SyncCommand::SendChat {
                                id: pkt.msg_id,
                                text: pkt.text,
                                avatar_id: pkt.avatar_id,
                                reply_to_id: pkt.reply_to_id,
                            });
                        }
                        break CloudSessionExit::Error {
                            message,
                            was_connected,
                        };
                    }
                }
            }

            Some(pkt) = p2p_chat_react_fallback_rx.recv() => {
                if let Some(frame) = send_msg(&CloudClientMsg::ChatReact {
                    target_msg_id: pkt.msg_id,
                    emoji: pkt.emoji,
                }) {
                    let _ = send_ws_bounded(&mut ws_tx, frame).await;
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
                        if code == 4029 {
                            break CloudSessionExit::FatalAuth {
                                message: "Too many failed password attempts. Please wait before retrying."
                                    .to_string(),
                            };
                        }
                        break CloudSessionExit::Error {
                            message: format!("Connection closed ({code})"),
                            was_connected,
                        };
                    }
                    Some(Ok(Message::Text(text))) => {
                        let stalled_for = awaiting_pong_since.map(|since| since.elapsed());
                        awaiting_pong_since = None;
                        sent_ping_retry = false;
                        if stalled_for.is_some_and(|d| d >= STALL_RECOVERY_THRESHOLD) && was_connected
                        {
                            // Connection just recovered from a severe packet-loss/ping stall without
                            // dropping the WebSocket; pull authoritative room state immediately.
                            force_snap_next_state = true;
                            if let Some(frame) = send_msg(&CloudClientMsg::Resync) {
                                if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                    break CloudSessionExit::Error {
                                        message,
                                        was_connected,
                                    };
                                }
                            }
                        }
                        if text == "pong" {
                            if let Some(sent_at) = last_ping_sent_at.take() {
                                clock.record_rtt_only(sent_at.elapsed().as_secs_f64() * 1000.0);
                            }
                            continue;
                        }
                        let Ok(parsed) = serde_json::from_str::<CloudServerMsg>(&text) else {
                            if unparseable_window_start.elapsed() >= Duration::from_secs(60) {
                                unparseable_window_start = Instant::now();
                                unparseable_count = 0;
                            }
                            unparseable_count = unparseable_count.saturating_add(1);
                            if unparseable_count > 5 && !warned_newer_server {
                                warned_newer_server = true;
                                let _ = app.emit(
                                    "sync://error",
                                    serde_json::json!({
                                        "message": "A newer version of Epilod Party is available."
                                    }),
                                );
                            }
                            continue;
                        };
                        match parsed {
                            CloudServerMsg::Welcome {
                                username: assigned,
                                host_token,
                                server_time_ms,
                                client_ms,
                                recv_ms,
                                retained,
                                server_caps: caps_list,
                                state,
                                participants,
                                room_control,
                                ..
                            } => {
                                let t4 = now_epoch_ms();
                                if let Some(c_ms) = client_ms {
                                    if let Some(r_ms) = recv_ms {
                                        clock.record_ntp_sample(c_ms, r_ms, server_time_ms, t4);
                                    } else {
                                        clock.record_pong(c_ms, t4, server_time_ms);
                                    }
                                } else if server_time_ms > 0.0 {
                                    // Fallback for workers that do not echo clientMs in Welcome:
                                    // calibrate immediately from Hello's send timestamp so
                                    // projected_position never stalls when the local PC clock is skewed.
                                    clock.record_pong(hello_sent_at_ms, t4, server_time_ms);
                                }
                                was_connected = true;
                                server_caps = caps_list.into_iter().collect();
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
                                *last_known_room_state = Some((state.position, state.paused));

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

                                // T2.6 + T1.1: Reconcile on Welcome when retained, multi-peer, or non-zero seq,
                                // unless we have a queued offline playback command that we are allowed to push right below.
                                // On reconnect into an active multi-peer room, discard stale queued playback intents
                                // from non-host peers so a reconnecting bad-network client cannot yank the room back.
                                if reconnects > 0 && participants.len() > 1 && !current_control.local_is_host {
                                    outbox.playback = None;
                                    outbox.latest_seek = None;
                                }
                                let can_control_welcome = !current_control.host_control_active
                                    || current_control.local_is_host
                                    || current_control.local_is_admin;
                                let has_queued_playback =
                                    can_control_welcome && (outbox.playback.is_some() || outbox.latest_seek.is_some());
                                if !has_queued_playback
                                    && should_apply_welcome_state(retained, state.seq, participants.len())
                                {
                                    let has_media = local_file.lock().ok().is_some_and(|g| g.is_some());
                                    if has_media && !mpv.is_loading_media() {
                                        if apply_welcome_playback_state(
                                            app,
                                            mpv,
                                            &state,
                                            clock,
                                            timeline_transform,
                                            timeline_segments,
                                            reconnects > 0,
                                        ) {
                                            last_seek_dispatched_at = Some(Instant::now());
                                        }
                                    } else {
                                        needs_initial_media_sync = true;
                                    }
                                } else if outbox.playback.is_none() && !mpv.is_loading_media() {
                                    let snap = mpv.snapshot();
                                    let has_media = local_file.lock().ok().is_some_and(|g| g.is_some());
                                    if has_media && !snap.paused {
                                        awaiting_self_echo = true;
                                        last_local_action_at = Some(Instant::now());
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
                                        let room_pos =
                                            map_local_to_room_piecewise(snap.position, tx, &segs, None);
                                        if let Some(frame) = send_msg(&CloudClientMsg::Play {
                                            position: room_pos,
                                            client_server_ms: Some(
                                                clock.estimated_server_ms(now_epoch_ms()),
                                            ),
                                        }) {
                                            let _ = send_ws_bounded(&mut ws_tx, frame).await;
                                        }
                                    }
                                }

                                // T2.1: Drain any queued offline commands in order: file -> ready -> chats -> playback.
                                if !outbox.is_empty() {
                                    if let Some(meta_opt) = outbox.file.take() {
                                        let wire = meta_opt.as_ref().map(to_wire_file);
                                        if let Some(frame) = send_msg(&CloudClientMsg::File { file: wire }) {
                                            let _ = ws_tx.send(frame).await;
                                        }
                                    }
                                    if let Some((is_ready, manual)) = outbox.ready.take() {
                                        if let Some(frame) = send_msg(&CloudClientMsg::Ready { is_ready, manual }) {
                                            let _ = ws_tx.send(frame).await;
                                        }
                                    }
                                    // Route queued chats/reactions through P2P (ordered after UpdateParticipants
                                    // above); `p2p` automatically emits fallback packets for non-direct peers.
                                    while let Some(chat_cmd) = outbox.chats.pop_front() {
                                        match chat_cmd {
                                            SyncCommand::SendReaction { emoji, avatar_id, count } => {
                                                p2p.try_send(P2pControlCmd::SendReaction { emoji, avatar_id, count });
                                            }
                                            SyncCommand::SendRatingVote { key, score, avatar_id } => {
                                                if let Some(encoded) = epilod_core::p2p::encode_epv_rating(&epilod_core::p2p::RatingVotePacket {
                                                    key: key.clone(),
                                                    score,
                                                    avatar_id: avatar_id.clone(),
                                                }) {
                                                    let msg_id = format!("epv-{}-{}", key, score);
                                                    if let Some(frame) = send_msg(&CloudClientMsg::Chat {
                                                        id: msg_id,
                                                        text: encoded,
                                                        avatar_id,
                                                        reply_to_id: None,
                                                    }) {
                                                        let _ = ws_tx.send(frame).await;
                                                    }
                                                }
                                            }
                                            SyncCommand::SendChat { id, text, avatar_id, reply_to_id } => {
                                                p2p.try_send(P2pControlCmd::SendChat { id, text, avatar_id, reply_to_id });
                                            }
                                            SyncCommand::SendChatEdit { target_msg_id, text } => {
                                                p2p.try_send(P2pControlCmd::SendChatEdit { target_msg_id, text });
                                            }
                                            SyncCommand::SendChatReact { target_msg_id, emoji } => {
                                                p2p.try_send(P2pControlCmd::SendChatReact { target_msg_id, emoji });
                                            }
                                            SyncCommand::SendChatSeen { last_msg_id } => {
                                                p2p.try_send(P2pControlCmd::SendChatSeen { last_msg_id });
                                            }
                                            SyncCommand::SendSubtitleShare { id, file_name, ext, lang, content } => {
                                                p2p.try_send(P2pControlCmd::SendSubtitleShare {
                                                    id,
                                                    file_name,
                                                    ext,
                                                    lang,
                                                    content,
                                                });
                                            }
                                            _ => {}
                                        }
                                    }
                                    let can_control = !current_control.host_control_active
                                        || current_control.local_is_host
                                        || current_control.local_is_admin;
                                    let seek_override = outbox.latest_seek.take();
                                    let pb = outbox.playback.take();
                                    if can_control && (seek_override.is_some() || pb.is_some()) {
                                        awaiting_self_echo = true;
                                        last_local_action_at = Some(Instant::now());
                                    }
                                    if can_control {
                                        let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                                        let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                                        let srv_now = Some(clock.estimated_server_ms(now_epoch_ms()));
                                        let hint_room = last_state
                                            .as_ref()
                                            .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())));
                                        if let Some(sk_pos) = seek_override {
                                            if !matches!(pb, Some(OutboxPlayback::Seek(_))) {
                                                let room_pos =
                                                    map_local_to_room_piecewise(sk_pos, tx, &segs, hint_room);
                                                if let Some(frame) = send_msg(&CloudClientMsg::Seek {
                                                    position: room_pos,
                                                    client_server_ms: srv_now,
                                                }) {
                                                    let _ = ws_tx.send(frame).await;
                                                }
                                            }
                                        }
                                        if let Some(intent) = pb {
                                            let msg = match intent {
                                                OutboxPlayback::Play(p) => CloudClientMsg::Play {
                                                    position: map_local_to_room_piecewise(p, tx, &segs, hint_room),
                                                    client_server_ms: srv_now,
                                                },
                                                OutboxPlayback::Pause(p) => CloudClientMsg::Pause {
                                                    position: map_local_to_room_piecewise(p, tx, &segs, hint_room),
                                                    client_server_ms: srv_now,
                                                },
                                                OutboxPlayback::Seek(p) => CloudClientMsg::Seek {
                                                    position: map_local_to_room_piecewise(p, tx, &segs, hint_room),
                                                    client_server_ms: srv_now,
                                                },
                                            };
                                            if let Some(frame) = send_msg(&msg) {
                                                let _ = ws_tx.send(frame).await;
                                            }
                                        }
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
                                        let _ = send_ws_bounded(&mut ws_tx, frame).await;
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
                                reason: _,
                            } => {
                                let prev_seq = last_state.as_ref().map(|prev| prev.seq).unwrap_or(0);
                                if last_state.as_ref().is_some_and(|prev| seq < prev.seq)
                                    && !force_snap_next_state
                                {
                                    continue;
                                }
                                let forced_snap = std::mem::take(&mut force_snap_next_state);
                                let is_self = set_by
                                    .as_deref()
                                    .is_some_and(|u| u.eq_ignore_ascii_case(&active_username));
                                let seq_skipped = seq > prev_seq.saturating_add(1);
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
                                *last_known_room_state = Some((position, paused));
                                let _ = app.emit(
                                    "sync://room-state",
                                    serde_json::json!({ "position": position, "paused": paused }),
                                );

                                let in_align_mode = align_mode.lock().ok().map(|g| *g).unwrap_or(false);
                                if is_self {
                                    awaiting_self_echo = false;
                                } else {
                                    awaiting_self_echo = false;
                                    last_local_action_at = None;
                                }
                                let self_desynced = if is_self
                                    && !is_scrubbing
                                    && !in_align_mode
                                    && !mpv.is_loading_media()
                                    && pending_seek_pos.is_none()
                                {
                                    let server_now = clock.estimated_server_ms(now_epoch_ms());
                                    let room_pos = next_state.projected_position(server_now);
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
                                    let target_local =
                                        map_room_to_local_piecewise(room_pos, tx, &segs);
                                    let snap = mpv.snapshot();
                                    snap.paused != paused || (target_local - snap.position).abs() >= 1.25
                                } else {
                                    false
                                };

                                if !is_self || forced_snap || seq_skipped || self_desynced {
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
                                        let coalesce_remote_seek = do_seek
                                            && !is_self
                                            && !forced_snap
                                            && last_remote_seek_applied_at
                                                .is_some_and(|t| t.elapsed() < REMOTE_SEEK_COALESCE);
                                        if coalesce_remote_seek {
                                            pending_remote_state = Some(next_state.clone());
                                            if pending_remote_deadline.is_none() {
                                                pending_remote_deadline =
                                                    Some(tokio::time::Instant::now() + REMOTE_SEEK_COALESCE);
                                            }
                                        } else {
                                            pending_remote_state = None;
                                            pending_remote_deadline = None;
                                            let mut state_to_apply = next_state.clone();
                                            if seq_skipped || forced_snap {
                                                state_to_apply.do_seek = true;
                                            }
                                            if apply_remote_playback_state(
                                                app,
                                                mpv,
                                                &state_to_apply,
                                                clock,
                                                &drift_ctrl,
                                                timeline_transform,
                                                timeline_segments,
                                            ) {
                                                let now_inst = Instant::now();
                                                last_seek_dispatched_at = Some(now_inst);
                                                if do_seek {
                                                    last_remote_seek_applied_at = Some(now_inst);
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            CloudServerMsg::PlayBlocked { usernames } => {
                                awaiting_self_echo = false;
                                force_snap_next_state = true;
                                last_local_action_at = None;
                                if !mpv.note_paused(true) {
                                    let req = mpv.next_request_id();
                                    let _ = mpv.send_command(set_pause_cmd(req, true));
                                    let _ = app.emit("mpv://paused", serde_json::json!({ "paused": true }));
                                }
                                let _ = app.emit(
                                    "sync://play-blocked",
                                    serde_json::json!({ "usernames": usernames }),
                                );
                            }
                            CloudServerMsg::RateLimited { bucket: _, retry_after_ms: _ } => {
                                awaiting_self_echo = false;
                                force_snap_next_state = true;
                                last_local_action_at = None;
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
                                        awaiting_self_echo = false;
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
                                if let Some(av) = epilod_core::p2p::decode_ep2_avatar(&payload) {
                                    if !sender.eq_ignore_ascii_case(&active_username) {
                                        let _ = app.emit(
                                            "sync://peer-avatar",
                                            serde_json::json!({
                                                "username": sender,
                                                "avatarId": av,
                                            }),
                                        );
                                    }
                                } else {
                                    p2p.try_send(P2pControlCmd::RemoteBeacon {
                                        username: sender,
                                        raw_message: payload,
                                    });
                                }
                            }
                            CloudServerMsg::Chat {
                                id,
                                username: sender,
                                avatar_id,
                                text,
                                reply_to_id,
                            } => {
                                if let Some(pkt) = epilod_core::p2p::decode_epv_rating(text.trim()) {
                                    let _ = app.emit(
                                        "sync://rating-vote",
                                        serde_json::json!({
                                            "username": sender,
                                            "avatarId": pkt.avatar_id,
                                            "key": pkt.key,
                                            "score": pkt.score,
                                            "via": "cloud",
                                        }),
                                    );
                                } else {
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
                            }
                            CloudServerMsg::ChatAck { id } => {
                                let _ = app.emit(
                                    "chat://delivery",
                                    serde_json::json!({
                                        "id": id,
                                        "status": "delivered",
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
                            CloudServerMsg::ChatSeen {
                                username: sender,
                                last_msg_id,
                            } => {
                                let _ = app.emit(
                                    "sync://chat-seen",
                                    serde_json::json!({
                                        "username": sender,
                                        "lastMsgId": last_msg_id,
                                        "via": "syncplay",
                                    }),
                                );
                            }
                            CloudServerMsg::IntroSkipVote {
                                username: sender,
                                seg_key,
                            } => {
                                let _ = app.emit(
                                    "sync://intro-skip-vote",
                                    serde_json::json!({
                                        "username": sender,
                                        "segKey": seg_key,
                                        "via": "p2pRelay",
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
                                if code == "BAD_PASSWORD" || code == "RATE_LIMITED" {
                                    break CloudSessionExit::FatalAuth { message };
                                }
                                if code != "UNSUPPORTED" {
                                    let _ = app.emit("sync://error", serde_json::json!({ "message": message }));
                                }
                            }
                        }
                    }
                    Some(Ok(_)) => {
                        awaiting_pong_since = None;
                        sent_ping_retry = false;
                    }
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
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
                                    was_connected,
                                };
                            }
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
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
                                    was_connected,
                                };
                            }
                        }
                    }
                    SyncCommand::UserPlay(local_pos) => {
                        let locked_out = current_control.host_control_active
                            && !current_control.local_is_host
                            && !current_control.local_is_admin;
                        if locked_out {
                            if let Some(ref st) = last_state {
                                if apply_remote_playback_state(
                                    app,
                                    mpv,
                                    st,
                                    &clock,
                                    &drift_ctrl,
                                    timeline_transform,
                                    timeline_segments,
                                ) {
                                    last_seek_dispatched_at = Some(Instant::now());
                                }
                            }
                            continue;
                        }
                        is_scrubbing = false;
                        pending_seek_pos = None;
                        pending_seek_deadline = None;
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
                        awaiting_self_echo = true;
                        last_local_action_at = Some(Instant::now());
                        pending_seek_pos = None;
                        pending_seek_deadline = None;
                        let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                        let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                        let hint_room = last_state
                            .as_ref()
                            .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())));
                        let room_pos = map_local_to_room_piecewise(local_pos, tx, &segs, hint_room);
                        // T2.8: Send latency-critical Play BEFORE Ready.
                        if let Some(frame) = send_msg(&CloudClientMsg::Play {
                            position: room_pos,
                            client_server_ms: Some(clock.estimated_server_ms(now_epoch_ms())),
                        }) {
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
                                    was_connected,
                                };
                            }
                        }
                        if let Some(frame) = send_msg(&CloudClientMsg::Ready {
                            is_ready: true,
                            manual: true,
                        }) {
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
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
                                if apply_remote_playback_state(
                                    app,
                                    mpv,
                                    st,
                                    clock,
                                    &drift_ctrl,
                                    timeline_transform,
                                    timeline_segments,
                                ) {
                                    last_seek_dispatched_at = Some(Instant::now());
                                }
                            }
                            continue;
                        }
                        if !mpv.note_paused(true) {
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_pause_cmd(req, true));
                            let _ = app.emit("mpv://paused", serde_json::json!({ "paused": true }));
                        }
                        awaiting_self_echo = true;
                        last_local_action_at = Some(Instant::now());
                        pending_seek_pos = None;
                        pending_seek_deadline = None;
                        let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                        let segs = timeline_segments.lock().ok().map(|g| g.clone()).unwrap_or_default();
                        let hint_room = last_state
                            .as_ref()
                            .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())));
                        let room_pos = map_local_to_room_piecewise(local_pos, tx, &segs, hint_room);
                        if let Some(frame) = send_msg(&CloudClientMsg::Pause {
                            position: room_pos,
                            client_server_ms: Some(clock.estimated_server_ms(now_epoch_ms())),
                        }) {
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
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
                                if apply_remote_playback_state(
                                    app,
                                    mpv,
                                    st,
                                    clock,
                                    &drift_ctrl,
                                    timeline_transform,
                                    timeline_segments,
                                ) {
                                    last_seek_dispatched_at = Some(Instant::now());
                                }
                            }
                            continue;
                        }
                        awaiting_self_echo = true;
                        last_local_action_at = Some(Instant::now());
                        let leading_edge = !is_scrubbing
                            && last_seek_sent_at
                                .is_none_or(|t| t.elapsed() >= Duration::from_millis(150));
                        if leading_edge {
                            pending_seek_pos = None;
                            pending_seek_deadline = None;
                            let hint_room = last_state
                                .as_ref()
                                .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())));
                            if let Some(frame) = build_seek_frame(local_pos, clock, hint_room) {
                                last_seek_sent_at = Some(Instant::now());
                                if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                    break CloudSessionExit::Error {
                                        message,
                                        was_connected,
                                    };
                                }
                            }
                        } else {
                            pending_seek_pos = Some(local_pos);
                            if pending_seek_deadline.is_none() {
                                let debounce = if is_scrubbing {
                                    SEEK_SCRUB_DEBOUNCE
                                } else {
                                    SEEK_TAP_DEBOUNCE
                                };
                                pending_seek_deadline =
                                    Some(tokio::time::Instant::now() + debounce);
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
                        if let Ok(mut g) = has_user_alignment.lock() {
                            *g = false;
                        }
                        soft_speed_active = false;
                        last_speed = 1.0;
                        last_applied_mpv_speed = 1.0;
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(None));
                        let req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(req, 1.0));
                        let _ = app.emit("sync://timeline-transform", TimelineTransform::default());
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        if let Some(frame) = send_msg(&CloudClientMsg::File { file: None }) {
                            let _ = ws_tx.send(frame).await;
                        }
                        if let Some(frame) = send_msg(&CloudClientMsg::Ready {
                            is_ready: false,
                            manual: false,
                        }) {
                            let _ = ws_tx.send(frame).await;
                        }
                    }
                    SyncCommand::ForceResync => {
                        is_scrubbing = false;
                        if let Ok(mut g) = align_mode.lock() {
                            *g = false;
                        }
                        force_snap_next_state = true;
                        if let Some(frame) = send_msg(&CloudClientMsg::Ping {
                            client_ms: now_epoch_ms(),
                        }) {
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
                                    was_connected,
                                };
                            }
                        }
                        if let Some(frame) = send_msg(&CloudClientMsg::Resync) {
                            if let Err(message) = send_ws_bounded(&mut ws_tx, frame).await {
                                break CloudSessionExit::Error {
                                    message,
                                    was_connected,
                                };
                            }
                        }
                    }
                    SyncCommand::SetScrubbing(s) => {
                        is_scrubbing = s;
                    }
                    SyncCommand::SetTimelineTransform(tx) => {
                        let next_tx = tx.sanitized();
                        if let Ok(mut g) = timeline_transform.lock() {
                            *g = next_tx;
                        }
                        if let Ok(mut g) = timeline_segments.lock() {
                            g.clear();
                        }
                        if let Ok(mut g) = has_user_alignment.lock() {
                            *g = !next_tx.is_identity();
                        }
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_local_media(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                        let in_align_mode = align_mode.lock().ok().map(|g| *g).unwrap_or(false);
                        if !in_align_mode {
                            let base_speed = next_tx.effective_speed(1.0);
                            soft_speed_active = false;
                            last_speed = 1.0;
                            last_applied_mpv_speed = base_speed;
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                            if !is_scrubbing {
                                if let Some(ref st) = last_state {
                                    let mut snap_st = st.clone();
                                    snap_st.do_seek = true;
                                    if apply_remote_playback_state(
                                        app,
                                        mpv,
                                        &snap_st,
                                        &clock,
                                        &drift_ctrl,
                                        timeline_transform,
                                        timeline_segments,
                                    ) {
                                        last_seek_dispatched_at = Some(Instant::now());
                                    }
                                }
                            }
                        }
                    }
                    SyncCommand::NudgeTimelineOffset(delta) => {
                        let next_tx = if let Ok(mut g) = timeline_transform.lock() {
                            g.offset_secs += delta;
                            *g = g.sanitized();
                            *g
                        } else {
                            TimelineTransform::default()
                        };
                        if let Ok(mut g) = timeline_segments.lock() {
                            g.clear();
                        }
                        if let Ok(mut g) = has_user_alignment.lock() {
                            *g = true;
                        }
                        let _ = app.emit("sync://timeline-transform", next_tx);
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_local_media(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                        let in_align_mode = align_mode.lock().ok().map(|g| *g).unwrap_or(false);
                        if !in_align_mode {
                            let base_speed = next_tx.effective_speed(1.0);
                            soft_speed_active = false;
                            last_speed = 1.0;
                            last_applied_mpv_speed = base_speed;
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                            if !is_scrubbing {
                                if let Some(ref st) = last_state {
                                    let mut snap_st = st.clone();
                                    snap_st.do_seek = true;
                                    if apply_remote_playback_state(
                                        app,
                                        mpv,
                                        &snap_st,
                                        &clock,
                                        &drift_ctrl,
                                        timeline_transform,
                                        timeline_segments,
                                    ) {
                                        last_seek_dispatched_at = Some(Instant::now());
                                    }
                                }
                            }
                        }
                    }
                    SyncCommand::SetAlignMode(enabled) => {
                        if let Ok(mut g) = align_mode.lock() {
                            *g = enabled;
                        }
                        if enabled {
                            if let Some(ref st) = last_state {
                                let server_now = clock.estimated_server_ms(now_epoch_ms());
                                let room_pos = st.projected_position(server_now);
                                *last_known_room_state = Some((room_pos, st.paused));
                                let _ = app.emit(
                                    "sync://room-state",
                                    serde_json::json!({ "position": room_pos, "paused": st.paused }),
                                );
                            }
                        } else {
                            let tx = timeline_transform.lock().ok().map(|g| *g).unwrap_or_default();
                            let base_speed = tx.effective_speed(1.0);
                            soft_speed_active = false;
                            last_speed = 1.0;
                            last_applied_mpv_speed = base_speed;
                            let req = mpv.next_request_id();
                            let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                            if !is_scrubbing {
                                if let Some(ref st) = last_state {
                                    let mut snap_st = st.clone();
                                    snap_st.do_seek = true;
                                    if apply_remote_playback_state(
                                        app,
                                        mpv,
                                        &snap_st,
                                        &clock,
                                        &drift_ctrl,
                                        timeline_transform,
                                        timeline_segments,
                                    ) {
                                        last_seek_dispatched_at = Some(Instant::now());
                                    }
                                }
                            }
                        }
                    }
                    SyncCommand::AlignSceneHere { local_pos_secs, reply } => {
                        let local_pos = local_pos_secs.unwrap_or_else(|| mpv.snapshot().position);
                        let room_pos = last_state
                            .as_ref()
                            .map(|s| s.projected_position(clock.estimated_server_ms(now_epoch_ms())))
                            .unwrap_or(local_pos);
                        let next_tx = if let Ok(mut g) = timeline_transform.lock() {
                            g.offset_secs = local_pos - room_pos * g.scale;
                            *g = g.sanitized();
                            *g
                        } else {
                            TimelineTransform::default()
                        };
                        if let Ok(mut g) = timeline_segments.lock() {
                            g.clear();
                        }
                        if let Ok(mut g) = has_user_alignment.lock() {
                            *g = true;
                        }
                        if let Ok(mut g) = align_mode.lock() {
                            *g = false;
                        }
                        let _ = app.emit("sync://timeline-transform", next_tx);
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_local_media(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                        let base_speed = next_tx.effective_speed(1.0);
                        soft_speed_active = false;
                        last_speed = 1.0;
                        last_applied_mpv_speed = base_speed;
                        let req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(req, base_speed));
                        if let Some(ref st) = last_state {
                            let mut snap_st = st.clone();
                            snap_st.do_seek = true;
                            if apply_remote_playback_state(
                                app,
                                mpv,
                                &snap_st,
                                &clock,
                                &drift_ctrl,
                                timeline_transform,
                                timeline_segments,
                            ) {
                                last_seek_dispatched_at = Some(Instant::now());
                            }
                        }
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
                    SyncCommand::SendRatingVote { key, score, avatar_id } => {
                        if let Some(encoded) = epilod_core::p2p::encode_epv_rating(&epilod_core::p2p::RatingVotePacket {
                            key: key.clone(),
                            score,
                            avatar_id: avatar_id.clone(),
                        }) {
                            let msg_id = format!("epv-{}-{}", key, score);
                            if let Some(frame) = send_msg(&CloudClientMsg::Chat {
                                id: msg_id,
                                text: encoded,
                                avatar_id,
                                reply_to_id: None,
                            }) {
                                let _ = ws_tx.send(frame).await;
                            }
                        }
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
                    SyncCommand::SendChatSeen { last_msg_id } => {
                        p2p.try_send(P2pControlCmd::SendChatSeen {
                            last_msg_id: last_msg_id.clone(),
                        });
                        if let Some(frame) = send_msg(&CloudClientMsg::ChatSeen { last_msg_id }) {
                            let _ = ws_tx.send(frame).await;
                        }
                    }
                    SyncCommand::SendIntroSkipVote { seg_key } => {
                        p2p.try_send(P2pControlCmd::SendIntroSkipVote {
                            seg_key: seg_key.clone(),
                        });
                        if let Some(frame) = send_msg(&CloudClientMsg::IntroSkipVote { seg_key }) {
                            let _ = ws_tx.send(frame).await;
                        }
                    }
                    SyncCommand::SendAvatarPresence { avatar_id } => {
                        if let Some(payload) = epilod_core::p2p::encode_ep2_avatar(&avatar_id) {
                            if let Some(frame) = send_msg(&CloudClientMsg::P2pSignal { payload }) {
                                let _ = ws_tx.send(frame).await;
                            }
                        }
                    }
                    SyncCommand::SetChatImageMode { mode } => {
                        p2p.try_send(P2pControlCmd::SetChatImageMode { mode });
                    }
                    SyncCommand::SendChatImage {
                        id,
                        avatar_id,
                        caption,
                        spoiler,
                        width,
                        height,
                        data_b64,
                        reply_to_id,
                    } => {
                        p2p.try_send(P2pControlCmd::SendChatImage {
                            id,
                            avatar_id,
                            caption,
                            spoiler,
                            width,
                            height,
                            data_b64,
                            reply_to_id,
                        });
                    }
                    SyncCommand::RequestChatImage { id, sender } => {
                        p2p.try_send(P2pControlCmd::RequestChatImage { id, sender });
                    }
                    SyncCommand::SendSubtitleShare {
                        id,
                        file_name,
                        ext,
                        lang,
                        content,
                    } => {
                        p2p.try_send(P2pControlCmd::SendSubtitleShare {
                            id,
                            file_name,
                            ext,
                            lang,
                            content,
                        });
                    }
                    SyncCommand::ManualRetry => {}
                }
            }
        }
    };

    let _ = ws_tx.send(Message::Close(None)).await;
    exit_reason
}

fn apply_remote_playback_state(
    app: &AppHandle,
    mpv: &Arc<MpvController>,
    state: &CloudPlaybackState,
    clock: &ClockSyncEstimator,
    drift_ctrl: &DriftController,
    timeline_transform: &Arc<Mutex<TimelineTransform>>,
    timeline_segments: &Arc<Mutex<Vec<TimelineSegment>>>,
) -> bool {
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
    let target_local = map_room_to_local_piecewise(room_pos, tx, &segs);

    let snap = mpv.snapshot();
    let seek_thr = drift_ctrl.seek_threshold_secs(clock.jitter_ms() / 1000.0);
    let action = compute_playback_action(state, target_local, snap.position, snap.paused, seek_thr);

    if let Some(paused) = action.set_pause {
        if !mpv.note_paused(paused) {
            let req = mpv.next_request_id();
            let _ = mpv.send_command(set_pause_cmd(req, paused));
            let _ = app.emit("mpv://paused", serde_json::json!({ "paused": paused }));
        }
    }

    if let Some(seek_base) = action.seek_to {
        let lead = if state.paused {
            0.0
        } else {
            mpv.seek_lead_secs()
        };
        let _ = mpv.dispatch_seek((seek_base + lead).max(0.0), false, None);
        return true;
    }
    false
}

fn apply_welcome_playback_state(
    app: &AppHandle,
    mpv: &Arc<MpvController>,
    state: &CloudPlaybackState,
    clock: &ClockSyncEstimator,
    timeline_transform: &Arc<Mutex<TimelineTransform>>,
    timeline_segments: &Arc<Mutex<Vec<TimelineSegment>>>,
    is_reconnect: bool,
) -> bool {
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
    let target_local = map_room_to_local_piecewise(room_pos, tx, &segs);

    let snap = mpv.snapshot();
    let action = compute_welcome_playback_action(
        state,
        target_local,
        snap.position,
        snap.paused,
        is_reconnect,
    );

    if let Some(paused) = action.set_pause {
        if !mpv.note_paused(paused) {
            let req = mpv.next_request_id();
            let _ = mpv.send_command(set_pause_cmd(req, paused));
            let _ = app.emit("mpv://paused", serde_json::json!({ "paused": paused }));
        }
    }

    if let Some(seek_base) = action.seek_to {
        let lead = if state.paused {
            0.0
        } else {
            mpv.seek_lead_secs()
        };
        let _ = mpv.dispatch_seek((seek_base + lead).max(0.0), false, None);
        return true;
    }
    false
}

/// Fast batched HTTPS `/peek` for Cloudflare endpoints (replaces `__ep_peek_` ghost TCP joins).
pub async fn probe_cloud_rooms(
    endpoint: &str,
    targets: &[(String, String, String)],
    checked_at: u64,
) -> Vec<RoomOccupancyDto> {
    let empty_all = || {
        targets
            .iter()
            .map(|(id, _, _)| RoomOccupancyDto {
                id: id.clone(),
                ok: false,
                online_count: 0,
                usernames_preview: Vec::new(),
                active_media_hint: None,
                checked_at,
            })
            .collect::<Vec<_>>()
    };

    let Some((is_tls, host, port)) = parse_endpoint_host_port(&build_cloud_http_base(endpoint))
    else {
        return empty_all();
    };

    const MAX_PEEK_RESPONSE_BYTES: usize = 64 * 1024;
    let wire_rooms: Vec<String> = targets.iter().map(|(_, w, _)| w.clone()).collect();
    let proofs: Vec<String> = targets
        .iter()
        .map(|(_, w, secret)| peek_proof_for_room(w, secret))
        .collect();
    let path = build_cloud_peek_path_with_proofs(&wire_rooms, &proofs);
    let http_req = format!(
        "GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: EpilodParty/1\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );

    let body_res = tokio::time::timeout(Duration::from_secs(5), async {
        let tcp = TcpStream::connect((host.as_str(), port)).await.ok()?;
        let _ = tcp.set_nodelay(true);
        let mut buf = Vec::with_capacity(4096);
        if is_tls {
            let connector = shared_tls_connector()?;
            let mut tls = connector.connect(&host, tcp).await.ok()?;
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
        .map(|(id, wire_room, _)| {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outbox_coalesces_playback_and_caps_chats() {
        let mut ob = CloudOutbox::default();
        assert!(ob.is_empty());

        ob.push(SyncCommand::UserPlay(10.0));
        ob.push(SyncCommand::UserSeek(25.0));
        ob.push(SyncCommand::UserPause(26.0));
        assert!(matches!(ob.playback, Some(OutboxPlayback::Pause(p)) if (p - 26.0).abs() < 1e-6));
        assert_eq!(ob.latest_seek, Some(25.0));

        for i in 0..25 {
            ob.push(SyncCommand::SendChat {
                id: format!("m{i}"),
                text: "hi".into(),
                avatar_id: "1".into(),
                reply_to_id: None,
            });
        }
        assert_eq!(ob.chats.len(), 20);
    }
}
