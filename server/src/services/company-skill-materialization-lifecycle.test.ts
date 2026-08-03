import { describe, expect, it, vi } from "vitest";
import {
  agentAdapterConfigRevisions,
  companySkills,
  issueExecutionAttempts,
  issueExecutionSessions,
} from "@paperclipai/db";
import {
  selectedCompanySkillMaterializationKey,
  selectedCompanySkillRuntimeName,
} from "@paperclipai/adapter-utils/selected-company-skills";
import {
  collectCompanySkillMaterializationIfUnreferencedInTransaction,
  type ReapedCompanySkillMaterialization,
} from "./company-skill-materialization-lifecycle.js";

const identity = {
  companyId: "00000000-0000-4000-8000-000000000001",
  agentId: "00000000-0000-4000-8000-000000000002",
  executionTargetIdentity: "c".repeat(64),
  adapterConfigRevisionId: "00000000-0000-4000-8000-000000000003",
} as const;
const selected = [{
  key: "company/example/review",
  runtimeName: selectedCompanySkillRuntimeName(
    "company/example/review",
    "review",
  ),
  versionId: "00000000-0000-4000-8000-000000000004",
  files: [{
    path: "SKILL.md",
    kind: "skill" as const,
    content: "# Review\n",
  }],
}] as const;
const materializationKey = selectedCompanySkillMaterializationKey({
  identity,
  entries: selected,
}).materializationKey;

const revision = {
  id: identity.adapterConfigRevisionId,
  companyId: identity.companyId,
  agentId: identity.agentId,
  executionTargetDigest: identity.executionTargetIdentity,
  acpConfiguration: {
    contractVersion: "acp-subprocess/v1",
    launchProfile: {
      registryName: "test",
      targetNativeCli: "test-native",
      command: "/opt/test-acp",
      args: [],
      frontendPackage: "@paperclip-test/test-acp",
      frontendVersion: "1.0.0",
      frontendDigest: "b".repeat(64),
    },
    sessionConfigSelections: [
      { configId: "model", value: "provider/model" },
    ],
    model: {
      id: "provider/model",
      label: "Provider model",
      value: "provider/model",
      limits: {
        contextTokenLimit: 128_000,
        outputTokenLimit: 32_000,
      },
    },
    executionTargetSelector: {
      defaultEnvironmentId: "00000000-0000-4000-8000-000000000005",
      executionTargetDriver: "local",
      executionTargetDigest: identity.executionTargetIdentity,
    },
    workspaceSelector: { kind: "issue_execution_workspace" },
    companySkillPins: [{
      key: selected[0].key,
      versionId: selected[0].versionId,
    }],
    skillChannel: "isolated_skills_home",
  },
};

function transactionFixture(input: {
  readonly activeAttempt?: boolean;
  readonly eligibleCorrelation?: boolean;
  readonly adapterRevision?: unknown;
}) {
  const events: string[] = [];
  const rowsFor = (table: unknown): readonly unknown[] => {
    if (table === agentAdapterConfigRevisions) {
      return [input.adapterRevision ?? revision];
    }
    if (table === companySkills) {
      return [{
        key: selected[0].key,
        slug: "review",
        skillId: "00000000-0000-4000-8000-000000000006",
        versionId: selected[0].versionId,
        versionSkillId: "00000000-0000-4000-8000-000000000006",
        fileInventory: selected[0].files,
      }];
    }
    if (table === issueExecutionAttempts) {
      events.push("active-attempt-check");
      return input.activeAttempt ? [{ id: "attempt" }] : [];
    }
    if (table === issueExecutionSessions) {
      events.push("native-correlation-check");
      return input.eligibleCorrelation ? [{ id: "correlation" }] : [];
    }
    throw new Error("unexpected materialization lifecycle table");
  };
  const select = () => {
    let table: unknown;
    const query = {
      from(value: unknown) {
        table = value;
        return query;
      },
      innerJoin() {
        return query;
      },
      where() {
        return query;
      },
      limit() {
        return query;
      },
      then<TResult1 = readonly unknown[], TResult2 = never>(
        onfulfilled?: ((value: readonly unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(rowsFor(table)).then(onfulfilled, onrejected);
      },
    };
    return query;
  };
  return {
    events,
    transaction: {
      select,
      async execute() {
        events.push("advisory-fence");
        return [];
      },
    },
  };
}

function candidate(
  collectExact: ReapedCompanySkillMaterialization["collectExact"],
): ReapedCompanySkillMaterialization {
  return {
    identity,
    materializationKey,
    collectExact,
  };
}

describe("correlation-fenced selected company skill materialization GC", () => {
  it("performs no lifecycle I/O without a verified reaped materialization", async () => {
    const select = vi.fn();
    const execute = vi.fn();

    await expect(
      collectCompanySkillMaterializationIfUnreferencedInTransaction(
        { select, execute } as never,
        null,
      ),
    ).resolves.toBeNull();
    expect(select).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a materialization candidate for the zero-I/O operator-native channel", async () => {
    const fixture = transactionFixture({
      adapterRevision: {
        ...revision,
        acpConfiguration: {
          ...revision.acpConfiguration,
          companySkillPins: [],
          skillChannel: "operator_native",
        },
      },
    });
    const collectExact = vi.fn();

    await expect(
      collectCompanySkillMaterializationIfUnreferencedInTransaction(
        fixture.transaction as never,
        candidate(collectExact),
      ),
    ).rejects.toThrow(
      "operator_native produced a Paperclip materialization candidate",
    );
    expect(collectExact).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  it.each([
    {
      label: "materialization key",
      overrides: { materializationKey: "f".repeat(64) },
    },
    {
      label: "company identity",
      overrides: {
        identity: {
          ...identity,
          companyId: "00000000-0000-4000-8000-000000000011",
        },
      },
    },
    {
      label: "agent identity",
      overrides: {
        identity: {
          ...identity,
          agentId: "00000000-0000-4000-8000-000000000012",
        },
      },
    },
    {
      label: "physical-target identity",
      overrides: {
        identity: {
          ...identity,
          executionTargetIdentity: "d".repeat(64),
        },
      },
    },
    {
      label: "adapter-revision identity",
      overrides: {
        identity: {
          ...identity,
          adapterConfigRevisionId:
            "00000000-0000-4000-8000-000000000013",
        },
      },
    },
  ])("rejects a candidate with the wrong complete $label", async ({ overrides }) => {
    const fixture = transactionFixture({});
    const collectExact = vi.fn();
    const exactCandidate = candidate(collectExact);

    await expect(
      collectCompanySkillMaterializationIfUnreferencedInTransaction(
        fixture.transaction as never,
        { ...exactCandidate, ...overrides } as ReapedCompanySkillMaterialization,
      ),
    ).rejects.toThrow(
      "materialization collection candidate crossed its complete revision key",
    );
    expect(collectExact).not.toHaveBeenCalled();
    expect(fixture.events).toEqual(["advisory-fence"]);
  });

  it("retains the exact key while an active attempt references its revision", async () => {
    const fixture = transactionFixture({ activeAttempt: true });
    const collectExact = vi.fn();

    await expect(
      collectCompanySkillMaterializationIfUnreferencedInTransaction(
        fixture.transaction as never,
        candidate(collectExact),
      ),
    ).resolves.toEqual({
      outcome: "retained_active_attempt",
      materializationKey,
    });
    expect(collectExact).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      "advisory-fence",
      "active-attempt-check",
    ]);
  });

  it("retains the exact key while an eligible/current native correlation references it", async () => {
    const fixture = transactionFixture({ eligibleCorrelation: true });
    const collectExact = vi.fn();

    await expect(
      collectCompanySkillMaterializationIfUnreferencedInTransaction(
        fixture.transaction as never,
        candidate(collectExact),
      ),
    ).resolves.toEqual({
      outcome: "retained_native_correlation",
      materializationKey,
    });
    expect(collectExact).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([
      "advisory-fence",
      "active-attempt-check",
      "native-correlation-check",
    ]);
  });

  it("collects only after the same advisory fence sees zero exact references", async () => {
    const fixture = transactionFixture({});
    const collectExact = vi.fn(async (expectedKey: string) => {
      fixture.events.push("target-exact-key-collection");
      return {
        materializationKey: expectedKey,
        outcome: "collected" as const,
      };
    });

    await expect(
      collectCompanySkillMaterializationIfUnreferencedInTransaction(
        fixture.transaction as never,
        candidate(collectExact),
      ),
    ).resolves.toEqual({ outcome: "collected", materializationKey });
    expect(collectExact).toHaveBeenCalledWith(materializationKey);
    expect(fixture.events).toEqual([
      "advisory-fence",
      "active-attempt-check",
      "native-correlation-check",
      "target-exact-key-collection",
    ]);
  });
});
