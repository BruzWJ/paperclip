import { describe, expect, it } from "vitest";
import {
  evaluateAgentInvokability,
  InvokableIssueOwnerRejected,
  resolveInvokableIssueOwner,
  resolveInvokableIssueOwnerCatalog,
  type AgentOrgRow,
  type InvokableIssueOwnerAgent,
  type InvokableIssueOwnerRevision,
} from "../services/agent-invokability.ts";
import {
  listCompanyAgentGraphDescendants,
} from "../services/agent-org-graph-lock.ts";

function agent(partial: Partial<AgentOrgRow> & Pick<AgentOrgRow, "id">): AgentOrgRow {
  return {
    companyId: "company-1",
    name: partial.id,
    reportsTo: null,
    status: "active",
    ...partial,
  };
}

function ownerAgent(
  partial: Partial<InvokableIssueOwnerAgent> & Pick<InvokableIssueOwnerAgent, "id">,
): InvokableIssueOwnerAgent {
  return {
    ...agent(partial),
    currentAdapterConfigRevisionId: `${partial.id}-revision`,
    ...partial,
  };
}

function ownerRevision(
  id: string,
  agentId: string,
): InvokableIssueOwnerRevision {
  return {
    id,
    companyId: "company-1",
    agentId,
  };
}

describe("agent invokability", () => {
  it("blocks active descendants under a terminated manager as invalid-org-chain", () => {
    const rows = [
      agent({ id: "root", status: "terminated" }),
      agent({ id: "manager", reportsTo: "root" }),
      agent({ id: "coder", reportsTo: "manager" }),
    ];

    const result = evaluateAgentInvokability(rows[2], rows);

    expect(result).toMatchObject({
      invokable: false,
      reason: "manager_terminated",
      invalidOrgChain: true,
      details: {
        managerId: "root",
        reportingChainAgentIds: ["manager", "root"],
      },
    });
  });

  it("reports missing managers and cycles as invalid-org-chain", () => {
    const missingManager = [agent({ id: "coder", reportsTo: "missing" })];
    expect(evaluateAgentInvokability(missingManager[0], missingManager)).toMatchObject({
      invokable: false,
      reason: "manager_missing",
      invalidOrgChain: true,
    });

    const cycle = [
      agent({ id: "a", reportsTo: "b" }),
      agent({ id: "b", reportsTo: "a" }),
    ];
    expect(evaluateAgentInvokability(cycle[0], cycle)).toMatchObject({
      invokable: false,
      reason: "reporting_cycle",
      invalidOrgChain: true,
    });
  });

  it("lists the complete locked subtree in deterministic parent-before-child order", () => {
    const rows = [
      agent({ id: "root", status: "terminated" }),
      agent({ id: "manager-b", reportsTo: "root" }),
      agent({ id: "coder", reportsTo: "manager-a" }),
      agent({ id: "old-coder", reportsTo: "manager-b", status: "terminated" }),
      agent({ id: "manager-a", reportsTo: "root" }),
      agent({ id: "other-root" }),
    ];

    expect(
      listCompanyAgentGraphDescendants("root", rows).map((row) => row.id),
    ).toEqual(["manager-a", "manager-b", "coder", "old-coder"]);
  });

  it("uses one typed owner predicate for lifecycle, org-chain, and exact revision failures", () => {
    const active = ownerAgent({ id: "active" });
    const valid = resolveInvokableIssueOwner({
      companyId: "company-1",
      ownerAgentId: active.id,
      companyAgents: [active],
      adapterRevisions: [
        ownerRevision(active.currentAdapterConfigRevisionId!, active.id),
      ],
    });
    expect(valid).toMatchObject({
      owner: { id: "active" },
      revisionId: "active-revision",
    });

    const cases: Array<{
      name: string;
      agents: InvokableIssueOwnerAgent[];
      revisions: InvokableIssueOwnerRevision[];
      expectedReason: string;
    }> = [
      {
        name: "paused",
        agents: [ownerAgent({ id: "paused", status: "paused" })],
        revisions: [ownerRevision("paused-revision", "paused")],
        expectedReason: "owner_not_invokable:paused",
      },
      {
        name: "pending approval",
        agents: [ownerAgent({ id: "pending", status: "pending_approval" })],
        revisions: [ownerRevision("pending-revision", "pending")],
        expectedReason: "owner_not_invokable:pending_approval",
      },
      {
        name: "revisionless",
        agents: [ownerAgent({ id: "revisionless", currentAdapterConfigRevisionId: null })],
        revisions: [],
        expectedReason: "owner_revision_missing",
      },
      {
        name: "dangling revision",
        agents: [ownerAgent({ id: "dangling" })],
        revisions: [],
        expectedReason: "owner_revision_missing",
      },
      {
        name: "cross-agent revision",
        agents: [ownerAgent({ id: "cross" })],
        revisions: [ownerRevision("cross-revision", "other")],
        expectedReason: "owner_revision_missing",
      },
      {
        name: "invalid reporting chain",
        agents: [
          ownerAgent({ id: "terminated-manager", status: "terminated" }),
          ownerAgent({ id: "invalid-chain", reportsTo: "terminated-manager" }),
        ],
        revisions: [
          ownerRevision(
            "terminated-manager-revision",
            "terminated-manager",
          ),
          ownerRevision("invalid-chain-revision", "invalid-chain"),
        ],
        expectedReason: "owner_not_invokable:manager_terminated",
      },
    ];

    for (const testCase of cases) {
      const owner = testCase.agents.at(-1)!;
      try {
        resolveInvokableIssueOwner({
          companyId: "company-1",
          ownerAgentId: owner.id,
          companyAgents: testCase.agents,
          adapterRevisions: testCase.revisions,
        });
        throw new Error(`Expected ${testCase.name} to be rejected`);
      } catch (error) {
        expect(error).toBeInstanceOf(InvokableIssueOwnerRejected);
        expect(error).toMatchObject({
          code: "invokable_issue_owner_rejected",
          reason: testCase.expectedReason,
        });
      }
    }
  });

  it("omits every non-invokable or unresolved owner from the presentation catalog", () => {
    const valid = ownerAgent({ id: "valid" });
    const paused = ownerAgent({ id: "paused", status: "paused" });
    const pending = ownerAgent({ id: "pending", status: "pending_approval" });
    const terminatedManager = ownerAgent({ id: "terminated-manager", status: "terminated" });
    const invalidChain = ownerAgent({
      id: "invalid-chain",
      reportsTo: terminatedManager.id,
    });
    const revisionless = ownerAgent({
      id: "revisionless",
      currentAdapterConfigRevisionId: null,
    });
    const secondValid = ownerAgent({ id: "second-valid" });

    const catalog = resolveInvokableIssueOwnerCatalog({
      companyId: "company-1",
      companyAgents: [
        valid,
        paused,
        pending,
        terminatedManager,
        invalidChain,
        revisionless,
        secondValid,
      ],
      adapterRevisions: [
        ownerRevision(valid.currentAdapterConfigRevisionId!, valid.id),
        ownerRevision(paused.currentAdapterConfigRevisionId!, paused.id),
        ownerRevision(pending.currentAdapterConfigRevisionId!, pending.id),
        ownerRevision(
          terminatedManager.currentAdapterConfigRevisionId!,
          terminatedManager.id,
        ),
        ownerRevision(
          invalidChain.currentAdapterConfigRevisionId!,
          invalidChain.id,
        ),
        ownerRevision(
          secondValid.currentAdapterConfigRevisionId!,
          secondValid.id,
        ),
      ],
    });

    expect([...catalog.keys()]).toEqual(["valid", "second-valid"]);
  });
});
