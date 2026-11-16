import type { Metadata } from "next";

import { ChatView } from "@/features/chat/chat-view";

export const metadata: Metadata = { title: "Script Generator" };

export default function GeneratorPage() {
  return <ChatView mode="generate" />;
}
