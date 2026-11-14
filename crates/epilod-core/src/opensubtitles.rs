use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const MAX_SUBTITLE_ARCHIVE_BYTES: u64 = 16 * 1024 * 1024;
const ALLOWED_SUB_EXTS: &[&str] = &["srt", "ass", "ssa", "vtt", "sub"];

#[derive(Debug, Error, PartialEq, Eq)]
pub enum OpenSubtitlesError {
    #[error("OpenSubtitles API key cannot be blank.")]
    MissingApiKey,
    #[error("OpenSubtitles User-Agent cannot be blank.")]
    MissingUserAgent,
    #[error("Unsafe archive entry path rejected: {0}")]
    UnsafeArchivePath(String),
    #[error("Unsupported archive entry file type: {0}")]
    UnsupportedExtension(String),
    #[error("Archive entry exceeds 16 MiB safety limit.")]
    PayloadTooLarge,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchParams {
    pub query: Option<String>,
    pub moviehash: Option<String>,
    pub moviebytesize: Option<u64>,
    pub languages: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubtitleFileRef {
    pub file_id: u64,
    pub file_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubtitleAttributes {
    pub subtitle_id: Option<String>,
    pub language: Option<String>,
    pub download_count: Option<u64>,
    pub release: Option<String>,
    pub files: Vec<SubtitleFileRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubtitleItem {
    pub id: String,
    pub attributes: SubtitleAttributes,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubtitlesSearchResponse {
    pub total_count: Option<u64>,
    pub data: Vec<SubtitleItem>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadRequest {
    pub file_id: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DownloadResponse {
    pub link: String,
    pub file_name: Option<String>,
    pub remaining: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiErrorResponse {
    pub message: Option<String>,
    pub status: Option<u16>,
}

pub fn validate_headers(api_key: &str, user_agent: &str) -> Result<(), OpenSubtitlesError> {
    if api_key.trim().is_empty() {
        return Err(OpenSubtitlesError::MissingApiKey);
    }
    if user_agent.trim().is_empty() {
        return Err(OpenSubtitlesError::MissingUserAgent);
    }
    Ok(())
}

pub fn build_search_query_string(params: &SearchParams) -> String {
    let mut pairs: Vec<String> = Vec::new();
    if let Some(ref hash) = params.moviehash {
        let clean = hash.trim();
        if !clean.is_empty() {
            pairs.push(format!("moviehash={}", url_encode_component(clean)));
        }
    }
    if let Some(size) = params.moviebytesize {
        if size > 0 {
            pairs.push(format!("moviebytesize={size}"));
        }
    }
    if let Some(ref langs) = params.languages {
        let clean = langs.trim();
        if !clean.is_empty() {
            pairs.push(format!("languages={}", url_encode_component(clean)));
        }
    }
    if let Some(ref query) = params.query {
        let clean = query.trim();
        if !clean.is_empty() {
            pairs.push(format!("query={}", url_encode_component(clean)));
        }
    }
    pairs.join("&")
}

fn url_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b',') {
            out.push(b as char);
        } else if b == b' ' {
            out.push_str("%20");
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

pub fn validate_archive_entry_path(
    entry_path: &str,
    uncompressed_bytes: u64,
) -> Result<(), OpenSubtitlesError> {
    if uncompressed_bytes > MAX_SUBTITLE_ARCHIVE_BYTES {
        return Err(OpenSubtitlesError::PayloadTooLarge);
    }
    let trimmed = entry_path.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('/')
        || trimmed.starts_with('\\')
        || trimmed.contains('\0')
    {
        return Err(OpenSubtitlesError::UnsafeArchivePath(
            entry_path.to_string(),
        ));
    }
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(OpenSubtitlesError::UnsafeArchivePath(
            entry_path.to_string(),
        ));
    }
    for segment in trimmed.split(['/', '\\']) {
        if segment == ".." {
            return Err(OpenSubtitlesError::UnsafeArchivePath(
                entry_path.to_string(),
            ));
        }
    }
    let ext = trimmed
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if !ALLOWED_SUB_EXTS.contains(&ext.as_str()) {
        return Err(OpenSubtitlesError::UnsupportedExtension(ext));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_archive_entry_guard_blocks_zip_slip_and_executables() {
        assert!(validate_archive_entry_path("movie.ar.srt", 4096).is_ok());
        assert!(validate_archive_entry_path("subs/episode.ASS", 4096).is_ok());
        assert!(matches!(
            validate_archive_entry_path("../../evil.srt", 100),
            Err(OpenSubtitlesError::UnsafeArchivePath(_))
        ));
        assert!(matches!(
            validate_archive_entry_path("C:\\Windows\\evil.srt", 100),
            Err(OpenSubtitlesError::UnsafeArchivePath(_))
        ));
        assert!(matches!(
            validate_archive_entry_path("payload.exe", 100),
            Err(OpenSubtitlesError::UnsupportedExtension(_))
        ));
        assert_eq!(
            validate_archive_entry_path("huge.srt", MAX_SUBTITLE_ARCHIVE_BYTES + 1),
            Err(OpenSubtitlesError::PayloadTooLarge)
        );
    }

    #[test]
    fn test_header_and_query_builder() {
        assert_eq!(
            validate_headers("", "EpilodParty/0.1"),
            Err(OpenSubtitlesError::MissingApiKey)
        );
        assert!(validate_headers("key123", "EpilodParty/0.1").is_ok());
        let qs = build_search_query_string(&SearchParams {
            moviehash: Some("0123456789abcdef".into()),
            moviebytesize: Some(1_234_567),
            languages: Some("ar,en".into()),
            query: Some("My Movie".into()),
        });
        assert_eq!(
            qs,
            "moviehash=0123456789abcdef&moviebytesize=1234567&languages=ar,en&query=My%20Movie"
        );
    }
}
