import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  agentAdapterConfigurationTestResultSchema,
  type AgentAdapterConfigurationTestFailureReason,
  type AgentAdapterConfigurationTestResult,
} from "@paperclipai/shared";
import {
  AcpxRuntimeReadinessCapabilityError,
  AcpxRuntimeReadinessCleanupError,
  probeAcpxRuntimeReadiness,
  type AcpxRuntimeReadinessProbeInput,
  type AcpxRuntimeReadinessProbeResult,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  resolveRegisteredAdapterRuntimeConfiguration,
  type ResolvedRegisteredAdapterRuntimeConfiguration,
} from "./agent-adapter-config-revisions.js";

export interface AdapterConfigurationDraftTestInput {
  readonly adapterType: string;
  readonly adapterConfig: Record<string, unknown>;
}

export interface AdapterConfigurationDraftTestService {
  test(
    input: AdapterConfigurationDraftTestInput,
  ): Promise<AgentAdapterConfigurationTestResult>;
}

export interface AdapterConfigurationDraftTestDependencies {
  /** Test seam; production reuses the exact resolver used before persistence. */
  readonly resolveRegisteredAdapterRuntimeConfiguration?: (
    input: AdapterConfigurationDraftTestInput,
  ) => Promise<ResolvedRegisteredAdapterRuntimeConfiguration>;
  /** Test seam; production opens a no-prompt disposable ACPX session. */
  readonly probeAcpxRuntimeReadiness?: (
    input: AcpxRuntimeReadinessProbeInput,
  ) => Promise<AcpxRuntimeReadinessProbeResult>;
  /** Test seams paired around the provider session's execution workspace. */
  readonly createTemporarySessionCwd?: () => Promise<string>;
  readonly removeTemporarySessionCwd?: (cwd: string) => Promise<void>;
  readonly serviceCwd?: string;
  readonly now?: () => Date;
}

function testedAt(now: () => Date): string {
  return now().toISOString();
}

async function createDefaultTemporarySessionCwd(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "paperclip-acpx-draft-test-"));
}

async function removeDefaultTemporarySessionCwd(cwd: string): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
}

function failedResult(input: {
  readonly adapterType: string;
  readonly reason: AgentAdapterConfigurationTestFailureReason;
  readonly message: string;
  readonly now: () => Date;
}): AgentAdapterConfigurationTestResult {
  return agentAdapterConfigurationTestResultSchema.parse({
    status: "failed",
    adapterType: input.adapterType,
    reason: input.reason,
    message: input.message,
    testedAt: testedAt(input.now),
  });
}

/**
 * Tests an unsaved adapter/session configuration through ACPX without making
 * an agent, run, workspace, revision, or provider prompt. This observation is
 * intentionally narrower than persisted run readiness: it proves only that
 * the configured local ACPX agent initializes and accepts its generic session
 * selections in the Paperclip service environment.
 */
export function createAdapterConfigurationDraftTestService(
  dependencies: AdapterConfigurationDraftTestDependencies = {},
): AdapterConfigurationDraftTestService {
  const resolveConfiguration =
    dependencies.resolveRegisteredAdapterRuntimeConfiguration ??
    resolveRegisteredAdapterRuntimeConfiguration;
  const probe =
    dependencies.probeAcpxRuntimeReadiness ?? probeAcpxRuntimeReadiness;
  const createTemporarySessionCwd =
    dependencies.createTemporarySessionCwd ??
    createDefaultTemporarySessionCwd;
  const removeTemporarySessionCwd =
    dependencies.removeTemporarySessionCwd ??
    removeDefaultTemporarySessionCwd;
  const serviceCwd = dependencies.serviceCwd ?? process.cwd();
  const now = dependencies.now ?? (() => new Date());

  return {
    async test(input) {
      const resolved = await resolveConfiguration(input);
      const acpConfiguration = resolved.acpConfiguration;
      let sessionCwd: string;

      try {
        sessionCwd = await createTemporarySessionCwd();
      } catch {
        return failedResult({
          adapterType: input.adapterType,
          reason: "acp_initialization_failed",
          message:
            "Paperclip could not prepare an execution workspace for the local agent test.",
          now,
        });
      }

      let result: AgentAdapterConfigurationTestResult;

      try {
        const observation = await probe({
          cwd: sessionCwd,
          registryCwd: serviceCwd,
          agentName: acpConfiguration.launchProfile.registryName,
          configSelections:
            acpConfiguration.sessionConfigSelections,
          requireBackendSessionDiscard: true,
        });
        result = agentAdapterConfigurationTestResultSchema.parse({
          status: "ready",
          adapterType: input.adapterType,
          runtimeControls: [...observation.capabilities.controls],
          testedAt: testedAt(now),
        });
      } catch (error) {
        if (error instanceof AcpxRuntimeReadinessCleanupError) {
          result = failedResult({
            adapterType: input.adapterType,
            reason: "acp_cleanup_failed",
            message:
              "Paperclip could not verify cleanup of the disposable test session.",
            now,
          });
        } else if (error instanceof AcpxRuntimeReadinessCapabilityError) {
          result = failedResult({
            adapterType: input.adapterType,
            reason: "acp_capability_incompatible",
            message:
              "The local agent runtime does not expose the controls required by this configuration.",
            now,
          });
        } else {
          result = failedResult({
            adapterType: input.adapterType,
            reason: "acp_initialization_failed",
            message:
              "Paperclip could not initialize the local agent with this configuration.",
            now,
          });
        }
      }

      try {
        await removeTemporarySessionCwd(sessionCwd);
      } catch {
        return failedResult({
          adapterType: input.adapterType,
          reason: "acp_cleanup_failed",
          message:
            "Paperclip could not remove the isolated local agent test workspace.",
          now,
        });
      }
      return result;
    },
  };
}
