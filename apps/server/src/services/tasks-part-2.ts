import * as d from "./tasks-dependencies.js";

import { taskServiceOperations } from "./tasks-operations.js";
import * as taskShared from "./tasks-shared.js";

export function taskServicePart2(db: d.Db) {
  const context = taskShared.taskServiceContext(db);
  const { getTaskByUuid, getTaskByCompanyTaskNumber, getTaskRelationSummaryMap } =
    taskServiceOperations(context);

  return {
    archiveInbox: async (
      companyId: string,
      taskId: string,
      userId: string,
      archivedAt: Date = new Date(),
      attribution?: {
        archivedByActorType: "user" | "agent";
        archivedByAgentId?: string | null;
        archivedByRunId?: string | null;
      },
    ) => {
      const now = new Date();
      const [row] = await db
        .insert(d.taskInboxArchives)
        .values({
          companyId,
          taskId,
          userId,
          archivedByActorType: attribution?.archivedByActorType ?? "user",
          archivedByAgentId: attribution?.archivedByAgentId ?? null,
          archivedByRunId: attribution?.archivedByRunId ?? null,
          archivedAt,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [d.taskInboxArchives.companyId, d.taskInboxArchives.taskId, d.taskInboxArchives.userId],
          set: {
            archivedAt,
            archivedByActorType: attribution?.archivedByActorType ?? "user",
            archivedByAgentId: attribution?.archivedByAgentId ?? null,
            archivedByRunId: attribution?.archivedByRunId ?? null,
            updatedAt: now,
          },
        })
        .returning();
      return row;
    },
    unarchiveInbox: async (companyId: string, taskId: string, userId: string) => {
      const [row] = await db
        .delete(d.taskInboxArchives)
        .where(
          d.and(
            d.eq(d.taskInboxArchives.companyId, companyId),
            d.eq(d.taskInboxArchives.taskId, taskId),
            d.eq(d.taskInboxArchives.userId, userId),
          ),
        )
        .returning();
      return row ?? null;
    },
    getActiveInboxArchiveFields: async (
      task: Pick<taskShared.TaskRow, "id" | "companyId" | "updatedAt">,
      userId: string,
    ) => {
      const [[activity], [archive]] = await Promise.all([
        taskShared.lastActivityStatsForTasks(db, task.companyId, [task.id]),
        taskShared.inboxArchiveRowsForTasks(db, task.companyId, userId, [task.id]),
      ]);
      const lastActivityAt =
        taskShared.latestTaskActivityAt(
          task.updatedAt,
          activity?.latestCommentAt ?? null,
          activity?.latestLogAt ?? null,
        ) ?? task.updatedAt;
      return taskShared.activeInboxArchiveFields(archive, lastActivityAt);
    },
    getById: async (id: string) => (d.isCanonicalUuid(id) ? getTaskByUuid(id) : null),
    getByCompanyTaskNumber: getTaskByCompanyTaskNumber,
    getRelationSummaries: async (taskId: string) => {
      const task = await db
        .select({ id: d.tasks.id, companyId: d.tasks.companyId })
        .from(d.tasks)
        .where(d.eq(d.tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw d.notFound("Task not found");
      const relations = await getTaskRelationSummaryMap(task.companyId, [taskId], db);
      return relations.get(taskId) ?? { blockedBy: [], blocks: [] };
    },
    getBlockerDiagnostics: async (
      taskId: string,
      maxBlockers = taskShared.TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS,
    ) => {
      const task = await db
        .select({ id: d.tasks.id, companyId: d.tasks.companyId })
        .from(d.tasks)
        .where(d.eq(d.tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw d.notFound("Task not found");

      const cappedMax = Math.max(0, Math.min(maxBlockers, taskShared.TASK_BLOCKER_DIAGNOSTICS_MAX_BLOCKERS));
      const blockerRows = await db
        .select({
          id: d.tasks.id,
          companyId: d.tasks.companyId,
          projectId: d.tasks.projectId,
          parentId: d.tasks.parentId,
          taskNumber: d.tasks.taskNumber,
          identifier: d.tasks.identifier,
          title: d.tasks.title,
          boardPresentationStatus: d.tasks.boardPresentationStatus,
          priority: d.tasks.priority,
          ownerAgentId: d.tasks.ownerAgentId,
          ownerUserId: d.tasks.ownerUserId,
        })
        .from(d.taskRelations)
        .innerJoin(d.tasks, d.eq(d.taskRelations.taskId, d.tasks.id))
        .where(
          d.and(
            d.eq(d.taskRelations.companyId, task.companyId),
            d.eq(d.taskRelations.type, "blocks"),
            d.eq(d.taskRelations.relatedTaskId, task.id),
            d.eq(d.tasks.companyId, task.companyId),
          ),
        )
        .orderBy(d.asc(d.tasks.title), d.asc(d.tasks.id))
        .limit(cappedMax + 1);

      const readiness = await taskShared.listTaskDependencyReadinessMap(db, task.companyId, [task.id]);

      return {
        blockers: blockerRows.slice(0, cappedMax) as taskShared.TaskBlockerDiagnosticsTaskRow[],
        readiness: readiness.get(task.id) ?? taskShared.createTaskDependencyReadiness(task.id),
        truncated: blockerRows.length > cappedMax,
      };
    },
    getSubtreeDiagnostics: async (
      taskId: string,
      opts?: {
        maxDepth?: number;
        maxNodes?: number;
        maxBlockersPerNode?: number;
      },
    ) => {
      const task = await db
        .select({ id: d.tasks.id, companyId: d.tasks.companyId })
        .from(d.tasks)
        .where(d.eq(d.tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw d.notFound("Task not found");

      const maxDepth = Math.max(
        0,
        Math.min(
          opts?.maxDepth ?? taskShared.TASK_SUBTREE_DIAGNOSTICS_MAX_DEPTH,
          taskShared.TASK_SUBTREE_DIAGNOSTICS_MAX_DEPTH,
        ),
      );
      const maxNodes = Math.max(
        1,
        Math.min(
          opts?.maxNodes ?? taskShared.TASK_SUBTREE_DIAGNOSTICS_MAX_NODES,
          taskShared.TASK_SUBTREE_DIAGNOSTICS_MAX_NODES,
        ),
      );
      const maxBlockersPerNode = Math.max(
        0,
        Math.min(
          opts?.maxBlockersPerNode ?? taskShared.TASK_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
          taskShared.TASK_SUBTREE_DIAGNOSTICS_MAX_BLOCKERS_PER_NODE,
        ),
      );
      const rawSubtreeRows = await db.execute(d.sql<taskShared.TaskSubtreeDiagnosticsTaskRow>`
        WITH RECURSIVE task_tree AS (
          SELECT
            id,
            company_id,
            project_id,
            parent_id,
            task_number,
            identifier,
            title,
            board_presentation_status AS "boardPresentationStatus",
            priority,
            owner_agent_id,
            owner_user_id,
            created_at,
            updated_at,
            0 AS depth,
            ARRAY[id] AS path
          FROM tasks
          WHERE company_id = ${task.companyId}
            AND id = ${task.id}
            AND hidden_at IS NULL
          UNION ALL
          SELECT
            child.id,
            child.company_id,
            child.project_id,
            child.parent_id,
            child.task_number,
            child.identifier,
            child.title,
            child.board_presentation_status AS "boardPresentationStatus",
            child.priority,
            child.owner_agent_id,
            child.owner_user_id,
            child.created_at,
            child.updated_at,
            task_tree.depth + 1,
            task_tree.path || child.id
          FROM tasks child
          JOIN task_tree ON child.parent_id = task_tree.id
          WHERE child.company_id = ${task.companyId}
            AND child.hidden_at IS NULL
            AND task_tree.depth < ${maxDepth + 1}
            AND NOT child.id = ANY(task_tree.path)
        )
        SELECT
          id,
          company_id AS "companyId",
          project_id AS "projectId",
          parent_id AS "parentId",
          task_number AS "taskNumber",
          identifier,
          title,
          "boardPresentationStatus",
          priority,
          owner_agent_id AS "ownerAgentId",
          owner_user_id AS "ownerUserId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          depth::int AS depth
        FROM task_tree
        ORDER BY depth ASC, created_at ASC, id ASC
        LIMIT ${maxNodes + 1}
      `);
      const subtreeRows = Array.from(rawSubtreeRows).map((row) => ({
        ...row,
        depth: Number(row.depth),
      }));
      const rowsWithinDepth = subtreeRows.filter((row) => row.depth <= maxDepth);
      const nodes = rowsWithinDepth.slice(0, maxNodes) as taskShared.TaskSubtreeDiagnosticsTaskRow[];
      const truncatedNodes = rowsWithinDepth.length > maxNodes;
      const truncatedDepth = truncatedNodes || subtreeRows.some((row) => row.depth > maxDepth);
      const nodeIds = nodes.map((node) => node.id);

      const readiness =
        nodeIds.length > 0
          ? await taskShared.listTaskDependencyReadinessMap(db, task.companyId, nodeIds)
          : new Map<string, taskShared.TaskDependencyReadiness>();
      const blockersByTaskId = new Map<string, taskShared.TaskSubtreeDiagnosticsBlockerRow[]>();
      const truncatedBlockerTaskIds = new Set<string>();

      if (nodeIds.length > 0) {
        const nodeIdValues = d.sql.join(
          nodeIds.map((id) => d.sql`${id}`),
          d.sql`, `,
        );
        const rawBlockerRows = Array.from(
          await db.execute(d.sql`
          WITH blocker_rows AS (
            SELECT
              blocker.id,
              blocker.company_id AS "companyId",
              blocker.project_id AS "projectId",
              blocker.parent_id AS "parentId",
              blocker.task_number AS "taskNumber",
              blocker.identifier,
              blocker.title,
              blocker.board_presentation_status AS "boardPresentationStatus",
              blocker.priority,
              blocker.owner_agent_id AS "ownerAgentId",
              blocker.owner_user_id AS "ownerUserId",
              relation.related_task_id AS "blockedTaskId",
              relation.created_at AS "relationCreatedAt",
              row_number() OVER (
                PARTITION BY relation.related_task_id
                ORDER BY blocker.title ASC, blocker.id ASC
              )::int AS "rowNumber"
            FROM task_relations relation
            INNER JOIN tasks blocker ON blocker.id = relation.task_id
            WHERE relation.company_id = ${task.companyId}
              AND relation.type = 'blocks'
              AND blocker.company_id = ${task.companyId}
              AND blocker.hidden_at IS NULL
              AND relation.related_task_id::text IN (${nodeIdValues})
          )
          SELECT *
          FROM blocker_rows
          WHERE "rowNumber" <= ${maxBlockersPerNode + 1}
          ORDER BY "blockedTaskId" ASC, "rowNumber" ASC
        `),
        ) as taskShared.TaskSubtreeDiagnosticsBlockerResultRow[];
        for (const row of rawBlockerRows) {
          const normalized = { ...row, rowNumber: Number(row.rowNumber) };
          if (normalized.rowNumber > maxBlockersPerNode) {
            truncatedBlockerTaskIds.add(normalized.blockedTaskId);
            continue;
          }
          const rows = blockersByTaskId.get(normalized.blockedTaskId) ?? [];
          rows.push(normalized);
          blockersByTaskId.set(normalized.blockedTaskId, rows);
        }
      }

      return {
        nodes,
        blockersByTaskId,
        readinessByTaskId: readiness,
        truncatedNodes,
        truncatedDepth,
        truncatedBlockerTaskIds,
        caps: {
          maxDepth,
          maxNodes,
          maxBlockersPerNode,
        },
      };
    },
    getDependencyReadiness: async (taskId: string, dbOrTx: any = db) => {
      const task = await dbOrTx
        .select({ id: d.tasks.id, companyId: d.tasks.companyId })
        .from(d.tasks)
        .where(d.eq(d.tasks.id, taskId))
        .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
      if (!task) throw d.notFound("Task not found");
      const readiness = await taskShared.listTaskDependencyReadinessMap(dbOrTx, task.companyId, [taskId]);
      return readiness.get(taskId) ?? taskShared.createTaskDependencyReadiness(taskId);
    },
    listDependencyReadiness: async (companyId: string, taskIds: string[], dbOrTx: any = db) => {
      return taskShared.listTaskDependencyReadinessMap(dbOrTx, companyId, taskIds);
    },
    listBlockerAttention: async (
      companyId: string,
      taskRows: taskShared.TaskBlockerAttentionInputNode[],
      dbOrTx: any = db,
    ) => {
      return taskShared.listTaskBlockerAttentionMap(dbOrTx, companyId, taskRows);
    },
    updateTitle: async (id: string, title: string | null) => {
      return db.transaction(async (tx) => {
        const updated = await tx
          .update(d.tasks)
          .set({ title, updatedAt: new Date() })
          .where(d.eq(d.tasks.id, id))
          .returning()
          .then((rows) => rows[0] ?? null);
        if (!updated) return null;
        await d.syncTask(updated.id, tx);
        const [enriched] = await taskShared.withTaskLabels(tx, [updated]);
        return enriched;
      });
    },
  };
}
