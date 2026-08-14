import {
  type Db,
  approvals,
  taskApprovals,
  tasks,
  taskBoardMentions,
  taskBoardReopenCommands,
  taskBoardUserComments,
} from "@paperclipai/db";
import type { AttentionFeed, AttentionItem } from "@paperclipai/shared";
import { collectPendingApprovalAttention } from "./attention-pending-approval-attention.js";
import {
  activeDismissalState,
  betterDuplicate,
  compareAttentionItems,
  dismissalByKey,
  emptyCounts,
  requireCompany,
  type AttentionListOptions,
  toIso,
  decisionVerbs,
  createItem,
  budgetObservedPercent,
  taskContext,
  taskImages,
  genericDetail,
  taskSubject,
  taskSummaryMap,
  taskImageMap,
  boardMentionComments,
  boardReplyComments,
} from "./attention-support.js";
import { budgetService } from "./budgets.js";

import { and, desc, eq, inArray, isNull, gt, notExists, sql } from "drizzle-orm";
import { parseTaskExecutionState } from "./task-execution-policy.js";

export async function collectBoardMentionAttention(
  db: Db,
  companyId: string,
  add: (item: AttentionItem, options?: { suppressible?: boolean }) => void,
) {
  const activeBoardMentions = await db
    .select({
      id: taskBoardMentions.id,
      taskId: taskBoardMentions.taskId,
      message: boardMentionComments.body,
      createdAt: taskBoardMentions.createdAt,
    })
    .from(taskBoardMentions)
    .innerJoin(
      boardMentionComments,
      and(
        eq(boardMentionComments.companyId, taskBoardMentions.companyId),
        eq(boardMentionComments.taskId, taskBoardMentions.taskId),
        eq(boardMentionComments.id, taskBoardMentions.commentId),
      ),
    )
    .innerJoin(
      tasks,
      and(
        eq(tasks.companyId, taskBoardMentions.companyId),
        eq(tasks.id, taskBoardMentions.taskId),
        eq(tasks.ownershipEpoch, taskBoardMentions.ownershipEpoch),
      ),
    )
    .where(
      and(
        eq(taskBoardMentions.companyId, companyId),
        isNull(tasks.hiddenAt),
        inArray(tasks.lifecycleStatus, ["open", "blocked"]),
        notExists(
          db
            .select({ id: taskBoardUserComments.id })
            .from(taskBoardUserComments)
            .innerJoin(
              boardReplyComments,
              and(
                eq(boardReplyComments.companyId, taskBoardUserComments.companyId),
                eq(boardReplyComments.taskId, taskBoardUserComments.taskId),
                eq(boardReplyComments.id, taskBoardUserComments.commentId),
              ),
            )
            .where(
              and(
                eq(taskBoardUserComments.companyId, taskBoardMentions.companyId),
                eq(taskBoardUserComments.taskId, taskBoardMentions.taskId),
                eq(taskBoardUserComments.ownershipEpoch, taskBoardMentions.ownershipEpoch),
                eq(taskBoardUserComments.mentionTargetAgentId, taskBoardMentions.agentId),
                gt(boardReplyComments.projectedEventSeq, boardMentionComments.projectedEventSeq),
              ),
            ),
        ),
        notExists(
          db
            .select({ id: taskBoardReopenCommands.id })
            .from(taskBoardReopenCommands)
            .where(
              and(
                eq(taskBoardReopenCommands.companyId, taskBoardMentions.companyId),
                eq(taskBoardReopenCommands.taskId, taskBoardMentions.taskId),
                eq(taskBoardReopenCommands.ownershipEpoch, taskBoardMentions.ownershipEpoch),
                sql`${taskBoardReopenCommands.createdAt} >= ${taskBoardMentions.createdAt}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(taskBoardMentions.createdAt), desc(taskBoardMentions.id));

  const boardMentionTaskMap = await taskSummaryMap(
    db,
    companyId,
    activeBoardMentions.map((mention) => mention.taskId),
  );

  const boardMentionImageMap = await taskImageMap(
    db,
    companyId,
    activeBoardMentions.map((mention) => mention.taskId),
  );

  for (const mention of activeBoardMentions) {
    const task = boardMentionTaskMap.get(mention.taskId);
    if (!task) continue;
    add(
      createItem({
        companyId,
        sourceKind: "mention_board",
        subject: taskSubject(task),
        whyNow: "An agent requested information or direction from the Board.",
        decisionVerbs: decisionVerbs({
          id: "reply_and_continue",
          label: "Reply & continue",
          description: "Reply to the agent and continue this task.",
        }),
        inlineResolvable: false,
        entryRule: "An active agent Board mention exists for the current nonterminal task ownership epoch.",
        exitRule:
          "A Board user resumes the exact owner/epoch, the task is reopened, or the ownership epoch leaves scope.",
        dedupKey: `board-mention:${mention.id}`,
        severity: "medium",
        activityAt: toIso(mention.createdAt),
        createdAt: toIso(mention.createdAt),
        updatedAt: toIso(mention.createdAt),
        relatedTask: null,
        ...taskContext(task),
        detail: genericDetail(mention.message, taskImages(boardMentionImageMap, mention.taskId)),
      }),
    );
  }
}

export async function collectReviewAttention(
  db: Db,
  companyId: string,
  add: (item: AttentionItem, options?: { suppressible?: boolean }) => void,
) {
  const reviewRows = await db
    .select({
      id: tasks.id,
      companyId: tasks.companyId,
      identifier: tasks.identifier,
      title: tasks.title,
      boardPresentationStatus: tasks.boardPresentationStatus,
      priority: tasks.priority,
      ownerAgentId: tasks.ownerAgentId,
      ownerUserId: tasks.ownerUserId,
      executionState: tasks.executionState,
      createdAt: tasks.createdAt,
      updatedAt: tasks.updatedAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.companyId, companyId),
        eq(tasks.boardPresentationStatus, "in_review"),
        isNull(tasks.hiddenAt),
      ),
    )
    .orderBy(desc(tasks.updatedAt), desc(tasks.id));

  const reviewTaskIds = reviewRows.map((row) => row.id);

  const pendingReviewApprovalRows =
    reviewTaskIds.length === 0
      ? []
      : await db
          .select({
            taskId: taskApprovals.taskId,
            approvalId: approvals.id,
          })
          .from(taskApprovals)
          .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
          .where(
            and(
              eq(taskApprovals.companyId, companyId),
              eq(approvals.companyId, companyId),
              inArray(taskApprovals.taskId, reviewTaskIds),
              eq(approvals.status, "pending"),
            ),
          );

  const pendingApprovalByTaskId = new Map(
    pendingReviewApprovalRows.map((row) => [row.taskId, row.approvalId]),
  );

  const reviewTaskMap = await taskSummaryMap(db, companyId, reviewTaskIds);

  const reviewImageMap = await taskImageMap(db, companyId, reviewTaskIds);

  for (const review of reviewRows) {
    const state = parseTaskExecutionState(review.executionState);
    const currentParticipant = state?.status === "pending" ? state.currentParticipant : null;
    const hasHumanParticipant = currentParticipant?.type === "user";
    const pendingApprovalId = pendingApprovalByTaskId.get(review.id) ?? null;
    if (!hasHumanParticipant && !review.ownerUserId && !pendingApprovalId) continue;
    const task = reviewTaskMap.get(review.id);
    if (!task) continue;
    const dedupKey = `review:${review.id}`;
    add(
      createItem({
        companyId,
        sourceKind: "review",
        subject: taskSubject(task),
        whyNow: pendingApprovalId
          ? "Task is in review with a linked pending approval."
          : hasHumanParticipant
            ? "Task is in review and the current execution participant is a user."
            : "Task is in review and owned by a user.",
        decisionVerbs: decisionVerbs(
          {
            id: "approve",
            label: "Approve",
            description: "Approve the review and advance the task.",
          },
          {
            id: "request_changes",
            label: "Request changes",
            description: "Return the task to its owner with changes requested.",
          },
        ),
        inlineResolvable: false,
        entryRule:
          "tasks.boardPresentationStatus = 'in_review' and human reviewer, user owner, or linked pending approval exists.",
        exitRule: "Task leaves in_review or the human review path resolves.",
        dedupKey,
        severity: "medium",
        activityAt: toIso(review.updatedAt),
        createdAt: toIso(review.createdAt),
        updatedAt: toIso(review.updatedAt),
        relatedTask: null,
        ...taskContext(task),
        detail: genericDetail(review.title, taskImages(reviewImageMap, review.id)),
      }),
    );
  }
}

export async function collectBudgetAttention(
  db: Db,
  companyId: string,
  add: (item: AttentionItem, options?: { suppressible?: boolean }) => void,
) {
  const budgetOverview = await budgetService(db).overview(companyId);

  for (const incident of budgetOverview.activeIncidents) {
    const observedPercent = budgetObservedPercent(incident.observedAmount, incident.limitAmount);
    if (incident.thresholdType !== "hard" && observedPercent < 85) continue;
    const dedupKey = `budget:${incident.policyId}:${toIso(incident.windowStart)}:${incident.thresholdType}`;
    add(
      createItem({
        companyId,
        sourceKind: "budget_alert",
        subject: {
          kind: "budget_incident",
          id: incident.id,
          companyId,
          taskNumber: null,
          title: `${incident.scopeName} budget ${incident.thresholdType === "hard" ? "hard stop" : "warning"}`,
          identifier: null,
          status: incident.status,
          routeTarget: { kind: "costs" },
          metadata: {
            policyId: incident.policyId,
            scopeType: incident.scopeType,
            scopeId: incident.scopeId,
            thresholdType: incident.thresholdType,
            budgetCurrency: incident.budgetCurrency,
            observedAmount: incident.observedAmount,
            limitAmount: incident.limitAmount,
            observedPercent,
            approvalId: incident.approvalId,
            approvalStatus: incident.approvalStatus,
          },
        },
        whyNow:
          incident.thresholdType === "hard"
            ? "Budget hard stop was reached."
            : "Budget crossed the 85% warning threshold.",
        decisionVerbs: decisionVerbs(
          {
            id: "raise_budget_and_resume",
            label: "Raise budget",
            description: "Raise the budget and resume paused work.",
          },
          {
            id: "keep_paused",
            label: "Keep paused",
            description: "Dismiss or keep the budget stop in place.",
          },
        ),
        inlineResolvable: true,
        entryRule: "open budget incident is hard, or soft with observed spend >= 85% of limit.",
        exitRule: "Budget incident is resolved or dismissed.",
        dedupKey,
        severity: incident.thresholdType === "hard" ? "high" : "medium",
        activityAt: toIso(incident.updatedAt),
        createdAt: toIso(incident.createdAt),
        updatedAt: toIso(incident.updatedAt),
        relatedTask: null,
        detail: {
          kind: "budget",
          observedPercent,
          budgetCurrency: incident.budgetCurrency,
          observedAmount: incident.observedAmount,
          limitAmount: incident.limitAmount,
          images: [],
        },
      }),
    );
  }
}

export function attentionService(db: Db) {
  return {
    list: async (companyId: string, options: AttentionListOptions = {}): Promise<AttentionFeed> => {
      await requireCompany(db, companyId);
      const dismissals = await dismissalByKey(db, companyId, options.userId);
      const includeDismissed = options.includeDismissed === true;
      const now = Date.now();
      const collected: AttentionItem[] = [];

      const add = (item: AttentionItem, options: { suppressible?: boolean } = {}) => {
        if (options.suppressible === false) {
          collected.push({ ...item, dismissal: null });
          return;
        }
        const dismissal = activeDismissalState(dismissals, item.dismissalKey, item.activityAt, now);
        if (!includeDismissed && dismissal?.isActive) return;
        collected.push({ ...item, dismissal });
      };

      await collectPendingApprovalAttention(db, companyId, add);
      await collectReviewAttention(db, companyId, add);
      await collectBoardMentionAttention(db, companyId, add);
      await collectBudgetAttention(db, companyId, add);

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(item.dedupKey, current ? betterDuplicate(current, item) : item);
      }

      const items = [...deduped.values()]
        .sort(compareAttentionItems)
        .map((item, index) => ({ ...item, rank: index + 1 }));
      const countsBySourceKind = emptyCounts();
      for (const item of items) countsBySourceKind[item.sourceKind] += 1;

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        totalCount: items.length,
        countsBySourceKind,
        items,
      };
    },
  };
}
