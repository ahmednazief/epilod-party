use crate::room_control::RoomControlSummary;
use crate::syncplay::{RoomParticipantUpdate, WireFileInfo};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const CLOUD_DEFAULT_ENDPOINT: &str = "wss://epilod-sync.ahmednazief.workers.dev";
pub const CLOUD_PROTOCOL_VERSION: u8 = 1;
pub const CLOUD_DRIFT_SEEK_THRESHOLD_SECS: f64 = 1.5;
pub const CLOUD_DRIFT_SPEED_THRESHOLD_SECS: f64 = 0.25;

/// Room-salted SHA-256 password hash so plaintext passwords never leave the device.
pub fn hash_room_password(wire_room: &str, password: &str) -> String {
    let mut h = Sha256::new();
    h.update(b"epilod-pw-v1:");
    h.update(wire_room.trim().as_bytes());
    h.update(b":");
    h.update(password.as_bytes());
    let digest = h.finalize();
    digest.iter().map(|b| format!("{b:02x}")).collect()
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

pub fn build_cloud_peek_path(wire_rooms: &[String]) -> String {
    let joined = wire_rooms
        .iter()
        .take(8)
        .map(|r| format!("room={}", percent_encode_query_value(r.trim())))
        .collect::<Vec<_>>()
        .join("&");
    format!("/peek?{joined}")
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

/// Estimates `server_time_ms - local_time_ms` using the lowest-RTT sample
/// to stay resilient against transient Wi-Fi jitter spikes.
#[derive(Debug, Clone, Default)]
pub struct ClockSyncEstimator {
    best_rtt_ms: Option<f64>,
    offset_ms: f64,
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
        if rtt > 15_000.0 {
            return;
        }
        let midpoint = client_send_ms + rtt * 0.5;
        let candidate_offset = server_time_ms - midpoint;
        self.sample_count = self.sample_count.saturating_add(1);

        match self.best_rtt_ms {
            None => {
                self.best_rtt_ms = Some(rtt);
                self.offset_ms = candidate_offset;
            }
            Some(best) if rtt <= best + 15.0 => {
                if rtt < best {
                    self.best_rtt_ms = Some(rtt);
                }
                // Smooth update when sample is near best RTT.
                self.offset_ms = self.offset_ms * 0.35 + candidate_offset * 0.65;
            }
            _ => {}
        }
    }

    pub fn estimated_server_ms(&self, local_now_ms: f64) -> f64 {
        local_now_ms + self.offset_ms
    }

    pub fn offset_ms(&self) -> f64 {
        self.offset_ms
    }

    pub fn best_rtt_ms(&self) -> Option<f64> {
        self.best_rtt_ms
    }

    pub fn sample_count(&self) -> u32 {
        self.sample_count
    }
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
    },
    Ping {
        #[serde(rename = "clientMs")]
        client_ms: f64,
    },
    Play {
        position: f64,
    },
    Pause {
        position: f64,
    },
    Seek {
        position: f64,
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
        });
        assert_eq!(hello["type"], "hello");
        assert_eq!(hello["claimEmpty"], true);
        assert_eq!(hello["hostOnly"], true);
        assert_eq!(hello["hostToken"], "tok");
        assert_eq!(hello["isReady"], true);
        assert!(hello.get("passwordHash").is_none());
        assert_eq!(hello["file"]["name"], "m.mkv");

        assert_eq!(v(&CloudClientMsg::Ping { client_ms: 1.5 })["clientMs"], 1.5);
        assert_eq!(v(&CloudClientMsg::Play { position: 2.0 })["type"], "play");
        assert_eq!(v(&CloudClientMsg::Pause { position: 2.0 })["type"], "pause");
        assert_eq!(v(&CloudClientMsg::Seek { position: 2.0 })["type"], "seek");
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
            build_cloud_peek_path(&["ep-1".into(), "Movie, Night".into()]),
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
}
