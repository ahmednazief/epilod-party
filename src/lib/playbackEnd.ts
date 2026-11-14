export type MpvEndAction =
  | { kind: "ignore" }
  | { kind: "eof" }
  | { kind: "error"; message: string };

/**
 * Fix 11: Differentiates clean natural EOF (`reason: "eof"` -> replayable paused state)
 * from fatal playback errors (`reason: "error"`). `stop` / `redirect` when replacing media
 * must not treat the incoming load as a crash.
 */
export function classifyMpvEnd(payload: {
  reason: string;
  error?: string | null;
}): MpvEndAction {
  const reason = (payload.reason || "").trim().toLowerCase();
  if (reason === "eof") {
    return { kind: "eof" };
  }
  if (reason === "error") {
    const detail = (payload.error || "").trim();
    return {
      kind: "error",
      message: detail || "Playback ended due to a media error.",
    };
  }
  return { kind: "ignore" };
}

export function shouldReplayFromStart(params: {
  endedAtEof: boolean;
  paused: boolean;
  positionSecs: number;
  durationSecs: number;
}): boolean {
  if (!params.paused) {
    return false;
  }
  if (params.endedAtEof) {
    return true;
  }
  return (
    params.durationSecs > 1 &&
    params.positionSecs >= Math.max(0, params.durationSecs - 0.5)
  );
}
