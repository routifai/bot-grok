import { t } from "@lingui/core/macro";
import type { Artifact } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { decodeArtifactBase64 } from "../../../lib/artifact-open";
import { rpc } from "../../../lib/rpc";

type ContentState =
  | { status: "loading" }
  | { status: "ready"; artifact: Artifact; bytes: Uint8Array }
  | { status: "error"; message: string };

/**
 * Loads one artifact's latest version and content, the same way `Artifacts.tsx`'s
 * `PreviewPane` does, minus the version switcher the Library dialog doesn't need.
 */
export function useArtifactContent(artifactId: string | null): ContentState {
  const [state, setState] = useState<ContentState>({ status: "loading" });

  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    setState({ status: "loading" });

    void rpc.artifacts
      .listVersions({ familyId: artifactId })
      .then((versions) => versions[0]?.id ?? artifactId)
      .catch(() => artifactId)
      .then((versionId) => rpc.artifacts.getById({ artifactId: versionId }))
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
  }, [artifactId]);

  return state;
}
