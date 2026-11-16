#![cfg(windows)]

use crate::mpv::MpvController;
use crate::p2p::{P2pAutoAlignment, P2pControlCmd, P2pLocalMedia, P2pSessionHandle};
use epilod_core::matching::{analyze_files, FileIdentity, FileMatchStatus, SourceRelation};
use epilod_core::mpv_ipc::{set_pause_cmd, set_speed_cmd};
use epilod_core::p2p::{
    decode_epr_reaction, encode_epr_reaction, ReactionFallbackPacket, EP2_CHAT_PREFIX,
    EP_REACTION_CHAT_PREFIX, MAX_REACTION_BURST_COUNT,
};
use epilod_core::room_code::resolve_syncplay_room;
use epilod_core::room_control::{
    PersistedHostAuthority, RoomControlChatOutcome, RoomControlSession, RoomControlSummary,
    EPC_CHAT_PREFIX, EPC_QUERY_MSG,
};
use epilod_core::syncplay::{
    encode_chat, encode_hello, encode_set_file, encode_set_ready, encode_start_tls_send,
    extract_tls_server_name, hash_filename, hash_filesize, parse_server_line, PlayerSnapshot,
    ReconnectPolicy, RoomParticipantUpdate, ServerMessage, SetUpdate, SyncAction, SyncStateMachine,
    TimelineSegment, TimelineTransform, MAX_WIRE_LINE_BYTES,
};
use epilod_core::validation::{validate_endpoint, LocalPathOptions};
use native_tls::TlsConnector as NativeTlsConnector;
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;
use tokio_native_tls::TlsConnector;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParticipantDto {
    pub username: String,
    pub room: String,
    pub position: f64,
    pub file_name: Option<String>,
    pub file_duration: Option<f64>,
    pub is_ready: bool,
    pub is_controller: bool,
    pub is_host: bool,
    pub is_admin: bool,
    pub file_match: FileMatchStatus,
    pub source_relation: SourceRelation,
    pub duration_delta_secs: Option<f64>,
    pub suggested_fps_scale: Option<f64>,
    pub suggested_fps_label: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LocalFileMeta {
    pub name: String,
    pub size_bytes: Option<u64>,
    pub duration_secs: f64,
    pub hash_identity: bool,
}

pub enum SyncCommand {
    SetFile(Option<LocalFileMeta>),
    SetReady {
        is_ready: bool,
        manual: bool,
    },
    UserPlay(f64),
    UserPause(f64),
    UserSeek(f64),
    ResetForNewFile,
    ForceResync,
    SetScrubbing(bool),
    SetTimelineTransform(TimelineTransform),
    NudgeTimelineOffset(f64),
    SetAlignMode(bool),
    AlignSceneHere {
        local_pos_secs: Option<f64>,
        reply: oneshot::Sender<TimelineTransform>,
    },
    TriggerP2pRealign {
        force: bool,
    },
    SetAdmin {
        username: String,
        grant: bool,
        reply: oneshot::Sender<Result<(), String>>,
    },
    ReleaseHostControlOnLeave {
        reply: oneshot::Sender<()>,
    },
    SendReaction {
        emoji: String,
        avatar_id: String,
        count: u8,
    },
    ManualRetry,
}

struct SyncSessionConfig {
    endpoint: String,
    username: String,
    wire_room: String,
    password: Option<String>,
    host_only: bool,
    network_opts: LocalPathOptions,
}

struct SyncRuntime {
    tx: mpsc::Sender<SyncCommand>,
    task: JoinHandle<()>,
    config: SyncSessionConfig,
}

#[derive(Default)]
pub struct SyncController {
    runtime: Mutex<Option<SyncRuntime>>,
    local_file: Arc<Mutex<Option<LocalFileMeta>>>,
    local_media_path: Arc<Mutex<Option<PathBuf>>>,
    local_ready: Arc<Mutex<bool>>,
    timeline_transform: Arc<Mutex<TimelineTransform>>,
    timeline_segments: Arc<Mutex<Vec<TimelineSegment>>>,
    has_user_alignment: Arc<Mutex<bool>>,
    align_mode: Arc<Mutex<bool>>,
    network_opts: Arc<Mutex<LocalPathOptions>>,
    persisted_host: Arc<Mutex<Option<PersistedHostAuthority>>>,
}

impl SyncController {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn connect(
        &self,
        app: AppHandle,
        mpv: Arc<MpvController>,
        endpoint: String,
        username: String,
        room_input: String,
        literal_room: bool,
        password: Option<String>,
        host_only: bool,
        network_opts: LocalPathOptions,
    ) -> Result<(), String> {
        let valid_endpoint = validate_endpoint(&endpoint).map_err(|e| e.to_string())?;
        let wire_room =
            resolve_syncplay_room(&room_input, literal_room).map_err(|e| e.to_string())?;
        if let Ok(mut guard) = self.network_opts.lock() {
            *guard = network_opts;
        }
        if let Ok(mut guard) = self.persisted_host.lock() {
            if !host_only || guard.as_ref().is_some_and(|p| p.wire_room != wire_room) {
                *guard = None;
            }
        }

        self.disconnect_internal().await;
        let _ = app.emit("sync://participants", Vec::<serde_json::Value>::new());
        let _ = app.emit(
            "sync://room-control",
            RoomControlSummary {
                host_control_active: host_only,
                local_is_host: host_only,
                local_is_admin: false,
                host_username: host_only.then(|| username.clone()),
                admin_usernames: Vec::new(),
            },
        );
        let _ = app.emit(
            "sync://status",
            serde_json::json!({ "state": "disconnected" }),
        );

        let (tx, rx) = mpsc::channel::<SyncCommand>(64);
        let cfg = SyncSessionConfig {
            endpoint: valid_endpoint.clone(),
            username: username.clone(),
            wire_room: wire_room.clone(),
            password: password.clone(),
            host_only,
            network_opts,
        };
        let local_file = Arc::clone(&self.local_file);
        let local_media_path = Arc::clone(&self.local_media_path);
        let local_ready = Arc::clone(&self.local_ready);
        let timeline_transform = Arc::clone(&self.timeline_transform);
        let timeline_segments = Arc::clone(&self.timeline_segments);
        let has_user_alignment = Arc::clone(&self.has_user_alignment);
        let align_mode = Arc::clone(&self.align_mode);
        let persisted_host = Arc::clone(&self.persisted_host);

        let task = tokio::spawn(async move {
            run_sync_loop(
                app,
                mpv,
                valid_endpoint,
                username,
                wire_room,
                password,
                host_only,
                network_opts,
                rx,
                local_file,
                local_media_path,
                local_ready,
                timeline_transform,
                timeline_segments,
                has_user_alignment,
                align_mode,
                persisted_host,
            )
            .await;
        });

        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| "Sync state lock poisoned".to_string())?;
        *guard = Some(SyncRuntime {
            tx,
            task,
            config: cfg,
        });
        Ok(())
    }

    pub async fn reconnect(&self, app: AppHandle, mpv: Arc<MpvController>) -> Result<(), String> {
        let existing_tx = {
            let guard = self
                .runtime
                .lock()
                .map_err(|_| "Sync state lock poisoned".to_string())?;
            guard.as_ref().map(|rt| {
                (
                    rt.tx.clone(),
                    rt.task.is_finished(),
                    rt.config.endpoint.clone(),
                    rt.config.username.clone(),
                    rt.config.wire_room.clone(),
                    rt.config.password.clone(),
                    rt.config.host_only,
                    rt.config.network_opts,
                )
            })
        };

        let Some((tx, finished, endpoint, username, wire_room, password, host_only, network_opts)) =
            existing_tx
        else {
            return Err("No active room session to retry.".to_string());
        };

        if !finished && tx.send(SyncCommand::ManualRetry).await.is_ok() {
            return Ok(());
        }

        // Loop had exited or channel closed — respawn cleanly with same session config
        self.disconnect_internal().await;
        let (new_tx, rx) = mpsc::channel::<SyncCommand>(64);
        let cfg = SyncSessionConfig {
            endpoint: endpoint.clone(),
            username: username.clone(),
            wire_room: wire_room.clone(),
            password: password.clone(),
            host_only,
            network_opts,
        };
        let local_file = Arc::clone(&self.local_file);
        let local_media_path = Arc::clone(&self.local_media_path);
        let local_ready = Arc::clone(&self.local_ready);
        let timeline_transform = Arc::clone(&self.timeline_transform);
        let timeline_segments = Arc::clone(&self.timeline_segments);
        let has_user_alignment = Arc::clone(&self.has_user_alignment);
        let align_mode = Arc::clone(&self.align_mode);
        let persisted_host = Arc::clone(&self.persisted_host);
        let task = tokio::spawn(async move {
            run_sync_loop(
                app,
                mpv,
                endpoint,
                username,
                wire_room,
                password,
                host_only,
                network_opts,
                rx,
                local_file,
                local_media_path,
                local_ready,
                timeline_transform,
                timeline_segments,
                has_user_alignment,
                align_mode,
                persisted_host,
            )
            .await;
        });
        let mut guard = self
            .runtime
            .lock()
            .map_err(|_| "Sync state lock poisoned".to_string())?;
        *guard = Some(SyncRuntime {
            tx: new_tx,
            task,
            config: cfg,
        });
        Ok(())
    }

    pub async fn force_resync(
        &self,
        app: AppHandle,
        mpv: Arc<MpvController>,
    ) -> Result<(), String> {
        let existing_tx = {
            let guard = self
                .runtime
                .lock()
                .map_err(|_| "Sync state lock poisoned".to_string())?;
            guard
                .as_ref()
                .map(|rt| (rt.tx.clone(), rt.task.is_finished()))
        };

        if let Some((tx, finished)) = existing_tx {
            if !finished && tx.send(SyncCommand::ForceResync).await.is_ok() {
                return Ok(());
            }
        }

        self.reconnect(app, mpv).await
    }

    pub async fn disconnect(&self) {
        let active_tx = {
            if let Ok(guard) = self.runtime.lock() {
                guard
                    .as_ref()
                    .filter(|rt| !rt.task.is_finished())
                    .map(|rt| rt.tx.clone())
            } else {
                None
            }
        };
        if let Some(tx) = active_tx {
            let (reply_tx, reply_rx) = oneshot::channel();
            if tx
                .send(SyncCommand::ReleaseHostControlOnLeave { reply: reply_tx })
                .await
                .is_ok()
            {
                let _ = tokio::time::timeout(Duration::from_millis(250), reply_rx).await;
            }
        }
        self.disconnect_internal().await;
        if let Ok(mut ph) = self.persisted_host.lock() {
            *ph = None;
        }
        if let Ok(mut f) = self.local_file.lock() {
            *f = None;
        }
        if let Ok(mut p) = self.local_media_path.lock() {
            *p = None;
        }
        if let Ok(mut r) = self.local_ready.lock() {
            *r = false;
        }
        if let Ok(mut tx) = self.timeline_transform.lock() {
            *tx = TimelineTransform::default();
        }
        if let Ok(mut segs) = self.timeline_segments.lock() {
            segs.clear();
        }
        if let Ok(mut ua) = self.has_user_alignment.lock() {
            *ua = false;
        }
        if let Ok(mut am) = self.align_mode.lock() {
            *am = false;
        }
    }

    pub async fn set_room_admin(&self, username: String, grant: bool) -> Result<(), String> {
        let sender = {
            let guard = self
                .runtime
                .lock()
                .map_err(|_| "Sync state lock poisoned".to_string())?;
            guard
                .as_ref()
                .filter(|rt| !rt.task.is_finished())
                .map(|rt| rt.tx.clone())
        }
        .ok_or_else(|| "Not connected to a Watch Party room.".to_string())?;
        let (reply_tx, reply_rx) = oneshot::channel();
        sender
            .send(SyncCommand::SetAdmin {
                username,
                grant,
                reply: reply_tx,
            })
            .await
            .map_err(|_| "Sync session is not active.".to_string())?;
        tokio::time::timeout(Duration::from_secs(2), reply_rx)
            .await
            .map_err(|_| "Timed out updating room admin.".to_string())?
            .map_err(|_| "Room control channel closed.".to_string())?
    }

    async fn disconnect_internal(&self) {
        let taken = {
            if let Ok(mut guard) = self.runtime.lock() {
                guard.take()
            } else {
                None
            }
        };
        if let Some(rt) = taken {
            rt.task.abort();
            let _ = rt.task.await;
        }
    }

    pub fn set_local_media_path(&self, path: Option<PathBuf>) {
        if let Ok(mut guard) = self.local_media_path.lock() {
            *guard = path;
        }
    }

    pub fn set_local_file(&self, file: Option<LocalFileMeta>) {
        if let Ok(mut guard) = self.local_file.lock() {
            *guard = file.clone();
        }
        self.try_send(SyncCommand::SetFile(file));
    }

    pub fn set_local_ready(&self, is_ready: bool, manual: bool) {
        if let Ok(mut guard) = self.local_ready.lock() {
            *guard = is_ready;
        }
        self.try_send(SyncCommand::SetReady { is_ready, manual });
    }

    pub fn reset_for_new_file(&self) {
        if let Ok(mut guard) = self.local_file.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.local_media_path.lock() {
            *guard = None;
        }
        if let Ok(mut guard) = self.local_ready.lock() {
            *guard = false;
        }
        if let Ok(mut guard) = self.timeline_transform.lock() {
            *guard = TimelineTransform::default();
        }
        if let Ok(mut guard) = self.timeline_segments.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.has_user_alignment.lock() {
            *guard = false;
        }
        if let Ok(mut guard) = self.align_mode.lock() {
            *guard = false;
        }
        self.try_send(SyncCommand::ResetForNewFile);
    }

    pub fn set_scrubbing(&self, scrubbing: bool) {
        self.try_send(SyncCommand::SetScrubbing(scrubbing));
    }

    pub fn set_timeline_transform(&self, app: &AppHandle, transform: TimelineTransform) {
        let clean = transform.sanitized();
        if let Ok(mut guard) = self.timeline_transform.lock() {
            *guard = clean;
        }
        if let Ok(mut guard) = self.timeline_segments.lock() {
            guard.clear();
        }
        if let Ok(mut guard) = self.has_user_alignment.lock() {
            *guard = !clean.is_identity();
        }
        let _ = app.emit("sync://timeline-transform", clean);
        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
        self.try_send(SyncCommand::SetTimelineTransform(clean));
    }

    pub fn trigger_p2p_realign(&self, force: bool) {
        if force {
            if let Ok(mut guard) = self.has_user_alignment.lock() {
                *guard = false;
            }
        }
        self.try_send(SyncCommand::TriggerP2pRealign { force });
    }

    pub fn nudge_timeline_offset(&self, delta_secs: f64) {
        if !delta_secs.is_finite() {
            return;
        }
        self.try_send(SyncCommand::NudgeTimelineOffset(delta_secs));
    }

    pub fn set_align_mode(&self, enabled: bool) {
        if let Ok(mut guard) = self.align_mode.lock() {
            *guard = enabled;
        }
        self.try_send(SyncCommand::SetAlignMode(enabled));
    }

    pub async fn align_scene_here(
        &self,
        local_pos_secs: Option<f64>,
    ) -> Result<TimelineTransform, String> {
        let tx = {
            let guard = self
                .runtime
                .lock()
                .map_err(|_| "Sync state lock poisoned".to_string())?;
            guard
                .as_ref()
                .filter(|rt| !rt.task.is_finished())
                .map(|rt| rt.tx.clone())
        };
        let Some(sender) = tx else {
            return Err("Not connected to a Watch Party room.".to_string());
        };
        let (reply_tx, reply_rx) = oneshot::channel();
        sender
            .send(SyncCommand::AlignSceneHere {
                local_pos_secs,
                reply: reply_tx,
            })
            .await
            .map_err(|_| "Sync session is not active.".to_string())?;
        tokio::time::timeout(Duration::from_secs(2), reply_rx)
            .await
            .map_err(|_| "Timed out capturing scene alignment.".to_string())?
            .map_err(|_| "Alignment channel closed.".to_string())
    }

    pub fn send_reaction(&self, emoji: String, avatar_id: String, count: u8) {
        self.try_send(SyncCommand::SendReaction {
            emoji,
            avatar_id,
            count,
        });
    }

    pub fn send_command(&self, cmd: SyncCommand) {
        self.try_send(cmd);
    }

    fn try_send(&self, cmd: SyncCommand) {
        if let Ok(guard) = self.runtime.lock() {
            if let Some(ref rt) = *guard {
                let _ = rt.tx.try_send(cmd);
            }
        }
    }
}

/// Zero-overread line reader over raw TcpStream before upgrading to TLS.
async fn read_unbuffered_line_async(stream: &mut TcpStream) -> Result<String, String> {
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        let n = stream
            .read(&mut byte)
            .await
            .map_err(|e| format!("Network read failed during TLS handshake: {e}"))?;
        if n == 0 {
            return Err(
                "Syncplay server closed connection before completing handshake.".to_string(),
            );
        }
        if buf.len() >= MAX_WIRE_LINE_BYTES {
            return Err("Server handshake line exceeded maximum size.".to_string());
        }
        buf.push(byte[0]);
        if byte[0] == b'\n' {
            break;
        }
    }
    String::from_utf8(buf).map_err(|_| "Invalid UTF-8 from Syncplay server.".to_string())
}

enum WireStream {
    Plain(TcpStream),
    Tls(Box<tokio_native_tls::TlsStream<TcpStream>>),
}

async fn establish_connection(endpoint: &str) -> Result<(WireStream, bool), String> {
    let mut tcp = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect(endpoint))
        .await
        .map_err(|_| format!("Timed out connecting to {endpoint}."))?
        .map_err(|e| format!("Could not connect to {endpoint}: {e}"))?;

    let _ = tcp.set_nodelay(true);

    // Probe STARTTLS as used by Syncplay 1.7.0+ (`syncplay.pl:8999`)
    let tls_probe = encode_start_tls_send();
    tcp.write_all(tls_probe.as_bytes())
        .await
        .map_err(|e| format!("Failed sending STARTTLS probe: {e}"))?;

    let probe_reply =
        tokio::time::timeout(Duration::from_secs(6), read_unbuffered_line_async(&mut tcp))
            .await
            .map_err(|_| "Timed out waiting for server TLS response.".to_string())?;

    let use_tls = match probe_reply {
        Ok(line) => match parse_server_line(&line) {
            Ok(ServerMessage::Tls { start_tls }) => start_tls,
            _ => false,
        },
        Err(e) => return Err(e),
    };

    if use_tls {
        let sni = extract_tls_server_name(endpoint);
        let native = NativeTlsConnector::new()
            .map_err(|e| format!("Windows TLS initialization failed: {e}"))?;
        let connector = TlsConnector::from(native);
        let tls_stream =
            tokio::time::timeout(Duration::from_secs(10), connector.connect(&sni, tcp))
                .await
                .map_err(|_| "TLS handshake timed out.".to_string())?
                .map_err(|e| format!("TLS handshake failed for {sni}: {e}"))?;
        Ok((WireStream::Tls(Box::new(tls_stream)), true))
    } else {
        Ok((WireStream::Plain(tcp), false))
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_sync_loop(
    app: AppHandle,
    mpv: Arc<MpvController>,
    endpoint: String,
    username: String,
    wire_room: String,
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
    persisted_host: Arc<Mutex<Option<PersistedHostAuthority>>>,
) {
    let mut policy = ReconnectPolicy::new();

    loop {
        let attempt_num = policy.attempt + 1;
        let _ = app.emit(
            "sync://status",
            serde_json::json!({
                "state": "connecting",
                "endpoint": endpoint,
                "attempt": attempt_num,
            }),
        );

        match establish_connection(&endpoint).await {
            Ok((wire, tls_active)) => {
                policy.on_connected();
                let snapshot = mpv.snapshot();
                let session_res = match wire {
                    WireStream::Plain(tcp) => {
                        let (r, w) = tokio::io::split(tcp);
                        drive_authenticated_session(
                            &app,
                            &mpv,
                            &endpoint,
                            &username,
                            &wire_room,
                            password.as_deref(),
                            host_only,
                            network_opts,
                            tls_active,
                            snapshot,
                            &mut rx,
                            &local_file,
                            &local_media_path,
                            &local_ready,
                            &timeline_transform,
                            &timeline_segments,
                            &has_user_alignment,
                            &align_mode,
                            &persisted_host,
                            r,
                            w,
                        )
                        .await
                    }
                    WireStream::Tls(tls) => {
                        let (r, w) = tokio::io::split(tls);
                        drive_authenticated_session(
                            &app,
                            &mpv,
                            &endpoint,
                            &username,
                            &wire_room,
                            password.as_deref(),
                            host_only,
                            network_opts,
                            tls_active,
                            snapshot,
                            &mut rx,
                            &local_file,
                            &local_media_path,
                            &local_ready,
                            &timeline_transform,
                            &timeline_segments,
                            &has_user_alignment,
                            &align_mode,
                            &persisted_host,
                            r,
                            w,
                        )
                        .await
                    }
                };

                if let Err(err_msg) = session_res {
                    let _ = app.emit("sync://error", serde_json::json!({ "message": err_msg }));
                }
            }
            Err(err_msg) => {
                let _ = app.emit("sync://error", serde_json::json!({ "message": err_msg }));
            }
        }

        // Schedule reconnect or enter circuit_open error state until ManualRetry
        if let Some(delay_secs) = policy.next_delay_secs() {
            let _ = app.emit(
                "sync://status",
                serde_json::json!({
                    "state": "reconnecting",
                    "endpoint": endpoint,
                    "attempt": policy.attempt,
                    "retryInSecs": delay_secs,
                    "suggestBackup": policy.suggest_backup(),
                }),
            );
            let sleep = tokio::time::sleep(Duration::from_secs(delay_secs));
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    cmd = rx.recv() => match cmd {
                        None => return,
                        Some(SyncCommand::ManualRetry | SyncCommand::ForceResync) => {
                            policy.manual_retry();
                            break;
                        }
                        Some(_) => {}
                    }
                }
            }
        } else {
            let _ = app.emit(
                "sync://status",
                serde_json::json!({
                    "state": "error",
                    "endpoint": endpoint,
                    "message": "Could not reach Syncplay server after repeated attempts.",
                    "suggestBackup": true,
                    "circuitOpen": true,
                }),
            );
            loop {
                match rx.recv().await {
                    None => return,
                    Some(SyncCommand::ManualRetry | SyncCommand::ForceResync) => {
                        policy.manual_retry();
                        break;
                    }
                    Some(_) => {}
                }
            }
        }
    }
}

fn apply_sync_actions(
    app: &AppHandle,
    mpv: &MpvController,
    actions: Vec<SyncAction>,
    is_scrubbing: bool,
) {
    for act in actions {
        match act {
            SyncAction::ServerOverride { set_by } => {
                let _ = app.emit(
                    "sync://server-override",
                    serde_json::json!({ "setBy": set_by }),
                );
            }
            SyncAction::SetPaused(p) => {
                if !mpv.note_paused(p) {
                    let req = mpv.next_request_id();
                    let _ = mpv.send_command(set_pause_cmd(req, p));
                    let _ = app.emit("mpv://paused", serde_json::json!({ "paused": p }));
                }
            }
            SyncAction::Seek(pos) => {
                if !is_scrubbing {
                    let _ = mpv.dispatch_seek(pos, false, None);
                }
            }
            SyncAction::SetSpeed(spd) => {
                if !is_scrubbing {
                    let req = mpv.next_request_id();
                    let _ = mpv.send_command(set_speed_cmd(req, spd));
                }
            }
        }
    }
}

fn build_local_file_identity(
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
) -> Option<FileIdentity> {
    local_file
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .map(|f| FileIdentity {
            name: if f.hash_identity {
                hash_filename(&f.name)
            } else {
                f.name
            },
            size_bytes: f.size_bytes,
            size_hash: f
                .hash_identity
                .then(|| f.size_bytes.map(hash_filesize))
                .flatten(),
            duration_secs: (f.duration_secs > 0.0).then_some(f.duration_secs),
            is_hashed: f.hash_identity,
        })
}

fn build_peer_file_identity(pf: &epilod_core::syncplay::WireFileInfo) -> FileIdentity {
    let peer_name_hashed = pf.size_hash.is_some()
        || (pf.name.len() == 12 && pf.name.bytes().all(|b| b.is_ascii_hexdigit()));
    FileIdentity {
        name: pf.name.clone(),
        size_bytes: pf.size,
        size_hash: pf.size_hash.clone(),
        duration_secs: pf.duration.filter(|d| *d > 0.0),
        is_hashed: peer_name_hashed,
    }
}

fn is_peer_compatible_for_sync(
    local_id: Option<&FileIdentity>,
    peer: &RoomParticipantUpdate,
) -> bool {
    let Some(pf) = peer.file.as_ref() else {
        return false;
    };
    let peer_id = build_peer_file_identity(pf);
    let cmp = analyze_files(local_id, Some(&peer_id));
    matches!(
        cmp.status,
        FileMatchStatus::Matched | FileMatchStatus::SameLengthDifferentEncode
    ) || (cmp.status == FileMatchStatus::DurationMismatch
        && cmp.source_relation != SourceRelation::DifferentMedia)
}

fn summarize_peer_compatibility(
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
) -> (bool, bool) {
    let local_id = build_local_file_identity(local_file);
    let mut any_peer_has_file = false;
    let mut compatible_peer_exists = false;
    for peer in participants.values() {
        if peer.username.eq_ignore_ascii_case(active_username) || peer.file.is_none() {
            continue;
        }
        any_peer_has_file = true;
        if local_id.is_some() && is_peer_compatible_for_sync(local_id.as_ref(), peer) {
            compatible_peer_exists = true;
            break;
        }
    }
    (any_peer_has_file, compatible_peer_exists)
}

fn seed_server_playstate_from_compatible_peer_if_missing(
    sm: &mut SyncStateMachine,
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    room_control: &RoomControlSession,
    now_secs: f64,
) {
    if sm.last_server_playstate.is_some() {
        return;
    }
    let local_id = build_local_file_identity(local_file);
    let Some(li) = local_id.as_ref() else {
        return;
    };
    if let Some(peer) = participants
        .values()
        .find(|p| {
            !p.username.eq_ignore_ascii_case(active_username)
                && is_peer_effective_controller(p, room_control)
                && is_peer_compatible_for_sync(Some(li), p)
        })
        .or_else(|| {
            participants.values().find(|p| {
                !p.username.eq_ignore_ascii_case(active_username)
                    && is_peer_compatible_for_sync(Some(li), p)
            })
        })
    {
        sm.last_server_playstate = Some(epilod_core::syncplay::Playstate {
            position: peer.position,
            paused: peer.paused,
            do_seek: true,
            set_by: Some(peer.username.clone()),
        });
        sm.last_server_state_at = Some(now_secs);
    }
}

fn seed_server_playstate_from_peers_if_missing(
    sm: &mut SyncStateMachine,
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
    room_control: &RoomControlSession,
    now_secs: f64,
) {
    if sm.last_server_playstate.is_some() {
        return;
    }
    if let Some(peer) = participants
        .values()
        .find(|p| p.username != active_username && is_peer_effective_controller(p, room_control))
        .or_else(|| {
            participants
                .values()
                .find(|p| p.username != active_username)
        })
    {
        sm.last_server_playstate = Some(epilod_core::syncplay::Playstate {
            position: peer.position,
            paused: peer.paused,
            do_seek: true,
            set_by: Some(peer.username.clone()),
        });
        sm.last_server_state_at = Some(now_secs);
    }
}

fn emit_room_state(app: &AppHandle, sm: &SyncStateMachine, now_secs: f64) {
    let paused = sm
        .last_server_playstate
        .as_ref()
        .map(|ps| ps.paused)
        .unwrap_or(sm.local_paused);
    let _ = app.emit(
        "sync://room-state",
        serde_json::json!({
            "position": sm.estimated_room_position(now_secs),
            "paused": paused,
        }),
    );
}

fn build_p2p_media_snapshot(
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    local_media_path: &Arc<Mutex<Option<PathBuf>>>,
    has_user_alignment: &Arc<Mutex<bool>>,
) -> Option<P2pLocalMedia> {
    let f = local_file.lock().ok().and_then(|g| g.clone())?;
    let path = local_media_path.lock().ok().and_then(|g| g.clone());
    let has_user = has_user_alignment.lock().map(|g| *g).unwrap_or(false);
    let file_sig = format!(
        "{}|{}|{:.3}",
        f.name,
        f.size_bytes.unwrap_or(0),
        f.duration_secs
    );
    let identity = FileIdentity {
        name: f.name,
        size_bytes: f.size_bytes,
        size_hash: None,
        duration_secs: (f.duration_secs > 0.0).then_some(f.duration_secs),
        is_hashed: false,
    };
    Some(P2pLocalMedia {
        file_sig,
        identity,
        path,
        has_user_alignment: has_user,
    })
}

#[allow(clippy::too_many_arguments)]
async fn drive_authenticated_session<R, W>(
    app: &AppHandle,
    mpv: &Arc<MpvController>,
    endpoint: &str,
    username: &str,
    wire_room: &str,
    password: Option<&str>,
    host_only: bool,
    network_opts: LocalPathOptions,
    tls_active: bool,
    initial_snapshot: PlayerSnapshot,
    rx: &mut mpsc::Receiver<SyncCommand>,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    local_media_path: &Arc<Mutex<Option<PathBuf>>>,
    local_ready: &Arc<Mutex<bool>>,
    timeline_transform: &Arc<Mutex<TimelineTransform>>,
    timeline_segments: &Arc<Mutex<Vec<TimelineSegment>>>,
    has_user_alignment: &Arc<Mutex<bool>>,
    align_mode: &Arc<Mutex<bool>>,
    persisted_host: &Arc<Mutex<Option<PersistedHostAuthority>>>,
    reader: R,
    mut writer: W,
) -> Result<(), String>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let hello = encode_hello(username, wire_room, password);
    writer
        .write_all(hello.as_bytes())
        .await
        .map_err(|e| format!("Failed sending Hello handshake: {e}"))?;

    let start_instant = Instant::now();
    let mut sm = SyncStateMachine::with_initial_state(initial_snapshot);
    if let Ok(guard) = timeline_segments.lock() {
        if guard.len() > 1 {
            sm.segments = guard.clone();
            sm.transform = guard[0].to_transform();
        }
    }
    if sm.segments.is_empty() {
        if let Ok(guard) = timeline_transform.lock() {
            sm.transform = guard.sanitized();
        }
    }
    if let Ok(guard) = align_mode.lock() {
        sm.align_mode = *guard;
    }
    let mut active_username = username.to_string();
    let mut room_control = if host_only {
        let cached = persisted_host.lock().ok().and_then(|g| g.clone());
        let sess = RoomControlSession::new_host(wire_room, &active_username, cached.as_ref());
        if let Ok(mut guard) = persisted_host.lock() {
            *guard = sess.export_persisted_host();
        }
        sess
    } else {
        RoomControlSession::new_guest(wire_room, &active_username)
    };
    let mut participants: HashMap<String, RoomParticipantUpdate> = HashMap::new();
    let mut manually_not_ready = false;
    let mut manually_not_ready_peers: HashSet<String> = HashSet::new();
    let mut lines = BufReader::new(reader).lines();
    let mut connected_emitted = false;
    let mut is_scrubbing = false;
    let mut ctrl_broadcast_dirty = false;
    let mut last_ctrl_broadcast_at: Option<Instant> = None;
    let mut sent_ctrl_query = false;
    let mut no_controller_since: Option<Instant> = None;
    let mut authoritative_playstate: Option<(f64, bool, Instant)> = None;
    let mut last_pushback_at: Option<Instant> = None;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut epr_flush_tick = tokio::time::interval(Duration::from_millis(320));
    epr_flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut pending_epr_bursts: VecDeque<ReactionFallbackPacket> = VecDeque::new();
    let mut peer_epr_rx_window: HashMap<String, (Instant, u32)> = HashMap::new();

    let (p2p_beacon_tx, mut p2p_beacon_rx) = mpsc::channel::<String>(16);
    let (p2p_align_tx, mut p2p_align_rx) = mpsc::channel::<P2pAutoAlignment>(8);
    let (p2p_reaction_fallback_tx, mut p2p_reaction_fallback_rx) =
        mpsc::channel::<ReactionFallbackPacket>(64);
    let p2p = P2pSessionHandle::spawn(
        app.clone(),
        username.to_string(),
        network_opts,
        p2p_beacon_tx,
        p2p_align_tx,
        p2p_reaction_fallback_tx,
    );

    let result: Result<(), String> = loop {
        tokio::select! {
            maybe_line = lines.next_line() => {
                let line = match maybe_line {
                    Ok(Some(l)) => l,
                    Ok(None) => break Err("Syncplay connection closed by server.".to_string()),
                    Err(e) => break Err(format!("Syncplay network read error: {e}")),
                };

                match parse_server_line(&line) {
                    Ok(ServerMessage::Hello { username: assigned, .. }) => {
                        if !assigned.is_empty() {
                            active_username = assigned;
                        }
                        sm.set_local_username(active_username.clone());
                        p2p.try_send(P2pControlCmd::UpdateLocalUsername(active_username.clone()));
                        let host_name_changed = room_control.update_local_username(&active_username);
                        if host_name_changed {
                            if let Ok(mut guard) = persisted_host.lock() {
                                *guard = room_control.export_persisted_host();
                            }
                        }
                        emit_room_control(app, &room_control);
                        if room_control.is_local_host() {
                            ctrl_broadcast_dirty = true;
                        }
                        connected_emitted = true;

                        let _ = app.emit(
                            "sync://status",
                            serde_json::json!({
                                "state": "connected",
                                "endpoint": endpoint,
                                "tls": tls_active,
                                "username": active_username,
                            }),
                        );

                        // Fix 08: Emit initial file and readiness accurately on connect / reconnect
                        let current_file = local_file.lock().ok().and_then(|g| g.clone());
                        if current_file.is_some() {
                            if let Ok(mut guard) = local_ready.lock() {
                                *guard = true;
                            }
                        }
                        if let Some(ref f) = current_file {
                            sm.set_local_duration(Some(f.duration_secs));
                            let file_msg = encode_set_file(
                                &f.name,
                                f.size_bytes,
                                f.duration_secs,
                                f.hash_identity,
                            );
                            let _ = writer.write_all(file_msg.as_bytes()).await;
                        }
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_media_snapshot(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));

                        let is_ready = local_ready.lock().map(|g| *g).unwrap_or(false);
                        let ready_msg = encode_set_ready(is_ready, false);
                        let _ = writer.write_all(ready_msg.as_bytes()).await;

                        let snap = mpv.snapshot();
                        if !snap.paused {
                            if let Ok(mut guard) = local_ready.lock() {
                                *guard = true;
                            }
                            let ready_true = encode_set_ready(true, false);
                            let _ = writer.write_all(ready_true.as_bytes()).await;
                            sm.on_user_play(snap.position);
                            if snap.position > 0.5 {
                                sm.on_user_seek(snap.position);
                            }
                            let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                            let _ = writer.write_all(hb.as_bytes()).await;
                        }

                        let list_req = "{\"List\":null}\r\n";
                        let _ = writer.write_all(list_req.as_bytes()).await;
                    }
                    Ok(ServerMessage::List(items)) => {
                        participants.clear();
                        for item in items {
                            participants.insert(item.username.clone(), item);
                        }
                        manually_not_ready_peers.retain(|name| {
                            participants.values().any(|p| {
                                p.username.eq_ignore_ascii_case(name) && p.is_ready != Some(true)
                            })
                        });
                        publish_participants(app, &participants, local_file, &room_control, &p2p);
                        update_no_controller_timer(&participants, &room_control, &mut no_controller_since);
                        if room_control.is_local_host() && participants.len() > 1 {
                            ctrl_broadcast_dirty = true;
                            if flush_host_control_broadcast(
                                &mut writer,
                                &mut room_control,
                                &participants,
                                &mut ctrl_broadcast_dirty,
                                &mut last_ctrl_broadcast_at,
                            )
                            .await
                            .is_err()
                            {
                                break Err("Failed sending room control state.".to_string());
                            }
                        } else if !room_control.is_local_host()
                            && !room_control.is_locked()
                            && !sent_ctrl_query
                            && participants.len() > 1
                        {
                            sent_ctrl_query = true;
                            let wire = encode_chat(EPC_QUERY_MSG);
                            if writer.write_all(wire.as_bytes()).await.is_err() {
                                break Err("Failed querying room host status.".to_string());
                            }
                        }
                    }
                    Ok(ServerMessage::Set(updates)) => {
                        let mut changed = false;
                        let mut refresh_list = false;
                        let mut peer_not_ready_events: Vec<(String, bool)> = Vec::new();
                        let mut peer_left_events: Vec<String> = Vec::new();
                        let mut left_peers_in_batch: HashSet<String> = HashSet::new();
                        for upd in updates {
                            match upd {
                                SetUpdate::UserJoined { username: u } => {
                                    let key = u.to_ascii_lowercase();
                                    left_peers_in_batch.remove(&key);
                                    peer_left_events.retain(|name| !name.eq_ignore_ascii_case(&u));
                                    upsert_participant_mut(&mut participants, &u, wire_room);
                                    p2p.try_send(P2pControlCmd::PeerJoined(u));
                                    if room_control.is_local_host() {
                                        ctrl_broadcast_dirty = true;
                                    }
                                    changed = true;
                                    refresh_list = true;
                                }
                                SetUpdate::UserLeft { username: u } => {
                                    let is_local = u.eq_ignore_ascii_case(&active_username);
                                    let prev_len = participants.len();
                                    participants.retain(|k, _| !k.eq_ignore_ascii_case(&u));
                                    let was_present = participants.len() != prev_len;
                                    let key = u.to_ascii_lowercase();
                                    manually_not_ready_peers.remove(&key);
                                    if should_notify_peer_left(is_local, was_present) {
                                        left_peers_in_batch.insert(key);
                                        peer_left_events.push(u);
                                    }
                                    if was_present {
                                        changed = true;
                                    }
                                }
                                SetUpdate::Ready {
                                    username: u,
                                    is_ready,
                                    manually_initiated,
                                } => {
                                    let is_local = u.eq_ignore_ascii_case(&active_username);
                                    let was_ready = find_participant_mut(&mut participants, &u)
                                        .and_then(|p| p.is_ready)
                                        .unwrap_or(false);
                                    let entry =
                                        upsert_participant_mut(&mut participants, &u, wire_room);
                                    entry.is_ready = Some(is_ready);
                                    changed = true;

                                    if !is_local {
                                        let key = u.to_ascii_lowercase();
                                        if is_ready {
                                            manually_not_ready_peers.remove(&key);
                                        } else {
                                            if manually_initiated == Some(true) {
                                                manually_not_ready_peers.insert(key);
                                            }
                                            if should_notify_peer_not_ready(
                                                is_local,
                                                is_ready,
                                                manually_initiated,
                                                was_ready,
                                            ) {
                                                peer_not_ready_events.push((
                                                    u,
                                                    manually_initiated.unwrap_or(false),
                                                ));
                                            }
                                        }
                                    }
                                }
                                SetUpdate::File { username: u, file } => {
                                    let entry =
                                        upsert_participant_mut(&mut participants, &u, wire_room);
                                    entry.file = Some(file);
                                    changed = true;
                                }
                                SetUpdate::FileCleared { username: u } => {
                                    if let Some(entry) = find_participant_mut(&mut participants, &u)
                                    {
                                        entry.file = None;
                                        entry.is_ready = Some(false);
                                        changed = true;
                                    }
                                }
                                SetUpdate::ControllerAuth {
                                    username: u,
                                    is_controller,
                                } => {
                                    let entry =
                                        upsert_participant_mut(&mut participants, &u, wire_room);
                                    entry.is_controller = is_controller;
                                    changed = true;
                                }
                            }
                        }
                        if refresh_list {
                            let _ = writer.write_all(b"{\"List\":null}\r\n").await;
                        }
                        if !left_peers_in_batch.is_empty() {
                            peer_not_ready_events.retain(|(name, _)| {
                                !left_peers_in_batch.contains(&name.to_ascii_lowercase())
                            });
                        }
                        if changed {
                            publish_participants(app, &participants, local_file, &room_control, &p2p);
                            update_no_controller_timer(&participants, &room_control, &mut no_controller_since);
                        }
                        if connected_emitted
                            && flush_host_control_broadcast(
                                &mut writer,
                                &mut room_control,
                                &participants,
                                &mut ctrl_broadcast_dirty,
                                &mut last_ctrl_broadcast_at,
                            )
                            .await
                            .is_err()
                        {
                            break Err("Failed sending room control state.".to_string());
                        }
                        for (peer_name, manual) in peer_not_ready_events {
                            let _ = app.emit(
                                "sync://peer-not-ready",
                                serde_json::json!({
                                    "username": peer_name,
                                    "manual": manual,
                                }),
                            );
                        }
                        for peer_name in peer_left_events {
                            let _ = app.emit(
                                "sync://peer-left",
                                serde_json::json!({
                                    "username": peer_name,
                                }),
                            );
                        }
                    }
                    Ok(ServerMessage::State(st)) => {
                        let now_secs = start_instant.elapsed().as_secs_f64();
                        if !is_scrubbing {
                            let snap = mpv.snapshot();
                            sm.update_local_player(snap.position, snap.paused);
                        }
                        let unauthorized_actor = if room_control.is_locked() && participants.len() > 1 {
                            st.playstate.as_ref().and_then(|ps| {
                                let actor = ps.set_by.as_deref()?.trim();
                                let authorized = actor.is_empty()
                                    || actor.eq_ignore_ascii_case(&active_username)
                                    || room_control.is_user_controller(actor)
                                    || participants
                                        .values()
                                        .any(|p| p.username.eq_ignore_ascii_case(actor) && p.is_controller);
                                (!authorized).then(|| actor.to_string())
                            })
                        } else {
                            None
                        };

                        if unauthorized_actor.is_none() {
                            if let Some(ref ps) = st.playstate {
                                let trusted_actor = !room_control.is_locked()
                                    || ps.set_by.as_deref().is_some_and(|actor| {
                                        actor.eq_ignore_ascii_case(&active_username)
                                            || room_control.is_user_controller(actor)
                                            || participants.values().any(|p| {
                                                p.username.eq_ignore_ascii_case(actor) && p.is_controller
                                            })
                                    })
                                    || authoritative_playstate.is_none();
                                if trusted_actor {
                                    authoritative_playstate =
                                        Some((ps.position, ps.paused, Instant::now()));
                                }
                            }
                        } else if let Some(ref actor) = unauthorized_actor {
                            if should_enforce_authoritative_playstate(
                                &participants,
                                &active_username,
                                &room_control,
                            ) {
                                let (auth_pos, auth_paused, auth_at) = authoritative_playstate
                                    .unwrap_or_else(|| (sm.local_pos, sm.local_paused, Instant::now()));
                                if let Some(ref ps) = st.playstate {
                                    let server_forced = st
                                        .ignoring_on_the_fly
                                        .as_ref()
                                        .and_then(|i| i.server)
                                        .is_some();
                                    let projected_room = (auth_pos
                                        + if auth_paused {
                                            0.0
                                        } else {
                                            auth_at.elapsed().as_secs_f64().min(5.0)
                                        })
                                    .max(0.0);
                                    let deviated = server_forced
                                        || ps.paused != auth_paused
                                        || ps.do_seek
                                        || (ps.position - projected_room).abs() > 1.0;
                                    if deviated
                                        && last_pushback_at
                                            .is_none_or(|t| t.elapsed() >= Duration::from_millis(850))
                                    {
                                        last_pushback_at = Some(Instant::now());
                                        let target_local = sm
                                            .active_transform_at(projected_room)
                                            .room_to_local(projected_room, sm.local_duration_secs);
                                        if !mpv.note_paused(auth_paused) {
                                            let req = mpv.next_request_id();
                                            let _ = mpv.send_command(set_pause_cmd(req, auth_paused));
                                            let _ = app.emit(
                                                "mpv://paused",
                                                serde_json::json!({ "paused": auth_paused }),
                                            );
                                        }
                                        if !is_scrubbing {
                                            let _ = mpv.dispatch_seek(target_local, false, None);
                                        }
                                        sm.restore_authoritative_room_playstate(
                                            projected_room,
                                            auth_paused,
                                            target_local,
                                        );
                                        let hb = sm.on_heartbeat_tick(now_secs);
                                        let _ = writer.write_all(hb.as_bytes()).await;
                                        if room_control.is_local_host() {
                                            ctrl_broadcast_dirty = true;
                                            let _ = flush_host_control_broadcast(
                                                &mut writer,
                                                &mut room_control,
                                                &participants,
                                                &mut ctrl_broadcast_dirty,
                                                &mut last_ctrl_broadcast_at,
                                            )
                                            .await;
                                        }
                                        let _ = app.emit(
                                            "sync://control-notice",
                                            serde_json::json!({
                                                "kind": "guestBlocked",
                                                "actor": actor,
                                            }),
                                        );
                                    }
                                }
                            }
                        }

                        let prev_server_paused =
                            sm.last_server_playstate.as_ref().map(|ps| ps.paused);
                        let (any_peer_has_file, compatible_peer_exists) =
                            summarize_peer_compatibility(&participants, &active_username, local_file);
                        let all_peers_incompatible =
                            sm.local_duration_secs.is_some()
                                && any_peer_has_file
                                && !compatible_peer_exists;
                        let suppress_unauth_state = unauthorized_actor.is_some()
                            && (authoritative_playstate.is_some()
                                || should_enforce_authoritative_playstate(
                                    &participants,
                                    &active_username,
                                    &room_control,
                                ));
                        let effective_state = if all_peers_incompatible || suppress_unauth_state {
                            // Ignore peer states from other episodes or unauthorized non-controllers
                            // while still letting ping and ignoring_on_the_fly ACKs progress.
                            epilod_core::syncplay::ServerState {
                                playstate: None,
                                ..st.clone()
                            }
                        } else {
                            st.clone()
                        };
                        let actions = sm.handle_server_state(&effective_state, now_secs);
                        if sm.align_mode {
                            emit_room_state(app, &sm, now_secs);
                        }
                        let server_unpaused = !all_peers_incompatible
                            && !suppress_unauth_state
                            && st.playstate.as_ref().is_some_and(|ps| !ps.paused);
                        let blocking_manual_peers = if server_unpaused && !sm.align_mode {
                            collect_manually_not_ready_peers(
                                &participants,
                                &active_username,
                                &manually_not_ready_peers,
                            )
                        } else {
                            Vec::new()
                        };
                        let block_server_unpause = !sm.align_mode
                            && server_unpaused
                            && (manually_not_ready || !blocking_manual_peers.is_empty());

                        if block_server_unpause {
                            let filtered: Vec<SyncAction> = actions
                                .into_iter()
                                .filter(|a| !matches!(a, SyncAction::SetPaused(false)))
                                .collect();
                            apply_sync_actions(app, mpv, filtered, is_scrubbing);
                            sm.keep_local_paused();

                            if prev_server_paused != Some(false) {
                                if !mpv.note_paused(true) {
                                    let req = mpv.next_request_id();
                                    let _ = mpv.send_command(set_pause_cmd(req, true));
                                    let _ = app
                                        .emit("mpv://paused", serde_json::json!({ "paused": true }));
                                }
                                if !is_effective_controller_locked(
                                    &participants,
                                    &active_username,
                                    &room_control,
                                ) {
                                    let snap = mpv.snapshot();
                                    sm.on_user_pause(snap.position);
                                    authoritative_playstate = Some((
                                        sm.map_local_to_room(snap.position),
                                        true,
                                        Instant::now(),
                                    ));
                                    let hb = sm.on_heartbeat_tick(now_secs);
                                    let _ = writer.write_all(hb.as_bytes()).await;
                                }
                                if !blocking_manual_peers.is_empty() {
                                    let _ = app.emit(
                                        "sync://play-blocked",
                                        serde_json::json!({ "usernames": blocking_manual_peers }),
                                    );
                                }
                            }
                        } else {
                            apply_sync_actions(app, mpv, actions, is_scrubbing);
                        }
                    }
                    Ok(ServerMessage::Chat { username: sender, message }) => {
                        let trimmed = message.trim();
                        if trimmed.starts_with(EP2_CHAT_PREFIX) {
                            p2p.try_send(P2pControlCmd::RemoteBeacon {
                                username: sender,
                                raw_message: message,
                            });
                        } else if trimmed.starts_with(EP_REACTION_CHAT_PREFIX)
                            && !sender.eq_ignore_ascii_case(&active_username)
                        {
                            if let Some(pkt) = decode_epr_reaction(trimmed) {
                                let sender_key = sender.to_ascii_lowercase();
                                let now = Instant::now();
                                let entry = peer_epr_rx_window
                                    .entry(sender_key)
                                    .or_insert((now, 0));
                                if now.duration_since(entry.0) >= Duration::from_secs(2) {
                                    *entry = (now, 0);
                                }
                                if entry.1 < 120 {
                                    let allowed = (120 - entry.1).min(pkt.count as u32) as u8;
                                    entry.1 += allowed as u32;
                                    if allowed > 0 {
                                        let _ = app.emit(
                                            "sync://reaction",
                                            serde_json::json!({
                                                "username": sender,
                                                "avatarId": pkt.avatar_id,
                                                "emoji": pkt.emoji,
                                                "count": allowed,
                                                "via": "syncplay",
                                            }),
                                        );
                                    }
                                }
                            }
                        } else if trimmed.starts_with(EPC_CHAT_PREFIX)
                            && !sender.eq_ignore_ascii_case(&active_username)
                        {
                            match room_control.handle_chat_message(&sender, trimmed) {
                                RoomControlChatOutcome::Ignored => {}
                                RoomControlChatOutcome::QueryFromPeer => {
                                    if room_control.is_local_host() && connected_emitted {
                                        ctrl_broadcast_dirty = true;
                                        if flush_host_control_broadcast(
                                            &mut writer,
                                            &mut room_control,
                                            &participants,
                                            &mut ctrl_broadcast_dirty,
                                            &mut last_ctrl_broadcast_at,
                                        )
                                        .await
                                        .is_err()
                                        {
                                            break Err("Failed replying with room control state.".to_string());
                                        }
                                    }
                                }
                                RoomControlChatOutcome::StateChanged(chg) => {
                                    emit_room_control(app, &room_control);
                                    publish_participants(
                                        app,
                                        &participants,
                                        local_file,
                                        &room_control,
                                        &p2p,
                                    );
                                    update_no_controller_timer(
                                        &participants,
                                        &room_control,
                                        &mut no_controller_since,
                                    );
                                    if let Some(host) = chg.became_locked_by_host {
                                        let _ = app.emit(
                                            "sync://control-notice",
                                            serde_json::json!({
                                                "kind": "hostEnabled",
                                                "actor": host,
                                            }),
                                        );
                                    }
                                    if let Some(host) = chg.became_unlocked_by_host {
                                        let _ = app.emit(
                                            "sync://control-notice",
                                            serde_json::json!({
                                                "kind": "hostReleased",
                                                "actor": host,
                                            }),
                                        );
                                    }
                                    if let Some(host) = chg.local_admin_granted_by {
                                        let _ = app.emit(
                                            "sync://control-notice",
                                            serde_json::json!({
                                                "kind": "adminGranted",
                                                "actor": host,
                                            }),
                                        );
                                    }
                                    if let Some(host) = chg.local_admin_revoked_by {
                                        let _ = app.emit(
                                            "sync://control-notice",
                                            serde_json::json!({
                                                "kind": "adminRevoked",
                                                "actor": host,
                                            }),
                                        );
                                    }
                                }
                            }
                        }
                    }
                    Ok(ServerMessage::Error(msg)) => {
                        let _ = app.emit("sync://error", serde_json::json!({ "message": msg }));
                        if !connected_emitted {
                            break Err(msg);
                        }
                    }
                    Ok(ServerMessage::Tls { .. }) | Err(_) => {}
                }
            }
            Some(beacon_msg) = p2p_beacon_rx.recv() => {
                if connected_emitted {
                    let wire = encode_chat(&beacon_msg);
                    if writer.write_all(wire.as_bytes()).await.is_err() {
                        break Err("Failed sending P2P discovery beacon.".to_string());
                    }
                }
            }
            Some(fallback_pkt) = p2p_reaction_fallback_rx.recv() => {
                if connected_emitted {
                    if let Some(existing) = pending_epr_bursts.iter_mut().find(|p| {
                        p.emoji == fallback_pkt.emoji
                            && p.avatar_id == fallback_pkt.avatar_id
                            && p.count < MAX_REACTION_BURST_COUNT
                    }) {
                        existing.count = existing
                            .count
                            .saturating_add(fallback_pkt.count)
                            .min(MAX_REACTION_BURST_COUNT);
                        existing.seq = fallback_pkt.seq;
                    } else if pending_epr_bursts.len() < 8 {
                        pending_epr_bursts.push_back(fallback_pkt);
                    }
                }
            }
            _ = epr_flush_tick.tick(), if connected_emitted && !pending_epr_bursts.is_empty() => {
                if let Some(pkt) = pending_epr_bursts.pop_front() {
                    if let Some(encoded) = encode_epr_reaction(&pkt) {
                        let wire = encode_chat(&encoded);
                        if writer.write_all(wire.as_bytes()).await.is_err() {
                            break Err("Failed sending fallback party reaction.".to_string());
                        }
                    }
                }
            }
            Some(auto_align) = p2p_align_rx.recv() => {
                let current_sig = build_p2p_media_snapshot(
                    local_file,
                    local_media_path,
                    has_user_alignment,
                )
                .map(|m| m.file_sig);
                let user_locked = has_user_alignment.lock().map(|g| *g).unwrap_or(false);
                if current_sig.as_deref() == Some(auto_align.file_sig.as_str()) && !user_locked {
                    let now_secs = start_instant.elapsed().as_secs_f64();
                    seed_server_playstate_from_peers_if_missing(
                        &mut sm,
                        &participants,
                        &active_username,
                        &room_control,
                        now_secs,
                    );
                    let seg_count = auto_align.segments.len();
                    let actions = if !auto_align.segments.is_empty() {
                        if let Ok(mut guard) = timeline_segments.lock() {
                            *guard = auto_align.segments.clone();
                        }
                        let _ = app.emit("sync://timeline-segments", &auto_align.segments);
                        sm.set_piecewise_timeline(auto_align.segments, now_secs)
                    } else {
                        if let Ok(mut guard) = timeline_segments.lock() {
                            guard.clear();
                        }
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        sm.set_transform(auto_align.transform, now_secs)
                    };
                    if let Ok(mut guard) = timeline_transform.lock() {
                        *guard = sm.transform;
                    }
                    let _ = app.emit("sync://timeline-transform", sm.transform);
                    let _ = app.emit(
                        "sync://auto-aligned",
                        serde_json::json!({
                            "offsetSecs": sm.transform.offset_secs,
                            "scale": sm.transform.scale,
                            "segmentCount": seg_count.max(1),
                            "confidence": auto_align.confidence,
                            "summary": auto_align.summary,
                        }),
                    );
                    if connected_emitted && !sm.align_mode {
                        apply_sync_actions(app, mpv, actions, is_scrubbing);
                    }
                }
            }
            _ = heartbeat.tick() => {
                if connected_emitted {
                    let now_secs = start_instant.elapsed().as_secs_f64();
                    if !is_scrubbing {
                        let snap = mpv.snapshot();
                        sm.update_local_player(snap.position, snap.paused);
                    }
                    if sm.align_mode {
                        emit_room_state(app, &sm, now_secs);
                    }
                    let hb = sm.on_heartbeat_tick(now_secs);
                    if writer.write_all(hb.as_bytes()).await.is_err() {
                        break Err("Syncplay heartbeat write failed.".to_string());
                    }
                    if flush_host_control_broadcast(
                        &mut writer,
                        &mut room_control,
                        &participants,
                        &mut ctrl_broadcast_dirty,
                        &mut last_ctrl_broadcast_at,
                    )
                    .await
                    .is_err()
                    {
                        break Err("Failed flushing room control state.".to_string());
                    }
                    if no_controller_since.is_some_and(|t| t.elapsed() >= Duration::from_secs(15)) {
                        let present: Vec<&str> =
                            participants.values().map(|p| p.username.as_str()).collect();
                        if room_control.unlock_if_all_controllers_absent(&present) {
                            no_controller_since = None;
                            emit_room_control(app, &room_control);
                            publish_participants(app, &participants, local_file, &room_control, &p2p);
                            let _ = app.emit(
                                "sync://control-notice",
                                serde_json::json!({ "kind": "hostAbsentUnlocked" }),
                            );
                        } else {
                            no_controller_since = None;
                        }
                    }
                }
            }
            maybe_cmd = rx.recv() => {
                let Some(cmd) = maybe_cmd else {
                    break Ok(());
                };
                match cmd {
                    SyncCommand::SetFile(Some(meta)) => {
                        manually_not_ready = false;
                        sm.set_local_duration(Some(meta.duration_secs));
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_media_snapshot(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                        if connected_emitted {
                            let wire = encode_set_file(
                                &meta.name,
                                meta.size_bytes,
                                meta.duration_secs,
                                meta.hash_identity,
                            );
                            if writer.write_all(wire.as_bytes()).await.is_err() {
                                break Err("Failed sending file info to Syncplay.".to_string());
                            }
                            let is_ready = local_ready.lock().map(|g| *g).unwrap_or(true);
                            let ready_wire = encode_set_ready(is_ready, false);
                            if writer.write_all(ready_wire.as_bytes()).await.is_err() {
                                break Err("Failed refreshing ready status after setting file.".to_string());
                            }
                            emit_participants(app, &participants, local_file, &room_control);
                            let (_, compatible_peer_exists) = summarize_peer_compatibility(
                                &participants,
                                &active_username,
                                local_file,
                            );
                            if participants.len() > 1
                                && compatible_peer_exists
                                && meta.duration_secs > 0.0
                                && sm.ignoring_client == 0
                                && !sm.align_mode
                            {
                                let now_secs = start_instant.elapsed().as_secs_f64();
                                seed_server_playstate_from_compatible_peer_if_missing(
                                    &mut sm,
                                    &participants,
                                    &active_username,
                                    local_file,
                                    &room_control,
                                    now_secs,
                                );
                                if sm.last_server_playstate.is_some() {
                                    let actions = sm.force_resync(now_secs);
                                    apply_sync_actions(app, mpv, actions, is_scrubbing);
                                }
                            }
                        }
                    }
                    SyncCommand::SetFile(None) => {}
                    SyncCommand::SetReady { is_ready, manual } => {
                        if let Ok(mut guard) = local_ready.lock() {
                            *guard = is_ready;
                        }
                        manually_not_ready = !is_ready && manual;
                        if let Some(me) = find_participant_mut(&mut participants, &active_username) {
                            me.is_ready = Some(is_ready);
                            emit_participants(app, &participants, local_file, &room_control);
                        }
                        if connected_emitted {
                            let wire = encode_set_ready(is_ready, manual);
                            if writer.write_all(wire.as_bytes()).await.is_err() {
                                break Err("Failed sending ready status.".to_string());
                            }
                        }
                    }
                    SyncCommand::UserPlay(pos) => {
                        if sm.align_mode {
                            continue;
                        }
                        if is_effective_controller_locked(&participants, &active_username, &room_control)
                        {
                            continue;
                        }
                        is_scrubbing = false;
                        let blocked_users = if connected_emitted {
                            collect_blocking_not_ready_peers(
                                &participants,
                                &active_username,
                                &manually_not_ready_peers,
                            )
                        } else {
                            Vec::new()
                        };

                        if !blocked_users.is_empty() {
                            if !mpv.note_paused(true) {
                                let pause_req = mpv.next_request_id();
                                let _ = mpv.send_command(set_pause_cmd(pause_req, true));
                                let _ = app
                                    .emit("mpv://paused", serde_json::json!({ "paused": true }));
                            }
                            let _ = app.emit(
                                "sync://play-blocked",
                                serde_json::json!({ "usernames": blocked_users }),
                            );
                        } else {
                            if let Ok(mut guard) = local_ready.lock() {
                                *guard = true;
                            }
                            manually_not_ready = false;
                            if let Some(me) =
                                find_participant_mut(&mut participants, &active_username)
                            {
                                me.is_ready = Some(true);
                                emit_participants(app, &participants, local_file, &room_control);
                            }
                            if !mpv.note_paused(false) {
                                let pause_req = mpv.next_request_id();
                                let _ = mpv.send_command(set_pause_cmd(pause_req, false));
                                let _ = app
                                    .emit("mpv://paused", serde_json::json!({ "paused": false }));
                            }
                            sm.on_user_play(pos);
                            authoritative_playstate =
                                Some((sm.map_local_to_room(pos), false, Instant::now()));
                            if connected_emitted {
                                let ready_wire = encode_set_ready(true, true);
                                let _ = writer.write_all(ready_wire.as_bytes()).await;
                                let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                                let _ = writer.write_all(hb.as_bytes()).await;
                            }
                        }
                    }
                    SyncCommand::UserPause(pos) => {
                        if sm.align_mode {
                            continue;
                        }
                        if is_effective_controller_locked(&participants, &active_username, &room_control)
                        {
                            continue;
                        }
                        is_scrubbing = false;
                        if !mpv.note_paused(true) {
                            let pause_req = mpv.next_request_id();
                            let _ = mpv.send_command(set_pause_cmd(pause_req, true));
                            let _ = app
                                .emit("mpv://paused", serde_json::json!({ "paused": true }));
                        }
                        sm.on_user_pause(pos);
                        authoritative_playstate =
                            Some((sm.map_local_to_room(pos), true, Instant::now()));
                        if connected_emitted {
                            let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                            let _ = writer.write_all(hb.as_bytes()).await;
                        }
                    }
                    SyncCommand::UserSeek(pos) => {
                        if sm.align_mode {
                            continue;
                        }
                        if is_effective_controller_locked(&participants, &active_username, &room_control)
                        {
                            continue;
                        }
                        is_scrubbing = false;
                        sm.on_user_seek(pos);
                        authoritative_playstate =
                            Some((sm.map_local_to_room(pos), sm.local_paused, Instant::now()));
                        if connected_emitted {
                            let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                            let _ = writer.write_all(hb.as_bytes()).await;
                        }
                    }
                    SyncCommand::ResetForNewFile => {
                        manually_not_ready = false;
                        sm.reset_for_new_file();
                        if let Ok(mut guard) = timeline_segments.lock() {
                            guard.clear();
                        }
                        if let Ok(mut guard) = has_user_alignment.lock() {
                            *guard = false;
                        }
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(None));
                        let spd_req = mpv.next_request_id();
                        let _ = mpv.send_command(set_speed_cmd(spd_req, 1.0));
                        let _ = app.emit("sync://timeline-transform", TimelineTransform::default());
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        if let Some(me) = find_participant_mut(&mut participants, &active_username) {
                            me.is_ready = Some(false);
                        }
                        if connected_emitted {
                            let ready_wire = encode_set_ready(false, false);
                            if writer.write_all(ready_wire.as_bytes()).await.is_err() {
                                break Err("Failed resetting ready status for new file.".to_string());
                            }
                            emit_participants(app, &participants, local_file, &room_control);
                        }
                    }
                    SyncCommand::ForceResync => {
                        is_scrubbing = false;
                        if sm.align_mode {
                            sm.align_mode = false;
                            if let Ok(mut guard) = align_mode.lock() {
                                *guard = false;
                            }
                        }
                        if connected_emitted {
                            let is_ready = local_ready.lock().map(|g| *g).unwrap_or(false);
                            let ready_wire = encode_set_ready(is_ready, false);
                            if writer.write_all(ready_wire.as_bytes()).await.is_err() {
                                break Err("Failed refreshing ready status during resync.".to_string());
                            }
                            let current_file = local_file.lock().ok().and_then(|g| g.clone());
                            if let Some(f) = current_file {
                                let file_wire = encode_set_file(
                                    &f.name,
                                    f.size_bytes,
                                    f.duration_secs,
                                    f.hash_identity,
                                );
                                if writer.write_all(file_wire.as_bytes()).await.is_err() {
                                    break Err("Failed refreshing file info during resync.".to_string());
                                }
                            }
                            let _ = writer.write_all(b"{\"List\":null}\r\n").await;
                            let now_secs = start_instant.elapsed().as_secs_f64();
                            seed_server_playstate_from_peers_if_missing(
                                &mut sm,
                                &participants,
                                &active_username,
                                &room_control,
                                now_secs,
                            );
                            let actions = sm.force_resync(now_secs);
                            apply_sync_actions(app, mpv, actions, is_scrubbing);
                            let hb = sm.on_heartbeat_tick(now_secs);
                            if writer.write_all(hb.as_bytes()).await.is_err() {
                                break Err("Syncplay heartbeat write failed during resync.".to_string());
                            }
                        }
                    }
                    SyncCommand::SetScrubbing(scrubbing) => {
                        is_scrubbing = scrubbing;
                    }
                    SyncCommand::SetTimelineTransform(tx) => {
                        let now_secs = start_instant.elapsed().as_secs_f64();
                        seed_server_playstate_from_peers_if_missing(
                            &mut sm,
                            &participants,
                            &active_username,
                            &room_control,
                            now_secs,
                        );
                        let actions = sm.set_transform(tx, now_secs);
                        if let Ok(mut guard) = timeline_transform.lock() {
                            *guard = sm.transform;
                        }
                        if let Ok(mut guard) = timeline_segments.lock() {
                            guard.clear();
                        }
                        if let Ok(mut guard) = has_user_alignment.lock() {
                            *guard = !sm.transform.is_identity();
                        }
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_media_snapshot(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                        if connected_emitted && !sm.align_mode {
                            apply_sync_actions(app, mpv, actions, is_scrubbing);
                        }
                    }
                    SyncCommand::NudgeTimelineOffset(delta_secs) => {
                        let now_secs = start_instant.elapsed().as_secs_f64();
                        seed_server_playstate_from_peers_if_missing(
                            &mut sm,
                            &participants,
                            &active_username,
                            &room_control,
                            now_secs,
                        );
                        let next = TimelineTransform {
                            offset_secs: sm.transform.offset_secs + delta_secs,
                            scale: sm.transform.scale,
                        };
                        let actions = sm.set_transform(next, now_secs);
                        if let Ok(mut guard) = timeline_transform.lock() {
                            *guard = sm.transform;
                        }
                        if let Ok(mut guard) = timeline_segments.lock() {
                            guard.clear();
                        }
                        if let Ok(mut guard) = has_user_alignment.lock() {
                            *guard = true;
                        }
                        let _ = app.emit("sync://timeline-transform", sm.transform);
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_media_snapshot(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                        if connected_emitted && !sm.align_mode {
                            apply_sync_actions(app, mpv, actions, is_scrubbing);
                        }
                    }
                    SyncCommand::SetAlignMode(enabled) => {
                        let now_secs = start_instant.elapsed().as_secs_f64();
                        seed_server_playstate_from_peers_if_missing(
                            &mut sm,
                            &participants,
                            &active_username,
                            &room_control,
                            now_secs,
                        );
                        if let Ok(mut guard) = align_mode.lock() {
                            *guard = enabled;
                        }
                        let actions = sm.set_align_mode(enabled, now_secs);
                        if enabled {
                            emit_room_state(app, &sm, now_secs);
                        } else if connected_emitted {
                            apply_sync_actions(app, mpv, actions, is_scrubbing);
                        }
                    }
                    SyncCommand::AlignSceneHere {
                        local_pos_secs,
                        reply,
                    } => {
                        let now_secs = start_instant.elapsed().as_secs_f64();
                        seed_server_playstate_from_peers_if_missing(
                            &mut sm,
                            &participants,
                            &active_username,
                            &room_control,
                            now_secs,
                        );
                        let mpv_pos = local_pos_secs.unwrap_or_else(|| mpv.snapshot().position);
                        let (tx, actions) = sm.align_scene_here(mpv_pos, now_secs);
                        if let Ok(mut guard) = timeline_transform.lock() {
                            *guard = tx;
                        }
                        if let Ok(mut guard) = timeline_segments.lock() {
                            guard.clear();
                        }
                        if let Ok(mut guard) = has_user_alignment.lock() {
                            *guard = true;
                        }
                        if let Ok(mut guard) = align_mode.lock() {
                            *guard = false;
                        }
                        let _ = app.emit("sync://timeline-transform", tx);
                        let _ = app.emit("sync://timeline-segments", Vec::<TimelineSegment>::new());
                        p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_media_snapshot(
                            local_file,
                            local_media_path,
                            has_user_alignment,
                        )));
                        if connected_emitted {
                            apply_sync_actions(app, mpv, actions, false);
                            let hb = sm.on_heartbeat_tick(now_secs);
                            let _ = writer.write_all(hb.as_bytes()).await;
                        }
                        let _ = reply.send(tx);
                    }
                    SyncCommand::TriggerP2pRealign { force } => {
                        if force {
                            if let Ok(mut guard) = has_user_alignment.lock() {
                                *guard = false;
                            }
                            p2p.try_send(P2pControlCmd::UpdateLocalMedia(build_p2p_media_snapshot(
                                local_file,
                                local_media_path,
                                has_user_alignment,
                            )));
                        }
                        p2p.try_send(P2pControlCmd::TriggerRealign { force });
                    }
                    SyncCommand::SetAdmin {
                        username: target,
                        grant,
                        reply,
                    } => {
                        let res = match room_control.set_admin(&target, grant) {
                            Ok(lines) => {
                                if let Ok(mut guard) = persisted_host.lock() {
                                    *guard = room_control.export_persisted_host();
                                }
                                emit_room_control(app, &room_control);
                                publish_participants(
                                    app,
                                    &participants,
                                    local_file,
                                    &room_control,
                                    &p2p,
                                );
                                if connected_emitted && !lines.is_empty() {
                                    if send_ctrl_chat_lines(&mut writer, &lines).await.is_err() {
                                        Err("Failed sending admin permission update.".to_string())
                                    } else {
                                        ctrl_broadcast_dirty = false;
                                        last_ctrl_broadcast_at = Some(Instant::now());
                                        Ok(())
                                    }
                                } else {
                                    Ok(())
                                }
                            }
                            Err(e) => Err(e),
                        };
                        let _ = reply.send(res);
                    }
                    SyncCommand::ReleaseHostControlOnLeave { reply } => {
                        if connected_emitted {
                            let present: Vec<&str> =
                                participants.values().map(|p| p.username.as_str()).collect();
                            if let Some(lines) = room_control.release_on_leave(&present) {
                                let _ = send_ctrl_chat_lines(&mut writer, &lines).await;
                            }
                        }
                        if let Ok(mut guard) = persisted_host.lock() {
                            *guard = None;
                        }
                        let _ = reply.send(());
                        break Ok(());
                    }
                    SyncCommand::SendReaction {
                        emoji,
                        avatar_id,
                        count,
                    } => {
                        let has_other_peer = participants
                            .values()
                            .any(|p| !p.username.eq_ignore_ascii_case(&active_username));
                        if connected_emitted && has_other_peer {
                            p2p.try_send(P2pControlCmd::SendReaction {
                                emoji,
                                avatar_id,
                                count,
                            });
                        }
                    }
                    SyncCommand::ManualRetry => {}
                }
            }
        }
    };
    p2p.try_send(P2pControlCmd::Shutdown);
    result
}

fn is_peer_effective_controller(
    peer: &RoomParticipantUpdate,
    room_control: &RoomControlSession,
) -> bool {
    peer.is_controller || room_control.is_user_controller(&peer.username)
}

fn emit_room_control(app: &AppHandle, room_control: &RoomControlSession) {
    let _ = app.emit("sync://room-control", room_control.summary());
}

fn build_effective_p2p_participants(
    participants: &HashMap<String, RoomParticipantUpdate>,
    room_control: &RoomControlSession,
) -> Vec<RoomParticipantUpdate> {
    participants
        .values()
        .map(|p| RoomParticipantUpdate {
            is_controller: is_peer_effective_controller(p, room_control),
            ..p.clone()
        })
        .collect()
}

fn publish_participants(
    app: &AppHandle,
    participants: &HashMap<String, RoomParticipantUpdate>,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    room_control: &RoomControlSession,
    p2p: &P2pSessionHandle,
) {
    emit_participants(app, participants, local_file, room_control);
    p2p.try_send(P2pControlCmd::UpdateParticipants(
        build_effective_p2p_participants(participants, room_control),
    ));
}

fn update_no_controller_timer(
    participants: &HashMap<String, RoomParticipantUpdate>,
    room_control: &RoomControlSession,
    no_controller_since: &mut Option<Instant>,
) {
    if !room_control.is_locked() || room_control.is_local_host() || participants.is_empty() {
        *no_controller_since = None;
        return;
    }
    let any_controller_present = participants
        .values()
        .any(|p| room_control.is_user_controller(&p.username));
    if any_controller_present {
        *no_controller_since = None;
    } else if no_controller_since.is_none() {
        *no_controller_since = Some(Instant::now());
    }
}

fn should_enforce_authoritative_playstate(
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
    room_control: &RoomControlSession,
) -> bool {
    if !room_control.is_locked() {
        return false;
    }
    if room_control.is_local_host() {
        return true;
    }
    if !room_control.is_local_admin() {
        return false;
    }
    let host_present = participants
        .values()
        .any(|p| room_control.is_user_host(&p.username));
    if host_present {
        return false;
    }
    let mut active_admins: Vec<String> = participants
        .values()
        .filter(|p| room_control.is_user_admin(&p.username))
        .map(|p| p.username.to_ascii_lowercase())
        .collect();
    active_admins.sort();
    active_admins
        .first()
        .is_some_and(|first| first == &active_username.to_ascii_lowercase())
}

async fn send_ctrl_chat_lines<W: AsyncWrite + Unpin>(
    writer: &mut W,
    lines: &[String],
) -> Result<(), std::io::Error> {
    for line in lines {
        let wire = encode_chat(line);
        writer.write_all(wire.as_bytes()).await?;
    }
    Ok(())
}

async fn flush_host_control_broadcast<W: AsyncWrite + Unpin>(
    writer: &mut W,
    room_control: &mut RoomControlSession,
    participants: &HashMap<String, RoomParticipantUpdate>,
    dirty: &mut bool,
    last_sent_at: &mut Option<Instant>,
) -> Result<(), std::io::Error> {
    if !*dirty || !room_control.is_local_host() || participants.len() <= 1 {
        return Ok(());
    }
    if last_sent_at.is_some_and(|t| t.elapsed() < Duration::from_millis(650)) {
        return Ok(());
    }
    let lines = room_control.encode_current_snapshot_lines(false);
    if !lines.is_empty() {
        send_ctrl_chat_lines(writer, &lines).await?;
    }
    *dirty = false;
    *last_sent_at = Some(Instant::now());
    Ok(())
}

fn emit_participants(
    app: &AppHandle,
    participants: &HashMap<String, RoomParticipantUpdate>,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    room_control: &RoomControlSession,
) {
    let local_id = build_local_file_identity(local_file);

    let mut list: Vec<ParticipantDto> = participants
        .values()
        .map(|p| {
            let peer_id = p.file.as_ref().map(build_peer_file_identity);
            let cmp = analyze_files(local_id.as_ref(), peer_id.as_ref());
            let is_host = room_control.is_user_host(&p.username);
            let is_admin = room_control.is_user_admin(&p.username);
            ParticipantDto {
                username: p.username.clone(),
                room: p.room.clone(),
                position: p.position,
                file_name: p.file.as_ref().map(|f| f.name.clone()),
                file_duration: p.file.as_ref().and_then(|f| f.duration),
                is_ready: p.is_ready.unwrap_or(false),
                is_controller: p.is_controller || is_host || is_admin,
                is_host,
                is_admin,
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

fn find_participant_mut<'a>(
    participants: &'a mut HashMap<String, RoomParticipantUpdate>,
    username: &str,
) -> Option<&'a mut RoomParticipantUpdate> {
    participants
        .iter_mut()
        .find(|(k, _)| k.eq_ignore_ascii_case(username))
        .map(|(_, p)| p)
}

fn upsert_participant_mut<'a>(
    participants: &'a mut HashMap<String, RoomParticipantUpdate>,
    username: &str,
    room: &str,
) -> &'a mut RoomParticipantUpdate {
    let key = participants
        .keys()
        .find(|k| k.eq_ignore_ascii_case(username))
        .cloned()
        .unwrap_or_else(|| username.to_string());
    participants
        .entry(key)
        .or_insert_with(|| RoomParticipantUpdate {
            username: username.to_string(),
            room: room.to_string(),
            position: 0.0,
            paused: true,
            is_ready: Some(false),
            is_controller: false,
            file: None,
        })
}

fn should_notify_peer_not_ready(
    is_local: bool,
    is_ready: bool,
    manually_initiated: Option<bool>,
    was_ready: bool,
) -> bool {
    !is_local && !is_ready && (manually_initiated == Some(true) || was_ready)
}

fn should_notify_peer_left(is_local: bool, was_present: bool) -> bool {
    !is_local && was_present
}

fn is_controller_locked(
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
) -> bool {
    let has_controllers = participants.values().any(|p| p.is_controller);
    if !has_controllers {
        return false;
    }
    !participants
        .values()
        .any(|p| p.username.eq_ignore_ascii_case(active_username) && p.is_controller)
}

fn is_effective_controller_locked(
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
    room_control: &RoomControlSession,
) -> bool {
    if room_control.is_locked() {
        return !room_control.is_user_controller(active_username);
    }
    is_controller_locked(participants, active_username)
}

fn collect_manually_not_ready_peers(
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
    manually_not_ready_peers: &HashSet<String>,
) -> Vec<String> {
    let mut names: Vec<String> = participants
        .values()
        .filter(|p| {
            !p.username.eq_ignore_ascii_case(active_username)
                && !p.is_ready.unwrap_or(false)
                && manually_not_ready_peers.contains(&p.username.to_ascii_lowercase())
        })
        .map(|p| p.username.clone())
        .collect();
    names.sort();
    names
}

fn collect_blocking_not_ready_peers(
    participants: &HashMap<String, RoomParticipantUpdate>,
    active_username: &str,
    manually_not_ready_peers: &HashSet<String>,
) -> Vec<String> {
    let mut names: Vec<String> = participants
        .values()
        .filter(|p| {
            !p.username.eq_ignore_ascii_case(active_username)
                && !p.is_ready.unwrap_or(false)
                && (p.file.is_some()
                    || manually_not_ready_peers.contains(&p.username.to_ascii_lowercase()))
        })
        .map(|p| p.username.clone())
        .collect();
    names.sort();
    names
}

#[cfg(test)]
mod tests {
    use super::*;
    use epilod_core::syncplay::WireFileInfo;

    fn peer(username: &str, is_ready: Option<bool>, has_file: bool) -> RoomParticipantUpdate {
        RoomParticipantUpdate {
            username: username.to_string(),
            room: "r".to_string(),
            position: 0.0,
            paused: true,
            is_ready,
            is_controller: false,
            file: has_file.then(|| WireFileInfo {
                name: "movie.mkv".to_string(),
                size: None,
                size_hash: None,
                duration: Some(1200.0),
            }),
        }
    }

    #[test]
    fn notifies_only_when_peer_manually_unreadies_or_transitions_from_ready() {
        assert!(should_notify_peer_not_ready(
            false,
            false,
            Some(true),
            false
        ));
        assert!(should_notify_peer_not_ready(false, false, None, true));
        assert!(should_notify_peer_not_ready(
            false,
            false,
            Some(false),
            true
        ));
        assert!(!should_notify_peer_not_ready(
            false,
            false,
            Some(false),
            false
        ));
        assert!(!should_notify_peer_not_ready(true, false, Some(true), true));
        assert!(!should_notify_peer_not_ready(
            false,
            true,
            Some(true),
            false
        ));
    }

    #[test]
    fn notifies_peer_left_only_for_present_remote_peer() {
        assert!(should_notify_peer_left(false, true));
        assert!(!should_notify_peer_left(false, false));
        assert!(!should_notify_peer_left(true, true));
        assert!(!should_notify_peer_left(true, false));
    }

    #[test]
    fn collects_blocking_and_manual_not_ready_peers_case_insensitively() {
        let mut participants = HashMap::new();
        participants.insert("Alice".into(), peer("Alice", Some(false), true));
        participants.insert("Bob".into(), peer("Bob", Some(false), true));
        participants.insert("Charlie".into(), peer("Charlie", Some(false), false));
        participants.insert("Dana".into(), peer("Dana", Some(true), true));

        let mut manual = HashSet::new();
        manual.insert("charlie".to_string());

        assert_eq!(
            collect_blocking_not_ready_peers(&participants, "alice", &manual),
            vec!["Bob".to_string(), "Charlie".to_string()]
        );
        assert_eq!(
            collect_manually_not_ready_peers(&participants, "alice", &manual),
            vec!["Charlie".to_string()]
        );

        let empty_manual = HashSet::new();
        assert_eq!(
            collect_blocking_not_ready_peers(&participants, "alice", &empty_manual),
            vec!["Bob".to_string()]
        );
    }

    #[test]
    fn summarize_peer_compatibility_ignores_previous_episode_peers() {
        let mut participants = HashMap::new();
        participants.insert(
            "Bob".into(),
            RoomParticipantUpdate {
                username: "Bob".into(),
                room: "r".into(),
                position: 1438.0,
                paused: false,
                is_ready: Some(true),
                is_controller: false,
                file: Some(WireFileInfo {
                    name: "Show.S01E01.mkv".into(),
                    size: None,
                    size_hash: None,
                    duration: Some(1440.0),
                }),
            },
        );

        let local_ep2 = Arc::new(Mutex::new(Some(LocalFileMeta {
            name: "Show.S01E02.mkv".into(),
            size_bytes: None,
            duration_secs: 1440.0,
            hash_identity: false,
        })));

        // Bob is still on S01E01 while we loaded S01E02 -> any_peer_has_file=true, compatible=false
        assert_eq!(
            summarize_peer_compatibility(&participants, "Alice", &local_ep2),
            (true, false)
        );

        // Once another peer moves to S01E02 (even a different encode like .mp4), compatible becomes true
        participants.insert(
            "Charlie".into(),
            RoomParticipantUpdate {
                username: "Charlie".into(),
                room: "r".into(),
                position: 1.0,
                paused: false,
                is_ready: Some(true),
                is_controller: false,
                file: Some(WireFileInfo {
                    name: "Show.S01E02.mp4".into(),
                    size: None,
                    size_hash: None,
                    duration: Some(1440.0),
                }),
            },
        );
        assert_eq!(
            summarize_peer_compatibility(&participants, "Alice", &local_ep2),
            (true, true)
        );
    }

    #[test]
    fn effective_controller_lock_and_authoritative_enforcer_respect_host_and_admin_roles() {
        let mut participants = HashMap::new();
        participants.insert("Alice".into(), peer("Alice", Some(true), true));
        participants.insert("Bob".into(), peer("Bob", Some(true), true));
        participants.insert("Charlie".into(), peer("Charlie", Some(true), true));

        let mut host = RoomControlSession::new_host("ep-room", "Alice", None);
        assert!(!is_effective_controller_locked(
            &participants,
            "Alice",
            &host
        ));
        assert!(should_enforce_authoritative_playstate(
            &participants,
            "Alice",
            &host
        ));

        let lines = host.set_admin("Bob", true).unwrap();
        let mut bob = RoomControlSession::new_guest("ep-room", "Bob");
        let mut charlie = RoomControlSession::new_guest("ep-room", "Charlie");
        for l in &lines {
            bob.handle_chat_message("Alice", l);
            charlie.handle_chat_message("Alice", l);
        }

        assert!(!is_effective_controller_locked(&participants, "Bob", &bob));
        assert!(is_effective_controller_locked(
            &participants,
            "Charlie",
            &charlie
        ));
        // While Host Alice is present, Admin Bob defers authoritative pushback to Alice.
        assert!(!should_enforce_authoritative_playstate(
            &participants,
            "Bob",
            &bob
        ));

        // Once Host Alice leaves, remaining Admin Bob becomes authoritative enforcer.
        participants.remove("Alice");
        assert!(should_enforce_authoritative_playstate(
            &participants,
            "Bob",
            &bob
        ));
    }
}
