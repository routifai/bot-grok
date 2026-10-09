import type { ArtifactExtension } from "../artifacts";
import { SheetView } from "./SheetView";
import { SHEET_MIME_TYPES } from "./sheet-model";

/** Opens CSV / XLSX files in the sheet viewer and gives its panel the wider width. */
export const sheetsExtension: ArtifactExtension = {
  usePanel: ({ artifact }) => ({ wide: !!artifact && SHEET_MIME_TYPES.has(artifact.mimeType) }),
  card: () => null,
  view: ({ artifact, onEdited, toolbarHost, fallback }) =>
    SHEET_MIME_TYPES.has(artifact.mimeType) ? (
      <SheetView
        artifact={artifact}
        onEdited={onEdited}
        toolbarHost={toolbarHost}
        fallback={fallback}
      />
    ) : null,
};
