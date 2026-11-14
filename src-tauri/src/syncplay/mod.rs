#![cfg(windows)]

use crate::mpv::MpvController;
use epilod_core::matching::{compare_files, FileIdentity, FileMatchStatus};
use epilod_core::mpv_ipc::{seek_absolute_cmd, set_pause_cmd};
use epilod_core::room_code::resolve_syncplay_room;
use epilod_core::syncplay::{
    encode_hello, encode_set_file, encode_set_ready, encode_start_tls_send,
    extract_tls_server_name, hash_filename, parse_server_line, PlayerSnapshot, ReconnectPolicy,
    RoomParticipantUpdate, ServerMessage, SetUpdate, SyncAction, SyncStateMachine,
    MAX_WIRE_LINE_BYTES,
};
use epilod_core::validation::validate_endpoint;
use native_tls::TlsConnector as NativeTlsConnector;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
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
    pub file_match: FileMatchStatus,
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
    SetReady { is_ready: bool, manual: bool },
    UserPlay(f64),
    UserPause(f64),
    UserSeek(f64),
    ManualRetry,
}

struct SyncSessionConfig {
    endpoint: String,
    username: String,
    wire_room: String,
    password: Option<String>,
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
    local_ready: Arc<Mutex<bool>>,
}

impl SyncController {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn connect(
        &self,
        app: AppHandle,
        mpv: Arc<MpvController>,
        endpoint: String,
        username: String,
        room_input: String,
        literal_room: bool,
        password: Option<String>,
    ) -> Result<(), String> {
        let valid_endpoint = validate_endpoint(&endpoint).map_err(|e| e.to_string())?;
        let wire_room =
            resolve_syncplay_room(&room_input, literal_room).map_err(|e| e.to_string())?;

        self.disconnect_internal().await;

        let (tx, rx) = mpsc::channel::<SyncCommand>(64);
        let cfg = SyncSessionConfig {
            endpoint: valid_endpoint.clone(),
            username: username.clone(),
            wire_room: wire_room.clone(),
            password: password.clone(),
        };
        let local_file = Arc::clone(&self.local_file);
        let local_ready = Arc::clone(&self.local_ready);

        let task = tokio::spawn(async move {
            run_sync_loop(
                app,
                mpv,
                valid_endpoint,
                username,
                wire_room,
                password,
                rx,
                local_file,
                local_ready,
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
                )
            })
        };

        let Some((tx, finished, endpoint, username, wire_room, password)) = existing_tx else {
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
        };
        let local_file = Arc::clone(&self.local_file);
        let local_ready = Arc::clone(&self.local_ready);
        let task = tokio::spawn(async move {
            run_sync_loop(
                app,
                mpv,
                endpoint,
                username,
                wire_room,
                password,
                rx,
                local_file,
                local_ready,
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

    pub async fn disconnect(&self) {
        self.disconnect_internal().await;
        if let Ok(mut f) = self.local_file.lock() {
            *f = None;
        }
        if let Ok(mut r) = self.local_ready.lock() {
            *r = false;
        }
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
    Tls(tokio_native_tls::TlsStream<TcpStream>),
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
        Ok((WireStream::Tls(tls_stream), true))
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
    mut rx: mpsc::Receiver<SyncCommand>,
    local_file: Arc<Mutex<Option<LocalFileMeta>>>,
    local_ready: Arc<Mutex<bool>>,
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
                            tls_active,
                            snapshot,
                            &mut rx,
                            &local_file,
                            &local_ready,
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
                            tls_active,
                            snapshot,
                            &mut rx,
                            &local_file,
                            &local_ready,
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
                        Some(SyncCommand::ManualRetry) => {
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
                    Some(SyncCommand::ManualRetry) => {
                        policy.manual_retry();
                        break;
                    }
                    Some(_) => {}
                }
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive_authenticated_session<R, W>(
    app: &AppHandle,
    mpv: &Arc<MpvController>,
    endpoint: &str,
    username: &str,
    wire_room: &str,
    password: Option<&str>,
    tls_active: bool,
    initial_snapshot: PlayerSnapshot,
    rx: &mut mpsc::Receiver<SyncCommand>,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
    local_ready: &Arc<Mutex<bool>>,
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
    let mut active_username = username.to_string();
    let mut participants: HashMap<String, RoomParticipantUpdate> = HashMap::new();
    let mut lines = BufReader::new(reader).lines();
    let mut connected_emitted = false;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(1));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            maybe_line = lines.next_line() => {
                let line = match maybe_line {
                    Ok(Some(l)) => l,
                    Ok(None) => return Err("Syncplay connection closed by server.".to_string()),
                    Err(e) => return Err(format!("Syncplay network read error: {e}")),
                };

                match parse_server_line(&line) {
                    Ok(ServerMessage::Hello { username: assigned, .. }) => {
                        if !assigned.is_empty() {
                            active_username = assigned;
                        }
                        sm.set_local_username(active_username.clone());
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

                        // Fix 08: Emit initial readiness accurately on connect / reconnect
                        let is_ready = local_ready.lock().map(|g| *g).unwrap_or(false);
                        let ready_msg = encode_set_ready(is_ready, false);
                        let _ = writer.write_all(ready_msg.as_bytes()).await;

                        // Re-announce loaded local file if one is active
                        let current_file = local_file.lock().ok().and_then(|g| g.clone());
                        if let Some(f) = current_file {
                            let file_msg = encode_set_file(
                                &f.name,
                                f.size_bytes,
                                f.duration_secs,
                                f.hash_identity,
                            );
                            let _ = writer.write_all(file_msg.as_bytes()).await;
                        }

                        let list_req = "{\"List\":null}\r\n";
                        let _ = writer.write_all(list_req.as_bytes()).await;
                    }
                    Ok(ServerMessage::List(items)) => {
                        participants.clear();
                        for item in items {
                            participants.insert(item.username.clone(), item);
                        }
                        emit_participants(app, &participants, local_file);
                    }
                    Ok(ServerMessage::Set(updates)) => {
                        let mut changed = false;
                        for upd in updates {
                            match upd {
                                SetUpdate::UserJoined { username: u } => {
                                    participants.entry(u.clone()).or_insert(RoomParticipantUpdate {
                                        username: u,
                                        room: wire_room.to_string(),
                                        position: 0.0,
                                        paused: true,
                                        is_ready: Some(false),
                                        is_controller: false,
                                        file: None,
                                    });
                                    changed = true;
                                }
                                SetUpdate::UserLeft { username: u } => {
                                    participants.remove(&u);
                                    changed = true;
                                }
                                SetUpdate::Ready { username: u, is_ready } => {
                                    let entry = participants.entry(u.clone()).or_insert(RoomParticipantUpdate {
                                        username: u,
                                        room: wire_room.to_string(),
                                        position: 0.0,
                                        paused: true,
                                        is_ready: Some(is_ready),
                                        is_controller: false,
                                        file: None,
                                    });
                                    entry.is_ready = Some(is_ready);
                                    changed = true;
                                }
                                SetUpdate::File { username: u, file } => {
                                    let entry = participants.entry(u.clone()).or_insert(RoomParticipantUpdate {
                                        username: u,
                                        room: wire_room.to_string(),
                                        position: 0.0,
                                        paused: true,
                                        is_ready: Some(false),
                                        is_controller: false,
                                        file: Some(file.clone()),
                                    });
                                    entry.file = Some(file);
                                    changed = true;
                                }
                                SetUpdate::ControllerAuth { username: u, is_controller } => {
                                    if let Some(entry) = participants.get_mut(&u) {
                                        entry.is_controller = is_controller;
                                        changed = true;
                                    }
                                }
                            }
                        }
                        if changed {
                            emit_participants(app, &participants, local_file);
                        }
                    }
                    Ok(ServerMessage::State(st)) => {
                        let now_secs = start_instant.elapsed().as_secs_f64();
                        let snap = mpv.snapshot();
                        sm.update_local_player(snap.position, snap.paused);
                        let actions = sm.handle_server_state(&st, now_secs);
                        for act in actions {
                            match act {
                                SyncAction::ServerOverride { set_by } => {
                                    let _ = app.emit(
                                        "sync://server-override",
                                        serde_json::json!({ "setBy": set_by }),
                                    );
                                }
                                SyncAction::SetPaused(p) => {
                                    let req = mpv.next_request_id();
                                    let _ = mpv.send_command(set_pause_cmd(req, p));
                                }
                                SyncAction::Seek(pos) => {
                                    let req = mpv.next_request_id();
                                    let _ = mpv.send_command(seek_absolute_cmd(req, pos));
                                }
                            }
                        }
                    }
                    Ok(ServerMessage::Error(msg)) => {
                        let _ = app.emit("sync://error", serde_json::json!({ "message": msg }));
                        if !connected_emitted {
                            return Err(msg);
                        }
                    }
                    Ok(ServerMessage::Tls { .. }) | Err(_) => {}
                }
            }
            _ = heartbeat.tick() => {
                if connected_emitted {
                    let snap = mpv.snapshot();
                    sm.update_local_player(snap.position, snap.paused);
                    let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                    if writer.write_all(hb.as_bytes()).await.is_err() {
                        return Err("Syncplay heartbeat write failed.".to_string());
                    }
                }
            }
            maybe_cmd = rx.recv() => {
                let Some(cmd) = maybe_cmd else {
                    return Ok(());
                };
                match cmd {
                    SyncCommand::SetFile(Some(meta)) => {
                        let wire = encode_set_file(
                            &meta.name,
                            meta.size_bytes,
                            meta.duration_secs,
                            meta.hash_identity,
                        );
                        if writer.write_all(wire.as_bytes()).await.is_err() {
                            return Err("Failed sending file info to Syncplay.".to_string());
                        }
                    }
                    SyncCommand::SetFile(None) => {}
                    SyncCommand::SetReady { is_ready, manual } => {
                        let wire = encode_set_ready(is_ready, manual);
                        if writer.write_all(wire.as_bytes()).await.is_err() {
                            return Err("Failed sending ready status.".to_string());
                        }
                    }
                    SyncCommand::UserPlay(pos) => {
                        sm.on_user_play(pos);
                        let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                        let _ = writer.write_all(hb.as_bytes()).await;
                    }
                    SyncCommand::UserPause(pos) => {
                        sm.on_user_pause(pos);
                        let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                        let _ = writer.write_all(hb.as_bytes()).await;
                    }
                    SyncCommand::UserSeek(pos) => {
                        sm.on_user_seek(pos);
                        let hb = sm.on_heartbeat_tick(start_instant.elapsed().as_secs_f64());
                        let _ = writer.write_all(hb.as_bytes()).await;
                    }
                    SyncCommand::ManualRetry => {}
                }
            }
        }
    }
}

fn emit_participants(
    app: &AppHandle,
    participants: &HashMap<String, RoomParticipantUpdate>,
    local_file: &Arc<Mutex<Option<LocalFileMeta>>>,
) {
    let local_id = local_file
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
            duration_secs: Some(f.duration_secs),
            is_hashed: f.hash_identity,
        });

    let mut list: Vec<ParticipantDto> = participants
        .values()
        .map(|p| {
            let peer_id = p.file.as_ref().map(|pf| FileIdentity {
                name: pf.name.clone(),
                size_bytes: pf.size,
                duration_secs: pf.duration,
                is_hashed: true,
            });
            let file_match = compare_files(local_id.as_ref(), peer_id.as_ref());
            ParticipantDto {
                username: p.username.clone(),
                room: p.room.clone(),
                position: p.position,
                file_name: p.file.as_ref().map(|f| f.name.clone()),
                file_duration: p.file.as_ref().and_then(|f| f.duration),
                is_ready: p.is_ready.unwrap_or(false),
                is_controller: p.is_controller,
                file_match,
            }
        })
        .collect();
    list.sort_by(|a, b| a.username.cmp(&b.username));
    let _ = app.emit("sync://participants", list);
}
