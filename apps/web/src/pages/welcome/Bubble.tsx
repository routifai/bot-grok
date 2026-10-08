import { cn } from "@aiden/ui-web";
import type { ReactNode } from "react";

export function Bubble({
  you,
  className,
  children,
}: {
  you?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex w-full", you && "justify-end")}>
      <div
        className={cn(
          "max-w-[78%] rounded-[18px] px-3.5 py-2.5 text-[14.5px] leading-[1.45]",
          you
            ? "rounded-br-[6px] bg-welcome-me text-white"
            : "rounded-bl-[6px] bg-welcome-bubble text-welcome-ink",
          className,
        )}
      >
        {children}
      </div>
    </div>
  );
}
