import { Button, Spinner } from "@aiden/ui-web";
import { Trans, useLingui } from "@lingui/react/macro";
import { useState } from "react";

/**
 * "Restore" on an archived Side Chat or Fork: brings it back as an open chat. The caller does
 * the restore (and what follows it); this owns the busy and failed states.
 */
export function RestoreButton({
  onRestore,
  className,
}: {
  onRestore: () => Promise<unknown>;
  className?: string;
}) {
  const { t } = useLingui();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className={className}
        disabled={busy}
        aria-busy={busy || undefined}
        onClick={(event) => {
          event.stopPropagation();
          setBusy(true);
          setFailed(false);
          onRestore()
            .catch(() => setFailed(true))
            .finally(() => setBusy(false));
        }}
      >
        {busy ? <Spinner className="size-3.5" /> : null}
        <Trans>Restore</Trans>
      </Button>
      {failed ? (
        <span role="alert" className="text-[12.5px] text-muted-foreground">
          {t`Something went wrong.`}
        </span>
      ) : null}
    </>
  );
}
