import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  companySkills,
  costEvents,
  documentRevisions,
  documents,
  feedbackExports,
  feedbackVotes,
  instanceSettings,
  issueComments,
  issueDocuments,
  issues,
} from "@paperclipai/db";
import {
  canonicalizeMoneyAmount,
  DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION,
  instanceGeneralSettingsSchema,
  type FeedbackTargetType,
  type FeedbackTraceBundle,
  type FeedbackTraceBundleCaptureStatus,
  type FeedbackTraceBundleFile,
  type FeedbackTrace,
  type FeedbackTraceStatus,
  type FeedbackTraceTargetSummary,
  type FeedbackVoteValue,
} from "@paperclipai/shared";
import { notFound, unprocessable } from "../errors.js";
import {
  createFeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
  sha256Digest,
} from "./feedback-redaction.js";
import { createContextRetrievalDbRepository } from "./context-retrieval-db.js";
import { companySkillPinsForAgent } from "./runtime-skill-selections.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import {
  resolveIssueExecutionRunIdentityById,
  type IssueExecutionRunService,
} from "./issue-execution-run-service.js";

const FEEDBACK_SCHEMA_VERSION = "paperclip-feedback-envelope-v2";
const FEEDBACK_BUNDLE_VERSION = "paperclip-feedback-bundle-v2";
const FEEDBACK_PAYLOAD_VERSION = "paperclip-feedback-v1";
const FEEDBACK_DESTINATION = "paperclip_labs_feedback_v1";
const FEEDBACK_CONTEXT_WINDOW = 3;
const MAX_EXCERPT_CHARS = 200;
const MAX_PRIMARY_CONTENT_CHARS = 8_000;
const MAX_CONTEXT_ITEM_BODY_CHARS = 3_000;
const MAX_TOTAL_CONTEXT_CHARS = 12_000;
const MAX_DESCRIPTION_CHARS = 1_200;
const MAX_PATH_CHARS = 600;
const MAX_SKILLS = 20;
const MAX_TRACE_FILE_CHARS = 10_000_000;
const DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY = "default";
const FEEDBACK_EXPORT_BACKEND_NOT_CONFIGURED = "Feedback export backend is not configured";

type FeedbackTraceRow = typeof feedbackExports.$inferSelect & {
  issueIdentifier: string | null;
  issueTitle: string | null;
};

type PendingFeedbackExportRow = typeof feedbackExports.$inferSelect;

type IssueFeedbackContext = {
  id: string;
  companyId: string;
  projectId: string | null;
  identifier: string | null;
  title: string | null;
  request: string | null;
};

type FeedbackTargetRecord = {
  targetType: FeedbackTargetType;
  targetId: string;
  label: string;
  body: string;
  createdAt: Date;
  authorAgentId: string | null;
  authorUserId: string | null;
  authorType?: string | null;
  presentation?: unknown;
  metadata?: unknown;
  createdByRunId: string | null;
  documentId: string | null;
  documentKey: string | null;
  documentTitle: string | null;
  revisionNumber: number | null;
  issuePath: string | null;
  targetPath: string | null;
};

type ResolvedFeedbackTarget = FeedbackTargetRecord & {
  payloadTarget: Record<string, unknown>;
};

const feedbackExportColumns = getTableColumns(feedbackExports);

type FeedbackTraceShareClient = {
  uploadTraceBundle(bundle: FeedbackTraceBundle): Promise<{ objectKey: string }>;
};

type FeedbackServiceOptions = {
  shareClient?: FeedbackTraceShareClient;
  runService?: Pick<
    IssueExecutionRunService,
    "readRun" | "readJoinedRunDetail"
  >;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateExcerpt(text: string, max = MAX_EXCERPT_CHARS) {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

function normalizeInstanceGeneralSettings(raw: unknown) {
  const parsed = instanceGeneralSettingsSchema.safeParse(raw ?? {});
  if (parsed.success) return parsed.data;
  return {
    censorUsernameInLogs: false,
    feedbackDataSharingPreference: DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  };
}

function buildIssuePath(identifier: string | null) {
  if (!identifier) return null;
  const prefix = identifier.split("-")[0]?.trim();
  if (!prefix) return null;
  return `/${prefix}/issues/${identifier}`;
}

function buildTargetSummary(input: {
  label: string;
  excerpt: string | null;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdAt: Date | null;
  documentKey?: string | null;
  documentTitle?: string | null;
  revisionNumber?: number | null;
}): FeedbackTraceTargetSummary {
  return {
    label: input.label,
    excerpt: input.excerpt,
    authorAgentId: input.authorAgentId,
    authorUserId: input.authorUserId,
    createdAt: input.createdAt,
    documentKey: input.documentKey ?? null,
    documentTitle: input.documentTitle ?? null,
    revisionNumber: input.revisionNumber ?? null,
  };
}

function normalizeReason(vote: FeedbackVoteValue, reason: string | null | undefined) {
  if (vote !== "down" || typeof reason !== "string") return null;
  const trimmed = reason.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSkillReference(value: string) {
  return value.trim().toLowerCase();
}

function matchesSkillReference(
  skill: typeof companySkills.$inferSelect,
  reference: string,
) {
  const normalized = normalizeSkillReference(reference);
  if (!normalized) return false;
  if (skill.key.toLowerCase() === normalized) return true;
  if (skill.slug.toLowerCase() === normalized) return true;
  if (skill.name.toLowerCase() === normalized) return true;
  const keyTail = skill.key.split("/").pop()?.toLowerCase();
  return keyTail === normalized;
}

function buildExportId(feedbackVoteId: string, sharedAt: Date) {
  return `fbexp_${sha256Digest(`${feedbackVoteId}:${sharedAt.toISOString()}`).slice(0, 24)}`;
}

function resolveSourceRunId(payloadSnapshot: Record<string, unknown> | null) {
  const targetRunId = asString(asRecord(payloadSnapshot?.target)?.createdByRunId);
  if (targetRunId) return targetRunId;

  const bundle = asRecord(payloadSnapshot?.bundle);
  const agentContext = asRecord(bundle?.agentContext);
  const runtime = asRecord(agentContext?.runtime);
  return asString(asRecord(runtime?.sourceRun)?.id);
}

function makeBundleFile(input: {
  path: string;
  contentType: string;
  source: FeedbackTraceBundleFile["source"];
  contents: string;
}) {
  return {
    path: input.path,
    contentType: input.contentType,
    encoding: "utf8" as const,
    byteLength: Buffer.byteLength(input.contents, "utf8"),
    sha256: sha256Digest(input.contents),
    source: input.source,
    contents: input.contents,
  } satisfies FeedbackTraceBundleFile;
}

function appendNote(notes: string[], note: string) {
  if (note.trim().length === 0 || notes.includes(note)) return;
  notes.push(note);
}

function captureStatusFromFiles(files: FeedbackTraceBundleFile[]): FeedbackTraceBundleCaptureStatus {
  return files.length > 0 ? "partial" : "unavailable";
}

function truncateFailureReason(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim().slice(0, 1_000) || "Feedback export failed";
}

function mapTraceRow(row: FeedbackTraceRow, includePayload: boolean): FeedbackTrace {
  const targetSummary = asRecord(row.targetSummary) as unknown as FeedbackTraceTargetSummary | null;
  return {
    id: row.id,
    companyId: row.companyId,
    feedbackVoteId: row.feedbackVoteId,
    issueId: row.issueId,
    projectId: row.projectId ?? null,
    issueIdentifier: row.issueIdentifier,
    issueTitle: row.issueTitle,
    authorUserId: row.authorUserId,
    targetType: row.targetType as FeedbackTargetType,
    targetId: row.targetId,
    vote: row.vote as FeedbackVoteValue,
    status: row.status as FeedbackTraceStatus,
    destination: row.destination ?? null,
    exportId: row.exportId ?? null,
    consentVersion: row.consentVersion ?? null,
    schemaVersion: row.schemaVersion,
    bundleVersion: row.bundleVersion,
    payloadVersion: row.payloadVersion,
    payloadDigest: row.payloadDigest ?? null,
    payloadSnapshot: includePayload ? asRecord(row.payloadSnapshot) : null,
    targetSummary: targetSummary ?? buildTargetSummary({
      label: row.targetType,
      excerpt: null,
      authorAgentId: null,
      authorUserId: null,
      createdAt: null,
    }),
    redactionSummary: asRecord(row.redactionSummary),
    attemptCount: row.attemptCount,
    lastAttemptedAt: row.lastAttemptedAt ?? null,
    exportedAt: row.exportedAt ?? null,
    failureReason: row.failureReason ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

async function resolveFeedbackTarget(
  db: Pick<Db, "select">,
  issue: IssueFeedbackContext,
  targetType: FeedbackTargetType,
  targetId: string,
): Promise<ResolvedFeedbackTarget> {
  const issuePath = buildIssuePath(issue.identifier);

  if (targetType === "issue_comment") {
    const targetComment = await db
      .select({
        id: issueComments.id,
        issueId: issueComments.issueId,
        companyId: issueComments.companyId,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorType: issueComments.authorType,
        presentation: issueComments.presentation,
        metadata: issueComments.metadata,
        createdByRunId: issueComments.runId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.id, targetId))
      .then((rows) => rows[0] ?? null);

    if (!targetComment || targetComment.issueId !== issue.id || targetComment.companyId !== issue.companyId) {
      throw notFound("Feedback target not found");
    }
    if (!targetComment.authorAgentId) {
      throw unprocessable("Feedback voting is only available on agent-authored issue comments");
    }

    const record: ResolvedFeedbackTarget = {
      targetType,
      targetId,
      label: "Comment",
      body: targetComment.body,
      createdAt: targetComment.createdAt,
      authorAgentId: targetComment.authorAgentId,
      authorUserId: targetComment.authorUserId,
      authorType: targetComment.authorType ?? (targetComment.authorAgentId ? "agent" : targetComment.authorUserId ? "user" : "system"),
      presentation: targetComment.presentation ?? null,
      metadata: targetComment.metadata ?? null,
      createdByRunId: targetComment.createdByRunId ?? null,
      documentId: null,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
      issuePath,
      targetPath: issuePath ? `${issuePath}#comment-${targetComment.id}` : null,
      payloadTarget: {
        type: targetType,
        id: targetComment.id,
        createdAt: targetComment.createdAt.toISOString(),
        authorAgentId: targetComment.authorAgentId,
        authorUserId: targetComment.authorUserId,
        authorType: targetComment.authorType ?? (targetComment.authorAgentId ? "agent" : targetComment.authorUserId ? "user" : "system"),
        presentation: targetComment.presentation ?? null,
        metadata: targetComment.metadata ?? null,
        createdByRunId: targetComment.createdByRunId ?? null,
        issuePath,
        targetPath: issuePath ? `${issuePath}#comment-${targetComment.id}` : null,
      },
    };
    return record;
  }

  if (targetType === "issue_document_revision") {
    const targetRevision = await db
      .select({
        id: documentRevisions.id,
        companyId: documentRevisions.companyId,
        documentId: documentRevisions.documentId,
        revisionNumber: documentRevisions.revisionNumber,
        body: documentRevisions.body,
        createdByAgentId: documentRevisions.createdByAgentId,
        createdByUserId: documentRevisions.createdByUserId,
        createdByRunId: documentRevisions.createdByRunId,
        createdAt: documentRevisions.createdAt,
        issueId: issueDocuments.issueId,
        key: issueDocuments.key,
        title: documents.title,
      })
      .from(documentRevisions)
      .innerJoin(documents, eq(documentRevisions.documentId, documents.id))
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documents.id))
      .where(eq(documentRevisions.id, targetId))
      .then((rows) => rows.find((row) => row.issueId === issue.id) ?? null);

    if (!targetRevision || targetRevision.companyId !== issue.companyId) {
      throw notFound("Feedback target not found");
    }
    if (!targetRevision.createdByAgentId) {
      throw unprocessable("Feedback voting is only available on agent-authored document revisions");
    }

    const record: ResolvedFeedbackTarget = {
      targetType,
      targetId,
      label: `${targetRevision.key} rev ${targetRevision.revisionNumber}`,
      body: targetRevision.body,
      createdAt: targetRevision.createdAt,
      authorAgentId: targetRevision.createdByAgentId,
      authorUserId: targetRevision.createdByUserId,
      createdByRunId: targetRevision.createdByRunId ?? null,
      documentId: targetRevision.documentId,
      documentKey: targetRevision.key,
      documentTitle: targetRevision.title ?? null,
      revisionNumber: targetRevision.revisionNumber,
      issuePath,
      targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(targetRevision.key)}` : null,
      payloadTarget: {
        type: targetType,
        id: targetRevision.id,
        documentId: targetRevision.documentId,
        documentKey: targetRevision.key,
        documentTitle: targetRevision.title ?? null,
        revisionNumber: targetRevision.revisionNumber,
        createdAt: targetRevision.createdAt.toISOString(),
        authorAgentId: targetRevision.createdByAgentId,
        authorUserId: targetRevision.createdByUserId,
        createdByRunId: targetRevision.createdByRunId ?? null,
        issuePath,
        targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(targetRevision.key)}` : null,
      },
    };
    return record;
  }

  throw unprocessable("Unsupported feedback target type");
}

async function listIssueContextItems(
  db: Pick<Db, "select">,
  issue: IssueFeedbackContext,
) {
  const [commentRows, revisionRows] = await Promise.all([
    db
      .select({
        targetId: issueComments.id,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorType: issueComments.authorType,
        presentation: issueComments.presentation,
        metadata: issueComments.metadata,
        createdByRunId: issueComments.runId,
      })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, issue.companyId),
        eq(issueComments.issueId, issue.id),
      )),
    db
      .select({
        targetId: documentRevisions.id,
        body: documentRevisions.body,
        createdAt: documentRevisions.createdAt,
        authorAgentId: documentRevisions.createdByAgentId,
        authorUserId: documentRevisions.createdByUserId,
        createdByRunId: documentRevisions.createdByRunId,
        documentId: documentRevisions.documentId,
        documentKey: issueDocuments.key,
        documentTitle: documents.title,
        revisionNumber: documentRevisions.revisionNumber,
      })
      .from(documentRevisions)
      .innerJoin(documents, eq(documentRevisions.documentId, documents.id))
      .innerJoin(issueDocuments, eq(issueDocuments.documentId, documents.id))
      .where(and(eq(documentRevisions.companyId, issue.companyId), eq(issueDocuments.issueId, issue.id))),
  ]);

  const issuePath = buildIssuePath(issue.identifier);

  const items: FeedbackTargetRecord[] = [
    ...commentRows.map((row) => ({
      targetType: "issue_comment" as const,
      targetId: row.targetId,
      label: "Comment",
      body: row.body,
      createdAt: row.createdAt,
      authorAgentId: row.authorAgentId,
      authorUserId: row.authorUserId,
      authorType: row.authorType ?? (row.authorAgentId ? "agent" : row.authorUserId ? "user" : "system"),
      presentation: row.presentation ?? null,
      metadata: row.metadata ?? null,
      createdByRunId: row.createdByRunId ?? null,
      documentId: null,
      documentKey: null,
      documentTitle: null,
      revisionNumber: null,
      issuePath,
      targetPath: issuePath ? `${issuePath}#comment-${row.targetId}` : null,
    })),
    ...revisionRows.map((row) => ({
      targetType: "issue_document_revision" as const,
      targetId: row.targetId,
      label: `${row.documentKey} rev ${row.revisionNumber}`,
      body: row.body,
      createdAt: row.createdAt,
      authorAgentId: row.authorAgentId,
      authorUserId: row.authorUserId,
      createdByRunId: row.createdByRunId ?? null,
      documentId: row.documentId,
      documentKey: row.documentKey,
      documentTitle: row.documentTitle ?? null,
      revisionNumber: row.revisionNumber,
      issuePath,
      targetPath: issuePath ? `${issuePath}#document-${encodeURIComponent(row.documentKey)}` : null,
    })),
  ];

  return items.sort((left, right) => {
    const byDate = left.createdAt.getTime() - right.createdAt.getTime();
    if (byDate !== 0) return byDate;
    return left.targetId.localeCompare(right.targetId);
  });
}

async function buildIssueContext(
  db: Pick<Db, "select">,
  issue: IssueFeedbackContext,
  target: ResolvedFeedbackTarget,
  state: ReturnType<typeof createFeedbackRedactionState>,
) {
  const items = await listIssueContextItems(db, issue);
  const targetIndex = items.findIndex((item) => item.targetType === target.targetType && item.targetId === target.targetId);
  const before = targetIndex >= 0
    ? items.slice(Math.max(0, targetIndex - FEEDBACK_CONTEXT_WINDOW), targetIndex)
    : [];
  const after = targetIndex >= 0
    ? items.slice(targetIndex + 1, targetIndex + 1 + FEEDBACK_CONTEXT_WINDOW)
    : [];

  let remainingChars = MAX_TOTAL_CONTEXT_CHARS;
  const serializedItems = [...before, ...after].map((item, index) => {
    const relation = index < before.length ? "before" : "after";
    if (remainingChars <= 0) {
      state.omittedFields.add("bundle.issueContext.items");
      return null;
    }
    const maxChars = Math.min(MAX_CONTEXT_ITEM_BODY_CHARS, remainingChars);
    const body = sanitizeFeedbackText(
      item.body,
      state,
      `bundle.issueContext.items.${index}.body`,
      maxChars,
    );
    remainingChars -= body.length;
    return {
      type: item.targetType,
      id: item.targetId,
      label: item.label,
      relation,
      createdAt: item.createdAt.toISOString(),
      authorAgentId: item.authorAgentId,
      authorUserId: item.authorUserId,
      authorType: item.authorType ?? null,
      presentation: item.presentation ?? null,
      metadata: item.metadata ?? null,
      createdByRunId: item.createdByRunId,
      documentKey: item.documentKey,
      documentTitle: item.documentTitle,
      revisionNumber: item.revisionNumber,
      targetPath: item.targetPath,
      body,
      excerpt: truncateExcerpt(body),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== null);

  const requestExcerpt = issue.request
    ? sanitizeFeedbackText(issue.request, state, "bundle.issueContext.issue.request", MAX_DESCRIPTION_CHARS)
    : null;

  return {
    issue: {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      projectId: issue.projectId,
      path: buildIssuePath(issue.identifier),
      requestExcerpt: requestExcerpt ? truncateExcerpt(requestExcerpt, MAX_DESCRIPTION_CHARS) : null,
    },
    items: serializedItems,
  };
}

async function buildAgentContext(
  db: Db | IssueSessionDbTransaction,
  companyId: string,
  authorAgentId: string | null,
  createdByRunId: string | null,
  state: ReturnType<typeof createFeedbackRedactionState>,
  runService?: Pick<IssueExecutionRunService, "readRun">,
) {
  if (!authorAgentId) {
    state.notes.add("author_agent_missing");
    return null;
  }

  const agent = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      title: agents.title,
      status: agents.status,
      adapterType: agents.adapterType,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.id, authorAgentId))
    .then((rows) => rows[0] ?? null);

  if (!agent || agent.companyId !== companyId) {
    state.notes.add("author_agent_unavailable");
    return null;
  }

  const adapterConfig = asRecord(agent.adapterConfig) ?? {};
  const selectionRows = await companySkillPinsForAgent(
    db,
    companyId,
    authorAgentId,
  );
  const selectedRows = selectionRows.slice(0, MAX_SKILLS);
  const desiredSkillRefs = selectedRows.map((selection) => selection.key);
  const availableSkills = selectedRows.length === 0
    ? []
    : await db
      .select()
      .from(companySkills)
      .where(
        and(
          eq(companySkills.companyId, companyId),
          inArray(
            companySkills.key,
            selectedRows.map((selection) => selection.key),
          ),
        ),
      );
  const matchedSkills = availableSkills
    .filter((skill) => desiredSkillRefs.some((reference) => matchesSkillReference(skill, reference)))
    .slice(0, MAX_SKILLS);
  const unresolvedSkillRefs = desiredSkillRefs.filter(
    (reference) => !matchedSkills.some((skill) => matchesSkillReference(skill, reference)),
  );

  if (selectionRows.length > MAX_SKILLS) {
    state.omittedFields.add("bundle.agentContext.skills");
  }

  const runIdentity = createdByRunId
    ? await resolveIssueExecutionRunIdentityById(db, createdByRunId)
    : null;
  const run = runIdentity?.companyId === companyId && runService
    ? await runService.readRun(runIdentity)
    : null;
  const runCost = run
    ? await db
      .select({
        budgetCurrency: costEvents.budgetCurrency,
        knownCostAmount:
          sql<string>`coalesce(sum(${costEvents.knownDeltaAmount}) filter (where ${costEvents.kind} = 'known'), 0)::text`,
        pricedPromptCount:
          sql<number>`count(*) filter (where ${costEvents.kind} = 'known')::int`,
        unpricedPromptCount:
          sql<number>`count(*) filter (where ${costEvents.kind} = 'unavailable')::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.companyId, companyId), eq(costEvents.runId, run.runId)))
      .groupBy(costEvents.budgetCurrency)
      .then((rows) => rows[0] ?? null)
    : null;

  const runtime = {
    configuredModel: asString(adapterConfig.model),
    provenanceMode: run ? "source_run" : "vote_time_snapshot",
    sourceRun: run
      ? sanitizeFeedbackValue({
        id: run.runId,
        kind: run.kind,
        status: run.status,
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      }, state, "bundle.agentContext.runtime.sourceRun", 400)
      : null,
    costSummary: runCost
      ? {
        budgetCurrency: runCost.budgetCurrency,
        knownCostAmount: canonicalizeMoneyAmount(runCost.knownCostAmount),
        pricedPromptCount: Number(runCost.pricedPromptCount),
        unpricedPromptCount: Number(runCost.unpricedPromptCount),
      }
      : null,
  };

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      title: agent.title,
      status: agent.status,
      adapterType: agent.adapterType,
    },
    runtime: sanitizeFeedbackValue(runtime, state, "bundle.agentContext.runtime", 400),
    skills: {
      desiredRefs: desiredSkillRefs,
      unresolvedRefs: unresolvedSkillRefs,
      items: matchedSkills.map((skill, index) => ({
        key: skill.key,
        selectedVersionId: selectedRows.find(
          (selection) => selection.key === skill.key,
        )?.versionId ?? null,
        slug: skill.slug,
        name: skill.name,
        sourceType: skill.sourceType,
        sourceLocator: skill.sourceLocator == null
          ? null
          : skill.sourceType === "github" || skill.sourceType === "skills_sh" || skill.sourceType === "url"
            ? skill.sourceLocator
            : sanitizeFeedbackText(
              skill.sourceLocator,
              state,
              `bundle.agentContext.skills.items.${index}.sourceLocator`,
              MAX_PATH_CHARS,
            ),
        sourceRef: skill.sourceRef,
        trustLevel: skill.trustLevel,
        compatibility: skill.compatibility,
        fileInventory: skill.fileInventory,
      })),
    },
    paperclip: {
      schemaVersion: FEEDBACK_SCHEMA_VERSION,
      bundleVersion: FEEDBACK_BUNDLE_VERSION,
    },
  };
}

async function buildPayloadArtifacts(
  db: Db | IssueSessionDbTransaction,
  input: {
    issue: IssueFeedbackContext;
    target: ResolvedFeedbackTarget;
    voteId: string;
    vote: FeedbackVoteValue;
    reason: string | null;
    authorUserId: string;
    consentVersion: string | null;
    sharedWithLabs: boolean;
    now: Date;
  },
  runService?: Pick<IssueExecutionRunService, "readRun">,
) {
  const state = createFeedbackRedactionState();
  const primaryBody = sanitizeFeedbackText(
    input.target.body,
    state,
    "bundle.primaryContent.body",
    MAX_PRIMARY_CONTENT_CHARS,
  );
  const primaryContent = {
    type: input.target.targetType,
    id: input.target.targetId,
    label: input.target.label,
    createdAt: input.target.createdAt.toISOString(),
    authorAgentId: input.target.authorAgentId,
    authorUserId: input.target.authorUserId,
    createdByRunId: input.target.createdByRunId,
    documentId: input.target.documentId,
    documentKey: input.target.documentKey,
    documentTitle: input.target.documentTitle,
    revisionNumber: input.target.revisionNumber,
    targetPath: input.target.targetPath,
    body: primaryBody,
    excerpt: truncateExcerpt(primaryBody),
  };
  const targetSummary = buildTargetSummary({
    label: input.target.label,
    excerpt: primaryContent.excerpt,
    authorAgentId: input.target.authorAgentId,
    authorUserId: input.target.authorUserId,
    createdAt: input.target.createdAt,
    documentKey: input.target.documentKey,
    documentTitle: input.target.documentTitle,
    revisionNumber: input.target.revisionNumber,
  });

  const basePayload = {
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    bundleVersion: FEEDBACK_BUNDLE_VERSION,
    sourceApp: "paperclip",
    capturedAt: input.now.toISOString(),
    consentVersion: input.consentVersion,
    vote: {
      id: input.voteId,
      value: input.vote,
      reason: input.reason,
      authorUserId: input.authorUserId,
      sharedWithLabs: input.sharedWithLabs,
      sharedAt: input.sharedWithLabs ? input.now.toISOString() : null,
    },
    target: input.target.payloadTarget,
  } satisfies Record<string, unknown>;

  if (!input.sharedWithLabs) {
    state.notes.add("local_only_trace_stores_metadata_only");
    const payloadSnapshot = {
      ...basePayload,
      exportId: null,
      exportEligible: false,
      bundle: null,
    };
    const redactionSummary = finalizeFeedbackRedactionSummary(state);
    return {
      exportId: null,
      targetSummary,
      redactionSummary,
      payloadSnapshot: {
        ...payloadSnapshot,
        redactionSummary,
      },
      payloadDigest: sha256Digest({
        ...payloadSnapshot,
        redactionSummary,
      }),
    };
  }

  const exportId = buildExportId(input.voteId, input.now);
  const [issueContext, agentContext] = await Promise.all([
    buildIssueContext(db, input.issue, input.target, state),
    buildAgentContext(
      db,
      input.issue.companyId,
      input.target.authorAgentId,
      input.target.createdByRunId,
      state,
      runService,
    ),
  ]);

  const payloadSnapshot = {
    ...basePayload,
    exportId,
    exportEligible: true,
    bundle: {
      primaryContent,
      issueContext,
      agentContext,
    },
  };
  const redactionSummary = finalizeFeedbackRedactionSummary(state);
  const payloadWithSummary = {
    ...payloadSnapshot,
    redactionSummary,
  };
  return {
    exportId,
    targetSummary,
    redactionSummary,
    payloadSnapshot: payloadWithSummary,
    payloadDigest: sha256Digest(payloadWithSummary),
  };
}

async function buildFeedbackTraceBundleFromRow(
  db: Db,
  row: FeedbackTraceRow,
  runService?: Pick<
    IssueExecutionRunService,
    "readRun" | "readJoinedRunDetail"
  >,
): Promise<FeedbackTraceBundle> {
  const trace = mapTraceRow(row, true);
  const payloadSnapshot = asRecord(trace.payloadSnapshot);
  const notes: string[] = [];
  const state = createFeedbackRedactionState();
  const files: FeedbackTraceBundleFile[] = [];
  const sourceRunId = resolveSourceRunId(payloadSnapshot);

  let paperclipRun: Record<string, unknown> | null = null;
  let adapterType: string | null = null;

  if (!sourceRunId) {
    appendNote(notes, "source_run_missing");
  } else {
    const runIdentity = await resolveIssueExecutionRunIdentityById(db, sourceRunId);
    const run = runIdentity?.companyId === row.companyId && runService
      ? await runService.readRun(runIdentity)
      : null;
    const sourceAgent = run?.targetAgentId
      ? await db
      .select({
        adapterType: agents.adapterType,
      })
      .from(agents)
      .where(and(
        eq(agents.id, run.targetAgentId),
        eq(agents.companyId, row.companyId),
      ))
      .then((rows) => rows[0] ?? null)
      : null;

    if (!run || !sourceAgent) {
      appendNote(notes, "source_run_unavailable");
    } else {
      adapterType = sourceAgent.adapterType;
      let canonicalTrace = runService
        ? await createContextRetrievalDbRepository(db, {
            runService,
          }).readCanonicalRunTrace({
            companyId: row.companyId,
            runId: run.runId,
            projection: "export",
          })
        : null;
      while (
        canonicalTrace?.nextCursor &&
        JSON.stringify(canonicalTrace).length < MAX_TRACE_FILE_CHARS
      ) {
        const next = await createContextRetrievalDbRepository(db, {
          runService: runService!,
        }).readCanonicalRunTrace({
          companyId: row.companyId,
          runId: run.runId,
          projection: "export",
          cursor: canonicalTrace.nextCursor,
        });
        if (!next) break;
        canonicalTrace = {
          ...canonicalTrace,
          turns: [...canonicalTrace.turns, ...next.turns],
          nextCursor: next.nextCursor,
        };
      }
      if (canonicalTrace && canonicalTrace.issueId === row.issueId) {
        paperclipRun = sanitizeFeedbackValue(
          canonicalTrace,
          state,
          "bundle.paperclipRun",
          MAX_TRACE_FILE_CHARS,
        ) as Record<string, unknown>;
        files.push(makeBundleFile({
          path: "paperclip/issue-session-run.json",
          contentType: "application/json",
          source: "paperclip_issue_session_trace",
          contents: `${JSON.stringify(paperclipRun, null, 2)}\n`,
        }));
      } else {
        appendNote(notes, "issue_session_trace_unavailable");
      }
      appendNote(notes, "provider_native_trace_not_accessed");
    }
  }

  const privacy = {
    ...(asRecord(trace.redactionSummary) ?? {}),
    bundleRedactionSummary: finalizeFeedbackRedactionSummary(state),
  };
  const captureStatus = captureStatusFromFiles(files);
  if (captureStatus !== "full" && files.length > 0) {
    appendNote(notes, "adapter_trace_partial");
  }

  const envelope = sanitizeFeedbackValue(
    {
      traceId: trace.id,
      exportId: trace.exportId,
      companyId: trace.companyId,
      feedbackVoteId: trace.feedbackVoteId,
      issueId: trace.issueId,
      issueIdentifier: trace.issueIdentifier,
      issueTitle: trace.issueTitle,
      projectId: trace.projectId,
      authorUserId: trace.authorUserId,
      targetType: trace.targetType,
      targetId: trace.targetId,
      vote: trace.vote,
      status: trace.status,
      destination: trace.destination,
      consentVersion: trace.consentVersion,
      schemaVersion: trace.schemaVersion,
      bundleVersion: trace.bundleVersion,
      payloadVersion: trace.payloadVersion,
      payloadDigest: trace.payloadDigest,
      createdAt: trace.createdAt.toISOString(),
      exportedAt: trace.exportedAt?.toISOString() ?? null,
    },
    state,
    "bundle.envelope",
    MAX_TRACE_FILE_CHARS,
  ) as Record<string, unknown>;

  const surface = sanitizeFeedbackValue(
    {
      target: asRecord(payloadSnapshot?.target),
      summary: trace.targetSummary,
    },
    state,
    "bundle.surface",
    MAX_TRACE_FILE_CHARS,
  ) as Record<string, unknown>;

  const bundle: FeedbackTraceBundle = {
    traceId: trace.id,
    exportId: trace.exportId,
    companyId: trace.companyId,
    issueId: trace.issueId,
    issueIdentifier: trace.issueIdentifier,
    adapterType,
    captureStatus,
    notes,
    envelope,
    surface,
    paperclipRun,
    privacy,
    integrity: {
      payloadDigest: trace.payloadDigest,
      bundleDigest: sha256Digest({
        traceId: trace.id,
        files: files.map((file) => ({
          path: file.path,
          source: file.source,
          sha256: file.sha256,
        })),
        captureStatus,
      }),
    },
    files,
  };

  return bundle;
}

export function feedbackService(db: Db, options: FeedbackServiceOptions = {}) {
  return {
    listIssueVotesForUser: async (issueId: string, authorUserId: string) =>
      db
        .select()
        .from(feedbackVotes)
        .where(and(eq(feedbackVotes.issueId, issueId), eq(feedbackVotes.authorUserId, authorUserId))),

    listFeedbackTraces: async (input: {
      companyId: string;
      issueId?: string;
      projectId?: string;
      targetType?: FeedbackTargetType;
      vote?: FeedbackVoteValue;
      status?: FeedbackTraceStatus;
      from?: Date;
      to?: Date;
      sharedOnly?: boolean;
      includePayload?: boolean;
    }) => {
      const filters = [eq(feedbackExports.companyId, input.companyId)];
      if (input.issueId) filters.push(eq(feedbackExports.issueId, input.issueId));
      if (input.projectId) filters.push(eq(feedbackExports.projectId, input.projectId));
      if (input.targetType) filters.push(eq(feedbackExports.targetType, input.targetType));
      if (input.vote) filters.push(eq(feedbackExports.vote, input.vote));
      if (input.status) filters.push(eq(feedbackExports.status, input.status));
      if (input.sharedOnly) filters.push(ne(feedbackExports.status, "local_only"));
      if (input.from) filters.push(gte(feedbackExports.createdAt, input.from));
      if (input.to) filters.push(lte(feedbackExports.createdAt, input.to));

      const rows = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(and(...filters))
        .orderBy(desc(feedbackExports.createdAt));

      return rows.map((row) => mapTraceRow(row, input.includePayload === true));
    },

    getFeedbackTraceById: async (traceId: string, includePayload = true) => {
      const row = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(eq(feedbackExports.id, traceId))
        .then((rows) => rows[0] ?? null);
      return row ? mapTraceRow(row, includePayload) : null;
    },

    getFeedbackTraceBundle: async (traceId: string) => {
      const row = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(eq(feedbackExports.id, traceId))
        .then((rows) => rows[0] ?? null);
      return row
        ? buildFeedbackTraceBundleFromRow(
            db,
            row,
            options.runService,
          )
        : null;
    },

    flushPendingFeedbackTraces: async (input?: {
      companyId?: string;
      traceId?: string;
      limit?: number;
      now?: Date;
    }) => {
      const shareClient = options.shareClient;
      if (!shareClient) {
        const filters = [eq(feedbackExports.status, "pending")];
        if (input?.companyId) {
          filters.push(eq(feedbackExports.companyId, input.companyId));
        }
        if (input?.traceId) {
          filters.push(eq(feedbackExports.id, input.traceId));
        }

        const rows = await db
          .select({
            id: feedbackExports.id,
            attemptCount: feedbackExports.attemptCount,
          })
          .from(feedbackExports)
          .where(and(...filters))
          .orderBy(asc(feedbackExports.createdAt), asc(feedbackExports.id))
          .limit(Math.max(1, Math.min(input?.limit ?? 25, 200)));

        const attemptAt = input?.now ?? new Date();
        for (const row of rows) {
          await db
            .update(feedbackExports)
            .set({
              status: "failed",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              failureReason: FEEDBACK_EXPORT_BACKEND_NOT_CONFIGURED,
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
        }

        return {
          attempted: rows.length,
          sent: 0,
          failed: rows.length,
        };
      }

      const limit = Math.max(1, Math.min(input?.limit ?? 25, 200));
      const filters = [
        or(eq(feedbackExports.status, "pending"), eq(feedbackExports.status, "failed")),
      ];
      if (input?.companyId) {
        filters.push(eq(feedbackExports.companyId, input.companyId));
      }
      if (input?.traceId) {
        filters.push(eq(feedbackExports.id, input.traceId));
      }

      const rows = await db
        .select({
          ...feedbackExportColumns,
          issueIdentifier: issues.identifier,
          issueTitle: issues.title,
        })
        .from(feedbackExports)
        .innerJoin(issues, eq(feedbackExports.issueId, issues.id))
        .where(and(...filters))
        .orderBy(asc(feedbackExports.createdAt), asc(feedbackExports.id))
        .limit(limit);

      let attempted = 0;
      let sent = 0;
      let failed = 0;

      for (const row of rows) {
        const attemptAt = input?.now ?? new Date();
        attempted += 1;

        try {
          const bundle = await buildFeedbackTraceBundleFromRow(
            db,
            row,
            options.runService,
          );
          await shareClient.uploadTraceBundle(bundle);

          await db
            .update(feedbackExports)
            .set({
              status: "sent",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              exportedAt: attemptAt,
              failureReason: null,
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
          sent += 1;
        } catch (error) {
          await db
            .update(feedbackExports)
            .set({
              status: "failed",
              attemptCount: row.attemptCount + 1,
              lastAttemptedAt: attemptAt,
              failureReason: truncateFailureReason(error),
              updatedAt: attemptAt,
            })
            .where(eq(feedbackExports.id, row.id));
          failed += 1;
        }
      }

      return {
        attempted,
        sent,
        failed,
      };
    },

    saveIssueVote: async (input: {
      issueId: string;
      targetType: FeedbackTargetType;
      targetId: string;
      vote: FeedbackVoteValue;
      authorUserId: string;
      reason?: string | null;
      allowSharing?: boolean;
    }) =>
      db.transaction(async (tx) => {
        const issue = await tx
          .select({
            id: issues.id,
            companyId: issues.companyId,
            projectId: issues.projectId,
            identifier: issues.identifier,
            title: issues.title,
            request: issues.request,
          })
          .from(issues)
          .where(eq(issues.id, input.issueId))
          .then((rows) => rows[0] ?? null);
        if (!issue) throw notFound("Issue not found");

        const target = await resolveFeedbackTarget(tx, issue, input.targetType, input.targetId);

        const existingCompany = await tx
          .select({
            feedbackDataSharingEnabled: companies.feedbackDataSharingEnabled,
            feedbackDataSharingTermsVersion: companies.feedbackDataSharingTermsVersion,
          })
          .from(companies)
          .where(eq(companies.id, issue.companyId))
          .then((rows) => rows[0] ?? null);
        if (!existingCompany) throw notFound("Company not found");

        const now = new Date();
        const normalizedReason = normalizeReason(input.vote, input.reason);
        const sharedWithLabs = input.allowSharing === true;
        let consentEnabledNow = false;
        let consentVersion = existingCompany.feedbackDataSharingTermsVersion ?? null;
        let persistedSharingPreference: "allowed" | "not_allowed" | null = null;

        if (sharedWithLabs && !existingCompany.feedbackDataSharingEnabled) {
          consentEnabledNow = true;
          consentVersion = DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION;
          await tx
            .update(companies)
            .set({
              feedbackDataSharingEnabled: true,
              feedbackDataSharingConsentAt: now,
              feedbackDataSharingConsentByUserId: input.authorUserId,
              feedbackDataSharingTermsVersion: consentVersion,
              updatedAt: now,
            })
            .where(eq(companies.id, issue.companyId));
        }

        const existingInstanceSettings = await tx
          .select({
            id: instanceSettings.id,
            general: instanceSettings.general,
          })
          .from(instanceSettings)
          .where(eq(instanceSettings.singletonKey, DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY))
          .then((rows) => rows[0] ?? null);

        const currentInstanceSettings =
          existingInstanceSettings ??
          (await tx
            .insert(instanceSettings)
            .values({
              singletonKey: DEFAULT_INSTANCE_SETTINGS_SINGLETON_KEY,
              general: {},
              experimental: {},
              createdAt: now,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [instanceSettings.singletonKey],
              set: {
                updatedAt: now,
              },
            })
            .returning({
              id: instanceSettings.id,
              general: instanceSettings.general,
            })
            .then((rows) => rows[0] ?? null));

        const currentGeneral = normalizeInstanceGeneralSettings(currentInstanceSettings?.general);
        if (currentInstanceSettings && currentGeneral.feedbackDataSharingPreference === "prompt") {
          const nextSharingPreference = sharedWithLabs ? "allowed" : "not_allowed";
          const currentGeneralRaw = asRecord(currentInstanceSettings.general) ?? {};
          await tx
            .update(instanceSettings)
            .set({
              general: {
                ...currentGeneralRaw,
                censorUsernameInLogs: currentGeneral.censorUsernameInLogs,
                feedbackDataSharingPreference: nextSharingPreference,
              },
              updatedAt: now,
            })
            .where(eq(instanceSettings.id, currentInstanceSettings.id));
          persistedSharingPreference = nextSharingPreference;
        }

        const [savedVote] = await tx
          .insert(feedbackVotes)
          .values({
            companyId: issue.companyId,
            issueId: issue.id,
            targetType: input.targetType,
            targetId: input.targetId,
            authorUserId: input.authorUserId,
            vote: input.vote,
            reason: normalizedReason,
            sharedWithLabs,
            sharedAt: sharedWithLabs ? now : null,
            consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
            redactionSummary: null,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              feedbackVotes.companyId,
              feedbackVotes.targetType,
              feedbackVotes.targetId,
              feedbackVotes.authorUserId,
            ],
            set: {
              vote: input.vote,
              reason: normalizedReason,
              sharedWithLabs,
              sharedAt: sharedWithLabs ? now : null,
              consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
              redactionSummary: null,
              updatedAt: now,
            },
          })
          .returning();

        const artifacts = await buildPayloadArtifacts(tx, {
          issue,
          target,
          voteId: savedVote.id,
          vote: input.vote,
          reason: normalizedReason,
          authorUserId: input.authorUserId,
          consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
          sharedWithLabs,
          now,
        }, options.runService);

        await tx
          .update(feedbackVotes)
          .set({
            redactionSummary: artifacts.redactionSummary,
            updatedAt: now,
          })
          .where(eq(feedbackVotes.id, savedVote.id));

        const [savedTrace] = await tx
          .insert(feedbackExports)
          .values({
            companyId: issue.companyId,
            feedbackVoteId: savedVote.id,
            issueId: issue.id,
            projectId: issue.projectId,
            authorUserId: input.authorUserId,
            targetType: input.targetType,
            targetId: input.targetId,
            vote: input.vote,
            status: sharedWithLabs ? "pending" : "local_only",
            destination: sharedWithLabs ? FEEDBACK_DESTINATION : null,
            exportId: artifacts.exportId,
            consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
            schemaVersion: FEEDBACK_SCHEMA_VERSION,
            bundleVersion: FEEDBACK_BUNDLE_VERSION,
            payloadVersion: FEEDBACK_PAYLOAD_VERSION,
            payloadDigest: artifacts.payloadDigest,
            payloadSnapshot: artifacts.payloadSnapshot,
            targetSummary: artifacts.targetSummary,
            redactionSummary: artifacts.redactionSummary,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [feedbackExports.feedbackVoteId],
            set: {
              issueId: issue.id,
              projectId: issue.projectId,
              authorUserId: input.authorUserId,
              targetType: input.targetType,
              targetId: input.targetId,
              vote: input.vote,
              status: sharedWithLabs ? "pending" : "local_only",
              destination: sharedWithLabs ? FEEDBACK_DESTINATION : null,
              exportId: artifacts.exportId,
              consentVersion: sharedWithLabs ? (consentVersion ?? DEFAULT_FEEDBACK_DATA_SHARING_TERMS_VERSION) : null,
              schemaVersion: FEEDBACK_SCHEMA_VERSION,
              bundleVersion: FEEDBACK_BUNDLE_VERSION,
              payloadVersion: FEEDBACK_PAYLOAD_VERSION,
              payloadDigest: artifacts.payloadDigest,
              payloadSnapshot: artifacts.payloadSnapshot,
              targetSummary: artifacts.targetSummary,
              redactionSummary: artifacts.redactionSummary,
              failureReason: null,
              updatedAt: now,
            },
          })
          .returning({
            id: feedbackExports.id,
          });

        return {
          vote: {
            ...savedVote,
            redactionSummary: artifacts.redactionSummary,
          },
          traceId: savedTrace?.id ?? null,
          consentEnabledNow,
          persistedSharingPreference,
          sharingEnabled: sharedWithLabs,
        };
      }),
  };
}
