import { z } from "zod";

export const ADAPTER_RUNTIME_READINESS_INCOMPLETE_REASONS = [
  "run_not_preflightable",
  "agent_revision_not_current",
  "adapter_revision_invalid",
  "workspace_unavailable",
  "execution_target_unavailable",
  "target_native_executable_unavailable",
  "native_authentication_required",
  "native_authentication_check_failed",
  "acp_frontend_unavailable",
  "acp_initialization_failed",
  "acp_capability_incompatible",
  "target_cleanup_failed",
] as const;

export type AdapterRuntimeReadinessIncompleteReason =
  (typeof ADAPTER_RUNTIME_READINESS_INCOMPLETE_REASONS)[number];

export const adapterRuntimeReadinessScopeSchema = z
  .object({
    runId: z.string().uuid(),
    agentId: z.string().uuid(),
    adapterConfigRevisionId: z.string().uuid(),
  })
  .strict();

export type AdapterRuntimeReadinessScope = z.infer<
  typeof adapterRuntimeReadinessScopeSchema
>;

const adapterRuntimeReadinessReadySchema = z
  .object({
    status: z.literal("ready"),
    scope: adapterRuntimeReadinessScopeSchema,
    /** Exact public ACPX controls observed in this readiness probe. */
    runtimeControls: z.array(z.string().min(1)),
  })
  .strict();

const adapterRuntimeReadinessIncompleteSchema = z
  .object({
    status: z.literal("incomplete"),
    scope: adapterRuntimeReadinessScopeSchema,
    reason: z.enum(ADAPTER_RUNTIME_READINESS_INCOMPLETE_REASONS),
    remediationCommand: z.string().min(1).nullable(),
  })
  .strict();

export const adapterRuntimeReadinessSchema = z.discriminatedUnion("status", [
  adapterRuntimeReadinessReadySchema,
  adapterRuntimeReadinessIncompleteSchema,
]);

export type AdapterRuntimeReadiness = z.infer<
  typeof adapterRuntimeReadinessSchema
>;
