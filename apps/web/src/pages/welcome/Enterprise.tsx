import { Trans } from "@lingui/react/macro";
import {
  Brain,
  Cpu,
  KeyRound,
  ListChecks,
  type LucideIcon,
  MonitorCog,
  ServerCog,
  ShieldCheck,
  Workflow,
} from "lucide-react";
import type { ReactNode } from "react";
import { useReveal } from "./reveal";

function Item({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <li className="grid content-start gap-2">
      <Icon aria-hidden="true" strokeWidth={1.5} className="size-6 text-welcome-ink-2" />
      <h3 className="m-0 text-base font-medium tracking-[-0.01em]">{title}</h3>
      <p className="m-0 text-sm leading-[1.5] text-welcome-ink-2">{children}</p>
    </li>
  );
}

function Group({ eyebrow, children }: { eyebrow: ReactNode; children: ReactNode }) {
  return (
    <div className="grid gap-6">
      <div className="font-mono text-[11px] tracking-[0.18em] text-welcome-ink-3">{eyebrow}</div>
      <ul className="m-0 grid list-none grid-cols-1 gap-x-8 gap-y-9 p-0 min-[600px]:grid-cols-2 min-[1000px]:grid-cols-4">
        {children}
      </ul>
    </div>
  );
}

export function Enterprise() {
  const [ref, shown] = useReveal<HTMLElement>("0px 0px -12% 0px");
  return (
    <section
      ref={ref}
      data-in={shown ? "true" : "false"}
      className={`mx-auto grid max-w-[1120px] gap-14 px-[clamp(16px,4vw,40px)] py-[12vh] transition-opacity duration-[800ms] ease-out motion-reduce:transition-none ${
        shown ? "opacity-100" : "opacity-0"
      }`}
    >
      <h2 className="m-0 text-center text-[clamp(34px,4.5vw,56px)] font-normal leading-none tracking-[-0.04em] text-balance">
        <Trans>Ready for your company.</Trans>
      </h2>
      <Group eyebrow={<Trans>YOUR STACK</Trans>}>
        <Item icon={ServerCog} title={<Trans>Runs where you choose</Trans>}>
          <Trans>Your cloud or your own servers. Self-host with Docker.</Trans>
        </Item>
        <Item icon={Cpu} title={<Trans>Your model</Trans>}>
          <Trans>Connect the model provider your company approves.</Trans>
        </Item>
        <Item icon={Workflow} title={<Trans>Your harness</Trans>}>
          <Trans>
            Nova runs on the agent harness you pick, like Claude or Pi, and keeps the same memory
            and tools.
          </Trans>
        </Item>
        <Item icon={MonitorCog} title={<Trans>A computer you host</Trans>}>
          <Trans>
            Each person gets an isolated computer, on your own infrastructure when you self-host.
          </Trans>
        </Item>
      </Group>
      <Group eyebrow={<Trans>YOUR DATA</Trans>}>
        <Item icon={Brain} title={<Trans>Memory per person</Trans>}>
          <Trans>
            What Nova remembers belongs to that person. They can read, edit or clear it.
          </Trans>
        </Item>
        <Item icon={KeyRound} title={<Trans>Secrets stay sealed</Trans>}>
          <Trans>Passwords live in a vault. Nova fills them in; the model never sees them.</Trans>
        </Item>
        <Item icon={ShieldCheck} title={<Trans>Approvals you set</Trans>}>
          <Trans>Choose what waits for a yes, and cap daily spending.</Trans>
        </Item>
        <Item icon={ListChecks} title={<Trans>Every step on record</Trans>}>
          <Trans>Every step it took, in plain words.</Trans>
        </Item>
      </Group>
    </section>
  );
}
