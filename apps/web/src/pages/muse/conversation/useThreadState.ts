import type { ThreadSnapshot } from "@nova/contracts";
import { withLiveStreamingProgress } from "@nova/core";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  getResponseStreamingEnabled,
  subscribeResponseStreaming,
} from "../../../lib/response-streaming";

/** The open thread's snapshot, mirrored in a ref so SSE handlers and async refreshes read the
 * latest one, with live-streaming progress layered on according to the user's preference. */
export function useThreadState() {
  const [snapshot, setSnapshot] = useState<ThreadSnapshot | null>(null);
  const snapshotRef = useRef<ThreadSnapshot | null>(null);
  const streamResponses = useSyncExternalStore(
    subscribeResponseStreaming,
    getResponseStreamingEnabled,
    () => false,
  );
  const streamResponsesRef = useRef(streamResponses);
  streamResponsesRef.current = streamResponses;
  function commitSnapshot(next: ThreadSnapshot | null) {
    snapshotRef.current = next;
    setSnapshot(withLiveStreamingProgress(next, streamResponsesRef.current));
  }

  useEffect(() => {
    setSnapshot(withLiveStreamingProgress(snapshotRef.current, streamResponses));
  }, [streamResponses]);

  function updateSnapshot(update: (prev: ThreadSnapshot | null) => ThreadSnapshot | null) {
    commitSnapshot(update(snapshotRef.current));
  }
  return { snapshot, snapshotRef, commitSnapshot, updateSnapshot };
}
