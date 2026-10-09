import { useLingui } from "@lingui/react/macro";
import type { ArtifactTable, TableCell, TableCellEdit } from "@nova/contracts";
import { Button, Tabs, TabsList, TabsTrigger } from "@nova/ui-web";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { rpc } from "../../lib/rpc";
import { createEvaluator } from "./formula-eval";
import { setSheetAsk, sheetAskLabel, useSheetAskAvailable } from "./sheet-ask";
import {
  type CellPos,
  type CellRange,
  cellAt,
  cellFromValue,
  cellKey,
  cellSource,
  cellText,
  colLetter,
  diffTables,
  inRange,
  isNumeric,
  normalizeRange,
  parseDraft,
  rangeCellCount,
  rangeLabel,
  rangeSum,
  revertEdits,
} from "./sheet-model";

const ROW_H = 30;
const HEAD_H = 30;
const GUTTER_W = 48;
const COL_W = 140;
const COL_MIN_W = 48;
const COL_MAX_W = 520;
/** Cell padding (px-2.5 both sides) + the border + a little air. */
const CELL_PAD = 32;
/** The grid body font (text-[13px] in the page's sans). */
const CELL_FONT_SIZE = 13;
/** Average glyph width at the grid font when there is no canvas to measure with. */
const FALLBACK_CHAR_PX = 7.6;
const MEASURE_ROWS = 500;

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** Pixel width of `text` at the grid font, or null where there is no canvas (tests). */
function measureText(text: string, weight: number): number | null {
  if (measureCtx === undefined) {
    try {
      measureCtx = document.createElement("canvas").getContext("2d");
    } catch {
      measureCtx = null;
    }
  }
  if (!measureCtx) return null;
  const family = getComputedStyle(document.body).fontFamily || "sans-serif";
  measureCtx.font = `${weight} ${CELL_FONT_SIZE}px ${family}`;
  return measureCtx.measureText(text).width;
}

/** A column's width in pixels: wide enough for its longest value (the file's character width, or
 * what the cells measure at the grid font, whichever is larger) plus padding, within the cap. */
function columnPx(
  chars: number | null | undefined,
  texts: readonly string[],
  bold: number,
): number {
  const fromChars = chars ? chars * FALLBACK_CHAR_PX : 0;
  let widest = 0;
  let measured = false;
  texts.forEach((text, index) => {
    const px = measureText(text, index < bold ? 600 : 400);
    if (px !== null) {
      measured = true;
      widest = Math.max(widest, px);
    }
  });
  const content = measured ? Math.max(widest, chars ? fromChars * 0.6 : 0) : fromChars;
  if (!chars && !measured) return COL_W;
  return Math.max(COL_MIN_W, Math.min(COL_MAX_W, Math.ceil(content + CELL_PAD)));
}
const OVERSCAN = 8;
/** Used until the grid is measured (and where there is no layout, e.g. tests). */
const FALLBACK_VIEW_H = 640;

/** The calls the viewer makes; the API by default (a fixture in the dev preview). */
export interface SheetSource {
  table(input: { artifactId: string }): Promise<ArtifactTable>;
  listVersions(input: {
    familyId: string;
  }): Promise<Array<{ id: string; origin?: string; parentVersionId?: string | null }>>;
  editTable(input: {
    artifactId: string;
    baseVersion: number;
    edits: TableCellEdit[];
  }): Promise<{ id: string; version: number }>;
  tableRange(input: {
    artifactId: string;
    sheet: string;
    range: string;
  }): Promise<{ block: string }>;
}

type Artifact = { id: string; name: string; version: number };

/** What the version history says about the table on screen. */
type History = {
  /** The newest version: older ones are read-only. */
  newest: boolean;
  /** The person's hand edit is the version on screen. */
  manual: boolean;
  /** Cells changed by hand since the last version Nova saved. */
  changed: Set<string>;
  /** The edits that put the previous version's values back. */
  revert: TableCellEdit[];
};

const NO_HISTORY: History = { newest: true, manual: false, changed: new Set(), revert: [] };

const isConflict = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "CONFLICT";

/** The table calls live on `sheets`, the version list on `artifacts`. */
const defaultSource = {
  table: (input: { artifactId: string }) => rpc.sheets.table(input),
  editTable: (input: Parameters<typeof rpc.sheets.editTable>[0]) => rpc.sheets.editTable(input),
  tableRange: (input: Parameters<typeof rpc.sheets.tableRange>[0]) => rpc.sheets.tableRange(input),
  listVersions: (input: { familyId: string }) => rpc.artifacts.listVersions(input),
};

/** A CSV / XLSX as a grid: read, select, ask Nova about a range, and (behind Edit) change cells.
 * Every edit saves at once as a new version; `onEdited` hands the caller its id. */
export function SheetView({
  artifact,
  onEdited,
  fallback,
  source = defaultSource,
  toolbarHost,
}: {
  artifact: Artifact;
  onEdited?: (artifactId: string) => void;
  /** Shown if the file cannot be read as a table. */
  fallback?: ReactNode;
  source?: SheetSource;
  /** Where the Edit button and the "Edited by you" pill go (the panel's header). Undefined keeps
   * them in a row above the grid; null waits for the host to mount. */
  toolbarHost?: HTMLElement | null;
}) {
  const { t } = useLingui();
  const askAvailable = useSheetAskAvailable();
  const cells = (n: number) => (n === 1 ? t`1 cell` : t`${n} cells`);
  const [table, setTable] = useState<ArtifactTable | null>(null);
  const [failed, setFailed] = useState(false);
  const [history, setHistory] = useState<History>(NO_HISTORY);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [overlay, setOverlay] = useState<ReadonlyMap<string, TableCell>>(new Map());
  const [editMode, setEditMode] = useState(false);
  const [editing, setEditing] = useState<{ r: number; c: number; draft: string } | null>(null);
  const [anchor, setAnchor] = useState<CellPos>({ r: 0, c: 0 });
  const [head, setHead] = useState<CellPos>({ r: 0, c: 0 });
  const [error, setError] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(FALLBACK_VIEW_H);
  const [undoStack, setUndoStack] = useState<TableCellEdit[][]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const settled = useRef(false);
  const canFallbackUndo = useRef(true);
  const loadSeq = useRef(0);
  const headVersion = useRef({ id: artifact.id, version: artifact.version });
  const queue = useRef<Promise<void>>(Promise.resolve());

  const requestedId = useRef<string | null>(null);
  const load = useCallback(
    async (id: string) => {
      const seq = ++loadSeq.current;
      requestedId.current = id;
      try {
        const next = await source.table({ artifactId: id });
        const versions = await source.listVersions({ familyId: id }).catch(() => []);
        const info = await readHistory(source, id, next, versions);
        if (seq !== loadSeq.current) return;
        headVersion.current = { id: next.artifactId, version: next.version };
        setTable(next);
        setHistory(info);
        setOverlay(new Map());
        setFailed(false);
      } catch {
        if (seq === loadSeq.current) setFailed(true);
      }
    },
    [source],
  );

  useEffect(() => {
    // A version this view just saved is already loading.
    if (requestedId.current !== artifact.id) void load(artifact.id);
  }, [artifact.id, load]);

  useEffect(() => {
    const node = scroller.current;
    if (node && node.clientHeight > 0) setViewH(node.clientHeight);
  }, [table]);

  const sheet = table?.sheets[Math.min(sheetIndex, (table?.sheets.length ?? 1) - 1)];
  const sheetName = sheet?.name ?? "";
  const colCount = Math.max(sheet?.rows[0]?.length ?? 0, 1);
  const rowCount = Math.max(sheet?.rows.length ?? 0, 1);
  const frozen = Math.min(sheet?.frozenRows ?? 0, rowCount);
  // Column widths: each column fits its longest value (header row included) at the grid font.
  const colLeft = useMemo(() => {
    const lefts = [0];
    const rows = sheet?.rows.slice(0, MEASURE_ROWS) ?? [];
    for (let c = 0; c < colCount; c += 1) {
      const texts = rows.map(
        (_, r) => cellText(cellAt(sheet as NonNullable<typeof sheet>, r, c)).text,
      );
      lefts.push(
        (lefts[c] as number) +
          columnPx(sheet?.colWidths?.[c], texts, Math.min(sheet?.frozenRows ?? 0, rows.length)),
      );
    }
    return lefts;
  }, [colCount, sheet]);
  const colWidth = (c: number) => (colLeft[c + 1] as number) - (colLeft[c] as number);

  // Formulas the file holds no result for (or whose inputs were just edited) are worked out here.
  const evaluate = useMemo(
    () => createEvaluator(table?.sheets ?? [], (name, r, c) => overlay.get(cellKey(name, r, c))),
    [table, overlay],
  );
  const cell = useCallback(
    (r: number, c: number): TableCell => {
      const raw =
        overlay.get(cellKey(sheetName, r, c)) ??
        (sheet ? cellAt(sheet, r, c) : cellAt(EMPTY_SHEET, r, c));
      if (!raw.f) return raw;
      const computed = evaluate(sheetName, r, c);
      return computed === undefined
        ? raw
        : { ...raw, v: computed, t: typeof computed === "number" ? "n" : raw.t };
    },
    [overlay, sheet, sheetName, evaluate],
  );

  const selection: CellRange = useMemo(() => normalizeRange(anchor, head), [anchor, head]);

  // --- saving -------------------------------------------------------------------------------

  const save = useCallback(
    async (edits: TableCellEdit[]) => {
      try {
        let created: { id: string; version: number };
        const base = headVersion.current;
        try {
          created = await source.editTable({
            artifactId: base.id,
            baseVersion: base.version,
            edits,
          });
        } catch (failure) {
          if (!isConflict(failure)) throw failure;
          // Someone saved in between: take the newest version and apply the change once more.
          const newest = (await source.listVersions({ familyId: base.id }))[0];
          if (!newest) throw failure;
          const fresh = await source.table({ artifactId: newest.id });
          created = await source.editTable({
            artifactId: newest.id,
            baseVersion: fresh.version,
            edits,
          });
        }
        headVersion.current = { id: created.id, version: created.version };
        onEdited?.(created.id);
        await load(created.id);
      } catch {
        setError(t`Couldn't save that change.`);
        await load(headVersion.current.id);
      }
    },
    [load, onEdited, source, t],
  );

  const commit = useCallback(
    (edits: TableCellEdit[], options?: { undo?: boolean }) => {
      if (!sheet || edits.length === 0) return;
      setError(null);
      if (!options?.undo) {
        canFallbackUndo.current = false;
        const before = edits.map((edit) => ({
          ...edit,
          value: cell(edit.row, edit.col).f ?? cell(edit.row, edit.col).v,
        }));
        setUndoStack((stack) => [...stack, before]);
      }
      setOverlay((current) => {
        const next = new Map(current);
        for (const edit of edits) {
          next.set(
            cellKey(edit.sheet, edit.row, edit.col),
            cellFromValue(edit.value, cell(edit.row, edit.col)),
          );
        }
        return next;
      });
      queue.current = queue.current.then(() => save(edits));
    },
    [cell, save, sheet],
  );

  const undoEdits = useMemo<TableCellEdit[] | null>(() => {
    const last = undoStack.at(-1);
    if (last) return last;
    return canFallbackUndo.current && history.manual && history.revert.length > 0
      ? history.revert
      : null;
  }, [undoStack, history]);

  function undo() {
    if (!undoEdits) return;
    if (undoStack.length > 0) setUndoStack((stack) => stack.slice(0, -1));
    else canFallbackUndo.current = false;
    commit(undoEdits, { undo: true });
  }

  // --- selection and keys -------------------------------------------------------------------

  const clamp = useCallback(
    (pos: CellPos): CellPos => ({
      r: Math.max(0, Math.min(rowCount - 1, pos.r)),
      c: Math.max(0, Math.min(colCount - 1, pos.c)),
    }),
    [colCount, rowCount],
  );

  function select(pos: CellPos, extend: boolean) {
    const next = clamp(pos);
    if (!extend) setAnchor(next);
    setHead(next);
  }

  function finishEdit(save: boolean, move?: { dr: number; dc: number }) {
    if (!editing) return;
    const { r, c, draft } = editing;
    setEditing(null);
    if (save && sheet && draft !== cellSource(cell(r, c))) {
      commit([{ sheet: sheetName, row: r, col: c, value: parseDraft(draft) }]);
    }
    if (move) select({ r: r + move.dr, c: c + move.dc }, false);
    window.requestAnimationFrame(() => scroller.current?.focus());
  }

  function onGridKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (editing || !sheet) return;
    const step = (dr: number, dc: number) => {
      event.preventDefault();
      const from = event.shiftKey ? head : anchor;
      select({ r: from.r + dr, c: from.c + dc }, event.shiftKey);
    };
    switch (event.key) {
      case "ArrowDown":
        return step(1, 0);
      case "ArrowUp":
        return step(-1, 0);
      case "ArrowRight":
        return step(0, 1);
      case "ArrowLeft":
        return step(0, -1);
      case "Tab":
        return step(0, event.shiftKey ? -1 : 1);
    }
    if (!editMode) return;
    if (event.key === "Enter" || event.key === "F2") {
      event.preventDefault();
      setEditing({ r: anchor.r, c: anchor.c, draft: cellSource(cell(anchor.r, anchor.c)) });
    } else if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      const edits: TableCellEdit[] = [];
      for (let r = selection.r0; r <= selection.r1; r += 1) {
        for (let c = selection.c0; c <= selection.c1; c += 1) {
          if (cellSource(cell(r, c)) !== "") {
            edits.push({ sheet: sheetName, row: r, col: c, value: null });
          }
        }
      }
      commit(edits.slice(0, 500));
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault();
      setEditing({ r: anchor.r, c: anchor.c, draft: event.key });
    }
  }

  const posOf = (event: ReactMouseEvent): CellPos | null => {
    const td = (event.target as HTMLElement).closest<HTMLElement>("[data-r][data-c]");
    return td ? { r: Number(td.dataset.r), c: Number(td.dataset.c) } : null;
  };

  function onMouseDown(event: ReactMouseEvent) {
    const pos = posOf(event);
    if (!pos || (event.target as HTMLElement).tagName === "INPUT") return;
    if (editing) finishEdit(true);
    dragging.current = true;
    select(pos, event.shiftKey);
    scroller.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    const stop = () => {
      dragging.current = false;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // Keep the active cell in view while arrowing through a big sheet.
  useEffect(() => {
    const node = scroller.current;
    if (!node || !settled.current) {
      settled.current = true;
      return;
    }
    const top = HEAD_H + head.r * ROW_H;
    const frozenH = HEAD_H + frozen * ROW_H;
    if (head.r >= frozen) {
      if (top - ROW_H < node.scrollTop + frozenH - HEAD_H) node.scrollTop = top - frozenH;
      else if (top + ROW_H > node.scrollTop + node.clientHeight) {
        node.scrollTop = top + ROW_H - node.clientHeight;
      }
    }
    const left = GUTTER_W + (colLeft[head.c] ?? 0);
    const width = colLeft[head.c + 1] === undefined ? COL_W : colWidth(head.c);
    if (left < node.scrollLeft + GUTTER_W) node.scrollLeft = left - GUTTER_W;
    else if (left + width > node.scrollLeft + node.clientWidth) {
      node.scrollLeft = left + width - node.clientWidth;
    }
    // biome-ignore lint/correctness/useExhaustiveDependencies: colWidth reads colLeft
  }, [head, frozen, colLeft]);

  // --- ask Nova -----------------------------------------------------------------------------

  const [asking, setAsking] = useState(false);
  async function askNova() {
    if (!sheet) return;
    const label = rangeLabel(selection);
    setAsking(true);
    try {
      const { block } = await source.tableRange({
        artifactId: headVersion.current.id,
        sheet: sheetName,
        range: label,
      });
      const n = rangeCellCount(selection);
      setSheetAsk({
        label: sheetAskLabel(sheetName, label, n),
        block,
      });
    } catch {
      setError(t`Couldn't read that selection.`);
    } finally {
      setAsking(false);
    }
  }

  // --- render -------------------------------------------------------------------------------

  if (failed && !table)
    return <>{fallback ?? <SheetNote>{t`Couldn't open this sheet.`}</SheetNote>}</>;
  if (!table || !sheet) return <SheetNote>{t`Loading…`}</SheetNote>;

  const changedHere = (r: number, c: number) =>
    history.changed.has(cellKey(sheetName, r, c)) || overlay.has(cellKey(sheetName, r, c));
  let changedCount = overlay.size;
  for (const key of history.changed) {
    if (key.startsWith(`${sheetName}\u0000`) && !overlay.has(key)) changedCount += 1;
  }
  const canEdit = history.newest;
  const editOn = editMode && canEdit;
  const first = Math.max(frozen, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);
  const activeCell = cell(anchor.r, anchor.c);
  const barText = editing ? editing.draft : cellSource(activeCell);
  const stats = rangeSum(cell, selection);
  const total = rangeCellCount(selection);
  const label = rangeLabel(selection);

  const toolbar = (
    <>
      {history.manual ? (
        <span className="rounded-full bg-warning/15 px-2 py-0.5 text-[11px] whitespace-nowrap text-warning">
          {t`Edited by you`}
        </span>
      ) : null}
      {canEdit ? (
        <Button
          variant={editMode ? "default" : "secondary"}
          size="sm"
          className="rounded-full"
          aria-pressed={editMode}
          onClick={() => {
            setEditMode((on) => !on);
            setEditing(null);
          }}
        >
          {t`Edit`}
        </Button>
      ) : null}
    </>
  );

  const rowNodes: ReactNode[] = [];
  const pushRow = (r: number) => {
    const isFrozen = r < frozen;
    rowNodes.push(
      <tr key={r} style={{ height: ROW_H }}>
        <th
          scope="row"
          className={`sticky start-0 z-10 border-e border-b border-border bg-muted text-center text-[11px] font-normal tabular-nums ${
            selection.r0 <= r && r <= selection.r1 ? "text-foreground" : "text-muted-foreground"
          }`}
          style={isFrozen ? { top: HEAD_H + r * ROW_H, zIndex: 15 } : undefined}
        >
          {r + 1}
        </th>
        {Array.from({ length: colCount }, (_, c) => {
          const value = cell(r, c);
          const shown = cellText(value);
          const isEditing = editing?.r === r && editing.c === c;
          const active = anchor.r === r && anchor.c === c;
          const selected = inRange(selection, r, c);
          return (
            <td
              key={c}
              data-r={r}
              data-c={c}
              data-selected={selected || undefined}
              onDoubleClick={() => {
                if (editOn) setEditing({ r, c, draft: cellSource(value) });
              }}
              className={[
                "relative cursor-cell truncate border-e border-b border-border px-2.5 text-[13px]",
                isNumeric(value) ? "text-right tabular-nums" : "text-left",
                isFrozen ? "sticky z-[5] bg-muted font-medium" : "bg-card",
                shown.muted ? "text-muted-foreground" : "text-foreground",
                selected && !active ? "bg-primary/10" : "",
                active ? "ring-2 ring-ring ring-inset" : "",
              ].join(" ")}
              style={isFrozen ? { top: HEAD_H + r * ROW_H } : undefined}
              title={isEditing || !shown.text ? undefined : shown.text}
            >
              {isEditing ? (
                <CellEditor
                  draft={editing.draft}
                  onChange={(draft) => setEditing({ r, c, draft })}
                  onDone={finishEdit}
                />
              ) : (
                shown.text
              )}
              {changedHere(r, c) ? (
                <span
                  role="img"
                  aria-label={t`Edited by you`}
                  className="absolute end-1 top-1 size-1.5 rounded-full bg-warning"
                />
              ) : null}
            </td>
          );
        })}
      </tr>,
    );
  };
  for (let r = 0; r < frozen; r += 1) pushRow(r);
  if (first > frozen) {
    rowNodes.push(<tr key="pad-top" aria-hidden style={{ height: (first - frozen) * ROW_H }} />);
  }
  for (let r = first; r < last; r += 1) pushRow(r);
  if (last < rowCount) {
    rowNodes.push(
      <tr key="pad-bottom" aria-hidden style={{ height: (rowCount - last) * ROW_H }} />,
    );
  }

  return (
    <div data-testid="sheet-view" className="flex h-full min-h-0 flex-col bg-background">
      {toolbarHost === undefined ? (
        <div className="flex shrink-0 items-center justify-end gap-2 px-4 pt-3">{toolbar}</div>
      ) : toolbarHost ? (
        createPortal(toolbar, toolbarHost)
      ) : null}

      {table.sheets.length > 1 ? (
        <Tabs
          value={String(sheetIndex)}
          onValueChange={(value) => {
            setSheetIndex(Number(value));
            setAnchor({ r: 0, c: 0 });
            setHead({ r: 0, c: 0 });
            setEditing(null);
            if (scroller.current) scroller.current.scrollTop = 0;
            setScrollTop(0);
          }}
          className="shrink-0 px-4 pt-2"
        >
          <TabsList variant="line" aria-label={t`Sheets`}>
            {table.sheets.map((entry, index) => (
              <TabsTrigger key={entry.name} value={String(index)}>
                {entry.name}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      ) : null}

      <div className="mx-4 mt-2.5 flex shrink-0 items-center gap-2.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px]">
        <b className="min-w-10 font-medium text-muted-foreground tabular-nums">
          {rangeLabel({ r0: anchor.r, c0: anchor.c, r1: anchor.r, c1: anchor.c })}
        </b>
        <span data-testid="formula-bar" className="min-w-0 flex-1 truncate font-mono text-[12.5px]">
          {barText}
        </span>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: a spreadsheet grid is a focus-managed region */}
      <div
        ref={scroller}
        role="grid"
        tabIndex={0}
        aria-label={sheetName}
        aria-readonly={!editOn}
        onKeyDown={onGridKeyDown}
        onMouseDown={onMouseDown}
        onMouseMove={(event) => {
          if (!dragging.current) return;
          const pos = posOf(event);
          if (pos) setHead((now) => (now.r === pos.r && now.c === pos.c ? now : pos));
        }}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        className="relative mx-4 mt-2.5 min-h-0 flex-1 overflow-auto rounded-xl border border-border outline-none select-none focus-visible:border-ring/60"
      >
        <table
          className="border-separate border-spacing-0 table-fixed"
          style={{ width: GUTTER_W + (colLeft[colCount] ?? 0) }}
        >
          <colgroup>
            <col style={{ width: GUTTER_W }} />
            {Array.from({ length: colCount }, (_, c) => (
              <col key={c} style={{ width: colWidth(c) }} />
            ))}
          </colgroup>
          <thead>
            <tr style={{ height: HEAD_H }}>
              <th className="sticky start-0 top-0 z-30 border-e border-b border-border bg-muted" />
              {Array.from({ length: colCount }, (_, c) => (
                <th
                  key={c}
                  scope="col"
                  className={`sticky top-0 z-20 border-e border-b border-border text-[11px] font-normal ${
                    selection.c0 <= c && c <= selection.c1
                      ? "bg-accent text-foreground"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {colLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{rowNodes}</tbody>
        </table>
      </div>

      {sheet.truncated ? (
        <p className="mx-4 mt-2 shrink-0 text-[12px] text-muted-foreground">
          {t`Showing the first ${sheet.rows.length} rows`}
        </p>
      ) : null}

      {askAvailable ? (
        <div className="mx-4 mt-3 flex shrink-0 flex-wrap items-center gap-2.5">
          <Button
            size="sm"
            className="rounded-full"
            disabled={asking}
            onClick={() => void askNova()}
          >
            {t`Ask Nova about ${label}`}
          </Button>
          <span className="text-[12px] text-muted-foreground tabular-nums">
            {cells(total)}
            {stats.numeric > 0 ? ` · ${t`Sum ${formatSum(stats.sum)}`}` : ""}
          </span>
        </div>
      ) : null}

      <div className="mx-4 my-3 flex shrink-0 flex-col gap-2">
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
        {changedCount > 0 ? (
          <div
            data-testid="sheet-changes"
            className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-warning/40 bg-warning/10 px-3 py-2"
          >
            <span aria-hidden className="size-2 rounded-full bg-warning" />
            <span className="min-w-0 flex-1 basis-60 text-[13px]">
              {changedCount === 1
                ? t`You changed 1 cell on ${sheetName}. Nova sees this before its next reply.`
                : t`You changed ${changedCount} cells on ${sheetName}. Nova sees this before its next reply.`}
            </span>
            {undoEdits ? (
              <Button variant="outline" size="sm" className="rounded-full" onClick={undo}>
                {t`Undo`}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

const EMPTY_SHEET = { rows: [] } as unknown as Parameters<typeof cellAt>[0];

const formatSum = (value: number): string =>
  Number.isInteger(value) ? value.toLocaleString("en-US") : String(Math.round(value * 100) / 100);

function SheetNote({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center px-6 text-center text-[13.5px] text-muted-foreground">
      {children}
    </div>
  );
}

function CellEditor({
  draft,
  onChange,
  onDone,
}: {
  draft: string;
  onChange: (draft: string) => void;
  onDone: (save: boolean, move?: { dr: number; dc: number }) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const input = ref.current;
    if (!input) return;
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }, []);
  const finish = (save: boolean, move?: { dr: number; dc: number }) => {
    if (done.current) return;
    done.current = true;
    onDone(save, move);
  };
  return (
    <input
      ref={ref}
      value={draft}
      spellCheck={false}
      aria-label="Cell"
      onChange={(event) => onChange(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true, { dr: event.shiftKey ? -1 : 1, dc: 0 });
        } else if (event.key === "Tab") {
          event.preventDefault();
          finish(true, { dr: 0, dc: event.shiftKey ? -1 : 1 });
        } else if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
      className="absolute inset-0 w-full bg-card px-2.5 font-mono text-[12.5px] text-foreground outline-none ring-2 ring-ring ring-inset"
    />
  );
}

/** Which version this is, and what the person changed by hand since Nova's last save. */
async function readHistory(
  source: SheetSource,
  id: string,
  current: ArtifactTable,
  versions: ReadonlyArray<{
    id: string;
    origin?: string;
    parentVersionId?: string | null;
  }>,
): Promise<History> {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const here = byId.get(id);
  const info: History = { ...NO_HISTORY, newest: versions.length === 0 || versions[0]?.id === id };
  if (here?.origin !== "manual" || !here.parentVersionId) return info;
  // Walk back to the last version Nova (or a restore) saved: that is what "changed" is against.
  let baseId = here.parentVersionId;
  for (let step = 0; step < 50; step += 1) {
    const entry = byId.get(baseId);
    if (entry?.origin !== "manual" || !entry.parentVersionId) break;
    baseId = entry.parentVersionId;
  }
  try {
    const parent = await source.table({ artifactId: here.parentVersionId });
    const base =
      baseId === here.parentVersionId ? parent : await source.table({ artifactId: baseId });
    const changed = new Set(
      diffTables(base.sheets, current.sheets).map((d) => cellKey(d.sheet, d.row, d.col)),
    );
    return {
      ...info,
      manual: true,
      changed,
      revert: revertEdits(diffTables(parent.sheets, current.sheets)),
    };
  } catch {
    return { ...info, manual: true };
  }
}
