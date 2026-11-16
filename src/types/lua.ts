/**
 * Types for the Lua script generator. Shared by the server (verification, generation flow) and the
 * browser (report panel, script actions). Everything is computed from the script and the indexed
 * documentation; nothing here is a model's claim.
 */

export type ApiUseStatus =
  /** Found in the indexed documentation. */
  | "documented"
  /** Not found in the documentation (and not Lua, and not defined by the script). */
  | "undocumented"
  /** Part of standard Lua: not a GTPS API. */
  | "lua_standard"
  /** Cannot be resolved statically (a `.` call on a value of unknown type). */
  | "unresolved";

export type FindingKind =
  | "syntax"
  | "incomplete"
  | "undocumented_api"
  | "wrong_arguments"
  | "unknown_event"
  | "callback_signature"
  | "lua_standard"
  | "restricted_lua"
  | "unverified_call"
  | "removed_feature"
  | "changed_feature"
  | "preservation_skipped";

export type FindingSeverity = "error" | "warning" | "info";

export interface Finding {
  kind: FindingKind;
  severity: FindingSeverity;
  message: string;
  line: number | null;
  name: string | null;
}

export interface ApiUse {
  /** The name as the script uses it, e.g. "player:getName" or "onPlayerChatCallback". */
  name: string;
  status: ApiUseStatus;
  /** The documented entry it was matched to (e.g. "Player:getName"), when documented. */
  documentedAs: string | null;
  signature: string | null;
  kind: "function" | "method" | "callback" | "event" | null;
  /** Page that documents it. */
  source: { documentId: number; title: string; url: string } | null;
  /** Lines where the script uses it. */
  lines: number[];
  /** A similarly named documented entry, when the name is undocumented (e.g. a case mismatch). */
  suggestion: string | null;
}

export interface Preservation {
  /** Top-level parts of the original script that are identical in the new one. */
  preserved: string[];
  /** Parts that exist in both but whose code changed. */
  modified: string[];
  /** Parts of the original that are missing from the new script. */
  removed: string[];
  /** Parts that are new. */
  added: string[];
}

export type SyntaxStatus =
  | { ok: true }
  | { ok: false; message: string; line: number; column: number };

export interface ScriptCheck {
  syntax: SyntaxStatus;
  stats: { lines: number; functions: number; calls: number; units: number };
  apiUses: ApiUse[];
  findings: Finding[];
  /** Present when the script was checked against an original (modification workflow). */
  preservation: Preservation | null;
  /** No syntax error, no placeholders, no error-level finding. */
  passed: boolean;
}

/** What the generator found out about the request before writing code. */
export interface GenerationAnalysis {
  /** Feature keys matched in the request, e.g. "daily_reward". */
  features: string[];
  /** Labels of the matched features, for display. */
  featureLabels: string[];
  /** Whether the request modifies an existing script. */
  modifying: boolean;
  /** Documentation topics searched, with how many sections each one found. */
  topics: { label: string; query: string; found: number }[];
  /** Topics for which the documentation had nothing. */
  missingTopics: string[];
  /** Documented API names found for the request (events, callbacks, functions, methods). */
  requiredApis: string[];
}
