import { DASHBOARD_FIXTURE } from "@nova/charts";
import { useEffect } from "react";
import { DashboardView } from "../../features/charts/DashboardView";

/**
 * Dev-only route (`/dev/dashboard`, gated by `import.meta.env.DEV` in App.tsx): the sample
 * dashboard as the chat shows it (`?width=` sets the column, default 720) and as the panel does
 * (`?size=panel`). `?theme=light|dark` forces a theme.
 */
export function DashboardPreviewPage() {
  const params = new URLSearchParams(window.location.search);
  const size = params.get("size") === "panel" ? "panel" : "card";
  const width = Number(params.get("width")) || (size === "panel" ? 1100 : 720);
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  }, []);
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <div className="mx-auto" style={{ maxWidth: width }}>
        {size === "card" ? (
          <article className="rounded-2xl border border-border bg-card p-5">
            <DashboardView document={DASHBOARD_FIXTURE} size="card" />
          </article>
        ) : (
          <DashboardView document={DASHBOARD_FIXTURE} size="panel" />
        )}
      </div>
    </div>
  );
}
