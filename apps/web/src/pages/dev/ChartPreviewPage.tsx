import { CHART_FIXTURES } from "@nova/charts";
import { useEffect } from "react";
import { ChartView } from "../../features/charts/ChartView";

/**
 * Dev-only route (`/dev/chart`, gated by `import.meta.env.DEV` in App.tsx): every chart type on
 * sample data, so the charts can be eyeballed and screenshotted without a session or engine.
 * `?theme=light|dark` forces a theme.
 */
export function ChartPreviewPage() {
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  }, []);
  return (
    <div className="min-h-dvh bg-background p-6 text-foreground">
      <div className="mx-auto grid max-w-[1200px] gap-5 md:grid-cols-2">
        {CHART_FIXTURES.map((fixture) => (
          <section
            key={fixture.id}
            data-testid={`chart-${fixture.id}`}
            className="rounded-[18px] border border-border bg-card p-5"
          >
            <ChartView
              document={{
                spec: fixture.spec,
                data: fixture.data,
                source: {
                  file: `${fixture.id}.csv`,
                  path: `${fixture.id}.csv`,
                  columns: Object.keys(fixture.data[0] ?? {}),
                  rows: fixture.data.length,
                  truncated: false,
                },
              }}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
