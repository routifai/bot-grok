// @vitest-environment jsdom

import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  me: vi.fn(),
  models: { list: vi.fn(async () => [] as unknown[]) },
  integrationSetup: { get: vi.fn(async () => null) },
  bots: {
    list: vi.fn(async () => [] as unknown[]),
    create: vi.fn(async (input: { name: string; color?: string }) => ({
      id: "bot-1",
      spawnKey: "onboarding:first",
      name: input.name,
      color: input.color ?? "#000000",
    })),
  },
  mcp: { assignments: { approve: vi.fn(async () => undefined) } },
  onboarding: {
    start: vi.fn(async () => ({ ok: true as const })),
    promptFocus: vi.fn(async () => ({ ok: true as const })),
  },
}));
const authApi = vi.hoisted(() => ({ updateUser: vi.fn(async () => ({ error: null })) }));

vi.mock("../lib/rpc", () => ({ rpc: api }));
vi.mock("../lib/auth", () => ({ authClient: authApi }));
vi.mock("../components/integrations/IntegrationSetup", () => ({
  IntegrationSetup: () => <div data-testid="integration-setup" />,
}));
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((acc, part, i) => acc + part + (i < values.length ? String(values[i]) : ""), "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@aiden/ui-web", () => {
  const Container = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    BotAvatar: () => <span data-testid="bot-avatar" />,
    Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
    cn: (...parts: unknown[]) => parts.filter(Boolean).join(" "),
    Input: (props: ComponentProps<"input">) => <input {...props} />,
    ModelThinkingOptions: () => null,
    Select: Container,
    SelectContent: Container,
    SelectItem: Container,
    SelectTrigger: Container,
    SelectValue: () => null,
  };
});

import { DEFAULT_MUSE_COLOR } from "@aiden/contracts";
import { OnboardingPage } from "./Onboarding";

function baseMe(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    userId: "user-1",
    email: "person@example.com",
    name: "Alex",
    spaceId: "space-1",
    isDeploymentOwner: true,
    needsModel: true,
    defaultProvider: null,
    defaultModel: null,
    computerHost: null,
    canChooseHostComputer: false,
    sandboxProvider: "docker",
    avatarStyle: "robot",
    ...overrides,
  };
}

async function renderOnboarding() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/onboarding"]}>
        <OnboardingPage />
      </MemoryRouter>,
    ),
  );
  return {
    container,
    async cleanup() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

function findButton(container: HTMLElement, text: string) {
  const button = [...container.querySelectorAll("button")].find((el) =>
    el.textContent?.includes(text),
  );
  if (!button) throw new Error(`missing button "${text}"`);
  return button;
}

function nameInput(container: HTMLElement) {
  const input = container.querySelector("input");
  if (!(input instanceof HTMLInputElement)) throw new Error("missing input");
  return input;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("walks intro -> name -> Muse name -> color (sky preselected) -> model, in order", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.me.mockResolvedValue(baseMe({ needsModel: true }));
  const page = await renderOnboarding();
  try {
    // Step 0: the warm introduction.
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Hi, I'm Nova — already on it.");
      });
    });
    await act(async () => {
      findButton(page.container, "Let's get started").click();
    });

    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("First, what should I call you?");
      });
    });

    // Step 1: your name.
    await act(async () => {
      setInputValue(nameInput(page.container), "Jamie");
    });
    await act(async () => {
      findButton(page.container, "Continue").click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(authApi.updateUser).toHaveBeenCalledWith({ name: "Jamie" });
      });
    });

    // Step 2: the Muse's name.
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("And what would you like to call me?");
      });
    });
    await act(async () => {
      setInputValue(nameInput(page.container), "Nova");
    });
    await act(async () => {
      findButton(page.container, "Continue").click();
    });

    // Step 3: color, sky preselected.
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Pick my color.");
      });
    });
    const preselected = page.container.querySelector(
      `button[aria-label="Color ${DEFAULT_MUSE_COLOR}"]`,
    );
    expect(preselected?.getAttribute("aria-pressed")).toBe("true");
    await act(async () => {
      findButton(page.container, "Continue").click();
    });

    // Step 4: model, warm copy.
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain(
          "Last thing — connect the brain I'll think with.",
        );
      });
    });
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});

it("creates exactly one bot with the chosen name and color", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.bots.create.mockClear();
  api.me.mockResolvedValue(baseMe({ needsModel: false }));
  const page = await renderOnboarding();
  try {
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Hi, I'm Nova — already on it.");
      });
    });
    await act(async () => {
      findButton(page.container, "Let's get started").click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("First, what should I call you?");
      });
    });
    await act(async () => {
      setInputValue(nameInput(page.container), "Jamie");
    });
    await act(async () => {
      findButton(page.container, "Continue").click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("And what would you like to call me?");
      });
    });
    await act(async () => {
      setInputValue(nameInput(page.container), "Nova");
    });
    await act(async () => {
      findButton(page.container, "Continue").click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(page.container.textContent).toContain("Pick my color.");
      });
    });
    await act(async () => {
      findButton(page.container, "Continue").click();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(api.bots.create).toHaveBeenCalledTimes(1);
      });
    });
    expect(api.bots.create).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Nova", color: DEFAULT_MUSE_COLOR }),
    );
  } finally {
    await page.cleanup();
    vi.unstubAllGlobals();
  }
});
