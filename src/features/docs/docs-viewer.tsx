import { FileText } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { MarkdownRenderer } from "@/features/chat/markdown-renderer";
import type { DocPage } from "@/types";

interface DocsViewerProps {
  page: DocPage | null;
}

export function DocsViewer({ page }: DocsViewerProps) {
  if (!page) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-6 text-center">
        <FileText className="mb-3 size-8 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-base font-medium">No document selected</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Choose a page from the list to preview the viewer layout.
        </p>
      </div>
    );
  }

  return (
    <article className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-8">
      {page.sourceUrl ? (
        <p className="mb-4 break-all text-xs text-muted-foreground">
          Source:{" "}
          <a
            href={page.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {page.sourceUrl}
          </a>
        </p>
      ) : (
        <Badge variant="muted" className="mb-4">
          Layout sample, not real documentation. Run the scraper to load GTPS Cloud docs.
        </Badge>
      )}
      <MarkdownRenderer source={page.body} />
    </article>
  );
}
