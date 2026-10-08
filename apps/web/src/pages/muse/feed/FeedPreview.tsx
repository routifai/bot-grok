import { Trans } from "@lingui/react/macro";
import { illustrationUrl } from "../../../lib/illustrations";
import { SparkGlyph } from "../chrome/NovaGlyphs";
import { NovaTile } from "../chrome/NovaTile";

const CARD = "nova-card p-4";

/**
 * What a Feed morning looks like before there is one: a finished-work report from a
 * Goal and a sourced find on a followed topic, shown on a soft stage.
 */
export function FeedPreview(_props: { botName: string; color: string }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 rounded-[22px] bg-window p-5 sm:p-7">
      <div className={CARD}>
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <NovaTile tone="blue" size={20}>
            <SparkGlyph />
          </NovaTile>
          <Trans>From Q3 portfolio review · 7:40</Trans>
        </div>
        <div className="mt-2.5 flex gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[16px] font-semibold tracking-[-0.015em] text-foreground">
              <Trans>Talking points are ready for all 12 clients</Trans>
            </p>
            <p className="mt-1 text-[14.5px] leading-[1.45] text-muted-foreground">
              <Trans>
                Two portfolios drifted past 8% from target; I put them first and drafted a
                rebalancing note for each.
              </Trans>
            </p>
          </div>
          <div className="hidden h-[72px] w-[104px] shrink-0 flex-col gap-1.5 rounded-xl bg-muted p-2.5 sm:flex">
            <span className="h-1.5 w-3/4 rounded-full bg-foreground/20" />
            <span className="h-1.5 w-full rounded-full bg-foreground/10" />
            <span className="h-1.5 w-5/6 rounded-full bg-foreground/10" />
            <span className="h-1.5 w-2/3 rounded-full bg-foreground/10" />
          </div>
        </div>
      </div>

      <div className={CARD}>
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <img src={illustrationUrl("chart-increasing")} alt="" className="size-5" />
          <Trans>Mortgage rates · 6:15</Trans>
        </div>
        <p className="mt-2.5 text-[16px] font-semibold tracking-[-0.015em] text-foreground">
          <Trans>Central bank holds its rate; lenders trim five-year fixed</Trans>
        </p>
        <p className="mt-1 text-[14.5px] leading-[1.45] text-muted-foreground">
          <Trans>
            Three of your clients renew this quarter. Fixed looks better than it did last month; I
            can draft a note for each.
          </Trans>
        </p>
      </div>
    </div>
  );
}
