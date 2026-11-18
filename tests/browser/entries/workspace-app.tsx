import { createRoot } from "react-dom/client";

import { ChatProvider } from "@/features/chat/chat-provider";
import { WorkspaceProvider } from "@/features/workspace/workspace-provider";
import { WorkspaceView } from "@/features/workspace/workspace-view";

const params = new URLSearchParams(location.search);
const engine = params.get("engine") === "basic" ? "basic" : "auto";
const timeout = Number(params.get("timeout") ?? "") || undefined;

createRoot(document.getElementById("root")!).render(
  <ChatProvider>
    <WorkspaceProvider>
      <div style={{ height: "720px", width: "1100px" }}>
        <WorkspaceView engine={engine} loadTimeoutMs={timeout} />
      </div>
    </WorkspaceProvider>
  </ChatProvider>,
);
