pub use epilod_core::updater::{
    compare_semver as compare_versions, parse_semver, ParsedSemVer as SemVer,
};

#[cfg(test)]
mod tests {
    use super::*;
    use std::cmp::Ordering;

    #[test]
    fn semver_ordering_and_validation() {
        assert_eq!(compare_versions("0.1.0", "v0.1.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("0.1.0", "0.2.0"), Some(Ordering::Less));
        assert_eq!(
            compare_versions("0.2.0-rc.1", "0.2.0"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_versions("0.2.0-rc.2", "0.2.0-rc.10"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_versions("1.0.0", "0.99.99"),
            Some(Ordering::Greater)
        );
        assert!(parse_semver("not-a-version").is_none());
        assert!(parse_semver("0.1.0-").is_none());
        assert!(parse_semver("0.1").is_none());
    }
}
