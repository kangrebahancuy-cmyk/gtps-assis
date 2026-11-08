interface CodePreviewProps {
  content: string;
}

/** Read-only, line-numbered view of the active file. */
export function CodePreview({ content }: CodePreviewProps) {
  const lines = content.split("\n");

  return (
    <div className="h-full overflow-auto bg-secondary/30 scrollbar-thin">
      <pre className="p-4 font-mono text-[13px] leading-relaxed">
        <code>
          {lines.map((line, index) => (
            <div key={index} className="flex">
              <span
                aria-hidden="true"
                className="mr-4 w-8 shrink-0 select-none text-right text-muted-foreground"
              >
                {index + 1}
              </span>
              <span className="whitespace-pre-wrap break-all">{line || " "}</span>
            </div>
          ))}
        </code>
      </pre>
    </div>
  );
}
