import { useRef } from "react";
import { Closing } from "./welcome/Closing";
import { DemoStack } from "./welcome/DemoStack";
import { Grain } from "./welcome/Grain";
import { Hero } from "./welcome/Hero";
import { Stars } from "./welcome/Stars";
import { Statement } from "./welcome/Statement";

// The signed-out welcome: a dark film hero, a scroll-lit statement, then a light sheet of six
// stacked demo cards. Always dark at the top, whatever the app theme (`welcome-*` tokens).
// The page scrolls inside this container, so the stars and the demos listen to it, not window.
export function WelcomePage() {
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={scrollRef}
      className="relative isolate h-full overflow-x-clip overflow-y-auto bg-welcome-night text-welcome-night-ink antialiased [color-scheme:dark]"
      data-nova-surface="welcome"
    >
      <Stars scrollRef={scrollRef} />
      <Grain />
      <Hero />
      <Statement scrollRef={scrollRef} />
      <DemoStack scrollRef={scrollRef} />
      <Closing />
    </div>
  );
}
