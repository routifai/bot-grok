import { Trans } from "@lingui/react/macro";
import { Link } from "react-router-dom";

export const FOCUS =
  "focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-welcome-night-glow";
export const GUTTER = "px-[clamp(16px,4vw,48px)]";

const BTN = `cursor-pointer rounded-full px-[22px] py-[13px] text-[15px] font-semibold ${FOCUS}`;

/** The primary button: light on the night hero, dark on the light sheet. */
export function GetStarted({ tone }: { tone: "night" | "sheet" }) {
  const look =
    tone === "night"
      ? "bg-welcome-night-ink text-welcome-night hover:bg-welcome-paper"
      : "bg-welcome-ink text-welcome-paper hover:bg-welcome-ink/90";
  return (
    <Link to="/sign-up" className={`${BTN} ${look}`}>
      <Trans>Get started</Trans>
    </Link>
  );
}

export function HaveAccount() {
  return (
    <Link
      to="/sign-in"
      className={`${BTN} border border-welcome-sheet-line-2 bg-transparent text-welcome-sheet-ink-2 hover:text-welcome-ink`}
    >
      <Trans>I have an account</Trans>
    </Link>
  );
}
