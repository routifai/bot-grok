import { useLingui } from "@lingui/react/macro";
import { BotAvatar } from "@nova/ui-web";
import { Bot, Code2, Lightbulb, MessageCircle, Rss, Settings, Target } from "lucide-react";
import { Link } from "react-router-dom";

/** The five Muse-mode screens (F1). "Waiting on you" opens from the avatar, not a rail entry. */
export type MuseRailView = "conversation" | "goals" | "feed" | "ideas" | "library";

type AppRailProps =
  | { active: "bots" | "artifacts" }
  | {
      active: MuseRailView;
      museMode: true;
      onNavigate: (view: MuseRailView) => void;
      avatarColor: string;
      avatarIdentity: string;
      avatarStatus?: string;
      askCount?: number;
      onAvatarClick: () => void;
      /** Settings entry pinned at the bottom of the rail, when the shell has one reachable. */
      onOpenSettings?: () => void;
    };

export function AppRail(props: AppRailProps) {
  const { t } = useLingui();
  if ("museMode" in props && props.museMode) {
    const {
      active,
      onNavigate,
      avatarColor,
      avatarIdentity,
      avatarStatus,
      askCount,
      onAvatarClick,
      onOpenSettings,
    } = props;
    return (
      <nav
        data-testid="app-rail"
        aria-label={t`Sections`}
        className="flex w-16 shrink-0 flex-col items-center gap-1 border-e border-sidebar-border bg-sidebar py-3"
      >
        <button
          type="button"
          aria-label={t`Waiting on you`}
          title={t`Waiting on you`}
          onClick={onAvatarClick}
          className="relative mb-2 flex h-11 w-11 items-center justify-center rounded-full hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <BotAvatar
            color={avatarColor}
            identity={avatarIdentity}
            status={avatarStatus}
            face="muse"
            waitingCount={askCount}
            size={40}
          />
        </button>
        <div className="my-1 h-px w-8 bg-sidebar-border" aria-hidden="true" />
        <MuseRailButton
          label={t`Conversation`}
          active={active === "conversation"}
          onClick={() => onNavigate("conversation")}
        >
          <MessageCircle size={18} strokeWidth={1.75} />
        </MuseRailButton>
        <MuseRailButton
          label={t`Goals`}
          active={active === "goals"}
          onClick={() => onNavigate("goals")}
        >
          <Target size={18} strokeWidth={1.75} />
        </MuseRailButton>
        <MuseRailButton
          label={t`Feed`}
          active={active === "feed"}
          onClick={() => onNavigate("feed")}
        >
          <Rss size={18} strokeWidth={1.75} />
        </MuseRailButton>
        <MuseRailButton
          label={t`Ideas`}
          active={active === "ideas"}
          onClick={() => onNavigate("ideas")}
        >
          <Lightbulb size={18} strokeWidth={1.75} />
        </MuseRailButton>
        <MuseRailButton
          label={t`Library`}
          active={active === "library"}
          onClick={() => onNavigate("library")}
        >
          <Code2 size={18} strokeWidth={1.75} />
        </MuseRailButton>
        {onOpenSettings ? (
          <MuseRailButton
            label={t`Settings`}
            active={false}
            onClick={onOpenSettings}
            className="mt-auto"
          >
            <Settings size={18} strokeWidth={1.75} />
          </MuseRailButton>
        ) : null}
      </nav>
    );
  }

  const { active } = props;
  return (
    <nav
      data-testid="app-rail"
      aria-label={t`Sections`}
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-e border-sidebar-border bg-sidebar py-3"
    >
      <RailLink to="/app" label={t`Bots`} active={active === "bots"}>
        <Bot size={19} strokeWidth={1.75} />
      </RailLink>
      <RailLink to="/app/artifacts" label={t`Artifacts`} active={active === "artifacts"}>
        <Code2 size={19} strokeWidth={1.75} />
      </RailLink>
    </nav>
  );
}

function RailLink({
  to,
  label,
  active,
  children,
}: {
  to: string;
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      className={`flex h-10 w-10 items-center justify-center rounded-[11px] transition-colors ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      }`}
    >
      {children}
    </Link>
  );
}

/** A Muse rail entry: icon above a 10.5px label (docs/muse/DESIGN.md "Rail"). */
function MuseRailButton({
  label,
  active,
  onClick,
  className = "",
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={label}
      className={`flex w-14 flex-col items-center gap-1 rounded-[11px] px-1 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        active
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
      } ${className}`}
    >
      {children}
      <span className="text-[10.5px] leading-none">{label}</span>
    </button>
  );
}
