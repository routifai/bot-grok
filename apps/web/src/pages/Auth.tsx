import { Trans, useLingui } from "@lingui/react/macro";
import { readBoundedJsonResponse, signupRequiresEmailVerification } from "@nova/core";
import { Button, Input, Label } from "@nova/ui-web";
import { Eye, EyeOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { clearSpaceSelection } from "../lib/rpc";
import { WelcomeFrame, welcomeFieldClass, welcomeSubmitClass } from "./welcome/WelcomeFrame";

type AuthMode = "in" | "up" | "forgot";
type AuthCapabilities = {
  passwordReset: boolean;
  resetUrl: string | null;
  emailCode: boolean;
  /** The one OIDC connection, when configured; its name labels the button. */
  sso: { name: string } | null;
  /** True while the deployment owner seat is unclaimed and needs the operator setup token. */
  ownerSetup: boolean;
  signupMode: "closed" | "invite" | "domain" | "approval" | "open";
};
/** What the code is for: signing in, or proving the mailbox of a password signup. */
type CodePurpose = "sign-in" | "verify";

const NO_CAPABILITIES: AuthCapabilities = {
  passwordReset: false,
  resetUrl: null,
  emailCode: false,
  sso: null,
  ownerSetup: false,
  signupMode: "open",
};
const fieldClass = welcomeFieldClass;
const submitClass = welcomeSubmitClass;
const AUTH_CAPABILITIES_TIMEOUT_MS = 8_000;
const MAX_AUTH_CAPABILITIES_RESPONSE_BYTES = 64 * 1024;
const CODE_LENGTH = 6;
const RESEND_COOLDOWN_SECONDS = 30;
const PENDING_CODE_KEY = "nova:auth-pending-code";
const OWNER_TOKEN_KEY = "nova:auth-owner-token";
const OWNER_SETUP_HEADER = "x-owner-setup-token";
const FRESH_ACCOUNT_MS = 2 * 60_000;

const linkClass = "font-medium text-welcome-night-ink underline-offset-4 hover:underline";

/** The code step survives the session refresh that signup triggers, which remounts this page. */
function readPendingCode(): { email: string; purpose: CodePurpose } | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(PENDING_CODE_KEY) ?? "null") as {
      email?: unknown;
      purpose?: unknown;
    } | null;
    return typeof parsed?.email === "string" &&
      (parsed.purpose === "sign-in" || parsed.purpose === "verify")
      ? { email: parsed.email, purpose: parsed.purpose }
      : null;
  } catch {
    return null;
  }
}

function writePendingCode(value: { email: string; purpose: CodePurpose } | null) {
  try {
    if (value) sessionStorage.setItem(PENDING_CODE_KEY, JSON.stringify(value));
    else sessionStorage.removeItem(PENDING_CODE_KEY);
  } catch {
    // Storage can be unavailable; the code step then simply restarts.
  }
}

/** The operator's setup token, kept for the tab only so it survives the signup remount. */
function readOwnerToken(): string {
  try {
    return sessionStorage.getItem(OWNER_TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeOwnerToken(value: string) {
  try {
    if (value) sessionStorage.setItem(OWNER_TOKEN_KEY, value);
    else sessionStorage.removeItem(OWNER_TOKEN_KEY);
  } catch {
    // Storage can be unavailable; the field is then simply asked for again.
  }
}

export function AuthPage({ mode }: { mode: AuthMode }) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [usePassword, setUsePassword] = useState(false);
  const [ownerToken, setOwnerToken] = useState(readOwnerToken);
  const restored = searchParams.get("verify") === "email" ? readPendingCode() : null;
  const [code, setCode] = useState<{ email: string; purpose: CodePurpose } | null>(restored);
  const [digits, setDigits] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const caps = capabilities ?? NO_CAPABILITIES;
  const tokenOptions = ownerToken
    ? { fetchOptions: { headers: { [OWNER_SETUP_HEADER]: ownerToken } } }
    : {};
  const codeLogin = caps.emailCode && !usePassword && mode !== "forgot";
  const passwordFieldId = mode === "in" ? "current-password" : "new-password";
  const title = code ? (
    <Trans>Check your email</Trans>
  ) : resetSent ? (
    <Trans>Check your email</Trans>
  ) : mode === "in" ? (
    <Trans>Welcome back.</Trans>
  ) : mode === "up" ? (
    <Trans>Meet Nova.</Trans>
  ) : (
    <Trans>Reset your password</Trans>
  );

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AUTH_CAPABILITIES_TIMEOUT_MS);
    void fetch("/api/auth/capabilities", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load authentication capabilities");
        return readBoundedJsonResponse<AuthCapabilities>(
          response,
          MAX_AUTH_CAPABILITIES_RESPONSE_BYTES,
          controller.signal,
        );
      })
      .then((loaded) => {
        if (active) setCapabilities({ ...NO_CAPABILITIES, ...loaded });
      })
      .catch(() => undefined)
      .finally(() => clearTimeout(timer));
    return () => {
      // Do not abort on unmount: a guard redirect that bounces through this
      // page only mounts it for a render or two, and the cancelled fetch then
      // surfaces as a failed request. `active` drops the result and the timer
      // keeps its bound — abort() on an already settled fetch is a no-op.
      active = false;
    };
  }, []);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((seconds) => seconds - 1), 1_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  function showCodeStep(next: { email: string; purpose: CodePurpose }) {
    writePendingCode(next);
    setCode(next);
    setDigits("");
    setError(null);
    setCooldown(RESEND_COOLDOWN_SECONDS);
  }

  function leaveCodeStep() {
    writePendingCode(null);
    setCode(null);
    setDigits("");
    setError(null);
    if (searchParams.has("verify")) setSearchParams({});
  }

  /** A brand-new account starts at onboarding; a returning one at the app. */
  function destination(createdAt: unknown, fresh: boolean) {
    if (searchParams.get("next") === "/integrations/setup") return "/integrations/setup";
    const created = typeof createdAt === "string" ? Date.parse(createdAt) : Number.NaN;
    return fresh || Date.now() - created < FRESH_ACCOUNT_MS ? "/onboarding" : "/app";
  }

  async function submitCode(event: React.FormEvent) {
    event.preventDefault();
    if (!code || digits.length !== CODE_LENGTH) return;
    setPending(true);
    setError(null);
    try {
      const result =
        code.purpose === "verify"
          ? await authClient.emailOtp.verifyEmail({
              email: code.email,
              otp: digits,
              ...tokenOptions,
            })
          : await authClient.signIn.emailOtp({ email: code.email, otp: digits, ...tokenOptions });
      if (result.error) {
        setDigits("");
        setError(result.error.message ?? t`That code did not work`);
        return;
      }
      writePendingCode(null);
      writeOwnerToken("");
      clearSpaceSelection();
      const user = (result.data as { user?: { createdAt?: unknown } } | null)?.user;
      navigate(destination(user?.createdAt, mode === "up" && code.purpose === "verify"));
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  async function resend() {
    if (!code || cooldown > 0) return;
    setError(null);
    setCooldown(RESEND_COOLDOWN_SECONDS);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: code.email,
        type: code.purpose === "verify" ? "email-verification" : "sign-in",
      });
      if (result.error) setError(result.error.message ?? t`Could not send a code`);
    } catch {
      setError(t`Could not reach the server`);
    }
  }

  async function continueWithSso() {
    setError(null);
    try {
      const result = await authClient.signIn.social({
        provider: "sso",
        callbackURL: new URL("/app", window.location.origin).href,
        newUserCallbackURL: new URL("/onboarding", window.location.origin).href,
        errorCallbackURL: new URL("/sign-in", window.location.origin).href,
      });
      if (result.error) setError(result.error.message ?? t`Could not continue`);
    } catch {
      setError(t`Could not reach the server`);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      if (mode === "forgot") {
        if (!caps.passwordReset || !caps.resetUrl) {
          setError(t`Password recovery is not configured for this server`);
          return;
        }
        const result = await authClient.requestPasswordReset({
          email: email.trim(),
          redirectTo: caps.resetUrl,
        });
        if (result.error) {
          setError(result.error.message ?? t`Could not send reset email`);
          return;
        }
        setResetSent(true);
        return;
      }
      writeOwnerToken(ownerToken);
      if (codeLogin) {
        const result = await authClient.emailOtp.sendVerificationOtp({
          email: email.trim(),
          type: "sign-in",
        });
        if (result.error) {
          setError(result.error.message ?? t`Could not send a code`);
          return;
        }
        showCodeStep({ email: email.trim(), purpose: "sign-in" });
        return;
      }
      const result =
        mode === "up"
          ? await authClient.signUp.email({
              email,
              password,
              name: name || email.split("@")[0] || "User",
              ...tokenOptions,
            })
          : await authClient.signIn.email({ email, password, ...tokenOptions });
      if (result.error) {
        // An unverified address was just sent a fresh code by the server.
        if (result.error.code === "EMAIL_NOT_VERIFIED") {
          showCodeStep({ email: email.trim(), purpose: "verify" });
          return;
        }
        setError(result.error.message ?? t`Could not continue`);
        return;
      }
      if (mode === "up" && signupRequiresEmailVerification(result.data)) {
        // Signup refreshes the session and remounts this page; the URL and storage carry the step.
        writePendingCode({ email: email.trim(), purpose: "verify" });
        setSearchParams({ verify: "email" });
        showCodeStep({ email: email.trim(), purpose: "verify" });
        return;
      }
      // The setup token is a one-time operator secret: never leave it in the tab after a sign-in.
      writeOwnerToken("");
      clearSpaceSelection();
      navigate(
        mode === "up"
          ? "/onboarding"
          : searchParams.get("next") === "/integrations/setup"
            ? "/integrations/setup"
            : "/app",
      );
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  if (code) {
    return (
      <WelcomeFrame onSubmit={submitCode} title={title}>
        <p className="mb-6 w-full text-center text-sm text-welcome-night-ink-2">{code.email}</p>
        <div className="w-full">
          <Label htmlFor="code" className="sr-only">
            <Trans>Code</Trans>
          </Label>
          <Input
            id="code"
            name="code"
            value={digits}
            onChange={(event) =>
              setDigits(event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH))
            }
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={CODE_LENGTH}
            placeholder="000000"
            autoFocus
            required
            className={`${fieldClass} text-center font-mono text-2xl tracking-[0.5em]`}
          />
        </div>
        {error ? (
          <p role="alert" className="mt-3 w-full text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          type="submit"
          size="lg"
          disabled={pending || digits.length !== CODE_LENGTH}
          className={submitClass}
        >
          {pending ? <Trans>Working…</Trans> : <Trans>Continue</Trans>}
        </Button>
        <div className="mt-7 flex w-full items-center justify-between text-sm text-welcome-night-ink-2">
          <button
            type="button"
            onClick={() => void resend()}
            disabled={cooldown > 0}
            className={`${linkClass} disabled:cursor-default disabled:no-underline disabled:opacity-60`}
          >
            {cooldown > 0 ? <Trans>Resend in {cooldown}s</Trans> : <Trans>Resend code</Trans>}
          </button>
          <button type="button" onClick={leaveCodeStep} className={linkClass}>
            <Trans>Use a different email</Trans>
          </button>
        </div>
      </WelcomeFrame>
    );
  }

  return (
    <WelcomeFrame onSubmit={submit} title={title}>
      {resetSent ? (
        <div className="w-full text-center">
          <Link to="/sign-in" className={linkClass}>
            <Trans>Back to sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          {mode !== "forgot" && caps.sso ? (
            <div className="mb-6 w-full">
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={() => void continueWithSso()}
                className="h-12 w-full rounded-full border-welcome-night-line/16 bg-transparent text-[15px] font-medium text-welcome-night-ink hover:bg-welcome-night-bubble"
              >
                <Trans>Continue with {caps.sso.name}</Trans>
              </Button>
            </div>
          ) : null}
          {mode === "up" && !codeLogin ? (
            <div className="mb-4 w-full">
              <Label htmlFor="name" className="text-welcome-night-ink-2">
                <Trans>Name</Trans>
              </Label>
              <Input
                id="name"
                name="name"
                autoComplete="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t`Your name`}
                className={fieldClass}
              />
            </div>
          ) : null}
          <div className="w-full">
            <Label htmlFor="email" className="text-welcome-night-ink-2">
              <Trans>Email</Trans>
            </Label>
            <Input
              id="email"
              name="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder={t`Your email address`}
              type="email"
              required
              className={fieldClass}
            />
          </div>
          {mode !== "forgot" && !codeLogin ? (
            <div className="mt-4 w-full">
              <Label htmlFor={passwordFieldId} className="text-welcome-night-ink-2">
                <Trans>Password</Trans>
              </Label>
              <div className="relative">
                <Input
                  id={passwordFieldId}
                  name="password"
                  autoComplete={mode === "in" ? "current-password" : "new-password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t`Password`}
                  type={showPassword ? "text" : "password"}
                  required
                  minLength={8}
                  className={`${fieldClass} pr-12`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowPassword((shown) => !shown)}
                  aria-label={showPassword ? t`Hide password` : t`Show password`}
                  aria-pressed={showPassword}
                  className="absolute inset-y-0 right-2 my-auto text-welcome-night-ink-3 hover:bg-transparent hover:text-welcome-night-ink"
                >
                  {showPassword ? <EyeOff /> : <Eye />}
                </Button>
              </div>
              {mode === "in" && caps.passwordReset ? (
                <div className="mt-2 text-right text-sm">
                  <Link to="/forgot-password" className={linkClass}>
                    <Trans>Forgot password?</Trans>
                  </Link>
                </div>
              ) : null}
            </div>
          ) : null}
          {mode !== "forgot" && caps.ownerSetup ? (
            <div className="mt-4 w-full">
              <Label htmlFor="owner-token" className="text-welcome-night-ink-2">
                <Trans>Setup token</Trans>
              </Label>
              <Input
                id="owner-token"
                name="owner-token"
                type="password"
                autoComplete="off"
                value={ownerToken}
                onChange={(e) => setOwnerToken(e.target.value)}
                className={fieldClass}
              />
            </div>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button type="submit" size="lg" disabled={pending} className={submitClass}>
            {pending ? (
              <Trans>Working…</Trans>
            ) : codeLogin || mode === "in" ? (
              <Trans>Continue with email</Trans>
            ) : mode === "forgot" ? (
              <Trans>Send reset link</Trans>
            ) : (
              <Trans>Create account</Trans>
            )}
          </Button>
          {mode === "in" && caps.emailCode ? (
            <button
              type="button"
              onClick={() => {
                setUsePassword((value) => !value);
                setError(null);
              }}
              className={`mt-4 text-sm ${linkClass}`}
            >
              {usePassword ? <Trans>Email me a code</Trans> : <Trans>Use a password</Trans>}
            </button>
          ) : null}
          <p className="mt-7 text-sm text-welcome-night-ink-2">
            {mode === "in" ? (
              caps.signupMode === "closed" ? null : (
                <>
                  <Trans>Don’t have an account?</Trans>{" "}
                  <Link to="/sign-up" className={linkClass}>
                    <Trans>Sign up</Trans>
                  </Link>
                </>
              )
            ) : mode === "up" ? (
              <>
                <Trans>Already have an account?</Trans>{" "}
                <Link to="/sign-in" className={linkClass}>
                  <Trans>Sign in</Trans>
                </Link>
              </>
            ) : (
              <Link to="/sign-in" className={linkClass}>
                <Trans>Back to sign in</Trans>
              </Link>
            )}
          </p>
        </>
      )}
    </WelcomeFrame>
  );
}

export function PasswordResetPage() {
  const { t } = useLingui();
  const [params] = useSearchParams();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(
    params.get("error") || !params.get("token") ? t`This reset link is invalid or expired` : null,
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const token = params.get("token");
    if (!token) return;
    if (password !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.resetPassword({ newPassword: password, token });
      if (result.error) {
        setError(result.error.message ?? t`Could not reset password`);
        return;
      }
      setComplete(true);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <WelcomeFrame onSubmit={submit} title={<Trans>Choose a new password</Trans>}>
      {complete ? (
        <div role="status" className="w-full text-center">
          <p className="text-lg">
            <Trans>Password updated</Trans>
          </p>
          <Link to="/sign-in" className="mt-6 inline-block font-medium">
            <Trans>Sign in</Trans>
          </Link>
        </div>
      ) : (
        <>
          <PasswordField
            id="new-password"
            label={t`New password`}
            value={password}
            onChange={setPassword}
          />
          <PasswordField
            id="confirm-password"
            label={t`Confirm password`}
            value={confirmation}
            onChange={setConfirmation}
            className="mt-4"
          />
          {error ? (
            <p role="alert" className="mt-3 w-full text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="lg"
            disabled={pending || !params.get("token")}
            className={submitClass}
          >
            {pending ? <Trans>Working…</Trans> : <Trans>Reset password</Trans>}
          </Button>
          <Link to="/sign-in" className="mt-6 font-medium">
            <Trans>Back to sign in</Trans>
          </Link>
        </>
      )}
    </WelcomeFrame>
  );
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  className = "",
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <div className={`w-full ${className}`}>
      <Label htmlFor={id} className="text-welcome-night-ink-2">
        {label}
      </Label>
      <Input
        id={id}
        name={id}
        autoComplete="new-password"
        type="password"
        required
        minLength={8}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={fieldClass}
      />
    </div>
  );
}
