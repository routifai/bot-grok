import type { Artifact } from "@nova/contracts";

/** Matches the shape `rpc.artifacts.listSpace` returns (Artifacts.tsx keeps its own copy). */
export type ArtifactSummary = Artifact & { versionCount: number };
