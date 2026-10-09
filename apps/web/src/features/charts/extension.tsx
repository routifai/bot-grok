import { t } from "@lingui/core/macro";
import { isChartArtifactName } from "@nova/contracts";
import type { ArtifactExtension } from "../artifacts";
import { ChartInlinePreview, ChartPanelView } from "./ChartArtifact";
import { ChartResult } from "./ChartResult";
import { ChartThumbnail } from "./ChartThumbnail";

/** Opens charts (JSON files named `*.chart.json`) as live charts in the panel and the chat and,
 * as a server-rendered image, in the Library. */
export const chartsExtension: ArtifactExtension = {
  usePanel: ({ artifact }) => ({ wide: !!artifact && isChartArtifactName(artifact.name) }),
  card: (artifact) => (isChartArtifactName(artifact.name) ? { meta: t`Chart` } : null),
  view: ({ artifact, bytes, fallback }) =>
    isChartArtifactName(artifact.name) ? (
      <ChartPanelView
        artifactId={artifact.id}
        version={artifact.version}
        bytes={bytes}
        fallback={fallback}
      />
    ) : null,
  inline: ({ artifactId, name, version, near }) =>
    isChartArtifactName(name) ? (
      <ChartInlinePreview artifactId={artifactId} version={version} enabled={near} />
    ) : null,
  result: ({ artifactId, name, version }) =>
    isChartArtifactName(name) ? (
      <ChartResult artifactId={artifactId} name={name} version={version} />
    ) : null,
  thumbnail: ({ id, name, version }) =>
    isChartArtifactName(name) ? <ChartThumbnail artifactId={id} version={version} /> : null,
};
