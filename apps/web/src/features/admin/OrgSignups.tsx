import { Trans, useLingui } from "@lingui/react/macro";
import type { PendingSignup, SignupSettings } from "@nova/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  cn,
  Textarea,
} from "@nova/ui-web";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/error-text";
import { rpc } from "../../lib/rpc";
import { SettingsGroup, SettingsSegmented } from "../../pages/muse/settings/kit";
import { MUSE_INSET_GROUP } from "../../pages/muse/ui";

type Mode = SignupSettings["mode"];

const toLines = (values: readonly string[]) => values.join("\n");
const fromLines = (text: string) =>
  text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);

/**
 * Who may join and who is waiting (deployment owner only; the server decides). Approving is the
 * first moment a person gets a space, so nothing is spent on them before it.
 */
export function OrgSignups() {
  const { t, i18n } = useLingui();
  const [settings, setSettings] = useState<SignupSettings | null>(null);
  const [pending, setPending] = useState<PendingSignup[]>([]);
  const [list, setList] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<PendingSignup | null>(null);

  const load = useCallback(async () => {
    try {
      const [loaded, waiting] = await Promise.all([rpc.signups.settings(), rpc.signups.pending()]);
      setSettings(loaded);
      setPending(waiting);
      setList(toLines(loaded.mode === "domain" ? loaded.domains : loaded.invites));
    } catch (err) {
      setError(errorText(err, t`Could not load signups.`));
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  /** "Created Oct 1 · Last active Oct 3 · 2 Muses": just enough to tell if it is the same person. */
  function evidenceLine(space: NonNullable<PendingSignup["previousSpace"]>): string {
    const day = (iso: string) =>
      new Date(iso).toLocaleDateString(i18n.locale, {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    const created = day(space.createdAt);
    const parts = [t`Created ${created}`];
    if (space.lastActive) {
      const last = day(space.lastActive);
      parts.push(t`Last active ${last}`);
    }
    const muses = space.muses;
    parts.push(t`${muses} Muses`);
    return parts.join(" · ");
  }

  async function run(key: string, action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setBusy(key);
    try {
      await action();
      await load();
    } catch (err) {
      setError(errorText(err, fallback));
    } finally {
      setBusy(null);
    }
  }

  if (!settings) {
    return error ? (
      <p role="alert" className="text-[13px] text-destructive">
        {error}
      </p>
    ) : null;
  }
  const listed = settings.mode === "invite" || settings.mode === "domain";
  const current = toLines(settings.mode === "domain" ? settings.domains : settings.invites);
  return (
    <section data-testid="org-signups" className="flex flex-col gap-6">
      <SettingsGroup>
        <SettingsSegmented<Mode>
          label={t`Who can join`}
          testId="signup-mode"
          value={settings.mode}
          options={[
            { value: "closed", label: t`Closed` },
            { value: "invite", label: t`Invite` },
            { value: "domain", label: t`Domain` },
            { value: "approval", label: t`Approval` },
            { value: "open", label: t`Open` },
          ]}
          onChange={(mode) =>
            void run("mode", () => rpc.signups.update({ mode }), t`Could not change this.`)
          }
        />
        {listed ? (
          <div className="flex flex-col gap-2 p-2">
            <Textarea
              aria-label={settings.mode === "domain" ? t`Allowed domains` : t`Invited emails`}
              data-testid="signup-list"
              value={list}
              rows={4}
              placeholder={settings.mode === "domain" ? "company.com" : "name@company.com"}
              onChange={(event) => setList(event.target.value)}
            />
            <div>
              <Button
                size="sm"
                disabled={busy === "list" || list.trim() === current}
                onClick={() =>
                  void run(
                    "list",
                    () =>
                      rpc.signups.update(
                        settings.mode === "domain"
                          ? { domains: fromLines(list) }
                          : { invites: fromLines(list) },
                      ),
                    t`Could not save this.`,
                  )
                }
              >
                <Trans>Save</Trans>
              </Button>
            </div>
          </div>
        ) : null}
      </SettingsGroup>
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <div className={cn(MUSE_INSET_GROUP, "divide-y divide-border/60")}>
        {pending.length === 0 ? (
          <p className="px-3 py-3 text-[13px] text-ink-3">
            <Trans>No one is waiting.</Trans>
          </p>
        ) : (
          <>
            {pending.some((person) => !person.emailVerified) ? (
              <p className="px-3 py-2.5 text-[12.5px] text-ink-2">
                <Trans>
                  Approve unverified emails only after confirming the person another way.
                </Trans>
              </p>
            ) : null}
            {pending.map((person) => (
              <div
                key={person.userId}
                data-testid={`signup-${person.userId}`}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-[13px] text-foreground">{person.email}</span>
                  {person.previousSpace ? (
                    <span data-testid="signup-evidence" className="text-[11.5px] text-ink-3">
                      {evidenceLine(person.previousSpace)}
                    </span>
                  ) : null}
                  <span className="flex items-center gap-2 text-[11.5px] text-ink-3">
                    <time dateTime={person.createdAt}>
                      {new Date(person.createdAt).toLocaleString(i18n.locale, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                    {person.previousSpace ? (
                      <span data-testid="signup-quarantined">
                        <Trans>Previous space kept: confirm it&apos;s the same person</Trans>
                      </span>
                    ) : null}
                    {person.emailVerified ? null : (
                      <span
                        data-testid="signup-unverified"
                        className="rounded-full bg-warning/12 px-2 py-0.5 font-medium text-warning"
                      >
                        <Trans>Email not verified</Trans>
                      </span>
                    )}
                  </span>
                </span>
                <span className="inline-flex shrink-0 items-center gap-1">
                  {person.previousSpace ? (
                    <>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy === person.userId}
                        onClick={() => setDiscarding(person)}
                      >
                        <Trans>Discard</Trans>
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === person.userId}
                        onClick={() =>
                          void run(
                            person.userId,
                            () => rpc.signups.restore({ userId: person.userId }),
                            t`Could not restore the previous space.`,
                          )
                        }
                      >
                        <Trans>Restore previous space</Trans>
                      </Button>
                    </>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy === person.userId}
                    onClick={() =>
                      void run(
                        person.userId,
                        () => rpc.signups.reject({ userId: person.userId }),
                        t`Could not reject this person.`,
                      )
                    }
                  >
                    <Trans>Reject</Trans>
                  </Button>
                  <Button
                    size="sm"
                    disabled={busy === person.userId}
                    onClick={() =>
                      void run(
                        person.userId,
                        () => rpc.signups.approve({ userId: person.userId }),
                        t`Could not approve this person.`,
                      )
                    }
                  >
                    <Trans>Approve</Trans>
                  </Button>
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      <AlertDialog
        open={discarding !== null}
        onOpenChange={(open) => {
          if (!open) setDiscarding(null);
        }}
      >
        <AlertDialogContent data-testid="discard-space-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              <Trans>Discard the previous space?</Trans>
            </AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>Its Muses, memory and Computer are removed for good.</Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = discarding;
                if (!target) return;
                setDiscarding(null);
                void run(
                  target.userId,
                  () => rpc.signups.discard({ userId: target.userId }),
                  t`Could not discard the previous space.`,
                );
              }}
            >
              <Trans>Discard</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
