// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("react-dom/client", async (orig) =>
  (await import("../test/i18n")).withI18nRoot(await orig<typeof import("react-dom/client")>()),
);

const client = vi.hoisted(() => ({
  signIn: { email: vi.fn(), emailOtp: vi.fn(), social: vi.fn() },
  signUp: { email: vi.fn() },
  emailOtp: { sendVerificationOtp: vi.fn(), verifyEmail: vi.fn() },
  requestPasswordReset: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ authClient: client }));
vi.mock("../lib/rpc", () => ({ clearSpaceSelection: vi.fn() }));

import { AuthPage } from "./Auth";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

const capabilities = {
  passwordReset: true,
  resetUrl: "http://web.test/reset-password",
  emailCode: false,
  sso: null as { name: string } | null,
  ownerSetup: false,
  signupMode: "open",
};

function serve(over: Partial<typeof capabilities>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ ...capabilities, ...over }))),
  );
}

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  sessionStorage.clear();
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("reduce"),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
  for (const name of ["IntersectionObserver", "ResizeObserver"]) {
    vi.stubGlobal(
      name,
      class {
        observe() {}
        disconnect() {}
      },
    );
  }
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

function Where() {
  return <p data-testid="where">{useLocation().pathname}</p>;
}

async function render(mode: "in" | "up" | "forgot", search = "") {
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/${mode}${search}`]}>
        <Routes>
          <Route path="/:mode" element={<AuthPage mode={mode} />} />
          <Route path="*" element={<Where />} />
        </Routes>
        <Where />
      </MemoryRouter>,
    );
  });
  await act(async () => {});
}

function type(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const button = (label: string | RegExp) =>
  [...host.querySelectorAll("button")].find((b) =>
    typeof label === "string" ? b.textContent === label : label.test(b.textContent ?? ""),
  ) as HTMLButtonElement | undefined;

async function submit() {
  await act(async () => {
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

it("keeps the password form on a server with no email, with no code or social buttons", async () => {
  serve({});
  client.signIn.email.mockResolvedValue({ data: { token: "t" }, error: null });
  await render("in");
  expect(host.querySelector("#current-password")).not.toBeNull();
  expect(button(/google|microsoft/i)).toBeUndefined();
  expect(button("Use a password")).toBeUndefined();
  type("#email", "ada@corp.test");
  type("#current-password", "correct-horse");
  await submit();
  expect(client.signIn.email).toHaveBeenCalledWith({
    email: "ada@corp.test",
    password: "correct-horse",
  });
});

it("signs in with an emailed code, then enters the app", async () => {
  serve({ emailCode: true });
  client.emailOtp.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
  client.signIn.emailOtp.mockResolvedValue({
    data: { user: { createdAt: "2020-01-01T00:00:00Z" } },
    error: null,
  });
  await render("in");
  expect(host.querySelector("#current-password")).toBeNull();
  type("#email", "ada@corp.test");
  await submit();
  expect(client.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "ada@corp.test",
    type: "sign-in",
  });
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  expect(host.textContent).toContain("ada@corp.test");
  type("#code", "12a3456 9");
  expect(host.querySelector<HTMLInputElement>("#code")!.value).toBe("123456");
  await submit();
  expect(client.signIn.emailOtp).toHaveBeenCalledWith({ email: "ada@corp.test", otp: "123456" });
  expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("/app");
});

it("sends a brand-new account to onboarding", async () => {
  serve({ emailCode: true });
  client.emailOtp.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
  client.signIn.emailOtp.mockResolvedValue({
    data: { user: { createdAt: new Date().toISOString() } },
    error: null,
  });
  await render("up");
  type("#email", "new@corp.test");
  await submit();
  type("#code", "654321");
  await submit();
  expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("/onboarding");
});

it("shows a wrong code as an error and lets the person retry", async () => {
  serve({ emailCode: true });
  client.emailOtp.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
  client.signIn.emailOtp.mockResolvedValue({
    data: null,
    error: { message: "Invalid OTP", status: 400 },
  });
  await render("in");
  type("#email", "ada@corp.test");
  await submit();
  type("#code", "000000");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Invalid OTP");
  expect(host.querySelector("#code")).not.toBeNull();
  expect(host.querySelector<HTMLInputElement>("#code")!.value).toBe("");
});

it("resends only after the cooldown and can go back to another email", async () => {
  serve({ emailCode: true });
  client.emailOtp.sendVerificationOtp.mockResolvedValue({ data: { success: true }, error: null });
  await render("in");
  type("#email", "ada@corp.test");
  vi.useFakeTimers();
  await submit();
  expect(button(/Resend in/)?.disabled).toBe(true);
  client.emailOtp.sendVerificationOtp.mockClear();
  for (let second = 0; second < 30; second += 1) {
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
  }
  expect(button("Resend code")?.disabled).toBe(false);
  await act(async () => button("Resend code")!.click());
  expect(client.emailOtp.sendVerificationOtp).toHaveBeenCalledWith({
    email: "ada@corp.test",
    type: "sign-in",
  });
  await act(async () => button("Use a different email")!.click());
  expect(host.querySelector("#email")).not.toBeNull();
});

it("asks for the emailed code after a password signup, and verifies the mailbox with it", async () => {
  // A server without code sign-in (the capabilities lack it) still verifies by code afterwards.
  serve({ emailCode: false });
  client.signUp.email.mockResolvedValue({ data: { token: null, user: {} }, error: null });
  client.emailOtp.verifyEmail.mockResolvedValue({ data: { user: {} }, error: null });
  await render("up");
  type("#email", "ada@corp.test");
  type("#new-password", "correct-horse");
  await submit();
  expect(client.signUp.email).toHaveBeenCalled();
  expect(host.querySelector("h1")?.textContent).toBe("Check your email");
  type("#code", "111222");
  await submit();
  expect(client.emailOtp.verifyEmail).toHaveBeenCalledWith({
    email: "ada@corp.test",
    otp: "111222",
  });
  expect(host.querySelector('[data-testid="where"]')?.textContent).toBe("/onboarding");
});

it("resumes the code step after the signup remount", async () => {
  serve({ emailCode: true });
  sessionStorage.setItem(
    "nova:auth-pending-code",
    JSON.stringify({ email: "ada@corp.test", purpose: "verify" }),
  );
  await render("up", "?verify=email");
  expect(host.querySelector("#code")).not.toBeNull();
  expect(host.textContent).toContain("ada@corp.test");
});

it("moves an unverified password sign-in to the code step", async () => {
  serve({});
  client.signIn.email.mockResolvedValue({
    data: null,
    error: { code: "EMAIL_NOT_VERIFIED", message: "Email not verified", status: 403 },
  });
  await render("in");
  type("#email", "ada@corp.test");
  type("#current-password", "correct-horse");
  await submit();
  expect(host.querySelector("#code")).not.toBeNull();
});

it("shows a server refusal on signup", async () => {
  serve({});
  client.signUp.email.mockResolvedValue({
    data: null,
    error: { message: "Registration is closed", status: 400 },
  });
  await render("up");
  type("#email", "ada@corp.test");
  type("#new-password", "correct-horse");
  await submit();
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Registration is closed");
});

it("shows the one SSO button, named by the server, only when it is configured", async () => {
  serve({ sso: { name: "Contoso" } });
  client.signIn.social.mockResolvedValue({ data: {}, error: null });
  await render("in");
  expect(button(/google|microsoft/i)).toBeUndefined();
  await act(async () => button("Continue with Contoso")!.click());
  expect(client.signIn.social).toHaveBeenCalledWith(expect.objectContaining({ provider: "sso" }));
});

it("offers no password route on sign-up when email codes are available", async () => {
  serve({ emailCode: true });
  await render("up");
  expect(button("Use a password")).toBeUndefined();
  expect(host.querySelector("#new-password")).toBeNull();
});

it("asks for the setup token while the owner seat is open, and sends it with the sign-in", async () => {
  serve({ ownerSetup: true, signupMode: "approval" });
  client.signUp.email.mockResolvedValue({ data: { token: "t", user: {} }, error: null });
  await render("up");
  expect(host.querySelector("#owner-token")).not.toBeNull();
  type("#email", "owner@corp.test");
  type("#new-password", "correct-horse");
  type("#owner-token", "operator-token");
  await submit();
  expect(client.signUp.email).toHaveBeenCalledWith(
    expect.objectContaining({
      fetchOptions: { headers: { "x-owner-setup-token": "operator-token" } },
    }),
  );
});

it("forgets the setup token from the tab once the sign-up succeeds", async () => {
  serve({ ownerSetup: true, signupMode: "approval" });
  client.signUp.email.mockResolvedValue({ data: { token: "t", user: {} }, error: null });
  await render("up");
  type("#email", "owner@corp.test");
  type("#new-password", "correct-horse");
  type("#owner-token", "operator-token");
  await submit();
  expect(sessionStorage.getItem("nova:auth-owner-token")).toBeNull();
});

it("does not show the setup token field once an owner exists", async () => {
  serve({ ownerSetup: false });
  await render("up");
  expect(host.querySelector("#owner-token")).toBeNull();
});

it("hides the sign-up link while registration is closed", async () => {
  serve({ signupMode: "closed" });
  await render("in");
  expect(host.textContent).not.toContain("Sign up");
});
