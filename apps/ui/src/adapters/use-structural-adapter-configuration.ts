import {
  adapterConfigOptionErrors,
  useAdapterConfigOptions,
} from "./acpx-config-options";

/**
 * Validate a draft against the adapter-owned form schema without starting a
 * process. The separate Test Agent action may apply this configuration to a
 * disposable local-agent session, but a draft still has no persisted run, target, or
 * workspace from which to make a full execution-readiness claim.
 */
export function useStructuralAdapterConfiguration(input: {
  adapterType: string;
  adapterConfig: Record<string, string | boolean>;
  enabled?: boolean;
}) {
  const enabled = input.enabled ?? true;
  const {
    configOptions,
    isLoading,
    error,
  } = useAdapterConfigOptions(input.adapterType, { enabled });
  const fieldErrors = adapterConfigOptionErrors(
    configOptions,
    input.adapterConfig,
  );
  const valid = Boolean(
    enabled &&
      !isLoading &&
      !error &&
      configOptions &&
      fieldErrors.length === 0,
  );

  return {
    configOptions,
    isLoading,
    error,
    fieldErrors,
    valid,
  };
}
