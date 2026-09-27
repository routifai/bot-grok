import { useLingui } from "@lingui/react/macro";
import { BotAvatar } from "@rakazo/ui-web";
import { Bot, Code2, MessageCircle, Rss, Target } from "lucide-react";
import { Link } from "react-router-dom";

/** The four Muse-mode screens (F1). Ideas lives inside Feed; "Waiting on you" opens from the avatar. */
export type MuseRailView = "conversation" | "goals" | "feed" | "library";

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
    } = props;
    return (
      <nav
        data-testid="app-rail"
        aria-label={t`Sections`}
        className="flex w-14 shrink-0 flex-col items-center gap-1 border-e border-sidebar-border bg-sidebar py-3"
      >
        <button
          type="button"
          aria-label={t`Waiting on you`}
          title={t`Waiting on you`}
          onClick={onAvatarClick}
          className="relative mb-2 flex h-10 w-10 items-center justify-center rounded-full hover:opacity-90"
        >
          <BotAvatar
            color={avatarColor}
            identity={avatarIdentity}
            status={avatarStatus}
            size={32}
          />
          {askCount ? (
            <span className="absolute -end-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold leading-none text-primary-foreground">
              {askCount > 99 ? "99+" : askCount}
            </span>
          ) : null}
        </button>
        <div className="my-1 h-px w-8 bg-sidebar-border" aria-hidden="true" />
        <RailButton
          label={t`Conversation`}
          active={active === "conversation"}
          onClick={() => onNavigate("conversation")}
        >
          <MessageCircle size={19} strokeWidth={1.75} />
        </RailButton>
        <RailButton
          label={t`Goals`}
          active={active === "goals"}
          onClick={() => onNavigate("goals")}
        >
          <Target size={19} strokeWidth={1.75} />
        </RailButton>
        <RailButton label={t`Feed`} active={active === "feed"} onClick={() => onNavigate("feed")}>
          <Rss size={19} strokeWidth={1.75} />
        </RailButton>
        <RailButton
          label={t`Library`}
          active={active === "library"}
          onClick={() => onNavigate("library")}
        >
          <Code2 size={19} strokeWidth={1.75} />
        </RailButton>
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

function RailButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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
    </button>
  );
}
