import type { TaughtSkill, ThreadSnapshot } from "@aiden/contracts";
import {
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
  useCallback,
  useState,
} from "react";
import { rpc } from "../../../lib/rpc";

/** Stopping a teaching recording and refreshing the teach chrome. */
export function useTeaching({
  activeBotId,
  taughtSkills,
  taughtSkillsBotId,
  setTaughtSkills,
  setTaughtSkillsBotId,
  refreshThreadRef,
  setComputerOpen,
}: {
  activeBotId: MutableRefObject<string | undefined>;
  taughtSkills: TaughtSkill[];
  taughtSkillsBotId: string | null;
  setTaughtSkills: Dispatch<SetStateAction<TaughtSkill[]>>;
  setTaughtSkillsBotId: Dispatch<SetStateAction<string | null>>;
  refreshThreadRef: MutableRefObject<(id: string, signal?: AbortSignal) => Promise<ThreadSnapshot>>;
  setComputerOpen: Dispatch<SetStateAction<boolean>>;
}) {
  const [teachBusy, setTeachBusy] = useState(false);
  const stopTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id || teachBusy) return;
    const recording = taughtSkills.find(
      (skill) => skill.status === "recording" && taughtSkillsBotId === id,
    );
    if (!recording) return;
    setTeachBusy(true);
    try {
      await rpc.skills.stop({ skillId: recording.id });
      await refreshThreadRef.current(id);
      setComputerOpen(false);
    } finally {
      setTeachBusy(false);
    }
  }, [teachBusy, taughtSkills, taughtSkillsBotId]);
  // Teach chrome needs skills applied before this resolves — refreshThread only
  // kicks skills.list off in the background, so Stop teaching would never mount
  // if that background call failed or lagged behind local recovery.
  const refreshActiveTeaching = useCallback(async () => {
    const id = activeBotId.current;
    if (!id) return;
    await refreshThreadRef.current(id);
    const skills = await rpc.skills.list({ botId: id });
    if (activeBotId.current !== id) return;
    setTaughtSkills(skills);
    setTaughtSkillsBotId(id);
  }, []);
  return { teachBusy, stopTeaching, refreshActiveTeaching };
}
