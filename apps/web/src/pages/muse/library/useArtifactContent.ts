import type { Artifact, ArtifactVersion } from "@aiden/contracts";
import { t } from "@lingui/core/macro";
import { useEffect, useState } from "react";
import { decodeArtifactBase64 } from "../../../lib/artifact-open";
import { rpc } from "../../../lib/rpc";

type ContentState =
  | { status: "loading" }
  | { status: "ready"; artifact: Artifact; bytes: Uint8Array }
  | { status: "error"; message: string };

type Loaded = ContentState & {
  /** Every version of the deliverable, newest first. */
  versions: ArtifactVersion[];
  /** The version currently shown (its artifact id). */
  versionId: string | null;
  selectVersion: (versionId: string) => void;
};

/**
 * Loads one artifact's versions and the content of the chosen one (the latest until the person
 * picks another from the dialog's version menu).
 */
export function useArtifactContent(artifactId: string | null): Loaded {
  const [state, setState] = useState<ContentState>({ status: "loading" });
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    setState({ status: "loading" });
    setPicked(null);
    void rpc.artifacts
      .listVersions({ familyId: artifactId })
      .then((list) => {
        if (!cancelled) setVersions(list);
        return list;
      })
      .catch(() => [] as ArtifactVersion[])
      .then((list) => {
        if (!cancelled) setPicked(list[0]?.id ?? artifactId);
      });
    return () => {
      cancelled = true;
    };
  }, [artifactId]);

  useEffect(() => {
    if (!picked) return;
    let cancelled = false;
    setState({ status: "loading" });
    void rpc.artifacts
      .getById({ artifactId: picked })
      .then((artifact) => {
        if (cancelled) return;
        setState({
          status: "ready",
          artifact,
          bytes: decodeArtifactBase64(artifact.contentBase64),
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : t`Could not load this.`,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [picked]);

  return { ...state, versions, versionId: picked, selectVersion: setPicked };
}
