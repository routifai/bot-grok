import { useState } from "react";
import { DeckViewer } from "../../features/decks/DeckViewer";
import { setDeckEditing, useDeckEditing } from "../../features/decks/deck-ui-state";
import sample from "../../features/decks/edit/sample-deck.txt?raw";

const NAME = "sample.deck.html";

/**
 * Dev-only route (`/dev/deck`, gated by `import.meta.env.DEV` in App.tsx): the deck viewer in the
 * artifact panel's width with the edit mode on offer, the engine replaced by a recorder
 * (`window.__deckEdits`), so selecting and editing can be driven in a real browser without a
 * session or engine.
 */
export function DeckPreviewPage() {
  const editing = useDeckEditing(NAME);
  const [version, setVersion] = useState(1);
  return (
    <div className="flex h-dvh justify-center bg-background p-2">
      <section className="flex min-h-0 w-[min(58vw,900px)] flex-col overflow-hidden rounded-[18px] border border-border bg-card">
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1 truncate text-[14px] font-medium">{NAME}</div>
          <button
            type="button"
            aria-pressed={editing}
            data-testid="dev-edit-toggle"
            className="rounded-full border border-border px-3 py-1 text-[13px]"
            onClick={() => setDeckEditing(NAME, !editing)}
          >
            Edit
          </button>
          <span data-testid="dev-version" className="text-[12px]">
            v{version}
          </span>
        </header>
        <div className="min-h-0 flex-1">
          <DeckViewer
            html={sample}
            title={NAME}
            artifact={{ id: `v${version}`, version }}
            editSource={async (input) => {
              const w = window as unknown as { __deckEdits?: unknown[] };
              w.__deckEdits = [...(w.__deckEdits ?? []), input];
              setVersion(input.baseVersion + 1);
              return { id: `v${input.baseVersion + 1}`, version: input.baseVersion + 1 };
            }}
          />
        </div>
      </section>
    </div>
  );
}
