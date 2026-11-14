/**
 * Documentation pages are scraped from the web, so their text is UNTRUSTED: a page
 * could contain "ignore your instructions and ...". Two layers protect the model:
 *
 *  1. Structure (prompt.ts): every excerpt sits between unguessable markers and the
 *     system prompt says that text between them is data, never instructions.
 *  2. This file: invisible/control characters are removed, text that imitates the
 *     markers or chat-role tags is defused, and lines that read as instructions to an
 *     AI are removed (and counted, so the UI can say so).
 *
 * Neither layer can make a language model obey rules with certainty. This reduces the
 * risk; the tests check what we send, not what a real model would do.
 */

const REMOVED = "[line removed: it looked like an instruction to an AI and was not passed on]";

/** Patterns for lines that talk TO an AI instead of describing the API. English and Indonesian. */
const INSTRUCTION_PATTERNS: RegExp[] = [
  /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the|these|those)\b[^.\n]{0,40}\b(instructions?|prompts?|rules?|guidelines?|directions?|polic(y|ies))\b/i,
  /\b(abaikan|lupakan|kesampingkan)\b[^.\n]{0,40}\b(instruksi|perintah|aturan|petunjuk)\b/i,
  /\b(you are now|from now on,? you|your new (role|instructions?|task)|new instructions?\s*:)/i,
  /\b(sekarang kamu adalah|mulai sekarang kamu|instruksi baru\s*:)/i,
  /\b(reveal|print|show|output|repeat|leak|disclose|send)\b[^.\n]{0,40}\b(system prompt|your instructions|hidden instructions|api[- ]?keys?|secret keys?|access tokens?|password)\b/i,
  /\b(tampilkan|ungkapkan|bocorkan|kirim)\b[^.\n]{0,40}\b(system prompt|instruksi (kamu|anda)|api[- ]?key|kunci rahasia|token|kata sandi)\b/i,
  /\b(do not|don't|never)\b[^.\n]{0,30}\b(tell|mention|cite|reveal|inform)\b[^.\n]{0,30}\b(the )?(user|human|anyone)\b/i,
  /\b(always|must)\b[^.\n]{0,20}\b(answer|respond|reply|say|output)\b[^.\n]{0,20}\b(with|that|only)\b/i,
  /\b(assistant|ai|model|chatbot|llm)\b[^.\n]{0,25}\b(must|should|shall|will now|has to)\b[^.\n]{0,40}\b(ignore|obey|follow|reply|respond|say|output|call|run|execute|send)\b/i,
  /(<\|?(im_start|im_end|system|assistant|user|endoftext)\|?>|\[\/?INST\]|<<\s*SYS\s*>>|^\s*(system|assistant)\s*:)/i,
  /\b(execute|run)\b[^.\n]{0,30}\b(this|the following)\b[^.\n]{0,20}\b(command|shell|code)\b[^.\n]{0,30}\b(on|in) (the )?(user|server|machine|computer)/i,
];

export interface Neutralized {
  text: string;
  /** Number of lines that were removed. */
  removed: number;
}

/** Zero-width, bidi-override and other invisible characters, and ASCII control characters (newline and tab stay). */
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;

/** A single-line field (title, heading, URL) for the excerpt header. */
export function cleanField(text: string, max = 200): string {
  const line = text.replace(INVISIBLE, "").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Text that imitates our markers: runs of < or > and the marker word are broken up so they cannot close a block. */
function defuseMarkers(line: string): string {
  return line.replace(/<{3,}/g, "‹‹‹").replace(/>{3,}/g, "›››").replace(/GTPS[_ -]?DOCS/gi, "GTPS-docs");
}

export function neutralizeUntrusted(text: string): Neutralized {
  let removed = 0;
  const lines = text
    .replace(INVISIBLE, "")
    .split("\n")
    .map((line) => {
      if (INSTRUCTION_PATTERNS.some((p) => p.test(line))) {
        removed += 1;
        return REMOVED;
      }
      return defuseMarkers(line);
    });
  return { text: lines.join("\n"), removed };
}

/** Would this text be changed by neutralizeUntrusted? (used by tests and by the retriever's statistics) */
export const looksLikeInstruction = (line: string): boolean => INSTRUCTION_PATTERNS.some((p) => p.test(line));
