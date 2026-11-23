import { describe, it, expect } from "vitest";
import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { pickLocationHint } from "../src/index.js";

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function connect(room, headers = {}) {
  const resp = await SELF.fetch(`https://epilod.test/ws?v=1&room=${encodeURIComponent(room)}`, {
    headers: {
      Upgrade: "websocket",
      ...headers,
    },
  });
  if (resp.status !== 101 || !resp.webSocket) {
    return { status: resp.status, body: await resp.text().catch(() => ""), ws: null };
  }
  const ws = resp.webSocket;
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", (ev) => {
    const data = typeof ev.data === "string" ? ev.data : "";
    if (data === "pong") {
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (waiters.length > 0) {
      const idx = waiters.findIndex((w) => !w.type || w.type === parsed.type);
      if (idx !== -1) {
        const [w] = waiters.splice(idx, 1);
        clearTimeout(w.timer);
        w.resolve(parsed);
        return;
      }
    }
    queue.push(parsed);
  });
  ws.accept();
  return {
    status: 101,
    ws,
    send(obj) {
      ws.send(JSON.stringify(obj));
    },
    nextMsg(type = null, timeoutMs = 2000) {
      const qIdx = queue.findIndex((m) => !type || m.type === type);
      if (qIdx !== -1) {
        return Promise.resolve(queue.splice(qIdx, 1)[0]);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = waiters.findIndex((w) => w.resolve === resolve);
          if (idx !== -1) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for ${type || "any"} message`));
        }, timeoutMs);
        waiters.push({ type, resolve, reject, timer });
      });
    },
    close(code = 1000, reason = "bye") {
      try {
        ws.close(code, reason);
      } catch {}
    },
  };
}

async function hello(client, opts = {}) {
  client.send({
    type: "hello",
    username: opts.username || "Alice",
    claimEmpty: Boolean(opts.claimEmpty),
    hostOnly: Boolean(opts.hostOnly),
    passwordHash: opts.passwordHash || undefined,
    hostToken: opts.hostToken || undefined,
    isReady: opts.isReady ?? true,
    caps: opts.caps,
    clientVersion: opts.clientVersion,
    resume: opts.resume,
    peekProofHash: opts.peekProofHash,
    file: opts.file,
  });
  return client.nextMsg("welcome");
}

describe("RoomDO baseline & hardening", () => {
  it("welcomes first joiner, increments seq, and handles legacy hello without caps", async () => {
    const room = `test-basic-${Math.random().toString(36).slice(2)}`;
    const a = await connect(room);
    expect(a.status).toBe(101);
    const w = await hello(a, { username: "Alice", claimEmpty: true });
    expect(w.username).toBe("Alice");
    expect(w.state.seq).toBe(0);
    expect(w.state.paused).toBe(true);
    expect(Array.isArray(w.serverCaps)).toBe(true);
    expect(w.retained).toBe(false);

    a.send({ type: "play", position: 12.5 });
    const s1 = await a.nextMsg("state");
    expect(s1.seq).toBe(1);
    expect(s1.paused).toBe(false);
    expect(s1.position).toBeCloseTo(12.5, 2);

    a.send({ type: "seek", position: 42.0 });
    const s2 = await a.nextMsg("state");
    expect(s2.seq).toBe(2);
    expect(s2.doSeek).toBe(true);
    expect(s2.position).toBeCloseTo(42.0, 2);

    a.send({ type: "pause", position: 43.0 });
    const s3 = await a.nextMsg("state");
    expect(s3.seq).toBe(3);
    expect(s3.paused).toBe(true);

    a.close();
  });

  it("retains state across empty window (T1.1) and seeds from resume when pristine", async () => {
    const room = `test-retain-${Math.random().toString(36).slice(2)}`;
    const a = await connect(room);
    await hello(a, { username: "Alice", claimEmpty: true });
    const b = await connect(room);
    await hello(b, { username: "Bob" });

    a.send({ type: "play", position: 600.0 });
    await a.nextMsg("state");
    await b.nextMsg("state");

    // Both drop simultaneously
    a.close();
    b.close();
    await new Promise((r) => setTimeout(r, 40));

    // Reconnect within grace window -> state retained near 600s, not 0
    const a2 = await connect(room);
    const wA2 = await hello(a2, { username: "Alice" });
    expect(wA2.retained).toBe(true);
    expect(wA2.state.position).toBeGreaterThanOrEqual(600.0);
    expect(wA2.state.paused).toBe(false);

    const b2 = await connect(room);
    const wB2 = await hello(b2, { username: "Bob" });
    expect(wB2.state.position).toBeGreaterThanOrEqual(600.0);
    a2.close();
    b2.close();
  });

  it("blocks password/host takeover during empty grace window (T1.2) and scopes lockout per IP (T1.6)", async () => {
    const room = `test-takeover-${Math.random().toString(36).slice(2)}`;
    const pwHash = "a".repeat(64);
    const host = await connect(room, { "CF-Connecting-IP": "1.1.1.1" });
    const wHost = await hello(host, {
      username: "Host",
      claimEmpty: true,
      hostOnly: true,
      passwordHash: pwHash,
    });
    host.close();
    await new Promise((r) => setTimeout(r, 40));

    // Stranger tries to join empty room within 65s without password -> BAD_PASSWORD
    const eve = await connect(room, { "CF-Connecting-IP": "2.2.2.2" });
    eve.send({
      type: "hello",
      username: "Eve",
      claimEmpty: false,
      hostOnly: true,
      isReady: true,
    });
    const err = await eve.nextMsg("error");
    expect(err.code).toBe("BAD_PASSWORD");
    eve.close();

    // Attacker fails 10 times from 3.3.3.3 -> locked out, but 4.4.4.4 can still join
    for (let i = 0; i < 10; i++) {
      const att = await connect(room, { "CF-Connecting-IP": "3.3.3.3" });
      att.send({ type: "hello", username: "Att", passwordHash: "c".repeat(64), isReady: true });
      await att.nextMsg("error");
      att.close();
    }
    const locked = await connect(room, { "CF-Connecting-IP": "3.3.3.3" });
    locked.send({ type: "hello", username: "Att", passwordHash: pwHash, isReady: true });
    const lockErr = await locked.nextMsg("error");
    expect(lockErr.code).toBe("RATE_LIMITED");
    locked.close();

    const legit = await connect(room, { "CF-Connecting-IP": "4.4.4.4" });
    const wLegit = await hello(legit, { username: "Bob", passwordHash: pwHash });
    expect(wLegit.username).toBe("Bob");
    expect(wLegit.roomControl.localIsHost).toBe(false);

    // Host reconnects with token
    const host2 = await connect(room, { "CF-Connecting-IP": "1.1.1.1" });
    const wHost2 = await hello(host2, {
      username: "Host",
      passwordHash: pwHash,
      hostToken: wHost.hostToken,
    });
    expect(wHost2.roomControl.localIsHost).toBe(true);

    legit.close();
    host2.close();
  });

  it("prevents guest impersonating absent host username during reconnect grace period", async () => {
    const room = `test-host-impersonation-${Math.random().toString(36).slice(2)}`;
    const host = await connect(room);
    const wHost = await hello(host, {
      username: "Alice",
      claimEmpty: true,
      hostOnly: true,
    });
    expect(wHost.roomControl.localIsHost).toBe(true);

    const bob = await connect(room);
    await hello(bob, { username: "Bob" });

    // Host temporarily disconnects (entering 60s grace window)
    host.close();
    await bob.nextMsg("peerLeft");

    // Attacker tries to join using the absent host's exact username without hostToken
    const eve = await connect(room);
    const wEve = await hello(eve, { username: "Alice" });
    expect(wEve.username).not.toBe("Alice");
    expect(wEve.roomControl.localIsHost).toBe(false);

    // Playback command from attacker is blocked
    eve.send({ type: "play", position: 99 });
    const blocked = await eve.nextMsg("roomControl");
    expect(blocked.notice?.kind).toBe("guestBlocked");

    // Real host reconnects with valid hostToken and keeps exact username + host control
    const host2 = await connect(room);
    const wHost2 = await hello(host2, {
      username: "Alice",
      hostToken: wHost.hostToken,
    });
    expect(wHost2.username).toBe("Alice");
    expect(wHost2.roomControl.localIsHost).toBe(true);

    bob.close();
    eve.close();
    host2.close();
  });

  it("enforces Ready-Play Gate server-side for readygate-capable clients (T1.4)", async () => {
    const room = `test-ready-${Math.random().toString(36).slice(2)}`;
    const a = await connect(room);
    await hello(a, { username: "Alice", claimEmpty: true, caps: ["readygate"] });
    const b = await connect(room);
    await hello(b, { username: "Bob", caps: ["readygate"] });

    b.send({ type: "ready", isReady: false, manual: true });
    await a.nextMsg("peerNotReady");

    a.send({ type: "play", position: 10 });
    const blocked = await a.nextMsg("playBlocked");
    expect(blocked.usernames).toContain("Bob");
    const st = await a.nextMsg("state");
    expect(st.paused).toBe(true);
    expect(st.reason).toBe("readyBlocked");

    b.send({ type: "ready", isReady: true, manual: true });
    await a.nextMsg("participants");

    a.send({ type: "play", position: 10 });
    const played = await a.nextMsg("state");
    expect(played.paused).toBe(false);

    a.close();
    b.close();
  });

  it("prevents concurrent claimEmpty race (T1.5)", async () => {
    const room = `test-race-${Math.random().toString(36).slice(2)}`;
    const c1 = await connect(room);
    const c2 = await connect(room);
    c1.send({ type: "hello", username: "A", claimEmpty: true, isReady: true });
    c2.send({ type: "hello", username: "B", claimEmpty: true, isReady: true });

    const r1 = await c1.nextMsg();
    const r2 = await c2.nextMsg();
    const types = [r1.type, r2.type].sort();
    expect(types).toEqual(["error", "welcome"]);
    c1.close();
    c2.close();
  });

  it("gives rateLimited feedback + authoritative state on playback burst (T1.7)", async () => {
    const room = `test-rl-${Math.random().toString(36).slice(2)}`;
    const a = await connect(room);
    await hello(a, { username: "Alice", claimEmpty: true });

    for (let i = 0; i < 16; i++) {
      a.send({ type: "seek", position: 10 + i });
    }
    const rl = await a.nextMsg("rateLimited");
    expect(rl.bucket).toBe("playback");
    const st = await a.nextMsg("state");
    expect(st.seq).toBeLessThanOrEqual(12);
    a.close();
  });

  it("returns 409 ROOM_FULL for 17th connection (T1.8)", async () => {
    const room = `test-full-${Math.random().toString(36).slice(2)}`;
    const clients = [];
    for (let i = 0; i < 16; i++) {
      const c = await connect(room);
      expect(c.status).toBe(101);
      await hello(c, { username: `User${i}` });
      clients.push(c);
    }
    const extra = await connect(room);
    expect(extra.status).toBe(409);
    for (const c of clients) c.close();
  });

  it("compensates sender latency with clientServerMs (T3.6)", async () => {
    const room = `test-ts-${Math.random().toString(36).slice(2)}`;
    const a = await connect(room);
    await hello(a, { username: "Alice", claimEmpty: true, caps: ["clientts"] });

    const sentAt = Date.now() - 250;
    a.send({ type: "play", position: 100.0, clientServerMs: sentAt });
    const st = await a.nextMsg("state");
    expect(st.serverTimeMs).toBeLessThan(Date.now() - 150);
    a.close();
  });

  it("tracks peer status/lag/buffering (T3.7) and hardens /peek (T4.1)", async () => {
    const room = `test-peek-${Math.random().toString(36).slice(2)}`;
    const proof = "secret-proof-123";
    const proofHash = await sha256Hex(proof);

    const a = await connect(room);
    await hello(a, {
      username: "Alice",
      claimEmpty: true,
      caps: ["status"],
      peekProofHash: proofHash,
      file: { name: "Pilot.mkv", size: 1000, duration: 2400 },
    });

    a.send({ type: "status", position: 0, buffering: true });
    const pMsg = await a.nextMsg("participants");
    expect(pMsg.participants[0].buffering).toBe(true);

    // Unauthenticated peek: counts only
    const unauthResp = await SELF.fetch(`https://epilod.test/peek?room=${encodeURIComponent(room)}`);
    const unauthJson = await unauthResp.json();
    expect(unauthJson.rooms[room].onlineCount).toBe(1);
    expect(unauthJson.rooms[room].usernamesPreview).toEqual([]);
    expect(unauthJson.rooms[room].activeMediaHint).toBeNull();

    // Authenticated peek: returns usernames & media
    const authResp = await SELF.fetch(
      `https://epilod.test/peek?room=${encodeURIComponent(room)}&proof=${encodeURIComponent(proof)}`
    );
    const authJson = await authResp.json();
    expect(authJson.rooms[room].onlineCount).toBe(1);
    expect(authJson.rooms[room].usernamesPreview).toEqual(["Alice"]);
    expect(authJson.rooms[room].activeMediaHint).toBe("Pilot.mkv");

    a.close();
  });

  it("handles forward-compat unknown messages without disconnecting newer clients (T4.5) and alarm cleanup", async () => {
    const room = `test-fwd-${Math.random().toString(36).slice(2)}`;
    const a = await connect(room);
    await hello(a, { username: "Alice", claimEmpty: true, clientVersion: "2.0.0" });
    a.send({ type: "futureFeatureXYZ" });
    const err = await a.nextMsg("error");
    expect(err.code).toBe("UNSUPPORTED");
    a.close();

    // Dynamic placement mapping (T4.2)
    expect(pickLocationHint({ cf: { continent: "NA" } })).toBe("enam");
    expect(pickLocationHint({ cf: { continent: "EU" } })).toBe("weur");
    expect(pickLocationHint({})).toBeUndefined();

    // Alarm helper runs cleanly on DO stub
    const id = env.ROOMS.idFromName(room);
    const stub = env.ROOMS.get(id);
    await runDurableObjectAlarm(stub);
  });

  it("delivers adminGranted/adminRevoked notices only to the target user", async () => {
    const room = `test-admin-notice-${Math.random().toString(36).slice(2)}`;
    const host = await connect(room);
    await hello(host, { username: "Alice", hostOnly: true, claimEmpty: true });
    const bob = await connect(room);
    await hello(bob, { username: "Bob" });
    const charlie = await connect(room);
    await hello(charlie, { username: "Charlie" });

    // Drain initial roomControl/participants
    host.send({ type: "setAdmin", username: "Bob", grant: true });
    const hostRc = await host.nextMsg("roomControl");
    const bobRc = await bob.nextMsg("roomControl");
    const charlieRc = await charlie.nextMsg("roomControl");
    expect(hostRc.notice).toBeNull();
    expect(charlieRc.notice).toBeNull();
    expect(bobRc.notice).toEqual({ kind: "adminGranted", actor: "Alice" });
    expect(bobRc.roomControl.localIsAdmin).toBe(true);

    host.close();
    bob.close();
    charlie.close();
  });
});
