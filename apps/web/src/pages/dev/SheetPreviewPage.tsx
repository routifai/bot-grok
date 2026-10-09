import type { ThreadMessage } from "@nova/contracts";
import { useEffect, useState } from "react";
import { SheetAskChip } from "../../features/sheets/SheetAskChip";
import { SheetView } from "../../features/sheets/SheetView";
import {
  setSheetAsk,
  useSheetAsk,
  useSheetAskTarget,
  withSheetAsk,
} from "../../features/sheets/sheet-ask";
import { MessageView } from "../muse/conversation/MessageView";
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
  const [sent, setSent] = useState<ThreadMessage[]>([]);
  const [toolbarHost, setToolbarHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const theme = new URLSearchParams(window.location.search).get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  }, []);
  return (
    <div className="flex h-dvh justify-center bg-background p-2">
      <section className="flex min-h-0 w-[min(58vw,900px)] flex-col overflow-hidden rounded-[18px] border border-border bg-card">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1 truncate text-[14px] font-medium">q3-sales-clean.xlsx</div>
          <div ref={setToolbarHost} className="contents" />
        </header>
        <div className="min-h-0 flex-1">
          <SheetView
            artifact={{ id, name: "q3-sales-clean.xlsx", version: 1 }}
            onEdited={setId}
            source={source}
            toolbarHost={toolbarHost}
          />
        </div>
      </section>
      <aside className="fixed start-3 bottom-3 flex w-[270px] flex-col items-end gap-2">
        {sent.map((message) => (
          <MessageView
            key={message.id}
            museMode
            artifactTarget={{ botId: "dev" }}
            canAnswer={false}
            message={message}
            onAnswer={async () => undefined}
            onOpenBot={() => undefined}
            onOpenPeerMessages={() => undefined}
            peerBot={() => undefined}
            onRefresh={async () => undefined}
            onBotChanged={async () => undefined}
            onAddRoutine={() => undefined}
            voiceReady={false}
            speaking={false}
            onSpeak={() => undefined}
            onOpenComputer={() => undefined}
          />
        ))}
        {ask ? <SheetAskChip label={ask.label} /> : null}
        <button
          type="button"
          className="rounded-full border border-border bg-card px-3 py-1.5 text-[13px]"
          onClick={() => {
            const text = withSheetAsk("What is the trend in these revenue numbers?", ask);
            setSheetAsk(null);
            setSent((all) => [
              ...all,
              {
                id: `u${all.length}`,
                threadId: "dev",
                seq: all.length,
                role: "user",
                blocks: [{ kind: "text", text }],
                createdAt: new Date().toISOString(),
              },
            ]);
          }}
        >
          Send (dev)
        </button>
      </aside>
    </div>
  );
}
