const BIDI_AND_CONTROL_RE = /[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;

export function stripUnsafeUnicode(input: string): string {
  return input.replace(BIDI_AND_CONTROL_RE, "");
}

export function sanitizeUsername(raw: string): string {
  const clean = stripUnsafeUnicode(raw).trim();
  if (!clean) {
    return "";
  }
  return Array.from(clean).slice(0, 32).join("");
}

export function sanitizeRoomCodeInput(raw: string, literalRoom = false): string {
  const clean = stripUnsafeUnicode(raw).trim();
  if (literalRoom) {
    return Array.from(clean).slice(0, 64).join("");
  }
  return clean.toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 24);
}

export function sanitizeCustomServerEndpoint(raw: string): string {
  let clean = stripUnsafeUnicode(raw).trim();
  clean = clean.replace(/^(syncplay|wss?|https?):\/\//i, "");
  clean = clean.split(/[/?#]/)[0] ?? "";
  return clean.slice(0, 128);
}

export interface EndpointValidation {
  ok: boolean;
  endpoint?: string;
  reason?: string;
}

export function validateServerEndpointInput(raw: string): EndpointValidation {
  const clean = sanitizeCustomServerEndpoint(raw);
  if (!clean) {
    return { ok: false, reason: "Server address cannot be empty." };
  }
  const lastColon = clean.lastIndexOf(":");
  let host = clean;
  let port = 8999;

  if (lastColon > 0 && !clean.endsWith("]")) {
    host = clean.slice(0, lastColon);
    const portStr = clean.slice(lastColon + 1);
    if (!/^\d+$/.test(portStr)) {
      return { ok: false, reason: "Server port must be a valid number (1–65535)." };
    }
    port = Number.parseInt(portStr, 10);
    if (port < 1 || port > 65535) {
      return { ok: false, reason: "Server port must be between 1 and 65535." };
    }
  }

  host = host.replace(/^\[|\]$/g, "");
  if (!host || /\s/.test(host)) {
    return { ok: false, reason: "Server hostname contains invalid characters." };
  }

  const normalized = lastColon > 0 && !clean.endsWith("]") ? `${host}:${port}` : `${host}:8999`;
  return { ok: true, endpoint: normalized };
}
