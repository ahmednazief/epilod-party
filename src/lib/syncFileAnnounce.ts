export interface FileAnnouncementInput {
  syncConnected: boolean;
  endpoint: string;
  username: string;
  roomCode: string;
  fileName: string | null;
  loaded: boolean;
  durationSecs: number;
}

/**
 * Fix 02: Computes a unique announcement key per connection session and loaded file
 * (rounded duration avoids repeating IPC on sub-second duration jitter).
 */
export function buildFileAnnouncementKey(input: FileAnnouncementInput): string | null {
  if (!input.syncConnected || !input.loaded || !input.fileName) {
    return null;
  }
  const roundedDuration = Math.max(0, Math.round(input.durationSecs));
  if (roundedDuration <= 0) {
    return null;
  }
  return `${input.endpoint}|${input.roomCode}|${input.username}|${input.fileName}|${roundedDuration}`;
}

export function shouldAnnounceFile(
  previousKey: string | null,
  input: FileAnnouncementInput,
): { announce: boolean; nextKey: string | null } {
  if (!input.syncConnected) {
    // Clearing cached key on disconnect forces re-announce on reconnect!
    return { announce: false, nextKey: null };
  }
  const nextKey = buildFileAnnouncementKey(input);
  if (!nextKey) {
    return { announce: false, nextKey: previousKey };
  }
  if (nextKey === previousKey) {
    return { announce: false, nextKey };
  }
  return { announce: true, nextKey };
}
