import type { ReactNode } from "react";
import { useId, useState } from "react";
import { Separator } from "../components/ui/separator.js";
import { TabsContent, TabsList, Tabs as TabsRoot, TabsTrigger } from "../components/ui/tabs.js";
import { cn } from "../lib/utils.js";

const GAP_CLASS = { sm: "gap-2", md: "gap-4", lg: "gap-6" } as const;
const ALIGN_CLASS = {
  start: "items-start",
  center: "items-center",
  end: "items-end",
  stretch: "items-stretch",
} as const;

export function CanvasStack({
  direction = "vertical",
  gap = "md",
  align,
  children,
}: {
  direction?: "vertical" | "horizontal";
  gap?: keyof typeof GAP_CLASS;
  align?: keyof typeof ALIGN_CLASS;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0",
        direction === "horizontal" ? "flex-row flex-wrap" : "flex-col",
        GAP_CLASS[gap],
        align ? ALIGN_CLASS[align] : undefined,
      )}
    >
      {children}
    </div>
  );
}

export function CanvasRow({
  gap = "md",
  wrap = true,
  align = "stretch",
  children,
}: {
  gap?: keyof typeof GAP_CLASS;
  wrap?: boolean;
  align?: keyof typeof ALIGN_CLASS;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-row",
        wrap ? "flex-wrap" : undefined,
        GAP_CLASS[gap],
        ALIGN_CLASS[align],
      )}
    >
      {children}
    </div>
  );
}

export function CanvasGrid({
  columns = 3,
  minColumnWidth,
  children,
}: {
  columns?: number;
  minColumnWidth?: number;
  children: ReactNode;
}) {
  return (
    <div
      className="grid min-w-0 gap-4"
      style={{
        gridTemplateColumns: minColumnWidth
          ? `repeat(auto-fit, minmax(${minColumnWidth}px, 1fr))`
          : `repeat(${columns}, minmax(0, 1fr))`,
      }}
      data-canvas-grid-columns={columns}
    >
      {children}
    </div>
  );
}

export function CanvasSection({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={title ? headingId : undefined}
      className="flex min-w-0 flex-col gap-3"
    >
      {title ? (
        <header>
          <h3 id={headingId} className="text-[15px] font-semibold text-foreground">
            {title}
          </h3>
          {description ? (
            <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>
          ) : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function CanvasTabs({
  tabs,
  children,
}: {
  tabs: { id: string; label: string }[];
  children: ReactNode[];
}) {
  const [active, setActive] = useState(tabs[0]?.id);
  if (tabs.length === 0) return null;
  return (
    <TabsRoot value={active} onValueChange={setActive} className="min-w-0 gap-3">
      <TabsList>
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab, index) => (
        <TabsContent key={tab.id} value={tab.id}>
          {children[index]}
        </TabsContent>
      ))}
    </TabsRoot>
  );
}

export function CanvasDivider() {
  return <Separator role="separator" className="my-1" />;
}
