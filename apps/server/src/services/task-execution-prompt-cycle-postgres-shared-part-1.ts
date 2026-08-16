import {
  taskExecutionAttempts,
  taskExecutionLeases,
  taskExecutionRefs,
  taskExecutionSessions,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { BudgetEnforcementScope } from "./budgets.js";
import type { AcpCorrelationScope, StoredAcpSessionCorrelation } from "./native-correlation.js";
import type { PostgresPromptCapabilityCompiler } from "./runtime-interface-compiler-db.js";
import {
  type TaskExecutionAttemptLease,
  type TaskExecutionPromptIdentity,
  TaskExecutionPromptAuthorityLost,
} from "./task-execution-attempt-executor.js";
import type { TaskExecutionRunService } from "./task-execution-run-service.js";
import { type TaskSessionDbTransaction } from "./task-session/event-store.js";

export const DEFAULT_CAPABILITY_TTL_MS = 60_000;

export const DEFAULT_LEASE_TTL_MS = 15 * 60_000;

export interface PostgresTaskExecutionPromptCycleOptions {
  readonly database: Db;
  readonly runService: Pick<TaskExecutionRunService, "lockRun">;
  readonly compiler: Pick<PostgresPromptCapabilityCompiler, "resolve">;
  readonly capabilityEndpoint: string;
  readonly idFactory?: () => string;
  readonly capabilityTtlMs?: number;
  readonly leaseTtlMs?: number;
  readonly suspendBudgetScopes?: (scopes: readonly BudgetEnforcementScope[]) => Promise<void>;
}

export class PostgresTaskExecutionPromptCycleRejected extends Error {
  readonly code = "postgres_task_execution_prompt_cycle_rejected";

  constructor(message: string) {
    super(message);
    this.name = "PostgresTaskExecutionPromptCycleRejected";
  }
}

export type AttemptRow = typeof taskExecutionAttempts.$inferSelect;

export type LeaseRow = typeof taskExecutionLeases.$inferSelect;

export type RefRow = typeof taskExecutionRefs.$inferSelect;

export type CorrelationRow = typeof taskExecutionSessions.$inferSelect;

export type InitialPromptCycleResolution =
  | { readonly kind: "singleton"; readonly freshSessionAllowed: boolean }
  | { readonly kind: "new" }
  | { readonly kind: "bootstrap_unavailable" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "bootstrap_resume";
      readonly correlation: CorrelationRow;
      readonly predecessor: {
        readonly runId: string;
        readonly refId: string;
        readonly refOrdinal: number;
      };
    };

export function reject(message: string): never {
  throw new PostgresTaskExecutionPromptCycleRejected(message);
}

export function rejectAuthorityLoss(lease: TaskExecutionAttemptLease, message: string): never {
  throw new TaskExecutionPromptAuthorityLost(lease, new PostgresTaskExecutionPromptCycleRejected(message));
}

export function exactlyOne<T>(rows: readonly T[], message: string): T {
  if (rows.length !== 1) reject(message);
  return rows[0]!;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export { deterministicUuid } from "./deterministic-uuid.js";

export function validDate(value: unknown, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    reject(`${label} is invalid`);
  }
  return value;
}

export async function transactionClockTimestamp(
  transaction: TaskSessionDbTransaction,
  label: string,
): Promise<Date> {
  const rows = Array.from(
    await transaction.execute(sql<{ timestampMs: number }>`
      select (extract(epoch from clock_timestamp()) * 1000)::double precision
        as "timestampMs"
    `),
  );
  return validDate(new Date(Number(rows[0]?.timestampMs)), label);
}

export function boundedReason(value: string, fallback: string): string {
  const normalized = value.trim().slice(0, 200);
  return normalized || fallback;
}

export function promptCompileScope(prompt: TaskExecutionPromptIdentity) {
  return {
    companyId: prompt.companyId,
    taskId: prompt.taskId,
    ownershipEpoch: prompt.ownershipEpoch,
    targetAgentId: prompt.targetAgentId,
    executionMode: prompt.laneKind,
    taskExecutionAuthorityId: prompt.taskExecutionAuthorityId,
    consultExecutionId: prompt.consultExecutionId,
    sessionId: prompt.sessionId,
    runId: prompt.runId,
    attemptId: prompt.attemptId,
    refId: prompt.refId,
    refOrdinal: prompt.refOrdinal,
    segmentOrdinal: prompt.segmentOrdinal,
  } as const;
}

export function sourceTextFromPrompt(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    reject("steering input lost its canonical prompt");
  }
  const prompt = value as Record<string, unknown>;
  if (
    typeof prompt.text !== "string" ||
    prompt.text.length === 0 ||
    (prompt.files !== undefined && (!Array.isArray(prompt.files) || prompt.files.length !== 0)) ||
    (prompt.agents !== undefined && (!Array.isArray(prompt.agents) || prompt.agents.length !== 0))
  ) {
    reject("steering input contains a non-text provider prompt");
  }
  return prompt.text;
}

export function scopeFromCorrelationRow(row: CorrelationRow): AcpCorrelationScope {
  const common = {
    companyId: row.companyId,
    taskId: row.taskId,
    ownershipEpoch: row.ownershipEpoch,
    targetAgentId: row.targetAgentId,
    adapterConfigIdentity: row.adapterConfigIdentity,
    workspaceIdentity: row.workspaceIdentity,
    targetFingerprint: row.targetFingerprint,
    correlationGeneration: row.correlationGeneration,
  } as const;
  if (row.purpose === "carry") {
    if (!row.laneKind || !row.authorizedContextExposureDigest) {
      reject("stored carry correlation has an invalid checked shape");
    }
    return {
      ...common,
      purpose: "carry",
      laneKind: row.laneKind,
      authorizedContextExposureDigest: row.authorizedContextExposureDigest,
    };
  }
  if (
    !row.runId ||
    !row.currentRefId ||
    row.currentRefOrdinal === null ||
    row.currentSegmentOrdinal === null
  ) {
    reject("stored steering correlation has an invalid checked shape");
  }
  return {
    ...common,
    purpose: "active_run_steering",
    runId: row.runId,
    currentRefId: row.currentRefId,
    currentRefOrdinal: row.currentRefOrdinal,
    currentSegmentOrdinal: row.currentSegmentOrdinal,
  };
}

export function storedCorrelation(row: CorrelationRow): StoredAcpSessionCorrelation {
  if (
    (row.purpose === "carry" && row.state !== "eligible") ||
    (row.purpose === "active_run_steering" && row.state !== "current")
  ) {
    reject("selected native correlation is not current for its purpose");
  }
  return {
    id: row.id,
    state: row.state as "eligible" | "current",
    scope: scopeFromCorrelationRow(row),
    envelopeVersion: row.envelopeVersion,
    codecKind: row.codecKind,
    ciphertext: row.protectedTargetSession,
    digest: row.protectedTargetSessionDigest,
  };
}

export async function selectCurrentCorrelation(
  transaction: TaskSessionDbTransaction,
  input: {
    readonly identity: TaskExecutionPromptIdentity;
    readonly carryContext: boolean;
    readonly effectiveContextExposureDigest: string;
    readonly targetFingerprint: string;
  },
): Promise<CorrelationRow | null> {
  const { identity } = input;
  const common = and(
    eq(taskExecutionSessions.companyId, identity.companyId),
    eq(taskExecutionSessions.taskId, identity.taskId),
    eq(taskExecutionSessions.ownershipEpoch, identity.ownershipEpoch),
    eq(taskExecutionSessions.targetAgentId, identity.targetAgentId),
    eq(taskExecutionSessions.adapterConfigIdentity, identity.adapterConfigRevisionId),
    eq(taskExecutionSessions.workspaceIdentity, identity.executionWorkspaceBindingId),
    eq(taskExecutionSessions.targetFingerprint, input.targetFingerprint),
  );
  const rows = input.carryContext
    ? await transaction
        .select()
        .from(taskExecutionSessions)
        .where(
          and(
            common,
            eq(taskExecutionSessions.purpose, "carry"),
            eq(taskExecutionSessions.state, "eligible"),
            eq(taskExecutionSessions.laneKind, identity.laneKind),
            eq(taskExecutionSessions.authorizedContextExposureDigest, input.effectiveContextExposureDigest),
          ),
        )
        .limit(2)
        .for("update")
    : await transaction
        .select()
        .from(taskExecutionSessions)
        .where(
          and(
            common,
            eq(taskExecutionSessions.purpose, "active_run_steering"),
            eq(taskExecutionSessions.state, "current"),
            eq(taskExecutionSessions.runId, identity.runId),
          ),
        )
        .limit(2)
        .for("update");
  if (rows.length > 1) reject("native correlation logical key is ambiguous");
  return rows[0] ?? null;
}
