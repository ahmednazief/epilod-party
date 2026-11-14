use serde::{Deserialize, Serialize};

pub const DURATION_TOLERANCE_SECS: f64 = 2.5;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileIdentity {
    pub name: String,
    pub size_bytes: Option<u64>,
    pub duration_secs: Option<f64>,
    pub is_hashed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FileMatchStatus {
    Matched,
    SameLengthDifferentEncode,
    DurationMismatch,
    DifferentFile,
    NoFile,
}

pub fn compare_files(local: Option<&FileIdentity>, peer: Option<&FileIdentity>) -> FileMatchStatus {
    let (Some(l), Some(p)) = (local, peer) else {
        return FileMatchStatus::NoFile;
    };

    if let (Some(ld), Some(pd)) = (l.duration_secs, p.duration_secs) {
        if ld.is_finite() && pd.is_finite() && (ld - pd).abs() > DURATION_TOLERANCE_SECS {
            return FileMatchStatus::DurationMismatch;
        }
    }

    let size_matches = match (l.size_bytes, p.size_bytes) {
        (Some(ls), Some(ps)) => ls == ps,
        _ => false,
    };

    let name_matches = if !l.is_hashed && !p.is_hashed {
        l.name.eq_ignore_ascii_case(&p.name)
    } else {
        l.name == p.name
    };

    if size_matches && name_matches {
        return FileMatchStatus::Matched;
    }

    // Fix 07: When duration is known and matches within tolerance (e.g. 1080p vs 720p encode),
    // report SameLengthDifferentEncode instead of alarming DifferentFile.
    if let (Some(ld), Some(pd)) = (l.duration_secs, p.duration_secs) {
        if ld.is_finite() && pd.is_finite() && (ld - pd).abs() <= DURATION_TOLERANCE_SECS {
            return FileMatchStatus::SameLengthDifferentEncode;
        }
    }

    FileMatchStatus::DifferentFile
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(name: &str, size: Option<u64>, dur: Option<f64>, hashed: bool) -> FileIdentity {
        FileIdentity {
            name: name.to_string(),
            size_bytes: size,
            duration_secs: dur,
            is_hashed: hashed,
        }
    }

    #[test]
    fn test_missing_local_or_peer_file() {
        let f = id("ep01.mkv", Some(500_000), Some(1440.0), false);
        assert_eq!(compare_files(None, Some(&f)), FileMatchStatus::NoFile);
        assert_eq!(compare_files(Some(&f), None), FileMatchStatus::NoFile);
    }

    #[test]
    fn test_exact_raw_file_match() {
        let a = id("Movie.mkv", Some(1_000_000), Some(5400.0), false);
        let b = id("movie.mkv", Some(1_000_000), Some(5400.5), false);
        assert_eq!(compare_files(Some(&a), Some(&b)), FileMatchStatus::Matched);
    }

    #[test]
    fn test_privacy_hashed_file_match() {
        let a = id("a1b2c3d4e5f6", Some(1_000_000), Some(5400.0), true);
        let b = id("a1b2c3d4e5f6", Some(1_000_000), Some(5400.0), true);
        assert_eq!(compare_files(Some(&a), Some(&b)), FileMatchStatus::Matched);
    }

    #[test]
    fn test_duration_mismatch() {
        let a = id("Movie.mkv", Some(1_000_000), Some(5400.0), false);
        let b = id("Movie.mkv", Some(1_000_000), Some(5410.0), false);
        assert_eq!(
            compare_files(Some(&a), Some(&b)),
            FileMatchStatus::DurationMismatch
        );
    }

    #[test]
    fn test_same_length_different_encode_for_differing_size_or_name() {
        let a = id("Movie.1080p.mkv", Some(4_200_000_000), Some(5400.0), false);
        let b = id("Movie.720p.mp4", Some(1_800_000_000), Some(5401.0), false);
        assert_eq!(
            compare_files(Some(&a), Some(&b)),
            FileMatchStatus::SameLengthDifferentEncode
        );
    }

    #[test]
    fn test_different_file_when_size_or_name_differs_without_matching_duration() {
        let a = id("Ep01.mkv", Some(500_000), None, false);
        let b = id("Ep02.mkv", Some(600_000), None, false);
        assert_eq!(
            compare_files(Some(&a), Some(&b)),
            FileMatchStatus::DifferentFile
        );
    }
}
