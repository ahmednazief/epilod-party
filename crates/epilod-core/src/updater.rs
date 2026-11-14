use crate::ed25519::{decode_hex_fixed, ed25519_verify};
use crate::validation::has_unsafe_unicode;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::path::Path;
use thiserror::Error;

pub const CURRENT_APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const EMBEDDED_UPDATE_PUBKEY_HEX: Option<&str> = option_env!("EPILOD_UPDATE_PUBKEY");
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/ahmednazief/epilod-party/releases/latest/download/epilod-update-manifest.json";
pub const DEFAULT_RELEASES_API_URL: &str =
    "https://api.github.com/repos/ahmednazief/epilod-party/releases/latest";
pub const REPO_PATH_PREFIX: &str = "/ahmednazief/epilod-party/";
pub const MAX_MANIFEST_BYTES: usize = 512 * 1024;
pub const MIN_INSTALLER_BYTES: u64 = 64 * 1024;
pub const MAX_INSTALLER_BYTES: u64 = 1024 * 1024 * 1024;
pub const MAX_REDIRECTS: usize = 6;
pub const STALE_PART_TTL_SECS: u64 = 7 * 24 * 60 * 60;

pub const ALLOWED_UPDATE_HOSTS: &[&str] = &[
    "github.com",
    "api.github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "github-releases.githubusercontent.com",
    "raw.githubusercontent.com",
];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum UpdateError {
    #[error("Update URL must be an official HTTPS Epilod Party release URL: {0}")]
    UntrustedUrl(String),
    #[error("Release manifest is too large or malformed JSON.")]
    InvalidManifest,
    #[error("Release manifest contains invalid version string: {0}")]
    InvalidVersion(String),
    #[error("Release manifest contains invalid SHA-256 digest.")]
    InvalidChecksum,
    #[error("Release manifest binary size ({0} bytes) is outside allowed bounds.")]
    InvalidSize(u64),
    #[error("Current version ({current}) cannot directly update to {target}; please install v{min_req} or later manually.")]
    UnsupportedDirectUpgrade {
        current: String,
        target: String,
        min_req: String,
    },
    #[error("Too many HTTP redirects while contacting update server.")]
    TooManyRedirects,
    #[error("HTTP {status} returned by update server.")]
    HttpStatus { status: u16 },
    #[error("Malformed HTTP response from update server: {0}")]
    MalformedHttp(String),
    #[error("Downloaded update failed verification: {0}")]
    VerificationFailed(String),
    #[error("I/O error during update: {0}")]
    Io(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseManifest {
    pub version: String,
    #[serde(default)]
    pub released_at: String,
    #[serde(default)]
    pub notes: String,
    pub download_url: String,
    pub sha256: String,
    pub size_bytes: u64,
    #[serde(default)]
    pub min_supported_version: Option<String>,
    #[serde(default)]
    pub file_name: Option<String>,
    #[serde(default)]
    pub signature: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum UpdateAvailability {
    UpToDate,
    UpdateAvailable,
    DownloadedReady,
    UnsupportedUpgrade,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedHttpsUrl {
    pub host: String,
    pub port: u16,
    pub path_and_query: String,
    pub full_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedSemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

pub fn parse_semver(raw: &str) -> Option<ParsedSemVer> {
    let trimmed = raw.trim();
    let no_v = trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed);
    let clean = no_v.split('+').next()?.trim();
    let (core, pre) = match clean.split_once('-') {
        Some((c, p)) => {
            if p.trim().is_empty() {
                return None;
            }
            (c, Some(p.trim().to_string()))
        }
        None => (clean, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    if let Some(ref p) = pre {
        if !p
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        {
            return None;
        }
    }
    Some(ParsedSemVer {
        major,
        minor,
        patch,
        pre,
    })
}

pub fn compare_semver(a: &str, b: &str) -> Option<Ordering> {
    let va = parse_semver(a)?;
    let vb = parse_semver(b)?;
    match va.major.cmp(&vb.major) {
        Ordering::Equal => {}
        o => return Some(o),
    }
    match va.minor.cmp(&vb.minor) {
        Ordering::Equal => {}
        o => return Some(o),
    }
    match va.patch.cmp(&vb.patch) {
        Ordering::Equal => {}
        o => return Some(o),
    }
    match (&va.pre, &vb.pre) {
        (None, None) => Some(Ordering::Equal),
        (Some(_), None) => Some(Ordering::Less),
        (None, Some(_)) => Some(Ordering::Greater),
        (Some(pa), Some(pb)) => Some(compare_pre(pa, pb)),
    }
}

fn compare_pre(a: &str, b: &str) -> Ordering {
    let mut ia = a.split('.');
    let mut ib = b.split('.');
    loop {
        match (ia.next(), ib.next()) {
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
            (Some(sa), Some(sb)) => {
                let ord = match (sa.parse::<u64>(), sb.parse::<u64>()) {
                    (Ok(na), Ok(nb)) => na.cmp(&nb),
                    (Ok(_), Err(_)) => Ordering::Less,
                    (Err(_), Ok(_)) => Ordering::Greater,
                    (Err(_), Err(_)) => sa.cmp(sb),
                };
                if ord != Ordering::Equal {
                    return ord;
                }
            }
        }
    }
}

pub fn validate_https_url(
    raw: &str,
    allowed_hosts: &[&str],
) -> Result<ParsedHttpsUrl, UpdateError> {
    let trimmed = raw.trim();
    if trimmed.is_empty()
        || trimmed.len() > 2048
        || has_unsafe_unicode(trimmed)
        || trimmed.chars().any(|c| c.is_whitespace())
    {
        return Err(UpdateError::UntrustedUrl(trimmed.to_string()));
    }

    let rest = trimmed
        .strip_prefix("https://")
        .ok_or_else(|| UpdateError::UntrustedUrl(trimmed.to_string()))?;

    let (authority, path_and_query) = match rest.find('/') {
        Some(idx) => {
            let p = &rest[idx..];
            if p.contains('#') {
                return Err(UpdateError::UntrustedUrl(trimmed.to_string()));
            }
            (&rest[..idx], p.to_string())
        }
        None => (rest, "/".to_string()),
    };

    if authority.is_empty() || authority.contains('@') {
        return Err(UpdateError::UntrustedUrl(trimmed.to_string()));
    }

    let (host, port) = if let Some((h, p_str)) = authority.split_once(':') {
        let port = p_str
            .parse::<u16>()
            .map_err(|_| UpdateError::UntrustedUrl(trimmed.to_string()))?;
        if port != 443 {
            return Err(UpdateError::UntrustedUrl(trimmed.to_string()));
        }
        (h.to_ascii_lowercase(), port)
    } else {
        (authority.to_ascii_lowercase(), 443)
    };

    let host_ok = allowed_hosts
        .iter()
        .any(|allowed| host == allowed.to_ascii_lowercase());
    if !host_ok {
        return Err(UpdateError::UntrustedUrl(trimmed.to_string()));
    }

    // Scope primary GitHub/API paths strictly to our repository
    if host == "github.com" && !path_and_query.starts_with(REPO_PATH_PREFIX) {
        return Err(UpdateError::UntrustedUrl(trimmed.to_string()));
    }
    if host == "api.github.com" && !path_and_query.starts_with("/repos/ahmednazief/epilod-party/") {
        return Err(UpdateError::UntrustedUrl(trimmed.to_string()));
    }

    Ok(ParsedHttpsUrl {
        host,
        port,
        path_and_query,
        full_url: trimmed.to_string(),
    })
}

pub fn resolve_redirect_url(
    current: &ParsedHttpsUrl,
    location: &str,
    allowed_hosts: &[&str],
) -> Result<ParsedHttpsUrl, UpdateError> {
    let loc = location.trim();
    if loc.is_empty() || has_unsafe_unicode(loc) {
        return Err(UpdateError::UntrustedUrl(loc.to_string()));
    }
    if loc.starts_with('/') {
        let joined = format!("https://{}{}", current.host, loc);
        validate_https_url(&joined, allowed_hosts)
    } else {
        validate_https_url(loc, allowed_hosts)
    }
}

pub fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn manifest_signing_message(manifest: &ReleaseManifest) -> Vec<u8> {
    let norm_version = match parse_semver(&manifest.version) {
        Some(parsed) => match parsed.pre {
            Some(p) => format!("{}.{}.{}-{p}", parsed.major, parsed.minor, parsed.patch),
            None => format!("{}.{}.{}", parsed.major, parsed.minor, parsed.patch),
        },
        None => manifest
            .version
            .trim()
            .trim_start_matches(['v', 'V'])
            .to_string(),
    };
    let norm_released_at = manifest.released_at.trim();
    let norm_download_url = manifest.download_url.trim();
    let norm_sha256 = manifest.sha256.trim().to_ascii_lowercase();
    let norm_min_ver = manifest
        .min_supported_version
        .as_deref()
        .map(str::trim)
        .unwrap_or("");
    let norm_file_name = manifest.file_name.as_deref().map(str::trim).unwrap_or("");
    format!(
        "epilod-update-manifest-v1\nversion={norm_version}\nreleasedAt={norm_released_at}\ndownloadUrl={norm_download_url}\nsha256={norm_sha256}\nsizeBytes={}\nminSupportedVersion={norm_min_ver}\nfileName={norm_file_name}\n",
        manifest.size_bytes
    )
    .into_bytes()
}

/// Verifies an optional Ed25519 manifest signature against a trusted 32-byte hex public key.
/// Returns `Ok(true)` if verified against `trusted_pubkey_hex`, `Ok(false)` if no key is pinned,
/// or `Err(VerificationFailed)` if the key is pinned and signature is missing/invalid, or if a
/// present signature string is malformed.
pub fn verify_manifest_signature_with_pubkey(
    manifest: &ReleaseManifest,
    trusted_pubkey_hex: Option<&str>,
) -> Result<bool, UpdateError> {
    let trimmed_sig = manifest
        .signature
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let parsed_sig = match trimmed_sig {
        Some(hex_sig) => Some(decode_hex_fixed::<64>(hex_sig).map_err(|e| {
            UpdateError::VerificationFailed(format!(
                "Malformed Ed25519 signature in release manifest: {e}"
            ))
        })?),
        None => None,
    };

    let Some(pubkey_hex) = trusted_pubkey_hex.map(str::trim).filter(|s| !s.is_empty()) else {
        return Ok(false);
    };

    let pubkey = decode_hex_fixed::<32>(pubkey_hex).map_err(|e| {
        UpdateError::VerificationFailed(format!("Configured update public key is invalid: {e}"))
    })?;
    let sig = parsed_sig.ok_or_else(|| {
        UpdateError::VerificationFailed(
            "Release manifest is missing required Ed25519 signature.".into(),
        )
    })?;

    let msg = manifest_signing_message(manifest);
    ed25519_verify(&pubkey, &msg, &sig).map_err(|e| {
        UpdateError::VerificationFailed(format!("Manifest signature rejected: {e}"))
    })?;
    Ok(true)
}

pub fn parse_and_validate_manifest_with_pubkey(
    bytes: &[u8],
    current_version: &str,
    trusted_pubkey_hex: Option<&str>,
) -> Result<(ReleaseManifest, UpdateAvailability, bool), UpdateError> {
    if bytes.is_empty() || bytes.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::InvalidManifest);
    }

    let mut manifest: ReleaseManifest =
        serde_json::from_slice(bytes).map_err(|_| UpdateError::InvalidManifest)?;

    let parsed_remote = parse_semver(&manifest.version)
        .ok_or_else(|| UpdateError::InvalidVersion(manifest.version.clone()))?;
    manifest.version = match parsed_remote.pre {
        Some(p) => format!(
            "{}.{}.{}-{p}",
            parsed_remote.major, parsed_remote.minor, parsed_remote.patch
        ),
        None => format!(
            "{}.{}.{}",
            parsed_remote.major, parsed_remote.minor, parsed_remote.patch
        ),
    };

    manifest.sha256 = manifest.sha256.trim().to_ascii_lowercase();
    if !is_valid_sha256_hex(&manifest.sha256) {
        return Err(UpdateError::InvalidChecksum);
    }

    if manifest.size_bytes < MIN_INSTALLER_BYTES || manifest.size_bytes > MAX_INSTALLER_BYTES {
        return Err(UpdateError::InvalidSize(manifest.size_bytes));
    }

    validate_https_url(&manifest.download_url, ALLOWED_UPDATE_HOSTS)?;

    let signature_verified = verify_manifest_signature_with_pubkey(&manifest, trusted_pubkey_hex)?;

    let cmp = compare_semver(&manifest.version, current_version)
        .ok_or_else(|| UpdateError::InvalidVersion(current_version.to_string()))?;
    if cmp != Ordering::Greater {
        return Ok((manifest, UpdateAvailability::UpToDate, signature_verified));
    }

    if let Some(ref min_ver) = manifest.min_supported_version {
        if let Some(min_cmp) = compare_semver(current_version, min_ver) {
            if min_cmp == Ordering::Less {
                return Err(UpdateError::UnsupportedDirectUpgrade {
                    current: current_version.to_string(),
                    target: manifest.version.clone(),
                    min_req: min_ver.clone(),
                });
            }
        }
    }

    Ok((
        manifest,
        UpdateAvailability::UpdateAvailable,
        signature_verified,
    ))
}

pub fn parse_and_validate_manifest_with_signature(
    bytes: &[u8],
    current_version: &str,
) -> Result<(ReleaseManifest, UpdateAvailability, bool), UpdateError> {
    parse_and_validate_manifest_with_pubkey(bytes, current_version, EMBEDDED_UPDATE_PUBKEY_HEX)
}

pub fn parse_and_validate_manifest(
    bytes: &[u8],
    current_version: &str,
) -> Result<(ReleaseManifest, UpdateAvailability), UpdateError> {
    let (manifest, availability, _) =
        parse_and_validate_manifest_with_signature(bytes, current_version)?;
    Ok((manifest, availability))
}

#[derive(Deserialize)]
struct GitHubReleaseApiAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Deserialize)]
struct GitHubReleaseApiResponse {
    #[serde(default)]
    assets: Vec<GitHubReleaseApiAsset>,
}

/// Extracts `epilod-update-manifest.json` URL if a fallback GitHub Releases API response is parsed.
pub fn extract_manifest_url_from_github_release(
    api_json: &[u8],
) -> Result<Option<String>, UpdateError> {
    if api_json.len() > MAX_MANIFEST_BYTES {
        return Err(UpdateError::InvalidManifest);
    }
    let rel: GitHubReleaseApiResponse =
        serde_json::from_slice(api_json).map_err(|_| UpdateError::InvalidManifest)?;
    for asset in rel.assets {
        if asset
            .name
            .eq_ignore_ascii_case("epilod-update-manifest.json")
        {
            let parsed = validate_https_url(&asset.browser_download_url, ALLOWED_UPDATE_HOSTS)?;
            return Ok(Some(parsed.full_url));
        }
    }
    Ok(None)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentRange {
    pub start: Option<u64>,
    pub end: Option<u64>,
    pub total: Option<u64>,
}

pub fn parse_content_range(raw: &str) -> Option<ContentRange> {
    let trimmed = raw.trim();
    let rest = trimmed
        .strip_prefix("bytes ")
        .or_else(|| trimmed.strip_prefix("BYTES "))?
        .trim();
    let (range_part, total_part) = rest.split_once('/')?;
    let total = match total_part.trim() {
        "*" => None,
        s => Some(s.parse::<u64>().ok()?),
    };
    let range_part = range_part.trim();
    if range_part == "*" {
        return Some(ContentRange {
            start: None,
            end: None,
            total,
        });
    }
    let (start_s, end_s) = range_part.split_once('-')?;
    let start = start_s.trim().parse::<u64>().ok()?;
    let end = end_s.trim().parse::<u64>().ok()?;
    if end < start {
        return None;
    }
    if let Some(t) = total {
        if end >= t {
            return None;
        }
    }
    Some(ContentRange {
        start: Some(start),
        end: Some(end),
        total,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponseHead {
    pub status: u16,
    pub content_length: Option<u64>,
    pub content_range: Option<ContentRange>,
    pub chunked: bool,
    pub accept_ranges_bytes: bool,
    pub location: Option<String>,
    pub body_offset: usize,
}

pub fn find_http_header_end(buf: &[u8]) -> Option<(usize, usize)> {
    if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
        return Some((pos, pos + 4));
    }
    if let Some(pos) = buf.windows(2).position(|w| w == b"\n\n") {
        return Some((pos, pos + 2));
    }
    None
}

pub fn parse_http_head(buf: &[u8]) -> Result<HttpResponseHead, UpdateError> {
    let (head_end, body_offset) = find_http_header_end(buf)
        .ok_or_else(|| UpdateError::MalformedHttp("Missing header terminator".into()))?;
    let head_str = std::str::from_utf8(&buf[..head_end])
        .map_err(|_| UpdateError::MalformedHttp("Non-UTF8 HTTP headers".into()))?;
    let mut lines = head_str.lines();
    let status_line = lines
        .next()
        .ok_or_else(|| UpdateError::MalformedHttp("Empty status line".into()))?;
    let mut parts = status_line.split_whitespace();
    let _http_ver = parts
        .next()
        .filter(|p| p.starts_with("HTTP/1."))
        .ok_or_else(|| UpdateError::MalformedHttp(format!("Bad status line: {status_line}")))?;
    let status = parts
        .next()
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| UpdateError::MalformedHttp(format!("Bad status code: {status_line}")))?;

    let mut content_length = None;
    let mut content_range = None;
    let mut chunked = false;
    let mut accept_ranges_bytes = false;
    let mut location = None;

    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let key = name.trim().to_ascii_lowercase();
            let val = value.trim();
            match key.as_str() {
                "content-length" => {
                    if let Ok(len) = val.parse::<u64>() {
                        content_length = Some(len);
                    }
                }
                "content-range" => {
                    content_range = parse_content_range(val);
                }
                "transfer-encoding" => {
                    if val.to_ascii_lowercase().contains("chunked") {
                        chunked = true;
                    }
                }
                "accept-ranges" => {
                    if val.eq_ignore_ascii_case("bytes") {
                        accept_ranges_bytes = true;
                    }
                }
                "location" if location.is_none() => {
                    location = Some(val.to_string());
                }
                _ => {}
            }
        }
    }

    Ok(HttpResponseHead {
        status,
        content_length,
        content_range,
        chunked,
        accept_ranges_bytes,
        location,
        body_offset,
    })
}

/// Incremental HTTP/1.1 Transfer-Encoding: chunked decoder for bounded memory streaming.
#[derive(Debug, Default)]
pub struct ChunkedDecoder {
    buf: Vec<u8>,
    remaining_in_chunk: usize,
    expect_chunk_crlf: bool,
    finished: bool,
}

impl ChunkedDecoder {
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn push(&mut self, incoming: &[u8]) -> Result<Vec<u8>, UpdateError> {
        if !incoming.is_empty() {
            self.buf.extend_from_slice(incoming);
        }
        let mut out = Vec::new();
        while !self.finished {
            if self.remaining_in_chunk > 0 {
                if self.buf.is_empty() {
                    break;
                }
                let take = self.remaining_in_chunk.min(self.buf.len());
                out.extend_from_slice(&self.buf[..take]);
                self.buf.drain(..take);
                self.remaining_in_chunk -= take;
                if self.remaining_in_chunk == 0 {
                    self.expect_chunk_crlf = true;
                }
                continue;
            }

            if self.expect_chunk_crlf {
                if self.buf.len() < 2 {
                    break;
                }
                if &self.buf[..2] == b"\r\n" {
                    self.buf.drain(..2);
                    self.expect_chunk_crlf = false;
                } else if self.buf[0] == b'\n' {
                    self.buf.drain(..1);
                    self.expect_chunk_crlf = false;
                } else {
                    return Err(UpdateError::MalformedHttp(
                        "Invalid chunk terminator CRLF".into(),
                    ));
                }
                continue;
            }

            // Read chunk size line terminated by \r\n or \n
            let Some(eol) = self.buf.iter().position(|&b| b == b'\n') else {
                if self.buf.len() > 256 {
                    return Err(UpdateError::MalformedHttp("Oversized chunk header".into()));
                }
                break;
            };
            let line_bytes = self.buf.drain(..=eol).collect::<Vec<u8>>();
            let line = std::str::from_utf8(&line_bytes)
                .map_err(|_| UpdateError::MalformedHttp("Non-UTF8 chunk header".into()))?
                .trim();
            let hex_part = line.split(';').next().unwrap_or("").trim();
            let size = usize::from_str_radix(hex_part, 16)
                .map_err(|_| UpdateError::MalformedHttp(format!("Bad chunk size '{hex_part}'")))?;
            if size == 0 {
                self.finished = true;
                break;
            }
            self.remaining_in_chunk = size;
        }
        Ok(out)
    }
}

pub fn safe_version_filename_token(version: &str) -> String {
    let token: String = version
        .trim()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if token.is_empty() {
        "0.0.0".to_string()
    } else {
        token
    }
}

pub fn compute_file_sha256_hex(path: &Path) -> Result<(u64, String), UpdateError> {
    let file = File::open(path).map_err(|e| UpdateError::Io(e.to_string()))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    let mut total = 0u64;
    loop {
        let n = reader
            .read(&mut buf)
            .map_err(|e| UpdateError::Io(e.to_string()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total = total.saturating_add(n as u64);
    }
    let digest = hasher.finalize();
    let mut hex = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        let _ = write!(&mut hex, "{b:02x}");
    }
    Ok((total, hex))
}

pub fn verify_downloaded_installer(
    path: &Path,
    expected_size: u64,
    expected_sha256: &str,
) -> Result<(), UpdateError> {
    if !path.is_file() {
        return Err(UpdateError::VerificationFailed(
            "Downloaded installer file missing".into(),
        ));
    }
    let (actual_size, actual_hash) = compute_file_sha256_hex(path)?;
    if actual_size != expected_size {
        return Err(UpdateError::VerificationFailed(format!(
            "Size mismatch (expected {expected_size} B, got {actual_size} B)"
        )));
    }
    let expected_lower = expected_sha256.trim().to_ascii_lowercase();
    if actual_hash != expected_lower {
        return Err(UpdateError::VerificationFailed(format!(
            "SHA-256 mismatch (expected {expected_lower}, got {actual_hash})"
        )));
    }
    Ok(())
}

fn extract_part_version_token(name: &str) -> Option<&str> {
    name.strip_prefix("Epilod Party Setup-").and_then(|s| {
        s.strip_suffix(".exe.part")
            .or_else(|| s.strip_suffix(".exe.part.meta.json"))
    })
}

fn is_file_expired(path: &Path, now_unix: u64) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|mt| mt.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| now_unix.saturating_sub(d.as_secs()) >= STALE_PART_TTL_SECS)
        .unwrap_or(false)
}

/// Cleans obsolete cached installers (already installed versions, superseded future versions,
/// expired `.part` files, and orphaned `.part.meta.json` files).
pub fn cleanup_update_cache_with_keep(
    cache_dir: &Path,
    current_version: &str,
    keep_latest_version: Option<&str>,
    now_unix: u64,
) {
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return;
    };
    let paths: Vec<(std::path::PathBuf, String)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.is_file() {
                Some((p, e.file_name().to_string_lossy().into_owned()))
            } else {
                None
            }
        })
        .collect();

    // Determine the sole future version to preserve if multiple cached versions exist.
    let mut best_future: Option<String> = keep_latest_version
        .map(str::trim)
        .filter(|v| {
            compare_semver(v, current_version)
                .map(|ord| ord == Ordering::Greater)
                .unwrap_or(false)
        })
        .map(safe_version_filename_token);

    if best_future.is_none() {
        for (_, name) in &paths {
            let ver_opt = name
                .strip_prefix("update-ready-")
                .and_then(|s| s.strip_suffix(".json"))
                .or_else(|| {
                    name.strip_prefix("Epilod Party Setup-")
                        .and_then(|s| s.strip_suffix(".exe"))
                });
            if let Some(ver_part) = ver_opt {
                let is_future = compare_semver(ver_part, current_version)
                    .map(|ord| ord == Ordering::Greater)
                    .unwrap_or(false);
                if is_future {
                    let replace = match best_future.as_deref() {
                        Some(cur_best) => {
                            compare_semver(ver_part, cur_best) == Some(Ordering::Greater)
                        }
                        None => true,
                    };
                    if replace {
                        best_future = Some(ver_part.to_string());
                    }
                }
            }
        }
    }

    for (path, name) in paths {
        if name.ends_with(".part") || name.ends_with(".part.meta.json") {
            let mut remove = is_file_expired(&path, now_unix);
            if let Some(meta_stem) = name.strip_suffix(".meta.json") {
                if !cache_dir.join(meta_stem).is_file() {
                    remove = true;
                }
            }
            if !remove {
                if let Some(ver_part) = extract_part_version_token(&name) {
                    if compare_semver(ver_part, current_version)
                        .map(|ord| ord != Ordering::Greater)
                        .unwrap_or(false)
                    {
                        remove = true;
                    } else if let Some(ref keep_ver) = best_future {
                        if compare_semver(ver_part, keep_ver) == Some(Ordering::Less) {
                            remove = true;
                        }
                    }
                }
            }
            if remove {
                let _ = fs::remove_file(&path);
                if name.ends_with(".part") {
                    let _ = fs::remove_file(cache_dir.join(format!("{name}.meta.json")));
                }
            }
            continue;
        }

        // Remove `update-ready-<ver>.json` + corresponding `Epilod Party Setup-<ver>.exe` if already applied
        // or superseded by a newer target version.
        if let Some(ver_part) = name
            .strip_prefix("update-ready-")
            .and_then(|s| s.strip_suffix(".json"))
        {
            let obsolete = compare_semver(ver_part, current_version)
                .map(|ord| ord != Ordering::Greater)
                .unwrap_or(false);
            let superseded = best_future
                .as_deref()
                .map(|keep_ver| ver_part != keep_ver)
                .unwrap_or(false);
            if obsolete || superseded {
                let _ = fs::remove_file(&path);
                let exe_name = format!("Epilod Party Setup-{ver_part}.exe");
                let _ = fs::remove_file(cache_dir.join(exe_name));
            }
        } else if let Some(ver_part) = name
            .strip_prefix("Epilod Party Setup-")
            .and_then(|s| s.strip_suffix(".exe"))
        {
            let obsolete = compare_semver(ver_part, current_version)
                .map(|ord| ord != Ordering::Greater)
                .unwrap_or(false);
            let superseded = best_future
                .as_deref()
                .map(|keep_ver| ver_part != keep_ver)
                .unwrap_or(false);
            if obsolete || superseded {
                let _ = fs::remove_file(&path);
            }
        }
    }
}

/// Cleans obsolete cached installers (already installed versions) and expired `.part` files.
pub fn cleanup_stale_update_cache(cache_dir: &Path, current_version: &str, now_unix: u64) {
    cleanup_update_cache_with_keep(cache_dir, current_version, None, now_unix);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ed25519::{ed25519_sign, encode_hex};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn sample_manifest_json(
        ver: &str,
        url: &str,
        sha: &str,
        size: u64,
        min_ver: Option<&str>,
    ) -> Vec<u8> {
        let obj = serde_json::json!({
            "version": ver,
            "releasedAt": "2026-11-14T12:00:00Z",
            "notes": "Reliability and updater improvements.",
            "downloadUrl": url,
            "sha256": sha,
            "sizeBytes": size,
            "minSupportedVersion": min_ver
        });
        serde_json::to_vec(&obj).unwrap()
    }

    #[test]
    fn url_allowlist_blocks_http_untrusted_domains_credentials_and_bad_redirects() {
        assert!(validate_https_url(DEFAULT_MANIFEST_URL, ALLOWED_UPDATE_HOSTS).is_ok());
        assert!(validate_https_url(
            "https://objects.githubusercontent.com/github-production-release-asset/12345",
            ALLOWED_UPDATE_HOSTS
        )
        .is_ok());

        // Must reject plaintext HTTP
        assert!(matches!(
            validate_https_url(
                "http://github.com/ahmednazief/epilod-party/releases/latest",
                ALLOWED_UPDATE_HOSTS
            ),
            Err(UpdateError::UntrustedUrl(_))
        ));
        // Must reject unrelated domains
        assert!(matches!(
            validate_https_url("https://evil.example/Epilod.exe", ALLOWED_UPDATE_HOSTS),
            Err(UpdateError::UntrustedUrl(_))
        ));
        // Must reject other repos on github.com
        assert!(matches!(
            validate_https_url(
                "https://github.com/otheruser/evil/releases/download/v1/x.exe",
                ALLOWED_UPDATE_HOSTS
            ),
            Err(UpdateError::UntrustedUrl(_))
        ));
        // Must reject embedded credentials
        assert!(matches!(
            validate_https_url(
                "https://user:pass@github.com/ahmednazief/epilod-party/x",
                ALLOWED_UPDATE_HOSTS
            ),
            Err(UpdateError::UntrustedUrl(_))
        ));

        // Redirect safety
        let cur = validate_https_url(DEFAULT_MANIFEST_URL, ALLOWED_UPDATE_HOSTS).unwrap();
        assert!(resolve_redirect_url(
            &cur,
            "https://objects.githubusercontent.com/abc",
            ALLOWED_UPDATE_HOSTS
        )
        .is_ok());
        assert!(
            resolve_redirect_url(&cur, "https://evil-cdn.net/abc", ALLOWED_UPDATE_HOSTS).is_err()
        );
        assert!(resolve_redirect_url(
            &cur,
            "http://objects.githubusercontent.com/abc",
            ALLOWED_UPDATE_HOSTS
        )
        .is_err());
    }

    #[test]
    fn manifest_validation_checks_semver_checksums_size_and_downgrade_prevention() {
        let sha = "a".repeat(64);
        let url = "https://github.com/ahmednazief/epilod-party/releases/download/v0.2.0/Epilod.Party.Setup.exe";

        let (_, avail) = parse_and_validate_manifest(
            &sample_manifest_json("v0.2.0", url, &sha, 94_000_000, None),
            "0.1.0",
        )
        .unwrap();
        assert_eq!(avail, UpdateAvailability::UpdateAvailable);

        // Same version -> UpToDate
        let (_, same) = parse_and_validate_manifest(
            &sample_manifest_json("0.1.0", url, &sha, 94_000_000, None),
            "0.1.0",
        )
        .unwrap();
        assert_eq!(same, UpdateAvailability::UpToDate);

        // Older version -> UpToDate (never downgrades automatically)
        let (_, older) = parse_and_validate_manifest(
            &sample_manifest_json("0.0.9", url, &sha, 94_000_000, None),
            "0.1.0",
        )
        .unwrap();
        assert_eq!(older, UpdateAvailability::UpToDate);

        // Enforce minSupportedVersion
        let err = parse_and_validate_manifest(
            &sample_manifest_json("0.5.0", url, &sha, 94_000_000, Some("0.3.0")),
            "0.1.0",
        )
        .unwrap_err();
        assert!(matches!(err, UpdateError::UnsupportedDirectUpgrade { .. }));

        // Invalid checksum
        assert_eq!(
            parse_and_validate_manifest(
                &sample_manifest_json("0.2.0", url, "bad", 94_000_000, None),
                "0.1.0"
            )
            .unwrap_err(),
            UpdateError::InvalidChecksum
        );
        // Too small
        assert_eq!(
            parse_and_validate_manifest(
                &sample_manifest_json("0.2.0", url, &sha, 100, None),
                "0.1.0"
            )
            .unwrap_err(),
            UpdateError::InvalidSize(100)
        );
    }

    #[test]
    fn manifest_signature_verification_enforces_pinned_pubkey_and_detects_tampering() {
        let seed = [0x42u8; 32];
        let mut manifest = ReleaseManifest {
            version: "0.2.0".into(),
            released_at: "2026-11-14T12:00:00Z".into(),
            notes: "Signed release".into(),
            download_url: "https://github.com/ahmednazief/epilod-party/releases/download/v0.2.0/Epilod.Party.Setup.exe".into(),
            sha256: "b".repeat(64),
            size_bytes: 94_000_000,
            min_supported_version: Some("0.1.0".into()),
            file_name: Some("Epilod.Party.Setup.exe".into()),
            signature: None,
        };
        let msg = manifest_signing_message(&manifest);
        let (pubkey, sig) = ed25519_sign(&seed, &msg);
        let pubkey_hex = encode_hex(&pubkey);
        manifest.signature = Some(encode_hex(&sig));

        let signed_json = serde_json::to_vec(&manifest).unwrap();
        let (_, avail, verified) =
            parse_and_validate_manifest_with_pubkey(&signed_json, "0.1.0", Some(&pubkey_hex))
                .unwrap();
        assert_eq!(avail, UpdateAvailability::UpdateAvailable);
        assert!(verified);

        // Unpinned build reports unverified (false) instead of false-positive trust
        let (_, _, unpinned_verified) =
            parse_and_validate_manifest_with_pubkey(&signed_json, "0.1.0", None).unwrap();
        assert!(!unpinned_verified);

        // Tampered hash fails signature check when pubkey is pinned
        let mut tampered = manifest.clone();
        tampered.sha256 = "c".repeat(64);
        let tampered_json = serde_json::to_vec(&tampered).unwrap();
        assert!(matches!(
            parse_and_validate_manifest_with_pubkey(&tampered_json, "0.1.0", Some(&pubkey_hex)),
            Err(UpdateError::VerificationFailed(_))
        ));

        // Missing signature fails when pubkey is pinned
        let mut unsigned = manifest.clone();
        unsigned.signature = None;
        let unsigned_json = serde_json::to_vec(&unsigned).unwrap();
        assert!(matches!(
            parse_and_validate_manifest_with_pubkey(&unsigned_json, "0.1.0", Some(&pubkey_hex)),
            Err(UpdateError::VerificationFailed(_))
        ));
    }

    #[test]
    fn http_head_and_chunked_decoder_handle_split_chunks_and_corruption() {
        let raw_resp = b"HTTP/1.1 206 Partial Content\r\nContent-Length: 5\r\nContent-Range: bytes 10-14/100\r\nAccept-Ranges: bytes\r\n\r\nhello";
        let head = parse_http_head(raw_resp).unwrap();
        assert_eq!(head.status, 206);
        assert_eq!(head.content_length, Some(5));
        assert_eq!(
            head.content_range,
            Some(ContentRange {
                start: Some(10),
                end: Some(14),
                total: Some(100),
            })
        );
        assert!(head.accept_ranges_bytes);
        assert_eq!(&raw_resp[head.body_offset..], b"hello");

        assert_eq!(
            parse_content_range("bytes */512"),
            Some(ContentRange {
                start: None,
                end: None,
                total: Some(512),
            })
        );
        assert_eq!(parse_content_range("bytes 20-10/100"), None);
        assert_eq!(parse_content_range("bytes 0-100/100"), None);

        let mut dec = ChunkedDecoder::default();
        let mut out = Vec::new();
        out.extend(dec.push(b"5\r\nhel").unwrap());
        assert!(!dec.is_finished());
        out.extend(dec.push(b"lo\r\n6;ext=1\r\n world\r\n0\r\n\r\n").unwrap());
        assert!(dec.is_finished());
        assert_eq!(out, b"hello world");

        let mut bad_dec = ChunkedDecoder::default();
        assert!(bad_dec.push(b"ZZZ\r\nabc\r\n").is_err());
    }

    #[test]
    fn verifies_installer_digest_and_cleans_stale_and_superseded_update_cache() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("epilod_updater_test_{nanos}"));
        fs::create_dir_all(&dir).unwrap();

        let setup_old = dir.join("Epilod Party Setup-0.1.0.exe");
        let meta_old = dir.join("update-ready-0.1.0.json");
        let setup_mid = dir.join("Epilod Party Setup-0.2.0.exe");
        let meta_mid = dir.join("update-ready-0.2.0.json");
        let setup_new = dir.join("Epilod Party Setup-0.3.0.exe");
        let meta_new = dir.join("update-ready-0.3.0.json");
        let orphan_part_meta = dir.join("Epilod Party Setup-0.3.0.exe.part.meta.json");

        fs::write(&setup_old, b"old-setup-bytes").unwrap();
        fs::write(&meta_old, b"{}").unwrap();
        fs::write(&setup_mid, b"mid-setup-bytes").unwrap();
        fs::write(&meta_mid, b"{}").unwrap();
        let new_bytes = vec![0x42u8; 70_000];
        fs::write(&setup_new, &new_bytes).unwrap();
        fs::write(&meta_new, b"{}").unwrap();
        fs::write(&orphan_part_meta, b"{}").unwrap();

        let (sz, digest) = compute_file_sha256_hex(&setup_new).unwrap();
        verify_downloaded_installer(&setup_new, sz, &digest).unwrap();
        assert!(verify_downloaded_installer(&setup_new, sz, &"0".repeat(64)).is_err());
        assert!(verify_downloaded_installer(&setup_new, sz + 1, &digest).is_err());

        cleanup_update_cache_with_keep(&dir, "0.1.0", Some("0.3.0"), 9_999_999);
        assert!(!setup_old.exists());
        assert!(!meta_old.exists());
        assert!(!setup_mid.exists());
        assert!(!meta_mid.exists());
        assert!(!orphan_part_meta.exists());
        assert!(setup_new.exists());
        assert!(meta_new.exists());

        let _ = fs::remove_dir_all(&dir);
    }
}
