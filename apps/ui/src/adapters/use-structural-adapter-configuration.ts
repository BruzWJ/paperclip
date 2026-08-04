import {
  adapterConfigSchemaFieldErrors,
  useAdapterConfigSchema,
} from "./schema-config-fields";

/**
 * Validate a draft against the adapter-owned form schema without starting a
 * process. The separate Test Agent action may apply this configuration to a
 * disposable ACPX session, but a draft still has no persisted run, target, or
 * workspace from which to make a full execution-readiness claim.
 */
export function useStructuralAdapterConfiguration(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  enabled?: boolean;
}) {
  const enabled = input.enabled ?? true;
  const {
    schema,
    isLoading,
    error,
  } = useAdapterConfigSchema(input.adapterType, { enabled });
  const fieldErrors = adapterConfigSchemaFieldErrors(
    schema,
    input.adapterConfig,
  );
  const valid = Boolean(
    enabled &&
      !isLoading &&
      !error &&
      schema &&
      fieldErrors.length === 0,
  );

  return {
    schema,
    isLoading,
    error,
    fieldErrors,
    valid,
  };
}
