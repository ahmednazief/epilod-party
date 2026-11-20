use chacha20poly1305::{
    aead::{Aead, KeyInit, Payload},
    ChaCha20Poly1305, Nonce,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, VecDeque};
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use x25519_dalek::{PublicKey, StaticSecret};

pub const EP2_CHAT_PREFIX: &str = "~EP2:";
pub const EP_REACTION_CHAT_PREFIX: &str = "~EPR:";
pub const EP_CHAT_TEXT_PREFIX: &str = "~EPT:";
pub const EP_CHAT_REACT_PREFIX: &str = "~EPCR:";
pub const EP2_URI_PREFIX: &str = "epilod://p2p/";
pub const MAX_CHAT_BEACON_CHARS: usize = 144;
pub const MAX_CHAT_REACTION_CHARS: usize = 144;
pub const MAX_CHAT_FALLBACK_LINE_CHARS: usize = 144;
pub const MAX_CHAT_MESSAGE_CHARS: usize = 500;
pub const MAX_CHAT_ID_LEN: usize = 24;
pub const MAX_EPT_CHUNKS: usize = 24;
pub const MAX_P2P_DATAGRAM_BYTES: usize = 1024;
pub const MAX_VOICE_OPUS_BYTES: usize = 400;
pub const VOICE_FLAG_END_OF_TALK: u8 = 0b0000_0001;
pub const VOICE_FLAG_RELAYED: u8 = 0b0000_0010;
pub const MAX_REACTION_EMOJI_BYTES: usize = 48;
pub const MAX_REACTION_BURST_COUNT: u8 = 25;
pub const P2P_CHUNK_PAYLOAD_BYTES: usize = 920;
pub const MAX_RELIABLE_CHUNKS: u16 = 512;
pub const MAX_RELIABLE_MSG_BYTES: usize = 256 * 1024;
pub const STUN_SERVERS: [&str; 4] = [
    "stun.l.google.com:19302",
    "stun.cloudflare.com:3478",
    "stun1.l.google.com:19302",
    "stun.stunprotocol.org:3478",
];
pub const SSDP_MULTICAST_ADDR: &str = "239.255.255.250:1900";
pub const NATPMP_PCP_PORT: u16 = 5351;

const B64_URL_ALPHA: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn encode_base64_url(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_URL_ALPHA[((triple >> 18) & 0x3F) as usize] as char);
        out.push(B64_URL_ALPHA[((triple >> 12) & 0x3F) as usize] as char);
        if chunk.len() >= 2 {
            out.push(B64_URL_ALPHA[((triple >> 6) & 0x3F) as usize] as char);
        }
        if chunk.len() == 3 {
            out.push(B64_URL_ALPHA[(triple & 0x3F) as usize] as char);
        }
    }
    out
}

pub fn decode_base64_url(input: &str) -> Option<Vec<u8>> {
    let s = input.trim().trim_end_matches('=');
    if s.is_empty() || s.len() % 4 == 1 {
        return None;
    }
    let decode_char = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    };
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity((bytes.len() * 3) / 4);
    let mut i = 0;
    while i + 4 <= bytes.len() {
        let a = decode_char(bytes[i])?;
        let b = decode_char(bytes[i + 1])?;
        let c = decode_char(bytes[i + 2])?;
        let d = decode_char(bytes[i + 3])?;
        let triple = (a << 18) | (b << 12) | (c << 6) | d;
        out.push(((triple >> 16) & 0xFF) as u8);
        out.push(((triple >> 8) & 0xFF) as u8);
        out.push((triple & 0xFF) as u8);
        i += 4;
    }
    let rem = bytes.len() - i;
    if rem == 2 {
        let a = decode_char(bytes[i])?;
        let b = decode_char(bytes[i + 1])?;
        out.push((((a << 18) | (b << 12)) >> 16) as u8);
    } else if rem == 3 {
        let a = decode_char(bytes[i])?;
        let b = decode_char(bytes[i + 1])?;
        let c = decode_char(bytes[i + 2])?;
        let triple = (a << 18) | (b << 12) | (c << 6);
        out.push(((triple >> 16) & 0xFF) as u8);
        out.push(((triple >> 8) & 0xFF) as u8);
    }
    Some(out)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum P2pCandidateKind {
    Lan,
    Wan,
    Ipv6,
}

/// Preferred path rank: IPv6 direct > LAN direct > mapped/STUN WAN.
pub fn candidate_priority(kind: P2pCandidateKind) -> u8 {
    match kind {
        P2pCandidateKind::Ipv6 => 3,
        P2pCandidateKind::Lan => 2,
        P2pCandidateKind::Wan => 1,
    }
}

pub fn infer_candidate_kind(addr: SocketAddr) -> P2pCandidateKind {
    match addr {
        SocketAddr::V6(_) => P2pCandidateKind::Ipv6,
        SocketAddr::V4(v4) => {
            let ip = v4.ip();
            if ip.is_private() || ip.is_loopback() || ip.is_link_local() {
                P2pCandidateKind::Lan
            } else {
                P2pCandidateKind::Wan
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct P2pCandidate {
    pub kind: P2pCandidateKind,
    pub addr: SocketAddr,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct P2pBeacon {
    pub version: u8,
    pub nat_symmetric: bool,
    pub pubkey: [u8; 32],
    pub session_id: u32,
    pub candidates: Vec<P2pCandidate>,
}

fn push_candidate_bytes(out: &mut Vec<u8>, cand: P2pCandidate) {
    match cand.addr {
        SocketAddr::V4(v4) => {
            let tag = match cand.kind {
                P2pCandidateKind::Lan => 1u8,
                P2pCandidateKind::Wan | P2pCandidateKind::Ipv6 => 2u8,
            };
            out.push(tag);
            out.extend_from_slice(&v4.ip().octets());
            out.extend_from_slice(&v4.port().to_be_bytes());
        }
        SocketAddr::V6(v6) => {
            out.push(3u8);
            out.extend_from_slice(&v6.ip().octets());
            out.extend_from_slice(&v6.port().to_be_bytes());
        }
    }
}

pub fn encode_ep2_beacon(beacon: &P2pBeacon) -> String {
    let mut raw = Vec::with_capacity(96);
    raw.push(1u8);
    raw.push(u8::from(beacon.nat_symmetric));
    raw.extend_from_slice(&beacon.pubkey);
    raw.extend_from_slice(&beacon.session_id.to_be_bytes());

    // Keep within Syncplay's 150-char chat budget (`<= 144` chars) by prioritizing compact
    // candidates and dropping overflow IPv6 if many candidates exist.
    let count_idx = raw.len();
    raw.push(0u8);
    for (kept, &cand) in beacon.candidates.iter().take(4).enumerate() {
        let prev_len = raw.len();
        push_candidate_bytes(&mut raw, cand);
        raw[count_idx] = (kept + 1) as u8;
        let encoded_len = EP2_CHAT_PREFIX.len() + encode_base64_url(&raw).len();
        if encoded_len > MAX_CHAT_BEACON_CHARS {
            raw.truncate(prev_len);
            raw[count_idx] = kept as u8;
            break;
        }
    }

    format!("{EP2_CHAT_PREFIX}{}", encode_base64_url(&raw))
}

fn is_valid_beacon_v4(ip: Ipv4Addr, is_lan_tag: bool) -> bool {
    if ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_broadcast()
        || ip.is_multicast()
    {
        return false;
    }
    if is_lan_tag {
        ip.is_private()
    } else {
        !ip.is_private()
    }
}

fn is_valid_beacon_v6(ip: Ipv6Addr) -> bool {
    !ip.is_unspecified() && !ip.is_loopback() && !ip.is_multicast() && !ip.is_unicast_link_local()
}

pub fn decode_ep2_beacon(message: &str) -> Option<P2pBeacon> {
    let payload = message.trim().strip_prefix(EP2_CHAT_PREFIX)?;
    let bytes = decode_base64_url(payload)?;
    if bytes.len() < 39 {
        return None;
    }
    let version = bytes[0];
    if version != 1 {
        return None;
    }
    let nat_symmetric = (bytes[1] & 1) != 0;
    let mut pubkey = [0u8; 32];
    pubkey.copy_from_slice(&bytes[2..34]);
    let session_id = u32::from_be_bytes(bytes[34..38].try_into().ok()?);
    let cand_count = bytes[38] as usize;
    let mut pos = 39usize;
    let mut candidates = Vec::with_capacity(cand_count.min(4));
    for _ in 0..cand_count.min(6) {
        if pos >= bytes.len() {
            return None;
        }
        let tag = bytes[pos];
        pos += 1;
        match tag {
            1 | 2 => {
                if pos + 6 > bytes.len() {
                    return None;
                }
                let ip = Ipv4Addr::new(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
                let port = u16::from_be_bytes([bytes[pos + 4], bytes[pos + 5]]);
                pos += 6;
                if port > 0 && is_valid_beacon_v4(ip, tag == 1) {
                    candidates.push(P2pCandidate {
                        kind: if tag == 1 {
                            P2pCandidateKind::Lan
                        } else {
                            P2pCandidateKind::Wan
                        },
                        addr: SocketAddr::V4(SocketAddrV4::new(ip, port)),
                    });
                }
            }
            3 => {
                if pos + 18 > bytes.len() {
                    return None;
                }
                let octets: [u8; 16] = bytes[pos..pos + 16].try_into().ok()?;
                let ip = Ipv6Addr::from(octets);
                let port = u16::from_be_bytes([bytes[pos + 16], bytes[pos + 17]]);
                pos += 18;
                if port > 0 && is_valid_beacon_v6(ip) {
                    candidates.push(P2pCandidate {
                        kind: P2pCandidateKind::Ipv6,
                        addr: SocketAddr::V6(SocketAddrV6::new(ip, port, 0, 0)),
                    });
                }
            }
            _ => return None,
        }
    }

    Some(P2pBeacon {
        version,
        nat_symmetric,
        pubkey,
        session_id,
        candidates,
    })
}

pub fn encode_ep2_invite_uri(beacon: &P2pBeacon) -> String {
    let chat = encode_ep2_beacon(beacon);
    let b64 = chat.strip_prefix(EP2_CHAT_PREFIX).unwrap_or("");
    format!("{EP2_URI_PREFIX}{b64}")
}

pub fn decode_ep2_invite_uri(raw: &str) -> Option<P2pBeacon> {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix(EP2_URI_PREFIX) {
        return decode_ep2_beacon(&format!("{EP2_CHAT_PREFIX}{rest}"));
    }
    decode_ep2_beacon(trimmed)
}

pub fn sanitize_reaction_emoji(raw: &str) -> Option<String> {
    let clean: String = raw
        .trim()
        .chars()
        .filter(|&c| {
            !c.is_control()
                && !c.is_whitespace()
                && !matches!(
                    c,
                    '\u{00AD}'
                        | '\u{061C}'
                        | '\u{200B}'
                        | '\u{200C}'
                        | '\u{200E}'
                        | '\u{200F}'
                        | '\u{202A}'..='\u{202E}'
                        | '\u{2060}'
                        | '\u{2066}'..='\u{2069}'
                        | '\u{FEFF}'
                )
        })
        .collect();
    if clean.is_empty()
        || clean.len() > MAX_REACTION_EMOJI_BYTES
        || clean.is_ascii()
        || clean.starts_with('\u{200D}')
        || clean.ends_with('\u{200D}')
    {
        return None;
    }
    let has_invalid_ascii = clean.chars().any(|c| {
        c.is_ascii() && !(matches!(c, '0'..='9' | '*' | '#') && clean.contains('\u{20E3}'))
    });
    if has_invalid_ascii {
        return None;
    }
    Some(clean)
}

pub fn sanitize_avatar_id(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(24)
        .collect()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReactionFallbackPacket {
    pub avatar_id: String,
    pub emoji: String,
    pub count: u8,
    pub seq: u32,
}

pub fn encode_epr_reaction(packet: &ReactionFallbackPacket) -> Option<String> {
    let emoji = sanitize_reaction_emoji(&packet.emoji)?;
    let avatar_id = sanitize_avatar_id(&packet.avatar_id);
    let avatar_bytes = avatar_id.as_bytes();
    let emoji_bytes = emoji.as_bytes();
    if avatar_bytes.len() > 24 || emoji_bytes.len() > MAX_REACTION_EMOJI_BYTES {
        return None;
    }
    let count = packet.count.clamp(1, MAX_REACTION_BURST_COUNT);
    let mut raw = Vec::with_capacity(8 + avatar_bytes.len() + emoji_bytes.len());
    raw.push(1u8);
    raw.push(count);
    raw.extend_from_slice(&packet.seq.to_be_bytes());
    raw.push(avatar_bytes.len() as u8);
    raw.extend_from_slice(avatar_bytes);
    raw.push(emoji_bytes.len() as u8);
    raw.extend_from_slice(emoji_bytes);
    let encoded = format!("{EP_REACTION_CHAT_PREFIX}{}", encode_base64_url(&raw));
    if encoded.len() > MAX_CHAT_REACTION_CHARS {
        return None;
    }
    Some(encoded)
}

pub fn decode_epr_reaction(message: &str) -> Option<ReactionFallbackPacket> {
    let payload = message.trim().strip_prefix(EP_REACTION_CHAT_PREFIX)?;
    let bytes = decode_base64_url(payload)?;
    if bytes.len() < 9 || bytes[0] != 1 {
        return None;
    }
    let count = bytes[1].clamp(1, MAX_REACTION_BURST_COUNT);
    let seq = u32::from_be_bytes(bytes[2..6].try_into().ok()?);
    let avatar_len = bytes[6] as usize;
    let mut pos = 7usize;
    if avatar_len > 24 || pos + avatar_len + 1 > bytes.len() {
        return None;
    }
    let avatar_raw = std::str::from_utf8(&bytes[pos..pos + avatar_len]).ok()?;
    let avatar_id = sanitize_avatar_id(avatar_raw);
    pos += avatar_len;
    let emoji_len = bytes[pos] as usize;
    pos += 1;
    if emoji_len == 0 || emoji_len > MAX_REACTION_EMOJI_BYTES || pos + emoji_len != bytes.len() {
        return None;
    }
    let emoji_raw = std::str::from_utf8(&bytes[pos..]).ok()?;
    let emoji = sanitize_reaction_emoji(emoji_raw)?;
    Some(ReactionFallbackPacket {
        avatar_id,
        emoji,
        count,
        seq,
    })
}

pub fn sanitize_chat_id(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .take(MAX_CHAT_ID_LEN)
        .collect()
}

pub fn sanitize_chat_text(raw: &str) -> Option<String> {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::with_capacity(normalized.len().min(MAX_CHAT_MESSAGE_CHARS * 4));
    let mut consecutive_newlines = 0u8;
    let mut char_count = 0usize;

    for c in normalized.chars() {
        if c == '\n' {
            if consecutive_newlines < 2 {
                out.push('\n');
                consecutive_newlines += 1;
                char_count += 1;
            }
        } else if c.is_control()
            || matches!(
                c,
                '\u{00AD}'
                    | '\u{061C}'
                    | '\u{200B}'
                    | '\u{200E}'
                    | '\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{FEFF}'
            )
        {
            continue;
        } else {
            consecutive_newlines = 0;
            out.push(c);
            char_count += 1;
        }
        if char_count >= MAX_CHAT_MESSAGE_CHARS {
            break;
        }
    }

    let trimmed = out.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatFallbackPacket {
    pub msg_id: String,
    pub avatar_id: String,
    pub reply_to_id: Option<String>,
    pub text: String,
    pub is_edit: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatReactFallbackPacket {
    pub msg_id: String,
    pub emoji: String,
}

pub fn encode_epcr_chat_react(packet: &ChatReactFallbackPacket) -> Option<String> {
    let msg_id = sanitize_chat_id(&packet.msg_id);
    let emoji = sanitize_reaction_emoji(&packet.emoji)?;
    if msg_id.is_empty() {
        return None;
    }
    let short_id: String = msg_id.chars().take(12).collect();
    let encoded = format!(
        "{EP_CHAT_REACT_PREFIX}{short_id}:{}",
        encode_base64_url(emoji.as_bytes())
    );
    if encoded.len() > MAX_CHAT_FALLBACK_LINE_CHARS {
        None
    } else {
        Some(encoded)
    }
}

pub fn decode_epcr_chat_react(message: &str) -> Option<ChatReactFallbackPacket> {
    let body = message.trim().strip_prefix(EP_CHAT_REACT_PREFIX)?;
    let (raw_id, b64_emoji) = body.split_once(':')?;
    let msg_id = sanitize_chat_id(raw_id);
    if msg_id.is_empty() {
        return None;
    }
    let bytes = decode_base64_url(b64_emoji)?;
    let raw_emoji = std::str::from_utf8(&bytes).ok()?;
    let emoji = sanitize_reaction_emoji(raw_emoji)?;
    Some(ChatReactFallbackPacket { msg_id, emoji })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EptChatChunk {
    pub msg_id: String,
    pub idx: usize,
    pub total: usize,
    pub payload_part: String,
}

fn encode_ept_binary_payload(packet: &ChatFallbackPacket) -> Option<Vec<u8>> {
    let text = sanitize_chat_text(&packet.text)?;
    let avatar_id = sanitize_avatar_id(&packet.avatar_id);
    let reply_id = packet
        .reply_to_id
        .as_deref()
        .map(sanitize_chat_id)
        .filter(|s| !s.is_empty());

    let avatar_bytes = avatar_id.as_bytes();
    let reply_bytes = reply_id.as_deref().unwrap_or("").as_bytes();
    let text_bytes = text.as_bytes();
    if avatar_bytes.len() > 24 || reply_bytes.len() > MAX_CHAT_ID_LEN || text_bytes.len() > 2400 {
        return None;
    }

    let mut raw = Vec::with_capacity(5 + avatar_bytes.len() + reply_bytes.len() + text_bytes.len());
    raw.push(if packet.is_edit { 2u8 } else { 1u8 });
    raw.push(avatar_bytes.len() as u8);
    raw.extend_from_slice(avatar_bytes);
    raw.push(reply_bytes.len() as u8);
    raw.extend_from_slice(reply_bytes);
    raw.extend_from_slice(&(text_bytes.len() as u16).to_be_bytes());
    raw.extend_from_slice(text_bytes);
    Some(raw)
}

fn decode_ept_binary_payload(msg_id: String, bytes: &[u8]) -> Option<ChatFallbackPacket> {
    if bytes.len() < 5 || (bytes[0] != 1 && bytes[0] != 2) {
        return None;
    }
    let is_edit = bytes[0] == 2;
    let mut pos = 1usize;
    let avatar_len = bytes[pos] as usize;
    pos += 1;
    if avatar_len > 24 || pos + avatar_len + 1 > bytes.len() {
        return None;
    }
    let avatar_raw = std::str::from_utf8(&bytes[pos..pos + avatar_len]).ok()?;
    let avatar_id = sanitize_avatar_id(avatar_raw);
    pos += avatar_len;

    let reply_len = bytes[pos] as usize;
    pos += 1;
    if reply_len > MAX_CHAT_ID_LEN || pos + reply_len + 2 > bytes.len() {
        return None;
    }
    let reply_to_id = if reply_len > 0 {
        let raw_reply = std::str::from_utf8(&bytes[pos..pos + reply_len]).ok()?;
        let clean_reply = sanitize_chat_id(raw_reply);
        if clean_reply.is_empty() {
            None
        } else {
            Some(clean_reply)
        }
    } else {
        None
    };
    pos += reply_len;

    let text_len = u16::from_be_bytes(bytes[pos..pos + 2].try_into().ok()?) as usize;
    pos += 2;
    if text_len == 0 || text_len > 2400 || pos + text_len != bytes.len() {
        return None;
    }
    let text_raw = std::str::from_utf8(&bytes[pos..]).ok()?;
    let text = sanitize_chat_text(text_raw)?;

    Some(ChatFallbackPacket {
        msg_id,
        avatar_id,
        reply_to_id,
        text,
        is_edit,
    })
}

pub fn encode_ept_chat_chunks(packet: &ChatFallbackPacket) -> Option<Vec<String>> {
    let msg_id = sanitize_chat_id(&packet.msg_id);
    if msg_id.is_empty() {
        return None;
    }
    let short_id: String = msg_id.chars().take(12).collect();
    let raw = encode_ept_binary_payload(packet)?;
    let b64 = encode_base64_url(&raw);
    // Header `~EPT:<id>/<idx>/<total>:` is <= 5 + 12 + 1 + 2 + 1 + 2 + 1 = 24 bytes, leaving >= 120 chars.
    let max_part = MAX_CHAT_FALLBACK_LINE_CHARS.saturating_sub(24).max(64);
    let total = b64.len().div_ceil(max_part).max(1);
    if total > MAX_EPT_CHUNKS {
        return None;
    }
    let mut lines = Vec::with_capacity(total);
    for (idx, chunk) in b64.as_bytes().chunks(max_part).enumerate() {
        let part = std::str::from_utf8(chunk).ok()?;
        let line = format!("{EP_CHAT_TEXT_PREFIX}{short_id}/{}/{total}:{part}", idx + 1);
        if line.len() > MAX_CHAT_FALLBACK_LINE_CHARS {
            return None;
        }
        lines.push(line);
    }
    Some(lines)
}

pub fn decode_ept_chat_chunk(message: &str) -> Option<EptChatChunk> {
    let body = message.trim().strip_prefix(EP_CHAT_TEXT_PREFIX)?;
    let (header, payload_part) = body.split_once(':')?;
    let mut header_parts = header.split('/');
    let raw_id = header_parts.next()?;
    let idx_str = header_parts.next()?;
    let total_str = header_parts.next()?;
    if header_parts.next().is_some() {
        return None;
    }
    let msg_id = sanitize_chat_id(raw_id);
    if msg_id.is_empty() {
        return None;
    }
    let idx: usize = idx_str.parse().ok()?;
    let total: usize = total_str.parse().ok()?;
    if idx == 0 || total == 0 || idx > total || total > MAX_EPT_CHUNKS {
        return None;
    }
    if payload_part.is_empty()
        || !payload_part
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return None;
    }
    Some(EptChatChunk {
        msg_id,
        idx,
        total,
        payload_part: payload_part.to_string(),
    })
}

#[derive(Debug, Clone)]
struct EptChunkAssembly {
    total: usize,
    parts: Vec<Option<String>>,
    order_seq: u64,
}

#[derive(Debug, Default)]
pub struct EptChatReassembler {
    entries: std::collections::HashMap<(String, String), EptChunkAssembly>,
    order_counter: u64,
}

impl EptChatReassembler {
    pub fn push_chunk(&mut self, sender: &str, chunk: EptChatChunk) -> Option<ChatFallbackPacket> {
        let sender_key = sender.trim().to_ascii_lowercase();
        if sender_key.is_empty() {
            return None;
        }
        if chunk.total == 1 && chunk.idx == 1 {
            let bytes = decode_base64_url(&chunk.payload_part)?;
            return decode_ept_binary_payload(chunk.msg_id, &bytes);
        }

        let key = (sender_key, chunk.msg_id.clone());
        self.order_counter = self.order_counter.wrapping_add(1);
        let order_seq = self.order_counter;

        if !self.entries.contains_key(&key) && self.entries.len() >= 32 {
            if let Some(oldest_key) = self
                .entries
                .iter()
                .min_by_key(|(_, v)| v.order_seq)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&oldest_key);
            }
        }

        let entry = self
            .entries
            .entry(key.clone())
            .or_insert_with(|| EptChunkAssembly {
                total: chunk.total,
                parts: vec![None; chunk.total],
                order_seq,
            });
        if entry.total != chunk.total || entry.parts.len() != chunk.total {
            *entry = EptChunkAssembly {
                total: chunk.total,
                parts: vec![None; chunk.total],
                order_seq,
            };
        } else {
            entry.order_seq = order_seq;
        }
        entry.parts[chunk.idx - 1] = Some(chunk.payload_part);

        if entry.parts.iter().all(Option::is_some) {
            let full_b64: String = entry.parts.iter().filter_map(|p| p.as_deref()).collect();
            self.entries.remove(&key);
            let bytes = decode_base64_url(&full_b64)?;
            decode_ept_binary_payload(chunk.msg_id, &bytes)
        } else {
            None
        }
    }
}

/// Builds an RFC 5389 STUN Binding Request (20 bytes).
pub fn build_stun_binding_request(tx_id: [u8; 12]) -> [u8; 20] {
    let mut req = [0u8; 20];
    // Binding Request (0x0001), message length = 0 (0x0000), Magic Cookie = 0x2112A442
    req[0] = 0x00;
    req[1] = 0x01;
    req[4..8].copy_from_slice(&0x2112_A442u32.to_be_bytes());
    req[8..20].copy_from_slice(&tx_id);
    req
}

/// Parses an RFC 5389 STUN Binding Success Response, validating transaction ID and magic cookie.
pub fn parse_stun_binding_response(packet: &[u8], expected_tx: [u8; 12]) -> Option<SocketAddr> {
    if packet.len() < 20 {
        return None;
    }
    let msg_type = u16::from_be_bytes([packet[0], packet[1]]);
    if msg_type != 0x0101 {
        return None;
    }
    if packet[4..8] != 0x2112_A442u32.to_be_bytes() || packet[8..20] != expected_tx {
        return None;
    }
    let msg_len = u16::from_be_bytes([packet[2], packet[3]]) as usize;
    let attr_end = (20 + msg_len).min(packet.len());
    let mut pos = 20usize;
    let mut fallback_mapped: Option<SocketAddr> = None;

    while pos + 4 <= attr_end {
        let attr_type = u16::from_be_bytes([packet[pos], packet[pos + 1]]);
        let attr_len = u16::from_be_bytes([packet[pos + 2], packet[pos + 3]]) as usize;
        pos += 4;
        if pos + attr_len > attr_end {
            break;
        }
        let val = &packet[pos..pos + attr_len];
        match attr_type {
            0x0020 => {
                // XOR-MAPPED-ADDRESS
                if let Some(addr) = parse_stun_addr_attr(val, true, &expected_tx) {
                    return Some(addr);
                }
            }
            0x0001 if fallback_mapped.is_none() => {
                fallback_mapped = parse_stun_addr_attr(val, false, &expected_tx);
            }
            _ => {}
        }
        let padded = (attr_len + 3) & !3;
        pos = pos.saturating_add(padded);
    }

    fallback_mapped
}

fn parse_stun_addr_attr(val: &[u8], xored: bool, tx_id: &[u8; 12]) -> Option<SocketAddr> {
    if val.len() < 4 {
        return None;
    }
    let family = val[1];
    let raw_port = u16::from_be_bytes([val[2], val[3]]);
    let port = if xored { raw_port ^ 0x2112 } else { raw_port };
    if port == 0 {
        return None;
    }
    match family {
        0x01 if val.len() >= 8 => {
            let mut ip = [val[4], val[5], val[6], val[7]];
            if xored {
                let cookie = 0x2112_A442u32.to_be_bytes();
                for i in 0..4 {
                    ip[i] ^= cookie[i];
                }
            }
            Some(SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::from(ip), port)))
        }
        0x02 if val.len() >= 20 => {
            let mut ip = [0u8; 16];
            ip.copy_from_slice(&val[4..20]);
            if xored {
                let cookie = 0x2112_A442u32.to_be_bytes();
                for i in 0..4 {
                    ip[i] ^= cookie[i];
                }
                for i in 0..12 {
                    ip[4 + i] ^= tx_id[i];
                }
            }
            Some(SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::from(ip),
                port,
                0,
                0,
            )))
        }
        _ => None,
    }
}

pub fn build_ssdp_msearch(search_target: &str) -> Vec<u8> {
    format!(
        "M-SEARCH * HTTP/1.1\r\n\
HOST: 239.255.255.250:1900\r\n\
MAN: \"ssdp:discover\"\r\n\
MX: 1\r\n\
ST: {search_target}\r\n\r\n"
    )
    .into_bytes()
}

/// Returns true only for RFC1918 private LAN IPv4 addresses (rejecting loopback, link-local,
/// multicast, broadcast, unspecified, and public WAN addresses).
pub fn is_allowed_upnp_lan_ip(ip: Ipv4Addr) -> bool {
    ip.is_private()
        && !ip.is_loopback()
        && !ip.is_link_local()
        && !ip.is_unspecified()
        && !ip.is_broadcast()
        && !ip.is_multicast()
}

fn has_unsafe_http_chars(s: &str) -> bool {
    s.bytes()
        .any(|b| b <= 0x20 || b >= 0x7F || matches!(b, b'@' | b'#' | b'\\'))
}

pub fn parse_ssdp_location(response: &str) -> Option<String> {
    for line in response.lines() {
        let trimmed = line.trim();
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("location") {
                let url = v.trim();
                if url.starts_with("http://") && !has_unsafe_http_chars(url) {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

pub fn parse_http_url_host_port_path(url: &str) -> Option<(String, u16, String)> {
    let trimmed = url.trim();
    if trimmed.len() > 1024 || has_unsafe_http_chars(trimmed) {
        return None;
    }
    let rest = trimmed.strip_prefix("http://")?;
    let (authority, path_raw) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    if authority.is_empty() || !path_raw.starts_with('/') {
        return None;
    }
    let (host, port) = if let Some((h, p)) = authority.rsplit_once(':') {
        let port = p.parse::<u16>().ok()?;
        if port == 0 {
            return None;
        }
        (h.to_string(), port)
    } else {
        (authority.to_string(), 80u16)
    };
    if host.is_empty() || has_unsafe_http_chars(&host) || has_unsafe_http_chars(path_raw) {
        return None;
    }
    Some((host, port, path_raw.to_string()))
}

fn extract_xml_tag_value<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

/// Extracts `(control_url, service_type)` for WANIPConnection or WANPPPConnection from an IGD XML doc.
pub fn parse_igd_control_url(base_location_url: &str, xml: &str) -> Option<(String, String)> {
    let targets = [
        "urn:schemas-upnp-org:service:WANIPConnection:2",
        "urn:schemas-upnp-org:service:WANIPConnection:1",
        "urn:schemas-upnp-org:service:WANPPPConnection:1",
    ];
    for service_type in targets {
        let mut cursor = xml;
        while let Some(svc_pos) = cursor.find("<service>") {
            let after_open = &cursor[svc_pos..];
            let Some(end_pos) = after_open.find("</service>") else {
                break;
            };
            let block = &after_open[..end_pos];
            if extract_xml_tag_value(block, "serviceType") == Some(service_type) {
                if let Some(ctrl) = extract_xml_tag_value(block, "controlURL") {
                    let resolved = resolve_upnp_url(base_location_url, ctrl)?;
                    return Some((resolved, service_type.to_string()));
                }
            }
            cursor = &after_open[end_pos + "</service>".len()..];
        }
    }
    None
}

fn resolve_upnp_url(base_url: &str, rel_or_abs: &str) -> Option<String> {
    let (base_host, base_port, _) = parse_http_url_host_port_path(base_url)?;
    let trimmed = rel_or_abs.trim();
    if trimmed.is_empty() || trimmed.len() > 512 || has_unsafe_http_chars(trimmed) {
        return None;
    }
    if trimmed.starts_with("http://") {
        let (abs_host, abs_port, abs_path) = parse_http_url_host_port_path(trimmed)?;
        // Pin controlURL strictly to the same host and port as the IGD LOCATION URL
        // to prevent LAN SSDP SSRF against localhost or other internal services.
        if !abs_host.eq_ignore_ascii_case(&base_host) || abs_port != base_port {
            return None;
        }
        return Some(format!("http://{abs_host}:{abs_port}{abs_path}"));
    }
    if trimmed.contains("://") {
        return None;
    }
    let path = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    Some(format!("http://{base_host}:{base_port}{path}"))
}

pub fn build_upnp_add_port_mapping_soap(
    service_type: &str,
    external_port: u16,
    internal_ip: Ipv4Addr,
    internal_port: u16,
    lease_secs: u32,
) -> String {
    format!(
        "<?xml version=\"1.0\"?>\
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
<s:Body>\
<u:AddPortMapping xmlns:u=\"{service_type}\">\
<NewRemoteHost></NewRemoteHost>\
<NewExternalPort>{external_port}</NewExternalPort>\
<NewProtocol>UDP</NewProtocol>\
<NewInternalPort>{internal_port}</NewInternalPort>\
<NewInternalClient>{internal_ip}</NewInternalClient>\
<NewEnabled>1</NewEnabled>\
<NewPortMappingDescription>Epilod Party P2P</NewPortMappingDescription>\
<NewLeaseDuration>{lease_secs}</NewLeaseDuration>\
</u:AddPortMapping>\
</s:Body>\
</s:Envelope>"
    )
}

pub fn build_upnp_delete_port_mapping_soap(service_type: &str, external_port: u16) -> String {
    format!(
        "<?xml version=\"1.0\"?>\
<s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\">\
<s:Body>\
<u:DeletePortMapping xmlns:u=\"{service_type}\">\
<NewRemoteHost></NewRemoteHost>\
<NewExternalPort>{external_port}</NewExternalPort>\
<NewProtocol>UDP</NewProtocol>\
</u:DeletePortMapping>\
</s:Body>\
</s:Envelope>"
    )
}

/// Builds a RFC 6886 NAT-PMP UDP mapping request (12 bytes).
pub fn build_natpmp_map_request(
    internal_port: u16,
    suggested_external_port: u16,
    lifetime_secs: u32,
) -> [u8; 12] {
    let mut pkt = [0u8; 12];
    pkt[0] = 0; // Version 0
    pkt[1] = 1; // Opcode 1 = Map UDP
    pkt[4..6].copy_from_slice(&internal_port.to_be_bytes());
    pkt[6..8].copy_from_slice(&suggested_external_port.to_be_bytes());
    pkt[8..12].copy_from_slice(&lifetime_secs.to_be_bytes());
    pkt
}

/// Parses a RFC 6886 NAT-PMP UDP mapping response -> `(internal_port, external_port, lifetime_secs)`.
pub fn parse_natpmp_map_response(buf: &[u8]) -> Option<(u16, u16, u32)> {
    if buf.len() < 16 || buf[0] != 0 || buf[1] != 129 {
        return None;
    }
    let result_code = u16::from_be_bytes([buf[2], buf[3]]);
    if result_code != 0 {
        return None;
    }
    let internal = u16::from_be_bytes([buf[8], buf[9]]);
    let external = u16::from_be_bytes([buf[10], buf[11]]);
    let lifetime = u32::from_be_bytes([buf[12], buf[13], buf[14], buf[15]]);
    (external > 0).then_some((internal, external, lifetime))
}

/// Builds a RFC 6887 PCP MAP UDP request (60 bytes: 24-byte header + 36-byte MAP payload).
pub fn build_pcp_map_request(
    client_ip: Ipv4Addr,
    internal_port: u16,
    suggested_external_port: u16,
    lifetime_secs: u32,
    nonce: [u8; 12],
) -> [u8; 60] {
    let mut pkt = [0u8; 60];
    pkt[0] = 2; // PCP version 2
    pkt[1] = 1; // MAP opcode (request R=0)
    pkt[4..8].copy_from_slice(&lifetime_secs.to_be_bytes());
    // IPv4-mapped IPv6 address (::ffff:a.b.c.d) in bytes 8..24
    pkt[18] = 0xFF;
    pkt[19] = 0xFF;
    pkt[20..24].copy_from_slice(&client_ip.octets());
    // MAP opcode payload (bytes 24..60)
    pkt[24..36].copy_from_slice(&nonce);
    pkt[36] = 17; // Protocol UDP
    pkt[40..42].copy_from_slice(&internal_port.to_be_bytes());
    pkt[42..44].copy_from_slice(&suggested_external_port.to_be_bytes());
    // Suggested external IPv6 ::ffff:0.0.0.0
    pkt[54] = 0xFF;
    pkt[55] = 0xFF;
    pkt
}

/// Parses a RFC 6887 PCP MAP UDP response -> `(external_addr_v4, external_port, lifetime_secs)`.
pub fn parse_pcp_map_response(
    buf: &[u8],
    expected_nonce: [u8; 12],
) -> Option<(Option<Ipv4Addr>, u16, u32)> {
    if buf.len() < 60 || buf[0] != 2 || buf[1] != 0x81 {
        return None;
    }
    let result_code = buf[3];
    if result_code != 0 || buf[24..36] != expected_nonce {
        return None;
    }
    let lifetime = u32::from_be_bytes([buf[4], buf[5], buf[6], buf[7]]);
    let ext_port = u16::from_be_bytes([buf[42], buf[43]]);
    if ext_port == 0 {
        return None;
    }
    let v4 = if buf[44..54].iter().all(|&b| b == 0) && buf[54] == 0xFF && buf[55] == 0xFF {
        let ip = Ipv4Addr::new(buf[56], buf[57], buf[58], buf[59]);
        (!ip.is_unspecified()).then_some(ip)
    } else {
        None
    };
    Some((v4, ext_port, lifetime))
}

/// Generates deterministic predictable-offset + birthday probe ports around a NAT-mapped port.
pub fn compute_birthday_probe_ports(base_port: u16, count: usize, seed: u32) -> Vec<u16> {
    if base_port < 1024 || count == 0 {
        return Vec::new();
    }
    let mut ports = Vec::with_capacity(count);
    // Include adjacent sequential NAT allocations first (+/-1, +/-2) then deterministic birthday offsets
    for delta in [1i32, -1, 2, -2, 3, 4] {
        if ports.len() >= count {
            break;
        }
        let cand = (base_port as i32) + delta;
        if (1024..=65535).contains(&cand) {
            let p = cand as u16;
            if p != base_port && !ports.contains(&p) {
                ports.push(p);
            }
        }
    }
    let mut state = seed ^ ((base_port as u32) << 16) ^ 0x9E37_79B9;
    let mut attempts = 0;
    while ports.len() < count && attempts < 32 {
        attempts += 1;
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let offset = ((state >> 16) % 64) as u16 + 5;
        let p = base_port.wrapping_add(offset).max(1024);
        if p != base_port && !ports.contains(&p) {
            ports.push(p);
        }
    }
    ports
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum P2pWireFrame {
    PunchPing {
        ts_ms: u64,
    },
    PunchPong {
        echo_ts_ms: u64,
    },
    KeepAlive {
        ts_ms: u64,
    },
    Chunk {
        msg_id: u32,
        idx: u16,
        total: u16,
        data: Vec<u8>,
    },
    Ack {
        msg_id: u32,
        base_idx: u16,
        mask: u64,
    },
    Datagram {
        data: Vec<u8>,
    },
    Voice {
        voice_id: u8,
        epoch: u8,
        seq: u16,
        ts_48k: u32,
        flags: u8,
        opus: Vec<u8>,
    },
}

impl P2pWireFrame {
    pub fn encode_binary(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(32);
        match self {
            Self::PunchPing { ts_ms } => {
                out.push(1);
                out.extend_from_slice(&ts_ms.to_be_bytes());
            }
            Self::PunchPong { echo_ts_ms } => {
                out.push(2);
                out.extend_from_slice(&echo_ts_ms.to_be_bytes());
            }
            Self::KeepAlive { ts_ms } => {
                out.push(3);
                out.extend_from_slice(&ts_ms.to_be_bytes());
            }
            Self::Chunk {
                msg_id,
                idx,
                total,
                data,
            } => {
                out.push(4);
                out.extend_from_slice(&msg_id.to_be_bytes());
                out.extend_from_slice(&idx.to_be_bytes());
                out.extend_from_slice(&total.to_be_bytes());
                out.extend_from_slice(&(data.len().min(u16::MAX as usize) as u16).to_be_bytes());
                out.extend_from_slice(&data[..data.len().min(u16::MAX as usize)]);
            }
            Self::Ack {
                msg_id,
                base_idx,
                mask,
            } => {
                out.push(5);
                out.extend_from_slice(&msg_id.to_be_bytes());
                out.extend_from_slice(&base_idx.to_be_bytes());
                out.extend_from_slice(&mask.to_be_bytes());
            }
            Self::Datagram { data } => {
                let len = data.len().min(MAX_P2P_DATAGRAM_BYTES);
                out.push(6);
                out.extend_from_slice(&(len as u16).to_be_bytes());
                out.extend_from_slice(&data[..len]);
            }
            Self::Voice {
                voice_id,
                epoch,
                seq,
                ts_48k,
                flags,
                opus,
            } => {
                let len = opus.len().min(MAX_VOICE_OPUS_BYTES);
                out.push(7);
                out.push(*voice_id);
                out.push(*epoch);
                out.extend_from_slice(&seq.to_be_bytes());
                out.extend_from_slice(&ts_48k.to_be_bytes());
                out.push(*flags);
                out.extend_from_slice(&(len as u16).to_be_bytes());
                out.extend_from_slice(&opus[..len]);
            }
        }
        out
    }

    pub fn decode_binary(bytes: &[u8]) -> Option<Self> {
        let (&kind, rest) = bytes.split_first()?;
        match kind {
            1 if rest.len() == 8 => Some(Self::PunchPing {
                ts_ms: u64::from_be_bytes(rest.try_into().ok()?),
            }),
            2 if rest.len() == 8 => Some(Self::PunchPong {
                echo_ts_ms: u64::from_be_bytes(rest.try_into().ok()?),
            }),
            3 if rest.len() == 8 => Some(Self::KeepAlive {
                ts_ms: u64::from_be_bytes(rest.try_into().ok()?),
            }),
            4 if rest.len() >= 10 => {
                let msg_id = u32::from_be_bytes(rest[0..4].try_into().ok()?);
                let idx = u16::from_be_bytes(rest[4..6].try_into().ok()?);
                let total = u16::from_be_bytes(rest[6..8].try_into().ok()?);
                let len = u16::from_be_bytes(rest[8..10].try_into().ok()?) as usize;
                if total == 0
                    || total > MAX_RELIABLE_CHUNKS
                    || idx >= total
                    || len > P2P_CHUNK_PAYLOAD_BYTES + 64
                    || rest.len() != 10 + len
                {
                    return None;
                }
                Some(Self::Chunk {
                    msg_id,
                    idx,
                    total,
                    data: rest[10..].to_vec(),
                })
            }
            5 if rest.len() == 14 => Some(Self::Ack {
                msg_id: u32::from_be_bytes(rest[0..4].try_into().ok()?),
                base_idx: u16::from_be_bytes(rest[4..6].try_into().ok()?),
                mask: u64::from_be_bytes(rest[6..14].try_into().ok()?),
            }),
            6 if rest.len() >= 3 => {
                let len = u16::from_be_bytes([rest[0], rest[1]]) as usize;
                if len == 0 || len > MAX_P2P_DATAGRAM_BYTES || rest.len() != 2 + len {
                    return None;
                }
                Some(Self::Datagram {
                    data: rest[2..].to_vec(),
                })
            }
            7 if rest.len() >= 11 => {
                let voice_id = rest[0];
                let epoch = rest[1];
                let seq = u16::from_be_bytes([rest[2], rest[3]]);
                let ts_48k = u32::from_be_bytes(rest[4..8].try_into().ok()?);
                let flags = rest[8];
                let len = u16::from_be_bytes([rest[9], rest[10]]) as usize;
                let end_of_talk = (flags & VOICE_FLAG_END_OF_TALK) != 0;
                if len > MAX_VOICE_OPUS_BYTES
                    || (len == 0 && !end_of_talk)
                    || rest.len() != 11 + len
                {
                    return None;
                }
                Some(Self::Voice {
                    voice_id,
                    epoch,
                    seq,
                    ts_48k,
                    flags,
                    opus: rest[11..].to_vec(),
                })
            }
            _ => None,
        }
    }
}

pub struct VoiceTxCrypto {
    send_cipher: ChaCha20Poly1305,
    pub tx_tag: [u8; 4],
    tx_seq: u64,
}

pub struct VoiceRxCrypto {
    recv_cipher: ChaCha20Poly1305,
    pub rx_tag: [u8; 4],
    rx_highest_seq: u64,
    rx_window_mask: u64,
    rx_seen_any: bool,
}

impl VoiceTxCrypto {
    pub fn seal(&mut self, frame: &P2pWireFrame) -> Option<Vec<u8>> {
        seal_frame_with_cipher(&mut self.send_cipher, &self.tx_tag, &mut self.tx_seq, frame)
    }
}

impl VoiceRxCrypto {
    pub fn open(&mut self, packet: &[u8]) -> Option<P2pWireFrame> {
        open_frame_with_cipher(
            &self.recv_cipher,
            &self.rx_tag,
            &mut self.rx_highest_seq,
            &mut self.rx_window_mask,
            &mut self.rx_seen_any,
            packet,
        )
    }
}

pub struct P2pCryptoSession {
    send_cipher: ChaCha20Poly1305,
    recv_cipher: ChaCha20Poly1305,
    pub tx_tag: [u8; 4],
    pub rx_tag: [u8; 4],
    tx_seq: u64,
    rx_highest_seq: u64,
    rx_window_mask: u64,
    rx_seen_any: bool,
}

pub struct P2pIdentity {
    secret: StaticSecret,
    pub pubkey: [u8; 32],
    pub session_id: u32,
}

/// Derives a 32-byte room-specific P2P pre-shared key from the room name and plaintext password
/// using a domain separator distinct from both Cloudflare (`epilod-pw-v1:`) and Syncplay (`md5`),
/// so the sync server cannot derive the P2P PSK or MITM P2P chat/voice sessions.
pub fn derive_p2p_room_psk(wire_room: &str, password: &str) -> [u8; 32] {
    let mut h = Sha256::new();
    h.update(b"epilod-p2p-psk-v1:");
    h.update(wire_room.trim().as_bytes());
    h.update(b":");
    h.update(password.trim().as_bytes());
    h.finalize().into()
}

impl P2pIdentity {
    pub fn generate() -> Self {
        let mut raw = [0u8; 32];
        let _ = getrandom::getrandom(&mut raw);
        let secret = StaticSecret::from(raw);
        let pubkey = PublicKey::from(&secret).to_bytes();
        let mut sid = [0u8; 4];
        let _ = getrandom::getrandom(&mut sid);
        let session_id = u32::from_be_bytes(sid).max(1);
        Self {
            secret,
            pubkey,
            session_id,
        }
    }

    pub fn establish_with(&self, peer_pubkey: [u8; 32], peer_session_id: u32) -> P2pCryptoSession {
        self.establish_with_psk(peer_pubkey, peer_session_id, None)
    }

    pub fn establish_with_psk(
        &self,
        peer_pubkey: [u8; 32],
        peer_session_id: u32,
        room_psk: Option<[u8; 32]>,
    ) -> P2pCryptoSession {
        P2pCryptoSession::establish_with_psk(
            &self.secret,
            self.pubkey,
            self.session_id,
            peer_pubkey,
            peer_session_id,
            room_psk,
        )
    }

    pub fn establish_voice_with(
        &self,
        peer_pubkey: [u8; 32],
        peer_session_id: u32,
    ) -> (VoiceTxCrypto, VoiceRxCrypto) {
        self.establish_voice_with_psk(peer_pubkey, peer_session_id, None)
    }

    pub fn establish_voice_with_psk(
        &self,
        peer_pubkey: [u8; 32],
        peer_session_id: u32,
        room_psk: Option<[u8; 32]>,
    ) -> (VoiceTxCrypto, VoiceRxCrypto) {
        let (key_domain, tag_domain): (&[u8], &[u8]) = if room_psk.is_some() {
            (b"epilod-voice-v1-psk:", b"epilod-voice-tag-v1-psk:")
        } else {
            (b"epilod-voice-v1:", b"epilod-voice-tag-v1:")
        };
        let (send_cipher, recv_cipher, tx_tag, rx_tag) = derive_directional_ciphers(
            key_domain,
            tag_domain,
            &self.secret,
            self.pubkey,
            self.session_id,
            peer_pubkey,
            peer_session_id,
            room_psk.as_ref(),
        );
        (
            VoiceTxCrypto {
                send_cipher,
                tx_tag,
                tx_seq: 1,
            },
            VoiceRxCrypto {
                recv_cipher,
                rx_tag,
                rx_highest_seq: 0,
                rx_window_mask: 0,
                rx_seen_any: false,
            },
        )
    }
}

pub fn fill_random_bytes(dst: &mut [u8]) {
    let _ = getrandom::getrandom(dst);
}

#[allow(clippy::too_many_arguments)]
fn derive_directional_ciphers(
    key_domain: &[u8],
    tag_domain: &[u8],
    local_secret: &StaticSecret,
    local_pubkey: [u8; 32],
    local_session_id: u32,
    peer_pubkey: [u8; 32],
    peer_session_id: u32,
    room_psk: Option<&[u8; 32]>,
) -> (ChaCha20Poly1305, ChaCha20Poly1305, [u8; 4], [u8; 4]) {
    let shared = local_secret.diffie_hellman(&PublicKey::from(peer_pubkey));
    let local_id = (local_pubkey, local_session_id);
    let peer_id = (peer_pubkey, peer_session_id);
    let is_initiator = local_id < peer_id;

    let (min_pub, min_sid, max_pub, max_sid) = if is_initiator {
        (local_pubkey, local_session_id, peer_pubkey, peer_session_id)
    } else {
        (peer_pubkey, peer_session_id, local_pubkey, local_session_id)
    };

    let derive_key = |label: &[u8]| -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(key_domain);
        h.update(label);
        h.update(shared.as_bytes());
        if let Some(psk) = room_psk {
            h.update(psk);
        }
        h.update(min_pub);
        h.update(min_sid.to_be_bytes());
        h.update(max_pub);
        h.update(max_sid.to_be_bytes());
        h.finalize().into()
    };

    let derive_tag = |sender_pub: &[u8; 32], sender_sid: u32| -> [u8; 4] {
        let mut h = Sha256::new();
        h.update(tag_domain);
        h.update(shared.as_bytes());
        if let Some(psk) = room_psk {
            h.update(psk);
        }
        h.update(sender_pub);
        h.update(sender_sid.to_be_bytes());
        let d: [u8; 32] = h.finalize().into();
        [d[0], d[1], d[2], d[3]]
    };

    let (send_key, recv_key) = if is_initiator {
        (derive_key(b"init->resp"), derive_key(b"resp->init"))
    } else {
        (derive_key(b"resp->init"), derive_key(b"init->resp"))
    };

    (
        ChaCha20Poly1305::new((&send_key).into()),
        ChaCha20Poly1305::new((&recv_key).into()),
        derive_tag(&local_pubkey, local_session_id),
        derive_tag(&peer_pubkey, peer_session_id),
    )
}

fn seal_frame_with_cipher(
    send_cipher: &mut ChaCha20Poly1305,
    tx_tag: &[u8; 4],
    tx_seq: &mut u64,
    frame: &P2pWireFrame,
) -> Option<Vec<u8>> {
    let seq = *tx_seq;
    *tx_seq = tx_seq.checked_add(1)?;
    let mut header = [0u8; 12];
    header[..4].copy_from_slice(tx_tag);
    header[4..12].copy_from_slice(&seq.to_le_bytes());

    let mut nonce_bytes = [0u8; 12];
    nonce_bytes[4..12].copy_from_slice(&seq.to_le_bytes());
    let plaintext = frame.encode_binary();
    let ciphertext = send_cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &plaintext,
                aad: &header,
            },
        )
        .ok()?;

    let mut pkt = Vec::with_capacity(12 + ciphertext.len());
    pkt.extend_from_slice(&header);
    pkt.extend_from_slice(&ciphertext);
    Some(pkt)
}

fn open_frame_with_cipher(
    recv_cipher: &ChaCha20Poly1305,
    rx_tag: &[u8; 4],
    rx_highest_seq: &mut u64,
    rx_window_mask: &mut u64,
    rx_seen_any: &mut bool,
    packet: &[u8],
) -> Option<P2pWireFrame> {
    if packet.len() < 12 + 16 {
        return None;
    }
    if packet[..4] != *rx_tag {
        return None;
    }
    let seq = u64::from_le_bytes(packet[4..12].try_into().ok()?);
    if seq == 0 {
        return None;
    }
    if *rx_seen_any && seq <= *rx_highest_seq {
        let diff = *rx_highest_seq - seq;
        if diff >= 64 || ((*rx_window_mask >> diff) & 1) != 0 {
            return None;
        }
    }

    let mut nonce_bytes = [0u8; 12];
    nonce_bytes[4..12].copy_from_slice(&seq.to_le_bytes());
    let plaintext = recv_cipher
        .decrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: &packet[12..],
                aad: &packet[..12],
            },
        )
        .ok()?;

    let frame = P2pWireFrame::decode_binary(&plaintext)?;

    if !*rx_seen_any {
        *rx_seen_any = true;
        *rx_highest_seq = seq;
        *rx_window_mask = 1;
    } else if seq > *rx_highest_seq {
        let shift = seq - *rx_highest_seq;
        *rx_window_mask = if shift >= 64 {
            1
        } else {
            (*rx_window_mask << shift) | 1
        };
        *rx_highest_seq = seq;
    } else {
        let diff = *rx_highest_seq - seq;
        *rx_window_mask |= 1u64 << diff;
    }

    Some(frame)
}

impl P2pCryptoSession {
    pub fn establish(
        local_secret: &StaticSecret,
        local_pubkey: [u8; 32],
        local_session_id: u32,
        peer_pubkey: [u8; 32],
        peer_session_id: u32,
    ) -> Self {
        Self::establish_with_psk(
            local_secret,
            local_pubkey,
            local_session_id,
            peer_pubkey,
            peer_session_id,
            None,
        )
    }

    pub fn establish_with_psk(
        local_secret: &StaticSecret,
        local_pubkey: [u8; 32],
        local_session_id: u32,
        peer_pubkey: [u8; 32],
        peer_session_id: u32,
        room_psk: Option<[u8; 32]>,
    ) -> Self {
        let (key_domain, tag_domain): (&[u8], &[u8]) = if room_psk.is_some() {
            (b"epilod-p2p-v1-psk:", b"epilod-p2p-tag-v1-psk:")
        } else {
            (b"epilod-p2p-v1:", b"epilod-p2p-tag-v1:")
        };
        let (send_cipher, recv_cipher, tx_tag, rx_tag) = derive_directional_ciphers(
            key_domain,
            tag_domain,
            local_secret,
            local_pubkey,
            local_session_id,
            peer_pubkey,
            peer_session_id,
            room_psk.as_ref(),
        );

        Self {
            send_cipher,
            recv_cipher,
            tx_tag,
            rx_tag,
            tx_seq: 1,
            rx_highest_seq: 0,
            rx_window_mask: 0,
            rx_seen_any: false,
        }
    }

    pub fn seal(&mut self, frame: &P2pWireFrame) -> Option<Vec<u8>> {
        seal_frame_with_cipher(&mut self.send_cipher, &self.tx_tag, &mut self.tx_seq, frame)
    }

    pub fn open(&mut self, packet: &[u8]) -> Option<P2pWireFrame> {
        open_frame_with_cipher(
            &self.recv_cipher,
            &self.rx_tag,
            &mut self.rx_highest_seq,
            &mut self.rx_window_mask,
            &mut self.rx_seen_any,
            packet,
        )
    }
}

#[derive(Debug, Clone)]
struct OutgoingMsg {
    msg_id: u32,
    chunks: Vec<Vec<u8>>,
    acked: Vec<bool>,
    last_sent_ms: Vec<u64>,
}

#[derive(Debug, Clone)]
struct IncomingMsg {
    total: u16,
    slots: Vec<Option<Vec<u8>>>,
    received_count: usize,
    total_bytes: usize,
}

#[derive(Debug, Default)]
pub struct ReliableChannel {
    next_msg_id: u32,
    outgoing: BTreeMap<u32, OutgoingMsg>,
    incoming: BTreeMap<u32, IncomingMsg>,
    completed_ids: VecDeque<u32>,
}

impl ReliableChannel {
    pub fn new() -> Self {
        Self {
            next_msg_id: 1,
            outgoing: BTreeMap::new(),
            incoming: BTreeMap::new(),
            completed_ids: VecDeque::new(),
        }
    }

    pub fn enqueue_message(&mut self, payload: &[u8]) -> Option<(u32, Vec<P2pWireFrame>)> {
        if payload.is_empty() || payload.len() > MAX_RELIABLE_MSG_BYTES {
            return None;
        }
        let chunks: Vec<Vec<u8>> = payload
            .chunks(P2P_CHUNK_PAYLOAD_BYTES)
            .map(|c| c.to_vec())
            .collect();
        if chunks.len() > MAX_RELIABLE_CHUNKS as usize {
            return None;
        }
        let msg_id = self.next_msg_id;
        self.next_msg_id = self.next_msg_id.wrapping_add(1).max(1);
        let total = chunks.len() as u16;
        let frames = chunks
            .iter()
            .enumerate()
            .map(|(idx, data)| P2pWireFrame::Chunk {
                msg_id,
                idx: idx as u16,
                total,
                data: data.clone(),
            })
            .collect();
        self.outgoing.insert(
            msg_id,
            OutgoingMsg {
                msg_id,
                acked: vec![false; chunks.len()],
                last_sent_ms: vec![0; chunks.len()],
                chunks,
            },
        );
        while self.outgoing.len() > 24 {
            if let Some(first) = self.outgoing.keys().next().copied() {
                self.outgoing.remove(&first);
            }
        }
        Some((msg_id, frames))
    }

    pub fn handle_frame(&mut self, frame: P2pWireFrame) -> (Vec<P2pWireFrame>, Option<Vec<u8>>) {
        match frame {
            P2pWireFrame::Chunk {
                msg_id,
                idx,
                total,
                data,
            } => {
                if total == 0
                    || total > MAX_RELIABLE_CHUNKS
                    || idx >= total
                    || data.len() > P2P_CHUNK_PAYLOAD_BYTES
                {
                    return (Vec::new(), None);
                }
                if self.completed_ids.contains(&msg_id) {
                    let ack = P2pWireFrame::Ack {
                        msg_id,
                        base_idx: total,
                        mask: u64::MAX,
                    };
                    return (vec![ack], None);
                }

                let entry = self.incoming.entry(msg_id).or_insert_with(|| IncomingMsg {
                    total,
                    slots: vec![None; total as usize],
                    received_count: 0,
                    total_bytes: 0,
                });
                if entry.total != total {
                    return (Vec::new(), None);
                }
                let idx_usize = idx as usize;
                if idx_usize < entry.slots.len() && entry.slots[idx_usize].is_none() {
                    if entry.total_bytes + data.len() > MAX_RELIABLE_MSG_BYTES {
                        self.incoming.remove(&msg_id);
                        return (Vec::new(), None);
                    }
                    entry.total_bytes += data.len();
                    entry.slots[idx_usize] = Some(data);
                    entry.received_count += 1;
                }

                let mut base_idx = 0usize;
                while base_idx < entry.slots.len() && entry.slots[base_idx].is_some() {
                    base_idx += 1;
                }
                let mut mask = 0u64;
                for bit in 0..64 {
                    let check = base_idx + bit;
                    if check >= entry.slots.len() {
                        break;
                    }
                    if entry.slots[check].is_some() {
                        mask |= 1u64 << bit;
                    }
                }
                let ack = P2pWireFrame::Ack {
                    msg_id,
                    base_idx: base_idx as u16,
                    mask,
                };

                let completed = if entry.received_count == entry.total as usize {
                    if let Some(finished) = self.incoming.remove(&msg_id) {
                        self.completed_ids.push_back(msg_id);
                        while self.completed_ids.len() > 64 {
                            self.completed_ids.pop_front();
                        }
                        let mut assembled = Vec::with_capacity(finished.total_bytes);
                        for part in finished.slots.into_iter().flatten() {
                            assembled.extend_from_slice(&part);
                        }
                        Some(assembled)
                    } else {
                        None
                    }
                } else {
                    while self.incoming.len() > 16 {
                        if let Some(first) = self.incoming.keys().next().copied() {
                            self.incoming.remove(&first);
                        }
                    }
                    None
                };

                (vec![ack], completed)
            }
            P2pWireFrame::Ack {
                msg_id,
                base_idx,
                mask,
            } => {
                if let Some(msg) = self.outgoing.get_mut(&msg_id) {
                    let base = (base_idx as usize).min(msg.acked.len());
                    for flag in &mut msg.acked[..base] {
                        *flag = true;
                    }
                    for bit in 0..64 {
                        let idx = base + bit;
                        if idx >= msg.acked.len() {
                            break;
                        }
                        if ((mask >> bit) & 1) != 0 {
                            msg.acked[idx] = true;
                        }
                    }
                    if msg.acked.iter().all(|&a| a) {
                        self.outgoing.remove(&msg_id);
                    }
                }
                (Vec::new(), None)
            }
            _ => (Vec::new(), None),
        }
    }

    pub fn collect_retransmits(&mut self, now_ms: u64, rto_ms: u64) -> Vec<P2pWireFrame> {
        self.collect_retransmits_bounded(now_ms, rto_ms, 16)
    }

    pub fn collect_retransmits_bounded(
        &mut self,
        now_ms: u64,
        rto_ms: u64,
        max_frames: usize,
    ) -> Vec<P2pWireFrame> {
        if max_frames == 0 {
            return Vec::new();
        }
        let mut out = Vec::with_capacity(max_frames.min(16));
        for single_chunk_first in [true, false] {
            for msg in self.outgoing.values_mut() {
                if (msg.chunks.len() == 1) != single_chunk_first {
                    continue;
                }
                let total = msg.chunks.len() as u16;
                for idx in 0..msg.chunks.len() {
                    let last = msg.last_sent_ms[idx];
                    if !msg.acked[idx] && (last == 0 || now_ms.saturating_sub(last) >= rto_ms) {
                        msg.last_sent_ms[idx] = now_ms.max(1);
                        out.push(P2pWireFrame::Chunk {
                            msg_id: msg.msg_id,
                            idx: idx as u16,
                            total,
                            data: msg.chunks[idx].clone(),
                        });
                        if out.len() >= max_frames {
                            return out;
                        }
                    }
                }
            }
        }
        out
    }

    pub fn mark_sent(&mut self, msg_id: u32, now_ms: u64) {
        if let Some(msg) = self.outgoing.get_mut(&msg_id) {
            let stamped = now_ms.max(1);
            for ts in &mut msg.last_sent_ms {
                *ts = stamped;
            }
        }
    }

    pub fn mark_sent_prefix(&mut self, msg_id: u32, count: usize, now_ms: u64) {
        if let Some(msg) = self.outgoing.get_mut(&msg_id) {
            let stamped = now_ms.max(1);
            for ts in msg.last_sent_ms.iter_mut().take(count) {
                *ts = stamped;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ep2_beacon_fits_syncplay_chat_budget_and_roundtrips() {
        let beacon = P2pBeacon {
            version: 1,
            nat_symmetric: false,
            pubkey: [0xAB; 32],
            session_id: 0x1234_5678,
            candidates: vec![
                P2pCandidate {
                    kind: P2pCandidateKind::Lan,
                    addr: "192.168.1.44:51234".parse().unwrap(),
                },
                P2pCandidate {
                    kind: P2pCandidateKind::Wan,
                    addr: "203.0.113.19:51234".parse().unwrap(),
                },
                P2pCandidate {
                    kind: P2pCandidateKind::Ipv6,
                    addr: "[2001:db8::42]:51234".parse().unwrap(),
                },
            ],
        };
        let encoded = encode_ep2_beacon(&beacon);
        assert!(encoded.starts_with(EP2_CHAT_PREFIX));
        assert!(
            encoded.len() <= MAX_CHAT_BEACON_CHARS,
            "len={}",
            encoded.len()
        );

        let decoded = decode_ep2_beacon(&encoded).expect("decode beacon");
        assert_eq!(decoded, beacon);

        let uri = encode_ep2_invite_uri(&beacon);
        assert_eq!(decode_ep2_invite_uri(&uri), Some(beacon));
    }

    #[test]
    fn stun_xor_mapped_ipv4_and_ipv6_decode_correctly() {
        let tx = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
        let req = build_stun_binding_request(tx);
        assert_eq!(req.len(), 20);

        // Build Binding Success response with XOR-MAPPED-ADDRESS for 198.51.100.77:43210
        let cookie = 0x2112_A442u32.to_be_bytes();
        let xport = 43210u16 ^ 0x2112;
        let ip = [198u8, 51, 100, 77];
        let mut resp = vec![0x01, 0x01, 0x00, 0x0C];
        resp.extend_from_slice(&cookie);
        resp.extend_from_slice(&tx);
        resp.extend_from_slice(&[0x00, 0x20, 0x00, 0x08, 0x00, 0x01]);
        resp.extend_from_slice(&xport.to_be_bytes());
        for i in 0..4 {
            resp.push(ip[i] ^ cookie[i]);
        }
        assert_eq!(
            parse_stun_binding_response(&resp, tx),
            Some("198.51.100.77:43210".parse().unwrap())
        );
    }

    #[test]
    fn upnp_ssdp_and_igd_xml_parse_control_url() {
        let ssdp = "HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: http://192.168.1.1:5000/rootDesc.xml\r\n\r\n";
        let loc = parse_ssdp_location(ssdp).unwrap();
        let xml = r#"<root><device><serviceList>
            <service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/ctl/comm</controlURL></service>
            <service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>
        </serviceList></device></root>"#;
        let (ctrl, svc) = parse_igd_control_url(&loc, xml).unwrap();
        assert_eq!(ctrl, "http://192.168.1.1:5000/ctl/IPConn");
        assert_eq!(svc, "urn:schemas-upnp-org:service:WANIPConnection:1");
    }

    #[test]
    fn x25519_aead_session_encrypts_bidirectionally_and_blocks_replays() {
        let sk_a = StaticSecret::from([0x11u8; 32]);
        let pk_a = PublicKey::from(&sk_a).to_bytes();
        let sk_b = StaticSecret::from([0x22u8; 32]);
        let pk_b = PublicKey::from(&sk_b).to_bytes();

        let mut a = P2pCryptoSession::establish(&sk_a, pk_a, 10, pk_b, 20);
        let mut b = P2pCryptoSession::establish(&sk_b, pk_b, 20, pk_a, 10);

        let ping = P2pWireFrame::PunchPing { ts_ms: 999 };
        let pkt = a.seal(&ping).unwrap();
        assert_eq!(b.open(&pkt), Some(ping));
        // Replay must be rejected
        assert_eq!(b.open(&pkt), None);
        // Tamper must fail AEAD
        let mut tampered = b
            .seal(&P2pWireFrame::PunchPong { echo_ts_ms: 999 })
            .unwrap();
        let last = tampered.len() - 1;
        tampered[last] ^= 0xFF;
        assert_eq!(a.open(&tampered), None);
    }

    #[test]
    fn reliable_channel_chunks_recovers_drops_and_reassembles() {
        let payload: Vec<u8> = (0..5000).map(|i| (i % 251) as u8).collect();
        let mut tx = ReliableChannel::new();
        let mut rx = ReliableChannel::new();

        let (msg_id, frames) = tx.enqueue_message(&payload).unwrap();
        assert!(frames.len() >= 5);
        tx.mark_sent(msg_id, 100);

        // Deliver all except index 2 to simulate packet drop
        for (i, frame) in frames.iter().enumerate() {
            if i == 2 {
                continue;
            }
            let (acks, done) = rx.handle_frame(frame.clone());
            assert!(done.is_none());
            for ack in acks {
                tx.handle_frame(ack);
            }
        }

        // Retransmit recovers only the dropped chunk
        let retx = tx.collect_retransmits(500, 200);
        assert_eq!(retx.len(), 1);
        let (acks, assembled) = rx.handle_frame(retx.into_iter().next().unwrap());
        assert_eq!(assembled.as_deref(), Some(payload.as_slice()));
        for ack in acks {
            tx.handle_frame(ack);
        }
        assert!(tx.collect_retransmits(2000, 200).is_empty());
    }

    #[test]
    fn p2p_datagram_frame_roundtrips_and_enforces_size_limit() {
        let frame = P2pWireFrame::Datagram {
            data: b"{\"kind\":\"reaction\",\"emoji\":\"\xF0\x9F\x98\xB1\"}".to_vec(),
        };
        let encoded = frame.encode_binary();
        assert_eq!(P2pWireFrame::decode_binary(&encoded), Some(frame));

        let empty = P2pWireFrame::Datagram { data: Vec::new() }.encode_binary();
        assert_eq!(P2pWireFrame::decode_binary(&empty), None);

        let mut oversized = vec![6u8];
        oversized.extend_from_slice(&((MAX_P2P_DATAGRAM_BYTES as u16) + 1).to_be_bytes());
        oversized.resize(3 + MAX_P2P_DATAGRAM_BYTES + 1, 0x41);
        assert_eq!(P2pWireFrame::decode_binary(&oversized), None);
    }

    #[test]
    fn epr_reaction_roundtrips_including_zwj_and_scared_emojis() {
        for emoji in ["😱", "❤️", "❤️‍🔥", "👏🏽", "1️⃣"] {
            let pkt = ReactionFallbackPacket {
                avatar_id: "snoo-violet".to_string(),
                emoji: emoji.to_string(),
                count: 14,
                seq: 4242,
            };
            let encoded = encode_epr_reaction(&pkt).expect("encode epr");
            assert!(encoded.starts_with(EP_REACTION_CHAT_PREFIX));
            assert!(encoded.len() <= MAX_CHAT_REACTION_CHARS);
            let decoded = decode_epr_reaction(&encoded).expect("decode epr");
            assert_eq!(decoded, pkt);
        }

        // Plain ASCII or control characters must be rejected
        assert_eq!(sanitize_reaction_emoji("hello"), None);
        assert_eq!(
            sanitize_reaction_emoji("❤️\u{202E}"),
            Some("❤️".to_string())
        );
        assert_eq!(sanitize_reaction_emoji("\u{200D}😱"), None);
    }

    #[test]
    fn ept_chat_single_and_multichunk_roundtrip_including_arabic_and_emoji() {
        let short = ChatFallbackPacket {
            msg_id: "m1234567890".to_string(),
            avatar_id: "violet-fox".to_string(),
            reply_to_id: Some("m0987654321".to_string()),
            text: "يلا نبدأ؟ 🍿".to_string(),
            is_edit: false,
        };
        let chunks = encode_ept_chat_chunks(&short).expect("encode short ept");
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].len() <= MAX_CHAT_FALLBACK_LINE_CHARS);

        let mut reassembler = EptChatReassembler::default();
        let parsed_chunk = decode_ept_chat_chunk(&chunks[0]).expect("decode chunk");
        let decoded = reassembler
            .push_chunk("Maya", parsed_chunk)
            .expect("reassemble single");
        assert_eq!(decoded, short);

        let edit_pkt = ChatFallbackPacket {
            msg_id: "m1234567890".to_string(),
            avatar_id: "violet-fox".to_string(),
            reply_to_id: None,
            text: "edited line".to_string(),
            is_edit: true,
        };
        let edit_chunks = encode_ept_chat_chunks(&edit_pkt).expect("encode edit ept");
        let edit_decoded = reassembler
            .push_chunk("Maya", decode_ept_chat_chunk(&edit_chunks[0]).unwrap())
            .expect("decode edit");
        assert_eq!(edit_decoded, edit_pkt);

        let react_pkt = ChatReactFallbackPacket {
            msg_id: "m1234567890".to_string(),
            emoji: "🔥".to_string(),
        };
        let react_wire = encode_epcr_chat_react(&react_pkt).expect("encode epcr");
        assert!(react_wire.len() <= MAX_CHAT_FALLBACK_LINE_CHARS);
        assert_eq!(decode_epcr_chat_react(&react_wire), Some(react_pkt));

        let long_text = "Hold on!! ".repeat(45);
        let long = ChatFallbackPacket {
            msg_id: "m9988776655".to_string(),
            avatar_id: "luna".to_string(),
            reply_to_id: None,
            text: long_text.trim().to_string(),
            is_edit: false,
        };
        let long_chunks = encode_ept_chat_chunks(&long).expect("encode long ept");
        assert!(long_chunks.len() >= 3);
        for line in &long_chunks {
            assert!(line.len() <= MAX_CHAT_FALLBACK_LINE_CHARS);
        }

        // Deliver out of order
        let mut out = None;
        for line in long_chunks.into_iter().rev() {
            let c = decode_ept_chat_chunk(&line).expect("decode multi chunk");
            out = reassembler.push_chunk("Tariq", c);
        }
        assert_eq!(out, Some(long));
    }

    #[test]
    fn sanitize_chat_text_strips_controls_and_caps_length() {
        assert_eq!(sanitize_chat_text("   \n\t  "), None);
        assert_eq!(
            sanitize_chat_text("  hello\u{202E}\n\n\n\nworld  "),
            Some("hello\n\nworld".to_string())
        );
        let huge = "a".repeat(MAX_CHAT_MESSAGE_CHARS + 50);
        assert_eq!(
            sanitize_chat_text(&huge).unwrap().chars().count(),
            MAX_CHAT_MESSAGE_CHARS
        );
    }

    #[test]
    fn voice_frame_roundtrips_and_enforces_size_limit() {
        let frame = P2pWireFrame::Voice {
            voice_id: 3,
            epoch: 2,
            seq: 512,
            ts_48k: 960 * 512,
            flags: 0,
            opus: vec![0xAA; 120],
        };
        let encoded = frame.encode_binary();
        assert_eq!(P2pWireFrame::decode_binary(&encoded), Some(frame));

        let eot_empty = P2pWireFrame::Voice {
            voice_id: 3,
            epoch: 2,
            seq: 513,
            ts_48k: 960 * 513,
            flags: VOICE_FLAG_END_OF_TALK,
            opus: Vec::new(),
        };
        let eot_bytes = eot_empty.encode_binary();
        assert_eq!(P2pWireFrame::decode_binary(&eot_bytes), Some(eot_empty));

        let empty_non_eot = P2pWireFrame::Voice {
            voice_id: 3,
            epoch: 2,
            seq: 514,
            ts_48k: 960 * 514,
            flags: 0,
            opus: Vec::new(),
        }
        .encode_binary();
        assert_eq!(P2pWireFrame::decode_binary(&empty_non_eot), None);

        let mut oversized = vec![7u8, 3, 2, 0, 1, 0, 0, 0, 0, 0];
        oversized.extend_from_slice(&((MAX_VOICE_OPUS_BYTES as u16) + 1).to_be_bytes());
        oversized.resize(12 + MAX_VOICE_OPUS_BYTES + 1, 0x55);
        assert_eq!(P2pWireFrame::decode_binary(&oversized), None);
    }

    #[test]
    fn voice_crypto_isolates_tags_and_blocks_replays_alongside_chunk_bursts() {
        let a = P2pIdentity::generate();
        let b = P2pIdentity::generate();
        let mut a_ctrl = a.establish_with(b.pubkey, b.session_id);
        let mut b_ctrl = b.establish_with(a.pubkey, a.session_id);
        let (mut a_vtx, _a_vrx) = a.establish_voice_with(b.pubkey, b.session_id);
        let (_b_vtx, mut b_vrx) = b.establish_voice_with(a.pubkey, a.session_id);

        assert_ne!(a_ctrl.tx_tag, a_vtx.tx_tag);
        assert_eq!(a_vtx.tx_tag, b_vrx.rx_tag);

        // Interleave a 100-packet reliable chunk burst with 50 pps voice packets
        for i in 0..100u16 {
            let chunk_pkt = a_ctrl
                .seal(&P2pWireFrame::KeepAlive { ts_ms: i as u64 })
                .unwrap();
            assert!(b_ctrl.open(&chunk_pkt).is_some());
            assert!(b_vrx.open(&chunk_pkt).is_none());

            let voice_pkt = a_vtx
                .seal(&P2pWireFrame::Voice {
                    voice_id: 1,
                    epoch: 1,
                    seq: i,
                    ts_48k: (i as u32) * 960,
                    flags: 0,
                    opus: vec![0x77; 80],
                })
                .unwrap();
            assert!(b_ctrl.open(&voice_pkt).is_none());
            assert!(b_vrx.open(&voice_pkt).is_some());
            assert!(b_vrx.open(&voice_pkt).is_none()); // Replay blocked
        }
    }

    #[test]
    fn natpmp_pcp_candidate_priority_and_birthday_probes_behave_cleanly() {
        assert!(
            candidate_priority(P2pCandidateKind::Ipv6) > candidate_priority(P2pCandidateKind::Lan)
        );
        assert!(
            candidate_priority(P2pCandidateKind::Lan) > candidate_priority(P2pCandidateKind::Wan)
        );

        let req = build_natpmp_map_request(50000, 50000, 3600);
        assert_eq!(req[0], 0);
        assert_eq!(req[1], 1);
        let mut resp = [0u8; 16];
        resp[0] = 0;
        resp[1] = 129;
        resp[8..10].copy_from_slice(&50000u16.to_be_bytes());
        resp[10..12].copy_from_slice(&50123u16.to_be_bytes());
        resp[12..16].copy_from_slice(&3600u32.to_be_bytes());
        assert_eq!(parse_natpmp_map_response(&resp), Some((50000, 50123, 3600)));

        let nonce = [7u8; 12];
        let mut pcp_resp =
            build_pcp_map_request(Ipv4Addr::new(192, 168, 1, 20), 50000, 50000, 3600, nonce);
        pcp_resp[1] = 0x81;
        pcp_resp[42..44].copy_from_slice(&54321u16.to_be_bytes());
        pcp_resp[56..60].copy_from_slice(&[203, 0, 113, 9]);
        assert_eq!(
            parse_pcp_map_response(&pcp_resp, nonce),
            Some((Some(Ipv4Addr::new(203, 0, 113, 9)), 54321, 3600))
        );

        let probes = compute_birthday_probe_ports(40000, 6, 42);
        assert_eq!(probes.len(), 6);
        assert!(!probes.contains(&40000));
        assert!(probes.contains(&40001));
    }

    #[test]
    fn reliable_channel_bounded_retransmits_prioritize_control_frames_and_do_not_starve() {
        let mut ch = ReliableChannel::new();
        let bulk = vec![0xAB; P2P_CHUNK_PAYLOAD_BYTES * 5];
        let (bulk_id, bulk_frames) = ch.enqueue_message(&bulk).unwrap();
        assert_eq!(bulk_frames.len(), 5);
        ch.mark_sent(bulk_id, 100);

        let ctrl = br#"{"kind":"voiceState","inVoice":true}"#;
        let (ctrl_id, ctrl_frames) = ch.enqueue_message(ctrl).unwrap();
        assert_eq!(ctrl_frames.len(), 1);
        ch.mark_sent(ctrl_id, 100);

        // At t=400ms with max_frames=2, the single-chunk control message must go first
        // and only 1 bulk chunk should be stamped, leaving bulk chunks 1..5 ready immediately.
        let r1 = ch.collect_retransmits_bounded(400, 260, 2);
        assert_eq!(r1.len(), 2);
        assert!(matches!(r1[0], P2pWireFrame::Chunk { msg_id, .. } if msg_id == ctrl_id));
        assert!(matches!(r1[1], P2pWireFrame::Chunk { msg_id, idx: 0, .. } if msg_id == bulk_id));

        // Immediately afterwards at t=401ms, bulk chunks 1..3 are still unstamped and ready!
        let r2 = ch.collect_retransmits_bounded(401, 260, 2);
        assert_eq!(r2.len(), 2);
        assert!(matches!(r2[0], P2pWireFrame::Chunk { msg_id, idx: 1, .. } if msg_id == bulk_id));
        assert!(matches!(r2[1], P2pWireFrame::Chunk { msg_id, idx: 2, .. } if msg_id == bulk_id));
    }

    #[test]
    fn upnp_rejects_ssrf_cross_host_and_crlf_smuggling() {
        assert!(is_allowed_upnp_lan_ip(Ipv4Addr::new(192, 168, 1, 1)));
        assert!(is_allowed_upnp_lan_ip(Ipv4Addr::new(10, 0, 0, 1)));
        assert!(!is_allowed_upnp_lan_ip(Ipv4Addr::new(127, 0, 0, 1)));
        assert!(!is_allowed_upnp_lan_ip(Ipv4Addr::new(169, 254, 169, 254)));
        assert!(!is_allowed_upnp_lan_ip(Ipv4Addr::new(8, 8, 8, 8)));

        let base = "http://192.168.1.1:5000/rootDesc.xml";
        // Cross-host controlURL to localhost must be rejected
        let evil_ssrf = "<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>http://127.0.0.1:9222/ctl</controlURL></service>";
        assert!(parse_igd_control_url(base, evil_ssrf).is_none());

        // CRLF / whitespace smuggling in controlURL must be rejected
        let evil_crlf = "<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\nDELETE /x</controlURL></service>";
        assert!(parse_igd_control_url(base, evil_crlf).is_none());

        // Same-host absolute or relative path succeeds
        let ok_rel = "<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><controlURL>/ctl/IPConn</controlURL></service>";
        assert_eq!(
            parse_igd_control_url(base, ok_rel).unwrap().0,
            "http://192.168.1.1:5000/ctl/IPConn"
        );
    }

    #[test]
    fn reliable_channel_rejects_oversized_or_zero_total_chunks() {
        let mut ch = ReliableChannel::new();
        let (acks_big, done_big) = ch.handle_frame(P2pWireFrame::Chunk {
            msg_id: 1,
            idx: 0,
            total: 65535,
            data: vec![0u8; 8],
        });
        assert!(acks_big.is_empty() && done_big.is_none());

        let (acks_zero, done_zero) = ch.handle_frame(P2pWireFrame::Chunk {
            msg_id: 2,
            idx: 0,
            total: 0,
            data: vec![1u8],
        });
        assert!(acks_zero.is_empty() && done_zero.is_none());
    }

    #[test]
    fn beacon_decode_filters_link_local_and_mismatched_candidate_kinds() {
        let b = P2pBeacon {
            version: 1,
            nat_symmetric: false,
            pubkey: [7u8; 32],
            session_id: 42,
            candidates: vec![
                P2pCandidate {
                    kind: P2pCandidateKind::Lan,
                    addr: SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(169, 254, 169, 254), 80)),
                },
                P2pCandidate {
                    kind: P2pCandidateKind::Wan,
                    addr: SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 1), 80)),
                },
                P2pCandidate {
                    kind: P2pCandidateKind::Lan,
                    addr: SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 20), 50000)),
                },
            ],
        };
        let enc = encode_ep2_beacon(&b);
        let dec = decode_ep2_beacon(&enc).unwrap();
        assert_eq!(dec.candidates.len(), 1);
        assert_eq!(
            dec.candidates[0].addr,
            SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::new(192, 168, 1, 20), 50000))
        );
    }

    #[test]
    fn p2p_room_psk_binds_session_keys_and_blocks_mitm_without_password() {
        let a = P2pIdentity::generate();
        let b = P2pIdentity::generate();
        let mallory = P2pIdentity::generate();
        let psk = derive_p2p_room_psk("ep-room-123", "SquadSecret!2026");

        let mut a_to_b = a.establish_with_psk(b.pubkey, b.session_id, Some(psk));
        let mut b_from_a = b.establish_with_psk(a.pubkey, a.session_id, Some(psk));
        let pkt = a_to_b
            .seal(&P2pWireFrame::Datagram {
                data: b"private watch party".to_vec(),
            })
            .unwrap();
        assert!(b_from_a.open(&pkt).is_some());

        // MITM who substitutes their own pubkey without knowing the room password cannot decrypt
        let mut a_to_m = a.establish_with_psk(mallory.pubkey, mallory.session_id, Some(psk));
        let mut m_from_a_no_psk = mallory.establish_with_psk(a.pubkey, a.session_id, None);
        let mut m_from_a_wrong_psk = mallory.establish_with_psk(
            a.pubkey,
            a.session_id,
            Some(derive_p2p_room_psk("ep-room-123", "WrongPass")),
        );
        let pkt_m = a_to_m
            .seal(&P2pWireFrame::Datagram {
                data: b"secret".to_vec(),
            })
            .unwrap();
        assert!(m_from_a_no_psk.open(&pkt_m).is_none());
        assert!(m_from_a_wrong_psk.open(&pkt_m).is_none());
    }
}
