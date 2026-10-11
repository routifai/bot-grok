import { ORPCError } from "@orpc/server";
import {
  bytesToBase64,
  fetchOmnigentArtifactContent,
  getOmnigentArtifact,
} from "@superchat/adapters/omnigent/browser";
import { parseChartDocument, parseDashboardDocument } from "@superchat/charts";
import { isChartArtifactName, isDashboardArtifactName } from "@superchat/contracts";
import { notFound } from "./artifacts";
import { limitForThumbnail } from "./chart-limits";
import { renderChartSvg } from "./chart-svg";
import { engineClient, NO_EMAIL } from "./client";
import { os } from "./context";

/** The drawn size, which is wider than asked when the legend sits beside the chart. */
function svgSize(svg: string, fallback: { width: number; height: number }) {
  const size = svg.match(/width="(\d+(?:\.\d+)?)" height="(\d+(?:\.\d+)?)" viewBox/);
  return {
    width: Math.round(Number(size?.[1] ?? fallback.width)),
    height: Math.round(Number(size?.[2] ?? fallback.height)),
  };
}

export const chartsRouter = {
  charts: {
    /** A saved chart (a `*.chart.json` artifact, or a dashboard's first chart) drawn as an SVG,
     * cut down to a thumbnail's worth of points. */
    thumbnail: os.charts.thumbnail.handler(async ({ input }) => {
      const client = engineClient();
      const meta = await getOmnigentArtifact(client, NO_EMAIL, input.artifactId).catch(notFound);
      const dashboard = isDashboardArtifactName(meta.name);
      if (!dashboard && !isChartArtifactName(meta.name)) {
        throw new ORPCError("BAD_REQUEST", { message: "That file is not a chart" });
      }
      const bytes = await fetchOmnigentArtifactContent(
        client,
        NO_EMAIL,
        input.artifactId,
        meta.version,
      ).catch(notFound);
      // A dashboard's thumbnail is its first chart, the one it leads with.
      const document = dashboard
        ? (parseDashboardDocument(bytes)?.charts[0] ?? null)
        : parseChartDocument(bytes);
      if (!document) {
        throw new ORPCError("BAD_REQUEST", { message: "That chart file is unreadable" });
      }
      let svg: string;
      try {
        svg = renderChartSvg(limitForThumbnail(document), input);
      } catch (error) {
        throw new ORPCError("INTERNAL_SERVER_ERROR", {
          message: `The chart could not be drawn: ${error instanceof Error ? error.message : "unknown error"}`,
        });
      }
      return {
        mimeType: "image/svg+xml" as const,
        contentBase64: bytesToBase64(new TextEncoder().encode(svg)),
        ...svgSize(svg, input),
      };
    }),
  },
};
