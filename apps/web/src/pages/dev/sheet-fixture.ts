import type { ArtifactTable, TableCell, TableCellEdit } from "@nova/contracts";

const num = (v: number): TableCell => ({ v, f: null, t: "n" });
const str = (v: string): TableCell => ({ v, f: null, t: "s" });
const formula = (f: string): TableCell => ({ v: null, f, t: null });
const toCell = (value: TableCellEdit["value"]): TableCell =>
  value === null
    ? { v: null, f: null, t: null }
    : typeof value === "string" && value.startsWith("=")
      ? formula(value)
      : { v: value, f: null, t: typeof value === "number" ? "n" : "s" };

const SALES: Array<[string, string, number, number, string, string]> = [
  ["Ontario", "Northwind", 64000, 120, "Maya Chen", "2026-07-14"],
  ["Quebec", "Acme Corp", 48000, 90, "Luc Martin", "2026-07-22"],
  ["BC", "Fabrikam", 21500, 40, "Priya Shah", "2026-08-03"],
  ["Alberta", "Contoso", 17900, 35, "Sam Lee", "2026-08-11"],
  ["Ontario", "Litware", 12900, 22, "Maya Chen", "2026-08-19"],
  ["Quebec", "Tailspin", 9800, 18, "Luc Martin", "2026-09-02"],
  ["BC", "Adatum", 7450, 14, "Priya Shah", "2026-09-16"],
];

function baseTable(): ArtifactTable {
  const rows: TableCell[][] = [
    ["Region", "Account", "Revenue (CAD)", "Units", "Rep", "Closed"].map(str),
    ...SALES.map(([a, b, c, d, e, f]) => [str(a), str(b), num(c), num(d), str(e), str(f)]),
    [str("Total"), str(""), formula("=SUM(C2:C8)"), formula("=SUM(D2:D8)"), str(""), str("")],
  ];
  const region: TableCell[][] = [
    [str("Region"), str("Revenue")],
    [str("Ontario"), formula("=SUM(Sales!C2,Sales!C6)")],
    [str("Quebec"), formula("=Sales!C3+Sales!C7")],
  ];
  return {
    artifactId: "v1",
    version: 1,
    kind: "xlsx",
    sheets: [
      { name: "Sales", rows, frozenRows: 1, nRows: rows.length, nCols: 6, truncated: false },
      {
        name: "By region",
        rows: region,
        frozenRows: 1,
        nRows: region.length,
        nCols: 2,
        truncated: false,
      },
    ],
  };
}

/** An in-memory workbook that answers the viewer's calls like the API (versions, edits). */
export function createSheetFixtureSource() {
  const versions: Array<{ table: ArtifactTable; origin: string; parent: string | null }> = [
    { table: baseTable(), origin: "ai", parent: null },
  ];
  const find = (id: string) => versions.find((entry) => entry.table.artifactId === id);
  const source = {
    table: async ({ artifactId }: { artifactId: string }) => {
      const found = find(artifactId);
      if (!found) throw new Error("missing");
      return structuredClone(found.table);
    },
    listVersions: async () =>
      [...versions].reverse().map((entry) => ({
        id: entry.table.artifactId,
        version: entry.table.version,
        name: "q3-sales-clean.xlsx",
        createdAt: "",
        origin: entry.origin,
        parentVersionId: entry.parent,
      })),
    editTable: async (input: {
      artifactId: string;
      baseVersion: number;
      edits: TableCellEdit[];
    }) => {
      const from = find(input.artifactId);
      if (!from || from.table.version !== versions.length) throw { code: "CONFLICT" };
      const next = structuredClone(from.table);
      next.artifactId = `v${versions.length + 1}`;
      next.version = versions.length + 1;
      for (const edit of input.edits) {
        const sheet = next.sheets.find((entry) => entry.name === edit.sheet);
        const row = sheet?.rows[edit.row];
        if (row) row[edit.col] = toCell(edit.value);
      }
      versions.push({ table: next, origin: "manual", parent: from.table.artifactId });
      return { id: next.artifactId, version: next.version };
    },
    tableRange: async ({ range }: { range: string }) => ({
      version: versions.length,
      block: `[selection ${range}]`,
    }),
  };
  return { source, head: "v1" };
}
