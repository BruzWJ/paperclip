import { and, eq, gte, inArray, lte, or } from "drizzle-orm";
import { activityLog, agents, approvals, taskApprovals, taskComments } from "@paperclipai/db";
import type {
  TimelineActorType,
  WorkTimelineActor,
  WorkTimelineEdge,
  WorkTimelineEvent,
  WorkTimelineResult,
  WorkTimelineSpan,
} from "@paperclipai/shared";
import * as timelineContracts from "./work-timeline-contracts.js";
import { buildWorkTimelineRunQueries } from "./work-timeline-run-queries.js";
import { buildWorkTimelineTaskLens } from "./work-timeline-task-lens.js";

export function buildWorkTimelineProjection(
  scope: timelineContracts.WorkTimelineContext &
    ReturnType<typeof buildWorkTimelineRunQueries> &
    ReturnType<typeof buildWorkTimelineTaskLens>,
) {
  const {
    db,
    listTaskRunsInWindow,
    filterReadableTasks,
    collectTaskIds,
    loadTasks,
    applyUserLens,
    loadActorMaps,
  } = scope;

  function actorForTaskCreator(task: timelineContracts.TaskRow) {
    if (task.creatorKind === "agent-execution" && task.creatorAgentId) {
      return timelineContracts.actorId("agent", task.creatorAgentId);
    }
    if (task.creatorKind === "user/board" && task.creatorUserId) {
      return timelineContracts.actorId("user", task.creatorUserId);
    }
    return timelineContracts.actorId("system", "system");
  }

  function actorForTaskOwner(task: timelineContracts.TaskRow) {
    if (task.ownerAgentId) return timelineContracts.actorId("agent", task.ownerAgentId);
    if (task.ownerUserId) return timelineContracts.actorId("user", task.ownerUserId);
    return null;
  }

  async function getTimeline(input: timelineContracts.WorkTimelineQuery): Promise<WorkTimelineResult> {
    const { from, to, capped } = timelineContracts.normalizeTimelineWindow(input);
    const limit = timelineContracts.normalizeLimit(input.limit);
    const offset = timelineContracts.normalizeOffset(input.offset);

    const candidateTaskIds = await collectTaskIds(input, from, to);
    const loadedTasks = await loadTasks(input, candidateTaskIds);
    const userScopedTasks = await applyUserLens(input, loadedTasks, from, to);
    const accessibleTasks = await filterReadableTasks(userScopedTasks, input.canReadTask);
    const sortedTasks = accessibleTasks.sort(
      (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
    );
    const pagedTasks = sortedTasks.slice(offset, offset + limit);
    const taskById = new Map(pagedTasks.map((task) => [task.id, task]));
    const readableTaskIds = Array.from(taskById.keys());

    if (readableTaskIds.length === 0) {
      return {
        actors: [],
        spans: [],
        events: [],
        edges: [],
        pagination: {
          limit,
          offset,
          totalTasks: sortedTasks.length,
          hasMore: offset + limit < sortedTasks.length,
        },
        window: { from: from.toISOString(), to: to.toISOString(), capped },
      };
    }

    const actorIds = new Set<string>();
    const events: WorkTimelineEvent[] = [];
    const edges: WorkTimelineEdge[] = [];

    for (const task of pagedTasks) {
      const creatorActorId = actorForTaskCreator(task);
      actorIds.add(creatorActorId);
      events.push({
        actorId: creatorActorId,
        kind: "created",
        taskId: task.id,
        at: task.createdAt.toISOString(),
      });

      const ownerActorId = actorForTaskOwner(task);
      if (ownerActorId) {
        actorIds.add(ownerActorId);
        edges.push({
          fromActorId: creatorActorId,
          toActorId: ownerActorId,
          taskId: task.id,
          at: task.createdAt.toISOString(),
          kind: "assignment",
        });
      }

      const parent = task.parentId ? taskById.get(task.parentId) : null;
      const parentActorId = parent ? (actorForTaskOwner(parent) ?? actorForTaskCreator(parent)) : null;
      if (parentActorId && ownerActorId && parentActorId !== ownerActorId) {
        actorIds.add(parentActorId);
        edges.push({
          fromActorId: parentActorId,
          toActorId: ownerActorId,
          taskId: task.id,
          at: task.createdAt.toISOString(),
          kind: "delegation",
        });
        events.push({
          actorId: parentActorId,
          kind: "delegated",
          taskId: task.id,
          at: task.createdAt.toISOString(),
        });
      }
    }

    const [runRows, commentRows, approvalRows, logRows] = await Promise.all([
      Promise.all(
        readableTaskIds.map((taskId) => listTaskRunsInWindow(input.companyId, taskId, from, to)),
      ).then((pages) => pages.flat()),
      db
        .select({
          taskId: taskComments.taskId,
          authorAgentId: taskComments.authorAgentId,
          authorUserId: taskComments.authorUserId,
          createdAt: taskComments.createdAt,
        })
        .from(taskComments)
        .where(
          and(
            eq(taskComments.companyId, input.companyId),
            inArray(taskComments.taskId, readableTaskIds),
            gte(taskComments.createdAt, from),
            lte(taskComments.createdAt, to),
          ),
        ),
      db
        .select({
          taskId: taskApprovals.taskId,
          decidedByUserId: approvals.decidedByUserId,
          decidedAt: approvals.decidedAt,
          requestedByAgentId: approvals.requestedByAgentId,
          requestedByUserId: approvals.requestedByUserId,
          createdAt: approvals.createdAt,
        })
        .from(taskApprovals)
        .innerJoin(approvals, eq(taskApprovals.approvalId, approvals.id))
        .where(
          and(
            eq(taskApprovals.companyId, input.companyId),
            inArray(taskApprovals.taskId, readableTaskIds),
            or(
              and(gte(approvals.createdAt, from), lte(approvals.createdAt, to)),
              and(gte(approvals.decidedAt, from), lte(approvals.decidedAt, to)),
            ),
          ),
        ),
      db
        .select({
          taskId: activityLog.entityId,
          actorType: activityLog.actorType,
          actorId: activityLog.actorId,
          action: activityLog.action,
          details: activityLog.details,
          createdAt: activityLog.createdAt,
        })
        .from(activityLog)
        .where(
          and(
            eq(activityLog.companyId, input.companyId),
            eq(activityLog.entityType, "task"),
            inArray(activityLog.entityId, readableTaskIds),
            gte(activityLog.createdAt, from),
            lte(activityLog.createdAt, to),
          ),
        ),
    ]);

    const spanByRunId = new Map<string, WorkTimelineSpan>();
    for (const row of runRows) {
      if (!taskById.has(row.taskId) || spanByRunId.has(row.runId)) continue;
      const task = taskById.get(row.taskId)!;
      const runActorId = timelineContracts.actorId("agent", row.targetAgentId);
      actorIds.add(runActorId);
      spanByRunId.set(row.runId, {
        actorId: runActorId,
        runId: row.runId,
        kind: row.kind,
        taskId: row.taskId,
        taskNumber: task.taskNumber,
        taskIdentifier: task.identifier,
        taskTitle: task.title,
        start: (row.startedAt ?? row.createdAt).toISOString(),
        end: timelineContracts.dateIso(row.finishedAt),
        status: row.status,
        retryOfRunId: row.retryOfRunId ?? null,
      });
    }

    for (const row of commentRows) {
      const commentActorId = row.authorAgentId
        ? timelineContracts.actorId("agent", row.authorAgentId)
        : row.authorUserId
          ? timelineContracts.actorId("user", row.authorUserId)
          : timelineContracts.actorId("system", "system");
      actorIds.add(commentActorId);
      events.push({
        actorId: commentActorId,
        kind: "commented",
        taskId: row.taskId,
        at: row.createdAt.toISOString(),
      });
    }

    for (const row of approvalRows) {
      const approvalActorId = row.decidedByUserId
        ? timelineContracts.actorId("user", row.decidedByUserId)
        : row.requestedByAgentId
          ? timelineContracts.actorId("agent", row.requestedByAgentId)
          : row.requestedByUserId
            ? timelineContracts.actorId("user", row.requestedByUserId)
            : timelineContracts.actorId("system", "system");
      actorIds.add(approvalActorId);
      events.push({
        actorId: approvalActorId,
        kind: "approved",
        taskId: row.taskId,
        at: (row.decidedAt ?? row.createdAt).toISOString(),
      });
    }

    for (const row of logRows) {
      const logActorType =
        row.actorType === "agent" || row.actorType === "user" || row.actorType === "plugin"
          ? row.actorType
          : "system";
      const fromActorId = timelineContracts.actorId(logActorType, row.actorId);
      actorIds.add(fromActorId);
      if (row.action.includes("assign")) {
        events.push({
          actorId: fromActorId,
          kind: "assigned",
          taskId: row.taskId,
          at: row.createdAt.toISOString(),
        });
        const details =
          row.details && typeof row.details === "object" && !Array.isArray(row.details)
            ? (row.details as Record<string, unknown>)
            : {};
        const targetAgentId = timelineContracts.readString(details.ownerAgentId);
        const targetUserId = timelineContracts.readString(details.ownerUserId);
        const toActorId = targetAgentId
          ? timelineContracts.actorId("agent", targetAgentId)
          : targetUserId
            ? timelineContracts.actorId("user", targetUserId)
            : null;
        if (toActorId) {
          actorIds.add(toActorId);
          edges.push({
            fromActorId,
            toActorId,
            taskId: row.taskId,
            at: row.createdAt.toISOString(),
            kind: "assignment",
          });
        }
      }
    }

    const actorMaps = await loadActorMaps(input.companyId, actorIds);
    const actors: WorkTimelineActor[] = Array.from(actorIds).map((id) => {
      const [type, rawId] = id.split(":", 2) as [TimelineActorType, string];
      if (type === "agent") {
        const agent = actorMaps.agents.get(rawId);
        return {
          id,
          type,
          name: agent?.name ?? "Unknown agent",
          avatar: agent?.icon ?? null,
        };
      }
      if (type === "user") {
        const user = actorMaps.users.get(rawId);
        return {
          id,
          type,
          name: user?.name ?? rawId,
          avatar: user?.image ?? null,
        };
      }
      return {
        id,
        type,
        name: type === "plugin" ? rawId : "System",
        avatar: null,
      };
    });

    return {
      actors,
      spans: Array.from(spanByRunId.values()).sort((left, right) => left.start.localeCompare(right.start)),
      events: events.sort((left, right) => left.at.localeCompare(right.at)),
      edges: edges.sort((left, right) => left.at.localeCompare(right.at)),
      pagination: {
        limit,
        offset,
        totalTasks: sortedTasks.length,
        hasMore: offset + limit < sortedTasks.length,
      },
      window: { from: from.toISOString(), to: to.toISOString(), capped },
    };
  }

  return { actorForTaskCreator, actorForTaskOwner, getTimeline };
}
