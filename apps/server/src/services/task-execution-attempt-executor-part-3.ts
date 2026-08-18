import {
  createPaperclipRunToolsMcpServer,
  executeAcpxOneShotPrompt,
  prepareAcpxRuntimeInvocation,
  type AcpxOneShotPromptResult,
} from "@paperclipai/adapter-utils/acpx-runtime";

import { RUN_TOOLS_STDIO_PROXY_SOURCE } from "@paperclipai/adapter-utils/run-tools-stdio-proxy";

import type { NativeCorrelationService } from "./native-correlation.js";

import type {
  AcquiredTaskExecutionTarget,
  TaskExecutionTargetAcquirer,
} from "./task-execution-provider-configuration.js";

import type { PluginBeforePromptDispatcher } from "./plugin-before-prompt-dispatcher.js";

import { publishLiveEvent } from "./live-events.js";

import { logger } from "../middleware/logger.js";
import * as executorCore from "./task-execution-attempt-executor-part-1.js";
import * as executorRun from "./task-execution-attempt-executor-part-2.js";

export function createTaskExecutionAttemptExecutor(options: {
  readonly repository: executorCore.TaskExecutionPromptCycleRepository;
  readonly beforePrompt: PluginBeforePromptDispatcher;
  readonly targetAcquirer: TaskExecutionTargetAcquirer;
  readonly sessionCorrelations: Pick<NativeCorrelationService, "resolveResume" | "protectSession">;
  readonly events: executorCore.TaskExecutionAcpEventSink;
}): executorCore.TaskExecutionAttemptExecutor {
  async function composeWorkPrompt(prompt: executorCore.ResolvedTaskExecutionPrompt): Promise<string> {
    return options.beforePrompt.dispatch({
      companyId: prompt.identity.companyId,
      taskId: prompt.identity.taskId,
      sessionId: prompt.identity.sessionId,
      runId: prompt.identity.runId,
      agentId: prompt.identity.targetAgentId,
      sourceText: prompt.sourceText,
      promptKind: prompt.identity.promptKind,
      sessionOperation: prompt.sessionOperation,
      refId: prompt.identity.refId,
      refOrdinal: prompt.identity.refOrdinal,
      segmentOrdinal: prompt.identity.segmentOrdinal,
      sourceMessageId: prompt.sourceMessageId,
      sourceMessageSeq: prompt.sourceMessageSeq,
      contextAccess: prompt.contextAccess,
    });
  }

  async function runCycle(input: {
    readonly prompt: executorCore.ResolvedTaskExecutionPrompt;
    readonly target: AcquiredTaskExecutionTarget;
    readonly start:
      | { readonly kind: "new" }
      | {
          readonly kind: "resume";
          readonly sessionId: string;
        };
    readonly message: string;
    readonly signal: AbortSignal;
  }): Promise<executorCore.TaskExecutionPromptClosureDecision> {
    const capability = await options.repository.mintPendingCapability(input.prompt);
    executorRun.exactCapability(capability);
    const capabilityIdentity: executorCore.TaskExecutionPromptCapabilityIdentity = Object.freeze({
      capabilityConnectionId: capability.capabilityConnectionId,
      capabilityGeneration: capability.capabilityGeneration,
    });
    let activatedSessionId: string | null = null;
    const redactRuntimeText = executorRun.createRuntimeRedactor({
      targetRedactor: input.target.redactor.redactText,
      capability,
      resumeSessionId: input.start.kind === "resume" ? input.start.sessionId : null,
      activatedSessionId: () => activatedSessionId,
    });
    let prepared: Awaited<ReturnType<typeof prepareAcpxRuntimeInvocation>> | null = null;
    let promptTransmissionRecorded = false;
    let result: AcpxOneShotPromptResult;
    try {
      if (input.target.targetAdditionalDirectories.length > 0) {
        throw new executorCore.TaskExecutionAttemptRejected(
          "ACPX public runtime does not support Paperclip-managed additional directories",
        );
      }
      prepared = await prepareAcpxRuntimeInvocation({
        target: input.target.executionTarget,
        targetCwd: input.target.targetCwd,
        invocationFiles: [
          {
            fileName: executorCore.RUN_TOOLS_PROXY_FILE,
            contents: RUN_TOOLS_STDIO_PROXY_SOURCE,
          },
          {
            fileName: executorCore.RUN_TOOLS_SECRET_FILE,
            contents: executorRun.runToolsSecret(capability),
          },
        ],
      });
      const proxyEntrypoint = prepared.invocationFilePaths[executorCore.RUN_TOOLS_PROXY_FILE];
      const secretFile = prepared.invocationFilePaths[executorCore.RUN_TOOLS_SECRET_FILE];
      if (!proxyEntrypoint || !secretFile) {
        throw new executorCore.TaskExecutionAttemptRejected(
          "execution target omitted request-scoped run-tools files",
        );
      }
      result = await executeAcpxOneShotPrompt({
        cwd: prepared.targetCwd,
        registryCwd: process.cwd(),
        agentName: input.prompt.acpConfiguration.launchProfile.registryName,
        start: input.start,
        message: input.message,
        configSelections: input.prompt.acpConfiguration.sessionConfigSelections,
        // Board approval gates are already settled for this exact execution.
        permissionMode: "approve-all",
        nonInteractivePermissions: "fail",
        mcpServers: Object.freeze([
          createPaperclipRunToolsMcpServer({
            nodeExecutable: prepared.targetNodeExecutable,
            proxyEntrypoint,
            secretFile,
          }),
        ]),
        timeoutMs: executorCore.ACPX_TURN_TIMEOUT_MS,
        signal: input.signal,
        async activatePrompt({ sessionId }) {
          activatedSessionId = sessionId;
          const protectedCorrelation = await options.sessionCorrelations.protectSession({
            sessionId,
            scope: input.prompt.activationCorrelationScope,
          });
          await options.repository.activatePrompt({
            prompt: input.prompt,
            capability: capabilityIdentity,
            correlation: protectedCorrelation,
          });
        },
        beginPromptTransmission: () =>
          options.repository
            .beginPromptTransmission({
              prompt: input.prompt,
              capability: capabilityIdentity,
            })
            .then(() => {
              promptTransmissionRecorded = true;
            }),
        async onSessionEvent(event) {
          try {
            const projection = await options.events.publish({
              prompt: input.prompt.identity,
              capability: capabilityIdentity,
              redactor: input.target.redactor,
              event,
            });
            publishLiveEvent({
              companyId: input.prompt.identity.companyId,
              type: "run.stream",
              payload: projection,
            });
          } catch (error) {
            logger.error(
              {
                err: error,
                runId: input.prompt.identity.runId,
                refId: input.prompt.identity.refId,
                attemptId: input.prompt.identity.attemptId,
                eventKind: event.kind,
              },
              "task-execution ACP event projection failed",
            );
            throw error;
          }
        },
      });
    } catch (cause) {
      result = {
        kind: "error",
        phase: promptTransmissionRecorded ? "prompt" : "session_setup",
        promptTransmitted: promptTransmissionRecorded,
        cause,
      };
    }
    if (result.kind === "error") {
      result = {
        ...result,
        cause: executorRun.redactAcpxRuntimeError(result.cause, redactRuntimeText),
      };
    }
    if (prepared) {
      try {
        await prepared.cleanup();
      } catch (cause) {
        const cleanupFailure = executorRun.redactAcpxRuntimeError(cause, redactRuntimeText);
        const priorFailure = result.kind === "error" ? result.cause : null;
        const promptTransmitted =
          promptTransmissionRecorded || result.kind !== "error" || result.promptTransmitted;
        result = {
          kind: "error",
          phase: promptTransmitted ? "prompt" : "session_setup",
          promptTransmitted,
          cause:
            priorFailure === null
              ? cleanupFailure
              : new AggregateError(
                  [priorFailure, cleanupFailure],
                  "ACPX execution and request-file cleanup both failed",
                ),
        };
      }
    }
    try {
      return await options.repository.closePrompt({
        prompt: input.prompt,
        capability: capabilityIdentity,
        outcome: executorRun.canonicalClosure(result),
      });
    } catch (closureError) {
      throw new AggregateError(
        result.kind === "error" ? [result.cause, closureError] : [closureError],
        "canonical prompt closure did not commit",
      );
    }
  }

  return {
    async execute(lease, signal, settle) {
      const prompt = await options.repository.resolve(lease);
      executorRun.validateLeaseResolution(lease, prompt);
      executorRun.validatePrompt(prompt);
      await options.repository.renewPromptAuthority(prompt);

      const executionController = new AbortController();
      const renewalStopController = new AbortController();
      const propagateCancellation = () => {
        if (!executionController.signal.aborted) {
          executionController.abort(signal.reason);
        }
      };
      if (signal.aborted) propagateCancellation();
      else signal.addEventListener("abort", propagateCancellation, { once: true });

      let renewalFailure: unknown;
      let renewalFailed = false;
      let renewalAuthorityLoss: executorCore.TaskExecutionPromptAuthorityLost | null = null;
      let renewalStopped = false;
      const renewalLoop = (async () => {
        while (
          await executorRun.waitForLeaseRenewalInterval(
            prompt.leaseRenewalIntervalMs,
            renewalStopController.signal,
          )
        ) {
          try {
            await options.repository.renewPromptAuthority(prompt);
          } catch (error) {
            renewalFailed = true;
            renewalFailure = error;
            if (error instanceof executorCore.TaskExecutionPromptAuthorityLost) {
              renewalAuthorityLoss = error;
            }
            if (!executionController.signal.aborted) {
              executionController.abort(error);
            }
            return;
          }
        }
      })();

      const stopRenewal = async (renewForSettlement: boolean) => {
        if (!renewalStopped) {
          renewalStopped = true;
          renewalStopController.abort();
          await renewalLoop;
        }
        if (renewForSettlement) {
          try {
            await options.repository.renewPromptAuthority(prompt);
          } catch (error) {
            renewalFailed = true;
            renewalFailure = error;
            if (error instanceof executorCore.TaskExecutionPromptAuthorityLost) {
              renewalAuthorityLoss = error;
            }
            throw error;
          }
          // A successfully closed prompt plus this fresh exact DB fence is the
          // canonical proof that a transient periodic-renewal failure did not
          // lose authority. The provider was still aborted immediately; only
          // its already-durable closure decision may now settle.
          renewalFailed = false;
          renewalFailure = undefined;
          renewalAuthorityLoss = null;
          return;
        }
        if (renewalFailed) throw renewalFailure;
      };

      let operationFailed = false;
      let operationFailure: unknown;
      let dispatchResult: executorCore.TaskExecutionDispatchResult | null = null;
      try {
        let outboundMessage = prompt.sourceText;
        if (!executionController.signal.aborted) {
          outboundMessage = await composeWorkPrompt(prompt);
        }
        if (renewalFailed) throw renewalFailure;
        const target = await options.targetAcquirer.acquire(prompt.target);
        executorRun.assertTargetMatchesPrompt(prompt, target);
        let targetFailed = true;
        let targetReleased = false;
        const releaseTarget = async (): Promise<void> => {
          if (targetReleased) return;
          targetReleased = true;
          await target.release(targetFailed);
        };
        try {
          if (renewalFailed) throw renewalFailure;
          let start: { readonly kind: "new" } | { readonly kind: "resume"; readonly sessionId: string };
          if (prompt.sessionOperation === "new") {
            start = { kind: "new" };
          } else {
            const resolvedStart = await options.sessionCorrelations.resolveResume({
              promptKind: prompt.identity.promptKind,
              carryContext: prompt.carryContext,
              bootstrapHandoff: prompt.bootstrapPredecessor !== null,
              stored: prompt.storedCorrelation,
            });
            start = resolvedStart.start;
          }
          if (renewalFailed) throw renewalFailure;

          const decision = await runCycle({
            prompt,
            target,
            start,
            message: outboundMessage,
            signal: executionController.signal,
          });
          const failed =
            (decision.result.kind === "terminal" && decision.result.outcome === "failed") ||
            decision.result.kind === "retry";
          await stopRenewal(true);
          targetFailed = failed;
          // ACPX has closed and its disposable state is gone; release the
          // Paperclip execution target before settling the durable run.
          await releaseTarget();
          await settle(decision.result);
          dispatchResult = decision.result;
        } finally {
          await releaseTarget();
        }
      } catch (error) {
        operationFailed = true;
        operationFailure = error;
      } finally {
        await stopRenewal(false).catch((error) => {
          if (!renewalFailed) {
            renewalFailed = true;
            renewalFailure = error;
          }
        });
        signal.removeEventListener("abort", propagateCancellation);
      }
      const authorityLoss =
        renewalAuthorityLoss ??
        (operationFailed ? executorRun.findPromptAuthorityLoss(operationFailure) : null);
      if (authorityLoss) {
        const failures = [operationFailed ? operationFailure : null, renewalFailure].filter(
          (failure, index, values) =>
            failure !== null && failure !== undefined && values.indexOf(failure) === index,
        );
        const cause =
          failures.length > 1
            ? new AggregateError(failures, "prompt authority loss coincided with execution cleanup failure")
            : (failures[0] ?? authorityLoss.cause);
        throw new executorCore.TaskExecutionPromptAuthorityLost(lease, cause);
      }
      if (renewalFailed) {
        if (operationFailed && operationFailure !== renewalFailure) {
          throw new AggregateError(
            [operationFailure, renewalFailure],
            "prompt renewal and execution cleanup both failed",
          );
        }
        throw renewalFailure;
      }
      if (operationFailed) throw operationFailure;
      if (dispatchResult === null) {
        throw new executorCore.TaskExecutionAttemptRejected(
          "task execution attempt returned no canonical dispatch result",
        );
      }
      return dispatchResult;
    },
  };
}
