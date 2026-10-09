// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("./ArtifactPanel", () => ({
  ArtifactPanel: ({ artifactId }: { artifactId: string }) => <div data-panel>{artifactId}</div>,
}));

import type { ArtifactPanelApi } from "../../components/cards/context";
import { useChatArtifacts } from "./useChatArtifacts";

type Surface = ReturnType<typeof useChatArtifacts>;
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

function setup(initialKey: string) {
  let latest!: Surface;
  const host = document.createElement("div");
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  function Probe({ resetKey }: { resetKey: string }) {
    latest = useChatArtifacts(resetKey);
    return <>{latest.panel}</>;
  }
  act(() => root.render(<Probe resetKey={initialKey} />));
  return {
    host,
    get: () => latest,
    rerender: (key: string) => act(() => root.render(<Probe resetKey={key} />)),
  };
}

it("opens an artifact in the shared panel and closes it", async () => {
  const s = setup("bot:a");
  expect(s.get().isOpen).toBe(false);
  await act(async () => (s.get().api as ArtifactPanelApi).open("art-1", "Report"));
  expect(s.get().isOpen).toBe(true);
  expect(s.get().api.openId).toBe("art-1");
  await vi.waitFor(() => expect(s.host.querySelector("[data-panel]")?.textContent).toBe("art-1"));
  act(() => s.get().api.close());
  expect(s.get().isOpen).toBe(false);
});

it("closes when the chat changes (Conversation to a Side Chat)", async () => {
  const s = setup("bot:a:");
  await act(async () => s.get().api.open("art-1"));
  expect(s.get().isOpen).toBe(true);
  s.rerender("bot:a:side-1");
  expect(s.get().isOpen).toBe(false);
});
