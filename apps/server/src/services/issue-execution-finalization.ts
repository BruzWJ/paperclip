import { createHash } from "node:crypto";
import type {
  IssueExecutionFinalizationAction,
  IssueExecutionProtocolSettlementState,
  IssueExecutionRunKind,
} from "@paperclipai/shared";

export type IssueExecutionFinalizationPromptIdentity =
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

export type IssueExecutionFinalizationPromptDependency =
  IssueExecutionFinalizationPromptIdentity & {
    readonly protocolSettlementState: IssueExecutionProtocolSettlementState;
    readonly settlementVersion: number;
    readonly accountingId: string | null;
    readonly costEventId: string | null;
  };

export interface IssueExecutionFinalizationUpdateDependency {
  readonly issueUpdateId: string;
}

export interface IssueExecutionGatewayRevocationIdentity {
  readonly capabilityConnectionId: string;
  readonly capabilityGeneration: number;
}

export interface BuildIssueExecutionFinalizationPlanInput {
  readonly companyId: string;
  readonly issueId: string;
  readonly runId: string;
  readonly runKind: IssueExecutionRunKind;
  readonly action: IssueExecutionFinalizationAction;
  readonly expectedPromptIdentities: readonly IssueExecutionFinalizationPromptIdentity[];
  readonly promptDependencies: readonly IssueExecutionFinalizationPromptDependency[];
  readonly terminalSessionEventId: string | null;
  readonly terminalSessionMessageId: string | null;
  readonly progressCommentId: string | null;
  readonly runLivenessFactId: string | null;
  readonly gatewayRevocationRequired: boolean;
  readonly gatewayRevocation: IssueExecutionGatewayRevocationIdentity | null;
  readonly updates: readonly IssueExecutionFinalizationUpdateDependency[];
}

export interface IssueExecutionFinalizationPlan {
  readonly finalizationIdentityDigest: string;
  readonly promptDependencies: readonly (IssueExecutionFinalizationPromptDependency & {
    readonly dependencyOrdinal: number;
  })[];
  readonly updateDependencies: readonly {
    readonly dependencyOrdinal: number;
    readonly issueUpdateId: string;
  }[];
}

export class IssueExecutionFinalizationRejected extends Error {
  readonly code = "issue_execution_finalization_rejected";

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
    this.name = "IssueExecutionFinalizationRejected";
  }
}

function exactIdentity(value: string, label: string): void {
  if (value.length === 0 || value !== value.trim()) {
    throw new IssueExecutionFinalizationRejected(
      `${label} must be exact and non-empty`,
      "identity_invalid",
    );
  }
}

function positiveVersion(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new IssueExecutionFinalizationRejected(
      `${label} must be a positive integer`,
      "prompt_settlement_invalid",
    );
  }
}

function promptIdentityKey(
  value: IssueExecutionFinalizationPromptIdentity,
): string {
  switch (value.kind) {
    case "base":
      if (
        !Number.isSafeInteger(value.refOrdinal) ||
        value.refOrdinal < 0 ||
        value.segmentOrdinal !== 0
      ) {
        throw new IssueExecutionFinalizationRejected(
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
        throw new IssueExecutionFinalizationRejected(
          "Steering finalization dependency has an invalid identity",
          "identity_invalid",
        );
      }
      exactIdentity(value.refId, "steering ref id");
      return `steering:${value.refOrdinal}:${value.refId}:${value.segmentOrdinal}`;
  }
}

function assertPromptSettlement(
  value: IssueExecutionFinalizationPromptDependency,
): void {
  promptIdentityKey(value);
  positiveVersion(value.settlementVersion, "settlement version");
  if (value.protocolSettlementState === "settled") {
    if (!value.accountingId || !value.costEventId) {
      throw new IssueExecutionFinalizationRejected(
        "A settled prompt requires its matching accounting and cost identities",
        "prompt_settlement_invalid",
      );
    }
    exactIdentity(value.accountingId, "accounting id");
    exactIdentity(value.costEventId, "cost event id");
    return;
  }
  if (value.accountingId !== null || value.costEventId !== null) {
    throw new IssueExecutionFinalizationRejected(
      "A not-sent or incomplete prompt cannot reference accounting or cost",
      "prompt_settlement_invalid",
    );
  }
}

function assertPromptFrontier(
  expected: readonly IssueExecutionFinalizationPromptIdentity[],
  actual: readonly IssueExecutionFinalizationPromptDependency[],
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
    throw new IssueExecutionFinalizationRejected(
      "Finalization prompt dependencies do not equal the locked ordered frontier",
      "prompt_frontier_mismatch",
    );
  }
  if (actual.length === 0) {
    throw new IssueExecutionFinalizationRejected(
      "Finalization prompt dependencies do not match the run kind",
      "prompt_frontier_mismatch",
    );
  }
}

function assertBranch(input: BuildIssueExecutionFinalizationPlanInput): void {
  if (input.runKind === "productive") {
    if (!input.runLivenessFactId) {
      throw new IssueExecutionFinalizationRejected(
        "A productive finalization requires its immutable liveness fact",
        "branch_invalid",
      );
    }
    exactIdentity(input.runLivenessFactId, "run liveness fact id");
  } else if (input.runLivenessFactId !== null) {
    throw new IssueExecutionFinalizationRejected(
      "Consult finalizations cannot reference productive liveness",
      "branch_invalid",
    );
  }

  if (!input.progressCommentId) {
    throw new IssueExecutionFinalizationRejected(
      "Productive and consult finalizations require their stable progress comment",
      "branch_invalid",
    );
  }
  exactIdentity(input.progressCommentId, "progress comment id");

  if (input.action === "comment_only") {
    if (
      !input.terminalSessionEventId ||
      !input.terminalSessionMessageId ||
      input.updates.length !== 0
    ) {
      throw new IssueExecutionFinalizationRejected(
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
      throw new IssueExecutionFinalizationRejected(
        "Updates-committed finalization requires an event, updates, and no terminal message",
        "branch_invalid",
      );
    }
  } else if (
    input.terminalSessionEventId !== null ||
    input.terminalSessionMessageId !== null ||
    input.updates.length !== 0
  ) {
    throw new IssueExecutionFinalizationRejected(
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

function assertGatewayRevocation(
  input: BuildIssueExecutionFinalizationPlanInput,
): void {
  if (!input.gatewayRevocationRequired) {
    if (input.gatewayRevocation !== null) {
      throw new IssueExecutionFinalizationRejected(
        "Finalization references an inapplicable gateway revocation",
        "gateway_revocation_invalid",
      );
    }
    return;
  }
  if (!input.gatewayRevocation) {
    throw new IssueExecutionFinalizationRejected(
      "Finalization is missing its required gateway revocation",
      "gateway_revocation_invalid",
    );
  }
  exactIdentity(
    input.gatewayRevocation.capabilityConnectionId,
    "gateway capability connection id",
  );
  positiveVersion(
    input.gatewayRevocation.capabilityGeneration,
    "gateway capability generation",
  );
}

function assertUpdates(
  updates: readonly IssueExecutionFinalizationUpdateDependency[],
): void {
  const updateIds = new Set<string>();
  for (const update of updates) {
    exactIdentity(update.issueUpdateId, "issue update id");
    if (updateIds.has(update.issueUpdateId)) {
      throw new IssueExecutionFinalizationRejected(
        "Finalization contains a duplicate update dependency",
        "branch_invalid",
      );
    }
    updateIds.add(update.issueUpdateId);
  }
}

function digestRecord(input: BuildIssueExecutionFinalizationPlanInput) {
  return {
    version: "paperclip.issue-execution-finalization/v1",
    companyId: input.companyId,
    issueId: input.issueId,
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
      issueUpdateId: dependency.issueUpdateId,
    })),
  } as const;
}

/**
 * Validate the locked finalization frontier and derive its immutable digest.
 * This function never accepts text, provider output, transcript fragments, or
 * generic metadata, so those bytes cannot leak into the idempotency owner.
 */
export function buildIssueExecutionFinalizationPlan(
  input: BuildIssueExecutionFinalizationPlanInput,
): IssueExecutionFinalizationPlan {
  for (const [label, value] of [
    ["company id", input.companyId],
    ["issue id", input.issueId],
    ["run id", input.runId],
  ] as const) {
    exactIdentity(value, label);
  }
  assertPromptFrontier(
    input.expectedPromptIdentities,
    input.promptDependencies,
  );
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
          issueUpdateId: dependency.issueUpdateId,
        }),
      ),
    ),
  });
}
