import { describe, expect, it } from "vitest";
import { authorizationService } from "../services/authorization.js";
import {
  resolveCurrentIssueOwnerRunLinkage,
  resolveProductiveRunLinkage,
} from "../services/productive-run-linkage.js";
import { createMockDb } from "./helpers/mock-db.js";

const companyId = "00000000-0000-4000-8000-000000000001";
const agentId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";
const runId = "00000000-0000-4000-8000-000000000004";
const refId = "00000000-0000-4000-8000-000000000005";
const sessionId = "00000000-0000-4000-8000-000000000006";
const adapterConfigRevisionId = "00000000-0000-4000-8000-000000000007";
const issueExecutionAuthorityId = "00000000-0000-4000-8000-000000000008";

const currentOwnerLinkage = {
  runId,
  runStatus: "running" as const,
  companyId,
  agentId,
  refId,
  issueId,
  projectId: null,
  routineId: null,
  sessionId,
  ownershipEpoch: 1,
  mode: "owner" as const,
  sourceKind: "issue_request" as const,
  sourceRecordId: issueId,
  adapterConfigRevisionId,
  issueExecutionAuthorityId,
  consultExecutionId: null,
  issueExecutionPolicy: { authorizationPolicy: {} },
  startedAt: new Date("2026-04-21T10:00:00.000Z"),
  finishedAt: null,
  createdAt: new Date("2026-04-21T09:59:00.000Z"),
};

describe("productive run linkage", () => {
  it("resolves the exact typed ref from the canonical joined projection", async () => {
    const { db, calls } = createMockDb({ select: [[currentOwnerLinkage]] });

    await expect(resolveProductiveRunLinkage(db, {
      runId,
      companyId,
      agentId,
    })).resolves.toMatchObject({
      runId,
      companyId,
      agentId,
      refId,
      issueId,
      adapterConfigRevisionId,
      issueExecutionPolicy: { authorizationPolicy: {} },
    });
    expect(calls.filter((call) => call.method === "innerJoin")).toHaveLength(5);
    expect(calls.find((call) => call.method === "limit")?.args).toEqual([1]);
  });

  it("projects a run only while it is the current owner epoch", async () => {
    const { db } = createMockDb({ select: [[currentOwnerLinkage], []] });

    await expect(resolveCurrentIssueOwnerRunLinkage(db, {
      companyId,
      issueId,
    })).resolves.toMatchObject({
      runId,
      refId,
      issueId,
      agentId,
      ownershipEpoch: 1,
      mode: "owner",
    });

    await expect(resolveCurrentIssueOwnerRunLinkage(db, {
      companyId,
      issueId,
    })).resolves.toBeNull();
  });

  it("keeps generic REST denied for a canonically linked productive run", async () => {
    const { db } = createMockDb({
      select: [
        [currentOwnerLinkage],
        [{ id: agentId, companyId, status: "running" }],
      ],
    });

    await expect(resolveProductiveRunLinkage(db, {
      runId,
      companyId,
      agentId,
    })).resolves.toMatchObject({ refId, issueId });
    await expect(authorizationService(db).decide({
      actor: {
        type: "agent",
        agentId,
        companyId,
        runId,
        source: "internal",
      },
      action: "issue:read",
      resource: {
        type: "issue",
        companyId,
        issueId,
        ownerKind: "agent",
        ownerAgentId: agentId,
      },
    })).resolves.toMatchObject({
      allowed: false,
      reason: "deny_unsupported_action",
      explanation:
        "Agent credentials cannot use generic REST content or control surfaces; use the run-scoped compiled interface.",
    });
  });
});
