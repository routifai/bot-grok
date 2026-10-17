import type { ReactNode } from "react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import type { ArtifactPanelApi } from "../../components/cards/context";

const ArtifactPanel = lazy(() =>
  import("./ArtifactPanel").then((m) => ({ default: m.ArtifactPanel })),
);

/** The artifact side panel every chat surface shares (the Conversation and Side Chats): which
 * deliverable is open, the api cards use to open it (`ArtifactPanelProvider`), and the panel
 * itself to render beside the chat. `resetKey` closes it when the chat changes. */
export function useChatArtifacts(resetKey: string | undefined): {
  api: ArtifactPanelApi;
  isOpen: boolean;
  panel: ReactNode;
} {
  const [open, setOpen] = useState<{ id: string; title?: string; page?: number } | null>(null);
  const api = useMemo<ArtifactPanelApi>(
    () => ({
      openId: open?.id ?? null,
      open: (id, title, page) => setOpen({ id, title, page }),
      close: () => setOpen(null),
    }),
    [open?.id],
  );
  useEffect(() => setOpen(null), [resetKey]);
  const panel = open ? (
    <Suspense fallback={null}>
      <ArtifactPanel
        key={open.id}
        artifactId={open.id}
        title={open.title}
        page={open.page}
        onClose={api.close}
      />
    </Suspense>
  ) : null;
  return { api, isOpen: open !== null, panel };
}
