import { describe, expect, it } from "vitest";
import { OMNIGENT_ADMIN_HEADER, omnigentClientFor, omnigentHeaders } from "./core.js";

const connection = { baseUrl: "http://engine.test", proxySecret: "s3cret" };

describe("omnigentHeaders admin header", () => {
  it("sends X-Omnigent-Admin for an organization owner or admin", () => {
    const headers = omnigentHeaders(omnigentClientFor(connection, "space-1", true), "a@x.test");
    expect(headers[OMNIGENT_ADMIN_HEADER]).toBe("1");
    expect(headers["X-Omnigent-Proxy-Secret"]).toBe("s3cret");
  });

  it("omits it for a member", () => {
    const headers = omnigentHeaders(omnigentClientFor(connection, "space-1", false), "a@x.test");
    expect(OMNIGENT_ADMIN_HEADER in headers).toBe(false);
    expect(
      OMNIGENT_ADMIN_HEADER in
        omnigentHeaders(omnigentClientFor(connection, "space-1"), "a@x.test"),
    ).toBe(false);
  });
});
