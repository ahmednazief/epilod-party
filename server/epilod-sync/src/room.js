import { DurableObject } from "cloudflare:workers";

const MAX_ROOM_USERS = 16;
const MAX_MESSAGE_BYTES = 4096;
const MAX_CHAT_CHARS = 500;
const MAX_USERNAME_CHARS = 48;
const MAX_FILENAME_CHARS = 240;
const MAX_STRIKES = 10;
const STRIKE_DECAY_MS = 60_000;
const HOST_RECONNECT_GRACE_MS = 60_000;
const EMPTY_CLEANUP_ALARM_MS = 65_000;
const LIVENESS_ALARM_MS = 30_000;
const GHOST_IDLE_TIMEOUT_MS = 90_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
const SERVER_VERSION = "1.1.0";
const SERVER_CAPS = ["readygate", "clientts", "status", "outbox", "peekproof"];

const TEXT_ENCODER = new TextEncoder();

const RATE_LIMITS = {
  playback: { max: 12, windowMs: 2_000 },
  chat: { max: 8, windowMs: 2_000 },
  typing: { max: 2, windowMs: 2_000 },
  p2pSignal: { max: 12, windowMs: 60_000 },
  ping: { max: 6, windowMs: 10_000 },
  control: { max: 6, windowMs: 5_000 },
  status: { max: 1, windowMs: 4_000 },
};

function log(level, event, fields = {}) {
  try {
    console.log(JSON.stringify({ level, event, ...fields, ts: Date.now() }));
  } catch {}
}

function stripUnsafeUnicode(str) {
  if (typeof str !== "string") return "";
  return str
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "")
    .trim();
}

function clampString(str, maxLen) {
  const clean = stripUnsafeUnicode(str);
  return clean.length > maxLen ? clean.slice(0, maxLen) : clean;
}

function isFiniteNonNeg(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0 && n < 1e7;
}

function constantTimeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length || a.length === 0) return false;
  const ba = TEXT_ENCODER.encode(a);
  const bb = TEXT_ENCODER.encode(b);
  if (ba.byteLength !== bb.byteLength) return false;
  return crypto.subtle.timingSafeEqual(ba, bb);
}

async function sha256Hex(text) {
  const data = TEXT_ENCODER.encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function randomTokenHex() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeCaps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const item of raw.slice(0, 16)) {
    const clean = clampString(item, 24);
    if (clean) out.push(clean);
  }
  return out;
}

function hasCap(att, cap) {
  return Array.isArray(att?.caps) && att.caps.includes(cap);
}

function sanitizeFile(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = clampString(raw.name, MAX_FILENAME_CHARS);
  if (!name) return null;
  const size =
    typeof raw.size === "number" && Number.isFinite(raw.size) && raw.size >= 0
      ? Math.floor(raw.size)
      : null;
  const sizeHash =
    typeof raw.sizeHash === "string" ? clampString(raw.sizeHash, 64) || null : null;
  const duration = isFiniteNonNeg(raw.duration) ? raw.duration : null;
  return { name, size, sizeHash, duration };
}

function defaultRoomState() {
  return {
    position: 0,
    paused: true,
    seq: 0,
    serverTimeMs: Date.now(),
    setBy: null,
    hostOnly: false,
    hostUsername: null,
    hostTokenHash: null,
    hostDisconnectedAt: null,
    admins: [],
    passwordHash: null,
    emptySince: null,
    peekProofHash: null,
  };
}

export class RoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rateState = new WeakMap();
    this.attCache = new WeakMap();
    this.cachedState = null;
    this.schemaReady = false;
    this.badPasswordMap = new Map();

    // Zero-compute edge auto-response for lightweight keepalive pings.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  getAttachment(ws) {
    let att = this.attCache.get(ws);
    if (!att) {
      att = ws.deserializeAttachment();
      if (att) this.attCache.set(ws, att);
    }
    return att;
  }

  saveAttachment(ws, att) {
    this.attCache.set(ws, att);
    ws.serializeAttachment(att);
  }

  ensureSchema() {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS room_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
      )
    `);
    this.schemaReady = true;
  }

  loadState() {
    if (this.cachedState) return this.cachedState;
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec("SELECT json FROM room_state WHERE id = 1")
      .toArray();
    if (rows.length > 0 && typeof rows[0].json === "string") {
      try {
        this.cachedState = { ...defaultRoomState(), ...JSON.parse(rows[0].json) };
        return this.cachedState;
      } catch {
        // Corrupted row fallback
      }
    }
    this.cachedState = defaultRoomState();
    return this.cachedState;
  }

  saveState(state) {
    this.cachedState = state;
    this.ensureSchema();
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO room_state (id, json) VALUES (1, ?)",
      JSON.stringify(state)
    );
  }

  async ensureAlarmAt(targetMs) {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || existing > targetMs + 2_000) {
      await this.ctx.storage.setAlarm(targetMs);
    }
  }

  evictStaleUnjoinedSockets(nowMs = Date.now()) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (!att || (!att.joined && nowMs - (att.joinedAt || 0) > HANDSHAKE_TIMEOUT_MS)) {
        try {
          ws.close(1008, "Handshake timeout");
        } catch {}
      }
    }
  }

  projectedPosition(state, nowMs = Date.now()) {
    if (state.paused) return state.position;
    const elapsed = Math.max(0, (nowMs - state.serverTimeMs) / 1000);
    return state.position + elapsed;
  }

  getActiveSockets() {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.getAttachment(ws);
      if (att && att.joined) {
        out.push({ ws, att });
      }
    }
    return out;
  }

  buildParticipants(roomName, state, nowMs = Date.now()) {
    const pos = this.projectedPosition(state, nowMs);
    const adminSet = new Set(state.admins.map((a) => a.toLowerCase()));
    return this.getActiveSockets().map(({ att }) => {
      const lower = att.username.toLowerCase();
      const isHost = Boolean(
        state.hostOnly &&
        att.isHost &&
        state.hostUsername &&
        state.hostUsername.toLowerCase() === lower
      );
      const isAdmin = !isHost && adminSet.has(lower);
      const reportedPosition =
        typeof att.reportedPosition === "number" && Number.isFinite(att.reportedPosition)
          ? att.reportedPosition
          : null;
      const lagSecs =
        typeof att.reportedLagSecs === "number" && Number.isFinite(att.reportedLagSecs)
          ? att.reportedLagSecs
          : reportedPosition !== null
            ? Math.round((pos - reportedPosition) * 100) / 100
            : null;
      return {
        username: att.username,
        room: roomName,
        position: pos,
        paused: state.paused,
        isReady: Boolean(att.isReady),
        manualNotReady: Boolean(att.manualNotReady),
        isController: state.hostOnly ? isHost || isAdmin : false,
        isHost,
        isAdmin,
        file: att.file || null,
        reportedPosition,
        buffering: Boolean(att.buffering),
        lagSecs,
      };
    });
  }

  buildRoomControlFor(state, username, attIsHost = false) {
    const lower = (username || "").toLowerCase();
    const localIsHost = Boolean(
      state.hostOnly &&
      attIsHost &&
      state.hostUsername &&
      state.hostUsername.toLowerCase() === lower
    );
    const localIsAdmin =
      !localIsHost && state.admins.some((a) => a.toLowerCase() === lower);
    return {
      hostControlActive: Boolean(state.hostOnly),
      localIsHost,
      localIsAdmin,
      hostUsername: state.hostUsername || null,
      adminUsernames: [...state.admins],
    };
  }

  expireAbsentHostIfNeeded(roomName, state, nowMs = Date.now()) {
    if (
      state.hostOnly &&
      state.hostDisconnectedAt &&
      nowMs - state.hostDisconnectedAt > HOST_RECONNECT_GRACE_MS
    ) {
      state.hostOnly = false;
      state.hostUsername = null;
      state.hostTokenHash = null;
      state.hostDisconnectedAt = null;
      state.admins = [];
      this.saveState(state);
      log("info", "host.expired", { room: roomName });
      this.broadcastRoomControl(state, { kind: "hostAbsentUnlocked", actor: null });
      if (roomName) {
        this.broadcastParticipants(roomName, state);
      }
      return true;
    }
    return false;
  }

  canControlPlayback(roomName, state, att, nowMs = Date.now()) {
    this.expireAbsentHostIfNeeded(roomName, state, nowMs);
    if (!state.hostOnly) return true;
    const lower = (att?.username || "").toLowerCase();
    if (att?.isHost && state.hostUsername && state.hostUsername.toLowerCase() === lower) {
      return true;
    }
    if (state.admins.some((a) => a.toLowerCase() === lower)) {
      return true;
    }
    return false;
  }

  sendJson(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  broadcastJson(obj, excludeWs = null) {
    const raw = JSON.stringify(obj);
    for (const { ws } of this.getActiveSockets()) {
      if (ws === excludeWs) continue;
      try {
        ws.send(raw);
      } catch {}
    }
  }

  broadcastParticipants(roomName, state, excludeWs = null) {
    const participants = this.buildParticipants(roomName, state);
    this.broadcastJson({ type: "participants", participants }, excludeWs);
  }

  broadcastRoomControl(state, notice = null, targetUsername = null) {
    const targetLower = targetUsername ? targetUsername.toLowerCase() : null;
    const adminSet = state.admins.length > 0 ? new Set(state.admins.map((a) => a.toLowerCase())) : null;
    let guestPlainRaw = null;
    for (const { ws, att } of this.getActiveSockets()) {
      const includeNotice =
        notice && (!targetLower || (att.username || "").toLowerCase() === targetLower);
      const isHostOrAdmin =
        state.hostOnly &&
        (att.isHost || (adminSet && adminSet.has((att.username || "").toLowerCase())));
      if (!includeNotice && !isHostOrAdmin) {
        if (guestPlainRaw === null) {
          guestPlainRaw = JSON.stringify({
            type: "roomControl",
            roomControl: this.buildRoomControlFor(state, att.username, false),
            notice: null,
          });
        }
        try {
          ws.send(guestPlainRaw);
        } catch {}
        continue;
      }
      this.sendJson(ws, {
        type: "roomControl",
        roomControl: this.buildRoomControlFor(state, att.username, Boolean(att.isHost)),
        notice: includeNotice ? notice : null,
      });
    }
  }

  checkRateLimit(ws, bucket) {
    const cfg = RATE_LIMITS[bucket];
    if (!cfg) return true;
    let entry = this.rateState.get(ws);
    if (!entry) {
      entry = { buckets: {}, strikes: 0, lastStrikeAt: 0 };
      this.rateState.set(ws, entry);
    }
    const now = Date.now();
    if (entry.strikes > 0 && now - entry.lastStrikeAt > STRIKE_DECAY_MS) {
      entry.strikes = 0;
    }
    let arr = entry.buckets[bucket];
    if (!arr) {
      arr = [];
      entry.buckets[bucket] = arr;
    }
    while (arr.length > 0 && now - arr[0] >= cfg.windowMs) {
      arr.shift();
    }
    if (arr.length >= cfg.max) {
      entry.strikes += 1;
      entry.lastStrikeAt = now;
      if (entry.strikes >= MAX_STRIKES) {
        try {
          ws.close(1008, "Rate limit exceeded");
        } catch {}
      }
      return false;
    }
    arr.push(now);
    return true;
  }

  addStrike(ws) {
    let entry = this.rateState.get(ws);
    if (!entry) {
      entry = { buckets: {}, strikes: 0, lastStrikeAt: 0 };
      this.rateState.set(ws, entry);
    }
    const now = Date.now();
    if (entry.strikes > 0 && now - entry.lastStrikeAt > STRIKE_DECAY_MS) {
      entry.strikes = 0;
    }
    entry.strikes += 1;
    entry.lastStrikeAt = now;
    if (entry.strikes >= MAX_STRIKES) {
      try {
        ws.close(1008, "Policy violation");
      } catch {}
    }
  }

  pruneBadPasswordMap(nowMs = Date.now()) {
    for (const [key, entry] of this.badPasswordMap) {
      if (nowMs - entry.startMs >= 60_000) {
        this.badPasswordMap.delete(key);
      }
    }
  }

  deduplicateUsername(rawName, excludeWs, reservedLower = null) {
    const base = clampString(rawName, MAX_USERNAME_CHARS) || "Guest";
    const used = new Set();
    if (reservedLower) {
      used.add(reservedLower);
    }
    for (const { ws, att } of this.getActiveSockets()) {
      if (ws === excludeWs) continue;
      used.add(att.username.toLowerCase());
    }
    if (!used.has(base.toLowerCase())) return base;
    for (let i = 2; i <= MAX_ROOM_USERS + 4; i++) {
      const candidate = `${base} (${i})`;
      if (!used.has(candidate.toLowerCase())) return candidate;
    }
    return `${base}-${Math.floor(Math.random() * 900 + 100)}`;
  }

  async peek(proof = null) {
    this.evictStaleUnjoinedSockets();
    const active = this.getActiveSockets();
    if (active.length === 0) {
      return {
        onlineCount: 0,
        usernamesPreview: [],
        activeMediaHint: null,
        locked: false,
      };
    }
    const state = this.loadState();
    const locked = Boolean(state.passwordHash);
    let authorized = false;
    if (
      typeof proof === "string" &&
      proof.length > 0 &&
      proof.length <= 128 &&
      state.peekProofHash
    ) {
      const candidateHash = await sha256Hex(proof);
      authorized = constantTimeEqualHex(candidateHash, state.peekProofHash);
    }
    if (!authorized) {
      return {
        onlineCount: active.length,
        usernamesPreview: [],
        activeMediaHint: null,
        locked,
      };
    }
    const usernamesPreview = active.slice(0, 4).map(({ att }) => att.username);
    const activeMediaHint =
      active.find(({ att }) => att.file && att.file.name)?.att.file.name || null;
    return {
      onlineCount: active.length,
      usernamesPreview,
      activeMediaHint,
      locked,
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    // Reclaim any stalled unauthenticated sockets before checking room capacity.
    this.evictStaleUnjoinedSockets();
    const activeCount = this.ctx.getWebSockets().length;
    if (activeCount >= MAX_ROOM_USERS) {
      return new Response(
        JSON.stringify({ ok: false, error: "ROOM_FULL" }),
        {
          status: 409,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        }
      );
    }

    const roomName = clampString(url.searchParams.get("room") || "", 64);
    if (!roomName) {
      return new Response("Missing room", { status: 400 });
    }

    const clientKey = clampString(request.headers.get("X-Epilod-Client") || "", 32) || "anon";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const nowMs = Date.now();
    this.ctx.acceptWebSocket(server);
    this.saveAttachment(server, {
      joined: false,
      room: roomName,
      username: "",
      isHost: false,
      isReady: false,
      manualNotReady: false,
      file: null,
      joinedAt: nowMs,
      lastMsgAt: nowMs,
      clientKey,
      caps: [],
      clientVersion: null,
      reportedPosition: null,
      buffering: false,
    });

    await this.ensureAlarmAt(nowMs + LIVENESS_ALARM_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      this.addStrike(ws);
      return;
    }
    if (
      message.length > MAX_MESSAGE_BYTES ||
      (message.length > 1365 && TEXT_ENCODER.encode(message).byteLength > MAX_MESSAGE_BYTES)
    ) {
      this.sendJson(ws, {
        type: "error",
        code: "PAYLOAD_TOO_LARGE",
        message: "Message exceeds 4 KB limit.",
      });
      this.addStrike(ws);
      return;
    }

    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      this.addStrike(ws);
      return;
    }
    if (!msg || typeof msg !== "object" || typeof msg.type !== "string") {
      this.addStrike(ws);
      return;
    }

    const att = this.getAttachment(ws);
    if (!att) {
      ws.close(1008, "Invalid session");
      return;
    }

    const nowMs = Date.now();
    if (att.joined && nowMs - (att.lastMsgAt || 0) >= 10_000) {
      att.lastMsgAt = nowMs;
      this.saveAttachment(ws, att);
    }

    if (!att.joined) {
      if (msg.type === "ping") {
        if (!this.checkRateLimit(ws, "ping")) return;
        this.sendJson(ws, {
          type: "pong",
          clientMs: typeof msg.clientMs === "number" ? msg.clientMs : 0,
          serverTimeMs: nowMs,
        });
        return;
      }
      if (msg.type !== "hello") {
        this.addStrike(ws);
        return;
      }
      await this.handleHello(ws, att, msg, nowMs);
      return;
    }

    const state = this.loadState();

    switch (msg.type) {
      case "ping": {
        if (!this.checkRateLimit(ws, "ping")) return;
        this.sendJson(ws, {
          type: "pong",
          clientMs: typeof msg.clientMs === "number" ? msg.clientMs : 0,
          serverTimeMs: nowMs,
        });
        return;
      }

      case "play":
      case "pause":
      case "seek": {
        if (!this.checkRateLimit(ws, "playback")) {
          log("warn", "rate.limited", {
            room: att.room,
            username: att.username,
            bucket: "playback",
          });
          this.sendJson(ws, {
            type: "rateLimited",
            bucket: "playback",
            retryAfterMs: 1000,
          });
          this.sendJson(ws, {
            type: "state",
            position: this.projectedPosition(state, nowMs),
            paused: state.paused,
            seq: state.seq,
            serverTimeMs: nowMs,
            setBy: state.setBy,
            doSeek: true,
            reason: "rateLimited",
          });
          return;
        }
        if (!this.canControlPlayback(att.room, state, att, nowMs)) {
          this.sendJson(ws, {
            type: "roomControl",
            roomControl: this.buildRoomControlFor(state, att.username, Boolean(att.isHost)),
            notice: { kind: "guestBlocked", actor: state.hostUsername },
          });
          this.sendJson(ws, {
            type: "state",
            position: this.projectedPosition(state, nowMs),
            paused: state.paused,
            seq: state.seq,
            serverTimeMs: nowMs,
            setBy: state.setBy,
            doSeek: true,
            reason: "guestBlocked",
          });
          return;
        }
        if (msg.type === "play" && hasCap(att, "readygate")) {
          const blockers = this.getActiveSockets()
            .filter(
              ({ ws: otherWs, att: otherAtt }) =>
                otherWs !== ws && otherAtt.manualNotReady && !otherAtt.isReady
            )
            .map(({ att: otherAtt }) => otherAtt.username);
          if (blockers.length > 0) {
            this.sendJson(ws, {
              type: "playBlocked",
              usernames: blockers,
            });
            this.sendJson(ws, {
              type: "state",
              position: this.projectedPosition(state, nowMs),
              paused: state.paused,
              seq: state.seq,
              serverTimeMs: nowMs,
              setBy: state.setBy,
              doSeek: true,
              reason: "readyBlocked",
            });
            return;
          }
        }

        const nextPaused =
          msg.type === "play" ? false : msg.type === "pause" ? true : state.paused;
        const doSeek = msg.type === "seek";
        let pos = isFiniteNonNeg(msg.position)
          ? msg.position
          : this.projectedPosition(state, nowMs);
        let effectiveServerTimeMs = nowMs;

        if (
          hasCap(att, "clientts") &&
          typeof msg.clientServerMs === "number" &&
          Number.isFinite(msg.clientServerMs)
        ) {
          const latMs = Math.max(0, Math.min(2500, nowMs - msg.clientServerMs));
          if (msg.type === "play") {
            effectiveServerTimeMs = nowMs - latMs;
          } else if (!nextPaused) {
            pos += latMs / 1000;
          }
        }

        state.position = pos;
        state.paused = nextPaused;
        state.seq += 1;
        state.serverTimeMs = effectiveServerTimeMs;
        state.setBy = att.username;
        this.broadcastJson({
          type: "state",
          position: pos,
          paused: nextPaused,
          seq: state.seq,
          serverTimeMs: effectiveServerTimeMs,
          setBy: att.username,
          doSeek,
        });
        this.saveState(state);
        return;
      }

      case "resync": {
        if (!this.checkRateLimit(ws, "ping")) return;
        this.sendJson(ws, {
          type: "state",
          position: this.projectedPosition(state, nowMs),
          paused: state.paused,
          seq: state.seq,
          serverTimeMs: nowMs,
          setBy: state.setBy,
          doSeek: true,
        });
        return;
      }

      case "status": {
        if (!this.checkRateLimit(ws, "status")) return;
        const prevBuf = Boolean(att.buffering);
        const prevPos = att.reportedPosition;
        const nextPos = isFiniteNonNeg(msg.position) ? msg.position : null;
        const nextBuf = Boolean(msg.buffering);
        const posChanged =
          (prevPos == null) !== (nextPos == null) ||
          (prevPos != null && nextPos != null && Math.abs(prevPos - nextPos) >= 0.5);
        const proj = this.projectedPosition(state, nowMs);
        const prevLag =
          typeof att.reportedLagSecs === "number" && Number.isFinite(att.reportedLagSecs)
            ? att.reportedLagSecs
            : 0;
        const nextLag =
          typeof nextPos === "number" ? Math.round((proj - nextPos) * 100) / 100 : null;
        const lagDelta = Math.abs((nextLag ?? 0) - prevLag);
        att.reportedPosition = nextPos;
        att.reportedLagSecs = nextLag;
        att.buffering = nextBuf;
        if (prevBuf !== nextBuf || posChanged || lagDelta >= 0.25) {
          this.saveAttachment(ws, att);
        }

        if (prevBuf !== nextBuf || lagDelta >= 1.0) {
          this.broadcastParticipants(att.room, state);
        }
        return;
      }

      case "file": {
        if (!this.checkRateLimit(ws, "control")) return;
        att.file = sanitizeFile(msg.file);
        this.saveAttachment(ws, att);
        this.broadcastParticipants(att.room, state);
        return;
      }

      case "ready": {
        if (!this.checkRateLimit(ws, "control")) return;
        const nextReady = Boolean(msg.isReady);
        const manual = Boolean(msg.manual);
        const wasReady = Boolean(att.isReady);
        att.isReady = nextReady;
        att.manualNotReady = !nextReady && manual;
        this.saveAttachment(ws, att);
        if (!nextReady && (wasReady || manual)) {
          this.broadcastJson(
            {
              type: "peerNotReady",
              username: att.username,
              manual,
            },
            ws
          );
        }
        this.broadcastParticipants(att.room, state);
        return;
      }

      case "setAdmin": {
        if (!this.checkRateLimit(ws, "control")) return;
        const isHost = Boolean(
          state.hostOnly &&
          att.isHost &&
          state.hostUsername &&
          state.hostUsername.toLowerCase() === att.username.toLowerCase()
        );
        if (!isHost) {
          this.sendJson(ws, {
            type: "error",
            code: "NOT_HOST",
            message: "Only the room host can manage admins.",
          });
          return;
        }
        const target = clampString(msg.username, MAX_USERNAME_CHARS);
        if (!target || target.toLowerCase() === att.username.toLowerCase()) return;
        const grant = Boolean(msg.grant);
        const targetLower = target.toLowerCase();
        const exists = state.admins.some((a) => a.toLowerCase() === targetLower);
        if (grant && !exists && state.admins.length < MAX_ROOM_USERS) {
          state.admins.push(target);
          this.saveState(state);
          this.broadcastRoomControl(state, { kind: "adminGranted", actor: att.username }, target);
          this.broadcastParticipants(att.room, state);
        } else if (!grant && exists) {
          state.admins = state.admins.filter((a) => a.toLowerCase() !== targetLower);
          this.saveState(state);
          this.broadcastRoomControl(state, { kind: "adminRevoked", actor: att.username }, target);
          this.broadcastParticipants(att.room, state);
        }
        return;
      }

      case "releaseHost": {
        if (!this.checkRateLimit(ws, "control")) return;
        const isHost = Boolean(
          state.hostOnly &&
          att.isHost &&
          state.hostUsername &&
          state.hostUsername.toLowerCase() === att.username.toLowerCase()
        );
        if (!isHost) return;
        const prevHost = state.hostUsername;
        att.isHost = false;
        this.saveAttachment(ws, att);
        state.hostOnly = false;
        state.hostUsername = null;
        state.hostTokenHash = null;
        state.hostDisconnectedAt = null;
        state.admins = [];
        this.saveState(state);
        this.broadcastRoomControl(state, { kind: "hostReleased", actor: prevHost });
        this.broadcastParticipants(att.room, state);
        return;
      }

      case "p2pSignal": {
        if (!this.checkRateLimit(ws, "p2pSignal")) return;
        const payload = clampString(msg.payload, 1024);
        if (!payload) return;
        this.broadcastJson(
          {
            type: "p2pSignal",
            username: att.username,
            payload,
          },
          ws
        );
        return;
      }

      case "chat": {
        if (!this.checkRateLimit(ws, "chat")) return;
        const id = clampString(msg.id, 32);
        const text = clampString(msg.text, MAX_CHAT_CHARS);
        const avatarId = clampString(msg.avatarId || "", 32);
        const replyToId = msg.replyToId ? clampString(msg.replyToId, 32) : null;
        if (!id || !text) return;
        this.broadcastJson(
          {
            type: "chat",
            id,
            username: att.username,
            avatarId,
            text,
            replyToId,
          },
          ws
        );
        return;
      }

      case "chatEdit": {
        if (!this.checkRateLimit(ws, "chat")) return;
        const targetMsgId = clampString(msg.targetMsgId, 32);
        const text = clampString(msg.text, MAX_CHAT_CHARS);
        if (!targetMsgId || !text) return;
        this.broadcastJson(
          {
            type: "chatEdit",
            targetMsgId,
            username: att.username,
            text,
          },
          ws
        );
        return;
      }

      case "chatReact": {
        if (!this.checkRateLimit(ws, "chat")) return;
        const targetMsgId = clampString(msg.targetMsgId, 32);
        const emoji = clampString(msg.emoji, 48);
        if (!targetMsgId || !emoji) return;
        this.broadcastJson(
          {
            type: "chatReact",
            targetMsgId,
            username: att.username,
            emoji,
          },
          ws
        );
        return;
      }

      case "chatSeen": {
        if (!this.checkRateLimit(ws, "chat")) return;
        const lastMsgId = clampString(msg.lastMsgId, 32);
        if (!lastMsgId) return;
        this.broadcastJson(
          {
            type: "chatSeen",
            username: att.username,
            lastMsgId,
          },
          ws
        );
        return;
      }

      case "introSkipVote": {
        if (!this.checkRateLimit(ws, "chat")) return;
        const segKey = clampString(msg.segKey, 128);
        if (!segKey) return;
        this.broadcastJson(
          {
            type: "introSkipVote",
            username: att.username,
            segKey,
          },
          ws
        );
        return;
      }

      case "reaction": {
        if (!this.checkRateLimit(ws, "chat")) return;
        const emoji = clampString(msg.emoji, 48);
        const avatarId = clampString(msg.avatarId || "", 32);
        const count = Math.max(1, Math.min(25, Math.floor(Number(msg.count) || 1)));
        if (!emoji) return;
        this.broadcastJson(
          {
            type: "reaction",
            username: att.username,
            avatarId,
            emoji,
            count,
          },
          ws
        );
        return;
      }

      case "typing": {
        if (!this.checkRateLimit(ws, "typing")) return;
        this.broadcastJson(
          {
            type: "typing",
            username: att.username,
            isTyping: Boolean(msg.isTyping),
          },
          ws
        );
        return;
      }

      default: {
        if (att.clientVersion && att.clientVersion !== SERVER_VERSION) {
          if (!att.warnedUnsupported) {
            att.warnedUnsupported = true;
            this.saveAttachment(ws, att);
            this.sendJson(ws, {
              type: "error",
              code: "UNSUPPORTED",
              message: `Unsupported message type: ${msg.type}`,
            });
          }
          return;
        }
        this.addStrike(ws);
      }
    }
  }

  async handleHello(ws, att, msg, recvMs = Date.now()) {
    // Precompute all async hashes/tokens BEFORE reading active sockets or room state,
    // so the join/claim check and attachment mutation execute without any interleaved awaits.
    const incomingHostTokenHash =
      typeof msg.hostToken === "string" && msg.hostToken.length > 0
        ? await sha256Hex(msg.hostToken)
        : null;
    const generatedToken = msg.hostOnly ? randomTokenHex() : null;
    const generatedTokenHash = generatedToken ? await sha256Hex(generatedToken) : null;
    const incomingPeekProofHash =
      typeof msg.peekProofHash === "string" && /^[0-9a-f]{64}$/i.test(msg.peekProofHash)
        ? msg.peekProofHash.toLowerCase()
        : null;

    const nowMs = Date.now();
    const active = this.getActiveSockets();
    const state = this.loadState();

    const withinGrace =
      active.length === 0 &&
      typeof state.emptySince === "number" &&
      nowMs - state.emptySince <= EMPTY_CLEANUP_ALARM_MS;
    const isEmptyReset = active.length === 0 && !withinGrace;
    const retained = active.length === 0 && withinGrace;

    if (msg.claimEmpty && (active.length > 0 || withinGrace)) {
      log("info", "hello.reject", { room: att.room, code: "ROOM_OCCUPIED" });
      this.sendJson(ws, {
        type: "error",
        code: "ROOM_OCCUPIED",
        message: "Room code is already in use.",
      });
      ws.close(4009, "Room occupied");
      return;
    }

    const incomingPwHash =
      typeof msg.passwordHash === "string" && /^[0-9a-f]{64}$/i.test(msg.passwordHash)
        ? msg.passwordHash.toLowerCase()
        : null;

    const isValidHostReconnect = Boolean(
      state.hostOnly &&
        state.hostTokenHash &&
        incomingHostTokenHash &&
        (!state.hostDisconnectedAt ||
          nowMs - state.hostDisconnectedAt <= HOST_RECONNECT_GRACE_MS) &&
        constantTimeEqualHex(incomingHostTokenHash, state.hostTokenHash)
    );

    if (isEmptyReset) {
      Object.assign(state, defaultRoomState());
      state.serverTimeMs = nowMs;
      state.passwordHash = incomingPwHash;
      state.peekProofHash = incomingPeekProofHash;
      this.badPasswordMap.clear();
      log("info", "state.reset", { room: att.room });
    } else {
      if (retained) {
        log("info", "state.retained", { room: att.room, seq: state.seq });
      }
      if (state.passwordHash) {
        if (this.badPasswordMap.size > 64) {
          this.pruneBadPasswordMap(nowMs);
        }
        const clientKey = att.clientKey || "anon";
        let pwWin = this.badPasswordMap.get(clientKey);
        if (!pwWin || nowMs - pwWin.startMs >= 60_000) {
          pwWin = { startMs: nowMs, count: 0 };
        }
        if (pwWin.count >= 10) {
          log("warn", "hello.reject", { room: att.room, code: "RATE_LIMITED" });
          this.sendJson(ws, {
            type: "error",
            code: "RATE_LIMITED",
            message: "Too many failed password attempts. Please wait a minute and try again.",
          });
          ws.close(4029, "Too many failed password attempts");
          return;
        }
        if (!incomingPwHash || !constantTimeEqualHex(incomingPwHash, state.passwordHash)) {
          pwWin.count += 1;
          this.badPasswordMap.set(clientKey, pwWin);
          log("warn", "hello.reject", { room: att.room, code: "BAD_PASSWORD" });
          this.sendJson(ws, {
            type: "error",
            code: "BAD_PASSWORD",
            message: "Incorrect room password.",
          });
          ws.close(4003, "Incorrect password");
          return;
        }
        this.badPasswordMap.delete(clientKey);
      }
      if (!state.peekProofHash && incomingPeekProofHash) {
        state.peekProofHash = incomingPeekProofHash;
      }
    }

    const reservedHostLower =
      !isEmptyReset &&
      !isValidHostReconnect &&
      state.hostOnly &&
      state.hostDisconnectedAt !== null &&
      state.hostUsername
        ? state.hostUsername.toLowerCase()
        : null;
    const username = this.deduplicateUsername(msg.username, ws, reservedHostLower);
    let issuedHostToken = null;
    let hostReclaimed = false;

    if (!isEmptyReset && isValidHostReconnect) {
      state.hostUsername = username;
      state.hostDisconnectedAt = null;
      issuedHostToken = msg.hostToken;
      hostReclaimed = true;
    } else if (isEmptyReset && msg.hostOnly && generatedToken && generatedTokenHash) {
      state.hostOnly = true;
      state.hostUsername = username;
      state.hostTokenHash = generatedTokenHash;
      state.hostDisconnectedAt = null;
      state.admins = [];
      issuedHostToken = generatedToken;
    }

    if (
      retained &&
      state.seq === 0 &&
      state.setBy === null &&
      msg.resume &&
      typeof msg.resume === "object"
    ) {
      if (isFiniteNonNeg(msg.resume.position)) {
        state.position = msg.resume.position;
      }
      state.paused = Boolean(msg.resume.paused);
      state.seq = 1;
      state.serverTimeMs = nowMs;
      state.setBy = username;
    }

    state.emptySince = null;
    this.cachedState = state;

    att.joined = true;
    att.username = username;
    att.isHost = Boolean(issuedHostToken);
    att.isReady = Boolean(msg.isReady);
    att.manualNotReady = false;
    att.file = sanitizeFile(msg.file);
    att.lastMsgAt = nowMs;
    att.caps = sanitizeCaps(msg.caps);
    att.clientVersion =
      typeof msg.clientVersion === "string" ? clampString(msg.clientVersion, 32) || null : null;
    this.saveAttachment(ws, att);
    this.saveState(state);

    log("info", "hello.ok", { room: att.room, username, retained, host: Boolean(issuedHostToken) });

    const sendMs = Date.now();
    const participants = this.buildParticipants(att.room, state, sendMs);
    this.sendJson(ws, {
      type: "welcome",
      username,
      room: att.room,
      hostToken: issuedHostToken,
      clientMs:
        typeof msg.clientMs === "number" && Number.isFinite(msg.clientMs) ? msg.clientMs : null,
      recvMs,
      serverTimeMs: sendMs,
      retained,
      serverCaps: SERVER_CAPS,
      state: {
        position: this.projectedPosition(state, sendMs),
        paused: state.paused,
        seq: state.seq,
        serverTimeMs: sendMs,
        setBy: state.setBy,
        doSeek: true,
        reason: retained ? "resume" : undefined,
      },
      participants,
      roomControl: this.buildRoomControlFor(state, username, Boolean(att.isHost)),
    });

    if (hostReclaimed && active.length > 0) {
      this.broadcastRoomControl(state, { kind: "hostReconnected", actor: username });
    }
    if (active.length > 0) {
      this.broadcastParticipants(att.room, state, ws);
    }
    await this.ensureAlarmAt(nowMs + LIVENESS_ALARM_MS);
  }

  async webSocketClose(ws) {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws) {
    await this.handleDisconnect(ws);
  }

  async handleDisconnect(ws) {
    const att = this.getAttachment(ws);
    if (!att || !att.joined) return;

    // Immediately mark unjoined to prevent double-handling and ensure
    // getActiveSockets() / broadcastParticipants() exclude this socket.
    const departedUsername = att.username;
    const roomName = att.room;
    const wasHost = Boolean(att.isHost);
    att.joined = false;
    att.isHost = false;
    this.saveAttachment(ws, att);

    const nowMs = Date.now();
    const state = this.loadState();
    const remaining = this.getActiveSockets();

    if (
      wasHost &&
      state.hostOnly &&
      state.hostUsername &&
      state.hostUsername.toLowerCase() === departedUsername.toLowerCase()
    ) {
      state.hostDisconnectedAt = nowMs;
    }

    if (remaining.length === 0) {
      state.emptySince = nowMs;
      this.saveState(state);
      await this.ctx.storage.setAlarm(nowMs + EMPTY_CLEANUP_ALARM_MS);
    } else {
      this.saveState(state);
      this.broadcastJson({ type: "peerLeft", username: departedUsername });
      this.broadcastParticipants(roomName, state);
      await this.ensureAlarmAt(nowMs + LIVENESS_ALARM_MS);
    }
  }

  async alarm() {
    const nowMs = Date.now();
    this.evictStaleUnjoinedSockets(nowMs);

    for (const { ws, att } of this.getActiveSockets()) {
      const autoTs = this.ctx.getWebSocketAutoResponseTimestamp(ws);
      const autoMs = autoTs instanceof Date ? autoTs.getTime() : 0;
      const lastSeen = Math.max(att.joinedAt || 0, att.lastMsgAt || 0, autoMs);
      if (nowMs - lastSeen > GHOST_IDLE_TIMEOUT_MS) {
        log("info", "socket.reaped", { room: att.room, username: att.username });
        try {
          ws.close(1001, "Idle");
        } catch {}
        await this.handleDisconnect(ws);
      }
    }

    const active = this.getActiveSockets();
    const state = this.loadState();
    if (active.length === 0) {
      if (!state.emptySince || nowMs - state.emptySince >= EMPTY_CLEANUP_ALARM_MS) {
        this.cachedState = null;
        this.badPasswordMap.clear();
        this.ensureSchema();
        this.ctx.storage.sql.exec("DELETE FROM room_state");
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(state.emptySince + EMPTY_CLEANUP_ALARM_MS);
      }
      return;
    }

    const roomName = active[0]?.att?.room || "";
    this.expireAbsentHostIfNeeded(roomName, state, nowMs);
    await this.ctx.storage.setAlarm(nowMs + LIVENESS_ALARM_MS);
  }
}
