// @vitest-environment jsdom

import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// jsdom does not implement these; Shell (and the real @aiden/ui-web components
// it renders) use them unconditionally on mount.
beforeEach(() => {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    return setTimeout(() => cb(0), 0) as unknown as number;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => clearTimeout(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const elementProto = Element.prototype as unknown as {
    scrollTo?: (...args: unknown[]) => void;
    scrollIntoView?: (...args: unknown[]) => void;
  };
  elementProto.scrollTo = () => undefined;
  elementProto.scrollIntoView = () => undefined;
  vi.spyOn(performance, "mark").mockImplementation(() => undefined as unknown as PerformanceMark);
  vi.spyOn(performance, "getEntriesByName").mockImplementation(() => []);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const bootstrapApi = vi.hoisted(() => ({ takeInitialBootstrap: vi.fn() }));
vi.mock("../lib/bootstrap", () => bootstrapApi);

vi.mock("../lib/auth", () => ({
  authClient: {
    useSession: () => ({
      data: { user: { id: "user-1" } },
      isPending: false,
      refetch: async () => undefined,
    }),
  },
}));

vi.mock("../lib/rpc", () => {
  function pendingRpc(): unknown {
    const target = () => new Promise(() => undefined);
    return new Proxy(target, { get: () => pendingRpc() });
  }
  return {
    rpc: pendingRpc(),
    selectedSpaceId: () => null,
    selectSpace: () => true,
    clearSpaceSelection: () => undefined,
    withSpaceHeaders: (headers: Record<string, string>) => headers,
  };
});

function tagText(strings: TemplateStringsArray, ...values: unknown[]) {
  return strings.reduce(
    (acc, part, i) => acc + part + (values[i] !== undefined ? String(values[i]) : ""),
    "",
  );
}
vi.mock("@lingui/core/macro", () => ({ t: tagText }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: tagText, i18n: {} }),
  Trans: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@aiden/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock("@aiden/ui-web", () => {
  // Passes every prop straight onto a <div> (event handlers included) so
  // data-testid/aria-label/onClick still work for assertions and clicks even
  // though this isn't the real Base UI component.
  const Passthrough = ({ children, ...rest }: ComponentProps<"div">) => (
    <div {...rest}>{children}</div>
  );
  return {
    AvatarStyleProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
    BotAvatar: ({ identity }: { identity?: string }) => (
      <span data-testid="bot-avatar" data-identity={identity} />
    ),
    Button: (props: ComponentProps<"button">) => <button {...props} />,
    cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
    DropdownMenu: ({ children }: { children?: ReactNode }) => <>{children}</>,
    DropdownMenuContent: Passthrough,
    DropdownMenuItem: (props: ComponentProps<"div">) => <div {...props} />,
    DropdownMenuTrigger: Passthrough,
    GroupAvatar: () => <span data-testid="group-avatar" />,
    Sheet: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
      open ? <>{children}</> : null,
    SheetContent: Passthrough,
    Skeleton: Passthrough,
    SheetTitle: Passthrough,
    SheetDescription: Passthrough,
    Tooltip: ({ children }: { children?: ReactNode }) => <>{children}</>,
    TooltipContent: () => null,
    TooltipTrigger: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    InputGroup: Passthrough,
    InputGroupAddon: Passthrough,
    InputGroupInput: (props: ComponentProps<"input">) => <input {...props} />,
    Popover: ({ children }: { children?: ReactNode }) => <>{children}</>,
    PopoverContent: Passthrough,
    PopoverTrigger: Passthrough,
    resolvePersonaColorDef: () => ({ hex: "#000000" }),
    // Real behavior (packages/ui-web/src/bot-avatar.tsx): museState.ts (Shell's live
    // Muse state derivation) calls this directly, so the mock must actually derive.
    museAvatarState: (status: string | undefined, waitingCount: number | undefined) => {
      if ((waitingCount ?? 0) > 0) return "waiting";
      if (status === "queued" || status === "leased") return "thinking";
      if (status === "running" || status === "waiting_input" || status === "waiting_takeover") {
        return "working";
      }
      return "idle";
    },
  };
});

// Stubs: every module below is presentational chrome not under test here
// (settings panels, dialogs, teach overlays, message cards, ...). Each export
// becomes either a component rendering nothing or a harmless no-op function.
function Stub() {
  return null;
}

vi.mock("../components/ArtifactFileCard", () => ({ ArtifactFileCard: Stub }));
vi.mock("../components/AskCard", () => ({ AskCard: Stub }));
vi.mock("../components/ai/CollaborationMarker", () => ({
  CollaborationMarker: Stub,
  ActiveBotGlyph: Stub,
}));
vi.mock("../components/CloudAgentCard", () => ({ CloudAgentCard: Stub }));
vi.mock("../components/ComputerMaintenanceActions", () => ({ ComputerMaintenanceActions: Stub }));
vi.mock("../components/ComputersUnavailableHint", () => ({
  ComputersUnavailableHint: Stub,
  computersAreUnavailable: () => false,
}));
vi.mock("../components/ComputerUpdateProgress", () => ({ ComputerUpdateProgress: Stub }));
vi.mock("../components/MessageHoverMetadata", () => ({ MessageHoverMetadata: Stub }));
vi.mock("../components/teach/SkillDraftCard", () => ({ SkillDraftCard: Stub }));
vi.mock("../components/teach/TeachCaptureOverlay", () => ({ TeachCaptureOverlay: Stub }));
vi.mock("../components/teach/TeachComputerOverlay", () => ({ TeachComputerOverlayControl: Stub }));
vi.mock("../components/teach/TeachRecordingChrome", () => ({
  TeachRecordingChrome: Stub,
  TeachStopButton: Stub,
}));
vi.mock("./muse/WaitingSheet", () => ({ WaitingSheet: Stub }));
vi.mock("./GroupPanel", () => ({
  GroupSettings: Stub,
  memberName: () => "",
}));
vi.mock("./HostComputerPrompt", () => ({ HostComputerPrompt: Stub }));
vi.mock("./RoutineEditor", () => ({
  RoutineEditor: Stub,
  RoutineListHeader: Stub,
  RoutineListRow: Stub,
  routineNeedsOneShotArm: () => false,
  draftFromRoutine: () => ({}),
  emptyRoutineDraft: () => ({}),
  routineTriggerSummary: () => "",
}));
vi.mock("./SettingsOverlay", () => ({ SettingsOverlay: Stub }));
vi.mock("./shell/bot-panel", () => ({ BotSettings: Stub, CreateBotForm: Stub }));
vi.mock("./shell/dialogs", () => ({
  ClearConversationDialog: Stub,
  DeleteItemDialog: Stub,
}));
vi.mock("./shell/message-cards", () => ({
  ChoiceCard: Stub,
  AppConnectCard: Stub,
  McpApprovalCard: Stub,
  ChartBlockView: Stub,
  ArtifactImage: Stub,
}));

import { ShellPage } from "./Shell";

function bot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "bot-1",
    spaceId: "space-1",
    name: "My Muse",
    title: "My Muse",
    description: "",
    instructions: "",
    color: "#0090FF",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    threadId: "thread-1",
    preview: "",
    status: "idle",
    computerMode: "docker",
    updatedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
    ...overrides,
  };
}

function me(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: "user-1",
    email: "person@example.com",
    name: "Person",
    spaceId: "space-1",
    isDeploymentOwner: true,
    needsModel: false,
    defaultProvider: null,
    defaultModel: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    avatarStyle: "robot",
    ...overrides,
  };
}

function bootstrap(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    me: me(),
    bots: [bot()],
    groups: [],
    botSections: [],
    archivedBots: [],
    archivedGroups: [],
    thread: null,
    routines: [],
    spaces: [],
    ...overrides,
  };
}

async function renderShell(initialBootstrap: ReturnType<typeof bootstrap>) {
  bootstrapApi.takeInitialBootstrap.mockResolvedValue(initialBootstrap);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  i18n.loadAndActivate({ locale: "en", messages: {} });
  await act(async () => {
    root.render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={["/app"]}>
          <Routes>
            <Route path="/app" element={<ShellPage />} />
            <Route path="/app/:botId" element={<ShellPage />} />
            <Route path="/app/g/:groupId" element={<ShellPage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
  });
  // Let the bootstrap promise resolve and its state updates flush.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

it("opens the sidebar as a drawer from the mobile menu button and closes it on navigate", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const page = await renderShell(bootstrap({ me: me() }));
  try {
    const drawer = () => page.container.querySelector('[data-testid="app-rail-drawer"]');
    expect(drawer()).toBeNull();
    await act(async () => {
      page.container
        .querySelector<HTMLButtonElement>('[data-testid="mobile-nav-trigger"]')
        ?.click();
    });
    expect(drawer()).toBeTruthy();
    const goals = [...(drawer()?.querySelectorAll("button") ?? [])].find((el) =>
      el.textContent?.includes("Goals"),
    );
    await act(async () => goals?.click());
    expect(drawer()).toBeNull();
  } finally {
    await page.cleanup();
  }
});

it("hides the bot list and shows the four Muse rail entries", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const page = await renderShell(bootstrap({ me: me() }));
  try {
    expect(page.container.querySelector('[data-testid="bots-sidebar"]')).toBeNull();
    expect(page.container.querySelector('[data-testid="create-menu-trigger"]')).toBeNull();
    const rail = page.container.querySelector('[data-testid="app-rail"]');
    expect(rail).toBeTruthy();
    const labels = [...(rail?.querySelectorAll("button") ?? [])].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent?.trim(),
    );
    expect(labels).toContain("Conversation");
    expect(labels).toContain("Goals");
    expect(labels).toContain("Feed");
    expect(labels).toContain("Library");
  } finally {
    await page.cleanup();
  }
});
