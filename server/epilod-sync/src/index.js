export { RoomDO } from "./room.js";

const MAX_PEEK_ROOMS = 8;
const TEXT_ENCODER = new TextEncoder();

const CONTINENT_TO_HINT = {
  EU: "weur",
  NA: "enam",
  AS: "apac",
  OC: "oc",
  SA: "sam",
  AF: "afr",
};

export function pickLocationHint(request) {
  const continent = request?.cf?.continent;
  if (typeof continent === "string" && CONTINENT_TO_HINT[continent]) {
    return CONTINENT_TO_HINT[continent];
  }
  return undefined;
}

function getRoomStub(env, room, request) {
  const hint = pickLocationHint(request);
  if (hint) {
    return env.ROOMS.get(env.ROOMS.idFromName(room), { locationHint: hint });
  }
  return env.ROOMS.getByName(room);
}

async function hashClientIp(ip) {
  const data = TEXT_ENCODER.encode("epilod-ip-v1:" + (ip || "unknown"));
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function sanitizeRoomId(raw) {
  if (typeof raw !== "string") return "";
  const clean = raw
    .replace(/[\u0000-\u001F\u007F-\u009F\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/g, "")
    .trim();
  if (!clean || clean.length > 64) return "";
  return clean;
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

// Per-IP edge rate limit (Workers Rate Limiting binding). Fails open if the binding is
// unavailable so a limiter outage can never take rooms down.
async function isRateLimited(request, env, kind) {
  const limiter = kind === "ws" && env.RL_WS ? env.RL_WS : env.RL;
  if (!limiter) return false;
  try {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await limiter.limit({ key: kind + ":" + ip });
    return !success;
  } catch {
    return false;
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    const url = new URL(request.url);
    if (url.href.length > 1024) {
      return jsonResponse({ ok: false, error: "URL too long" }, 414);
    }

    if (url.pathname === "/health") {
      return jsonResponse({ ok: true, service: "epilod-sync", version: 1 });
    }

    if (url.pathname === "/peek") {
      if (await isRateLimited(request, env, "peek")) {
        return jsonResponse({ ok: false, error: "Rate limited" }, 429, { "Retry-After": "30" });
      }
      const repeated = url.searchParams.getAll("room").map(sanitizeRoomId).filter(Boolean);
      const commaList = (url.searchParams.get("rooms") || "")
        .split(",")
        .map(sanitizeRoomId)
        .filter(Boolean);
      const rooms = Array.from(new Set([...repeated, ...commaList])).slice(0, MAX_PEEK_ROOMS);
      const proofsParam = url.searchParams.get("proofs") || "";
      const proofList = proofsParam ? proofsParam.split(",") : [];

      if (rooms.length === 0) {
        return jsonResponse({ ok: true, rooms: {} });
      }

      const entries = await Promise.all(
        rooms.map(async (room, idx) => {
          try {
            const stub = getRoomStub(env, room, request);
            const proof = proofList[idx] || url.searchParams.get("proof") || null;
            const info = await stub.peek(proof);
            return [room, info];
          } catch {
            return [
              room,
              {
                onlineCount: 0,
                usernamesPreview: [],
                activeMediaHint: null,
                locked: false,
              },
            ];
          }
        })
      );

      return jsonResponse({ ok: true, rooms: Object.fromEntries(entries) });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse({ ok: false, error: "WebSocket upgrade required" }, 426);
      }
      const version = url.searchParams.get("v");
      if (version !== "1") {
        return jsonResponse({ ok: false, error: "Unsupported protocol version" }, 400);
      }
      const room = sanitizeRoomId(url.searchParams.get("room") || "");
      if (!room) {
        return jsonResponse({ ok: false, error: "Invalid room identifier" }, 400);
      }
      if (await isRateLimited(request, env, "ws")) {
        return jsonResponse({ ok: false, error: "Rate limited" }, 429, { "Retry-After": "30" });
      }

      const clientIpHash = await hashClientIp(request.headers.get("CF-Connecting-IP") || "unknown");
      const headers = new Headers(request.headers);
      headers.set("X-Epilod-Client", clientIpHash);
      const fwdReq = new Request(request.url, { headers, method: request.method });

      const stub = getRoomStub(env, room, request);
      return stub.fetch(fwdReq);
    }

    return jsonResponse({ ok: false, error: "Not found" }, 404);
  },
};
