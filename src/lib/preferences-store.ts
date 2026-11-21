/** Framework-free preferences store (no React), so it can be tested and reused by backup/restore. */
import { DEFAULT_PREFERENCES, parsePreferences, type Preferences } from "@/lib/preferences";
import { STORAGE_KEYS } from "@/services/storage";

export const PREFERENCES_VERSION = 1;

type Listener = () => void;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Preferences with no framework dependency: one object, saved to localStorage on every change,
 * observable through subscribe(). Storage that is missing or blocked only means "not saved".
 */
export class PreferencesStore {
  private prefs: Preferences;
  private readonly listeners = new Set<Listener>();

  constructor(private readonly storage: StorageLike | null = browserStorage()) {
    this.prefs = this.load();
  }

  private load(): Preferences {
    try {
      const raw = this.storage?.getItem(STORAGE_KEYS.prefs);
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        return parsePreferences(typeof parsed === "object" && parsed !== null ? (parsed as { prefs?: unknown }).prefs : null);
      }
      // First run after the upgrade: carry over theme and sidebar state saved by the earlier settings page.
      const legacy = this.storage?.getItem(STORAGE_KEYS.ui);
      if (legacy) {
        const state = (JSON.parse(legacy) as { state?: unknown }).state;
        return parsePreferences(typeof state === "object" && state !== null ? state : null);
      }
    } catch {
      /* corrupt value: fall through to the defaults */
    }
    return { ...DEFAULT_PREFERENCES };
  }

  readonly get = (): Preferences => this.prefs;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Merges and validates; fields that are not valid keep their current value. */
  set(patch: Partial<Preferences>): void {
    this.replace(parsePreferences({ ...this.prefs, ...patch }));
  }

  replace(next: Preferences): void {
    this.prefs = next;
    try {
      this.storage?.setItem(STORAGE_KEYS.prefs, JSON.stringify({ version: PREFERENCES_VERSION, prefs: next }));
    } catch {
      /* not saved (quota or blocked), still applied for this session */
    }
    for (const listener of [...this.listeners]) listener();
  }

  reset(): void {
    this.replace({ ...DEFAULT_PREFERENCES });
  }

  /** Re-reads storage (another tab changed it, or the data was cleared). */
  reload(): void {
    this.prefs = this.load();
    for (const listener of [...this.listeners]) listener();
  }
}
