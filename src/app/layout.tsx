import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { APP_NAME, APP_TAGLINE } from "@/lib/constants";
import { STORAGE_KEYS } from "@/services/storage";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: APP_NAME, template: `%s · ${APP_NAME}` },
  description: APP_TAGLINE,
};

export const viewport: Viewport = {
  themeColor: "#0f0f11",
  colorScheme: "dark light",
};

/**
 * Runs before first paint: applies the saved theme (dark by default) so the
 * page does not flash the wrong colors. Static string, no user input.
 */
const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var raw=localStorage.getItem(${JSON.stringify(
  STORAGE_KEYS.ui,
)});var theme=raw?(JSON.parse(raw).state||{}).theme:null;d.classList.toggle('dark',theme!=='light');}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
