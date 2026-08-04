import {
  issueConsultExecutions,
  issueExecutionRefs,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { lockIssueExecutionRunRefMembershipInTransaction } from "./issue-execution-run-service.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";

type RefRow = typeof issueExecutionRefs.$inferSelect;
type ConsultRow = typeof issueConsultExecutions.$inferSelect;

export class IssueConsultChainInvalid extends Error {
  constructor(
    message: string,
    readonly reason: "invalid" | "cycle" | "depth",
  ) {
    super(message);
    this.name = "IssueConsultChainInvalid";
  }
}

export interface LockedIssueConsultChain {
  readonly chainToken: string;
  readonly agentIds: ReadonlySet<string>;
  readonly rootRef: RefRow;
}

function invalid(message: string): never {
  throw new IssueConsultChainInvalid(message, "invalid");
}

/**
 * Locks and revalidates every persisted consult edge back to its owner root.
 * The consult row, child ref, caller ref, and source-run membership must all
 * describe the same immutable edge. Mention refs additionally require every
 * ancestor run/ref to remain live while their synchronous call is in flight.
 */
export async function lockAndValidateIssueConsultChain(
  transaction: IssueSessionDbTransaction,
  input: {
    readonly ref: RefRow;
    readonly requireLiveAncestors: boolean;
    readonly leafState: "active" | "active_or_completed";
  },
): Promise<LockedIssueConsultChain> {
  const first = input.ref;
  const chainToken = first.consultChainToken ?? `consult_chain:${first.id}`;
  const seen = new Set<string>();
  const agentIds = new Set<string>();
  let cursorId: string | null = first.id;
  let rootRef: RefRow | null = null;

  for (let depth = 0; cursorId !== null && depth < 64; depth += 1) {
    const cursor: RefRow | null = await transaction
      .select()
      .from(issueExecutionRefs)
      .where(eq(issueExecutionRefs.id, cursorId))
      .limit(2)
      .for("update")
      .then((rows) => rows.length === 1 ? rows[0]! : null);
    if (
      !cursor ||
      cursor.companyId !== first.companyId ||
      cursor.issueId !== first.issueId ||
      cursor.sessionId !== first.sessionId ||
      cursor.ownershipEpoch !== first.ownershipEpoch ||
      cursor.executionLineageId !== first.executionLineageId ||
      cursor.disposition === "invalidated" ||
      (input.requireLiveAncestors && cursor.disposition !== "active")
    ) {
      invalid("consult caller chain left its immutable issue-execution scope");
    }
    if (seen.has(cursor.id)) {
      throw new IssueConsultChainInvalid(
        "consult caller chain contains a cycle",
        "cycle",
      );
    }
    seen.add(cursor.id);
    agentIds.add(cursor.targetAgentId);

    if (cursor.mode === "owner") {
      if (
        cursor.issueExecutionAuthorityId === null ||
        cursor.consultExecutionId !== null ||
        cursor.consultCallerRefId !== null ||
        cursor.consultChainToken !== null
      ) {
        invalid("consult caller chain has an invalid owner root");
      }
      rootRef = cursor;
      cursorId = null;
      break;
    }
    if (
      cursor.mode !== "consult" ||
      cursor.issueExecutionAuthorityId !== null ||
      cursor.consultExecutionId === null ||
      cursor.consultCallerRefId === null ||
      cursor.consultChainToken !== chainToken
    ) {
      invalid("consult caller ref has an incomplete immutable binding");
    }

    const consult: ConsultRow | null = await transaction
      .select()
      .from(issueConsultExecutions)
      .where(eq(issueConsultExecutions.id, cursor.consultExecutionId))
      .limit(2)
      .for("update")
      .then((rows) => rows.length === 1 ? rows[0]! : null);
    if (
      !consult ||
      consult.companyId !== cursor.companyId ||
      consult.issueId !== cursor.issueId ||
      consult.sessionId !== cursor.sessionId ||
      consult.ownershipEpoch !== cursor.ownershipEpoch ||
      consult.sourceRefId !== cursor.consultCallerRefId ||
      consult.targetAgentId !== cursor.targetAgentId ||
      consult.adapterConfigRevisionId !== cursor.adapterConfigRevisionId ||
      consult.chainToken !== cursor.consultChainToken ||
      (cursor.sourceKind === "consult_mention" &&
        cursor.sourceRecordId !== consult.id) ||
      (cursor.id === first.id &&
        (input.leafState === "active"
          ? consult.state !== "active"
          : consult.state !== "active" && consult.state !== "completed")) ||
      (input.requireLiveAncestors && consult.state !== "active") ||
      (!input.requireLiveAncestors && consult.state === "revoked")
    ) {
      invalid("consult execution diverged from its immutable child ref");
    }

    const caller: RefRow | null = await transaction
      .select()
      .from(issueExecutionRefs)
      .where(eq(issueExecutionRefs.id, consult.sourceRefId))
      .limit(2)
      .for("update")
      .then((rows) => rows.length === 1 ? rows[0]! : null);
    if (
      !caller ||
      caller.companyId !== cursor.companyId ||
      caller.issueId !== cursor.issueId ||
      caller.sessionId !== cursor.sessionId ||
      caller.ownershipEpoch !== cursor.ownershipEpoch ||
      caller.executionLineageId !== cursor.executionLineageId ||
      caller.executionScopeId !== consult.callerExecutionScopeId ||
      caller.disposition === "invalidated" ||
      (input.requireLiveAncestors && caller.disposition !== "active")
    ) {
      invalid("consult execution lost its exact caller scope");
    }

    const sourceRun = await lockIssueExecutionRunRefMembershipInTransaction(
      transaction,
      {
        companyId: caller.companyId,
        issueId: caller.issueId,
        runId: consult.sourceRunId,
        refId: caller.id,
      },
    );
    if (
      !sourceRun ||
      sourceRun.run.companyId !== caller.companyId ||
      sourceRun.run.issueId !== caller.issueId ||
      sourceRun.run.sessionId !== caller.sessionId ||
      sourceRun.run.ownershipEpoch !== caller.ownershipEpoch ||
      sourceRun.run.executionScopeId !== caller.executionScopeId ||
      sourceRun.run.targetAgentId !== caller.targetAgentId ||
      sourceRun.run.adapterConfigRevisionId !== caller.adapterConfigRevisionId ||
      sourceRun.run.executionMode !== caller.mode ||
      (caller.mode === "owner"
        ? sourceRun.run.issueExecutionAuthorityId !==
            caller.issueExecutionAuthorityId ||
          sourceRun.run.consultExecutionId !== null
        : sourceRun.run.issueExecutionAuthorityId !== null ||
          sourceRun.run.consultExecutionId !== caller.consultExecutionId) ||
      (input.requireLiveAncestors &&
        (sourceRun.run.status !== "running" ||
          sourceRun.currentRefId !== caller.id ||
          sourceRun.currentOrdinal !== sourceRun.refOrdinal))
    ) {
      invalid("consult execution lost its exact source-run membership");
    }
    cursorId = caller.id;
  }

  if (cursorId !== null || rootRef === null) {
    throw new IssueConsultChainInvalid(
      "consult caller chain exceeded its bounded depth",
      "depth",
    );
  }
  return Object.freeze({
    chainToken,
    agentIds: new Set(agentIds),
    rootRef,
  });
}
