import { cn } from "@nova/ui-web";
import { useEffect, useState } from "react";
import { artifactPanelWidth } from "../../features/artifacts/ArtifactPanel";
import { DeckHeaderActions } from "../../features/decks/DeckHeaderActions";
import { DeckViewer } from "../../features/decks/DeckViewer";
import { useDeckEditing } from "../../features/decks/deck-ui-state";
import sample from "../../features/decks/edit/sample-deck.txt?raw";

const NAME = "sample.deck.html";

type DevWindow = Window & {
  __deckEdits?: unknown[];
  /** Replaces the page's deck source (a test loads a deck the engine's kit built). */
  __deckSetHtml?: (html: string) => void;
  /** The engine's theme dictionary, when a test provides it. */
  __deckThemes?: () => Promise<{ themes: never[]; defaultTheme: string }>;
  /** The theme id the engine reads from a deck's source (null when hand-made). */
  __deckTheme?: (html: string) => Promise<string | null>;
  /** What the engine would answer to a `set-theme` patch: the restyled source. */
  __deckRestyle?: (html: string, theme: string) => Promise<string>;
};

/**
 * Dev-only route (`/dev/deck`, gated by `import.meta.env.DEV` in App.tsx): the deck viewer in the
 * artifact panel's width with the panel's real header buttons, the engine replaced by a recorder
 * (`window.__deckEdits`), so selecting, editing and switching themes can be driven in a real
 * browser without a session or engine. A test may hand it a kit-built deck, the theme dictionary
 * and a restyle function (`window.__deckSetHtml`, `__deckThemes`, `__deckRestyle`).
 */
export function DeckPreviewPage() {
  const editing = useDeckEditing(NAME);
  const [version, setVersion] = useState(1);
  const [html, setHtml] = useState(sample);
  useEffect(() => {
    const dev = window as DevWindow;
    dev.__deckSetHtml = (next) => {
      setHtml(next);
      setVersion(1);
    };
    return () => {
      dev.__deckSetHtml = undefined;
    };
  }, []);
  return (
    <div className="flex h-dvh justify-center bg-background p-2">
      <section
        data-testid="dev-panel"
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-[18px] border border-border bg-card motion-safe:transition-[width] motion-safe:duration-300 motion-safe:ease-out",
          artifactPanelWidth({ wide: true, expanded: editing }),
        )}
      >
        <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
          <div className="min-w-0 flex-1 truncate text-[14px] font-medium">{NAME}</div>
          <DeckHeaderActions
            deckKey={NAME}
            state={{ kind: "idle" }}
            onExport={() => undefined}
            onCancel={() => undefined}
            source={undefined}
          />
          <span data-testid="dev-version" className="text-[12px]">
            v{version}
          </span>
        </header>
        <div className="min-h-0 flex-1">
          <DeckViewer
            html={html}
            title={NAME}
            artifact={{ id: `v${version}`, version }}
            themesSource={async () => {
              const dev = window as DevWindow;
              if (dev.__deckThemes) return dev.__deckThemes();
              return { themes: [], defaultTheme: "" };
            }}
            themeSource={async () => {
              const dev = window as DevWindow;
              return dev.__deckTheme ? dev.__deckTheme(html) : null;
            }}
            editSource={async (input) => {
              const dev = window as DevWindow;
              dev.__deckEdits = [...(dev.__deckEdits ?? []), input];
              const theme = input.patches.find((patch) => patch.kind === "set-theme");
              if (theme?.kind === "set-theme" && dev.__deckRestyle) {
                setHtml(await dev.__deckRestyle(html, theme.theme));
              }
              const full = input.patches.find((patch) => patch.kind === "set-full-source");
              if (full?.kind === "set-full-source") setHtml(full.source);
              setVersion(input.baseVersion + 1);
              return { id: `v${input.baseVersion + 1}`, version: input.baseVersion + 1 };
            }}
          />
        </div>
      </section>
    </div>
  );
}
