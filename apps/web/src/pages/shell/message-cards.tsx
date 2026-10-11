import { Trans, useLingui } from "@lingui/react/macro";
import type { CanvasNode, MessageBlock } from "@superchat/contracts";
import {
  Button,
  CanvasView,
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@superchat/ui-web";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { type ArtifactTarget, fetchArtifactBytes } from "../../lib/artifact-open";
import { chartViewport } from "../../lib/chart-viewport";

function ChartCanvas({
  spec,
  data,
  width,
  height,
}: {
  spec: Record<string, unknown>;
  data: unknown[];
  width: number;
  height?: number;
}) {
  const { t } = useLingui();
  const ref = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<{
    title?: string;
    swatches: { label: string; color: string }[];
  }>({ swatches: [] });
  useEffect(() => {
    let cancelled = false;
    // Plot loads lazily so threads without charts never pay for the library.
    void (async () => {
      try {
        const { buildPlotParts } = await import("@superchat/core/plot");
        if (cancelled || !ref.current) return;
        // Hover inspection by default: give the first mark a tooltip unless
        // the spec already asks for one somewhere.
        const marks = Array.isArray((spec as { marks?: unknown[] }).marks)
          ? ((spec as { marks: { options?: Record<string, unknown> }[] }).marks ?? [])
          : [];
        const hasTip = marks.some((mark) => mark.options && "tip" in mark.options);
        const liveSpec = hasTip
          ? spec
          : {
              ...spec,
              marks: marks.map((mark, index) =>
                index === 0 ? { ...mark, options: { ...(mark.options ?? {}), tip: true } } : mark,
              ),
            };
        const parts = buildPlotParts(liveSpec as never, data, document, { width, height });
        setMeta({ title: parts.title, swatches: parts.swatches });
        setError(null);
        ref.current.replaceChildren(parts.plotted);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : t`Could not render chart`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [spec, data, width, height, t]);
  if (error)
    return (
      <div className="text-[13px] text-destructive">
        <Trans>Chart failed to render: {error}</Trans>
      </div>
    );
  return (
    <div className="text-foreground/75">
      {meta.title ? (
        <div className="mb-1 text-[14.5px] font-semibold text-foreground">{meta.title}</div>
      ) : null}
      {meta.swatches.length > 0 ? (
        <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1">
          {meta.swatches.map((swatch) => (
            <span
              key={swatch.label}
              className="flex items-center gap-1.5 text-[12px] text-muted-foreground"
            >
              {/* Series colours are data-driven and intentionally distinct. */}
              <span
                className="h-[10px] w-[10px] rounded-[3px]"
                style={{ background: swatch.color }}
              />
              {swatch.label}
            </span>
          ))}
        </div>
      ) : null}
      <div ref={ref} className="[&_svg]:max-w-full" />
    </div>
  );
}

export function ChartBlockView({
  name,
  spec,
  data,
}: {
  name: string;
  spec: Record<string, unknown>;
  data: unknown[];
}) {
  const { t } = useLingui();
  const [expanded, setExpanded] = useState(false);
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  useEffect(() => {
    if (!expanded) return;
    setViewport({ width: window.innerWidth, height: window.innerHeight });
    const onResize = () => setViewport({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [expanded]);
  const expandedViewport = chartViewport(viewport.width, viewport.height);
  return (
    <>
      <div className="group relative max-w-[74%] rounded-[20px] bg-muted p-4">
        <ChartCanvas spec={spec} data={data} width={520} />
        <Button
          variant="outline"
          size="xs"
          onClick={() => setExpanded(true)}
          className="absolute end-3 top-3 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trans>Expand</Trans>
        </Button>
      </div>
      <Dialog open={expanded} onOpenChange={setExpanded}>
        <DialogContent
          showCloseButton={false}
          className="max-h-[92vh] w-[min(1320px,94vw)] max-w-none overflow-auto p-8 sm:max-w-none"
        >
          <div className="flex items-center justify-between">
            <DialogTitle className="text-[13px] font-normal text-muted-foreground">
              {name}
            </DialogTitle>
            <DialogClose
              aria-label={t`Close chart`}
              render={<Button variant="ghost" size="icon-sm" />}
            >
              <X />
            </DialogClose>
          </div>
          <ChartCanvas
            spec={spec}
            data={data}
            width={expandedViewport.width}
            height={expandedViewport.height}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Superchat Canvas (docs: show_canvas). `tree` already passed the catalog schema before
 * publish, so this only needs to dispatch it — no re-validation on the client. */
export function CanvasBlockView({
  block,
  onAnswer,
  disabled,
}: {
  block: Extract<MessageBlock, { kind: "canvas" }>;
  /** Wired the same as an `ask`/`choice` tap: posts back through the thread's run-input
   * answer call. Omit when the block is read-only (e.g. a shared or archived view). */
  onAnswer?: (value: string) => Promise<void>;
  disabled?: boolean;
}) {
  // block.tree is typed loosely (Record<string, any>) at the contract level, the same
  // reason ChartBlock's `spec` is, so it stays JSON-assignable for persistence; the shape
  // is a CanvasNode by construction (validated and repaired before publish).
  const tree = block.tree as unknown as CanvasNode;
  return (
    <div className="w-full max-w-[640px]">
      <CanvasView tree={tree} title={block.title} onAnswer={onAnswer} disabled={disabled} />
    </div>
  );
}

export function ArtifactImage({
  target,
  artifactId,
  name,
  mimeType,
}: {
  target: ArtifactTarget;
  artifactId: string;
  name: string;
  mimeType?: string;
}) {
  const { t } = useLingui();
  const [src, setSrc] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let objectUrl: string | null = null;
    setSrc(null);
    void fetchArtifactBytes(target, artifactId)
      .then((bytes) => {
        objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mimeType }));
        if (cancelled) URL.revokeObjectURL(objectUrl);
        else setSrc(objectUrl);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifactId, target, mimeType, visible]);

  return (
    <div ref={container}>
      {src ? (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="max-w-[240px] overflow-hidden rounded-[20px]"
        >
          <img src={src} alt={name} className="max-h-48 w-full object-cover" />
        </button>
      ) : (
        <div className="rounded-[20px] border border-border bg-muted px-4 py-3 text-[14px] text-muted-foreground">
          {name}
        </div>
      )}
      {src ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent
            showCloseButton={false}
            className="w-auto max-w-none bg-transparent p-0 ring-0 sm:max-w-none"
          >
            <DialogTitle className="sr-only">{name}</DialogTitle>
            <DialogClose
              aria-label={t`Close image preview`}
              render={<Button variant="ghost" size="icon-sm" className="absolute end-2 top-2" />}
            >
              <X />
            </DialogClose>
            <img
              src={src}
              alt={name}
              className="max-h-[85vh] max-w-[90vw] rounded-xl object-contain"
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
