// Real `dailyNotes.*` handlers: the person's daily notes (engine, per owner).
import {
  listOmnigentDailyNotes,
  type OmnigentDailyNote,
  putOmnigentDailyNote,
  redactMemoryProfile,
} from "@nova/adapters";
import type { Actor } from "@nova/contracts";
import { onSuperChat } from "../../omnigent-errors.js";
import { requireClient, requireSuperChat, type SuperChatDeps } from "../../super-chat-session.js";

function mapDailyNote(note: OmnigentDailyNote, secrets: string[]) {
  return {
    date: note.date,
    sections: Object.fromEntries(
      Object.entries(note.sections).map(([key, text]) => [
        key,
        redactMemoryProfile(text, secrets) ?? "",
      ]),
    ),
    editedByPerson: note.edited_by_person,
    finalized: note.finalized,
    updatedAt: note.updated_at,
  };
}

/** `dailyNotes.list`: the person's recent daily notes (engine, per owner). */
export async function listDailyNotes(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string; limit: number },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { email } = await requireSuperChat(deps, actor, input.botId);
  const notes = await onSuperChat(listOmnigentDailyNotes(client, email, input.limit));
  return { notes: notes.map((note) => mapDailyNote(note, client.secrets ?? [])) };
}

/** `dailyNotes.save`: the person's edit of one day's note. */
export async function saveDailyNote(
  deps: SuperChatDeps,
  actor: Actor,
  input: { botId: string; date: string; sections: Record<string, string> },
  env: NodeJS.ProcessEnv = process.env,
) {
  const client = requireClient(env, actor);
  const { email } = await requireSuperChat(deps, actor, input.botId);
  const note = await onSuperChat(putOmnigentDailyNote(client, email, input.date, input.sections));
  return mapDailyNote(note, client.secrets ?? []);
}
