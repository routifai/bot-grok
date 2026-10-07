import type { FamilyEvent } from "@aiden/contracts";
import { rpc } from "./rpc";

/** Opens the Muse's family stream (`chats.watch`). A seam so tests and fixtures can supply
 * their own events instead of the live relay. */
export type FamilyWatch = (
  input: { botId: string },
  signal: AbortSignal,
) => Promise<AsyncIterable<FamilyEvent>>;

const liveWatch: FamilyWatch = (input, signal) => rpc.chats.watch(input, { signal });

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 15_000;

type Listener = (event: FamilyEvent) => void;

/**
 * One live stream per Muse for the Conversation, its Side Chats and Helpers (ADR 0009). Events
 * carry ids only: every listener refetches what it shows. The stream opens with the first
 * listener and closes with the last; it reconnects with backoff and tells listeners `open` each
 * time it is (re)connected, so whatever was missed meanwhile is refetched.
 */
class FamilyStream {
  private readonly listeners = new Set<Listener>();
  private abort: AbortController | undefined;

  constructor(
    private readonly botId: string,
    private readonly watch: FamilyWatch,
    private readonly onIdle: () => void,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.abort?.abort();
        this.abort = undefined;
        this.onIdle();
      }
    };
  }

  private emit(event: FamilyEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private start(): void {
    const abort = new AbortController();
    this.abort = abort;
    void (async () => {
      let retryMs = RETRY_MIN_MS;
      while (!abort.signal.aborted) {
        try {
          const events = await this.watch({ botId: this.botId }, abort.signal);
          for await (const event of events) {
            if (abort.signal.aborted) return;
            retryMs = RETRY_MIN_MS;
            this.emit(event);
          }
        } catch {
          if (abort.signal.aborted) return;
        }
        await new Promise((resolve) => setTimeout(resolve, retryMs));
        retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
      }
    })();
  }
}

const streams = new Map<string, FamilyStream>();

/** Listens to a Muse's family stream; returns the unsubscribe. */
export function watchFamily(
  botId: string,
  listener: Listener,
  watch: FamilyWatch = liveWatch,
): () => void {
  let stream = streams.get(botId);
  if (!stream) {
    const created = new FamilyStream(botId, watch, () => {
      if (streams.get(botId) === created) streams.delete(botId);
    });
    streams.set(botId, created);
    stream = created;
  }
  return stream.subscribe(listener);
}
