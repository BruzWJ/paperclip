import { useId, useState } from "react";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { PopoverTitle, PopoverDescription } from "@/components/ui/popover";
import { createSecretCreationDraft } from "@/lib/presentation-contracts";

const SECRET_NAME_RE = /^[a-z][a-z0-9_]*$/;

export interface SecretPopoverFormProps {
  /** Popover heading / body copy differ between the two flows. */
  mode: "create" | "store";
  initialName: string;
  /** The plaintext value being stored. Editable (create) or read-only (store). */
  initialValue: string;
  /** For a same-name uniqueness hint before the server round-trips. */
  existingSecretNames?: readonly string[];
  onCancel: () => void;
  /** Resolves once the secret is created + the row is bound; rejects with a message. */
  onSubmit: (name: string, value: string) => Promise<void>;
}

/**
 * Shared anchored-popover form behind {@link CreateSecretPopover} and
 * {@link ConvertToSecretPopover}. Replaces the old `window.prompt` seal flow
 * (plan §6.5). Meant to be rendered inside a `<PopoverContent>`.
 */
export function SecretPopoverForm({
  mode,
  initialName,
  initialValue,
  existingSecretNames,
  onCancel,
  onSubmit,
}: SecretPopoverFormProps) {
  const [draft, setDraft] = useState(() =>
    createSecretCreationDraft({ name: initialName, value: initialValue }),
  );
  const [reveal, setReveal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const nameErrorId = useId();
  const valueErrorId = useId();

  const trimmedName = draft.name.trim();
  const nameError = (() => {
    if (!trimmedName) return touched ? "Name is required" : null;
    if (!SECRET_NAME_RE.test(trimmedName)) return "Use lowercase letters, digits and _";
    if (existingSecretNames?.some((existing) => existing.toLowerCase() === trimmedName)) {
      return "A secret with this name already exists";
    }
    return null;
  })();
  const valueError = draft.value.length === 0 ? (touched ? "Value is required" : null) : null;
  const canSubmit = !submitting && trimmedName.length > 0 && draft.value.length > 0 && !nameError;

  async function handleSubmit() {
    setTouched(true);
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmedName, draft.value);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Failed to create secret");
      setSubmitting(false);
    }
  }

  const ctaLabel = mode === "create" ? "Create & bind" : "Store & bind";
  const heading = mode === "create" ? "Create secret" : "Store value as secret";

  return (
    <div className="w-72 space-y-3">
      <div className="space-y-1">
        <PopoverTitle className="text-sm font-medium">{heading}</PopoverTitle>
        {mode === "store" ? (
          <PopoverDescription className="text-(length:--text-micro) text-muted-foreground">
            Moves the typed value into an encrypted company secret and binds{" "}
            <span className="font-mono">{initialName || "this variable"}</span> to it.
          </PopoverDescription>
        ) : null}
      </div>

      <LabeledFormField data-invalid={Boolean(nameError)} label="Secret name">
        <Input
          className="font-mono"
          value={draft.name}
          autoFocus
          spellCheck={false}
          placeholder="secret_name"
          aria-label="Secret name"
          aria-invalid={nameError ? true : undefined}
          aria-describedby={nameError ? nameErrorId : undefined}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
          onBlur={() => setTouched(true)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void handleSubmit();
            }
          }}
        />
        <FieldError id={nameErrorId}>{nameError}</FieldError>
      </LabeledFormField>

      <LabeledFormField data-invalid={Boolean(valueError)} label="Secret value">
        <InputGroup>
          <InputGroupInput
            className="font-mono"
            type={reveal ? "text" : "password"}
            value={draft.value}
            readOnly={mode === "store"}
            spellCheck={false}
            placeholder={mode === "create" ? "value" : undefined}
            aria-label="Secret value"
            aria-invalid={valueError ? true : undefined}
            aria-describedby={valueError ? valueErrorId : undefined}
            onChange={
              mode === "create"
                ? (event) => setDraft((current) => ({ ...current, value: event.target.value }))
                : undefined
            }
          />
          <InputGroupAddon align="inline-end">
            <InputGroupButton
              size="icon-xs"
              aria-label={reveal ? "Hide value" : "Show value"}
              onClick={() => setReveal((prev) => !prev)}
            >
              {reveal ? <EyeOff  data-icon="inline-start"/> : <Eye  data-icon="inline-start"/>}
            </InputGroupButton>
          </InputGroupAddon>
        </InputGroup>
        <FieldError id={valueErrorId}>{valueError}</FieldError>
      </LabeledFormField>

      {error ? <p className="text-(length:--text-micro) text-destructive">{error}</p> : null}

      <div className="flex items-center justify-end gap-2 pt-0.5">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {submitting ? <Loader2 className="h-3.5 w-3.5 animate-spin"  data-icon="inline-start"/> : null}
          {ctaLabel}
        </Button>
      </div>
    </div>
  );
}

/** Create a brand-new secret from the fuzzy picker's creatable item (§6.4/§6.5). */
export function CreateSecretPopover(props: Omit<SecretPopoverFormProps, "mode">) {
  return <SecretPopoverForm mode="create" {...props} />;
}

/** Store a typed Text value as a secret and bind the row (replaces "Seal", §6.5). */
export function ConvertToSecretPopover(props: Omit<SecretPopoverFormProps, "mode">) {
  return <SecretPopoverForm mode="store" {...props} />;
}
