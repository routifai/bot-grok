import type { ComputerStatus } from "@nova/contracts";

/** How long a step waits for a Computer that is starting (the managed launch window). */
export const COMPUTER_LAUNCH_WINDOW_MS = 120_000;

/** The Computer's status as the thread's event stream reports it. Nothing here polls: a step that
 * has to wait for the Computer waits for the next status event. */
export interface ComputerFeed {
  current(): ComputerStatus | null;
  subscribe(listener: (status: ComputerStatus | null) => void): () => void;
}

/** Up: running, its runner connected (or not known to be missing), and no launch in progress. */
export function computerIsUp(status: ComputerStatus | null): boolean {
  return Boolean(
    status && status.state === "running" && status.runnerReady !== false && !status.launch,
  );
}

/** The launch failed, so waiting longer cannot help. */
function launchFailed(status: ComputerStatus | null): boolean {
  return status?.launch?.stage === "failed" || status?.state === "error";
}

export class ComputerStartTimeout extends Error {
  constructor() {
    super("The Computer did not start in time");
    this.name = "ComputerStartTimeout";
  }
}

/** Resolves when a status event says the Computer is up. Rejects when `signal` aborts, when the
 * launch fails, or when `windowMs` passes. */
export function waitForComputerUp(
  feed: ComputerFeed,
  signal: AbortSignal,
  windowMs: number = COMPUTER_LAUNCH_WINDOW_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const finish = (done: () => void) => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", onAbort);
      done();
    };
    const onAbort = () => finish(() => reject(signal.reason));
    const react = (status: ComputerStatus | null) => {
      if (computerIsUp(status)) finish(resolve);
      else if (launchFailed(status)) finish(() => reject(new ComputerStartTimeout()));
    };
    // An event that landed before this wait began is not lost: look at the status as it is now.
    const unsubscribe = feed.subscribe(react);
    const timer = setTimeout(() => finish(() => reject(new ComputerStartTimeout())), windowMs);
    signal.addEventListener("abort", onAbort, { once: true });
    react(feed.current());
  });
}

/**
 * Runs one step that needs the Computer (a workspace write). If the engine answers "starting",
 * `onStarting` fires, the step waits for the status event that says the Computer is up (or for
 * `signal` to abort), then runs once more. No timer retries.
 */
export async function runWhenComputerReady<T>(
  attempt: () => Promise<T>,
  options: {
    isStarting: (error: unknown) => boolean;
    onStarting: () => void;
    feed: ComputerFeed;
    signal: AbortSignal;
    windowMs?: number;
  },
): Promise<T> {
  options.signal.throwIfAborted();
  try {
    return await attempt();
  } catch (error) {
    if (!options.isStarting(error)) throw error;
    options.onStarting();
    try {
      await waitForComputerUp(options.feed, options.signal, options.windowMs);
    } catch (waitError) {
      if (waitError instanceof ComputerStartTimeout) throw error;
      throw waitError;
    }
  }
  return attempt();
}

/** Calls `onStarting` / `onUp` as status events say the Computer goes down or up while a call
 * that wakes it (the engine's ingest) is in flight. Returns the unsubscribe. */
export function followComputerStart(
  feed: ComputerFeed,
  handlers: { onStarting: () => void; onUp: () => void },
): () => void {
  const apply = (status: ComputerStatus | null) => {
    if (status === null) return;
    if (computerIsUp(status)) handlers.onUp();
    else handlers.onStarting();
  };
  apply(feed.current());
  return feed.subscribe(apply);
}
