import { useLingui } from "@lingui/react/macro";
import type { AutomationSchedule, Live, LiveTell } from "@superchat/contracts";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
} from "@superchat/ui-web";
import { ChevronDown, Plus, X } from "lucide-react";
import { useState } from "react";
import { WEEKDAYS } from "../automations";
import type { LiveSettingsInput, useLive } from "./useLive";

const DEFAULT_SCHEDULE: AutomationSchedule = { frequency: "weekly", time: "08:00", weekday: 0 };

type LiveApi = ReturnType<typeof useLive>;

/** "Keep updated" (or "Updates weekly ▾" once on) and the popover with the page's live settings. */
export function LiveSettings({ api, live }: { api: LiveApi; live: Live | null }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const frequency = live?.schedule?.frequency;
  const label = !live
    ? t`Keep updated`
    : frequency === "daily"
      ? t`Updates daily`
      : frequency === "weekly"
        ? t`Updates weekly`
        : frequency === "monthly"
          ? t`Updates monthly`
          : t`Updates on a schedule`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={<Button variant={live ? "outline" : "secondary"} size="sm" />}
        data-testid="live-settings"
      >
        {label}
        {live ? <ChevronDown size={12} aria-hidden="true" /> : null}
      </PopoverTrigger>
      <PopoverContent align="end" className="max-h-[80vh] w-80 gap-3 overflow-y-auto p-3">
        {/* Mounted while open, so every opening starts from what is saved. */}
        <SettingsForm api={api} live={live} onClose={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

function SettingsForm({
  api,
  live,
  onClose,
}: {
  api: LiveApi;
  live: Live | null;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const [schedule, setSchedule] = useState<AutomationSchedule>(live?.schedule ?? DEFAULT_SCHEDULE);
  const [sources, setSources] = useState<string[]>(live?.sources ?? []);
  const [tell, setTell] = useState<LiveTell>(live?.tell ?? "notable");
  const [busy, setBusy] = useState(false);

  const done = async (work: () => Promise<unknown>) => {
    setBusy(true);
    const result = await work();
    setBusy(false);
    if (result) onClose();
  };
  const input = (): LiveSettingsInput => ({
    schedule,
    sources: sources.map((source) => source.trim()).filter(Boolean),
    tell,
  });
  const setFrequency = (frequency: AutomationSchedule["frequency"]) =>
    setSchedule({
      time: schedule.time,
      frequency,
      ...(frequency === "weekly" ? { weekday: schedule.weekday ?? 0 } : {}),
      ...(frequency === "monthly" ? { monthDay: schedule.monthDay ?? 1 } : {}),
    });
  const editSource = (index: number, value: string) =>
    setSources(sources.map((source, at) => (at === index ? value : source)));

  const field = "flex flex-col gap-1.5";
  const caption = "text-[12px] text-muted-foreground";
  return (
    <div className="flex flex-col gap-3" data-testid="live-form">
      <div className={field}>
        <span className={caption}>{t`How often`}</span>
        <Tabs
          value={schedule.frequency}
          onValueChange={(value) => setFrequency(value as AutomationSchedule["frequency"])}
        >
          <TabsList className="w-full">
            <TabsTrigger value="daily">{t`Daily`}</TabsTrigger>
            <TabsTrigger value="weekly">{t`Weekly`}</TabsTrigger>
            <TabsTrigger value="monthly">{t`Monthly`}</TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="flex gap-2">
          {schedule.frequency === "weekly" ? (
            <NativeSelect
              className="shrink-0"
              aria-label={t`Day of the week`}
              value={schedule.weekday ?? 0}
              onChange={(event) =>
                setSchedule({ ...schedule, weekday: Number(event.target.value) })
              }
            >
              {WEEKDAYS.map((day, index) => (
                <NativeSelectOption key={day} value={index}>
                  {day}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {schedule.frequency === "monthly" ? (
            <NativeSelect
              className="shrink-0"
              aria-label={t`Day of the month`}
              value={schedule.monthDay ?? 1}
              onChange={(event) =>
                setSchedule({ ...schedule, monthDay: Number(event.target.value) })
              }
            >
              {Array.from({ length: 28 }, (_, index) => index + 1).map((day) => (
                <NativeSelectOption key={day} value={day}>
                  {day}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          <Input
            className="min-w-0 flex-1"
            type="time"
            aria-label={t`Time`}
            value={schedule.time}
            onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}
          />
        </div>
      </div>

      <div className={field}>
        <span className={caption}>{t`Checks`}</span>
        {sources.map((source, index) => (
          <div key={index} className="flex items-center gap-1">
            <Input
              aria-label={t`Source`}
              placeholder={t`Web address or file path`}
              value={source}
              onChange={(event) => editSource(index, event.target.value)}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t`Remove source`}
              onClick={() => setSources(sources.filter((_, at) => at !== index))}
            >
              <X />
            </Button>
          </div>
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setSources([...sources, ""])}
        >
          <Plus size={13} />
          {t`Add a source`}
        </Button>
      </div>

      <div className={field}>
        <span className={caption}>{t`Tell me in chat`}</span>
        <NativeSelect
          aria-label={t`Tell me in chat`}
          value={tell}
          onChange={(event) => setTell(event.target.value as LiveTell)}
        >
          <NativeSelectOption value="notable">{t`When something important changes`}</NativeSelectOption>
          <NativeSelectOption value="every">{t`After every update`}</NativeSelectOption>
          <NativeSelectOption value="never">{t`Never`}</NativeSelectOption>
        </NativeSelect>
      </div>

      {api.error ? <p className="text-[13px] text-destructive">{api.error}</p> : null}
      {live ? (
        <div className="-mx-2 flex items-center gap-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void done(api.run)}>
            {t`Update now`}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={busy}
            onClick={() => void done(api.stop)}
          >
            {t`Stop updating`}
          </Button>
        </div>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          {t`Cancel`}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void done(() => api.save(input()))}>
          {live ? t`Save` : t`Keep updated`}
        </Button>
      </div>
    </div>
  );
}
