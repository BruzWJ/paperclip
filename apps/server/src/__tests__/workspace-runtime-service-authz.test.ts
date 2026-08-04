import type { Db } from "@paperclipai/db";
import { describe, expect, it } from "vitest";
import {
  assertCanManageExecutionWorkspaceRuntimeServices,
  assertCanManageProjectWorkspaceRuntimeServices,
} from "../routes/workspace-runtime-service-authz.js";
import { testBoardSessionActor } from "./helpers/request-actor.js";

const db = {} as Db;
const companyId = "company-1";

function requestWithActor(actor: Record<string, unknown>) {
  return {
    actor,
    method: "POST",
  } as any;
}

describe("workspace runtime service authz helper", () => {
  it("allows a same-company board operator to manage project workspace runtime services", async () => {
    await expect(assertCanManageProjectWorkspaceRuntimeServices(
      db,
      requestWithActor(testBoardSessionActor({
        userId: "board-1",
        companyIds: [companyId],
      })),
      {
        companyId,
        projectWorkspaceId: "project-workspace-1",
      },
    )).resolves.toBeUndefined();
  });

  it("allows a same-company board operator to manage execution workspace runtime services", async () => {
    await expect(assertCanManageExecutionWorkspaceRuntimeServices(
      db,
      requestWithActor(testBoardSessionActor({
        userId: "board-1",
        companyIds: [companyId],
      })),
      {
        companyId,
        executionWorkspaceId: "execution-workspace-1",
        sourceIssueId: "issue-1",
      },
    )).resolves.toBeUndefined();
  });

  it("masks cross-company project workspace access as not found", async () => {
    await expect(assertCanManageProjectWorkspaceRuntimeServices(
      db,
      requestWithActor(testBoardSessionActor({
        userId: "board-2",
        companyIds: ["company-2"],
      })),
      {
        companyId,
        projectWorkspaceId: "project-workspace-1",
      },
    )).rejects.toMatchObject({
      status: 404,
      message: "Project workspace not found",
    });
  });

  it("masks cross-company execution workspace access as not found", async () => {
    await expect(assertCanManageExecutionWorkspaceRuntimeServices(
      db,
      requestWithActor(testBoardSessionActor({
        userId: "board-2",
        companyIds: ["company-2"],
      })),
      {
        companyId,
        executionWorkspaceId: "execution-workspace-1",
      },
    )).rejects.toMatchObject({
      status: 404,
      message: "Execution workspace not found",
    });
  });

  it("keeps project runtime-service REST unavailable to productive agent actors", async () => {
    await expect(assertCanManageProjectWorkspaceRuntimeServices(
      db,
      requestWithActor({
        type: "agent",
        source: "internal",
        companyId,
        agentId: "agent-1",
        runId: "run-1",
      }),
      {
        companyId,
        projectWorkspaceId: "project-workspace-1",
      },
    )).rejects.toMatchObject({
      status: 404,
      message: "Project workspace not found",
    });
  });

  it("keeps execution runtime-service REST unavailable to productive agent actors", async () => {
    await expect(assertCanManageExecutionWorkspaceRuntimeServices(
      db,
      requestWithActor({
        type: "agent",
        source: "internal",
        companyId,
        agentId: "agent-1",
        runId: "run-1",
      }),
      {
        companyId,
        executionWorkspaceId: "execution-workspace-1",
        sourceIssueId: "issue-1",
      },
    )).rejects.toMatchObject({
      status: 404,
      message: "Execution workspace not found",
    });
  });
});
