import { describe, expect, it } from "vitest";
import { shouldOpenInAppPopup } from "./window-open.js";

const appOrigin = "https://aiden.example.com";

describe("desktop child windows", () => {
  it("keeps same-origin app routes in Electron", () => {
    expect(shouldOpenInAppPopup(appOrigin, `${appOrigin}/mcp/oauth/callback`, "_blank")).toBe(true);
  });

  it("opens ordinary external links outside Electron", () => {
    expect(
      shouldOpenInAppPopup(appOrigin, "https://github.com/octocat/hello-world/pull/395", "_blank"),
    ).toBe(false);
  });

  it.each(["aiden-model-oauth", "aiden-mcp-oauth", "aiden-app-connect", "aiden-plugin-connect"])(
    "keeps the intentional %s flow in an Electron popup",
    (frameName) => {
      expect(
        shouldOpenInAppPopup(appOrigin, "https://provider.example.com/authorize", frameName),
      ).toBe(true);
    },
  );

  it("rejects malformed URLs and non-HTTPS third-party targets", () => {
    expect(shouldOpenInAppPopup(appOrigin, "not a url", "aiden-model-oauth")).toBe(false);
    expect(
      shouldOpenInAppPopup(appOrigin, "http://provider.example.com", "aiden-model-oauth"),
    ).toBe(false);
  });
});
