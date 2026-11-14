import { isDesktop, safeInvoke } from "./bridge";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  tsMs: number;
  level: LogLevel;
  target: string;
  code?: string | null;
  message: string;
}

export interface LogsSnapshot {
  entries: LogEntry[];
  droppedCount: number;
  logFilePath?: string | null;
}

export async function logFrontendEvent(
  level: LogLevel,
  target: string,
  message: string,
  code?: string,
): Promise<void> {
  if (!isDesktop()) {
    return;
  }
  try {
    await safeInvoke<void>("log_frontend_event", {
      level,
      target,
      code: code ?? null,
      message,
    });
  } catch {
    // Diagnostics logging must never cascade failures
  }
}

export async function getLogsSnapshot(limit = 150): Promise<LogsSnapshot> {
  if (!isDesktop()) {
    return { entries: [], droppedCount: 0, logFilePath: null };
  }
  return safeInvoke<LogsSnapshot>("get_logs_snapshot", { limit });
}
