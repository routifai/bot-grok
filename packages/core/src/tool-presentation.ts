import type { ActivityStep } from "@nova/contracts";

// One registry, one source of truth for how an Activity Step reads in the UI
// (docs/super-chat/README.md "The Activity panel"; AGENTS.md "no hex, tokens only" applies to
// the icon, never the copy). The owner's three rules: register every tool here once; never
// show a tool's raw name, only an icon and a plain-language title; never show the full
// call/result trace, only a short snippet of the output.
//
// A Step's `tool` is the engine tool name (e.g. "web_search"); `detail` is
// `{ call: { name, args: <JSON string> }, result: { content: <string, often JSON> } }`,
// populated only on `activities.get` (packages/contracts/src/rpc/activity.ts).

/** A small, closed set of line icons a tool can present as — never the tool's own name.
 * apps/web/src/pages/muse/chrome/toolIcons.ts maps each to a lucide icon. */
export type ToolIconKey =
  | "search"
  | "web"
  | "memory"
  | "helper"
  | "sideChat"
  | "history"
  | "generic";

/** One tool's presentation: an icon, a plain-language title derived from its call
 * arguments, and a short snippet of its result — never the tool's own name, never the
 * full call/result trace. */
export interface ToolPresentation {
  icon: ToolIconKey;
  /** A plain-language title from the call's arguments alone (no tool name). */
  title: (args: Record<string, unknown>) => string;
  /** A short (~240 char / 2-3 line) human snippet of the result, or `null` when there is
   * nothing worth showing — a Step whose snippet is `null` isn't expandable. */
  snippet: (output: string) => string | null;
}

/** What `presentStep` returns for one Activity Step: ready to render, never the tool name. */
export interface PresentedStep {
  icon: ToolIconKey;
  title: string;
  snippet: string | null;
}

/** The engine's always-on superside-chat tools (engine/omnigent/omnigent/tools/builtins/
 * memory.py, session_history.py, side_chat.py, spawn.py, async_inbox.py) — registered for
 * every `omnigent.context.mode=superside-chat` session regardless of the agent bundle's own
 * `tools.builtins` list. Kept next to the registry so the completeness test
 * (tool-presentation.completeness.test.ts) can assert every one of these has an entry too. */
export const ALWAYS_ON_SUPERSIDE_CHAT_TOOLS = [
  "memory_search",
  "memory_remember",
  "memory_get",
  "memory_explain",
  "memory_forget",
  "session_history",
  "side_chat_open",
  "sys_session_send",
  "sys_session_create",
  "sys_read_inbox",
  "sys_cancel_task",
  "sys_session_get_history",
  "sys_scheduled_task_create",
  "sys_scheduled_task_list",
  "sys_scheduled_task_update",
  "sys_scheduled_task_delete",
] as const;

const MAX_SNIPPET_CHARS = 240;

function clip(text: string, max = MAX_SNIPPET_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1).trimEnd()}…` : collapsed;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function field(source: unknown, key: string): unknown {
  return source !== null && typeof source === "object"
    ? (source as Record<string, unknown>)[key]
    : undefined;
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Flattens any JSON value down to its leaf strings/numbers/booleans, dropping keys —
 * the fallback for an unrecognized tool: readable words, never raw `{"key": ...}` noise. */
function flattenJsonValues(value: unknown, acc: string[] = [], depth = 0): string[] {
  if (depth > 5) return acc;
  if (typeof value === "string") {
    if (value.trim()) acc.push(value.trim());
  } else if (typeof value === "number" || typeof value === "boolean") {
    acc.push(String(value));
  } else if (Array.isArray(value)) {
    for (const item of value) flattenJsonValues(item, acc, depth + 1);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) flattenJsonValues(item, acc, depth + 1);
  }
  return acc;
}

/** The unknown-tool fallback, and a reasonable default for a known tool whose exact output
 * shape isn't worth a bespoke parser: JSON is stripped to its values, plain text is kept as
 * is, then clipped to ~200 chars. */
function genericSnippet(output: string, max = 200): string | null {
  if (!output.trim()) return null;
  const parsed = tryParseJson(output);
  const text = parsed === undefined ? output : flattenJsonValues(parsed).join(" ");
  return text.trim() ? clip(text, max) : null;
}

function claimText(claim: unknown): string | null {
  const text = field(claim, "text");
  return isNonEmptyString(text) ? text.trim() : null;
}

function errorMessage(parsed: unknown): string | null {
  const error = field(parsed, "error");
  return isNonEmptyString(error) ? error.trim() : null;
}

// ── web_search ───────────────────────────────────────────────────────────

interface WebResult {
  title: string;
  domain: string;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`);
  } catch {
    return null;
  }
}

function domainOf(url: string): string {
  return parseUrl(url)?.hostname.replace(/^www\./, "") ?? url;
}

/** Search engines a browser Step can be visiting: where the query lives in the URL. */
const SEARCH_ENGINES: { host: RegExp; name: string; param: string }[] = [
  { host: /(^|\.)google\./, name: "Google", param: "q" },
  { host: /(^|\.)bing\.com$/, name: "Bing", param: "q" },
  { host: /(^|\.)duckduckgo\.com$/, name: "DuckDuckGo", param: "q" },
  { host: /(^|\.)search\.brave\.com$/, name: "Brave", param: "q" },
  { host: /(^|\.)search\.yahoo\.com$/, name: "Yahoo", param: "p" },
];

/** A browser navigation in plain words: a search-engine results URL reads as the search
 * ("Searched Google for “tesla stock price”"), any other URL as the site ("Opened cnn.com"). */
function navigateTitle(args: Record<string, unknown>): string {
  const raw = args.url;
  if (!isNonEmptyString(raw)) return "Opened a page";
  const url = parseUrl(raw.trim());
  if (!url) return `Opened ${raw.trim()}`;
  const engine = SEARCH_ENGINES.find((entry) => entry.host.test(url.hostname));
  const query = engine ? url.searchParams.get(engine.param)?.trim() : undefined;
  if (engine && query) return `Searched ${engine.name} for “${query}”`;
  return `Opened ${domainOf(raw.trim())}`;
}

/** Parses Tavily's `/search` text format (engine/omnigent/omnigent/tools/builtins/
 * web_search_tavily.py `_format_results`): an optional answer paragraph, then
 * `"<n>. <title>\n   <url>\n   <snippet>"` entries separated by blank lines. Also accepts the
 * raw Tavily JSON shape (`{results: [{title, url}]}`) in case a caller passes that instead. */
function parseWebSearchResults(output: string): WebResult[] {
  const parsed = tryParseJson(output);
  if (parsed !== undefined && Array.isArray(field(parsed, "results"))) {
    const results = field(parsed, "results") as unknown[];
    return results
      .map((entry) => {
        const title = field(entry, "title");
        const url = field(entry, "url");
        return isNonEmptyString(title) && isNonEmptyString(url)
          ? { title: title.trim(), domain: domainOf(url.trim()) }
          : null;
      })
      .filter((entry): entry is WebResult => entry !== null);
  }
  const results: WebResult[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const titleMatch = /^\d+\.\s+(.+)$/.exec(lines[i] ?? "");
    const title = titleMatch?.[1];
    if (!title) continue;
    const urlLine = (lines[i + 1] ?? "").trim();
    if (!urlLine) continue;
    results.push({ title: title.trim(), domain: domainOf(urlLine) });
  }
  return results;
}

function webSearchSnippet(output: string): string | null {
  const results = parseWebSearchResults(output);
  if (results.length === 0) return genericSnippet(output);
  return clip(
    results
      .slice(0, 3)
      .map((r) => `${r.title} (${r.domain})`)
      .join("; "),
  );
}

// ── session_history ─────────────────────────────────────────────────────

function sessionHistorySnippet(output: string): string | null {
  const parsed = tryParseJson(output);
  if (parsed === undefined) return genericSnippet(output);
  if (isNonEmptyString(field(parsed, "error"))) return errorMessage(parsed);
  const chats = field(parsed, "chats");
  if (Array.isArray(chats)) {
    const titles = chats.map((chat) => field(chat, "title")).filter(isNonEmptyString);
    return titles.length ? clip(titles.slice(0, 3).join("; ")) : null;
  }
  const turns = field(parsed, "turns");
  if (Array.isArray(turns)) {
    if (turns.length === 0) return null;
    return `${turns.length} earlier turn${turns.length === 1 ? "" : "s"} found`;
  }
  const results = field(parsed, "results");
  if (Array.isArray(results)) {
    const texts = results
      .map((item) => field(item, "content") ?? field(item, "text"))
      .filter(isNonEmptyString);
    return texts.length ? clip(texts.slice(0, 3).join("; ")) : null;
  }
  const percent = field(parsed, "context_used_percent");
  if (typeof percent === "number") return `${percent}% of context used`;
  return genericSnippet(output);
}

function sessionHistoryTitle(args: Record<string, unknown>): string {
  const action = args.action;
  if (action === "read") return "Read earlier messages";
  if (action === "search") {
    const query = args.query;
    return isNonEmptyString(query)
      ? `Searched earlier messages for “${query.trim()}”`
      : "Searched earlier messages";
  }
  if (action === "list_chats") return "Listed side chats";
  if (action === "status") return "Checked how much room is left";
  return "Checked the conversation";
}

// ── helper (sub-agent) tools ────────────────────────────────────────────

function helperHandleSnippet(output: string): string | null {
  const parsed = tryParseJson(output);
  if (parsed === undefined) return null;
  const error = errorMessage(parsed);
  if (error) return clip(error);
  // The engine's launch notice is plumbing; say who started, in plain words.
  const agent = field(parsed, "agent");
  return isNonEmptyString(agent) ? `${capitalize(helperName(agent))} started.` : "Started.";
}

/** A Helper's user-facing name: internal sub-agents never show their engine name. */
export function helperName(agent: string): string {
  return agent.startsWith("__web") ? "web research" : agent.replace(/^_+/, "").replace(/_/g, " ");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Engine plumbing a snippet must never show: tool names and system notices. */
const PLUMBING = /\[System:|\bsys_[a-z_]+|\b__[a-z_]+/;

/** An id-looking token: 6+ hex chars, optionally with separators ("91af03c2", "web_fetch_91af"). */
const ID_LIKE = /^(?:[a-z_-]+[_-])?[0-9a-f]{6,}(?:[_-][0-9a-f]+)*$/i;

/** The engine's own title for a Conversation turn that carried no message of its own. */
const CONVERSATION_TITLE = /^nova conversation$/i;

/** An Activity title in plain words: a Helper's "agent: topic" shows just the topic (the
 * Helper pill says who), falling back to the Helper's name when the topic is only an id;
 * the Conversation's own untitled turns read "Conversation". */
export function presentActivityTitle(title: string): string {
  if (CONVERSATION_TITLE.test(title.trim())) return "Conversation";
  const match = /^([a-z_]+): (.+)$/i.exec(title);
  if (!match) return title;
  const [, agent = "", rest = ""] = match;
  if (agent.startsWith("__web")) return "Web research";
  return ID_LIKE.test(rest.trim()) ? capitalize(helperName(agent)) : rest;
}

function fileTitle(verb: string, args: Record<string, unknown>): string {
  const path = args.path;
  const name = isNonEmptyString(path) ? path.trim().split("/").pop() : "";
  return name ? `${verb} “${name}”` : `${verb} a file`;
}

// ── the registry ────────────────────────────────────────────────────────

export const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  web_search: {
    icon: "search",
    title: (args) => {
      const query = args.query;
      return isNonEmptyString(query)
        ? `Searched the web for “${query.trim()}”`
        : "Searched the web";
    },
    snippet: webSearchSnippet,
  },

  web_fetch: {
    icon: "web",
    title: (args) => {
      const url = args.url;
      return isNonEmptyString(url) ? `Read ${domainOf(url.trim())}` : "Read a web page";
    },
    snippet: () => null,
  },

  memory_search: {
    icon: "memory",
    title: (args) => {
      const query = args.query;
      return isNonEmptyString(query) ? `Checked memory for “${query.trim()}”` : "Checked memory";
    },
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return genericSnippet(output);
      const error = errorMessage(parsed);
      if (error) return clip(error);
      const results = field(parsed, "results");
      if (!Array.isArray(results) || results.length === 0) return null;
      const texts = results.map(claimText).filter((text): text is string => text !== null);
      return texts.length ? clip(texts.slice(0, 3).join("; ")) : null;
    },
  },

  memory_remember: {
    icon: "memory",
    title: () => "Remembered something about you",
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return genericSnippet(output);
      const error = errorMessage(parsed);
      if (error) return clip(error);
      const text = claimText(field(parsed, "claim"));
      return text ? clip(text) : null;
    },
  },

  memory_get: {
    icon: "memory",
    title: () => "Looked up a memory",
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return genericSnippet(output);
      const error = errorMessage(parsed);
      if (error) return clip(error);
      const text = claimText(parsed);
      return text ? clip(text) : null;
    },
  },

  memory_explain: {
    icon: "memory",
    title: () => "Checked where a memory came from",
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return genericSnippet(output);
      const error = errorMessage(parsed);
      if (error) return clip(error);
      const quote = field(parsed, "quote");
      if (isNonEmptyString(quote)) return clip(quote);
      const text = claimText(field(parsed, "claim"));
      return text ? clip(text) : null;
    },
  },

  memory_forget: {
    icon: "memory",
    title: (args) => (args.confirm === true ? "Forgot a memory" : "Reviewed forgetting a memory"),
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return genericSnippet(output);
      const error = errorMessage(parsed);
      if (error) return clip(error);
      if (field(parsed, "status") === "not_found") return null;
      const text = claimText(field(parsed, "claim"));
      return text ? clip(text) : null;
    },
  },

  session_history: {
    icon: "history",
    title: sessionHistoryTitle,
    snippet: sessionHistorySnippet,
  },

  sys_session_get_history: {
    icon: "helper",
    title: () => "Checked on background work",
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return genericSnippet(output);
      const error = errorMessage(parsed);
      if (error) return clip(error);
      const title = field(parsed, "title");
      return isNonEmptyString(title) ? clip(title) : genericSnippet(output);
    },
  },

  sys_scheduled_task_create: {
    icon: "helper",
    title: (args) => {
      const name = args.name;
      return isNonEmptyString(name)
        ? `Set up following “${name.trim()}”`
        : "Set up a followed topic";
    },
    snippet: () => null,
  },

  sys_scheduled_task_list: {
    icon: "helper",
    title: () => "Checked followed topics",
    snippet: () => null,
  },

  sys_scheduled_task_update: {
    icon: "helper",
    title: () => "Updated a followed topic",
    snippet: () => null,
  },

  sys_scheduled_task_delete: {
    icon: "helper",
    title: () => "Stopped following a topic",
    snippet: () => null,
  },

  side_chat_open: {
    icon: "sideChat",
    title: (args) => {
      const title = args.title;
      return isNonEmptyString(title)
        ? `Opened a side chat “${title.trim()}”`
        : "Opened a side chat";
    },
    snippet: () => null,
  },

  sys_session_send: {
    icon: "helper",
    title: (args) => {
      const title = args.title;
      return isNonEmptyString(title)
        ? `Started “${title.trim()}” in the background`
        : "Sent a follow-up to background work";
    },
    snippet: helperHandleSnippet,
  },

  sys_session_create: {
    icon: "helper",
    title: (args) => {
      const title = args.title;
      return isNonEmptyString(title)
        ? `Started “${title.trim()}” in the background`
        : "Started background work";
    },
    snippet: helperHandleSnippet,
  },

  start_helper: {
    icon: "helper",
    title: () => "Started background work",
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return null;
      const error = errorMessage(parsed);
      if (error) return clip(error);
      const title = field(parsed, "title");
      return isNonEmptyString(title) ? clip(title) : "Started.";
    },
  },

  open_project: {
    icon: "generic",
    title: (args) => (args.slug === null ? "Left the project" : "Opened a project"),
    snippet: (output) => {
      const parsed = tryParseJson(output);
      if (parsed === undefined) return null;
      const error = errorMessage(parsed);
      if (error) return clip(error);
      const name = field(parsed, "name");
      return isNonEmptyString(name) ? clip(name) : null;
    },
  },

  sys_read_inbox: {
    icon: "helper",
    title: () => "Collected the result",
    snippet: (output) => genericSnippet(output),
  },

  sys_cancel_task: {
    icon: "helper",
    title: () => "Stopped background work",
    snippet: () => null,
  },

  // ── the Computer: shell, files and browser (sys_os_*, browser_*) ─────────
  // Not bundle `builtins`, so the completeness test doesn't force these; registered so a
  // Step reads in plain words. Titles never echo a command; a path is the file's own name.
  sys_os_shell: {
    icon: "generic",
    title: () => "Ran a command on the Computer",
    snippet: (output) => genericSnippet(output),
  },

  sys_os_read: {
    icon: "generic",
    title: (args) => fileTitle("Read", args),
    snippet: () => null,
  },

  sys_os_write: {
    icon: "generic",
    title: (args) => fileTitle("Wrote", args),
    snippet: () => null,
  },

  sys_os_edit: {
    icon: "generic",
    title: (args) => fileTitle("Edited", args),
    snippet: () => null,
  },

  browser_navigate: {
    icon: "web",
    title: navigateTitle,
    snippet: () => null,
  },

  browser_snapshot: {
    icon: "web",
    title: () => "Read the page",
    snippet: () => null,
  },

  browser_click: {
    icon: "web",
    title: () => "Clicked on the page",
    snippet: () => null,
  },

  browser_type: {
    icon: "web",
    title: () => "Typed on the page",
    snippet: () => null,
  },

  browser_screenshot: {
    icon: "web",
    title: () => "Looked at the screen",
    snippet: () => null,
  },
};

function callArgsOf(detail: ActivityStep["detail"]): Record<string, unknown> {
  const raw = field(field(detail, "call"), "args") ?? field(field(detail, "call"), "arguments");
  if (typeof raw !== "string") return {};
  const parsed = tryParseJson(raw);
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function resultContentOf(detail: ActivityStep["detail"]): string {
  const content =
    field(field(detail, "result"), "content") ?? field(field(detail, "result"), "output");
  return typeof content === "string" ? content : "";
}

/** The one place a Step becomes UI: an icon, a plain-language title, and a short result
 * snippet — preferring the registry, and never the tool's raw name. A tool with no
 * registry entry (not yet registered — see docs/super-chat/README.md "How to register a
 * tool") falls back to the engine's own `step.title` and a generic JSON-stripped snippet. */
export function presentStep(step: Pick<ActivityStep, "tool" | "title" | "detail">): PresentedStep {
  const output = resultContentOf(step.detail);
  const entry = step.tool ? TOOL_PRESENTATION[step.tool] : undefined;
  if (!entry) {
    const snippet = genericSnippet(output);
    return {
      icon: "generic",
      title: step.title,
      snippet: snippet && PLUMBING.test(snippet) ? null : snippet,
    };
  }
  const args = callArgsOf(step.detail);
  const title = entry.title(args) || step.title;
  const snippet = output ? entry.snippet(output) : null;
  return { icon: entry.icon, title, snippet: snippet && PLUMBING.test(snippet) ? null : snippet };
}
