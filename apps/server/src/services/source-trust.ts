import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
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

export type SourceTrustIssueContext = {
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
  issueId: string;
  runId?: string | null;
  agentId?: string | null;
}): SourceTrustMetadata {
  return {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "quarantined",
    sourceIssueId: input.issueId,
    sourceRunId: input.runId ?? null,
    sourceAgentId: input.agentId ?? null,
  };
}

export function buildPromotedSourceTrust(input: {
  sourceIssueId: string;
  sourceArtifactKind: "comment" | "document" | "work_product" | "issue";
  sourceArtifactId: string;
  promotedByActorType: "agent" | "user" | "system";
  promotedByActorId: string;
  promotedAt?: Date;
}): SourceTrustMetadata {
  return {
    preset: LOW_TRUST_REVIEW_PRESET,
    disposition: "promoted",
    sourceIssueId: input.sourceIssueId,
    promotedFrom: {
      artifactKind: input.sourceArtifactKind,
      artifactId: input.sourceArtifactId,
      issueId: input.sourceIssueId,
    },
    promotedByActorType: input.promotedByActorType,
    promotedByActorId: input.promotedByActorId,
    promotedAt: (input.promotedAt ?? new Date()).toISOString(),
  };
}

export async function resolveActorSourceTrustForIssue(input: {
  db: Db;
  issue: SourceTrustIssueContext;
  actor: SourceTrustActor;
}): Promise<SourceTrustMetadata | null> {
  if (input.actor.actorType !== "agent" || !input.actor.agentId) return null;

  const [agent, runLinkage] = await Promise.all([
    input.db
      .select({
        companyId: agents.companyId,
        permissions: agents.permissions,
      })
      .from(agents)
      .where(and(eq(agents.id, input.actor.agentId), eq(agents.companyId, input.issue.companyId)))
      .then((rows) => rows[0] ?? null),
    input.actor.runId
      ? resolveProductiveRunLinkage(input.db, {
          runId: input.actor.runId,
          companyId: input.issue.companyId,
          agentId: input.actor.agentId,
        })
      : Promise.resolve(null),
  ]);

  if (
    input.actor.runId
    && (!runLinkage || runLinkage.issueId !== input.issue.id)
  ) {
    // Fail closed: only the exact persisted productive issue execution can
    // establish the source run for an agent-authored write.
    return buildLowTrustSourceTrust({
      issueId: input.issue.id,
      runId: input.actor.runId,
      agentId: input.actor.agentId,
    });
  }

  const resolution = resolveCoreTrustPreset({
    companyId: input.issue.companyId,
    agent: agent
      ? { companyId: agent.companyId, governance: agent.permissions }
      : null,
    issue: {
      companyId: input.issue.companyId,
      executionPolicy: input.issue.executionPolicy,
    },
    run: runLinkage
      ? {
          companyId: runLinkage.companyId,
          executionPolicy: runLinkage.issueExecutionPolicy,
        }
      : null,
  });

  if (resolution.kind === "denied") {
    throw forbidden(resolution.detail);
  }
  if (resolution.kind !== "low_trust_review") return null;
  return buildLowTrustSourceTrust({
    issueId: input.issue.id,
    runId: input.actor.runId,
    agentId: input.actor.agentId,
  });
}
