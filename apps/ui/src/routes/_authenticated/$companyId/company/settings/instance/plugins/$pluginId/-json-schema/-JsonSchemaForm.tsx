import { JsonSchemaField } from "./-JsonSchemaFields";
import { JsonSchemaFormContent } from "./-JsonSchemaFormContent";
import type { JsonSchemaNode } from "./-JsonSchemaUtils";

export interface JsonSchemaFormProps {
  schema: JsonSchemaNode;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
  className?: string;
  advancedLabel?: string;
}

export interface JsonSchemaFormFieldProps {
  propSchema: JsonSchemaNode;
  value: unknown;
  onChange: (value: unknown) => void;
  error?: string;
  disabled?: boolean;
  label: string;
  isRequired?: boolean;
  errors: Record<string, string>;
  path: string;
}

/**
 * Renders primitive values, enums, secrets, objects, and arrays from a JSON
 * Schema while preserving nested validation paths.
 */
export function JsonSchemaForm(props: JsonSchemaFormProps) {
  return <JsonSchemaFormContent {...props} FieldComponent={JsonSchemaField} />;
}

export * from "./-JsonSchemaScalarFields";
export * from "./-JsonSchemaSecretField";
export * from "./-JsonSchemaUtils";
