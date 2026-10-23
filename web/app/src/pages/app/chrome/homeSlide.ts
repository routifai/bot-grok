import type { ThreadMessage } from "@superchat/contracts";
import { type TouchEvent, useCallback, useRef, type WheelEvent } from "react";
import { previewMessageText } from "../conversation/messageText";

/** The "Last:" line is cut to about this many characters. */
const LINE_CHARS = 60;
/** Scrolling on past Home's end this far (summed wheel deltaY), or swiping up this far, continues. */
const PULL_PX = 140;
const SWIPE_PX = 90;
/** The slide between Home and the Conversation. */
const SLIDE_MS = 700;
const SLIDE_EASING = "cubic-bezier(.7,0,.2,1)";
const FADE_MS = 200;

/** Where the slide goes: up into the Conversation, or down back to Home. */
export type SlideWay = "up" | "down";

/** The first sentence of *text* (a reply's opening line). */
function firstSentence(text: string): string {
  const match = /^(.+?[.!?…])(\s|$)/u.exec(text);
  return match?.[1] ?? text;
}

/** *text* on one line, cut at a word to about `LINE_CHARS` with an ellipsis. */
export function clipLine(text: string, max = LINE_CHARS): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, "")}…`;
}

/**
 * Home's "Last:" line: the Conversation's latest message with words in it, the person's
 * request as they wrote it or the first sentence of Super Chat's reply (Markdown stripped), on
 * one line; and when it was written. `null` while the Conversation has nothing to continue.
 */
export function lastLine(messages: readonly ThreadMessage[]): { text: string; at: string } | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || (message.role !== "user" && message.role !== "bot")) continue;
    if (!message.blocks.some((block) => block.kind === "text" && block.text.trim())) continue;
    const text = previewMessageText(message);
    if (!text) continue;
    return {
      text: clipLine(message.role === "bot" ? firstSentence(text) : text),
      at: message.createdAt,
    };
  }
  return null;
}

/** Whether something between *target* and *root* (inclusive) can still scroll down. */
function scrollsFurther(target: EventTarget | null, root: HTMLElement): boolean {
  let node = target instanceof Element ? target : null;
  while (node) {
    if (node instanceof HTMLElement && node.scrollHeight > node.clientHeight + 2) {
      const { overflowY } = getComputedStyle(node);
      const scrollable = overflowY === "auto" || overflowY === "scroll" || node === root;
      if (scrollable && node.scrollTop + node.clientHeight < node.scrollHeight - 2) return true;
    }
    if (node === root) break;
    node = node.parentElement;
  }
  return false;
}

/**
 * Scrolling on past the end of Home (a wheel pull of 140px) or swiping up at its end calls
 * *onPull*; a list inside Home that still scrolls takes the wheel first. Spread the handlers on
 * Home's scroll root.
 */
export function usePullPastEnd(onPull: (() => void) | null) {
  const pulled = useRef(0);
  const touchY = useRef<number | null>(null);
  const onWheel = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (!onPull || event.deltaY <= 0 || scrollsFurther(event.target, event.currentTarget)) {
        pulled.current = 0;
        return;
      }
      pulled.current += event.deltaY;
      if (pulled.current > PULL_PX) {
        pulled.current = 0;
        onPull();
      }
    },
    [onPull],
  );
  const onTouchStart = useCallback((event: TouchEvent<HTMLElement>) => {
    touchY.current = event.touches[0]?.clientY ?? null;
  }, []);
  const onTouchEnd = useCallback(
    (event: TouchEvent<HTMLElement>) => {
      const from = touchY.current;
      touchY.current = null;
      const to = event.changedTouches[0]?.clientY;
      if (!onPull || from === null || to === undefined || from - to <= SWIPE_PX) return;
      if (scrollsFurther(event.target, event.currentTarget)) return;
      onPull();
    },
    [onPull],
  );
  return { onWheel, onTouchStart, onTouchEnd };
}

/**
 * Runs the slide on the two layers: up, Home leaves through the top while the Conversation
 * rises from below; down, the reverse. Under reduced motion it is a short crossfade of Home.
 * Resolves when it has played (at once without Web Animations); the returned `cancel` drops
 * the animations' held end state once the views have settled.
 */
export function slideViews(
  home: HTMLElement | null,
  chat: HTMLElement | null,
  way: SlideWay,
): { done: Promise<void>; cancel: () => void } {
  const animations: Animation[] = [];
  const play = (
    element: HTMLElement | null,
    frames: Keyframe[],
    duration: number,
    easing: string,
  ) => {
    if (!element || typeof element.animate !== "function") return;
    animations.push(element.animate(frames, { duration, easing, fill: "forwards" }));
  };
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  if (reduce) {
    const fade = [{ opacity: 1 }, { opacity: 0 }];
    play(home, way === "up" ? fade : [...fade].reverse(), FADE_MS, "ease");
  } else {
    const off = { up: "translateY(-100%)", down: "translateY(100%)" };
    const homeFrames = [{ transform: "none" }, { transform: off.up }];
    const chatFrames = [{ transform: off.down }, { transform: "none" }];
    play(home, way === "up" ? homeFrames : [...homeFrames].reverse(), SLIDE_MS, SLIDE_EASING);
    play(chat, way === "up" ? chatFrames : [...chatFrames].reverse(), SLIDE_MS, SLIDE_EASING);
  }
  return {
    done: Promise.all(animations.map((animation) => animation.finished)).then(
      () => undefined,
      () => undefined,
    ),
    cancel: () => {
      for (const animation of animations) animation.cancel();
    },
  };
}
