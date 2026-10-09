// Capability folders: the same capability name in every layer (engine `superchat/<cap>/`, api
// `features/<cap>/`, adapters `omnigent/<cap>.ts`, contracts `rpc/<cap>.ts`, web
// `features/<cap>/`). This test fails on any import from one capability into another, except
//   - the declared BASES (a capability may sit on top of its base, through the base's public
//     `__init__.py` / `index.ts` only), and
//   - the composition roots (the files that wire every capability together).
// Edges that existed before a capability moved are listed in BASELINE. It is a ratchet: a new
// edge fails, and an entry that no longer exists fails too, so the list can only shrink.
import { readdirSync, readFileSync } from "node:fs";
import { posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type LayerName = "engine" | "api" | "adapters" | "contracts" | "web";

/** Capabilities already in capability layout, per layer. Add a name here as it moves. */
const CAPABILITIES: Record<LayerName, readonly string[]> = {
  engine: [
    "activity",
    "admin",
    "approvals",
    "apps",
    "artifacts",
    "computer",
    "daily-notes",
    "decks",
    "feed",
    "goals",
    "ideas",
    "memory",
    "models",
    "sheets",
    "side-chats",
    "skills",
    "vault",
  ],
  api: [
    "activity",
    "admin",
    "approvals",
    "apps",
    "artifacts",
    "computer",
    "daily-notes",
    "decks",
    "feed",
    "goals",
    "ideas",
    "memory",
    "models",
    "sheets",
    "side-chats",
    "skills",
    "vault",
  ],
  adapters: [
    "activity",
    "approvals",
    "apps",
    "artifacts",
    "computer",
    "daily-notes",
    "decks",
    "feed",
    "goals",
    "ideas",
    "memory",
    "models",
    "sheets",
    "side-chats",
    "skills",
    "vault",
  ],
  contracts: [
    "activity",
    "admin",
    "approvals",
    "apps",
    "artifacts",
    "computer",
    "daily-notes",
    "decks",
    "feed",
    "goals",
    "ideas",
    "memory",
    "models",
    "sheets",
    "side-chats",
    "skills",
    "vault",
  ],
  web: [
    "activity",
    "admin",
    "approvals",
    "apps",
    "artifacts",
    "computer",
    "daily-notes",
    "decks",
    "feed",
    "goals",
    "ideas",
    "memory",
    "models",
    "sheets",
    "side-chats",
    "skills",
    "vault",
  ],
};

/** `capability -> capabilities it may import`, through their public entry point only. */
const BASES: Record<string, readonly string[]> = {
  // A deck is a saved HTML artifact (`*.deck.html`); exports are saved back as artifacts.
  decks: ["artifacts"],
  sheets: ["artifacts"],
  apps: ["artifacts"],
  admin: ["models"],
  skills: ["computer"],
  computer: ["artifacts"],
};

/**
 * Edges that exist today and are not allowed: `"<layer>:<file relative to the layer root> ->
 * <capability>"`. Remove an entry when the edge is gone; never add one without a reason.
 */
const BASELINE: readonly string[] = [
  // The bootstrap payload says whether the person still needs a model; that is the models
  // capability's answer (engine key/budget status). Goes away when bootstrap assembles per-
  // capability contributions instead of reaching into each one.
  "api:routers/shared.ts -> models",
  // The transcript draws a saved file (message block, reply card) with the artifacts file card;
  // goes away when the conversation and cards move into their folders and take a block extension
  // point.
  "web:components/cards/ReplyCard.tsx -> artifacts",
  "web:pages/muse/conversation/MessageView.test.tsx -> artifacts",
  "web:pages/muse/conversation/MessageView.tsx -> artifacts",
  // Tests of the apps extension mount the artifact host (ArtifactPanel, LibraryCard) and stub its
  // preview/thumbnail modules by path; they test the seam from the host side.
  "web:features/apps/LibraryCardPublished.test.tsx -> artifacts",
  "web:features/apps/PublishApp.test.tsx -> artifacts",
  // The sheet "ask about this selection" chip lives in the composer and the message view; it
  // needs a composer/message extension point, which comes when those move into their folders.
  // The transcript attaches each message's Forks (side-chats forks.py: forks_by_anchor,
  // attach_forks); goes away when the transcript takes a per-message attachment hook that
  // side-chats registers.
  "engine:transcript/routes.py -> side-chats",
  // The thread snapshot carries the Computer's status and builds its base value with the
  // computer mapper (toComputerStatus); goes away when the snapshot takes `computer` only from
  // the shell (withComputer) and drops the local-sandbox base.
  "api:thread-target.ts -> computer",
  // The conversation draws a Helper's row and the working line from the Activity feed (activity
  // rows, tree, durations, the run dialog); goes away when the conversation moves into its folder
  // and takes a Helper-row extension point.
  "web:pages/muse/conversation/HelperTracker.test.tsx -> activity",
  "web:pages/muse/conversation/HelperTracker.tsx -> activity",
  "web:pages/muse/conversation/WorkingRow.tsx -> activity",
  // The sidebar's status line counts Nova's running work (useNovaWork: runs + Activity feed);
  // goes away when the sidebar moves into its folder or takes the count from the shell.
  "web:pages/muse/chrome/MuseSidebar.tsx -> activity",
  // The transcript draws an ask block (and a skill offer) with the approvals AskCard; goes away
  // when the conversation moves into its folder and takes a block extension point, like the
  // artifact card above.
  "web:pages/muse/conversation/MessageView.test.tsx -> approvals",
  "web:pages/muse/conversation/MessageView.tsx -> approvals",
  // The same block extension point will draw the taught-skill draft card (skills SkillDraftCard).
  "web:pages/muse/conversation/MessageView.test.tsx -> skills",
  "web:pages/muse/conversation/MessageView.tsx -> skills",
  // Answering an inline ask from the composer calls asks.answer and tells the Asks list (the
  // waiting sheet, the Feed) to refetch; goes away when the composer takes an "answered an ask"
  // callback from the shell.
  "web:pages/muse/conversation/useComposerSend.ts -> approvals",
  // The Muse's live state (waiting face, sidebar badge) counts the open Asks (useAsks); goes away
  // when the shell passes the count in instead of the state hook reaching into approvals.
  "web:pages/muse/chrome/useMuseLiveState.test.tsx -> approvals",
  "web:pages/muse/chrome/useMuseLiveState.ts -> approvals",
  // The General settings panel lists the standing approval rules (ApprovalRulesSettings); goes
  // away when the settings panels take their sections from the settings overlay.
  "web:pages/muse/settings/GeneralPanel.tsx -> approvals",
  // The transcript draws the Fork gutter and branch icon under each message, and the sidebar lists
  // the Side Chats and Forks (their row model, live dot and list state); both go away when the
  // conversation and the sidebar move into their folders and take a Side-Chat extension point.
  "web:pages/muse/chrome/MuseSidebar.tsx -> side-chats",
  "web:pages/muse/conversation/MessageHoverActions.tsx -> side-chats",
  "web:pages/muse/conversation/Transcript.tsx -> side-chats",
  // The conversation's hooks keep the Computer's store, screen link and launch stage in step with
  // the thread (read the screen link, show "Starting your Computer", mirror the store into the
  // panel header); goes away when the conversation moves into its folder and takes the Computer
  // as an injected store.
  "web:pages/muse/chrome/SidePanelHeader.tsx -> computer",
  "web:pages/muse/chrome/useMuseLiveState.ts -> computer",
  "web:pages/muse/conversation/useComposerSend.ts -> computer",
  "web:pages/muse/conversation/useThreadSync.ts -> computer",
];

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

interface Layer {
  name: LayerName;
  /** Absolute root directory the layer is scanned from. */
  root: string;
  extensions: readonly string[];
  /** Composition roots, relative to `root`: they may import any capability. */
  composition: readonly RegExp[];
  /** The capability folder a root-relative path (extension optional) belongs to, or null. */
  capOf(path: string): string | null;
  /** True when a path inside the capability is its public entry point. */
  isPublic(path: string, cap: string): boolean;
}

const stem = (segment: string): string => segment.split(".")[0] ?? segment;

/** `features/<cap>/…` layout shared by api and web. */
function featuresLayout(name: "api" | "web", root: string, composition: RegExp[]): Layer {
  return {
    name,
    root: `${REPO}${root}`,
    extensions: [".ts", ".tsx"],
    composition,
    capOf(path) {
      const [dir, cap] = path.split("/");
      return dir === "features" && cap ? stem(cap) : null;
    },
    isPublic(path, cap) {
      return new RegExp(`^features/${cap}(/index)?(\\.[a-z]+)?$`).test(path);
    },
  };
}

/** `<dir>/<cap>.ts` or `<dir>/<cap>/…` layout shared by adapters and contracts. */
function fileLayout(
  name: "adapters" | "contracts",
  root: string,
  dir: string,
  composition: RegExp[],
): Layer {
  return {
    name,
    root: `${REPO}${root}`,
    extensions: [".ts", ".tsx"],
    composition,
    capOf(path) {
      const [first, cap] = path.split("/");
      return first === dir && cap ? stem(cap) : null;
    },
    isPublic(path, cap) {
      return new RegExp(`^${dir}/${cap}(/index)?(\\.[a-z]+)?$`).test(path);
    },
  };
}

const LAYERS: readonly Layer[] = [
  {
    name: "engine",
    root: `${REPO}engine/omnigent/omnigent/superchat`,
    extensions: [".py"],
    composition: [/^features\.py$/],
    capOf: (path) => {
      const [first] = path.split("/");
      return first && path.includes("/") ? first.replaceAll("_", "-") : null;
    },
    isPublic: (path) => /\/__init__\.py$/.test(path),
  },
  featuresLayout("api", "apps/api/src", [/^router\.ts$/, /^app\.ts$/, /^routers\/context\.ts$/]),
  fileLayout("adapters", "packages/adapters/src", "omnigent", [
    /^index\.ts$/,
    /^omnigent\/client\.ts$/,
  ]),
  fileLayout("contracts", "packages/contracts/src", "rpc", [/^rpc\.ts$/, /^index\.ts$/]),
  featuresLayout("web", "apps/web/src", [
    /^App\.tsx$/,
    /^pages\/Shell(\.test)?\.tsx$/,
    /^pages\/SettingsOverlay(\.test)?\.tsx$/,
    /^pages\/AccountSettingsOverlay(\.test)?\.tsx$/,
    /^pages\/muse\/NovaSettingsPanel(\.test)?\.tsx$/,
    /^pages\/muse\/chrome\/ContextPanel\.tsx$/,
    /^pages\/dev\//,
  ]),
];

const SKIPPED = new Set(["node_modules", "dist", "__pycache__", ".venv", ".turbo"]);

function listFiles(layer: Layer): string[] {
  return readdirSync(layer.root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && layer.extensions.some((ext) => entry.name.endsWith(ext)))
    .map((entry) =>
      relative(layer.root, `${entry.parentPath}${sep}${entry.name}`).split(sep).join("/"),
    )
    .filter((path) => !path.split("/").some((segment) => SKIPPED.has(segment)));
}

const TS_SPECIFIER =
  /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\bvi\.(?:mock|doMock|importActual|importMock|unmock)\s*\(\s*)["']([^"']+)["']/g;

/** Every module specifier a TS/TSX source names (`from`, `import()`, side-effect import, vi.mock). */
function tsSpecifiers(source: string): string[] {
  return [...source.matchAll(TS_SPECIFIER)].map((match) => match[1] as string);
}

const PY_IMPORT = /^\s*(?:from|import)\s+omnigent\.superchat\.(\w+)((?:\.\w+)*)/gm;

/** `[first segment, deeper submodule path]` of every `omnigent.superchat.<x>` import. */
function pySuperchatImports(source: string): Array<{ top: string; rest: string }> {
  return [...source.matchAll(PY_IMPORT)].map((match) => ({
    top: match[1] as string,
    rest: match[2] as string,
  }));
}

interface Edge {
  /** Path of the imported module relative to the layer root (no extension fix-ups). */
  target: string;
}

function tsEdges(file: string, source: string): Edge[] {
  const edges: Edge[] = [];
  for (const specifier of tsSpecifiers(source)) {
    if (!specifier.startsWith(".")) continue;
    const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
    if (resolved.startsWith("..")) continue;
    edges.push({ target: resolved });
  }
  return edges;
}

function pyEdges(source: string): Edge[] {
  return pySuperchatImports(source).map(({ top, rest }) => ({
    // A bare `omnigent.superchat.<cap>` is the package, i.e. its `__init__.py`.
    target: rest ? `${top}${rest.replaceAll(".", "/")}.py` : `${top}/__init__.py`,
  }));
}

/** The violations (`"<layer>:<file> -> <cap>"`) one layer has today. */
function violationsOf(
  layer: Layer,
  capabilities: readonly string[],
  files: ReadonlyMap<string, string>,
): string[] {
  const known = new Set(capabilities);
  const found = new Set<string>();
  for (const [file, source] of files) {
    if (layer.composition.some((root) => root.test(file))) continue;
    const from = layer.capOf(file);
    const owner = from !== null && known.has(from) ? from : null;
    const edges = layer.name === "engine" ? pyEdges(source) : tsEdges(file, source);
    for (const { target } of edges) {
      const candidate = layer.capOf(target);
      if (candidate === null || !known.has(candidate) || candidate === owner) continue;
      const allowedBase =
        owner !== null &&
        (BASES[owner] ?? []).includes(candidate) &&
        layer.isPublic(target, candidate);
      if (!allowedBase) found.add(`${layer.name}:${file} -> ${candidate}`);
    }
  }
  return [...found].sort();
}

function read(layer: Layer): Map<string, string> {
  return new Map(
    listFiles(layer).map((file) => [file, readFileSync(`${layer.root}/${file}`, "utf8")]),
  );
}

describe("feature boundaries", () => {
  const found = LAYERS.flatMap((layer) =>
    violationsOf(layer, CAPABILITIES[layer.name], read(layer)),
  );

  it("has no cross-capability edge outside the baseline", () => {
    expect(found.filter((edge) => !BASELINE.includes(edge))).toEqual([]);
  });

  it("keeps no baseline entry for an edge that is gone", () => {
    expect(BASELINE.filter((edge) => !found.includes(edge))).toEqual([]);
  });

  it("only names capabilities that exist as folders", () => {
    for (const layer of LAYERS) {
      const folders = new Set(listFiles(layer).map((file) => layer.capOf(file)));
      for (const cap of CAPABILITIES[layer.name]) expect(folders.has(cap)).toBe(true);
    }
  });
});

describe("boundary scanner", () => {
  const web = LAYERS.find((layer) => layer.name === "web") as Layer;
  const engine = LAYERS.find((layer) => layer.name === "engine") as Layer;

  it("reads from, import(), side-effect import and vi.mock specifiers", () => {
    const source = [
      `import { a } from "./a.js";`,
      `export * from '../b';`,
      `const c = await import("./c");`,
      `import "./d.css";`,
      `vi.mock("./e", () => ({}));`,
    ].join("\n");
    expect(tsSpecifiers(source)).toEqual(["./a.js", "../b", "./c", "./d.css", "./e"]);
  });

  it("reads superchat python imports with their submodule", () => {
    const source = [
      "from omnigent.superchat.artifacts import store",
      "    from omnigent.superchat.artifacts.store import X",
      "import omnigent.superchat.apps.routes as r",
      "from omnigent.superchat import feature",
    ].join("\n");
    expect(pySuperchatImports(source)).toEqual([
      { top: "artifacts", rest: "" },
      { top: "artifacts", rest: ".store" },
      { top: "apps", rest: ".routes" },
    ]);
  });

  it("flags a cross-capability import, allows a base through its entry point only", () => {
    const files = new Map([
      ["features/apps/a.ts", `import "../sheets/x.js"; import "../artifacts/index.js";`],
      ["features/sheets/b.ts", `import "../artifacts/store.js"; import "../../lib/core.js";`],
      ["lib/core.ts", `import "../features/apps/a.js";`],
      ["App.tsx", `import "./features/apps/a.js";`],
    ]);
    expect(violationsOf(web, ["apps", "sheets", "artifacts"], files)).toEqual([
      "web:features/apps/a.ts -> sheets",
      "web:features/sheets/b.ts -> artifacts",
      "web:lib/core.ts -> apps",
    ]);
  });

  it("applies the same rules to python imports", () => {
    const files = new Map([
      [
        "apps/routes.py",
        "from omnigent.superchat.artifacts import X\nfrom omnigent.superchat.sheets import Y",
      ],
      ["sheets/routes.py", "from omnigent.superchat.artifacts.store import S"],
      ["titles.py", "from omnigent.superchat.apps import Z"],
      ["features.py", "from omnigent.superchat.apps import FEATURE"],
    ]);
    expect(violationsOf(engine, ["apps", "sheets", "artifacts"], files)).toEqual([
      "engine:apps/routes.py -> sheets",
      "engine:sheets/routes.py -> artifacts",
      "engine:titles.py -> apps",
    ]);
  });
});
