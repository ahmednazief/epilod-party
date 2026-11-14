import { invoke } from "@tauri-apps/api/core";

export class RuntimeUnavailableError extends Error {
  constructor(message = "Epilod Party desktop features require the Windows Tauri runtime.") {
    super(message);
    this.name = "RuntimeUnavailableError";
  }
}

export function isDesktop(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.__TAURI_INTERNALS__ || w.__TAURI__);
}

export async function safeInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) {
    throw new RuntimeUnavailableError();
  }
  return invoke<T>(command, args);
}
