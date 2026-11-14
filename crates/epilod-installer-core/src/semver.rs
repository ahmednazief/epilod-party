use std::cmp::Ordering;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemVer {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Option<String>,
}

pub fn normalize_version_str(raw: &str) -> &str {
    let trimmed = raw.trim();
    trimmed
        .strip_prefix('v')
        .or_else(|| trimmed.strip_prefix('V'))
        .unwrap_or(trimmed)
}

pub fn parse_semver(raw: &str) -> Option<SemVer> {
    let clean = normalize_version_str(raw);
    let core_and_build = clean.split('+').next()?.trim();
    let (core, pre) = match core_and_build.split_once('-') {
        Some((c, p)) => {
            if p.trim().is_empty() {
                return None;
            }
            (c, Some(p.trim().to_string()))
        }
        None => (core_and_build, None),
    };

    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }

    if let Some(ref pre_str) = pre {
        if !pre_str
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-'))
        {
            return None;
        }
    }

    Some(SemVer {
        major,
        minor,
        patch,
        pre,
    })
}

pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let va = parse_semver(a)?;
    let vb = parse_semver(b)?;

    match va.major.cmp(&vb.major) {
        Ordering::Equal => {}
        ord => return Some(ord),
    }
    match va.minor.cmp(&vb.minor) {
        Ordering::Equal => {}
        ord => return Some(ord),
    }
    match va.patch.cmp(&vb.patch) {
        Ordering::Equal => {}
        ord => return Some(ord),
    }

    match (&va.pre, &vb.pre) {
        (None, None) => Some(Ordering::Equal),
        (Some(_), None) => Some(Ordering::Less),
        (None, Some(_)) => Some(Ordering::Greater),
        (Some(pa), Some(pb)) => Some(compare_prerelease(pa, pb)),
    }
}

fn compare_prerelease(a: &str, b: &str) -> Ordering {
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

#[cfg(test)]
mod tests {
    use super::*;

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
