import { oc } from "@orpc/contract";
import * as z from "zod";
import { Id } from "../ids.js";
import { ArchivingSchema, ArchivingUpdateSchema, MuseSettingsSchema } from "../muse.js";

export const museContract = {
  muse: {
    settings: oc.input(z.object({ botId: Id })).output(MuseSettingsSchema),
    updateSettings: oc
      .input(MuseSettingsSchema.partial().safeExtend({ botId: Id }))
      .output(MuseSettingsSchema),
    archiving: oc.input(z.object({ botId: Id })).output(ArchivingSchema),
    updateArchiving: oc
      .input(ArchivingUpdateSchema.safeExtend({ botId: Id }))
      .output(ArchivingSchema),
  },
};
