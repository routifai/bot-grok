import { Trans, useLingui } from "@lingui/react/macro";
import type { EngineAdminUser } from "@nova/contracts";
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
} from "@nova/ui-web";
import { useCallback, useEffect, useState } from "react";
import { errorText } from "../../lib/error-text";
import { rpc } from "../../lib/rpc";
import { MUSE_INSET_GROUP } from "../../pages/muse/ui";
import { formatEngineDate, formatUsd, MODEL_PROVIDERS } from "../models";

const CELL = "whitespace-nowrap px-3 py-2.5 text-[13px] tabular-nums";
const HEAD = "whitespace-nowrap px-3 py-2 text-start text-[11.5px] font-medium text-ink-3";

export function personName(user: Pick<EngineAdminUser, "email" | "id">): string {
  return user.email ?? user.id;
}

function StatusPill({ status }: { status: EngineAdminUser["status"] }) {
  return (
    <span
      data-testid="user-status"
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11.5px] font-medium",
        status === "active" ? "bg-success/12 text-success" : "bg-destructive/12 text-destructive",
      )}
    >
      {status === "active" ? <Trans>Active</Trans> : <Trans>Paused</Trans>}
    </span>
  );
}

/**
 * The organization's people: who is using what. Pausing stops their model use; deleting removes
 * the person and what they own, so it names them and asks first. The engine refuses the
 * dangerous cases (your own account, the last admin), and its message shows here.
 */
export function OrgUsers({ selfEmail }: { selfEmail?: string | null }) {
  const { t, i18n } = useLingui();
  const locale = i18n.locale;
  const [users, setUsers] = useState<EngineAdminUser[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<EngineAdminUser | null>(null);

  const load = useCallback(async () => {
    try {
      setUsers(await rpc.engineAdmin.users());
    } catch (err) {
      setError(errorText(err, t`Could not load people.`));
      setUsers([]);
    }
  }, [t]);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(user: EngineAdminUser, action: () => Promise<unknown>, fallback: string) {
    setError(null);
    setBusy(user.id);
    try {
      await action();
      await load();
      return true;
    } catch (err) {
      setError(errorText(err, fallback));
      return false;
    } finally {
      setBusy(null);
    }
  }

  if (!users) return null;
  const who = confirming ? personName(confirming) : "";
  const labelOf = (id: string) => MODEL_PROVIDERS.find((p) => p.id === id)?.label ?? id;
  const isSelf = (user: EngineAdminUser) =>
    Boolean(selfEmail) && user.email?.toLowerCase() === selfEmail?.toLowerCase();

  return (
    <section data-testid="org-users">
      <div className={cn(MUSE_INSET_GROUP, "rk-scroll overflow-x-auto")}>
        <table className="w-full min-w-[820px] border-collapse">
          <thead>
            <tr className="border-b border-border/70">
              <th className={HEAD}>
                <Trans>Person</Trans>
              </th>
              <th className={HEAD}>
                <Trans>Status</Trans>
              </th>
              <th className={cn(HEAD, "text-end")}>
                <Trans>This month</Trans>
              </th>
              <th className={cn(HEAD, "text-end")}>
                <Trans>Today</Trans>
              </th>
              <th className={cn(HEAD, "text-end")}>
                <Trans>Chats</Trans>
              </th>
              <th className={HEAD}>
                <Trans>Keys</Trans>
              </th>
              <th className={cn(HEAD, "text-end")}>
                <Trans>Budget</Trans>
              </th>
              <th className={HEAD}>
                <Trans>Computer</Trans>
              </th>
              <th className={HEAD}>
                <Trans>Last active</Trans>
              </th>
              <th className={HEAD}>
                <span className="sr-only">
                  <Trans>Actions</Trans>
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => {
              const self = isSelf(user);
              return (
                <tr
                  key={user.id}
                  data-testid={`org-user-${user.id}`}
                  className="border-b border-border/50 last:border-b-0"
                >
                  <td className={cn(CELL, "max-w-[220px] truncate text-foreground")}>
                    {personName(user)}
                    {user.isAdmin ? <span className="ms-1.5 text-ink-3">· {t`Admin`}</span> : null}
                  </td>
                  <td className={CELL}>
                    <StatusPill status={user.status} />
                  </td>
                  <td className={cn(CELL, "text-end")}>{formatUsd(user.spendMonthUsd, locale)}</td>
                  <td className={cn(CELL, "text-end")}>{formatUsd(user.spendTodayUsd, locale)}</td>
                  <td className={cn(CELL, "text-end")}>{user.sessionCount}</td>
                  <td className={cn(CELL, "text-ink-2")}>
                    {user.providers.length ? user.providers.map(labelOf).join(", ") : "—"}
                  </td>
                  <td className={cn(CELL, "text-end")}>
                    {user.budget.monthlyLimitUsd === null
                      ? "—"
                      : formatUsd(user.budget.monthlyLimitUsd, locale)}
                  </td>
                  <td className={cn(CELL, "text-ink-2")}>
                    {user.computer === "online"
                      ? t`Online`
                      : user.computer === "offline"
                        ? t`Offline`
                        : "—"}
                  </td>
                  <td className={cn(CELL, "text-ink-2")}>
                    {formatEngineDate(user.lastActive, locale) || "—"}
                  </td>
                  <td className={cn(CELL, "text-end")}>
                    <span className="inline-flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={self || busy === user.id}
                        onClick={() =>
                          void run(
                            user,
                            () =>
                              rpc.engineAdmin.setSuspended({
                                userId: user.id,
                                suspended: user.status === "active",
                              }),
                            t`Could not change this account.`,
                          )
                        }
                      >
                        {user.status === "active" ? <Trans>Suspend</Trans> : <Trans>Resume</Trans>}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        disabled={self || busy === user.id}
                        onClick={() => setConfirming(user)}
                      >
                        <Trans>Delete</Trans>
                      </Button>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {error ? (
        <p role="alert" className="px-1.5 pt-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <AlertDialogContent data-testid="delete-user-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>{t`Delete ${who}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              <Trans>
                Their chats, Computer and keys are removed for good. This can't be undone.
              </Trans>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              <Trans>Cancel</Trans>
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={confirming !== null && busy === confirming.id}
              onClick={() => {
                const target = confirming;
                if (!target) return;
                setConfirming(null);
                void run(
                  target,
                  () => rpc.engineAdmin.deleteUser({ userId: target.id }),
                  t`Could not delete this account.`,
                );
              }}
            >
              <Trans>Delete</Trans>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
