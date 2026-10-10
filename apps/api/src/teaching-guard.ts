import { listOmnigentTaughtSkills } from "@superchat/adapters";
import type { Actor } from "@superchat/contracts";
import type { PrismaClient } from "@superchat/db";
import { ORPCError } from "@orpc/server";
import { engineComputerClient, engineSessionOf } from "./engine-client.js";

/** The Muse's active teaching session, if any; sends are held while the person is teaching. */
export async function assertTeachingSendAllowed(
  prisma: PrismaClient,
  actor: Actor,
  botId: string,
): Promise<void> {
  const client = engineComputerClient(actor);
  if (!client) return;
  const recording = await (async () => {
    try {
      const { email, sessionId } = await engineSessionOf({ prisma }, client, actor, botId);
      if (!sessionId) return false;
      const skills = await listOmnigentTaughtSkills(client, email, sessionId);
      return skills.some((skill) => skill.status === "recording");
    } catch {
      // The send itself needs the engine and fails clearly there; never block on this check.
      return false;
    }
  })();
  if (recording) throw new ORPCError("CONFLICT", { message: "Stop teaching first" });
}
