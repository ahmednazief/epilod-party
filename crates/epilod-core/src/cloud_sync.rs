use crate::room_control::RoomControlSummary;
use crate::syncplay::{RoomParticipantUpdate, WireFileInfo};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CLOUD_DEFAULT_ENDPOINT: &str = "wss://epilod-sync.ahmednazief.workers.dev";
pub const CLOUD_PROTOCOL_VERSION: u8 = 1;

pub fn sha256_hex(input: &str) -> String {
    let mut h = Sha256::new();
    h.update(input.as_bytes());
    let digest = h.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Room-salted SHA-256 password hash so plaintext passwords never leave the device.
pub fn hash_room_password(wire_room: &str, password: &str) -> String {
    sha256_hex(&format!("epilod-pw-v1:{}:{}", wire_room.trim(), password))
}

/// Derives a `/peek` proof token from knowledge of the room code or password.
pub fn peek_proof_for_room(wire_room: &str, secret: &str) -> String {
    sha256_hex(&format!(
        "epilod-peek-v1:{}:{}",
        wire_room.trim(),
        secret.trim()
    ))
}

/// Resolves the shared secret used for `/peek` proof generation across both join and room probing.
pub fn default_peek_secret<'a>(
    wire_room: &'a str,
    six_digit: Option<&'a str>,
    password: Option<&'a str>,
) -> &'a str {
    password
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .or_else(|| six_digit.map(str::trim).filter(|s| !s.is_empty()))
        .unwrap_or(wire_room)
}

fn percent_encode_query_value(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn build_cloud_ws_url(endpoint: &str, wire_room: &str) -> String {
    let base = endpoint.trim().trim_end_matches('/');
    format!(
        "{base}/ws?v={CLOUD_PROTOCOL_VERSION}&room={}",
        percent_encode_query_value(wire_room.trim())
    )
}

pub fn build_cloud_http_base(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("wss://") {
        format!("https://{rest}")
    } else if let Some(rest) = trimmed.strip_prefix("ws://") {
        format!("http://{rest}")
    } else {
        format!("https://{trimmed}")
    }
}

pub fn build_cloud_peek_path_with_proofs(wire_rooms: &[String], proofs: &[String]) -> String {
    let rooms_part = wire_rooms
        .iter()
        .take(8)
        .map(|r| format!("room={}", percent_encode_query_value(r.trim())))
        .collect::<Vec<_>>()
        .join("&");
    if proofs.is_empty() {
        return format!("/peek?{rooms_part}");
    }
    let proofs_part = proofs
        .iter()
        .take(8)
        .map(|p| percent_encode_query_value(p.trim()))
        .collect::<Vec<_>>()
        .join(",");
    format!("/peek?{rooms_part}&proofs={proofs_part}")
}

/// Parses an HTTP/1.x response into `(status_code, decoded_body)`, properly handling
/// both plain responses and `Transfer-Encoding: chunked` multi-chunk responses.
pub fn decode_http_response_body(raw: &[u8]) -> Option<(u16, Vec<u8>)> {
    let header_end = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let header_str = std::str::from_utf8(&raw[..header_end]).ok()?;
    let mut lines = header_str.lines();
    let status_line = lines.next()?;
    let status: u16 = status_line.split_whitespace().nth(1)?.parse().ok()?;

    let is_chunked = lines.any(|line| {
        if let Some((k, v)) = line.split_once(':') {
            k.trim().eq_ignore_ascii_case("transfer-encoding")
                && v.to_ascii_lowercase().contains("chunked")
        } else {
            false
        }
    });

    let body_bytes = &raw[header_end + 4..];
    if !is_chunked {
        return Some((status, body_bytes.to_vec()));
    }

    let mut out = Vec::with_capacity(body_bytes.len());
    let mut pos = 0usize;
    while pos < body_bytes.len() {
        let rem = &body_bytes[pos..];
        let crlf = rem.windows(2).position(|w| w == b"\r\n")?;
        let size_line = std::str::from_utf8(&rem[..crlf]).ok()?.trim();
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let chunk_len = usize::from_str_radix(size_hex, 16).ok()?;
        pos += crlf + 2;
        if chunk_len == 0 {
            break;
        }
        if pos + chunk_len > body_bytes.len() {
            return None;
        }
        out.extend_from_slice(&body_bytes[pos..pos + chunk_len]);
        pos += chunk_len;
        if pos + 2 <= body_bytes.len() && &body_bytes[pos..pos + 2] == b"\r\n" {
            pos += 2;
        }
    }
    Some((status, out))
}

#[derive(Debug, Clone, Copy)]
struct ClockSample {
    at_ms: f64,
    rtt_ms: f64,
    offset_ms: f64,
}

const CLOCK_WINDOW_MS: f64 = 300_000.0; // 5 minutes
const CLOCK_MAX_SAMPLES: usize = 8;

/// Estimates `server_time_ms - local_time_ms` using a windowed minimum-RTT
/// filter so transient Wi-Fi spikes are ignored while route changes recover.
#[derive(Debug, Clone, Default)]
pub struct ClockSyncEstimator {
    samples: Vec<ClockSample>,
    offset_ms: f64,
    jitter_ms: f64,
    last_rtt_ms: Option<f64>,
    sample_count: u32,
}

impl ClockSyncEstimator {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_pong(&mut self, client_send_ms: f64, client_recv_ms: f64, server_time_ms: f64) {
        if !client_send_ms.is_finite() || !client_recv_ms.is_finite() || !server_time_ms.is_finite()
        {
            return;
        }
        let rtt = (client_recv_ms - client_send_ms).max(0.0);
        let midpoint = client_send_ms + rtt * 0.5;
        let candidate_offset = server_time_ms - midpoint;
        self.push_sample(client_recv_ms, rtt, candidate_offset);
    }

    /// NTP 4-timestamp clock sample (`t1`: client send, `t2`: server recv, `t3`: server send,
    /// `t4`: client recv) that subtracts server processing time `t3 - t2`.
    pub fn record_ntp_sample(
        &mut self,
        t1_client_send_ms: f64,
        t2_server_recv_ms: f64,
        t3_server_send_ms: f64,
        t4_client_recv_ms: f64,
    ) {
        if !t1_client_send_ms.is_finite()
            || !t2_server_recv_ms.is_finite()
            || !t3_server_send_ms.is_finite()
            || !t4_client_recv_ms.is_finite()
        {
            return;
        }
        let server_proc = (t3_server_send_ms - t2_server_recv_ms).max(0.0);
        let rtt = ((t4_client_recv_ms - t1_client_send_ms) - server_proc).max(0.0);
        let candidate_offset = ((t2_server_recv_ms - t1_client_send_ms)
            + (t3_server_send_ms - t4_client_recv_ms))
            * 0.5;
        self.push_sample(t4_client_recv_ms, rtt, candidate_offset);
    }

    fn push_sample(&mut self, client_recv_ms: f64, rtt: f64, candidate_offset: f64) {
        if rtt > 15_000.0 || !candidate_offset.is_finite() {
            return;
        }
        self.sample_count = self.sample_count.saturating_add(1);
        self.record_rtt_only(rtt);

        self.samples
            .retain(|s| (client_recv_ms - s.at_ms) <= CLOCK_WINDOW_MS && client_recv_ms >= s.at_ms);

        let window_best = self.samples.iter().map(|s| s.rtt_ms).reduce(f64::min);

        match window_best {
            None => {
                self.offset_ms = candidate_offset;
            }
            Some(best) if rtt <= best + 15.0 => {
                self.offset_ms = self.offset_ms * 0.35 + candidate_offset * 0.65;
            }
            Some(_) => {}
        }

        self.samples.push(ClockSample {
            at_ms: client_recv_ms,
            rtt_ms: rtt,
            offset_ms: candidate_offset,
        });
        if self.samples.len() > CLOCK_MAX_SAMPLES {
            self.samples.remove(0);
        }

        // If the minimum RTT in the window shifted up (e.g. VPN/route change),
        // re-anchor offset to the lowest-RTT sample in the current window.
        if let Some(best_sample) = self
            .samples
            .iter()
            .min_by(|a, b| a.rtt_ms.total_cmp(&b.rtt_ms))
        {
            if let Some(prev_best) = window_best {
                if best_sample.rtt_ms > prev_best + 15.0 {
                    self.offset_ms = best_sample.offset_ms;
                }
            }
        }
    }

    /// Updates rolling RTT and jitter EWMA from lightweight keepalive `"pong"` frames.
    pub fn record_rtt_only(&mut self, rtt_ms: f64) {
        if !rtt_ms.is_finite() || !(0.0..=15_000.0).contains(&rtt_ms) {
            return;
        }
        if let Some(prev) = self.last_rtt_ms {
            let delta = (rtt_ms - prev).abs();
            self.jitter_ms = self.jitter_ms * 0.75 + delta * 0.25;
        }
        self.last_rtt_ms = Some(rtt_ms);
    }

    pub fn estimated_server_ms(&self, local_now_ms: f64) -> f64 {
        local_now_ms + self.offset_ms
    }

    pub fn offset_ms(&self) -> f64 {
        self.offset_ms
    }

    pub fn best_rtt_ms(&self) -> Option<f64> {
        self.samples
            .iter()
            .map(|s| s.rtt_ms)
            .reduce(f64::min)
            .or(self.last_rtt_ms)
    }

    pub fn last_rtt_ms(&self) -> Option<f64> {
        self.last_rtt_ms
    }

    pub fn jitter_ms(&self) -> f64 {
        self.jitter_ms
    }

    pub fn sample_count(&self) -> u32 {
        self.sample_count
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DriftAction {
    None,
    SetSpeed(f64),
    Seek,
    ResetSpeed,
}

#[derive(Debug, Clone, Copy)]
pub struct DriftController {
    pub min_deadband_secs: f64,
    pub min_seek_threshold_secs: f64,
    pub max_seek_threshold_secs: f64,
}

impl Default for DriftController {
    fn default() -> Self {
        Self {
            min_deadband_secs: 0.08,
            min_seek_threshold_secs: 0.80,
            max_seek_threshold_secs: 2.00,
        }
    }
}

impl DriftController {
    pub fn deadband_secs(&self, jitter_secs: f64) -> f64 {
        (2.0 * jitter_secs.max(0.0)).max(self.min_deadband_secs)
    }

    pub fn seek_threshold_secs(&self, jitter_secs: f64) -> f64 {
        (self.min_seek_threshold_secs + 4.0 * jitter_secs.max(0.0))
            .clamp(self.min_seek_threshold_secs, self.max_seek_threshold_secs)
    }

    pub fn decide(
        &self,
        drift_secs: f64,
        jitter_secs: f64,
        soft_active: bool,
        last_speed: f64,
    ) -> DriftAction {
        if !drift_secs.is_finite() {
            return DriftAction::None;
        }
        let abs_drift = drift_secs.abs();
        let deadband = self.deadband_secs(jitter_secs);
        let seek_thr = self.seek_threshold_secs(jitter_secs);

        if abs_drift >= seek_thr {
            return DriftAction::Seek;
        }
        if abs_drift >= deadband || (soft_active && abs_drift >= deadband * 0.5) {
            let target_speed = (1.0 + drift_secs * 0.20).clamp(0.92, 1.08);
            if !soft_active || (target_speed - last_speed).abs() >= 0.005 {
                return DriftAction::SetSpeed(target_speed);
            }
            return DriftAction::None;
        }
        if soft_active {
            return DriftAction::ResetSpeed;
        }
        DriftAction::None
    }
}

pub fn should_apply_welcome_state(retained: bool, state_seq: u64, participants_len: usize) -> bool {
    retained || participants_len > 1 || state_seq > 0
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybackAction {
    pub set_pause: Option<bool>,
    pub seek_to: Option<f64>,
}

pub fn compute_playback_action(
    state: &CloudPlaybackState,
    target_local: f64,
    snap_position: f64,
    snap_paused: bool,
    seek_threshold_secs: f64,
) -> PlaybackAction {
    let set_pause = if snap_paused != state.paused {
        Some(state.paused)
    } else {
        None
    };
    let abs_drift = (target_local - snap_position).abs();
    let should_seek = if state.paused {
        state.do_seek || abs_drift > 0.08
    } else {
        state.do_seek || abs_drift >= seek_threshold_secs
    };
    let seek_to = should_seek.then_some(target_local.max(0.0));
    PlaybackAction { set_pause, seek_to }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPlaybackState {
    pub position: f64,
    pub paused: bool,
    pub seq: u64,
    pub server_time_ms: f64,
    pub set_by: Option<String>,
    #[serde(default)]
    pub do_seek: bool,
}

impl CloudPlaybackState {
    pub fn projected_position(&self, server_now_ms: f64) -> f64 {
        if self.paused || !server_now_ms.is_finite() {
            return self.position.max(0.0);
        }
        let elapsed_secs = ((server_now_ms - self.server_time_ms) / 1000.0).max(0.0);
        (self.position + elapsed_secs).max(0.0)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudParticipant {
    pub username: String,
    pub room: String,
    pub position: f64,
    pub paused: bool,
    pub is_ready: bool,
    #[serde(default)]
    pub manual_not_ready: bool,
    pub is_controller: bool,
    pub is_host: bool,
    pub is_admin: bool,
    pub file: Option<WireFileInfo>,
    #[serde(default)]
    pub reported_position: Option<f64>,
    #[serde(default)]
    pub buffering: bool,
    #[serde(default)]
    pub lag_secs: Option<f64>,
}

impl CloudParticipant {
    pub fn to_room_participant(&self) -> RoomParticipantUpdate {
        RoomParticipantUpdate {
            username: self.username.clone(),
            room: self.room.clone(),
            position: self.position,
            paused: self.paused,
            is_ready: Some(self.is_ready),
            is_controller: self.is_controller,
            file: self.file.clone(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudRoomControl {
    pub host_control_active: bool,
    pub local_is_host: bool,
    pub local_is_admin: bool,
    pub host_username: Option<String>,
    #[serde(default)]
    pub admin_usernames: Vec<String>,
}

impl From<CloudRoomControl> for RoomControlSummary {
    fn from(c: CloudRoomControl) -> Self {
        Self {
            host_control_active: c.host_control_active,
            local_is_host: c.local_is_host,
            local_is_admin: c.local_is_admin,
            host_username: c.host_username,
            admin_usernames: c.admin_usernames,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudControlNotice {
    pub kind: String,
    pub actor: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudResumeHint {
    pub position: f64,
    pub paused: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CloudClientMsg {
    Hello {
        username: String,
        #[serde(rename = "claimEmpty")]
        claim_empty: bool,
        #[serde(rename = "hostOnly")]
        host_only: bool,
        #[serde(rename = "passwordHash", skip_serializing_if = "Option::is_none")]
        password_hash: Option<String>,
        #[serde(rename = "hostToken", skip_serializing_if = "Option::is_none")]
        host_token: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        file: Option<WireFileInfo>,
        #[serde(rename = "isReady")]
        is_ready: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        resume: Option<CloudResumeHint>,
        #[serde(skip_serializing_if = "Option::is_none")]
        caps: Option<Vec<String>>,
        #[serde(rename = "clientVersion", skip_serializing_if = "Option::is_none")]
        client_version: Option<String>,
        #[serde(rename = "peekProofHash", skip_serializing_if = "Option::is_none")]
        peek_proof_hash: Option<String>,
        #[serde(rename = "clientMs", skip_serializing_if = "Option::is_none")]
        client_ms: Option<f64>,
    },
    Ping {
        #[serde(rename = "clientMs")]
        client_ms: f64,
    },
    Play {
        position: f64,
        #[serde(rename = "clientServerMs", skip_serializing_if = "Option::is_none")]
        client_server_ms: Option<f64>,
    },
    Pause {
        position: f64,
        #[serde(rename = "clientServerMs", skip_serializing_if = "Option::is_none")]
        client_server_ms: Option<f64>,
    },
    Seek {
        position: f64,
        #[serde(rename = "clientServerMs", skip_serializing_if = "Option::is_none")]
        client_server_ms: Option<f64>,
    },
    Status {
        position: f64,
        buffering: bool,
    },
    Resync,
    File {
        file: Option<WireFileInfo>,
    },
    Ready {
        #[serde(rename = "isReady")]
        is_ready: bool,
        manual: bool,
    },
    #[serde(rename = "setAdmin")]
    SetAdmin {
        username: String,
        grant: bool,
    },
    #[serde(rename = "releaseHost")]
    ReleaseHost,
    #[serde(rename = "p2pSignal")]
    P2pSignal {
        payload: String,
    },
    Chat {
        id: String,
        text: String,
        #[serde(rename = "avatarId")]
        avatar_id: String,
        #[serde(rename = "replyToId", skip_serializing_if = "Option::is_none")]
        reply_to_id: Option<String>,
    },
    #[serde(rename = "chatEdit")]
    ChatEdit {
        #[serde(rename = "targetMsgId")]
        target_msg_id: String,
        text: String,
    },
    #[serde(rename = "chatReact")]
    ChatReact {
        #[serde(rename = "targetMsgId")]
        target_msg_id: String,
        emoji: String,
    },
    Reaction {
        emoji: String,
        #[serde(rename = "avatarId")]
        avatar_id: String,
        count: u8,
    },
    Typing {
        #[serde(rename = "isTyping")]
        is_typing: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CloudServerMsg {
    Welcome {
        username: String,
        room: String,
        #[serde(rename = "hostToken")]
        host_token: Option<String>,
        #[serde(rename = "serverTimeMs")]
        server_time_ms: f64,
        #[serde(rename = "clientMs", default)]
        client_ms: Option<f64>,
        #[serde(rename = "recvMs", default)]
        recv_ms: Option<f64>,
        #[serde(default)]
        retained: bool,
        #[serde(rename = "serverCaps", default)]
        server_caps: Vec<String>,
        state: CloudPlaybackState,
        participants: Vec<CloudParticipant>,
        #[serde(rename = "roomControl")]
        room_control: CloudRoomControl,
    },
    Pong {
        #[serde(rename = "clientMs")]
        client_ms: f64,
        #[serde(rename = "serverTimeMs")]
        server_time_ms: f64,
    },
    State {
        position: f64,
        paused: bool,
        seq: u64,
        #[serde(rename = "serverTimeMs")]
        server_time_ms: f64,
        #[serde(rename = "setBy")]
        set_by: Option<String>,
        #[serde(rename = "doSeek", default)]
        do_seek: bool,
        #[serde(default)]
        reason: Option<String>,
    },
    #[serde(rename = "playBlocked")]
    PlayBlocked {
        usernames: Vec<String>,
    },
    #[serde(rename = "rateLimited")]
    RateLimited {
        bucket: String,
        #[serde(rename = "retryAfterMs")]
        retry_after_ms: u64,
    },
    Participants {
        participants: Vec<CloudParticipant>,
    },
    #[serde(rename = "roomControl")]
    RoomControl {
        #[serde(rename = "roomControl")]
        room_control: CloudRoomControl,
        notice: Option<CloudControlNotice>,
    },
    #[serde(rename = "p2pSignal")]
    P2pSignal {
        username: String,
        payload: String,
    },
    Chat {
        id: String,
        username: String,
        #[serde(rename = "avatarId")]
        avatar_id: String,
        text: String,
        #[serde(rename = "replyToId")]
        reply_to_id: Option<String>,
    },
    #[serde(rename = "chatEdit")]
    ChatEdit {
        #[serde(rename = "targetMsgId")]
        target_msg_id: String,
        username: String,
        text: String,
    },
    #[serde(rename = "chatReact")]
    ChatReact {
        #[serde(rename = "targetMsgId")]
        target_msg_id: String,
        username: String,
        emoji: String,
    },
    Reaction {
        username: String,
        #[serde(rename = "avatarId")]
        avatar_id: String,
        emoji: String,
        count: u8,
    },
    Typing {
        username: String,
        #[serde(rename = "isTyping")]
        is_typing: bool,
    },
    #[serde(rename = "peerLeft")]
    PeerLeft {
        username: String,
    },
    #[serde(rename = "peerNotReady")]
    PeerNotReady {
        username: String,
        manual: bool,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudPeekRoomInfo {
    pub online_count: usize,
    #[serde(default)]
    pub usernames_preview: Vec<String>,
    pub active_media_hint: Option<String>,
    #[serde(default)]
    pub locked: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CloudPeekResponse {
    pub ok: bool,
    #[serde(default)]
    pub rooms: std::collections::HashMap<String, CloudPeekRoomInfo>,
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures below are verbatim messages captured from the live Worker (protocol v1).
    #[test]
    fn parses_real_server_messages_captured_from_live_worker() {
        let welcome = r#"{"type":"welcome","username":"Alice","room":"fix-p7qwpo","hostToken":"4a31d2fa8253a424b4b2b86a15b42d71e9b89a70b44593a21af7c217357299b7","serverTimeMs":1795187544221,"state":{"position":0,"paused":true,"seq":0,"serverTimeMs":1795187544221,"setBy":null,"doSeek":true},"participants":[{"username":"Alice","room":"fix-p7qwpo","position":0,"paused":true,"isReady":true,"manualNotReady":false,"isController":true,"isHost":true,"isAdmin":false,"file":{"name":"movie.mkv","size":123456,"sizeHash":null,"duration":5400.5}}],"roomControl":{"hostControlActive":true,"localIsHost":true,"localIsAdmin":false,"hostUsername":"Alice","adminUsernames":[]}}"#;
        match serde_json::from_str::<CloudServerMsg>(welcome).expect("welcome parses") {
            CloudServerMsg::Welcome {
                username,
                host_token,
                state,
                participants,
                room_control,
                ..
            } => {
                assert_eq!(username, "Alice");
                assert_eq!(host_token.as_deref().map(str::len), Some(64));
                assert!(state.paused && state.set_by.is_none() && state.do_seek);
                assert_eq!(participants.len(), 1);
                assert!(participants[0].is_host && participants[0].is_controller);
                assert_eq!(participants[0].file.as_ref().unwrap().name, "movie.mkv");
                assert!(room_control.host_control_active && room_control.local_is_host);
            }
            other => panic!("wrong variant: {other:?}"),
        }

        type MsgCheck = fn(&CloudServerMsg) -> bool;
        let cases: &[(&str, MsgCheck)] = &[
            (
                r#"{"type":"pong","clientMs":1000,"serverTimeMs":1795187545429}"#,
                |m| matches!(m, CloudServerMsg::Pong { .. }),
            ),
            (
                r#"{"type":"state","position":10.25,"paused":false,"seq":1,"serverTimeMs":1795187545429,"setBy":"Alice","doSeek":false}"#,
                |m| {
                    matches!(
                        m,
                        CloudServerMsg::State {
                            seq: 1,
                            paused: false,
                            ..
                        }
                    )
                },
            ),
            (r#"{"type":"participants","participants":[]}"#, |m| {
                matches!(m, CloudServerMsg::Participants { .. })
            }),
            (
                r#"{"type":"roomControl","roomControl":{"hostControlActive":true,"localIsHost":true,"localIsAdmin":false,"hostUsername":"Alice","adminUsernames":["Bob"]},"notice":{"kind":"adminGranted","actor":"Alice"}}"#,
                |m| {
                    matches!(
                        m,
                        CloudServerMsg::RoomControl {
                            notice: Some(_),
                            ..
                        }
                    )
                },
            ),
            (
                r#"{"type":"roomControl","roomControl":{"hostControlActive":false,"localIsHost":false,"localIsAdmin":false,"hostUsername":null,"adminUsernames":[]},"notice":null}"#,
                |m| matches!(m, CloudServerMsg::RoomControl { notice: None, .. }),
            ),
            (r#"{"type":"peerLeft","username":"Bob"}"#, |m| {
                matches!(m, CloudServerMsg::PeerLeft { .. })
            }),
            (
                r#"{"type":"peerNotReady","username":"Bob","manual":true}"#,
                |m| matches!(m, CloudServerMsg::PeerNotReady { manual: true, .. }),
            ),
            (
                r#"{"type":"chat","id":"m1","username":"Alice","avatarId":"3","text":"hi","replyToId":null}"#,
                |m| matches!(m, CloudServerMsg::Chat { .. }),
            ),
            (
                r#"{"type":"reaction","username":"Alice","avatarId":"3","emoji":"🔥","count":2}"#,
                |m| matches!(m, CloudServerMsg::Reaction { count: 2, .. }),
            ),
            (
                r#"{"type":"typing","username":"Alice","isTyping":true}"#,
                |m| {
                    matches!(
                        m,
                        CloudServerMsg::Typing {
                            is_typing: true,
                            ..
                        }
                    )
                },
            ),
            (
                r#"{"type":"chatEdit","targetMsgId":"m1","username":"Alice","text":"x"}"#,
                |m| matches!(m, CloudServerMsg::ChatEdit { .. }),
            ),
            (
                r#"{"type":"chatReact","targetMsgId":"m1","username":"Alice","emoji":"👍"}"#,
                |m| matches!(m, CloudServerMsg::ChatReact { .. }),
            ),
            (
                r#"{"type":"p2pSignal","username":"Alice","payload":"~EP2:abc"}"#,
                |m| matches!(m, CloudServerMsg::P2pSignal { .. }),
            ),
            (
                r#"{"type":"error","code":"ROOM_OCCUPIED","message":"x"}"#,
                |m| matches!(m, CloudServerMsg::Error { .. }),
            ),
            (
                r#"{"type":"playBlocked","usernames":["Bob"]}"#,
                |m| matches!(m, CloudServerMsg::PlayBlocked { usernames } if usernames == &["Bob"]),
            ),
            (
                r#"{"type":"rateLimited","bucket":"playback","retryAfterMs":1000}"#,
                |m| {
                    matches!(
                        m,
                        CloudServerMsg::RateLimited {
                            retry_after_ms: 1000,
                            ..
                        }
                    )
                },
            ),
        ];
        for (raw, check) in cases {
            let parsed: CloudServerMsg =
                serde_json::from_str(raw).unwrap_or_else(|e| panic!("{raw} failed: {e}"));
            assert!(check(&parsed), "unexpected variant for {raw}: {parsed:?}");
        }
    }

    #[test]
    fn client_messages_serialize_to_exact_keys_the_worker_reads() {
        let v = |m: &CloudClientMsg| serde_json::to_value(m).unwrap();

        let hello = v(&CloudClientMsg::Hello {
            username: "A".into(),
            claim_empty: true,
            host_only: true,
            password_hash: None,
            host_token: Some("tok".into()),
            file: Some(WireFileInfo {
                name: "m.mkv".into(),
                size: Some(5),
                size_hash: None,
                duration: Some(9.5),
            }),
            is_ready: true,
            resume: None,
            caps: Some(vec!["readygate".into()]),
            client_version: Some("1.0.0".into()),
            peek_proof_hash: None,
            client_ms: Some(1234.5),
        });
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["clientMs"], 1234.5);
        assert_eq!(hello["claimEmpty"], true);
        assert_eq!(hello["hostOnly"], true);
        assert_eq!(hello["hostToken"], "tok");
        assert_eq!(hello["isReady"], true);
        assert!(hello.get("passwordHash").is_none());
        assert_eq!(hello["file"]["name"], "m.mkv");

        assert_eq!(v(&CloudClientMsg::Ping { client_ms: 1.5 })["clientMs"], 1.5);
        assert_eq!(
            v(&CloudClientMsg::Play {
                position: 2.0,
                client_server_ms: None
            })["type"],
            "play"
        );
        assert_eq!(
            v(&CloudClientMsg::Pause {
                position: 2.0,
                client_server_ms: None
            })["type"],
            "pause"
        );
        assert_eq!(
            v(&CloudClientMsg::Seek {
                position: 2.0,
                client_server_ms: None
            })["type"],
            "seek"
        );
        assert_eq!(
            v(&CloudClientMsg::Status {
                position: 5.0,
                buffering: true
            })["type"],
            "status"
        );
        assert_eq!(v(&CloudClientMsg::Resync)["type"], "resync");
        let ready = v(&CloudClientMsg::Ready {
            is_ready: false,
            manual: true,
        });
        assert_eq!(
            (
                ready["type"].as_str(),
                ready["isReady"].as_bool(),
                ready["manual"].as_bool()
            ),
            (Some("ready"), Some(false), Some(true))
        );
        let adm = v(&CloudClientMsg::SetAdmin {
            username: "B".into(),
            grant: true,
        });
        assert_eq!(
            (adm["type"].as_str(), adm["grant"].as_bool()),
            (Some("setAdmin"), Some(true))
        );
        assert_eq!(v(&CloudClientMsg::ReleaseHost)["type"], "releaseHost");
        assert_eq!(
            v(&CloudClientMsg::P2pSignal {
                payload: "p".into()
            })["type"],
            "p2pSignal"
        );
        let chat = v(&CloudClientMsg::Chat {
            id: "i".into(),
            text: "t".into(),
            avatar_id: "a".into(),
            reply_to_id: None,
        });
        assert_eq!(
            (chat["avatarId"].as_str(), chat.get("replyToId").is_none()),
            (Some("a"), true)
        );
        assert_eq!(
            v(&CloudClientMsg::ChatEdit {
                target_msg_id: "i".into(),
                text: "t".into()
            })["targetMsgId"],
            "i"
        );
        assert_eq!(
            v(&CloudClientMsg::ChatReact {
                target_msg_id: "i".into(),
                emoji: "e".into()
            })["type"],
            "chatReact"
        );
        assert_eq!(
            v(&CloudClientMsg::Reaction {
                emoji: "e".into(),
                avatar_id: "a".into(),
                count: 3
            })["count"],
            3
        );
        assert_eq!(
            v(&CloudClientMsg::Typing { is_typing: true })["isTyping"],
            true
        );
    }

    #[test]
    fn password_hash_is_room_salted_and_hex() {
        let a = hash_room_password("ep-123", "secret");
        let b = hash_room_password("ep-456", "secret");
        assert_eq!(a.len(), 64);
        assert_ne!(a, b);
    }

    #[test]
    fn build_urls_encode_spaces_and_symbols() {
        assert_eq!(
            build_cloud_ws_url("wss://epilod-sync.ahmednazief.workers.dev/", "Movie Night"),
            "wss://epilod-sync.ahmednazief.workers.dev/ws?v=1&room=Movie%20Night"
        );
        assert_eq!(
            build_cloud_peek_path_with_proofs(&["ep-1".into(), "Movie, Night".into()], &[]),
            "/peek?room=ep-1&room=Movie%2C%20Night"
        );
    }

    #[test]
    fn decode_http_response_handles_plain_and_multi_chunk_bodies() {
        let plain = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        let (st, body) = decode_http_response_body(plain).unwrap();
        assert_eq!(st, 200);
        assert_eq!(body, b"{\"ok\":true}");

        let chunked = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n6\r\n{\"ok\":\r\n5\r\ntrue}\r\n0\r\n\r\n";
        let (st2, body2) = decode_http_response_body(chunked).unwrap();
        assert_eq!(st2, 200);
        assert_eq!(body2, b"{\"ok\":true}");
    }

    #[test]
    fn clock_sync_prefers_low_rtt_samples() {
        let mut est = ClockSyncEstimator::new();
        // True offset = +500ms. First sample has 40ms RTT.
        est.record_pong(1000.0, 1040.0, 1520.0);
        assert!((est.offset_ms() - 500.0).abs() < 0.01);
        // Huge spike (500ms RTT, skewed) should be ignored.
        est.record_pong(2000.0, 2500.0, 3200.0);
        assert!((est.offset_ms() - 500.0).abs() < 0.01);
    }

    #[test]
    fn playback_projection_advances_only_when_playing() {
        let playing = CloudPlaybackState {
            position: 100.0,
            paused: false,
            seq: 2,
            server_time_ms: 10_000.0,
            set_by: Some("Alex".into()),
            do_seek: false,
        };
        assert!((playing.projected_position(12_500.0) - 102.5).abs() < 1e-6);

        let paused = CloudPlaybackState {
            paused: true,
            ..playing
        };
        assert!((paused.projected_position(15_000.0) - 100.0).abs() < 1e-6);
    }

    #[test]
    fn clock_sync_recovers_after_window_expires() {
        let mut est = ClockSyncEstimator::new();
        est.record_pong(1000.0, 1020.0, 1510.0); // offset +500, rtt 20
        assert!((est.offset_ms() - 500.0).abs() < 0.01);

        // 6 minutes later, route changed (rtt 80ms, new offset +600ms)
        est.record_pong(361_000.0, 361_080.0, 361_640.0);
        assert!((est.offset_ms() - 600.0).abs() < 0.01);
    }

    #[test]
    fn drift_controller_proportional_and_hysteresis() {
        let ctrl = DriftController::default();
        assert_eq!(ctrl.decide(0.05, 0.01, false, 1.0), DriftAction::None);
        match ctrl.decide(0.30, 0.01, false, 1.0) {
            DriftAction::SetSpeed(s) => assert!((s - 1.06).abs() < 1e-6),
            other => panic!("expected SetSpeed, got {other:?}"),
        }
        assert_eq!(ctrl.decide(0.06, 0.01, true, 1.01), DriftAction::None);
        assert_eq!(ctrl.decide(0.02, 0.01, true, 1.01), DriftAction::ResetSpeed);
        assert_eq!(ctrl.decide(0.95, 0.01, false, 1.0), DriftAction::Seek);
    }

    #[test]
    fn welcome_and_playback_action_helpers() {
        assert!(!should_apply_welcome_state(false, 0, 1));
        assert!(should_apply_welcome_state(true, 0, 1));
        assert!(should_apply_welcome_state(false, 0, 2));
        assert!(should_apply_welcome_state(false, 3, 1));

        let paused_state = CloudPlaybackState {
            position: 100.0,
            paused: true,
            seq: 1,
            server_time_ms: 1000.0,
            set_by: None,
            do_seek: false,
        };
        let act = compute_playback_action(&paused_state, 100.2, 100.0, false, 0.8);
        assert_eq!(act.set_pause, Some(true));
        assert_eq!(act.seek_to, Some(100.2));
    }

    #[test]
    fn peek_proof_is_deterministic_and_distinct() {
        let p1 = peek_proof_for_room("fix-123456", "123456");
        let p2 = peek_proof_for_room("fix-123456", "123456");
        let p3 = peek_proof_for_room("fix-123456", "other");
        assert_eq!(p1, p2);
        assert_ne!(p1, p3);
        assert_eq!(p1.len(), 64);
    }

    #[test]
    fn clock_sync_ntp_sample_subtracts_server_processing() {
        let mut clock = ClockSyncEstimator::new();
        // True offset = +500ms, network one-way = 20ms, server processing = 10ms.
        // t1 = 1000, t2 = 1520, t3 = 1530, t4 = 1050.
        clock.record_ntp_sample(1000.0, 1520.0, 1530.0, 1050.0);
        assert!((clock.offset_ms() - 500.0).abs() < 0.01);
        assert!((clock.last_rtt_ms().unwrap() - 40.0).abs() < 0.01);
    }
}
