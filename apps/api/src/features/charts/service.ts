import type { OmnigentClientConfig } from "@nova/adapters";
import { parseChartDocument } from "@nova/charts";
import { type Actor, type ChartThumbnail, isChartArtifactName } from "@nova/contracts";
import { ORPCError } from "@orpc/server";
import { type EngineArtifactsDeps, engineGetArtifact } from "../artifacts/index.js";
import { renderChart } from "./render.js";

export interface ChartThumbnailInput {
  artifactId: string;
  format: "png" | "svg";
  theme: "light" | "dark";
  width: number;
  height: number;
}

/** A saved chart (`*.chart.json`) drawn as a PNG or SVG, for the Library card and the feed. */
export async function engineChartThumbnail(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: ChartThumbnailInput,
): Promise<ChartThumbnail> {
  const artifact = await engineGetArtifact(deps, client, actor, input.artifactId);
  if (!isChartArtifactName(artifact.name)) {
    throw new ORPCError("BAD_REQUEST", { message: "That file is not a chart" });
  }
  const document = parseChartDocument(Buffer.from(artifact.contentBase64, "base64"));
  if (!document) throw new ORPCError("BAD_REQUEST", { message: "That chart file is unreadable" });
  try {
    const image = renderChart(document, input);
    return {
      mimeType: image.mimeType,
      contentBase64: image.bytes.toString("base64"),
      width: image.width,
      height: image.height,
    };
  } catch (error) {
    throw new ORPCError("INTERNAL_SERVER_ERROR", {
      message: `The chart could not be drawn: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
}
