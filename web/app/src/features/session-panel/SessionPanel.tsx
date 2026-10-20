import { useLingui } from "@lingui/react/macro";
import type { Activity, Artifact, RoundView, ToolFamily } from "@superchat/contracts";
import { Button, Sheet, SheetContent, SheetTitle } from "@superchat/ui-web";
import { PanelRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useMemo } from "react";
import { useIsDesktop } from "../../components/ai/orb";
import { useFileStudio } from "../../components/cards/context";
import { useActivities, useConversationFiles, useRoundView } from "../activity";
import { ArtifactPreviewThumbnail } from "../artifacts";
import { roundOutputs, usedFamilies } from "./sessionPanelState";

// The session panel (ADR 0027): beside the transcript while work runs, the files the running
// Round saved, else the ones the Conversation made (Outputs), and the kinds of tool its work used;
// the work itself is in its strip. A side column on desktop, a sheet on a phone. Section names
// only: no explainer copy.

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
  const studio = useFileStudio();
  return (
    <li>
      <button
        type="button"
        data-testid="session-output"
        onClick={() => studio?.open(artifact.id, artifact.name)}
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

function Outputs({ outputs }: { outputs: readonly Artifact[] }) {
  const { t } = useLingui();
  if (outputs.length === 0) return null;
  return (
    <Section title={t`Outputs`} testId="session-outputs">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {outputs.map((artifact) => (
          <OutputRow key={artifact.id} artifact={artifact} />
        ))}
      </ul>
    </Section>
  );
}

/** The files the Round saved, from its record. */
function RoundOutputs({ botId, roundId }: { botId: string; roundId: string }) {
  const view = useRoundView(botId, roundId);
  const files = view?.files ?? NO_FILES;
  const rows = useConversationFiles(botId, files.length > 0);
  const outputs = useMemo(() => roundOutputs(files, rows), [files, rows]);
  return <Outputs outputs={outputs} />;
}

function ConversationOutputs({ botId }: { botId: string }) {
  return <Outputs outputs={useConversationFiles(botId)} />;
}

const NO_ACTIVITIES: readonly Activity[] = [];
const NO_FILES: RoundView["files"] = [];

function PanelBody({
  botId,
  roundId,
  onClose,
}: {
  botId: string;
  roundId: string | undefined;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const { state } = useActivities(botId);
  const activities = state.status === "ready" ? state.activities : NO_ACTIVITIES;
  const used = useMemo(() => usedFamilies(activities), [activities]);
  const familyName: Record<ToolFamily, string> = {
    web: t`Web search`,
    files: t`Files`,
    decks: t`Decks`,
    shell: t`Shell`,
    browser: t`Browser`,
  };
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
      {roundId ? (
        <RoundOutputs key={roundId} botId={botId} roundId={roundId} />
      ) : (
        <ConversationOutputs botId={botId} />
      )}
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
  roundId,
  open,
  onClose,
}: {
  botId: string;
  /** The running Round, whose files are the Outputs; else the Conversation's are. */
  roundId?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const desktop = useIsDesktop();
  if (!open) return null;
  const body = <PanelBody botId={botId} roundId={roundId} onClose={onClose} />;
  if (!desktop) {
    return (
      <Sheet open onOpenChange={(next) => (next ? undefined : onClose())}>
        <SheetContent
          side="right"
          showCloseButton={false}
          className="sc-scroll overflow-y-auto p-4"
        >
          <SheetTitle className="sr-only">{t`Session panel`}</SheetTitle>
          {body}
        </SheetContent>
      </Sheet>
    );
  }
  return (
    <aside
      data-testid="session-panel"
      aria-label={t`Session panel`}
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
