export function parseOptionalBooleanEnvironmentValue(
  rawValue: string | undefined,
  key: string,
): boolean | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue === "true") return true;
  if (rawValue === "false") return false;
  throw new Error(`${key} must be exactly "true" or "false"`);
}

export function parseOptionalEnumEnvironmentValue<const Value extends string>(
  rawValue: string | undefined,
  key: string,
  allowedValues: readonly Value[],
): Value | undefined {
  if (rawValue === undefined) return undefined;
  if (allowedValues.includes(rawValue as Value)) return rawValue as Value;
  throw new Error(`${key} must be exactly one of: ${allowedValues.join(", ")}`);
}

export function parseOptionalIntegerEnvironmentValue(
  rawValue: string | undefined,
  key: string,
  options: { min: number; max?: number },
): number | undefined {
  if (rawValue === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/.test(rawValue)) {
    throw new Error(
      `${key} must be an exact integer with no whitespace or leading zeros`,
    );
  }
  const value = Number(rawValue);
  if (
    !Number.isSafeInteger(value) ||
    value < options.min ||
    (options.max !== undefined && value > options.max)
  ) {
    const range =
      options.max === undefined
        ? `at least ${options.min}`
        : `from ${options.min} through ${options.max}`;
    throw new Error(`${key} must be ${range}`);
  }
  return value;
}

export function parseOptionalExactNonEmptyEnvironmentValue(
  rawValue: string | undefined,
  key: string,
): string | undefined {
  if (rawValue === undefined) return undefined;
  if (rawValue.length === 0 || rawValue.trim() !== rawValue) {
    throw new Error(
      `${key} must be non-empty and contain no surrounding whitespace`,
    );
  }
  return rawValue;
}
