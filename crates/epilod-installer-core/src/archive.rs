use crate::plan::{ComponentId, APP_VERSION};
use lzma_rust2::filter::bcj2::{Bcj2Options, Bcj2Reader, Bcj2Writer};
use lzma_rust2::{
    Lzma2Options, Lzma2Reader, Lzma2Writer, LzmaOptions, LzmaReader, LzmaWriter, DICT_SIZE_MIN,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use thiserror::Error;

const MAGIC: &[u8; 8] = b"EPKG0001";
const MAGIC_V2: &[u8; 8] = b"EPKG0002";
const SFX_TRAILER_MAGIC: &[u8; 12] = b"EPILOD_SFX01";
const SFX_TRAILER_SIZE: u64 = 20; // [u64 payload_start_offset LE][12-byte SFX_TRAILER_MAGIC]
const BCJ2_HEADER_SIZE: u64 = 36; // [u32 dict_size][u64 main_len][u64 call_len][u64 jump_len][u64 rc_len]
const CHUNK_SIZE: usize = 64 * 1024;
const MAX_MANIFEST_BYTES: usize = 8 * 1024 * 1024;
const MAIN_DICT_MIN: u32 = 1 << 16;
const MAIN_DICT_MAX: u32 = 256 << 20;
const CALL_JUMP_DICT_MAX: u32 = 8 << 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveFormat {
    RawV1,
    Bcj2Lzma2V2,
}

fn parse_magic(magic: &[u8; 8]) -> Option<ArchiveFormat> {
    if magic == MAGIC {
        Some(ArchiveFormat::RawV1)
    } else if magic == MAGIC_V2 {
        Some(ArchiveFormat::Bcj2Lzma2V2)
    } else {
        None
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Bcj2StreamHeader {
    dict_size: u32,
    main_len: u64,
    call_len: u64,
    jump_len: u64,
    rc_len: u64,
}

impl Bcj2StreamHeader {
    fn write_to<W: Write>(&self, writer: &mut W) -> Result<(), ArchiveError> {
        writer.write_all(&self.dict_size.to_le_bytes())?;
        writer.write_all(&self.main_len.to_le_bytes())?;
        writer.write_all(&self.call_len.to_le_bytes())?;
        writer.write_all(&self.jump_len.to_le_bytes())?;
        writer.write_all(&self.rc_len.to_le_bytes())?;
        Ok(())
    }

    fn read_checked(
        file: &mut File,
        data_start: u64,
        end_offset: u64,
    ) -> Result<Self, ArchiveError> {
        let streams_start = data_start
            .checked_add(BCJ2_HEADER_SIZE)
            .ok_or(ArchiveError::BadHeader)?;
        if streams_start > end_offset {
            return Err(ArchiveError::BadHeader);
        }

        file.seek(SeekFrom::Start(data_start))?;
        let mut raw = [0u8; BCJ2_HEADER_SIZE as usize];
        file.read_exact(&mut raw)?;

        let dict_size = u32::from_le_bytes(raw[0..4].try_into().unwrap());
        if !(DICT_SIZE_MIN..=MAIN_DICT_MAX).contains(&dict_size) {
            return Err(ArchiveError::BadHeader);
        }

        let main_len = u64::from_le_bytes(raw[4..12].try_into().unwrap());
        let call_len = u64::from_le_bytes(raw[12..20].try_into().unwrap());
        let jump_len = u64::from_le_bytes(raw[20..28].try_into().unwrap());
        let rc_len = u64::from_le_bytes(raw[28..36].try_into().unwrap());

        let total_end = streams_start
            .checked_add(main_len)
            .and_then(|v| v.checked_add(call_len))
            .and_then(|v| v.checked_add(jump_len))
            .and_then(|v| v.checked_add(rc_len))
            .ok_or_else(|| ArchiveError::CorruptBounds("Compressed stream overflow".to_string()))?;

        if total_end != end_offset {
            return Err(ArchiveError::CorruptBounds(
                "Compressed BCJ2 stream length mismatch".to_string(),
            ));
        }

        Ok(Self {
            dict_size,
            main_len,
            call_len,
            jump_len,
            rc_len,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ArchiveSource {
    pub start_offset: u64,
    pub end_offset: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageEntry {
    pub relative_path: String,
    pub component: ComponentId,
    pub size: u64,
    pub offset: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    pub version: String,
    pub total_bytes: u64,
    pub entries: Vec<PackageEntry>,
}

impl PackageManifest {
    fn validate_common(&self, raw_bounds: Option<(u64, u64)>) -> Result<(), ArchiveError> {
        if self.version.trim().is_empty() || self.entries.is_empty() {
            return Err(ArchiveError::CorruptBounds(
                "Empty installer manifest".to_string(),
            ));
        }

        let mut seen_lower = BTreeSet::new();
        let mut computed_total = 0u64;

        for entry in &self.entries {
            let _ = sanitize_relative_path(&entry.relative_path)?;
            let lower_rel = entry.relative_path.replace('\\', "/").to_ascii_lowercase();
            if !seen_lower.insert(lower_rel) {
                return Err(ArchiveError::UnsafePath(format!(
                    "Duplicate archive entry (case-insensitive NTFS collision): {}",
                    entry.relative_path
                )));
            }

            if !is_valid_sha256_hex(&entry.sha256) {
                return Err(ArchiveError::ChecksumMismatch {
                    path: entry.relative_path.clone(),
                    expected: "64-char sha256 hex".to_string(),
                    actual: entry.sha256.clone(),
                });
            }

            if let Some((data_start, end_offset)) = raw_bounds {
                let abs_start = data_start
                    .checked_add(entry.offset)
                    .ok_or_else(|| ArchiveError::CorruptBounds(entry.relative_path.clone()))?;
                let abs_end = abs_start
                    .checked_add(entry.size)
                    .ok_or_else(|| ArchiveError::CorruptBounds(entry.relative_path.clone()))?;
                if abs_end > end_offset {
                    return Err(ArchiveError::CorruptBounds(entry.relative_path.clone()));
                }
            } else if entry.offset != computed_total {
                return Err(ArchiveError::CorruptBounds(format!(
                    "Non-contiguous compressed stream offset for {}",
                    entry.relative_path
                )));
            }

            computed_total = computed_total
                .checked_add(entry.size)
                .ok_or_else(|| ArchiveError::CorruptBounds(entry.relative_path.clone()))?;
        }

        if computed_total != self.total_bytes {
            return Err(ArchiveError::CorruptBounds(format!(
                "Manifest byte total mismatch (header {}, entries sum {})",
                self.total_bytes, computed_total
            )));
        }

        Ok(())
    }

    pub fn validate_layout(&self, data_start: u64, end_offset: u64) -> Result<(), ArchiveError> {
        self.validate_common(Some((data_start, end_offset)))
    }

    pub fn validate_compressed_layout(&self) -> Result<(), ArchiveError> {
        self.validate_common(None)
    }
}

pub fn is_valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExtractAction {
    Unpacking,
    VerifyingDigest,
    ReusedVerified,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractProgress {
    pub action: ExtractAction,
    pub component: ComponentId,
    pub relative_path: String,
    pub file_bytes_done: u64,
    pub file_bytes_total: u64,
    pub total_bytes_done: u64,
    pub total_bytes: u64,
    pub files_done: usize,
    pub files_total: usize,
}

#[derive(Debug, Error)]
pub enum ArchiveError {
    #[error("I/O failure: {0}")]
    Io(#[from] std::io::Error),
    #[error("Invalid archive header or unsupported package format.")]
    BadHeader,
    #[error("Invalid manifest JSON: {0}")]
    BadManifest(#[from] serde_json::Error),
    #[error("Unsafe relative entry path rejected: {0}")]
    UnsafePath(String),
    #[error("SHA-256 verification failed for '{path}' (expected {expected}, got {actual}).")]
    ChecksumMismatch {
        path: String,
        expected: String,
        actual: String,
    },
    #[error("Archive entry '{0}' size or offset out of bounds.")]
    CorruptBounds(String),
    #[error("Installation cancelled by user.")]
    Cancelled,
}

pub fn sanitize_relative_path(raw: &str) -> Result<PathBuf, ArchiveError> {
    if raw.is_empty() || raw.len() > 260 {
        return Err(ArchiveError::UnsafePath(raw.to_string()));
    }
    if raw.starts_with('/') || raw.starts_with('\\') {
        return Err(ArchiveError::UnsafePath(raw.to_string()));
    }
    if raw.chars().any(|c| c.is_control() || c == '\0') {
        return Err(ArchiveError::UnsafePath(raw.to_string()));
    }

    let normalized = raw.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return Err(ArchiveError::UnsafePath(raw.to_string()));
    }

    let mut clean = PathBuf::new();
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == "." || segment == ".." {
            return Err(ArchiveError::UnsafePath(raw.to_string()));
        }
        if segment.contains(':')
            || segment
                .chars()
                .any(|c| matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
        {
            return Err(ArchiveError::UnsafePath(raw.to_string()));
        }
        let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
        if matches!(
            stem.as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        ) {
            return Err(ArchiveError::UnsafePath(raw.to_string()));
        }
        clean.push(segment);
    }

    if clean.as_os_str().is_empty() {
        return Err(ArchiveError::UnsafePath(raw.to_string()));
    }

    Ok(clean)
}

pub fn classify_component(relative_path: &str) -> ComponentId {
    let lower = relative_path.replace('\\', "/").to_ascii_lowercase();
    if lower.contains("mpv.exe") || lower.contains("resources/mpv/mpv") {
        ComponentId::Mpv
    } else if lower.contains("ffmpeg")
        || lower.starts_with("resources/fonts/")
        || lower.starts_with("resources/licenses/")
    {
        ComponentId::Fonts
    } else if lower.contains("syncplay") || lower.contains("tls") {
        ComponentId::Syncplay
    } else {
        ComponentId::Core
    }
}

struct TempFileGuard(PathBuf);

impl Drop for TempFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

enum Bcj2Sink {
    Main(Lzma2Writer<BufWriter<File>>),
    Addr(LzmaWriter<Vec<u8>>),
    Rc(Vec<u8>),
}

impl Write for Bcj2Sink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Bcj2Sink::Main(w) => w.write(buf),
            Bcj2Sink::Addr(w) => w.write(buf),
            Bcj2Sink::Rc(w) => w.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Bcj2Sink::Main(w) => w.flush(),
            Bcj2Sink::Addr(w) => w.flush(),
            Bcj2Sink::Rc(w) => w.flush(),
        }
    }
}

fn build_manifest(
    source_dir: &Path,
    version: &str,
) -> Result<(BTreeMap<String, PathBuf>, PackageManifest), ArchiveError> {
    let mut files: BTreeMap<String, PathBuf> = BTreeMap::new();
    collect_files_sorted(source_dir, source_dir, &mut files)?;

    let mut seen_lower = BTreeSet::new();
    let mut entries = Vec::with_capacity(files.len());
    let mut data_offset: u64 = 0;

    for (rel, full_path) in &files {
        sanitize_relative_path(rel)?;
        let lower_rel = normalize_rel(rel).to_ascii_lowercase();
        if !seen_lower.insert(lower_rel) {
            return Err(ArchiveError::UnsafePath(format!(
                "Case-insensitive collision in source tree: {rel}"
            )));
        }
        let (size, sha256) = hash_file(full_path)?;
        entries.push(PackageEntry {
            relative_path: rel.clone(),
            component: classify_component(rel),
            size,
            offset: data_offset,
            sha256,
        });
        data_offset = data_offset
            .checked_add(size)
            .ok_or_else(|| ArchiveError::CorruptBounds(rel.clone()))?;
    }

    if entries.is_empty() {
        return Err(ArchiveError::CorruptBounds(
            "Source payload directory is empty".to_string(),
        ));
    }

    let manifest = PackageManifest {
        version: version.trim().to_string(),
        total_bytes: data_offset,
        entries,
    };
    Ok((files, manifest))
}

fn copy_stream_chunks<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    buf: &mut [u8],
) -> Result<(), ArchiveError> {
    loop {
        let n = reader.read(buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
    }
    Ok(())
}

pub fn pack_directory(
    source_dir: &Path,
    out_archive: &Path,
) -> Result<PackageManifest, ArchiveError> {
    pack_directory_with_version(source_dir, out_archive, APP_VERSION)
}

pub fn pack_directory_with_version(
    source_dir: &Path,
    out_archive: &Path,
    version: &str,
) -> Result<PackageManifest, ArchiveError> {
    let (files, manifest) = build_manifest(source_dir, version)?;
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ArchiveError::BadHeader);
    }

    if let Some(parent) = out_archive.parent() {
        fs::create_dir_all(parent)?;
    }

    let tmp_name = format!(
        ".{}.{}.main.tmp",
        out_archive
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("epilod-payload"),
        std::process::id()
    );
    let main_tmp_path = out_archive.with_file_name(tmp_name);
    let _tmp_guard = TempFileGuard(main_tmp_path.clone());

    let dict_size = (manifest.total_bytes.min(u64::from(MAIN_DICT_MAX)) as u32)
        .clamp(MAIN_DICT_MIN, MAIN_DICT_MAX);
    let mut main_opts = Lzma2Options::with_preset(9);
    main_opts.lzma_options.dict_size = dict_size;

    let mut addr_opts = LzmaOptions::with_preset(6);
    addr_opts.lc = 0;
    addr_opts.lp = 2;
    addr_opts.pb = 2;
    addr_opts.dict_size = (manifest.total_bytes.min(u64::from(CALL_JUMP_DICT_MAX)) as u32)
        .clamp(MAIN_DICT_MIN, CALL_JUMP_DICT_MAX);

    let main_sink = Bcj2Sink::Main(Lzma2Writer::new(
        BufWriter::new(File::create(&main_tmp_path)?),
        main_opts,
    ));
    let call_sink = Bcj2Sink::Addr(LzmaWriter::new_use_header(Vec::new(), &addr_opts, None)?);
    let jump_sink = Bcj2Sink::Addr(LzmaWriter::new_use_header(Vec::new(), &addr_opts, None)?);
    let rc_sink = Bcj2Sink::Rc(Vec::new());

    let bcj2_opts = Bcj2Options {
        uncompressed_size: Some(manifest.total_bytes),
        relative_limit: Bcj2Options::RELATIVE_LIMIT_DEFAULT,
    };
    let mut bcj2 = Bcj2Writer::new([main_sink, call_sink, jump_sink, rc_sink], &bcj2_opts)?;

    let mut buf = vec![0u8; CHUNK_SIZE];
    for full_path in files.values() {
        let mut reader = BufReader::new(File::open(full_path)?);
        copy_stream_chunks(&mut reader, &mut bcj2, &mut buf)?;
    }

    let [main_done, call_done, jump_done, rc_done] = bcj2.finish()?;

    let mut main_file_writer = match main_done {
        Bcj2Sink::Main(w) => w.finish()?,
        _ => unreachable!(),
    };
    main_file_writer.flush()?;
    drop(main_file_writer);

    let call_bytes = match call_done {
        Bcj2Sink::Addr(w) => w.finish()?,
        _ => unreachable!(),
    };
    let jump_bytes = match jump_done {
        Bcj2Sink::Addr(w) => w.finish()?,
        _ => unreachable!(),
    };
    let rc_bytes = match rc_done {
        Bcj2Sink::Rc(v) => v,
        _ => unreachable!(),
    };

    let main_len = fs::metadata(&main_tmp_path)?.len();
    let header = Bcj2StreamHeader {
        dict_size,
        main_len,
        call_len: call_bytes.len() as u64,
        jump_len: jump_bytes.len() as u64,
        rc_len: rc_bytes.len() as u64,
    };

    let out_file = File::create(out_archive)?;
    let mut writer = BufWriter::new(out_file);
    writer.write_all(MAGIC_V2)?;
    writer.write_all(&(manifest_bytes.len() as u64).to_le_bytes())?;
    writer.write_all(&manifest_bytes)?;
    header.write_to(&mut writer)?;

    let mut main_reader = BufReader::new(File::open(&main_tmp_path)?);
    copy_stream_chunks(&mut main_reader, &mut writer, &mut buf)?;
    writer.write_all(&call_bytes)?;
    writer.write_all(&jump_bytes)?;
    writer.write_all(&rc_bytes)?;
    writer.flush()?;
    Ok(manifest)
}

#[cfg(test)]
pub(crate) fn pack_directory_v1(
    source_dir: &Path,
    out_archive: &Path,
    version: &str,
) -> Result<PackageManifest, ArchiveError> {
    let (files, manifest) = build_manifest(source_dir, version)?;
    let manifest_bytes = serde_json::to_vec(&manifest)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ArchiveError::BadHeader);
    }

    if let Some(parent) = out_archive.parent() {
        fs::create_dir_all(parent)?;
    }

    let out_file = File::create(out_archive)?;
    let mut writer = BufWriter::new(out_file);
    writer.write_all(MAGIC)?;
    writer.write_all(&(manifest_bytes.len() as u64).to_le_bytes())?;
    writer.write_all(&manifest_bytes)?;

    let mut buf = vec![0u8; CHUNK_SIZE];
    for full_path in files.values() {
        let mut reader = BufReader::new(File::open(full_path)?);
        copy_stream_chunks(&mut reader, &mut writer, &mut buf)?;
    }
    writer.flush()?;
    Ok(manifest)
}

pub fn detect_archive_source(archive_path: &Path) -> Result<ArchiveSource, ArchiveError> {
    let mut file = File::open(archive_path)?;
    let file_len = file.metadata()?.len();
    if file_len < 16 {
        return Err(ArchiveError::BadHeader);
    }

    let mut head_magic = [0u8; 8];
    file.read_exact(&mut head_magic)?;
    if parse_magic(&head_magic).is_some() {
        return Ok(ArchiveSource {
            start_offset: 0,
            end_offset: file_len,
        });
    }

    if let Some(src) = try_read_sfx_trailer_at_end(&mut file, file_len)? {
        return Ok(src);
    }

    // Authenticode signing (`signtool.exe`) appends `WIN_CERTIFICATE` (with 0..=7 bytes of
    // 8-byte alignment padding) *after* the SFX trailer. Use PE DataDirectory[4] to step
    // backwards to the pre-signature end-of-payload boundary.
    if let Some((cert_offset, _cert_size)) = parse_pe_security_directory(&mut file, file_len) {
        for pad in 0..=7u64 {
            let Some(candidate_end) = cert_offset.checked_sub(pad) else {
                break;
            };
            if pad > 0 {
                file.seek(SeekFrom::Start(candidate_end))?;
                let mut pad_bytes = [0u8; 7];
                let pad_usize = pad as usize;
                file.read_exact(&mut pad_bytes[..pad_usize])?;
                if !pad_bytes[..pad_usize].iter().all(|&b| b == 0) {
                    continue;
                }
            }
            if let Some(src) = try_read_sfx_trailer_at_end(&mut file, candidate_end)? {
                return Ok(src);
            }
        }
    }

    Err(ArchiveError::BadHeader)
}

fn try_read_sfx_trailer_at_end(
    file: &mut File,
    candidate_end: u64,
) -> Result<Option<ArchiveSource>, ArchiveError> {
    if candidate_end < SFX_TRAILER_SIZE + 16 {
        return Ok(None);
    }

    file.seek(SeekFrom::Start(candidate_end - SFX_TRAILER_SIZE))?;
    let mut trailer = [0u8; 20];
    file.read_exact(&mut trailer)?;
    if &trailer[8..20] != SFX_TRAILER_MAGIC {
        return Ok(None);
    }

    let mut offset_bytes = [0u8; 8];
    offset_bytes.copy_from_slice(&trailer[0..8]);
    let start_offset = u64::from_le_bytes(offset_bytes);
    let end_offset = candidate_end - SFX_TRAILER_SIZE;
    if start_offset > end_offset.saturating_sub(16) {
        return Ok(None);
    }

    file.seek(SeekFrom::Start(start_offset))?;
    let mut payload_magic = [0u8; 8];
    file.read_exact(&mut payload_magic)?;
    if parse_magic(&payload_magic).is_some() {
        return Ok(Some(ArchiveSource {
            start_offset,
            end_offset,
        }));
    }

    Ok(None)
}

pub fn attach_payload_sfx(
    base_exe: &Path,
    archive_path: &Path,
    out_exe: &Path,
) -> Result<u64, ArchiveError> {
    // Validate archive integrity before embedding
    let _ = read_manifest(archive_path)?;

    if let Some(parent) = out_exe.parent() {
        fs::create_dir_all(parent)?;
    }

    let mut exe_reader = BufReader::new(File::open(base_exe)?);
    let mut pkg_reader = BufReader::new(File::open(archive_path)?);
    let mut writer = BufWriter::new(File::create(out_exe)?);

    let mut buf = vec![0u8; CHUNK_SIZE];
    let mut exe_len = 0u64;
    loop {
        let n = exe_reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        exe_len = exe_len
            .checked_add(n as u64)
            .ok_or_else(|| ArchiveError::CorruptBounds("base_exe".to_string()))?;
    }

    let mut total_written = exe_len;
    loop {
        let n = pkg_reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        total_written = total_written
            .checked_add(n as u64)
            .ok_or_else(|| ArchiveError::CorruptBounds("payload".to_string()))?;
    }

    writer.write_all(&exe_len.to_le_bytes())?;
    writer.write_all(SFX_TRAILER_MAGIC)?;
    writer.flush()?;

    Ok(total_written + SFX_TRAILER_SIZE)
}

fn normalize_rel(rel: &str) -> String {
    rel.replace('\\', "/")
}

fn read_manifest_internal(
    archive_path: &Path,
) -> Result<(ArchiveSource, ArchiveFormat, PackageManifest, u64), ArchiveError> {
    let source = detect_archive_source(archive_path)?;
    let mut file = File::open(archive_path)?;
    file.seek(SeekFrom::Start(source.start_offset))?;

    let mut magic = [0u8; 8];
    file.read_exact(&mut magic)?;
    let format = parse_magic(&magic).ok_or(ArchiveError::BadHeader)?;

    let mut len_buf = [0u8; 8];
    file.read_exact(&mut len_buf)?;
    let manifest_len = u64::from_le_bytes(len_buf) as usize;
    if manifest_len == 0 || manifest_len > MAX_MANIFEST_BYTES {
        return Err(ArchiveError::BadHeader);
    }

    let data_start = source
        .start_offset
        .checked_add(16u64)
        .and_then(|v| v.checked_add(manifest_len as u64))
        .ok_or(ArchiveError::BadHeader)?;
    if data_start > source.end_offset {
        return Err(ArchiveError::BadHeader);
    }

    let mut manifest_bytes = vec![0u8; manifest_len];
    file.read_exact(&mut manifest_bytes)?;
    let manifest: PackageManifest = serde_json::from_slice(&manifest_bytes)?;
    match format {
        ArchiveFormat::RawV1 => manifest.validate_layout(data_start, source.end_offset)?,
        ArchiveFormat::Bcj2Lzma2V2 => {
            manifest.validate_compressed_layout()?;
            let _ = Bcj2StreamHeader::read_checked(&mut file, data_start, source.end_offset)?;
        }
    }
    Ok((source, format, manifest, data_start))
}

pub fn read_manifest(archive_path: &Path) -> Result<(PackageManifest, u64), ArchiveError> {
    let (_source, _format, manifest, data_start) = read_manifest_internal(archive_path)?;
    Ok((manifest, data_start))
}

pub fn extract_verified_streaming<F>(
    archive_path: &Path,
    dest_dir: &Path,
    cancel_flag: &AtomicBool,
    on_progress: F,
) -> Result<PackageManifest, ArchiveError>
where
    F: FnMut(ExtractProgress),
{
    extract_entries_verified_streaming(
        archive_path,
        dest_dir,
        &BTreeSet::new(),
        cancel_flag,
        on_progress,
    )
}

struct ExtractContext<'a, F> {
    dest_dir: &'a Path,
    reused_rel_paths: &'a BTreeSet<String>,
    total_bytes: u64,
    files_total: usize,
    total_done: u64,
    buf: Vec<u8>,
    cancel_flag: &'a AtomicBool,
    on_progress: &'a mut F,
}

impl<'a, F> ExtractContext<'a, F>
where
    F: FnMut(ExtractProgress),
{
    fn new(
        manifest: &PackageManifest,
        dest_dir: &'a Path,
        reused_rel_paths: &'a BTreeSet<String>,
        cancel_flag: &'a AtomicBool,
        on_progress: &'a mut F,
    ) -> Self {
        Self {
            dest_dir,
            reused_rel_paths,
            total_bytes: manifest.total_bytes,
            files_total: manifest.entries.len(),
            total_done: 0,
            buf: vec![0u8; CHUNK_SIZE],
            cancel_flag,
            on_progress,
        }
    }

    fn emit_reused(&mut self, entry: &PackageEntry, idx: usize) {
        self.total_done = self.total_done.saturating_add(entry.size);
        (self.on_progress)(ExtractProgress {
            action: ExtractAction::ReusedVerified,
            component: entry.component,
            relative_path: entry.relative_path.clone(),
            file_bytes_done: entry.size,
            file_bytes_total: entry.size,
            total_bytes_done: self.total_done,
            total_bytes: self.total_bytes,
            files_done: idx + 1,
            files_total: self.files_total,
        });
    }

    fn stream_entry<R: Read>(
        &mut self,
        reader: &mut R,
        entry: &PackageEntry,
        idx: usize,
    ) -> Result<(), ArchiveError> {
        let clean_rel = sanitize_relative_path(&entry.relative_path)?;
        let out_path = self.dest_dir.join(&clean_rel);
        if let Some(parent) = out_path.parent() {
            fs::create_dir_all(parent)?;
        }

        let mut writer = BufWriter::new(File::create(&out_path)?);
        let mut hasher = Sha256::new();
        let mut remaining = entry.size;
        let mut file_done = 0u64;

        (self.on_progress)(ExtractProgress {
            action: ExtractAction::Unpacking,
            component: entry.component,
            relative_path: entry.relative_path.clone(),
            file_bytes_done: 0,
            file_bytes_total: entry.size,
            total_bytes_done: self.total_done,
            total_bytes: self.total_bytes,
            files_done: idx,
            files_total: self.files_total,
        });

        while remaining > 0 {
            if self.cancel_flag.load(Ordering::SeqCst) {
                return Err(ArchiveError::Cancelled);
            }
            let want = remaining.min(self.buf.len() as u64) as usize;
            reader.read_exact(&mut self.buf[..want])?;
            writer.write_all(&self.buf[..want])?;
            hasher.update(&self.buf[..want]);
            remaining -= want as u64;
            file_done += want as u64;
            self.total_done += want as u64;

            (self.on_progress)(ExtractProgress {
                action: ExtractAction::Unpacking,
                component: entry.component,
                relative_path: entry.relative_path.clone(),
                file_bytes_done: file_done,
                file_bytes_total: entry.size,
                total_bytes_done: self.total_done,
                total_bytes: self.total_bytes,
                files_done: idx,
                files_total: self.files_total,
            });
        }

        writer.flush()?;

        (self.on_progress)(ExtractProgress {
            action: ExtractAction::VerifyingDigest,
            component: entry.component,
            relative_path: entry.relative_path.clone(),
            file_bytes_done: entry.size,
            file_bytes_total: entry.size,
            total_bytes_done: self.total_done,
            total_bytes: self.total_bytes,
            files_done: idx + 1,
            files_total: self.files_total,
        });

        let digest_hex = hex_lower(&hasher.finalize());
        if digest_hex != entry.sha256.to_ascii_lowercase() {
            return Err(ArchiveError::ChecksumMismatch {
                path: entry.relative_path.clone(),
                expected: entry.sha256.clone(),
                actual: digest_hex,
            });
        }

        Ok(())
    }

    fn drain_exact<R: Read>(
        &mut self,
        reader: &mut R,
        mut remaining: u64,
    ) -> Result<(), ArchiveError> {
        while remaining > 0 {
            if self.cancel_flag.load(Ordering::SeqCst) {
                return Err(ArchiveError::Cancelled);
            }
            let want = remaining.min(self.buf.len() as u64) as usize;
            reader.read_exact(&mut self.buf[..want])?;
            remaining -= want as u64;
        }
        Ok(())
    }
}

fn open_slice(
    path: &Path,
    offset: u64,
    len: u64,
) -> Result<BufReader<io::Take<File>>, ArchiveError> {
    let mut file = File::open(path)?;
    file.seek(SeekFrom::Start(offset))?;
    Ok(BufReader::new(file.take(len)))
}

fn extract_v1_entries<F: FnMut(ExtractProgress)>(
    archive_path: &Path,
    source: ArchiveSource,
    data_start: u64,
    manifest: &PackageManifest,
    ctx: &mut ExtractContext<'_, F>,
) -> Result<(), ArchiveError> {
    let mut reader = BufReader::new(File::open(archive_path)?);

    for (idx, entry) in manifest.entries.iter().enumerate() {
        if ctx.cancel_flag.load(Ordering::SeqCst) {
            return Err(ArchiveError::Cancelled);
        }

        if ctx
            .reused_rel_paths
            .contains(&normalize_rel(&entry.relative_path))
        {
            ctx.emit_reused(entry, idx);
            continue;
        }

        let abs_start = data_start
            .checked_add(entry.offset)
            .ok_or_else(|| ArchiveError::CorruptBounds(entry.relative_path.clone()))?;
        let abs_end = abs_start
            .checked_add(entry.size)
            .ok_or_else(|| ArchiveError::CorruptBounds(entry.relative_path.clone()))?;
        if abs_end > source.end_offset {
            return Err(ArchiveError::CorruptBounds(entry.relative_path.clone()));
        }

        reader.seek(SeekFrom::Start(abs_start))?;
        ctx.stream_entry(&mut reader, entry, idx)?;
    }

    Ok(())
}

fn extract_v2_entries<F: FnMut(ExtractProgress)>(
    archive_path: &Path,
    source: ArchiveSource,
    data_start: u64,
    manifest: &PackageManifest,
    ctx: &mut ExtractContext<'_, F>,
) -> Result<(), ArchiveError> {
    let mut meta_file = File::open(archive_path)?;
    let hdr = Bcj2StreamHeader::read_checked(&mut meta_file, data_start, source.end_offset)?;

    let main_start = data_start + BCJ2_HEADER_SIZE;
    let call_start = main_start + hdr.main_len;
    let jump_start = call_start + hdr.call_len;
    let rc_start = jump_start + hdr.jump_len;

    let main_reader: Box<dyn Read> = Box::new(Lzma2Reader::new(
        open_slice(archive_path, main_start, hdr.main_len)?,
        hdr.dict_size,
        None,
    ));
    let call_reader: Box<dyn Read> = Box::new(LzmaReader::new_mem_limit(
        open_slice(archive_path, call_start, hdr.call_len)?,
        u32::MAX,
        None,
    )?);
    let jump_reader: Box<dyn Read> = Box::new(LzmaReader::new_mem_limit(
        open_slice(archive_path, jump_start, hdr.jump_len)?,
        u32::MAX,
        None,
    )?);
    let rc_reader: Box<dyn Read> = Box::new(open_slice(archive_path, rc_start, hdr.rc_len)?);

    let mut bcj2 = Bcj2Reader::try_new(
        vec![main_reader, call_reader, jump_reader, rc_reader],
        manifest.total_bytes,
    )?;

    let mut early_exited = false;
    for (idx, entry) in manifest.entries.iter().enumerate() {
        if ctx.cancel_flag.load(Ordering::SeqCst) {
            return Err(ArchiveError::Cancelled);
        }

        if ctx
            .reused_rel_paths
            .contains(&normalize_rel(&entry.relative_path))
        {
            let remaining_all_reused = manifest.entries[idx..].iter().all(|item| {
                ctx.reused_rel_paths
                    .contains(&normalize_rel(&item.relative_path))
            });
            if remaining_all_reused {
                for (rem_offset, rem_entry) in manifest.entries[idx..].iter().enumerate() {
                    if ctx.cancel_flag.load(Ordering::SeqCst) {
                        return Err(ArchiveError::Cancelled);
                    }
                    ctx.emit_reused(rem_entry, idx + rem_offset);
                }
                early_exited = true;
                break;
            }

            ctx.drain_exact(&mut bcj2, entry.size)?;
            ctx.emit_reused(entry, idx);
            continue;
        }

        ctx.stream_entry(&mut bcj2, entry, idx)?;
    }

    if !early_exited {
        let _ = bcj2.finish()?;
    }

    Ok(())
}

pub fn extract_entries_verified_streaming<F>(
    archive_path: &Path,
    dest_dir: &Path,
    reused_rel_paths: &BTreeSet<String>,
    cancel_flag: &AtomicBool,
    mut on_progress: F,
) -> Result<PackageManifest, ArchiveError>
where
    F: FnMut(ExtractProgress),
{
    let (source, format, manifest, data_start) = read_manifest_internal(archive_path)?;
    fs::create_dir_all(dest_dir)?;

    let mut ctx = ExtractContext::new(
        &manifest,
        dest_dir,
        reused_rel_paths,
        cancel_flag,
        &mut on_progress,
    );

    match format {
        ArchiveFormat::RawV1 => {
            extract_v1_entries(archive_path, source, data_start, &manifest, &mut ctx)?
        }
        ArchiveFormat::Bcj2Lzma2V2 => {
            extract_v2_entries(archive_path, source, data_start, &manifest, &mut ctx)?
        }
    }

    Ok(manifest)
}

fn collect_files_sorted(
    root: &Path,
    dir: &Path,
    out: &mut BTreeMap<String, PathBuf>,
) -> Result<(), ArchiveError> {
    for item in fs::read_dir(dir)? {
        let entry = item?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?;
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            collect_files_sorted(root, &path, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(root)
                .map_err(|_| ArchiveError::UnsafePath(path.display().to_string()))?;
            let rel_str = rel.to_string_lossy().replace('\\', "/");
            out.insert(rel_str, path);
        }
    }
    Ok(())
}

pub fn hash_file(path: &Path) -> Result<(u64, String), ArchiveError> {
    let mut reader = BufReader::new(File::open(path)?);
    let mut hasher = Sha256::new();
    let mut buf = [0u8; CHUNK_SIZE];
    let mut total = 0u64;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        total += n as u64;
    }
    Ok((total, hex_lower(&hasher.finalize())))
}

pub fn copy_uninstaller_executable(
    current_exe: &Path,
    dest_exe: &Path,
) -> Result<(), ArchiveError> {
    let strip_len = match detect_archive_source(current_exe) {
        Ok(src) if src.start_offset > 4096 && !has_pe_authenticode_signature(current_exe) => {
            Some(src.start_offset)
        }
        _ => None,
    };

    if let Some(parent) = dest_exe.parent() {
        fs::create_dir_all(parent)?;
    }

    let tmp_path = dest_exe.with_file_name(format!(
        ".{}.tmp",
        dest_exe
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("epilod-uninstall.exe")
    ));

    let write_res = (|| -> Result<(), ArchiveError> {
        let mut reader = BufReader::new(File::open(current_exe)?);
        let mut writer = BufWriter::new(File::create(&tmp_path)?);
        let mut buf = vec![0u8; CHUNK_SIZE];

        match strip_len {
            Some(limit) => {
                let mut remaining = limit;
                while remaining > 0 {
                    let want = remaining.min(buf.len() as u64) as usize;
                    let n = reader.read(&mut buf[..want])?;
                    if n == 0 {
                        break;
                    }
                    writer.write_all(&buf[..n])?;
                    remaining -= n as u64;
                }
            }
            None => loop {
                let n = reader.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                writer.write_all(&buf[..n])?;
            },
        }

        writer.flush()?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }

    let mut attempt = 0usize;
    const BACKOFF_MS: [u64; 5] = [100, 150, 250, 400, 600];
    let commit_res = loop {
        clear_readonly_attr(dest_exe);
        if dest_exe.exists() {
            let _ = fs::remove_file(dest_exe);
        }
        match fs::rename(&tmp_path, dest_exe) {
            Ok(()) => break Ok(()),
            Err(err) if attempt < BACKOFF_MS.len() && is_transient_fs_err(&err) => {
                std::thread::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt]));
                attempt += 1;
            }
            Err(_) => {
                // Fallback to direct overwrite if rename was blocked after clearing ReadOnly
                clear_readonly_attr(dest_exe);
                match fs::copy(&tmp_path, dest_exe) {
                    Ok(_) => {
                        let _ = fs::remove_file(&tmp_path);
                        break Ok(());
                    }
                    Err(copy_err)
                        if attempt < BACKOFF_MS.len() && is_transient_fs_err(&copy_err) =>
                    {
                        std::thread::sleep(std::time::Duration::from_millis(BACKOFF_MS[attempt]));
                        attempt += 1;
                    }
                    Err(copy_err) => break Err(copy_err),
                }
            }
        }
    };

    if let Err(err) = commit_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(ArchiveError::Io(err));
    }

    Ok(())
}

fn clear_readonly_attr(path: &Path) {
    if let Ok(meta) = fs::metadata(path) {
        let mut perms = meta.permissions();
        if perms.readonly() {
            #[allow(clippy::permissions_set_readonly_false)]
            perms.set_readonly(false);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

fn is_transient_fs_err(err: &std::io::Error) -> bool {
    err.kind() == std::io::ErrorKind::PermissionDenied
        || matches!(err.raw_os_error(), Some(5 | 32 | 33))
}

pub fn estimate_uninstaller_copy_bytes(exe_path: &Path) -> u64 {
    match detect_archive_source(exe_path) {
        Ok(src) if src.start_offset > 4096 && !has_pe_authenticode_signature(exe_path) => {
            src.start_offset
        }
        _ => fs::metadata(exe_path).map(|m| m.len()).unwrap_or(0),
    }
}

fn parse_pe_security_directory(file: &mut File, file_len: u64) -> Option<(u64, u64)> {
    if file_len < 0x40 {
        return None;
    }
    file.seek(SeekFrom::Start(0)).ok()?;
    let mut dos = [0u8; 0x40];
    file.read_exact(&mut dos).ok()?;
    if &dos[0..2] != b"MZ" {
        return None;
    }
    let lfanew = u32::from_le_bytes([dos[0x3C], dos[0x3D], dos[0x3E], dos[0x3F]]) as u64;
    if lfanew.checked_add(26)? > file_len {
        return None;
    }

    file.seek(SeekFrom::Start(lfanew)).ok()?;
    let mut coff = [0u8; 24];
    file.read_exact(&mut coff).ok()?;
    if &coff[0..4] != b"PE\0\0" {
        return None;
    }
    let size_of_opt = u16::from_le_bytes([coff[20], coff[21]]) as u64;

    let opt_start = lfanew + 24;
    let mut magic_buf = [0u8; 2];
    file.seek(SeekFrom::Start(opt_start)).ok()?;
    file.read_exact(&mut magic_buf).ok()?;
    let magic = u16::from_le_bytes(magic_buf);

    let (num_rva_rel, sec_dir_rel) = match magic {
        0x20B => (108u64, 144u64), // PE32+
        0x10B => (92u64, 128u64),  // PE32
        _ => return None,
    };

    if size_of_opt != 0 && size_of_opt < sec_dir_rel + 8 {
        return None;
    }
    if opt_start.checked_add(sec_dir_rel + 8)? > file_len {
        return None;
    }

    file.seek(SeekFrom::Start(opt_start + num_rva_rel)).ok()?;
    let mut rva_count_buf = [0u8; 4];
    file.read_exact(&mut rva_count_buf).ok()?;
    let num_rva = u32::from_le_bytes(rva_count_buf);
    if size_of_opt != 0 && num_rva <= 4 {
        return None;
    }

    file.seek(SeekFrom::Start(opt_start + sec_dir_rel)).ok()?;
    let mut sec_buf = [0u8; 8];
    file.read_exact(&mut sec_buf).ok()?;
    let cert_offset = u32::from_le_bytes([sec_buf[0], sec_buf[1], sec_buf[2], sec_buf[3]]) as u64;
    let cert_size = u32::from_le_bytes([sec_buf[4], sec_buf[5], sec_buf[6], sec_buf[7]]) as u64;
    if cert_offset == 0 || cert_size == 0 {
        return None;
    }
    let cert_end = cert_offset.checked_add(cert_size)?;
    if cert_end > file_len {
        return None;
    }
    Some((cert_offset, cert_size))
}

pub fn has_pe_authenticode_signature(exe_path: &Path) -> bool {
    let Ok(mut file) = File::open(exe_path) else {
        return false;
    };
    let Ok(meta) = file.metadata() else {
        return false;
    };
    parse_pe_security_directory(&mut file, meta.len()).is_some()
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        let _ = write!(&mut out, "{b:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_tmp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time")
            .as_nanos();
        std::env::temp_dir().join(format!("epilod_inst_test_{tag}_{nanos}"))
    }

    fn make_synthetic_pe32_plus_stub(stub_len: usize, lfanew: usize) -> Vec<u8> {
        let mut buf = vec![0u8; stub_len];
        buf[0] = b'M';
        buf[1] = b'Z';
        buf[0x3C..0x40].copy_from_slice(&(lfanew as u32).to_le_bytes());
        buf[lfanew..lfanew + 4].copy_from_slice(b"PE\0\0");
        buf[lfanew + 20..lfanew + 22].copy_from_slice(&(240u16).to_le_bytes());
        let opt = lfanew + 24;
        buf[opt..opt + 2].copy_from_slice(&(0x020Bu16).to_le_bytes());
        buf[opt + 108..opt + 112].copy_from_slice(&(16u32).to_le_bytes());
        buf
    }

    fn append_synthetic_authenticode(exe_path: &Path, lfanew: usize, align_pad: usize) {
        let mut raw = fs::read(exe_path).unwrap();
        raw.extend(std::iter::repeat_n(0u8, align_pad));
        let cert_offset = raw.len() as u32;
        let cert_blob = vec![0x30u8; 256];
        let cert_size = cert_blob.len() as u32;
        raw.extend_from_slice(&cert_blob);
        let opt = lfanew + 24;
        raw[opt + 144..opt + 148].copy_from_slice(&cert_offset.to_le_bytes());
        raw[opt + 148..opt + 152].copy_from_slice(&cert_size.to_le_bytes());
        fs::write(exe_path, raw).unwrap();
    }

    #[test]
    fn sanitize_blocks_zip_slip_drives_and_reserved_names() {
        assert!(sanitize_relative_path("Epilod Party.exe").is_ok());
        assert!(sanitize_relative_path("resources/fonts/Inter-Regular.ttf").is_ok());

        assert!(sanitize_relative_path("../evil.exe").is_err());
        assert!(sanitize_relative_path("resources/../../evil.exe").is_err());
        assert!(sanitize_relative_path("/etc/passwd").is_err());
        assert!(sanitize_relative_path(r"\Windows\System32\cmd.exe").is_err());
        assert!(sanitize_relative_path("C:\\evil.exe").is_err());
        assert!(sanitize_relative_path("resources/CON.txt").is_err());
        assert!(sanitize_relative_path("").is_err());
    }

    #[test]
    fn pack_and_stream_extract_verifies_checksums_and_reports_progress() {
        let root = unique_tmp_dir("roundtrip");
        let src = root.join("src");
        let pkg = root.join("epilod.epkg");
        let out = root.join("out");

        fs::create_dir_all(src.join("resources/mpv")).unwrap();
        fs::create_dir_all(src.join("resources/fonts")).unwrap();
        fs::write(src.join("Epilod Party.exe"), vec![0x5Au8; 100_000]).unwrap();
        fs::write(src.join("resources/mpv/mpv.exe"), vec![0xAAu8; 70_000]).unwrap();
        fs::write(src.join("resources/fonts/Inter-Regular.ttf"), b"font-bytes").unwrap();

        let manifest = pack_directory(&src, &pkg).unwrap();
        assert_eq!(manifest.entries.len(), 3);

        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let unpacked = extract_verified_streaming(&pkg, &out, &cancel, |ev| {
            events.push(ev);
        })
        .unwrap();

        assert_eq!(unpacked.entries.len(), 3);
        assert!(!events.is_empty());
        assert_eq!(
            events.last().unwrap().total_bytes_done,
            manifest.total_bytes
        );
        assert_eq!(
            fs::read(out.join("resources/mpv/mpv.exe")).unwrap().len(),
            70_000
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn extract_detects_corrupted_payload_bytes() {
        let root = unique_tmp_dir("tamper");
        let src = root.join("src");
        let pkg_v1 = root.join("epilod_v1.epkg");
        let pkg_v2 = root.join("epilod_v2.epkg");
        let out = root.join("out");

        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("Epilod Party.exe"), b"original-payload-bytes").unwrap();

        // Raw V1 archive: flipping final payload byte yields ChecksumMismatch
        pack_directory_v1(&src, &pkg_v1, APP_VERSION).unwrap();
        let mut raw_v1 = fs::read(&pkg_v1).unwrap();
        let last_v1 = raw_v1.len() - 1;
        raw_v1[last_v1] ^= 0xFF;
        fs::write(&pkg_v1, raw_v1).unwrap();

        let cancel = AtomicBool::new(false);
        let err_v1 = extract_verified_streaming(&pkg_v1, &out, &cancel, |_| {}).unwrap_err();
        assert!(matches!(err_v1, ArchiveError::ChecksumMismatch { .. }));

        // Compressed V2 archive: corrupting compressed stream triggers error cleanly
        pack_directory(&src, &pkg_v2).unwrap();
        let mut raw_v2 = fs::read(&pkg_v2).unwrap();
        let last_v2 = raw_v2.len() - 1;
        raw_v2[last_v2] ^= 0xFF;
        fs::write(&pkg_v2, raw_v2).unwrap();

        let err_v2 = extract_verified_streaming(&pkg_v2, &out, &cancel, |_| {}).unwrap_err();
        assert!(matches!(
            err_v2,
            ArchiveError::Io(_) | ArchiveError::ChecksumMismatch { .. }
        ));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn compressed_v2_reused_skip_and_midstream_drain_work() {
        let root = unique_tmp_dir("v2_reuse");
        let src = root.join("src");
        let pkg = root.join("epilod.epkg");

        fs::create_dir_all(src.join("resources/fonts")).unwrap();
        fs::create_dir_all(src.join("resources/mpv")).unwrap();
        // Entries sort lexicographically:
        // 0: Epilod Party.exe
        // 1: resources/fonts/Inter-Regular.ttf
        // 2: resources/mpv/mpv.exe
        let app_bytes = [0xE8u8, 0x10, 0x00, 0x00, 0x00, 0x90, 0x90, 0xC3].repeat(1024);
        let font_bytes = b"font-payload-data".repeat(256);
        let mpv_bytes = [0x0Fu8, 0x84, 0x20, 0x00, 0x00, 0x00, 0x55, 0x89].repeat(2048);

        fs::write(src.join("Epilod Party.exe"), &app_bytes).unwrap();
        fs::write(src.join("resources/fonts/Inter-Regular.ttf"), &font_bytes).unwrap();
        fs::write(src.join("resources/mpv/mpv.exe"), &mpv_bytes).unwrap();

        let manifest = pack_directory(&src, &pkg).unwrap();
        assert_eq!(manifest.entries.len(), 3);
        let (read_back, _) = read_manifest(&pkg).unwrap();
        assert_eq!(read_back, manifest);

        // Case 1: trailing entry reused -> early exit skips decompressing mpv.exe
        let out_tail = root.join("out_tail");
        let mut reused_tail = BTreeSet::new();
        reused_tail.insert("resources/mpv/mpv.exe".to_string());
        let mut actions_tail = Vec::new();
        let cancel = AtomicBool::new(false);
        extract_entries_verified_streaming(&pkg, &out_tail, &reused_tail, &cancel, |ev| {
            actions_tail.push((ev.relative_path, ev.action));
        })
        .unwrap();
        assert_eq!(
            fs::read(out_tail.join("Epilod Party.exe")).unwrap(),
            app_bytes
        );
        assert_eq!(
            fs::read(out_tail.join("resources/fonts/Inter-Regular.ttf")).unwrap(),
            font_bytes
        );
        assert!(!out_tail.join("resources/mpv/mpv.exe").exists());
        assert!(actions_tail
            .iter()
            .any(|(p, a)| { p == "resources/mpv/mpv.exe" && *a == ExtractAction::ReusedVerified }));

        // Case 2: middle entry reused while later entry is unpacked -> stream drains cleanly
        let out_mid = root.join("out_mid");
        let mut reused_mid = BTreeSet::new();
        reused_mid.insert("resources/fonts/Inter-Regular.ttf".to_string());
        extract_entries_verified_streaming(&pkg, &out_mid, &reused_mid, &cancel, |_| {}).unwrap();
        assert_eq!(
            fs::read(out_mid.join("Epilod Party.exe")).unwrap(),
            app_bytes
        );
        assert!(!out_mid.join("resources/fonts/Inter-Regular.ttf").exists());
        assert_eq!(
            fs::read(out_mid.join("resources/mpv/mpv.exe")).unwrap(),
            mpv_bytes
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_layout_rejects_case_collisions_and_corrupt_bounds() {
        let manifest = PackageManifest {
            version: "0.1.0".into(),
            total_bytes: 20,
            entries: vec![
                PackageEntry {
                    relative_path: "resources/Font.ttf".into(),
                    component: ComponentId::Fonts,
                    size: 10,
                    offset: 0,
                    sha256: "a".repeat(64),
                },
                PackageEntry {
                    relative_path: "resources/font.ttf".into(),
                    component: ComponentId::Fonts,
                    size: 10,
                    offset: 10,
                    sha256: "b".repeat(64),
                },
            ],
        };
        assert!(manifest.validate_layout(100, 200).is_err());

        let oob = PackageManifest {
            version: "0.1.0".into(),
            total_bytes: 10,
            entries: vec![PackageEntry {
                relative_path: "Epilod Party.exe".into(),
                component: ComponentId::Core,
                size: 10,
                offset: 0,
                sha256: "a".repeat(64),
            }],
        };
        assert!(oob.validate_layout(100, 105).is_err());
        assert!(oob.validate_layout(100, 110).is_ok());
    }

    #[test]
    fn sfx_overlay_attaches_and_extracts_verified_payload() {
        let root = unique_tmp_dir("sfx");
        let src = root.join("src");
        let pkg = root.join("epilod.epkg");
        let stub = root.join("stub-setup.exe");
        let sfx = root.join("Epilod Party Setup.exe");
        let out = root.join("out");

        fs::create_dir_all(src.join("resources/fonts")).unwrap();
        fs::write(
            &stub,
            vec![0x4Du8, 0x5A, 0x90, 0x00, 0xDE, 0xAD, 0xBE, 0xEF],
        )
        .unwrap();
        fs::write(src.join("Epilod Party.exe"), vec![0x33u8; 4096]).unwrap();
        fs::write(
            src.join("resources/fonts/NotoSansArabic-Regular.ttf"),
            b"arabic-font",
        )
        .unwrap();

        let manifest = pack_directory(&src, &pkg).unwrap();
        let total_size = attach_payload_sfx(&stub, &pkg, &sfx).unwrap();
        assert!(total_size > fs::metadata(&pkg).unwrap().len());

        let (read_back, _) = read_manifest(&sfx).unwrap();
        assert_eq!(read_back, manifest);

        let cancel = AtomicBool::new(false);
        extract_verified_streaming(&sfx, &out, &cancel, |_| {}).unwrap();
        assert_eq!(
            fs::read(out.join("Epilod Party.exe")).unwrap(),
            vec![0x33u8; 4096]
        );
        assert_eq!(
            fs::read(out.join("resources/fonts/NotoSansArabic-Regular.ttf")).unwrap(),
            b"arabic-font"
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_uninstaller_strips_unsigned_sfx_and_preserves_signed_pe() {
        let root = unique_tmp_dir("uninst_copy");
        let src = root.join("src");
        let pkg = root.join("epilod.epkg");

        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("Epilod Party.exe"), vec![0x11u8; 8192]).unwrap();
        pack_directory(&src, &pkg).unwrap();

        // Build synthetic unsigned PE32+ stub (> 4096 bytes) with empty Certificate Table
        let unsigned_stub = make_synthetic_pe32_plus_stub(8192, 0x80);
        let stub_path = root.join("unsigned_stub.exe");
        fs::write(&stub_path, &unsigned_stub).unwrap();

        let sfx_unsigned = root.join("SetupUnsigned.exe");
        attach_payload_sfx(&stub_path, &pkg, &sfx_unsigned).unwrap();
        assert!(fs::metadata(&sfx_unsigned).unwrap().len() > unsigned_stub.len() as u64);

        let uninst_unsigned = root.join("out_unsigned/epilod-uninstall.exe");
        copy_uninstaller_executable(&sfx_unsigned, &uninst_unsigned).unwrap();
        assert_eq!(fs::read(&uninst_unsigned).unwrap(), unsigned_stub);

        // Synthetic Authenticode-signed PE32+: DataDirectory[4] points to WIN_CERTIFICATE at EOF
        let sfx_signed = root.join("SetupSigned.exe");
        attach_payload_sfx(&stub_path, &pkg, &sfx_signed).unwrap();
        append_synthetic_authenticode(&sfx_signed, 0x80, 3);

        let uninst_signed = root.join("out_signed/epilod-uninstall.exe");
        copy_uninstaller_executable(&sfx_signed, &uninst_signed).unwrap();
        assert_eq!(
            fs::metadata(&uninst_signed).unwrap().len(),
            fs::metadata(&sfx_signed).unwrap().len()
        );

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_archive_source_handles_authenticode_trailer_and_alignment_padding() {
        let root = unique_tmp_dir("auth_sfx");
        let src = root.join("src");
        let pkg = root.join("epilod.epkg");

        fs::create_dir_all(&src).unwrap();
        fs::write(src.join("Epilod Party.exe"), vec![0x7Au8; 6000]).unwrap();
        let manifest = pack_directory(&src, &pkg).unwrap();

        for pad in [0usize, 1, 3, 7] {
            let stub = make_synthetic_pe32_plus_stub(8192, 0x1200);
            let stub_path = root.join(format!("stub_{pad}.exe"));
            fs::write(&stub_path, &stub).unwrap();

            let sfx = root.join(format!("Setup_{pad}.exe"));
            attach_payload_sfx(&stub_path, &pkg, &sfx).unwrap();
            append_synthetic_authenticode(&sfx, 0x1200, pad);

            assert!(has_pe_authenticode_signature(&sfx));
            let (read_back, _) = read_manifest(&sfx).unwrap();
            assert_eq!(read_back, manifest);

            let out = root.join(format!("out_{pad}"));
            let cancel = AtomicBool::new(false);
            extract_verified_streaming(&sfx, &out, &cancel, |_| {}).unwrap();
            assert_eq!(
                fs::read(out.join("Epilod Party.exe")).unwrap(),
                vec![0x7Au8; 6000]
            );
        }

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_uninstaller_overwrites_readonly_destination() {
        let root = unique_tmp_dir("uninst_readonly");
        fs::create_dir_all(&root).unwrap();
        let src = root.join("src_setup.exe");
        let dst = root.join("epilod-uninstall.exe");
        fs::write(&src, b"new-uninstaller-stub").unwrap();
        fs::write(&dst, b"old-uninstaller-stub").unwrap();

        let mut perms = fs::metadata(&dst).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&dst, perms).unwrap();

        copy_uninstaller_executable(&src, &dst).unwrap();
        assert_eq!(fs::read(&dst).unwrap(), b"new-uninstaller-stub");

        let _ = fs::remove_dir_all(&root);
    }
}
