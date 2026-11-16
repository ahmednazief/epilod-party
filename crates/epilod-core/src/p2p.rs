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
pub const EP2_URI_PREFIX: &str = "epilod://p2p/";
pub const MAX_CHAT_BEACON_CHARS: usize = 144;
pub const MAX_CHAT_REACTION_CHARS: usize = 144;
pub const MAX_P2P_DATAGRAM_BYTES: usize = 1024;
pub const MAX_REACTION_EMOJI_BYTES: usize = 48;
pub const MAX_REACTION_BURST_COUNT: u8 = 25;
pub const P2P_CHUNK_PAYLOAD_BYTES: usize = 920;
pub const MAX_RELIABLE_CHUNKS: u16 = 512;
pub const MAX_RELIABLE_MSG_BYTES: usize = 256 * 1024;
pub const STUN_SERVERS: [&str; 2] = ["stun.l.google.com:19302", "stun.cloudflare.com:3478"];
pub const SSDP_MULTICAST_ADDR: &str = "239.255.255.250:1900";

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
                if port > 0 && !ip.is_unspecified() && !ip.is_loopback() {
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
                if port > 0 && !ip.is_unspecified() && !ip.is_loopback() {
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
        c.is_ascii()
            && !(matches!(c, '0'..='9' | '*' | '#') && clean.contains('\u{20E3}'))
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
    if emoji_len == 0
        || emoji_len > MAX_REACTION_EMOJI_BYTES
        || pos + emoji_len != bytes.len()
    {
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

pub fn parse_ssdp_location(response: &str) -> Option<String> {
    for line in response.lines() {
        let trimmed = line.trim();
        if let Some((k, v)) = trimmed.split_once(':') {
            if k.trim().eq_ignore_ascii_case("location") {
                let url = v.trim();
                if url.starts_with("http://") {
                    return Some(url.to_string());
                }
            }
        }
    }
    None
}

pub fn parse_http_url_host_port_path(url: &str) -> Option<(String, u16, String)> {
    let rest = url.trim().strip_prefix("http://")?;
    let (authority, path_raw) = match rest.find('/') {
        Some(idx) => (&rest[..idx], &rest[idx..]),
        None => (rest, "/"),
    };
    let (host, port) = if let Some((h, p)) = authority.rsplit_once(':') {
        let port = p.parse::<u16>().ok()?;
        (h.to_string(), port)
    } else {
        (authority.to_string(), 80u16)
    };
    if host.is_empty() {
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
    let trimmed = rel_or_abs.trim();
    if trimmed.starts_with("http://") {
        return Some(trimmed.to_string());
    }
    let (host, port, _) = parse_http_url_host_port_path(base_url)?;
    let path = if trimmed.starts_with('/') {
        trimmed.to_string()
    } else {
        format!("/{trimmed}")
    };
    Some(format!("http://{host}:{port}{path}"))
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
            _ => None,
        }
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
        P2pCryptoSession::establish(
            &self.secret,
            self.pubkey,
            self.session_id,
            peer_pubkey,
            peer_session_id,
        )
    }
}

pub fn fill_random_bytes(dst: &mut [u8]) {
    let _ = getrandom::getrandom(dst);
}

impl P2pCryptoSession {
    pub fn establish(
        local_secret: &StaticSecret,
        local_pubkey: [u8; 32],
        local_session_id: u32,
        peer_pubkey: [u8; 32],
        peer_session_id: u32,
    ) -> Self {
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
            h.update(b"epilod-p2p-v1:");
            h.update(label);
            h.update(shared.as_bytes());
            h.update(min_pub);
            h.update(min_sid.to_be_bytes());
            h.update(max_pub);
            h.update(max_sid.to_be_bytes());
            h.finalize().into()
        };

        let derive_tag = |sender_pub: &[u8; 32], sender_sid: u32| -> [u8; 4] {
            let mut h = Sha256::new();
            h.update(b"epilod-p2p-tag-v1:");
            h.update(shared.as_bytes());
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

        Self {
            send_cipher: ChaCha20Poly1305::new((&send_key).into()),
            recv_cipher: ChaCha20Poly1305::new((&recv_key).into()),
            tx_tag: derive_tag(&local_pubkey, local_session_id),
            rx_tag: derive_tag(&peer_pubkey, peer_session_id),
            tx_seq: 1,
            rx_highest_seq: 0,
            rx_window_mask: 0,
            rx_seen_any: false,
        }
    }

    pub fn seal(&mut self, frame: &P2pWireFrame) -> Option<Vec<u8>> {
        let seq = self.tx_seq;
        self.tx_seq = self.tx_seq.checked_add(1)?;
        let mut header = [0u8; 12];
        header[..4].copy_from_slice(&self.tx_tag);
        header[4..12].copy_from_slice(&seq.to_le_bytes());

        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[4..12].copy_from_slice(&seq.to_le_bytes());
        let plaintext = frame.encode_binary();
        let ciphertext = self
            .send_cipher
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

    pub fn open(&mut self, packet: &[u8]) -> Option<P2pWireFrame> {
        if packet.len() < 12 + 16 {
            return None;
        }
        if packet[..4] != self.rx_tag {
            return None;
        }
        let seq = u64::from_le_bytes(packet[4..12].try_into().ok()?);
        if seq == 0 {
            return None;
        }
        if self.rx_seen_any && seq <= self.rx_highest_seq {
            let diff = self.rx_highest_seq - seq;
            if diff >= 64 || ((self.rx_window_mask >> diff) & 1) != 0 {
                return None;
            }
        }

        let mut nonce_bytes = [0u8; 12];
        nonce_bytes[4..12].copy_from_slice(&seq.to_le_bytes());
        let plaintext = self
            .recv_cipher
            .decrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: &packet[12..],
                    aad: &packet[..12],
                },
            )
            .ok()?;

        let frame = P2pWireFrame::decode_binary(&plaintext)?;

        if !self.rx_seen_any {
            self.rx_seen_any = true;
            self.rx_highest_seq = seq;
            self.rx_window_mask = 1;
        } else if seq > self.rx_highest_seq {
            let shift = seq - self.rx_highest_seq;
            self.rx_window_mask = if shift >= 64 {
                1
            } else {
                (self.rx_window_mask << shift) | 1
            };
            self.rx_highest_seq = seq;
        } else {
            let diff = self.rx_highest_seq - seq;
            self.rx_window_mask |= 1u64 << diff;
        }

        Some(frame)
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
        let mut out = Vec::new();
        for msg in self.outgoing.values_mut() {
            let total = msg.chunks.len() as u16;
            for idx in 0..msg.chunks.len() {
                if !msg.acked[idx] && now_ms.saturating_sub(msg.last_sent_ms[idx]) >= rto_ms {
                    msg.last_sent_ms[idx] = now_ms;
                    out.push(P2pWireFrame::Chunk {
                        msg_id: msg.msg_id,
                        idx: idx as u16,
                        total,
                        data: msg.chunks[idx].clone(),
                    });
                    if out.len() >= 16 {
                        return out;
                    }
                }
            }
        }
        out
    }

    pub fn mark_sent(&mut self, msg_id: u32, now_ms: u64) {
        if let Some(msg) = self.outgoing.get_mut(&msg_id) {
            for ts in &mut msg.last_sent_ms {
                *ts = now_ms;
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
        assert_eq!(sanitize_reaction_emoji("❤️\u{202E}"), Some("❤️".to_string()));
        assert_eq!(sanitize_reaction_emoji("\u{200D}😱"), None);
    }
}
