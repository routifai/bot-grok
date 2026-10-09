// `sheets.*` for Muses whose files the engine owns: a CSV / XLSX deliverable read as grids and
// hand-edited into new versions.
import {
  editOmnigentTable,
  getOmnigentTable,
  getOmnigentTableRange,
  type OmnigentClientConfig,
  OmnigentTableConflictError,
} from "@nova/adapters";
import type { Actor, Artifact, ArtifactTable, TableCellEdit } from "@nova/contracts";
import { ORPCError } from "@orpc/server";
import { type EngineArtifactsDeps, emailOf, notFound, toArtifact } from "../artifacts/index.js";

/** A CSV / XLSX version as grids (the engine's `{v, f, t}` cells, camel-cased). */
export async function engineGetTable(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  artifactId: string,
): Promise<ArtifactTable> {
  const table = await getOmnigentTable(client, await emailOf(deps, actor), artifactId).catch(
    notFound,
  );
  return {
    artifactId: table.artifact_id,
    version: table.version,
    kind: table.kind,
    sheets: table.sheets.map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows,
      frozenRows: sheet.frozen_rows,
      nRows: sheet.n_rows,
      nCols: sheet.n_cols,
      truncated: sheet.truncated,
      ...(sheet.col_widths ? { colWidths: sheet.col_widths } : {}),
    })),
  };
}

/** Cell edits as a new manual version. A stale `baseVersion` is a CONFLICT the web reloads from. */
export async function engineEditTable(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { artifactId: string; baseVersion: number; edits: TableCellEdit[] },
): Promise<Artifact> {
  try {
    const created = await editOmnigentTable(
      client,
      await emailOf(deps, actor),
      input.artifactId,
      input.baseVersion,
      input.edits,
    );
    return toArtifact(created, null);
  } catch (error) {
    if (error instanceof OmnigentTableConflictError) {
      throw new ORPCError("CONFLICT", { message: error.message });
    }
    return notFound(error);
  }
}

export async function engineGetTableRange(
  deps: EngineArtifactsDeps,
  client: OmnigentClientConfig,
  actor: Actor,
  input: { artifactId: string; sheet: string; range: string },
): Promise<{ version: number; block: string }> {
  const email = await emailOf(deps, actor);
  try {
    const { version, block } = await getOmnigentTableRange(
      client,
      email,
      input.artifactId,
      input.sheet,
      input.range,
    );
    return { version, block };
  } catch (error) {
    if (error instanceof Error && /\(400\)/.test(error.message)) {
      throw new ORPCError("BAD_REQUEST", { message: "That selection can't be read." });
    }
    return notFound(error);
  }
}
