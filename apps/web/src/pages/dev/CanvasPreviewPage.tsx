import { CanvasView } from "@nova/ui-web";
import { useEffect } from "react";
import { CREDIT_CARD_CANVAS_FIXTURE } from "./canvas-fixture";

/**
 * Dev-only route (`/dev/canvas`, gated by `import.meta.env.DEV` in App.tsx) for eyeballing
 * and screenshotting the Nova Canvas catalog without needing a signed-in session or a live
 * agent run. `?theme=light|dark` forces a theme for deterministic screenshots.
 */
export function CanvasPreviewPage() {
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark") {
      document.documentElement.dataset.theme = theme;
    }
  }, []);

  return (
    <div className="min-h-full bg-background px-4 py-10">
      <div className="mx-auto w-full max-w-[960px]">
        <div className="w-full rounded-[20px] bg-muted p-4 sm:p-6">
          <CanvasView tree={CREDIT_CARD_CANVAS_FIXTURE} />
        </div>
      </div>
    </div>
  );
}
