import type { RoundSummary, RoundView, ThreadMessage } from "@superchat/contracts";
import { useCallback, useSyncExternalStore } from "react";
import { watchFamily } from "../../lib/family-stream";
import { rpc } from "../../lib/rpc";

// The Conversation's Rounds (ADR 0029), read from the engine's record: the recent list, kept
// current from the family stream's `roundUpdated` (it carries the Round's summary), and one Round
// in full, read again on each update to it. An update only says the record grew, so reads are
// coalesced: one in flight, at most one more after it.

type Store<T> = {
  value: T;
  listeners: Set<() => void>;
  stop: (() => void) | null;
  reading: boolean;
  again: boolean;
};

const NO_ROUNDS: readonly RoundSummary[] = [];
const lists = new Map<string, Store<readonly RoundSummary[]>>();
const views = new Map<string, Store<RoundView | null>>();

function storeIn<T>(stores: Map<string, Store<T>>, key: string, empty: T): Store<T> {
  let store = stores.get(key);
  if (!store) {
    store = { value: empty, listeners: new Set(), stop: null, reading: false, again: false };
    stores.set(key, store);
  }
  return store;
}

function publish<T>(store: Store<T>, value: T): void {
  store.value = value;
  for (const listener of [...store.listeners]) listener();
}

/** Reads into `store`, or queues one more read behind the one in flight. */
function read<T>(store: Store<T>, load: () => Promise<T>): void {
  if (store.reading) {
    store.again = true;
    return;
  }
  store.reading = true;
  load()
    .then(
      (value) => publish(store, value),
      () => undefined,
    )
    .finally(() => {
      store.reading = false;
      if (store.again) {
        store.again = false;
        read(store, load);
      }
    });
}

/** Subscribes to `store`, reading it and watching the family stream while anything listens. */
function listen<T>(
  store: Store<T>,
  botId: string,
  load: () => Promise<T>,
  onEvent: Parameters<typeof watchFamily>[1],
  listener: () => void,
): () => void {
  store.listeners.add(listener);
  if (!store.stop) {
    read(store, load);
    store.stop = watchFamily(botId, (event) => {
      // A (re)connect may have missed updates.
      if (event.type === "open" && !store.reading) read(store, load);
      else onEvent(event);
    });
  }
  return () => {
    store.listeners.delete(listener);
    if (store.listeners.size === 0) {
      store.stop?.();
      store.stop = null;
    }
  };
}

/** The Conversation's latest Rounds, newest first (none while `botId` is unknown). */
export function useRounds(botId: string | undefined): readonly RoundSummary[] {
  const subscribe = useCallback(
    (listener: () => void) => {
      if (!botId) return () => undefined;
      const store = storeIn(lists, botId, NO_ROUNDS);
      const load = () => rpc.chats.rounds({ botId }).then(({ rounds }) => rounds);
      return listen(
        store,
        botId,
        load,
        (event) => {
          if (event.type !== "roundUpdated") return;
          const { type: _, ...round } = event;
          const known = store.value.some((r) => r.roundId === round.roundId);
          publish(
            store,
            known
              ? store.value.map((r) => (r.roundId === round.roundId ? round : r))
              : [round, ...store.value],
          );
        },
        listener,
      );
    },
    [botId],
  );
  return useSyncExternalStore(subscribe, () =>
    botId ? storeIn(lists, botId, NO_ROUNDS).value : NO_ROUNDS,
  );
}

/** One Round in full, read when first shown and again on each update to it; null until read. */
export function useRoundView(botId: string, roundId: string): RoundView | null {
  const key = `${botId}\n${roundId}`;
  const subscribe = useCallback(
    (listener: () => void) => {
      const store = storeIn<RoundView | null>(views, key, null);
      const load = () => rpc.chats.round({ botId, roundId });
      return listen(
        store,
        botId,
        load,
        (event) => {
          if (event.type === "roundUpdated" && event.roundId === roundId) read(store, load);
        },
        listener,
      );
    },
    [key, botId, roundId],
  );
  return useSyncExternalStore(subscribe, () => storeIn<RoundView | null>(views, key, null).value);
}

/** The transcript with each message that opened a Round carrying its id (the Round's id is the
 * message's own). Unchanged when no message did. */
export function withRounds(messages: ThreadMessage[], ids: ReadonlySet<string>): ThreadMessage[] {
  if (!messages.some((message) => message.role === "user" && ids.has(message.id))) return messages;
  return messages.map((message) =>
    message.role === "user" && ids.has(message.id) && message.roundId !== message.id
      ? { ...message, roundId: message.id }
      : message,
  );
}

/** When the newest running Round began (ms, the engine's clock), or null when none runs. */
export function runningRoundSince(rounds: readonly RoundSummary[]): number | null {
  return rounds.find((round) => round.status === "running")?.startedAt ?? null;
}

/** Forget every reader (tests). */
export function resetRounds(): void {
  for (const store of [...lists.values(), ...views.values()]) store.stop?.();
  lists.clear();
  views.clear();
}
