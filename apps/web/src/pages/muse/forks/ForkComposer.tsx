import { cn } from "@aiden/ui-web";
import { useLingui } from "@lingui/react/macro";
import { ArrowUp } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { FORK_TONE_CLASS, type ForkTone } from "./forkModel";

const MAX_HEIGHT_PX = 160;

/**
 * A fork's message box: one rounded field in the fork's color (ink before the fork exists),
 * Enter sends, Shift+Enter starts a new line. The text is cleared once the send is accepted.
 */
export function ForkComposer({
  tone,
  placeholder,
  leading,
  sending,
  autoFocus,
  onSend,
}: {
  tone: ForkTone | null;
  placeholder: string;
  leading?: ReactNode;
  sending: boolean;
  autoFocus?: boolean;
  /** Resolves true when the text was taken (it is then cleared). */
  onSend: (text: string) => Promise<boolean> | boolean;
}) {
  const { t } = useLingui();
  const [value, setValue] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a few lines.
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  const submit = async () => {
    const text = value.trim();
    if (!text || sending) return;
    if (await onSend(text)) setValue("");
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className={cn(
        "flex min-h-12 items-end gap-2.5 rounded-3xl border-[1.5px] bg-card py-1.5 ps-4 pe-1.5 shadow-float",
        tone ? FORK_TONE_CLASS[tone].border : "border-line",
      )}
    >
      {leading ? <span className="mb-2 flex shrink-0 text-ink-2">{leading}</span> : null}
      <textarea
        ref={field}
        rows={1}
        value={value}
        // biome-ignore lint/a11y/noAutofocus: the person just asked to write here.
        autoFocus={autoFocus}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void submit();
          }
        }}
        className="min-w-0 flex-1 resize-none self-center bg-transparent py-1.5 text-[14.5px] leading-[1.5] text-foreground outline-none placeholder:text-ink-3"
        dir="auto"
      />
      <button
        type="submit"
        aria-label={t`Send`}
        disabled={!value.trim() || sending}
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-full transition-[opacity,background-color] disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring",
          tone ? `${FORK_TONE_CLASS[tone].bg} text-solid` : "bg-foreground text-background",
        )}
      >
        <ArrowUp size={16} strokeWidth={2} aria-hidden="true" />
      </button>
    </form>
  );
}
