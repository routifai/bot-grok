import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type { TranscriptWork, TurnWork } from "./workPlan";
import { drawnKey } from "./workPlan";
import type { StripHelper, StripTurn } from "./workStripState";

type Strip = { helpers: StripHelper[]; turn: StripTurn };
type Input = { work: TranscriptWork; running: boolean; liveLabel: string | undefined };

/** What a reply's strip shows, as text: two TurnWorks with the same one are the same work. */
const workKey = (work: TurnWork): string => JSON.stringify(work);

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const key of a) if (!b.has(key)) return false;
  return true;
}

/**
 * The transcript's work, handed out per message: a message reads only its own strip, and a
 * strip keeps its identity while its reply's work did not change, so a transcript update (a
 * streamed word, another reply's plan) re-renders only the messages whose strip it touched.
 */
class TurnWorkStore {
  private keys = new Map<string, string>();
  private strips = new Map<string, Strip>();
  private drawn: ReadonlySet<string> = new Set();
  private listeners = new Set<() => void>();
  /** Something changed since the messages were last told. */
  private dirty = false;

  constructor(input: Input) {
    this.update(input);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  strip = (messageId: string): Strip | null => this.strips.get(messageId) ?? null;

  drawnKeys = (): ReadonlySet<string> => this.drawn;

  /** Takes the transcript's newest work. Messages rendered after it read it at once; the
   * others hear of it in `notify`. */
  update({ work, running, liveLabel }: Input): void {
    let changed = false;
    const keys = new Map<string, string>();
    const strips = new Map<string, Strip>();
    for (const [id, found] of work.turns) {
      const live = Boolean(found.last && running);
      const key = `${workKey(found)}|${found.outcome ?? ""}|${live}|${live ? (liveLabel ?? "") : ""}`;
      const kept = this.strips.get(id);
      keys.set(id, key);
      if (kept && this.keys.get(id) === key) {
        strips.set(id, kept);
        continue;
      }
      changed = true;
      strips.set(id, {
        helpers: found.helpers,
        turn: {
          plan: found.plan,
          live,
          startedAt: found.startedAt,
          endedAt: found.endedAt,
          ...(found.outcome ? { outcome: found.outcome } : {}),
          ...(live && liveLabel ? { liveLabel } : {}),
        },
      });
    }
    if (strips.size !== this.strips.size) changed = true;
    this.keys = keys;
    this.strips = strips;
    if (!sameSet(this.drawn, work.drawn)) {
      this.drawn = work.drawn;
      changed = true;
    }
    this.dirty ||= changed;
  }

  notify(): void {
    if (!this.dirty) return;
    this.dirty = false;
    for (const listener of this.listeners) listener();
  }
}

const TurnWorkContext = createContext<TurnWorkStore | null>(null);

const noSubscribe = () => () => undefined;
const NO_DRAWN: ReadonlySet<string> = new Set();

/** Wrap a transcript once with its `transcriptWork` (workPlan.ts): each reply's strip then finds
 * its plan and running state, and the plan cards a strip draws stay out of the transcript. */
export function TurnWorkProvider({
  work,
  running,
  liveLabel,
  children,
}: {
  work: TranscriptWork;
  /** The newest reply is being written. */
  running: boolean;
  /** What the running turn is doing now ("Reading files…"). */
  liveLabel?: string;
  children: ReactNode;
}) {
  const [store] = useState(() => new TurnWorkStore({ work, running, liveLabel }));
  // Read during this render by the messages it renders; the memoised ones it skips are told
  // once it commits.
  store.update({ work, running, liveLabel });
  useLayoutEffect(() => store.notify(), [store, work, running, liveLabel]);
  return <TurnWorkContext.Provider value={store}>{children}</TurnWorkContext.Provider>;
}

/** The strip a message carries (it is its reply's anchor), or null. */
export function useTurnStrip(messageId: string): Strip | null {
  const store = useContext(TurnWorkContext);
  const read = useCallback(() => store?.strip(messageId) ?? null, [store, messageId]);
  return useSyncExternalStore(store?.subscribe ?? noSubscribe, read, read);
}

/** Whether a strip draws this card (the reply's living plan), so the card itself is not shown. */
export function useDrawnByStrip(): (messageId: string, index: number) => boolean {
  const store = useContext(TurnWorkContext);
  const drawn = useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.drawnKeys ?? (() => NO_DRAWN),
    store?.drawnKeys ?? (() => NO_DRAWN),
  );
  return useCallback((messageId, index) => drawn.has(drawnKey(messageId, index)), [drawn]);
}
