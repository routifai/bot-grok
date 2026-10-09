import { describe, expect, it } from "vitest";
import {
  ALWAYS_ON_SUPERSIDE_CHAT_TOOLS,
  presentActivityTitle,
  presentStep,
  TOOL_PRESENTATION,
  type ToolPresentation,
} from "./tool-presentation.js";

/** Builds a realistic Step `detail` in the engine's own shape
 * (engine/omnigent/omnigent/tools/builtins/spawn.py `_project_activity_item`/`_step_detail`):
 * `{ call: { name, args: <JSON string> }, result: { content: <string> } }`. */
function detailFor(name: string, args: Record<string, unknown>, content: string) {
  return {
    call: { role: "assistant", type: "tool_call", name, args: JSON.stringify(args) },
    result: { role: "tool", type: "tool_result", name, content },
  };
}

const TAVILY_OUTPUT =
  "The current prime rate is 7.5%.\n\n" +
  "1. Fed holds rates steady\n   https://www.reuters.com/markets/fed-rate\n   The Federal Reserve kept rates unchanged.\n\n" +
  "2. What the prime rate means for you\n   https://blog.bankrate.com/prime-rate\n   A plain-language explainer.\n\n" +
  "3. Historical prime rate chart\n   https://www.investopedia.com/prime-rate\n   Decades of data.";

describe("TOOL_PRESENTATION", () => {
  it("web_search: titles from the query, snippet lists result titles with domains", () => {
    const entry = TOOL_PRESENTATION.web_search as ToolPresentation;
    expect(entry.icon).toBe("search");
    expect(entry.title({ query: "prime rate" })).toBe("Searched the web for “prime rate”");
    expect(entry.title({})).toBe("Searched the web");
    const snippet = entry.snippet(TAVILY_OUTPUT);
    expect(snippet).toContain("Fed holds rates steady (reuters.com)");
    expect(snippet).toContain("bankrate.com");
    expect(snippet?.length).toBeLessThanOrEqual(240);
  });

  it("web_search: no results falls back to a plain-text snippet", () => {
    const entry = TOOL_PRESENTATION.web_search as ToolPresentation;
    expect(entry.snippet("No results found.")).toBe("No results found.");
  });

  it("memory_search: checks memory by query, snippet lists matched claim texts", () => {
    const entry = TOOL_PRESENTATION.memory_search as ToolPresentation;
    expect(entry.icon).toBe("memory");
    expect(entry.title({ query: "deadline" })).toBe("Checked memory for “deadline”");
    expect(entry.title({})).toBe("Checked memory");
    const output = JSON.stringify({
      results: [
        { claim_id: "c1", text: "Prefers phone-first slide decks", kind: "preference" },
        { claim_id: "c2", text: "Reviews the Q3 steering deck with Dana", kind: "fact" },
      ],
    });
    const snippet = entry.snippet(output);
    expect(snippet).toContain("Prefers phone-first slide decks");
    expect(snippet).toContain("Reviews the Q3 steering deck with Dana");
  });

  it("memory_search: no matches yields no snippet (not expandable)", () => {
    const entry = TOOL_PRESENTATION.memory_search as ToolPresentation;
    expect(entry.snippet(JSON.stringify({ results: [] }))).toBeNull();
  });

  it("memory_remember: saves to memory, snippet shows the saved claim", () => {
    const entry = TOOL_PRESENTATION.memory_remember as ToolPresentation;
    expect(entry.icon).toBe("memory");
    expect(entry.title({ text: "Prefers phone-first slide decks" })).toBe(
      "Remembered something about you",
    );
    const output = JSON.stringify({
      action: "added",
      claim: { claim_id: "c1", text: "Prefers phone-first slide decks", kind: "preference" },
    });
    expect(entry.snippet(output)).toBe("Prefers phone-first slide decks");
  });

  it("memory_get: looks up a claim by id, snippet shows its text", () => {
    const entry = TOOL_PRESENTATION.memory_get as ToolPresentation;
    expect(entry.icon).toBe("memory");
    expect(entry.title({ claim_id: "c1" })).toBe("Looked up a memory");
    const output = JSON.stringify({ claim_id: "c1", text: "Weekly branch KPI summary on Mondays" });
    expect(entry.snippet(output)).toBe("Weekly branch KPI summary on Mondays");
  });

  it("memory_get: a missing claim yields the error, not a crash", () => {
    const entry = TOOL_PRESENTATION.memory_get as ToolPresentation;
    expect(entry.snippet(JSON.stringify({ error: "claim not found" }))).toBe("claim not found");
  });

  it("memory_explain: explains provenance, snippet prefers the evidence quote", () => {
    const entry = TOOL_PRESENTATION.memory_explain as ToolPresentation;
    expect(entry.icon).toBe("memory");
    expect(entry.title({ claim_id: "c1" })).toBe("Checked where a memory came from");
    const output = JSON.stringify({
      claim: { claim_id: "c1", text: "Prefers phone-first slide decks" },
      quote: "I always read these on my phone",
      supersedes: [],
      superseded_by: null,
    });
    expect(entry.snippet(output)).toBe("I always read these on my phone");
  });

  it("memory_forget: two-step plan vs confirm, snippet shows the targeted claim", () => {
    const entry = TOOL_PRESENTATION.memory_forget as ToolPresentation;
    expect(entry.icon).toBe("memory");
    expect(entry.title({ claim_id: "c1" })).toBe("Reviewed forgetting a memory");
    expect(entry.title({ claim_id: "c1", confirm: true })).toBe("Forgot a memory");
    const output = JSON.stringify({
      status: "forgotten",
      claim: { claim_id: "c1", text: "Old preference, no longer true" },
    });
    expect(entry.snippet(output)).toBe("Old preference, no longer true");
    expect(entry.snippet(JSON.stringify({ status: "not_found" }))).toBeNull();
  });

  it("session_history: read/search/list_chats/status map to plain language", () => {
    const entry = TOOL_PRESENTATION.session_history as ToolPresentation;
    expect(entry.icon).toBe("history");
    expect(entry.title({ action: "read" })).toBe("Read earlier messages");
    expect(entry.title({ action: "search", query: "Q4" })).toBe(
      "Searched earlier messages for “Q4”",
    );
    expect(entry.title({ action: "list_chats" })).toBe("Listed side chats");
    expect(entry.title({ action: "status" })).toBe("Checked how much room is left");

    const readOutput = JSON.stringify({
      turns: [{ messages: [{ role: "user", type: "text", content: "hi" }] }],
      next_cursor: null,
    });
    expect(entry.snippet(readOutput)).toBe("1 earlier turn found");

    const listChatsOutput = JSON.stringify({ chats: [{ id: "c1", title: "Q4 checklist" }] });
    expect(entry.snippet(listChatsOutput)).toContain("Q4 checklist");
  });

  it("side_chat_open: opens a side chat by title, no snippet", () => {
    const entry = TOOL_PRESENTATION.side_chat_open as ToolPresentation;
    expect(entry.icon).toBe("sideChat");
    expect(entry.title({ title: "Q4 checklist", start: "with_context" })).toBe(
      "Opened a side chat “Q4 checklist”",
    );
    expect(entry.title({ start: "blank" })).toBe("Opened a side chat");
    expect(
      entry.snippet('{"conversation_id":"conv_1","title":"Q4 checklist","start":"blank"}'),
    ).toBeNull();
  });

  it("sys_session_send: starts background work for a title, snippet says who started", () => {
    const entry = TOOL_PRESENTATION.sys_session_send as ToolPresentation;
    expect(entry.icon).toBe("helper");
    expect(entry.title({ agent: "analyst", title: "Q3 budget check", args: "go" })).toBe(
      "Started “Q3 budget check” in the background",
    );
    const output = JSON.stringify({
      task_id: "task_1",
      kind: "sub_agent",
      agent: "analyst",
      title: "Q3 budget check",
      conversation_id: "conv_1",
      status: "in_progress",
      message: "Dispatched; result will arrive in the inbox.",
    });
    expect(entry.snippet(output)).toBe("Analyst started.");
  });

  it("start_helper: says it started and shows the Helper's plain title", () => {
    const entry = TOOL_PRESENTATION.start_helper as ToolPresentation;
    expect(entry.icon).toBe("helper");
    expect(entry.title({ task: "Compare notes apps" })).toBe("Started background work");
    expect(
      entry.snippet('{"started":true,"helper_id":"conv_1","title":"Compare notes apps"}'),
    ).toBe("Compare notes apps");
    expect(entry.snippet('{"error":"cap reached"}')).toBe("cap reached");
  });

  it("message_helper: says a note was passed on and shows a refusal", () => {
    const entry = TOOL_PRESENTATION.message_helper as ToolPresentation;
    expect(entry.icon).toBe("helper");
    expect(entry.title({ message: "make it blue" })).toBe("Passed a note to background work");
    expect(entry.snippet('{"sent":true,"helper_id":"conv_1"}')).toBeNull();
    expect(entry.snippet('{"error":"no Helper is running"}')).toBe("no Helper is running");
  });

  it("open_project: says a Project was opened and shows its name", () => {
    const entry = TOOL_PRESENTATION.open_project as ToolPresentation;
    expect(entry.title({ slug: "q3-deck" })).toBe("Opened a project");
    expect(entry.title({ slug: null })).toBe("Left the project");
    expect(entry.snippet('{"opened":"q3-deck","name":"Q3 board deck","path":"/p"}')).toBe(
      "Q3 board deck",
    );
    expect(entry.snippet('{"opened":null,"path":"/w"}')).toBeNull();
    expect(entry.snippet('{"error":"no Project"}')).toBe("no Project");
  });

  it("sys_session_create: starts background work for a title", () => {
    const entry = TOOL_PRESENTATION.sys_session_create as ToolPresentation;
    expect(entry.icon).toBe("helper");
    expect(entry.title({ agent_id: "ag_1", title: "auth refactor" })).toBe(
      "Started “auth refactor” in the background",
    );
    expect(entry.title({ agent_id: "ag_1" })).toBe("Started background work");
  });

  it("sys_read_inbox: collects the result", () => {
    const entry = TOOL_PRESENTATION.sys_read_inbox as ToolPresentation;
    expect(entry.icon).toBe("helper");
    expect(entry.title({})).toBe("Collected the result");
    expect(entry.snippet("[System: task task_1 complete] 61 of 84 line items matched.")).toContain(
      "61 of 84 line items matched",
    );
  });

  it("sys_cancel_task: stops background work, no useful snippet to show", () => {
    const entry = TOOL_PRESENTATION.sys_cancel_task as ToolPresentation;
    expect(entry.icon).toBe("helper");
    expect(entry.title({ task_id: "task_1" })).toBe("Stopped background work");
    expect(
      entry.snippet(JSON.stringify({ error: "task_not_found", task_id: "task_1" })),
    ).toBeNull();
  });

  it("sys_session_get_history: checks on background work by its title", () => {
    const entry = TOOL_PRESENTATION.sys_session_get_history as ToolPresentation;
    expect(entry.icon).toBe("helper");
    expect(entry.title({ session_id: "conv_1" })).toBe("Checked on background work");
    const output = JSON.stringify({
      conversation_id: "conv_1",
      agent: "analyst",
      title: "Q3 budget check",
      items: [],
    });
    expect(entry.snippet(output)).toBe("Q3 budget check");
  });
});

describe("ALWAYS_ON_SUPERSIDE_CHAT_TOOLS", () => {
  it("has a registry entry for every always-on tool", () => {
    for (const name of ALWAYS_ON_SUPERSIDE_CHAT_TOOLS) {
      expect(TOOL_PRESENTATION[name]).toBeDefined();
    }
  });
});

describe("presentStep", () => {
  it("prefers the registry's icon and title for a registered tool", () => {
    const step = {
      tool: "web_search",
      title: "Used web_search",
      detail: detailFor("web_search", { query: "prime rate" }, TAVILY_OUTPUT),
    };
    const presented = presentStep(step);
    expect(presented.icon).toBe("search");
    expect(presented.title).toBe("Searched the web for “prime rate”");
    expect(presented.snippet).toContain("reuters.com");
  });

  it("falls back to the engine's own title for an unregistered tool", () => {
    const step = {
      tool: "read_file",
      title: "Opened budget.xlsx",
      detail: detailFor("read_file", { path: "budget.xlsx" }, "Opened. 84 rows."),
    };
    const presented = presentStep(step);
    expect(presented.icon).toBe("generic");
    expect(presented.title).toBe("Opened budget.xlsx");
    expect(presented.snippet).toBe("Opened. 84 rows.");
  });

  it("falls back to the engine's title when a tool name is null", () => {
    const presented = presentStep({ tool: null, title: "Did something", detail: null });
    expect(presented.icon).toBe("generic");
    expect(presented.title).toBe("Did something");
    expect(presented.snippet).toBeNull();
  });

  it("has no snippet, and so is not expandable, when there is no result content", () => {
    const presented = presentStep({ tool: "web_search", title: "Used web_search", detail: null });
    expect(presented.snippet).toBeNull();
  });
});

describe("never reveals the tool's raw name", () => {
  const cases: Array<{ tool: string; args: Record<string, unknown>; output: string }> = [
    { tool: "web_search", args: { query: "prime rate" }, output: TAVILY_OUTPUT },
    { tool: "memory_search", args: { query: "deadline" }, output: JSON.stringify({ results: [] }) },
    {
      tool: "memory_remember",
      args: { text: "Prefers phone-first slide decks" },
      output: JSON.stringify({
        action: "added",
        claim: { text: "Prefers phone-first slide decks" },
      }),
    },
    { tool: "memory_get", args: { claim_id: "c1" }, output: JSON.stringify({ text: "A fact" }) },
    {
      tool: "memory_explain",
      args: { claim_id: "c1" },
      output: JSON.stringify({ quote: "my own words", claim: { text: "A fact" } }),
    },
    {
      tool: "memory_forget",
      args: { claim_id: "c1", confirm: true },
      output: JSON.stringify({ status: "forgotten", claim: { text: "Old fact" } }),
    },
    {
      tool: "session_history",
      args: { action: "read" },
      output: JSON.stringify({ turns: [], next_cursor: null }),
    },
    {
      tool: "side_chat_open",
      args: { title: "Q4 checklist", start: "blank" },
      output: JSON.stringify({ conversation_id: "conv_1" }),
    },
    {
      tool: "sys_session_send",
      args: { agent: "analyst", title: "Q3 budget check" },
      output: JSON.stringify({ message: "Dispatched." }),
    },
    {
      tool: "sys_session_create",
      args: { title: "auth refactor" },
      output: JSON.stringify({ status: "ok" }),
    },
    { tool: "sys_read_inbox", args: {}, output: "[System: task task_1 complete] done." },
    {
      tool: "sys_cancel_task",
      args: { task_id: "task_1" },
      output: JSON.stringify({ error: "task_not_found" }),
    },
    {
      tool: "sys_session_get_history",
      args: { session_id: "conv_1" },
      output: JSON.stringify({ title: "Q3 budget check" }),
    },
  ];

  it.each(cases)(
    "$tool's title and snippet never contain the tool name",
    ({ tool, args, output }) => {
      const entry = TOOL_PRESENTATION[tool];
      expect(entry).toBeDefined();
      const title = entry?.title(args) ?? "";
      const snippet = entry?.snippet(output) ?? "";
      expect(title.toLowerCase()).not.toContain(tool);
      expect((snippet ?? "").toLowerCase()).not.toContain(tool);
    },
  );

  it("presentStep never surfaces the raw tool name for an unregistered tool either", () => {
    const presented = presentStep({
      tool: "web_search_v2_internal",
      title: "Searched the web (plain language, from the engine)",
      detail: detailFor("web_search_v2_internal", { query: "x" }, "Some plain output."),
    });
    expect(presented.title.toLowerCase()).not.toContain("web_search_v2_internal");
    expect((presented.snippet ?? "").toLowerCase()).not.toContain("web_search_v2_internal");
  });
});

describe("no engine plumbing reaches the UI", () => {
  it("a helper launch reads as who started, not the engine's launch notice", () => {
    const step = {
      tool: "sys_session_send",
      title: "Sent a message to sub-agent 'APR vs APY'",
      detail: {
        call: { args: '{"agent":"researcher","title":"APR vs APY"}' },
        result: {
          content:
            '{"agent":"researcher","status":"launching","message":"[System: sub-agent researcher launching as task 91af. Result will appear in your inbox; call sys_read_inbox to check or sys_cancel_task to interrupt it."}',
        },
      },
    };
    expect(presentStep(step).snippet).toBe("Researcher started.");
  });

  it("drops any snippet that still carries a system notice or tool name", () => {
    const step = {
      tool: "unknown_tool",
      title: "Did something",
      detail: { result: { content: "[System: call sys_read_inbox to collect.]" } },
    };
    expect(presentStep(step).snippet).toBeNull();
  });

  it("names Helper Activities in plain words", () => {
    expect(presentActivityTitle("__web_researcher: web_fetch_91af")).toBe("Web research");
    expect(presentActivityTitle("researcher: APR vs APY")).toBe("APR vs APY");
    expect(presentActivityTitle("researcher: 91af03c2b7")).toBe("Researcher");
    expect(presentActivityTitle("Nova Conversation")).toBe("Conversation");
    expect(presentActivityTitle("Use a researcher helper")).toBe("Use a researcher helper");
  });
});

describe("browser and web steps read as what the person would say", () => {
  const title = (tool: string, args: Record<string, unknown>) =>
    presentStep({ tool, title: "raw", detail: detailFor(tool, args, "") }).title;

  it("a search-engine results page reads as the search", () => {
    expect(
      title("browser_navigate", { url: "https://www.google.com/search?q=tesla+stock+price&hl=en" }),
    ).toBe("Searched Google for “tesla stock price”");
    expect(title("browser_navigate", { url: "https://duckduckgo.com/?q=ai%20agents" })).toBe(
      "Searched DuckDuckGo for “ai agents”",
    );
    expect(title("browser_navigate", { url: "bing.com/search?q=prime rate" })).toBe(
      "Searched Bing for “prime rate”",
    );
  });

  it("any other page reads as the site, with or without a scheme", () => {
    expect(title("browser_navigate", { url: "https://www.cnn.com/world/live-news" })).toBe(
      "Opened cnn.com",
    );
    expect(title("browser_navigate", { url: "google.com" })).toBe("Opened google.com");
    expect(title("browser_navigate", { url: "https://www.google.com/maps" })).toBe(
      "Opened google.com",
    );
    expect(title("browser_navigate", {})).toBe("Opened a page");
  });

  it("reading a page, fetching one and remembering are plain", () => {
    expect(title("browser_snapshot", {})).toBe("Read the page");
    expect(title("web_fetch", { url: "https://www.reuters.com/markets/fed-rate" })).toBe(
      "Read reuters.com",
    );
    expect(title("web_fetch", {})).toBe("Read a web page");
    expect(
      presentStep({
        tool: "web_fetch",
        title: "raw",
        detail: detailFor("web_fetch", {}, "page text"),
      }).snippet,
    ).toBeNull();
    expect(title("memory_remember", { text: "x" })).toBe("Remembered something about you");
  });
});
