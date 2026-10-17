import type { Artifact, ArtifactVersion, ThreadMessage } from "@superchat/contracts";
import { useEffect, useMemo, useState } from "react";
import type { ArtifactContent } from "../../features/artifacts/editor/ArtifactEditor";
import sample from "../../features/artifacts/editor/html/sample-deck.txt?raw";
import { ArtifactRegistryProvider } from "../../features/artifacts/registry";
import { StudioView } from "../../features/artifacts/studio/ArtifactStudio";
import { decksExtension } from "../../features/decks/extension";

const BOT = "dev-bot";
const STUDIO = "dev-studio";
const NAME = "q3_review.deck.html";
const DAY = Date.UTC(2026, 9, 17, 10, 24) / 1000;
const at = (minutes: number) => new Date((DAY + minutes * 60) * 1000).toISOString();

/** The file's versions, newest first: made in Super Chat, changed in the studio and by hand. */
const VERSIONS: ArtifactVersion[] = [
  { id: "v6", version: 6, name: NAME, createdAt: at(40), origin: "ai", chatId: BOT },
  {
    id: "v5",
    version: 5,
    name: NAME,
    createdAt: at(31),
    origin: "manual",
    editSummary: "slide 1 cover-title color #1d2b4f→#c8553d",
  },
  {
    id: "v4",
    version: 4,
    name: NAME,
    createdAt: at(30),
    origin: "manual",
    editSummary: "slide 1 cover-title font-size 44px→52px",
  },
  {
    id: "v3",
    version: 3,
    name: NAME,
    createdAt: at(21),
    origin: "ai",
    chatId: STUDIO,
    itemId: "m2",
    fromStudio: true,
  },
  {
    id: "v2",
    version: 2,
    name: NAME,
    createdAt: at(11),
    origin: "ai",
    chatId: STUDIO,
    itemId: "m1",
    fromStudio: true,
  },
  { id: "v1", version: 1, name: NAME, createdAt: at(0), origin: "ai", chatId: BOT },
];

const said = (id: string, role: "user" | "bot", text: string, minute: number): ThreadMessage => ({
  id,
  threadId: STUDIO,
  seq: minute,
  role,
  blocks: [{ kind: "text", text }],
  createdAt: at(minute),
});

const MESSAGES: ThreadMessage[] = [
  said("m1", "user", "Make the cover say what moved, not just faster.", 10),
  said("a1", "bot", "Done: the cover now reads “Deploys up 38%, incidents down”.", 12),
  said(
    "m2",
    "user",
    '<superchat-element-request file="q3_review.deck.html" artifact="v2" version="2" chip="Slide 1 · cover-lead">\n</superchat-element-request>\n\nShorter, one line.',
    20,
  ),
  said("a2", "bot", "Shortened the subtitle on slide 1 to one line.", 22),
];

type Scenario = "history" | "running" | "old";

/**
 * Dev-only route (`/dev/studio`, gated by `import.meta.env.DEV` in App.tsx): a file's studio on
 * fixtures, so it can be eyeballed and screenshotted without a session or engine.
 * `?scenario=history|running|old` picks the state, `?theme=light|dark` forces a theme.
 */
export function StudioPreviewPage() {
  const params = new URLSearchParams(window.location.search);
  const scenario = (params.get("scenario") ?? "history") as Scenario;
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const theme = params.get("theme");
    if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
  });
  const bytes = useMemo(() => new TextEncoder().encode(sample), []);
  const shownId = scenario === "old" ? "v3" : "v6";
  const shown = VERSIONS.find((version) => version.id === shownId) as ArtifactVersion;
  const artifact: Artifact = {
    id: shown.id,
    botId: BOT,
    runId: null,
    name: NAME,
    description: "Q3 review",
    mimeType: "text/html",
    size: bytes.byteLength,
    version: shown.version,
    createdAt: shown.createdAt,
    groupId: "v1",
  };
  const content: ArtifactContent = {
    status: "ready",
    artifact,
    bytes,
    versions: VERSIONS,
    versionId: shownId,
    selectVersion: () => {},
    adoptVersion: () => {},
    newer: scenario === "old" ? (VERSIONS[0] ?? null) : null,
    showNewest: () => {},
    arrived: null,
  };
  return (
    <ArtifactRegistryProvider value={[decksExtension]}>
      <div className="flex h-dvh items-center justify-center bg-background text-muted-foreground">
        {open ? null : (
          <button type="button" onClick={() => setOpen(true)}>
            Open the studio
          </button>
        )}
      </div>
      {open ? (
        <StudioView
          content={content}
          chat={{
            sessionId: STUDIO,
            messages: MESSAGES,
            running: scenario === "running",
            failed: false,
          }}
          title="Q3 review"
          onClose={() => setOpen(false)}
        />
      ) : null}
    </ArtifactRegistryProvider>
  );
}
