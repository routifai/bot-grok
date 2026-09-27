import type { Bot } from "@aiden/contracts";
import { BOT_NAME_MAX_LENGTH } from "@aiden/contracts";
import { Input } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useId, useState } from "react";
import { AvatarStudioPopover } from "../shell/avatar-studio-popover";
import { ProactivitySettings } from "./ProactivitySettings";
import { Section, Surface } from "./ui";

/**
 * What the person tunes about their Muse, gathered in one place (docs/muse/DESIGN.md):
 * its name, its color (the avatar studio's color choice — the Muse always wears its
 * face, no shape or upload), and how proactively it works on Goals. Everything here
 * saves through the same bot-update path bot-panel uses, so there is one source of truth.
 */
export function AidenSettingsPanel({
  bot,
  onSave,
}: {
  bot: Bot;
  onSave: (patch: { name?: string; color?: string }) => Promise<void>;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [name, setName] = useState(bot.name);
  const [color, setColor] = useState(bot.color);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(bot.name);
    setColor(bot.color);
  }, [bot.id, bot.name, bot.color]);

  async function save(patch: { name?: string; color?: string }) {
    setError(null);
    try {
      await onSave(patch);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save`);
      setName(bot.name);
      setColor(bot.color);
    }
  }

  return (
    <div data-testid="aiden-settings" className="space-y-8 pb-2">
      <Section title={t`Identity`}>
        <Surface className="flex items-center gap-4 p-4">
          <AvatarStudioPopover
            value={color}
            identity={bot.id}
            status={bot.status}
            size={56}
            museMode
            onChange={(nextColor) => {
              setColor(nextColor);
              void save({ color: nextColor });
            }}
          />
          <div className="min-w-0 flex-1">
            <label htmlFor={`${ids}-name`} className="block text-[13px] text-muted-foreground">
              <Trans>Name</Trans>
            </label>
            <Input
              id={`${ids}-name`}
              value={name}
              maxLength={BOT_NAME_MAX_LENGTH}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                const trimmed = name.trim();
                if (trimmed && trimmed !== bot.name) void save({ name: trimmed });
                else setName(bot.name);
              }}
              className="mt-1.5"
            />
          </div>
        </Surface>
        {error ? (
          <p role="alert" className="text-[13px] text-destructive">
            {error}
          </p>
        ) : null}
      </Section>

      <Section title={t`Proactivity`}>
        <Surface className="p-4">
          <ProactivitySettings botId={bot.id} className="" />
        </Surface>
      </Section>
    </div>
  );
}
