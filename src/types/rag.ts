/**
 * Types shared by the retrieval pipeline (server) and the chat UI (browser).
 * Everything here describes what really happened for one question: nothing is estimated for display.
 */

import type { GenerationAnalysis } from "@/types/lua";

export type IntentKind = "smalltalk" | "api_lookup" | "code_example" | "modify_script" | "how_to" | "general";

/**
 * used:        sections were retrieved and sent to the model.
 * none_found:  the index was searched but nothing relevant was found.
 * skipped:     the question did not need the documentation (greeting, thanks...).
 * unavailable: the documentation index is empty (no synchronization has run yet).
 * error:       the search itself failed; the chat continued without documentation.
 */
export type RetrievalStatus = "used" | "none_found" | "skipped" | "unavailable" | "error";

export type SourceKind = "section" | "api" | "code";

/** One piece of documentation that was sent to the model, numbered as the model sees it. */
export interface Citation {
  /** The number the model is told to cite as [n]. */
  n: number;
  documentId: number;
  title: string;
  /** Section heading, API name or code-example context. */
  section: string | null;
  /** Heading id inside the page (matches the documentation viewer), when known. */
  anchor: string | null;
  /** Original page URL on the documentation site. */
  url: string;
  kind: SourceKind;
  /** The start of the text that was sent, so the reader can see what the answer was based on. */
  excerpt: string;
  /** The text was shortened to fit the context budget. */
  truncated: boolean;
}

/** A function mentioned in the question or the user's script, checked against the indexed API entries. */
export interface IdentifierCheck {
  name: string;
  documented: boolean;
  /** Citation numbers whose text documents it. */
  sources: number[];
}

export interface DocConflict {
  name: string;
  /** Citation numbers whose texts disagree. */
  sources: number[];
  note: string;
}

export interface RetrievalInfo {
  status: RetrievalStatus;
  /** Plain explanation when the status is not "used". */
  reason: string | null;
  intent: IntentKind;
  /** The search terms that were used (after stop-word removal). */
  terms: string[];
  /** Chunks that matched before filtering. */
  candidates: number;
  /** Distinct documents among the sections sent to the model. */
  documentsRetrieved: number;
  /** Sections/API entries/code examples sent to the model (= citations.length). */
  sectionsSent: number;
  /** Rough size of the documentation text sent, in tokens (characters / 3.6). */
  tokensEstimate: number;
  /** Lines of documentation text that looked like instructions to an AI and were removed. */
  removedInstructionLines: number;
  citations: Citation[];
  identifiers: IdentifierCheck[];
  conflicts: DocConflict[];
  /** Indexed state at the time of the question. */
  index: { documents: number; chunks: number; lastSyncAt: string | null };
  /** Present for script generation requests: what was analysed and searched before the model was called. */
  generation?: GenerationAnalysis;
}

/** What the chat header shows when no question has been asked yet. */
export interface DocsContextStatus {
  available: boolean;
  documents: number;
  chunks: number;
  lastSyncAt: string | null;
}
