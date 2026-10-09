import { oc } from "@orpc/contract";
import * as z from "zod";
import { AgentSecretInputSchema, AgentSecretSchema } from "../domain.js";
import { Id } from "../ids.js";

export const agentSecretsContract = {
  agentSecrets: {
    list: oc.output(z.array(AgentSecretSchema)),
    put: oc.input(AgentSecretInputSchema).output(AgentSecretSchema),
    remove: oc.input(z.object({ id: Id })).output(z.object({ ok: z.literal(true) })),
  },
};
