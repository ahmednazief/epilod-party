use crate::ed25519::{ed25519_public_key_from_seed, ed25519_sign, ed25519_verify};
use crate::p2p::{decode_base64_url, encode_base64_url, fill_random_bytes};
use serde::Serialize;
use std::collections::HashMap;

pub const EPC_CHAT_PREFIX: &str = "~EPC:";
pub const EPC_QUERY_MSG: &str = "~EPC:Q";
pub const MAX_EPC_CHAT_LEN: usize = 144;

const SIGN_DOMAIN: &[u8] = b"epilod-room-ctrl-v1:";
const WIRE_VERSION: u8 = 1;
const FLAG_LOCKED: u8 = 1 << 0;
const MAX_ADMINS: usize = 24;
const MAX_CHUNKS: usize = 24;
const MAX_REASSEMBLY_ENTRIES: usize = 24;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PersistedHostAuthority {
    pub wire_room: String,
    pub owner_seed: [u8; 32],
    pub admins: Vec<String>,
    pub seq: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomControlSummary {
    pub host_control_active: bool,
    pub local_is_host: bool,
    pub local_is_admin: bool,
    pub host_username: Option<String>,
    pub admin_usernames: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RoomControlStateChange {
    pub became_locked_by_host: Option<String>,
    pub became_unlocked_by_host: Option<String>,
    pub local_admin_granted_by: Option<String>,
    pub local_admin_revoked_by: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RoomControlChatOutcome {
    Ignored,
    QueryFromPeer,
    StateChanged(RoomControlStateChange),
}

#[derive(Debug, Clone)]
struct ChunkAssembly {
    total: usize,
    parts: Vec<Option<String>>,
    order_seq: u64,
}

#[derive(Debug, Clone)]
struct ParsedAuthoritySnapshot {
    locked: bool,
    seq: u32,
    host_pubkey: [u8; 32],
    wire_room: String,
    owner_username: String,
    admins: Vec<String>,
}

pub struct RoomControlSession {
    wire_room: String,
    local_username: String,
    owner_seed: Option<[u8; 32]>,
    owner_pubkey: Option<[u8; 32]>,
    host_username: Option<String>,
    locked: bool,
    admins: Vec<String>,
    seq: u32,
    last_seq_by_key: HashMap<[u8; 32], u32>,
    reassembly: HashMap<(String, String), ChunkAssembly>,
    reassembly_counter: u64,
}

impl RoomControlSession {
    pub fn new_guest(wire_room: &str, local_username: &str) -> Self {
        Self {
            wire_room: wire_room.trim().to_string(),
            local_username: local_username.trim().to_string(),
            owner_seed: None,
            owner_pubkey: None,
            host_username: None,
            locked: false,
            admins: Vec::new(),
            seq: 0,
            last_seq_by_key: HashMap::new(),
            reassembly: HashMap::new(),
            reassembly_counter: 0,
        }
    }

    pub fn new_host(
        wire_room: &str,
        local_username: &str,
        persisted: Option<&PersistedHostAuthority>,
    ) -> Self {
        let clean_room = wire_room.trim().to_string();
        let clean_user = local_username.trim().to_string();
        let (seed, admins, seq) = match persisted {
            Some(prev) if prev.wire_room == clean_room => (
                prev.owner_seed,
                dedup_usernames(&prev.admins, &clean_user),
                prev.seq.saturating_add(1).max(1),
            ),
            _ => {
                let mut fresh = [0u8; 32];
                fill_random_bytes(&mut fresh);
                (fresh, Vec::new(), 1)
            }
        };
        let pubkey = ed25519_public_key_from_seed(&seed);
        Self {
            wire_room: clean_room,
            local_username: clean_user.clone(),
            owner_seed: Some(seed),
            owner_pubkey: Some(pubkey),
            host_username: Some(clean_user),
            locked: true,
            admins,
            seq,
            last_seq_by_key: HashMap::new(),
            reassembly: HashMap::new(),
            reassembly_counter: 0,
        }
    }

    pub fn export_persisted_host(&self) -> Option<PersistedHostAuthority> {
        let seed = self.owner_seed?;
        if !self.locked {
            return None;
        }
        Some(PersistedHostAuthority {
            wire_room: self.wire_room.clone(),
            owner_seed: seed,
            admins: self.admins.clone(),
            seq: self.seq,
        })
    }

    pub fn summary(&self) -> RoomControlSummary {
        RoomControlSummary {
            host_control_active: self.locked,
            local_is_host: self.is_local_host(),
            local_is_admin: self.is_local_admin(),
            host_username: if self.locked {
                self.host_username.clone()
            } else {
                None
            },
            admin_usernames: if self.locked {
                self.admins.clone()
            } else {
                Vec::new()
            },
        }
    }

    pub fn is_locked(&self) -> bool {
        self.locked
    }

    pub fn is_local_host(&self) -> bool {
        self.locked && self.owner_seed.is_some()
    }

    pub fn is_local_admin(&self) -> bool {
        self.is_user_admin(&self.local_username)
    }

    pub fn is_user_host(&self, username: &str) -> bool {
        if !self.locked {
            return false;
        }
        self.host_username
            .as_deref()
            .is_some_and(|h| h.eq_ignore_ascii_case(username.trim()))
    }

    pub fn is_user_admin(&self, username: &str) -> bool {
        if !self.locked {
            return false;
        }
        let target = username.trim();
        !target.is_empty()
            && !self.is_user_host(target)
            && self.admins.iter().any(|a| a.eq_ignore_ascii_case(target))
    }

    pub fn is_user_controller(&self, username: &str) -> bool {
        self.locked && (self.is_user_host(username) || self.is_user_admin(username))
    }

    pub fn has_admins(&self) -> bool {
        self.locked && !self.admins.is_empty()
    }

    pub fn admin_usernames(&self) -> &[String] {
        &self.admins
    }

    pub fn update_local_username(&mut self, assigned_username: &str) -> bool {
        let clean = assigned_username.trim();
        if clean.is_empty() {
            return false;
        }
        let changed = self.local_username != clean;
        self.local_username = clean.to_string();
        if self.is_local_host() {
            let host_changed = self.host_username.as_deref() != Some(clean);
            self.host_username = Some(clean.to_string());
            self.admins.retain(|a| !a.eq_ignore_ascii_case(clean));
            return host_changed;
        }
        changed
    }

    pub fn set_admin(&mut self, target_username: &str, grant: bool) -> Result<Vec<String>, String> {
        if !self.is_local_host() {
            return Err("Only the room host can manage admin permissions.".to_string());
        }
        let target = target_username.trim();
        if target.is_empty() || target.len() > 64 {
            return Err("Invalid participant username.".to_string());
        }
        if self.is_user_host(target) || target.eq_ignore_ascii_case(&self.local_username) {
            return Err("You are already the room host.".to_string());
        }
        let currently_admin = self.admins.iter().any(|a| a.eq_ignore_ascii_case(target));
        if grant == currently_admin {
            return Ok(Vec::new());
        }
        if grant {
            if self.admins.len() >= MAX_ADMINS {
                return Err(format!("Maximum of {MAX_ADMINS} room admins reached."));
            }
            self.admins.push(target.to_string());
        } else {
            self.admins.retain(|a| !a.eq_ignore_ascii_case(target));
        }
        Ok(self.encode_current_snapshot_lines(true))
    }

    pub fn encode_current_snapshot_lines(&mut self, bump_seq: bool) -> Vec<String> {
        let Some(seed) = self.owner_seed else {
            return Vec::new();
        };
        let Some(pubkey) = self.owner_pubkey else {
            return Vec::new();
        };
        if bump_seq {
            self.seq = self.seq.saturating_add(1).max(1);
        }
        let owner = self
            .host_username
            .as_deref()
            .unwrap_or(&self.local_username)
            .to_string();
        encode_signed_snapshot_lines(
            &seed,
            pubkey,
            self.locked,
            self.seq,
            &self.wire_room,
            &owner,
            &self.admins,
        )
    }

    pub fn release_on_leave(&mut self, present_usernames: &[&str]) -> Option<Vec<String>> {
        if !self.is_local_host() {
            return None;
        }
        let active_admin_present = self.admins.iter().any(|admin| {
            present_usernames
                .iter()
                .any(|p| p.eq_ignore_ascii_case(admin))
        });
        if active_admin_present {
            // Preserve lock while a promoted admin remains inside the room.
            return None;
        }
        let seed = self.owner_seed?;
        let pubkey = self.owner_pubkey?;
        self.locked = false;
        self.admins.clear();
        self.seq = self.seq.saturating_add(1).max(1);
        let owner = self
            .host_username
            .as_deref()
            .unwrap_or(&self.local_username)
            .to_string();
        Some(encode_signed_snapshot_lines(
            &seed,
            pubkey,
            false,
            self.seq,
            &self.wire_room,
            &owner,
            &[],
        ))
    }

    pub fn unlock_if_all_controllers_absent(&mut self, present_usernames: &[&str]) -> bool {
        if !self.locked || self.is_local_host() || present_usernames.is_empty() {
            return false;
        }
        let any_controller_present = present_usernames
            .iter()
            .any(|name| self.is_user_controller(name));
        if any_controller_present {
            return false;
        }
        self.locked = false;
        self.owner_pubkey = None;
        self.host_username = None;
        self.admins.clear();
        true
    }

    pub fn handle_chat_message(
        &mut self,
        sender: &str,
        raw_message: &str,
    ) -> RoomControlChatOutcome {
        let trimmed = raw_message.trim();
        let Some(rest) = trimmed.strip_prefix(EPC_CHAT_PREFIX) else {
            return RoomControlChatOutcome::Ignored;
        };
        if sender.eq_ignore_ascii_case(&self.local_username) {
            return RoomControlChatOutcome::Ignored;
        }
        if rest == "Q" {
            return if self.is_local_host() {
                RoomControlChatOutcome::QueryFromPeer
            } else {
                RoomControlChatOutcome::Ignored
            };
        }

        let Some(snap_bytes) = self.ingest_chunk(sender, rest) else {
            return RoomControlChatOutcome::Ignored;
        };
        let Some(parsed) = parse_and_verify_snapshot(&snap_bytes) else {
            return RoomControlChatOutcome::Ignored;
        };
        if parsed.wire_room != self.wire_room {
            return RoomControlChatOutcome::Ignored;
        }
        if !sender.eq_ignore_ascii_case(&parsed.owner_username) {
            return RoomControlChatOutcome::Ignored;
        }
        // A host never lets another peer override its own local authority.
        if self.is_local_host() {
            return RoomControlChatOutcome::Ignored;
        }
        // Key pinning prevents a non-host peer from claiming host while locked.
        if self.locked && self.owner_pubkey.is_some_and(|pk| pk != parsed.host_pubkey) {
            return RoomControlChatOutcome::Ignored;
        }
        let prev_seq = self
            .last_seq_by_key
            .get(&parsed.host_pubkey)
            .copied()
            .unwrap_or(0);
        if parsed.seq <= prev_seq {
            return RoomControlChatOutcome::Ignored;
        }
        self.last_seq_by_key.insert(parsed.host_pubkey, parsed.seq);

        let was_locked = self.locked;
        let was_local_admin = self.is_local_admin();
        let prev_host = self.host_username.clone();
        let prev_admins = self.admins.clone();

        if parsed.locked {
            self.locked = true;
            self.owner_pubkey = Some(parsed.host_pubkey);
            self.host_username = Some(parsed.owner_username.clone());
            self.admins = dedup_usernames(&parsed.admins, &parsed.owner_username);
        } else {
            self.locked = false;
            self.owner_pubkey = None;
            self.host_username = None;
            self.admins.clear();
        }

        let now_local_admin = self.is_local_admin();
        if was_locked == self.locked
            && was_local_admin == now_local_admin
            && prev_host == self.host_username
            && prev_admins == self.admins
        {
            return RoomControlChatOutcome::Ignored;
        }

        let host_label = parsed.owner_username;
        RoomControlChatOutcome::StateChanged(RoomControlStateChange {
            became_locked_by_host: (!was_locked && self.locked).then(|| host_label.clone()),
            became_unlocked_by_host: (was_locked && !self.locked).then(|| host_label.clone()),
            local_admin_granted_by: (!was_local_admin && now_local_admin)
                .then(|| host_label.clone()),
            local_admin_revoked_by: (was_local_admin && !now_local_admin).then_some(host_label),
        })
    }

    fn ingest_chunk(&mut self, sender: &str, body_after_prefix: &str) -> Option<Vec<u8>> {
        // Expected: S:<msg_id_hex4>:<idx>/<total>:<b64_chunk>
        let after_kind = body_after_prefix.strip_prefix("S:")?;
        let mut parts = after_kind.splitn(3, ':');
        let msg_id = parts.next()?.trim();
        let frac = parts.next()?.trim();
        let chunk_b64 = parts.next()?.trim();
        if msg_id.is_empty()
            || msg_id.len() > 8
            || !msg_id.bytes().all(|b| b.is_ascii_hexdigit())
            || chunk_b64.is_empty()
        {
            return None;
        }
        let (idx_str, total_str) = frac.split_once('/')?;
        let idx: usize = idx_str.parse().ok()?;
        let total: usize = total_str.parse().ok()?;
        if total == 0 || total > MAX_CHUNKS || idx >= total {
            return None;
        }
        if total == 1 {
            return decode_base64_url(chunk_b64);
        }

        let key = (sender.to_ascii_lowercase(), msg_id.to_ascii_lowercase());
        self.reassembly_counter = self.reassembly_counter.wrapping_add(1);
        let order_seq = self.reassembly_counter;

        if !self.reassembly.contains_key(&key) && self.reassembly.len() >= MAX_REASSEMBLY_ENTRIES {
            if let Some(oldest_key) = self
                .reassembly
                .iter()
                .min_by_key(|(_, v)| v.order_seq)
                .map(|(k, _)| k.clone())
            {
                self.reassembly.remove(&oldest_key);
            }
        }

        let entry = self
            .reassembly
            .entry(key.clone())
            .or_insert_with(|| ChunkAssembly {
                total,
                parts: vec![None; total],
                order_seq,
            });
        if entry.total != total {
            *entry = ChunkAssembly {
                total,
                parts: vec![None; total],
                order_seq,
            };
        } else {
            entry.order_seq = order_seq;
        }
        entry.parts[idx] = Some(chunk_b64.to_string());

        if entry.parts.iter().all(Option::is_some) {
            let joined: String = entry.parts.iter().filter_map(|p| p.as_deref()).collect();
            self.reassembly.remove(&key);
            return decode_base64_url(&joined);
        }
        None
    }
}

fn dedup_usernames(list: &[String], exclude_host: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for item in list {
        let trimmed = item.trim();
        if trimmed.is_empty()
            || trimmed.len() > 64
            || trimmed.eq_ignore_ascii_case(exclude_host)
            || out.iter().any(|x| x.eq_ignore_ascii_case(trimmed))
        {
            continue;
        }
        out.push(trimmed.to_string());
        if out.len() >= MAX_ADMINS {
            break;
        }
    }
    out
}

fn push_len_prefixed_str(out: &mut Vec<u8>, s: &str, max_bytes: usize) {
    let bytes = s.as_bytes();
    let clamped = bytes.len().min(max_bytes).min(u8::MAX as usize);
    // Walk back to UTF-8 boundary if truncated cleanly.
    let mut end = clamped;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    out.push(end as u8);
    out.extend_from_slice(&bytes[..end]);
}

fn read_len_prefixed_str(bytes: &[u8], pos: &mut usize, max_bytes: usize) -> Option<String> {
    let len = *bytes.get(*pos)? as usize;
    *pos += 1;
    if len == 0 || len > max_bytes || *pos + len > bytes.len() {
        return None;
    }
    let slice = &bytes[*pos..*pos + len];
    *pos += len;
    std::str::from_utf8(slice)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn encode_signed_snapshot_lines(
    seed: &[u8; 32],
    pubkey: [u8; 32],
    locked: bool,
    seq: u32,
    wire_room: &str,
    owner_username: &str,
    admins: &[String],
) -> Vec<String> {
    let clean_admins = dedup_usernames(admins, owner_username);
    let mut body = Vec::with_capacity(96 + clean_admins.len() * 16);
    body.push(WIRE_VERSION);
    body.push(if locked { FLAG_LOCKED } else { 0 });
    body.extend_from_slice(&seq.to_be_bytes());
    body.extend_from_slice(&pubkey);
    push_len_prefixed_str(&mut body, wire_room.trim(), 128);
    push_len_prefixed_str(&mut body, owner_username.trim(), 64);
    body.push(clean_admins.len() as u8);
    for admin in &clean_admins {
        push_len_prefixed_str(&mut body, admin, 64);
    }

    let mut sign_input = Vec::with_capacity(SIGN_DOMAIN.len() + body.len());
    sign_input.extend_from_slice(SIGN_DOMAIN);
    sign_input.extend_from_slice(&body);
    let (derived_pk, sig) = ed25519_sign(seed, &sign_input);
    debug_assert_eq!(derived_pk, pubkey);

    let mut full = body;
    full.extend_from_slice(&sig);
    let b64 = encode_base64_url(&full);
    let msg_id = format!("{:02x}{:02x}", sig[0], sig[1]);

    // Reserve worst-case header length: `~EPC:S:xxxx:12/12:` = 18 bytes.
    let max_chunk_b64 = MAX_EPC_CHAT_LEN.saturating_sub(18);
    let total = b64.len().div_ceil(max_chunk_b64).max(1);
    let mut out = Vec::with_capacity(total);
    for idx in 0..total {
        let start = idx * max_chunk_b64;
        let end = (start + max_chunk_b64).min(b64.len());
        let chunk = &b64[start..end];
        out.push(format!("{EPC_CHAT_PREFIX}S:{msg_id}:{idx}/{total}:{chunk}"));
    }
    out
}

fn parse_and_verify_snapshot(full_bytes: &[u8]) -> Option<ParsedAuthoritySnapshot> {
    if full_bytes.len() <= 64 {
        return None;
    }
    let body_len = full_bytes.len() - 64;
    let body = &full_bytes[..body_len];
    let sig: [u8; 64] = full_bytes[body_len..].try_into().ok()?;

    let mut pos = 0usize;
    let version = *body.get(pos)?;
    pos += 1;
    if version != WIRE_VERSION {
        return None;
    }
    let flags = *body.get(pos)?;
    pos += 1;
    let locked = (flags & FLAG_LOCKED) != 0;

    if pos + 4 + 32 > body.len() {
        return None;
    }
    let seq = u32::from_be_bytes(body[pos..pos + 4].try_into().ok()?);
    pos += 4;
    if seq == 0 {
        return None;
    }
    let host_pubkey: [u8; 32] = body[pos..pos + 32].try_into().ok()?;
    pos += 32;

    let wire_room = read_len_prefixed_str(body, &mut pos, 128)?;
    let owner_username = read_len_prefixed_str(body, &mut pos, 64)?;
    let admin_count = *body.get(pos)? as usize;
    pos += 1;
    if admin_count > MAX_ADMINS {
        return None;
    }
    let mut admins = Vec::with_capacity(admin_count);
    for _ in 0..admin_count {
        admins.push(read_len_prefixed_str(body, &mut pos, 64)?);
    }
    if pos != body_len {
        return None;
    }

    let mut sign_input = Vec::with_capacity(SIGN_DOMAIN.len() + body_len);
    sign_input.extend_from_slice(SIGN_DOMAIN);
    sign_input.extend_from_slice(body);
    ed25519_verify(&host_pubkey, &sign_input, &sig).ok()?;

    Some(ParsedAuthoritySnapshot {
        locked,
        seq,
        host_pubkey,
        wire_room,
        owner_username,
        admins,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_snapshot_chunks_fit_syncplay_budget_and_roundtrip_on_guest() {
        let mut host = RoomControlSession::new_host("ep-0123456789abcdef", "HostAlice", None);
        let mut guest = RoomControlSession::new_guest("ep-0123456789abcdef", "Bob");

        assert!(host.is_local_host());
        assert!(host.is_user_controller("hostalice"));
        assert!(!guest.is_locked());

        let lines = host.encode_current_snapshot_lines(false);
        assert!(!lines.is_empty());
        for line in &lines {
            assert!(
                line.len() <= MAX_EPC_CHAT_LEN,
                "chat line exceeded budget: {} chars ({line})",
                line.len()
            );
        }

        let mut last_outcome = RoomControlChatOutcome::Ignored;
        for line in &lines {
            last_outcome = guest.handle_chat_message("HostAlice", line);
        }
        assert_eq!(
            last_outcome,
            RoomControlChatOutcome::StateChanged(RoomControlStateChange {
                became_locked_by_host: Some("HostAlice".to_string()),
                became_unlocked_by_host: None,
                local_admin_granted_by: None,
                local_admin_revoked_by: None,
            })
        );
        assert!(guest.is_locked());
        assert!(guest.is_user_host("hostalice"));
        assert!(!guest.is_user_controller("bob"));
    }

    #[test]
    fn grant_and_revoke_admin_updates_peer_roles_and_rejects_replays() {
        let mut host = RoomControlSession::new_host("ep-room", "Alice", None);
        let mut bob = RoomControlSession::new_guest("ep-room", "Bob");
        let mut charlie = RoomControlSession::new_guest("ep-room", "Charlie");

        let init_lines = host.encode_current_snapshot_lines(false);
        for line in &init_lines {
            bob.handle_chat_message("Alice", line);
            charlie.handle_chat_message("Alice", line);
        }

        let grant_lines = host.set_admin("Bob", true).expect("grant admin");
        for line in &grant_lines {
            assert!(line.len() <= MAX_EPC_CHAT_LEN);
        }

        let mut bob_outcome = RoomControlChatOutcome::Ignored;
        for line in &grant_lines {
            bob_outcome = bob.handle_chat_message("Alice", line);
            charlie.handle_chat_message("Alice", line);
        }
        assert_eq!(
            bob_outcome,
            RoomControlChatOutcome::StateChanged(RoomControlStateChange {
                became_locked_by_host: None,
                became_unlocked_by_host: None,
                local_admin_granted_by: Some("Alice".to_string()),
                local_admin_revoked_by: None,
            })
        );
        assert!(bob.is_local_admin());
        assert!(bob.is_user_controller("Bob"));
        assert!(charlie.is_user_admin("Bob"));
        assert!(!charlie.is_user_controller("Charlie"));

        // Replaying the earlier init snapshot with seq=1 must be ignored.
        for line in &init_lines {
            assert_eq!(
                bob.handle_chat_message("Alice", line),
                RoomControlChatOutcome::Ignored
            );
        }
        assert!(bob.is_local_admin());

        let revoke_lines = host.set_admin("Bob", false).expect("revoke admin");
        for line in &revoke_lines {
            bob_outcome = bob.handle_chat_message("Alice", line);
            charlie.handle_chat_message("Alice", line);
        }
        assert_eq!(
            bob_outcome,
            RoomControlChatOutcome::StateChanged(RoomControlStateChange {
                became_locked_by_host: None,
                became_unlocked_by_host: None,
                local_admin_granted_by: None,
                local_admin_revoked_by: Some("Alice".to_string()),
            })
        );
        assert!(!bob.is_local_admin());
        assert!(!bob.is_user_controller("Bob"));
        assert!(!charlie.is_user_admin("Bob"));

        // Replaying the old grant lines must now be rejected because seq moved forward.
        for line in &grant_lines {
            assert_eq!(
                charlie.handle_chat_message("Alice", line),
                RoomControlChatOutcome::Ignored
            );
        }
        assert!(!charlie.is_user_admin("Bob"));
    }

    #[test]
    fn prevents_hijack_wrong_room_and_username_spoofing() {
        let mut real_host = RoomControlSession::new_host("ep-real", "Alice", None);
        let mut attacker = RoomControlSession::new_host("ep-real", "Eve", None);
        let mut wrong_room_host = RoomControlSession::new_host("ep-other", "Alice", None);
        let mut guest = RoomControlSession::new_guest("ep-real", "Guest");

        let real_lines = real_host.encode_current_snapshot_lines(false);
        for line in &real_lines {
            guest.handle_chat_message("Alice", line);
        }

        // Attacker signs a snapshot under her own key -> blocked by host key pinning.
        for line in attacker.encode_current_snapshot_lines(true) {
            assert_eq!(
                guest.handle_chat_message("Eve", &line),
                RoomControlChatOutcome::Ignored
            );
        }
        assert!(guest.is_user_host("Alice"));

        // Mismatched Syncplay Chat sender claiming owner_username="Alice" -> rejected.
        for line in &real_host.encode_current_snapshot_lines(true) {
            assert_eq!(
                guest.handle_chat_message("Eve", line),
                RoomControlChatOutcome::Ignored
            );
        }

        // Valid signature for a different room -> rejected.
        let mut fresh_guest = RoomControlSession::new_guest("ep-real", "Guest");
        for line in &wrong_room_host.encode_current_snapshot_lines(false) {
            assert_eq!(
                fresh_guest.handle_chat_message("Alice", line),
                RoomControlChatOutcome::Ignored
            );
        }
        assert!(!fresh_guest.is_locked());
    }

    #[test]
    fn host_reconnect_with_renamed_username_preserves_ownership_and_admins() {
        let mut host = RoomControlSession::new_host("ep-room", "Alice", None);
        let mut guest = RoomControlSession::new_guest("ep-room", "Bob");

        let grant_lines = host.set_admin("Bob", true).unwrap();
        for line in &grant_lines {
            guest.handle_chat_message("Alice", line);
        }
        let persisted = host.export_persisted_host().unwrap();

        let mut host_reconnected =
            RoomControlSession::new_host("ep-room", "Alice", Some(&persisted));
        host_reconnected.update_local_username("Alice_1");
        let reconnect_lines = host_reconnected.encode_current_snapshot_lines(false);

        for line in &reconnect_lines {
            guest.handle_chat_message("Alice_1", line);
        }
        assert!(guest.is_user_host("Alice_1"));
        assert!(!guest.is_user_host("Alice"));
        assert!(guest.is_local_admin());
    }

    #[test]
    fn release_on_leave_unlocks_when_no_admin_present_but_keeps_lock_when_admin_remains() {
        let mut host_a = RoomControlSession::new_host("ep-room", "Alice", None);
        let mut guest = RoomControlSession::new_guest("ep-room", "Charlie");
        for line in host_a.encode_current_snapshot_lines(false) {
            guest.handle_chat_message("Alice", &line);
        }
        assert!(guest.is_locked());
        let rel = host_a
            .release_on_leave(&["Alice", "Charlie"])
            .expect("should broadcast unlock when no admin remains");
        for line in rel {
            guest.handle_chat_message("Alice", &line);
        }
        assert!(!guest.is_locked());

        let mut host_b = RoomControlSession::new_host("ep-room", "Alice", None);
        for line in host_b.set_admin("Bob", true).unwrap() {
            guest.handle_chat_message("Alice", &line);
        }
        assert!(host_b
            .release_on_leave(&["Alice", "Bob", "Charlie"])
            .is_none());
        assert!(guest.is_locked());

        // If everyone with control later leaves the room, orphaned lock clears cleanly.
        assert!(!guest.unlock_if_all_controllers_absent(&["Bob", "Charlie"]));
        assert!(guest.unlock_if_all_controllers_absent(&["Charlie"]));
        assert!(!guest.is_locked());
    }

    #[test]
    fn max_24_long_admin_usernames_stay_within_chat_and_chunk_budgets() {
        let mut host = RoomControlSession::new_host("ep-0123456789abcdef0123", "HostOwner", None);
        let mut guest = RoomControlSession::new_guest("ep-0123456789abcdef0123", "Viewer_01");

        let mut last_lines = Vec::new();
        for i in 0..MAX_ADMINS {
            let name = format!(
                "LongAdminUserNameNumber{:02}_abcdefghijklmnopqrstuvwx",
                i + 1
            );
            last_lines = host.set_admin(&name, true).expect("grant admin");
        }
        assert!(last_lines.len() <= MAX_CHUNKS);
        for line in &last_lines {
            assert!(line.len() <= MAX_EPC_CHAT_LEN);
            guest.handle_chat_message("HostOwner", line);
        }
        assert!(guest.is_locked());
        assert_eq!(guest.admin_usernames().len(), MAX_ADMINS);
        assert!(guest.is_user_admin("LongAdminUserNameNumber24_abcdefghijklmnopqrstuvwx"));
    }
}
