import type { ChatMessage } from "@/types/ai";
import type { StoredMessage } from "@/lib/chat/types";

/** What is sent to the provider: a short system prompt plus as much recent history as the backend accepts. */

export const SYSTEM_PROMPT =
  "You are GTPS Assistant, a helpful assistant for Growtopia Private Server (GTPS) Lua scripting. " +
  "Answer clearly and concisely and format replies with Markdown. Put code in fenced blocks labelled with the language (use ```lua for Lua). " +
  "You do not have access to the GTPS Cloud documentation in this conversation: if you are not sure an API function exists or how it behaves, say so instead of guessing.";

// Mirror the backend limits (src/server/ai/validate.ts) with a safety margin.
export const MAX_CONTEXT_MESSAGES = 99; // plus the system prompt = 100
export const MAX_CONTEXT_MESSAGE_CHARS = 100_000;
export const MAX_CONTEXT_TOTAL_CHARS = 390_000;
const TRUNCATION_NOTE = "\n\n[…earlier part of this message was cut to fit the size limit]";

/**
 * Turns the stored conversation into a provider request:
 *  - failed, empty and still-streaming replies are left out;
 *  - consecutive messages of one role are merged (some providers require alternation);
 *  - oversized messages are shortened, and the oldest messages are dropped until the whole thing fits;
 *  - the history always starts with a user message.
 */
export function buildContext(messages: readonly StoredMessage[], systemPrompt: string = SYSTEM_PROMPT): ChatMessage[] {
  const usable = messages.filter((m) => m.content.trim() !== "" && (m.status === "complete" || m.status === "stopped" || m.status === "interrupted" || m.role === "user"));

  const merged: ChatMessage[] = [];
  for (const m of usable) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  for (const m of merged) {
    if (m.content.length > MAX_CONTEXT_MESSAGE_CHARS) {
      // Keep the end: the latest text matters most.
      m.content = `${TRUNCATION_NOTE.trimStart()}${m.content.slice(m.content.length - (MAX_CONTEXT_MESSAGE_CHARS - TRUNCATION_NOTE.length))}`;
    }
  }

  let total = systemPrompt.length + merged.reduce((n, m) => n + m.content.length, 0);
  while (merged.length > 1 && (merged.length > MAX_CONTEXT_MESSAGES || total > MAX_CONTEXT_TOTAL_CHARS)) {
    total -= merged.shift()?.content.length ?? 0;
  }
  while (merged.length > 1 && merged[0]?.role !== "user") merged.shift();

  return [{ role: "system", content: systemPrompt }, ...merged];
}

/** A short title from the first line of the first user message. */
export function deriveTitle(text: string, max = 48): string {
  const line = text.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const clean = line.replace(/^#+\s*/, "").replace(/[`*_>]/g, "").replace(/\s+/g, " ").trim();
  if (clean === "") return "New chat";
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`;
}
