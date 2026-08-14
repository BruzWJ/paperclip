import * as d from "./tasks-dependencies.js";

import { taskServiceOperations } from "./tasks-operations.js";
import { taskServiceContext } from "./tasks-shared.js";

export function taskServicePart4(db: d.Db) {
  const context = taskServiceContext(db);
  const { instanceSettings } = context;
  const { redactTaskComment } = taskServiceOperations(context);

  return {
    getCommentCursor: async (taskId: string) => {
      const [latest, countRow] = await Promise.all([
        db
          .select({
            latestCommentId: d.taskComments.id,
            latestCommentAt: d.taskComments.createdAt,
          })
          .from(d.taskComments)
          .where(d.eq(d.taskComments.taskId, taskId))
          .orderBy(d.desc(d.taskComments.createdAt), d.desc(d.taskComments.id))
          .limit(1)
          .then((rows) => rows[0] ?? null),
        db
          .select({
            totalComments: d.sql<number>`count(*)::int`,
          })
          .from(d.taskComments)
          .where(d.eq(d.taskComments.taskId, taskId))
          .then((rows) => rows[0] ?? null),
      ]);

      return {
        totalComments: Number(countRow?.totalComments ?? 0),
        latestCommentId: latest?.latestCommentId ?? null,
        latestCommentAt: latest?.latestCommentAt ?? null,
      };
    },
    getComment: async (commentId: string) => {
      if (!d.isCanonicalUuid(commentId)) return null;
      const { censorUsernameInLogs } = await instanceSettings.getGeneral();
      const comment = await db
        .select()
        .from(d.taskComments)
        .where(d.eq(d.taskComments.id, commentId))
        .then((rows) => rows[0] ?? null);
      if (!comment) return null;
      return redactTaskComment(comment, censorUsernameInLogs);
    },
    createAttachment: async (input: {
      taskId: string;
      taskCommentId?: string | null;
      provider: string;
      objectKey: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      originalFilename?: string | null;
      createdByAgentId?: string | null;
      createdByUserId?: string | null;
    }) => {
      const task = await db
        .select({ id: d.tasks.id, companyId: d.tasks.companyId })
        .from(d.tasks)
        .where(d.eq(d.tasks.id, input.taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) throw d.notFound("Task not found");

      if (input.taskCommentId) {
        const comment = await db
          .select({
            id: d.taskComments.id,
            companyId: d.taskComments.companyId,
            taskId: d.taskComments.taskId,
          })
          .from(d.taskComments)
          .where(d.eq(d.taskComments.id, input.taskCommentId))
          .then((rows) => rows[0] ?? null);
        if (!comment) throw d.notFound("Task comment not found");
        if (comment.companyId !== task.companyId || comment.taskId !== task.id) {
          throw d.unprocessable("Attachment comment must belong to same task and company");
        }
      }

      return db.transaction(async (tx) => {
        const [asset] = await tx
          .insert(d.assets)
          .values({
            companyId: task.companyId,
            provider: input.provider,
            objectKey: input.objectKey,
            contentType: input.contentType,
            byteSize: input.byteSize,
            sha256: input.sha256,
            originalFilename: input.originalFilename ?? null,
            createdByAgentId: input.createdByAgentId ?? null,
            createdByUserId: input.createdByUserId ?? null,
          })
          .returning();

        const [attachment] = await tx
          .insert(d.taskAttachments)
          .values({
            companyId: task.companyId,
            taskId: task.id,
            assetId: asset.id,
            taskCommentId: input.taskCommentId ?? null,
          })
          .returning();

        return {
          id: attachment.id,
          companyId: attachment.companyId,
          taskId: attachment.taskId,
          taskCommentId: attachment.taskCommentId,
          assetId: attachment.assetId,
          provider: asset.provider,
          objectKey: asset.objectKey,
          contentType: asset.contentType,
          byteSize: asset.byteSize,
          sha256: asset.sha256,
          originalFilename: asset.originalFilename,
          createdByAgentId: asset.createdByAgentId,
          createdByUserId: asset.createdByUserId,
          createdAt: attachment.createdAt,
          updatedAt: attachment.updatedAt,
        };
      });
    },
    listAttachments: async (taskId: string) =>
      db
        .select({
          id: d.taskAttachments.id,
          companyId: d.taskAttachments.companyId,
          taskId: d.taskAttachments.taskId,
          taskCommentId: d.taskAttachments.taskCommentId,
          assetId: d.taskAttachments.assetId,
          provider: d.assets.provider,
          objectKey: d.assets.objectKey,
          contentType: d.assets.contentType,
          byteSize: d.assets.byteSize,
          sha256: d.assets.sha256,
          originalFilename: d.assets.originalFilename,
          createdByAgentId: d.assets.createdByAgentId,
          createdByUserId: d.assets.createdByUserId,
          createdAt: d.taskAttachments.createdAt,
          updatedAt: d.taskAttachments.updatedAt,
        })
        .from(d.taskAttachments)
        .innerJoin(d.assets, d.eq(d.taskAttachments.assetId, d.assets.id))
        .where(d.eq(d.taskAttachments.taskId, taskId))
        .orderBy(d.desc(d.taskAttachments.createdAt)),
    getAttachmentById: async (id: string) => {
      if (!d.isCanonicalUuid(id)) return null;
      return db
        .select({
          id: d.taskAttachments.id,
          companyId: d.taskAttachments.companyId,
          taskId: d.taskAttachments.taskId,
          taskCommentId: d.taskAttachments.taskCommentId,
          assetId: d.taskAttachments.assetId,
          provider: d.assets.provider,
          objectKey: d.assets.objectKey,
          contentType: d.assets.contentType,
          byteSize: d.assets.byteSize,
          sha256: d.assets.sha256,
          originalFilename: d.assets.originalFilename,
          createdByAgentId: d.assets.createdByAgentId,
          createdByUserId: d.assets.createdByUserId,
          createdAt: d.taskAttachments.createdAt,
          updatedAt: d.taskAttachments.updatedAt,
        })
        .from(d.taskAttachments)
        .innerJoin(d.assets, d.eq(d.taskAttachments.assetId, d.assets.id))
        .where(d.eq(d.taskAttachments.id, id))
        .then((rows) => rows[0] ?? null);
    },
    removeAttachment: async (id: string) => {
      if (!d.isCanonicalUuid(id)) return null;
      return db.transaction(async (tx) => {
        const existing = await tx
          .select({
            id: d.taskAttachments.id,
            companyId: d.taskAttachments.companyId,
            taskId: d.taskAttachments.taskId,
            taskCommentId: d.taskAttachments.taskCommentId,
            assetId: d.taskAttachments.assetId,
            provider: d.assets.provider,
            objectKey: d.assets.objectKey,
            contentType: d.assets.contentType,
            byteSize: d.assets.byteSize,
            sha256: d.assets.sha256,
            originalFilename: d.assets.originalFilename,
            createdByAgentId: d.assets.createdByAgentId,
            createdByUserId: d.assets.createdByUserId,
            createdAt: d.taskAttachments.createdAt,
            updatedAt: d.taskAttachments.updatedAt,
          })
          .from(d.taskAttachments)
          .innerJoin(d.assets, d.eq(d.taskAttachments.assetId, d.assets.id))
          .where(d.eq(d.taskAttachments.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;

        await tx.delete(d.taskAttachments).where(d.eq(d.taskAttachments.id, id));
        await tx.delete(d.assets).where(d.eq(d.assets.id, existing.assetId));
        return existing;
      });
    },
    findMentionedAgents: async (companyId: string, body: string) => {
      const explicitAgentMentionIds = d.extractAgentMentionIds(body);
      if (explicitAgentMentionIds.length === 0) return [];

      const rows = await db
        .select({ id: d.agents.id })
        .from(d.agents)
        .where(d.eq(d.agents.companyId, companyId));
      const companyAgentIds = new Set(rows.map((agent) => agent.id));
      return explicitAgentMentionIds.filter((agentId) => companyAgentIds.has(agentId));
    },
    findMentionedProjectIds: async (taskId: string, opts?: { includeCommentBodies?: boolean }) => {
      const task = await db
        .select({
          companyId: d.tasks.companyId,
          title: d.tasks.title,
          request: d.tasks.request,
        })
        .from(d.tasks)
        .where(d.eq(d.tasks.id, taskId))
        .then((rows) => rows[0] ?? null);
      if (!task) return [];

      const mentionedIds = new Set<string>();
      for (const source of [task.title, task.request]) {
        if (!source) continue;
        for (const projectId of d.extractProjectMentionIds(source)) {
          mentionedIds.add(projectId);
        }
      }

      if (opts?.includeCommentBodies !== false) {
        const comments = await db
          .select({ body: d.taskComments.body })
          .from(d.taskComments)
          .where(d.eq(d.taskComments.taskId, taskId));

        for (const comment of comments) {
          for (const projectId of d.extractProjectMentionIds(comment.body)) {
            mentionedIds.add(projectId);
          }
        }
      }

      if (mentionedIds.size === 0) return [];

      const rows = await db
        .select({ id: d.projects.id })
        .from(d.projects)
        .where(
          d.and(d.eq(d.projects.companyId, task.companyId), d.inArray(d.projects.id, [...mentionedIds])),
        );
      const valid = new Set(rows.map((row) => row.id));
      return [...mentionedIds].filter((projectId) => valid.has(projectId));
    },
    getAncestors: async (taskId: string) => {
      const raw: Array<{
        id: string;
        taskNumber: number;
        identifier: string;
        title: string | null;
        request: string | null;
        boardPresentationStatus: d.TaskStatus;
        priority: string;
        ownerAgentId: string | null;
        ownerUserId: string | null;
        projectId: string | null;
        goalId: string | null;
      }> = [];
      const visited = new Set<string>([taskId]);
      const start = await db
        .select()
        .from(d.tasks)
        .where(d.eq(d.tasks.id, taskId))
        .then((r) => r[0] ?? null);
      let currentId = start?.parentId ?? null;
      while (currentId && !visited.has(currentId) && raw.length < 50) {
        visited.add(currentId);
        const parent = await db
          .select({
            id: d.tasks.id,
            taskNumber: d.tasks.taskNumber,
            identifier: d.tasks.identifier,
            title: d.tasks.title,
            request: d.tasks.request,
            boardPresentationStatus: d.tasks.boardPresentationStatus,
            priority: d.tasks.priority,
            ownerAgentId: d.tasks.ownerAgentId,
            ownerUserId: d.tasks.ownerUserId,
            projectId: d.tasks.projectId,
            goalId: d.tasks.goalId,
            parentId: d.tasks.parentId,
          })
          .from(d.tasks)
          .where(d.eq(d.tasks.id, currentId))
          .then((r) => r[0] ?? null);
        if (!parent) break;
        raw.push({
          id: parent.id,
          taskNumber: parent.taskNumber,
          identifier: parent.identifier,
          title: parent.title,
          request: parent.request,
          boardPresentationStatus: parent.boardPresentationStatus,
          priority: parent.priority,
          ownerAgentId: parent.ownerAgentId ?? null,
          ownerUserId: parent.ownerUserId ?? null,
          projectId: parent.projectId ?? null,
          goalId: parent.goalId ?? null,
        });
        currentId = parent.parentId ?? null;
      }

      // Batch-fetch referenced projects and goals.
      const projectIds = [...new Set(raw.map((a) => a.projectId).filter((id): id is string => id != null))];
      const goalIds = [...new Set(raw.map((a) => a.goalId).filter((id): id is string => id != null))];

      const projectMap = new Map<
        string,
        {
          id: string;
          name: string;
          description: string | null;
          status: string;
        }
      >();
      const goalMap = new Map<
        string,
        {
          id: string;
          title: string;
          description: string | null;
          level: string;
          status: string;
        }
      >();

      if (projectIds.length > 0) {
        const rows = await db
          .select({
            id: d.projects.id,
            name: d.projects.name,
            description: d.projects.description,
            status: d.projects.status,
          })
          .from(d.projects)
          .where(d.inArray(d.projects.id, projectIds));
        for (const r of rows) {
          projectMap.set(r.id, r);
        }
      }

      if (goalIds.length > 0) {
        const rows = await db
          .select({
            id: d.goals.id,
            title: d.goals.title,
            description: d.goals.description,
            level: d.goals.level,
            status: d.goals.status,
          })
          .from(d.goals)
          .where(d.inArray(d.goals.id, goalIds));
        for (const r of rows) goalMap.set(r.id, r);
      }

      return raw.map((a) => ({
        ...a,
        project: a.projectId ? (projectMap.get(a.projectId) ?? null) : null,
        goal: a.goalId ? (goalMap.get(a.goalId) ?? null) : null,
      }));
    },
  };
}
