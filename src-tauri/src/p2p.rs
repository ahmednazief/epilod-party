#![cfg(windows)]

use epilod_core::matching::{analyze_files, FileIdentity, SourceRelation};
use epilod_core::media_align::{
    analyze_probe_matches, AlignmentAnalysis, ProbeMatch, SparseAudioProbe, SparseAudioProbeWire,
};
use epilod_core::p2p::{
    build_natpmp_map_request, build_pcp_map_request, build_ssdp_msearch,
    build_stun_binding_request, build_upnp_add_port_mapping_soap,
    build_upnp_delete_port_mapping_soap, candidate_priority, compute_birthday_probe_ports,
    decode_ep2_beacon, encode_ep2_beacon, fill_random_bytes, infer_candidate_kind,
    is_allowed_upnp_lan_ip, parse_http_url_host_port_path, parse_igd_control_url,
    parse_natpmp_map_response, parse_pcp_map_response, parse_ssdp_location,
    parse_stun_binding_response, sanitize_avatar_id, sanitize_chat_id, sanitize_chat_text,
    sanitize_reaction_emoji, sanitize_shared_subtitle_ext, sanitize_shared_subtitle_name,
    ChatFallbackPacket, ChatReactFallbackPacket, P2pBeacon, P2pCandidate, P2pCandidateKind,
    P2pCryptoSession, P2pIdentity, P2pWireFrame, ReactionFallbackPacket, ReliableChannel,
    VoiceRxCrypto, VoiceTxCrypto, MAX_P2P_DATAGRAM_BYTES, MAX_REACTION_BURST_COUNT,
    MAX_RELIABLE_MSG_BYTES, MAX_SHARED_SUBTITLE_BYTES, MAX_VOICE_OPUS_BYTES, NATPMP_PCP_PORT,
    P2P_CHUNK_PAYLOAD_BYTES, SSDP_MULTICAST_ADDR, STUN_SERVERS, VOICE_FLAG_END_OF_TALK,
    VOICE_FLAG_RELAYED,
};
use epilod_core::syncplay::{
    RoomParticipantUpdate, TimelineSegment, TimelineTransform, WireFileInfo,
};
use epilod_core::validation::LocalPathOptions;
use epilod_core::voice_dsp::{PeerTokenBucket, UplinkBandwidthTracker};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU32, AtomicU64, AtomicU8, Ordering};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoicePeerRosterDto {
    pub username: String,
    pub voice_id: u8,
    pub epoch: u8,
    pub in_voice: bool,
    pub muted: bool,
    pub deafened: bool,
    pub transport: String,
    pub relay_via: Option<String>,
    pub rtt_ms: Option<u32>,
    pub loss_pct: f32,
    pub jitter_ms: u32,
    pub bitrate_kbps: u32,
    pub quality_bars: u8,
    pub health_reason: Option<String>,
    pub health_fix: Option<String>,
}

#[derive(Debug, Clone)]
pub struct VoiceRxPacket {
    pub origin_key: String,
    pub origin_username: String,
    pub voice_id: u8,
    pub epoch: u8,
    pub seq: u16,
    pub ts_48k: u32,
    pub end_of_talk: bool,
    pub relayed: bool,
    pub opus: Vec<u8>,
    pub arrival_ms: u64,
}

#[derive(Clone)]
pub struct VoiceTxTarget {
    pub peer_key: String,
    pub username: String,
    pub addr: SocketAddr,
    pub tx_crypto: Arc<std::sync::Mutex<VoiceTxCrypto>>,
}

pub struct VoiceTransportHandle {
    sock_v4: std::sync::RwLock<Option<Arc<UdpSocket>>>,
    sock_v6: std::sync::RwLock<Option<Arc<UdpSocket>>>,
    tx_targets: std::sync::RwLock<Vec<VoiceTxTarget>>,
    latest_roster: std::sync::RwLock<Vec<VoicePeerRosterDto>>,
    peer_rx_telemetry: std::sync::RwLock<HashMap<String, (u32, f32)>>,
    local_nat_mode: std::sync::RwLock<String>,
    pub local_voice_id: AtomicU8,
    pub local_epoch: AtomicU8,
    pub local_voice_gen: AtomicU32,
    pub local_bitrate_kbps: AtomicU32,
    pub est_upload_kbps: AtomicU32,
    pub on_battery: AtomicBool,
    pub relay_capacity_streams: AtomicU8,
    pub active_relay_streams: AtomicU8,
    pub in_voice: AtomicBool,
    pub muted: AtomicBool,
    pub deafened: AtomicBool,
    pub allow_relay_for_others: AtomicBool,
    pub allow_relayed_voice: AtomicBool,
    pub local_loss_pct_x10: AtomicU16,
    pub last_voice_tx_rx_ms: AtomicU64,
    pub udp_would_block_events: AtomicU32,
    rx_tx: std::sync::mpsc::SyncSender<VoiceRxPacket>,
    rx_rx: std::sync::Mutex<std::sync::mpsc::Receiver<VoiceRxPacket>>,
    rx_notify: (std::sync::Mutex<u64>, std::sync::Condvar),
    cmd_tx: mpsc::Sender<P2pControlCmd>,
    pub start_instant: Instant,
    #[cfg(test)]
    test_beacon: std::sync::Mutex<Option<P2pBeacon>>,
}

impl VoiceTransportHandle {
    fn new(cmd_tx: mpsc::Sender<P2pControlCmd>) -> Self {
        let (rx_tx, rx_rx) = std::sync::mpsc::sync_channel::<VoiceRxPacket>(256);
        Self {
            sock_v4: std::sync::RwLock::new(None),
            sock_v6: std::sync::RwLock::new(None),
            tx_targets: std::sync::RwLock::new(Vec::new()),
            latest_roster: std::sync::RwLock::new(Vec::new()),
            peer_rx_telemetry: std::sync::RwLock::new(HashMap::new()),
            local_nat_mode: std::sync::RwLock::new("probing".to_string()),
            local_voice_id: AtomicU8::new(0),
            local_epoch: AtomicU8::new(1),
            local_voice_gen: AtomicU32::new(1),
            local_bitrate_kbps: AtomicU32::new(48),
            est_upload_kbps: AtomicU32::new(UplinkBandwidthTracker::INITIAL_KBPS),
            on_battery: AtomicBool::new(false),
            relay_capacity_streams: AtomicU8::new(2),
            active_relay_streams: AtomicU8::new(0),
            in_voice: AtomicBool::new(false),
            muted: AtomicBool::new(false),
            deafened: AtomicBool::new(false),
            allow_relay_for_others: AtomicBool::new(true),
            allow_relayed_voice: AtomicBool::new(true),
            local_loss_pct_x10: AtomicU16::new(0),
            last_voice_tx_rx_ms: AtomicU64::new(0),
            udp_would_block_events: AtomicU32::new(0),
            rx_tx,
            rx_rx: std::sync::Mutex::new(rx_rx),
            rx_notify: (std::sync::Mutex::new(0), std::sync::Condvar::new()),
            cmd_tx,
            start_instant: Instant::now(),
            #[cfg(test)]
            test_beacon: std::sync::Mutex::new(None),
        }
    }

    /// Drains all currently queued incoming voice packets without dropping ownership of the receiver
    /// across worker restarts (e.g., opening Voice Settings before joining, or leaving & rejoining voice).
    pub fn drain_rx_packets(&self, mut on_packet: impl FnMut(VoiceRxPacket)) {
        let rx = self.rx_rx.lock().unwrap_or_else(|e| e.into_inner());
        while let Ok(pkt) = rx.try_recv() {
            on_packet(pkt);
        }
    }

    pub fn clear_rx_packets(&self) {
        let rx = self.rx_rx.lock().unwrap_or_else(|e| e.into_inner());
        while rx.try_recv().is_ok() {}
    }

    /// Blocks up to `timeout` until a new voice RX packet arrives (used when mixer is idle).
    pub fn wait_for_rx_packet(&self, last_seen: &mut u64, timeout: Duration) -> bool {
        let (lock, cv) = &self.rx_notify;
        let guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        if *guard != *last_seen {
            *last_seen = *guard;
            return true;
        }
        let (guard, _) = cv
            .wait_timeout_while(guard, timeout, |seq| *seq == *last_seen)
            .unwrap_or_else(|e| e.into_inner());
        if *guard != *last_seen {
            *last_seen = *guard;
            true
        } else {
            false
        }
    }

    fn push_rx_packet_and_notify(&self, pkt: VoiceRxPacket) {
        if self.rx_tx.try_send(pkt).is_ok() {
            let (lock, cv) = &self.rx_notify;
            let mut seq = lock.lock().unwrap_or_else(|e| e.into_inner());
            *seq = seq.wrapping_add(1);
            cv.notify_all();
        }
    }

    #[cfg(test)]
    pub fn try_recv_rx_packet(&self) -> Result<VoiceRxPacket, std::sync::mpsc::TryRecvError> {
        self.rx_rx
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .try_recv()
    }

    pub fn roster_snapshot(&self) -> Vec<VoicePeerRosterDto> {
        self.latest_roster
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn nat_mode(&self) -> String {
        self.local_nat_mode
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn relay_stats(&self) -> (u32, usize, usize) {
        (
            self.est_upload_kbps.load(Ordering::Relaxed),
            self.relay_capacity_streams.load(Ordering::Relaxed) as usize,
            self.active_relay_streams.load(Ordering::Relaxed) as usize,
        )
    }

    pub fn report_peer_rx_telemetry(&self, metrics: Vec<(String, u32, f32)>) {
        let mut g = self
            .peer_rx_telemetry
            .write()
            .unwrap_or_else(|e| e.into_inner());
        g.clear();
        for (k, jitter_ms, loss_pct) in metrics {
            g.insert(k, (jitter_ms, loss_pct));
        }
    }

    pub fn update_power_and_upload(&self, on_battery: bool, est_upload_kbps: u32) {
        self.on_battery.store(on_battery, Ordering::Relaxed);
        if est_upload_kbps > 0 {
            self.est_upload_kbps
                .store(est_upload_kbps, Ordering::Relaxed);
        }
    }

    pub fn update_battery_state(&self, on_battery: bool) {
        self.on_battery.store(on_battery, Ordering::Relaxed);
    }

    pub fn record_udp_would_block(&self) {
        self.udp_would_block_events.fetch_add(1, Ordering::Relaxed);
    }

    pub fn voice_recently_active(&self) -> bool {
        if !self.in_voice.load(Ordering::Relaxed) {
            return false;
        }
        let now_ms = self.start_instant.elapsed().as_millis() as u64;
        let last = self.last_voice_tx_rx_ms.load(Ordering::Relaxed);
        last > 0 && now_ms.saturating_sub(last) <= 600
    }

    pub fn tx_target_count(&self) -> usize {
        self.tx_targets
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .len()
    }

    /// Directly encrypts and sends a voice packet over UDP without entering the main P2P actor loop.
    pub fn send_voice_frame(&self, seq: u16, ts_48k: u32, end_of_talk: bool, opus: &[u8]) {
        if !self.in_voice.load(Ordering::Relaxed) {
            return;
        }
        if opus.len() > MAX_VOICE_OPUS_BYTES || (opus.is_empty() && !end_of_talk) {
            return;
        }
        self.last_voice_tx_rx_ms.store(
            self.start_instant.elapsed().as_millis() as u64,
            Ordering::Relaxed,
        );
        let voice_id = self.local_voice_id.load(Ordering::Relaxed);
        let epoch = self.local_epoch.load(Ordering::Relaxed);
        let flags = if end_of_talk {
            VOICE_FLAG_END_OF_TALK
        } else {
            0
        };
        let frame = P2pWireFrame::Voice {
            voice_id,
            epoch,
            seq,
            ts_48k,
            flags,
            opus: opus.to_vec(),
        };
        let sock_v4 = self
            .sock_v4
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let sock_v6 = self
            .sock_v6
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        let targets = self.tx_targets.read().unwrap_or_else(|e| e.into_inner());
        for target in targets.iter() {
            let pkt = {
                let mut crypto = target.tx_crypto.lock().unwrap_or_else(|e| e.into_inner());
                crypto.seal(&frame)
            };
            let Some(pkt) = pkt else {
                continue;
            };
            match target.addr {
                SocketAddr::V4(_) => {
                    if let Some(ref s4) = sock_v4 {
                        if let Err(e) = s4.try_send_to(&pkt, target.addr) {
                            if e.kind() == std::io::ErrorKind::WouldBlock {
                                self.record_udp_would_block();
                            }
                        }
                    }
                }
                SocketAddr::V6(_) => {
                    if let Some(ref s6) = sock_v6 {
                        if let Err(e) = s6.try_send_to(&pkt, target.addr) {
                            if e.kind() == std::io::ErrorKind::WouldBlock {
                                self.record_udp_would_block();
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn notify_local_state(
        &self,
        in_voice: bool,
        epoch: u8,
        muted: bool,
        deafened: bool,
        allow_relay_for_others: bool,
        allow_relayed_voice: bool,
    ) {
        if in_voice != self.in_voice.load(Ordering::Relaxed)
            || epoch != self.local_epoch.load(Ordering::Relaxed)
        {
            self.local_voice_gen.fetch_add(1, Ordering::AcqRel);
        }
        self.in_voice.store(in_voice, Ordering::Release);
        self.local_epoch.store(epoch, Ordering::Release);
        self.muted.store(muted, Ordering::Release);
        self.deafened.store(deafened, Ordering::Release);
        self.allow_relay_for_others
            .store(allow_relay_for_others, Ordering::Release);
        self.allow_relayed_voice
            .store(allow_relayed_voice, Ordering::Release);
        if !in_voice {
            self.clear_rx_packets();
        }
        let _ = self.cmd_tx.try_send(P2pControlCmd::UpdateLocalVoiceState);
    }
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
    SendSubtitleShare {
        id: String,
        file_name: String,
        ext: String,
        lang: Option<String>,
        content: String,
    },
    PeerJoined(String),
    UpdateLocalVoiceState,
    #[cfg(test)]
    TestInjectBeacon {
        username: String,
        beacon: P2pBeacon,
        drop_direct_from: Vec<String>,
    },
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
    Connected(String),
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
    SubtitleShare {
        id: String,
        sender: String,
        file_name: String,
        ext: String,
        #[serde(default)]
        lang: Option<String>,
        content: String,
        #[serde(default)]
        relay_targets: Vec<String>,
        #[serde(default)]
        ttl: u8,
    },
    VoiceState {
        username: String,
        voice_id: u8,
        epoch: u8,
        in_voice: bool,
        muted: bool,
        deafened: bool,
        loss_pct_x10: u16,
        allow_relay_for_others: bool,
        allow_relayed_voice: bool,
        #[serde(default)]
        voice_gen: u32,
        #[serde(default)]
        on_battery: bool,
        #[serde(default)]
        est_upload_kbps: u32,
        #[serde(default)]
        relay_cap: u8,
        #[serde(default)]
        blocked_voice_peers: Vec<String>,
        #[serde(default)]
        relay_targets: Vec<String>,
        #[serde(default)]
        ttl: u8,
    },
    VoiceRosterRequest,
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
    voice_tx: Arc<std::sync::Mutex<VoiceTxCrypto>>,
    reliable: ReliableChannel,
    state: LinkTransportState,
    started_at: Instant,
    active_addr: Option<SocketAddr>,
    last_rx_at: Option<Instant>,
    last_keepalive_at: Instant,
    last_repunch_at: Instant,
    punch_attempts: u32,
    rtt_ms: Option<u32>,
    pending_pings: HashMap<u64, Instant>,
    offered_file_sig: Option<String>,
    cant_relay_to: HashSet<String>,
    voice_id: u8,
    voice_epoch: u8,
    prev_voice_epoch: Option<u8>,
    voice_gen: u32,
    voice_in_call: bool,
    voice_muted: bool,
    voice_deafened: bool,
    voice_loss_pct: f32,
    voice_allow_relay_for_others: bool,
    voice_allow_relayed_voice: bool,
    voice_on_battery: bool,
    voice_est_upload_kbps: u32,
    voice_relay_cap: u8,
    last_voice_state_rx: Option<Instant>,
    voice_blocked_peers: Vec<String>,
    bidirectional_verified: bool,
    inbound_chat_window: (Instant, u32),
    inbound_reaction_window: (Instant, u32),
    inbound_align_window: (Instant, u32),
    #[cfg(test)]
    test_drop_direct: bool,
}

impl PeerSession {
    fn allow_inbound_chat(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.inbound_chat_window.0) >= Duration::from_secs(5) {
            self.inbound_chat_window = (now, 0);
        }
        if self.inbound_chat_window.1 >= 30 {
            return false;
        }
        self.inbound_chat_window.1 += 1;
        true
    }

    fn allow_inbound_reaction(&mut self, count: u8) -> u8 {
        let now = Instant::now();
        if now.duration_since(self.inbound_reaction_window.0) >= Duration::from_secs(2) {
            self.inbound_reaction_window = (now, 0);
        }
        if self.inbound_reaction_window.1 >= 120 {
            return 0;
        }
        let allowed = (120 - self.inbound_reaction_window.1).min(count as u32) as u8;
        self.inbound_reaction_window.1 += allowed as u32;
        allowed
    }

    fn allow_inbound_align(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.inbound_align_window.0) >= Duration::from_secs(10) {
            self.inbound_align_window = (now, 0);
        }
        if self.inbound_align_window.1 >= 4 {
            return false;
        }
        self.inbound_align_window.1 += 1;
        true
    }
}

struct VoiceRxPeerState {
    peer_key: String,
    username: String,
    crypto: VoiceRxCrypto,
    token_bucket: PeerTokenBucket,
    per_voice_buckets: HashMap<u8, PeerTokenBucket>,
    last_voice_pkt_at: Option<Instant>,
}

#[derive(Clone)]
struct VoiceRelayForward {
    target_addr: SocketAddr,
    target_tx: Arc<std::sync::Mutex<VoiceTxCrypto>>,
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
    pub voice: Arc<VoiceTransportHandle>,
}

impl P2pSessionHandle {
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        app: AppHandle,
        initial_username: String,
        room_psk: Option<[u8; 32]>,
        network_opts: LocalPathOptions,
        beacon_tx: mpsc::Sender<String>,
        align_tx: mpsc::Sender<P2pAutoAlignment>,
        reaction_fallback_tx: mpsc::Sender<ReactionFallbackPacket>,
        chat_fallback_tx: mpsc::Sender<ChatFallbackPacket>,
        chat_react_fallback_tx: mpsc::Sender<ChatReactFallbackPacket>,
    ) -> Self {
        let (cmd_tx, cmd_rx) = mpsc::channel::<P2pControlCmd>(128);
        let voice = Arc::new(VoiceTransportHandle::new(cmd_tx.clone()));
        tokio::spawn(run_p2p_actor(
            Some(app),
            initial_username,
            room_psk,
            network_opts,
            cmd_rx,
            Arc::clone(&voice),
            false,
            beacon_tx,
            align_tx,
            reaction_fallback_tx,
            chat_fallback_tx,
            chat_react_fallback_tx,
        ));
        Self { cmd_tx, voice }
    }

    pub fn try_send(&self, cmd: P2pControlCmd) {
        let _ = self.cmd_tx.try_send(cmd);
    }
}

fn emit_opt<S: Serialize + Clone>(app: Option<&AppHandle>, event: &str, payload: S) {
    if let Some(a) = app {
        let _ = a.emit(event, payload);
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
    let mut tx_ids = [[0u8; 12]; 4];
    for tx in &mut tx_ids {
        fill_random_bytes(tx);
    }

    for (idx, host) in STUN_SERVERS.iter().enumerate() {
        if idx >= tx_ids.len() {
            break;
        }
        if let Ok(addrs) = tokio::net::lookup_host(*host).await {
            if let Some(target) = addrs.into_iter().find(|a| a.is_ipv4()) {
                let req = build_stun_binding_request(tx_ids[idx]);
                let _ = sock.send_to(&req, target).await;
            }
        }
    }

    let mut mapped: [Option<SocketAddr>; 4] = [None, None, None, None];
    let mut buf = [0u8; 512];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(850);

    while tokio::time::Instant::now() < deadline
        && mapped.iter().filter(|m| m.is_some()).count() < 2
    {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rem, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, _src))) => {
                for i in 0..mapped.len() {
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

    let found: Vec<SocketAddr> = mapped.into_iter().flatten().collect();
    let symmetric = found.len() >= 2 && found[0].port() != found[1].port();
    (found.into_iter().next(), symmetric)
}

async fn try_pcp_or_natpmp_port_map(
    local_ip: Ipv4Addr,
    local_port: u16,
) -> Option<(&'static str, Option<Ipv4Addr>, u16)> {
    let [o0, o1, o2, _] = local_ip.octets();
    let gw_candidates = [Ipv4Addr::new(o0, o1, o2, 1), Ipv4Addr::new(o0, o1, o2, 254)];
    let sock = UdpSocket::bind(SocketAddr::new(IpAddr::V4(local_ip), 0))
        .await
        .ok()?;

    let mut nonce = [0u8; 12];
    fill_random_bytes(&mut nonce);
    let pcp_req = build_pcp_map_request(local_ip, local_port, local_port, 3600, nonce);
    let natpmp_req = build_natpmp_map_request(local_port, local_port, 3600);

    for gw in gw_candidates {
        let target = SocketAddr::new(IpAddr::V4(gw), NATPMP_PCP_PORT);
        let _ = sock.send_to(&pcp_req, target).await;
        let _ = sock.send_to(&natpmp_req, target).await;
    }

    let mut buf = [0u8; 128];
    let deadline = tokio::time::Instant::now() + Duration::from_millis(260);
    while tokio::time::Instant::now() < deadline {
        let rem = deadline.saturating_duration_since(tokio::time::Instant::now());
        match tokio::time::timeout(rem, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, _))) => {
                if let Some((ext_ip, ext_port, _)) = parse_pcp_map_response(&buf[..n], nonce) {
                    return Some(("pcp", ext_ip, ext_port));
                }
                if let Some((_, ext_port, _)) = parse_natpmp_map_response(&buf[..n]) {
                    return Some(("natpmp", None, ext_port));
                }
            }
            _ => break,
        }
    }
    None
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
    let (n, src) = tokio::time::timeout(Duration::from_millis(450), ssdp_sock.recv_from(&mut buf))
        .await
        .ok()?
        .ok()?;
    let IpAddr::V4(responder_ip) = src.ip() else {
        return None;
    };
    if !is_allowed_upnp_lan_ip(responder_ip) {
        return None;
    }
    let location = parse_ssdp_location(&String::from_utf8_lossy(&buf[..n]))?;
    let (host, port, path) = parse_http_url_host_port_path(&location)?;
    // Pin LOCATION strictly to the SSDP responder's RFC1918 LAN IPv4 address (prevents LAN SSRF).
    let loc_ip: Ipv4Addr = host.parse().ok()?;
    if loc_ip != responder_ip || !is_allowed_upnp_lan_ip(loc_ip) {
        return None;
    }
    let get_req =
        format!("GET {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    let xml = http_plain_request(&host, port, get_req.as_bytes(), 700).await?;
    let (control_url, service_type) = parse_igd_control_url(&location, &xml)?;
    let (ctrl_host, ctrl_port, ctrl_path) = parse_http_url_host_port_path(&control_url)?;
    let ctrl_ip: Ipv4Addr = ctrl_host.parse().ok()?;
    if ctrl_ip != responder_ip || !is_allowed_upnp_lan_ip(ctrl_ip) {
        return None;
    }

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
    app: Option<&AppHandle>,
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
    emit_opt(
        app,
        "sync://p2p-status",
        P2pStatusPayload {
            nat_mode: nat_mode.to_string(),
            peers: peer_dtos,
        },
    );
}

fn assign_local_voice_id(
    local_session_id: u32,
    local_username: &str,
    current_vid: u8,
    peers: &HashMap<String, PeerSession>,
) -> (u8, bool) {
    let local_key = local_username.to_ascii_lowercase();
    let collided_with_winner = peers
        .iter()
        .any(|(k, p)| p.voice_in_call && p.voice_id == current_vid && *k < local_key);
    if current_vid > 0 && !collided_with_winner {
        return (current_vid, false);
    }

    let mut hash_byte = ((local_session_id
        ^ (local_session_id >> 8)
        ^ (local_session_id >> 16)
        ^ (local_session_id >> 24)) as u8)
        .max(1);
    for b in local_key.as_bytes() {
        hash_byte = hash_byte.wrapping_mul(33).wrapping_add(*b);
    }
    let start = hash_byte.max(1);
    let mut candidate = start;
    for _ in 0..254 {
        let taken = peers.values().any(|p| p.voice_id == candidate);
        if !taken && candidate > 0 {
            return (candidate, candidate != current_vid);
        }
        candidate = candidate.wrapping_add(1).max(1);
    }
    (start, start != current_vid)
}

fn is_direct_peer(p: &PeerSession) -> bool {
    matches!(
        p.state,
        LinkTransportState::DirectLan | LinkTransportState::DirectWan
    ) && p.active_addr.is_some()
        && p.bidirectional_verified
}

fn compute_relay_stream_cap(est_upload_kbps: u32, on_battery: bool) -> usize {
    if on_battery {
        return if est_upload_kbps >= 1500 { 2 } else { 1 };
    }
    if est_upload_kbps >= 2000 {
        4
    } else if est_upload_kbps >= 900 {
        3
    } else if est_upload_kbps >= 450 || est_upload_kbps == 0 {
        2
    } else {
        1
    }
}

fn compute_peer_quality_bars(
    transport: &str,
    loss_pct: f32,
    jitter_ms: u32,
    rtt_ms: Option<u32>,
) -> u8 {
    if transport == "blocked" || transport == "unavailable" {
        return 0;
    }
    let rtt = rtt_ms.unwrap_or(50);
    if loss_pct >= 6.0 || jitter_ms >= 80 || rtt >= 350 {
        1
    } else if loss_pct >= 2.5 || jitter_ms >= 50 || rtt >= 220 {
        2
    } else if loss_pct >= 0.8 || jitter_ms >= 30 || rtt >= 130 || transport == "relayed" {
        3
    } else {
        4
    }
}

fn diagnose_peer_health(
    transport: &str,
    relay_via: Option<&str>,
    local_allow_relayed: bool,
    peer_allow_relayed: bool,
    loss_pct: f32,
    jitter_ms: u32,
    rtt_ms: Option<u32>,
) -> (Option<String>, Option<String>) {
    match transport {
        "blocked" => {
            if !local_allow_relayed || !peer_allow_relayed {
                (
                    Some("Relayed voice is disabled in Privacy & Relay settings.".to_string()),
                    Some("Enable 'Allow My Voice to Be Relayed' in Voice & Audio settings if direct UDP fails.".to_string()),
                )
            } else {
                (
                    Some("Both peers are behind strict NAT with no mutually reachable peer to relay.".to_string()),
                    Some("Have someone on an open/IPv6/UPnP connection join the room, or enable IPv6 / UPnP / NAT-PMP on your router.".to_string()),
                )
            }
        }
        "unavailable" => (
            Some("Direct UDP path has not connected yet.".to_string()),
            Some(
                "Wait a moment for hole-punching or check Windows Firewall UDP permissions."
                    .to_string(),
            ),
        ),
        "relayed" => {
            let via = relay_via.unwrap_or("room peer");
            (
                Some(format!(
                    "Direct UDP blocked; audio is relayed 1-hop via {via}."
                )),
                Some(
                    "Enable IPv6 or UPnP/NAT-PMP on your router for direct lower-latency audio."
                        .to_string(),
                ),
            )
        }
        _ => {
            if loss_pct >= 4.0 || jitter_ms >= 55 || rtt_ms.unwrap_or(0) >= 260 {
                (
                    Some(format!(
                        "Degraded link ({:.1}% loss, {} ms jitter{}).",
                        loss_pct,
                        jitter_ms,
                        rtt_ms.map_or_else(String::new, |r| format!(", {r} ms RTT"))
                    )),
                    Some(
                        "Use 5 GHz Wi-Fi or Ethernet, or pause heavy background downloads."
                            .to_string(),
                    ),
                )
            } else {
                (None, None)
            }
        }
    }
}

fn compute_worst_peer_rtt_inflation<'a>(
    active_rtts: impl IntoIterator<Item = (&'a str, u32)>,
    peer_baselines: &mut HashMap<String, u32>,
) -> (u32, u32) {
    let mut worst_delta = 0u32;
    let mut worst_pair = (0u32, 0u32);
    for (peer_key, rtt) in active_rtts {
        let base = *peer_baselines
            .entry(peer_key.to_string())
            .and_modify(|b| *b = (*b).min(rtt))
            .or_insert(rtt);
        let delta = rtt.saturating_sub(base);
        if delta >= worst_delta {
            worst_delta = delta;
            worst_pair = (rtt, base);
        }
    }
    worst_pair
}

fn score_relay_candidate(peer: &PeerSession) -> (u8, u8, u32) {
    // Lower tuple sorts first: AC power (0) > battery (1), higher relay cap (negated), lower RTT
    let bat_pen = if peer.voice_on_battery { 1 } else { 0 };
    let cap_pen = 8u8.saturating_sub(peer.voice_relay_cap.max(1));
    let rtt = peer.rtt_ms.unwrap_or(9999);
    (bat_pen, cap_pen, rtt)
}

fn rebuild_voice_routing(
    app: Option<&AppHandle>,
    local_username: &str,
    local_session_id: u32,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &HashMap<String, PeerSession>,
    voice_handle: &VoiceTransportHandle,
    relay_routes: &mut HashMap<String, Vec<VoiceRelayForward>>,
) -> bool {
    let cur_vid = voice_handle.local_voice_id.load(Ordering::Relaxed);
    let (my_vid, vid_changed) =
        assign_local_voice_id(local_session_id, local_username, cur_vid, peers);
    if vid_changed {
        voice_handle.local_voice_id.store(my_vid, Ordering::Relaxed);
        voice_handle.local_voice_gen.fetch_add(1, Ordering::AcqRel);
    }

    let allow_relay_for_others = voice_handle.allow_relay_for_others.load(Ordering::Relaxed);
    let allow_relayed_voice = voice_handle.allow_relayed_voice.load(Ordering::Relaxed);
    let local_on_battery = voice_handle.on_battery.load(Ordering::Relaxed);
    let local_upload_kbps = voice_handle.est_upload_kbps.load(Ordering::Relaxed);
    let dynamic_cap = compute_relay_stream_cap(local_upload_kbps, local_on_battery);
    voice_handle
        .relay_capacity_streams
        .store(dynamic_cap as u8, Ordering::Relaxed);
    let local_bitrate_kbps = voice_handle
        .local_bitrate_kbps
        .load(Ordering::Relaxed)
        .max(24);
    let rx_telem = voice_handle
        .peer_rx_telemetry
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone();

    let mut tx_targets: Vec<VoiceTxTarget> = Vec::new();
    let mut tx_keys: HashSet<String> = HashSet::new();
    let mut roster: Vec<VoicePeerRosterDto> = Vec::new();

    // Direct peers first (skip deafened peers to avoid wasting upload bandwidth)
    for (key, peer) in peers {
        if is_direct_peer(peer) && peer.voice_in_call && !peer.voice_deafened {
            if let Some(addr) = peer.active_addr {
                if tx_keys.insert(key.clone()) {
                    tx_targets.push(VoiceTxTarget {
                        peer_key: key.clone(),
                        username: peer.username.clone(),
                        addr,
                        tx_crypto: Arc::clone(&peer.voice_tx),
                    });
                }
            }
        }
    }

    // Build roster + find 1-hop relays for non-direct voice peers
    let mut seen_usernames: HashSet<String> = HashSet::new();
    for (key, peer) in peers {
        seen_usernames.insert(key.clone());
        let direct = is_direct_peer(peer);
        let mut transport = if direct {
            if peer.active_addr.is_some_and(|a| a.is_ipv6()) {
                "directIpv6".to_string()
            } else {
                peer.state.as_wire().to_string()
            }
        } else {
            "unavailable".to_string()
        };
        let mut relay_via: Option<String> = None;

        if !direct && peer.voice_in_call {
            if !allow_relayed_voice || !peer.voice_allow_relayed_voice {
                transport = "blocked".to_string();
            } else {
                // Scored deterministic candidate ranking: AC > battery, headroom > tight, lowest RTT;
                // never pick a helper whose own blocked_peers includes target `key`!
                let can_reach_target = |rp: &PeerSession| {
                    rp.last_voice_state_rx.is_some()
                        && !rp.voice_blocked_peers.iter().any(|b| b == key)
                        && !rp.cant_relay_to.contains(key)
                };
                let mut candidates: Vec<(&String, &PeerSession)> = peers
                    .iter()
                    .filter(|(rk, rp)| {
                        *rk != key
                            && is_direct_peer(rp)
                            && rp.voice_allow_relay_for_others
                            && can_reach_target(rp)
                    })
                    .collect();
                candidates.sort_by_key(|(rk, rp)| (score_relay_candidate(rp), (*rk).clone()));
                if let Some((rk, rp)) = candidates.first() {
                    if let Some(r_addr) = rp.active_addr {
                        transport = "relayed".to_string();
                        relay_via = Some(rp.username.clone());
                        if !peer.voice_deafened && tx_keys.insert((*rk).clone()) {
                            tx_targets.push(VoiceTxTarget {
                                peer_key: (*rk).clone(),
                                username: rp.username.clone(),
                                addr: r_addr,
                                tx_crypto: Arc::clone(&rp.voice_tx),
                            });
                        }
                    }
                } else {
                    transport = "blocked".to_string();
                }
            }
        }

        let (jitter_ms, local_rx_loss) = rx_telem.get(key).copied().unwrap_or((0, 0.0));
        let combined_loss = peer.voice_loss_pct.max(local_rx_loss);
        let quality_bars = if peer.voice_in_call {
            compute_peer_quality_bars(&transport, combined_loss, jitter_ms, peer.rtt_ms)
        } else {
            0
        };
        let (health_reason, health_fix) = if peer.voice_in_call {
            diagnose_peer_health(
                &transport,
                relay_via.as_deref(),
                allow_relayed_voice,
                peer.voice_allow_relayed_voice,
                combined_loss,
                jitter_ms,
                peer.rtt_ms,
            )
        } else {
            (None, None)
        };

        roster.push(VoicePeerRosterDto {
            username: peer.username.clone(),
            voice_id: peer.voice_id,
            epoch: peer.voice_epoch,
            in_voice: peer.voice_in_call,
            muted: peer.voice_muted,
            deafened: peer.voice_deafened,
            transport,
            relay_via,
            rtt_ms: peer.rtt_ms,
            loss_pct: combined_loss,
            jitter_ms,
            bitrate_kbps: if peer.voice_in_call {
                local_bitrate_kbps
            } else {
                0
            },
            quality_bars,
            health_reason,
            health_fix,
        });
    }

    // Any room participant without even a P2P beacon yet
    for item in participants.values() {
        if item.username.eq_ignore_ascii_case(local_username) {
            continue;
        }
        let key = item.username.to_ascii_lowercase();
        if seen_usernames.contains(&key) {
            continue;
        }
        roster.push(VoicePeerRosterDto {
            username: item.username.clone(),
            voice_id: 0,
            epoch: 0,
            in_voice: false,
            muted: false,
            deafened: false,
            transport: "unavailable".to_string(),
            relay_via: None,
            rtt_ms: None,
            loss_pct: 0.0,
            jitter_ms: 0,
            bitrate_kbps: 0,
            quality_bars: 0,
            health_reason: None,
            health_fix: None,
        });
    }

    // Compute which direct pairs this node should relay for (dynamic upload/battery cap, max 4)
    relay_routes.clear();
    if allow_relay_for_others {
        let mut origins: Vec<(&String, &PeerSession)> = peers
            .iter()
            .filter(|(_, p)| is_direct_peer(p) && p.voice_in_call && p.voice_allow_relayed_voice)
            .collect();
        origins.sort_by_key(|(k, p)| (p.voice_muted as u8, p.rtt_ms.unwrap_or(9999), (*k).clone()));

        for (orig_key, orig_peer) in origins {
            if relay_routes.len() >= dynamic_cap {
                break;
            }
            let mut forwards = Vec::new();
            for blocked in &orig_peer.voice_blocked_peers {
                let target_key = blocked.to_ascii_lowercase();
                if target_key == *orig_key || target_key == local_username.to_ascii_lowercase() {
                    continue;
                }
                if let Some(target_peer) = peers.get(&target_key) {
                    if is_direct_peer(target_peer)
                        && target_peer.voice_in_call
                        && !target_peer.voice_deafened
                        && target_peer.voice_allow_relayed_voice
                    {
                        if let Some(t_addr) = target_peer.active_addr {
                            forwards.push(VoiceRelayForward {
                                target_addr: t_addr,
                                target_tx: Arc::clone(&target_peer.voice_tx),
                            });
                        }
                    }
                }
            }
            if !forwards.is_empty() {
                relay_routes.insert(orig_key.clone(), forwards);
            }
        }
    }
    voice_handle
        .active_relay_streams
        .store(relay_routes.len().min(255) as u8, Ordering::Relaxed);

    roster.sort_by_key(|a| a.username.to_lowercase());
    {
        let mut w = voice_handle
            .tx_targets
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *w = tx_targets;
    }
    {
        let mut r = voice_handle
            .latest_roster
            .write()
            .unwrap_or_else(|e| e.into_inner());
        *r = roster.clone();
    }
    emit_opt(app, "voice://roster", roster);
    vid_changed
}

#[allow(clippy::too_many_arguments)]
fn try_handle_voice_udp(
    buf: &[u8],
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    voice_rx_peers: &mut HashMap<[u8; 4], VoiceRxPeerState>,
    peers: &HashMap<String, PeerSession>,
    relay_routes: &HashMap<String, Vec<VoiceRelayForward>>,
    voice_handle: &VoiceTransportHandle,
    start_instant: Instant,
) -> bool {
    if buf.len() < 12 + 16 {
        return false;
    }
    let Ok(tag): Result<[u8; 4], _> = buf[..4].try_into() else {
        return false;
    };
    let Some(rx_state) = voice_rx_peers.get_mut(&tag) else {
        return false;
    };
    #[cfg(test)]
    if peers
        .get(&rx_state.peer_key)
        .is_some_and(|p| p.test_drop_direct)
    {
        return false;
    }
    let Some(frame) = rx_state.crypto.open(buf) else {
        return true; // Matched voice tag, invalid or replayed -> drop immediately
    };
    let now_ms = epoch_ms(start_instant);
    if !rx_state.token_bucket.allow(now_ms) {
        return true; // Hop rate limit exceeded
    }
    let P2pWireFrame::Voice {
        voice_id,
        epoch,
        seq,
        ts_48k,
        flags,
        opus,
    } = frame
    else {
        return true;
    };
    let origin_allowed = rx_state
        .per_voice_buckets
        .entry(voice_id)
        .or_insert_with(|| PeerTokenBucket::new_voice_default(now_ms))
        .allow(now_ms);
    if !origin_allowed {
        return true; // Per-speaker stream rate limit exceeded
    }
    if rx_state.per_voice_buckets.len() > 16 {
        let keep_vids: HashSet<u8> = peers
            .values()
            .filter(|p| p.voice_in_call && p.voice_id > 0)
            .map(|p| p.voice_id)
            .collect();
        rx_state
            .per_voice_buckets
            .retain(|vid, _| *vid == voice_id || keep_vids.contains(vid));
    }
    voice_handle
        .last_voice_tx_rx_ms
        .store(now_ms, Ordering::Relaxed);
    rx_state.last_voice_pkt_at = Some(Instant::now());

    let relayed = (flags & VOICE_FLAG_RELAYED) != 0;
    let end_of_talk = (flags & VOICE_FLAG_END_OF_TALK) != 0;

    // 1-hop relay forwarding when not already relayed
    if !relayed && voice_handle.allow_relay_for_others.load(Ordering::Relaxed) {
        if let Some(forwards) = relay_routes.get(&rx_state.peer_key) {
            let fwd_frame = P2pWireFrame::Voice {
                voice_id,
                epoch,
                seq,
                ts_48k,
                flags: flags | VOICE_FLAG_RELAYED,
                opus: opus.clone(),
            };
            for fwd in forwards {
                let pkt = {
                    let mut c = fwd.target_tx.lock().unwrap_or_else(|e| e.into_inner());
                    c.seal(&fwd_frame)
                };
                if let Some(pkt) = pkt {
                    match fwd.target_addr {
                        SocketAddr::V4(_) => {
                            let _ = sock_v4.try_send_to(&pkt, fwd.target_addr);
                        }
                        SocketAddr::V6(_) => {
                            if let Some(s6) = sock_v6 {
                                let _ = s6.try_send_to(&pkt, fwd.target_addr);
                            }
                        }
                    }
                }
            }
        }
    }

    if !voice_handle.in_voice.load(Ordering::Relaxed) {
        return true;
    }

    let (origin_key, origin_username, origin_in_voice) = if relayed {
        // Relayed voice can only originate from a peer without a clean direct path (prefer non-direct match).
        let picked = peers
            .iter()
            .find(|(_, p)| {
                p.voice_in_call
                    && p.voice_id == voice_id
                    && p.prev_voice_epoch != Some(epoch)
                    && !is_direct_peer(p)
            })
            .or_else(|| {
                peers.iter().find(|(_, p)| {
                    p.voice_in_call && p.voice_id == voice_id && p.prev_voice_epoch != Some(epoch)
                })
            });
        if let Some((ok, op)) = picked {
            (ok.clone(), op.username.clone(), true)
        } else {
            return true;
        }
    } else {
        let in_call = peers
            .get(&rx_state.peer_key)
            .is_some_and(|p| p.voice_in_call && p.prev_voice_epoch != Some(epoch));
        (
            rx_state.peer_key.clone(),
            rx_state.username.clone(),
            in_call,
        )
    };

    if !origin_in_voice {
        return true;
    }

    voice_handle.push_rx_packet_and_notify(VoiceRxPacket {
        origin_key,
        origin_username,
        voice_id,
        epoch,
        seq,
        ts_48k,
        end_of_talk,
        relayed,
        opus,
        arrival_ms: now_ms,
    });
    true
}

async fn broadcast_local_voice_state(
    local_username: &str,
    peers: &mut HashMap<String, PeerSession>,
    voice_handle: &VoiceTransportHandle,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    now_ms: u64,
    only_peer_key: Option<&str>,
) {
    let blocked_voice_peers: Vec<String> = peers
        .iter()
        .filter(|(_, p)| !is_direct_peer(p))
        .map(|(k, _)| k.clone())
        .collect();
    let msg = P2pAppMessage::VoiceState {
        username: local_username.to_string(),
        voice_id: voice_handle.local_voice_id.load(Ordering::Relaxed),
        epoch: voice_handle.local_epoch.load(Ordering::Relaxed),
        in_voice: voice_handle.in_voice.load(Ordering::Relaxed),
        muted: voice_handle.muted.load(Ordering::Relaxed),
        deafened: voice_handle.deafened.load(Ordering::Relaxed),
        loss_pct_x10: voice_handle.local_loss_pct_x10.load(Ordering::Relaxed),
        allow_relay_for_others: voice_handle.allow_relay_for_others.load(Ordering::Relaxed),
        allow_relayed_voice: voice_handle.allow_relayed_voice.load(Ordering::Relaxed),
        voice_gen: voice_handle.local_voice_gen.load(Ordering::Relaxed),
        on_battery: voice_handle.on_battery.load(Ordering::Relaxed),
        est_upload_kbps: voice_handle.est_upload_kbps.load(Ordering::Relaxed),
        relay_cap: voice_handle.relay_capacity_streams.load(Ordering::Relaxed),
        relay_targets: blocked_voice_peers.clone(),
        blocked_voice_peers,
        ttl: 1,
    };
    let Ok(payload) = serde_json::to_vec(&msg) else {
        return;
    };
    for (key, peer) in peers.iter_mut() {
        if let Some(only) = only_peer_key {
            if key != only {
                continue;
            }
        }
        if is_direct_peer(peer) {
            let _ = send_reliable_payload(peer, &payload, sock_v4, sock_v6, now_ms).await;
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_p2p_actor(
    app: Option<AppHandle>,
    initial_username: String,
    room_psk: Option<[u8; 32]>,
    network_opts: LocalPathOptions,
    mut cmd_rx: mpsc::Receiver<P2pControlCmd>,
    voice_handle: Arc<VoiceTransportHandle>,
    test_loopback: bool,
    beacon_tx: mpsc::Sender<String>,
    align_tx: mpsc::Sender<P2pAutoAlignment>,
    reaction_fallback_tx: mpsc::Sender<ReactionFallbackPacket>,
    chat_fallback_tx: mpsc::Sender<ChatFallbackPacket>,
    chat_react_fallback_tx: mpsc::Sender<ChatReactFallbackPacket>,
) {
    let bind_v4 = if test_loopback {
        "127.0.0.1:0"
    } else {
        "0.0.0.0:0"
    };
    let Ok(sock_v4) = UdpSocket::bind(bind_v4).await.map(Arc::new) else {
        return;
    };
    let sock_v6 = if test_loopback {
        None
    } else {
        UdpSocket::bind("[::]:0").await.ok().map(Arc::new)
    };
    {
        *voice_handle
            .sock_v4
            .write()
            .unwrap_or_else(|e| e.into_inner()) = Some(Arc::clone(&sock_v4));
        *voice_handle
            .sock_v6
            .write()
            .unwrap_or_else(|e| e.into_inner()) = sock_v6.clone();
    }
    let local_port_v4 = sock_v4.local_addr().map(|a| a.port()).unwrap_or(0);
    let local_port_v6 = sock_v6
        .as_ref()
        .and_then(|s| s.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(0);

    let local_identity = P2pIdentity::generate();
    let local_pubkey = local_identity.pubkey;
    let local_session_id = local_identity.session_id;
    let start_instant = voice_handle.start_instant;

    const BEACON_COOLDOWN: Duration = Duration::from_millis(2500);
    let (internal_tx, mut internal_rx) = mpsc::channel::<InternalEvent>(32);
    let stun_in_flight = Arc::new(AtomicBool::new(!test_loopback));

    // Run non-blocking LAN + STUN + UPnP candidate discovery while Syncplay is already live
    if test_loopback {
        let mut cands = Vec::new();
        if let Ok(addr) = sock_v4.local_addr() {
            cands.push(P2pCandidate {
                kind: P2pCandidateKind::Lan,
                addr,
            });
        }
        let beacon = P2pBeacon {
            version: 1,
            nat_symmetric: false,
            pubkey: local_pubkey,
            session_id: local_session_id,
            candidates: cands,
        };
        #[cfg(test)]
        {
            *voice_handle.test_beacon.lock().unwrap() = Some(beacon.clone());
        }
        let _ = internal_tx.try_send(InternalEvent::LocalBeaconReady {
            beacon,
            nat_mode: "loopback".to_string(),
            upnp: None,
        });
    } else {
        let sock_stun = Arc::clone(&sock_v4);
        let int_tx = internal_tx.clone();
        let stun_flag = Arc::clone(&stun_in_flight);
        tokio::spawn(async move {
            let (lan_ip, global_v6, stun_res) = tokio::join!(
                discover_local_lan_v4(),
                discover_local_global_v6(),
                query_stun_candidates(&sock_stun),
            );
            stun_flag.store(false, Ordering::Release);
            let upnp = if let (Some(lip), true) = (lan_ip, local_port_v4 > 0) {
                try_upnp_port_map(lip, local_port_v4).await
            } else {
                None
            };
            let pcp_pmp = if upnp.is_none() {
                if let (Some(lip), true) = (lan_ip, local_port_v4 > 0) {
                    try_pcp_or_natpmp_port_map(lip, local_port_v4).await
                } else {
                    None
                }
            } else {
                None
            };
            let (stun_wan, raw_symmetric) = stun_res;
            let mapped = upnp.is_some() || pcp_pmp.is_some();
            let nat_symmetric = raw_symmetric && !mapped;

            let mut cands = Vec::new();
            if let Some(v6) = global_v6 {
                if local_port_v6 > 0 {
                    cands.push(P2pCandidate {
                        kind: P2pCandidateKind::Ipv6,
                        addr: SocketAddr::new(IpAddr::V6(v6), local_port_v6),
                    });
                }
            }
            if let Some(ip) = lan_ip {
                if local_port_v4 > 0 {
                    cands.push(P2pCandidate {
                        kind: P2pCandidateKind::Lan,
                        addr: SocketAddr::new(IpAddr::V4(ip), local_port_v4),
                    });
                }
            }
            if let Some((_, Some(ext_ip), ext_port)) = pcp_pmp {
                let addr = SocketAddr::new(IpAddr::V4(ext_ip), ext_port);
                if !cands.iter().any(|c| c.addr == addr) {
                    cands.push(P2pCandidate {
                        kind: P2pCandidateKind::Wan,
                        addr,
                    });
                }
            } else if let (Some((_, None, ext_port)), Some(sw)) = (pcp_pmp, stun_wan) {
                let addr = SocketAddr::new(sw.ip(), ext_port);
                if !cands.iter().any(|c| c.addr == addr) {
                    cands.push(P2pCandidate {
                        kind: P2pCandidateKind::Wan,
                        addr,
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

            let nat_mode = if upnp.is_some() {
                "upnp"
            } else if let Some((proto, _, _)) = pcp_pmp {
                proto
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
    let mut voice_rx_peers: HashMap<[u8; 4], VoiceRxPeerState> = HashMap::new();
    let mut voice_relay_routes: HashMap<String, Vec<VoiceRelayForward>> = HashMap::new();
    let mut last_voice_broadcast_at = Instant::now();
    let mut last_voice_eval_at = Instant::now();
    let mut last_roster_req_at = Instant::now();
    let mut last_uplink_eval_at = Instant::now();
    let mut uplink_tracker = UplinkBandwidthTracker::new();
    let mut peer_baseline_rtt_ms: HashMap<String, u32> = HashMap::new();
    let mut local_nat_symmetric = false;
    let mut local_beacon_str: Option<String> = None;
    let mut nat_mode = "discovering".to_string();
    let mut upnp_mapping: Option<UpnpMapping> = None;
    let mut last_beacon_sent_at: Option<Instant> = None;
    let mut sent_beacon_to_room = false;
    let mut beacon_echo_pending = false;

    let mut cached_ref_probes: Option<(String, Vec<SparseAudioProbe>)> = None;
    let mut ref_extract_cancel: Option<Arc<AtomicBool>> = None;
    let mut align_job: Option<AlignJobState> = None;
    let mut completed_sigs: HashSet<String> = HashSet::new();
    let mut force_realign_pending = false;
    let mut reaction_seq: u32 = 1;
    let mut seen_reactions: VecDeque<((String, u32), Instant)> = VecDeque::new();
    let mut seen_chat_msgs: VecDeque<((String, String), Instant)> = VecDeque::new();
    let mut seen_shared_subs: VecDeque<String> = VecDeque::new();

    let mut tick = tokio::time::interval(Duration::from_millis(120));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut udp_buf_v4 = [0u8; 2048];
    let mut udp_buf_v6 = [0u8; 2048];

    loop {
        tokio::select! {
            biased;
            Ok((n, src)) = sock_v4.recv_from(&mut udp_buf_v4), if !stun_in_flight.load(Ordering::Acquire) => {
                if try_handle_voice_udp(
                    &udp_buf_v4[..n],
                    &sock_v4,
                    sock_v6.as_ref(),
                    &mut voice_rx_peers,
                    &peers,
                    &voice_relay_routes,
                    &voice_handle,
                    start_instant,
                ) {
                    continue;
                }
                if let Some(evt) = handle_udp_packet(
                    &mut peers,
                    &udp_buf_v4[..n],
                    src,
                    &sock_v4,
                    start_instant,
                ).await {
                    dispatch_udp_event(
                        evt,
                        app.as_ref(),
                        network_opts,
                        &local_username,
                        local_session_id,
                        local_media.as_ref(),
                        &participants,
                        &mut peers,
                        &mut voice_relay_routes,
                        &voice_handle,
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
                        &mut seen_shared_subs,
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
                    if try_handle_voice_udp(
                        &udp_buf_v6[..n],
                        &sock_v4,
                        sock_v6.as_ref(),
                        &mut voice_rx_peers,
                        &peers,
                        &voice_relay_routes,
                        &voice_handle,
                        start_instant,
                    ) {
                        continue;
                    }
                    if let Some(evt) = handle_udp_packet(
                        &mut peers,
                        &udp_buf_v6[..n],
                        src,
                        s6,
                        start_instant,
                    ).await {
                        dispatch_udp_event(
                            evt,
                            app.as_ref(),
                            network_opts,
                            &local_username,
                            local_session_id,
                            local_media.as_ref(),
                            &participants,
                            &mut peers,
                            &mut voice_relay_routes,
                            &voice_handle,
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
                            &mut seen_shared_subs,
                            &nat_mode,
                        ).await;
                    }
                }
            }
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
                            app.as_ref(),
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
                        emit_p2p_status(app.as_ref(), &nat_mode, &peers, align_job.as_ref());
                    }
                    P2pControlCmd::UpdateParticipants(items) => {
                        participants.clear();
                        let mut active_keys = HashSet::new();
                        for item in items {
                            active_keys.insert(item.username.to_ascii_lowercase());
                            participants.insert(item.username.clone(), item);
                        }
                        peers.retain(|k, _| active_keys.contains(k));
                        voice_rx_peers.retain(|_, v| active_keys.contains(&v.peer_key));
                        voice_relay_routes.retain(|k, _| active_keys.contains(k));
                        if peers.is_empty() {
                            sent_beacon_to_room = false;
                            beacon_echo_pending = false;
                        }
                        if active_keys.len() > 1 && !sent_beacon_to_room {
                            if let Some(ref msg) = local_beacon_str {
                                if last_beacon_sent_at
                                    .is_none_or(|t| t.elapsed() >= BEACON_COOLDOWN)
                                {
                                    let _ = beacon_tx.try_send(msg.clone());
                                    last_beacon_sent_at = Some(Instant::now());
                                    sent_beacon_to_room = true;
                                    beacon_echo_pending = false;
                                } else {
                                    beacon_echo_pending = true;
                                }
                            } else {
                                beacon_echo_pending = true;
                            }
                        }
                        maybe_drive_auto_align(
                            app.as_ref(),
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
                        emit_p2p_status(app.as_ref(), &nat_mode, &peers, align_job.as_ref());
                        let _ = rebuild_voice_routing(
                            app.as_ref(),
                            &local_username,
                            local_session_id,
                            &participants,
                            &peers,
                            &voice_handle,
                            &mut voice_relay_routes,
                        );
                    }
                    P2pControlCmd::PeerJoined(username) => {
                        if !username.eq_ignore_ascii_case(&local_username) {
                            if let Some(ref msg) = local_beacon_str {
                                if last_beacon_sent_at
                                    .is_none_or(|t| t.elapsed() >= BEACON_COOLDOWN)
                                {
                                    let _ = beacon_tx.try_send(msg.clone());
                                    last_beacon_sent_at = Some(Instant::now());
                                    sent_beacon_to_room = true;
                                    beacon_echo_pending = false;
                                } else {
                                    beacon_echo_pending = true;
                                }
                            } else {
                                beacon_echo_pending = true;
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
                        const MAX_P2P_PEERS: usize = 32;
                        if !peers.contains_key(&key) && peers.len() >= MAX_P2P_PEERS {
                            continue;
                        }
                        let same_session = peers.get(&key).is_some_and(|p| {
                            p.beacon.pubkey == beacon.pubkey && p.beacon.session_id == beacon.session_id
                        });
                        if same_session {
                            continue;
                        }

                        let crypto = local_identity.establish_with_psk(
                            beacon.pubkey,
                            beacon.session_id,
                            room_psk,
                        );
                        let (v_tx, v_rx) = local_identity.establish_voice_with_psk(
                            beacon.pubkey,
                            beacon.session_id,
                            room_psk,
                        );
                        let v_rx_tag = v_rx.rx_tag;
                        voice_rx_peers.retain(|_, s| s.peer_key != key);
                        voice_rx_peers.insert(
                            v_rx_tag,
                            VoiceRxPeerState {
                                peer_key: key.clone(),
                                username: username.clone(),
                                crypto: v_rx,
                                token_bucket: PeerTokenBucket::new_relay_hop(epoch_ms(
                                    start_instant,
                                )),
                                per_voice_buckets: HashMap::new(),
                                last_voice_pkt_at: None,
                            },
                        );
                        let mut session = PeerSession {
                            username: username.clone(),
                            beacon,
                            crypto,
                            voice_tx: Arc::new(std::sync::Mutex::new(v_tx)),
                            reliable: ReliableChannel::new(),
                            state: LinkTransportState::Punching,
                            started_at: Instant::now(),
                            active_addr: None,
                            last_rx_at: None,
                            last_keepalive_at: Instant::now(),
                            last_repunch_at: Instant::now(),
                            punch_attempts: 0,
                            rtt_ms: None,
                            pending_pings: HashMap::new(),
                            offered_file_sig: None,
                            cant_relay_to: HashSet::new(),
                            voice_id: 0,
                            voice_epoch: 0,
                            prev_voice_epoch: None,
                            voice_gen: 0,
                            voice_in_call: false,
                            voice_muted: false,
                            voice_deafened: false,
                            voice_loss_pct: 0.0,
                            voice_allow_relay_for_others: true,
                            voice_allow_relayed_voice: true,
                            voice_on_battery: false,
                            voice_est_upload_kbps: UplinkBandwidthTracker::INITIAL_KBPS,
                            voice_relay_cap: 2,
                            last_voice_state_rx: None,
                            voice_blocked_peers: Vec::new(),
                            bidirectional_verified: false,
                            inbound_chat_window: (Instant::now(), 0),
                            inbound_reaction_window: (Instant::now(), 0),
                            inbound_align_window: (Instant::now(), 0),
                            #[cfg(test)]
                            test_drop_direct: false,
                        };
                        send_punch_burst(
                            &mut session,
                            local_nat_symmetric,
                            &sock_v4,
                            sock_v6.as_ref(),
                            start_instant,
                        )
                        .await;
                        peers.insert(key, session);

                        // Echo our own beacon if not yet shared recently so newcomer receives our candidates
                        if let Some(ref msg) = local_beacon_str {
                            if last_beacon_sent_at
                                .is_none_or(|t| t.elapsed() >= BEACON_COOLDOWN)
                            {
                                let _ = beacon_tx.try_send(msg.clone());
                                last_beacon_sent_at = Some(Instant::now());
                                sent_beacon_to_room = true;
                                beacon_echo_pending = false;
                            } else {
                                beacon_echo_pending = true;
                            }
                        } else {
                            beacon_echo_pending = true;
                        }
                        emit_p2p_status(app.as_ref(), &nat_mode, &peers, align_job.as_ref());
                        if rebuild_voice_routing(
                            app.as_ref(),
                            &local_username,
                            local_session_id,
                            &participants,
                            &peers,
                            &voice_handle,
                            &mut voice_relay_routes,
                        ) {
                            broadcast_local_voice_state(
                                &local_username,
                                &mut peers,
                                &voice_handle,
                                &sock_v4,
                                sock_v6.as_ref(),
                                epoch_ms(start_instant),
                                None,
                            )
                            .await;
                        }
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
                            app.as_ref(),
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
                        emit_p2p_status(app.as_ref(), &nat_mode, &peers, align_job.as_ref());
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

                        if fallback_needed {
                            let _ = reaction_fallback_tx.try_send(ReactionFallbackPacket {
                                avatar_id: clean_avatar,
                                emoji: clean_emoji,
                                count: clean_count,
                                seq,
                            });
                        } else if !direct_keys.is_empty() {
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
                        if fallback_needed {
                            let _ = chat_react_fallback_tx.try_send(ChatReactFallbackPacket {
                                msg_id: clean_id,
                                emoji: clean_emoji,
                            });
                        } else if !direct_keys.is_empty() {
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
                    P2pControlCmd::SendSubtitleShare {
                        id,
                        file_name,
                        ext,
                        lang,
                        content,
                    } => {
                        let clean_id = sanitize_chat_id(&id);
                        let Some(safe_ext) = sanitize_shared_subtitle_ext(&ext) else {
                            continue;
                        };
                        if clean_id.is_empty()
                            || content.is_empty()
                            || content.len() > MAX_SHARED_SUBTITLE_BYTES
                        {
                            continue;
                        }
                        let clean_name = sanitize_shared_subtitle_name(&file_name, safe_ext);
                        let clean_lang = lang
                            .as_deref()
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(|s| s.chars().take(16).collect::<String>());
                        let (direct_keys, relay_targets, _) =
                            compute_chat_routing(&peers, &participants, &local_username);
                        if direct_keys.is_empty() {
                            continue;
                        }
                        if !seen_shared_subs.contains(&clean_id) {
                            if seen_shared_subs.len() >= 64 {
                                seen_shared_subs.pop_front();
                            }
                            seen_shared_subs.push_back(clean_id.clone());
                        }
                        let app_msg = P2pAppMessage::SubtitleShare {
                            id: clean_id,
                            sender: local_username.clone(),
                            file_name: clean_name,
                            ext: safe_ext.to_string(),
                            lang: clean_lang,
                            content,
                            relay_targets,
                            ttl: 1,
                        };
                        if let Ok(payload) = serde_json::to_vec(&app_msg) {
                            if payload.len() <= MAX_RELIABLE_MSG_BYTES {
                                let now_ms = epoch_ms(start_instant);
                                for dk in &direct_keys {
                                    if let Some(peer) = peers.get_mut(dk) {
                                        let _ = send_reliable_payload_paced(
                                            peer,
                                            &payload,
                                            &sock_v4,
                                            sock_v6.as_ref(),
                                            now_ms,
                                            true,
                                        )
                                        .await;
                                    }
                                }
                            }
                        }
                    }
                    P2pControlCmd::UpdateLocalVoiceState => {
                        let _ = rebuild_voice_routing(
                            app.as_ref(),
                            &local_username,
                            local_session_id,
                            &participants,
                            &peers,
                            &voice_handle,
                            &mut voice_relay_routes,
                        );
                        broadcast_local_voice_state(
                            &local_username,
                            &mut peers,
                            &voice_handle,
                            &sock_v4,
                            sock_v6.as_ref(),
                            epoch_ms(start_instant),
                            None,
                        )
                        .await;
                        last_voice_broadcast_at = Instant::now();
                    }
                    #[cfg(test)]
                    P2pControlCmd::TestInjectBeacon {
                        username,
                        beacon,
                        drop_direct_from,
                    } => {
                        let key = username.to_ascii_lowercase();
                        let drop_direct = drop_direct_from
                            .iter()
                            .any(|d| d.eq_ignore_ascii_case(&username));
                        let crypto = local_identity.establish_with_psk(
                            beacon.pubkey,
                            beacon.session_id,
                            room_psk,
                        );
                        let (v_tx, v_rx) = local_identity.establish_voice_with_psk(
                            beacon.pubkey,
                            beacon.session_id,
                            room_psk,
                        );
                        let v_rx_tag = v_rx.rx_tag;
                        voice_rx_peers.retain(|_, s| s.peer_key != key);
                        voice_rx_peers.insert(
                            v_rx_tag,
                            VoiceRxPeerState {
                                peer_key: key.clone(),
                                username: username.clone(),
                                crypto: v_rx,
                                token_bucket: PeerTokenBucket::new_relay_hop(epoch_ms(
                                    start_instant,
                                )),
                                per_voice_buckets: HashMap::new(),
                                last_voice_pkt_at: None,
                            },
                        );
                        let mut session = PeerSession {
                            username: username.clone(),
                            beacon,
                            crypto,
                            voice_tx: Arc::new(std::sync::Mutex::new(v_tx)),
                            reliable: ReliableChannel::new(),
                            state: if drop_direct {
                                LinkTransportState::FallbackSyncplay
                            } else {
                                LinkTransportState::Punching
                            },
                            started_at: Instant::now(),
                            active_addr: None,
                            last_rx_at: None,
                            last_keepalive_at: Instant::now(),
                            last_repunch_at: Instant::now(),
                            punch_attempts: 0,
                            rtt_ms: None,
                            pending_pings: HashMap::new(),
                            offered_file_sig: None,
                            cant_relay_to: HashSet::new(),
                            voice_id: 0,
                            voice_epoch: 0,
                            prev_voice_epoch: None,
                            voice_gen: 0,
                            voice_in_call: false,
                            voice_muted: false,
                            voice_deafened: false,
                            voice_loss_pct: 0.0,
                            voice_allow_relay_for_others: true,
                            voice_allow_relayed_voice: true,
                            voice_on_battery: false,
                            voice_est_upload_kbps: UplinkBandwidthTracker::INITIAL_KBPS,
                            voice_relay_cap: 2,
                            last_voice_state_rx: None,
                            voice_blocked_peers: Vec::new(),
                            bidirectional_verified: false,
                            inbound_chat_window: (Instant::now(), 0),
                            inbound_reaction_window: (Instant::now(), 0),
                            inbound_align_window: (Instant::now(), 0),
                            test_drop_direct: drop_direct,
                        };
                        if !drop_direct {
                            send_punch_burst(
                                &mut session,
                                local_nat_symmetric,
                                &sock_v4,
                                sock_v6.as_ref(),
                                start_instant,
                            )
                            .await;
                        }
                        peers.insert(key, session);
                    }
                }
            }
            evt = internal_rx.recv() => {
                let Some(evt) = evt else { continue };
                match evt {
                    InternalEvent::LocalBeaconReady { beacon, nat_mode: nm, upnp } => {
                        local_nat_symmetric = beacon.nat_symmetric;
                        nat_mode = nm;
                        *voice_handle
                            .local_nat_mode
                            .write()
                            .unwrap_or_else(|e| e.into_inner()) = nat_mode.clone();
                        upnp_mapping = upnp;
                        let msg = encode_ep2_beacon(&beacon);
                        local_beacon_str = Some(msg.clone());
                        let should_send = (test_loopback
                            || participants.len() > 1
                            || !peers.is_empty()
                            || beacon_echo_pending)
                            && (!sent_beacon_to_room || beacon_echo_pending);
                        if should_send {
                            let _ = beacon_tx.try_send(msg);
                            last_beacon_sent_at = Some(Instant::now());
                            sent_beacon_to_room = true;
                            beacon_echo_pending = false;
                        }
                        emit_p2p_status(app.as_ref(), &nat_mode, &peers, align_job.as_ref());
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
                                let _ = send_reliable_payload_paced(
                                    peer,
                                    &payload,
                                    &sock_v4,
                                    sock_v6.as_ref(),
                                    now_ms,
                                    voice_handle.in_voice.load(Ordering::Relaxed),
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
                        emit_p2p_status(app.as_ref(), &nat_mode, &peers, align_job.as_ref());
                    }
                }
            }
            _ = tick.tick() => {
                let now_ms = epoch_ms(start_instant);
                let mut status_dirty = false;
                let mut newly_connected = false;
                let voice_active = voice_handle.in_voice.load(Ordering::Relaxed);
                let voice_busy = voice_handle.voice_recently_active();
                for (peer_key, peer) in peers.iter_mut() {
                    #[cfg(test)]
                    if peer.test_drop_direct {
                        continue;
                    }
                    match peer.state {
                        LinkTransportState::Punching => {
                            let elapsed = peer.started_at.elapsed();
                            if elapsed >= Duration::from_secs(5) {
                                peer.state = LinkTransportState::FallbackSyncplay;
                                peer.last_repunch_at = Instant::now();
                                status_dirty = true;
                            } else if elapsed < Duration::from_millis(2500) || (now_ms % 480) < 130 {
                                send_punch_burst(
                                    peer,
                                    local_nat_symmetric,
                                    &sock_v4,
                                    sock_v6.as_ref(),
                                    start_instant,
                                )
                                .await;
                            }
                        }
                        LinkTransportState::DirectLan | LinkTransportState::DirectWan => {
                            let max_retx = if voice_busy {
                                2
                            } else if voice_active {
                                8
                            } else {
                                16
                            };
                            let retx = peer
                                .reliable
                                .collect_retransmits_bounded(now_ms, 260, max_retx);
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
                            if peer.bidirectional_verified
                                && peer
                                    .last_rx_at
                                    .is_some_and(|t| t.elapsed() >= Duration::from_secs(12))
                            {
                                // Inbound path went dark; demote bidirectional trust until KeepAlive/Pong returns
                                peer.bidirectional_verified = false;
                                status_dirty = true;
                            }
                            newly_connected |= peer.bidirectional_verified
                                && peer.last_rx_at.is_some_and(|t| t.elapsed() < Duration::from_millis(300));
                        }
                        LinkTransportState::FallbackSyncplay => {
                            #[cfg(test)]
                            let _ = test_loopback;
                            if !test_loopback && peer.last_repunch_at.elapsed() >= Duration::from_secs(20) {
                                peer.last_repunch_at = Instant::now();
                                send_punch_burst(
                                    peer,
                                    local_nat_symmetric,
                                    &sock_v4,
                                    sock_v6.as_ref(),
                                    start_instant,
                                )
                                .await;
                            }
                        }
                    }
                    // Evict ghost voice peers whose state hasn't refreshed within 25 s TTL
                    // (unless authenticated voice packets arrived recently).
                    let recent_voice_pkt = voice_rx_peers.values().any(|r| {
                        r.peer_key == *peer_key
                            && r.last_voice_pkt_at
                                .is_some_and(|t| t.elapsed() < Duration::from_secs(10))
                    });
                    if peer.voice_in_call
                        && !recent_voice_pkt
                        && peer
                            .last_voice_state_rx
                            .is_some_and(|t| t.elapsed() >= Duration::from_secs(25))
                    {
                        peer.voice_in_call = false;
                        peer.voice_blocked_peers.clear();
                        status_dirty = true;
                    }
                }
                if let Some(ref msg) = local_beacon_str {
                    if beacon_echo_pending
                        && last_beacon_sent_at.is_none_or(|t| t.elapsed() >= BEACON_COOLDOWN)
                    {
                        let _ = beacon_tx.try_send(msg.clone());
                        last_beacon_sent_at = Some(Instant::now());
                        sent_beacon_to_room = true;
                        beacon_echo_pending = false;
                    } else if !test_loopback
                        && last_beacon_sent_at.is_some_and(|t| t.elapsed() >= Duration::from_secs(10))
                    {
                        let needs_discovery_refresh = participants.values().any(|p| {
                            if p.username.eq_ignore_ascii_case(&local_username) {
                                return false;
                            }
                            let key = p.username.to_ascii_lowercase();
                            match peers.get(&key) {
                                None => true,
                                Some(ps) => {
                                    ps.last_rx_at.is_none()
                                        && ps.started_at.elapsed() < Duration::from_secs(35)
                                }
                            }
                        });
                        if needs_discovery_refresh {
                            let _ = beacon_tx.try_send(msg.clone());
                            last_beacon_sent_at = Some(Instant::now());
                        }
                    }
                }
                if voice_active && last_voice_broadcast_at.elapsed() >= Duration::from_secs(4) {
                    last_voice_broadcast_at = Instant::now();
                    broadcast_local_voice_state(
                        &local_username,
                        &mut peers,
                        &voice_handle,
                        &sock_v4,
                        sock_v6.as_ref(),
                        now_ms,
                        None,
                    )
                    .await;
                }
                let any_peer_in_voice = peers.values().any(|p| p.voice_in_call);
                if (voice_active || any_peer_in_voice)
                    && last_roster_req_at.elapsed() >= Duration::from_secs(5)
                {
                    last_roster_req_at = Instant::now();
                    if let Ok(req_payload) = serde_json::to_vec(&P2pAppMessage::VoiceRosterRequest) {
                        for peer in peers.values_mut() {
                            if is_direct_peer(peer) {
                                let _ = send_reliable_payload(
                                    peer,
                                    &req_payload,
                                    &sock_v4,
                                    sock_v6.as_ref(),
                                    now_ms,
                                )
                                .await;
                            }
                        }
                    }
                }
                if last_uplink_eval_at.elapsed() >= Duration::from_secs(2) && voice_active {
                    last_uplink_eval_at = Instant::now();
                    let wb_hits = voice_handle.udp_would_block_events.swap(0, Ordering::Relaxed);
                    for _ in 0..wb_hits.min(4) {
                        uplink_tracker.record_would_block();
                    }
                    let tx_n = voice_handle.tx_target_count();
                    let active_losses: Vec<f32> = peers
                        .values()
                        .filter(|p| p.voice_in_call)
                        .map(|p| p.voice_loss_pct)
                        .collect();
                    let avg_l = if active_losses.is_empty() {
                        0.0
                    } else {
                        active_losses.iter().sum::<f32>() / (active_losses.len() as f32)
                    };
                    let max_l = active_losses.iter().copied().fold(0.0f32, f32::max);
                    peer_baseline_rtt_ms.retain(|k, _| peers.contains_key(k));
                    let (worst_rtt, worst_base) = compute_worst_peer_rtt_inflation(
                        peers
                            .iter()
                            .filter(|(_, p)| p.voice_in_call)
                            .filter_map(|(k, p)| p.rtt_ms.map(|r| (k.as_str(), r))),
                        &mut peer_baseline_rtt_ms,
                    );
                    let est = uplink_tracker.observe_network(
                        tx_n,
                        avg_l,
                        max_l,
                        worst_rtt,
                        worst_base,
                    );
                    voice_handle.est_upload_kbps.store(est, Ordering::Relaxed);
                }
                if last_voice_eval_at.elapsed() >= Duration::from_secs(10) {
                    last_voice_eval_at = Instant::now();
                    if voice_active || any_peer_in_voice {
                        status_dirty = true;
                    }
                }
                if newly_connected || status_dirty {
                    if newly_connected {
                        broadcast_local_voice_state(
                            &local_username,
                            &mut peers,
                            &voice_handle,
                            &sock_v4,
                            sock_v6.as_ref(),
                            now_ms,
                            None,
                        )
                        .await;
                    }
                    maybe_drive_auto_align(
                        app.as_ref(),
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
                    emit_p2p_status(app.as_ref(), &nat_mode, &peers, align_job.as_ref());
                    if rebuild_voice_routing(
                        app.as_ref(),
                        &local_username,
                        local_session_id,
                        &participants,
                        &peers,
                        &voice_handle,
                        &mut voice_relay_routes,
                    ) {
                        broadcast_local_voice_state(
                            &local_username,
                            &mut peers,
                            &voice_handle,
                            &sock_v4,
                            sock_v6.as_ref(),
                            now_ms,
                            None,
                        )
                        .await;
                    }
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

#[allow(clippy::too_many_arguments)]
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
    let pace_for_voice = payload.len() > P2P_CHUNK_PAYLOAD_BYTES * 8;
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
                let _ = send_reliable_payload_paced(
                    target_peer,
                    &payload,
                    sock_v4,
                    sock_v6,
                    now_ms,
                    pace_for_voice,
                )
                .await;
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

/// Validates that an inbound P2P message's claimed sender is authentic:
/// - rejects self-echoes and arbitrary `ttl > 1`
/// - requires direct (`ttl > 0`) messages to match the authenticated P2P session `peer_key`
/// - rejects spoofed 1-hop relays (`ttl == 0`) for peers we already have a verified direct link with
/// - requires relayed senders to be active room participants
fn validate_p2p_sender(
    ttl: u8,
    sender_display: &str,
    peer_key: &str,
    local_username: &str,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &HashMap<String, PeerSession>,
) -> bool {
    if sender_display.eq_ignore_ascii_case(local_username) || ttl > 1 {
        return false;
    }
    let sender_key = sender_display.to_ascii_lowercase();
    if ttl > 0 && sender_key != peer_key {
        return false;
    }
    if ttl == 0 && sender_key != peer_key && peers.get(&sender_key).is_some_and(is_direct_peer) {
        return false;
    }
    sender_key == peer_key
        || participants
            .values()
            .any(|p| p.username.eq_ignore_ascii_case(sender_display))
}

#[allow(clippy::too_many_arguments)]
async fn dispatch_udp_event(
    evt: UdpPacketEvent,
    app: Option<&AppHandle>,
    network_opts: LocalPathOptions,
    local_username: &str,
    local_session_id: u32,
    local_media: Option<&P2pLocalMedia>,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &mut HashMap<String, PeerSession>,
    voice_relay_routes: &mut HashMap<String, Vec<VoiceRelayForward>>,
    voice_handle: &VoiceTransportHandle,
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
    seen_shared_subs: &mut VecDeque<String>,
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
                local_session_id,
                local_media,
                participants,
                peers,
                voice_relay_routes,
                voice_handle,
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
                seen_shared_subs,
            )
            .await;
            emit_p2p_status(app, nat_mode, peers, align_job.as_ref());
        }
        UdpPacketEvent::Connected(peer_key) => {
            broadcast_local_voice_state(
                local_username,
                peers,
                voice_handle,
                sock_v4,
                sock_v6,
                epoch_ms(start_instant),
                Some(&peer_key),
            )
            .await;
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
                false,
            )
            .await;
            emit_p2p_status(app, nat_mode, peers, align_job.as_ref());
            if rebuild_voice_routing(
                app,
                local_username,
                local_session_id,
                participants,
                peers,
                voice_handle,
                voice_relay_routes,
            ) {
                broadcast_local_voice_state(
                    local_username,
                    peers,
                    voice_handle,
                    sock_v4,
                    sock_v6,
                    epoch_ms(start_instant),
                    None,
                )
                .await;
            }
        }
        UdpPacketEvent::Datagram(from_key, dmsg) => match dmsg {
            P2pDatagramMessage::ChatTyping { is_typing, .. } => {
                // Typing is never relayed; always bind sender identity to the authenticated P2P session.
                let allowed = peers
                    .get_mut(&from_key)
                    .is_some_and(PeerSession::allow_inbound_chat);
                if !allowed {
                    return;
                }
                let sender_display: String = peers
                    .get(&from_key)
                    .map(|p| p.username.clone())
                    .unwrap_or_else(|| from_key.clone());
                if sender_display.eq_ignore_ascii_case(local_username) {
                    return;
                }
                emit_opt(
                    app,
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
                let raw_count = count.clamp(1, MAX_REACTION_BURST_COUNT);
                let clean_count = peers
                    .get_mut(&from_key)
                    .map(|p| p.allow_inbound_reaction(raw_count))
                    .unwrap_or(0);
                if clean_count == 0 {
                    return;
                }

                let sender_display = if sender.trim().is_empty() {
                    peers
                        .get(&from_key)
                        .map(|p| p.username.clone())
                        .unwrap_or_else(|| from_key.clone())
                } else {
                    sender.trim().chars().take(32).collect()
                };

                let sender_key = sender_display.to_ascii_lowercase();
                if !validate_p2p_sender(
                    ttl,
                    &sender_display,
                    &from_key,
                    local_username,
                    participants,
                    peers,
                ) {
                    return;
                }

                if record_seen_reaction(seen_reactions, &sender_key, seq) {
                    emit_opt(
                        app,
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
    local_nat_symmetric: bool,
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    start_instant: Instant,
) {
    let ts_ms = epoch_ms(start_instant);
    peer.pending_pings.insert(ts_ms, Instant::now());
    peer.punch_attempts = peer.punch_attempts.saturating_add(1);
    if peer.pending_pings.len() > 24 {
        let cutoff = Instant::now() - Duration::from_secs(6);
        peer.pending_pings.retain(|_, t| *t >= cutoff);
    }
    let Some(pkt) = peer.crypto.seal(&P2pWireFrame::PunchPing { ts_ms }) else {
        return;
    };
    // Rank candidates IPv6 > LAN > WAN
    let mut ranked = peer.beacon.candidates.clone();
    ranked.sort_by_key(|b| std::cmp::Reverse(candidate_priority(b.kind)));
    for cand in &ranked {
        let _ = send_via_matching_sock(sock_v4, sock_v6, &pkt, cand.addr).await;
    }
    // Staggered predictable/birthday port probes for symmetric NAT pairs (after attempt 1)
    if (local_nat_symmetric || peer.beacon.nat_symmetric) && peer.punch_attempts >= 2 {
        if let Some(wan_cand) = ranked.iter().find(|c| c.kind == P2pCandidateKind::Wan) {
            for probe_port in compute_birthday_probe_ports(
                wan_cand.addr.port(),
                6,
                peer.beacon.session_id.wrapping_add(peer.punch_attempts),
            ) {
                let probe_addr = SocketAddr::new(wan_cand.addr.ip(), probe_port);
                let _ = send_via_matching_sock(sock_v4, sock_v6, &pkt, probe_addr).await;
            }
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
    send_reliable_payload_paced(peer, payload, sock_v4, sock_v6, now_ms, false).await
}

async fn send_reliable_payload_paced(
    peer: &mut PeerSession,
    payload: &[u8],
    sock_v4: &UdpSocket,
    sock_v6: Option<&Arc<UdpSocket>>,
    now_ms: u64,
    pace_for_voice: bool,
) -> bool {
    let Some(addr) = peer.active_addr else {
        return false;
    };
    let Some((msg_id, frames)) = peer.reliable.enqueue_message(payload) else {
        return false;
    };
    if pace_for_voice && frames.len() > 8 {
        peer.reliable.mark_sent_prefix(msg_id, 8, now_ms);
        for frame in frames.into_iter().take(8) {
            if let Some(pkt) = peer.crypto.seal(&frame) {
                let _ = send_via_matching_sock(sock_v4, sock_v6, &pkt, addr).await;
            }
        }
    } else {
        peer.reliable.mark_sent(msg_id, now_ms);
        for frame in frames {
            if let Some(pkt) = peer.crypto.seal(&frame) {
                let _ = send_via_matching_sock(sock_v4, sock_v6, &pkt, addr).await;
            }
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
    #[cfg(test)]
    if peer.test_drop_direct {
        return None;
    }
    let peer_key = peer_key.clone();
    let frame = peer.crypto.open(buf)?;
    let was_direct = is_direct_peer(peer);

    let stale_existing = peer
        .last_rx_at
        .is_some_and(|t| t.elapsed() >= Duration::from_secs(6));
    peer.last_rx_at = Some(Instant::now());
    let is_addr_switch_proof = matches!(
        frame,
        P2pWireFrame::PunchPong { .. } | P2pWireFrame::KeepAlive { .. }
    );
    let keep_existing_better = !stale_existing
        && peer.active_addr.is_some_and(|existing| {
            existing != src
                && (!is_addr_switch_proof
                    || candidate_priority(infer_candidate_kind(existing))
                        > candidate_priority(infer_candidate_kind(src)))
        });
    if !keep_existing_better {
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
            // Receiving PunchPing only proves inbound reachability; trigger reverse ping until Pong confirms outbound
            if !peer.bidirectional_verified {
                let rev_ts = epoch_ms(start_instant);
                peer.pending_pings.insert(rev_ts, Instant::now());
                if peer.pending_pings.len() > 24 {
                    let cutoff = Instant::now() - Duration::from_secs(6);
                    peer.pending_pings.retain(|_, t| *t >= cutoff);
                }
                if let Some(rev_pkt) = peer.crypto.seal(&P2pWireFrame::PunchPing { ts_ms: rev_ts })
                {
                    let _ = reply_sock.send_to(&rev_pkt, active).await;
                }
            }
            None
        }
        P2pWireFrame::PunchPong { echo_ts_ms } | P2pWireFrame::KeepAlive { ts_ms: echo_ts_ms } => {
            peer.bidirectional_verified = true;
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
            if !was_direct && is_direct_peer(peer) {
                Some(UdpPacketEvent::Connected(peer_key))
            } else {
                None
            }
        }
        P2pWireFrame::Datagram { data } => {
            peer.state = if is_lan_ip(active.ip()) {
                LinkTransportState::DirectLan
            } else {
                LinkTransportState::DirectWan
            };
            if !peer.bidirectional_verified {
                let rev_ts = epoch_ms(start_instant);
                peer.pending_pings.insert(rev_ts, Instant::now());
                if peer.pending_pings.len() > 24 {
                    let cutoff = Instant::now() - Duration::from_secs(6);
                    peer.pending_pings.retain(|_, t| *t >= cutoff);
                }
                if let Some(rev_pkt) = peer.crypto.seal(&P2pWireFrame::PunchPing { ts_ms: rev_ts })
                {
                    let _ = reply_sock.send_to(&rev_pkt, active).await;
                }
            }
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
            if matches!(other, P2pWireFrame::Ack { .. }) {
                peer.bidirectional_verified = true;
            } else if !peer.bidirectional_verified {
                let rev_ts = epoch_ms(start_instant);
                peer.pending_pings.insert(rev_ts, Instant::now());
                if peer.pending_pings.len() > 24 {
                    let cutoff = Instant::now() - Duration::from_secs(6);
                    peer.pending_pings.retain(|_, t| *t >= cutoff);
                }
                if let Some(rev_pkt) = peer.crypto.seal(&P2pWireFrame::PunchPing { ts_ms: rev_ts })
                {
                    let _ = reply_sock.send_to(&rev_pkt, active).await;
                }
            }
            let (acks, assembled) = peer.reliable.handle_frame(other);
            for ack in acks {
                if let Some(pkt) = peer.crypto.seal(&ack) {
                    let _ = reply_sock.send_to(&pkt, active).await;
                }
            }
            if let Some(msg) =
                assembled.and_then(|bytes| serde_json::from_slice::<P2pAppMessage>(&bytes).ok())
            {
                Some(UdpPacketEvent::App(peer_key, msg))
            } else if !was_direct && is_direct_peer(peer) {
                Some(UdpPacketEvent::Connected(peer_key))
            } else {
                None
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn maybe_drive_auto_align(
    app: Option<&AppHandle>,
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

    let Some(app_handle) = app else {
        return;
    };
    let Some(ffmpeg) = resolve_ffmpeg_exe(app_handle) else {
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
    app: Option<&AppHandle>,
    network_opts: LocalPathOptions,
    peer_key: &str,
    msg: P2pAppMessage,
    local_username: &str,
    local_session_id: u32,
    local_media: Option<&P2pLocalMedia>,
    participants: &HashMap<String, RoomParticipantUpdate>,
    peers: &mut HashMap<String, PeerSession>,
    voice_relay_routes: &mut HashMap<String, Vec<VoiceRelayForward>>,
    voice_handle: &VoiceTransportHandle,
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
    seen_shared_subs: &mut VecDeque<String>,
) {
    if let P2pAppMessage::VoiceState {
        username,
        voice_id,
        epoch,
        in_voice,
        muted,
        deafened,
        loss_pct_x10,
        allow_relay_for_others,
        allow_relayed_voice,
        voice_gen,
        on_battery,
        est_upload_kbps,
        relay_cap,
        blocked_voice_peers,
        relay_targets,
        ttl,
    } = msg
    {
        let sender_display: String = if username.trim().is_empty() {
            peers
                .get(peer_key)
                .map(|p| p.username.clone())
                .unwrap_or_else(|| peer_key.to_string())
        } else {
            username.trim().chars().take(32).collect()
        };
        let sender_key = sender_display.to_ascii_lowercase();
        if !validate_p2p_sender(
            ttl,
            &sender_display,
            peer_key,
            local_username,
            participants,
            peers,
        ) {
            return;
        }
        let clean_blocked: Vec<String> = blocked_voice_peers
            .into_iter()
            .take(16)
            .map(|s| s.to_ascii_lowercase())
            .collect();
        if let Some(peer) = peers.get_mut(&sender_key) {
            if voice_gen != 0 && peer.voice_gen != 0 && voice_gen < peer.voice_gen {
                return; // Drop stale generation state packet
            }
            if peer.voice_epoch != 0 && peer.voice_epoch != epoch {
                peer.prev_voice_epoch = Some(peer.voice_epoch);
            }
            if in_voice {
                if peer.prev_voice_epoch == Some(epoch) {
                    peer.prev_voice_epoch = None;
                }
            } else if peer.voice_in_call {
                peer.prev_voice_epoch = Some(epoch);
            }
            if voice_gen > 0 {
                peer.voice_gen = voice_gen;
            }
            peer.voice_id = voice_id;
            peer.voice_epoch = epoch;
            peer.voice_in_call = in_voice;
            peer.voice_muted = muted;
            peer.voice_deafened = deafened;
            peer.voice_loss_pct = (loss_pct_x10 as f32) / 10.0;
            peer.voice_allow_relay_for_others = allow_relay_for_others;
            peer.voice_allow_relayed_voice = allow_relayed_voice;
            peer.voice_on_battery = on_battery;
            if est_upload_kbps > 0 {
                peer.voice_est_upload_kbps = est_upload_kbps;
            }
            if relay_cap > 0 {
                peer.voice_relay_cap = relay_cap;
            }
            peer.last_voice_state_rx = Some(Instant::now());
            peer.voice_blocked_peers = clean_blocked.clone();
        }
        if rebuild_voice_routing(
            app,
            local_username,
            local_session_id,
            participants,
            peers,
            voice_handle,
            voice_relay_routes,
        ) {
            broadcast_local_voice_state(
                local_username,
                peers,
                voice_handle,
                sock_v4,
                sock_v6,
                epoch_ms(start_instant),
                None,
            )
            .await;
        }
        if ttl > 0 && !relay_targets.is_empty() {
            let fwd = P2pAppMessage::VoiceState {
                username: sender_display,
                voice_id,
                epoch,
                in_voice,
                muted,
                deafened,
                loss_pct_x10,
                allow_relay_for_others,
                allow_relayed_voice,
                voice_gen,
                on_battery,
                est_upload_kbps,
                relay_cap,
                blocked_voice_peers: clean_blocked,
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

    if matches!(msg, P2pAppMessage::VoiceRosterRequest) {
        broadcast_local_voice_state(
            local_username,
            peers,
            voice_handle,
            sock_v4,
            sock_v6,
            epoch_ms(start_instant),
            Some(peer_key),
        )
        .await;
        return;
    }

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
        if !validate_p2p_sender(
            ttl,
            &sender_display,
            peer_key,
            local_username,
            participants,
            peers,
        ) {
            return;
        }

        if record_seen_chat_msg(seen_chat_msgs, &sender_key, &clean_id) {
            let allowed = peers
                .get_mut(peer_key)
                .is_some_and(PeerSession::allow_inbound_chat);
            if !allowed {
                return;
            }
            emit_opt(
                app,
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
        if !validate_p2p_sender(
            ttl,
            &sender_display,
            peer_key,
            local_username,
            participants,
            peers,
        ) {
            return;
        }
        emit_opt(
            app,
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
        if !validate_p2p_sender(
            ttl,
            &sender_display,
            peer_key,
            local_username,
            participants,
            peers,
        ) {
            return;
        }
        emit_opt(
            app,
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

    if let P2pAppMessage::SubtitleShare {
        id,
        sender,
        file_name,
        ext,
        lang,
        content,
        relay_targets,
        ttl,
    } = msg
    {
        let clean_id = sanitize_chat_id(&id);
        let Some(safe_ext) = sanitize_shared_subtitle_ext(&ext) else {
            return;
        };
        if clean_id.is_empty()
            || content.trim().is_empty()
            || content.len() > MAX_SHARED_SUBTITLE_BYTES
        {
            return;
        }
        let clean_name = sanitize_shared_subtitle_name(&file_name, safe_ext);
        let clean_lang = lang
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| s.chars().take(16).collect::<String>());
        let sender_display: String = if sender.trim().is_empty() {
            peers
                .get(peer_key)
                .map(|p| p.username.clone())
                .unwrap_or_else(|| peer_key.to_string())
        } else {
            sender.trim().chars().take(32).collect()
        };
        let sender_key = sender_display.to_ascii_lowercase();
        if !validate_p2p_sender(
            ttl,
            &sender_display,
            peer_key,
            local_username,
            participants,
            peers,
        ) {
            return;
        }
        let size_bytes = content.len();
        if !seen_shared_subs.contains(&clean_id) {
            let allowed = peers
                .get_mut(peer_key)
                .is_some_and(PeerSession::allow_inbound_chat);
            if !allowed {
                return;
            }
            if seen_shared_subs.len() >= 64 {
                seen_shared_subs.pop_front();
            }
            seen_shared_subs.push_back(clean_id.clone());
            emit_opt(
                app,
                "sync://subtitle-shared",
                serde_json::json!({
                    "id": clean_id,
                    "sender": sender_display,
                    "fileName": clean_name,
                    "ext": safe_ext,
                    "lang": clean_lang,
                    "content": content,
                    "sizeBytes": size_bytes,
                }),
            );
        }
        if ttl > 0 && !relay_targets.is_empty() {
            let fwd = P2pAppMessage::SubtitleShare {
                id: clean_id,
                sender: sender_display,
                file_name: clean_name,
                ext: safe_ext.to_string(),
                lang: clean_lang,
                content,
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
    let Some(app_handle) = app else {
        return;
    };
    let Some(ffmpeg) = resolve_ffmpeg_exe(app_handle) else {
        return;
    };
    let Ok(valid_vp) = validate_video_for_sparse_probe(&local_path.to_string_lossy(), network_opts)
    else {
        return;
    };

    match msg {
        P2pAppMessage::ChatMessage { .. }
        | P2pAppMessage::ChatEdit { .. }
        | P2pAppMessage::ChatReact { .. }
        | P2pAppMessage::SubtitleShare { .. }
        | P2pAppMessage::VoiceState { .. }
        | P2pAppMessage::VoiceRosterRequest => {}
        P2pAppMessage::OfferRequest => {
            if !peers
                .get_mut(peer_key)
                .is_some_and(PeerSession::allow_inbound_align)
            {
                return;
            }
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
            let req_ts: Vec<f64> = timestamps_secs
                .into_iter()
                .filter(|t| t.is_finite() && *t >= 0.0 && *t < local_dur)
                .take(4)
                .collect();
            if req_ts.is_empty() {
                return;
            }
            if !peers
                .get_mut(peer_key)
                .is_some_and(PeerSession::allow_inbound_align)
            {
                return;
            }
            let cancel = Arc::new(AtomicBool::new(false));
            let int_tx = internal_tx.clone();
            let target = peer_key.to_string();
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
            if !peers
                .get_mut(peer_key)
                .is_some_and(PeerSession::allow_inbound_align)
            {
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
            if !peers
                .get_mut(peer_key)
                .is_some_and(PeerSession::allow_inbound_align)
            {
                return;
            }
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

    struct LoopbackRx(Arc<VoiceTransportHandle>);

    impl LoopbackRx {
        fn try_recv(&self) -> Result<VoiceRxPacket, std::sync::mpsc::TryRecvError> {
            self.0.try_recv_rx_packet()
        }
    }

    struct LoopbackNode {
        username: String,
        cmd_tx: mpsc::Sender<P2pControlCmd>,
        voice: Arc<VoiceTransportHandle>,
        rx: LoopbackRx,
        beacon: P2pBeacon,
    }

    async fn spawn_loopback_node(username: &str) -> LoopbackNode {
        let (cmd_tx, cmd_rx) = mpsc::channel::<P2pControlCmd>(128);
        let voice = Arc::new(VoiceTransportHandle::new(cmd_tx.clone()));
        let (b_tx, mut b_rx) = mpsc::channel::<String>(8);
        let (a_tx, _a_rx) = mpsc::channel(4);
        let (r_tx, _r_rx) = mpsc::channel(4);
        let (c_tx, _c_rx) = mpsc::channel(4);
        let (cr_tx, _cr_rx) = mpsc::channel(4);

        tokio::spawn(run_p2p_actor(
            None,
            username.to_string(),
            None,
            LocalPathOptions::default(),
            cmd_rx,
            Arc::clone(&voice),
            true,
            b_tx,
            a_tx,
            r_tx,
            c_tx,
            cr_tx,
        ));

        let _beacon_str = tokio::time::timeout(Duration::from_secs(2), b_rx.recv())
            .await
            .expect("beacon timeout")
            .expect("beacon channel closed");
        let beacon = voice
            .test_beacon
            .lock()
            .unwrap()
            .clone()
            .expect("test beacon populated");
        let rx = LoopbackRx(Arc::clone(&voice));
        LoopbackNode {
            username: username.to_string(),
            cmd_tx,
            voice,
            rx,
            beacon,
        }
    }

    fn make_test_participant(name: &str) -> RoomParticipantUpdate {
        RoomParticipantUpdate {
            username: name.to_string(),
            room: "test-room".to_string(),
            position: 0.0,
            file: None,
            is_ready: Some(true),
            is_controller: false,
            paused: false,
        }
    }

    #[tokio::test]
    async fn loopback_2peer_direct_and_3peer_relay_voice_fast_path() {
        let mut a = spawn_loopback_node("Alice").await;
        let mut b = spawn_loopback_node("Bob").await;
        let mut c = spawn_loopback_node("Charlie").await;

        let parts = vec![
            make_test_participant("Alice"),
            make_test_participant("Bob"),
            make_test_participant("Charlie"),
        ];
        for n in [&a, &b, &c] {
            let _ = n
                .cmd_tx
                .send(P2pControlCmd::UpdateParticipants(parts.clone()))
                .await;
        }

        // Alice <-> Bob direct, Bob <-> Charlie direct, Alice <-> Charlie blocked (tests 1-hop relay via Bob)
        let _ = a
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: b.username.clone(),
                beacon: b.beacon.clone(),
                drop_direct_from: vec![],
            })
            .await;
        let _ = a
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: c.username.clone(),
                beacon: c.beacon.clone(),
                drop_direct_from: vec!["Charlie".to_string()],
            })
            .await;

        let _ = b
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: a.username.clone(),
                beacon: a.beacon.clone(),
                drop_direct_from: vec![],
            })
            .await;
        let _ = b
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: c.username.clone(),
                beacon: c.beacon.clone(),
                drop_direct_from: vec![],
            })
            .await;

        let _ = c
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: b.username.clone(),
                beacon: b.beacon.clone(),
                drop_direct_from: vec![],
            })
            .await;
        let _ = c
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: a.username.clone(),
                beacon: a.beacon.clone(),
                drop_direct_from: vec!["Alice".to_string()],
            })
            .await;

        tokio::time::sleep(Duration::from_millis(120)).await;

        // Alice and Charlie join voice; Bob joins too (or relays with allow_relay_for_others=true)
        a.voice
            .notify_local_state(true, 1, false, false, true, true);
        b.voice
            .notify_local_state(true, 1, false, false, true, true);
        c.voice
            .notify_local_state(true, 1, false, false, true, true);

        tokio::time::sleep(Duration::from_millis(350)).await;

        // Send 20 voice packets from Alice (simulating 5% drop on receiver check)
        for seq in 0..20u16 {
            let payload = vec![0x42u8; 64];
            a.voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &payload);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        tokio::time::sleep(Duration::from_millis(150)).await;

        let mut b_count = 0usize;
        while let Ok(pkt) = b.rx.try_recv() {
            if pkt.origin_key == "alice" && !pkt.relayed {
                b_count += 1;
            }
        }
        let mut c_relayed = 0usize;
        while let Ok(pkt) = c.rx.try_recv() {
            if pkt.origin_key == "alice" && pkt.relayed {
                c_relayed += 1;
            }
        }
        assert!(
            b_count >= 18,
            "Bob should receive direct frames, got {b_count}; a_targets={} a_roster={:?} b_roster={:?}",
            a.voice.tx_target_count(),
            a.voice.roster_snapshot(),
            b.voice.roster_snapshot()
        );
        assert!(
            c_relayed >= 15,
            "Charlie should receive 1-hop relayed frames via Bob, got {c_relayed}"
        );

        for n in [&mut a, &mut b, &mut c] {
            let _ = n.cmd_tx.send(P2pControlCmd::Shutdown).await;
        }
    }

    #[tokio::test]
    async fn loopback_4peer_impairment_and_fast_path_latency_under_chunk_load() {
        use epilod_core::voice_dsp::{JitterPacket, PeerJitterBuffer};

        let mut nodes = vec![
            spawn_loopback_node("N1").await,
            spawn_loopback_node("N2").await,
            spawn_loopback_node("N3").await,
            spawn_loopback_node("N4").await,
        ];
        let parts: Vec<RoomParticipantUpdate> = nodes
            .iter()
            .map(|n| make_test_participant(&n.username))
            .collect();
        for n in &nodes {
            let _ = n
                .cmd_tx
                .send(P2pControlCmd::UpdateParticipants(parts.clone()))
                .await;
        }
        let beacons: Vec<(String, P2pBeacon)> = nodes
            .iter()
            .map(|n| (n.username.clone(), n.beacon.clone()))
            .collect();
        for n in &nodes {
            for (u, bc) in &beacons {
                if u != &n.username {
                    let _ = n
                        .cmd_tx
                        .send(P2pControlCmd::TestInjectBeacon {
                            username: u.clone(),
                            beacon: bc.clone(),
                            drop_direct_from: vec![],
                        })
                        .await;
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(120)).await;
        for n in &nodes {
            n.voice
                .notify_local_state(true, 1, false, false, true, true);
        }
        tokio::time::sleep(Duration::from_millis(320)).await;

        // Blast a large reliable message (100 KB) concurrently with 50 pps voice from N1
        let big_text = "x".repeat(480);
        for _ in 0..4 {
            let _ = nodes[0]
                .cmd_tx
                .send(P2pControlCmd::SendChat {
                    id: "burst".to_string(),
                    text: big_text.clone(),
                    avatar_id: "default".to_string(),
                    reply_to_id: None,
                })
                .await;
        }

        let mut delays_ms = Vec::new();
        for seq in 0..40u16 {
            let t0 = nodes[0].voice.start_instant.elapsed().as_millis() as u64;
            let mut payload = vec![0u8; 64];
            payload[..8].copy_from_slice(&t0.to_be_bytes());
            nodes[0]
                .voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &payload);
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;

        // Feed N2's received packets through a 5% loss + 0..80ms jitter impairment into PeerJitterBuffer
        // stepping playback every 20ms just like the real mix thread
        let mut jb = PeerJitterBuffer::new();
        let mut received = 0usize;
        let mut decoded_or_fec = 0usize;
        let mut rng = 0x9E37_79B9u32;
        while let Ok(pkt) = nodes[1].rx.try_recv() {
            if pkt.origin_key == "n1" && pkt.opus.len() >= 8 {
                let sent_ms = u64::from_be_bytes(pkt.opus[..8].try_into().unwrap());
                delays_ms.push(pkt.arrival_ms.saturating_sub(sent_ms));
                received += 1;

                rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
                if !rng.is_multiple_of(20) {
                    let jitter = (rng >> 16) % 80;
                    jb.push(
                        JitterPacket {
                            seq: pkt.seq,
                            epoch: pkt.epoch,
                            ts_48k: pkt.ts_48k,
                            end_of_talk: pkt.end_of_talk,
                            opus: pkt.opus,
                        },
                        pkt.arrival_ms + jitter as u64,
                    );
                }
                let (opus, _fec, _plc) = jb.pop_step();
                if opus.is_some() {
                    decoded_or_fec += 1;
                }
            }
        }
        assert!(
            received >= 36,
            "N2 should receive voice under chunk load, got {received}"
        );
        delays_ms.sort_unstable();
        let p99_idx = ((delays_ms.len() * 99) / 100).min(delays_ms.len().saturating_sub(1));
        assert!(
            delays_ms[p99_idx] <= 15,
            "voice fast-path p99 delay under chunk burst too high: {} ms",
            delays_ms[p99_idx]
        );

        for _ in 0..8 {
            let (opus, _fec, _plc) = jb.pop_step();
            if opus.is_some() {
                decoded_or_fec += 1;
            }
        }
        assert!(
            decoded_or_fec >= 30,
            "JitterBuffer should recover >= 30 frames under 5% loss + jitter, got {decoded_or_fec}"
        );

        // Also simulate a 300 ms Wi-Fi burst stall (15 dropped packets 100..115 then recovery 115..140)
        let mut stall_jb = PeerJitterBuffer::new();
        for seq in 100..145u16 {
            if !(108..123).contains(&seq) {
                stall_jb.push(
                    JitterPacket {
                        seq,
                        epoch: 2,
                        ts_48k: (seq as u32) * 960,
                        end_of_talk: false,
                        opus: vec![seq as u8; 40],
                    },
                    (seq as u64) * 20,
                );
            }
            let _ = stall_jb.pop_step();
        }
        for _ in 0..10 {
            let _ = stall_jb.pop_step();
        }
        assert!(
            stall_jb.target_delay_ms() > 40,
            "Burst stall must grow adaptive jitter cushion, got {} ms",
            stall_jb.target_delay_ms()
        );
        assert!(
            stall_jb.max_gap_frames() <= 16,
            "Gap bounded during 300 ms burst stall, got {}",
            stall_jb.max_gap_frames()
        );

        for n in &mut nodes {
            let _ = n.cmd_tx.send(P2pControlCmd::Shutdown).await;
        }
    }

    #[tokio::test]
    async fn loopback_5peer_symmetric_nat_smart_relay_and_honest_block() {
        let mut strict_a = spawn_loopback_node("StrictA").await;
        let mut strict_b = spawn_loopback_node("StrictB").await;
        let mut bat_relay = spawn_loopback_node("BatRelay").await;
        let mut ac_relay = spawn_loopback_node("AcRelay").await;
        let mut isolated = spawn_loopback_node("Isolated").await;

        let parts = vec![
            make_test_participant(&strict_a.username),
            make_test_participant(&strict_b.username),
            make_test_participant(&bat_relay.username),
            make_test_participant(&ac_relay.username),
            make_test_participant(&isolated.username),
        ];
        for n in [&strict_a, &strict_b, &bat_relay, &ac_relay, &isolated] {
            let _ = n
                .cmd_tx
                .send(P2pControlCmd::UpdateParticipants(parts.clone()))
                .await;
        }

        bat_relay.voice.update_power_and_upload(true, 450);
        ac_relay.voice.update_power_and_upload(false, 2500);

        let wire = |src: &mut LoopbackNode, dst: &LoopbackNode, drop: bool| {
            let mut drop_list = Vec::new();
            if drop {
                drop_list.push(dst.username.clone());
            }
            let _ = src.cmd_tx.try_send(P2pControlCmd::TestInjectBeacon {
                username: dst.username.clone(),
                beacon: dst.beacon.clone(),
                drop_direct_from: drop_list,
            });
        };

        // StrictA <-> StrictB blocked directly; both reach BatRelay & AcRelay; Isolated blocked from everyone
        wire(&mut strict_a, &strict_b, true);
        wire(&mut strict_b, &strict_a, true);
        wire(&mut strict_a, &bat_relay, false);
        wire(&mut bat_relay, &strict_a, false);
        wire(&mut strict_a, &ac_relay, false);
        wire(&mut ac_relay, &strict_a, false);
        wire(&mut strict_b, &bat_relay, false);
        wire(&mut bat_relay, &strict_b, false);
        wire(&mut strict_b, &ac_relay, false);
        wire(&mut ac_relay, &strict_b, false);
        wire(&mut bat_relay, &ac_relay, false);
        wire(&mut ac_relay, &bat_relay, false);

        // Isolated cannot reach StrictA directly; reaches BatRelay directly so StrictA hears Isolated's VoiceState
        // via 1-hop signaling, while Isolated opts out of relaying -> honest "blocked" status in StrictA's roster!
        for other in [&strict_a, &strict_b, &ac_relay] {
            wire(&mut isolated, other, true);
        }
        wire(&mut strict_a, &isolated, true);
        wire(&mut strict_b, &isolated, true);
        wire(&mut ac_relay, &isolated, true);
        wire(&mut isolated, &bat_relay, false);
        wire(&mut bat_relay, &isolated, false);

        tokio::time::sleep(Duration::from_millis(180)).await;
        for n in [&strict_a, &strict_b, &bat_relay, &ac_relay] {
            n.voice
                .notify_local_state(true, 1, false, false, true, true);
        }
        isolated
            .voice
            .notify_local_state(true, 1, false, false, false, false);
        tokio::time::sleep(Duration::from_millis(380)).await;

        let roster_a = strict_a.voice.roster_snapshot();
        let sb_entry = roster_a
            .iter()
            .find(|r| r.username == "StrictB")
            .expect("StrictB in StrictA roster");
        assert_eq!(sb_entry.transport, "relayed");
        assert_eq!(sb_entry.relay_via.as_deref(), Some("AcRelay"));

        let iso_entry = roster_a
            .iter()
            .find(|r| r.username == "Isolated")
            .expect("Isolated in StrictA roster");
        assert_eq!(iso_entry.transport, "blocked");
        assert!(iso_entry.health_reason.is_some());
        assert!(iso_entry.health_fix.is_some());

        for n in [strict_a, strict_b, bat_relay, ac_relay, isolated] {
            let _ = n.cmd_tx.send(P2pControlCmd::Shutdown).await;
        }
    }

    #[tokio::test]
    async fn loopback_8peer_mesh_bitrate_cap_and_deafened_skip() {
        use epilod_core::voice_dsp::AdaptiveBitrateController;

        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps(7, 2000),
            24_000
        );
        assert_eq!(
            AdaptiveBitrateController::room_bitrate_cap_bps(4, 2000),
            32_000
        );

        let mut nodes = Vec::with_capacity(8);
        for i in 1..=8 {
            nodes.push(spawn_loopback_node(&format!("Peer{i}")).await);
        }
        let parts: Vec<RoomParticipantUpdate> = nodes
            .iter()
            .map(|n| make_test_participant(&n.username))
            .collect();
        let beacons: Vec<(String, P2pBeacon)> = nodes
            .iter()
            .map(|n| (n.username.clone(), n.beacon.clone()))
            .collect();
        for n in &nodes {
            let _ = n
                .cmd_tx
                .send(P2pControlCmd::UpdateParticipants(parts.clone()))
                .await;
            for (u, bc) in &beacons {
                if u != &n.username {
                    let _ = n
                        .cmd_tx
                        .send(P2pControlCmd::TestInjectBeacon {
                            username: u.clone(),
                            beacon: bc.clone(),
                            drop_direct_from: vec![],
                        })
                        .await;
                }
            }
        }

        tokio::time::sleep(Duration::from_millis(200)).await;
        // Join all 8 peers, with Peer8 deafened so transmitters skip sending audio to Peer8
        for (idx, n) in nodes.iter().enumerate() {
            let deaf = idx == 7;
            n.voice.notify_local_state(true, 1, deaf, deaf, true, true);
        }
        tokio::time::sleep(Duration::from_millis(360)).await;

        assert_eq!(
            nodes[0].voice.tx_target_count(),
            6,
            "Peer1 should target 6 active non-deafened peers (skipping deafened Peer8)"
        );

        let t0 = Instant::now();
        for seq in 0..10u16 {
            nodes[0]
                .voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &[0x5Au8; 48]);
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let elapsed_ms = t0.elapsed().as_millis();
        tokio::time::sleep(Duration::from_millis(120)).await;

        for (idx, node) in nodes.iter().enumerate().take(7).skip(1) {
            let mut got = 0usize;
            while let Ok(pkt) = node.rx.try_recv() {
                if pkt.origin_key == "peer1" {
                    got += 1;
                }
            }
            assert!(got >= 9, "Peer{} expected >=9 packets, got {got}", idx + 1);
        }
        let mut deaf_got = 0usize;
        while nodes[7].rx.try_recv().is_ok() {
            deaf_got += 1;
        }
        assert_eq!(
            deaf_got, 0,
            "Deafened Peer8 must receive 0 wasted TX packets"
        );
        assert!(
            elapsed_ms < 2000,
            "8-peer fanout took unexpectedly long: {elapsed_ms} ms"
        );

        for n in &mut nodes {
            let _ = n.cmd_tx.send(P2pControlCmd::Shutdown).await;
        }
    }

    #[tokio::test]
    async fn loopback_500_iteration_randomized_session_churn_no_ghosts() {
        let mut n1 = spawn_loopback_node("Churn1").await;
        let mut n2 = spawn_loopback_node("Churn2").await;
        let mut n3 = spawn_loopback_node("Churn3").await;

        let full_parts = vec![
            make_test_participant("Churn1"),
            make_test_participant("Churn2"),
            make_test_participant("Churn3"),
        ];
        for n in [&n1, &n2, &n3] {
            let _ = n
                .cmd_tx
                .send(P2pControlCmd::UpdateParticipants(full_parts.clone()))
                .await;
        }
        for (a, b) in [
            (&n1, &n2),
            (&n1, &n3),
            (&n2, &n1),
            (&n2, &n3),
            (&n3, &n1),
            (&n3, &n2),
        ] {
            let _ = a
                .cmd_tx
                .send(P2pControlCmd::TestInjectBeacon {
                    username: b.username.clone(),
                    beacon: b.beacon.clone(),
                    drop_direct_from: vec![],
                })
                .await;
        }
        tokio::time::sleep(Duration::from_millis(160)).await;

        // Deterministic seeded 500-iteration churn across join/leave/mute/deafen/epoch/host-order
        let mut rng = 0xDEADBEEFu32;
        let mut epochs = [1u8; 3];
        let handles = [&n1.voice, &n2.voice, &n3.voice];
        let cmds = [&n1.cmd_tx, &n2.cmd_tx, &n3.cmd_tx];
        for iter in 0..500usize {
            rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
            let who = (rng as usize) % 3;
            let op = (rng >> 8) % 5;
            match op {
                0 => {
                    epochs[who] = epochs[who].wrapping_add(1).max(1);
                    handles[who].notify_local_state(true, epochs[who], false, false, true, true);
                }
                1 => {
                    handles[who].notify_local_state(false, epochs[who], false, false, true, true);
                }
                2 => {
                    handles[who].notify_local_state(true, epochs[who], true, false, true, true);
                }
                3 => {
                    handles[who].notify_local_state(true, epochs[who], true, true, true, true);
                }
                _ => {
                    // Toggle host control order on participants list without leaving
                    let mut p = full_parts.clone();
                    p[who].is_controller = true;
                    let _ = cmds[who].try_send(P2pControlCmd::UpdateParticipants(p));
                }
            }
            if handles[who].in_voice.load(Ordering::Relaxed) {
                handles[who].send_voice_frame(
                    (iter & 0xFFFF) as u16,
                    (iter as u32) * 960,
                    false,
                    &[1, 2, 3, 4],
                );
            }
            if iter % 25 == 0 {
                tokio::time::sleep(Duration::from_millis(3)).await;
            }
        }

        // All leave cleanly, settle, and assert zero ghosts remain
        for (idx, h) in handles.iter().enumerate() {
            h.notify_local_state(false, epochs[idx], false, false, true, true);
        }
        tokio::time::sleep(Duration::from_millis(260)).await;
        for (idx, n) in [&n1, &n2, &n3].iter().enumerate() {
            let ghosts: Vec<_> = n
                .voice
                .roster_snapshot()
                .into_iter()
                .filter(|r| r.in_voice)
                .collect();
            assert!(
                ghosts.is_empty(),
                "Node {} kept ghost voice peers after leave: {ghosts:?}",
                idx + 1
            );
        }

        // Rejoin after churn and prove voice still transmits cleanly
        for (idx, h) in handles.iter().enumerate() {
            epochs[idx] = epochs[idx].wrapping_add(1).max(1);
            h.notify_local_state(true, epochs[idx], false, false, true, true);
        }
        tokio::time::sleep(Duration::from_millis(220)).await;
        while n2.rx.try_recv().is_ok() {}
        n1.voice.send_voice_frame(999, 999 * 960, false, &[7u8; 32]);
        tokio::time::sleep(Duration::from_millis(80)).await;
        let resumed = std::iter::from_fn(|| n2.rx.try_recv().ok())
            .any(|p| p.origin_key == "churn1" && p.epoch == epochs[0]);
        assert!(
            resumed,
            "Voice must resume cleanly on current epoch after 500-iter churn"
        );

        for n in [&mut n1, &mut n2, &mut n3] {
            let _ = n.cmd_tx.send(P2pControlCmd::Shutdown).await;
        }
    }

    #[tokio::test]
    async fn loopback_multi_speaker_relay_passes_without_token_bucket_drop() {
        let mut s1 = spawn_loopback_node("SpkOne").await;
        let mut s2 = spawn_loopback_node("SpkTwo").await;
        let mut lst = spawn_loopback_node("Listener").await;
        let mut rly = spawn_loopback_node("HubRelay").await;

        let parts = vec![
            make_test_participant("SpkOne"),
            make_test_participant("SpkTwo"),
            make_test_participant("Listener"),
            make_test_participant("HubRelay"),
        ];
        for n in [&s1, &s2, &lst, &rly] {
            let _ = n
                .cmd_tx
                .send(P2pControlCmd::UpdateParticipants(parts.clone()))
                .await;
        }

        let wire = |src: &mut LoopbackNode, dst: &LoopbackNode, drop: bool| {
            let drop_list = if drop {
                vec![dst.username.clone()]
            } else {
                Vec::new()
            };
            let _ = src.cmd_tx.try_send(P2pControlCmd::TestInjectBeacon {
                username: dst.username.clone(),
                beacon: dst.beacon.clone(),
                drop_direct_from: drop_list,
            });
        };

        // Everyone reaches HubRelay, while Listener is blocked directly from both speakers
        for n in [&mut s1, &mut s2, &mut lst] {
            wire(n, &rly, false);
        }
        for n in [&s1, &s2, &lst] {
            wire(&mut rly, n, false);
        }
        wire(&mut s1, &lst, true);
        wire(&mut lst, &s1, true);
        wire(&mut s2, &lst, true);
        wire(&mut lst, &s2, true);
        wire(&mut s1, &s2, true);
        wire(&mut s2, &s1, true);

        tokio::time::sleep(Duration::from_millis(160)).await;
        for n in [&s1, &s2, &lst, &rly] {
            n.voice
                .notify_local_state(true, 1, false, false, true, true);
        }
        tokio::time::sleep(Duration::from_millis(380)).await;
        while lst.rx.try_recv().is_ok() {}

        // Blast 20 frames each simultaneously (~130 pps combined across HubRelay hop, > 60 pps single-speaker cap)
        for seq in 0..20u16 {
            s1.voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &[0x11u8; 40]);
            s2.voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &[0x22u8; 40]);
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;

        let mut from_s1 = 0usize;
        let mut from_s2 = 0usize;
        while let Ok(pkt) = lst.rx.try_recv() {
            if pkt.origin_key == "spkone" && pkt.relayed {
                from_s1 += 1;
            } else if pkt.origin_key == "spktwo" && pkt.relayed {
                from_s2 += 1;
            }
        }
        assert!(
            from_s1 >= 18 && from_s2 >= 18,
            "Multi-speaker relay must not drop packets on hop token bucket: spkone={from_s1}, spktwo={from_s2}"
        );

        for n in [s1, s2, lst, rly] {
            let _ = n.cmd_tx.send(P2pControlCmd::Shutdown).await;
        }
    }

    #[test]
    fn simultaneous_join_voice_id_collision_resolves_deterministically() {
        let local_id = P2pIdentity::generate();
        let peer_id = P2pIdentity::generate();
        let fake_beacon = P2pBeacon {
            version: 1,
            nat_symmetric: false,
            pubkey: peer_id.pubkey,
            session_id: peer_id.session_id,
            candidates: Vec::new(),
        };
        let (v_tx, _) = local_id.establish_voice_with(peer_id.pubkey, peer_id.session_id);
        let crypto = local_id.establish_with(peer_id.pubkey, peer_id.session_id);

        let mut peers = HashMap::new();
        peers.insert(
            "alice".to_string(),
            PeerSession {
                username: "Alice".to_string(),
                beacon: fake_beacon,
                crypto,
                voice_tx: Arc::new(std::sync::Mutex::new(v_tx)),
                reliable: ReliableChannel::new(),
                state: LinkTransportState::DirectLan,
                started_at: Instant::now(),
                active_addr: None,
                last_rx_at: None,
                last_keepalive_at: Instant::now(),
                last_repunch_at: Instant::now(),
                punch_attempts: 0,
                rtt_ms: Some(15),
                pending_pings: HashMap::new(),
                offered_file_sig: None,
                cant_relay_to: HashSet::new(),
                voice_id: 77,
                voice_epoch: 1,
                prev_voice_epoch: None,
                voice_gen: 1,
                voice_in_call: true,
                voice_muted: false,
                voice_deafened: false,
                voice_loss_pct: 0.0,
                voice_allow_relay_for_others: true,
                voice_allow_relayed_voice: true,
                voice_on_battery: false,
                voice_est_upload_kbps: 600,
                voice_relay_cap: 2,
                last_voice_state_rx: Some(Instant::now()),
                voice_blocked_peers: Vec::new(),
                bidirectional_verified: true,
                inbound_chat_window: (Instant::now(), 0),
                inbound_reaction_window: (Instant::now(), 0),
                inbound_align_window: (Instant::now(), 0),
                test_drop_direct: false,
            },
        );

        // "bob" > "alice", so if bob currently holds colliding vid 77, bob yields deterministically
        let (new_vid, changed) = assign_local_voice_id(42, "Bob", 77, &peers);
        assert!(changed);
        assert_ne!(new_vid, 77);
        assert_ne!(new_vid, 0);

        // "aaa" < "alice", so if aaa holds vid 77, aaa keeps it cleanly
        let (kept_vid, changed_winner) = assign_local_voice_id(42, "Aaa", 77, &peers);
        assert!(!changed_winner);
        assert_eq!(kept_vid, 77);
    }

    #[tokio::test]
    async fn asymmetric_one_way_udp_ping_does_not_bypass_relay() {
        let sock_b = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let sock_a = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        let id_a = P2pIdentity::generate();
        let id_b = P2pIdentity::generate();
        let id_r = P2pIdentity::generate();

        let mut crypto_ab = id_a.establish_with(id_b.pubkey, id_b.session_id);
        let crypto_ba = id_b.establish_with(id_a.pubkey, id_a.session_id);
        let (vtx_ba, _) = id_b.establish_voice_with(id_a.pubkey, id_a.session_id);
        let crypto_br = id_b.establish_with(id_r.pubkey, id_r.session_id);
        let (vtx_br, _) = id_b.establish_voice_with(id_r.pubkey, id_r.session_id);

        let make_beacon = |id: &P2pIdentity| P2pBeacon {
            version: 1,
            nat_symmetric: false,
            pubkey: id.pubkey,
            session_id: id.session_id,
            candidates: Vec::new(),
        };

        let mut peers = HashMap::new();
        peers.insert(
            "alice".to_string(),
            PeerSession {
                username: "Alice".to_string(),
                beacon: make_beacon(&id_a),
                crypto: crypto_ba,
                voice_tx: Arc::new(std::sync::Mutex::new(vtx_ba)),
                reliable: ReliableChannel::new(),
                state: LinkTransportState::Punching,
                started_at: Instant::now(),
                active_addr: None,
                last_rx_at: None,
                last_keepalive_at: Instant::now(),
                last_repunch_at: Instant::now(),
                punch_attempts: 0,
                rtt_ms: None,
                pending_pings: HashMap::new(),
                offered_file_sig: None,
                cant_relay_to: HashSet::new(),
                voice_id: 11,
                voice_epoch: 1,
                prev_voice_epoch: None,
                voice_gen: 1,
                voice_in_call: true,
                voice_muted: false,
                voice_deafened: false,
                voice_loss_pct: 0.0,
                voice_allow_relay_for_others: true,
                voice_allow_relayed_voice: true,
                voice_on_battery: false,
                voice_est_upload_kbps: 600,
                voice_relay_cap: 2,
                last_voice_state_rx: Some(Instant::now()),
                voice_blocked_peers: Vec::new(),
                bidirectional_verified: false,
                inbound_chat_window: (Instant::now(), 0),
                inbound_reaction_window: (Instant::now(), 0),
                inbound_align_window: (Instant::now(), 0),
                test_drop_direct: false,
            },
        );
        peers.insert(
            "relay".to_string(),
            PeerSession {
                username: "Relay".to_string(),
                beacon: make_beacon(&id_r),
                crypto: crypto_br,
                voice_tx: Arc::new(std::sync::Mutex::new(vtx_br)),
                reliable: ReliableChannel::new(),
                state: LinkTransportState::DirectWan,
                started_at: Instant::now(),
                active_addr: Some("127.0.0.1:49999".parse().unwrap()),
                last_rx_at: Some(Instant::now()),
                last_keepalive_at: Instant::now(),
                last_repunch_at: Instant::now(),
                punch_attempts: 1,
                rtt_ms: Some(25),
                pending_pings: HashMap::new(),
                offered_file_sig: None,
                cant_relay_to: HashSet::new(),
                voice_id: 12,
                voice_epoch: 1,
                prev_voice_epoch: None,
                voice_gen: 1,
                voice_in_call: true,
                voice_muted: false,
                voice_deafened: false,
                voice_loss_pct: 0.0,
                voice_allow_relay_for_others: true,
                voice_allow_relayed_voice: true,
                voice_on_battery: false,
                voice_est_upload_kbps: 1500,
                voice_relay_cap: 3,
                last_voice_state_rx: Some(Instant::now()),
                voice_blocked_peers: Vec::new(),
                bidirectional_verified: true,
                inbound_chat_window: (Instant::now(), 0),
                inbound_reaction_window: (Instant::now(), 0),
                inbound_align_window: (Instant::now(), 0),
                test_drop_direct: false,
            },
        );

        // Deliver a one-way PunchPing from Alice -> Bob without Bob receiving any PunchPong back
        let ping_pkt = crypto_ab
            .seal(&P2pWireFrame::PunchPing { ts_ms: 100 })
            .unwrap();
        let src_a = sock_a.local_addr().unwrap();
        let start = Instant::now();
        let _ = handle_udp_packet(&mut peers, &ping_pkt, src_a, &sock_b, start).await;

        assert!(
            !peers["alice"].bidirectional_verified,
            "One-way PunchPing must NOT mark peer bidirectional"
        );
        assert!(
            !is_direct_peer(&peers["alice"]),
            "Unverified one-way path must not enter direct voice targets"
        );

        let (cmd_tx, _cmd_rx) = mpsc::channel(4);
        let voice_handle = VoiceTransportHandle::new(cmd_tx);
        voice_handle.in_voice.store(true, Ordering::Relaxed);
        let mut routes = HashMap::new();
        let mut parts = HashMap::new();
        parts.insert("Alice".to_string(), make_test_participant("Alice"));
        parts.insert("Relay".to_string(), make_test_participant("Relay"));
        rebuild_voice_routing(
            None,
            "Bob",
            id_b.session_id,
            &parts,
            &peers,
            &voice_handle,
            &mut routes,
        );
        let alice_row = voice_handle
            .roster_snapshot()
            .into_iter()
            .find(|r| r.username == "Alice")
            .unwrap();
        assert_eq!(alice_row.transport, "relayed");
        assert_eq!(alice_row.relay_via.as_deref(), Some("Relay"));
    }

    #[test]
    fn mixed_lan_and_wan_rtts_do_not_trigger_false_uplink_congestion() {
        let mut baselines = HashMap::new();
        let mut tracker = UplinkBandwidthTracker::new();
        let start_est = tracker.est_kbps();

        // Steady mixed room: LAN peer at 2 ms, overseas WAN peer at 85 ms
        for _ in 0..10 {
            let (worst_rtt, worst_base) = compute_worst_peer_rtt_inflation(
                [("lan_peer", 2u32), ("wan_peer", 85u32)],
                &mut baselines,
            );
            tracker.observe_network(2, 0.0, 0.0, worst_rtt, worst_base);
        }
        assert!(
            tracker.est_kbps() >= start_est,
            "Mixed LAN+WAN room must not trigger false congestion: est={}",
            tracker.est_kbps()
        );

        // Now inject real +95 ms bufferbloat on the WAN peer (85 -> 180 ms)
        let before_bloat = tracker.est_kbps();
        let (worst_rtt, worst_base) = compute_worst_peer_rtt_inflation(
            [("lan_peer", 3u32), ("wan_peer", 180u32)],
            &mut baselines,
        );
        tracker.observe_network(2, 0.0, 0.0, worst_rtt, worst_base);
        assert!(
            tracker.est_kbps() < before_bloat,
            "Real +95 ms per-peer RTT bloat must reduce uplink estimate"
        );
    }

    #[tokio::test]
    async fn voice_rx_receiver_survives_monitor_stop_and_rejoin() {
        let mut a = spawn_loopback_node("Alice").await;
        let mut b = spawn_loopback_node("Bob").await;

        let parts = vec![make_test_participant("Alice"), make_test_participant("Bob")];
        for n in [&a, &b] {
            let _ = n
                .cmd_tx
                .send(P2pControlCmd::UpdateParticipants(parts.clone()))
                .await;
        }
        let _ = a
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: b.username.clone(),
                beacon: b.beacon.clone(),
                drop_direct_from: vec![],
            })
            .await;
        let _ = b
            .cmd_tx
            .send(P2pControlCmd::TestInjectBeacon {
                username: a.username.clone(),
                beacon: a.beacon.clone(),
                drop_direct_from: vec![],
            })
            .await;
        tokio::time::sleep(Duration::from_millis(120)).await;

        // Simulate Bob opening Voice Settings (worker drains/clears while not in call) before joining
        b.voice.clear_rx_packets();
        a.voice
            .notify_local_state(true, 2, false, false, true, true);
        b.voice
            .notify_local_state(true, 2, false, false, true, true);
        tokio::time::sleep(Duration::from_millis(220)).await;

        for seq in 0..8u16 {
            a.voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &[0x55; 48]);
            tokio::time::sleep(Duration::from_millis(8)).await;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;

        let mut received_round_1 = 0usize;
        b.voice.drain_rx_packets(|pkt| {
            if pkt.origin_key == "alice" {
                received_round_1 += 1;
            }
        });
        assert!(
            received_round_1 >= 6,
            "Round 1 should deliver packets after prior clear, got {received_round_1}"
        );

        // Simulate Bob leaving voice & rejoining voice (epoch 3)
        b.voice
            .notify_local_state(false, 2, false, false, true, true);
        tokio::time::sleep(Duration::from_millis(100)).await;
        b.voice
            .notify_local_state(true, 3, false, false, true, true);
        tokio::time::sleep(Duration::from_millis(220)).await;

        for seq in 10..18u16 {
            a.voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &[0x66; 48]);
            tokio::time::sleep(Duration::from_millis(8)).await;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;

        let mut received_round_2 = 0usize;
        b.voice.drain_rx_packets(|pkt| {
            if pkt.origin_key == "alice" {
                received_round_2 += 1;
            }
        });
        assert!(
            received_round_2 >= 6,
            "Round 2 should still deliver packets after leave & rejoin, got {received_round_2}"
        );

        // Round 3: Simulate Alice dropping out and recovering under the SAME epoch (2):
        // prev_voice_epoch must be cleared when VoiceState { in_voice: true } arrives again.
        a.voice
            .notify_local_state(false, 2, false, false, true, true);
        tokio::time::sleep(Duration::from_millis(120)).await;
        a.voice
            .notify_local_state(true, 2, false, false, true, true);
        tokio::time::sleep(Duration::from_millis(220)).await;

        for seq in 20..28u16 {
            a.voice
                .send_voice_frame(seq, (seq as u32) * 960, false, &[0x77; 48]);
            tokio::time::sleep(Duration::from_millis(8)).await;
        }
        tokio::time::sleep(Duration::from_millis(80)).await;

        let mut received_round_3 = 0usize;
        b.voice.drain_rx_packets(|pkt| {
            if pkt.origin_key == "alice" && pkt.epoch == 2 {
                received_round_3 += 1;
            }
        });
        assert!(
            received_round_3 >= 6,
            "Round 3 should still deliver packets after same-epoch VoiceState recovery, got {received_round_3}"
        );

        for n in [&mut a, &mut b] {
            let _ = n.cmd_tx.send(P2pControlCmd::Shutdown).await;
        }
    }

    #[test]
    fn voice_transport_wait_for_rx_packet_wakes_immediately() {
        let (cmd_tx, _cmd_rx) = mpsc::channel(4);
        let handle = Arc::new(VoiceTransportHandle::new(cmd_tx));
        let mut last_seq = 0u64;
        assert!(!handle.wait_for_rx_packet(&mut last_seq, Duration::from_millis(5)));

        let h2 = Arc::clone(&handle);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(5));
            h2.push_rx_packet_and_notify(VoiceRxPacket {
                origin_key: "peer".to_string(),
                origin_username: "Peer".to_string(),
                voice_id: 1,
                epoch: 1,
                seq: 1,
                ts_48k: 960,
                end_of_talk: false,
                relayed: false,
                opus: vec![1, 2, 3],
                arrival_ms: 10,
            });
        });
        let woke = handle.wait_for_rx_packet(&mut last_seq, Duration::from_millis(200));
        t.join().unwrap();
        assert!(woke);
        assert!(last_seq > 0);
    }

    fn make_dummy_peer_session(
        username: &str,
        state: LinkTransportState,
        bidirectional_verified: bool,
    ) -> PeerSession {
        let local = P2pIdentity::generate();
        let remote = P2pIdentity::generate();
        let crypto = local.establish_with(remote.pubkey, remote.session_id);
        let (v_tx, _v_rx) = local.establish_voice_with(remote.pubkey, remote.session_id);
        PeerSession {
            username: username.to_string(),
            beacon: P2pBeacon {
                version: 1,
                nat_symmetric: false,
                pubkey: remote.pubkey,
                session_id: remote.session_id,
                candidates: Vec::new(),
            },
            crypto,
            voice_tx: Arc::new(std::sync::Mutex::new(v_tx)),
            reliable: ReliableChannel::new(),
            state,
            started_at: Instant::now(),
            active_addr: Some("127.0.0.1:12345".parse().unwrap()),
            last_rx_at: None,
            last_keepalive_at: Instant::now(),
            last_repunch_at: Instant::now(),
            punch_attempts: 0,
            rtt_ms: None,
            pending_pings: HashMap::new(),
            offered_file_sig: None,
            cant_relay_to: HashSet::new(),
            voice_id: 0,
            voice_epoch: 0,
            prev_voice_epoch: None,
            voice_gen: 0,
            voice_in_call: false,
            voice_muted: false,
            voice_deafened: false,
            voice_loss_pct: 0.0,
            voice_allow_relay_for_others: true,
            voice_allow_relayed_voice: true,
            voice_on_battery: false,
            voice_est_upload_kbps: UplinkBandwidthTracker::INITIAL_KBPS,
            voice_relay_cap: 2,
            last_voice_state_rx: None,
            voice_blocked_peers: Vec::new(),
            bidirectional_verified,
            inbound_chat_window: (Instant::now(), 0),
            inbound_reaction_window: (Instant::now(), 0),
            inbound_align_window: (Instant::now(), 0),
            test_drop_direct: false,
        }
    }

    #[test]
    fn validate_p2p_sender_blocks_direct_and_relay_impersonation() {
        let mut participants = HashMap::new();
        participants.insert("Alice".to_string(), make_test_participant("Alice"));
        participants.insert("Bob".to_string(), make_test_participant("Bob"));
        participants.insert("Charlie".to_string(), make_test_participant("Charlie"));

        let mut peers = HashMap::new();
        // Alice has a verified direct link; Bob has a verified direct link; Charlie is not direct.
        peers.insert(
            "alice".to_string(),
            make_dummy_peer_session("Alice", LinkTransportState::DirectWan, true),
        );
        peers.insert(
            "bob".to_string(),
            make_dummy_peer_session("Bob", LinkTransportState::DirectWan, true),
        );
        peers.insert(
            "charlie".to_string(),
            make_dummy_peer_session("Charlie", LinkTransportState::FallbackSyncplay, false),
        );

        // Direct message from Bob claiming to be Bob is allowed
        assert!(validate_p2p_sender(
            1,
            "Bob",
            "bob",
            "LocalUser",
            &participants,
            &peers
        ));
        // Direct message from Bob claiming to be Alice is rejected
        assert!(!validate_p2p_sender(
            1,
            "Alice",
            "bob",
            "LocalUser",
            &participants,
            &peers
        ));
        // Relayed message (ttl=0) from Bob claiming to be Alice is REJECTED because Alice is direct
        assert!(!validate_p2p_sender(
            0,
            "Alice",
            "bob",
            "LocalUser",
            &participants,
            &peers
        ));
        // Relayed message (ttl=0) from Bob claiming to be Charlie (non-direct participant) is allowed
        assert!(validate_p2p_sender(
            0,
            "Charlie",
            "bob",
            "LocalUser",
            &participants,
            &peers
        ));
        // Relayed message claiming to be an unknown outsider or self is rejected
        assert!(!validate_p2p_sender(
            0,
            "Mallory",
            "bob",
            "LocalUser",
            &participants,
            &peers
        ));
        assert!(!validate_p2p_sender(
            0,
            "LocalUser",
            "bob",
            "LocalUser",
            &participants,
            &peers
        ));
        // ttl > 1 is rejected
        assert!(!validate_p2p_sender(
            2,
            "Bob",
            "bob",
            "LocalUser",
            &participants,
            &peers
        ));
    }

    #[test]
    fn peer_session_allow_inbound_align_rate_limits_ffmpeg_requests() {
        let mut session = make_dummy_peer_session("Bob", LinkTransportState::DirectWan, true);
        for _ in 0..4 {
            assert!(session.allow_inbound_align());
        }
        assert!(!session.allow_inbound_align());
    }
}
