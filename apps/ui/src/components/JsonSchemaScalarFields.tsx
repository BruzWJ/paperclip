import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { LabeledFormField } from "@/components/patterns/FormPatterns";
import React, { useId } from "react";
import { schemaFieldId } from "./JsonSchemaUtils";

const TEXTAREA_THRESHOLD = 200;

/**
 * Specialized field for boolean (checkbox) values.
 */
export const BooleanField = React.memo(
  ({
    id,
    value,
    onChange,
    disabled,
    label,
    isRequired,
    description,
    error,
  }: {
    id: string;
    value: unknown;
    onChange: (val: unknown) => void;
    disabled: boolean;
    label: string;
    isRequired?: boolean;
    description?: string;
    error?: string;
  }) => (
    <Field orientation="horizontal" data-disabled={disabled || undefined}>
      <Checkbox id={id} checked={!!value} onCheckedChange={onChange} disabled={disabled} />
      <FieldContent>
        {label && (
          <FieldLabel htmlFor={id}>
            {label}
            {isRequired ? <span aria-hidden="true">*</span> : null}
          </FieldLabel>
        )}
        <FieldDescription>{description}</FieldDescription>
        <FieldError>{error}</FieldError>
      </FieldContent>
    </Field>
  ),
);

/**
 * Sentinel value for the "not configured" row of an optional enum select.
 * Radix `Select` forbids an empty-string item value, so we map the unset state
 * onto this sentinel and translate it back to `undefined` on change.
 */
const ENUM_UNSET_VALUE = "__paperclip_unset__";

/**
 * Specialized field for enum (select) values.
 */
export const EnumField = React.memo(
  ({
    value,
    onChange,
    disabled,
    label,
    isRequired,
    description,
    error,
    options,
  }: {
    value: unknown;
    onChange: (val: unknown) => void;
    disabled: boolean;
    label: string;
    isRequired?: boolean;
    description?: string;
    error?: string;
    options: unknown[];
  }) => {
    // Optional enums get a leading blank row so the user can express "not
    // configured"; it is also the selected row when no value is set.
    const showUnsetOption = !isRequired;
    // When every option is numeric, coerce the selected string back to a number
    // so the payload keeps the schema's integer/number type — a stringified "2"
    // would otherwise fail server-side integer validation.
    const numericOptions = options.length > 0 && options.every((option) => typeof option === "number");

    const isUnset = value === undefined || value === null || value === "";
    const selectValue = isUnset ? (showUnsetOption ? ENUM_UNSET_VALUE : "") : String(value);

    const handleChange = (next: string) => {
      if (next === ENUM_UNSET_VALUE) {
        onChange(undefined);
        return;
      }
      onChange(numericOptions ? Number(next) : next);
    };

    return (
      <LabeledFormField
        data-disabled={disabled || undefined}
        label={label || undefined}
        requiredIndicator={isRequired}
        description={description}
        error={error}
      >
        <Select value={selectValue} onValueChange={handleChange} disabled={disabled}>
          <SelectTrigger className="w-full" aria-label={label}>
            <SelectValue placeholder="Select an option" />
          </SelectTrigger>
          <SelectContent>
            {showUnsetOption && (
              <SelectItem value={ENUM_UNSET_VALUE} textValue="None">
                <span className="text-muted-foreground">None</span>
              </SelectItem>
            )}
            {options.map((option) => (
              <SelectItem key={String(option)} value={String(option)}>
                {String(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </LabeledFormField>
    );
  },
);

/**
 * Specialized field for numeric (number/integer) values.
 */
export const NumberField = React.memo(
  ({
    id,
    value,
    onChange,
    disabled,
    label,
    isRequired,
    description,
    error,
    defaultValue,
    type,
    minimum,
    maximum,
    suggestions,
  }: {
    id: string;
    value: unknown;
    onChange: (val: unknown) => void;
    disabled: boolean;
    label: string;
    isRequired?: boolean;
    description?: string;
    error?: string;
    defaultValue?: unknown;
    type: "number" | "integer";
    minimum?: number;
    maximum?: number;
    suggestions?: unknown[];
  }) => {
    const errorId = useId();
    const fieldId = schemaFieldId(id);
    const hasSuggestions = Array.isArray(suggestions) && suggestions.length > 0;
    // Sanitize the path-based id so it is a valid CSS/HTML identifier (paths can contain "/").
    const listId = hasSuggestions ? `${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-suggestions` : undefined;
    return (
      <LabeledFormField
        data-disabled={disabled || undefined}
        label={label || undefined}
        labelFor={fieldId}
        requiredIndicator={isRequired}
        description={description}
        error={error}
        errorId={errorId}
      >
        <Input
          id={fieldId}
          type="number"
          step={type === "integer" ? "1" : "any"}
          min={minimum}
          max={maximum}
          list={listId}
          value={value !== undefined ? String(value) : ""}
          onChange={(e) => {
            const val = e.target.value;
            const trimmed = val.trim();
            onChange(trimmed === "" ? undefined : Number(trimmed));
          }}
          placeholder={String(defaultValue ?? "")}
          disabled={disabled}
          aria-label={label}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
        />
        {listId ? (
          <datalist id={listId}>
            {suggestions!.map((suggestion) => (
              <option key={String(suggestion)} value={String(suggestion)} />
            ))}
          </datalist>
        ) : null}
      </LabeledFormField>
    );
  },
);

/**
 * Specialized field for string values, rendering either an Input or Textarea based on length or format.
 */
export const StringField = React.memo(
  ({
    id,
    value,
    onChange,
    disabled,
    label,
    isRequired,
    description,
    error,
    defaultValue,
    format,
    maxLength,
  }: {
    id: string;
    value: unknown;
    onChange: (val: unknown) => void;
    disabled: boolean;
    label: string;
    isRequired?: boolean;
    description?: string;
    error?: string;
    defaultValue?: unknown;
    format?: string;
    maxLength?: number;
  }) => {
    const errorId = useId();
    const fieldId = schemaFieldId(id);
    const isTextArea = format === "textarea" || (maxLength && maxLength > TEXTAREA_THRESHOLD);
    return (
      <LabeledFormField
        data-disabled={disabled || undefined}
        label={label || undefined}
        labelFor={fieldId}
        requiredIndicator={isRequired}
        description={description}
        error={error}
        errorId={errorId}
      >
        {isTextArea ? (
          <Textarea
            id={fieldId}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            placeholder={String(defaultValue ?? "")}
            disabled={disabled}
            className="min-h-(--sz-100px)"
            aria-label={label}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
          />
        ) : (
          <Input
            id={fieldId}
            type="text"
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
            placeholder={String(defaultValue ?? "")}
            disabled={disabled}
            aria-label={label}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
          />
        )}
      </LabeledFormField>
    );
  },
);
