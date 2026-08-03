import {
  adapterConfigSchemaFieldErrors,
  useAdapterConfigSchema,
} from "./schema-config-fields";

/**
 * Validate a draft against the adapter-owned form schema. A draft has no
 * persisted revision, run, environment target, or execution workspace, so it
 * cannot make a runtime-readiness claim.
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
