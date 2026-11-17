use crate::validation::strip_unsafe_unicode;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use thiserror::Error;

pub const MAX_RECONNECT_ATTEMPTS: u32 = 20;
pub const DRIFT_SEEK_THRESHOLD_SECS: f64 = 4.0;
pub const MAX_WIRE_LINE_BYTES: usize = 64 * 1024;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SyncplayParseError {
    #[error("Syncplay wire line exceeds maximum length")]
    LineTooLong,
    #[error("Invalid JSON from Syncplay server: {0}")]
    InvalidJson(String),
    #[error("Unrecognized Syncplay message")]
    Unrecognized,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerSnapshot {
    pub position: f64,
    pub paused: bool,
}

impl Default for PlayerSnapshot {
    fn default() -> Self {
        Self {
            position: 0.0,
            paused: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireFileInfo {
    pub name: String,
    pub size: Option<u64>,
    #[serde(default)]
    pub size_hash: Option<String>,
    pub duration: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomParticipantUpdate {
    pub username: String,
    pub room: String,
    pub position: f64,
    pub paused: bool,
    pub is_ready: Option<bool>,
    pub is_controller: bool,
    pub file: Option<WireFileInfo>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PingData {
    pub latency_calculation: Option<f64>,
    pub client_latency_calculation: Option<f64>,
    pub client_rtt: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Playstate {
    pub position: f64,
    pub paused: bool,
    pub do_seek: bool,
    pub set_by: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IgnoringOnTheFly {
    pub server: Option<u64>,
    pub client: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerState {
    pub ping: Option<PingData>,
    pub playstate: Option<Playstate>,
    pub ignoring_on_the_fly: Option<IgnoringOnTheFly>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum SetUpdate {
    Ready {
        username: String,
        is_ready: bool,
        manually_initiated: Option<bool>,
    },
    File {
        username: String,
        file: WireFileInfo,
    },
    FileCleared {
        username: String,
    },
    UserLeft {
        username: String,
    },
    UserJoined {
        username: String,
    },
    ControllerAuth {
        username: String,
        is_controller: bool,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum ServerMessage {
    Tls {
        start_tls: bool,
    },
    Hello {
        username: String,
        room: String,
        version: String,
    },
    Set(Vec<SetUpdate>),
    List(Vec<RoomParticipantUpdate>),
    State(ServerState),
    Chat {
        username: String,
        message: String,
    },
    Error(String),
}

#[derive(Debug, Clone, PartialEq)]
pub enum SyncAction {
    SetPaused(bool),
    Seek(f64),
    SetSpeed(f64),
    ServerOverride { set_by: Option<String> },
}

pub fn md5_hex(input: &[u8]) -> String {
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];

    let orig_bit_len = (input.len() as u64).wrapping_mul(8);
    let mut msg = input.to_vec();
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&orig_bit_len.to_le_bytes());

    let mut a0: u32 = 0x67452301;
    let mut b0: u32 = 0xefcdab89;
    let mut c0: u32 = 0x98badcfe;
    let mut d0: u32 = 0x10325476;

    for chunk in msg.as_chunks::<64>().0 {
        let mut m = [0u32; 16];
        for (i, w) in m.iter_mut().enumerate() {
            let off = i * 4;
            *w = u32::from_le_bytes([chunk[off], chunk[off + 1], chunk[off + 2], chunk[off + 3]]);
        }
        let mut a = a0;
        let mut b = b0;
        let mut c = c0;
        let mut d = d0;
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            let sum = a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(m[g]);
            b = b.wrapping_add(sum.rotate_left(S[i]));
            a = temp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = String::with_capacity(32);
    for word in [a0, b0, c0, d0] {
        for byte in word.to_le_bytes() {
            out.push_str(&format!("{byte:02x}"));
        }
    }
    out
}

pub fn extract_tls_server_name(endpoint: &str) -> String {
    let trimmed = endpoint.trim();
    if trimmed.starts_with('[') {
        if let Some(end) = trimmed.find(']') {
            return trimmed[1..end].to_string();
        }
    }
    if let Some(colon) = trimmed.rfind(':') {
        return trimmed[..colon].to_string();
    }
    trimmed.to_string()
}

pub fn strip_filename_for_hash(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name).trim();
    let without_ext = match base.rfind('.') {
        Some(idx) if idx > 0 => &base[..idx],
        _ => base,
    };
    without_ext.to_string()
}

pub fn hash_filename(name: &str) -> String {
    let stripped = strip_filename_for_hash(name);
    let mut h = Sha256::new();
    h.update(stripped.as_bytes());
    let digest = h.finalize();
    digest[..6].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn hash_filesize(size_bytes: u64) -> String {
    let mut h = Sha256::new();
    h.update(size_bytes.to_string().as_bytes());
    let digest = h.finalize();
    digest[..6].iter().map(|b| format!("{b:02x}")).collect()
}

pub fn encode_start_tls_send() -> String {
    "{\"TLS\":{\"startTLS\":\"send\"}}\r\n".to_string()
}

pub fn encode_hello(username: &str, room_name: &str, password: Option<&str>) -> String {
    let mut hello = Map::new();
    hello.insert("username".into(), json!(username));
    if let Some(pw) = password.map(str::trim).filter(|p| !p.is_empty()) {
        hello.insert("password".into(), json!(md5_hex(pw.as_bytes())));
    }
    hello.insert("room".into(), json!({ "name": room_name }));
    hello.insert("version".into(), json!("1.7.0"));
    hello.insert("realversion".into(), json!("1.7.0"));
    hello.insert(
        "features".into(),
        json!({
            "sharedPlaylists": false,
            "chat": true,
            "featureList": true,
            "readiness": true,
            "managedRooms": true
        }),
    );
    format!("{}\r\n", json!({ "Hello": Value::Object(hello) }))
}

pub fn encode_set_ready(is_ready: bool, manually_initiated: bool) -> String {
    let payload = json!({
        "Set": {
            "ready": {
                "isReady": is_ready,
                "manuallyInitiated": manually_initiated
            }
        }
    });
    format!("{payload}\r\n")
}

pub fn encode_set_file(
    name: &str,
    size_bytes: Option<u64>,
    duration_secs: f64,
    hash_name_and_size: bool,
) -> String {
    let wire_name = if hash_name_and_size {
        hash_filename(name)
    } else {
        name.to_string()
    };
    let mut file_obj = Map::new();
    file_obj.insert("name".into(), json!(wire_name));
    if let Some(sz) = size_bytes {
        if hash_name_and_size {
            file_obj.insert("size".into(), json!(hash_filesize(sz)));
        } else {
            file_obj.insert("size".into(), json!(sz));
        }
    }
    if duration_secs.is_finite() && duration_secs >= 0.0 {
        file_obj.insert("duration".into(), json!(duration_secs));
    }
    format!(
        "{}\r\n",
        json!({ "Set": { "file": Value::Object(file_obj) } })
    )
}

#[allow(clippy::too_many_arguments)]
pub fn encode_state(
    position: f64,
    paused: bool,
    do_seek: bool,
    client_latency_calculation: f64,
    latency_calculation: Option<f64>,
    client_rtt: Option<f64>,
    ignoring_server: Option<u64>,
    ignoring_client: Option<u64>,
) -> String {
    let safe_pos = if position.is_finite() && position >= 0.0 {
        position
    } else {
        0.0
    };
    let mut ping = Map::new();
    if client_latency_calculation.is_finite() {
        ping.insert(
            "clientLatencyCalculation".into(),
            json!(client_latency_calculation),
        );
    }
    if let Some(lc) = latency_calculation.filter(|v| v.is_finite()) {
        ping.insert("latencyCalculation".into(), json!(lc));
    }
    if let Some(rtt) = client_rtt.filter(|v| v.is_finite() && *v >= 0.0) {
        ping.insert("clientRtt".into(), json!(rtt));
    }

    let playstate = json!({
        "position": safe_pos,
        "paused": paused,
        "doSeek": do_seek,
    });

    let mut state = Map::new();
    state.insert("ping".into(), Value::Object(ping));
    state.insert("playstate".into(), playstate);

    let mut ignoring = Map::new();
    if let Some(srv) = ignoring_server {
        ignoring.insert("server".into(), json!(srv));
    }
    if let Some(cli) = ignoring_client {
        ignoring.insert("client".into(), json!(cli));
    }
    if !ignoring.is_empty() {
        state.insert("ignoringOnTheFly".into(), Value::Object(ignoring));
    }

    format!("{}\r\n", json!({ "State": Value::Object(state) }))
}

pub fn encode_chat(message: &str) -> String {
    format!("{}\r\n", json!({ "Chat": message }))
}

fn clean_wire_string(raw: &str, max_chars: usize) -> String {
    strip_unsafe_unicode(raw).chars().take(max_chars).collect()
}

pub fn parse_server_line(line: &str) -> Result<ServerMessage, SyncplayParseError> {
    if line.len() > MAX_WIRE_LINE_BYTES {
        return Err(SyncplayParseError::LineTooLong);
    }
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Err(SyncplayParseError::InvalidJson("empty line".to_string()));
    }
    let val: Value = serde_json::from_str(trimmed)
        .map_err(|e| SyncplayParseError::InvalidJson(e.to_string()))?;
    let obj = val
        .as_object()
        .ok_or_else(|| SyncplayParseError::InvalidJson("expected object".to_string()))?;

    if let Some(tls) = obj.get("TLS").and_then(|v| v.as_object()) {
        let start_tls = match tls.get("startTLS") {
            Some(Value::Bool(b)) => *b,
            Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
            _ => false,
        };
        return Ok(ServerMessage::Tls { start_tls });
    }

    if let Some(hello) = obj.get("Hello").and_then(|v| v.as_object()) {
        let username = hello
            .get("username")
            .and_then(|v| v.as_str())
            .map(|s| clean_wire_string(s, 64))
            .unwrap_or_default();
        let room = hello
            .get("room")
            .and_then(|v| v.get("name"))
            .and_then(|v| v.as_str())
            .map(|s| clean_wire_string(s, 128))
            .unwrap_or_default();
        let version = hello
            .get("version")
            .and_then(|v| v.as_str())
            .map(|s| clean_wire_string(s, 32))
            .unwrap_or_default();
        return Ok(ServerMessage::Hello {
            username,
            room,
            version,
        });
    }

    if let Some(chat_obj) = obj.get("Chat").and_then(|v| v.as_object()) {
        let username = chat_obj
            .get("username")
            .and_then(|v| v.as_str())
            .map(|s| clean_wire_string(s, 64))
            .unwrap_or_default();
        let message = chat_obj
            .get("message")
            .and_then(|v| v.as_str())
            .map(|s| clean_wire_string(s, 512))
            .unwrap_or_default();
        return Ok(ServerMessage::Chat { username, message });
    }

    if let Some(err) = obj.get("Error").and_then(|v| v.as_object()) {
        let msg = err
            .get("message")
            .and_then(|v| v.as_str())
            .map(|s| clean_wire_string(s, 320))
            .unwrap_or_else(|| "Syncplay server error".to_string());
        return Ok(ServerMessage::Error(msg));
    }

    if let Some(state_obj) = obj.get("State").and_then(|v| v.as_object()) {
        let ping = state_obj
            .get("ping")
            .and_then(|v| v.as_object())
            .map(|p| PingData {
                latency_calculation: p
                    .get("latencyCalculation")
                    .and_then(|x| x.as_f64())
                    .filter(|x| x.is_finite()),
                client_latency_calculation: p
                    .get("clientLatencyCalculation")
                    .and_then(|x| x.as_f64())
                    .filter(|x| x.is_finite()),
                client_rtt: p
                    .get("clientRtt")
                    .and_then(|x| x.as_f64())
                    .filter(|x| x.is_finite() && *x >= 0.0),
            });
        let playstate = state_obj
            .get("playstate")
            .and_then(|v| v.as_object())
            .map(|ps| Playstate {
                position: ps
                    .get("position")
                    .and_then(|x| x.as_f64())
                    .filter(|x| x.is_finite() && *x >= 0.0)
                    .unwrap_or(0.0),
                paused: ps.get("paused").and_then(|x| x.as_bool()).unwrap_or(true),
                do_seek: ps.get("doSeek").and_then(|x| x.as_bool()).unwrap_or(false),
                set_by: ps
                    .get("setBy")
                    .and_then(|x| x.as_str())
                    .map(|s| clean_wire_string(s, 64)),
            });
        let ignoring_on_the_fly = state_obj
            .get("ignoringOnTheFly")
            .and_then(|v| v.as_object())
            .map(|ig| IgnoringOnTheFly {
                server: ig.get("server").and_then(|x| x.as_u64()),
                client: ig.get("client").and_then(|x| x.as_u64()),
            });
        return Ok(ServerMessage::State(ServerState {
            ping,
            playstate,
            ignoring_on_the_fly,
        }));
    }

    if let Some(list_obj) = obj.get("List").and_then(|v| v.as_object()) {
        let mut updates = Vec::new();
        for (room_name, users_val) in list_obj {
            let Some(users_obj) = users_val.as_object() else {
                continue;
            };
            for (username, info_val) in users_obj {
                let Some(info) = info_val.as_object() else {
                    continue;
                };
                let position = info
                    .get("position")
                    .and_then(|x| x.as_f64())
                    .filter(|x| x.is_finite() && *x >= 0.0)
                    .unwrap_or(0.0);
                let paused = info.get("paused").and_then(|x| x.as_bool()).unwrap_or(true);
                let is_ready = info.get("isReady").and_then(|x| x.as_bool());
                let is_controller = info
                    .get("controller")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                let file = info
                    .get("file")
                    .and_then(|v| v.as_object())
                    .and_then(parse_wire_file);
                updates.push(RoomParticipantUpdate {
                    username: clean_wire_string(username, 64),
                    room: clean_wire_string(room_name, 128),
                    position,
                    paused,
                    is_ready,
                    is_controller,
                    file,
                });
            }
        }
        return Ok(ServerMessage::List(updates));
    }

    if let Some(set_obj) = obj.get("Set").and_then(|v| v.as_object()) {
        let mut updates = Vec::new();
        if let Some(users_obj) = set_obj.get("user").and_then(|v| v.as_object()) {
            for (uname, uval) in users_obj {
                let username = clean_wire_string(uname, 64);
                let Some(uinfo) = uval.as_object() else {
                    continue;
                };
                if let Some(evt) = uinfo.get("event").and_then(|v| v.as_object()) {
                    if evt.get("left").and_then(|v| v.as_bool()).unwrap_or(false) {
                        updates.push(SetUpdate::UserLeft {
                            username: username.clone(),
                        });
                    }
                    if evt.get("joined").and_then(|v| v.as_bool()).unwrap_or(false) {
                        updates.push(SetUpdate::UserJoined {
                            username: username.clone(),
                        });
                    }
                }
                if let Some(file_val) = uinfo.get("file") {
                    if file_val.is_null() {
                        updates.push(SetUpdate::FileCleared {
                            username: username.clone(),
                        });
                    } else if let Some(file_obj) = file_val.as_object() {
                        if let Some(file) = parse_wire_file(file_obj) {
                            updates.push(SetUpdate::File {
                                username: username.clone(),
                                file,
                            });
                        } else {
                            updates.push(SetUpdate::FileCleared {
                                username: username.clone(),
                            });
                        }
                    }
                }
                if let Some(ready_val) = uinfo.get("isReady").and_then(|v| v.as_bool()) {
                    let manually_initiated =
                        uinfo.get("manuallyInitiated").and_then(|v| v.as_bool());
                    updates.push(SetUpdate::Ready {
                        username: username.clone(),
                        is_ready: ready_val,
                        manually_initiated,
                    });
                }
                if let Some(ctrl_val) = uinfo.get("controller").and_then(|v| v.as_bool()) {
                    updates.push(SetUpdate::ControllerAuth {
                        username,
                        is_controller: ctrl_val,
                    });
                }
            }
        }
        if let Some(ready_obj) = set_obj.get("ready").and_then(|v| v.as_object()) {
            if let (Some(username), Some(is_ready)) = (
                ready_obj.get("username").and_then(|v| v.as_str()),
                ready_obj.get("isReady").and_then(|v| v.as_bool()),
            ) {
                let manually_initiated =
                    ready_obj.get("manuallyInitiated").and_then(|v| v.as_bool());
                updates.push(SetUpdate::Ready {
                    username: clean_wire_string(username, 64),
                    is_ready,
                    manually_initiated,
                });
            }
        }
        if let Some(ctrl_obj) = set_obj.get("controllerAuth").and_then(|v| v.as_object()) {
            if let Some(username) = ctrl_obj.get("user").and_then(|v| v.as_str()) {
                let is_controller = ctrl_obj
                    .get("success")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true);
                updates.push(SetUpdate::ControllerAuth {
                    username: clean_wire_string(username, 64),
                    is_controller,
                });
            }
        }
        return Ok(ServerMessage::Set(updates));
    }

    Err(SyncplayParseError::Unrecognized)
}

pub fn parse_server_messages(raw: &str) -> Vec<Result<ServerMessage, SyncplayParseError>> {
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .map(parse_server_line)
        .collect()
}

fn parse_wire_file(obj: &Map<String, Value>) -> Option<WireFileInfo> {
    let name = obj
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| clean_wire_string(s, 260))
        .filter(|s| !s.trim().is_empty())?;
    let mut size_hash = None;
    let size = obj.get("size").and_then(|v| match v {
        Value::Number(n) => n.as_u64(),
        Value::String(s) => {
            let trimmed = s.trim();
            if let Ok(num) = trimmed.parse::<u64>() {
                Some(num)
            } else if trimmed.len() == 12 && trimmed.bytes().all(|b| b.is_ascii_hexdigit()) {
                size_hash = Some(trimmed.to_ascii_lowercase());
                None
            } else {
                None
            }
        }
        _ => None,
    });
    let duration = obj
        .get("duration")
        .and_then(|v| v.as_f64())
        .filter(|d| d.is_finite() && *d >= 0.0);
    Some(WireFileInfo {
        name,
        size,
        size_hash,
        duration,
    })
}

pub const SOFT_DRIFT_ENGAGE_SECS: f64 = 0.6;
pub const SOFT_DRIFT_CLEAR_SECS: f64 = 0.25;
pub const IGNORING_CLIENT_TIMEOUT_SECS: f64 = 2.5;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineTransform {
    /// Local offset in seconds: `T_local = scale * T_room + offset_secs`.
    pub offset_secs: f64,
    /// Playback speed scale of local file relative to room time (e.g. `23.976 / 25.0`).
    pub scale: f64,
}

impl Default for TimelineTransform {
    fn default() -> Self {
        Self {
            offset_secs: 0.0,
            scale: 1.0,
        }
    }
}

impl TimelineTransform {
    pub fn sanitized(self) -> Self {
        Self {
            offset_secs: if self.offset_secs.is_finite() {
                self.offset_secs.clamp(-3600.0, 3600.0)
            } else {
                0.0
            },
            scale: if self.scale.is_finite() && self.scale > 0.0 {
                self.scale.clamp(0.5, 2.0)
            } else {
                1.0
            },
        }
    }

    pub fn is_identity(self) -> bool {
        self.offset_secs.abs() < 1e-4 && (self.scale - 1.0).abs() < 1e-5
    }

    pub fn room_to_local_raw(self, room_secs: f64) -> f64 {
        let safe_room = if room_secs.is_finite() && room_secs >= 0.0 {
            room_secs
        } else {
            0.0
        };
        safe_room * self.scale + self.offset_secs
    }

    pub fn room_to_local(self, room_secs: f64, local_duration: Option<f64>) -> f64 {
        let raw = self.room_to_local_raw(room_secs).max(0.0);
        match local_duration {
            Some(dur) if dur.is_finite() && dur > 0.25 => raw.min((dur - 0.05).max(0.0)),
            _ => raw,
        }
    }

    pub fn local_to_room(self, local_secs: f64) -> f64 {
        let safe_local = if local_secs.is_finite() && local_secs >= 0.0 {
            local_secs
        } else {
            0.0
        };
        ((safe_local - self.offset_secs) / self.scale).max(0.0)
    }

    pub fn effective_speed(self, soft_speed: f64) -> f64 {
        (self.scale * soft_speed).clamp(0.25, 4.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSegment {
    pub room_start_secs: f64,
    pub offset_secs: f64,
    pub scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hold_room_until_secs: Option<f64>,
}

impl TimelineSegment {
    pub fn sanitized(self) -> Self {
        let room_start_secs = if self.room_start_secs.is_finite() && self.room_start_secs >= 0.0 {
            self.room_start_secs
        } else {
            0.0
        };
        let tx = TimelineTransform {
            offset_secs: self.offset_secs,
            scale: self.scale,
        }
        .sanitized();
        let hold_room_until_secs = self
            .hold_room_until_secs
            .filter(|h| h.is_finite() && *h > room_start_secs + 0.25);
        Self {
            room_start_secs,
            offset_secs: tx.offset_secs,
            scale: tx.scale,
            hold_room_until_secs,
        }
    }

    pub fn to_transform(self) -> TimelineTransform {
        TimelineTransform {
            offset_secs: self.offset_secs,
            scale: self.scale,
        }
        .sanitized()
    }
}

/// Snaps a measured two-point slope to an exact standard cinema/PAL/NTSC ratio when within tolerance,
/// preventing small manual-click timing errors from introducing unintended playback speedup/slowdown.
pub fn fit_two_point_timeline_transform(
    room_a: f64,
    local_a: f64,
    room_b: f64,
    local_b: f64,
) -> Option<TimelineTransform> {
    if ![room_a, local_a, room_b, local_b]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.0)
    {
        return None;
    }
    let (r1, l1, r2, l2) = if room_a <= room_b {
        (room_a, local_a, room_b, local_b)
    } else {
        (room_b, local_b, room_a, local_a)
    };
    let dr = r2 - r1;
    let dl = l2 - l1;
    if dr < 30.0 || dl <= 0.0 {
        return None;
    }
    let raw_scale = dl / dr;
    if !(0.90..=1.12).contains(&raw_scale) {
        return None;
    }

    let ntsc_film = 24_000.0 / 1001.0;
    let candidates = [
        (1.0, 0.0012),
        (ntsc_film / 25.0, 0.002),
        (25.0 / ntsc_film, 0.002),
        (24.0 / 25.0, 0.002),
        (25.0 / 24.0, 0.002),
        (ntsc_film / 24.0, 0.0004),
        (24.0 / ntsc_film, 0.0004),
    ];

    let mut snapped_scale = 1.0;
    let mut best_dist = f64::INFINITY;
    for (cand, tol) in candidates {
        let dist = (raw_scale - cand).abs();
        if dist <= tol && dist < best_dist {
            best_dist = dist;
            snapped_scale = cand;
        }
    }

    let offset_secs = ((l1 - snapped_scale * r1) + (l2 - snapped_scale * r2)) * 0.5;
    Some(
        TimelineTransform {
            offset_secs,
            scale: snapped_scale,
        }
        .sanitized(),
    )
}

#[derive(Debug, Clone)]
pub struct SyncStateMachine {
    pub local_username: Option<String>,
    pub local_pos: f64,
    pub last_local_mpv_pos: f64,
    pub local_paused: bool,
    pub ignoring_client: u64,
    pub ignoring_client_since: Option<f64>,
    pub ignoring_server: Option<u64>,
    pub pending_do_seek: bool,
    pub last_latency_calculation: Option<f64>,
    pub last_server_playstate: Option<Playstate>,
    pub last_server_state_at: Option<f64>,
    pub rtt_secs: f64,
    pub soft_speed: f64,
    pub transform: TimelineTransform,
    pub segments: Vec<TimelineSegment>,
    pub local_duration_secs: Option<f64>,
    pub align_mode: bool,
    pub waiting_preroll: bool,
    pub waiting_postroll: bool,
    pub waiting_cut_hold: bool,
}

impl Default for SyncStateMachine {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncStateMachine {
    pub fn new() -> Self {
        Self::with_initial_state(PlayerSnapshot::default())
    }

    pub fn with_initial_state(snapshot: PlayerSnapshot) -> Self {
        let initial_pos = if snapshot.position.is_finite() && snapshot.position >= 0.0 {
            snapshot.position
        } else {
            0.0
        };
        Self {
            local_username: None,
            local_pos: initial_pos,
            last_local_mpv_pos: initial_pos,
            local_paused: snapshot.paused,
            ignoring_client: 0,
            ignoring_client_since: None,
            ignoring_server: None,
            pending_do_seek: false,
            last_latency_calculation: None,
            last_server_playstate: None,
            last_server_state_at: None,
            rtt_secs: 0.0,
            soft_speed: 1.0,
            transform: TimelineTransform::default(),
            segments: Vec::new(),
            local_duration_secs: None,
            align_mode: false,
            waiting_preroll: false,
            waiting_postroll: false,
            waiting_cut_hold: false,
        }
    }

    pub fn reset_for_new_file(&mut self) {
        self.local_pos = 0.0;
        self.last_local_mpv_pos = 0.0;
        self.local_paused = true;
        self.ignoring_client = 0;
        self.ignoring_client_since = None;
        self.pending_do_seek = false;
        self.last_server_playstate = None;
        self.last_server_state_at = None;
        self.soft_speed = 1.0;
        self.transform = TimelineTransform::default();
        self.segments.clear();
        self.local_duration_secs = None;
        self.align_mode = false;
        self.waiting_preroll = false;
        self.waiting_postroll = false;
        self.waiting_cut_hold = false;
    }

    pub fn set_local_username(&mut self, username: String) {
        self.local_username = Some(username);
    }

    pub fn set_local_duration(&mut self, duration_secs: Option<f64>) {
        self.local_duration_secs = duration_secs.filter(|d| d.is_finite() && *d > 0.0);
    }

    fn active_segment_at(&self, room_secs: f64) -> TimelineSegment {
        if self.segments.is_empty() {
            return TimelineSegment {
                room_start_secs: 0.0,
                offset_secs: self.transform.offset_secs,
                scale: self.transform.scale,
                hold_room_until_secs: None,
            };
        }
        let idx = self
            .segments
            .partition_point(|seg| seg.room_start_secs <= room_secs)
            .saturating_sub(1);
        self.segments[idx]
    }

    pub fn active_transform_at(&self, room_secs: f64) -> TimelineTransform {
        self.active_segment_at(room_secs).to_transform()
    }

    pub fn map_local_to_room(&self, local_secs: f64) -> f64 {
        if self.segments.len() <= 1 {
            return self.transform.local_to_room(local_secs);
        }
        let mut best_room: Option<(f64, f64)> = None;
        for (i, seg) in self.segments.iter().enumerate() {
            if seg.hold_room_until_secs.is_some() {
                continue;
            }
            let r_lo = seg.room_start_secs;
            let r_hi = self
                .segments
                .get(i + 1)
                .map(|n| n.room_start_secs)
                .unwrap_or(f64::INFINITY);
            let mapped = seg.to_transform().local_to_room(local_secs);
            if mapped >= r_lo - 0.75 && mapped <= r_hi + 0.75 {
                let dist = (mapped - self.local_pos).abs();
                if best_room.is_none_or(|(_, best_d)| dist < best_d) {
                    best_room = Some((mapped.max(0.0), dist));
                }
            }
        }
        best_room.map(|(r, _)| r).unwrap_or_else(|| {
            self.active_transform_at(self.local_pos)
                .local_to_room(local_secs)
        })
    }

    pub fn estimated_room_position(&self, now_secs: f64) -> f64 {
        if let Some(ref ps) = self.last_server_playstate {
            let elapsed = if !ps.paused {
                self.last_server_state_at
                    .map(|t| (now_secs - t).clamp(0.0, 5.0))
                    .unwrap_or(0.0)
                    + self.rtt_secs / 2.0
            } else {
                0.0
            };
            (ps.position + elapsed).max(0.0)
        } else {
            self.local_pos.max(0.0)
        }
    }

    pub fn set_transform(
        &mut self,
        transform: TimelineTransform,
        now_secs: f64,
    ) -> Vec<SyncAction> {
        self.segments.clear();
        self.transform = transform.sanitized();
        if self.align_mode {
            return Vec::new();
        }
        self.force_resync(now_secs)
    }

    pub fn set_piecewise_timeline(
        &mut self,
        segments: Vec<TimelineSegment>,
        now_secs: f64,
    ) -> Vec<SyncAction> {
        let mut clean: Vec<TimelineSegment> = segments
            .into_iter()
            .map(TimelineSegment::sanitized)
            .collect();
        clean.sort_by(|a, b| a.room_start_secs.total_cmp(&b.room_start_secs));
        if clean.len() <= 1 {
            let tx = clean.first().map(|s| s.to_transform()).unwrap_or_default();
            return self.set_transform(tx, now_secs);
        }
        self.transform = clean[0].to_transform();
        self.segments = clean;
        if self.align_mode {
            return Vec::new();
        }
        self.force_resync(now_secs)
    }

    pub fn set_align_mode(&mut self, align_mode: bool, now_secs: f64) -> Vec<SyncAction> {
        self.align_mode = align_mode;
        if align_mode {
            self.waiting_preroll = false;
            self.waiting_postroll = false;
            self.waiting_cut_hold = false;
            Vec::new()
        } else {
            self.force_resync(now_secs)
        }
    }

    pub fn align_scene_here(
        &mut self,
        mpv_pos_secs: f64,
        now_secs: f64,
    ) -> (TimelineTransform, Vec<SyncAction>) {
        let room_pos = self.estimated_room_position(now_secs);
        let safe_local = if mpv_pos_secs.is_finite() && mpv_pos_secs >= 0.0 {
            mpv_pos_secs
        } else {
            0.0
        };
        let active_scale = self.active_transform_at(room_pos).scale;
        self.segments.clear();
        self.transform = TimelineTransform {
            offset_secs: safe_local - active_scale * room_pos,
            scale: active_scale,
        }
        .sanitized();
        self.align_mode = false;
        let actions = self.force_resync(now_secs);
        (self.transform, actions)
    }

    pub fn update_local_player(&mut self, position: f64, paused: bool) {
        if self.align_mode || self.waiting_preroll || self.waiting_postroll || self.waiting_cut_hold
        {
            return;
        }
        if position.is_finite() && position >= 0.0 && self.ignoring_client == 0 {
            self.last_local_mpv_pos = position;
            self.local_pos = self.map_local_to_room(position);
        }
        if self.ignoring_client == 0 && self.last_server_playstate.is_none() {
            self.local_paused = paused;
        }
    }

    pub fn on_user_play(&mut self, position: f64) {
        self.waiting_preroll = false;
        self.waiting_postroll = false;
        self.waiting_cut_hold = false;
        self.ignoring_client = self.ignoring_client.saturating_add(1);
        self.ignoring_client_since = None;
        if position.is_finite() && position >= 0.0 {
            self.last_local_mpv_pos = position;
            self.local_pos = self.map_local_to_room(position);
        }
        self.local_paused = false;
    }

    pub fn on_user_pause(&mut self, position: f64) {
        self.waiting_preroll = false;
        self.waiting_postroll = false;
        self.waiting_cut_hold = false;
        self.ignoring_client = self.ignoring_client.saturating_add(1);
        self.ignoring_client_since = None;
        if position.is_finite() && position >= 0.0 {
            self.last_local_mpv_pos = position;
            self.local_pos = self.map_local_to_room(position);
        }
        self.local_paused = true;
    }

    /// Preserves a local paused state when an external server update must not unpause playback.
    pub fn keep_local_paused(&mut self) {
        self.local_paused = true;
        self.soft_speed = 1.0;
    }

    pub fn on_user_seek(&mut self, position: f64) {
        self.waiting_preroll = false;
        self.waiting_postroll = false;
        self.waiting_cut_hold = false;
        self.ignoring_client = self.ignoring_client.saturating_add(1);
        self.ignoring_client_since = None;
        if position.is_finite() && position >= 0.0 {
            self.last_local_mpv_pos = position;
            self.local_pos = self.map_local_to_room(position);
        }
        self.pending_do_seek = true;
    }

    /// Restores both room timeline coordinates and local mpv coordinates cleanly when pushing back
    /// an unauthorized guest state update without double-transforming timeline offsets.
    pub fn restore_authoritative_room_playstate(
        &mut self,
        room_pos: f64,
        paused: bool,
        local_pos: f64,
    ) {
        self.waiting_preroll = false;
        self.waiting_postroll = false;
        self.waiting_cut_hold = false;
        self.ignoring_client = self.ignoring_client.saturating_add(1);
        self.ignoring_client_since = None;
        self.pending_do_seek = true;
        self.local_paused = paused;
        if room_pos.is_finite() && room_pos >= 0.0 {
            self.local_pos = room_pos;
        }
        if local_pos.is_finite() && local_pos >= 0.0 {
            self.last_local_mpv_pos = local_pos;
        }
    }

    /// Force an immediate hard snap to the most recently observed room state.
    pub fn force_resync(&mut self, now_secs: f64) -> Vec<SyncAction> {
        let mut actions = Vec::new();
        self.ignoring_client = 0;
        self.ignoring_client_since = None;
        self.pending_do_seek = false;
        self.soft_speed = 1.0;

        if let Some(ref ps) = self.last_server_playstate {
            let elapsed = self
                .last_server_state_at
                .map(|t| (now_secs - t).clamp(0.0, 5.0))
                .unwrap_or(0.0);
            let target_room = (ps.position
                + if !ps.paused {
                    elapsed + self.rtt_secs / 2.0
                } else {
                    0.0
                })
            .max(0.0);
            let seg = self.active_segment_at(target_room);
            let tx = seg.to_transform();
            let base_speed = tx.effective_speed(1.0);
            actions.push(SyncAction::SetSpeed(base_speed));

            let cut_hold = !ps.paused && seg.hold_room_until_secs.is_some_and(|u| target_room < u);
            let raw_local = if cut_hold {
                seg.offset_secs.max(0.0)
            } else {
                tx.room_to_local_raw(target_room)
            };
            let preroll = !ps.paused && !cut_hold && raw_local < -0.05;
            let postroll = !ps.paused
                && !cut_hold
                && self
                    .local_duration_secs
                    .is_some_and(|d| d > 5.0 && raw_local >= d - 0.05);
            self.waiting_preroll = preroll;
            self.waiting_postroll = postroll;
            self.waiting_cut_hold = cut_hold;
            self.local_paused = ps.paused;
            self.local_pos = target_room;
            let target_local = if cut_hold {
                raw_local
            } else {
                tx.room_to_local(target_room, self.local_duration_secs)
            };
            self.last_local_mpv_pos = target_local;
            actions.push(SyncAction::SetPaused(
                ps.paused || preroll || postroll || cut_hold,
            ));
            actions.push(SyncAction::Seek(target_local));
        } else {
            actions.push(SyncAction::SetSpeed(self.transform.effective_speed(1.0)));
            self.waiting_preroll = false;
            self.waiting_postroll = false;
            self.waiting_cut_hold = false;
        }

        actions
    }

    pub fn handle_server_state(&mut self, state: &ServerState, now_secs: f64) -> Vec<SyncAction> {
        let mut actions = Vec::new();

        if let Some(ref ping) = state.ping {
            if let Some(lc) = ping.latency_calculation {
                self.last_latency_calculation = Some(lc);
            }
            if let Some(clc) = ping.client_latency_calculation {
                let measured = (now_secs - clc).clamp(0.0, 5.0);
                self.rtt_secs = measured;
            } else if let Some(rtt) = ping.client_rtt {
                self.rtt_secs = rtt.clamp(0.0, 5.0);
            }
        }

        let mut acknowledged_client = false;
        let mut server_override = false;

        if let Some(ref ig) = state.ignoring_on_the_fly {
            if let Some(srv) = ig.server {
                self.ignoring_server = Some(srv);
            }
            if let Some(cli) = ig.client {
                if cli >= self.ignoring_client {
                    self.ignoring_client = 0;
                    self.ignoring_client_since = None;
                    acknowledged_client = true;
                }
            }
        }

        if let Some(ref ps) = state.playstate {
            self.last_server_playstate = Some(ps.clone());
            self.last_server_state_at = Some(now_secs);

            let from_other_or_server = match (&ps.set_by, &self.local_username) {
                (Some(sb), Some(me)) => !sb.eq_ignore_ascii_case(me),
                (Some(_), None) => true,
                _ => false,
            };
            let server_ignored = state
                .ignoring_on_the_fly
                .as_ref()
                .and_then(|i| i.server)
                .is_some();
            let has_client_ack_token = state
                .ignoring_on_the_fly
                .as_ref()
                .and_then(|i| i.client)
                .is_some();
            // A routine pre-seek server tick (doSeek=false and matching paused state) can carry
            // ignoringOnTheFly.server while another peer was the last `setBy`. Treat it as a real
            // override only when it carries an explicit seek or pause/play state change; otherwise
            // it would snap an in-flight user click-seek back to the previous position after 1 frame.
            let server_forced_action = ps.do_seek || ps.paused != self.local_paused;
            if self.ignoring_client > 0
                && !acknowledged_client
                && server_ignored
                && server_forced_action
                && (from_other_or_server || (ps.set_by.is_none() && !has_client_ack_token))
            {
                server_override = true;
                self.ignoring_client = 0;
                self.ignoring_client_since = None;
                self.pending_do_seek = false;
            }

            if self.ignoring_client > 0 && !acknowledged_client && !server_override {
                if self.ignoring_client_since.is_none() {
                    self.ignoring_client_since = Some(now_secs);
                }
                if self
                    .ignoring_client_since
                    .is_some_and(|since| now_secs - since >= IGNORING_CLIENT_TIMEOUT_SECS)
                {
                    self.ignoring_client = 0;
                    self.ignoring_client_since = None;
                    self.pending_do_seek = false;
                } else {
                    return actions;
                }
            }

            if self.ignoring_client == 0 {
                self.ignoring_client_since = None;
            }

            let target_room =
                (ps.position + if !ps.paused { self.rtt_secs / 2.0 } else { 0.0 }).max(0.0);

            if self.align_mode {
                self.local_paused = ps.paused;
                self.local_pos = target_room;
                return actions;
            }

            if server_override {
                actions.push(SyncAction::ServerOverride {
                    set_by: ps.set_by.clone(),
                });
            }

            let seg = self.active_segment_at(target_room);
            let tx = seg.to_transform();
            let next_cut_hold =
                !ps.paused && seg.hold_room_until_secs.is_some_and(|u| target_room < u);
            let raw_local = if next_cut_hold {
                seg.offset_secs.max(0.0)
            } else {
                tx.room_to_local_raw(target_room)
            };
            let next_preroll = !ps.paused && !next_cut_hold && raw_local < -0.05;
            let next_postroll = !ps.paused
                && !next_cut_hold
                && self
                    .local_duration_secs
                    .is_some_and(|d| d > 5.0 && raw_local >= d - 0.05);
            let was_hold = self.waiting_preroll || self.waiting_postroll || self.waiting_cut_hold;
            let is_hold = next_preroll || next_postroll || next_cut_hold;

            let external_do_seek = ps.do_seek
                && (!acknowledged_client
                    || from_other_or_server
                    || server_override
                    || (server_ignored && ps.set_by.is_none()));

            if is_hold {
                self.waiting_preroll = next_preroll;
                self.waiting_postroll = next_postroll;
                self.waiting_cut_hold = next_cut_hold;
                self.local_paused = false;
                self.local_pos = target_room;
                if !was_hold || external_do_seek || server_override {
                    if (self.soft_speed - 1.0).abs() > 1e-3 {
                        self.soft_speed = 1.0;
                        actions.push(SyncAction::SetSpeed(tx.effective_speed(1.0)));
                    }
                    let target_local = if next_cut_hold {
                        raw_local
                    } else {
                        tx.room_to_local(target_room, self.local_duration_secs)
                    };
                    self.last_local_mpv_pos = target_local;
                    actions.push(SyncAction::SetPaused(true));
                    actions.push(SyncAction::Seek(target_local));
                }
                return actions;
            }

            self.waiting_preroll = false;
            self.waiting_postroll = false;
            self.waiting_cut_hold = false;

            if ps.paused != self.local_paused || was_hold {
                self.local_paused = ps.paused;
                actions.push(SyncAction::SetPaused(ps.paused));
            }

            let target_local = tx.room_to_local(target_room, self.local_duration_secs);
            let signed_drift = if self.segments.len() > 1 {
                (self.last_local_mpv_pos - target_local) / tx.scale.max(0.25)
            } else {
                self.local_pos - target_room
            };
            let drift = signed_drift.abs();
            if was_hold || external_do_seek || server_override || drift > DRIFT_SEEK_THRESHOLD_SECS
            {
                if (self.soft_speed - 1.0).abs() > 1e-3 || was_hold {
                    self.soft_speed = 1.0;
                    actions.push(SyncAction::SetSpeed(tx.effective_speed(1.0)));
                }
                self.local_pos = target_room;
                self.last_local_mpv_pos = target_local;
                actions.push(SyncAction::Seek(target_local));
            } else if !ps.paused {
                let desired_speed = if signed_drift > SOFT_DRIFT_ENGAGE_SECS {
                    0.95
                } else if signed_drift < -SOFT_DRIFT_ENGAGE_SECS {
                    1.05
                } else if drift <= SOFT_DRIFT_CLEAR_SECS {
                    1.0
                } else {
                    self.soft_speed
                };
                if (desired_speed - self.soft_speed).abs() > 1e-3 {
                    self.soft_speed = desired_speed;
                    actions.push(SyncAction::SetSpeed(tx.effective_speed(desired_speed)));
                }
            } else if (self.soft_speed - 1.0).abs() > 1e-3 {
                self.soft_speed = 1.0;
                actions.push(SyncAction::SetSpeed(tx.effective_speed(1.0)));
            }
        }

        actions
    }

    pub fn on_heartbeat_tick(&mut self, now_secs: f64) -> String {
        if self.ignoring_client > 0 && self.ignoring_client_since.is_none() {
            self.ignoring_client_since = Some(now_secs);
        } else if self.ignoring_client == 0 {
            self.ignoring_client_since = None;
        }
        let do_seek = self.pending_do_seek;
        self.pending_do_seek = false;
        let ig_server = self.ignoring_server.take();
        let ig_client = if self.ignoring_client > 0 {
            Some(self.ignoring_client)
        } else {
            None
        };
        encode_state(
            self.local_pos,
            self.local_paused,
            do_seek,
            now_secs,
            self.last_latency_calculation,
            Some(self.rtt_secs),
            ig_server,
            ig_client,
        )
    }
}

#[derive(Debug, Clone)]
pub struct ReconnectPolicy {
    pub attempt: u32,
    pub max_attempts: u32,
}

impl Default for ReconnectPolicy {
    fn default() -> Self {
        Self::new()
    }
}

impl ReconnectPolicy {
    pub fn new() -> Self {
        Self {
            attempt: 0,
            max_attempts: MAX_RECONNECT_ATTEMPTS,
        }
    }

    pub fn next_delay_secs(&mut self) -> Option<u64> {
        if self.attempt >= self.max_attempts {
            return None;
        }
        let delay = match self.attempt {
            0 => 1,
            1 => 2,
            2 => 4,
            _ => 8,
        };
        self.attempt += 1;
        Some(delay)
    }

    pub fn on_connected(&mut self) {
        self.attempt = 0;
    }

    pub fn manual_retry(&mut self) {
        self.attempt = 0;
    }

    pub fn suggest_backup(&self) -> bool {
        self.attempt >= 3
    }

    pub fn circuit_open(&self) -> bool {
        self.attempt >= self.max_attempts
    }
}

#[derive(Debug, Default)]
pub struct RoomParticipantTracker {
    pub participants: HashMap<String, RoomParticipantUpdate>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpListener;
    use std::thread;

    #[test]
    fn test_md5_rfc1321_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            md5_hex(b"message digest"),
            "f96b697d7cb7938d525a2f31aaf161d0"
        );
    }

    #[test]
    fn test_extract_tls_server_name() {
        assert_eq!(extract_tls_server_name("syncplay.pl:8999"), "syncplay.pl");
        assert_eq!(extract_tls_server_name("[::1]:8999"), "::1");
    }

    #[test]
    fn test_encode_and_parse_tls() {
        assert_eq!(
            encode_start_tls_send(),
            "{\"TLS\":{\"startTLS\":\"send\"}}\r\n"
        );
        let parsed = parse_server_line(r#"{"TLS":{"startTLS":"true"}}"#).unwrap();
        assert_eq!(parsed, ServerMessage::Tls { start_tls: true });
    }

    #[test]
    fn test_encode_and_parse_hello() {
        let no_pw = encode_hello("Ahmed", "ep-123", None);
        assert!(!no_pw.contains("password"));
        let with_pw = encode_hello("Ahmed", "ep-123", Some("secret"));
        assert!(with_pw.contains(&md5_hex(b"secret")));

        let parsed = parse_server_line(
            r#"{"Hello":{"username":"Ahmed_1","room":{"name":"ep-123"},"version":"1.7.0"}}"#,
        )
        .unwrap();
        assert_eq!(
            parsed,
            ServerMessage::Hello {
                username: "Ahmed_1".into(),
                room: "ep-123".into(),
                version: "1.7.0".into(),
            }
        );
    }

    #[test]
    fn test_encode_and_parse_set_and_list() {
        let ready = encode_set_ready(true, true);
        assert!(ready.contains("\"isReady\":true"));
        let list = parse_server_line(
            r#"{"List":{"ep-1":{"Alice":{"position":120.5,"paused":false,"isReady":true,"controller":true,"file":{"name":"movie.mkv","size":1000,"duration":5400.0}}}}}"#,
        )
        .unwrap();
        match list {
            ServerMessage::List(items) => {
                assert_eq!(items.len(), 1);
                assert_eq!(items[0].username, "Alice");
                assert!(items[0].is_controller);
                assert_eq!(items[0].file.as_ref().unwrap().name, "movie.mkv");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn test_multi_user_set_messages() {
        let msg = parse_server_line(
            r#"{"Set":{"user":{"Bob":{"isReady":false,"file":{"name":"b.mkv","size":200,"duration":300.0}}}}}"#,
        )
        .unwrap();
        match msg {
            ServerMessage::Set(updates) => {
                assert_eq!(updates.len(), 2);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn test_parse_malformed_empty_and_user_leave() {
        assert!(parse_server_line("").is_err());
        assert!(parse_server_line("{bad").is_err());
        let leave =
            parse_server_line(r#"{"Set":{"user":{"Bob":{"event":{"left":true}}}}}"#).unwrap();
        assert_eq!(
            leave,
            ServerMessage::Set(vec![SetUpdate::UserLeft {
                username: "Bob".into()
            }])
        );
    }

    #[test]
    fn test_privacy_hashing_and_strip_filename() {
        assert_eq!(strip_filename_for_hash(r"C:\Movies\Ep 01.mkv"), "Ep 01");
        assert_ne!(hash_filename("Ep 01.mkv"), "Ep 01.mkv");
        assert_eq!(hash_filename("Ep 01.mkv"), hash_filename("Ep 01.mp4"));
    }

    #[test]
    fn test_hashed_file_encoding_round_trip() {
        let line = encode_set_file("Movie.mkv", Some(123456), 5400.0, true);
        let parsed: Value = serde_json::from_str(line.trim()).unwrap();
        assert_eq!(parsed["Set"]["file"]["name"], hash_filename("Movie.mkv"));
    }

    #[test]
    fn test_anti_echo_suppression_and_acknowledgment() {
        let mut sm = SyncStateMachine::new();
        sm.on_user_seek(120.0);
        let stale = ServerState {
            playstate: Some(Playstate {
                position: 10.0,
                paused: true,
                do_seek: true,
                set_by: Some("Peer".into()),
            }),
            ignoring_on_the_fly: Some(IgnoringOnTheFly {
                server: None,
                client: None,
            }),
            ..Default::default()
        };
        assert!(sm.handle_server_state(&stale, 100.0).is_empty());

        let ack = ServerState {
            playstate: Some(Playstate {
                position: 120.0,
                paused: true,
                do_seek: false,
                set_by: None,
            }),
            ignoring_on_the_fly: Some(IgnoringOnTheFly {
                server: None,
                client: Some(1),
            }),
            ..Default::default()
        };
        let actions = sm.handle_server_state(&ack, 101.0);
        assert!(actions.is_empty());
        assert_eq!(sm.ignoring_client, 0);
    }

    #[test]
    fn test_self_seek_ack_with_do_seek_echo_does_not_reseek_originator() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 100.0,
            paused: false,
        });
        sm.set_local_username("Alice".into());
        sm.rtt_secs = 0.30;

        sm.on_user_seek(300.0);
        let _ = sm.on_heartbeat_tick(10.0);

        // Server echoes Alice's own seek back with doSeek=true, setBy="Alice", AND server ignoring token:
        // Alice must NOT seek a second time to 300.05 + rtt/2.
        let self_ack = ServerState {
            playstate: Some(Playstate {
                position: 300.05,
                paused: false,
                do_seek: true,
                set_by: Some("Alice".into()),
            }),
            ignoring_on_the_fly: Some(IgnoringOnTheFly {
                server: Some(4),
                client: Some(1),
            }),
            ..Default::default()
        };
        let self_actions = sm.handle_server_state(&self_ack, 10.15);
        assert!(
            !self_actions
                .iter()
                .any(|a| matches!(a, SyncAction::Seek(_))),
            "self-seek ACK must not trigger duplicate Seek action: {self_actions:?}"
        );

        // Rapid double-seek must ignore stale first-seek echo without jumping backward to 300.0
        sm.on_user_seek(300.0);
        let _ = sm.on_heartbeat_tick(11.0);
        sm.on_user_seek(720.0);
        let _ = sm.on_heartbeat_tick(11.05);
        let stale_first_echo = ServerState {
            playstate: Some(Playstate {
                position: 300.0,
                paused: false,
                do_seek: true,
                set_by: None,
            }),
            ignoring_on_the_fly: Some(IgnoringOnTheFly {
                server: Some(5),
                client: Some(1),
            }),
            ..Default::default()
        };
        assert!(
            sm.handle_server_state(&stale_first_echo, 11.1).is_empty(),
            "stale first-seek echo must not override newer pending seek"
        );
        assert_eq!(sm.ignoring_client, 2);
        let final_ack = ServerState {
            playstate: Some(Playstate {
                position: 720.0,
                paused: false,
                do_seek: true,
                set_by: Some("Alice".into()),
            }),
            ignoring_on_the_fly: Some(IgnoringOnTheFly {
                server: Some(6),
                client: Some(2),
            }),
            ..Default::default()
        };
        assert!(sm.handle_server_state(&final_ack, 11.2).is_empty());
        assert_eq!(sm.ignoring_client, 0);

        // Whereas a seek originated by peer Bob MUST trigger Seek cleanly.
        let peer_seek = ServerState {
            playstate: Some(Playstate {
                position: 450.0,
                paused: false,
                do_seek: true,
                set_by: Some("Bob".into()),
            }),
            ..Default::default()
        };
        let peer_actions = sm.handle_server_state(&peer_seek, 12.0);
        assert_eq!(peer_actions, vec![SyncAction::Seek(450.15)]);
    }

    #[test]
    fn test_drift_threshold_boundary() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 100.0,
            paused: true,
        });
        let small = ServerState {
            playstate: Some(Playstate {
                position: 103.5,
                paused: true,
                do_seek: false,
                set_by: None,
            }),
            ..Default::default()
        };
        assert!(sm.handle_server_state(&small, 10.0).is_empty());

        let large = ServerState {
            playstate: Some(Playstate {
                position: 105.0,
                paused: true,
                do_seek: false,
                set_by: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            sm.handle_server_state(&large, 11.0),
            vec![SyncAction::Seek(105.0)]
        );
    }

    #[test]
    fn test_two_client_simulation() {
        let mut client_a = SyncStateMachine::new();
        let mut client_b = SyncStateMachine::new();
        client_a.on_user_seek(240.0);
        client_a.on_user_play(240.0);
        let hb_a = client_a.on_heartbeat_tick(50.0);
        let parsed = parse_server_line(&hb_a);
        assert!(matches!(parsed, Err(SyncplayParseError::Unrecognized)) || parsed.is_ok());

        let relay = ServerState {
            playstate: Some(Playstate {
                position: 240.0,
                paused: false,
                do_seek: true,
                set_by: Some("ClientA".into()),
            }),
            ..Default::default()
        };
        let b_actions = client_b.handle_server_state(&relay, 50.0);
        assert_eq!(
            b_actions,
            vec![SyncAction::SetPaused(false), SyncAction::Seek(240.0)]
        );
    }

    #[test]
    fn test_server_override_reverts_unauthorized_local_action_without_loop() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 100.0,
            paused: true,
        });
        sm.set_local_username("Viewer".into());
        sm.on_user_play(100.0);
        let override_state = ServerState {
            playstate: Some(Playstate {
                position: 100.0,
                paused: true,
                do_seek: true,
                set_by: Some("Host".into()),
            }),
            ignoring_on_the_fly: Some(IgnoringOnTheFly {
                server: Some(7),
                client: None,
            }),
            ..Default::default()
        };
        let actions = sm.handle_server_state(&override_state, 200.0);
        assert_eq!(
            actions,
            vec![
                SyncAction::ServerOverride {
                    set_by: Some("Host".into())
                },
                SyncAction::SetPaused(true),
                SyncAction::Seek(100.0),
            ]
        );
        assert_eq!(sm.ignoring_client, 0);
        let reply = sm.on_heartbeat_tick(200.1);
        assert!(reply.contains("\"server\":7"));
        assert!(!reply.contains("\"client\""));
    }

    #[test]
    fn test_state_machine_preserves_seeded_player_state_across_reconnect() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 1842.5,
            paused: false,
        });
        let hb = sm.on_heartbeat_tick(10.0);
        let v: Value = serde_json::from_str(hb.trim()).unwrap();
        assert_eq!(v["State"]["playstate"]["position"], 1842.5);
        assert_eq!(v["State"]["playstate"]["paused"], false);
    }

    #[test]
    fn test_reconnect_policy_backoff_and_backup_suggestion() {
        let mut p = ReconnectPolicy::new();
        assert_eq!(p.next_delay_secs(), Some(1));
        assert!(!p.suggest_backup());
        assert_eq!(p.next_delay_secs(), Some(2));
        assert_eq!(p.next_delay_secs(), Some(4));
        assert!(p.suggest_backup());
        assert_eq!(p.next_delay_secs(), Some(8));
        p.on_connected();
        assert_eq!(p.attempt, 0);
    }

    #[test]
    fn test_reconnect_policy_circuit_breaker_opens_at_max_attempts() {
        let mut p = ReconnectPolicy::new();
        for _ in 0..MAX_RECONNECT_ATTEMPTS {
            assert!(p.next_delay_secs().is_some());
        }
        assert!(p.circuit_open());
        assert_eq!(p.next_delay_secs(), None);
    }

    #[test]
    fn test_manual_retry_policy_resets_from_circuit_open() {
        let mut p = ReconnectPolicy::new();
        for _ in 0..MAX_RECONNECT_ATTEMPTS {
            p.next_delay_secs();
        }
        assert!(p.circuit_open());
        p.manual_retry();
        assert!(!p.circuit_open());
        assert_eq!(p.next_delay_secs(), Some(1));
    }

    #[test]
    fn test_wire_sanitization_and_bounds() {
        let huge = "x".repeat(MAX_WIRE_LINE_BYTES + 1);
        assert_eq!(
            parse_server_line(&huge),
            Err(SyncplayParseError::LineTooLong)
        );

        let nan_json = r#"{"State":{"ping":{"latencyCalculation":NaN,"clientRtt":Infinity}}}"#;
        assert!(parse_server_messages(nan_json)[0].is_err());

        let overflow = r#"{"State":{"ping":{"latencyCalculation":1e999,"clientRtt":1e309}}}"#;
        assert!(parse_server_messages(overflow)[0].is_err());
    }

    #[test]
    fn test_loopback_tcp_two_client_relay() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let server = thread::spawn(move || {
            let (mut s1, _) = listener.accept().unwrap();
            let (mut s2, _) = listener.accept().unwrap();
            let mut r1 = BufReader::new(s1.try_clone().unwrap());
            let mut line = String::new();
            r1.read_line(&mut line).unwrap();
            s1.write_all(b"{\"Hello\":{\"username\":\"A\",\"room\":{\"name\":\"r\"},\"version\":\"1.7\"}}\r\n")
                .unwrap();
            s2.write_all(b"{\"State\":{\"playstate\":{\"position\":42.0,\"paused\":false,\"doSeek\":true}}}\r\n")
                .unwrap();
        });

        let mut c1 = std::net::TcpStream::connect(addr).unwrap();
        let c2 = std::net::TcpStream::connect(addr).unwrap();
        c1.write_all(encode_hello("A", "r", None).as_bytes())
            .unwrap();

        let mut r1 = BufReader::new(c1);
        let mut l1 = String::new();
        r1.read_line(&mut l1).unwrap();
        assert!(matches!(
            parse_server_line(&l1).unwrap(),
            ServerMessage::Hello { .. }
        ));

        let mut r2 = BufReader::new(c2);
        let mut l2 = String::new();
        r2.read_line(&mut l2).unwrap();
        assert!(matches!(
            parse_server_line(&l2).unwrap(),
            ServerMessage::State(_)
        ));
        server.join().unwrap();
    }

    #[test]
    fn test_hashed_wire_size_and_file_cleared() {
        let sz_hash = hash_filesize(987654321);
        let msg = parse_server_line(&format!(
            r#"{{"Set":{{"user":{{"Bob":{{"file":{{"name":"a1b2c3d4e5f6","size":"{sz_hash}","duration":1440.0}}}}}}}}}}"#
        ))
        .unwrap();
        match msg {
            ServerMessage::Set(updates) => {
                assert_eq!(updates.len(), 1);
                match &updates[0] {
                    SetUpdate::File { username, file } => {
                        assert_eq!(username, "Bob");
                        assert_eq!(file.name, "a1b2c3d4e5f6");
                        assert_eq!(file.size, None);
                        assert_eq!(file.size_hash.as_deref(), Some(sz_hash.as_str()));
                    }
                    other => panic!("unexpected update: {other:?}"),
                }
            }
            other => panic!("unexpected msg: {other:?}"),
        }

        let cleared_empty = parse_server_line(r#"{"Set":{"user":{"Bob":{"file":{}}}}}"#).unwrap();
        assert_eq!(
            cleared_empty,
            ServerMessage::Set(vec![SetUpdate::FileCleared {
                username: "Bob".into(),
            }])
        );

        let cleared_null = parse_server_line(r#"{"Set":{"user":{"Bob":{"file":null}}}}"#).unwrap();
        assert_eq!(
            cleared_null,
            ServerMessage::Set(vec![SetUpdate::FileCleared {
                username: "Bob".into(),
            }])
        );
    }

    #[test]
    fn test_soft_speed_drift_correction_and_reset_for_new_file() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 101.2,
            paused: false,
        });

        // Ahead by 1.2s while playing -> slow down to 0.95x
        let ahead = ServerState {
            playstate: Some(Playstate {
                position: 100.0,
                paused: false,
                do_seek: false,
                set_by: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            sm.handle_server_state(&ahead, 10.0),
            vec![SyncAction::SetSpeed(0.95)]
        );

        // Once caught back within 0.25s -> restore 1.0x
        sm.update_local_player(100.1, false);
        assert_eq!(
            sm.handle_server_state(&ahead, 11.0),
            vec![SyncAction::SetSpeed(1.0)]
        );

        // Behind by 1.2s while playing -> speed up to 1.05x
        sm.update_local_player(98.8, false);
        assert_eq!(
            sm.handle_server_state(&ahead, 12.0),
            vec![SyncAction::SetSpeed(1.05)]
        );

        // Pausing resets soft speed back to 1.0x
        let paused_state = ServerState {
            playstate: Some(Playstate {
                position: 100.0,
                paused: true,
                do_seek: false,
                set_by: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            sm.handle_server_state(&paused_state, 13.0),
            vec![SyncAction::SetPaused(true), SyncAction::SetSpeed(1.0)]
        );

        // reset_for_new_file clears position, paused, pending_do_seek, stale server playstate, ignoring_client, and soft_speed
        sm.on_user_seek(250.0);
        sm.soft_speed = 1.05;
        sm.reset_for_new_file();
        assert_eq!(sm.local_pos, 0.0);
        assert!(sm.local_paused);
        assert_eq!(sm.ignoring_client, 0);
        assert!(!sm.pending_do_seek);
        assert!(sm.last_server_playstate.is_none());
        assert!(sm.last_server_state_at.is_none());
        assert_eq!(sm.soft_speed, 1.0);
    }

    #[test]
    fn test_ignoring_client_auto_expires_after_timeout_preventing_deadlock() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 50.0,
            paused: true,
        });
        sm.on_user_seek(120.0);
        let _ = sm.on_heartbeat_tick(10.0);

        // Before timeout: server state without client ack is suppressed
        let unacked_early = ServerState {
            playstate: Some(Playstate {
                position: 200.0,
                paused: false,
                do_seek: false,
                set_by: None,
            }),
            ..Default::default()
        };
        assert!(sm.handle_server_state(&unacked_early, 11.0).is_empty());

        // Past IGNORING_CLIENT_TIMEOUT_SECS: stale ignore lock auto-expires so room state applies
        let actions = sm.handle_server_state(&unacked_early, 13.0);
        assert_eq!(
            actions,
            vec![SyncAction::SetPaused(false), SyncAction::Seek(200.0)]
        );
        assert_eq!(sm.ignoring_client, 0);
    }

    #[test]
    fn test_force_resync_snaps_to_latest_server_playstate_with_elapsed_and_rtt() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 10.0,
            paused: false,
        });
        sm.rtt_secs = 0.4;
        sm.soft_speed = 1.05;
        sm.last_server_playstate = Some(Playstate {
            position: 300.0,
            paused: false,
            do_seek: false,
            set_by: Some("Host".into()),
        });
        sm.last_server_state_at = Some(100.0);
        sm.ignoring_client = 3;

        let actions = sm.force_resync(101.0);
        // elapsed = 1.0s + half RTT (0.2s) -> target = 301.2s
        assert_eq!(
            actions,
            vec![
                SyncAction::SetSpeed(1.0),
                SyncAction::SetPaused(false),
                SyncAction::Seek(301.2),
            ]
        );
        assert_eq!(sm.ignoring_client, 0);
        assert_eq!(sm.soft_speed, 1.0);
    }

    #[test]
    fn test_update_local_player_does_not_clobber_inflight_user_play_or_pause() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 12.0,
            paused: true,
        });
        // Establish server playstate as paused
        let paused_srv = ServerState {
            playstate: Some(Playstate {
                position: 12.0,
                paused: true,
                do_seek: false,
                set_by: None,
            }),
            ..Default::default()
        };
        assert!(sm.handle_server_state(&paused_srv, 10.0).is_empty());

        // Pre-UserPlay snapshot with paused=false must not trick handle_server_state into SetPaused(true)
        sm.update_local_player(12.0, false);
        assert!(sm.local_paused);
        assert!(sm.handle_server_state(&paused_srv, 10.2).is_empty());

        // In-flight UserPlay must not be clobbered back to paused=true by a loading snapshot
        sm.on_user_play(25.0);
        sm.update_local_player(0.0, true);
        assert!(!sm.local_paused);
        assert_eq!(sm.local_pos, 25.0);
    }

    #[test]
    fn test_parse_set_ready_with_manually_initiated() {
        let manual_false = parse_server_line(
            r#"{"Set":{"ready":{"username":"Bob","isReady":false,"manuallyInitiated":true}}}"#,
        )
        .unwrap();
        assert_eq!(
            manual_false,
            ServerMessage::Set(vec![SetUpdate::Ready {
                username: "Bob".into(),
                is_ready: false,
                manually_initiated: Some(true),
            }])
        );

        let user_ready =
            parse_server_line(r#"{"Set":{"user":{"Alice":{"isReady":false}}}}"#).unwrap();
        assert_eq!(
            user_ready,
            ServerMessage::Set(vec![SetUpdate::Ready {
                username: "Alice".into(),
                is_ready: false,
                manually_initiated: None,
            }])
        );
    }

    #[test]
    fn test_keep_local_paused_prevents_heartbeat_from_advertising_unpaused() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 40.0,
            paused: true,
        });
        let unpaused_srv = ServerState {
            playstate: Some(Playstate {
                position: 40.0,
                paused: false,
                do_seek: false,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let actions = sm.handle_server_state(&unpaused_srv, 10.0);
        assert_eq!(actions, vec![SyncAction::SetPaused(false)]);
        sm.keep_local_paused();
        let hb = sm.on_heartbeat_tick(10.1);
        let parsed: Value = serde_json::from_str(hb.trim()).unwrap();
        assert_eq!(parsed["State"]["playstate"]["paused"], true);
    }

    #[test]
    fn test_timeline_transform_maps_room_and_local_with_fps_scale_and_offset() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 0.0,
            paused: true,
        });
        let pal_scale = (24_000.0 / 1001.0) / 25.0;
        let actions = sm.set_transform(
            TimelineTransform {
                offset_secs: 6.5,
                scale: pal_scale,
            },
            1.0,
        );
        assert_eq!(actions, vec![SyncAction::SetSpeed(pal_scale)]);

        // Server says room is at 1000.0s playing -> local mpv must seek to 1000*scale + 6.5
        let srv = ServerState {
            playstate: Some(Playstate {
                position: 1000.0,
                paused: false,
                do_seek: true,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let s_actions = sm.handle_server_state(&srv, 2.0);
        let expected_local = 1000.0 * pal_scale + 6.5;
        assert_eq!(
            s_actions,
            vec![
                SyncAction::SetPaused(false),
                SyncAction::Seek(expected_local)
            ]
        );

        // Local mpv advancing to expected_local maps back to room time 1000.0 in heartbeats
        sm.update_local_player(expected_local, false);
        let hb: Value = serde_json::from_str(sm.on_heartbeat_tick(2.5).trim()).unwrap();
        let reported_pos = hb["State"]["playstate"]["position"].as_f64().unwrap();
        assert!((reported_pos - 1000.0).abs() < 1e-4);

        // Small local drift (+1.0s room equivalent) triggers scaled soft drift speed (0.95 * pal_scale)
        sm.update_local_player((1001.0 * pal_scale) + 6.5, false);
        let drift_srv = ServerState {
            playstate: Some(Playstate {
                position: 1000.0,
                paused: false,
                do_seek: false,
                set_by: None,
            }),
            ..Default::default()
        };
        assert_eq!(
            sm.handle_server_state(&drift_srv, 3.0),
            vec![SyncAction::SetSpeed(pal_scale * 0.95)]
        );
    }

    #[test]
    fn test_preroll_hold_waits_locally_without_pausing_room_then_starts_on_cue() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 0.0,
            paused: true,
        });
        // Peer has a 10s intro bumper that local file does NOT have (offset = -10.0s)
        sm.set_transform(
            TimelineTransform {
                offset_secs: -10.0,
                scale: 1.0,
            },
            1.0,
        );

        // Room plays at T_room = 3.0 -> raw local = -7.0 -> hold mpv paused at 0.0
        let early = ServerState {
            playstate: Some(Playstate {
                position: 3.0,
                paused: false,
                do_seek: false,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let acts_early = sm.handle_server_state(&early, 2.0);
        assert_eq!(
            acts_early,
            vec![SyncAction::SetPaused(true), SyncAction::Seek(0.0)]
        );
        assert!(sm.waiting_preroll);
        // Local player parked at 0.0 must not overwrite room position or pause room in heartbeat
        sm.update_local_player(0.0, true);
        let hb: Value = serde_json::from_str(sm.on_heartbeat_tick(2.5).trim()).unwrap();
        assert_eq!(hb["State"]["playstate"]["paused"], false);
        assert_eq!(hb["State"]["playstate"]["position"], 3.0);

        // Once room crosses 10.0s (T_room = 10.5 -> local = 0.5), unpause and seek to 0.5
        let ready_to_start = ServerState {
            playstate: Some(Playstate {
                position: 10.5,
                paused: false,
                do_seek: false,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let acts_start = sm.handle_server_state(&ready_to_start, 9.5);
        assert!(!sm.waiting_preroll);
        assert_eq!(
            acts_start,
            vec![
                SyncAction::SetPaused(false),
                SyncAction::SetSpeed(1.0),
                SyncAction::Seek(0.5),
            ]
        );
    }

    #[test]
    fn test_align_mode_and_scene_anchor_compute_offset_and_resume_cleanly() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 120.0,
            paused: true,
        });
        let initial = ServerState {
            playstate: Some(Playstate {
                position: 120.0,
                paused: true,
                do_seek: false,
                set_by: Some("Host".into()),
            }),
            ..Default::default()
        };
        assert!(sm.handle_server_state(&initial, 10.0).is_empty());

        // Enter align_mode: local scrubbing and server playstate must not fight each other
        assert!(sm.set_align_mode(true, 11.0).is_empty());
        let peer_scrub = ServerState {
            playstate: Some(Playstate {
                position: 125.0,
                paused: true,
                do_seek: true,
                set_by: Some("Host".into()),
            }),
            ..Default::default()
        };
        assert!(sm.handle_server_state(&peer_scrub, 12.0).is_empty());
        sm.update_local_player(400.0, false);
        let hb: Value = serde_json::from_str(sm.on_heartbeat_tick(12.5).trim()).unwrap();
        assert_eq!(hb["State"]["playstate"]["position"], 125.0);
        assert_eq!(hb["State"]["playstate"]["paused"], true);

        // User finds the matching frame in their BluRay at 133.5s -> offset = 133.5 - 125.0 = +8.5s
        let (tx, acts) = sm.align_scene_here(133.5, 13.0);
        assert!((tx.offset_secs - 8.5).abs() < 1e-6);
        assert!(!sm.align_mode);
        assert_eq!(
            acts,
            vec![
                SyncAction::SetSpeed(1.0),
                SyncAction::SetPaused(true),
                SyncAction::Seek(133.5),
            ]
        );
    }

    #[test]
    fn test_two_point_timeline_fit_snaps_noisy_clicks_to_exact_fps_ratio() {
        let true_scale = (24_000.0 / 1001.0) / 25.0;
        let fitted = fit_two_point_timeline_transform(
            60.0,
            60.0 * true_scale + 5.0,
            1860.0,
            1860.0 * true_scale + 5.2,
        )
        .expect("fit");
        assert!((fitted.scale - true_scale).abs() < 1e-9);
        assert!((fitted.offset_secs - 5.1).abs() < 0.05);

        let same_fps = fit_two_point_timeline_transform(60.0, 68.0, 1860.0, 1868.2).expect("fit");
        assert!((same_fps.scale - 1.0).abs() < 1e-9);
        assert!((same_fps.offset_secs - 8.1).abs() < 0.05);
    }

    #[test]
    fn test_encode_and_parse_chat_message() {
        let encoded = encode_chat("~EP2:abc123");
        assert_eq!(encoded, "{\"Chat\":\"~EP2:abc123\"}\r\n");

        let parsed = parse_server_line(r#"{"Chat":{"username":"Alice","message":"~EP2:abc123"}}"#)
            .expect("parse chat");
        assert_eq!(
            parsed,
            ServerMessage::Chat {
                username: "Alice".into(),
                message: "~EP2:abc123".into(),
            }
        );
    }

    #[test]
    fn test_piecewise_timeline_skips_extra_local_scene_and_holds_across_missing_scene() {
        let mut sm = SyncStateMachine::with_initial_state(PlayerSnapshot {
            position: 0.0,
            paused: false,
        });
        sm.set_local_duration(Some(5000.0));

        // Segment 0: offset +5s; Segment 1 at room 1000s: extra 60s scene in local -> +65s;
        // Segment 2: room 2000..2090 extra scene in room (missing locally) -> hold at local 2065, resume at 2090 with offset -25s
        let segments = vec![
            TimelineSegment {
                room_start_secs: 0.0,
                offset_secs: 5.0,
                scale: 1.0,
                hold_room_until_secs: None,
            },
            TimelineSegment {
                room_start_secs: 1000.0,
                offset_secs: 65.0,
                scale: 1.0,
                hold_room_until_secs: None,
            },
            TimelineSegment {
                room_start_secs: 2000.0,
                offset_secs: 2065.0,
                scale: 1.0,
                hold_room_until_secs: Some(2090.0),
            },
            TimelineSegment {
                room_start_secs: 2090.0,
                offset_secs: -25.0,
                scale: 1.0,
                hold_room_until_secs: None,
            },
        ];

        let init_acts = sm.set_piecewise_timeline(segments, 1.0);
        assert!(
            matches!(init_acts.first(), Some(SyncAction::SetSpeed(s)) if (*s - 1.0).abs() < 1e-6)
        );

        // Playing at room=999.0 -> local=1004.0 cleanly
        let s0 = ServerState {
            playstate: Some(Playstate {
                position: 999.0,
                paused: false,
                do_seek: false,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let a0 = sm.handle_server_state(&s0, 2.0);
        assert!(a0.contains(&SyncAction::Seek(1004.0)));

        // Advance locally just past 1005.2 as room crosses 1000.2 -> automatically seeks over extra 60s scene to 1065.2
        sm.update_local_player(1005.2, false);
        let s1 = ServerState {
            playstate: Some(Playstate {
                position: 1000.2,
                paused: false,
                do_seek: false,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let a1 = sm.handle_server_state(&s1, 3.2);
        assert_eq!(a1, vec![SyncAction::Seek(1065.2)]);

        // Entering missing-scene hold window [2000..2090) pauses locally at 2065 without reporting paused=true
        let s2 = ServerState {
            playstate: Some(Playstate {
                position: 2010.0,
                paused: false,
                do_seek: false,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let a2 = sm.handle_server_state(&s2, 4.0);
        assert!(sm.waiting_cut_hold);
        assert_eq!(
            a2,
            vec![SyncAction::SetPaused(true), SyncAction::Seek(2065.0)]
        );
        let hb: Value = serde_json::from_str(sm.on_heartbeat_tick(4.1).trim()).unwrap();
        assert_eq!(hb["State"]["playstate"]["paused"], false);

        // Exiting missing-scene hold window at room=2090.5 resumes smoothly at 2065.5
        let s3 = ServerState {
            playstate: Some(Playstate {
                position: 2090.5,
                paused: false,
                do_seek: false,
                set_by: Some("Peer".into()),
            }),
            ..Default::default()
        };
        let a3 = sm.handle_server_state(&s3, 5.0);
        assert!(!sm.waiting_cut_hold);
        assert_eq!(
            a3,
            vec![
                SyncAction::SetPaused(false),
                SyncAction::SetSpeed(1.0),
                SyncAction::Seek(2065.5),
            ]
        );
    }

    #[test]
    fn test_inflight_server_tick_without_action_does_not_snap_back_user_seek() {
        let mut sm = SyncStateMachine::new();
        sm.set_local_username("Me".into());

        // Establish initial room state where Bob was last actor at t=300s
        let initial = ServerState {
            playstate: Some(Playstate {
                position: 300.0,
                paused: false,
                do_seek: false,
                set_by: Some("Bob".into()),
            }),
            ..Default::default()
        };
        let _ = sm.handle_server_state(&initial, 1.0);

        // User clicks a new minute on the timeline (900s) -> jumps mpv locally & increments ignoring_client
        sm.on_user_seek(900.0);
        assert_eq!(sm.ignoring_client, 1);

        // Pre-seek in-flight server state packet arrives with ignoringOnTheFly.server set and Bob still in setBy,
        // or setBy=None, while doSeek=false and paused unchanged -> must NOT trigger ServerOverride snap-back!
        for set_by in [Some("Bob".into()), None] {
            let inflight = ServerState {
                playstate: Some(Playstate {
                    position: 300.0,
                    paused: false,
                    do_seek: false,
                    set_by,
                }),
                ignoring_on_the_fly: Some(IgnoringOnTheFly {
                    server: Some(7),
                    client: None,
                }),
                ..Default::default()
            };
            let actions = sm.handle_server_state(&inflight, 1.1);
            assert!(
                actions.is_empty(),
                "stale server tick must not snap user click-seek back: {actions:?}"
            );
            assert_eq!(sm.ignoring_client, 1);
        }

        // Server finally acknowledges client's seek to 900s
        let ack = ServerState {
            playstate: Some(Playstate {
                position: 900.0,
                paused: false,
                do_seek: true,
                set_by: Some("Me".into()),
            }),
            ignoring_on_the_fly: Some(IgnoringOnTheFly {
                server: Some(8),
                client: Some(1),
            }),
            ..Default::default()
        };
        let ack_actions = sm.handle_server_state(&ack, 1.2);
        assert_eq!(sm.ignoring_client, 0);
        assert!(
            !ack_actions.iter().any(|a| matches!(a, SyncAction::Seek(_))),
            "acknowledged self-seek must stay at 900s: {ack_actions:?}"
        );
    }
}
