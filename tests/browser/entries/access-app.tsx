import { createRoot } from "react-dom/client";

import { AccessBanner } from "@/components/layout/access-banner";

createRoot(document.getElementById("root")!).render(
  <div>
    <AccessBanner />
    <main data-testid="page">content</main>
  </div>,
);
