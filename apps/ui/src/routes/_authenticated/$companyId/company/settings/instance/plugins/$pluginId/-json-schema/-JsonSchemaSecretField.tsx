import { Button } from "@/components/ui/button";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Eye, EyeOff } from "lucide-react";
import React, { useCallback, useEffect, useId, useState } from "react";
import { isSecretRefBinding } from "./-JsonSchemaUtils";
import {
  SecretBindingPicker,
  type SecretBindingValue,
} from "@/features/secrets/pickers/SecretBindingPicker";

const TEXTAREA_THRESHOLD = 200;

/**
 * Specialized field for secret-ref values. Renders a picker for existing
 * company secrets plus explicit raw-value entry. Bound secrets use only the
 * structured `secret_ref` contract; plain strings are always new raw values.
 */
export const SecretField = React.memo(
  ({
    value,
    onChange,
    disabled,
    label,
    isRequired,
    description,
    error,
    defaultValue,
    maxLength,
  }: {
    value: unknown;
    onChange: (val: unknown) => void;
    disabled: boolean;
    label: string;
    isRequired?: boolean;
    description?: string;
    error?: string;
    defaultValue?: unknown;
    maxLength?: number;
  }) => {
    const [isVisible, setIsVisible] = useState(false);
    const errorId = useId();
    const isTextArea = maxLength != null && maxLength > TEXTAREA_THRESHOLD;

    const secretRefValue = isSecretRefBinding(value) ? value : null;
    const stringValue = typeof value === "string" ? value : "";
    const isBoundToSecret = secretRefValue !== null;
    const hasRawValue = stringValue.length > 0 && !isBoundToSecret;

    const [showRawInput, setShowRawInput] = useState(hasRawValue);

    // Keep the raw-input panel open when the parent loads a raw value after
    // mount (e.g. an environment-config form rendering with empty defaults
    // before its API response arrives). We only promote to `true` here; manual
    // toggles off are still preserved as long as `hasRawValue` is false.
    useEffect(() => {
      if (hasRawValue) setShowRawInput(true);
    }, [hasRawValue]);

    const bindingValue: SecretBindingValue | null = secretRefValue
      ? { secretId: secretRefValue.secretId, version: secretRefValue.version }
      : null;

    const handlePickerChange = useCallback(
      (next: SecretBindingValue | null) => {
        if (next) {
          onChange({
            type: "secret_ref",
            secretId: next.secretId,
            version: next.version ?? "latest",
          });
          setShowRawInput(false);
          setIsVisible(false);
        } else {
          onChange("");
        }
      },
      [onChange],
    );
    const visibilityButton = (
      <InputGroupButton
        size="icon-sm"
        onClick={() => setIsVisible(!isVisible)}
        disabled={disabled}
        aria-label={isVisible ? "Hide secret" : "Show secret"}
      >
        {isVisible ? <EyeOff /> : <Eye />}
      </InputGroupButton>
    );

    const rawInput = isTextArea ? (
      <InputGroup>
        {isVisible ? (
          <InputGroupTextarea
            value={stringValue}
            onChange={(e) => onChange(e.target.value)}
            placeholder={String(defaultValue ?? "")}
            aria-label={label ? `Raw value for ${label}` : "Raw secret value"}
            disabled={disabled}
            className="min-h-(--sz-140px) font-mono text-xs"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
          />
        ) : (
          <InputGroupTextarea
            // Render a placeholder summary instead of the secret content while
            // hidden. This avoids exposing multi-line secrets (e.g. SSH
            // private keys) on screen-shares; clicking the eye toggle reveals
            // the editable textarea above.
            value={
              stringValue.length === 0
                ? ""
                : `Sensitive — ${stringValue.length} characters hidden. Click the eye to reveal.`
            }
            readOnly
            placeholder={String(defaultValue ?? "")}
            aria-label={label ? `Raw value for ${label}` : "Raw secret value"}
            disabled={disabled}
            className="min-h-(--sz-140px) font-mono text-xs italic text-muted-foreground"
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
          />
        )}
        <InputGroupAddon align="inline-end" className="self-start">
          {visibilityButton}
        </InputGroupAddon>
      </InputGroup>
    ) : (
      <InputGroup>
        <InputGroupInput
          type={isVisible ? "text" : "password"}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          placeholder={String(defaultValue ?? "")}
          aria-label={label ? `Raw value for ${label}` : "Raw secret value"}
          disabled={disabled}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
        />
        <InputGroupAddon align="inline-end">{visibilityButton}</InputGroupAddon>
      </InputGroup>
    );

    return (
      <LabeledFormField
        data-disabled={disabled || undefined}
        label={label || undefined}
        requiredIndicator={isRequired}
        description={
          description ||
          "Pick an existing company secret, or paste a raw value (Paperclip will store it as a secret on save)."
        }
        error={error}
        errorId={errorId}
      >
        <div className="space-y-2">
          <SecretBindingPicker
            value={bindingValue}
            onChange={handlePickerChange}
            label=""
            placeholder="Select an existing secret"
            allowVersionSelector={false}
            emptyHint="No active secrets yet. Create one or paste a raw value below."
            disabled={disabled}
          />
          {!isBoundToSecret ? (
            showRawInput ? (
              <div className="space-y-1">
                {rawInput}
                {!hasRawValue ? (
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    onClick={() => {
                      setShowRawInput(false);
                      setIsVisible(false);
                    }}
                    disabled={disabled}
                  >
                    Hide raw value input
                  </Button>
                ) : null}
              </div>
            ) : (
              <Button
                type="button"
                variant="link"
                size="xs"
                onClick={() => setShowRawInput(true)}
                disabled={disabled}
              >
                Or paste a raw value
              </Button>
            )
          ) : null}
        </div>
      </LabeledFormField>
    );
  },
);
