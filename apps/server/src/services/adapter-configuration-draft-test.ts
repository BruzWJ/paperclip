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
} from "@paperclipai/adapter-utils/acpx-runtime";
import {
  resolveRegisteredAdapterRuntimeConfiguration,
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

function testedAt(): string {
  return new Date().toISOString();
}

async function createTemporarySessionCwd(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "paperclip-acpx-draft-test-"));
}

async function removeTemporarySessionCwd(cwd: string): Promise<void> {
  await rm(cwd, { recursive: true, force: true });
}

function failedResult(input: {
  readonly adapterType: string;
  readonly reason: AgentAdapterConfigurationTestFailureReason;
  readonly message: string;
}): AgentAdapterConfigurationTestResult {
  return agentAdapterConfigurationTestResultSchema.parse({
    status: "failed",
    adapterType: input.adapterType,
    reason: input.reason,
    message: input.message,
    testedAt: testedAt(),
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
): AdapterConfigurationDraftTestService {
  return {
    async test(input) {
      const resolved =
        await resolveRegisteredAdapterRuntimeConfiguration(input);
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
        });
      }

      let result: AgentAdapterConfigurationTestResult;

      try {
        const observation = await probeAcpxRuntimeReadiness({
          cwd: sessionCwd,
          registryCwd: process.cwd(),
          agentName: acpConfiguration.launchProfile.registryName,
          configSelections:
            acpConfiguration.sessionConfigSelections,
        });
        result = agentAdapterConfigurationTestResultSchema.parse({
          status: "ready",
          adapterType: input.adapterType,
          runtimeControls: [...observation.capabilities.controls],
          testedAt: testedAt(),
        });
      } catch (error) {
        if (error instanceof AcpxRuntimeReadinessCleanupError) {
          result = failedResult({
            adapterType: input.adapterType,
            reason: "acp_cleanup_failed",
            message:
              "Paperclip could not verify cleanup of the disposable test session.",
          });
        } else if (error instanceof AcpxRuntimeReadinessCapabilityError) {
          result = failedResult({
            adapterType: input.adapterType,
            reason: "acp_capability_incompatible",
            message:
              "The local agent runtime does not expose the controls required by this configuration.",
          });
        } else {
          result = failedResult({
            adapterType: input.adapterType,
            reason: "acp_initialization_failed",
            message:
              "Paperclip could not initialize the local agent with this configuration.",
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
        });
      }
      return result;
    },
  };
}
