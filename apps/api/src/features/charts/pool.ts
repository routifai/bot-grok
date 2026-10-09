import { Worker } from "node:worker_threads";
import type { ChartDocument } from "@nova/charts";
import type { ChartImageFormat, ChartTheme, RenderedChart } from "./render.js";

export interface RenderJob {
  document: Pick<ChartDocument, "spec" | "data">;
  options: { width: number; height: number; theme: ChartTheme; format: ChartImageFormat };
}

export class RenderBusyError extends Error {}
export class RenderTimeoutError extends Error {}

type Reply =
  | {
      id: number;
      ok: true;
      mimeType: RenderedChart["mimeType"];
      bytes: Uint8Array;
      width: number;
      height: number;
    }
  | { id: number; ok: false; message: string };

interface Pending {
  id: number;
  job: RenderJob;
  resolve: (image: RenderedChart) => void;
  reject: (error: Error) => void;
}

interface Slot {
  worker: Worker;
  current?: { pending: Pending; timer: NodeJS.Timeout };
}

export interface RenderPoolOptions {
  /** The worker script (the TS file under tsx, which workers inherit). */
  workerUrl: URL;
  size?: number;
  /** A render running longer than this is killed (ms). */
  timeoutMs?: number;
  /** Jobs waiting for a free worker beyond this are refused. */
  maxQueue?: number;
}

/**
 * A small pool of worker threads that draw chart images, so a slow chart never blocks the API's
 * event loop. A job past its deadline kills its worker (replaced on demand); a full queue refuses
 * new jobs instead of growing without bound.
 */
export class RenderPool {
  private readonly slots: Slot[] = [];
  private readonly queue: Pending[] = [];
  private nextId = 1;
  private closed = false;
  private readonly size: number;
  private readonly timeoutMs: number;
  private readonly maxQueue: number;

  constructor(private readonly options: RenderPoolOptions) {
    this.size = options.size ?? 2;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxQueue = options.maxQueue ?? 24;
  }

  render(job: RenderJob): Promise<RenderedChart> {
    if (this.closed) return Promise.reject(new Error("The render pool is closed"));
    return new Promise((resolve, reject) => {
      const pending: Pending = { id: this.nextId++, job, resolve, reject };
      const slot = this.idleSlot();
      if (slot) return this.run(slot, pending);
      if (this.queue.length >= this.maxQueue) {
        return reject(new RenderBusyError("Too many charts are rendering; try again shortly"));
      }
      this.queue.push(pending);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const pending of this.queue.splice(0))
      pending.reject(new Error("The render pool is closed"));
    await Promise.all(this.slots.splice(0).map((slot) => slot.worker.terminate()));
  }

  private idleSlot(): Slot | undefined {
    const idle = this.slots.find((slot) => !slot.current);
    if (idle) return idle;
    if (this.slots.length >= this.size) return undefined;
    const slot: Slot = { worker: new Worker(this.options.workerUrl) };
    slot.worker.on("message", (reply: Reply) => this.settle(slot, reply));
    slot.worker.on("error", (error) => this.fail(slot, error));
    slot.worker.on("exit", () => this.fail(slot, new Error("The render worker stopped")));
    this.slots.push(slot);
    return slot;
  }

  private run(slot: Slot, pending: Pending): void {
    const timer = setTimeout(() => {
      this.fail(slot, new RenderTimeoutError("The chart took too long to draw"));
      void slot.worker.terminate();
    }, this.timeoutMs);
    slot.current = { pending, timer };
    slot.worker.postMessage({ id: pending.id, job: pending.job });
  }

  private settle(slot: Slot, reply: Reply): void {
    const current = slot.current;
    if (!current || current.pending.id !== reply.id) return;
    clearTimeout(current.timer);
    slot.current = undefined;
    if (reply.ok) {
      current.pending.resolve({
        mimeType: reply.mimeType,
        bytes: Buffer.from(reply.bytes),
        width: reply.width,
        height: reply.height,
      });
    } else {
      current.pending.reject(new Error(reply.message));
    }
    this.drain();
  }

  /** The slot's worker died or timed out: fail its job and drop the slot (a new worker spawns on demand). */
  private fail(slot: Slot, error: Error): void {
    const index = this.slots.indexOf(slot);
    if (index === -1) return;
    this.slots.splice(index, 1);
    if (slot.current) {
      clearTimeout(slot.current.timer);
      slot.current.pending.reject(error);
      slot.current = undefined;
    }
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0 && !this.closed) {
      const slot = this.idleSlot();
      const next = this.queue.shift();
      if (!slot || !next) {
        if (next) this.queue.unshift(next);
        return;
      }
      this.run(slot, next);
    }
  }
}

let shared: RenderPool | undefined;

/** The API's one pool, started on first use. */
export function sharedRenderPool(): RenderPool {
  shared ??= new RenderPool({
    workerUrl: new URL("./render-worker.ts", import.meta.url),
    size: 2,
  });
  return shared;
}
