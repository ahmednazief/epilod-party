use std::net::Ipv6Addr;
use std::path::{Path, PathBuf};
use thiserror::Error;

pub const MAX_ENDPOINT_CHARS: usize = 264;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ValidationError {
    #[error("Server endpoint must be host:port (e.g. syncplay.pl:8999) or wss://host.")]
    InvalidEndpointFormat,
    #[error("Unsafe or unsupported file path.")]
    UnsafeLocalPath,
    #[error("File does not exist or is not a regular file.")]
    MissingLocalFile,
    #[error("Username cannot be empty.")]
    InvalidUsername,
    #[error("Invalid color value.")]
    InvalidColor,
    #[error("Invalid playback speed.")]
    InvalidSpeed,
    #[error("Invalid aspect ratio mode.")]
    InvalidAspectMode,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct LocalPathOptions {
    pub allow_network_shares: bool,
}

pub fn has_unsafe_unicode(s: &str) -> bool {
    s.chars().any(|c| {
        c.is_control()
            || matches!(
                c,
                '\u{00AD}'
                    | '\u{061C}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{FEFF}'
            )
    })
}

pub fn strip_unsafe_unicode(s: &str) -> String {
    s.chars()
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
        .collect()
}

pub fn is_cloud_ws_endpoint(endpoint: &str) -> bool {
    let lower = endpoint.trim().to_ascii_lowercase();
    lower.starts_with("wss://") || lower.starts_with("ws://")
}

fn is_valid_hostname(host: &str) -> bool {
    if host.is_empty()
        || host.contains(':')
        || host.starts_with('.')
        || host.ends_with('.')
        || host.contains("..")
    {
        return false;
    }
    host.split('.').all(|label| {
        !label.is_empty()
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    })
}

pub fn validate_endpoint(raw: &str) -> Result<String, ValidationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > MAX_ENDPOINT_CHARS
        || has_unsafe_unicode(trimmed)
        || trimmed.chars().any(|c| c.is_whitespace())
    {
        return Err(ValidationError::InvalidEndpointFormat);
    }

    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("wss://") || lower.starts_with("ws://") {
        let is_tls = lower.starts_with("wss://");
        let scheme = if is_tls { "wss://" } else { "ws://" };
        let rest = trimmed[scheme.len()..].trim_end_matches('/');
        if rest.is_empty()
            || rest.contains('/')
            || rest.contains('?')
            || rest.contains('#')
            || rest.contains('@')
        {
            return Err(ValidationError::InvalidEndpointFormat);
        }
        let (host, port_opt) = if let Some(colon) = rest.rfind(':') {
            let h = &rest[..colon];
            let p_str = &rest[colon + 1..];
            if p_str.is_empty() || p_str.len() > 5 || !p_str.bytes().all(|b| b.is_ascii_digit()) {
                return Err(ValidationError::InvalidEndpointFormat);
            }
            let port: u16 = p_str
                .parse()
                .map_err(|_| ValidationError::InvalidEndpointFormat)?;
            if port == 0 {
                return Err(ValidationError::InvalidEndpointFormat);
            }
            (h, Some(port))
        } else {
            (rest, None)
        };
        if !is_valid_hostname(host) {
            return Err(ValidationError::InvalidEndpointFormat);
        }
        if !is_tls {
            let h_low = host.to_ascii_lowercase();
            let is_local = h_low == "localhost" || h_low == "127.0.0.1";
            if !cfg!(debug_assertions) || !is_local {
                return Err(ValidationError::InvalidEndpointFormat);
            }
        }
        return match port_opt {
            Some(port) => Ok(format!("{scheme}{host}:{port}")),
            None => Ok(format!("{scheme}{host}")),
        };
    }

    if trimmed.contains("://") {
        return Err(ValidationError::InvalidEndpointFormat);
    }

    let (host, port_str) = if trimmed.starts_with('[') {
        let end = trimmed
            .find(']')
            .ok_or(ValidationError::InvalidEndpointFormat)?;
        let rest = &trimmed[end + 1..];
        if !rest.starts_with(':') {
            return Err(ValidationError::InvalidEndpointFormat);
        }
        let ipv6 = &trimmed[1..end];
        if ipv6.parse::<Ipv6Addr>().is_err() {
            return Err(ValidationError::InvalidEndpointFormat);
        }
        (format!("[{ipv6}]"), &rest[1..])
    } else {
        let colon = trimmed
            .rfind(':')
            .ok_or(ValidationError::InvalidEndpointFormat)?;
        if colon == 0 {
            return Err(ValidationError::InvalidEndpointFormat);
        }
        let host = &trimmed[..colon];
        let port_str = &trimmed[colon + 1..];
        if !is_valid_hostname(host) {
            return Err(ValidationError::InvalidEndpointFormat);
        }
        (host.to_string(), port_str)
    };

    if port_str.is_empty() || port_str.len() > 5 || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return Err(ValidationError::InvalidEndpointFormat);
    }
    let port: u16 = port_str
        .parse()
        .map_err(|_| ValidationError::InvalidEndpointFormat)?;
    if port == 0 {
        return Err(ValidationError::InvalidEndpointFormat);
    }
    Ok(format!("{host}:{port}"))
}

pub fn validate_local_path_syntax(raw: &str) -> Result<String, ValidationError> {
    validate_local_path_syntax_with_options(raw, LocalPathOptions::default())
}

pub fn validate_local_path_syntax_with_options(
    raw: &str,
    opts: LocalPathOptions,
) -> Result<String, ValidationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed.len() > 4096 || has_unsafe_unicode(trimmed) {
        return Err(ValidationError::UnsafeLocalPath);
    }

    // Reject URL schemes like http://, file://, rtsp://, smb://, etc.
    if let Some(scheme_end) = trimmed.find("://") {
        let prefix = &trimmed[..scheme_end];
        if !prefix.is_empty()
            && prefix
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
        {
            return Err(ValidationError::UnsafeLocalPath);
        }
    }

    // Reject Win32 device namespace paths (`\\.\...` or `//./...`)
    if trimmed.starts_with(r"\\.\") || trimmed.starts_with("//./") {
        return Err(ValidationError::UnsafeLocalPath);
    }

    // Handle extended-length paths (`\\?\...`)
    if let Some(after_prefix) = trimmed.strip_prefix(r"\\?\") {
        // Explicitly reject \\?\UNC\...
        if after_prefix.len() >= 4 && after_prefix[..4].eq_ignore_ascii_case("UNC\\") {
            return Err(ValidationError::UnsafeLocalPath);
        }
        let bytes = after_prefix.as_bytes();
        if bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && bytes[2] == b'\\'
        {
            return Ok(trimmed.to_string());
        }
        return Err(ValidationError::UnsafeLocalPath);
    }

    // Standard UNC network shares (`\\server\share\file` or `//server/share/file`)
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        if !opts.allow_network_shares {
            return Err(ValidationError::UnsafeLocalPath);
        }
        let rest = trimmed.trim_start_matches(['\\', '/']);
        let mut parts = rest.split(['\\', '/']).filter(|s| !s.is_empty());
        let server = parts.next();
        let share = parts.next();
        let item = parts.next();
        if let (Some(srv), Some(shr), Some(_)) = (server, share, item) {
            if srv != "." && srv != "?" && !shr.contains(':') {
                return Ok(trimmed.to_string());
            }
        }
        return Err(ValidationError::UnsafeLocalPath);
    }

    Ok(trimmed.to_string())
}

pub fn validate_existing_local_file_with_options(
    raw: &str,
    opts: LocalPathOptions,
) -> Result<PathBuf, ValidationError> {
    let clean = validate_local_path_syntax_with_options(raw, opts)?;
    let path = Path::new(&clean);
    let meta = std::fs::metadata(path).map_err(|_| ValidationError::MissingLocalFile)?;
    if !meta.is_file() {
        return Err(ValidationError::MissingLocalFile);
    }
    Ok(path.to_path_buf())
}

pub fn sanitize_username(raw: &str) -> Result<String, ValidationError> {
    let clean = strip_unsafe_unicode(raw);
    let collapsed = clean.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return Err(ValidationError::InvalidUsername);
    }
    Ok(collapsed.chars().take(24).collect())
}

pub fn sanitize_hex_color(raw: &str) -> Result<String, ValidationError> {
    let trimmed = raw.trim();
    if !(trimmed.len() == 7 || trimmed.len() == 9) || !trimmed.starts_with('#') {
        return Err(ValidationError::InvalidColor);
    }
    if !trimmed[1..].bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(ValidationError::InvalidColor);
    }
    Ok(trimmed.to_ascii_uppercase())
}

pub fn sanitize_playback_speed(speed: f64) -> Result<f64, ValidationError> {
    if !speed.is_finite() || !(0.25..=4.0).contains(&speed) {
        return Err(ValidationError::InvalidSpeed);
    }
    Ok((speed * 100.0).round() / 100.0)
}

pub fn sanitize_aspect_mode(raw: &str) -> Result<&'static str, ValidationError> {
    match raw.trim() {
        "auto" | "-1" => Ok("auto"),
        "16:9" => Ok("16:9"),
        "4:3" => Ok("4:3"),
        "21:9" => Ok("21:9"),
        _ => Err(ValidationError::InvalidAspectMode),
    }
}

pub fn sanitize_osd_text(raw: &str) -> String {
    let normalized: String = raw
        .chars()
        .map(|c| {
            if matches!(c, '\r' | '\n' | '\t') {
                ' '
            } else {
                c
            }
        })
        .collect();
    let clean = strip_unsafe_unicode(&normalized);
    clean
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(120)
        .collect()
}

pub fn is_allowed_webview_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("tauri://localhost")
        || lower.starts_with("http://tauri.localhost")
        || lower.starts_with("https://tauri.localhost")
        || lower.starts_with("http://localhost:1420")
        || lower.starts_with("http://127.0.0.1:1420")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_endpoint_accepts_valid_and_rejects_bad_ports_and_hosts() {
        assert_eq!(
            validate_endpoint("syncplay.pl:8999").unwrap(),
            "syncplay.pl:8999"
        );
        assert_eq!(validate_endpoint("[::1]:8999").unwrap(), "[::1]:8999");
        assert_eq!(
            validate_endpoint("[:::1]:8999"),
            Err(ValidationError::InvalidEndpointFormat)
        );
        assert_eq!(
            validate_endpoint("http://syncplay.pl:8999"),
            Err(ValidationError::InvalidEndpointFormat)
        );
        assert_eq!(
            validate_endpoint("syncplay.pl:0"),
            Err(ValidationError::InvalidEndpointFormat)
        );
        assert_eq!(
            validate_endpoint("syncplay.pl:70000"),
            Err(ValidationError::InvalidEndpointFormat)
        );
    }

    #[test]
    fn test_validate_local_path_rejects_schemes_unc_devices_and_bidi() {
        assert!(validate_local_path_syntax(r"C:\Videos\movie.mkv").is_ok());
        assert!(validate_local_path_syntax(r"\\?\C:\Videos\movie.mkv").is_ok());
        assert!(validate_local_path_syntax("http://evil.example/movie.mkv").is_err());
        assert!(validate_local_path_syntax(r"\\.\PhysicalDrive0").is_err());
        assert!(validate_local_path_syntax(r"\\server\share\movie.mkv").is_err());
        assert!(validate_local_path_syntax(r"\\?\UNC\server\share\movie.mkv").is_err());
        assert!(validate_local_path_syntax("C:\\Videos\\\u{202E}evil.mkv").is_err());
    }

    #[test]
    fn test_validate_local_path_opt_in_unc_shares() {
        let opts = LocalPathOptions {
            allow_network_shares: true,
        };
        assert_eq!(
            validate_local_path_syntax_with_options(r"\\nas\media\movie.mkv", opts).unwrap(),
            r"\\nas\media\movie.mkv"
        );
        // Device paths and internet schemes remain blocked even when NAS shares are enabled
        assert!(validate_local_path_syntax_with_options(r"\\.\pipe\mpv", opts).is_err());
        assert!(validate_local_path_syntax_with_options("https://nas/movie.mkv", opts).is_err());
        assert!(validate_local_path_syntax_with_options(r"\\nas\onlyshare", opts).is_err());
    }

    #[test]
    fn test_sanitize_username_and_colors() {
        assert_eq!(sanitize_username("  Ahmed \u{202E} ").unwrap(), "Ahmed");
        assert!(sanitize_username("   ").is_err());
        assert_eq!(sanitize_hex_color("#e5a93c").unwrap(), "#E5A93C");
        assert!(sanitize_hex_color("red").is_err());
    }

    #[test]
    fn test_playback_speed_aspect_and_osd_sanitization() {
        assert_eq!(sanitize_playback_speed(1.25).unwrap(), 1.25);
        assert!(sanitize_playback_speed(f64::NAN).is_err());
        assert!(sanitize_playback_speed(5.0).is_err());
        assert_eq!(sanitize_aspect_mode("21:9").unwrap(), "21:9");
        assert!(sanitize_aspect_mode("99:1").is_err());
        assert_eq!(sanitize_osd_text("Hello\n\u{202E}World"), "Hello World");
    }

    #[test]
    fn test_webview_navigation_allowlist() {
        assert!(is_allowed_webview_url("tauri://localhost/index.html"));
        assert!(is_allowed_webview_url("http://localhost:1420/"));
        assert!(!is_allowed_webview_url("https://evil.example/"));
        assert!(!is_allowed_webview_url("file:///C:/Windows/System32"));
    }
}
