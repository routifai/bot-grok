import type { MemoryDocument } from "@aiden/contracts";
import { Button, Skeleton } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { downloadArtifactBytes } from "../../../lib/artifact-open";
import { rpc } from "../../../lib/rpc";
import { SettingsGroup, SettingsLinkRow } from "./kit";

/**
 * Settings > Memory: what Nova keeps between conversations. Each note opens in place so the
 * person can read, correct or trim it.
 */
export function MemoryPanel({ botId }: { botId: string }) {
  const { t } = useLingui();
  const [docs, setDocs] = useState<MemoryDocument[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);

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

  if (error) return <p className="px-4 text-[13px] text-destructive">{error}</p>;
  if (docs === null) return <Skeleton className="h-[106px] w-full rounded-[22px]" />;

  // A note is worth showing once it holds more than its heading and the seed line.
  const withContent = docs.filter((doc) => {
    const line = firstLine(doc.content);
    return line && line !== SEED_LINE;
  });
  return (
    <div className="flex flex-col gap-7">
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
        {withContent.length === 0 ? (
          <p className="px-4 py-4 text-[15px] text-muted-foreground">
            <Trans>Nothing yet.</Trans>
          </p>
        ) : (
          withContent.map((doc) =>
            openId === doc.id ? (
              <MemoryEditor
                key={doc.id}
                doc={doc}
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
                value={firstLine(doc.content)}
                onClick={() => setOpenId(doc.id)}
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
  onClose,
  onSaved,
}: {
  doc: MemoryDocument;
  onClose: () => void;
  onSaved: (doc: MemoryDocument) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(doc.content);
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
          disabled={busy || draft === doc.content}
          onClick={() => void save()}
        >
          <Trans>Save</Trans>
        </Button>
      </div>
    </div>
  );
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
