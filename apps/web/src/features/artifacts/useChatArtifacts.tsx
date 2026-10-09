import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ArtifactPanelApi } from "../../../components/cards/context";

const ArtifactPanel = lazy(() =>
  import("../../../components/ArtifactPanel").then((m) => ({ default: m.ArtifactPanel })),
);

/** The artifact side panel every chat surface shares (the Conversation and Side Chats): which
 * deliverable is open, the api cards use to open it (`ArtifactPanelProvider`), and the panel
 * itself to render beside the chat. `resetKey` closes it when the chat changes. */
export function useChatArtifacts(resetKey: string | undefined): {
  api: ArtifactPanelApi;
  isOpen: boolean;
  panel: ReactNode;
} {
  const [open, setOpen] = useState<{ id: string; title?: string } | null>(null);
  const api = useMemo<ArtifactPanelApi>(
    () => ({
      openId: open?.id ?? null,
      open: (id, title) => setOpen({ id, title }),
      close: () => setOpen(null),
    }),
    [open?.id],
  );
  useEffect(() => setOpen(null), [resetKey]);
  const panel = open ? (
    <Suspense fallback={null}>
      <ArtifactPanel key={open.id} artifactId={open.id} title={open.title} onClose={api.close} />
    </Suspense>
  ) : null;
  return { api, isOpen: open !== null, panel };
}
