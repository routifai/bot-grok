import { useLingui } from "@lingui/react/macro";
import { Button, cn } from "@nova/ui-web";
import { ChevronLeft, ChevronRight, Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SandboxedHtmlViewer } from "../../components/SandboxedHtmlViewer";
import { DeckRail } from "./DeckRail";
import { DeckThemePicker, type DeckThemeSource, type DeckThemesSource } from "./DeckThemePicker";
import {
  type DeckNavigation,
  parseDeckSlides,
  postDeckNavigation,
  readDeckEvent,
} from "./deck-model";
import {
  setDeckThemeOpen,
  useDeckEditing,
  useDeckPresentRequest,
  useDeckThemeOpen,
} from "./deck-ui-state";
import { DeckEditor } from "./edit/DeckEditor";
import type { DeckEditSource } from "./edit/useDeckEditor";

const BAR_HIDE_MS = 2500;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * A deck in the artifact panel: the sandboxed HTML on a stage (the deck scales itself to the
 * frame), previous / next, a rail of live thumbnails and a full screen present mode. The deck
 * keeps its own navigation state; the host only sends `nova:slide` commands and mirrors the
 * `nova:slide-state` it hears back.
 */
export function DeckViewer({
  html,
  title,
  artifact,
  onEdited,
  editSource,
  themesSource,
  themeSource,
}: {
  html: string;
  title: string;
  /** The saved file on screen; without it the deck cannot be edited. */
  artifact?: { id: string; version: number };
  onEdited?: (artifactId: string) => void;
  editSource?: DeckEditSource;
  /** Where the Theme gallery gets the theme dictionary (the API by default). */
  themesSource?: DeckThemesSource;
  /** Where the gallery reads the theme the deck is on (the API by default). */
  themeSource?: DeckThemeSource;
}) {
  const { t } = useLingui();
  const slides = useMemo(() => parseDeckSlides(html), [html]);
  const frame = useRef<HTMLIFrameElement | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [count, setCount] = useState(slides.length);
  const activeRef = useRef(0);
  activeRef.current = active;
  const [presenting, setPresenting] = useState(false);
  const [barVisible, setBarVisible] = useState(true);
  const barTimer = useRef<number | undefined>(undefined);
  const editing = useDeckEditing(title);
  const themeOpen = useDeckThemeOpen(title);
  // The gallery is a hidden state while presenting and must not outlive the deck on screen.
  useEffect(() => {
    if (presenting) setDeckThemeOpen(title, false);
  }, [presenting, title]);
  useEffect(() => () => setDeckThemeOpen(title, false), [title]);
  const presentRequest = useDeckPresentRequest(title);
  const handledPresent = useRef(presentRequest);

  useEffect(() => {
    setCount(slides.length);
    setActive((value) => Math.min(value, Math.max(0, slides.length - 1)));
  }, [slides.length]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const deckEvent = readDeckEvent(event.data);
      if (deckEvent?.kind === "state") {
        setActive(deckEvent.active);
        setCount(deckEvent.count);
      } else if (deckEvent?.kind === "ready" && activeRef.current > 0) {
        // A new version of the deck loaded: stay on the slide the person was looking at.
        postDeckNavigation(frame.current?.contentWindow, {
          action: "go",
          index: activeRef.current,
        });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const navigate = useCallback((nav: DeckNavigation) => {
    postDeckNavigation(frame.current?.contentWindow, nav);
  }, []);
  const goTo = useCallback((index: number) => navigate({ action: "go", index }), [navigate]);

  const canFullscreen = typeof document !== "undefined" && !!document.fullscreenEnabled;
  const togglePresent = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void container.current?.requestFullscreen?.();
  }, []);

  // The header's Present button asks by bumping a counter; only changes after mount count.
  useEffect(() => {
    if (presentRequest === handledPresent.current) return;
    handledPresent.current = presentRequest;
    if (canFullscreen && !document.fullscreenElement) void container.current?.requestFullscreen?.();
  }, [presentRequest, canFullscreen]);

  useEffect(() => {
    const onChange = () => setPresenting(document.fullscreenElement === container.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      // A dialog the keyboard is in (a theme preview over this deck) owns the keys, unless it is
      // this viewer's own (the Theme gallery) or holds this viewer (the preview's deck).
      const dialog = (event.target as Element | null)?.closest?.('[role="dialog"]');
      const own = container.current;
      if (dialog && own && !dialog.contains(own) && !own.contains(dialog)) return;
      const nav: Record<string, DeckNavigation> = {
        ArrowRight: { action: "next" },
        PageDown: { action: "next" },
        ArrowLeft: { action: "prev" },
        PageUp: { action: "prev" },
        Home: { action: "first" },
        End: { action: "last" },
      };
      const next = nav[event.key];
      if (next) {
        event.preventDefault();
        navigate(next);
      } else if (event.key === "f" || event.key === "F") {
        if (!canFullscreen) return;
        event.preventDefault();
        togglePresent();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, togglePresent, canFullscreen]);

  const revealBar = useCallback(() => {
    setBarVisible(true);
    window.clearTimeout(barTimer.current);
    barTimer.current = window.setTimeout(() => setBarVisible(false), BAR_HIDE_MS);
  }, []);
  useEffect(() => {
    if (presenting) revealBar();
    else setBarVisible(true);
    return () => window.clearTimeout(barTimer.current);
  }, [presenting, revealBar]);

  const showBar = !presenting || barVisible;
  const last = Math.max(0, count - 1);

  const bar = (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center gap-1 px-3 py-2",
        presenting
          ? "absolute inset-x-0 bottom-4 mx-auto w-fit rounded-full bg-black/70 text-white motion-safe:transition-opacity"
          : "border-t border-border",
        !showBar && "pointer-events-none opacity-0",
      )}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Previous slide`}
        disabled={active <= 0}
        onClick={() => navigate({ action: "prev" })}
      >
        <ChevronLeft />
      </Button>
      <span
        data-testid="deck-counter"
        aria-live="polite"
        className="min-w-14 text-center text-[12.5px] tabular-nums"
      >
        {active + 1} / {Math.max(count, 1)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t`Next slide`}
        disabled={active >= last}
        onClick={() => navigate({ action: "next" })}
      >
        <ChevronRight />
      </Button>
      {canFullscreen ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={presenting ? t`Exit present mode` : t`Present`}
          aria-pressed={presenting}
          onClick={togglePresent}
        >
          {presenting ? <Minimize2 /> : <Maximize2 />}
        </Button>
      ) : null}
    </div>
  );
  const editor =
    editing && artifact && !presenting ? (
      <DeckEditor
        artifact={artifact}
        html={html}
        title={title}
        active={active}
        frameRef={frame}
        bar={bar}
        onEdited={onEdited}
        source={editSource}
      />
    ) : null;

  return (
    <section
      ref={container}
      data-testid="deck-viewer"
      aria-label={title}
      onMouseMove={presenting ? revealBar : undefined}
      className={cn("relative flex h-full min-h-0 bg-background", presenting && "bg-black")}
    >
      {presenting ? null : (
        <DeckRail html={html} slides={slides} active={active} onSelect={goTo} slim={!!editor} />
      )}
      {editor ? (
        editor
      ) : (
        <div className="relative flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <SandboxedHtmlViewer html={html} title={title} relay frameRef={frame} />
          </div>
          {bar}
        </div>
      )}
      {themeOpen && artifact && !presenting ? (
        <DeckThemePicker
          deckKey={title}
          frameRef={frame}
          artifact={artifact}
          onEdited={onEdited}
          themesSource={themesSource}
          themeSource={themeSource}
          editSource={editSource}
        />
      ) : null}
    </section>
  );
}
