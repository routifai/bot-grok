import { Trans, useLingui } from "@lingui/react/macro";
import type { Bot } from "@nova/contracts";
import { BOT_NAME_MAX_LENGTH } from "@nova/contracts";
import { cn } from "@nova/ui-web";
import { Check, ChevronRight } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { NovaOrb } from "../../components/ai/orb";
import { ApprovalsSettings } from "../../features/approvals";
import { SideChatArchiving } from "../../features/side-chats/SideChatArchiving";
import { VaultSettings } from "../../features/vault";
import { authClient } from "../../lib/auth";
import { resetFirstRun } from "./intro";
import { ProactivitySettings } from "./ProactivitySettings";
import { MUSE_INSET_GROUP } from "./ui";

/**
 * What the person tunes about their Muse, gathered in one place (docs/muse/DESIGN.md):
 * its name (Nova is always the orb: no shape, color or upload), and how proactively it works on Goals. Everything here
 * saves through the same bot-update path bot-panel uses, so there is one source of truth.
 */
export function NovaSettingsPanel({
  bot,
  onSave,
}: {
  bot: Bot;
  onSave: (patch: { name?: string }) => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const session = authClient.useSession();
  const [name, setName] = useState(bot.name);
  const [error, setError] = useState<string | null>(null);
  const [replayed, setReplayed] = useState(false);

  useEffect(() => {
    setName(bot.name);
  }, [bot.id, bot.name]);

  async function save(patch: { name?: string }) {
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save`);
      setName(bot.name);
    }
  }

  return (
    <div data-testid="nova-settings" className="flex flex-col gap-8 pb-4">
      <div className={cn(MUSE_INSET_GROUP, "flex flex-col items-center px-6 pt-7 pb-5")}>
        <NovaOrb size={88} flies={false} />
        <label htmlFor={`${ids}-name`} className="sr-only">
          <Trans>Name</Trans>
        </label>
        <input
          id={`${ids}-name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          onBlur={() => {
            const trimmed = name.trim();
            if (trimmed && trimmed !== bot.name) void save({ name: trimmed });
            else setName(bot.name);
          }}
          className="mt-4 w-full max-w-[280px] rounded-xl bg-transparent px-2 py-1 text-center text-[24px] font-semibold tracking-[-0.02em] text-foreground outline-none transition-colors hover:bg-muted/60 focus:bg-muted"
        />
        {error ? (
          <p role="alert" className="mt-2 text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <ProactivitySettings botId={bot.id} />

      <SideChatArchiving botId={bot.id} />

      <ApprovalsSettings botId={bot.id} />

      <VaultSettings botId={bot.id} />

      <div className={MUSE_INSET_GROUP}>
        <button
          type="button"
          onClick={() => {
            resetFirstRun(session.data?.user.id);
            setReplayed(true);
          }}
          className="flex min-h-[52px] w-full items-center justify-between gap-4 px-4 text-start transition-colors hover:bg-accent/50 active:bg-accent"
        >
          <span className="text-[16px] text-foreground">
            <Trans>Replay the intro</Trans>
          </span>
          {replayed ? (
            <span className="flex items-center gap-1 text-[14px] text-muted-foreground">
              <Check size={15} strokeWidth={2.25} aria-hidden="true" />
              <Trans>Done</Trans>
            </span>
          ) : (
            <ChevronRight
              size={18}
              strokeWidth={2}
              aria-hidden="true"
              className="text-muted-foreground/60"
            />
          )}
        </button>
      </div>
    </div>
  );
}
