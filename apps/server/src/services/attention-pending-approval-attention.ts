import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { type Db, approvals, invites, taskApprovals, joinRequests } from "@paperclipai/db";
import type { AttentionItem } from "@paperclipai/shared";
import {
  toIso,
  genericDetail,
  approvalDetail,
  decisionVerbs,
  createItem,
  approvalTitle,
} from "./attention-support.js";

export async function collectPendingApprovalAttention(
  db: Db,
  companyId: string,
  add: (item: AttentionItem, options?: { suppressible?: boolean }) => void,
) {
  const pendingApprovals = await db
    .select({
      id: approvals.id,
      type: approvals.type,
      status: approvals.status,
      requestedByAgentId: approvals.requestedByAgentId,
      requestedByUserId: approvals.requestedByUserId,
      payload: approvals.payload,
      createdAt: approvals.createdAt,
      updatedAt: approvals.updatedAt,
    })
    .from(approvals)
    .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.updatedAt), desc(approvals.id));

  const pendingApprovalIds = pendingApprovals.map((approval) => approval.id);

  const approvalTaskRows =
    pendingApprovalIds.length > 0
      ? await db
          .select({
            approvalId: taskApprovals.approvalId,
            taskId: taskApprovals.taskId,
          })
          .from(taskApprovals)
          .where(
            and(
              eq(taskApprovals.companyId, companyId),
              inArray(taskApprovals.approvalId, pendingApprovalIds),
            ),
          )
          .orderBy(asc(taskApprovals.approvalId), asc(taskApprovals.taskId))
      : [];

  const approvalTaskMap = new Map<string, string>();

  for (const row of approvalTaskRows) {
    if (!approvalTaskMap.has(row.approvalId)) approvalTaskMap.set(row.approvalId, row.taskId);
  }

  for (const approval of pendingApprovals) {
    const dedupKey = `approval:${approval.id}`;
    const title = approvalTitle(approval.type, approval.payload);
    add(
      createItem({
        companyId,
        sourceKind: "approval",
        subject: {
          kind: "approval",
          id: approval.id,
          companyId,
          taskNumber: null,
          title,
          identifier: null,
          status: approval.status,
          routeTarget: { kind: "approval", id: approval.id },
          metadata: {
            type: approval.type,
            requestedByAgentId: approval.requestedByAgentId,
            requestedByUserId: approval.requestedByUserId,
            taskId: approvalTaskMap.get(approval.id) ?? null,
          },
        },
        whyNow: "Approval is pending a board decision.",
        decisionVerbs: decisionVerbs(
          {
            id: "approve",
            label: "Approve",
            description: "Approve the request.",
          },
          {
            id: "reject",
            label: "Reject",
            description: "Reject the request.",
          },
          {
            id: "request_revision",
            label: "Request revision",
            description: "Send the request back for changes.",
          },
        ),
        inlineResolvable: approval.type !== "request_board_approval",
        entryRule: "approvals.status = 'pending'",
        exitRule: "Approval leaves pending status.",
        dedupKey,
        severity: "medium",
        activityAt: toIso(approval.updatedAt),
        createdAt: toIso(approval.createdAt),
        updatedAt: toIso(approval.updatedAt),
        relatedTask: null,
        detail: approvalDetail(approval.type, approval.payload),
      }),
    );
  }

  const pendingJoins = await db
    .select({
      id: joinRequests.id,
      status: joinRequests.status,
      requestingUserId: joinRequests.requestingUserId,
      requestEmailSnapshot: joinRequests.requestEmailSnapshot,
      createdAt: joinRequests.createdAt,
      updatedAt: joinRequests.updatedAt,
    })
    .from(joinRequests)
    .innerJoin(invites, eq(joinRequests.inviteId, invites.id))
    .where(
      and(
        eq(joinRequests.companyId, companyId),
        eq(invites.companyId, companyId),
        eq(joinRequests.status, "pending_approval"),
      ),
    )
    .orderBy(desc(joinRequests.updatedAt), desc(joinRequests.id));

  for (const join of pendingJoins) {
    const label = join.requestEmailSnapshot ?? join.requestingUserId ?? "User join request";
    const dedupKey = `join:${join.id}`;
    add(
      createItem({
        companyId,
        sourceKind: "join_request",
        subject: {
          kind: "join_request",
          id: join.id,
          companyId,
          taskNumber: null,
          title: label,
          identifier: null,
          status: join.status,
          routeTarget: { kind: "join_requests" },
          metadata: {
            requestingUserId: join.requestingUserId,
          },
        },
        whyNow: "Join request is pending approval.",
        decisionVerbs: decisionVerbs(
          {
            id: "approve",
            label: "Approve",
            description: "Approve this join request.",
          },
          {
            id: "reject",
            label: "Reject",
            description: "Reject this join request.",
          },
        ),
        inlineResolvable: true,
        entryRule: "join_requests.status = 'pending_approval'",
        exitRule: "Join request is approved or rejected.",
        dedupKey,
        severity: "medium",
        activityAt: toIso(join.updatedAt),
        createdAt: toIso(join.createdAt),
        updatedAt: toIso(join.updatedAt),
        relatedTask: null,
        detail: genericDetail(label, []),
      }),
    );
  }
}
