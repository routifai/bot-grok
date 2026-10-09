import { useLingui } from "@lingui/react/macro";
import type { Artifact, DeckPatch, DeckTheme } from "@nova/contracts";
import { Button, cn } from "@nova/ui-web";
import { Check, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { rpc } from "../../lib/rpc";
import { readDeckThemeName } from "./deck-model";
import { setDeckThemeOpen } from "./deck-ui-state";
import type { DeckEditSource } from "./edit/useDeckEditor";

export type DeckThemesSource = () => Promise<{ themes: DeckTheme[]; defaultTheme: string }>;

const defaultThemes: DeckThemesSource = () => rpc.decks.themes({});
const defaultEdit: DeckEditSource = (input) => rpc.decks.edit(input);

/** The data-attribute the header's Theme button carries, so a click on it is not an "outside"
 * click (it toggles the gallery itself). */
export const THEME_BUTTON_ATTR = "data-deck-theme-button";

const CATEGORY_ORDER = ["professional", "editorial", "bold", "dark"] as const;

/** One fetch of the dictionary per page load: the thumbnails are a few hundred KB. */
let cache: Promise<{ themes: DeckTheme[]; defaultTheme: string }> | null = null;
function loadThemes(source: DeckThemesSource) {
  cache ??= source().catch((error: unknown) => {
    cache = null;
    throw error;
  });
  return cache;
}
/** Test helper. */
export const resetDeckThemeCache = (): void => {
  cache = null;
};

/**
 * The deck panel's Theme gallery: every theme with its thumbnail, name and mood, the current one
 * marked. Picking one swaps the deck's theme through a `set-theme` source patch (the engine
 * rewrites the theme tokens, CSS and fonts; the slides are not touched), which saves a new
 * `manual` version Nova is told about like any hand edit. The last switch can be undone here by
 * putting the earlier source back as a newer version.
 */
export function DeckThemePicker({
  deckKey,
  html,
  artifact,
  onEdited,
  themesSource = defaultThemes,
  editSource = defaultEdit,
}: {
  deckKey: string;
  html: string;
  artifact: { id: string; version: number };
  onEdited?: (artifactId: string) => void;
  themesSource?: DeckThemesSource;
  editSource?: DeckEditSource;
}) {
  const { t } = useLingui();
  const [themes, setThemes] = useState<DeckTheme[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<{ html: string; name: string; version: number } | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setDeckThemeOpen(deckKey, false), [deckKey]);

  useEffect(() => {
    let live = true;
    loadThemes(themesSource).then(
      (found) => live && setThemes(found.themes),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [themesSource]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const onDown = (event: PointerEvent) => {
      const target = event.target as Element | null;
      if (root.current?.contains(target) || target?.closest?.(`[${THEME_BUTTON_ATTR}]`)) return;
      close();
    };
    // A click inside the slide frame never reaches the page; the window loses focus instead.
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("blur", close);
    };
  }, [close]);

  const currentName = useMemo(() => readDeckThemeName(html), [html]);
  const current = themes?.find((theme) => theme.name === currentName)?.id ?? null;
  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => ({
        category,
        items: (themes ?? []).filter((theme) => theme.category === category),
      })).filter((group) => group.items.length > 0),
    [themes],
  );
  const categoryLabel: Record<(typeof CATEGORY_ORDER)[number], string> = {
    professional: t`Professional`,
    editorial: t`Editorial`,
    bold: t`Bold`,
    dark: t`Dark`,
  };

  const send = async (
    patches: DeckPatch[],
    onDone: (created: Pick<Artifact, "id" | "version">) => void,
  ) => {
    setError(null);
    try {
      const created = await editSource({
        artifactId: artifact.id,
        baseVersion: artifact.version,
        patches,
      });
      onDone(created);
      onEdited?.(created.id);
    } catch (failure) {
      setError(
        failure instanceof Error && failure.message ? failure.message : t`That didn't work.`,
      );
    }
  };

  const pick = async (theme: DeckTheme) => {
    if (busy || theme.id === current) return;
    setBusy(theme.id);
    const before = html;
    await send([{ kind: "set-theme", theme: theme.id }], (created) =>
      setUndo({ html: before, name: theme.name, version: created.version }),
    );
    setBusy(null);
  };

  const revert = async () => {
    if (!undo || busy) return;
    setBusy("undo");
    await send([{ kind: "set-full-source", source: undo.html }], () => setUndo(null));
    setBusy(null);
  };

  const canUndo = undo !== null && undo.version === artifact.version;

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={t`Theme`}
      data-testid="deck-theme-picker"
      className="absolute end-3 top-3 z-30 flex max-h-[calc(100%-1.5rem)] w-[min(440px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-2xl bg-glass shadow-[0_12px_40px_rgb(0_0_0/0.16)] ring-[0.5px] ring-glass-line ring-inset backdrop-blur-[30px] backdrop-saturate-[1.8] motion-safe:animate-[deck-inspector-in_180ms_ease-out]"
    >
      <header className="flex items-center gap-1 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{t`Theme`}</div>
          <div className="truncate text-[11px] text-muted-foreground">
            {t`Restyles every slide; your content stays as it is.`}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-muted-foreground"
          aria-label={t`Close`}
          title={t`Close`}
          onClick={close}
        >
          <X />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-3">
        {failed ? (
          <p className="py-6 text-center text-[12px] text-muted-foreground">
            {t`Couldn't load the themes. Try again in a moment.`}
          </p>
        ) : themes === null ? (
          <div className="grid grid-cols-2 gap-3" aria-busy="true">
            {[0, 1, 2, 3].map((n) => (
              <div
                key={n}
                className="aspect-video animate-pulse rounded-lg bg-muted motion-reduce:animate-none"
              />
            ))}
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.category} className="mb-4 last:mb-1">
              <h3 className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {categoryLabel[group.category]}
              </h3>
              <div
                role="radiogroup"
                aria-label={categoryLabel[group.category]}
                className="grid grid-cols-2 gap-3"
              >
                {group.items.map((theme) => {
                  const selected = theme.id === current;
                  return (
                    // biome-ignore lint/a11y/useSemanticElements: a styled card, not a form radio
                    <button
                      key={theme.id}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      data-testid={`deck-theme-${theme.id}`}
                      disabled={busy !== null}
                      onClick={() => void pick(theme)}
                      className="group flex min-w-0 flex-col gap-1.5 rounded-xl text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                    >
                      <span
                        className={cn(
                          "relative block aspect-video overflow-hidden rounded-lg bg-muted ring-1 ring-inset motion-safe:transition-shadow",
                          selected
                            ? "ring-2 ring-foreground"
                            : "ring-border group-hover:ring-foreground/40",
                        )}
                      >
                        {theme.preview ? (
                          <img
                            src={theme.preview}
                            alt=""
                            draggable={false}
                            className="size-full object-cover"
                          />
                        ) : null}
                        {selected ? (
                          <span className="absolute end-1.5 top-1.5 grid size-5 place-items-center rounded-full bg-foreground text-background shadow">
                            <Check size={12} />
                          </span>
                        ) : null}
                      </span>
                      <span className="px-0.5">
                        <span className="block truncate text-[12px] font-medium">{theme.name}</span>
                        <span className="line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                          {theme.mood}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
      {error || canUndo ? (
        <footer
          role="status"
          className="flex items-center gap-2 border-t border-border px-4 py-2 text-[12px]"
        >
          <span className="min-w-0 flex-1 truncate">
            {error ?? t`Switched to ${undo?.name ?? ""}`}
          </span>
          {canUndo ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy !== null}
              onClick={() => void revert()}
            >
              <Undo2 />
              {t`Undo`}
            </Button>
          ) : null}
        </footer>
      ) : null}
    </div>
  );
}
