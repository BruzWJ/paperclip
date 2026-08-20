import { type Db, agents } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { type CompanySearchRateLimiter } from "../services/company-search-rate-limit.js";
import {
  accessService,
  companySearchService,
  companyService,
  documentAnnotationService,
  documentService,
  goalService,
  projectService,
  taskApprovalService,
  taskReferenceService,
  taskService,
  workProductService,
  type OrdinaryTaskRuntime,
  toPublicProject,
} from "../services/index.js";
import type { PluginDomainEventPublisher } from "../services/plugin-domain-event-publisher.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { TaskExecutionCancellationService } from "../services/task-execution-cancellation.js";
import { taskExecutionPolicyControlService } from "../services/task-execution-policy.js";
import type { StorageService } from "../storage/types.js";
import * as diagnostics from "./task-route-diagnostics.js";
import * as listcache from "./task-route-list-cache.js";
import * as listcoordinator from "./task-route-list-coordinator.js";
import { createTaskRequestHelpers, type TaskRouteRequestContext } from "./task-route-request-helpers.js";
import * as subtree from "./task-route-subtree.js";

import { attachmentArtifactWorkProductMetadataSchema, validationDetails } from "@paperclipai/shared";
import { eq } from "drizzle-orm";
import multer from "multer";
import { normalizeContentType } from "../attachment-types.js";
import { unprocessable } from "../errors.js";
import {
  readTaskExecutionRun,
  resolveTaskExecutionRunIdentityById,
} from "../services/task-execution-run-service.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

type TaskAttachmentHelperDependencies = Pick<
  TaskRouteRequestContext<TaskRouteBaseContext>,
  "db" | "storage" | "svc" | "access" | "buildAttachmentContentPath" | "attachmentArtifactMetadataInputSchema"
>;

export function createTaskAttachmentHelpers(context: TaskAttachmentHelperDependencies) {
  const { db, storage, svc, access, buildAttachmentContentPath, attachmentArtifactMetadataInputSchema } =
    context;

  async function canonicalizePaperclipArtifactMetadata(input: {
    task: { id: string; companyId: string };
    metadata: Record<string, unknown> | null | undefined;
  }) {
    const parsed = attachmentArtifactMetadataInputSchema.safeParse(input.metadata);
    if (!parsed.success) {
      throw unprocessable("Invalid attachment artifact metadata", {
        code: "invalid_attachment_artifact_metadata",
        details: validationDetails(parsed.error),
      });
    }

    const attachment = await svc.getAttachmentById(parsed.data.attachmentId);
    if (!attachment || attachment.companyId !== input.task.companyId || attachment.taskId !== input.task.id) {
      throw unprocessable("Attachment artifact must reference an attachment on the same task", {
        code: "invalid_attachment_artifact_metadata",
        attachmentId: parsed.data.attachmentId,
      });
    }

    const contentPath = buildAttachmentContentPath(attachment.id);
    return attachmentArtifactWorkProductMetadataSchema.parse({
      attachmentId: attachment.id,
      contentType: normalizeContentType(attachment.contentType),
      byteSize: attachment.byteSize,
      contentPath,
      openPath: contentPath,
      downloadPath: `${contentPath}?download=1`,
      originalFilename: attachment.originalFilename ?? null,
    });
  }

  async function runSingleFileUpload(req: Request, res: Response, fileSizeLimit: number) {
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: fileSizeLimit, files: 1 },
    });
    await new Promise<void>((resolve, reject) => {
      upload.single("file")(req, res, (err: unknown) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function assertCanManageTaskApprovalLinks(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
    return true;
  }

  function actorCanAccessCompany(req: Request, companyId: string) {
    if (req.actor.type !== "board") return false;
    if (req.actor.isInstanceAdmin) return true;
    return (req.actor.companyIds ?? []).includes(companyId);
  }

  async function assertTaskReadAllowed(req: Request, res: Response, task: { companyId: string }) {
    if (req.actor.type === "board" && actorCanAccessCompany(req, task.companyId)) {
      return true;
    }
    res.status(403).json({ error: "Board access required" });
    return false;
  }

  async function filterTasksForActor<T extends { companyId: string }>(req: Request, rows: T[]) {
    if (req.actor.type !== "board") return [];
    return rows.filter((task) => actorCanAccessCompany(req, task.companyId));
  }

  async function actorCanReadCompanyScope(req: Request, companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    return decision.allowed;
  }

  async function assertBoardTaskMutationAllowed(req: Request, res: Response, task: { companyId: string }) {
    if (req.actor.type === "board" && actorCanAccessCompany(req, task.companyId)) {
      return true;
    }
    res.status(403).json({ error: "Board access required" });
    return false;
  }

  async function loadWorkProductRunAttribution(runId: string) {
    const identity = await resolveTaskExecutionRunIdentityById(db, runId);
    if (!identity) return null;
    const run = await readTaskExecutionRun(db, identity);
    if (!run) return null;
    const agent = await db
      .select({ companyId: agents.companyId })
      .from(agents)
      .where(eq(agents.id, run.targetAgentId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return agent
      ? {
          id: run.runId,
          companyId: run.companyId,
          agentId: run.targetAgentId,
          agentCompanyId: agent.companyId,
        }
      : null;
  }

  async function resolveWorkProductCreatedByRunId(
    res: Response,
    companyId: string,
    input: { createdByRunId?: string | null },
    mode: "create" | "update",
  ): Promise<string | null | undefined> {
    const hasCreatedByRunId = Object.prototype.hasOwnProperty.call(input, "createdByRunId");
    if (mode === "update" && !hasCreatedByRunId) return undefined;

    const requestedRunId = input.createdByRunId ?? null;
    if (!requestedRunId) return null;
    const run = await loadWorkProductRunAttribution(requestedRunId);
    if (!run || run.companyId !== companyId || run.agentCompanyId !== companyId) {
      res.status(403).json({ error: "createdByRunId is not valid for this company" });
      return undefined;
    }
    return requestedRunId;
  }
  return {
    canonicalizePaperclipArtifactMetadata,
    runSingleFileUpload,
    assertCanManageTaskApprovalLinks,
    actorCanAccessCompany,
    assertTaskReadAllowed,
    filterTasksForActor,
    actorCanReadCompanyScope,
    assertBoardTaskMutationAllowed,
    loadWorkProductRunAttribution,
    resolveWorkProductCreatedByRunId,
  };
}

export type TaskRouteAttachmentContext = TaskRouteRequestContext<TaskRouteBaseContext> &
  ReturnType<typeof createTaskAttachmentHelpers>;

type TaskDetailHelperDependencies = Pick<
  TaskRouteAttachmentContext,
  | "svc"
  | "projectsSvc"
  | "goalsSvc"
  | "workProductsSvc"
  | "documentsSvc"
  | "taskReferencesSvc"
  | "toPublicTask"
>;

export function createTaskDetailHelpers(context: TaskDetailHelperDependencies) {
  const { svc, projectsSvc, goalsSvc, workProductsSvc, documentsSvc, taskReferencesSvc, toPublicTask } =
    context;

  async function resolveTaskProjectAndGoal(task: {
    companyId: string;
    projectId: string | null;
    goalId: string | null;
  }) {
    const projectPromise = task.projectId ? projectsSvc.getById(task.projectId) : Promise.resolve(null);
    const directGoalPromise = task.goalId ? goalsSvc.getById(task.goalId) : Promise.resolve(null);
    const [project, directGoal] = await Promise.all([projectPromise, directGoalPromise]);

    if (directGoal) {
      return { project, goal: directGoal };
    }

    if (!task.projectId) {
      const defaultGoal = await goalsSvc.getDefaultCompanyGoal(task.companyId);
      return { project, goal: defaultGoal };
    }

    return { project, goal: null };
  }

  function compactTaskProject(project: Awaited<ReturnType<typeof resolveTaskProjectAndGoal>>["project"]) {
    if (!project) return null;
    return {
      id: project.id,
      companyId: project.companyId,
      goalIds: project.goalIds,
      goals: project.goals,
      name: project.name,
      description: project.description,
      status: project.status,
      leadAgentId: project.leadAgentId,
      targetDate: project.targetDate,
      color: project.color,
      icon: project.icon,
      env: null,
      pauseReason: project.pauseReason,
      pausedAt: project.pausedAt,
      managedByPlugin: project.managedByPlugin ?? null,
      taskCount: project.taskCount,
      budget: project.budget,
      archivedAt: project.archivedAt,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  async function respondWithTaskDetail(
    req: Request,
    res: Response,
    task: NonNullable<Awaited<ReturnType<typeof svc.getById>>>,
  ) {
    const inboxArchiveFieldsPromise =
      req.actor.type === "board" && req.actor.userId
        ? svc.getActiveInboxArchiveFields(task, req.actor.userId)
        : Promise.resolve({});
    const [
      { project, goal },
      ancestors,
      mentionedProjectIds,
      documentPayload,
      relations,
      blockerAttention,
      referenceSummary,
      inboxArchiveFields,
    ] = await Promise.all([
      resolveTaskProjectAndGoal(task),
      svc.getAncestors(task.id),
      svc.findMentionedProjectIds(task.id, { includeCommentBodies: false }),
      documentsSvc.getTaskDocumentPayload(task),
      svc.getRelationSummaries(task.id),
      svc.listBlockerAttention(task.companyId, [task]).then((map) => map.get(task.id) ?? null),
      taskReferencesSvc.listTaskReferenceSummary(task.id),
      inboxArchiveFieldsPromise,
    ]);
    const mentionedProjects =
      mentionedProjectIds.length > 0 ? await projectsSvc.listByIds(task.companyId, mentionedProjectIds) : [];
    const workProducts = await workProductsSvc.listForTask(task.id);
    res.json({
      ...toPublicTask(task),
      ...inboxArchiveFields,
      goalId: goal?.id ?? task.goalId,
      ancestors,
      ...(blockerAttention ? { blockerAttention } : {}),
      blockedBy: relations.blockedBy,
      blocks: relations.blocks,
      relatedWork: referenceSummary,
      referencedTaskIdentifiers: referenceSummary.outbound
        .map((item) => item.task.identifier)
        .filter((identifier): identifier is string => identifier !== null),
      ...documentPayload,
      project: compactTaskProject(project),
      goal: goal ?? null,
      mentionedProjects: mentionedProjects.map(toPublicProject),
      workProducts,
    });
  }
  return {
    resolveTaskProjectAndGoal,
    compactTaskProject,
    respondWithTaskDetail,
  };
}

export function createTaskRouteBaseContext(
  db: Db,
  storage: StorageService,
  opts: {
    searchService?: diagnostics.CompanySearchService;
    searchRateLimiter?: CompanySearchRateLimiter;
    pluginWorkerManager?: PluginWorkerManager;
    taskListDiagnostics?: listcache.TaskListDiagnostics;
    ordinaryTasks: OrdinaryTaskRuntime;
    pluginDomainEvents: PluginDomainEventPublisher;
    taskExecutionCancellation: Pick<
      TaskExecutionCancellationService,
      "requestScopeCancellationsInTransaction" | "reconcileRequestedCancellations"
    >;
  },
) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = taskService(db);
  const ordinaryTasks = opts.ordinaryTasks;
  const executionPolicyControl = taskExecutionPolicyControlService(db, {
    taskExecutionCancellation: opts.taskExecutionCancellation,
  });
  const access = accessService(db);
  const companiesSvc = companyService(db);
  let searchSvc = opts.searchService ?? null;
  const getSearchService = () => {
    searchSvc ??= companySearchService(db);
    return searchSvc;
  };
  const searchRateLimiter = opts.searchRateLimiter ?? subtree.defaultCompanySearchRateLimiter;
  const projectsSvc = projectService(db);
  const goalsSvc = goalService(db);
  const taskApprovalsSvc = taskApprovalService(db);
  const workProductsSvc = workProductService(db);
  const documentsSvc = documentService(db);
  const documentAnnotationsSvc = documentAnnotationService(db);
  const taskReferencesSvc = taskReferenceService(db);
  return {
    db,
    storage,
    opts,
    router,
    svc,
    ordinaryTasks,
    executionPolicyControl,
    access,
    companiesSvc,
    getSearchService,
    searchRateLimiter,
    projectsSvc,
    goalsSvc,
    taskApprovalsSvc,
    workProductsSvc,
    documentsSvc,
    documentAnnotationsSvc,
    taskReferencesSvc,
    ...diagnostics,
    ...subtree,
    ...listcache,
    ...listcoordinator,
  };
}

export type TaskRouteBaseContext = ReturnType<typeof createTaskRouteBaseContext>;

export function createTaskRouteContext(
  db: Db,
  storage: StorageService,
  opts: Parameters<typeof createTaskRouteBaseContext>[2],
) {
  const base = createTaskRouteBaseContext(db, storage, opts);
  const request = createTaskRequestHelpers(base);
  const attachment = createTaskAttachmentHelpers({ ...base, ...request });
  const detail = createTaskDetailHelpers({
    ...base,
    ...request,
    ...attachment,
  });
  return { ...base, ...request, ...attachment, ...detail };
}

export type TaskRouteContext = ReturnType<typeof createTaskRouteContext>;
export type TaskRouteOptions = Parameters<typeof createTaskRouteBaseContext>[2];
