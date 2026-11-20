import { isDesktop, safeInvoke } from "./bridge";

export interface ProbeRoomRequest {
  id: string;
  serverHost: string;
  roomName: string;
  literalRoom: boolean;
}

export interface RoomOccupancyDto {
  id: string;
  ok: boolean;
  onlineCount: number;
  usernamesPreview: string[];
  activeMediaHint: string | null;
  checkedAt: number;
}

export interface LocalMatchCandidate {
  path: string;
  fileName: string;
  folderLabel: string;
  score: number;
  titleSimilarity: number;
  confidence: "high" | "medium";
  reason: string;
  isCloudPlaceholder: boolean;
  sizeBytes: number;
  durationSecs: number | null;
  durationDeltaSecs: number | null;
}

export interface FindLocalMatchesRequest {
  peerFileName: string;
  peerDurationSecs?: number | null;
  savedSeriesFolders: string[];
  recentFolders: string[];
  customLibraryFolders: string[];
  forceRefresh?: boolean;
}

export async function probePinnedRooms(
  rooms: readonly ProbeRoomRequest[],
): Promise<RoomOccupancyDto[]> {
  if (!isDesktop() || rooms.length === 0) return [];
  return safeInvoke<RoomOccupancyDto[]>("probe_pinned_rooms", {
    rooms: rooms.slice(0, 5),
  });
}

export async function findLocalMediaMatches(
  request: FindLocalMatchesRequest,
): Promise<LocalMatchCandidate[]> {
  if (!isDesktop() || !request.peerFileName.trim()) return [];
  return safeInvoke<LocalMatchCandidate[]>("find_local_media_matches", {
    request,
  });
}

export async function checkLocalFilesExist(paths: readonly string[]): Promise<boolean[]> {
  if (!isDesktop() || paths.length === 0) return paths.map(() => false);
  return safeInvoke<boolean[]>("check_local_files_exist", {
    paths: [...paths],
  });
}

export async function dpapiProtectSecret(plaintext: string): Promise<string> {
  if (!plaintext) return "";
  if (!isDesktop()) return "";
  return safeInvoke<string>("dpapi_protect_secret", { plaintext });
}

export async function dpapiUnprotectSecret(encoded: string): Promise<string> {
  if (!encoded) return "";
  if (!isDesktop()) return "";
  return safeInvoke<string>("dpapi_unprotect_secret", { encoded });
}
