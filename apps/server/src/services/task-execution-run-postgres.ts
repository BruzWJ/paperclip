import {
  type Db,
  taskCommentProjectionSources,
  taskExecutionAttempts,
  taskExecutionCancellationIntents,
  taskExecutionLeases,
  taskExecutionPromptSegments,
} from "@paperclipai/db";
import { createPostgresTaskExecutionSteeringRepositoryPart1 } from "./task-execution-run-postgres-part-1.js";
import { createPostgresTaskExecutionSteeringRepositoryPart2 } from "./task-execution-run-postgres-part-2.js";
import { createPostgresTaskExecutionSteeringRepositoryPart3 } from "./task-execution-run-postgres-part-3.js";
import {
  type CreatePostgresTaskExecutionSteeringRepositoryResult,
  type PostgresTaskExecutionSteeringRepositoryOptions,
  boundedPositiveInteger,
} from "./task-execution-run-postgres-shared-part-1.js";
import type { TaskExecutionSteeringRepository } from "./task-execution-run-service.js";

import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";

export function createPostgresTaskExecutionSteeringRepositoryPart4(
  db: Db,
  options: PostgresTaskExecutionSteeringRepositoryOptions = {},
) {
  const clock = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const settlementTimeoutMs = boundedPositiveInteger(
    options.settlementTimeoutMs,
    30000,
    "steering settlement timeout",
  );
  const settlementPollIntervalMs = boundedPositiveInteger(
    options.settlementPollIntervalMs,
    25,
    "steering settlement poll interval",
  );
  const wait =
    options.wait ??
    ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  return {
    async listRecoverableSources(limit) {
      const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit)));
      const rows = await db
        .select({
          companyId: taskCommentProjectionSources.companyId,
          taskId: taskCommentProjectionSources.taskId,
          sourceCommentId: taskCommentProjectionSources.commentId,
        })
        .from(taskCommentProjectionSources)
        .innerJoin(
          taskExecutionPromptSegments,
          and(
            eq(taskExecutionPromptSegments.runId, taskCommentProjectionSources.steeringTargetRunId),
            eq(taskExecutionPromptSegments.refId, taskCommentProjectionSources.refId),
            eq(taskExecutionPromptSegments.refOrdinal, taskCommentProjectionSources.refOrdinal),
            eq(taskExecutionPromptSegments.segmentOrdinal, taskCommentProjectionSources.segmentOrdinal),
            eq(taskExecutionPromptSegments.sourceCommentId, taskCommentProjectionSources.commentId),
          ),
        )
        .innerJoin(
          taskExecutionCancellationIntents,
          eq(taskExecutionCancellationIntents.id, taskExecutionPromptSegments.cancellationIntentId),
        )
        .innerJoin(
          taskExecutionAttempts,
          and(
            eq(taskExecutionAttempts.id, taskExecutionCancellationIntents.attemptId),
            eq(taskExecutionAttempts.runId, taskExecutionPromptSegments.runId),
          ),
        )
        .innerJoin(
          taskExecutionLeases,
          and(
            eq(taskExecutionLeases.id, taskExecutionCancellationIntents.leaseId),
            eq(taskExecutionLeases.attemptId, taskExecutionAttempts.id),
          ),
        )
        .where(
          and(
            inArray(taskCommentProjectionSources.sourceKind, ["human_comment", "harness_delivery"]),
            sql`${taskExecutionPromptSegments.protocolSettlementState} is null`,
            inArray(taskExecutionPromptSegments.steeringState, [
              "requested",
              "sent",
              "protocol_settled",
              "rebound",
            ]),
            eq(taskExecutionCancellationIntents.reasonKind, "steering"),
            inArray(taskExecutionCancellationIntents.state, ["requested", "acknowledged", "completed"]),
            or(
              eq(taskExecutionPromptSegments.steeringState, "rebound"),
              and(
                inArray(taskExecutionAttempts.state, ["settled", "cancelled", "failed"]),
                ne(taskExecutionLeases.state, "active"),
              ),
            ),
          ),
        )
        .orderBy(
          taskExecutionPromptSegments.createdAt,
          taskExecutionPromptSegments.runId,
          taskExecutionPromptSegments.segmentOrdinal,
        )
        .limit(boundedLimit);
      return Object.freeze(rows.map((row) => Object.freeze(row)));
    },
  } satisfies Partial<CreatePostgresTaskExecutionSteeringRepositoryResult>;
}

export type {
  CreatePostgresTaskExecutionSteeringRepositoryResult,
  PostgresTaskExecutionSteeringRepositoryOptions,
} from "./task-execution-run-postgres-shared-part-1.js";
export function createPostgresTaskExecutionSteeringRepository(
  db: Db,
  options: PostgresTaskExecutionSteeringRepositoryOptions = {},
): TaskExecutionSteeringRepository {
  return {
    ...createPostgresTaskExecutionSteeringRepositoryPart1(db, options),
    ...createPostgresTaskExecutionSteeringRepositoryPart2(db, options),
    ...createPostgresTaskExecutionSteeringRepositoryPart3(db, options),
    ...createPostgresTaskExecutionSteeringRepositoryPart4(db, options),
  } as CreatePostgresTaskExecutionSteeringRepositoryResult;
}
