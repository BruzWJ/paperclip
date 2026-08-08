import {
  issueExecutionAttempts,
  issueExecutionPromptCapabilities,
  type Db,
} from "@paperclipai/db";
import type { ProviderSafeRunTrace } from "@paperclipai/shared";
import { and, desc, eq, lt } from "drizzle-orm";
import type { ContextRetrievalService } from "./context-retrieval.js";
import { listPriorIssueExecutionRunIdsForAgent } from "./issue-execution-run-service.js";

/**
 * Exact durable identity from which recovery eligibility and prior run IDs
 * are derived. It is projected from an active prompt capability, never
 * stored as a second recovery mode.
 */
export interface RecoverySessionScope {
  readonly companyId: string;
  readonly issueId: string;
  readonly sessionId: string;
  readonly targetAgentId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly refId: string;
  readonly refOrdinal: number;
  readonly segmentOrdinal: number;
}

/** Ordered newest-first, exact-prompt attempt lineage. */
export interface RecoveryAttemptLineageEntry {
  readonly id: string;
  readonly attemptGeneration: number;
  readonly sessionOperation: "new" | "resume" | "steer_resume";
}

export interface RecoverySessionHistoryRepository {
  isTargetNotFoundReplacement(
    scope: RecoverySessionScope,
  ): Promise<boolean>;
  listPriorAgentRunIds(
    scope: RecoverySessionScope,
  ): Promise<readonly string[]>;
}

/** Exact read_issue_agent_run responses, one for every restored prior run. */
export interface RestoreSessionPage {
  readonly runs: readonly ProviderSafeRunTrace[];
}

export class RestoreSessionUnavailable extends Error {
  readonly code = "restore_session_unavailable";

  constructor() {
    super("Requested run is not available for this recovery bootstrap");
    this.name = "RestoreSessionUnavailable";
  }
}

export async function isTargetNotFoundReplacement(
  repository: Pick<
    RecoverySessionHistoryRepository,
    "isTargetNotFoundReplacement"
  >,
  scope: RecoverySessionScope | undefined,
): Promise<boolean> {
  return scope !== undefined &&
    await repository.isTargetNotFoundReplacement(scope);
}

/**
 * Finds the resume ancestor of a contiguous `new` retry chain. Pre-send
 * retries preserve `new`, so no recovery flag or lifecycle row is needed.
 */
export function recoveryAncestorAttemptId(
  currentGeneration: number,
  priorAttempts: readonly RecoveryAttemptLineageEntry[],
): string | null {
  let expectedGeneration = currentGeneration - 1;
  for (const attempt of priorAttempts) {
    if (attempt.attemptGeneration !== expectedGeneration) return null;
    expectedGeneration -= 1;
    if (attempt.sessionOperation === "new") continue;
    return attempt.sessionOperation === "resume" ||
      attempt.sessionOperation === "steer_resume"
      ? attempt.id
      : null;
  }
  return null;
}

/**
 * Recovery is only a thin enumeration layer: the detailed message/tool/turn
 * projection is the exact read_issue_agent_run implementation.
 */
export function createRecoverySessionHistoryReader(options: {
  readonly repository: Pick<
    RecoverySessionHistoryRepository,
    "listPriorAgentRunIds"
  >;
  readonly runTrace: Pick<
    ContextRetrievalService,
    "readCanonicalAgentRunTrace"
  >;
}) {
  return {
    async restore(input: {
      readonly capability: RecoverySessionScope;
      readonly runId?: string;
      readonly cursor?: string | null;
    }): Promise<RestoreSessionPage> {
      const scope = input.capability;
      const runIds = await options.repository.listPriorAgentRunIds(scope);
      const selectedRunIds = input.runId === undefined
        ? runIds
        : runIds.includes(input.runId)
          ? [input.runId]
          : null;
      if (selectedRunIds === null) throw new RestoreSessionUnavailable();
      return {
        runs: await Promise.all(
          selectedRunIds.map((runId) =>
            options.runTrace.readCanonicalAgentRunTrace({
              companyId: scope.companyId,
              runId,
              ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
            })
          ),
        ),
      };
    },
  };
}

/**
 * The durable proof for a replacement is a preceding resume/steer-resume
 * capability revoked as target missing. It is checked while compiling the
 * descriptor for every tools/list and tools/call request.
 */
export function createPostgresRecoverySessionHistoryRepository(
  db: Db,
): RecoverySessionHistoryRepository {
  return {
    async isTargetNotFoundReplacement(scope) {
      const current = await db
        .select({
          attemptGeneration: issueExecutionAttempts.attemptGeneration,
          promptKind: issueExecutionAttempts.promptKind,
        })
        .from(issueExecutionAttempts)
        .where(
          and(
            eq(issueExecutionAttempts.id, scope.attemptId),
            eq(issueExecutionAttempts.companyId, scope.companyId),
            eq(issueExecutionAttempts.issueId, scope.issueId),
            eq(issueExecutionAttempts.sessionId, scope.sessionId),
            eq(issueExecutionAttempts.runId, scope.runId),
            eq(issueExecutionAttempts.refId, scope.refId),
            eq(issueExecutionAttempts.refOrdinal, scope.refOrdinal),
            eq(issueExecutionAttempts.segmentOrdinal, scope.segmentOrdinal),
            eq(issueExecutionAttempts.sessionOperation, "new"),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !current ||
        !Number.isSafeInteger(current.attemptGeneration) ||
        current.attemptGeneration <= 1 ||
        (current.promptKind !== "base" && current.promptKind !== "steering")
      ) {
        return false;
      }
      const priorAttempts = await db
        .select({
          id: issueExecutionAttempts.id,
          attemptGeneration: issueExecutionAttempts.attemptGeneration,
          sessionOperation: issueExecutionAttempts.sessionOperation,
        })
        .from(issueExecutionAttempts)
        .where(
          and(
            eq(issueExecutionAttempts.companyId, scope.companyId),
            eq(issueExecutionAttempts.issueId, scope.issueId),
            eq(issueExecutionAttempts.sessionId, scope.sessionId),
            eq(issueExecutionAttempts.runId, scope.runId),
            eq(issueExecutionAttempts.refId, scope.refId),
            eq(issueExecutionAttempts.refOrdinal, scope.refOrdinal),
            eq(issueExecutionAttempts.segmentOrdinal, scope.segmentOrdinal),
            lt(
              issueExecutionAttempts.attemptGeneration,
              current.attemptGeneration,
            ),
          ),
        )
        .orderBy(desc(issueExecutionAttempts.attemptGeneration));
      const ancestorId = recoveryAncestorAttemptId(
        current.attemptGeneration,
        priorAttempts,
      );
      if (!ancestorId) return false;
      const predecessor = await db
        .select({ attemptId: issueExecutionPromptCapabilities.attemptId })
        .from(issueExecutionPromptCapabilities)
        .where(
          and(
            eq(
              issueExecutionPromptCapabilities.companyId,
              scope.companyId,
            ),
            eq(issueExecutionPromptCapabilities.attemptId, ancestorId),
            eq(issueExecutionPromptCapabilities.state, "revoked"),
            eq(
              issueExecutionPromptCapabilities.revocationReason,
              "target_not_found",
            ),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      return predecessor !== null;
    },

    async listPriorAgentRunIds(scope) {
      return listPriorIssueExecutionRunIdsForAgent(db, scope);
    },
  };
}
