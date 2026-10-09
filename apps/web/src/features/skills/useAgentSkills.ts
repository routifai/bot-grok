import type { AgentSkillCatalogEntry } from "@nova/contracts";
import { useCallback, useEffect, useState } from "react";
import { rpc } from "../../../lib/rpc";

/** The agent skill catalog the composer's slash menu offers. */
export function useAgentSkills() {
  const [agentSkills, setAgentSkills] = useState<AgentSkillCatalogEntry[]>([]);
  useEffect(() => {
    let cancelled = false;
    void rpc.agentSkills
      .list()
      .then((skills) => {
        if (!cancelled) setAgentSkills(skills);
      })
      .catch(() => {
        if (!cancelled) setAgentSkills([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshAgentSkills = useCallback(() => {
    void rpc.agentSkills
      .list()
      .then(setAgentSkills)
      .catch(() => undefined);
  }, []);
  return { agentSkills, setAgentSkills, refreshAgentSkills };
}
