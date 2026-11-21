import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_PREFERENCES, EDITOR_FONT_MAX, EDITOR_FONT_MIN, clampEditorFont, parsePreferences, resolveEditorTheme } from "@/lib/preferences";
import { PreferencesStore } from "@/lib/preferences-store";
import { STORAGE_KEYS } from "@/services/storage";

class MemoryStorage {
  data = new Map<string, string>();
  throwOnWrite = false;
  getItem = (k: string) => this.data.get(k) ?? null;
  setItem = (k: string, v: string) => {
    if (this.throwOnWrite) throw new Error("quota");
    this.data.set(k, v);
  };
  removeItem = (k: string) => void this.data.delete(k);
}

describe("parsePreferences", () => {
  it("returns the defaults for anything that is not an object", () => {
    for (const bad of [null, undefined, "x", 3, [], true]) assert.deepEqual(parsePreferences(bad), DEFAULT_PREFERENCES);
  });
  it("keeps valid values and replaces each invalid one with its default", () => {
    const p = parsePreferences({ theme: "light", uiFontSize: "huge", sidebarCollapsed: "yes", editorTheme: "high-contrast", editorFontSize: 99, renderMarkdown: false, wrapCode: true, evil: "<script>", __proto__: { x: 1 } });
    assert.equal(p.theme, "light");
    assert.equal(p.uiFontSize, "medium");
    assert.equal(p.sidebarCollapsed, false);
    assert.equal(p.editorTheme, "high-contrast");
    assert.equal(p.editorFontSize, 13);
    assert.equal(p.renderMarkdown, false);
    assert.equal(p.wrapCode, true);
    assert.equal("evil" in p, false);
  });
  it("accepts the editor font size limits and nothing outside them", () => {
    assert.equal(parsePreferences({ editorFontSize: EDITOR_FONT_MIN }).editorFontSize, EDITOR_FONT_MIN);
    assert.equal(parsePreferences({ editorFontSize: EDITOR_FONT_MAX }).editorFontSize, EDITOR_FONT_MAX);
    for (const bad of [EDITOR_FONT_MIN - 1, EDITOR_FONT_MAX + 1, 12.5, NaN, "14"]) assert.equal(parsePreferences({ editorFontSize: bad }).editorFontSize, 13);
  });
  it("auto editor theme follows the app theme; an explicit one wins", () => {
    assert.equal(resolveEditorTheme("auto", "light"), "light");
    assert.equal(resolveEditorTheme("auto", "dark"), "dark");
    assert.equal(resolveEditorTheme("high-contrast", "light"), "high-contrast");
    assert.equal(clampEditorFont(3), EDITOR_FONT_MIN);
    assert.equal(clampEditorFont(300), EDITOR_FONT_MAX);
  });
});

describe("PreferencesStore", () => {
  it("starts with defaults, saves every change and a new store reads it back", () => {
    const storage = new MemoryStorage();
    const a = new PreferencesStore(storage);
    assert.deepEqual(a.get(), DEFAULT_PREFERENCES);
    a.set({ theme: "light", editorFontSize: 18, wrapCode: true });
    const b = new PreferencesStore(storage);
    assert.equal(b.get().theme, "light");
    assert.equal(b.get().editorFontSize, 18);
    assert.equal(b.get().wrapCode, true);
    assert.equal(b.get().sidebarHistory, true, "untouched fields keep their defaults");
  });
  it("notifies subscribers once per change and keeps a stable snapshot between changes", () => {
    const store = new PreferencesStore(new MemoryStorage());
    let calls = 0;
    const off = store.subscribe(() => calls++);
    const before = store.get();
    assert.equal(store.get(), before);
    store.set({ theme: "light" });
    assert.equal(calls, 1);
    assert.notEqual(store.get(), before);
    off();
    store.set({ theme: "dark" });
    assert.equal(calls, 1);
  });
  it("ignores invalid values in set()", () => {
    const store = new PreferencesStore(new MemoryStorage());
    store.set({ editorFontSize: 500 as number, theme: "purple" as never });
    assert.equal(store.get().editorFontSize, 13);
    assert.equal(store.get().theme, "dark");
  });
  it("migrates the theme and sidebar state saved by the earlier settings page", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.ui, JSON.stringify({ state: { theme: "light", sidebarCollapsed: true }, version: 0 }));
    const store = new PreferencesStore(storage);
    assert.equal(store.get().theme, "light");
    assert.equal(store.get().sidebarCollapsed, true);
  });
  it("a corrupt stored value falls back to the defaults instead of crashing", () => {
    const storage = new MemoryStorage();
    storage.setItem(STORAGE_KEYS.prefs, "{not json");
    assert.deepEqual(new PreferencesStore(storage).get(), DEFAULT_PREFERENCES);
  });
  it("a failing storage still applies the change for this session", () => {
    const storage = new MemoryStorage();
    storage.throwOnWrite = true;
    const store = new PreferencesStore(storage);
    store.set({ theme: "light" });
    assert.equal(store.get().theme, "light");
    assert.equal(new PreferencesStore(storage).get().theme, "dark");
  });
  it("works with no storage at all, and reset() restores the defaults", () => {
    const store = new PreferencesStore(null);
    store.set({ uiFontSize: "large" });
    assert.equal(store.get().uiFontSize, "large");
    store.reset();
    assert.deepEqual(store.get(), DEFAULT_PREFERENCES);
  });
  it("reload() picks up a change made elsewhere (another tab)", () => {
    const storage = new MemoryStorage();
    const a = new PreferencesStore(storage);
    new PreferencesStore(storage).set({ theme: "light" });
    assert.equal(a.get().theme, "dark");
    a.reload();
    assert.equal(a.get().theme, "light");
  });
});
