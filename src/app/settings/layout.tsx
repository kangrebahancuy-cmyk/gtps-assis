import type { ReactNode } from "react";

import { SettingsNav } from "@/features/settings/settings-nav";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col md:flex-row">
      <aside className="shrink-0 border-b border-border md:w-56 md:border-b-0">
        <SettingsNav />
      </aside>
      <div className="min-w-0 flex-1 px-4 py-6 sm:px-6 md:py-8">{children}</div>
    </div>
  );
}
