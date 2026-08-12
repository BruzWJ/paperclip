import type { AdapterModel } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactNonEmptyString(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new Error(`${label} must be an exact non-empty string`);
  }
  return value;
}

/** Validate one exact value for the adapter's stable ACP model option. */
export function validateAdapterModel(value: unknown): AdapterModel {
  if (!isRecord(value)) {
    throw new Error("Adapter model must be an object");
  }
  const allowed = new Set(["value", "label"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Adapter model contains unknown field ${unknown}`);
  }
  return {
    value: exactNonEmptyString(
      value.value,
      "Adapter model value",
    ),
    label: exactNonEmptyString(value.label, "Adapter model label"),
  };
}

export function requireAdapterModel(input: {
  adapterType: string;
  selection: unknown;
  models: readonly AdapterModel[];
}): AdapterModel {
  const selection = exactNonEmptyString(
    input.selection,
    `Adapter ${input.adapterType} model selection`,
  );
  const matches = input.models.filter((model) => model.value === selection);
  if (matches.length !== 1) {
    throw new Error(
      `Adapter ${input.adapterType} model selection is not one exact advertised value`,
    );
  }
  return validateAdapterModel(matches[0]);
}
