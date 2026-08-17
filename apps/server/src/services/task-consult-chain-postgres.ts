import { taskConsultExecutions, taskExecutionRefs } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { lockTaskExecutionRunRefMembershipInTransaction } from "./task-execution-run-service.js";
import type { TaskSessionDbTransaction } from "./task-session/event-store.js";

type RefRow = typeof taskExecutionRefs.$inferSelect;
type ConsultRow = typeof taskConsultExecutions.$inferSelect;

export class TaskConsultChainInvalid extends Error {
  constructor(
    message: string,
    readonly reason: "invalid" | "cycle" | "depth",
  ) {
    super(message);
    this.name = "TaskConsultChainInvalid";
  }
}

export interface LockedTaskConsultChain {
  readonly chainToken: string;
  readonly agentIds: ReadonlySet<string>;
  readonly rootRef: RefRow;
}

function invalid(message: string): never {
  throw new TaskConsultChainInvalid(message, "invalid");
}

/**
 * Locks and revalidates every persisted consult edge back to its owner root.
 * The consult row, child ref, caller ref, and source-run membership must all
 * describe the same immutable edge. Mention refs additionally require every
 * ancestor run/ref to remain live while their synchronous call is in flight.
 */
export async function lockAndValidateTaskConsultChain(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly ref: RefRow;
    readonly requireLiveAncestors: boolean;
    readonly leafState: "active" | "active_or_completed";
  },
): Promise<LockedTaskConsultChain> {
  const first = input.ref;
  const chainToken = first.consultChainToken ?? `consult_chain:${first.id}`;
  const seen = new Set<string>();
  const agentIds = new Set<string>();
  let cursorId: string | null = first.id;
  let rootRef: RefRow | null = null;

  for (let depth = 0; cursorId !== null && depth < 64; depth += 1) {
    const cursor: RefRow | null = await transaction
      .select()
      .from(taskExecutionRefs)
      .where(eq(taskExecutionRefs.id, cursorId))
      .limit(2)
      .for("update")
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    if (
      !cursor ||
      cursor.companyId !== first.companyId ||
      cursor.taskId !== first.taskId ||
      cursor.sessionId !== first.sessionId ||
      cursor.ownershipEpoch !== first.ownershipEpoch ||
      cursor.executionLineageId !== first.executionLineageId ||
      cursor.disposition === "invalidated" ||
      (input.requireLiveAncestors && cursor.disposition !== "active")
    ) {
      invalid("consult caller chain left its immutable task-execution scope");
    }
    if (seen.has(cursor.id)) {
      throw new TaskConsultChainInvalid("consult caller chain contains a cycle", "cycle");
    }
    seen.add(cursor.id);
    agentIds.add(cursor.targetAgentId);

    if (cursor.mode === "owner") {
      if (
        cursor.taskExecutionAuthorityId === null ||
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
      cursor.taskExecutionAuthorityId !== null ||
      cursor.consultExecutionId === null ||
      cursor.consultCallerRefId === null ||
      cursor.consultChainToken !== chainToken
    ) {
      invalid("consult caller ref has an incomplete immutable binding");
    }

    const consult: ConsultRow | null = await transaction
      .select()
      .from(taskConsultExecutions)
      .where(eq(taskConsultExecutions.id, cursor.consultExecutionId))
      .limit(2)
      .for("update")
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    if (
      !consult ||
      consult.companyId !== cursor.companyId ||
      consult.taskId !== cursor.taskId ||
      consult.sessionId !== cursor.sessionId ||
      consult.ownershipEpoch !== cursor.ownershipEpoch ||
      consult.sourceRefId !== cursor.consultCallerRefId ||
      consult.targetAgentId !== cursor.targetAgentId ||
      consult.adapterConfigRevisionId !== cursor.adapterConfigRevisionId ||
      consult.chainToken !== cursor.consultChainToken ||
      cursor.sourceKind !== "mention_agent" ||
      cursor.sourceRecordId !== consult.id ||
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
      .from(taskExecutionRefs)
      .where(eq(taskExecutionRefs.id, consult.sourceRefId))
      .limit(2)
      .for("update")
      .then((rows) => (rows.length === 1 ? rows[0]! : null));
    if (
      !caller ||
      caller.companyId !== cursor.companyId ||
      caller.taskId !== cursor.taskId ||
      caller.sessionId !== cursor.sessionId ||
      caller.ownershipEpoch !== cursor.ownershipEpoch ||
      caller.executionLineageId !== cursor.executionLineageId ||
      caller.executionScopeId !== consult.callerExecutionScopeId ||
      caller.disposition === "invalidated" ||
      (input.requireLiveAncestors && caller.disposition !== "active")
    ) {
      invalid("consult execution lost its exact caller scope");
    }

    const sourceRun = await lockTaskExecutionRunRefMembershipInTransaction(transaction, {
      companyId: caller.companyId,
      taskId: caller.taskId,
      runId: consult.sourceRunId,
      refId: caller.id,
    });
    if (
      !sourceRun ||
      sourceRun.run.companyId !== caller.companyId ||
      sourceRun.run.taskId !== caller.taskId ||
      sourceRun.run.sessionId !== caller.sessionId ||
      sourceRun.run.ownershipEpoch !== caller.ownershipEpoch ||
      sourceRun.run.executionScopeId !== caller.executionScopeId ||
      sourceRun.run.targetAgentId !== caller.targetAgentId ||
      sourceRun.run.adapterConfigRevisionId !== caller.adapterConfigRevisionId ||
      sourceRun.run.executionMode !== caller.mode ||
      (caller.mode === "owner"
        ? sourceRun.run.taskExecutionAuthorityId !== caller.taskExecutionAuthorityId ||
          sourceRun.run.consultExecutionId !== null
        : sourceRun.run.taskExecutionAuthorityId !== null ||
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
    throw new TaskConsultChainInvalid("consult caller chain exceeded its bounded depth", "depth");
  }
  return Object.freeze({
    chainToken,
    agentIds: new Set(agentIds),
    rootRef,
  });
}
