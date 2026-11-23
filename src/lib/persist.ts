const KEY_PREFIX = "epilod.v1.";

export function versionedKey(name: string): string {
  return name.startsWith(KEY_PREFIX) ? name : `${KEY_PREFIX}${name}`;
}

export function loadJson<T>(name: string, fallback: T): T {
  try {
    if (typeof localStorage === "undefined") {
      return fallback;
    }
    const raw = localStorage.getItem(versionedKey(name));
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || parsed === undefined) {
      return fallback;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

export function saveJson<T>(name: string, value: T): boolean {
  try {
    if (typeof localStorage === "undefined") {
      return false;
    }
    localStorage.setItem(versionedKey(name), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export interface LruTimestamped {
  updatedAt: number;
}

/**
 * Trims a record map to at most `maxEntries` by removing the oldest `updatedAt` entries.
 */
export function trimLruMap<T extends LruTimestamped>(
  map: Record<string, T>,
  maxEntries: number,
): Record<string, T> {
  const entries = Object.entries(map);
  if (entries.length <= maxEntries) {
    return map;
  }
  entries.sort((a, b) => (b[1].updatedAt || 0) - (a[1].updatedAt || 0));
  return Object.fromEntries(entries.slice(0, Math.max(0, maxEntries)));
}
