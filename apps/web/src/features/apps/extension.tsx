import { useLingui } from "@lingui/react/macro";
import type { Artifact, ArtifactPublish, ArtifactPublishAudience } from "@nova/contracts";
import { Button } from "@nova/ui-web";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import type { ArtifactExtension, ArtifactPanelParts } from "../artifacts";
import { PublishDialog, PublishedBar, PublishedPill, viewsText } from "./PublishApp";

/** The artifact panel's publish controls: pill, Publish button, address bar and dialog. */
function useAppsPanel({
  artifact,
  title,
}: {
  artifact: Artifact | undefined;
  title?: string;
}): ArtifactPanelParts {
  const { t } = useLingui();
  const [publishing, setPublishing] = useState(false);
  const [publish, setPublish] = useState<ArtifactPublish | null>(null);
  useEffect(() => {
    setPublish(artifact?.publish ?? null);
  }, [artifact]);

  const app = artifact?.mimeType === "text/html" ? artifact : undefined;
  if (!app) return {};
  const { id: artifactId, name, version } = app;

  async function publishWith(audience: ArtifactPublishAudience) {
    const published = await rpc.apps.publish({
      artifactId,
      audience,
      version,
    });
    setPublish(published);
    setPublishing(false);
  }

  async function unpublish() {
    await rpc.apps.unpublish({ artifactId });
    setPublish(null);
  }

  return {
    badge: publish ? <PublishedPill /> : null,
    actions: (
      <Button size="sm" onClick={() => setPublishing(true)}>
        {publish ? t`Publish settings` : t`Publish…`}
      </Button>
    ),
    below: publish ? (
      <PublishedBar
        publish={publish}
        onSettings={() => setPublishing(true)}
        onUnpublish={unpublish}
      />
    ) : null,
    overlay: publishing ? (
      <PublishDialog
        name={title || name}
        current={publish}
        onClose={() => setPublishing(false)}
        onConfirm={publishWith}
      />
    ) : null,
    holdsEscape: publishing,
  };
}

function PublishedBadge() {
  const { t } = useLingui();
  return (
    <span
      data-testid="library-card-published"
      className="nova-glass-pill inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-[11px] font-medium text-ink-2"
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-success" />
      {t`Published`}
    </span>
  );
}

export const appsExtension: ArtifactExtension = {
  usePanel: useAppsPanel,
  card: (artifact) =>
    artifact.publish
      ? { meta: viewsText(artifact.publish.stats), badge: <PublishedBadge /> }
      : null,
};
