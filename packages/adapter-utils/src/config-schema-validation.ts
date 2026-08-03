import type {
  AdapterConfigSchema,
  ConfigFieldSchema,
} from "./types.js";

const CONFIG_FIELD_TYPES = new Set<ConfigFieldSchema["type"]>([
  "text",
  "select",
  "toggle",
  "number",
  "textarea",
  "combobox",
]);

type JsonRecord = Record<string, unknown>;

export type AdapterConfigSchemaValidationResult =
  | {
      success: true;
      data: AdapterConfigSchema;
    }
  | {
      success: false;
      errors: string[];
    };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateDefaultValue(
  field: JsonRecord,
  fieldName: string,
  errors: string[],
): void {
  if (field.default === undefined) return;

  switch (field.type) {
    case "text":
    case "textarea":
    case "select":
    case "combobox":
      if (typeof field.default !== "string") {
        errors.push(`${fieldName} default must be a string.`);
      }
      break;
    case "toggle":
      if (typeof field.default !== "boolean") {
        errors.push(`${fieldName} default must be a boolean.`);
      }
      break;
    case "number":
      if (
        typeof field.default !== "number"
        || !Number.isFinite(field.default)
      ) {
        errors.push(`${fieldName} default must be a finite number.`);
      }
      break;
  }
}

function validateVisibleWhen(
  field: JsonRecord,
  fieldName: string,
  fieldKeys: Set<string>,
  errors: string[],
): void {
  if (field.meta === undefined) return;
  if (!isRecord(field.meta)) {
    errors.push(`${fieldName} meta must be an object.`);
    return;
  }
  const visibleWhen = field.meta.visibleWhen;
  if (visibleWhen === undefined) return;
  if (!isRecord(visibleWhen)) {
    errors.push(`${fieldName} meta.visibleWhen must be an object.`);
    return;
  }
  if (!nonEmptyString(visibleWhen.key)) {
    errors.push(
      `${fieldName} meta.visibleWhen.key must be a non-empty string.`,
    );
  } else if (!fieldKeys.has(visibleWhen.key)) {
    errors.push(
      `${fieldName} meta.visibleWhen references unknown field "${visibleWhen.key}".`,
    );
  }

  const conditions = [
    visibleWhen.value !== undefined,
    visibleWhen.values !== undefined,
    visibleWhen.notValues !== undefined,
  ].filter(Boolean).length;
  if (conditions !== 1) {
    errors.push(
      `${fieldName} meta.visibleWhen must declare exactly one of value, values, or notValues.`,
    );
    return;
  }
  if (
    visibleWhen.value !== undefined
    && typeof visibleWhen.value !== "string"
  ) {
    errors.push(`${fieldName} meta.visibleWhen.value must be a string.`);
  }
  for (const key of ["values", "notValues"] as const) {
    const value = visibleWhen[key];
    if (
      value !== undefined
      && (
        !Array.isArray(value)
        || value.length === 0
        || value.some((entry) => typeof entry !== "string")
      )
    ) {
      errors.push(
        `${fieldName} meta.visibleWhen.${key} must be a non-empty string array.`,
      );
    }
  }
}

/**
 * Validate the complete adapter-owned declarative configuration schema.
 *
 * Both server and UI consume this function so malformed server-admitted ACP
 * adapter schemas fail closed at the same boundary instead of being interpreted
 * differently by each surface.
 */
export function validateAdapterConfigSchema(
  value: unknown,
): AdapterConfigSchemaValidationResult {
  if (!isRecord(value) || !Array.isArray(value.fields)) {
    return {
      success: false,
      errors: ["Adapter configuration schema must contain a fields array."],
    };
  }

  const errors: string[] = [];
  const fieldKeys = new Set<string>();
  for (const [index, entry] of value.fields.entries()) {
    const fieldName = `Configuration field at index ${index}`;
    if (!isRecord(entry)) {
      errors.push(`${fieldName} must be an object.`);
      continue;
    }
    if (!nonEmptyString(entry.key)) {
      errors.push(`${fieldName} key must be a non-empty string.`);
    } else if (fieldKeys.has(entry.key)) {
      errors.push(`Configuration field key "${entry.key}" is duplicated.`);
    } else {
      fieldKeys.add(entry.key);
    }
  }

  for (const [index, entry] of value.fields.entries()) {
    const fieldName = nonEmptyString((entry as JsonRecord | null)?.key)
      ? `Configuration field "${(entry as JsonRecord).key}"`
      : `Configuration field at index ${index}`;
    if (!isRecord(entry)) continue;

    if (!nonEmptyString(entry.label)) {
      errors.push(`${fieldName} label must be a non-empty string.`);
    }
    if (
      typeof entry.type !== "string"
      || !CONFIG_FIELD_TYPES.has(entry.type as ConfigFieldSchema["type"])
    ) {
      errors.push(`${fieldName} has an unsupported type.`);
    }
    if (
      entry.required !== undefined
      && typeof entry.required !== "boolean"
    ) {
      errors.push(`${fieldName} required must be a boolean.`);
    }
    for (const key of ["hint", "group"] as const) {
      if (entry[key] !== undefined && typeof entry[key] !== "string") {
        errors.push(`${fieldName} ${key} must be a string.`);
      }
    }

    if (entry.options !== undefined) {
      if (!Array.isArray(entry.options)) {
        errors.push(`${fieldName} options must be an array.`);
      } else {
        const optionValues = new Set<string>();
        for (const [optionIndex, option] of entry.options.entries()) {
          const optionName = `${fieldName} option at index ${optionIndex}`;
          if (!isRecord(option)) {
            errors.push(`${optionName} must be an object.`);
            continue;
          }
          if (!nonEmptyString(option.label)) {
            errors.push(`${optionName} label must be a non-empty string.`);
          }
          if (!nonEmptyString(option.value)) {
            errors.push(`${optionName} value must be a non-empty string.`);
          } else if (optionValues.has(option.value)) {
            errors.push(
              `${fieldName} option value "${option.value}" is duplicated.`,
            );
          } else {
            optionValues.add(option.value);
          }
          if (
            option.group !== undefined
            && typeof option.group !== "string"
          ) {
            errors.push(`${optionName} group must be a string.`);
          }
        }
        if (
          entry.type === "select"
          && typeof entry.default === "string"
          && !optionValues.has(entry.default)
        ) {
          errors.push(
            `${fieldName} default must select one of its declared options.`,
          );
        }
      }
    }

    validateDefaultValue(entry, fieldName, errors);
    validateVisibleWhen(entry, fieldName, fieldKeys, errors);
  }

  return errors.length === 0
    ? {
        success: true,
        data: value as unknown as AdapterConfigSchema,
      }
    : { success: false, errors };
}
