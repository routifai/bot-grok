import { t } from "@lingui/core/macro";
import { isChartArtifactName, isDashboardArtifactName, isDashboardPageName } from "@nova/contracts";
import type { ArtifactExtension } from "../artifacts";
import { ChartInlinePreview, ChartPanelView } from "./ChartArtifact";
import { ChartResult } from "./ChartResult";
import { ChartThumbnail } from "./ChartThumbnail";
import { DashboardPageResult } from "./DashboardPage";
import { DashboardPanelView, DashboardResult } from "./DashboardView";

const isChartish = (name: string) => isChartArtifactName(name) || isDashboardArtifactName(name);

/** Opens charts (`*.chart.json`) and dashboards (`*.dashboard.json`) as live charts in the panel
 * and the chat and, as a server-rendered image, in the Library. A dashboard page
 * (`*.dashboard.html`) shows live at full width in the chat and opens in a wide panel. */
export const chartsExtension: ArtifactExtension = {
  usePanel: ({ artifact }) => ({
    wide: !!artifact && (isChartish(artifact.name) || isDashboardPageName(artifact.name)),
  }),
  card: (artifact) =>
    isDashboardArtifactName(artifact.name) || isDashboardPageName(artifact.name)
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
    isDashboardPageName(name) ? (
      <DashboardPageResult artifactId={artifactId} name={name} version={version} />
    ) : isDashboardArtifactName(name) ? (
      <DashboardResult artifactId={artifactId} name={name} version={version} />
    ) : isChartArtifactName(name) ? (
      <ChartResult artifactId={artifactId} name={name} version={version} />
    ) : null,
  thumbnail: ({ id, name, version }) =>
    isChartish(name) ? <ChartThumbnail artifactId={id} version={version} /> : null,
};
