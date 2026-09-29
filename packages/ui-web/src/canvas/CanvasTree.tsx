import type { CanvasNode } from "@aiden/contracts";
import { CanvasChart } from "./CanvasChart.js";
import {
  CanvasBadge,
  CanvasCallout,
  CanvasHeading,
  CanvasKeyValue,
  CanvasQuote,
  CanvasSourceList,
  CanvasStat,
  CanvasText,
} from "./CanvasContent.js";
import { CanvasChecklist, CanvasProgress, CanvasTimeline } from "./CanvasData.js";
import type { CanvasAnswer } from "./CanvasInteractive.js";
import { CanvasChoiceButtons, CanvasForm, CanvasLinkButton } from "./CanvasInteractive.js";
import {
  CanvasDivider,
  CanvasGrid,
  CanvasRow,
  CanvasSection,
  CanvasStack,
  CanvasTabs,
} from "./CanvasLayout.js";
import {
  CanvasComparisonTable,
  CanvasItemCard,
  CanvasRankingList,
  CanvasRating,
} from "./CanvasProduct.js";

/**
 * Recursively renders a repaired, schema-valid `CanvasNode` tree (see
 * packages/contracts/src/canvas.ts for the catalog). `onAnswer`/`disabled` flow to every
 * interactive leaf (choice, form) exactly like an `ask` block's tap today.
 */
export function CanvasNodeView({
  node,
  onAnswer,
  disabled,
}: {
  node: CanvasNode;
  onAnswer?: CanvasAnswer;
  disabled?: boolean;
}) {
  const props = (node.props ?? {}) as Record<string, unknown>;
  switch (node.type) {
    case "stack":
      return (
        <CanvasStack
          direction={props.direction as never}
          gap={props.gap as never}
          align={props.align as never}
        >
          {(node.children ?? []).map((child, index) => (
            <CanvasNodeView key={index} node={child} onAnswer={onAnswer} disabled={disabled} />
          ))}
        </CanvasStack>
      );
    case "row":
      return (
        <CanvasRow gap={props.gap as never} wrap={props.wrap as never} align={props.align as never}>
          {(node.children ?? []).map((child, index) => (
            <CanvasNodeView key={index} node={child} onAnswer={onAnswer} disabled={disabled} />
          ))}
        </CanvasRow>
      );
    case "grid":
      return (
        <CanvasGrid columns={props.columns as never} minColumnWidth={props.minColumnWidth as never}>
          {(node.children ?? []).map((child, index) => (
            <CanvasNodeView key={index} node={child} onAnswer={onAnswer} disabled={disabled} />
          ))}
        </CanvasGrid>
      );
    case "section":
      return (
        <CanvasSection title={props.title as never} description={props.description as never}>
          {(node.children ?? []).map((child, index) => (
            <CanvasNodeView key={index} node={child} onAnswer={onAnswer} disabled={disabled} />
          ))}
        </CanvasSection>
      );
    case "tabs":
      return (
        <CanvasTabs tabs={(props.tabs as never) ?? []}>
          {(node.children ?? []).map((child, index) => (
            <CanvasNodeView key={index} node={child} onAnswer={onAnswer} disabled={disabled} />
          ))}
        </CanvasTabs>
      );
    case "divider":
      return <CanvasDivider />;
    case "heading":
      return <CanvasHeading text={props.text as string} level={props.level as never} />;
    case "text":
      return <CanvasText text={props.text as string} />;
    case "badge":
      return <CanvasBadge text={props.text as string} tone={props.tone as never} />;
    case "stat":
      return (
        <CanvasStat
          label={props.label as string}
          value={props.value as never}
          unit={props.unit as never}
          delta={props.delta as never}
          trend={props.trend as never}
        />
      );
    case "key_value":
      return <CanvasKeyValue items={(props.items as never) ?? []} />;
    case "callout":
      return (
        <CanvasCallout
          tone={props.tone as never}
          title={props.title as never}
          text={props.text as string}
        />
      );
    case "quote":
      return <CanvasQuote text={props.text as string} attribution={props.attribution as never} />;
    case "source_list":
      return <CanvasSourceList sources={(props.sources as never) ?? []} />;
    case "item_card":
      return (
        <CanvasItemCard
          title={props.title as string}
          subtitle={props.subtitle as never}
          monogram={props.monogram as never}
          color={props.color as never}
          imageUrl={props.imageUrl as never}
          highlight={props.highlight as never}
          stats={props.stats as never}
          pros={props.pros as never}
          cons={props.cons as never}
          ctaLabel={props.ctaLabel as never}
          ctaUrl={props.ctaUrl as never}
        />
      );
    case "comparison_table":
      return (
        <CanvasComparisonTable
          columns={(props.columns as never) ?? []}
          rows={(props.rows as never) ?? []}
          footer={props.footer as never}
        />
      );
    case "ranking_list":
      return <CanvasRankingList items={(props.items as never) ?? []} />;
    case "rating":
      return (
        <CanvasRating
          value={props.value as number}
          max={props.max as never}
          label={props.label as never}
        />
      );
    case "chart":
      return (
        <CanvasChart
          kind={props.kind as never}
          title={props.title as never}
          series={(props.series as never) ?? []}
          unit={props.unit as never}
        />
      );
    case "progress":
      return (
        <CanvasProgress
          label={props.label as never}
          value={props.value as number}
          tone={props.tone as never}
        />
      );
    case "timeline":
      return <CanvasTimeline items={(props.items as never) ?? []} />;
    case "checklist":
      return <CanvasChecklist items={(props.items as never) ?? []} />;
    case "choice":
      return (
        <CanvasChoiceButtons
          question={props.question as never}
          options={(props.options as never) ?? []}
          onAnswer={onAnswer}
          disabled={disabled}
        />
      );
    case "form":
      return (
        <CanvasForm
          fields={(props.fields as never) ?? []}
          submitLabel={props.submitLabel as never}
          onAnswer={onAnswer}
          disabled={disabled}
        />
      );
    case "link_button":
      return <CanvasLinkButton label={props.label as string} url={props.url as string} />;
    default:
      return null;
  }
}

/** Entry point for a whole canvas block: the root node plus an optional title strip. */
export function CanvasView({
  tree,
  title,
  onAnswer,
  disabled,
}: {
  tree: CanvasNode;
  title?: string;
  onAnswer?: CanvasAnswer;
  disabled?: boolean;
}) {
  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      {title ? <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3> : null}
      <CanvasNodeView node={tree} onAnswer={onAnswer} disabled={disabled} />
    </div>
  );
}
