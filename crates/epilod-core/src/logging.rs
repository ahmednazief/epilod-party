use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const MAX_RING_ENTRIES: usize = 500;
const MAX_MESSAGE_BYTES: usize = 1500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LogLevel {
    Error,
    Warn,
    Info,
    Debug,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub timestamp: String,
    pub level: LogLevel,
    pub target: String,
    pub code: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogsSnapshot {
    pub log_path: Option<String>,
    pub dropped_file_writes: u64,
    pub entries: Vec<LogEntry>,
}

pub fn format_utc_timestamp(now: SystemTime) -> String {
    let dur = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let total_secs = dur.as_secs() as i64;
    let millis = dur.subsec_millis();

    let days = total_secs.div_euclid(86_400);
    let secs_of_day = total_secs.rem_euclid(86_400);
    let hour = secs_of_day / 3_600;
    let minute = (secs_of_day % 3_600) / 60;
    let second = secs_of_day % 60;

    // Howard Hinnant civil_from_days
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    let year = y + if m <= 2 { 1 } else { 0 };

    format!("{year:04}-{m:02}-{d:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

pub fn sanitize_log_text(raw: &str) -> String {
    let mut cleaned = String::with_capacity(raw.len().min(MAX_MESSAGE_BYTES));
    for c in raw.chars() {
        if matches!(c, '\r' | '\n' | '\t') {
            cleaned.push(' ');
        } else if !c.is_control()
            && !matches!(
                c,
                '\u{00AD}'
                    | '\u{061C}'
                    | '\u{200B}'..='\u{200F}'
                    | '\u{202A}'..='\u{202E}'
                    | '\u{2060}'
                    | '\u{2066}'..='\u{2069}'
                    | '\u{FEFF}'
            )
        {
            cleaned.push(c);
        }
    }
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let redacted = redact_secrets(&collapsed);
    if redacted.len() > MAX_MESSAGE_BYTES {
        let mut end = MAX_MESSAGE_BYTES;
        while end > 0 && !redacted.is_char_boundary(end) {
            end -= 1;
        }
        format!("{}…", &redacted[..end])
    } else if redacted.is_empty() {
        "Unknown error".to_string()
    } else {
        redacted
    }
}

fn redact_secrets(text: &str) -> String {
    let mut out = text.to_string();
    for key in ["password=", "Api-Key:", "Authorization:", "token="] {
        if let Some(idx) = out.to_ascii_lowercase().find(&key.to_ascii_lowercase()) {
            let prefix_end = idx + key.len();
            let rest = &out[prefix_end..];
            let token_len = rest
                .find(|c: char| c.is_whitespace() || c == '&' || c == '"' || c == '\'')
                .unwrap_or(rest.len());
            let mut replaced = String::with_capacity(out.len());
            replaced.push_str(&out[..prefix_end]);
            replaced.push_str("[REDACTED]");
            replaced.push_str(&out[prefix_end + token_len..]);
            out = replaced;
        }
    }
    out
}

pub struct LogRateLimiter {
    window: Duration,
    max_per_window: usize,
    timestamps: VecDeque<Instant>,
    suppressed: u64,
}

impl LogRateLimiter {
    pub fn new(max_per_window: usize, window: Duration) -> Self {
        Self {
            window,
            max_per_window,
            timestamps: VecDeque::new(),
            suppressed: 0,
        }
    }

    pub fn allow(&mut self, now: Instant) -> (bool, u64) {
        while let Some(&front) = self.timestamps.front() {
            if now.duration_since(front) >= self.window {
                self.timestamps.pop_front();
            } else {
                break;
            }
        }
        if self.timestamps.len() >= self.max_per_window {
            self.suppressed += 1;
            return (false, 0);
        }
        self.timestamps.push_back(now);
        let drained = self.suppressed;
        self.suppressed = 0;
        (true, drained)
    }
}

pub struct RingLogger {
    entries: VecDeque<LogEntry>,
    max_entries: usize,
    log_path: Option<PathBuf>,
    max_file_bytes: u64,
    dropped_file_writes: u64,
    limiter: LogRateLimiter,
}

impl RingLogger {
    pub fn new(log_path: Option<PathBuf>, max_file_bytes: u64) -> Self {
        Self {
            entries: VecDeque::with_capacity(MAX_RING_ENTRIES),
            max_entries: MAX_RING_ENTRIES,
            log_path,
            max_file_bytes: max_file_bytes.max(4096),
            dropped_file_writes: 0,
            limiter: LogRateLimiter::new(40, Duration::from_secs(2)),
        }
    }

    pub fn log(
        &mut self,
        level: LogLevel,
        target: &str,
        code: Option<&str>,
        message: &str,
        now_sys: SystemTime,
        now_mono: Instant,
    ) {
        let (allowed, suppressed) = self.limiter.allow(now_mono);
        if !allowed {
            return;
        }
        if suppressed > 0 {
            let notice = LogEntry {
                timestamp: format_utc_timestamp(now_sys),
                level: LogLevel::Warn,
                target: "logger".to_string(),
                code: Some("LOG_SUPPRESSED".to_string()),
                message: format!("{suppressed} repeated log entries suppressed"),
            };
            self.push_entry(notice);
        }

        let entry = LogEntry {
            timestamp: format_utc_timestamp(now_sys),
            level,
            target: sanitize_log_text(target),
            code: code.map(sanitize_log_text),
            message: sanitize_log_text(message),
        };
        self.push_entry(entry);
    }

    fn push_entry(&mut self, entry: LogEntry) {
        if self.entries.len() >= self.max_entries {
            self.entries.pop_front();
        }
        self.write_entry_to_disk(&entry);
        self.entries.push_back(entry);
    }

    fn write_entry_to_disk(&mut self, entry: &LogEntry) {
        let Some(ref path) = self.log_path else {
            return;
        };
        if let Some(parent) = path.parent() {
            if fs::create_dir_all(parent).is_err() {
                self.dropped_file_writes += 1;
                return;
            }
        }
        if let Ok(meta) = fs::metadata(path) {
            if meta.len() >= self.max_file_bytes {
                let backup = backup_path(path);
                let _ = fs::remove_file(&backup);
                if fs::rename(path, &backup).is_err() {
                    let _ = File::create(path);
                }
            }
        }
        match OpenOptions::new().create(true).append(true).open(path) {
            Ok(mut f) => {
                let code_part = entry
                    .code
                    .as_deref()
                    .map(|c| format!(" [{c}]"))
                    .unwrap_or_default();
                let line = format!(
                    "[{}] [{:?}] [{}]{} {}\n",
                    entry.timestamp, entry.level, entry.target, code_part, entry.message
                );
                if f.write_all(line.as_bytes()).is_err() {
                    self.dropped_file_writes += 1;
                }
            }
            Err(_) => {
                self.dropped_file_writes += 1;
            }
        }
    }

    pub fn snapshot(&self, limit: usize) -> LogsSnapshot {
        let cap = limit.clamp(1, self.max_entries);
        let skip = self.entries.len().saturating_sub(cap);
        LogsSnapshot {
            log_path: self
                .log_path
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            dropped_file_writes: self.dropped_file_writes,
            entries: self.entries.iter().skip(skip).cloned().collect(),
        }
    }
}

fn backup_path(path: &Path) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(".1");
    PathBuf::from(os)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_utc_timestamp_iso_epoch_and_known_date() {
        assert_eq!(format_utc_timestamp(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let known = UNIX_EPOCH + Duration::from_millis(1_700_000_000_123);
        assert_eq!(format_utc_timestamp(known), "2023-11-14T22:13:20.123Z");
    }

    #[test]
    fn test_sanitize_log_text_prevents_injection_and_redacts_secrets() {
        let raw = "line1\r\nFAKE [ERROR]\u{202E} password=supersecret token=abc123";
        let clean = sanitize_log_text(raw);
        assert!(!clean.contains('\n'));
        assert!(!clean.contains('\u{202E}'));
        assert!(!clean.contains("supersecret"));
        assert!(!clean.contains("abc123"));
        assert!(clean.contains("[REDACTED]"));
    }

    #[test]
    fn test_rate_limiter_drops_excess_burst_and_reports_suppressed() {
        let mut lim = LogRateLimiter::new(2, Duration::from_secs(2));
        let t0 = Instant::now();
        assert_eq!(lim.allow(t0), (true, 0));
        assert_eq!(lim.allow(t0 + Duration::from_millis(10)), (true, 0));
        assert_eq!(lim.allow(t0 + Duration::from_millis(20)), (false, 0));
        assert_eq!(lim.allow(t0 + Duration::from_millis(30)), (false, 0));
        assert_eq!(lim.allow(t0 + Duration::from_millis(2100)), (true, 2));
    }

    #[test]
    fn test_logger_ring_buffer_and_file_rotation() {
        let dir = std::env::temp_dir().join(format!(
            "epilod_log_test_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let log_file = dir.join("epilod.log");
        let mut logger = RingLogger::new(Some(log_file.clone()), 4096);
        let t0 = Instant::now();
        for i in 0..80 {
            logger.log(
                LogLevel::Info,
                "test",
                Some("CODE"),
                &format!("message payload number {i:03} with padding to trigger rotation cleanly"),
                UNIX_EPOCH + Duration::from_secs(i),
                t0 + Duration::from_secs(i),
            );
        }
        let snap = logger.snapshot(10);
        assert_eq!(snap.entries.len(), 10);
        assert_eq!(snap.dropped_file_writes, 0);
        assert!(backup_path(&log_file).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
