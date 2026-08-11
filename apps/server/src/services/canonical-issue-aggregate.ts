import { createHash } from "node:crypto";
import {
  issueCreateIdempotencyKeys,
  issueCreatorEdgeReceivability,
  issueExecutionAuthorities,
  issues,
} from "@paperclipai/db";
import { isSystemCreatorSourceKind } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import {
  reserveIssueExecutionWorkspaceBinding,
  type ReserveIssueExecutionWorkspaceBindingInput,
} from "./execution-workspaces.js";
import { syncIssue } from "./issue-references.js";

type IssueInsert = typeof issues.$inferInsert;
type IssueRow = typeof issues.$inferSelect;
type AuthorityInsert = typeof issueExecutionAuthorities.$inferInsert;
type CreatorEdgeInsert =
  typeof issueCreatorEdgeReceivability.$inferInsert;

export class CanonicalIssueAggregateRejected extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = "CanonicalIssueAggregateRejected";
  }
}

function deterministicUuid(namespace: string, key: string): string {
  const bytes = Buffer.from(
    createHash("sha256")
      .update(`${namespace}\0${key}`)
      .digest("hex")
      .slice(0, 32),
    "hex",
  );
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function isPresent(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function allAbsent(...values: unknown[]): boolean {
  return values.every((value) => !isPresent(value));
}

/**
 * Mirrors the generated issues creator/provenance CHECK constraints before the
 * canonical aggregate attempts its sole issue insert.
 */
export function assertCanonicalIssueCreatorProvenance(
  issue: IssueInsert & { id: string },
): void {
  const unrelatedCreatorFields = [
    issue.creatorAuthorityId,
    issue.creatorAdapterConfigRevisionId,
    issue.creatorUserId,
    issue.creatorPluginInstallationId,
    issue.creatorPluginKey,
    issue.creatorCallbackKey,
    issue.creatorCallbackVersion,
    issue.creatorRoutineId,
    issue.creatorRoutineDispatchId,
    issue.creatorSystemSourceKind,
    issue.creatorSystemSourceId,
  ];

  let validCreatorShape = false;
  switch (issue.creatorKind) {
    case "agent-execution":
      validCreatorShape =
        isPresent(issue.creatorAuthorityId) &&
        isPresent(issue.creatorAdapterConfigRevisionId) &&
        allAbsent(...unrelatedCreatorFields.slice(2));
      break;
    case "user/board":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 2)) &&
        allAbsent(...unrelatedCreatorFields.slice(3));
      break;
    case "plugin":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 3)) &&
        isPresent(issue.creatorPluginInstallationId) &&
        isPresent(issue.creatorPluginKey) &&
        isPresent(issue.creatorCallbackKey) &&
        isPresent(issue.creatorCallbackVersion) &&
        allAbsent(...unrelatedCreatorFields.slice(7));
      break;
    case "routine":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 7)) &&
        isPresent(issue.creatorRoutineId) &&
        isPresent(issue.creatorRoutineDispatchId) &&
        allAbsent(...unrelatedCreatorFields.slice(9));
      break;
    case "system":
      validCreatorShape =
        allAbsent(...unrelatedCreatorFields.slice(0, 9)) &&
        isSystemCreatorSourceKind(
          issue.creatorSystemSourceKind,
        ) &&
        isPresent(issue.creatorSystemSourceId);
      break;
  }
  if (!validCreatorShape) {
    throw new CanonicalIssueAggregateRejected(
      "Issue creator fields do not match the selected creator kind",
      "creator_shape_invalid",
    );
  }

  const noEscalationProvenance = allAbsent(
    issue.escalatedFromAffectedIssueId,
    issue.escalatedFromTriggeringRunId,
    issue.escalatedFromReason,
    issue.affectedOwnershipEpoch,
  );
  const validEscalationProvenance =
    isPresent(issue.escalatedFromAffectedIssueId) &&
    issue.escalatedFromAffectedIssueId !== issue.id &&
    isPresent(issue.escalatedFromReason) &&
    typeof issue.affectedOwnershipEpoch === "number" &&
    Number.isInteger(issue.affectedOwnershipEpoch) &&
    issue.affectedOwnershipEpoch > 0 &&
    !isPresent(issue.parentId);
  const validEscalationShape =
    issue.creatorKind === "system"
      ? validEscalationProvenance
      : noEscalationProvenance;
  if (!validEscalationShape) {
    throw new CanonicalIssueAggregateRejected(
      "System creator and escalation provenance must occur together",
      "escalation_provenance_invalid",
    );
  }
}

function creatorEndpoint(issue: IssueRow): Pick<
  CreatorEdgeInsert,
  "endpointKind" | "endpointId" | "endpointSnapshot"
> {
  switch (issue.creatorKind) {
    case "agent-execution":
      if (
        issue.creatorAuthorityId &&
        issue.creatorAdapterConfigRevisionId
      ) {
        return {
          endpointKind: "agent-execution",
          endpointId: issue.creatorAuthorityId,
          endpointSnapshot: {
            authorityId: issue.creatorAuthorityId,
            originatingAdapterConfigRevisionId:
              issue.creatorAdapterConfigRevisionId,
          },
        };
      }
      break;
    case "user/board":
      if (issue.creatorUserId) {
        return {
          endpointKind: "user/board",
          endpointId: issue.creatorUserId,
          endpointSnapshot: {
            userId: issue.creatorUserId,
            recipient: "named-user",
          },
        };
      }
      return {
        endpointKind: "user/board",
        endpointId: null,
        endpointSnapshot: { recipient: "company-board" },
      };
    case "plugin":
      if (
        issue.creatorPluginInstallationId &&
        issue.creatorPluginKey &&
        issue.creatorCallbackKey &&
        issue.creatorCallbackVersion
      ) {
        return {
          endpointKind: "plugin",
          endpointId: issue.creatorPluginInstallationId,
          endpointSnapshot: {
            pluginInstallationId:
              issue.creatorPluginInstallationId,
            pluginKey: issue.creatorPluginKey,
            callbackKey: issue.creatorCallbackKey,
            callbackVersion: issue.creatorCallbackVersion,
          },
        };
      }
      break;
    case "routine":
      if (
        issue.creatorRoutineId &&
        issue.creatorRoutineDispatchId
      ) {
        return {
          endpointKind: "routine",
          endpointId: issue.creatorRoutineId,
          endpointSnapshot: {
            routineId: issue.creatorRoutineId,
            routineDispatchId: issue.creatorRoutineDispatchId,
          },
        };
      }
      break;
    case "system":
      if (
        issue.creatorSystemSourceKind &&
        issue.creatorSystemSourceId
      ) {
        return {
          endpointKind: "system",
          endpointId: issue.creatorSystemSourceId,
          endpointSnapshot: {
            sourceKind: issue.creatorSystemSourceKind,
            sourceId: issue.creatorSystemSourceId,
            recipient: "company-board",
          },
        };
      }
      break;
  }
  throw new CanonicalIssueAggregateRejected(
    "Issue creator endpoint is incomplete",
    "creator_endpoint_incomplete",
  );
}

async function assertAgentExecutionCreator(
  tx: IssueSessionDbTransaction,
  issue: IssueInsert,
): Promise<void> {
  if (issue.creatorKind !== "agent-execution") return;
  if (
    !issue.creatorAuthorityId ||
    !issue.creatorAdapterConfigRevisionId
  ) {
    throw new CanonicalIssueAggregateRejected(
      "Agent-execution creator identity is incomplete",
      "creator_authority_incomplete",
    );
  }
  const authority = await tx
    .select({
      id: issueExecutionAuthorities.id,
      companyId: issueExecutionAuthorities.companyId,
      auditAdapterConfigRevisionId:
        issueExecutionAuthorities.auditAdapterConfigRevisionId,
    })
    .from(issueExecutionAuthorities)
    .where(
      and(
        eq(
          issueExecutionAuthorities.companyId,
          issue.companyId,
        ),
        eq(
          issueExecutionAuthorities.id,
          issue.creatorAuthorityId,
        ),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (
    !authority ||
    authority.auditAdapterConfigRevisionId !==
      issue.creatorAdapterConfigRevisionId
  ) {
    throw new CanonicalIssueAggregateRejected(
      "Agent-execution creator authority is not resolvable in this company",
      "creator_authority_invalid",
    );
  }
}

export interface CanonicalIssueAggregateInput {
  issue: IssueInsert & {
    id: string;
    companyId: string;
    ownershipEpoch: number;
  };
  session: {
    id: string;
    parentSessionId?: string | null;
    now: Date;
  };
  workspaceReservation?: Omit<
    ReserveIssueExecutionWorkspaceBindingInput,
    "issue" | "session"
  >;
  authority: (Omit<
    AuthorityInsert,
    "companyId" | "issueId" | "sessionId" | "ownershipEpoch"
  > & {
    id: string;
    agentId: string;
    auditAdapterConfigRevisionId: string;
  }) | null;
  idempotency?: {
    id?: string;
    key: string;
  } | null;
}

/**
 * Sole production writer for a newly created issue aggregate.
 *
 * Source services retain source-specific authorization, correlation and
 * initial admission, but no source may persist a partial issue graph. This
 * transaction owner always commits the issue, canonical Session, current
 * workspace binding, current owner authority (for agent ownership), and the
 * immutable creator edge for live work as one aggregate.
 */
export async function persistCanonicalIssueAggregateInTx(
  tx: IssueSessionDbTransaction,
  input: CanonicalIssueAggregateInput,
) {
  let issue = input.issue;
  if (issue.ownershipEpoch < 1) {
    throw new CanonicalIssueAggregateRejected(
      "Issue ownership epoch must be positive",
      "ownership_epoch_invalid",
    );
  }
  assertCanonicalIssueCreatorProvenance(issue);
  if (issue.parentId) {
    if (issue.parentId === issue.id) {
      throw new CanonicalIssueAggregateRejected(
        "An issue cannot be its own parent",
        "parent_issue_invalid",
      );
    }
    const parent = await tx
      .select({ ownershipEpoch: issues.ownershipEpoch })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, issue.companyId),
          eq(issues.id, issue.parentId),
        ),
      )
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (!parent || parent.ownershipEpoch < 1) {
      throw new CanonicalIssueAggregateRejected(
        "Parent issue is not resolvable in this company",
        "parent_issue_invalid",
      );
    }
    if (
      issue.parentOwnershipEpoch !== undefined &&
      issue.parentOwnershipEpoch !== null &&
      issue.parentOwnershipEpoch !== parent.ownershipEpoch
    ) {
      throw new CanonicalIssueAggregateRejected(
        "Parent ownership epoch changed before child creation committed",
        "parent_ownership_epoch_conflict",
      );
    }
    issue = {
      ...issue,
      parentOwnershipEpoch: parent.ownershipEpoch,
    };
  } else if (issue.parentOwnershipEpoch != null) {
    throw new CanonicalIssueAggregateRejected(
      "A root issue cannot carry parent ownership provenance",
      "parent_ownership_epoch_unexpected",
    );
  }
  const nonterminal =
    issue.lifecycleStatus === "open" ||
    issue.lifecycleStatus === "blocked";
  if (issue.ownerKind === "agent") {
    if (
      !issue.ownerAgentId ||
      issue.ownerUserId ||
      !input.authority ||
      input.authority.agentId !== issue.ownerAgentId
    ) {
      throw new CanonicalIssueAggregateRejected(
        "Agent-owned issue requires one matching current authority",
        "owner_authority_invalid",
      );
    }
  } else if (input.authority) {
    throw new CanonicalIssueAggregateRejected(
      "Non-agent-owned issue cannot carry an owner authority",
      "owner_authority_unexpected",
    );
  }
  await assertAgentExecutionCreator(tx, issue);

  const created = await tx
    .insert(issues)
    .values(issue)
    .returning()
    .then((rows) => rows[0] ?? null);
  if (!created) {
    throw new CanonicalIssueAggregateRejected(
      "Issue was not persisted",
      "issue_insert_failed",
    );
  }
  await syncIssue(created.id, tx);

  const workspaceReservation =
    await reserveIssueExecutionWorkspaceBinding(tx, {
      issue: created,
      session: input.session,
      ...input.workspaceReservation,
    });
  const persistedIssue =
    created.projectWorkspaceId === workspaceReservation.projectWorkspaceId
      ? created
      : await tx
          .update(issues)
          .set({
            projectWorkspaceId: workspaceReservation.projectWorkspaceId,
          })
          .where(
            and(
              eq(issues.companyId, created.companyId),
              eq(issues.id, created.id),
            ),
          )
          .returning()
          .then((rows) => rows[0] ?? null);
  if (!persistedIssue) {
    throw new CanonicalIssueAggregateRejected(
      "Reserved project workspace was not projected onto the issue",
      "project_workspace_projection_failed",
    );
  }
  const sessionRoot = {
    session: workspaceReservation.session,
    contextEpoch: {
      generation: workspaceReservation.contextEpochGeneration,
    },
  };
  const binding = workspaceReservation.binding;

  const authority = input.authority
    ? await tx
        .insert(issueExecutionAuthorities)
        .values({
          ...input.authority,
          companyId: created.companyId,
          issueId: created.id,
          sessionId: input.session.id,
          ownershipEpoch: created.ownershipEpoch!,
          state: "current",
          createdAt:
            input.authority.createdAt ?? input.session.now,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
    : null;
  if (input.authority && !authority) {
    throw new CanonicalIssueAggregateRejected(
      "Issue owner authority was not persisted",
      "owner_authority_missing",
    );
  }

  const creatorEdge = nonterminal
    ? await tx
        .insert(issueCreatorEdgeReceivability)
        .values({
          id: deterministicUuid(
            "creator-edge",
            `${created.companyId}:${created.id}:${created.ownershipEpoch}`,
          ),
          companyId: created.companyId,
          issueId: created.id,
          sessionId: input.session.id,
          ownershipEpoch: created.ownershipEpoch!,
          creatorKind: created.creatorKind!,
          ...creatorEndpoint(created),
          endpointTombstone: null,
          state: "receivable",
          createdAt: input.session.now,
          updatedAt: input.session.now,
        })
        .returning()
        .then((rows) => rows[0] ?? null)
    : null;
  if (nonterminal && !creatorEdge) {
    throw new CanonicalIssueAggregateRejected(
      "Issue creator edge was not persisted",
      "creator_edge_missing",
    );
  }

  if (input.idempotency) {
    await tx.insert(issueCreateIdempotencyKeys).values({
      ...(input.idempotency.id
        ? { id: input.idempotency.id }
        : {}),
      companyId: created.companyId,
      idempotencyKey: input.idempotency.key,
      issueId: created.id,
      createdAt: input.session.now,
    });
  }

  return {
    issue: persistedIssue,
    sessionRoot,
    workspaceBinding: binding,
    authority,
    creatorEdge,
  };
}
