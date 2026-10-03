// The context panel's identity header shows a small Connection Status line ("Connected" /
// "Connecting…") describing whether Nova's calls are reaching the server at all — not
// whether the Muse is busy (that's `useMuseLiveState`). Derived from the last poll's
// outcome on whichever wires the panel already has, so no extra request is made just to
// answer this.

/** The subset of a poll's state this only needs: whether the last attempt ever landed. A
 * poll that answered `NOT_IMPLEMENTED` still reached a real server, so it counts as
 * connected too — only "still loading" or "a request failed" read as "Connecting…". */
export type PollOutcome = { status: "loading" | "ready" | "unavailable" | "error" };

export type ConnectionStatus = "connected" | "connecting";

function reached(poll: PollOutcome | undefined): boolean {
  return poll?.status === "ready" || poll?.status === "unavailable";
}

/** "Connected" once any one of the panel's polls has landed a real response; "Connecting…"
 * only while every poll given is still loading or failing. */
export function deriveConnectionStatus(...polls: (PollOutcome | undefined)[]): ConnectionStatus {
  return polls.some(reached) ? "connected" : "connecting";
}
