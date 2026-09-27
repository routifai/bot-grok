import { ArtifactsView } from "../Artifacts";

/**
 * F7 · Library. Reuses the Artifacts browsing/preview UI (`ArtifactsView`) with
 * the listing locked to the Muse's bot id, so it never shows another bot's
 * (there is only one) but does include everything the Muse has made, from the
 * Conversation and every Goal log: `artifacts.listSpace` is space-scoped with
 * an optional bot filter, not thread-scoped, and Goal-log turns create
 * artifacts under the same bot id as the Conversation, so they show up here
 * too without any backend change.
 */
export function LibraryScreen(props: { botId: string }) {
  return <ArtifactsView fixedBotId={props.botId} />;
}
