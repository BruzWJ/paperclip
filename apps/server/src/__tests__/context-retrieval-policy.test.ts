import { describe, expect, it } from "vitest";
import { resolveContextDial } from "../services/context-dial-resolver.ts";
import {
  ContextRetrievalDenied,
  createContextRetrievalService,
  type CanonicalRunTrace,
  type ContextRetrievalIssueProjection,
  type ContextRetrievalRepository,
} from "../services/context-retrieval.ts";

function issue(
  id: string,
  parentId: string | null,
): ContextRetrievalIssueProjection {
  return {
    id,
    identifier: `PAP-${id}`,
    title: id,
    request: id,
    status: "open",
    disposition: null,
    priority: "medium",
    creator: { kind: "system", sourceKind: "recovery" },
    owner: { kind: "agent", agentId: "owner" },
    parentId,
    directChildCount: 0,
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function canonicalTrace(
  runId: string,
  issueId: string,
): CanonicalRunTrace {
  return {
    runId,
    runKind: "productive",
    issueId,
    status: "succeeded",
    startedAt: "2026-07-28T00:00:00.000Z",
    finishedAt: "2026-07-28T00:00:01.000Z",
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      knownDeltaAmount: "0",
    },
    checkpoint: null,
    turns: [],
    outcome: null,
    comments: [],
  };
}

function repository(): ContextRetrievalRepository {
  const reach = new Map([
    ["active", { sameCompany: true, active: true, descendant: false }],
    ["child", { sameCompany: true, active: false, descendant: true }],
    ["other", { sameCompany: true, active: false, descendant: false }],
    ["cross", { sameCompany: false, active: false, descendant: false }],
  ]);
  const runIssues = new Map([
    ["run-active", "active"],
    ["run-child", "child"],
    ["run-other", "other"],
    ["run-cross", "cross"],
  ]);
  return {
    async issueReach({ issueId }) {
      return reach.get(issueId) ?? null;
    },
    async listTopLevelIssues() {
      return [];
    },
    async listDirectChildren({ issueId }) {
      return [issue(`${issueId}-child`, issueId)];
    },
    async listIssueComments() {
      return [];
    },
    async runIssue({ runId }) {
      const issueId = runIssues.get(runId);
      return issueId ? { issueId } : null;
    },
    async readCanonicalRunTrace({ runId }) {
      const issueId = runIssues.get(runId);
      return issueId ? canonicalTrace(runId, issueId) : null;
    },
  };
}

function scope(
  agent: Parameters<typeof resolveContextDial>[0]["agent"],
) {
  return {
    companyId: "company",
    activeIssueId: "active",
    dial: resolveContextDial({ agent }).effective,
  };
}

function service() {
  return createContextRetrievalService({
    cursorSecret: "policy-test-secret",
    repository: repository(),
  });
}

const REACH_CASES = [false, true].flatMap((current) =>
  [false, true].flatMap((descendant) =>
    [false, true].map((company) => ({
      name: `current=${current} descendant=${descendant} company=${company}`,
      current,
      descendant,
      company,
    })),
  ),
);

describe("context retrieval policy", () => {
  it("keeps sub-only omission, explicit-active rejection, and proper-descendant reach exact", async () => {
    const api = service();
    const subOnly = scope({ list_sub_issues: true });

    await expect(api.listSubIssues(subOnly)).resolves.toMatchObject({
      items: [{ parentId: "active" }],
    });
    await expect(
      api.listSubIssues(subOnly, { issueId: undefined }),
    ).resolves.toMatchObject({
      items: [{ parentId: "active" }],
    });
    await expect(
      api.listSubIssues(subOnly, { issueId: "active" }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);
    await expect(
      api.listSubIssues(subOnly, { issueId: "child" }),
    ).resolves.toMatchObject({
      items: [{ parentId: "child" }],
    });
    await expect(
      api.listSubIssues(subOnly, { issueId: "other" }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);
  });

  it("lets company listing target any same-company issue but never cross company", async () => {
    const api = service();
    const company = scope({ list_company_issues: true });

    await expect(api.listSubIssues(company)).resolves.toBeDefined();
    for (const issueId of ["active", "child", "other"]) {
      await expect(
        api.listSubIssues(company, { issueId }),
      ).resolves.toBeDefined();
    }
    await expect(
      api.listSubIssues(company, { issueId: "cross" }),
    ).rejects.toBeInstanceOf(ContextRetrievalDenied);
  });

  it.each(REACH_CASES)(
    "enforces the exact comment reach for $name",
    async ({ current, descendant, company }) => {
      const api = service();
      const activeScope = scope({
        read_issue_comments: current,
        read_sub_issue_comments: descendant,
        read_company_issue_comments: company,
      });
      const assertResult = async (
        accepted: boolean,
        input: { issueId?: string },
      ) => {
        const result = api.readIssueComments(activeScope, input);
        if (accepted) {
          await expect(result).resolves.toBeDefined();
        } else {
          await expect(result).rejects.toBeInstanceOf(
            ContextRetrievalDenied,
          );
        }
      };

      await assertResult(current, {});
      await assertResult(current, { issueId: undefined });
      await assertResult(current || company, { issueId: "active" });
      await assertResult(descendant || company, { issueId: "child" });
      await assertResult(company, { issueId: "other" });
      await assertResult(false, { issueId: "cross" });
    },
  );

  it.each(REACH_CASES)(
    "enforces the exact run reach for $name",
    async ({ current, descendant, company }) => {
      const api = service();
      const activeScope = scope({
        read_issue_agent_run: current,
        read_sub_issue_agent_run: descendant,
        read_company_issue_agent_run: company,
      });
      const expected = new Map([
        ["run-active", current || company],
        ["run-child", descendant || company],
        ["run-other", company],
        ["run-cross", false],
      ]);
      for (const [runId, accepted] of expected) {
        const result = api.readIssueAgentRun(activeScope, { runId });
        if (accepted) {
          await expect(result).resolves.toBeDefined();
        } else {
          await expect(result).rejects.toBeInstanceOf(
            ContextRetrievalDenied,
          );
        }
      }
    },
  );
});
