import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  documentRevisions,
  documents,
  issueComments,
  issueUpdates,
  routineRuns,
  summarySlots,
} from "@paperclipai/db";
import type { IssueStatus } from "@paperclipai/shared";

const TERMINAL_ISSUE_STATUSES = new Set<IssueStatus>(["done", "cancelled"]);
const SUMMARY_FORMAT = "markdown";
type SummaryProjectionDb = Pick<Db, "select" | "insert" | "update">;

interface TerminalGenerationIssue {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string | null;
  boardPresentationStatus: IssueStatus;
  ownerAgentId?: string | null;
  creatorRoutineId?: string | null;
  creatorRoutineDispatchId?: string | null;
}

export interface SummaryTerminalProjectionSource {
  updateId: string;
  commentId: string;
  runId: string;
}

function failureReasonForIssue(issue: TerminalGenerationIssue) {
  const label = issue.title ?? issue.identifier ?? `Issue ${issue.id}`;
  return issue.boardPresentationStatus === "cancelled"
    ? `Summary routine issue ${label} was cancelled.`
    : `Summary routine issue ${label} finished without one canonical terminal comment.`;
}

async function markRoutineRunTerminal(
  dbOrTx: SummaryProjectionDb,
  issue: TerminalGenerationIssue,
  status: "completed" | "failed",
  now: Date,
  failureReason: string | null,
) {
  if (!issue.creatorRoutineDispatchId) return;
  await dbOrTx
    .update(routineRuns)
    .set({
      status,
      failureReason,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(routineRuns.companyId, issue.companyId),
        eq(routineRuns.id, issue.creatorRoutineDispatchId),
        ...(issue.creatorRoutineId
          ? [eq(routineRuns.routineId, issue.creatorRoutineId)]
          : []),
      ),
    );
}

/**
 * Project a summary routine's one canonical terminal issue comment into the
 * board-readable slot document. The source comment is unique on revisions, so
 * retries cannot create a second summary output.
 */
export async function finalizeSummarySlotsForTerminalIssue(
  dbOrTx: SummaryProjectionDb,
  issue: TerminalGenerationIssue,
  source?: SummaryTerminalProjectionSource,
) {
  if (!TERMINAL_ISSUE_STATUSES.has(issue.boardPresentationStatus)) return [];

  const slots = await dbOrTx
    .select()
    .from(summarySlots)
    .where(
      and(
        eq(summarySlots.companyId, issue.companyId),
        eq(summarySlots.generatingIssueId, issue.id),
        eq(summarySlots.status, "generating"),
      ),
    )
    .for("update");
  if (slots.length === 0) return [];

  const now = new Date();
  if (issue.boardPresentationStatus === "cancelled" || !source) {
    const reason = failureReasonForIssue(issue);
    const failed = await dbOrTx
      .update(summarySlots)
      .set({
        status: "failed",
        failureReason: reason,
        updatedAt: now,
      })
      .where(
        and(
          eq(summarySlots.companyId, issue.companyId),
          eq(summarySlots.generatingIssueId, issue.id),
          eq(summarySlots.status, "generating"),
        ),
      )
      .returning({ id: summarySlots.id });
    await markRoutineRunTerminal(dbOrTx, issue, "failed", now, reason);
    return failed;
  }

  const [update, comment] = await Promise.all([
    dbOrTx
      .select()
      .from(issueUpdates)
      .where(
        and(
          eq(issueUpdates.id, source.updateId),
          eq(issueUpdates.companyId, issue.companyId),
          eq(issueUpdates.issueId, issue.id),
          eq(issueUpdates.form, "owner"),
          eq(issueUpdates.status, "done"),
          eq(issueUpdates.commentId, source.commentId),
          eq(issueUpdates.runId, source.runId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
    dbOrTx
      .select()
      .from(issueComments)
      .where(
        // A sub-issue owner update is canonically projected into its parent
        // Session, so the update comment need not belong to `issue.id`.
        and(
          eq(issueComments.id, source.commentId),
          eq(issueComments.companyId, issue.companyId),
          eq(issueComments.runId, source.runId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null),
  ]);
  const body = comment?.body.trim() ?? "";
  if (
    !update ||
    !comment ||
    !comment.authorAgentId ||
    update.message !== comment.body ||
    body.length === 0
  ) {
    const reason = `Summary routine issue ${issue.identifier ?? issue.id} has no valid canonical terminal comment.`;
    const failed = await dbOrTx
      .update(summarySlots)
      .set({ status: "failed", failureReason: reason, updatedAt: now })
      .where(
        and(
          eq(summarySlots.companyId, issue.companyId),
          eq(summarySlots.generatingIssueId, issue.id),
          eq(summarySlots.status, "generating"),
        ),
      )
      .returning({ id: summarySlots.id });
    await markRoutineRunTerminal(dbOrTx, issue, "failed", now, reason);
    return failed;
  }

  const projected: Array<{ id: string }> = [];
  for (const slot of slots) {
    const existingProjection = await dbOrTx
      .select({ id: documentRevisions.id })
      .from(documentRevisions)
      .where(eq(documentRevisions.sourceIssueCommentId, comment.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existingProjection) {
      await dbOrTx
        .update(summarySlots)
        .set({
          status: "idle",
          failureReason: null,
          generatingIssueId: null,
          lastGeneratedAt: comment.createdAt,
          lastGeneratedByAgentId: comment.authorAgentId,
          updatedAt: now,
        })
        .where(eq(summarySlots.id, slot.id));
      projected.push({ id: slot.id });
      continue;
    }

    let document = slot.documentId
      ? await dbOrTx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.id, slot.documentId),
              eq(documents.companyId, issue.companyId),
            ),
          )
          .limit(1)
          .for("update")
          .then((rows) => rows[0] ?? null)
      : null;
    const revisionNumber = document ? document.latestRevisionNumber + 1 : 1;
    if (!document) {
      [document] = await dbOrTx
        .insert(documents)
        .values({
          companyId: issue.companyId,
          title: issue.title,
          format: SUMMARY_FORMAT,
          latestBody: body,
          latestRevisionId: null,
          latestRevisionNumber: revisionNumber,
          createdByAgentId: comment.authorAgentId,
          updatedByAgentId: comment.authorAgentId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    }
    const [revision] = await dbOrTx
      .insert(documentRevisions)
      .values({
        companyId: issue.companyId,
        documentId: document.id,
        revisionNumber,
        title: issue.title,
        format: SUMMARY_FORMAT,
        body,
        changeSummary: `Projected from ${issue.identifier ?? issue.id}`,
        createdByAgentId: comment.authorAgentId,
        createdByRunId: source.runId,
        sourceIssueCommentId: comment.id,
        createdAt: now,
      })
      .returning();
    [document] = await dbOrTx
      .update(documents)
      .set({
        title: issue.title,
        format: SUMMARY_FORMAT,
        latestBody: body,
        latestRevisionId: revision.id,
        latestRevisionNumber: revisionNumber,
        updatedByAgentId: comment.authorAgentId,
        updatedAt: now,
      })
      .where(eq(documents.id, document.id))
      .returning();
    const [updatedSlot] = await dbOrTx
      .update(summarySlots)
      .set({
        documentId: document.id,
        status: "idle",
        failureReason: null,
        generatingIssueId: null,
        lastGeneratedAt: comment.createdAt,
        lastGeneratedByAgentId: comment.authorAgentId,
        lastModel: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(summarySlots.id, slot.id),
          eq(summarySlots.generatingIssueId, issue.id),
        ),
      )
      .returning({ id: summarySlots.id });
    if (updatedSlot) projected.push(updatedSlot);
  }
  await markRoutineRunTerminal(dbOrTx, issue, "completed", now, null);
  return projected;
}
