#![cfg(windows)]

use epilod_core::opensubtitles::{
    build_cached_subtitle_filename, build_search_query_string, compute_opensubtitles_file_hash,
    normalize_subtitle_lang_code, parse_cinemeta_search_results, parse_imdb_suggestion_results,
    parse_media_filename, parse_opensubtitles_v1_response, parse_preferred_languages,
    parse_stremio_subtitles_response, rank_and_filter_candidates, sanitize_subtitle_download_bytes,
    short_subtitle_cache_tag, subtitle_lang_display_name, subtitle_lang_to_iso1, DownloadRequest,
    DownloadResponse, ImdbMatch, SearchParams, SubtitleSearchCandidate, MAX_SUBTITLE_ARCHIVE_BYTES,
};
use epilod_core::updater::{
    find_http_header_end, parse_http_head, resolve_redirect_url, validate_https_url,
    ChunkedDecoder, MAX_REDIRECTS,
};
use epilod_core::validation::{validate_existing_local_file_with_options, LocalPathOptions};
use native_tls::TlsConnector as NativeTlsConnector;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_native_tls::TlsConnector;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const READ_TIMEOUT: Duration = Duration::from_secs(12);
const MAX_JSON_BYTES: usize = 4 * 1024 * 1024;
const USER_AGENT: &str = concat!("EpilodParty/", env!("CARGO_PKG_VERSION"));
const OS_API_USER_AGENT: &str = concat!("EpilodParty v", env!("CARGO_PKG_VERSION"));
const MAX_CACHED_SUB_FILES: usize = 400;

const ALLOWED_SUBTITLE_HOSTS: &[&str] = &[
    "v3-cinemeta.strem.io",
    "opensubtitles-v3.strem.io",
    "subs1.strem.io",
    "subs2.strem.io",
    "subs3.strem.io",
    "subs4.strem.io",
    "subs5.strem.io",
    "subs6.strem.io",
    "subs7.strem.io",
    "subs8.strem.io",
    "v3.sg.media-imdb.com",
    "api.opensubtitles.com",
    "vip-api.opensubtitles.com",
    "dl.opensubtitles.com",
    "www.opensubtitles.com",
];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSearchRequest {
    pub query: Option<String>,
    pub video_path: Option<String>,
    pub languages: Option<String>,
    pub media_type: Option<String>,
    pub season: Option<u32>,
    pub episode: Option<u32>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleSearchResultDto {
    pub resolved_title: Option<String>,
    pub resolved_imdb_id: Option<String>,
    pub resolved_year: Option<u32>,
    pub resolved_type: Option<String>,
    pub parsed_query: String,
    pub parsed_season: Option<u32>,
    pub parsed_episode: Option<u32>,
    pub movie_hash: Option<String>,
    pub items: Vec<SubtitleSearchCandidate>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubtitleDownloadRequest {
    pub download_url: Option<String>,
    pub file_id: Option<u64>,
    pub file_name: Option<String>,
    pub language: Option<String>,
    pub match_kind: Option<String>,
    pub video_path: Option<String>,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedSubtitleDto {
    pub subtitle_path: String,
    pub file_name: String,
    pub language: String,
    pub language_label: String,
    pub match_kind: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFetchSubtitleRequest {
    pub video_path: String,
    pub languages: String,
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoFetchSubtitleResultDto {
    pub found: bool,
    pub downloaded: Option<DownloadedSubtitleDto>,
    pub resolved_title: Option<String>,
    pub total_found: usize,
}

pub fn subtitle_cache_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
        .join("EpilodParty")
        .join("subtitles")
}

fn percent_encode_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 8);
    for b in input.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

async fn https_request_bytes(
    method: &str,
    start_url: &str,
    headers: &[(&str, &str)],
    body: Option<&[u8]>,
    max_bytes: usize,
) -> Result<Vec<u8>, String> {
    let mut current =
        validate_https_url(start_url, ALLOWED_SUBTITLE_HOSTS).map_err(|e| e.to_string())?;
    let mut cur_method = method.to_string();
    let mut cur_body = body.map(|b| b.to_vec());

    for _hop in 0..=MAX_REDIRECTS {
        let addr = format!("{}:{}", current.host, current.port);
        let tcp = timeout(CONNECT_TIMEOUT, TcpStream::connect(&addr))
            .await
            .map_err(|_| format!("Timed out connecting to {}", current.host))?
            .map_err(|e| format!("Connection failed to {}: {e}", current.host))?;

        let connector =
            NativeTlsConnector::new().map_err(|e| format!("TLS initializer failed: {e}"))?;
        let tls_connector = TlsConnector::from(connector);
        let mut tls = timeout(CONNECT_TIMEOUT, tls_connector.connect(&current.host, tcp))
            .await
            .map_err(|_| format!("TLS handshake timed out with {}", current.host))?
            .map_err(|e| format!("TLS failed for {}: {e}", current.host))?;

        let mut req = format!(
            "{} {} HTTP/1.1\r\nHost: {}\r\nUser-Agent: {}\r\nAccept: application/json, text/plain, */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n",
            cur_method, current.path_and_query, current.host, USER_AGENT
        );
        for (k, v) in headers {
            if !k.eq_ignore_ascii_case("host")
                && !k.eq_ignore_ascii_case("connection")
                && !k.eq_ignore_ascii_case("accept-encoding")
            {
                req.push_str(&format!("{k}: {v}\r\n"));
            }
        }
        if let Some(ref payload) = cur_body {
            req.push_str(&format!("Content-Length: {}\r\n", payload.len()));
        }
        req.push_str("\r\n");

        timeout(READ_TIMEOUT, tls.write_all(req.as_bytes()))
            .await
            .map_err(|_| "Timed out sending subtitle HTTP request.".to_string())?
            .map_err(|e| format!("Failed sending subtitle HTTP request: {e}"))?;
        if let Some(ref payload) = cur_body {
            timeout(READ_TIMEOUT, tls.write_all(payload))
                .await
                .map_err(|_| "Timed out sending subtitle request body.".to_string())?
                .map_err(|e| format!("Failed sending subtitle request body: {e}"))?;
        }

        let mut header_buf = Vec::with_capacity(8192);
        let mut tmp = [0u8; 4096];
        loop {
            if find_http_header_end(&header_buf).is_some() {
                break;
            }
            if header_buf.len() > 64 * 1024 {
                return Err("Subtitle server response headers exceeded limit.".to_string());
            }
            let n = timeout(READ_TIMEOUT, tls.read(&mut tmp))
                .await
                .map_err(|_| "Timed out reading subtitle response headers.".to_string())?
                .map_err(|e| format!("Error reading subtitle headers: {e}"))?;
            if n == 0 {
                return Err("Subtitle server closed connection before headers.".to_string());
            }
            header_buf.extend_from_slice(&tmp[..n]);
        }

        let head = parse_http_head(&header_buf).map_err(|e| e.to_string())?;
        if matches!(head.status, 301 | 302 | 303 | 307 | 308) {
            let loc = head
                .location
                .as_deref()
                .ok_or_else(|| "Subtitle redirect missing Location header.".to_string())?;
            current = resolve_redirect_url(&current, loc, ALLOWED_SUBTITLE_HOSTS)
                .map_err(|e| e.to_string())?;
            if matches!(head.status, 301 | 302 | 303) {
                cur_method = "GET".to_string();
                cur_body = None;
            }
            continue;
        }

        if head.status < 200 || head.status >= 300 {
            return Err(format!(
                "Subtitle service ({}) returned HTTP {}.",
                current.host, head.status
            ));
        }

        let leftover = &header_buf[head.body_offset..];
        let mut out = Vec::new();
        let mut decoder = ChunkedDecoder::default();
        if head.chunked {
            let chunk = decoder.push(leftover).map_err(|e| e.to_string())?;
            out.extend_from_slice(&chunk);
        } else {
            out.extend_from_slice(leftover);
        }
        if out.len() > max_bytes {
            return Err("Subtitle payload exceeded safety size limit.".to_string());
        }

        let mut buf = [0u8; 16 * 1024];
        while !(head.chunked && decoder.is_finished())
            && head
                .content_length
                .map(|cl| (out.len() as u64) < cl)
                .unwrap_or(true)
        {
            let n = timeout(READ_TIMEOUT, tls.read(&mut buf))
                .await
                .map_err(|_| "Timed out reading subtitle payload.".to_string())?
                .map_err(|e| format!("Error reading subtitle payload: {e}"))?;
            if n == 0 {
                break;
            }
            if head.chunked {
                let chunk = decoder.push(&buf[..n]).map_err(|e| e.to_string())?;
                out.extend_from_slice(&chunk);
            } else {
                out.extend_from_slice(&buf[..n]);
            }
            if out.len() > max_bytes {
                return Err("Subtitle payload exceeded safety size limit.".to_string());
            }
        }

        return Ok(out);
    }

    Err("Too many redirects contacting subtitle server.".to_string())
}

async fn resolve_imdb_matches(
    parsed: &epilod_core::opensubtitles::ParsedMediaQuery,
    media_type_hint: &str,
) -> Vec<ImdbMatch> {
    if let Some(ref direct) = parsed.direct_imdb_id {
        let inferred_type = if parsed.is_series || media_type_hint == "series" {
            "series".to_string()
        } else {
            "movie".to_string()
        };
        return vec![ImdbMatch {
            imdb_id: direct.clone(),
            title: direct.clone(),
            media_type: inferred_type,
            year: parsed.year,
            score: 1000,
        }];
    }

    let clean_title = parsed.title.trim();
    if clean_title.is_empty() {
        return Vec::new();
    }
    let encoded = percent_encode_component(clean_title);

    let want_movie = media_type_hint == "movie" || (media_type_hint == "auto" && !parsed.is_series);
    let want_series = media_type_hint == "series" || media_type_hint == "auto" || parsed.is_series;

    let movie_fut = async {
        if !want_movie && media_type_hint != "auto" {
            return Vec::new();
        }
        let url = format!("https://v3-cinemeta.strem.io/catalog/movie/top/search={encoded}.json");
        match https_request_bytes("GET", &url, &[], None, MAX_JSON_BYTES).await {
            Ok(bytes) => {
                let txt = String::from_utf8_lossy(&bytes);
                parse_cinemeta_search_results(&txt, "movie", parsed)
            }
            Err(_) => Vec::new(),
        }
    };

    let series_fut = async {
        if !want_series {
            return Vec::new();
        }
        let url = format!("https://v3-cinemeta.strem.io/catalog/series/top/search={encoded}.json");
        match https_request_bytes("GET", &url, &[], None, MAX_JSON_BYTES).await {
            Ok(bytes) => {
                let txt = String::from_utf8_lossy(&bytes);
                parse_cinemeta_search_results(&txt, "series", parsed)
            }
            Err(_) => Vec::new(),
        }
    };

    let (movies, series) = tokio::join!(movie_fut, series_fut);
    let mut combined = Vec::new();
    combined.extend(movies);
    combined.extend(series);

    if combined.is_empty() {
        let imdb_url = format!("https://v3.sg.media-imdb.com/suggestion/x/{encoded}.json");
        if let Ok(bytes) = https_request_bytes("GET", &imdb_url, &[], None, MAX_JSON_BYTES).await {
            let txt = String::from_utf8_lossy(&bytes);
            combined.extend(parse_imdb_suggestion_results(&txt, parsed));
        }
    }

    combined.sort_by(|a, b| b.score.cmp(&a.score));
    combined
}

async fn query_stremio_subtitles_for_match(
    matched: &ImdbMatch,
    season: Option<u32>,
    episode: Option<u32>,
    movie_hash: Option<&str>,
    movie_size: Option<u64>,
    file_name: Option<&str>,
    video_name: Option<&str>,
    preferred_langs: &[String],
) -> Result<Vec<SubtitleSearchCandidate>, String> {
    let video_id = if matched.media_type == "series" {
        let s = season.unwrap_or(1).max(1);
        let e = episode.unwrap_or(1).max(1);
        format!("{}:{s}:{e}", matched.imdb_id)
    } else {
        matched.imdb_id.clone()
    };

    let mut extra_parts = Vec::new();
    if let (Some(h), Some(sz)) = (movie_hash, movie_size) {
        if !h.is_empty() && sz > 0 {
            extra_parts.push(format!("videoHash={h}"));
            extra_parts.push(format!("videoSize={sz}"));
        }
    }
    if let Some(fname) = file_name {
        if !fname.trim().is_empty() {
            extra_parts.push(format!(
                "filename={}",
                percent_encode_component(fname.trim())
            ));
        }
    }

    let url = if extra_parts.is_empty() {
        format!(
            "https://opensubtitles-v3.strem.io/subtitles/{}/{}.json",
            matched.media_type, video_id
        )
    } else {
        format!(
            "https://opensubtitles-v3.strem.io/subtitles/{}/{}/{}.json",
            matched.media_type,
            video_id,
            extra_parts.join("&")
        )
    };

    let bytes = https_request_bytes("GET", &url, &[], None, MAX_JSON_BYTES).await?;
    let txt = String::from_utf8_lossy(&bytes);
    Ok(parse_stremio_subtitles_response(
        &txt,
        video_name,
        preferred_langs,
    ))
}

async fn query_opensubtitles_official_api(
    api_key: &str,
    parsed: &epilod_core::opensubtitles::ParsedMediaQuery,
    season: Option<u32>,
    episode: Option<u32>,
    movie_hash: Option<&str>,
    movie_size: Option<u64>,
    video_name: Option<&str>,
    preferred_langs: &[String],
) -> Result<Vec<SubtitleSearchCandidate>, String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Ok(Vec::new());
    }
    let langs_iso1: Vec<String> = preferred_langs
        .iter()
        .map(|l| subtitle_lang_to_iso1(l))
        .collect();
    let langs_param = if langs_iso1.is_empty() {
        None
    } else {
        Some(langs_iso1.join(","))
    };

    let mut query_text = parsed.title.clone();
    if let (Some(s), Some(e)) = (season, episode) {
        query_text = format!("{query_text} S{s:02}E{e:02}");
    }

    let qs = build_search_query_string(&SearchParams {
        query: if query_text.trim().is_empty() {
            None
        } else {
            Some(query_text)
        },
        moviehash: movie_hash.map(ToString::to_string),
        moviebytesize: movie_size,
        languages: langs_param,
    });
    if qs.is_empty() {
        return Ok(Vec::new());
    }

    let url = format!("https://api.opensubtitles.com/api/v1/subtitles?{qs}");
    let headers = [
        ("Api-Key", key),
        ("User-Agent", OS_API_USER_AGENT),
        ("Content-Type", "application/json"),
    ];
    let bytes = https_request_bytes("GET", &url, &headers, None, MAX_JSON_BYTES).await?;
    let txt = String::from_utf8_lossy(&bytes);
    Ok(parse_opensubtitles_v1_response(
        &txt,
        video_name,
        preferred_langs,
    ))
}

fn prune_subtitle_cache(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_file() {
            let mtime = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(UNIX_EPOCH);
            files.push((p, mtime));
        }
    }
    if files.len() <= MAX_CACHED_SUB_FILES {
        return;
    }
    files.sort_by_key(|(_, t)| *t);
    let remove_count = files.len().saturating_sub(MAX_CACHED_SUB_FILES);
    for (path, _) in files.into_iter().take(remove_count) {
        let _ = fs::remove_file(path);
    }
}

pub async fn search_online_subtitles_impl(
    req: SubtitleSearchRequest,
    path_opts: LocalPathOptions,
) -> Result<SubtitleSearchResultDto, String> {
    let validated_video: Option<PathBuf> = req
        .video_path
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .and_then(|p| validate_existing_local_file_with_options(p, path_opts).ok());

    let video_name: Option<String> = validated_video
        .as_ref()
        .and_then(|p| p.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .or_else(|| {
            req.video_path
                .as_deref()
                .map(str::trim)
                .filter(|p| !p.is_empty())
                .and_then(|p| Path::new(p).file_name())
                .map(|n| n.to_string_lossy().into_owned())
        });

    let effective_query_src = req
        .query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(ToString::to_string)
        .or_else(|| video_name.clone())
        .ok_or_else(|| "Enter a movie or show name, or open a video first.".to_string())?;

    let mut parsed = parse_media_filename(&effective_query_src);
    if parsed.season.is_none() && req.season.is_some() {
        parsed.season = req.season;
        parsed.is_series = true;
    }
    if parsed.episode.is_none() && req.episode.is_some() {
        parsed.episode = req.episode;
        parsed.is_series = true;
    }
    // If user typed a series title without SxxExx while watching a specific episode, inherit episode metadata
    if let Some(ref vname) = video_name {
        let parsed_video = parse_media_filename(vname);
        if parsed.season.is_none()
            && parsed.episode.is_none()
            && req
                .query
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .is_none()
        {
            parsed.season = parsed_video.season;
            parsed.episode = parsed_video.episode;
            parsed.is_series = parsed_video.is_series;
        }
    }

    let hash_task = {
        let vp = validated_video.clone();
        tokio::task::spawn_blocking(move || {
            vp.and_then(|p| compute_opensubtitles_file_hash(&p).ok())
        })
    };

    let media_hint = req
        .media_type
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto");

    let preferred_langs = parse_preferred_languages(req.languages.as_deref().unwrap_or("all"));
    let (hash_res, imdb_matches) =
        tokio::join!(hash_task, resolve_imdb_matches(&parsed, media_hint));
    let hash_info = hash_res.ok().flatten();
    let movie_hash = hash_info.as_ref().map(|(h, _)| h.clone());
    let movie_size = hash_info.as_ref().map(|(_, s)| *s);

    let mut all_candidates: Vec<SubtitleSearchCandidate> = Vec::new();
    let primary_match = imdb_matches.first().cloned();
    let mut last_network_err: Option<String> = None;

    if let Some(ref primary) = primary_match {
        // Also query runner-up if its type differs (movie vs series) and score is close
        let secondary = if media_hint == "auto" {
            imdb_matches
                .iter()
                .skip(1)
                .find(|m| m.media_type != primary.media_type && primary.score - m.score <= 220)
                .cloned()
        } else {
            None
        };

        let p_fut = query_stremio_subtitles_for_match(
            primary,
            parsed.season,
            parsed.episode,
            movie_hash.as_deref(),
            movie_size,
            video_name.as_deref(),
            video_name.as_deref(),
            &preferred_langs,
        );
        let s_fut = async {
            if let Some(ref sec) = secondary {
                Some(
                    query_stremio_subtitles_for_match(
                        sec,
                        parsed.season,
                        parsed.episode,
                        movie_hash.as_deref(),
                        movie_size,
                        video_name.as_deref(),
                        video_name.as_deref(),
                        &preferred_langs,
                    )
                    .await,
                )
            } else {
                None
            }
        };
        let os_fut = async {
            if let Some(ref key) = req.api_key {
                if !key.trim().is_empty() {
                    return Some(
                        query_opensubtitles_official_api(
                            key,
                            &parsed,
                            parsed.season,
                            parsed.episode,
                            movie_hash.as_deref(),
                            movie_size,
                            video_name.as_deref(),
                            &preferred_langs,
                        )
                        .await,
                    );
                }
            }
            None
        };

        let (p_res, s_res, os_res) = tokio::join!(p_fut, s_fut, os_fut);
        match p_res {
            Ok(items) => all_candidates.extend(items),
            Err(e) => last_network_err = Some(e),
        }
        if let Some(Ok(items)) = s_res {
            all_candidates.extend(items);
        }
        if let Some(Ok(items)) = os_res {
            all_candidates.extend(items);
        }
    } else if let Some(ref key) = req.api_key {
        if !key.trim().is_empty() {
            match query_opensubtitles_official_api(
                key,
                &parsed,
                parsed.season,
                parsed.episode,
                movie_hash.as_deref(),
                movie_size,
                video_name.as_deref(),
                &preferred_langs,
            )
            .await
            {
                Ok(items) => all_candidates.extend(items),
                Err(e) => last_network_err = Some(e),
            }
        }
    }

    if all_candidates.is_empty() {
        if let Some(err) = last_network_err {
            return Err(err);
        }
    }

    let ranked = rank_and_filter_candidates(all_candidates, &preferred_langs);
    Ok(SubtitleSearchResultDto {
        resolved_title: primary_match.as_ref().map(|m| m.title.clone()),
        resolved_imdb_id: primary_match.as_ref().map(|m| m.imdb_id.clone()),
        resolved_year: primary_match.as_ref().and_then(|m| m.year),
        resolved_type: primary_match.as_ref().map(|m| m.media_type.clone()),
        parsed_query: parsed.title,
        parsed_season: parsed.season,
        parsed_episode: parsed.episode,
        movie_hash,
        items: ranked,
    })
}

pub async fn download_online_subtitle_impl(
    req: SubtitleDownloadRequest,
) -> Result<DownloadedSubtitleDto, String> {
    let download_url = if let Some(url) = req
        .download_url
        .as_deref()
        .map(str::trim)
        .filter(|u| !u.is_empty())
    {
        url.to_string()
    } else if let Some(file_id) = req.file_id {
        let key = req
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .ok_or_else(|| {
                "OpenSubtitles API key is required for direct file_id downloads.".to_string()
            })?;
        let payload =
            serde_json::to_vec(&DownloadRequest { file_id }).map_err(|e| e.to_string())?;
        let headers = [
            ("Api-Key", key),
            ("User-Agent", OS_API_USER_AGENT),
            ("Content-Type", "application/json"),
        ];
        let resp_bytes = https_request_bytes(
            "POST",
            "https://api.opensubtitles.com/api/v1/download",
            &headers,
            Some(&payload),
            MAX_JSON_BYTES,
        )
        .await?;
        let dl: DownloadResponse = serde_json::from_slice(&resp_bytes)
            .map_err(|e| format!("Failed parsing OpenSubtitles download link response: {e}"))?;
        dl.link
    } else {
        return Err("Missing subtitle download URL or file ID.".to_string());
    };

    let raw_bytes = https_request_bytes(
        "GET",
        &download_url,
        &[],
        None,
        MAX_SUBTITLE_ARCHIVE_BYTES as usize,
    )
    .await?;

    let clean_utf8 = sanitize_subtitle_download_bytes(&raw_bytes)?;

    let cache_dir = subtitle_cache_dir();
    fs::create_dir_all(&cache_dir)
        .map_err(|e| format!("Failed creating subtitle cache directory: {e}"))?;

    let video_name = req
        .video_path
        .as_deref()
        .and_then(|p| Path::new(p).file_name())
        .map(|n| n.to_string_lossy().into_owned());

    let lang = normalize_subtitle_lang_code(req.language.as_deref().unwrap_or("eng"));
    let tag = short_subtitle_cache_tag(req.video_path.as_deref(), &download_url);
    let cached_name = build_cached_subtitle_filename(
        video_name.as_deref(),
        req.file_name.as_deref(),
        Some(&lang),
        &tag,
    );
    let dest_path = cache_dir.join(&cached_name);
    let tmp_path = cache_dir.join(format!("{cached_name}.part"));
    fs::write(&tmp_path, &clean_utf8).map_err(|e| format!("Failed saving subtitle file: {e}"))?;
    if dest_path.exists() {
        let _ = fs::remove_file(&dest_path);
    }
    fs::rename(&tmp_path, &dest_path)
        .map_err(|e| format!("Failed finalizing cached subtitle file: {e}"))?;

    prune_subtitle_cache(&cache_dir);

    Ok(DownloadedSubtitleDto {
        subtitle_path: dest_path.to_string_lossy().into_owned(),
        file_name: req
            .file_name
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(cached_name),
        language_label: subtitle_lang_display_name(&lang),
        language: lang,
        match_kind: req.match_kind.unwrap_or_else(|| "imdb".to_string()),
    })
}

pub async fn auto_fetch_online_subtitle_impl(
    req: AutoFetchSubtitleRequest,
    path_opts: LocalPathOptions,
) -> Result<AutoFetchSubtitleResultDto, String> {
    let langs = if req.languages.trim().is_empty() || req.languages.trim() == "all" {
        "eng".to_string()
    } else {
        req.languages.clone()
    };

    let search_res = search_online_subtitles_impl(
        SubtitleSearchRequest {
            query: None,
            video_path: Some(req.video_path.clone()),
            languages: Some(langs),
            media_type: Some("auto".to_string()),
            season: None,
            episode: None,
            api_key: req.api_key.clone(),
        },
        path_opts,
    )
    .await?;

    let total_found = search_res.items.len();
    for candidate in search_res.items.iter().take(3) {
        if let Ok(downloaded) = download_online_subtitle_impl(SubtitleDownloadRequest {
            download_url: candidate.download_url.clone(),
            file_id: candidate.file_id,
            file_name: Some(candidate.file_name.clone()),
            language: Some(candidate.language.clone()),
            match_kind: Some(candidate.match_kind.clone()),
            video_path: Some(req.video_path.clone()),
            api_key: req.api_key.clone(),
        })
        .await
        {
            return Ok(AutoFetchSubtitleResultDto {
                found: true,
                downloaded: Some(downloaded),
                resolved_title: search_res.resolved_title,
                total_found,
            });
        }
    }

    Ok(AutoFetchSubtitleResultDto {
        found: false,
        downloaded: None,
        resolved_title: search_res.resolved_title,
        total_found,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_percent_encode_component_preserves_unreserved() {
        assert_eq!(percent_encode_component("Breaking Bad"), "Breaking%20Bad");
        assert_eq!(
            percent_encode_component("Inception.2010.mkv"),
            "Inception.2010.mkv"
        );
    }

    #[test]
    fn test_subtitle_cache_dir_resolves_under_epilod_party() {
        let dir = subtitle_cache_dir();
        let norm = dir.to_string_lossy().replace('\\', "/");
        assert!(norm.ends_with("EpilodParty/subtitles"));
    }

    #[tokio::test]
    #[ignore = "live network smoke test for Stremio OpenSubtitles v3 pipeline"]
    async fn live_search_and_download_movie_and_series_subtitles() {
        let res = auto_fetch_online_subtitle_impl(
            AutoFetchSubtitleRequest {
                video_path: "D:\\Shows\\Breaking.Bad.S01E01.720p.BluRay.x264.mkv".to_string(),
                languages: "ara,eng".to_string(),
                api_key: None,
            },
            LocalPathOptions::default(),
        )
        .await
        .expect("live subtitle fetch succeeds");

        assert!(res.found, "should find and download subtitle");
        assert!(res.total_found > 0);
        let dl = res.downloaded.expect("downloaded dto present");
        let saved = fs::read_to_string(&dl.subtitle_path).expect("saved utf-8 srt readable");
        assert!(
            saved.contains("-->"),
            "downloaded file should contain SRT cues"
        );
        let _ = fs::remove_file(&dl.subtitle_path);
    }
}
