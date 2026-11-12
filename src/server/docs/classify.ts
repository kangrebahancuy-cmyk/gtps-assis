/** Pure classification of API entries. No database or HTML dependency. */

import type { ApiKind } from "@/types/docs";

export type { ApiKind };

export const API_KINDS: readonly ApiKind[] = ["function", "method", "callback", "event"];

/** Splits "Player:getName" / "os.time" into owner and member. */
export function splitApiName(name: string): { owner: string | null; member: string } {
  const index = name.search(/[:.]/);
  if (index === -1) return { owner: null, member: name };
  return { owner: name.slice(0, index), member: name.slice(index + 1) };
}

/**
 * - callback: names ending in "Callback" (onPlayerChatCallback)
 * - event:    members of a class named "...Event", or a bare on* handler
 * - method:   Class:method on a capitalised class
 * - function: global functions and members of lowercase libraries (os.time)
 */
export function classifyApiEntry(name: string): ApiKind {
  if (/Callback$/.test(name)) return "callback";
  const { owner } = splitApiName(name);
  if (owner === null) return /^on[A-Z]/.test(name) ? "event" : "function";
  if (/Event$/.test(owner)) return "event";
  return /^[a-z]/.test(owner) ? "function" : "method";
}
