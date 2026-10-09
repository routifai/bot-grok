import { Trans, useLingui } from "@lingui/react/macro";
import { LOCAL_SETTINGS_PAGE } from "@nova/contracts";
import { Button, Skeleton } from "@nova/ui-web";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate, Route, Routes, useSearchParams } from "react-router-dom";
import { LoadingState } from "./components/ai/primitives";
import { authClient } from "./lib/auth";
import { markAfterPaint, markOnce } from "./lib/performance";
import {
  holdUnreachableGate,
  sessionGate,
  sessionRetryDelayMs,
  showSessionUnavailable,
} from "./lib/session-gate";
import { ActivityPreviewPage } from "./pages/dev/ActivityPreviewPage";
import { CanvasPreviewPage } from "./pages/dev/CanvasPreviewPage";
import { DeckPreviewPage } from "./pages/dev/DeckPreviewPage";
import { ForksPreviewPage } from "./pages/dev/ForksPreviewPage";
import { MemoryPreviewPage } from "./pages/dev/MemoryPreviewPage";
import { SheetPreviewPage } from "./pages/dev/SheetPreviewPage";
import { SideChatsPreviewPage } from "./pages/dev/SideChatsPreviewPage";
import { IntegrationSetupPage } from "./pages/IntegrationSetup";
import { LocalSettingsPage } from "./pages/LocalSettings";
import { McpOAuthCallbackPage } from "./pages/McpOAuthCallback";
import { ShellPage } from "./pages/Shell";

const AuthPage = lazy(() =>
  import("./pages/Auth").then((module) => ({ default: module.AuthPage })),
);
const PasswordResetPage = lazy(() =>
  import("./pages/Auth").then((module) => ({ default: module.PasswordResetPage })),
);
const OnboardingPage = lazy(() =>
  import("./pages/Onboarding").then((module) => ({ default: module.OnboardingPage })),
);
const WelcomePage = lazy(() =>
  import("./pages/Welcome").then((module) => ({ default: module.WelcomePage })),
);
const ArtifactsPage = lazy(() =>
  import("./features/artifacts/Artifacts").then((module) => ({ default: module.ArtifactsPage })),
);

export function App() {
  if (window.location.pathname === LOCAL_SETTINGS_PAGE) return <LocalSettingsPage />;
  // Dev-only fixture route: no session needed, so screenshots and eyeballing don't
  // require a signed-in account or a live agent run.
  if (import.meta.env.DEV && window.location.pathname === "/dev/canvas") {
    return <CanvasPreviewPage />;
  }
  // Dev-only fixture route for the Side Chats sidebar + session (SideChatsPreviewPage.tsx),
  // same reasoning as /dev/canvas: no session or backend chats wire needed.
  if (import.meta.env.DEV && window.location.pathname === "/dev/side-chats") {
    return <SideChatsPreviewPage />;
  }
  // Dev-only fixture route for the Activity panel (ActivityPreviewPage.tsx): same
  // reasoning — `activities.*` isn't served by the local dev API either.
  if (import.meta.env.DEV && window.location.pathname === "/dev/activity") {
    return <ActivityPreviewPage />;
  }
  // Dev-only fixture route for message forks (ForksPreviewPage.tsx), same reasoning.
  if (import.meta.env.DEV && window.location.pathname === "/dev/forks") {
    return <ForksPreviewPage />;
  }
  if (import.meta.env.DEV && window.location.pathname === "/dev/sheet") {
    return <SheetPreviewPage />;
  }
  if (import.meta.env.DEV && window.location.pathname === "/dev/deck") {
    return <DeckPreviewPage />;
  }
  if (import.meta.env.DEV && window.location.pathname === "/dev/memory") {
    return <MemoryPreviewPage />;
  }
  return <SessionApp />;
}

function SessionApp() {
  const [searchParams] = useSearchParams();
  const signInDestination =
    searchParams.get("next") === "/integrations/setup" ? "/integrations/setup" : "/app";
  const session = authClient.useSession();
  const gate = sessionGate(session);
  const [holdingUnreachable, setHoldingUnreachable] = useState(false);
  const nextHolding = holdUnreachableGate(gate, holdingUnreachable);
  if (nextHolding !== holdingUnreachable) setHoldingUnreachable(nextHolding);

  useLayoutEffect(() => {
    if (session.isPending) return;
    markOnce("rk:renderer:session-committed");
    markAfterPaint("rk:renderer:session-painted");
  }, [session.isPending]);

  if (showSessionUnavailable(gate, nextHolding)) {
    return <SessionUnavailable refetch={session.refetch} />;
  }
  if (gate === "loading") {
    return window.location.pathname.startsWith("/app") ? (
      <ShellSkeleton />
    ) : (
      <div
        className="grid h-full place-items-center text-muted-foreground/80"
        data-nova-app-state="session-pending"
      >
        <Trans>Loading…</Trans>
      </div>
    );
  }

  const user = session.data?.user;
  return (
    <div className="h-full" data-nova-app-state="ready">
      {/* Signed out, every page wears the night welcome surface, so the loading frame does too. */}
      <Suspense
        fallback={<div className={`h-full ${user ? "bg-background" : "bg-welcome-night"}`} />}
      >
        <Routes>
          <Route path="/" element={user ? <Navigate to="/app" replace /> : <WelcomePage />} />
          <Route
            path="/sign-in"
            element={
              user ? <Navigate to={signInDestination} replace /> : <AuthPage key="in" mode="in" />
            }
          />
          <Route
            path="/sign-up"
            element={user ? <Navigate to="/onboarding" replace /> : <AuthPage key="up" mode="up" />}
          />
          <Route
            path="/forgot-password"
            element={
              user ? <Navigate to="/app" replace /> : <AuthPage key="forgot" mode="forgot" />
            }
          />
          <Route path="/reset-password" element={<PasswordResetPage />} />
          <Route
            path="/onboarding"
            element={user ? <OnboardingPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/mcp/oauth/callback"
            element={user ? <McpOAuthCallbackPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/integrations/setup"
            element={
              user ? (
                <IntegrationSetupPage />
              ) : (
                <Navigate to="/sign-in?next=/integrations/setup" replace />
              )
            }
          />
          <Route path="/app" element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />} />
          <Route
            path="/app/g/:groupId"
            element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/app/artifacts"
            element={user ? <ArtifactsPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/app/artifacts/:artifactId"
            element={user ? <ArtifactsPage /> : <Navigate to="/sign-in" replace />}
          />
          <Route
            path="/app/:botId"
            element={user ? <ShellPage /> : <Navigate to="/sign-in" replace />}
          />
        </Routes>
      </Suspense>
    </div>
  );
}

/**
 * A session lookup that never reached the server is not a sign-out, so the app
 * waits and retries here instead of routing to sign-in and stranding a signed-in
 * user. Better Auth only polls once a session exists, so the retry lives here.
 */
function SessionUnavailable({ refetch }: { refetch: () => Promise<void> }) {
  const { t } = useLingui();
  const [attempt, setAttempt] = useState(0);
  const [retryKey, setRetryKey] = useState(0);
  const retryImmediately = useRef(false);
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    let cancelled = false;
    const delay = retryImmediately.current ? 0 : sessionRetryDelayMs(attempt);
    retryImmediately.current = false;
    const timer = setTimeout(() => {
      void refetchRef.current().finally(() => {
        if (!cancelled) setAttempt((value) => value + 1);
      });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [attempt, retryKey]);

  return (
    <div className="grid h-full place-items-center bg-background px-6 text-center">
      <div className="flex flex-col items-center">
        <LoadingState label={t`Reconnecting`} />
        <p className="mt-3 text-[13.5px] text-muted-foreground/80">
          <Trans>Can&apos;t reach the server.</Trans>
        </p>
        <div className="mt-4">
          <Button
            variant="secondary"
            className="rounded-full"
            onClick={() => {
              retryImmediately.current = true;
              setAttempt(0);
              setRetryKey((key) => key + 1);
            }}
          >
            <Trans>Retry now</Trans>
          </Button>
        </div>
      </div>
    </div>
  );
}

function ShellSkeleton() {
  return (
    <div
      className="flex h-full overflow-hidden bg-background"
      data-nova-app-state="session-pending"
    >
      <aside className="hidden w-[316px] shrink-0 border-e border-sidebar-border bg-sidebar px-3.5 pt-16 md:block">
        <Skeleton className="h-10 rounded-xl" />
        <div className="mt-5 space-y-2 px-1">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="flex items-center gap-3 rounded-xl px-2 py-2.5">
              <Skeleton className="size-9 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-2/5" />
                <Skeleton className="h-2.5 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      </aside>
      <main className="flex flex-1 flex-col">
        <div className="h-[74px] border-b border-sidebar-border" />
        <div className="flex flex-1 items-center justify-center text-[14px] text-muted-foreground">
          <Trans>Opening your Space…</Trans>
        </div>
        <div className="mx-6 mb-6 h-[54px] rounded-full border border-border bg-background" />
      </main>
    </div>
  );
}
