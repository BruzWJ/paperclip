import { issueSessions, type Db } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import type {
  NonDispatchControlNotice,
  NonDispatchUserComment,
  IssueSessionProjectedCommentSource,
} from "./issue-session/admission.js";
import {
  createIssueSessionAdmissionService,
  type IssueSessionAdmissionResult,
} from "./issue-session/admission.js";
import type { IssueSessionDbTransaction } from "./issue-session/event-store.js";
import {
  IssueSessionInvariantError,
} from "./issue-session/store.js";

type SessionReadDb = Pick<Db, "select">;

async function canonicalSessionId(
  db: SessionReadDb,
  companyId: string,
  issueId: string,
): Promise<string> {
  const rows = await db
    .select({ id: issueSessions.id })
    .from(issueSessions)
    .where(
      and(
        eq(issueSessions.companyId, companyId),
        eq(issueSessions.issueId, issueId),
      ),
    )
    .limit(2);
  if (rows.length !== 1) {
    throw new IssueSessionInvariantError(
      `Issue ${issueId} must resolve to exactly one canonical Session`,
    );
  }
  return rows[0]!.id;
}

export interface CanonicalControlNoticeInput {
  companyId: string;
  issueId: string;
  sourceKind: string;
  immutableSourceKey: string;
  sourceRecordId: string;
  exactText: string;
  comment?: IssueSessionProjectedCommentSource;
  allowTerminal?: boolean;
  occurredAt?: Date | string | null;
}

export interface CanonicalUserCommentInput {
  companyId: string;
  issueId: string;
  sourceKind: string;
  immutableSourceKey: string;
  sourceRecordId: string;
  exactText: string;
  userId: string;
  occurredAt?: Date | string | null;
}

function canonicalClock(value: Date | string | null | undefined) {
  if (value == null) return undefined;
  const occurredAt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(occurredAt.getTime())) {
    throw new IssueSessionInvariantError(
      "Canonical issue Session source timestamp is invalid",
    );
  }
  return () => occurredAt;
}

/**
 * Canonical producer for non-dispatch server notices. The caller supplies
 * the immutable causal identity; this function only resolves the one Session
 * owned by the issue and delegates the event/projection transaction.
 */
export async function appendCanonicalControlNotice(
  db: Db,
  input: CanonicalControlNoticeInput,
  transaction?: IssueSessionDbTransaction,
): Promise<IssueSessionAdmissionResult> {
  const readDb = transaction ?? db;
  const sessionId = await canonicalSessionId(
    readDb,
    input.companyId,
    input.issueId,
  );
  const notice: NonDispatchControlNotice = {
    companyId: input.companyId,
    issueId: input.issueId,
    sessionId,
    sourceKind: input.sourceKind,
    immutableSourceKey: input.immutableSourceKey,
    sourceRecordId: input.sourceRecordId,
    exactText: input.exactText,
    comment: input.comment ?? null,
    allowTerminal: input.allowTerminal,
  };
  return createIssueSessionAdmissionService(db, {
    clock: canonicalClock(input.occurredAt),
  })
    .appendNonDispatchControlNotice(notice, transaction);
}

/**
 * Canonical non-dispatch human/board comment path. Agent/provider output is
 * deliberately not accepted here: it belongs to the run translator, while a
 * human @mention that invokes the current owner belongs to dispatching-user
 * admission.
 */
export async function appendCanonicalUserComment(
  db: Db,
  input: CanonicalUserCommentInput,
  transaction?: IssueSessionDbTransaction,
): Promise<IssueSessionAdmissionResult> {
  const readDb = transaction ?? db;
  const sessionId = await canonicalSessionId(
    readDb,
    input.companyId,
    input.issueId,
  );
  const comment: NonDispatchUserComment = {
    companyId: input.companyId,
    issueId: input.issueId,
    sessionId,
    sourceKind: input.sourceKind,
    immutableSourceKey: input.immutableSourceKey,
    sourceRecordId: input.sourceRecordId,
    exactText: input.exactText,
    comment: {
      author: { kind: "user", userId: input.userId },
      producingRun: null,
    },
  };
  return createIssueSessionAdmissionService(db, {
    clock: canonicalClock(input.occurredAt),
  })
    .appendNonDispatchUserComment(comment, transaction);
}
