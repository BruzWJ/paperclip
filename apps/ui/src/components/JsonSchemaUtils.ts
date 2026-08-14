import type { EnvSecretRefBinding } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Subset of JSON Schema properties we understand for form rendering.
 * We intentionally keep this loose (`Record<string, unknown>`) at the top
 * level to match the `JsonSchema` type in shared, but narrow internally.
 */
export interface JsonSchemaNode {
  type?: string | string[];
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  examples?: unknown[];
  const?: unknown;
  format?: string;

  // String constraints
  minLength?: number;
  maxLength?: number;
  pattern?: string;

  // Number constraints
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;

  // Object
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: boolean | JsonSchemaNode;

  // Array
  items?: JsonSchemaNode;
  minItems?: number;
  maxItems?: number;

  // Metadata
  readOnly?: boolean;
  writeOnly?: boolean;

  // Paperclip extensions
  /**
   * When true, the field is hidden behind an "Advanced options" disclosure
   * in the top-level `JsonSchemaForm`. Defaults to false (essential).
   */
  "x-paperclip-advanced"?: boolean;
  /**
   * Optional sub-section name used to group advanced fields under headings
   * inside the disclosure (e.g. "SSH access", "VM resources"). Ignored when
   * `x-paperclip-advanced` is not true.
   */
  "x-paperclip-group"?: string;

  // Allow extra keys
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the primary type string from a schema node. */
export function resolveType(schema: JsonSchemaNode): string {
  if (schema.enum) return "enum";
  if (schema.const !== undefined) return "const";
  if (schema.format === "secret-ref") return "secret-ref";
  if (Array.isArray(schema.type)) {
    // Use the first non-null type
    return schema.type.find((t) => t !== "null") ?? "string";
  }
  return schema.type ?? "string";
}

/** Human-readable label from schema title or property key. */
export function labelFromKey(key: string, schema: JsonSchemaNode): string {
  if (schema.title) return schema.title;
  // Convert camelCase / snake_case to Title Case
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Stable, HTML-safe identifier for a field path in a rendered schema. */
export function schemaFieldId(path: string): string {
  return `schema-field-${path.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/**
 * Produce a sensible default value for a schema node.
 *
 * Optional scalar fields (string, number, integer, secret-ref) without an
 * explicit `default` return `undefined` so they stay out of the submitted
 * payload — otherwise an empty field would round-trip as `""` or `0` and
 * trip server-side "X must be greater than 0 when provided" style validators.
 */
export function getDefaultForSchema(schema: JsonSchemaNode): unknown {
  if (schema.default !== undefined) return schema.default;

  const type = resolveType(schema);
  switch (type) {
    case "string":
    case "secret-ref":
    case "number":
    case "integer":
      return undefined;
    case "boolean":
      return false;
    case "enum":
      return undefined;
    case "array":
      return [];
    case "object": {
      if (!schema.properties) return {};
      const obj: Record<string, unknown> = {};
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        const def = getDefaultForSchema(propSchema);
        if (def !== undefined) obj[key] = def;
      }
      return obj;
    }
    default:
      return undefined;
  }
}

/** Validate a single field value against schema constraints. Returns error string or null. */
export function validateField(value: unknown, schema: JsonSchemaNode, isRequired: boolean): string | null {
  const type = resolveType(schema);

  // Required check
  if (isRequired && (value === undefined || value === null || value === "")) {
    return "This field is required";
  }

  // Skip further validation if empty and not required
  if (value === undefined || value === null || value === "") return null;

  if (type === "secret-ref" && isSecretRefBinding(value)) {
    return null;
  }
  if (type === "secret-ref" && typeof value === "object") {
    return "Invalid secret reference";
  }

  if (type === "string" || type === "secret-ref") {
    const str = String(value);
    if (schema.minLength != null && str.length < schema.minLength) {
      return `Must be at least ${schema.minLength} characters`;
    }
    if (schema.maxLength != null && str.length > schema.maxLength) {
      return `Must be at most ${schema.maxLength} characters`;
    }
    if (schema.pattern) {
      // Guard against ReDoS: reject overly complex patterns from plugin JSON Schemas.
      // Limit pattern length and run the regex with a defensive try/catch.
      const MAX_PATTERN_LENGTH = 512;
      if (schema.pattern.length <= MAX_PATTERN_LENGTH) {
        try {
          const re = new RegExp(schema.pattern);
          if (!re.test(str)) {
            return `Must match pattern: ${schema.pattern}`;
          }
        } catch {
          // Invalid regex in schema — skip
        }
      }
    }
  }

  if (type === "number" || type === "integer") {
    const num = Number(value);
    if (isNaN(num)) return "Must be a valid number";
    if (schema.minimum != null && num < schema.minimum) {
      return `Must be at least ${schema.minimum}`;
    }
    if (schema.maximum != null && num > schema.maximum) {
      return `Must be at most ${schema.maximum}`;
    }
    if (schema.exclusiveMinimum != null && num <= schema.exclusiveMinimum) {
      return `Must be greater than ${schema.exclusiveMinimum}`;
    }
    if (schema.exclusiveMaximum != null && num >= schema.exclusiveMaximum) {
      return `Must be less than ${schema.exclusiveMaximum}`;
    }
    if (type === "integer" && !Number.isInteger(num)) {
      return "Must be a whole number";
    }
    if (schema.multipleOf != null && num % schema.multipleOf !== 0) {
      return `Must be a multiple of ${schema.multipleOf}`;
    }
  }

  if (type === "array") {
    const arr = value as unknown[];
    if (schema.minItems != null && arr.length < schema.minItems) {
      return `Must have at least ${schema.minItems} items`;
    }
    if (schema.maxItems != null && arr.length > schema.maxItems) {
      return `Must have at most ${schema.maxItems} items`;
    }
  }

  return null;
}

/** Public API for validation */
export function validateJsonSchemaForm(
  schema: JsonSchemaNode,
  values: Record<string, unknown>,
  path: string[] = [],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const properties = schema.properties ?? {};
  const requiredFields = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(properties)) {
    const fieldPath = [...path, key];
    const errorKey = `/${fieldPath.join("/")}`;
    const value = values[key];
    const isRequired = requiredFields.has(key);
    const type = resolveType(propSchema);

    // Per-field validation
    const fieldErr = validateField(value, propSchema, isRequired);
    if (fieldErr) {
      errors[errorKey] = fieldErr;
    }

    // Recurse into objects
    if (type === "object" && propSchema.properties && typeof value === "object" && value !== null) {
      Object.assign(errors, validateJsonSchemaForm(propSchema, value as Record<string, unknown>, fieldPath));
    }

    // Recurse into arrays
    if (type === "array" && propSchema.items && Array.isArray(value)) {
      const itemSchema = propSchema.items as JsonSchemaNode;
      const isObjectItem = resolveType(itemSchema) === "object";

      value.forEach((item, index) => {
        const itemPath = [...fieldPath, String(index)];
        const itemErrorKey = `/${itemPath.join("/")}`;

        if (isObjectItem) {
          Object.assign(
            errors,
            validateJsonSchemaForm(itemSchema, item as Record<string, unknown>, itemPath),
          );
        } else {
          const itemErr = validateField(item, itemSchema, false);
          if (itemErr) {
            errors[itemErrorKey] = itemErr;
          }
        }
      });
    }
  }

  return errors;
}

/** Public API for default values */
export function getDefaultValues(schema: JsonSchemaNode): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const properties = schema.properties ?? {};

  for (const [key, propSchema] of Object.entries(properties)) {
    const def = getDefaultForSchema(propSchema);
    if (def !== undefined) {
      result[key] = def;
    }
  }

  return result;
}

export function isSecretRefBinding(value: unknown): value is EnvSecretRefBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}
