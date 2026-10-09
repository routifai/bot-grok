import { useEffect, useState } from "react";
import { SheetView } from "../../components/sheets/SheetView";
import { useSheetAsk, useSheetAskTarget } from "../../lib/sheet-ask";
import { createSheetFixtureSource } from "./sheet-fixture";

/**
 * Dev-only route (`/dev/sheet`, gated by `import.meta.env.DEV` in App.tsx): the sheet viewer on
 * an in-memory workbook, so it can be eyeballed and screenshotted without a session or engine.
 * `?theme=light|dark` forces a theme.
 */
export function SheetPreviewPage() {
  useSheetAskTarget();
  const ask = useSheetAsk();
  const [{ source, head }] = useState(createSheetFixtureSource);
  const [id, setId] = useState(head);
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  }, []);
  return (
    <div className="flex h-dvh justify-center bg-background p-2">
      <section className="flex min-h-0 w-[min(58vw,900px)] flex-col overflow-hidden rounded-[18px] border border-border bg-card">
        <header className="shrink-0 border-b border-border px-4 py-2.5 text-[14px] font-medium">
          q3-sales-clean.xlsx
        </header>
        <div className="min-h-0 flex-1">
          <SheetView
            artifact={{ id, name: "q3-sales-clean.xlsx", version: 1 }}
            onEdited={setId}
            source={source}
          />
        </div>
      </section>
      {ask ? (
        <div className="fixed start-4 bottom-4 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px]">
          {ask.label}
        </div>
      ) : null}
    </div>
  );
}
