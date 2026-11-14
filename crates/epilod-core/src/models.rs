use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConnectionStatus {
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FileMatch {
    Exact,
    Renamed,
    DifferentEncode,
    Mismatch,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Participant {
    pub username: String,
    pub is_local: bool,
    pub is_ready: bool,
    pub file_name: Option<String>,
    pub file_size: Option<u64>,
    pub duration_secs: Option<f64>,
    pub file_match: FileMatch,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn participant_serializes_to_camel_case() {
        let p = Participant {
            username: "Viewer".to_string(),
            is_local: true,
            is_ready: false,
            file_name: Some("movie.mkv".to_string()),
            file_size: Some(1_048_576),
            duration_secs: Some(5400.5),
            file_match: FileMatch::Exact,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains("\"isLocal\":true"));
        assert!(json.contains("\"isReady\":false"));
        assert!(json.contains("\"fileName\":\"movie.mkv\""));
        assert!(json.contains("\"fileSize\":1048576"));
        assert!(json.contains("\"durationSecs\":5400.5"));
        assert!(json.contains("\"fileMatch\":\"exact\""));
    }
}
