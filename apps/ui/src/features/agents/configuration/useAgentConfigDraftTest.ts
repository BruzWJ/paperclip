import type { AgentAdapterConfigurationTestResult } from "@paperclipai/shared";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { adapterConfigOptionErrors } from "@/adapters/acpx-config-options";
import { adaptersApi } from "@/api/adapters";
import { publicRuntimeMessage } from "@/lib/public-runtime-message";

type AdapterConfigOptions = Parameters<typeof adapterConfigOptionErrors>[0];

type UseAgentConfigDraftTestOptions = {
  adapterConfig: Record<string, string | boolean> | null;
  adapterType: string;
  catalogConfigOptions: AdapterConfigOptions | null;
  companyId: string | null;
  contextId: string;
  draftError: string | null;
  hasAdapter: boolean;
  isSavePending: boolean;
};

export function useAgentConfigDraftTest({
  adapterConfig,
  adapterType,
  catalogConfigOptions,
  companyId,
  contextId,
  draftError,
  hasAdapter,
  isSavePending,
}: UseAgentConfigDraftTestOptions) {
  const fingerprint = useMemo(
    () =>
      adapterConfig === null ? null : JSON.stringify([companyId, contextId, adapterType, adapterConfig]),
    [adapterConfig, adapterType, companyId, contextId],
  );
  const contextToken = useMemo(
    () => Object.freeze({ fingerprint }),
    [catalogConfigOptions, fingerprint, hasAdapter],
  );
  const currentContextToken = useRef(contextToken);
  currentContextToken.current = contextToken;
  const [feedback, setFeedback] = useState<{
    contextToken: object;
    result: AgentAdapterConfigurationTestResult | null;
    error: string | null;
  } | null>(null);

  useEffect(() => {
    setFeedback(null);
  }, [contextToken]);

  const mutation = useMutation({
    mutationFn: async (input: {
      companyId: string;
      adapterType: string;
      adapterConfig: Record<string, string | boolean>;
      contextToken: object;
    }) =>
      adaptersApi.testConfiguration(input.companyId, input.adapterType, {
        adapterConfig: input.adapterConfig,
      }),
    onSuccess: (result, input) => {
      if (currentContextToken.current !== input.contextToken) return;
      setFeedback({ contextToken: input.contextToken, result, error: null });
    },
    onError: (error, input) => {
      if (currentContextToken.current !== input.contextToken) return;
      setFeedback({
        contextToken: input.contextToken,
        result: null,
        error:
          error instanceof Error
            ? publicRuntimeMessage(error.message, "Agent configuration test failed.")
            : "Agent configuration test failed.",
      });
    },
  });

  const visibleFeedback = feedback?.contextToken === contextToken ? feedback : null;
  const fieldErrors = useMemo(
    () =>
      catalogConfigOptions && adapterConfig
        ? adapterConfigOptionErrors(catalogConfigOptions, adapterConfig)
        : [],
    [adapterConfig, catalogConfigOptions],
  );
  const validationError =
    fieldErrors.length > 0
      ? `Complete the required ACPX settings before testing: ${fieldErrors.map(({ message }) => message).join(" ")}`
      : null;
  const result = visibleFeedback?.result ?? null;
  const message =
    draftError ??
    validationError ??
    visibleFeedback?.error ??
    (result?.status === "failed"
      ? publicRuntimeMessage(result.message)
      : result?.status === "ready"
        ? "The local agent accepted this exact draft configuration."
        : null);
  const messageIsError = Boolean(
    draftError || validationError || visibleFeedback?.error || result?.status === "failed",
  );
  const disabled =
    !companyId ||
    !hasAdapter ||
    adapterConfig === null ||
    fieldErrors.length > 0 ||
    fingerprint === null ||
    mutation.isPending ||
    isSavePending;

  const test = () => {
    if (disabled || !companyId || adapterConfig === null || !fingerprint) return;
    setFeedback(null);
    mutation.mutate({
      companyId,
      adapterType,
      adapterConfig,
      contextToken,
    });
  };

  return {
    disabled,
    isTesting: mutation.isPending,
    message,
    messageIsError,
    test,
  };
}
