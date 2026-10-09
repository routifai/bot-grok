import { t } from "@lingui/core/macro";
import { isChartArtifactName, isDashboardArtifactName } from "@nova/contracts";
import type { ArtifactExtension } from "../artifacts";
import { ChartInlinePreview, ChartPanelView } from "./ChartArtifact";
import { ChartResult } from "./ChartResult";
import { ChartThumbnail } from "./ChartThumbnail";
import { DashboardPanelView, DashboardResult } from "./DashboardView";

const isChartish = (name: string) => isChartArtifactName(name) || isDashboardArtifactName(name);

/** Opens charts (`*.chart.json`) and dashboards (`*.dashboard.json`) as live charts in the panel
 * and the chat and, as a server-rendered image, in the Library. */
export const chartsExtension: ArtifactExtension = {
  usePanel: ({ artifact }) => ({ wide: !!artifact && isChartish(artifact.name) }),
  card: (artifact) =>
    isDashboardArtifactName(artifact.name)
      ? { meta: t`Dashboard` }
      : isChartArtifactName(artifact.name)
        ? { meta: t`Chart` }
        : null,
  view: ({ artifact, bytes, fallback }) =>
    isDashboardArtifactName(artifact.name) ? (
      <DashboardPanelView
        artifactId={artifact.id}
        version={artifact.version}
        bytes={bytes}
        fallback={fallback}
      />
    ) : isChartArtifactName(artifact.name) ? (
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
    isDashboardArtifactName(name) ? (
      <DashboardResult artifactId={artifactId} name={name} version={version} />
    ) : isChartArtifactName(name) ? (
      <ChartResult artifactId={artifactId} name={name} version={version} />
    ) : null,
  thumbnail: ({ id, name, version }) =>
    isChartish(name) ? <ChartThumbnail artifactId={id} version={version} /> : null,
};
