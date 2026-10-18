import { useLingui } from "@lingui/react/macro";
import type { Artifact, ToolFamily } from "@superchat/contracts";
import { Button, Sheet, SheetContent, SheetTitle } from "@superchat/ui-web";
import { PanelRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useIsDesktop } from "../../components/ai/orb";
import { useArtifactPanel } from "../../components/cards/context";
import type { TurnStrip } from "../activity";
import { PlanSteps, setStepComment, useConversationFiles, useStripView } from "../activity";
import { ArtifactPreviewThumbnail } from "../artifacts";
import { usedFamilies } from "./sessionPanelState";

// The session panel (ADR 0027): beside the transcript while work runs, the newest reply's plan in
// full (Progress), the files the Conversation made (Outputs) and the kinds of tool its work used.
// A side column on desktop, a sheet on a phone. Section names only: no explainer copy.

function Section({
  title,
  testId,
  children,
}: {
  title: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section data-testid={testId} className="flex flex-col gap-2 rounded-xl bg-card p-3">
      <h3 className="m-0 text-[13.5px] font-[620] text-foreground">{title}</h3>
      {children}
    </section>
  );
}

function OutputRow({ artifact }: { artifact: Artifact }) {
  const panel = useArtifactPanel();
  return (
    <li>
      <button
        type="button"
        data-testid="session-output"
        onClick={() => panel?.open(artifact.id, artifact.name)}
        className="flex w-full min-w-0 items-center gap-2.5 rounded-lg p-1 text-start text-[13px] text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
      >
        <span className="relative aspect-video w-16 shrink-0 overflow-hidden rounded-[4px] border border-border bg-muted">
          <ArtifactPreviewThumbnail artifact={artifact} />
        </span>
        <span className="min-w-0 truncate" dir="auto">
          {artifact.name}
        </span>
      </button>
    </li>
  );
}

const NO_HELPERS: TurnStrip["helpers"] = [];

function PanelBody({
  botId,
  strip,
  onClose,
}: {
  botId: string;
  strip: TurnStrip | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  // The same reading as the reply's strip: its plan, its fold and the latest line of the work.
  const { view, activities } = useStripView(
    botId,
    strip?.helpers ?? NO_HELPERS,
    strip?.turn,
    strip?.lit ?? false,
  );
  const outputs = useConversationFiles(botId);
  const used = useMemo(() => usedFamilies(activities ?? []), [activities]);
  const familyName: Record<ToolFamily, string> = {
    web: t`Web search`,
    files: t`Files`,
    decks: t`Decks`,
    shell: t`Shell`,
    browser: t`Browser`,
  };
  const planId = strip?.turn.planId ?? null;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t`Close panel`}
          data-testid="session-panel-close"
          onClick={onClose}
        >
          <X size={16} strokeWidth={1.8} />
        </Button>
      </div>
      {view.plan ? (
        <Section title={t`Progress`} testId="session-progress">
          <PlanSteps
            plan={view.plan}
            fold={view.fold}
            progress={view.progress}
            onComment={
              planId
                ? (index, step) =>
                    setStepComment({ botId, cardId: planId, stepIndex: index, text: step.text })
                : undefined
            }
          />
        </Section>
      ) : null}
      {outputs.length > 0 ? (
        <Section title={t`Outputs`} testId="session-outputs">
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {outputs.map((artifact) => (
              <OutputRow key={artifact.id} artifact={artifact} />
            ))}
          </ul>
        </Section>
      ) : null}
      {used.length > 0 ? (
        <Section title={t`Used in this conversation`} testId="session-used">
          <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
            {used.map((family) => (
              <li
                key={family}
                data-testid="session-used-family"
                className="rounded-full border border-border px-2.5 py-0.5 text-[12px] text-foreground"
              >
                {familyName[family]}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}

/** The session panel: a column beside the transcript on desktop, a sheet on a phone. */
export function SessionPanel({
  botId,
  strip,
  open,
  onClose,
}: {
  botId: string;
  /** The strip of the newest reply with a plan (`newestPlanTurn`, features/activity `stripOf`). */
  strip: TurnStrip | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const desktop = useIsDesktop();
  if (!open) return null;
  const body = <PanelBody botId={botId} strip={strip} onClose={onClose} />;
  if (!desktop) {
    return (
      <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="sc-scroll overflow-y-auto p-4"
        >
          <SheetTitle className="sr-only">{t`Progress`}</SheetTitle>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside
      data-testid="session-panel"
      aria-label={t`Progress`}
      className="sc-scroll relative z-10 w-[300px] shrink-0 overflow-y-auto py-4 pe-4"
    >
      {body}
    </aside>
  );
}

/** Opens and closes the session panel from the header. */
export function SessionPanelToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  const { t } = useLingui();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t`Session panel`}
      aria-expanded={open}
      data-testid="session-panel-toggle"
      onClick={onToggle}
    >
      <PanelRight size={16} strokeWidth={1.8} />
    </Button>
  );
}
