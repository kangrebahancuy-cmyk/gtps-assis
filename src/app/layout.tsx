import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { ChatProvider } from "@/features/chat/chat-provider";
import { WorkspaceProvider } from "@/features/workspace/workspace-provider";
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
const THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement;var read=function(k){try{return JSON.parse(localStorage.getItem(k)||"null")}catch(e){return null}};var p=read(${JSON.stringify(
  STORAGE_KEYS.prefs,
)});p=p&&p.prefs;if(!p){var u=read(${JSON.stringify(STORAGE_KEYS.ui)});p=u&&u.state}p=p||{};d.classList.toggle('dark',p.theme!=='light');var px={small:14,large:18}[p.uiFontSize];if(px)d.style.fontSize=px+'px';}catch(e){document.documentElement.classList.add('dark');}})();`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body className="font-sans">
        <ChatProvider>
          <WorkspaceProvider>
            <AppShell>{children}</AppShell>
          </WorkspaceProvider>
        </ChatProvider>
      </body>
    </html>
  );
}
