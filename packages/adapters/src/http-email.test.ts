import { describe, expect, it, vi } from "vitest";
import { HttpEmailProvider } from "./http-email.js";

const config = {
  url: "https://mail.example.test/emails",
  apiKey: "key-1",
  from: "Nova <a@b.test>",
};
const message = { to: "ada@example.test", subject: "Hi", text: "Plain", html: "<p>Hi</p>" };

describe("HttpEmailProvider", () => {
  it("posts a Resend-style payload with a bearer key", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    const provider = new HttpEmailProvider(config, { fetch: fetchMock as never });
    await provider.send(message);
    const [url, init] = (fetchMock.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(url).toBe(config.url);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key-1");
    expect(JSON.parse(String(init.body))).toEqual({
      from: config.from,
      to: ["ada@example.test"],
      subject: "Hi",
      text: "Plain",
      html: "<p>Hi</p>",
    });
    expect(provider.describe().capabilities.transactional).toBe(true);
  });

  it("retries 5xx and 429 but not other client errors", async () => {
    const sleep = vi.fn(async (_delayMs: number) => undefined);
    const flaky = vi
      .fn()
      .mockResolvedValueOnce(new Response("", { status: 503 }))
      .mockResolvedValueOnce(new Response("", { status: 429 }))
      .mockResolvedValue(new Response("{}", { status: 200 }));
    await new HttpEmailProvider(config, { fetch: flaky as never, sleep }).send(message);
    expect(flaky).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([250, 1_000]);
    const keys = (flaky.mock.calls as unknown as Array<[string, RequestInit]>).map(([, init]) =>
      new Headers(init.headers).get("idempotency-key"),
    );
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBeTruthy();

    const rejected = vi.fn(async () => new Response("", { status: 422 }));
    await expect(
      new HttpEmailProvider(config, { fetch: rejected as never, sleep }).send(message),
    ).rejects.toThrow("422");
    expect(rejected).toHaveBeenCalledTimes(1);
  });

  it("refuses insecure endpoints, missing keys and deliveries after drain", async () => {
    expect(() => new HttpEmailProvider({ ...config, url: "http://mail.example.test/x" })).toThrow(
      "https",
    );
    expect(() => new HttpEmailProvider({ ...config, apiKey: " " })).toThrow("EMAIL_API_KEY");
    const provider = new HttpEmailProvider(config, {
      fetch: vi.fn(async () => new Response("{}")) as never,
    });
    await provider.drain();
    await expect(provider.send(message)).rejects.toThrow("shutting down");
  });
});
