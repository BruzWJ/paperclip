import { createHash } from "node:crypto";
import type {
  TaskExecutionFinalizationAction,
  TaskExecutionProtocolSettlementState,
  TaskExecutionRunKind,
} from "@paperclipai/shared";

export type TaskExecutionFinalizationPromptIdentity =
  | {
      readonly kind: "base";
      readonly refId: string;
      readonly refOrdinal: number;
      readonly segmentOrdinal: 0;
    }
  | {
      readonly kind: "steering";
      readonly refId: string;
      readonly refOrdinal: number;
      readonly segmentOrdinal: number;
    };

export type TaskExecutionFinalizationPromptDependency = TaskExecutionFinalizationPromptIdentity & {
  readonly protocolSettlementState: TaskExecutionProtocolSettlementState;
  readonly settlementVersion: number;
  readonly accountingId: string | null;
  readonly costEventId: string | null;
};

export interface TaskExecutionFinalizationUpdateDependency {
  readonly taskUpdateId: string;
}

export interface TaskExecutionGatewayRevocationIdentity {
  readonly capabilityConnectionId: string;
  readonly capabilityGeneration: number;
}

export interface BuildTaskExecutionFinalizationPlanInput {
  readonly companyId: string;
  readonly taskId: string;
  readonly runId: string;
  readonly runKind: TaskExecutionRunKind;
  readonly action: TaskExecutionFinalizationAction;
  readonly expectedPromptIdentities: readonly TaskExecutionFinalizationPromptIdentity[];
  readonly promptDependencies: readonly TaskExecutionFinalizationPromptDependency[];
  readonly terminalSessionEventId: string | null;
  readonly terminalSessionMessageId: string | null;
  readonly progressCommentId: string | null;
  readonly runLivenessFactId: string | null;
  readonly gatewayRevocationRequired: boolean;
  readonly gatewayRevocation: TaskExecutionGatewayRevocationIdentity | null;
  readonly updates: readonly TaskExecutionFinalizationUpdateDependency[];
}

export interface TaskExecutionFinalizationPlan {
  readonly finalizationIdentityDigest: string;
  readonly promptDependencies: readonly (TaskExecutionFinalizationPromptDependency & {
    readonly dependencyOrdinal: number;
  })[];
  readonly updateDependencies: readonly {
    readonly dependencyOrdinal: number;
    readonly taskUpdateId: string;
  }[];
}

export class TaskExecutionFinalizationRejected extends Error {
  readonly code = "task_execution_finalization_rejected";

  constructor(
    message: string,
    readonly reason:
      | "identity_invalid"
      | "prompt_frontier_mismatch"
      | "prompt_settlement_invalid"
      | "branch_invalid"
      | "gateway_revocation_invalid",
  ) {
    super(message);
    this.name = "TaskExecutionFinalizationRejected";
  }
}

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new TaskExecutionFinalizationRejected(`${label} must be exact and non-empty`, "identity_invalid");
  }
}

function positiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TaskExecutionFinalizationRejected(
      `${label} must be a positive integer`,
      "prompt_settlement_invalid",
    );
  }
}

function promptIdentityKey(value: TaskExecutionFinalizationPromptIdentity): string {
  switch (value.kind) {
    case "base":
      if (!Number.isSafeInteger(value.refOrdinal) || value.refOrdinal < 0 || value.segmentOrdinal !== 0) {
        throw new TaskExecutionFinalizationRejected(
          "Base finalization dependency has an invalid identity",
          "identity_invalid",
        );
      }
      exactIdentity(value.refId, "base ref id");
      return `base:${value.refOrdinal}:${value.refId}`;
    case "steering":
      if (
        !Number.isSafeInteger(value.refOrdinal) ||
        value.refOrdinal < 0 ||
        !Number.isSafeInteger(value.segmentOrdinal) ||
        value.segmentOrdinal <= 0
      ) {
        throw new TaskExecutionFinalizationRejected(
          "Steering finalization dependency has an invalid identity",
          "identity_invalid",
        );
      }
      exactIdentity(value.refId, "steering ref id");
      return `steering:${value.refOrdinal}:${value.refId}:${value.segmentOrdinal}`;
  }
}

function assertPromptSettlement(value: TaskExecutionFinalizationPromptDependency): void {
  promptIdentityKey(value);
  positiveVersion(value.settlementVersion, "settlement version");
  if (value.protocolSettlementState === "settled") {
    if (!value.accountingId || !value.costEventId) {
      throw new TaskExecutionFinalizationRejected(
        "A settled prompt requires its matching accounting and cost identities",
        "prompt_settlement_invalid",
      );
    }
    exactIdentity(value.accountingId, "accounting id");
    exactIdentity(value.costEventId, "cost event id");
    return;
  }
  if (value.accountingId !== null || value.costEventId !== null) {
    throw new TaskExecutionFinalizationRejected(
      "A not-sent or incomplete prompt cannot reference accounting or cost",
      "prompt_settlement_invalid",
    );
  }
}

function assertPromptFrontier(
  expected: readonly TaskExecutionFinalizationPromptIdentity[],
  actual: readonly TaskExecutionFinalizationPromptDependency[],
): void {
  const expectedKeys = expected.map(promptIdentityKey);
  const actualKeys = actual.map((value) => {
    assertPromptSettlement(value);
    return promptIdentityKey(value);
  });
  if (
    expectedKeys.length !== new Set(expectedKeys).size ||
    actualKeys.length !== new Set(actualKeys).size ||
    expectedKeys.length !== actualKeys.length ||
    expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    throw new TaskExecutionFinalizationRejected(
      "Finalization prompt dependencies do not equal the locked ordered frontier",
      "prompt_frontier_mismatch",
    );
  }
  if (actual.length === 0) {
    throw new TaskExecutionFinalizationRejected(
      "Finalization prompt dependencies do not match the run kind",
      "prompt_frontier_mismatch",
    );
  }
}

function assertBranch(input: BuildTaskExecutionFinalizationPlanInput): void {
  if (input.runKind === "productive") {
    if (!input.runLivenessFactId) {
      throw new TaskExecutionFinalizationRejected(
        "A productive finalization requires its immutable liveness fact",
        "branch_invalid",
      );
    }
    exactIdentity(input.runLivenessFactId, "run liveness fact id");
  } else if (input.runLivenessFactId !== null) {
    throw new TaskExecutionFinalizationRejected(
      "Consult finalizations cannot reference productive liveness",
      "branch_invalid",
    );
  }

  if (!input.progressCommentId) {
    throw new TaskExecutionFinalizationRejected(
      "Productive and consult finalizations require their stable progress comment",
      "branch_invalid",
    );
  }
  exactIdentity(input.progressCommentId, "progress comment id");

  if (input.action === "comment_only") {
    if (!input.terminalSessionEventId || !input.terminalSessionMessageId || input.updates.length !== 0) {
      throw new TaskExecutionFinalizationRejected(
        "Comment-only finalization requires one terminal Session pair and no updates",
        "branch_invalid",
      );
    }
  } else if (input.action === "updates_committed") {
    if (
      !input.terminalSessionEventId ||
      input.terminalSessionMessageId !== null ||
      input.updates.length === 0
    ) {
      throw new TaskExecutionFinalizationRejected(
        "Updates-committed finalization requires an event, updates, and no terminal message",
        "branch_invalid",
      );
    }
  } else if (
    input.terminalSessionEventId !== null ||
    input.terminalSessionMessageId !== null ||
    input.updates.length !== 0
  ) {
    throw new TaskExecutionFinalizationRejected(
      "No-conversational-output finalization has extra output dependencies",
      "branch_invalid",
    );
  }

  if (input.terminalSessionEventId) {
    exactIdentity(input.terminalSessionEventId, "terminal Session event id");
  }
  if (input.terminalSessionMessageId) {
    exactIdentity(input.terminalSessionMessageId, "terminal Session message id");
  }
}

function assertGatewayRevocation(input: BuildTaskExecutionFinalizationPlanInput): void {
  if (!input.gatewayRevocationRequired) {
    if (input.gatewayRevocation !== null) {
      throw new TaskExecutionFinalizationRejected(
        "Finalization references an inapplicable gateway revocation",
        "gateway_revocation_invalid",
      );
    }
    return;
  }
  if (!input.gatewayRevocation) {
    throw new TaskExecutionFinalizationRejected(
      "Finalization is missing its required gateway revocation",
      "gateway_revocation_invalid",
    );
  }
  exactIdentity(input.gatewayRevocation.capabilityConnectionId, "gateway capability connection id");
  positiveVersion(input.gatewayRevocation.capabilityGeneration, "gateway capability generation");
}

function assertUpdates(updates: readonly TaskExecutionFinalizationUpdateDependency[]): void {
  const updateIds = new Set<string>();
  for (const update of updates) {
    exactIdentity(update.taskUpdateId, "task update id");
    if (updateIds.has(update.taskUpdateId)) {
      throw new TaskExecutionFinalizationRejected(
        "Finalization contains a duplicate update dependency",
        "branch_invalid",
      );
    }
    updateIds.add(update.taskUpdateId);
  }
}

function digestRecord(input: BuildTaskExecutionFinalizationPlanInput) {
  return {
    version: "paperclip.task-execution-finalization/v1",
    companyId: input.companyId,
    taskId: input.taskId,
    runId: input.runId,
    runKind: input.runKind,
    action: input.action,
    terminalSessionEventId: input.terminalSessionEventId,
    terminalSessionMessageId: input.terminalSessionMessageId,
    progressCommentId: input.progressCommentId,
    runLivenessFactId: input.runLivenessFactId,
    gatewayRevocation: input.gatewayRevocation,
    prompts: input.promptDependencies.map((dependency, dependencyOrdinal) => ({
      dependencyOrdinal,
      kind: dependency.kind,
      refId: dependency.refId,
      refOrdinal: dependency.refOrdinal,
      segmentOrdinal: dependency.segmentOrdinal,
      protocolSettlementState: dependency.protocolSettlementState,
      settlementVersion: dependency.settlementVersion,
      accountingId: dependency.accountingId,
      costEventId: dependency.costEventId,
    })),
    updates: input.updates.map((dependency, dependencyOrdinal) => ({
      dependencyOrdinal,
      taskUpdateId: dependency.taskUpdateId,
    })),
  } as const;
}

/**
 * Validate the locked finalization frontier and derive its immutable digest.
 * This function never accepts text, provider output, transcript fragments, or
 * generic metadata, so those bytes cannot leak into the idempotency owner.
 */
export function buildTaskExecutionFinalizationPlan(
  input: BuildTaskExecutionFinalizationPlanInput,
): TaskExecutionFinalizationPlan {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["task id", input.taskId],
    ["run id", input.runId],
  ] as const) {
    exactIdentity(value, label);
  }
  assertPromptFrontier(input.expectedPromptIdentities, input.promptDependencies);
  assertUpdates(input.updates);
  assertBranch(input);
  assertGatewayRevocation(input);

  const finalizationIdentityDigest = createHash("sha256")
    .update(JSON.stringify(digestRecord(input)), "utf8")
    .digest("hex");
  return Object.freeze({
    finalizationIdentityDigest,
    promptDependencies: Object.freeze(
      input.promptDependencies.map((dependency, dependencyOrdinal) =>
        Object.freeze({ ...dependency, dependencyOrdinal }),
      ),
    ),
    updateDependencies: Object.freeze(
      input.updates.map((dependency, dependencyOrdinal) =>
        Object.freeze({
          dependencyOrdinal,
          taskUpdateId: dependency.taskUpdateId,
        }),
      ),
    ),
  });
}
