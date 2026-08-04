import type { Db } from "@paperclipai/db";
import type { Request } from "express";
import { notFound } from "../errors.js";
import { assertCompanyAccess, hasCompanyAccess } from "./authz.js";

function assertBoardCanManageWorkspaceRuntimeServices(
  req: Request,
  companyId: string,
  notFoundMessage: string,
) {
  if (!hasCompanyAccess(req, companyId)) {
    throw notFound(notFoundMessage);
  }
  assertCompanyAccess(req, companyId);
}

export async function assertCanManageProjectWorkspaceRuntimeServices(
  _db: Db,
  req: Request,
  input: {
    companyId: string;
    projectWorkspaceId: string;
  },
) {
  assertBoardCanManageWorkspaceRuntimeServices(
    req,
    input.companyId,
    "Project workspace not found",
  );
}

export async function assertCanManageExecutionWorkspaceRuntimeServices(
  _db: Db,
  req: Request,
  input: {
    companyId: string;
    executionWorkspaceId: string;
    sourceIssueId?: string | null;
  },
) {
  assertBoardCanManageWorkspaceRuntimeServices(
    req,
    input.companyId,
    "Execution workspace not found",
  );
}
