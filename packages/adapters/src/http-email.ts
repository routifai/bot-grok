import { randomUUID } from "node:crypto";
import type { TransactionalEmail, TransactionalEmailProvider } from "@nova/adapter-kit";

export interface HttpEmailConfig {
  /** Send endpoint of a Resend-compatible API, e.g. `https://api.resend.com/emails`. */
  url: string;
  apiKey: string;
  from: string;
}

interface HttpEmailDependencies {
  fetch?: typeof fetch;
  retryDelaysMs?: readonly number[];
  drainTimeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
}

/**
 * Delivery over a Resend-style HTTPS API (`POST {from, to, subject, text, html}` with a bearer
 * key). Works with any vendor that accepts that shape, so no vendor SDK or variable is needed.
 */
export class HttpEmailProvider implements TransactionalEmailProvider {
  private readonly send_: typeof fetch;
  private readonly retryDelaysMs: readonly number[];
  private readonly drainTimeoutMs: number;
  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly inFlight = new Set<Promise<void>>();
  private accepting = true;

  constructor(
    private readonly config: HttpEmailConfig,
    dependencies: HttpEmailDependencies = {},
  ) {
    let protocol: string | undefined;
    try {
      protocol = new URL(config.url).protocol;
    } catch {
      protocol = undefined;
    }
    if (protocol !== "https:" && !isLoopbackHttp(config.url)) {
      throw new Error("EMAIL_API_URL must use https://");
    }
    if (!config.apiKey.trim()) throw new Error("EMAIL_API_KEY is required with EMAIL_API_URL");
    if (!config.from.trim()) throw new Error("EMAIL_FROM is required with EMAIL_API_URL");
    this.send_ = dependencies.fetch ?? fetch;
    this.retryDelaysMs = dependencies.retryDelaysMs ?? [250, 1_000];
    this.drainTimeoutMs = dependencies.drainTimeoutMs ?? 10_000;
    this.sleep =
      dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  }

  describe() {
    return {
      id: "http-email",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { transactional: true },
    };
  }

  send(message: TransactionalEmail): Promise<void> {
    if (!this.accepting) return Promise.reject(new Error("Email provider is shutting down"));
    const delivery = this.deliver(message);
    this.inFlight.add(delivery);
    const forget = () => this.inFlight.delete(delivery);
    void delivery.then(forget, forget);
    return delivery;
  }

  async drain(): Promise<void> {
    this.accepting = false;
    await Promise.race([
      Promise.allSettled([...this.inFlight]),
      new Promise((resolve) => setTimeout(resolve, this.drainTimeoutMs)),
    ]);
  }

  private async deliver(message: TransactionalEmail): Promise<void> {
    // One key across every retry, so a slow first attempt cannot become two emails.
    const idempotencyKey = randomUUID();
    for (let attempt = 0; ; attempt += 1) {
      let retryable = true;
      let failure: Error;
      try {
        const response = await this.send_(this.config.url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.config.apiKey}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: JSON.stringify({
            from: this.config.from,
            to: [message.to],
            subject: message.subject,
            text: message.text,
            html: message.html,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return;
        retryable = response.status === 429 || response.status >= 500;
        failure = new Error(`Email API responded with ${response.status}`);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Email API request failed");
      }
      const delay = this.retryDelaysMs[attempt];
      if (!retryable || delay === undefined) throw failure;
      await this.sleep(delay);
    }
  }
}

function isLoopbackHttp(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}
