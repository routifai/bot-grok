import { useMemo } from "react";
import { ContextPanel } from "../muse/chrome/ContextPanel";
import type { MemoryClaim } from "../muse/chrome/MemorySections";
import type { MemoryWire } from "../muse/chrome/MemoryTab";
import { DEV_CLAIMS, DEV_MEMORY_BOT_ID, DEV_NOTES } from "./memory-fixture";
import { DEV_MUSE_COLOR, DEV_MUSE_NAME } from "./side-chat-fixture";

/**
 * Dev-only route (`/dev/memory`, gated by `import.meta.env.DEV`, following `/dev/activity`):
 * the real context panel (Memory tab) on an in-memory claim fixture, so the Memory redesign
 * is reviewed without touching any live stack's memory. Edits and forgets only change the
 * fixture's copy. `?w=420` widens the panel for review.
 */
export function MemoryPreviewPage() {
  const width = new URLSearchParams(window.location.search).get("w");
  const wire = useMemo<MemoryWire>(() => {
    let claims: MemoryClaim[] = [...DEV_CLAIMS];
    const empty = new URLSearchParams(window.location.search).has("empty");
    return {
      profile: async () => ({ profile: null }),
      claims: async () => ({ claims: empty ? [] : claims }),
      editClaim: async (input) => {
        const current =
          claims.find((c) => c.id === input.claimId) ?? (DEV_CLAIMS[0] as MemoryClaim);
        const saved: MemoryClaim = {
          ...current,
          text: input.text,
          origin: "edited",
          personAuthored: true,
        };
        claims = claims.map((c) => (c.id === saved.id ? saved : c));
        return saved;
      },
      forgetClaim: async (input) => {
        claims = claims.filter((c) => c.id !== input.claimId);
        return { ok: true as const };
      },
      dailyNotes: async () => ({ notes: DEV_NOTES }),
      saveDailyNote: async (input) => ({
        ...(DEV_NOTES.find((n) => n.date === input.date) ?? (DEV_NOTES[0] as never)),
        sections: input.sections,
        editedByPerson: true,
      }),
    };
  }, []);

  return (
    <div
      className={
        width === "420"
          ? "flex h-screen gap-2 bg-background p-2 [&_[data-testid=context-panel]]:w-[420px]"
          : "flex h-screen gap-2 bg-background p-2"
      }
    >
      <div className="flex min-h-0 flex-1 items-center justify-center rounded-2xl border border-dashed border-border text-[13px] text-muted-foreground">
        Conversation — not part of this preview
      </div>
      <ContextPanel
        botId={DEV_MEMORY_BOT_ID}
        museName={DEV_MUSE_NAME}
        avatarColor={DEV_MUSE_COLOR}
        collapsed={false}
        onNavigate={() => undefined}
        onOpenWaiting={() => undefined}
        activitiesOverride={{
          state: { status: "ready", activities: [], hasMore: false },
          wire: {
            get: () => Promise.reject(new Error("fixture")),
            helperMessages: () => Promise.reject(new Error("fixture")),
          },
          loadEarlier: async () => undefined,
          loadingEarlier: false,
        }}
        memoryWire={wire}
      />
    </div>
  );
}
