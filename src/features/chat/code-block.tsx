"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { isLua, tokenizeLua, type LuaTokenType } from "@/lib/lua-highlight";

const TOKEN_CLASS: Record<LuaTokenType, string> = {
  keyword: "text-purple-600 dark:text-purple-400",
  constant: "text-orange-600 dark:text-orange-400",
  string: "text-green-700 dark:text-green-400",
  comment: "italic text-muted-foreground",
  number: "text-orange-600 dark:text-orange-400",
  function: "text-blue-600 dark:text-blue-400",
  builtin: "text-cyan-700 dark:text-cyan-400",
  plain: "",
};

/** Code text with Lua syntax highlighting when the language is Lua; plain text otherwise. */
export function HighlightedCode({ code, language }: { code: string; language?: string | null }) {
  const tokens = useMemo(() => (isLua(language) ? tokenizeLua(code) : null), [code, language]);
  if (!tokens) return <code>{code}</code>;
  return (
    <code>
      {tokens.map((token, index) =>
        token.type === "plain" ? (
          token.text
        ) : (
          <span key={index} className={TOKEN_CLASS[token.type]} data-token={token.type}>
            {token.text}
          </span>
        ),
      )}
    </code>
  );
}

interface CodeBlockProps {
  code: string;
  language?: string;
}

export function CodeBlock({ code, language }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="my-3 overflow-hidden rounded-lg border border-border bg-secondary/40">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
        <span className="font-mono text-xs text-muted-foreground">{language || "text"}</span>
        <Button variant="ghost" size="sm" onClick={handleCopy} aria-label="Copy code">
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto p-3 font-mono text-[13px] leading-relaxed scrollbar-thin">
        <HighlightedCode code={code} language={language} />
      </pre>
    </div>
  );
}
