import type { StateStorage } from "zustand/middleware";

/** All localStorage keys owned by this app. Used by "Local Data" settings. */
export const STORAGE_KEYS = {
  ui: "gtps-assistant:ui",
  chat: "gtps-assistant:chat",
  workspace: "gtps-assistant:workspace",
} as const;

function getStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * A localStorage adapter that never throws (private mode, blocked storage,
 * quota errors). Persisted stores simply fall back to in-memory state.
 */
export const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return getStorage()?.getItem(name) ?? null;
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      getStorage()?.setItem(name, value);
    } catch {
      /* ignore write failures */
    }
  },
  removeItem: (name) => {
    try {
      getStorage()?.removeItem(name);
    } catch {
      /* ignore */
    }
  },
};

/** Removes every key this app owns. Returns the number of keys removed. */
export function clearLocalData(): number {
  const storage = getStorage();
  if (!storage) return 0;
  let removed = 0;
  for (const key of Object.values(STORAGE_KEYS)) {
    if (storage.getItem(key) !== null) {
      storage.removeItem(key);
      removed += 1;
    }
  }
  return removed;
}

/** Approximate size in bytes of the data this app stores locally. */
export function getLocalDataSize(): number {
  const storage = getStorage();
  if (!storage) return 0;
  let bytes = 0;
  for (const key of Object.values(STORAGE_KEYS)) {
    const value = storage.getItem(key);
    if (value) bytes += (key.length + value.length) * 2;
  }
  return bytes;
}
