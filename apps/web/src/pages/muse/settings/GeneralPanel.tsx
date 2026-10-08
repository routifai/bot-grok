import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input, Switch } from "@nova/ui-web";
import { KeyRound, Link2, Mail, ShieldCheck, UserRound } from "lucide-react";
import { useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApprovalRulesSettings } from "../../../components/ApprovalRulesSettings";
import { SuccessPop } from "../../../components/ai/primitives";
import { authClient } from "../../../lib/auth";
import {
  getResponseStreamingPreference,
  setResponseStreamingPreference,
} from "../../../lib/response-streaming";
import { clearSpaceSelection } from "../../../lib/rpc";
import {
  type AppearancePreference,
  getUiAppearancePreference,
  setUiAppearance,
} from "../../../lib/ui-appearance";
import { SparkGlyph } from "../chrome/NovaGlyphs";
import { NovaTile } from "../chrome/NovaTile";
import {
  SETTINGS_ROW,
  SettingsGroup,
  SettingsLinkRow,
  SettingsRow,
  SettingsSegmented,
} from "./kit";

/** Settings > General: the account, how the app looks, and a few rarely touched controls. */
export function GeneralPanel({
  name,
  email,
  isDeploymentOwner = false,
}: {
  name: string;
  email?: string | null;
  isDeploymentOwner?: boolean;
}) {
  const { t } = useLingui();
  const navigate = useNavigate();
  const streamId = useId();
  const [appearance, setAppearance] = useState<AppearancePreference>(() =>
    getUiAppearancePreference(),
  );
  const [streamReplies, setStreamReplies] = useState(
    () => getResponseStreamingPreference() === "on",
  );
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [approvalsOpen, setApprovalsOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function logOut() {
    if (signingOut) return;
    setSigningOut(true);
    try {
      await authClient.signOut();
    } finally {
      clearSpaceSelection();
      navigate("/sign-in", { replace: true });
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup title={<Trans>Account</Trans>}>
        <SettingsRow
          icon={{ tone: "blue", glyph: <UserRound strokeWidth={2.4} /> }}
          label={<Trans>Name</Trans>}
          value={name}
        />
        {email ? (
          <SettingsRow
            icon={{ tone: "blue", glyph: <Mail strokeWidth={2.4} /> }}
            label={<Trans>Email</Trans>}
            value={email}
          />
        ) : null}
        <SettingsLinkRow
          icon={{ tone: "gray", glyph: <KeyRound strokeWidth={2.4} /> }}
          label={<Trans>Change password</Trans>}
          expanded={passwordOpen}
          onClick={() => setPasswordOpen((open) => !open)}
        />
        {passwordOpen ? (
          <ChangePassword email={email} onDone={() => setPasswordOpen(false)} />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title={<Trans>Appearance</Trans>}>
        <SettingsSegmented
          label={t`Appearance`}
          testId="ui-appearance"
          value={appearance}
          options={[
            { value: "system", label: t`System` },
            { value: "light", label: t`Light` },
            { value: "dark", label: t`Dark` },
          ]}
          onChange={(next) => {
            setAppearance(next);
            setUiAppearance(next);
          }}
        />
      </SettingsGroup>

      <SettingsGroup
        title={<Trans>Conversation</Trans>}
        footer={<Trans>Approvals choose which actions wait for your OK.</Trans>}
      >
        <label htmlFor={streamId} className={SETTINGS_ROW}>
          <span className="flex min-w-0 items-center gap-3">
            <NovaTile tone="purple" size={28}>
              <SparkGlyph />
            </NovaTile>
            <span className="min-w-0 truncate text-foreground">
              <Trans>Show replies as they're written</Trans>
            </span>
          </span>
          <Switch
            id={streamId}
            data-testid="response-streaming-toggle"
            checked={streamReplies}
            onCheckedChange={(checked) => {
              setStreamReplies(checked);
              setResponseStreamingPreference(checked ? "on" : "off");
            }}
          />
        </label>
        <SettingsLinkRow
          icon={{ tone: "orange", glyph: <ShieldCheck strokeWidth={2.4} /> }}
          label={<Trans>Approvals</Trans>}
          expanded={approvalsOpen}
          onClick={() => setApprovalsOpen((open) => !open)}
        />
        {approvalsOpen ? (
          <div className="px-4 pb-4">
            <ApprovalRulesSettings />
          </div>
        ) : null}
      </SettingsGroup>

      {isDeploymentOwner ? (
        <SettingsGroup title={<Trans>Server</Trans>}>
          <SettingsLinkRow
            icon={{ tone: "teal", glyph: <Link2 strokeWidth={2.4} /> }}
            label={<Trans>Integrations</Trans>}
            onClick={() => navigate("/integrations/setup")}
          />
        </SettingsGroup>
      ) : null}

      <SettingsGroup>
        <button
          type="button"
          disabled={signingOut}
          onClick={() => void logOut()}
          className={`${SETTINGS_ROW} nova-row-plain text-start text-destructive transition-colors hover:bg-selection disabled:opacity-60`}
        >
          {signingOut ? <Trans>Logging out…</Trans> : <Trans>Log out</Trans>}
        </button>
      </SettingsGroup>
    </div>
  );
}

function ChangePassword({ email, onDone }: { email?: string | null; onDone: () => void }) {
  const { t } = useLingui();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [pending, setPending] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (pending) return;
    if (next !== confirmation) {
      setError(t`Passwords do not match`);
      return;
    }
    setPending(true);
    setError(null);
    try {
      const result = await authClient.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: true,
      });
      if (result.error) {
        setError(result.error.message ?? t`Could not change password`);
        return;
      }
      setSaved(true);
      window.setTimeout(onDone, 1200);
    } catch {
      setError(t`Could not reach the server`);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-2.5 px-4 py-4"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <input
        type="text"
        name="username"
        autoComplete="username"
        value={email ?? ""}
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />
      <Input
        type="password"
        aria-label={t`Current password`}
        placeholder={t`Current password`}
        autoComplete="current-password"
        value={current}
        onChange={(event) => setCurrent(event.target.value)}
      />
      <Input
        type="password"
        aria-label={t`New password`}
        placeholder={t`New password`}
        autoComplete="new-password"
        minLength={8}
        value={next}
        onChange={(event) => setNext(event.target.value)}
      />
      <Input
        type="password"
        aria-label={t`Confirm password`}
        placeholder={t`Confirm password`}
        autoComplete="new-password"
        value={confirmation}
        onChange={(event) => setConfirmation(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-3 pt-1">
        <Button
          type="submit"
          className="rounded-full"
          disabled={pending || current.length < 8 || next.length < 8}
        >
          {pending ? <Trans>Changing…</Trans> : <Trans>Change password</Trans>}
        </Button>
        {saved ? <SuccessPop label={t`Password updated`} /> : null}
      </div>
    </form>
  );
}
