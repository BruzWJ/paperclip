import type { AdapterModel, AdapterModelLimits } from "./types.js";

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

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Number(value);
}

/** Validate immutable token limits without inventing a missing input limit. */
export function validateAdapterModelLimits(value: unknown): AdapterModelLimits {
  if (!isRecord(value)) {
    throw new Error("Adapter model limits must be an object");
  }
  const allowed = new Set([
    "contextTokenLimit",
    "inputTokenLimit",
    "outputTokenLimit",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Adapter model limits contain unknown field ${unknown}`);
  }
  const limits: AdapterModelLimits = {
    contextTokenLimit: positiveInteger(
      value.contextTokenLimit,
      "Adapter model limits.contextTokenLimit",
    ),
    ...(value.inputTokenLimit === undefined
      ? {}
      : {
          inputTokenLimit: positiveInteger(
            value.inputTokenLimit,
            "Adapter model limits.inputTokenLimit",
          ),
        }),
    outputTokenLimit: positiveInteger(
      value.outputTokenLimit,
      "Adapter model limits.outputTokenLimit",
    ),
  };
  if (limits.outputTokenLimit > limits.contextTokenLimit) {
    throw new Error(
      "Adapter model outputTokenLimit cannot exceed contextTokenLimit",
    );
  }
  if (
    limits.inputTokenLimit !== undefined &&
    limits.inputTokenLimit > limits.contextTokenLimit
  ) {
    throw new Error(
      "Adapter model inputTokenLimit cannot exceed contextTokenLimit",
    );
  }
  return limits;
}

/** Validate one exact value for the adapter's stable ACP model option. */
export function validateAdapterModel(value: unknown): AdapterModel {
  if (!isRecord(value)) {
    throw new Error("Adapter model catalog entry must be an object");
  }
  const allowed = new Set(["id", "label", "value", "limits"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`Adapter model catalog entry contains unknown field ${unknown}`);
  }
  return {
    id: exactNonEmptyString(value.id, "Adapter model catalog entry id"),
    label: exactNonEmptyString(
      value.label,
      "Adapter model catalog entry label",
    ),
    value: exactNonEmptyString(
      value.value,
      "Adapter model catalog entry value",
    ),
    limits: validateAdapterModelLimits(value.limits),
  };
}

export function requireAdapterCatalogModel(input: {
  adapterType: string;
  selection: unknown;
  models: readonly AdapterModel[];
}): AdapterModel {
  const selection = exactNonEmptyString(
    input.selection,
    `Adapter ${input.adapterType} model selection`,
  );
  const matches = input.models.filter((model) => model.id === selection);
  if (matches.length !== 1) {
    throw new Error(
      `Adapter ${input.adapterType} model selection is not an exact catalog entry`,
    );
  }
  return validateAdapterModel(matches[0]);
}

export function sameAdapterModel(
  left: AdapterModel,
  right: AdapterModel,
): boolean {
  return (
    left.id === right.id &&
    left.label === right.label &&
    left.value === right.value &&
    left.limits.contextTokenLimit === right.limits.contextTokenLimit &&
    left.limits.inputTokenLimit === right.limits.inputTokenLimit &&
    left.limits.outputTokenLimit === right.limits.outputTokenLimit
  );
}
