import { useLingui } from "@lingui/react/macro";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@nova/ui-web";
import { Check, ChevronDown, Download, Loader2, Pencil, Presentation, X } from "lucide-react";
import { downloadArtifactBytes } from "../../lib/artifact-open";
import type { DeckExportFormat, ExportState } from "./DeckExport";
import { requestDeckPresent, setDeckEditing, useDeckEditing } from "./deck-ui-state";

/** The deck panel's right-hand header controls: Edit, Present and one Download menu. Progress,
 * failure and the "added to your Library" note all show on the Download button itself. */
export function DeckHeaderActions({
  deckKey,
  state,
  onExport,
  onCancel,
  source,
}: {
  /** The deck's file name: the key edit mode and present requests are stored under. */
  deckKey: string;
  state: ExportState;
  onExport: (format: DeckExportFormat) => void;
  onCancel: () => void;
  /** The deck's own HTML, for "HTML (source)". */
  source: { name: string; mimeType: string; bytes: Uint8Array } | undefined;
}) {
  const { t } = useLingui();
  const editing = useDeckEditing(deckKey);
  const working = state.kind === "working";

  const label =
    state.kind === "working"
      ? state.format === "pptx"
        ? t`Preparing PowerPoint…`
        : t`Preparing PDF…`
      : state.kind === "done"
        ? t`Added to your Library`
        : state.kind === "error"
          ? state.format === "pptx"
            ? t`Couldn't prepare PowerPoint`
            : t`Couldn't prepare PDF`
          : t`Download`;

  return (
    <>
      <Button
        variant={editing ? "default" : "secondary"}
        size="sm"
        aria-pressed={editing}
        onClick={() => setDeckEditing(deckKey, !editing)}
      >
        <Pencil size={13} />
        {t`Edit`}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => requestDeckPresent(deckKey)}>
        <Presentation size={13} />
        {t`Present`}
      </Button>
      {state.kind === "error" ? (
        <Button
          variant="secondary"
          size="sm"
          data-testid="deck-download"
          onClick={() => onExport(state.format)}
        >
          <span className="text-muted-foreground">{label}</span>
          <span>{t`Try again`}</span>
        </Button>
      ) : working ? (
        <span className="inline-flex items-center gap-1">
          <Button
            variant="secondary"
            size="sm"
            data-testid="deck-download"
            disabled
            aria-busy="true"
          >
            <Loader2 className="animate-spin motion-reduce:animate-none" />
            {label}
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label={t`Cancel`} onClick={onCancel}>
            <X />
          </Button>
        </span>
      ) : (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="secondary" size="sm" data-testid="deck-download" />}
          >
            {state.kind === "done" ? <Check size={13} /> : <Download size={13} />}
            <span role={state.kind === "done" ? "status" : undefined}>{label}</span>
            <ChevronDown size={12} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => onExport("pptx")}
            >{t`PowerPoint (.pptx)`}</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onExport("pdf")}>{t`PDF`}</DropdownMenuItem>
            <DropdownMenuItem
              disabled={!source}
              onClick={() =>
                source && downloadArtifactBytes(source.name, source.mimeType, source.bytes)
              }
            >
              {t`HTML (source)`}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </>
  );
}
