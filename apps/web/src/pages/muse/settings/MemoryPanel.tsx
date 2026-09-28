import type { Episode, MemoryDocument } from "@aiden/contracts";
import { Button, Skeleton } from "@aiden/ui-web";
import { i18n } from "@lingui/core";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { downloadArtifactBytes } from "../../../lib/artifact-open";
import { rpc } from "../../../lib/rpc";
import { SettingsGroup, SettingsLinkRow } from "./kit";

/** How many recent episodes the "What we've done" group shows. */
const EPISODES_LIMIT = 20;

/**
 * Settings > Memory: what Nova keeps between conversations. Each note opens in place so the
 * person can read, correct or trim it.
 */
export function MemoryPanel({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [docs, setDocs] = useState<MemoryDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [episodes, setEpisodes] = useState<Episode[] | null>(null);
  const [episodesError, setEpisodesError] = useState<string | null>(null);
  const [openEpisodeId, setOpenEpisodeId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      rpc.memory.list({ botId, scope: "bot" }),
      rpc.memory.list({ scope: "user" }).catch(() => [] as MemoryDocument[]),
    ])
      .then(([bot, user]) => {
        if (!cancelled) setDocs([...bot, ...user]);
      })
      .catch(() => {
        if (!cancelled) setError(t`Could not load memory.`);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, t]);

  useEffect(() => {
    let cancelled = false;
    rpc.episodes
      .list({ botId, limit: EPISODES_LIMIT })
      .then((rows) => {
        if (!cancelled) setEpisodes(rows);
      })
      .catch(() => {
        if (!cancelled) setEpisodesError(t`Could not load past tasks.`);
      });
    return () => {
      cancelled = true;
    };
  }, [botId, t]);

  if (error) return <p className="px-4 text-[13px] text-destructive">{error}</p>;
  if (docs === null) return <Skeleton className="h-[106px] w-full rounded-[22px]" />;

  // Both notes always show so the person can start one; seed-only notes read as empty.
  const hasContent = (doc: MemoryDocument) => {
    const line = firstLine(doc.content);
    return Boolean(line) && line !== SEED_LINE;
  };
  const withContent = docs.filter(hasContent);

  return (
    <div className="flex flex-col gap-7" data-testid="memory-panel">
      <SettingsGroup
        title={<Trans>What I remember</Trans>}
        footer={
          withContent.length > 0 ? (
            <Trans>I read these before every conversation. Edit anything that's wrong.</Trans>
          ) : (
            <Trans>Tell me something to remember, like how you like reports written.</Trans>
          )
        }
      >
        {docs.length === 0 ? (
          <p className="px-4 py-4 text-[15px] text-muted-foreground">
            <Trans>Nothing yet.</Trans>
          </p>
        ) : (
          docs.map((doc) =>
            openId === doc.id ? (
              <MemoryEditor
                key={doc.id}
                doc={doc}
                startEmpty={!hasContent(doc)}
                onClose={() => setOpenId(null)}
                onSaved={(updated) =>
                  setDocs((current) =>
                    (current ?? []).map((entry) => (entry.id === updated.id ? updated : entry)),
                  )
                }
              />
            ) : (
              <SettingsLinkRow
                key={doc.id}
                label={memoryTitle(doc)}
                value={hasContent(doc) ? firstLine(doc.content) : t`Empty`}
                onClick={() => setOpenId(doc.id)}
              />
            ),
          )
        )}
      </SettingsGroup>

      <SettingsGroup
        title={<Trans>What we've done</Trans>}
        footer={<Trans>I use these to pick up where we left off.</Trans>}
      >
        {episodesError ? (
          <p className="px-4 py-4 text-[13px] text-destructive">{episodesError}</p>
        ) : episodes === null ? (
          <Skeleton className="h-[52px] w-full" />
        ) : episodes.length === 0 ? (
          <p className="px-4 py-4 text-[15px] text-muted-foreground">
            <Trans>Nothing yet.</Trans>
          </p>
        ) : (
          episodes.map((episode) =>
            openEpisodeId === episode.id ? (
              <EpisodeDetail
                key={episode.id}
                episode={episode}
                onClose={() => setOpenEpisodeId(null)}
                onForgotten={() =>
                  setEpisodes((current) =>
                    (current ?? []).filter((entry) => entry.id !== episode.id),
                  )
                }
              />
            ) : (
              <SettingsLinkRow
                key={episode.id}
                label={episode.title}
                value={formatEpisodeDate(episode.createdAt)}
                onClick={() => setOpenEpisodeId(episode.id)}
              />
            ),
          )
        )}
      </SettingsGroup>

      {withContent.length > 0 ? (
        <SettingsGroup>
          <SettingsLinkRow
            label={<Trans>Download as Markdown</Trans>}
            onClick={() =>
              downloadArtifactBytes(
                "nova-memory.md",
                "text/markdown",
                new TextEncoder().encode(
                  withContent.map((doc) => `# ${doc.path}\n\n${doc.content}`).join("\n\n"),
                ),
              )
            }
          />
        </SettingsGroup>
      ) : null}
    </div>
  );
}

function MemoryEditor({
  doc,
  startEmpty,
  onClose,
  onSaved,
}: {
  doc: MemoryDocument;
  /** A note that only holds its placeholder opens blank. */
  startEmpty: boolean;
  onClose: () => void;
  onSaved: (doc: MemoryDocument) => void;
}) {
  const { t } = useLingui();
  const initial = startEmpty ? "" : doc.content;
  const [draft, setDraft] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      onSaved(await rpc.memory.update({ documentId: doc.id, content: draft }));
      onClose();
    } catch {
      setError(t`Could not save.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-[16px] text-foreground">{memoryTitle(doc)}</p>
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        aria-label={memoryTitle(doc)}
        rows={Math.min(16, Math.max(5, draft.split("\n").length + 1))}
        className="resize-none rounded-2xl bg-muted/60 p-3.5 text-[14.5px] leading-[1.55] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        dir="auto"
      />
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" className="rounded-full" disabled={busy} onClick={onClose}>
          <Trans>Cancel</Trans>
        </Button>
        <Button
          className="rounded-full"
          disabled={busy || draft === initial}
          onClick={() => void save()}
        >
          <Trans>Save</Trans>
        </Button>
      </div>
    </div>
  );
}

/** An episode expanded in place: summary, links, and a quiet way to forget it. */
function EpisodeDetail({
  episode,
  onClose,
  onForgotten,
}: {
  episode: Episode;
  onClose: () => void;
  onForgotten: () => void;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function forget() {
    setBusy(true);
    setError(null);
    try {
      await rpc.episodes.remove({ episodeId: episode.id });
      onForgotten();
      onClose();
    } catch {
      setError(t`Could not forget this.`);
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-4">
      <p className="text-[16px] text-foreground">{episode.title}</p>
      <p className="text-[14.5px] leading-[1.55] text-muted-foreground" dir="auto">
        {episode.summary}
      </p>
      {episode.links.length > 0 ? (
        <ul className="flex flex-col gap-1">
          {episode.links.map((link) => (
            <li key={link} className="min-w-0 truncate">
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                className="text-[13.5px] text-primary underline-offset-4 hover:underline"
              >
                {link}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center justify-between gap-2">
        <Button variant="ghost" className="rounded-full" disabled={busy} onClick={onClose}>
          <Trans>Close</Trans>
        </Button>
        <Button
          variant="ghost"
          className="rounded-full text-destructive hover:bg-destructive/10"
          disabled={busy}
          onClick={() => void forget()}
        >
          <Trans>Forget this</Trans>
        </Button>
      </div>
    </div>
  );
}

/** Short date for an episode row, e.g. "Sep 28" — no year, like relative-time.ts. */
function formatEpisodeDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(i18n.locale || "en", { month: "short", day: "numeric" });
}

/** Nova's own notes vs. what it keeps about the person across every chat. */
function memoryTitle(doc: MemoryDocument): string {
  const base = doc.path.replace(/^.*\//, "").replace(/\.md$/i, "");
  if (base.toUpperCase() === "MEMORY") return doc.botId ? "My notes" : "About you";
  return base.replace(/[-_]+/g, " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

/** The placeholder a new space's memory starts with (packages/db/src/bootstrap-user.ts). */
const SEED_LINE = "Preferences and context kept within this space live here.";

function firstLine(content: string): string {
  return (
    content
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .map((line) => line.replace(/^[>*\-\s]+/, "").trim())
      .find(Boolean) ?? ""
  );
}
