import type { Db } from "@paperclipai/db";
import {
  LOW_TRUST_REVIEW_PRESET,
  type SourceTrustMetadata,
} from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { resolveProductiveRunLinkage } from "./productive-run-linkage.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";

export const LOW_TRUST_QUARANTINED_BODY =
  "[Quarantined low-trust output omitted from higher-trust agent context. A trusted reviewer can inspect and promote a sanitized artifact.]";

export type SourceTrustActor = {
  actorType: "agent" | "user";
  actorId: string;
  agentId: string | null;
  runId: string | null;
};

export type SourceTrustTaskContext = {
  id: string;
  companyId: string;
  executionPolicy?: unknown;
};

export function isLowTrustQuarantined(sourceTrust: SourceTrustMetadata | null | undefined): boolean {
  return sourceTrust?.preset === LOW_TRUST_REVIEW_PRESET && sourceTrust.disposition === "quarantined";
}

export function redactQuarantinedBodyForHigherTrust<T extends { body?: string | null; sourceTrust?: SourceTrustMetadata | null }>(
  value: T,
): T {
  if (!isLowTrustQuarantined(value.sourceTrust)) return value;
  return {
    ...value,
    body: LOW_TRUST_QUARANTINED_BODY,
  } as T;
}

export function sanitizeQuarantinedCommentForHigherTrust<
  T extends {
    body: string;
    presentation?: unknown;
    metadata?: unknown;
    sourceTrust?: SourceTrustMetadata | null;
  },
>(comment: T): T {
  if (!isLowTrustQuarantined(comment.sourceTrust)) return comment;
  return {
    ...comment,
    body: LOW_TRUST_QUARANTINED_BODY,
    presentation: null,
    metadata: null,
  };
}

export function buildLowTrustSourceTrust(input: {
  taskId: string;
  runId?: string | null;
  agentId?: string | null;
}): SourceTrustMetadata {
  return {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "quarantined",
    sourceTaskId: input.taskId,
    sourceRunId: input.runId ?? null,
    sourceAgentId: input.agentId ?? null,
  };
}

export function buildPromotedSourceTrust(input: {
  sourceTaskId: string;
  sourceArtifactKind: "comment" | "document" | "work_product" | "task";
  sourceArtifactId: string;
  promotedByActorType: "agent" | "user" | "system";
  promotedByActorId: string;
  promotedAt?: Date;
}): SourceTrustMetadata {
  return {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "promoted",
    sourceTaskId: input.sourceTaskId,
    promotedFrom: {
      artifactKind: input.sourceArtifactKind,
      artifactId: input.sourceArtifactId,
      taskId: input.sourceTaskId,
    },
    promotedByActorType: input.promotedByActorType,
    promotedByActorId: input.promotedByActorId,
    promotedAt: (input.promotedAt ?? new Date()).toISOString(),
  };
}

export async function resolveActorSourceTrustForTask(input: {
  db: Db;
  task: SourceTrustTaskContext;
  actor: SourceTrustActor;
}): Promise<SourceTrustMetadata | null> {
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;

  const runLinkage = input.actor.runId
    ? await resolveProductiveRunLinkage(input.db, {
        runId: input.actor.runId,
        companyId: input.task.companyId,
        agentId: input.actor.agentId,
      })
    : null;

  if (
    input.actor.runId
    && (!runLinkage || runLinkage.taskId !== input.task.id)
  ) {
    // Fail closed: only the exact persisted productive task execution can
    // establish the source run for an agent-authored write.
    return buildLowTrustSourceTrust({
      taskId: input.task.id,
      runId: input.actor.runId,
      agentId: input.actor.agentId,
    });
  }

  const resolution = resolveCoreTrustPreset({
    companyId: input.task.companyId,
    task: {
      companyId: input.task.companyId,
      executionPolicy: input.task.executionPolicy,
    },
    run: runLinkage
      ? {
          companyId: runLinkage.companyId,
          executionPolicy: runLinkage.taskExecutionPolicy,
        }
      : null,
  });

  if (resolution.kind === "denied") {
    throw forbidden(resolution.detail);
  }
  if (resolution.kind !== "low_trust_review") return null;
  return buildLowTrustSourceTrust({
    taskId: input.task.id,
    runId: input.actor.runId,
    agentId: input.actor.agentId,
  });
}
