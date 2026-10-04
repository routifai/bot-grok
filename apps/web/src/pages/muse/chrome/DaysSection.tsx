import { useLingui } from "@lingui/react/macro";
import { useCallback, useEffect, useState } from "react";

export type DailyNote = {
  date: string;
  sections: Record<string, string>;
  editedByPerson: boolean;
  finalized: boolean;
  updatedAt: number;
};

/** The Days section's wire: `rpc.memory.dailyNotes` / `rpc.memory.saveDailyNote`. */
export type DaysWire = {
  dailyNotes: (input: { botId: string }) => Promise<{ notes: DailyNote[] }>;
  saveDailyNote: (input: {
    botId: string;
    date: string;
    sections: Record<string, string>;
  }) => Promise<DailyNote>;
};

/** The engine's section keys, in reading order. */
export const DAY_SECTION_KEYS = [
  "talked_about",
  "decisions",
  "promised",
  "open_loops",
  "reflection",
] as const;

function Day({
  botId,
  note,
  wire,
  onSaved,
}: {
  botId: string;
  note: DailyNote;
  wire: DaysWire;
  onSaved: (note: DailyNote) => void;
}) {
  const { t } = useLingui();
  const titles: Record<string, string> = {
    talked_about: t`What we talked about`,
    decisions: t`Decisions`,
    promised: t`Promised`,
    open_loops: t`Open loops`,
    reflection: t`Reflection`,
  };
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    setFailed(false);
    try {
      onSaved(await wire.saveDailyNote({ botId, date: note.date, sections: draft }));
      setDraft(null);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const filled = DAY_SECTION_KEYS.filter((key) => (note.sections[key] ?? "").trim() !== "");
  return (
    <li className="rounded-xl border border-border/60 px-3 py-2" data-testid="day-note">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-[13px] font-semibold text-foreground">{note.date}</h4>
        {draft ? null : (
          <button
            type="button"
            className="text-[12px] text-muted-foreground hover:text-foreground"
            onClick={() => setDraft({ ...note.sections })}
          >
            {t`Edit`}
          </button>
        )}
      </div>
      {draft ? (
        <div className="mt-2 flex flex-col gap-2">
          {DAY_SECTION_KEYS.map((key) => (
            <label key={key} className="flex flex-col gap-1">
              <span className="text-[12px] font-medium text-muted-foreground">{titles[key]}</span>
              <textarea
                className="min-h-16 rounded-lg border border-border bg-background px-2 py-1 text-[13px] leading-[1.5]"
                dir="auto"
                value={draft[key] ?? ""}
                onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
              />
            </label>
          ))}
          {failed ? (
            <p className="text-[12px] text-destructive">{t`Could not save this day`}</p>
          ) : null}
          <div className="flex gap-3 text-[12.5px]">
            <button type="button" disabled={saving} onClick={() => void save()}>
              {t`Save`}
            </button>
            <button
              type="button"
              className="text-muted-foreground"
              disabled={saving}
              onClick={() => setDraft(null)}
            >
              {t`Cancel`}
            </button>
          </div>
        </div>
      ) : filled.length === 0 ? (
        <p className="mt-1 text-[12.5px] text-muted-foreground">{t`Nothing noted yet.`}</p>
      ) : (
        <div className="mt-1 flex flex-col gap-1.5">
          {filled.map((key) => (
            <div key={key}>
              <p className="text-[12px] font-medium text-muted-foreground">{titles[key]}</p>
              <p className="whitespace-pre-line text-[13.5px] leading-[1.5]" dir="auto">
                {note.sections[key]}
              </p>
            </div>
          ))}
        </div>
      )}
    </li>
  );
}

/** The Memory tab's "Days" section: recent daily notes, readable and editable in place. A
 * failed or unavailable load renders nothing (the Memory Profile above stays the tab's job). */
export function DaysSection({ botId, wire }: { botId: string; wire: DaysWire }) {
  const { t } = useLingui();
  const [notes, setNotes] = useState<DailyNote[]>([]);

  useEffect(() => {
    let live = true;
    wire
      .dailyNotes({ botId })
      .then((result) => {
        if (live) setNotes(result.notes);
      })
      .catch(() => {
        if (live) setNotes([]);
      });
    return () => {
      live = false;
    };
  }, [botId, wire]);

  const replace = useCallback(
    (saved: DailyNote) =>
      setNotes((current) => current.map((n) => (n.date === saved.date ? saved : n))),
    [],
  );

  if (notes.length === 0) return null;
  return (
    <section className="flex flex-col gap-1" data-testid="memory-days">
      <h3 className="px-1 text-[12.5px] font-semibold text-muted-foreground">{t`Days`}</h3>
      <ul className="flex flex-col gap-1.5">
        {notes.map((note) => (
          <Day key={note.date} botId={botId} note={note} wire={wire} onSaved={replace} />
        ))}
      </ul>
    </section>
  );
}
