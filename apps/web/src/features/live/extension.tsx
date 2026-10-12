import { useLingui } from "@lingui/react/macro";
import type { Artifact } from "@superchat/contracts";
import { Checkbox, Label } from "@superchat/ui-web";
import { useEffect, useState } from "react";
import type { ArtifactExtension, ArtifactPanelArgs, ArtifactPanelParts } from "../artifacts";
import {
  artifactKey,
  focusArtifactPart,
  setArtifactMarked,
} from "../artifacts/editor/editor-state";
import { LiveBar, whenText } from "./LiveBar";
import { LiveSettings } from "./LiveSettings";
import { canBeLive, useLive } from "./useLive";

/** The artifact panel's live parts: tag, "Keep updated" button, and the update bar. */
function useLivePanel({ artifact }: ArtifactPanelArgs): ArtifactPanelParts {
  const { t } = useLingui();
  const api = useLive(artifact);
  const { live } = api;
  const [showChanges, setShowChanges] = useState(true);
  const key = artifact ? artifactKey(artifact) : "";
  const newest = !!live?.lastUpdate && live.lastUpdate.version === artifact?.version;

  // The parts the newest update changed (and the ones in dispute) are marked in the page.
  const marked = [
    ...(newest ? (live?.lastUpdate?.applied ?? []).map((change) => change.id) : []),
    ...(live?.lastUpdate?.suggestions ?? []).map((suggestion) => suggestion.id),
  ].join("\n");
  useEffect(() => {
    if (!key) return;
    setArtifactMarked(key, showChanges && marked ? marked.split("\n") : []);
    return () => setArtifactMarked(key, []);
  }, [key, showChanges, marked]);

  if (!canBeLive(artifact) || live === undefined) return {};
  const updatedAt = live?.lastUpdate?.at ?? live?.checkedAt;
  return {
    badge: live ? (
      <span
        data-testid="live-tag"
        className="shrink-0 text-[12px] text-muted-foreground"
        title={updatedAt ? t`Updated ${whenText(updatedAt)}` : undefined}
      >
        {t`Live`}
      </span>
    ) : null,
    actions: <LiveSettings api={api} live={live} />,
    below: live ? (
      <LiveBar
        live={live}
        api={api}
        newest={newest}
        showChanges={showChanges}
        onShowChanges={setShowChanges}
        onPick={(id) => focusArtifactPart(key, id)}
      />
    ) : null,
  };
}

/** In the publish dialog: the published copy follows updates (only for a page that is live). */
function FollowUpdates({
  artifact,
  register,
}: {
  artifact: Artifact;
  register: Parameters<NonNullable<ArtifactExtension["publishOptions"]>>[1];
}) {
  const { t } = useLingui();
  const api = useLive(artifact);
  const { live } = api;
  const [follow, setFollow] = useState<boolean | null>(null);
  const checked = follow ?? live?.followPublish ?? false;
  useEffect(() => {
    if (!live?.schedule || follow === null || follow === live.followPublish) return;
    const { sources, tell } = live;
    const schedule = live.schedule;
    return register(async () => {
      await api.save({ schedule, sources, tell, followPublish: follow });
    });
  }, [live, follow, register, api.save]);
  if (!live?.schedule) return null;
  return (
    <Label className="gap-2 text-[13px] font-normal">
      <Checkbox checked={checked} onCheckedChange={(on) => setFollow(on === true)} />
      {t`Published copy follows updates`}
    </Label>
  );
}

/** Keeps a page up to date on a schedule; the editor shell, the version menu and the publish dialog
 * show it through the registry's slots. */
export const liveExtension: ArtifactExtension = {
  usePanel: useLivePanel,
  card: () => null,
  publishOptions: (artifact, register) =>
    canBeLive(artifact) ? <FollowUpdates artifact={artifact} register={register} /> : null,
};
