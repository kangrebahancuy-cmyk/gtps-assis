"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { SETTINGS_SECTIONS } from "@/lib/constants";
import { cn } from "@/lib/utils";

export function SettingsNav() {
  const pathname = usePathname();

  return (
    <nav aria-label="Settings sections" className="p-2 md:p-4">
      <ul className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
        {SETTINGS_SECTIONS.map((section) => {
          const href = `/settings/${section.id}`;
          const active = pathname === href;
          return (
            <li key={section.id} className="shrink-0">
              <Link
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
                  active && "bg-accent font-medium text-accent-foreground",
                )}
              >
                {section.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
