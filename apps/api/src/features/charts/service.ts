import {
  fetchOmnigentArtifactContent,
  getOmnigentArtifact,
  type OmnigentClientConfig,
} from "@nova/adapters";
import { parseChartDocument, parseDashboardDocument } from "@nova/charts";
import {
  type Actor,
  type ChartThumbnail,
  isChartArtifactName,
  isDashboardArtifactName,
} from "@nova/contracts";
import { ORPCError } from "@orpc/server";
import { type EngineArtifactsDeps, emailOf, notFound } from "../artifacts/index.js";
import { ThumbnailCache } from "./cache.js";
import { RenderBusyError, type RenderJob, sharedRenderPool } from "./pool.js";
import type { RenderedChart } from "./render.js";
import { limitForThumbnail } from "./thumbnail-limits.js";

export interface ChartThumbnailInput {
  artifactId: string;
  format: "png" | "svg";
  theme: "light" | "dark";
  width: number;
  height: number;
}

/** What draws a chart: the worker pool in the API, anything else in tests. */
export type ChartRenderer = (job: RenderJob) => Promise<RenderedChart>;

/** Holds the base64 the API returns, the only copy: the budget is what the cache really keeps. */
const cache = new ThumbnailCache<ChartThumbnail>((thumbnail) => thumbnail.contentBase64.length);

/**
 * A saved chart (`*.chart.json`, or a dashboard's first chart) drawn as a PNG or SVG, for the
 * Library card and the feed.
 * Authorised by the artifact lookup, cached by (artifact, version, theme, size, format), cut down
 * to a thumbnail's worth of points and drawn off the event loop in a worker thread.
 */
export async function engineChartThumbnail(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: ChartThumbnailInput,
  render: ChartRenderer = (job) => sharedRenderPool().render(job),
): Promise<ChartThumbnail> {
  const email = await emailOf(deps, actor);
  const meta = await getOmnigentArtifact(client, email, input.artifactId).catch(notFound);
  const dashboard = isDashboardArtifactName(meta.name);
  if (!dashboard && !isChartArtifactName(meta.name)) {
    throw new ORPCError("BAD_REQUEST", { message: "That file is not a chart" });
  }
  const key = [
    input.artifactId,
    meta.version,
    input.theme,
    input.width,
    input.height,
    input.format,
  ].join(":");
  const hit = cache.get(key);
  if (hit)
    return {
      mimeType: hit.mimeType,
      contentBase64: hit.contentBase64,
      width: hit.width,
      height: hit.height,
    };

  const bytes = await fetchOmnigentArtifactContent(
    client,
    email,
    input.artifactId,
    meta.version,
  ).catch(notFound);
  // A dashboard's thumbnail is its first chart, the one it leads with.
  const document = dashboard
    ? (parseDashboardDocument(bytes)?.charts[0] ?? null)
    : parseChartDocument(bytes);
  if (!document) throw new ORPCError("BAD_REQUEST", { message: "That chart file is unreadable" });
  try {
    const image = await render({
      document: limitForThumbnail(document),
      options: {
        width: input.width,
        height: input.height,
        theme: input.theme,
        format: input.format,
      },
    });
    const result = {
      mimeType: image.mimeType,
      contentBase64: image.bytes.toString("base64"),
      width: image.width,
      height: image.height,
    };
    cache.set(key, result);
    return result;
  } catch (error) {
    if (error instanceof RenderBusyError) {
      throw new ORPCError("SERVICE_UNAVAILABLE", { message: error.message });
    }
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `The chart could not be drawn: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
}
