import { isSessionNotFoundError } from "@aiden/adapters";
import { ORPCError } from "@orpc/server";

/** An engine call on a Super Chat the engine no longer has reads as "no Conversation yet"; the
 * next turn recreates it. Every other failure passes through unchanged. */
export async function onSuperChat<T>(call: Promise<T>): Promise<T> {
  try {
    return await call;
  } catch (error) {
    if (isSessionNotFoundError(error)) {
      throw new ORPCError("NOT_FOUND", { message: "This Muse has no Conversation yet" });
    }
    throw error;
  }
}
