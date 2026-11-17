use sha2::{Digest, Sha256};
use thiserror::Error;

pub const ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
pub const DEFAULT_ENDPOINT: &str = "syncplay.pl:8999";
pub const BACKUP_ENDPOINT: &str = "syncplay.pl:8998";
pub const MAX_STANDARD_ROOM_CHARS: usize = 64;

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
}
