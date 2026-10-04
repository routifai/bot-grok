import { useLingui } from "@lingui/react/macro";
import { ORPCError } from "@orpc/client";
import { useEffect, useRef, useState } from "react";
import { DaysSection, type DaysWire } from "./DaysSection";
import { addressMemoryItem, type MemoryProfileSection, parseMemoryProfile } from "./memoryProfile";
import { PanelRowSkeletonList } from "./PanelSkeleton";

// `NOT_IMPLEMENTED`: `memory.profile` isn't served in this environment. `NOT_FOUND`: this
// Muse has no Conversation yet (a brand new Muse) — both read as "nothing remembered
// yet", never "Could not load…" (same reasoning as useActivities.ts's `isUnavailable`).
const isEmptyBackend = (error: unknown) =>
  error instanceof ORPCError && (error.code === "NOT_IMPLEMENTED" || error.code === "NOT_FOUND");

/** The Memory tab's wire: `rpc.memory.profile`, kept explicit (not the `rpc` client)
 * so the dev fixture page can supply a fake — same convention as `ActivityWire`
 * (ActivityRunDialog.tsx) and `SideChatWire` (SideChatSession.tsx). */
export type MemoryWire = {
  profile: (input: { botId: string }) => Promise<{ profile: string | null }>;
} & Partial<DaysWire>;

type MemoryState =
  | { status: "loading" }
  | { status: "ready"; sections: MemoryProfileSection[] }
  | { status: "error" };

/**
 * The context panel's Memory tab: a read-only view of the Muse's Memory Profile
 * (`rpc.memory.profile`) — what it remembers about the person, in its own words, grouped
 * under the headings the engine gives it. The Days section lists recent daily notes, editable inline; Memory settings
 * (apps/web/src/pages/muse/settings/MemoryPanel.tsx) owns changing it.
 */
export function MemoryTab({ botId, wire }: { botId: string; wire: MemoryWire }) {
  const days =
    wire.dailyNotes && wire.saveDailyNote ? (
      <DaysSection
        botId={botId}
        wire={{ dailyNotes: wire.dailyNotes, saveDailyNote: wire.saveDailyNote }}
      />
    ) : null;
  const { t } = useLingui();
  const [state, setState] = useState<MemoryState>({ status: "loading" });
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setState({ status: "loading" });
    void wire
      .profile({ botId })
      .then((result) => {
        if (current !== generation.current) return;
        setState({ status: "ready", sections: parseMemoryProfile(result.profile) });
      })
      .catch((error: unknown) => {
        if (current !== generation.current) return;
        setState(isEmptyBackend(error) ? { status: "ready", sections: [] } : { status: "error" });
      });
    return () => {
      generation.current += 1;
    };
  }, [botId, wire]);

  if (state.status === "loading") return <PanelRowSkeletonList count={3} />;
  if (state.status === "error") {
    return <p className="text-[13px] text-destructive">{t`Could not load Memory`}</p>;
  }
  if (state.sections.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <p
          className="py-8 text-center text-[13.5px] text-muted-foreground"
          data-testid="memory-empty"
        >
          {t`Nothing remembered yet.`}
        </p>
        {days}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="memory-panel">
      {state.sections.map((section, index) => (
        <section key={section.heading || index} className="flex flex-col gap-1">
          {section.heading ? (
            <h3 className="px-1 text-[12.5px] font-semibold text-muted-foreground">
              {section.heading}
            </h3>
          ) : null}
          <ul className="flex flex-col gap-0.5">
            {section.items.map((item, itemIndex) => (
              <li
                key={itemIndex}
                className="rounded-lg px-2 py-1 text-[13.5px] leading-[1.5] text-foreground"
                dir="auto"
              >
                {addressMemoryItem(item)}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {days}
    </div>
  );
}
