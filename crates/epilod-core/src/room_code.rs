use crate::cloud_sync::CLOUD_DEFAULT_ENDPOINT;
use crate::validation::{strip_unsafe_unicode, validate_endpoint};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

pub const ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
pub const DEFAULT_ENDPOINT: &str = "syncplay.pl:8999";
pub const BACKUP_ENDPOINT: &str = "syncplay.pl:8998";
pub const MAX_STANDARD_ROOM_CHARS: usize = 64;
pub const EPILOD_JOIN_URI_PREFIX: &str = "epilod://join/";
pub const MAX_INVITE_URI_CHARS: usize = 512;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum RoomCodeError {
    #[error("A room code has 6 digits, for example 482 915.")]
    InvalidLength,
    #[error("The code contains a character that is not allowed: '{0}'.")]
    InvalidCharacter(char),
    #[error("Room name cannot be empty.")]
    EmptyRoomName,
    #[error("Room name must be at most {MAX_STANDARD_ROOM_CHARS} characters without control characters.")]
    InvalidRoomName,
    #[error("Could not get secure random numbers from the system.")]
    Rng,
}

/// New random 6-digit numeric invite code (e.g. `482915`) from the OS CSPRNG
/// using rejection sampling so all 1,000,000 codes are uniformly distributed.
pub fn generate() -> Result<String, RoomCodeError> {
    let mut out = String::with_capacity(6);
    let mut bytes = [0u8; 16];
    while out.len() < 6 {
        getrandom::getrandom(&mut bytes).map_err(|_| RoomCodeError::Rng)?;
        for &b in &bytes {
            if b < 250 {
                out.push((b'0' + (b % 10)) as char);
                if out.len() == 6 {
                    break;
                }
            }
        }
    }
    Ok(out)
}

/// Returns true if `input` normalizes to a 6-digit numeric invite code.
pub fn is_six_digit_code(input: &str) -> bool {
    normalize(input).is_ok_and(|c| c.len() == 6 && c.chars().all(|ch| ch.is_ascii_digit()))
}

/// Accepts 6-digit numeric OTP codes (with spaces/hyphens stripped) returning `DDDDDD`,
/// as well as legacy 12-character `XXXX-XXXX-XXXX` codes for backwards compatibility.
pub fn normalize(input: &str) -> Result<String, RoomCodeError> {
    let chars: Vec<char> = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    if chars.len() == 6 && chars.iter().all(|c| c.is_ascii_digit()) {
        return Ok(chars.iter().collect());
    }
    if chars.len() != 12 {
        return Err(RoomCodeError::InvalidLength);
    }
    for &c in &chars {
        if !c.is_ascii() || !ALPHABET.contains(&(c as u8)) {
            return Err(RoomCodeError::InvalidCharacter(c));
        }
    }
    let s: String = chars.iter().collect();
    Ok(format!("{}-{}-{}", &s[0..4], &s[4..8], &s[8..12]))
}

/// Syncplay room name. A plain domain-separated SHA-256, NOT a keyed hash and
/// NOT an access control: it only gives a fixed-format room name.
pub fn syncplay_room_name(code: &str) -> Result<String, RoomCodeError> {
    let canonical = normalize(code)?;
    let compact: String = canonical.chars().filter(|c| *c != '-').collect();
    let mut h = Sha256::new();
    h.update(b"epilod-party-room-v1:");
    h.update(compact.as_bytes());
    let d = h.finalize();
    let hex: String = d[..10].iter().map(|b| format!("{:02x}", b)).collect();
    Ok(format!("ep-{hex}"))
}

/// Sanitize and validate a standard Syncplay literal room name (Fix 06).
/// Preserves case and common room punctuation while stripping unsafe/bidi/control characters.
pub fn normalize_standard_room_name(input: &str) -> Result<String, RoomCodeError> {
    let cleaned: String = input
        .trim()
        .chars()
        .filter(|c| {
            !c.is_control()
                && !matches!(
                    *c,
                    '\u{00AD}'
                        | '\u{061C}'
                        | '\u{200B}'..='\u{200F}'
                        | '\u{202A}'..='\u{202E}'
                        | '\u{2060}'
                        | '\u{2066}'..='\u{2069}'
                        | '\u{FEFF}'
                )
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return Err(RoomCodeError::EmptyRoomName);
    }
    if collapsed.chars().count() > MAX_STANDARD_ROOM_CHARS {
        return Err(RoomCodeError::InvalidRoomName);
    }
    Ok(collapsed)
}

/// Resolve the Syncplay wire room name: either hashed `ep-...` for 12-char invite codes
/// or literal room name when `literal_room == true`.
pub fn resolve_syncplay_room(
    room_input: &str,
    literal_room: bool,
) -> Result<String, RoomCodeError> {
    if literal_room {
        normalize_standard_room_name(room_input)
    } else {
        syncplay_room_name(room_input)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepLinkInvite {
    pub uri: String,
    pub room_name: String,
    pub literal_room: bool,
    pub server_host: Option<String>,
}

fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.as_bytes() {
        let is_unreserved =
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~');
        if is_unreserved {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn percent_decode_component(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push(((hi << 4) | lo) as u8);
            i += 3;
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub fn format_invite_link(
    room_input: &str,
    literal_room: bool,
    server_host: Option<&str>,
) -> Option<String> {
    let canonical_room = if literal_room {
        normalize_standard_room_name(room_input).ok()?
    } else {
        normalize(room_input).ok()?
    };

    let mut params: Vec<String> = Vec::new();
    if literal_room {
        params.push("literal=1".to_string());
    }
    if let Some(raw_host) = server_host {
        let trimmed_host = raw_host.trim().trim_end_matches('/');
        if trimmed_host.eq_ignore_ascii_case(CLOUD_DEFAULT_ENDPOINT) {
            params.push("cloud=1".to_string());
        } else if let Ok(valid_host) = validate_endpoint(raw_host) {
            if !valid_host.eq_ignore_ascii_case(DEFAULT_ENDPOINT) {
                params.push(format!("host={}", percent_encode_component(&valid_host)));
            }
        }
    }

    let encoded_room = percent_encode_component(&canonical_room);
    if params.is_empty() {
        Some(format!("{EPILOD_JOIN_URI_PREFIX}{encoded_room}"))
    } else {
        Some(format!(
            "{EPILOD_JOIN_URI_PREFIX}{encoded_room}?{}",
            params.join("&")
        ))
    }
}

pub fn parse_invite_link(raw: &str) -> Option<DeepLinkInvite> {
    let clean = strip_unsafe_unicode(raw);
    let trimmed = clean
        .trim()
        .trim_matches(|c| matches!(c, '"' | '\'' | '<' | '>'));
    if trimmed.is_empty() || trimmed.chars().count() > MAX_INVITE_URI_CHARS {
        return None;
    }

    let prefix_len = EPILOD_JOIN_URI_PREFIX.len();
    let lower_prefix: String = trimmed.chars().take(prefix_len).collect();
    if !lower_prefix.eq_ignore_ascii_case(EPILOD_JOIN_URI_PREFIX) {
        return None;
    }

    let rest = trimmed.get(prefix_len..)?;
    if rest.chars().any(char::is_whitespace) {
        return None;
    }
    let without_fragment = rest.split('#').next().unwrap_or(rest);
    let (raw_room_part, raw_query) = match without_fragment.split_once('?') {
        Some((r, q)) => (r, Some(q)),
        None => (without_fragment, None),
    };
    let raw_room_part = raw_room_part.trim_end_matches('/');
    if raw_room_part.is_empty() || raw_room_part.contains('/') {
        return None;
    }

    let decoded_room = percent_decode_component(raw_room_part)?;
    let mut literal_room = false;
    let mut server_host: Option<String> = None;

    if let Some(query) = raw_query {
        for pair in query.split('&') {
            if pair.is_empty() {
                continue;
            }
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            if k.eq_ignore_ascii_case("literal") {
                literal_room = matches!(v, "1" | "true" | "TRUE");
            } else if k.eq_ignore_ascii_case("cloud") {
                if matches!(v, "1" | "true" | "TRUE") {
                    server_host = Some(CLOUD_DEFAULT_ENDPOINT.to_string());
                }
            } else if k.eq_ignore_ascii_case("host") && !v.is_empty() {
                let decoded_host = percent_decode_component(v)?;
                let trimmed_decoded = decoded_host.trim().trim_end_matches('/');
                if trimmed_decoded.eq_ignore_ascii_case(CLOUD_DEFAULT_ENDPOINT) {
                    server_host = Some(CLOUD_DEFAULT_ENDPOINT.to_string());
                } else {
                    let valid_host = validate_endpoint(&decoded_host).ok()?;
                    if !valid_host.eq_ignore_ascii_case(DEFAULT_ENDPOINT) {
                        server_host = Some(valid_host);
                    }
                }
            }
        }
    }

    let room_name = if literal_room {
        normalize_standard_room_name(&decoded_room).ok()?
    } else {
        normalize(&decoded_room).ok()?
    };

    let uri = format_invite_link(&room_name, literal_room, server_host.as_deref())?;
    Some(DeepLinkInvite {
        uri,
        room_name,
        literal_room,
        server_host,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_codes_are_valid_and_unique() {
        let a = generate().unwrap();
        let b = generate().unwrap();
        assert_ne!(a, b);
        assert_eq!(normalize(&a).unwrap(), a);
    }

    #[test]
    fn normalize_is_forgiving() {
        assert_eq!(normalize("  k7m4 p9x2-w8n5 ").unwrap(), "K7M4-P9X2-W8N5");
    }

    #[test]
    fn rejects_bad_input() {
        assert_eq!(normalize("ABCD-EFGH"), Err(RoomCodeError::InvalidLength));
        assert_eq!(
            normalize("0BCD-EFGH-JKLM"),
            Err(RoomCodeError::InvalidCharacter('0'))
        );
        assert_eq!(
            normalize("OBCD-EFGH-JKLM"),
            Err(RoomCodeError::InvalidCharacter('O'))
        );
    }

    #[test]
    fn non_ascii_never_panics_or_passes() {
        assert_eq!(
            normalize("\u{132}BCD-EFGH-JKLM"),
            Err(RoomCodeError::InvalidCharacter('\u{132}'))
        );
        assert!(normalize("ÄÖÜÄ-ÖÜÄÖ-ÜÄÖÜ").is_err());
    }

    #[test]
    fn room_name_is_deterministic_and_formatted() {
        let a = syncplay_room_name("K7M4-P9X2-W8N5").unwrap();
        let b = syncplay_room_name("k7m4p9x2w8n5").unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("ep-"));
        assert_eq!(a.len(), 23);
        assert_ne!(a, syncplay_room_name("K7M4-P9X2-W8N6").unwrap());
    }

    #[test]
    fn standard_syncplay_room_names_validate_without_ep_hash() {
        assert_eq!(
            resolve_syncplay_room("  MovieNight 2026  ", true).unwrap(),
            "MovieNight 2026"
        );
        assert_eq!(
            resolve_syncplay_room("أفلام\u{202E}السهرة", true).unwrap(),
            "أفلامالسهرة"
        );
        assert_eq!(
            resolve_syncplay_room("   \r\n  ", true),
            Err(RoomCodeError::EmptyRoomName)
        );
        let too_long = "a".repeat(MAX_STANDARD_ROOM_CHARS + 1);
        assert_eq!(
            resolve_syncplay_room(&too_long, true),
            Err(RoomCodeError::InvalidRoomName)
        );
        // Invite code mode still hashes identically
        assert!(resolve_syncplay_room("K7M4-P9X2-W8N5", false)
            .unwrap()
            .starts_with("ep-"));
        assert!(resolve_syncplay_room("482915", false)
            .unwrap()
            .starts_with("ep-"));
    }

    #[test]
    fn six_digit_numeric_otp_codes_normalize_and_hash() {
        let code = generate().unwrap();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));

        assert_eq!(normalize("482915").unwrap(), "482915");
        assert_eq!(normalize("  482 915  ").unwrap(), "482915");
        assert_eq!(normalize("482-915").unwrap(), "482915");

        let a = syncplay_room_name("482 915").unwrap();
        let b = syncplay_room_name("482915").unwrap();
        assert_eq!(a, b);
        assert!(a.starts_with("ep-"));
        assert_eq!(a.len(), 23);
        assert_ne!(a, syncplay_room_name("482916").unwrap());

        assert!(is_six_digit_code("482915"));
        assert!(is_six_digit_code("482 915"));
        assert!(!is_six_digit_code("K7M4-P9X2-W8N5"));
        assert!(!is_six_digit_code("MovieNight"));
    }

    #[test]
    fn invite_deep_links_roundtrip_and_reject_bad_inputs() {
        let link = format_invite_link("482 915", false, Some(DEFAULT_ENDPOINT)).unwrap();
        assert_eq!(link, "epilod://join/482915");
        let parsed = parse_invite_link(&link).unwrap();
        assert_eq!(
            parsed,
            DeepLinkInvite {
                uri: "epilod://join/482915".into(),
                room_name: "482915".into(),
                literal_room: false,
                server_host: None,
            }
        );

        let custom =
            format_invite_link("Movie Night 2026", true, Some("sync.example.org:8999")).unwrap();
        assert_eq!(
            custom,
            "epilod://join/Movie%20Night%202026?literal=1&host=sync.example.org%3A8999"
        );
        let parsed_custom = parse_invite_link(&format!("  <{custom}>  ")).unwrap();
        assert_eq!(parsed_custom.room_name, "Movie Night 2026");
        assert!(parsed_custom.literal_room);
        assert_eq!(
            parsed_custom.server_host.as_deref(),
            Some("sync.example.org:8999")
        );

        assert!(parse_invite_link("epilod://join/../../etc/passwd").is_none());
        assert!(parse_invite_link("epilod://join/notacode").is_none());
        assert!(parse_invite_link("epilod://join/482915?host=bad host").is_none());
        assert!(parse_invite_link("https://example.com/join/482915").is_none());
    }
}
