import { createContext, type ReactNode, useContext } from "react";
import type { OrbState } from "./orbState";

const SuperchatPresence = createContext<OrbState>("idle");

/** Whether Superchat is working right now, for every orb that doesn't pass its own state. The shell
 * provides it from live run and Activity data (useSuperchatWork), so all orbs brighten together. */
export function SuperchatPresenceProvider({
  state,
  children,
}: {
  state: OrbState;
  children: ReactNode;
}) {
  return <SuperchatPresence.Provider value={state}>{children}</SuperchatPresence.Provider>;
}

export function useSuperchatPresence(): OrbState {
  return useContext(SuperchatPresence);
}
