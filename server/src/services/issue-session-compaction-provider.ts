import {
  agentAdapterConfigRevisions,
  issueExecutionWorkspaceBindings,
  type Db,
} from "@paperclipai/db";
import {
  type AdapterModel,
  type ServerAdapterModule,
} from "@paperclipai/adapter-utils";
import {
  ACP_SUBPROCESS_CONTRACT_VERSION,
  executeAcpSubprocessPrompt,
  noAcpMcpServers,
  prepareAcpExecutionTargetSubprocess,
  resolveApprovedAcpLaunch,
  sameApprovedAcpLaunch,
  type AcpPromptClosureOutcome,
  type AcpPromptExecutionResult,
  type AcpSubprocessLaunch,
  type NormalizedAcpSessionEvent,
} from "@paperclipai/adapter-utils/acp-subprocess";
import {
  agentAdapterAcpConfigurationSchema,
  type AdapterImplementationIdentity,
  type AgentAdapterAcpConfiguration,
} from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import {
  SessionCompactionConflict,
  SessionCompactionProviderFailure,
  persistedSessionCompactionModelSchema,
  type SessionCompactionModelResolver,
  type SessionCompactionPromptLifecycle,
  type SessionCompactionSummaryResult,
  type SessionCompactionSummarizer,
  type PersistedSessionCompactionModel,
} from "./issue-session-compaction-contract.js";
import {
  createIssueExecutionTargetAcquirer,
  type IssueExecutionRuntimeRedactor,
  type IssueExecutionTargetAcquirer,
} from "./issue-execution-provider-configuration.js";
import type {
  EnvironmentRunOrchestrator,
} from "./environment-run-orchestrator.js";
import {
  createCompanyModelCatalog,
  type CompanyModelCatalog,
} from "./company-model-catalog.js";

type Revision = typeof agentAdapterConfigRevisions.$inferSelect;
type Binding = typeof issueExecutionWorkspaceBindings.$inferSelect;
type ExecutePrompt = typeof executeAcpSubprocessPrompt;
type PrepareTarget = typeof prepareAcpExecutionTargetSubprocess;

interface LoadedCompactionExecutionConfiguration {
  readonly revision: Revision;
  readonly binding: Binding;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
}

function exactNonempty(value: string, label: string): string {
  if (value.length === 0 || value !== value.trim()) {
    throw new SessionCompactionConflict(`${label} must be exact and non-empty`);
  }
  return value;
}

async function loadExactExecutionConfiguration(
  db: Db,
  input: {
    companyId: string;
    issueId: string;
    sessionId?: string;
    agentId: string;
    ownershipEpoch: number;
    adapterConfigRevisionId: string;
    executionWorkspaceBindingId: string;
  },
): Promise<LoadedCompactionExecutionConfiguration> {
  const [revision, binding] = await Promise.all([
    db
      .select()
      .from(agentAdapterConfigRevisions)
      .where(
        and(
          eq(agentAdapterConfigRevisions.id, input.adapterConfigRevisionId),
          eq(agentAdapterConfigRevisions.companyId, input.companyId),
          eq(agentAdapterConfigRevisions.agentId, input.agentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    db
      .select()
      .from(issueExecutionWorkspaceBindings)
      .where(
        and(
          eq(
            issueExecutionWorkspaceBindings.id,
            input.executionWorkspaceBindingId,
          ),
          eq(issueExecutionWorkspaceBindings.companyId, input.companyId),
          eq(issueExecutionWorkspaceBindings.issueId, input.issueId),
          ...(input.sessionId === undefined
            ? []
            : [
                eq(
                  issueExecutionWorkspaceBindings.sessionId,
                  input.sessionId,
                ),
              ]),
          eq(
            issueExecutionWorkspaceBindings.ownershipEpoch,
            input.ownershipEpoch,
          ),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  if (!revision || !binding) {
    throw new SessionCompactionConflict(
      "Compaction lost its immutable adapter revision or workspace binding",
    );
  }
  let acpConfiguration: AgentAdapterAcpConfiguration;
  try {
    acpConfiguration = agentAdapterAcpConfigurationSchema.parse(
      revision.acpConfiguration,
    );
  } catch {
    throw new SessionCompactionConflict(
      "Compaction adapter revision has no canonical ACP configuration",
    );
  }
  if (
    acpConfiguration.executionTargetSelector.defaultEnvironmentId !==
      revision.defaultEnvironmentId ||
    acpConfiguration.executionTargetSelector.executionTargetDriver !==
      revision.executionTargetDriver ||
    acpConfiguration.executionTargetSelector.executionTargetDigest !==
      revision.executionTargetDigest
  ) {
    throw new SessionCompactionConflict(
      "Compaction adapter revision changed its immutable execution target",
    );
  }
  return { revision, binding, acpConfiguration };
}

function persistedCatalogModel(
  modelRef: string,
  model: AdapterModel,
): PersistedSessionCompactionModel {
  return persistedSessionCompactionModelSchema.parse({
    modelRef,
    targetModelId: model.id,
    targetModelValue: model.value,
    contextTokenLimit: model.limits.contextTokenLimit,
    ...(model.limits.inputTokenLimit === undefined
      ? {}
      : { inputTokenLimit: model.limits.inputTokenLimit }),
    outputTokenLimit: model.limits.outputTokenLimit,
  });
}

function compactionAcpConfiguration(input: {
  readonly adapter: ServerAdapterModule;
  readonly revision: AgentAdapterAcpConfiguration;
  readonly model: PersistedSessionCompactionModel;
}): AgentAdapterAcpConfiguration {
  const selected = input.adapter.definition.models.find(
    (candidate) =>
      candidate.id === input.model.targetModelId &&
      candidate.value === input.model.targetModelValue,
  );
  if (
    !selected ||
    selected.limits.contextTokenLimit !== input.model.contextTokenLimit ||
    selected.limits.inputTokenLimit !== input.model.inputTokenLimit ||
    selected.limits.outputTokenLimit !== input.model.outputTokenLimit
  ) {
    throw new SessionCompactionConflict(
      "Compaction model is not the exact immutable ACP adapter catalog entry",
    );
  }
  if (
    input.adapter.definition.version !== input.revision.contractVersion ||
    !sameApprovedAcpLaunch(
      input.adapter.definition.launchProfile,
      input.revision.launchProfile,
    )
  ) {
    throw new SessionCompactionConflict(
      "Compaction adapter implementation differs from its immutable revision",
    );
  }
  const modelConfigOptionId = input.adapter.definition.modelConfigOptionId;
  let replacements = 0;
  const selections = input.revision.sessionConfigSelections.map((selection) => {
    if (selection.configId !== modelConfigOptionId) return selection;
    replacements += 1;
    return Object.freeze({
      configId: selection.configId,
      value: selected.value,
    });
  });
  if (replacements !== 1) {
    throw new SessionCompactionConflict(
      "Compaction revision has no singular ACP model configuration selection",
    );
  }
  return agentAdapterAcpConfigurationSchema.parse({
    ...input.revision,
    sessionConfigSelections: selections,
    model: selected,
  });
}

function safelyRedact(
  redactor: IssueExecutionRuntimeRedactor,
  value: string,
): string {
  try {
    const redacted = redactor.redactText(value);
    return typeof redacted === "string"
      ? redacted
      : "[ACP compaction redaction failed]";
  } catch {
    return "[ACP compaction redaction failed]";
  }
}

function failureMessage(result: Extract<
  AcpPromptExecutionResult,
  { kind: "error" }
>): string {
  if (result.failure === "authentication_required") {
    return "The configured ACP CLI requires its native login; authenticate that CLI outside Paperclip and retry";
  }
  return `ACP compaction failed during ${result.phase}`;
}

function verifyEchoChunk(input: {
  readonly event: Extract<
    NormalizedAcpSessionEvent,
    { kind: "user_message_echo" }
  >;
  readonly expected: string;
  readonly observed: string;
}): string {
  if (input.event.content.type !== "text") {
    throw new Error("ACP compaction prompt echo contained a non-text block");
  }
  const observed = input.observed + input.event.content.text;
  if (!input.expected.startsWith(observed)) {
    throw new Error("ACP compaction prompt echo differs from the exact request");
  }
  return observed;
}

function requireCompleteEcho(observed: string, expected: string): void {
  if (observed.length > 0 && observed !== expected) {
    throw new Error("ACP compaction prompt echo ended before exact verification");
  }
}

function collectCompactionEvent(input: {
  readonly event: NormalizedAcpSessionEvent;
  readonly expectedPrompt: string;
  readonly echoedPrompt: string;
  readonly assistantChunks: string[];
}): string {
  const event = input.event;
  if (event.kind === "user_message_echo") {
    return verifyEchoChunk({
      event,
      expected: input.expectedPrompt,
      observed: input.echoedPrompt,
    });
  }
  if (event.kind === "message_chunk") {
    if (event.channel === "thought") return input.echoedPrompt;
    if (event.content.type !== "text") {
      throw new Error("ACP compaction response contained a non-text block");
    }
    input.assistantChunks.push(event.content.text);
    return input.echoedPrompt;
  }
  if (event.kind === "tool_call" || event.kind === "tool_call_update") {
    throw new Error(
      "ACP compaction emitted a tool call even though mcpServers is empty",
    );
  }
  // Stable plan and other negotiated control observations are not compaction
  // text, history, accounting, or a second tool channel.
  return input.echoedPrompt;
}

async function summarizeThroughAcp(input: {
  readonly runId: string;
  readonly prompt: string;
  readonly signal?: AbortSignal;
  readonly lifecycle: SessionCompactionPromptLifecycle;
  readonly acpConfiguration: AgentAdapterAcpConfiguration;
  readonly targetAcquirer: IssueExecutionTargetAcquirer;
  readonly targetInput: Parameters<IssueExecutionTargetAcquirer["acquire"]>[0];
  readonly executePrompt: ExecutePrompt;
  readonly prepareTarget: PrepareTarget;
}): Promise<SessionCompactionSummaryResult> {
  if (input.signal?.aborted) {
    throw new SessionCompactionProviderFailure(
      "ACP compaction was cancelled before target acquisition",
      "acp_compaction_cancelled",
      false,
      "",
      false,
    );
  }
  const target = await input.targetAcquirer.acquire(input.targetInput);
  let failed = true;
  let activated = false;
  let transmissionBegan = false;
  try {
    if (input.signal?.aborted) {
      throw new SessionCompactionProviderFailure(
        "ACP compaction was cancelled during target acquisition",
        "acp_compaction_cancelled",
        false,
        "",
        false,
      );
    }
    const approvedLaunch = resolveApprovedAcpLaunch(
      input.acpConfiguration.launchProfile.registryName,
    );
    const prepared = await input.prepareTarget({
      runId: input.runId,
      target: target.executionTarget,
      sourceLaunch: approvedLaunch,
      hostCwd: target.hostCwd,
      targetCwd: target.targetCwd,
      targetAdditionalDirectories: target.targetAdditionalDirectories,
      companySkills: { channel: "operator_native" },
    });
    const launch: AcpSubprocessLaunch = {
      version: ACP_SUBPROCESS_CONTRACT_VERSION,
      launch: approvedLaunch,
      cwd: prepared.targetCwd,
      additionalDirectories: prepared.targetAdditionalDirectories,
      environment: Object.freeze({}),
      mcpServers: noAcpMcpServers(),
      configOptions: input.acpConfiguration.sessionConfigSelections,
    };
    const assistantChunks: string[] = [];
    let echoedPrompt = "";
    let closed: AcpPromptClosureOutcome | null = null;
    const result = await input.executePrompt({
      launch,
      request: { start: { kind: "new" }, message: input.prompt },
      startSubprocess: prepared.startSubprocess,
      signal: input.signal,
      redactStderr: (value) => safelyRedact(target.redactor, value),
      async activatePrompt({ sessionId }) {
        exactNonempty(sessionId, "ACP compaction session id");
        activated = true;
        await input.lifecycle.onSessionActivated?.();
      },
      async beginPromptTransmission({ sessionId }) {
        exactNonempty(sessionId, "ACP compaction session id");
        if (!activated) {
          throw new Error("ACP compaction prompt transmitted before activation");
        }
        transmissionBegan = true;
        await input.lifecycle.onPromptTransmissionBegan?.();
      },
      async closePrompt(outcome) {
        if (closed) {
          throw new Error("ACP compaction prompt closed more than once");
        }
        closed = outcome;
      },
      async onSessionEvent(event) {
        echoedPrompt = collectCompactionEvent({
          event,
          expectedPrompt: input.prompt,
          echoedPrompt,
          assistantChunks,
        });
      },
      validatePromptEvents() {
        requireCompleteEcho(echoedPrompt, input.prompt);
      },
    });
    if (!closed || result.closureError !== null) {
      throw new SessionCompactionProviderFailure(
        "ACP compaction prompt did not close its canonical lifecycle",
        "acp_closure_failed",
        false,
        safelyRedact(target.redactor, assistantChunks.join("")),
      );
    }
    if (result.teardown.kind !== "reaped") {
      throw new SessionCompactionProviderFailure(
        "ACP compaction subprocess did not reap cleanly",
        "acp_teardown_failed",
        false,
        safelyRedact(target.redactor, assistantChunks.join("")),
      );
    }
    if (
      result.teardown.processExit.exitCode !== 0 ||
      result.teardown.processExit.signal !== null
    ) {
      throw new SessionCompactionProviderFailure(
        "ACP compaction subprocess exited unsuccessfully",
        "acp_process_failed",
        false,
        safelyRedact(target.redactor, assistantChunks.join("")),
      );
    }
    if (result.kind === "target_not_found") {
      throw new SessionCompactionProviderFailure(
        "Fresh ACP compaction session unexpectedly returned target_not_found",
        "acp_protocol_violation",
        false,
        safelyRedact(target.redactor, assistantChunks.join("")),
      );
    }
    if (result.kind === "error") {
      throw new SessionCompactionProviderFailure(
        failureMessage(result),
        result.failure === "authentication_required"
          ? "authentication_required"
          : `acp_${result.phase}_failure`,
        result.failure === "runtime" &&
          !result.promptTransmitted &&
          (result.phase === "spawn" || result.phase === "initialize"),
        safelyRedact(target.redactor, assistantChunks.join("")),
      );
    }
    if (!activated || !transmissionBegan) {
      throw new SessionCompactionProviderFailure(
        "ACP compaction settlement bypassed prompt activation",
        "acp_protocol_violation",
        false,
        safelyRedact(target.redactor, assistantChunks.join("")),
      );
    }
    if (
      result.settlement.occupancy.size !==
      input.acpConfiguration.model.limits.contextTokenLimit
    ) {
      throw new SessionCompactionProviderFailure(
        "ACP compaction occupancy size differs from its immutable model limit",
        "acp_occupancy_invalid",
        false,
        safelyRedact(target.redactor, assistantChunks.join("")),
      );
    }
    failed = false;
    return Object.freeze({
      text: safelyRedact(target.redactor, assistantChunks.join("")),
      settlement: result.settlement,
    });
  } catch (error) {
    if (error instanceof SessionCompactionProviderFailure) {
      if (error.promptTransmitted || !transmissionBegan) throw error;
      throw new SessionCompactionProviderFailure(
        error.message,
        error.errorKind,
        error.retryable,
        error.partialText,
        true,
      );
    }
    throw new SessionCompactionProviderFailure(
      safelyRedact(
        target.redactor,
        error instanceof Error ? error.message : String(error),
      ),
      "acp_compaction_failure",
      false,
      "",
      transmissionBegan,
    );
  } finally {
    await target.release(failed);
  }
}

export function createPostgresSessionCompactionProvider(
  db: Db,
  options: {
    adapterRegistry?: {
      require(
        adapterType: string,
        implementationIdentity: AdapterImplementationIdentity,
      ): Promise<ServerAdapterModule> | ServerAdapterModule;
    };
    targetAcquirer?: IssueExecutionTargetAcquirer;
    environmentOrchestrator?: Pick<
      EnvironmentRunOrchestrator,
      "acquireExecutionTargetForRun"
    >;
    companyModelCatalog?: CompanyModelCatalog;
    executePrompt?: ExecutePrompt;
    prepareTarget?: PrepareTarget;
  } = {},
): {
  modelResolver: SessionCompactionModelResolver;
  summarizer: SessionCompactionSummarizer;
} {
  const registry = options.adapterRegistry ?? {
    async require(
      adapterType: string,
      implementationIdentity: AdapterImplementationIdentity,
    ) {
      const { requireServerAdapterImplementation } = await import(
        "../adapters/registry.js"
      );
      return requireServerAdapterImplementation(
        adapterType,
        implementationIdentity,
      );
    },
  };
  const companyModelCatalog =
    options.companyModelCatalog ?? createCompanyModelCatalog();
  const targetAcquirer =
    options.targetAcquirer ??
    (options.environmentOrchestrator
      ? createIssueExecutionTargetAcquirer({
          environmentOrchestrator: options.environmentOrchestrator,
        })
      : null);
  const executePrompt = options.executePrompt ?? executeAcpSubprocessPrompt;
  const prepareTarget =
    options.prepareTarget ?? prepareAcpExecutionTargetSubprocess;

  return {
    modelResolver: {
      async validateConfiguredModel(input) {
        exactNonempty(input.modelRef, "Compaction modelRef");
        try {
          await companyModelCatalog.resolve({
            companyId: input.companyId,
            modelId: input.modelRef,
          });
        } catch (error) {
          throw new SessionCompactionConflict(
            error instanceof Error
              ? `Compaction modelRef is unavailable: ${error.message}`
              : "Compaction modelRef is unavailable",
          );
        }
      },
      async resolve(input) {
        await loadExactExecutionConfiguration(db, input);
        const triggerModel = persistedSessionCompactionModelSchema.parse(
          input.triggerModel,
        );
        if (input.requestedModelRef === null) return triggerModel;
        exactNonempty(input.requestedModelRef, "Compaction modelRef");
        try {
          return persistedCatalogModel(
            input.requestedModelRef,
            await companyModelCatalog.resolve({
              companyId: input.companyId,
              modelId: input.requestedModelRef,
            }),
          );
        } catch (error) {
          throw new SessionCompactionConflict(
            error instanceof Error
              ? `Compaction modelRef is unavailable: ${error.message}`
              : "Compaction modelRef is unavailable",
          );
        }
      },
    },
    summarizer: {
      async summarize(input) {
        if (!targetAcquirer) {
          throw new SessionCompactionProviderFailure(
            "Compaction has no canonical execution-target acquirer",
            "execution_target_unavailable",
            false,
          );
        }
        const loaded = await loadExactExecutionConfiguration(db, input);
        const adapter = await registry.require(
          loaded.revision.adapterType,
          loaded.revision.implementationIdentity,
        );
        if (adapter.type !== loaded.revision.adapterType) {
          throw new SessionCompactionConflict(
            "Compaction adapter registry returned a different adapter type",
          );
        }
        const model = persistedSessionCompactionModelSchema.parse(input.model);
        const acpConfiguration = compactionAcpConfiguration({
          adapter,
          revision: loaded.acpConfiguration,
          model,
        });
        return summarizeThroughAcp({
          runId: input.runId,
          prompt: input.prompt,
          signal: input.signal,
          lifecycle: input.lifecycle,
          acpConfiguration,
          targetAcquirer,
          targetInput: {
            companyId: input.companyId,
            issueId: input.issueId,
            runId: input.runId,
            targetAgentId: input.agentId,
            adapterConfigRevisionId: loaded.revision.id,
            executionWorkspaceBindingId: loaded.binding.id,
            acpConfiguration,
            hostCwd: loaded.binding.absoluteCwd,
            localWorkspaceCwd: loaded.binding.absoluteCwd,
            targetAdditionalDirectories: Object.freeze([]),
          },
          executePrompt,
          prepareTarget,
        });
      },
    },
  };
}
