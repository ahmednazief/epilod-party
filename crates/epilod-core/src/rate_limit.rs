use std::collections::{HashMap, VecDeque};
use std::time::{Duration, Instant};

#[derive(Debug, Default)]
pub struct CommandRateGuard {
    windows: HashMap<String, VecDeque<Instant>>,
    last_signature: HashMap<String, (String, Instant)>,
}

impl CommandRateGuard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allow(&mut self, bucket: &str, limit: usize, window: Duration, now: Instant) -> bool {
        if limit == 0 {
            return false;
        }
        let q = self.windows.entry(bucket.to_string()).or_default();
        while let Some(&front) = q.front() {
            if now.duration_since(front) >= window {
                q.pop_front();
            } else {
                break;
            }
        }
        if q.len() >= limit {
            return false;
        }
        q.push_back(now);
        true
    }

    pub fn is_duplicate_within(
        &mut self,
        bucket: &str,
        signature: &str,
        cooldown: Duration,
        now: Instant,
    ) -> bool {
        if let Some((prev_sig, prev_at)) = self.last_signature.get(bucket) {
            if prev_sig == signature && now.duration_since(*prev_at) < cooldown {
                return true;
            }
        }
        self.last_signature
            .insert(bucket.to_string(), (signature.to_string(), now));
        false
    }

    pub fn clear_dedup_if_matches(&mut self, bucket: &str, signature: &str) {
        let should_remove = self
            .last_signature
            .get(bucket)
            .map(|(sig, _)| sig == signature)
            .unwrap_or(false);
        if should_remove {
            self.last_signature.remove(bucket);
        }
    }

    pub fn reset_bucket(&mut self, bucket: &str) {
        self.windows.remove(bucket);
        self.last_signature.remove(bucket);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rate_guard_blocks_burst_and_recovers_after_window() {
        let mut guard = CommandRateGuard::new();
        let t0 = Instant::now();
        let win = Duration::from_secs(2);
        assert!(guard.allow("mpv_ctl", 2, win, t0));
        assert!(guard.allow("mpv_ctl", 2, win, t0 + Duration::from_millis(100)));
        assert!(!guard.allow("mpv_ctl", 2, win, t0 + Duration::from_millis(200)));
        assert!(guard.allow("mpv_ctl", 2, win, t0 + Duration::from_millis(2100)));
    }

    #[test]
    fn test_duplicate_signature_coalesced_within_cooldown() {
        let mut guard = CommandRateGuard::new();
        let t0 = Instant::now();
        let cd = Duration::from_millis(500);
        assert!(!guard.is_duplicate_within("mpv_load", "a.mkv", cd, t0));
        assert!(guard.is_duplicate_within(
            "mpv_load",
            "a.mkv",
            cd,
            t0 + Duration::from_millis(100)
        ));
        guard.clear_dedup_if_matches("mpv_load", "a.mkv");
        assert!(!guard.is_duplicate_within(
            "mpv_load",
            "a.mkv",
            cd,
            t0 + Duration::from_millis(150)
        ));
    }
}
