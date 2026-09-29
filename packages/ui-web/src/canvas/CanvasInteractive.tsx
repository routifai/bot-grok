import { useLingui } from "@lingui/react/macro";
import { ExternalLink } from "lucide-react";
import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Field, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { NativeSelect, NativeSelectOption } from "../components/ui/native-select.js";
import { Switch } from "../components/ui/switch.js";
import { cn } from "../lib/utils.js";

/**
 * Interactive canvas nodes answer back through the same channel as an `ask`/`choice`
 * block's tap today: the host page passes `onAnswer`, wired to the thread's generic
 * run-input answer call, and `disabled` tracks whether that run is still waiting on it.
 */
export type CanvasAnswer = (value: string) => Promise<void> | void;

export function CanvasChoiceButtons({
  question,
  options,
  onAnswer,
  disabled,
}: {
  question?: string;
  options: { value: string; label: string }[];
  onAnswer?: CanvasAnswer;
  disabled?: boolean;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const settled = disabled || picked !== null;

  async function pick(value: string) {
    if (settled || pending) return;
    setPending(true);
    try {
      await onAnswer?.(value);
      setPicked(value);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {question ? <p className="text-[13.5px] text-foreground/90">{question}</p> : null}
      <div className="flex flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={picked === option.value ? "default" : "outline"}
            size="sm"
            className="rounded-full"
            disabled={settled || pending}
            onClick={() => void pick(option.value)}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

type FormField =
  | { kind: "text"; name: string; label: string; placeholder?: string }
  | { kind: "select"; name: string; label: string; options: { value: string; label: string }[] }
  | { kind: "toggle"; name: string; label: string; default?: boolean };

export function CanvasForm({
  fields,
  submitLabel,
  onAnswer,
  disabled,
}: {
  fields: FormField[];
  submitLabel?: string;
  onAnswer?: CanvasAnswer;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const resolvedSubmitLabel = submitLabel || t`Submit`;
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(
      fields.map((field) => [field.name, field.kind === "toggle" ? Boolean(field.default) : ""]),
    ),
  );
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState(false);
  const settled = disabled || submitted;

  async function submit() {
    if (settled || pending) return;
    setPending(true);
    try {
      await onAnswer?.(JSON.stringify(values));
      setSubmitted(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {fields.map((field) => (
        <Field
          key={field.name}
          className={cn(
            field.kind === "toggle" ? "flex-row items-center justify-between" : undefined,
          )}
        >
          <FieldLabel htmlFor={`canvas-field-${field.name}`}>{field.label}</FieldLabel>
          {field.kind === "text" ? (
            <Input
              id={`canvas-field-${field.name}`}
              placeholder={field.placeholder}
              disabled={settled}
              value={String(values[field.name] ?? "")}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
              }
            />
          ) : null}
          {field.kind === "select" ? (
            <NativeSelect
              id={`canvas-field-${field.name}`}
              disabled={settled}
              value={String(values[field.name] ?? "")}
              onChange={(event) =>
                setValues((prev) => ({ ...prev, [field.name]: event.target.value }))
              }
            >
              <NativeSelectOption value="" disabled>
                {t`Choose…`}
              </NativeSelectOption>
              {field.options.map((option) => (
                <NativeSelectOption key={option.value} value={option.value}>
                  {option.label}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          ) : null}
          {field.kind === "toggle" ? (
            <Switch
              id={`canvas-field-${field.name}`}
              disabled={settled}
              checked={Boolean(values[field.name])}
              onCheckedChange={(checked) =>
                setValues((prev) => ({ ...prev, [field.name]: checked }))
              }
            />
          ) : null}
        </Field>
      ))}
      <Button
        type="submit"
        size="sm"
        className="self-start rounded-full"
        disabled={settled || pending}
      >
        {submitted ? t`Sent` : resolvedSubmitLabel}
      </Button>
    </form>
  );
}

export function CanvasLinkButton({ label, url }: { label: string; url: string }) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="rounded-full"
      render={<a href={url} target="_blank" rel="noreferrer noopener" />}
    >
      {label}
      <ExternalLink size={13} strokeWidth={2} aria-hidden="true" />
    </Button>
  );
}
