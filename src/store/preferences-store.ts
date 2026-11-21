"use client";

import { useSyncExternalStore } from "react";

import { DEFAULT_PREFERENCES, type Preferences } from "@/lib/preferences";
import { PreferencesStore } from "@/lib/preferences-store";
import { STORAGE_KEYS } from "@/services/storage";

export { PreferencesStore } from "@/lib/preferences-store";

let shared: PreferencesStore | null = null;

/** The app-wide store. Created on first use; never persists on the server. */
export function preferencesStore(): PreferencesStore {
  if (!shared) {
    shared = new PreferencesStore();
    if (typeof window !== "undefined") {
      window.addEventListener("storage", (event) => {
        if (event.key === STORAGE_KEYS.prefs || event.key === null) shared?.reload();
      });
    }
  }
  return shared;
}

/** Test hook: forget the shared store so the next use re-reads storage. */
export function resetSharedPreferencesStore(): void {
  shared = null;
}

const serverSnapshot = (): Preferences => DEFAULT_PREFERENCES as Preferences;

export function usePreferences(): Preferences {
  const store = preferencesStore();
  return useSyncExternalStore(store.subscribe, store.get, serverSnapshot);
}

export function setPreferences(patch: Partial<Preferences>): void {
  preferencesStore().set(patch);
}
