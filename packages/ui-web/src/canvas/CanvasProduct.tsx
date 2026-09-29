import { useLingui } from "@lingui/react/macro";
import { Check, Minus, Star, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Button } from "../components/ui/button.js";
import { cn } from "../lib/utils.js";
import { initials, monogramColor } from "./canvas-colors.js";

export function CanvasItemCard({
  title,
  subtitle,
  monogram,
  color,
  imageUrl,
  highlight,
  stats,
  pros,
  cons,
  ctaLabel,
  ctaUrl,
}: {
  title: string;
  subtitle?: string;
  monogram?: string;
  color?: string;
  imageUrl?: string;
  highlight?: string;
  stats?: { label: string; value: string }[];
  pros?: string[];
  cons?: string[];
  ctaLabel?: string;
  ctaUrl?: string;
}) {
  const { t } = useLingui();
  const badgeText = monogram || initials(title);
  const badgeColor = monogramColor(title, color);
  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      <div className="flex items-start gap-3">
        {imageUrl ? (
          <img src={imageUrl} alt="" className="size-10 shrink-0 rounded-xl object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-xl text-[13px] font-semibold text-white"
            style={{ background: badgeColor }}
          >
            {badgeText}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h4 className="line-clamp-2 text-pretty text-[14.5px] leading-[1.3] font-semibold break-words text-foreground">
            {title}
          </h4>
          {subtitle ? (
            <p className="truncate text-[12.5px] text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {highlight ? (
        <span className="self-start rounded-full bg-success/12 px-2 py-0.5 text-[11px] font-medium text-success">
          {highlight}
        </span>
      ) : null}

      {stats && stats.length > 0 ? (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          {stats.map((stat) => (
            <div key={stat.label} className="min-w-0">
              <dt className="truncate text-[11px] text-muted-foreground">{stat.label}</dt>
              <dd className="truncate text-[13px] font-medium tabular-nums text-foreground">
                {stat.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}

      {pros && pros.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {pros.map((pro) => (
            <li key={pro} className="flex items-start gap-1.5 text-[12.5px] text-foreground/85">
              <Check
                size={13}
                strokeWidth={2.2}
                className="mt-0.5 shrink-0 text-success"
                aria-hidden="true"
              />
              <span>{pro}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {cons && cons.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {cons.map((con) => (
            <li key={con} className="flex items-start gap-1.5 text-[12.5px] text-muted-foreground">
              <X
                size={13}
                strokeWidth={2.2}
                className="mt-0.5 shrink-0 text-destructive/70"
                aria-hidden="true"
              />
              <span>{con}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {ctaUrl ? (
        <Button
          variant="outline"
          size="sm"
          className="mt-auto self-start rounded-full"
          render={<a href={ctaUrl} target="_blank" rel="noreferrer noopener" />}
        >
          {ctaLabel || t`Learn more`}
        </Button>
      ) : null}
    </article>
  );
}

type CellValue = string | number | boolean | null;

function CellContent({ value }: { value: CellValue }) {
  const { t } = useLingui();
  if (value === true)
    return <Check size={15} strokeWidth={2.4} className="text-success" aria-label={t`Yes`} />;
  if (value === false)
    return (
      <X size={15} strokeWidth={2.4} className="text-muted-foreground/60" aria-label={t`No`} />
    );
  if (value === null)
    return <Minus size={13} className="text-muted-foreground/50" aria-label={t`Not applicable`} />;
  return <span className="tabular-nums">{value}</span>;
}

/** Sticky first column so the attribute name stays put while the rest scrolls; the fade
 * hints there's more to see. Needs its own opaque background — it paints over whatever
 * column has scrolled underneath it. */
const STICKY_LABEL_CELL = "sticky left-0 z-10";

export function CanvasComparisonTable({
  columns,
  rows,
  footer,
}: {
  columns: { id: string; label: string }[];
  rows: { label: string; cells: { columnId: string; value: CellValue; winner?: boolean }[] }[];
  footer?: string;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showRightFade, setShowRightFade] = useState(false);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const update = () => {
      setShowRightFade(node.scrollWidth - node.clientWidth - node.scrollLeft > 1);
    };
    update();
    node.addEventListener("scroll", update, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    resizeObserver?.observe(node);
    return () => {
      node.removeEventListener("scroll", update);
      resizeObserver?.disconnect();
    };
  }, []);

  return (
    <div className="min-w-0 overflow-hidden rounded-2xl border border-border bg-card">
      <div className="relative">
        <div ref={scrollRef} className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border bg-muted/60">
                <th
                  scope="col"
                  className={cn(
                    STICKY_LABEL_CELL,
                    "bg-muted px-4 py-2.5 text-left font-medium text-muted-foreground",
                  )}
                >
                  {""}
                </th>
                {columns.map((column) => (
                  <th
                    key={column.id}
                    scope="col"
                    className="px-4 py-2.5 text-left font-medium text-muted-foreground"
                  >
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const byColumn = new Map(row.cells.map((cell) => [cell.columnId, cell]));
                return (
                  <tr key={row.label} className="border-b border-border last:border-0">
                    <th
                      scope="row"
                      className={cn(
                        STICKY_LABEL_CELL,
                        "bg-card px-4 py-2.5 text-left font-medium text-foreground",
                      )}
                    >
                      {row.label}
                    </th>
                    {columns.map((column) => {
                      const cell = byColumn.get(column.id);
                      return (
                        <td
                          key={column.id}
                          className={cn(
                            "px-4 py-2.5 text-foreground/85",
                            cell?.winner ? "bg-success/8 font-medium text-foreground" : undefined,
                          )}
                        >
                          {cell ? (
                            <CellContent value={cell.value} />
                          ) : (
                            <Minus
                              size={13}
                              className="text-muted-foreground/40"
                              aria-hidden="true"
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* Scroll-shadow hint: more columns are off-screen to the right. */}
        <div
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card to-transparent transition-opacity duration-200",
            showRightFade ? "opacity-100" : "opacity-0",
          )}
        />
      </div>
      {footer ? (
        <div className="border-t border-border px-4 py-2.5 text-[12.5px] text-muted-foreground">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export function CanvasRankingList({
  items,
}: {
  items: { rank?: number; name: string; score?: number; note?: string }[];
}) {
  const max = Math.max(1, ...items.map((item) => item.score ?? 0));
  return (
    <ol className="flex flex-col gap-2.5">
      {items.map((item, index) => (
        <li key={`${item.rank ?? index}-${item.name}`} className="flex items-center gap-3">
          <span className="w-5 shrink-0 text-center text-[13px] font-semibold tabular-nums text-muted-foreground">
            {item.rank ?? index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[13.5px] font-medium text-foreground">
                {item.name}
              </span>
              {item.note ? (
                <span className="shrink-0 text-[12px] text-muted-foreground">{item.note}</span>
              ) : null}
            </div>
            {item.score !== undefined ? (
              <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-500 motion-reduce:transition-none"
                  style={{ width: `${(item.score / max) * 100}%` }}
                />
              </div>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function CanvasRating({
  value,
  max = 5,
  label,
}: {
  value: number;
  max?: number;
  label?: string;
}) {
  const stars: ReactNode[] = [];
  for (let i = 0; i < max; i += 1) {
    const filled = i < Math.round(value);
    stars.push(
      <Star
        key={i}
        size={15}
        strokeWidth={1.8}
        className={filled ? "fill-warning text-warning" : "text-muted-foreground/30"}
        aria-hidden="true"
      />,
    );
  }
  return (
    <div
      className="flex items-center gap-1.5"
      role="img"
      aria-label={`${value} out of ${max} stars${label ? `: ${label}` : ""}`}
    >
      <span className="flex items-center gap-0.5">{stars}</span>
      {label ? <span className="text-[12.5px] text-muted-foreground">{label}</span> : null}
    </div>
  );
}
