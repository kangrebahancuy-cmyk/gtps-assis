import { Terminal } from "lucide-react";

import { APP_NAME } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface LogoProps {
  collapsed?: boolean;
  className?: string;
}

export function Logo({ collapsed = false, className }: LogoProps) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Terminal className="size-4" aria-hidden="true" />
      </div>
      {!collapsed && (
        <span className="truncate text-sm font-semibold tracking-tight">
          {APP_NAME}
        </span>
      )}
    </div>
  );
}
