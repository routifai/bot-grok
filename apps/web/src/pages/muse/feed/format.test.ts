import { describe, expect, it } from "vitest";
import { postPreview } from "./format";

describe("postPreview", () => {
  it("skips a leading source caveat so the card starts with the news", () => {
    const body = [
      "# Agent launches",
      "The findings below come from web search snippets only, so details may be thin.",
      "Acme shipped a new agent runtime on Monday.",
      "Sources: [acme.example](https://acme.example/news)",
    ].join("\n\n");
    const { heading, text, sources } = postPreview(body);
    expect(heading).toBe("Agent launches");
    expect(text.startsWith("Acme shipped")).toBe(true);
    expect(text).not.toMatch(/findings below/);
    expect(sources.map((source) => source.host)).toEqual(["acme.example"]);
  });

  it("keeps a caveat when it is all there is", () => {
    expect(postPreview("Most of this comes from one site.").text).toBe(
      "Most of this comes from one site.",
    );
  });

  it("leaves a body that opens with news untouched", () => {
    expect(postPreview("Acme shipped.\n\nNote: thin sources.").text).toBe(
      "Acme shipped. Note: thin sources.",
    );
  });
});
