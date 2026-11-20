import { DurableObject } from "cloudflare:workers";

const MAX_ROOM_USERS = 16;
const MAX_MESSAGE_BYTES = 4096;
const MAX_CHAT_CHARS = 500;
const MAX_USERNAME_CHARS = 48;
const MAX_FILENAME_CHARS = 240;
const MAX_STRIKES = 10;
const HOST_RECONNECT_GRACE_MS = 60_000;
const EMPTY_CLEANUP_ALARM_MS = 65_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

const TEXT_ENCODER = new TextEncoder();

const RATE_LIMITS = {
  playback: { max: 8, windowMs: 2_000 },
  chat: { max: 8, windowMs: 2_000 },
  typing: { max: 2, windowMs: 2_000 },
  p2pSignal: { max: 12, windowMs: 60_000 },
  ping: { max: 6, windowMs: 10_000 },
  control: { max: 6, windowMs: 5_000 },
};

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
  };
}

export class RoomDO extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rateState = new WeakMap();
    this.cachedState = null;
    this.schemaReady = false;
    this.hasAlarm = false;
    this.badPasswordWindow = { startMs: 0, count: 0 };

    // Zero-compute edge auto-response for lightweight keepalive pings.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
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

  evictStaleUnjoinedSockets(nowMs = Date.now()) {
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment();
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
      const att = ws.deserializeAttachment();
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
        state.hostUsername && state.hostUsername.toLowerCase() === lower
      );
      const isAdmin = !isHost && adminSet.has(lower);
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
      };
    });
  }

  buildRoomControlFor(state, username) {
    const lower = (username || "").toLowerCase();
    const localIsHost = Boolean(
      state.hostUsername && state.hostUsername.toLowerCase() === lower
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
      this.broadcastRoomControl(state, { kind: "hostAbsentUnlocked", actor: null });
      if (roomName) {
        this.broadcastParticipants(roomName, state);
      }
      return true;
    }
    return false;
  }

  canControlPlayback(roomName, state, username, nowMs = Date.now()) {
    this.expireAbsentHostIfNeeded(roomName, state, nowMs);
    if (!state.hostOnly) return true;
    const lower = (username || "").toLowerCase();
    if (state.hostUsername && state.hostUsername.toLowerCase() === lower) {
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

  broadcastParticipants(roomName, state) {
    const participants = this.buildParticipants(roomName, state);
    this.broadcastJson({ type: "participants", participants });
  }

  broadcastRoomControl(state, notice = null) {
    for (const { ws, att } of this.getActiveSockets()) {
      this.sendJson(ws, {
        type: "roomControl",
        roomControl: this.buildRoomControlFor(state, att.username),
        notice,
      });
    }
  }

  checkRateLimit(ws, bucket) {
    const cfg = RATE_LIMITS[bucket];
    if (!cfg) return true;
    let entry = this.rateState.get(ws);
    if (!entry) {
      entry = { buckets: {}, strikes: 0 };
      this.rateState.set(ws, entry);
    }
    const now = Date.now();
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
      entry = { buckets: {}, strikes: 0 };
      this.rateState.set(ws, entry);
    }
    entry.strikes += 1;
    if (entry.strikes >= MAX_STRIKES) {
      try {
        ws.close(1008, "Policy violation");
      } catch {}
    }
  }

  deduplicateUsername(rawName, excludeWs) {
    const base = clampString(rawName, MAX_USERNAME_CHARS) || "Guest";
    const used = new Set();
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

  async peek() {
    this.evictStaleUnjoinedSockets();
    const active = this.getActiveSockets();
    const state = this.loadState();
    if (active.length === 0) {
      return {
        onlineCount: 0,
        usernamesPreview: [],
        activeMediaHint: null,
        locked: false,
      };
    }
    const locked = Boolean(state.passwordHash);
    if (locked) {
      return {
        onlineCount: active.length,
        usernamesPreview: [],
        activeMediaHint: null,
        locked: true,
      };
    }
    const usernamesPreview = active.slice(0, 4).map(({ att }) => att.username);
    const activeMediaHint =
      active.find(({ att }) => att.file && att.file.name)?.att.file.name || null;
    return {
      onlineCount: active.length,
      usernamesPreview,
      activeMediaHint,
      locked: false,
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
      return new Response("Room full", { status: 429 });
    }

    const roomName = clampString(url.searchParams.get("room") || "", 64);
    if (!roomName) {
      return new Response("Missing room", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      joined: false,
      room: roomName,
      username: "",
      isReady: false,
      manualNotReady: false,
      file: null,
      joinedAt: Date.now(),
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== "string") {
      this.addStrike(ws);
      return;
    }
    if (
      message.length > MAX_MESSAGE_BYTES ||
      TEXT_ENCODER.encode(message).byteLength > MAX_MESSAGE_BYTES
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

    const att = ws.deserializeAttachment();
    if (!att) {
      ws.close(1008, "Invalid session");
      return;
    }

    if (!att.joined) {
      if (msg.type === "ping") {
        if (!this.checkRateLimit(ws, "ping")) return;
        this.sendJson(ws, {
          type: "pong",
          clientMs: typeof msg.clientMs === "number" ? msg.clientMs : 0,
          serverTimeMs: Date.now(),
        });
        return;
      }
      if (msg.type !== "hello") {
        this.addStrike(ws);
        return;
      }
      await this.handleHello(ws, att, msg);
      return;
    }

    const state = this.loadState();
    const nowMs = Date.now();

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
        if (!this.checkRateLimit(ws, "playback")) return;
        if (!this.canControlPlayback(att.room, state, att.username, nowMs)) {
          this.sendJson(ws, {
            type: "roomControl",
            roomControl: this.buildRoomControlFor(state, att.username),
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
          });
          return;
        }
        const pos = isFiniteNonNeg(msg.position)
          ? msg.position
          : this.projectedPosition(state, nowMs);
        const nextPaused =
          msg.type === "play" ? false : msg.type === "pause" ? true : state.paused;
        const doSeek = msg.type === "seek";
        state.position = pos;
        state.paused = nextPaused;
        state.seq += 1;
        state.serverTimeMs = nowMs;
        state.setBy = att.username;
        this.saveState(state);

        this.broadcastJson({
          type: "state",
          position: pos,
          paused: nextPaused,
          seq: state.seq,
          serverTimeMs: nowMs,
          setBy: att.username,
          doSeek,
        });
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

      case "file": {
        if (!this.checkRateLimit(ws, "control")) return;
        att.file = sanitizeFile(msg.file);
        ws.serializeAttachment(att);
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
        ws.serializeAttachment(att);
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
        const isHost =
          state.hostOnly &&
          state.hostUsername &&
          state.hostUsername.toLowerCase() === att.username.toLowerCase();
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
          this.broadcastRoomControl(state, { kind: "adminGranted", actor: att.username });
          this.broadcastParticipants(att.room, state);
        } else if (!grant && exists) {
          state.admins = state.admins.filter((a) => a.toLowerCase() !== targetLower);
          this.saveState(state);
          this.broadcastRoomControl(state, { kind: "adminRevoked", actor: att.username });
          this.broadcastParticipants(att.room, state);
        }
        return;
      }

      case "releaseHost": {
        if (!this.checkRateLimit(ws, "control")) return;
        const isHost =
          state.hostOnly &&
          state.hostUsername &&
          state.hostUsername.toLowerCase() === att.username.toLowerCase();
        if (!isHost) return;
        const prevHost = state.hostUsername;
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

      default:
        this.addStrike(ws);
    }
  }

  async handleHello(ws, att, msg) {
    const active = this.getActiveSockets();
    const state = this.loadState();
    const nowMs = Date.now();

    if (msg.claimEmpty && active.length > 0) {
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

    if (active.length === 0) {
      const isHostReconnecting =
        state.hostOnly &&
        state.hostTokenHash &&
        typeof msg.hostToken === "string" &&
        state.hostDisconnectedAt &&
        nowMs - state.hostDisconnectedAt <= HOST_RECONNECT_GRACE_MS &&
        constantTimeEqualHex(await sha256Hex(msg.hostToken), state.hostTokenHash);

      if (!isHostReconnecting) {
        Object.assign(state, defaultRoomState());
        state.serverTimeMs = nowMs;
        state.passwordHash = incomingPwHash;
      }
    } else if (state.passwordHash) {
      if (nowMs - this.badPasswordWindow.startMs >= 60_000) {
        this.badPasswordWindow = { startMs: nowMs, count: 0 };
      }
      if (this.badPasswordWindow.count >= 10) {
        this.sendJson(ws, {
          type: "error",
          code: "RATE_LIMITED",
          message: "Too many failed password attempts. Please wait a minute and try again.",
        });
        ws.close(4029, "Too many failed password attempts");
        return;
      }
      if (!incomingPwHash || !constantTimeEqualHex(incomingPwHash, state.passwordHash)) {
        this.badPasswordWindow.count += 1;
        this.sendJson(ws, {
          type: "error",
          code: "BAD_PASSWORD",
          message: "Incorrect room password.",
        });
        ws.close(4003, "Incorrect password");
        return;
      }
      this.badPasswordWindow = { startMs: 0, count: 0 };
    }

    const username = this.deduplicateUsername(msg.username, ws);
    let issuedHostToken = null;

    if (
      state.hostOnly &&
      state.hostTokenHash &&
      typeof msg.hostToken === "string" &&
      (!state.hostDisconnectedAt ||
        nowMs - state.hostDisconnectedAt <= HOST_RECONNECT_GRACE_MS) &&
      constantTimeEqualHex(await sha256Hex(msg.hostToken), state.hostTokenHash)
    ) {
      state.hostUsername = username;
      state.hostDisconnectedAt = null;
      issuedHostToken = msg.hostToken;
      if (this.hasAlarm || state.hostDisconnectedAt) {
        this.hasAlarm = false;
        await this.ctx.storage.deleteAlarm();
      }
    } else if (active.length === 0 && msg.hostOnly) {
      const token = randomTokenHex();
      state.hostOnly = true;
      state.hostUsername = username;
      state.hostTokenHash = await sha256Hex(token);
      state.hostDisconnectedAt = null;
      state.admins = [];
      issuedHostToken = token;
      if (this.hasAlarm) {
        this.hasAlarm = false;
        await this.ctx.storage.deleteAlarm();
      }
    } else if (this.hasAlarm && !state.hostDisconnectedAt) {
      this.hasAlarm = false;
      await this.ctx.storage.deleteAlarm();
    }

    this.cachedState = state;
    att.joined = true;
    att.username = username;
    att.isReady = Boolean(msg.isReady);
    att.manualNotReady = false;
    att.file = sanitizeFile(msg.file);
    ws.serializeAttachment(att);

    const participants = this.buildParticipants(att.room, state, nowMs);
    this.sendJson(ws, {
      type: "welcome",
      username,
      room: att.room,
      hostToken: issuedHostToken,
      serverTimeMs: nowMs,
      state: {
        position: this.projectedPosition(state, nowMs),
        paused: state.paused,
        seq: state.seq,
        serverTimeMs: nowMs,
        setBy: state.setBy,
        doSeek: true,
      },
      participants,
      roomControl: this.buildRoomControlFor(state, username),
    });

    this.saveState(state);
    this.broadcastParticipants(att.room, state);
  }

  async webSocketClose(ws) {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws) {
    await this.handleDisconnect(ws);
  }

  async handleDisconnect(ws) {
    const att = ws.deserializeAttachment();
    if (!att || !att.joined) return;

    // Immediately mark unjoined to prevent double-handling and ensure
    // getActiveSockets() / broadcastParticipants() exclude this socket.
    const departedUsername = att.username;
    const roomName = att.room;
    att.joined = false;
    ws.serializeAttachment(att);

    const state = this.loadState();
    const remaining = this.getActiveSockets();
    let hostJustLeft = false;

    if (
      state.hostOnly &&
      state.hostUsername &&
      state.hostUsername.toLowerCase() === departedUsername.toLowerCase()
    ) {
      state.hostDisconnectedAt = Date.now();
      hostJustLeft = true;
      this.saveState(state);
    }

    if (remaining.length === 0) {
      this.hasAlarm = true;
      await this.ctx.storage.setAlarm(Date.now() + EMPTY_CLEANUP_ALARM_MS);
    } else {
      if (hostJustLeft) {
        // Ensure remaining guests automatically unlock if host doesn't return in 60s.
        this.hasAlarm = true;
        await this.ctx.storage.setAlarm(Date.now() + HOST_RECONNECT_GRACE_MS + 1000);
      }
      this.broadcastJson({ type: "peerLeft", username: departedUsername });
      this.broadcastParticipants(roomName, state);
    }
  }

  async alarm() {
    this.evictStaleUnjoinedSockets();
    const active = this.getActiveSockets();
    if (active.length === 0) {
      this.cachedState = null;
      this.hasAlarm = false;
      this.ensureSchema();
      this.ctx.storage.sql.exec("DELETE FROM room_state");
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const state = this.loadState();
    const roomName = active[0]?.att?.room || "";
    this.expireAbsentHostIfNeeded(roomName, state, Date.now());
  }
}
