/**
 * Three different things the workspace can tell you about a script. They are kept apart on purpose:
 *
 *  1. SYNTAX (local, instant)       - is it well-formed Lua? Done here with the built-in parser.
 *  2. DOCUMENTATION (server lookup) - do the GTPS functions it calls appear in the indexed docs? (/api/lua/check)
 *  3. GTPS RUNTIME                  - does it work on a real GTPS server? NEVER checked: scripts are not executed here.
 *
 * Passing 1 or 2 never means the script works in GTPS.
 */
import { parseLua } from "@/lib/lua/parser";

export interface SyntaxProblem {
  line: number;
  column: number;
  message: string;
  severity: "error";
}

export interface SyntaxReport {
  /** True when no syntax error was found. NOT "the script works". */
  clean: boolean;
  problems: SyntaxProblem[];
  lines: number;
}

export const SYNTAX_SCOPE_TITLE = "Syntax check only";
export const SYNTAX_SCOPE =
  "Checks that the code is well-formed Lua. It does not run the script, does not check that GTPS functions exist or are used correctly, and is not GTPS runtime validation.";
export const DOCS_SCOPE =
  "Compares the GTPS functions the script calls with the indexed documentation. It reads the code; it never runs it.";
export const RUNTIME_SCOPE =
  "GTPS runtime: not validated. Scripts are never executed here, so only a test on your own GTPS server can show that a script works.";

/** Basic syntax check of Lua source (Lua 5.1-5.4 grammar). Reports the first error, like the real compiler. */
export function checkSyntax(source: string): SyntaxReport {
  const lines = source === "" ? 0 : source.split("\n").length;
  const result = parseLua(source);
  if (result.ok) return { clean: true, problems: [], lines };
  const { message, line, column } = result.error;
  return { clean: false, problems: [{ line, column, message, severity: "error" }], lines };
}

/** One-line status for the status bar. Never says the script is "valid" or "working". */
export function syntaxSummary(report: SyntaxReport): string {
  if (report.clean) return "No syntax errors found (syntax only)";
  const [first] = report.problems;
  return first ? `Syntax error at line ${first.line}: ${first.message}` : "Syntax error";
}
