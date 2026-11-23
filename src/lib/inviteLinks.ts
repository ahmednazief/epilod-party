import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isDesktop, safeInvoke } from "./bridge";
import { CLOUD_ENDPOINT, DEFAULT_ENDPOINT } from "./syncStatusDisplay";
import { stripUnsafeUnicode, validateServerEndpointInput } from "./webviewHardening";

export const EPILOD_JOIN_URI_PREFIX = "epilod://join/";
const INVITE_CODE_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;

export interface DeepLinkInvite {
  uri: string;
  roomName: string;
  literalRoom: boolean;
  serverHost: string | null;
}

export function normalizeInviteRoomInput(
  rawRoom: string,
  literalRoom: boolean,
): string | null {
  const clean = stripUnsafeUnicode(rawRoom).trim();
  if (!clean) return null;

  if (literalRoom) {
    const collapsed = clean.replace(/\s+/g, " ");
    if (!collapsed || collapsed.length > 64) return null;
    return collapsed;
  }

  const compact = clean.replace(/[\s-]+/g, "").toUpperCase();
  if (/^\d{6}$/.test(compact)) {
    return compact;
  }
  if (INVITE_CODE_RE.test(compact)) {
    return `${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8, 12)}`;
  }
  return null;
}

export function formatInviteLink(
  roomName: string,
  literalRoom: boolean,
  serverHost?: string | null,
): string | null {
  const canonicalRoom = normalizeInviteRoomInput(roomName, literalRoom);
  if (!canonicalRoom) return null;

  const params: string[] = [];
  if (literalRoom) {
    params.push("literal=1");
  }
  if (serverHost && serverHost.trim()) {
    const validated = validateServerEndpointInput(serverHost);
    if (validated.ok && validated.endpoint) {
      if (validated.endpoint.toLowerCase() !== DEFAULT_ENDPOINT.toLowerCase()) {
        params.push(`host=${encodeURIComponent(validated.endpoint)}`);
      }
    }
  }

  const encodedRoom = encodeURIComponent(canonicalRoom);
  return params.length > 0
    ? `${EPILOD_JOIN_URI_PREFIX}${encodedRoom}?${params.join("&")}`
    : `${EPILOD_JOIN_URI_PREFIX}${encodedRoom}`;
}

export function formatInviteClipboardText(
  roomName: string,
  literalRoom: boolean,
  serverHost?: string | null,
): string {
  const link = formatInviteLink(roomName, literalRoom, serverHost);
  if (!link) return roomName.trim();

  if (!literalRoom) {
    const compact = roomName.replace(/[\s-]+/g, "");
    if (/^\d{6}$/.test(compact)) {
      return `${compact.slice(0, 3)} ${compact.slice(3, 6)} · ${link}`;
    }
  }
  return link;
}

export function parseInviteLink(raw: string): DeepLinkInvite | null {
  const clean = stripUnsafeUnicode(raw);
  const match = /epilod:\/\/join\/[^\s<>"']+/i.exec(clean);
  if (!match) return null;

  const token = match[0].replace(/[.,!?;:)\]]+$/, "");
  if (token.length > 512) return null;

  const rest = token.slice(EPILOD_JOIN_URI_PREFIX.length);
  const noFrag = rest.split("#")[0] ?? rest;
  const qIdx = noFrag.indexOf("?");
  const rawRoomPart = (qIdx >= 0 ? noFrag.slice(0, qIdx) : noFrag).replace(/\/+$/, "");
  const rawQuery = qIdx >= 0 ? noFrag.slice(qIdx + 1) : "";
  if (!rawRoomPart || rawRoomPart.includes("/")) return null;

  let decodedRoom: string;
  try {
    decodedRoom = decodeURIComponent(rawRoomPart.replace(/\+/g, " "));
  } catch {
    return null;
  }

  let literalRoom = false;
  let serverHost: string | null = null;
  if (rawQuery) {
    for (const pair of rawQuery.split("&")) {
      if (!pair) continue;
      const eqIdx = pair.indexOf("=");
      const k = (eqIdx >= 0 ? pair.slice(0, eqIdx) : pair).toLowerCase();
      const v = eqIdx >= 0 ? pair.slice(eqIdx + 1) : "";
      if (k === "literal") {
        literalRoom = v === "1" || v.toLowerCase() === "true";
      } else if (k === "cloud") {
        if (v === "1" || v.toLowerCase() === "true") {
          serverHost = CLOUD_ENDPOINT;
        }
      } else if (k === "host" && v) {
        let decodedHost: string;
        try {
          decodedHost = decodeURIComponent(v.replace(/\+/g, " "));
        } catch {
          return null;
        }
        const validated = validateServerEndpointInput(decodedHost);
        if (!validated.ok || !validated.endpoint) return null;
        if (validated.endpoint.toLowerCase() !== DEFAULT_ENDPOINT.toLowerCase()) {
          serverHost = validated.endpoint;
        }
      }
    }
  }

  const roomName = normalizeInviteRoomInput(decodedRoom, literalRoom);
  if (!roomName) return null;

  const uri = formatInviteLink(roomName, literalRoom, serverHost);
  if (!uri) return null;

  return {
    uri,
    roomName,
    literalRoom,
    serverHost,
  };
}

export async function consumePendingDeepLink(): Promise<DeepLinkInvite | null> {
  return safeInvoke<DeepLinkInvite | null>("consume_pending_deep_link");
}

export async function onDeepLinkInvite(
  handler: (invite: DeepLinkInvite) => void,
): Promise<UnlistenFn> {
  if (!isDesktop()) return () => {};
  return listen<DeepLinkInvite>("app://deep-link", (event) => {
    if (event.payload) {
      handler(event.payload);
    }
  });
}
