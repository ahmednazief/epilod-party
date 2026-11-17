#![cfg(windows)]

use epilod_core::matching::{analyze_files, FileIdentity, SourceRelation};
use epilod_core::media_align::{
    analyze_probe_matches, AlignmentAnalysis, ProbeMatch, SparseAudioProbe, SparseAudioProbeWire,
};
use epilod_core::p2p::{
    build_ssdp_msearch, build_stun_binding_request, build_upnp_add_port_mapping_soap,
    build_upnp_delete_port_mapping_soap, decode_ep2_beacon, encode_ep2_beacon, fill_random_bytes,
    parse_http_url_host_port_path, parse_igd_control_url, parse_ssdp_location,
    parse_stun_binding_response, sanitize_avatar_id, sanitize_chat_id, sanitize_chat_text,
    sanitize_reaction_emoji, ChatFallbackPacket, ChatReactFallbackPacket, P2pBeacon, P2pCandidate,
    P2pCandidateKind, P2pCryptoSession, P2pIdentity, P2pWireFrame, ReactionFallbackPacket,
    ReliableChannel, MAX_P2P_DATAGRAM_BYTES, MAX_REACTION_BURST_COUNT, SSDP_MULTICAST_ADDR,
    STUN_SERVERS,
};
use epilod_core::syncplay::{
    RoomParticipantUpdate, TimelineSegment, TimelineTransform, WireFileInfo,
};
use epilod_core::validation::LocalPathOptions;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::mpsc;

use crate::mpv::process::resolve_ffmpeg_exe;
use crate::sparse_align::{
    extract_reference_probes, match_remote_probes_locally, validate_video_for_sparse_probe,
    ProbeMatchHints,
};

#[derive(Debug, Clone)]
pub struct P2pLocalMedia {
    pub file_sig: String,
    pub identity: FileIdentity,
    pub path: Option<PathBuf>,
    pub has_user_alignment: bool,
}

#[derive(Debug, Clone)]
pub struct P2pAutoAlignment {
    pub file_sig: String,
    pub transform: TimelineTransform,
    pub segments: Vec<TimelineSegment>,
    pub confidence: f64,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pPeerStatusDto {
    pub username: String,
    pub transport: String,
    pub rtt_ms: Option<u32>,
    pub auto_align_state: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pStatusPayload {
    pub nat_mode: String,
    pub peers: Vec<P2pPeerStatusDto>,
}

pub enum P2pControlCmd {
    UpdateLocalUsername(String),
    UpdateLocalMedia(Option<P2pLocalMedia>),
    UpdateParticipants(Vec<RoomParticipantUpdate>),
    RemoteBeacon {
        username: String,
        raw_message: String,
    },
    TriggerRealign {
        force: bool,
    },
    SendReaction {
        emoji: String,
        avatar_id: String,
        count: u8,
    },
    SendChat {
        id: String,
        text: String,
        avatar_id: String,
        reply_to_id: Option<String>,
    },
    SendChatEdit {
        target_msg_id: String,
        text: String,
    },
    SendChatReact {
        target_msg_id: String,
        emoji: String,
    },
    SendTyping {
        is_typing: bool,
    },
    PeerJoined(String),
    Shutdown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum P2pDatagramMessage {
    Reaction {
        sender: String,
        avatar_id: String,
        emoji: String,
        count: u8,
        seq: u32,
        #[serde(default)]
        relay_targets: Vec<String>,
        #[serde(default)]
        ttl: u8,
    },
    ChatTyping {
        sender: String,
        is_typing: bool,
    },
    RelayUnavailable {
        targets: Vec<String>,
    },
}

enum UdpPacketEvent {
    App(String, P2pAppMessage),
    Datagram(String, P2pDatagramMessage),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
enum P2pAppMessage {
    ProbeOffer {
        file_sig: String,
        ref_duration_secs: f64,
        probes: Vec<SparseAudioProbeWire>,
    },
    NeedlesRequest {
        file_sig: String,
        timestamps_secs: Vec<f64>,
    },
    NeedlesResponse {
        file_sig: String,
        probes: Vec<SparseAudioProbeWire>,
    },
    OfferRequest,
    ChatMessage {
        id: String,
        sender: String,
        avatar_id: String,
        text: String,
        #[serde(default)]
        reply_to_id: Option<String>,
        #[serde(default)]
        relay_targets: Vec<String>,
        #[serde(default)]
        ttl: u8,
    },
    ChatEdit {
        target_msg_id: String,
        sender: String,
        text: String,
        #[serde(default)]
        relay_targets: Vec<String>,
        #[serde(default)]
        ttl: u8,
    },
    ChatReact {
        target_msg_id: String,
        sender: String,
        emoji: String,
        #[serde(default)]
        relay_targets: Vec<String>,
        #[serde(default)]
        ttl: u8,
    },
}

#[derive(Debug, Clone)]
struct UpnpMapping {
    control_url: String,
    service_type: String,
    external_port: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinkTransportState {
    Punching,
    DirectLan,
    DirectWan,
    FallbackSyncplay,
}

impl LinkTransportState {
    fn as_wire(self) -> &'static str {
        match self {
            Self::Punching => "punching",
            Self::DirectLan => "directLan",
            Self::DirectWan => "directWan",
            Self::FallbackSyncplay => "fallbackSyncplay",
        }
    }
}

struct PeerSession {
    username: String,
    beacon: P2pBeacon,
    crypto: P2pCryptoSession,
    reliable: ReliableChannel,
    state: LinkTransportState,
    started_at: Instant,
    active_addr: Option<SocketAddr>,
    last_rx_at: Option<Instant>,
    last_keepalive_at: Instant,
    last_repunch_at: Instant,
    rtt_ms: Option<u32>,
    pending_pings: HashMap<u64, Instant>,
    offered_file_sig: Option<String>,
    cant_relay_to: HashSet<String>,
}

#[derive(Debug)]
struct AlignJobState {
    file_sig: String,
    ref_peer_key: String,
    ref_duration_secs: f64,
    matches: Vec<ProbeMatch>,
    unmatched_room_secs: Vec<f64>,
    bisect_rounds: usize,
    scale_hint: Option<f64>,
    offset_hint: Option<f64>,
    status: String,
    summary: Option<String>,
    cancel: Arc<AtomicBool>,
    in_flight: bool,
}

enum InternalEvent {
    LocalBeaconReady {
        beacon: P2pBeacon,
        nat_mode: String,
        upnp: Option<UpnpMapping>,
    },
    LocalProbesReady {
        target_peer_key: Option<String>,
        file_sig: String,
        duration_secs: f64,
        probes: Vec<SparseAudioProbe>,
        is_bisect_response: bool,
    },
    FollowerMatchBatch {
        file_sig: String,
        matched: Vec<ProbeMatch>,
        unmatched: Vec<f64>,
        from_bisect: bool,
    },
}

pub struct P2pSessionHandle {
    pub cmd_tx: mpsc::Sender<P2pControlCmd>,
}

impl P2pSessionHandle {
    pub fn spawn(
        app: AppHandle,
        initial_username: String,
        network_opts: LocalPathOptions,
        beacon_tx: mpsc::Sender<String>,
        align_tx: mpsc::Sender<P2pAutoAlignment>,
        reaction_fallback_tx: mpsc::Sender<ReactionFallbackPacket>,
        chat_fallback_tx: mpsc::Sender<ChatFallbackPacket>,
        chat_react_fallback_tx: mpsc::Sender<ChatReactFallbackPacket>,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<P2pControlCmd>(128);
        tokio::spawn(run_p2p_actor(
            app,
            initial_username,
            network_opts,
            cmd_rx,
            beacon_tx,
            align_tx,
            reaction_fallback_tx,
            chat_fallback_tx,
            chat_react_fallback_tx,
        ));
        Self { cmd_tx }
    }

    pub fn try_send(&self, cmd: P2pControlCmd) {
        let _ = self.cmd_tx.try_send(cmd);
    }
}

fn epoch_ms(start: Instant) -> u64 {
    start.elapsed().as_millis() as u64
}

fn is_lan_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => (v6.segments()[0] & 0xfe00) == 0xfc00 || v6.is_unicast_link_local(),
    }
}

async fn discover_local_lan_v4() -> Option<Ipv4Addr> {
    for probe in ["1.1.1.1:80", "8.8.8.8:80", "192.168.1.1:80"] {
        if let Ok(s) = UdpSocket::bind("0.0.0.0:0").await {
            if s.connect(probe).await.is_ok() {
                if let Ok(SocketAddr::V4(v4)) = s.local_addr() {
                    let ip = *v4.ip();
                    if !ip.is_unspecified() && !ip.is_loopback() {
                        return Some(ip);
                    }
                }
            }
        }
    }
    None
}

async fn discover_local_global_v6() -> Option<Ipv6Addr> {
    if let Ok(s) = UdpSocket::bind("[::]:0").await {
        if s.connect("[2606:4700:4700::1111]:80").await.is_ok() {
            if let Ok(SocketAddr::V6(v6)) = s.local_addr() {
                let ip = *v6.ip();
                // Global unicast `2000::/3`
                if !ip.is_unspecified()
                    && !ip.is_loopback()
                    && (ip.segments()[0] & 0xe000) == 0x2000
                {
                    return Some(ip);
                }
            }
        }
    }
    None
}

async fn query_stun_candidates(sock: &UdpSocket) -> (Option<SocketAddr>, bool) {
    let mut tx_ids = [[0u8; 12]; 2];
    for tx in &mut tx_ids {
        fill_random_bytes(tx);
    }

    for (idx, host) in STUN_SERVERS.iter().enumerate() {
        if let Ok(addrs) = tokio::net::lookup_host(*host).await {
            if let Some(target) = addrs.into_iter().find(|a| a.is_ipv4()) {
                let req = build_stun_binding_request(tx_ids[idx]);
                let _ = sock.send_to(&req, target).await;
            }
        }
    }

    let mut mapped: [Option<SocketAddr>; 2] = [None, None];
    let mut buf = [0u8; 512];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(700);

    while tokio::time::Instant::now() < deadline && (mapped[0].is_none() || mapped[1].is_none()) {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rem, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, _src))) => {
                for i in 0..2 {
                    if mapped[i].is_none() {
                        if let Some(addr) = parse_stun_binding_response(&buf[..n], tx_ids[i]) {
                            mapped[i] = Some(addr);
                        }
                    }
                }
            }
            _ => break,
        }
    }

    let symmetric = matches!((mapped[0], mapped[1]), (Some(a), Some(b)) if a.port() != b.port());
    (mapped[0].or(mapped[1]), symmetric)
}

async fn http_plain_request(
    host: &str,
    port: u16,
    req_bytes: &[u8],
    timeout_ms: u64,
) -> Option<String> {
    let addr = format!("{host}:{port}");
    let mut stream =
        tokio::time::timeout(Duration::from_millis(timeout_ms), TcpStream::connect(&addr))
            .await
            .ok()?
            .ok()?;
    tokio::time::timeout(
        Duration::from_millis(timeout_ms),
        stream.write_all(req_bytes),
    )
    .await
    .ok()?
    .ok()?;
    let mut resp = Vec::with_capacity(8192);
    let mut chunk = [0u8; 2048];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(timeout_ms);
    while tokio::time::Instant::now() < deadline && resp.len() < 64 * 1024 {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rem, stream.read(&mut chunk)).await {
            Ok(Ok(0)) | Err(_) => break,
            Ok(Ok(n)) => resp.extend_from_slice(&chunk[..n]),
            Ok(Err(_)) => break,
        }
    }
    Some(String::from_utf8_lossy(&resp).into_owned())
}

async fn try_upnp_port_map(local_ip: Ipv4Addr, local_port: u16) -> Option<UpnpMapping> {
    let ssdp_sock = UdpSocket::bind("0.0.0.0:0").await.ok()?;
    let msearch = build_ssdp_msearch("urn:schemas-upnp-org:device:InternetGatewayDevice:1");
    let _ = ssdp_sock.send_to(&msearch, SSDP_MULTICAST_ADDR).await;

    let mut buf = [0u8; 2048];
    let (n, _) = tokio::time::timeout(Duration::from_millis(450), ssdp_sock.recv_from(&mut buf))
        .await
        .ok()?
        .ok()?;
    let location = parse_ssdp_location(&String::from_utf8_lossy(&buf[..n]))?;
    let (host, port, path) = parse_http_url_host_port_path(&location)?;
    let get_req =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    let xml = http_plain_request(&host, port, get_req.as_bytes(), 700).await?;
    let (control_url, service_type) = parse_igd_control_url(&location, &xml)?;
    let (ctrl_host, ctrl_port, ctrl_path) = parse_http_url_host_port_path(&control_url)?;

    let body =
        build_upnp_add_port_mapping_soap(&service_type, local_port, local_ip, local_port, 7200);
    let post_req = format!(
        "POST {ctrl_path} HTTP/1.1\r\n\
Host: {ctrl_host}:{ctrl_port}\r\n\
Content-Type: text/xml; charset=\"utf-8\"\r\n\
SOAPAction: \"{service_type}#AddPortMapping\"\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n{body}",
        body.len()
    );
    let soap_resp = http_plain_request(&ctrl_host, ctrl_port, post_req.as_bytes(), 700).await?;
    if soap_resp.starts_with("HTTP/1.1 200") || soap_resp.starts_with("HTTP/1.0 200") {
        Some(UpnpMapping {
            control_url,
            service_type,
            external_port: local_port,
        })
    } else {
        None
    }
}

async fn cleanup_upnp_mapping(mapping: UpnpMapping) {
    if let Some((host, port, path)) = parse_http_url_host_port_path(&mapping.control_url) {
        let body =
            build_upnp_delete_port_mapping_soap(&mapping.service_type, mapping.external_port);
        let req = format!(
            "POST {path} HTTP/1.1\r\n\
Host: {host}:{port}\r\n\
Content-Type: text/xml; charset=\"utf-8\"\r\n\
SOAPAction: \"{}#DeletePortMapping\"\r\n\
Content-Length: {}\r\n\
Connection: close\r\n\r\n{body}",
            mapping.service_type,
            body.len()
        );
        let _ = http_plain_request(&host, port, req.as_bytes(), 400).await;
    }
}

fn elect_reference_peer(
    local_username: &str,
    local_media: Option<&P2pLocalMedia>,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &HashMap<String, PeerSession>,
) -> Option<String> {
    let mut pool: Vec<(String, bool, bool)> = Vec::new(); // (canonical_key, is_ctrl, has_file)
    if let Some(lm) = local_media {
        if lm.identity.duration_secs.is_some_and(|d| d > 12.0) {
            let local_ctrl = participants
                .values()
                .find(|p| p.username.eq_ignore_ascii_case(local_username))
                .is_some_and(|p| p.is_controller);
            pool.push((local_username.to_ascii_lowercase(), local_ctrl, true));
        }
    }

    for (key, peer) in peers {
        if matches!(
            peer.state,
            LinkTransportState::DirectLan | LinkTransportState::DirectWan
        ) {
            if let Some(rp) = participants
                .values()
                .find(|p| p.username.eq_ignore_ascii_case(key))
            {
                let has_file = rp
                    .file
                    .as_ref()
                    .and_then(|f| f.duration)
                    .is_some_and(|d| d > 12.0);
                if has_file {
                    pool.push((key.clone(), rp.is_controller, true));
                }
            }
        }
    }

    if pool.len() < 2 {
        return None;
    }
    pool.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    pool.first().map(|(k, _, _)| k.clone())
}

fn to_file_identity(file: &WireFileInfo) -> FileIdentity {
    FileIdentity {
        name: file.name.clone(),
        size_bytes: file.size,
        size_hash: file.size_hash.clone(),
        duration_secs: file.duration,
        is_hashed: file.size.is_none() && file.size_hash.is_some(),
    }
}

fn emit_p2p_status(
    app: &AppHandle,
    nat_mode: &str,
    peers: &HashMap<String, PeerSession>,
    align_job: Option<&AlignJobState>,
) {
    let peer_dtos: Vec<P2pPeerStatusDto> = peers
        .values()
        .map(|p| {
            let key = p.username.to_ascii_lowercase();
            let (auto_state, summary) = match align_job {
                Some(job) if job.ref_peer_key == key || job.in_flight => {
                    (job.status.clone(), job.summary.clone())
                }
                Some(job) => (job.status.clone(), job.summary.clone()),
                None => ("idle".to_string(), None),
            };
            P2pPeerStatusDto {
                username: p.username.clone(),
                transport: p.state.as_wire().to_string(),
                rtt_ms: p.rtt_ms,
                auto_align_state: auto_state,
                summary,
            }
        })
        .collect();
    let _ = app.emit(
        "sync://p2p-status",
        P2pStatusPayload {
            nat_mode: nat_mode.to_string(),
            peers: peer_dtos,
        },
    );
}

async fn run_p2p_actor(
    app: AppHandle,
    initial_username: String,
    network_opts: LocalPathOptions,
    mut cmd_rx: mpsc::Receiver<P2pControlCmd>,
    beacon_tx: mpsc::Sender<String>,
    align_tx: mpsc::Sender<P2pAutoAlignment>,
    reaction_fallback_tx: mpsc::Sender<ReactionFallbackPacket>,
    chat_fallback_tx: mpsc::Sender<ChatFallbackPacket>,
    chat_react_fallback_tx: mpsc::Sender<ChatReactFallbackPacket>,
) {
    let Ok(sock_v4) = UdpSocket::bind("0.0.0.0:0").await.map(Arc::new) else {
        return;
    };
    let sock_v6 = UdpSocket::bind("[::]:0").await.ok().map(Arc::new);
    let local_port_v4 = sock_v4.local_addr().map(|a| a.port()).unwrap_or(0);
    let local_port_v6 = sock_v6
        .as_ref()
        .and_then(|s| s.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(0);

    let local_identity = P2pIdentity::generate();
    let local_pubkey = local_identity.pubkey;
    let local_session_id = local_identity.session_id;
    let start_instant = Instant::now();

    let (internal_tx, mut internal_rx) = mpsc::channel::<InternalEvent>(32);

    // Run non-blocking LAN + STUN + UPnP candidate discovery while Syncplay is already live
    {
        let sock_stun = Arc::clone(&sock_v4);
        let int_tx = internal_tx.clone();
        tokio::spawn(async move {
            let (lan_ip, global_v6, stun_res) = tokio::join!(
                discover_local_lan_v4(),
                discover_local_global_v6(),
                query_stun_candidates(&sock_stun),
            );
            let upnp = if let (Some(lip), true) = (lan_ip, local_port_v4 > 0) {
                try_upnp_port_map(lip, local_port_v4).await
            } else {
                None
            };
            let (stun_wan, raw_symmetric) = stun_res;
            let nat_symmetric = raw_symmetric && upnp.is_none();

            let mut cands = Vec::new();
            if let Some(ip) = lan_ip {
                if local_port_v4 > 0 {
                    cands.push(P2pCandidate {
                        kind: P2pCandidateKind::Lan,
                        addr: SocketAddr::new(IpAddr::V4(ip), local_port_v4),
                    });
                }
            }
            if let Some(wan_addr) = stun_wan {
                if !cands.iter().any(|c| c.addr == wan_addr) {
                    cands.push(P2pCandidate {
                        kind: P2pCandidateKind::Wan,
                        addr: wan_addr,
                    });
                }
            }
            if let Some(v6) = global_v6 {
                if local_port_v6 > 0 {
                    cands.push(P2pCandidate {
                        kind: P2pCandidateKind::Ipv6,
                        addr: SocketAddr::new(IpAddr::V6(v6), local_port_v6),
                    });
                }
            }

            let nat_mode = if upnp.is_some() {
                "upnp"
            } else if nat_symmetric {
                "symmetric"
            } else {
                "cone"
            }
            .to_string();

            let beacon = P2pBeacon {
                version: 1,
                nat_symmetric,
                pubkey: local_pubkey,
                session_id: local_session_id,
                candidates: cands,
            };
            let _ = int_tx
                .send(InternalEvent::LocalBeaconReady {
                    beacon,
                    nat_mode,
                    upnp,
                })
                .await;
        });
    }

    let mut local_username = initial_username;
    let mut local_media: Option<P2pLocalMedia> = None;
    let mut participants: HashMap<String, RoomParticipantUpdate> = HashMap::new();
    let mut peers: HashMap<String, PeerSession> = HashMap::new();
    let mut local_beacon_str: Option<String> = None;
    let mut nat_mode = "discovering".to_string();
    let mut upnp_mapping: Option<UpnpMapping> = None;
    let mut last_beacon_sent_at: Option<Instant> = None;
    let mut sent_beacon_to_room = false;

    let mut cached_ref_probes: Option<(String, Vec<SparseAudioProbe>)> = None;
    let mut ref_extract_cancel: Option<Arc<AtomicBool>> = None;
    let mut align_job: Option<AlignJobState> = None;
    let mut completed_sigs: HashSet<String> = HashSet::new();
    let mut force_realign_pending = false;
    let mut reaction_seq: u32 = 1;
    let mut seen_reactions: VecDeque<((String, u32), Instant)> = VecDeque::new();
    let mut seen_chat_msgs: VecDeque<((String, String), Instant)> = VecDeque::new();

    let mut tick = tokio::time::interval(Duration::from_millis(120));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut udp_buf_v4 = [0u8; 2048];
    let mut udp_buf_v6 = [0u8; 2048];

    loop {
        tokio::select! {
            cmd = cmd_rx.recv() => {
                let Some(cmd) = cmd else {
                    break;
                };
                match cmd {
                    P2pControlCmd::Shutdown => break,
                    P2pControlCmd::UpdateLocalUsername(name) => {
                        local_username = name;
                    }
                    P2pControlCmd::UpdateLocalMedia(media) => {
                        let sig_changed = media.as_ref().map(|m| m.file_sig.as_str())
                            != local_media.as_ref().map(|m| m.file_sig.as_str());
                        local_media = media;
                        if sig_changed {
                            cached_ref_probes = None;
                            if let Some(c) = ref_extract_cancel.take() {
                                c.store(true, Ordering::SeqCst);
                            }
                            if let Some(job) = align_job.take() {
                                job.cancel.store(true, Ordering::SeqCst);
                            }
                            completed_sigs.clear();
                            for p in peers.values_mut() {
                                p.offered_file_sig = None;
                            }
                        }
                        maybe_drive_auto_align(
                            &app,
                            network_opts,
                            &local_username,
                            local_media.as_ref(),
                            &participants,
                            &mut peers,
                            &sock_v4,
                            sock_v6.as_ref(),
                            start_instant,
                            &mut cached_ref_probes,
                            &mut ref_extract_cancel,
                            &mut align_job,
                            &completed_sigs,
                            &internal_tx,
                            false,
                        ).await;
                        emit_p2p_status(&app, &nat_mode, &peers, align_job.as_ref());
                    }
                    P2pControlCmd::UpdateParticipants(items) => {
                        participants.clear();
                        let mut active_keys = HashSet::new();
                        for item in items {
                            active_keys.insert(item.username.to_ascii_lowercase());
                            participants.insert(item.username.clone(), item);
                        }
                        peers.retain(|k, _| active_keys.contains(k));
                        if peers.is_empty() {
                            sent_beacon_to_room = false;
                        }
                        if active_keys.len() > 1 && !sent_beacon_to_room {
                            if let Some(ref msg) = local_beacon_str {
                                if last_beacon_sent_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(6)) {
                                    let _ = beacon_tx.try_send(msg.clone());
                                    last_beacon_sent_at = Some(Instant::now());
                                    sent_beacon_to_room = true;
                                }
                            }
                        }
                        maybe_drive_auto_align(
                            &app,
                            network_opts,
                            &local_username,
                            local_media.as_ref(),
                            &participants,
                            &mut peers,
                            &sock_v4,
                            sock_v6.as_ref(),
                            start_instant,
                            &mut cached_ref_probes,
                            &mut ref_extract_cancel,
                            &mut align_job,
                            &completed_sigs,
                            &internal_tx,
                            false,
                        ).await;
                        emit_p2p_status(&app, &nat_mode, &peers, align_job.as_ref());
                    }
                    P2pControlCmd::PeerJoined(username) => {
                        if !username.eq_ignore_ascii_case(&local_username) {
                            if let Some(ref msg) = local_beacon_str {
                                if last_beacon_sent_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(6)) {
                                    let _ = beacon_tx.try_send(msg.clone());
                                    last_beacon_sent_at = Some(Instant::now());
                                    sent_beacon_to_room = true;
                                }
                            }
                        }
                    }
                    P2pControlCmd::RemoteBeacon { username, raw_message } => {
                        if username.eq_ignore_ascii_case(&local_username) {
                            continue;
                        }
                        let Some(beacon) = decode_ep2_beacon(&raw_message) else {
                            continue;
                        };
                        if beacon.pubkey == local_pubkey && beacon.session_id == local_session_id {
                            continue;
                        }
                        let key = username.to_ascii_lowercase();
                        let same_session = peers.get(&key).is_some_and(|p| {
                            p.beacon.pubkey == beacon.pubkey && p.beacon.session_id == beacon.session_id
                        });
                        if same_session {
                            continue;
                        }

                        let crypto =
                            local_identity.establish_with(beacon.pubkey, beacon.session_id);
                        let mut session = PeerSession {
                            username: username.clone(),
                            beacon,
                            crypto,
                            reliable: ReliableChannel::new(),
                            state: LinkTransportState::Punching,
                            started_at: Instant::now(),
                            active_addr: None,
                            last_rx_at: None,
                            last_keepalive_at: Instant::now(),
                            last_repunch_at: Instant::now(),
                            rtt_ms: None,
                            pending_pings: HashMap::new(),
                            offered_file_sig: None,
                            cant_relay_to: HashSet::new(),
                        };
                        send_punch_burst(&mut session, &sock_v4, sock_v6.as_ref(), start_instant).await;
                        peers.insert(key, session);

                        // Echo our own beacon once if not yet shared recently so newcomer receives our candidates
                        if let Some(ref msg) = local_beacon_str {
                            if last_beacon_sent_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(6)) {
                                let _ = beacon_tx.try_send(msg.clone());
                                last_beacon_sent_at = Some(Instant::now());
                                sent_beacon_to_room = true;
                            }
                        }
                        emit_p2p_status(&app, &nat_mode, &peers, align_job.as_ref());
                    }
                    P2pControlCmd::TriggerRealign { force } => {
                        if force {
                            force_realign_pending = true;
                            completed_sigs.clear();
                            if let Some(job) = align_job.take() {
                                job.cancel.store(true, Ordering::SeqCst);
                            }
                            for p in peers.values_mut() {
                                p.offered_file_sig = None;
                            }
                            if let Some(ref lm) = local_media {
                                if let Some(ref_key) = elect_reference_peer(
                                    &local_username,
                                    Some(lm),
                                    &participants,
                                    &peers,
                                ) {
                                    if !ref_key.eq_ignore_ascii_case(&local_username) {
                                        if let Some(ref_peer) = peers.get_mut(&ref_key) {
                                            if let Ok(payload) =
                                                serde_json::to_vec(&P2pAppMessage::OfferRequest)
                                            {
                                                let _ = send_reliable_payload(
                                                    ref_peer,
                                                    &payload,
                                                    &sock_v4,
                                                    sock_v6.as_ref(),
                                                    epoch_ms(start_instant),
                                                )
                                                .await;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        maybe_drive_auto_align(
                            &app,
                            network_opts,
                            &local_username,
                            local_media.as_ref(),
                            &participants,
                            &mut peers,
                            &sock_v4,
                            sock_v6.as_ref(),
                            start_instant,
                            &mut cached_ref_probes,
                            &mut ref_extract_cancel,
                            &mut align_job,
                            &completed_sigs,
                            &internal_tx,
                            force,
                        ).await;
                        emit_p2p_status(&app, &nat_mode, &peers, align_job.as_ref());
                    }
                    P2pControlCmd::SendReaction {
                        emoji,
                        avatar_id,
                        count,
                    } => {
                        let Some(clean_emoji) = sanitize_reaction_emoji(&emoji) else {
                            continue;
                        };
                        let clean_avatar = sanitize_avatar_id(&avatar_id);
                        let clean_count = count.clamp(1, MAX_REACTION_BURST_COUNT);

                        let direct_keys: Vec<String> = peers
                            .iter()
                            .filter(|(_, p)| {
                                matches!(
                                    p.state,
                                    LinkTransportState::DirectLan | LinkTransportState::DirectWan
                                ) && p.active_addr.is_some()
                            })
                            .map(|(k, _)| k.clone())
                            .collect();

                        let mut non_direct_keys: Vec<String> = Vec::new();
                        for item in participants.values() {
                            if item.username.eq_ignore_ascii_case(&local_username) {
                                continue;
                            }
                            let key = item.username.to_ascii_lowercase();
                            if !direct_keys.contains(&key) && !non_direct_keys.contains(&key) {
                                non_direct_keys.push(key);
                            }
                        }

                        if direct_keys.is_empty() && non_direct_keys.is_empty() {
                            continue;
                        }

                        reaction_seq = reaction_seq.wrapping_add(1).max(1);
                        let seq = reaction_seq;
                        record_seen_reaction(
                            &mut seen_reactions,
                            &local_username.to_ascii_lowercase(),
                            seq,
                        );

                        let relay_targets: Vec<String> = non_direct_keys
                            .iter()
                            .filter(|target| {
                                direct_keys.iter().any(|dk| {
                                    peers
                                        .get(dk)
                                        .is_some_and(|p| !p.cant_relay_to.contains(*target))
                                })
                            })
                            .take(16)
                            .cloned()
                            .collect();

                        let fallback_needed = !non_direct_keys.is_empty()
                            && (direct_keys.is_empty()
                                || non_direct_keys
                                    .iter()
                                    .any(|t| !relay_targets.contains(t)));

                        if !direct_keys.is_empty() {
                            let dmsg = P2pDatagramMessage::Reaction {
                                sender: local_username.clone(),
                                avatar_id: clean_avatar.clone(),
                                emoji: clean_emoji.clone(),
                                count: clean_count,
                                seq,
                                relay_targets,
                                ttl: 1,
                            };
                            for dk in &direct_keys {
                                if let Some(peer) = peers.get_mut(dk) {
                                    let _ = send_datagram_message(
                                        peer,
                                        &dmsg,
                                        &sock_v4,
                                        sock_v6.as_ref(),
                                    )
                                    .await;
                                }
                            }
                        }

                        if fallback_needed {
                            let _ = reaction_fallback_tx.try_send(ReactionFallbackPacket {
                                avatar_id: clean_avatar,
                                emoji: clean_emoji,
                                count: clean_count,
                                seq,
                            });
                        }
                    }
                    P2pControlCmd::SendChat {
                        id,
                        text,
                        avatar_id,
                        reply_to_id,
                    } => {
                        let clean_id = sanitize_chat_id(&id);
                        let Some(clean_text) = sanitize_chat_text(&text) else {
                            continue;
                        };
                        if clean_id.is_empty() {
                            continue;
                        }
                        let clean_avatar = sanitize_avatar_id(&avatar_id);
                        let clean_reply = reply_to_id
                            .as_deref()
                            .map(sanitize_chat_id)
                            .filter(|s| !s.is_empty());

                        let direct_keys: Vec<String> = peers
                            .iter()
                            .filter(|(_, p)| {
                                matches!(
                                    p.state,
                                    LinkTransportState::DirectLan | LinkTransportState::DirectWan
                                ) && p.active_addr.is_some()
                            })
                            .map(|(k, _)| k.clone())
                            .collect();

                        let mut non_direct_keys: Vec<String> = Vec::new();
                        for item in participants.values() {
                            if item.username.eq_ignore_ascii_case(&local_username) {
                                continue;
                            }
                            let key = item.username.to_ascii_lowercase();
                            if !direct_keys.contains(&key) && !non_direct_keys.contains(&key) {
                                non_direct_keys.push(key);
                            }
                        }

                        if direct_keys.is_empty() && non_direct_keys.is_empty() {
                            continue;
                        }

                        record_seen_chat_msg(
                            &mut seen_chat_msgs,
                            &local_username.to_ascii_lowercase(),
                            &clean_id,
                        );

                        let relay_targets: Vec<String> = non_direct_keys
                            .iter()
                            .filter(|target| {
                                direct_keys.iter().any(|dk| {
                                    peers
                                        .get(dk)
                                        .is_some_and(|p| !p.cant_relay_to.contains(*target))
                                })
                            })
                            .take(16)
                            .cloned()
                            .collect();

                        let fallback_needed = !non_direct_keys.is_empty()
                            && (direct_keys.is_empty()
                                || non_direct_keys
                                    .iter()
                                    .any(|t| !relay_targets.contains(t)));

                        if !direct_keys.is_empty() {
                            let app_msg = P2pAppMessage::ChatMessage {
                                id: clean_id.clone(),
                                sender: local_username.clone(),
                                avatar_id: clean_avatar.clone(),
                                text: clean_text.clone(),
                                reply_to_id: clean_reply.clone(),
                                relay_targets,
                                ttl: 1,
                            };
                            if let Ok(payload) = serde_json::to_vec(&app_msg) {
                                let now_ms = epoch_ms(start_instant);
                                for dk in &direct_keys {
                                    if let Some(peer) = peers.get_mut(dk) {
                                        let _ = send_reliable_payload(
                                            peer,
                                            &payload,
                                            &sock_v4,
                                            sock_v6.as_ref(),
                                            now_ms,
                                        )
                                        .await;
                                    }
                                }
                            }
                        }

                        if fallback_needed {
                            let _ = chat_fallback_tx.try_send(ChatFallbackPacket {
                                msg_id: clean_id,
                                avatar_id: clean_avatar,
                                reply_to_id: clean_reply,
                                text: clean_text,
                                is_edit: false,
                            });
                        }
                    }
                    P2pControlCmd::SendChatEdit {
                        target_msg_id,
                        text,
                    } => {
                        let clean_id = sanitize_chat_id(&target_msg_id);
                        let Some(clean_text) = sanitize_chat_text(&text) else {
                            continue;
                        };
                        if clean_id.is_empty() {
                            continue;
                        }
                        let (direct_keys, relay_targets, fallback_needed) =
                            compute_chat_routing(&peers, &participants, &local_username);
                        if !direct_keys.is_empty() {
                            let app_msg = P2pAppMessage::ChatEdit {
                                target_msg_id: clean_id.clone(),
                                sender: local_username.clone(),
                                text: clean_text.clone(),
                                relay_targets,
                                ttl: 1,
                            };
                            if let Ok(payload) = serde_json::to_vec(&app_msg) {
                                let now_ms = epoch_ms(start_instant);
                                for dk in &direct_keys {
                                    if let Some(peer) = peers.get_mut(dk) {
                                        let _ = send_reliable_payload(
                                            peer,
                                            &payload,
                                            &sock_v4,
                                            sock_v6.as_ref(),
                                            now_ms,
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                        if fallback_needed {
                            let _ = chat_fallback_tx.try_send(ChatFallbackPacket {
                                msg_id: clean_id,
                                avatar_id: String::new(),
                                reply_to_id: None,
                                text: clean_text,
                                is_edit: true,
                            });
                        }
                    }
                    P2pControlCmd::SendChatReact {
                        target_msg_id,
                        emoji,
                    } => {
                        let clean_id = sanitize_chat_id(&target_msg_id);
                        let Some(clean_emoji) = sanitize_reaction_emoji(&emoji) else {
                            continue;
                        };
                        if clean_id.is_empty() {
                            continue;
                        }
                        let (direct_keys, relay_targets, fallback_needed) =
                            compute_chat_routing(&peers, &participants, &local_username);
                        if !direct_keys.is_empty() {
                            let app_msg = P2pAppMessage::ChatReact {
                                target_msg_id: clean_id.clone(),
                                sender: local_username.clone(),
                                emoji: clean_emoji.clone(),
                                relay_targets,
                                ttl: 1,
                            };
                            if let Ok(payload) = serde_json::to_vec(&app_msg) {
                                let now_ms = epoch_ms(start_instant);
                                for dk in &direct_keys {
                                    if let Some(peer) = peers.get_mut(dk) {
                                        let _ = send_reliable_payload(
                                            peer,
                                            &payload,
                                            &sock_v4,
                                            sock_v6.as_ref(),
                                            now_ms,
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                        if fallback_needed {
                            let _ = chat_react_fallback_tx.try_send(ChatReactFallbackPacket {
                                msg_id: clean_id,
                                emoji: clean_emoji,
                            });
                        }
                    }
                    P2pControlCmd::SendTyping { is_typing } => {
                        let direct_keys: Vec<String> = peers
                            .iter()
                            .filter(|(_, p)| {
                                matches!(
                                    p.state,
                                    LinkTransportState::DirectLan | LinkTransportState::DirectWan
                                ) && p.active_addr.is_some()
                            })
                            .map(|(k, _)| k.clone())
                            .collect();
                        if !direct_keys.is_empty() {
                            let dmsg = P2pDatagramMessage::ChatTyping {
                                sender: local_username.clone(),
                                is_typing,
                            };
                            for dk in &direct_keys {
                                if let Some(peer) = peers.get_mut(dk) {
                                    let _ = send_datagram_message(
                                        peer,
                                        &dmsg,
                                        &sock_v4,
                                        sock_v6.as_ref(),
                                    )
                                    .await;
                                }
                            }
                        }
                    }
                }
            }
            evt = internal_rx.recv() => {
                let Some(evt) = evt else { continue };
                match evt {
                    InternalEvent::LocalBeaconReady { beacon, nat_mode: nm, upnp } => {
                        nat_mode = nm;
                        upnp_mapping = upnp;
                        let msg = encode_ep2_beacon(&beacon);
                        local_beacon_str = Some(msg.clone());
                        if participants.len() > 1 && !sent_beacon_to_room {
                            let _ = beacon_tx.try_send(msg);
                            last_beacon_sent_at = Some(Instant::now());
                            sent_beacon_to_room = true;
                        }
                        emit_p2p_status(&app, &nat_mode, &peers, align_job.as_ref());
                    }
                    InternalEvent::LocalProbesReady {
                        target_peer_key,
                        file_sig,
                        duration_secs,
                        probes,
                        is_bisect_response,
                    } => {
                        if !is_bisect_response {
                            ref_extract_cancel = None;
                        }
                        if local_media.as_ref().is_none_or(|m| m.file_sig != file_sig) || probes.is_empty() {
                            continue;
                        }
                        let wire_probes: Vec<SparseAudioProbeWire> =
                            probes.iter().map(SparseAudioProbe::to_wire).collect();
                        if !is_bisect_response {
                            cached_ref_probes = Some((file_sig.clone(), probes));
                        }
                        let app_msg = if is_bisect_response {
                            P2pAppMessage::NeedlesResponse {
                                file_sig: file_sig.clone(),
                                probes: wire_probes,
                            }
                        } else {
                            P2pAppMessage::ProbeOffer {
                                file_sig: file_sig.clone(),
                                ref_duration_secs: duration_secs,
                                probes: wire_probes,
                            }
                        };
                        if let Ok(payload) = serde_json::to_vec(&app_msg) {
                            let now_ms = epoch_ms(start_instant);
                            for (key, peer) in peers.iter_mut() {
                                if let Some(ref only_key) = target_peer_key {
                                    if key != only_key {
                                        continue;
                                    }
                                }
                                if !is_bisect_response {
                                    peer.offered_file_sig = Some(file_sig.clone());
                                }
                                let _ = send_reliable_payload(
                                    peer,
                                    &payload,
                                    &sock_v4,
                                    sock_v6.as_ref(),
                                    now_ms,
                                )
                                .await;
                            }
                        }
                    }
                    InternalEvent::FollowerMatchBatch {
                        file_sig,
                        matched,
                        unmatched,
                        from_bisect,
                    } => {
                        let Some(ref mut job) = align_job else {
                            continue;
                        };
                        if job.file_sig != file_sig {
                            continue;
                        }
                        job.in_flight = false;
                        for m in matched {
                            if job.matches.is_empty() {
                                job.scale_hint = Some(m.scale_used);
                                job.offset_hint = Some(m.local_secs - m.scale_used * m.room_secs);
                            }
                            job.matches.push(m);
                        }
                        job.unmatched_room_secs.extend(unmatched);
                        if from_bisect {
                            job.bisect_rounds += 1;
                        }

                        let local_dur = local_media
                            .as_ref()
                            .and_then(|m| m.identity.duration_secs)
                            .unwrap_or(job.ref_duration_secs);
                        match analyze_probe_matches(
                            &job.matches,
                            &job.unmatched_room_secs,
                            local_dur.max(job.ref_duration_secs),
                            job.bisect_rounds,
                        ) {
                            AlignmentAnalysis::Linear { transform, confidence } => {
                                let summary = if (transform.scale - 1.0).abs() > 0.002 {
                                    format!(
                                        "Auto-synced FPS ({:.3}x) & {:+.2}s",
                                        transform.scale, transform.offset_secs
                                    )
                                } else {
                                    format!("Auto-synced ({:+.2}s)", transform.offset_secs)
                                };
                                job.status = "alignedLinear".to_string();
                                job.summary = Some(summary.clone());
                                completed_sigs.insert(file_sig.clone());
                                let _ = align_tx
                                    .send(P2pAutoAlignment {
                                        file_sig,
                                        transform,
                                        segments: Vec::new(),
                                        confidence,
                                        summary,
                                    })
                                    .await;
                            }
                            AlignmentAnalysis::NeedsCutBisect {
                                provisional_transform,
                                bisect_room_secs,
                                ..
                            } => {
                                let prov_summary = format!(
                                    "Synced ({:+.2}s) · locating cut...",
                                    provisional_transform.offset_secs
                                );
                                job.status = "probing".to_string();
                                job.summary = Some(prov_summary.clone());
                                let _ = align_tx
                                    .send(P2pAutoAlignment {
                                        file_sig: file_sig.clone(),
                                        transform: provisional_transform,
                                        segments: Vec::new(),
                                        confidence: 0.5,
                                        summary: prov_summary,
                                    })
                                    .await;
                                if let Some(ref_peer) = peers.get_mut(&job.ref_peer_key) {
                                    if let Ok(payload) = serde_json::to_vec(&P2pAppMessage::NeedlesRequest {
                                        file_sig,
                                        timestamps_secs: vec![bisect_room_secs],
                                    }) {
                                        job.in_flight = true;
                                        let _ = send_reliable_payload(
                                            ref_peer,
                                            &payload,
                                            &sock_v4,
                                            sock_v6.as_ref(),
                                            epoch_ms(start_instant),
                                        )
                                        .await;
                                    }
                                }
                            }
                            AlignmentAnalysis::Piecewise {
                                transform,
                                segments,
                                confidence,
                            } => {
                                let summary = format!(
                                    "Auto-synced {} scene segments",
                                    segments.len()
                                );
                                job.status = "alignedPiecewise".to_string();
                                job.summary = Some(summary.clone());
                                completed_sigs.insert(file_sig.clone());
                                let _ = align_tx
                                    .send(P2pAutoAlignment {
                                        file_sig,
                                        transform,
                                        segments,
                                        confidence,
                                        summary,
                                    })
                                    .await;
                            }
                            AlignmentAnalysis::Inconclusive => {
                                job.status = "inconclusive".to_string();
                                job.summary = Some("Audio didn't match (different dub?)".to_string());
                                completed_sigs.insert(file_sig);
                            }
                        }
                        emit_p2p_status(&app, &nat_mode, &peers, align_job.as_ref());
                    }
                }
            }
            Ok((n, src)) = sock_v4.recv_from(&mut udp_buf_v4) => {
                if let Some(evt) = handle_udp_packet(
                    &mut peers,
                    &udp_buf_v4[..n],
                    src,
                    &sock_v4,
                    start_instant,
                ).await {
                    dispatch_udp_event(
                        evt,
                        &app,
                        network_opts,
                        &local_username,
                        local_media.as_ref(),
                        &participants,
                        &mut peers,
                        &sock_v4,
                        sock_v6.as_ref(),
                        start_instant,
                        &mut cached_ref_probes,
                        &mut ref_extract_cancel,
                        &mut align_job,
                        &completed_sigs,
                        &internal_tx,
                        &mut force_realign_pending,
                        &mut seen_reactions,
                        &mut seen_chat_msgs,
                        &nat_mode,
                    ).await;
                }
            }
            Ok((n, src)) = async {
                match sock_v6.as_ref() {
                    Some(s) => s.recv_from(&mut udp_buf_v6).await,
                    None => std::future::pending().await,
                }
            } => {
                if let Some(ref s6) = sock_v6 {
                    if let Some(evt) = handle_udp_packet(
                        &mut peers,
                        &udp_buf_v6[..n],
                        src,
                        s6,
                        start_instant,
                    ).await {
                        dispatch_udp_event(
                            evt,
                            &app,
                            network_opts,
                            &local_username,
                            local_media.as_ref(),
                            &participants,
                            &mut peers,
                            &sock_v4,
                            sock_v6.as_ref(),
                            start_instant,
                            &mut cached_ref_probes,
                            &mut ref_extract_cancel,
                            &mut align_job,
                            &completed_sigs,
                            &internal_tx,
                            &mut force_realign_pending,
                            &mut seen_reactions,
                            &mut seen_chat_msgs,
                            &nat_mode,
                        ).await;
                    }
                }
            }
            _ = tick.tick() => {
                let now_ms = epoch_ms(start_instant);
                let mut status_dirty = false;
                let mut newly_connected = false;
                for peer in peers.values_mut() {
                    match peer.state {
                        LinkTransportState::Punching => {
                            let elapsed = peer.started_at.elapsed();
                            if elapsed >= Duration::from_secs(5) {
                                peer.state = LinkTransportState::FallbackSyncplay;
                                peer.last_repunch_at = Instant::now();
                                status_dirty = true;
                            } else if elapsed < Duration::from_millis(2500) || (now_ms % 480) < 130 {
                                send_punch_burst(peer, &sock_v4, sock_v6.as_ref(), start_instant).await;
                            }
                        }
                        LinkTransportState::DirectLan | LinkTransportState::DirectWan => {
                            let retx = peer.reliable.collect_retransmits(now_ms, 260);
                            if !retx.is_empty() {
                                if let Some(addr) = peer.active_addr {
                                    for frame in retx {
                                        if let Some(pkt) = peer.crypto.seal(&frame) {
                                            let _ = send_via_matching_sock(&sock_v4, sock_v6.as_ref(), &pkt, addr).await;
                                        }
                                    }
                                }
                            }
                            if peer.last_keepalive_at.elapsed() >= Duration::from_secs(5) {
                                peer.last_keepalive_at = Instant::now();
                                let ping_ts = now_ms;
                                peer.pending_pings.insert(ping_ts, Instant::now());
                                if let Some(addr) = peer.active_addr {
                                    if let Some(pkt) = peer.crypto.seal(&P2pWireFrame::KeepAlive { ts_ms: ping_ts }) {
                                        let _ = send_via_matching_sock(&sock_v4, sock_v6.as_ref(), &pkt, addr).await;
                                    }
                                }
                            }
                            if peer.last_repunch_at.elapsed() >= Duration::from_secs(20) {
                                peer.last_repunch_at = Instant::now();
                                peer.cant_relay_to.clear();
                            }
                            newly_connected |= peer.last_rx_at.is_some_and(|t| t.elapsed() < Duration::from_millis(300));
                        }
                        LinkTransportState::FallbackSyncplay => {
                            if peer.last_repunch_at.elapsed() >= Duration::from_secs(20) {
                                peer.last_repunch_at = Instant::now();
                                send_punch_burst(peer, &sock_v4, sock_v6.as_ref(), start_instant).await;
                            }
                        }
                    }
                }
                if newly_connected || status_dirty {
                    maybe_drive_auto_align(
                        &app,
                        network_opts,
                        &local_username,
                        local_media.as_ref(),
                        &participants,
                        &mut peers,
                        &sock_v4,
                        sock_v6.as_ref(),
                        start_instant,
                        &mut cached_ref_probes,
                        &mut ref_extract_cancel,
                        &mut align_job,
                        &completed_sigs,
                        &internal_tx,
                        false,
                    ).await;
                    emit_p2p_status(&app, &nat_mode, &peers, align_job.as_ref());
                }
            }
        }
    }

    if let Some(c) = ref_extract_cancel.take() {
        c.store(true, Ordering::SeqCst);
    }
    if let Some(job) = align_job.take() {
        job.cancel.store(true, Ordering::SeqCst);
    }
    if let Some(mapping) = upnp_mapping {
        tokio::spawn(cleanup_upnp_mapping(mapping));
    }
}

fn record_seen_reaction(
    seen: &mut VecDeque<((String, u32), Instant)>,
    sender_key: &str,
    seq: u32,
) -> bool {
    let now = Instant::now();
    while let Some((_, ts)) = seen.front() {
        if now.duration_since(*ts) >= Duration::from_secs(15) || seen.len() >= 256 {
            seen.pop_front();
        } else {
            break;
        }
    }
    if seen
        .iter()
        .any(|((s, id), _)| *id == seq && s == sender_key)
    {
        return false;
    }
    seen.push_back(((sender_key.to_string(), seq), now));
    true
}

fn record_seen_chat_msg(
    seen: &mut VecDeque<((String, String), Instant)>,
    sender_key: &str,
    msg_id: &str,
) -> bool {
    let now = Instant::now();
    while let Some((_, ts)) = seen.front() {
        if now.duration_since(*ts) >= Duration::from_secs(120) || seen.len() >= 256 {
            seen.pop_front();
        } else {
            break;
        }
    }
    if seen
        .iter()
        .any(|((s, id), _)| s == sender_key && id == msg_id)
    {
        return false;
    }
    seen.push_back(((sender_key.to_string(), msg_id.to_string()), now));
    true
}

fn compute_chat_routing(
    peers: &HashMap<String, PeerSession>,
    participants: &HashMap<String, RoomParticipantUpdate>,
    local_username: &str,
) -> (Vec<String>, Vec<String>, bool) {
    let direct_keys: Vec<String> = peers
        .iter()
        .filter(|(_, p)| {
            matches!(
                p.state,
                LinkTransportState::DirectLan | LinkTransportState::DirectWan
            ) && p.active_addr.is_some()
        })
        .map(|(k, _)| k.clone())
        .collect();

    let mut non_direct_keys: Vec<String> = Vec::new();
    for item in participants.values() {
        if item.username.eq_ignore_ascii_case(local_username) {
            continue;
        }
        let key = item.username.to_ascii_lowercase();
        if !direct_keys.contains(&key) && !non_direct_keys.contains(&key) {
            non_direct_keys.push(key);
        }
    }

    let relay_targets: Vec<String> = non_direct_keys
        .iter()
        .filter(|target| {
            direct_keys.iter().any(|dk| {
                peers
                    .get(dk)
                    .is_some_and(|p| !p.cant_relay_to.contains(*target))
            })
        })
        .take(16)
        .cloned()
        .collect();

    let fallback_needed = !non_direct_keys.is_empty()
        && (direct_keys.is_empty() || non_direct_keys.iter().any(|t| !relay_targets.contains(t)));

    (direct_keys, relay_targets, fallback_needed)
}

async fn forward_chat_relay(
    peers: &mut HashMap<String, PeerSession>,
    relay_targets: Vec<String>,
    peer_key: &str,
    sender_key: &str,
    local_username: &str,
    fwd: &P2pAppMessage,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    start_instant: Instant,
) {
    let Ok(payload) = serde_json::to_vec(fwd) else {
        return;
    };
    let now_ms = epoch_ms(start_instant);
    for raw_target in relay_targets.into_iter().take(16) {
        let target_key = raw_target.to_ascii_lowercase();
        if target_key == peer_key
            || target_key == sender_key
            || target_key == local_username.to_ascii_lowercase()
        {
            continue;
        }
        if let Some(target_peer) = peers.get_mut(&target_key) {
            if matches!(
                target_peer.state,
                LinkTransportState::DirectLan | LinkTransportState::DirectWan
            ) && target_peer.active_addr.is_some()
            {
                let _ =
                    send_reliable_payload(target_peer, &payload, sock_v4, sock_v6, now_ms).await;
            }
        }
    }
}

async fn send_datagram_message(
    peer: &mut PeerSession,
    msg: &P2pDatagramMessage,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
) -> bool {
    let Some(addr) = peer.active_addr else {
        return false;
    };
    let Ok(data) = serde_json::to_vec(msg) else {
        return false;
    };
    if data.is_empty() || data.len() > MAX_P2P_DATAGRAM_BYTES {
        return false;
    }
    let Some(pkt) = peer.crypto.seal(&P2pWireFrame::Datagram { data }) else {
        return false;
    };
    send_via_matching_sock(sock_v4, sock_v6, &pkt, addr)
        .await
        .is_ok()
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_udp_event(
    evt: UdpPacketEvent,
    app: &AppHandle,
    network_opts: LocalPathOptions,
    local_username: &str,
    local_media: Option<&P2pLocalMedia>,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &mut HashMap<String, PeerSession>,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    start_instant: Instant,
    cached_ref_probes: &mut Option<(String, Vec<SparseAudioProbe>)>,
    ref_extract_cancel: &mut Option<Arc<AtomicBool>>,
    align_job: &mut Option<AlignJobState>,
    completed_sigs: &HashSet<String>,
    internal_tx: &mpsc::Sender<InternalEvent>,
    force_realign_pending: &mut bool,
    seen_reactions: &mut VecDeque<((String, u32), Instant)>,
    seen_chat_msgs: &mut VecDeque<((String, String), Instant)>,
    nat_mode: &str,
) {
    match evt {
        UdpPacketEvent::App(peer_key, msg) => {
            handle_peer_app_msg(
                app,
                network_opts,
                &peer_key,
                msg,
                local_username,
                local_media,
                participants,
                peers,
                sock_v4,
                sock_v6,
                start_instant,
                cached_ref_probes,
                ref_extract_cancel,
                align_job,
                completed_sigs,
                internal_tx,
                std::mem::take(force_realign_pending),
                seen_chat_msgs,
            )
            .await;
            emit_p2p_status(app, nat_mode, peers, align_job.as_ref());
        }
        UdpPacketEvent::Datagram(from_key, dmsg) => match dmsg {
            P2pDatagramMessage::ChatTyping { sender, is_typing } => {
                let sender_display: String = if sender.trim().is_empty() {
                    peers
                        .get(&from_key)
                        .map(|p| p.username.clone())
                        .unwrap_or_else(|| from_key.clone())
                } else {
                    sender.trim().chars().take(32).collect()
                };
                if sender_display.eq_ignore_ascii_case(local_username) {
                    return;
                }
                let sender_known = sender_display.to_ascii_lowercase() == from_key
                    || participants
                        .values()
                        .any(|p| p.username.eq_ignore_ascii_case(&sender_display));
                if !sender_known {
                    return;
                }
                let _ = app.emit(
                    "sync://chat-typing",
                    serde_json::json!({
                        "username": sender_display,
                        "isTyping": is_typing,
                    }),
                );
            }
            P2pDatagramMessage::RelayUnavailable { targets } => {
                if let Some(peer) = peers.get_mut(&from_key) {
                    for target in targets.into_iter().take(16) {
                        if peer.cant_relay_to.len() < 32 {
                            peer.cant_relay_to.insert(target.to_ascii_lowercase());
                        }
                    }
                }
            }
            P2pDatagramMessage::Reaction {
                sender,
                avatar_id,
                emoji,
                count,
                seq,
                relay_targets,
                ttl,
            } => {
                let Some(clean_emoji) = sanitize_reaction_emoji(&emoji) else {
                    return;
                };
                let clean_avatar = sanitize_avatar_id(&avatar_id);
                let clean_count = count.clamp(1, MAX_REACTION_BURST_COUNT);

                let sender_display = if sender.trim().is_empty() {
                    peers
                        .get(&from_key)
                        .map(|p| p.username.clone())
                        .unwrap_or_else(|| from_key.clone())
                } else {
                    sender.trim().chars().take(32).collect()
                };

                let sender_key = sender_display.to_ascii_lowercase();
                if sender_display.eq_ignore_ascii_case(local_username) {
                    return;
                }
                let sender_known = sender_key == from_key
                    || participants
                        .values()
                        .any(|p| p.username.eq_ignore_ascii_case(&sender_display));
                if !sender_known {
                    return;
                }

                if record_seen_reaction(seen_reactions, &sender_key, seq) {
                    let _ = app.emit(
                        "sync://reaction",
                        serde_json::json!({
                            "username": sender_display,
                            "avatarId": clean_avatar,
                            "emoji": clean_emoji,
                            "count": clean_count,
                            "via": if ttl == 0 { "p2pRelay" } else { "p2p" },
                        }),
                    );
                }

                if ttl > 0 && !relay_targets.is_empty() {
                    let mut unavailable = Vec::new();
                    for raw_target in relay_targets.into_iter().take(16) {
                        let target_key = raw_target.to_ascii_lowercase();
                        if target_key == from_key
                            || target_key == sender_key
                            || target_key == local_username.to_ascii_lowercase()
                        {
                            continue;
                        }
                        let forwarded = if let Some(target_peer) = peers.get_mut(&target_key) {
                            if matches!(
                                target_peer.state,
                                LinkTransportState::DirectLan | LinkTransportState::DirectWan
                            ) && target_peer.active_addr.is_some()
                            {
                                let fwd = P2pDatagramMessage::Reaction {
                                    sender: sender_display.clone(),
                                    avatar_id: clean_avatar.clone(),
                                    emoji: clean_emoji.clone(),
                                    count: clean_count,
                                    seq,
                                    relay_targets: Vec::new(),
                                    ttl: ttl - 1,
                                };
                                send_datagram_message(target_peer, &fwd, sock_v4, sock_v6).await
                            } else {
                                false
                            }
                        } else {
                            false
                        };
                        if !forwarded
                            && participants
                                .values()
                                .any(|p| p.username.eq_ignore_ascii_case(&target_key))
                        {
                            unavailable.push(target_key);
                        }
                    }

                    if !unavailable.is_empty() {
                        if let Some(origin_peer) = peers.get_mut(&from_key) {
                            let nack = P2pDatagramMessage::RelayUnavailable {
                                targets: unavailable,
                            };
                            let _ =
                                send_datagram_message(origin_peer, &nack, sock_v4, sock_v6).await;
                        }
                    }
                }
            }
        },
    }
}

async fn send_via_matching_sock(
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    pkt: &[u8],
    addr: SocketAddr,
) -> std::io::Result<usize> {
    match addr {
        SocketAddr::V4(_) => sock_v4.send_to(pkt, addr).await,
        SocketAddr::V6(_) => {
            if let Some(s6) = sock_v6 {
                s6.send_to(pkt, addr).await
            } else {
                Err(std::io::Error::new(
                    std::io::ErrorKind::AddrNotAvailable,
                    "No IPv6 socket",
                ))
            }
        }
    }
}

async fn send_punch_burst(
    peer: &mut PeerSession,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    start_instant: Instant,
) {
    let ts_ms = epoch_ms(start_instant);
    peer.pending_pings.insert(ts_ms, Instant::now());
    if peer.pending_pings.len() > 24 {
        let cutoff = Instant::now() - Duration::from_secs(6);
        peer.pending_pings.retain(|_, t| *t >= cutoff);
    }
    if let Some(pkt) = peer.crypto.seal(&P2pWireFrame::PunchPing { ts_ms }) {
        for cand in &peer.beacon.candidates {
            let _ = send_via_matching_sock(sock_v4, sock_v6, &pkt, cand.addr).await;
        }
    }
}

async fn send_reliable_payload(
    peer: &mut PeerSession,
    payload: &[u8],
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    now_ms: u64,
) -> bool {
    let Some(addr) = peer.active_addr else {
        return false;
    };
    let Some((msg_id, frames)) = peer.reliable.enqueue_message(payload) else {
        return false;
    };
    peer.reliable.mark_sent(msg_id, now_ms);
    for frame in frames {
        if let Some(pkt) = peer.crypto.seal(&frame) {
            let _ = send_via_matching_sock(sock_v4, sock_v6, &pkt, addr).await;
        }
    }
    true
}

async fn handle_udp_packet(
    peers: &mut HashMap<String, PeerSession>,
    buf: &[u8],
    src: SocketAddr,
    reply_sock: &UdpSocket,
    start_instant: Instant,
) -> Option<UdpPacketEvent> {
    if buf.len() < 12 + 16 {
        return None;
    }
    let tag: [u8; 4] = buf[..4].try_into().ok()?;
    let (peer_key, peer) = peers.iter_mut().find(|(_, p)| p.crypto.rx_tag == tag)?;
    let peer_key = peer_key.clone();
    let frame = peer.crypto.open(buf)?;

    peer.last_rx_at = Some(Instant::now());
    let keep_existing_lan = peer
        .active_addr
        .is_some_and(|a| is_lan_ip(a.ip()) && !is_lan_ip(src.ip()));
    if !keep_existing_lan {
        peer.active_addr = Some(src);
    }
    let active = peer.active_addr.unwrap_or(src);

    match frame {
        P2pWireFrame::PunchPing { ts_ms } => {
            if matches!(
                peer.state,
                LinkTransportState::Punching | LinkTransportState::FallbackSyncplay
            ) {
                peer.state = if is_lan_ip(active.ip()) {
                    LinkTransportState::DirectLan
                } else {
                    LinkTransportState::DirectWan
                };
            }
            if let Some(pkt) = peer
                .crypto
                .seal(&P2pWireFrame::PunchPong { echo_ts_ms: ts_ms })
            {
                let _ = reply_sock.send_to(&pkt, active).await;
            }
            None
        }
        P2pWireFrame::PunchPong { echo_ts_ms } | P2pWireFrame::KeepAlive { ts_ms: echo_ts_ms } => {
            if let Some(sent_at) = peer.pending_pings.remove(&echo_ts_ms) {
                peer.rtt_ms = Some(sent_at.elapsed().as_millis().min(9999) as u32);
            }
            peer.state = if is_lan_ip(active.ip()) {
                LinkTransportState::DirectLan
            } else {
                LinkTransportState::DirectWan
            };
            if matches!(frame, P2pWireFrame::KeepAlive { .. }) {
                if let Some(pkt) = peer.crypto.seal(&P2pWireFrame::PunchPong {
                    echo_ts_ms: epoch_ms(start_instant),
                }) {
                    let _ = reply_sock.send_to(&pkt, active).await;
                }
            }
            None
        }
        P2pWireFrame::Datagram { data } => {
            peer.state = if is_lan_ip(active.ip()) {
                LinkTransportState::DirectLan
            } else {
                LinkTransportState::DirectWan
            };
            serde_json::from_slice::<P2pDatagramMessage>(&data)
                .ok()
                .map(|m| UdpPacketEvent::Datagram(peer_key, m))
        }
        other => {
            peer.state = if is_lan_ip(active.ip()) {
                LinkTransportState::DirectLan
            } else {
                LinkTransportState::DirectWan
            };
            let (acks, assembled) = peer.reliable.handle_frame(other);
            for ack in acks {
                if let Some(pkt) = peer.crypto.seal(&ack) {
                    let _ = reply_sock.send_to(&pkt, active).await;
                }
            }
            assembled
                .and_then(|bytes| serde_json::from_slice::<P2pAppMessage>(&bytes).ok())
                .map(|m| UdpPacketEvent::App(peer_key, m))
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn maybe_drive_auto_align(
    app: &AppHandle,
    network_opts: LocalPathOptions,
    local_username: &str,
    local_media: Option<&P2pLocalMedia>,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &mut HashMap<String, PeerSession>,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    start_instant: Instant,
    cached_ref_probes: &mut Option<(String, Vec<SparseAudioProbe>)>,
    ref_extract_cancel: &mut Option<Arc<AtomicBool>>,
    align_job: &mut Option<AlignJobState>,
    completed_sigs: &HashSet<String>,
    internal_tx: &mpsc::Sender<InternalEvent>,
    force: bool,
) {
    let Some(lm) = local_media else {
        return;
    };
    let Some(local_dur) = lm.identity.duration_secs.filter(|d| *d > 12.0) else {
        return;
    };
    let Some(ref local_path) = lm.path else {
        return;
    };

    let Some(ref_key) = elect_reference_peer(local_username, Some(lm), participants, peers) else {
        return;
    };
    if !ref_key.eq_ignore_ascii_case(local_username) {
        if let Some(ref_peer) = peers.get(&ref_key) {
            let needs_probe = force
                || (!lm.has_user_alignment
                    && !completed_sigs.contains(&lm.file_sig)
                    && align_job.as_ref().is_none_or(|j| j.file_sig != lm.file_sig));
            if needs_probe {
                let ref_file = participants
                    .values()
                    .find(|p| p.username.eq_ignore_ascii_case(&ref_key))
                    .and_then(|p| p.file.as_ref())
                    .map(to_file_identity);
                let cmp = analyze_files(Some(&lm.identity), ref_file.as_ref());
                let should_align = force
                    || matches!(
                        cmp.source_relation,
                        SourceRelation::DifferentCut
                            | SourceRelation::FpsMismatch
                            | SourceRelation::DifferentEncode
                    ) && !matches!(cmp.source_relation, SourceRelation::Exact);
                let exact_same = matches!(cmp.source_relation, SourceRelation::Exact);
                if should_align && !exact_same && ref_peer.offered_file_sig.is_some() {
                    // Offer already received cleanly -> handled on receive; nothing else needed
                }
            }
        }
        return;
    }

    // We are the canonical Reference peer! Check if any connected P2P follower differs and needs probes.
    let mut needs_sending = false;
    for (key, peer) in peers.iter() {
        if !matches!(
            peer.state,
            LinkTransportState::DirectLan | LinkTransportState::DirectWan
        ) {
            continue;
        }
        if !force && peer.offered_file_sig.as_deref() == Some(lm.file_sig.as_str()) {
            continue;
        }
        if let Some(rp) = participants
            .values()
            .find(|p| p.username.eq_ignore_ascii_case(key))
        {
            if let Some(ref rf) = rp.file {
                let cmp = analyze_files(Some(&lm.identity), Some(&to_file_identity(rf)));
                if !matches!(
                    cmp.source_relation,
                    SourceRelation::Exact
                        | SourceRelation::DifferentMedia
                        | SourceRelation::Missing
                ) {
                    needs_sending = true;
                    break;
                }
            }
        }
    }

    if !needs_sending {
        return;
    }

    if let Some((cached_sig, cached_probes)) = cached_ref_probes {
        if cached_sig == &lm.file_sig && !cached_probes.is_empty() {
            let wire_probes: Vec<SparseAudioProbeWire> = cached_probes
                .iter()
                .map(SparseAudioProbe::to_wire)
                .collect();
            if let Ok(payload) = serde_json::to_vec(&P2pAppMessage::ProbeOffer {
                file_sig: lm.file_sig.clone(),
                ref_duration_secs: local_dur,
                probes: wire_probes,
            }) {
                let now_ms = epoch_ms(start_instant);
                for peer in peers.values_mut() {
                    if matches!(
                        peer.state,
                        LinkTransportState::DirectLan | LinkTransportState::DirectWan
                    ) && (force
                        || peer.offered_file_sig.as_deref() != Some(lm.file_sig.as_str()))
                    {
                        peer.offered_file_sig = Some(lm.file_sig.clone());
                        let _ =
                            send_reliable_payload(peer, &payload, sock_v4, sock_v6, now_ms).await;
                    }
                }
            }
            return;
        }
    }

    if ref_extract_cancel
        .as_ref()
        .is_some_and(|c| !c.load(Ordering::SeqCst))
    {
        return;
    }

    let Some(ffmpeg) = resolve_ffmpeg_exe(app) else {
        return;
    };
    let Ok(valid_vp) = validate_video_for_sparse_probe(&local_path.to_string_lossy(), network_opts)
    else {
        return;
    };

    let cancel = Arc::new(AtomicBool::new(false));
    *ref_extract_cancel = Some(Arc::clone(&cancel));
    let int_tx = internal_tx.clone();
    let file_sig = lm.file_sig.clone();

    tokio::spawn(async move {
        let probes = extract_reference_probes(&ffmpeg, &valid_vp, local_dur, None, &cancel).await;
        if !cancel.load(Ordering::SeqCst) {
            let _ = int_tx
                .send(InternalEvent::LocalProbesReady {
                    target_peer_key: None,
                    file_sig,
                    duration_secs: local_dur,
                    probes,
                    is_bisect_response: false,
                })
                .await;
        }
    });
}

#[allow(clippy::too_many_arguments)]
async fn handle_peer_app_msg(
    app: &AppHandle,
    network_opts: LocalPathOptions,
    peer_key: &str,
    msg: P2pAppMessage,
    local_username: &str,
    local_media: Option<&P2pLocalMedia>,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &mut HashMap<String, PeerSession>,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    start_instant: Instant,
    cached_ref_probes: &mut Option<(String, Vec<SparseAudioProbe>)>,
    ref_extract_cancel: &mut Option<Arc<AtomicBool>>,
    align_job: &mut Option<AlignJobState>,
    completed_sigs: &HashSet<String>,
    internal_tx: &mpsc::Sender<InternalEvent>,
    force_bypass_user_align: bool,
    seen_chat_msgs: &mut VecDeque<((String, String), Instant)>,
) {
    if let P2pAppMessage::ChatMessage {
        id,
        sender,
        avatar_id,
        text,
        reply_to_id,
        relay_targets,
        ttl,
    } = msg
    {
        let clean_id = sanitize_chat_id(&id);
        let Some(clean_text) = sanitize_chat_text(&text) else {
            return;
        };
        if clean_id.is_empty() {
            return;
        }
        let clean_avatar = sanitize_avatar_id(&avatar_id);
        let clean_reply = reply_to_id
            .as_deref()
            .map(sanitize_chat_id)
            .filter(|s| !s.is_empty());

        let sender_display: String = if sender.trim().is_empty() {
            peers
                .get(peer_key)
                .map(|p| p.username.clone())
                .unwrap_or_else(|| peer_key.to_string())
        } else {
            sender.trim().chars().take(32).collect()
        };
        let sender_key = sender_display.to_ascii_lowercase();
        if sender_display.eq_ignore_ascii_case(local_username) {
            return;
        }
        let sender_known = sender_key == peer_key
            || participants
                .values()
                .any(|p| p.username.eq_ignore_ascii_case(&sender_display));
        if !sender_known {
            return;
        }

        if record_seen_chat_msg(seen_chat_msgs, &sender_key, &clean_id) {
            let _ = app.emit(
                "sync://chat",
                serde_json::json!({
                    "id": clean_id,
                    "username": sender_display,
                    "avatarId": clean_avatar,
                    "text": clean_text,
                    "replyToId": clean_reply,
                    "via": if ttl == 0 { "p2pRelay" } else { "p2p" },
                }),
            );
        }

        if ttl > 0 && !relay_targets.is_empty() {
            let fwd = P2pAppMessage::ChatMessage {
                id: clean_id,
                sender: sender_display,
                avatar_id: clean_avatar,
                text: clean_text,
                reply_to_id: clean_reply,
                relay_targets: Vec::new(),
                ttl: ttl - 1,
            };
            forward_chat_relay(
                peers,
                relay_targets,
                peer_key,
                &sender_key,
                local_username,
                &fwd,
                sock_v4,
                sock_v6,
                start_instant,
            )
            .await;
        }
        return;
    }

    if let P2pAppMessage::ChatEdit {
        target_msg_id,
        sender,
        text,
        relay_targets,
        ttl,
    } = msg
    {
        let clean_id = sanitize_chat_id(&target_msg_id);
        let Some(clean_text) = sanitize_chat_text(&text) else {
            return;
        };
        if clean_id.is_empty() {
            return;
        }
        let sender_display: String = if sender.trim().is_empty() {
            peers
                .get(peer_key)
                .map(|p| p.username.clone())
                .unwrap_or_else(|| peer_key.to_string())
        } else {
            sender.trim().chars().take(32).collect()
        };
        let sender_key = sender_display.to_ascii_lowercase();
        if sender_display.eq_ignore_ascii_case(local_username) {
            return;
        }
        let sender_known = sender_key == peer_key
            || participants
                .values()
                .any(|p| p.username.eq_ignore_ascii_case(&sender_display));
        if !sender_known {
            return;
        }
        let _ = app.emit(
            "sync://chat-edit",
            serde_json::json!({
                "targetMsgId": clean_id,
                "username": sender_display,
                "text": clean_text,
                "via": if ttl == 0 { "p2pRelay" } else { "p2p" },
            }),
        );
        if ttl > 0 && !relay_targets.is_empty() {
            let fwd = P2pAppMessage::ChatEdit {
                target_msg_id: clean_id,
                sender: sender_display,
                text: clean_text,
                relay_targets: Vec::new(),
                ttl: ttl - 1,
            };
            forward_chat_relay(
                peers,
                relay_targets,
                peer_key,
                &sender_key,
                local_username,
                &fwd,
                sock_v4,
                sock_v6,
                start_instant,
            )
            .await;
        }
        return;
    }

    if let P2pAppMessage::ChatReact {
        target_msg_id,
        sender,
        emoji,
        relay_targets,
        ttl,
    } = msg
    {
        let clean_id = sanitize_chat_id(&target_msg_id);
        let Some(clean_emoji) = sanitize_reaction_emoji(&emoji) else {
            return;
        };
        if clean_id.is_empty() {
            return;
        }
        let sender_display: String = if sender.trim().is_empty() {
            peers
                .get(peer_key)
                .map(|p| p.username.clone())
                .unwrap_or_else(|| peer_key.to_string())
        } else {
            sender.trim().chars().take(32).collect()
        };
        let sender_key = sender_display.to_ascii_lowercase();
        if sender_display.eq_ignore_ascii_case(local_username) {
            return;
        }
        let sender_known = sender_key == peer_key
            || participants
                .values()
                .any(|p| p.username.eq_ignore_ascii_case(&sender_display));
        if !sender_known {
            return;
        }
        let _ = app.emit(
            "sync://chat-react",
            serde_json::json!({
                "targetMsgId": clean_id,
                "username": sender_display,
                "emoji": clean_emoji,
                "via": if ttl == 0 { "p2pRelay" } else { "p2p" },
            }),
        );
        if ttl > 0 && !relay_targets.is_empty() {
            let fwd = P2pAppMessage::ChatReact {
                target_msg_id: clean_id,
                sender: sender_display,
                emoji: clean_emoji,
                relay_targets: Vec::new(),
                ttl: ttl - 1,
            };
            forward_chat_relay(
                peers,
                relay_targets,
                peer_key,
                &sender_key,
                local_username,
                &fwd,
                sock_v4,
                sock_v6,
                start_instant,
            )
            .await;
        }
        return;
    }

    let Some(lm) = local_media else {
        return;
    };
    let Some(local_dur) = lm.identity.duration_secs.filter(|d| *d > 12.0) else {
        return;
    };
    let Some(ref local_path) = lm.path else {
        return;
    };
    let Some(ffmpeg) = resolve_ffmpeg_exe(app) else {
        return;
    };
    let Ok(valid_vp) = validate_video_for_sparse_probe(&local_path.to_string_lossy(), network_opts)
    else {
        return;
    };

    match msg {
        P2pAppMessage::ChatMessage { .. }
        | P2pAppMessage::ChatEdit { .. }
        | P2pAppMessage::ChatReact { .. } => {}
        P2pAppMessage::OfferRequest => {
            if let Some(peer) = peers.get_mut(peer_key) {
                peer.offered_file_sig = None;
            }
            maybe_drive_auto_align(
                app,
                network_opts,
                local_username,
                local_media,
                participants,
                peers,
                sock_v4,
                sock_v6,
                start_instant,
                cached_ref_probes,
                ref_extract_cancel,
                align_job,
                completed_sigs,
                internal_tx,
                true,
            )
            .await;
        }
        P2pAppMessage::NeedlesRequest {
            file_sig,
            timestamps_secs,
        } => {
            if lm.file_sig != file_sig || timestamps_secs.is_empty() {
                return;
            }
            let cancel = Arc::new(AtomicBool::new(false));
            let int_tx = internal_tx.clone();
            let target = peer_key.to_string();
            let req_ts: Vec<f64> = timestamps_secs.into_iter().take(4).collect();
            tokio::spawn(async move {
                let probes =
                    extract_reference_probes(&ffmpeg, &valid_vp, local_dur, Some(&req_ts), &cancel)
                        .await;
                if !probes.is_empty() {
                    let _ = int_tx
                        .send(InternalEvent::LocalProbesReady {
                            target_peer_key: Some(target),
                            file_sig,
                            duration_secs: local_dur,
                            probes,
                            is_bisect_response: true,
                        })
                        .await;
                }
            });
        }
        P2pAppMessage::ProbeOffer {
            ref_duration_secs,
            probes: wire_probes,
            ..
        } => {
            if lm.has_user_alignment && !force_bypass_user_align {
                return;
            }
            let probes: Vec<SparseAudioProbe> = wire_probes
                .iter()
                .filter_map(SparseAudioProbe::from_wire)
                .collect();
            if probes.is_empty() {
                return;
            }
            if let Some(prev) = align_job.take() {
                prev.cancel.store(true, Ordering::SeqCst);
            }
            let cancel = Arc::new(AtomicBool::new(false));
            *align_job = Some(AlignJobState {
                file_sig: lm.file_sig.clone(),
                ref_peer_key: peer_key.to_string(),
                ref_duration_secs,
                matches: Vec::new(),
                unmatched_room_secs: Vec::new(),
                bisect_rounds: 0,
                scale_hint: None,
                offset_hint: None,
                status: "probing".to_string(),
                summary: Some("Matching audio timeline via P2P...".to_string()),
                cancel: Arc::clone(&cancel),
                in_flight: true,
            });
            let int_tx = internal_tx.clone();
            let sig = lm.file_sig.clone();
            tokio::spawn(async move {
                let (matched, unmatched) = match_remote_probes_locally(
                    &ffmpeg,
                    &valid_vp,
                    local_dur,
                    ref_duration_secs,
                    &probes,
                    ProbeMatchHints::default(),
                    &cancel,
                )
                .await;
                if !cancel.load(Ordering::SeqCst) {
                    let _ = int_tx
                        .send(InternalEvent::FollowerMatchBatch {
                            file_sig: sig,
                            matched,
                            unmatched,
                            from_bisect: false,
                        })
                        .await;
                }
            });
        }
        P2pAppMessage::NeedlesResponse {
            probes: wire_probes,
            ..
        } => {
            let Some(ref mut job) = align_job else {
                return;
            };
            if job.file_sig != lm.file_sig || job.ref_peer_key != peer_key {
                return;
            }
            let probes: Vec<SparseAudioProbe> = wire_probes
                .iter()
                .filter_map(SparseAudioProbe::from_wire)
                .collect();
            if probes.is_empty() {
                return;
            }
            let cancel = Arc::clone(&job.cancel);
            let scale_hint = job.scale_hint;
            let offset_hint = job.offset_hint;
            let ref_dur = job.ref_duration_secs;
            let sig = lm.file_sig.clone();
            let int_tx = internal_tx.clone();
            job.in_flight = true;

            tokio::spawn(async move {
                let (matched, unmatched) = match_remote_probes_locally(
                    &ffmpeg,
                    &valid_vp,
                    local_dur,
                    ref_dur,
                    &probes,
                    ProbeMatchHints {
                        scale: scale_hint,
                        offset: offset_hint,
                    },
                    &cancel,
                )
                .await;
                if !cancel.load(Ordering::SeqCst) {
                    let _ = int_tx
                        .send(InternalEvent::FollowerMatchBatch {
                            file_sig: sig,
                            matched,
                            unmatched,
                            from_bisect: true,
                        })
                        .await;
                }
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_seen_reaction_deduplicates_and_bounds_capacity() {
        let mut seen = VecDeque::new();
        assert!(record_seen_reaction(&mut seen, "alice", 1));
        assert!(!record_seen_reaction(&mut seen, "alice", 1));
        assert!(record_seen_reaction(&mut seen, "alice", 2));
        assert!(record_seen_reaction(&mut seen, "bob", 1));

        for seq in 10..300u32 {
            assert!(record_seen_reaction(&mut seen, "spammer", seq));
        }
        assert!(seen.len() <= 256);
    }

    #[test]
    fn datagram_reaction_roundtrips_json_with_relay_targets_and_scared_emoji() {
        let msg = P2pDatagramMessage::Reaction {
            sender: "Maya".to_string(),
            avatar_id: "maya".to_string(),
            emoji: "😱".to_string(),
            count: 3,
            seq: 99,
            relay_targets: vec!["tariq".to_string()],
            ttl: 1,
        };
        let bytes = serde_json::to_vec(&msg).expect("serialize datagram");
        assert!(bytes.len() <= MAX_P2P_DATAGRAM_BYTES);
        let decoded: P2pDatagramMessage =
            serde_json::from_slice(&bytes).expect("deserialize datagram");
        match decoded {
            P2pDatagramMessage::Reaction {
                sender,
                avatar_id,
                emoji,
                count,
                seq,
                relay_targets,
                ttl,
            } => {
                assert_eq!(sender, "Maya");
                assert_eq!(avatar_id, "maya");
                assert_eq!(emoji, "😱");
                assert_eq!(count, 3);
                assert_eq!(seq, 99);
                assert_eq!(relay_targets, vec!["tariq".to_string()]);
                assert_eq!(ttl, 1);
            }
            other => panic!("unexpected variant: {other:?}"),
        }
    }
}
