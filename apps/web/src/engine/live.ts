// `live.*`: a page kept up to date on a schedule (engine/omnigent/omnigent/superchat/live). The
// engine owns the schedule, the sources and the update versions; this maps its rows to the shapes
// the page speaks. The engine 404s another owner's page.
import {
  acceptOmnigentLive,
  deleteOmnigentLive,
  getOmnigentLive,
  type OmnigentLive,
  putOmnigentLive,
  runOmnigentLive,
  undoOmnigentLive,
} from "@superchat/adapters/omnigent/browser";
import type { Live } from "@superchat/contracts";
import { notFound } from "./artifacts";
import { rruleToSchedule, scheduleToRrule } from "./automations";
import { engineClient, NO_EMAIL } from "./client";
import { os } from "./context";

export function toLive(live: OmnigentLive): Live {
  return {
    schedule: live.rrule ? rruleToSchedule(live.rrule) : null,
    active: live.schedule === "active",
    sources: live.sources,
    tell: live.tell,
    followPublish: live.follow_publish,
    checkedAt: live.checked_at,
    openIssue: live.open_issue,
    lastUpdate: live.last_update && {
      version: live.last_update.version,
      applied: live.last_update.applied,
      suggestions: live.last_update.suggestions.map(({ source_value, ...rest }) => ({
        ...rest,
        sourceValue: source_value,
      })),
      at: live.last_update.at,
    },
  };
}

const ok = { ok: true as const };

export const liveRouter = {
  live: {
    get: os.live.get.handler(async ({ input }) => {
      const live = await getOmnigentLive(engineClient(), NO_EMAIL, input.artifactId).catch(
        notFound,
      );
      return live && toLive(live);
    }),
    save: os.live.save.handler(async ({ input }) => {
      const live = await putOmnigentLive(engineClient(), NO_EMAIL, input.artifactId, {
        rrule: scheduleToRrule(input.schedule),
        ...(input.sources ? { sources: input.sources } : {}),
        ...(input.tell ? { tell: input.tell } : {}),
        ...(input.followPublish === undefined ? {} : { follow_publish: input.followPublish }),
      }).catch(notFound);
      return live && toLive(live);
    }),
    stop: os.live.stop.handler(async ({ input }) => {
      await deleteOmnigentLive(engineClient(), NO_EMAIL, input.artifactId).catch(notFound);
      return ok;
    }),
    run: os.live.run.handler(async ({ input }) => {
      await runOmnigentLive(engineClient(), NO_EMAIL, input.artifactId).catch(notFound);
      return ok;
    }),
    undo: os.live.undo.handler(({ input }) =>
      undoOmnigentLive(engineClient(), NO_EMAIL, input.artifactId).catch(notFound),
    ),
    accept: os.live.accept.handler(({ input }) =>
      acceptOmnigentLive(engineClient(), NO_EMAIL, input.artifactId, input.elementId).catch(
        notFound,
      ),
    ),
  },
};
