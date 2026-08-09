import {
  Router,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import {
  createChildIssueSchema,
  createIssueSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  OrdinaryIssueRuntimeRejected,
  type OrdinaryIssueRuntime,
} from "../services/ordinary-issue-runtime.js";
import {
  conflict,
  forbidden,
  notFound,
  unprocessable,
} from "../errors.js";
import {
  assertBoard,
  assertCompanyAccess,
  getAccessibleResource,
} from "./authz.js";

type IssueIngressParent = {
  id: string;
  companyId: string;
};

function canonicalIssueCreateError(error: unknown): never {
  if (!(error instanceof OrdinaryIssueRuntimeRejected)) {
    throw error;
  }
  const details = { code: error.reason };
  if (error.reason === "create_idempotency_conflict") {
    throw conflict(error.message, details);
  }
  if (error.reason === "parent_issue_invalid") {
    throw notFound("Parent issue not found");
  }
  if (
    error.reason === "company_inactive" ||
    error.reason === "canonical_create_incomplete"
  ) {
    throw conflict(error.message, details);
  }
  throw unprocessable(error.message, details);
}

function requireNamedBoardIssueCreator(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    assertBoard(req);
    if (!req.actor.userId.trim()) {
      throw forbidden(
        "Issue creation requires an authenticated named board user",
      );
    }
    next();
  } catch (error) {
    next(error);
  }
}

export function issueIngressRoutes(input: {
  ordinaryIssues: OrdinaryIssueRuntime;
  getIssueById(id: string): Promise<IssueIngressParent | null>;
}) {
  const router = Router();

  router.post(
    "/companies/:companyId/issues",
    requireNamedBoardIssueCreator,
    validate(createIssueSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const userId = req.actor.userId!.trim();
      try {
        const created = await input.ordinaryIssues.create({
          companyId,
          request: req.body.request,
          ownerAgentId: req.body.ownerAgentId,
          creator: { kind: "user/board", userId },
          idempotencyKey: req.body.idempotencyKey,
          sourceKind: "issue_request",
          title: req.body.title ?? null,
          projectId: req.body.projectId ?? null,
          goalId: req.body.goalId ?? null,
          parentId: req.body.parentId ?? null,
          priority: req.body.priority,
        });
        res.status(created.retried ? 200 : 201).json({
          ...created.issue,
          refId: created.ref.id,
          retried: created.retried,
        });
      } catch (error) {
        canonicalIssueCreateError(error);
      }
    },
  );

  router.post(
    "/issues/:id/children",
    requireNamedBoardIssueCreator,
    validate(createChildIssueSchema),
    async (req, res) => {
      const parentId = req.params.id as string;
      const parent = await getAccessibleResource(
        req,
        res,
        input.getIssueById(parentId),
        "Parent issue not found",
      );
      if (!parent) return;
      const userId = req.actor.userId!.trim();
      try {
        const created = await input.ordinaryIssues.create({
          companyId: parent.companyId,
          request: req.body.request,
          ownerAgentId: req.body.ownerAgentId,
          creator: { kind: "user/board", userId },
          idempotencyKey: req.body.idempotencyKey,
          sourceKind: "issue_request",
          title: req.body.title ?? null,
          projectId: req.body.projectId ?? null,
          goalId: req.body.goalId ?? null,
          parentId: parent.id,
          priority: req.body.priority,
        });
        res.status(created.retried ? 200 : 201).json({
          ...created.issue,
          refId: created.ref.id,
          retried: created.retried,
        });
      } catch (error) {
        canonicalIssueCreateError(error);
      }
    },
  );

  return router;
}
