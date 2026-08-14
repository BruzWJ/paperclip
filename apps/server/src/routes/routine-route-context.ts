import type { Db } from "@paperclipai/db";
import { Router, type Request, type Response } from "express";
import { forbidden } from "../errors.js";
import type { SecretsRuntimeConfig } from "../secrets/types.js";
import {
  accessService,
  documentAnnotationService,
  logActivity,
  routineService,
  type OrdinaryTaskRuntime,
} from "../services/index.js";
import { assertBoard, assertCompanyAccess, getAccessibleResource } from "./authz.js";

const ANNOTATION_STATUSES = ["open", "resolved", "all"] as const;

export function createRoutineRouteContext(
  db: Db,
  opts: {
    ordinaryTasks: OrdinaryTaskRuntime;
    secretsRuntime: SecretsRuntimeConfig;
  },
) {
  const router = Router({ caseSensitive: true, strict: true });
  const svc = routineService(db, {
    ordinaryTasks: opts.ordinaryTasks,
    secretsRuntime: opts.secretsRuntime,
  });
  const documentAnnotationsSvc = documentAnnotationService(db);
  const access = accessService(db);
  const routineDocumentKey = "description";

  function annotationActorInput(req: Request) {
    assertBoard(req);
    return {
      actorType: "user" as const,
      actorId: req.actor.userId,
      userId: req.actor.userId,
    };
  }

  async function remapRoutineDescriptionAnnotations(req: Request, routineId: string) {
    const doc = await svc.getDescriptionDocument(routineId);
    if (!doc) return;
    const remapped = await documentAnnotationsSvc.remapOpenThreadsForRoutineDocument({
      routineId,
      key: routineDocumentKey,
      documentId: doc.id,
      nextRevisionId: doc.latestRevisionId,
      nextRevisionNumber: doc.latestRevisionNumber,
      nextBody: doc.body,
    });
    assertBoard(req);
    for (const remap of remapped) {
      await logActivity(db, {
        companyId: doc.companyId,
        actorType: "user",
        actorId: req.actor.userId,
        action: "routine.document_annotation_remapped",
        entityType: "routine",
        entityId: routineId,
        details: {
          documentKey: doc.key,
          documentId: doc.id,
          threadId: remap.thread.id,
          revisionNumber: doc.latestRevisionNumber,
          anchorState: remap.thread.anchorState,
          anchorConfidence: remap.thread.anchorConfidence,
          snapshotId: remap.snapshot.id,
        },
      });
    }
  }

  async function assertBoardRoutineAuthority(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "task:mutate",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) throw forbidden(decision.explanation);
  }

  function assertCanManageCompanyRoutine(req: Request, companyId: string, _assigneeAgentId?: string | null) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
  }

  async function getManageableRoutine(
    req: Request,
    res: Response,
    routineId: string,
    notFoundMessage = "Routine not found",
  ) {
    const routine = await getAccessibleResource(req, res, svc.get(routineId), notFoundMessage);
    if (!routine) return null;
    assertBoard(req);
    assertCompanyAccess(req, routine.companyId);
    return routine;
  }

  async function logRoutineRevisionCreated(
    req: Request,
    input: {
      companyId: string;
      routineId: string;
      revisionId: string | null;
      revisionNumber: number;
      changeSummary?: string | null;
      triggerCount?: number | null;
    },
  ) {
    if (!input.revisionId) return;
    assertBoard(req);
    await logActivity(db, {
      companyId: input.companyId,
      actorType: "user",
      actorId: req.actor.userId,
      action: "routine.revision_created",
      entityType: "routine",
      entityId: input.routineId,
      details: {
        revisionId: input.revisionId,
        revisionNumber: input.revisionNumber,
        changeSummary: input.changeSummary ?? null,
        triggerCount: input.triggerCount ?? null,
      },
    });
  }
  return {
    router,
    db,
    opts,
    svc,
    documentAnnotationsSvc,
    access,
    routineDocumentKey,
    annotationActorInput,
    remapRoutineDescriptionAnnotations,
    assertBoardRoutineAuthority,
    assertCanManageCompanyRoutine,
    getManageableRoutine,
    logRoutineRevisionCreated,
  };
}

export type RoutineRouteContext = ReturnType<typeof createRoutineRouteContext>;
export type RoutineRouteOptions = Parameters<typeof createRoutineRouteContext>[1];
