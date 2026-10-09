import { ChatMarkdown } from "@nova/chat-ui/web";
import { parseReplyCard, type ReplyCardBlock } from "@nova/contracts";
import { ReplyArtifactFileCard } from "../../features/artifacts";
import { CardSkeleton, catalog } from "./catalog";
import { useResolvedReplyCard } from "./context";
import { SecureEntryCard } from "./SecureEntryCard";

/** The markdown the Muse wrote for a card the client cannot draw. */
function Fallback({ text }: { text: string }) {
  return (
    <div className="max-w-full text-[16px] leading-[1.65] text-foreground" dir="auto">
      <ChatMarkdown>{text}</ChatMarkdown>
    </div>
  );
}

/** One `reply_card` block: skeleton while pending, the catalog component when it parses,
 * otherwise its markdown fallback. `answer` is the person's reply to it, when there is one. */
export function ReplyCard({ block, answer }: { block: ReplyCardBlock; answer?: string }) {
  if (block.pending) return <CardSkeleton card={block.card} />;
  const parsed = parseReplyCard(block);
  if (!parsed) return <Fallback text={block.fallback} />;
  const title = block.title;
  switch (parsed.kind) {
    case "sources":
      return <catalog.sources title={title} data={parsed.data} />;
    case "compare":
      return <catalog.compare title={title} data={parsed.data} />;
    case "plan":
      return <catalog.plan title={title} data={parsed.data} />;
    case "ask":
      return <catalog.ask title={title} data={parsed.data} answer={answer} />;
    case "quote":
      return <catalog.quote title={title} data={parsed.data} />;
    case "chart":
      return <catalog.chart title={title} data={parsed.data} />;
    case "person":
      return <catalog.person title={title} data={parsed.data} />;
    case "file":
      return parsed.data.url ? (
        <catalog.file title={title} data={parsed.data} />
      ) : (
        <ReplyArtifactFileCard title={title} data={parsed.data} />
      );
    case "progress":
      return <catalog.progress title={title} data={parsed.data} />;
    case "secure_entry":
      return <SecureEntryCard data={parsed.data} />;
  }
}

/** A reply card inside a transcript: honors in-place updates and the person's answer. */
export function ReplyCardBlockView({
  block,
  messageId,
  index,
}: {
  block: ReplyCardBlock;
  messageId: string;
  index: number;
}) {
  const resolved = useResolvedReplyCard(messageId, index);
  const shown = resolved ? resolved.block : block;
  if (!shown) return null;
  return (
    <div className="flex w-full justify-start py-1">
      <ReplyCard block={shown} answer={resolved?.answer} />
    </div>
  );
}
