import { createContext, type ReactNode, useContext } from "react";
import type { OrbState } from "./orbState";

const NovaPresence = createContext<OrbState>("idle");

/** Whether Nova is working right now, for every orb that doesn't pass its own state. The shell
 * provides it from live run and Activity data (useNovaWork), so all orbs brighten together. */
export function NovaPresenceProvider({
  state,
  children,
}: {
  state: OrbState;
  children: ReactNode;
}) {
  return <NovaPresence.Provider value={state}>{children}</NovaPresence.Provider>;
}

export function useNovaPresence(): OrbState {
  return useContext(NovaPresence);
}
