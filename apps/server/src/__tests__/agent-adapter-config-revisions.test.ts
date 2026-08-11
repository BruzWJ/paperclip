import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentAdapterConfigurationService,
} from "../services/agent-adapter-config-revisions.js";
import { createMockDb, type MockDbHarness } from "./helpers/mock-db.js";

const adapterRegistry = vi.hoisted(() => ({
  refreshAcpxAdapters: vi.fn(),
  findServerAdapterImplementation: vi.fn(),
}));

vi.mock("../adapters/registry.js", () => adapterRegistry);

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const boardUserId = "board-user";
const now = new Date("2026-08-01T12:00:00.000Z");

const noCompanySkills = {
  companySkillPins: [],
};

const TEST_ADAPTER = Object.freeze({
  type: "codex",
  definition: Object.freeze({
    version: "acpx-runtime/v1" as const,
    launchProfile: Object.freeze({ registryName: "codex" }),
    environment: Object.freeze({
      cwd: "execution-workspace" as const,
      additionalDirectories: "authorized-workspace-only" as const,
      environmentKeys: Object.freeze([]),
    }),
    runtime: Object.freeze({
      controls: Object.freeze(["session/status", "session/set_config_option"]),
    }),
    ui: Object.freeze({
      label: "Codex fixture",
      description: "Test-only ACPX registry fixture.",
    }),
    configSchema: Object.freeze({
      fields: Object.freeze([
        Object.freeze({
          key: "model",
          label: "Model",
          type: "select" as const,
          required: true,
          options: Object.freeze([
            Object.freeze({ label: "GPT-5.6", value: "gpt-5.6" }),
            Object.freeze({ label: "GPT-5.6 Sol", value: "gpt-5.6-sol" }),
          ]),
        }),
      ]),
    }),
    configOptions: Object.freeze([
      Object.freeze({
        id: "model",
        configKey: "model",
        label: "Model",
        required: true as const,
        values: Object.freeze([
          Object.freeze({ label: "GPT-5.6", value: "gpt-5.6" }),
          Object.freeze({ label: "GPT-5.6 Sol", value: "gpt-5.6-sol" }),
        ]),
      }),
    ]),
    modelConfigOptionId: "model",
    models: Object.freeze([
      Object.freeze({
        id: "gpt-5.6",
        label: "GPT-5.6",
        value: "gpt-5.6",
        limits: null,
      }),
      Object.freeze({
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        value: "gpt-5.6-sol",
        limits: null,
      }),
    ]),
    modelProfiles: Object.freeze([]),
    configurationDoc: "Supplied by the ACPX test registry.",
  }),
});

const TEST_IMPLEMENTATION_IDENTITY = Object.freeze({
  adapterType: "codex",
  definitionVersion: "acpx-runtime/v1" as const,
  protocolVersion: 1 as const,
  packageName: "acpx",
  packageVersion: "test-runtime",
  buildIdentity: "acpx-test-runtime:codex",
  artifactDigest: "a".repeat(64),
});

function adapterConfig(model: "gpt-5.6" | "gpt-5.6-sol") {
  return { model };
}

function agent(currentAdapterConfigRevisionId: string | null = null) {
  return {
    id: agentId,
    companyId,
    name: "Revision owner",
    status: "idle",
    adapterType: currentAdapterConfigRevisionId ? "codex" : null,
    adapterConfig: currentAdapterConfigRevisionId ? adapterConfig("gpt-5.6") : null,
    runtimeConfig: {},
    currentAdapterConfigRevisionId,
    createdAt: now,
    updatedAt: now,
  };
}

type Revision = Record<string, unknown> & {
  id: string;
  digest: string;
  revisionNumber: number;
  parentRevisionId: string | null;
};

function appendHarness(input: {
  revisionId: string;
  revisionNumber: number;
  currentRevision?: Revision | null;
}): MockDbHarness {
  const currentRevision = input.currentRevision ?? null;
  const locked = agent(currentRevision?.id ?? null);
  let harness: MockDbHarness;
  harness = createMockDb({
    select: [
      [locked],
      [{
        id: agentId,
        companyId,
        currentAdapterConfigRevisionId: currentRevision?.id ?? null,
      }],
      ...(currentRevision ? [[currentRevision]] : []),
      [{ value: input.revisionNumber }],
    ],
    insert: [() => {
      const values = [...harness.calls].reverse().find(
        (call) => call.operation === "insert" && call.method === "values",
      )?.args[0] as Record<string, unknown>;
      return [{
        id: input.revisionId,
        createdAt: now,
        ...values,
      }];
    }],
    update: [
      [{ id: agentId }],
      () => {
        const values = [...harness.calls].reverse().find(
          (call) => call.operation === "update" && call.method === "set",
        )?.args[0] as Record<string, unknown>;
        return [{ ...locked, ...values }];
      },
    ],
  });
  return harness;
}

function reuseHarness(revision: Revision): MockDbHarness {
  const locked = agent(revision.id);
  let harness: MockDbHarness;
  harness = createMockDb({
    select: [
      [locked],
      [{
        id: agentId,
        companyId,
        currentAdapterConfigRevisionId: revision.id,
      }],
      [revision],
    ],
    update: [() => {
      const values = [...harness.calls].reverse().find(
        (call) => call.operation === "update" && call.method === "set",
      )?.args[0] as Record<string, unknown>;
      return [{ ...locked, ...values }];
    }],
  });
  return harness;
}

async function createRevision(
  harness: MockDbHarness,
  input: {
    model?: "gpt-5.6" | "gpt-5.6-sol";
    runtimeConfig?: Record<string, unknown>;
    companySkillPins?: Array<{ key: string; versionId: string }>;
  } = {},
) {
  return createAgentAdapterConfigurationService(harness.db).createRevision({
    companyId,
    agentId,
    configuration: {
      adapterType: "codex",
      adapterConfig: adapterConfig(input.model ?? "gpt-5.6"),
      runtimeConfig: input.runtimeConfig ?? {},
      companySkillPins: input.companySkillPins ?? [],
    },
    actor: { type: "user", userId: boardUserId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  adapterRegistry.refreshAcpxAdapters.mockResolvedValue(undefined);
  adapterRegistry.findServerAdapterImplementation.mockReturnValue({
    adapter: TEST_ADAPTER,
    identity: TEST_IMPLEMENTATION_IDENTITY,
  });
});

describe("agent adapter configuration revisions", () => {
  it("appends immutable A to B to A lineage instead of reviving history", async () => {
    const first = await createRevision(appendHarness({
      revisionId: "44444444-4444-4444-8444-444444444444",
      revisionNumber: 1,
    }));
    const second = await createRevision(appendHarness({
      revisionId: "55555555-5555-4555-8555-555555555555",
      revisionNumber: 2,
      currentRevision: first.revision as Revision,
    }), { model: "gpt-5.6-sol" });
    const thirdHarness = appendHarness({
      revisionId: "66666666-6666-4666-8666-666666666666",
      revisionNumber: 3,
      currentRevision: second.revision as Revision,
    });
    const third = await createRevision(thirdHarness);

    expect([first.appended, second.appended, third.appended]).toEqual([
      true,
      true,
      true,
    ]);
    expect(third.revision.id).not.toBe(first.revision.id);
    expect(third.revision.digest).toBe(first.revision.digest);
    expect([
      first.revision.revisionNumber,
      second.revision.revisionNumber,
      third.revision.revisionNumber,
    ]).toEqual([1, 2, 3]);
    expect([
      first.revision.parentRevisionId,
      second.revision.parentRevisionId,
      third.revision.parentRevisionId,
    ]).toEqual([null, first.revision.id, second.revision.id]);
    expect(third.current.currentAdapterConfigRevisionId).toBe(third.revision.id);
    expect(thirdHarness.remaining("select")).toBe(0);
    expect(thirdHarness.remaining("insert")).toBe(0);
    expect(thirdHarness.remaining("update")).toBe(0);
  });

  it("reuses only an already-current immutable identity", async () => {
    const first = await createRevision(appendHarness({
      revisionId: "44444444-4444-4444-8444-444444444444",
      revisionNumber: 1,
    }));
    const repeatedHarness = reuseHarness(first.revision as Revision);

    const repeated = await createRevision(repeatedHarness);

    expect(repeated.appended).toBe(false);
    expect(repeated.revision.id).toBe(first.revision.id);
    expect(repeatedHarness.calls.some((call) => call.operation === "insert"))
      .toBe(false);
    expect(repeatedHarness.remaining("select")).toBe(0);
    expect(repeatedHarness.remaining("update")).toBe(0);
  });

  it("makes runtime configuration part of the immutable digest", async () => {
    const first = await createRevision(appendHarness({
      revisionId: "44444444-4444-4444-8444-444444444444",
      revisionNumber: 1,
    }), { runtimeConfig: { runtimeFlags: { outputTokenMax: 10 } } });
    const second = await createRevision(appendHarness({
      revisionId: "55555555-5555-4555-8555-555555555555",
      revisionNumber: 2,
      currentRevision: first.revision as Revision,
    }), { runtimeConfig: { runtimeFlags: { outputTokenMax: 20 } } });

    expect(second.appended).toBe(true);
    expect(second.revision.digest).not.toBe(first.revision.digest);
    expect(second.revision.runtimeConfig).toEqual({
      runtimeFlags: { outputTokenMax: 20 },
    });
  });

  it("rejects a version pinned to the wrong company skill before writing", async () => {
    const reviewId = "77777777-7777-4777-8777-777777777777";
    const researchId = "88888888-8888-4888-8888-888888888888";
    const versionId = "99999999-9999-4999-8999-999999999999";
    const locked = agent();
    const harness = createMockDb({
      select: [
        [locked],
        [{ id: agentId, companyId, currentAdapterConfigRevisionId: null }],
        [{ id: reviewId, key: "code-review" }],
        [{ id: versionId, companySkillId: researchId }],
      ],
    });

    await expect(createRevision(harness, {
      companySkillPins: [{ key: "code-review", versionId }],
    })).rejects.toThrow("does not belong to company skill code-review");

    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
    expect(harness.remaining("select")).toBe(0);
  });

  it("reads explicit immutable pins outside provider configuration", async () => {
    const versionId = "99999999-9999-4999-8999-999999999999";
    const harness = createMockDb({
      select: [[{
        currentAdapterConfigRevisionId: "revision-1",
        revisionId: "revision-1",
        acpConfiguration: {
          contractVersion: "acpx-runtime/v1",
          launchProfile: {
            registryName: "fixture-agent",
          },
          sessionConfigSelections: [{ configId: "model", value: "gpt-5.6" }],
          model: {
            id: "gpt-5.6",
            label: "GPT-5.6",
            value: "gpt-5.6",
            limits: {
              contextTokenLimit: 1_050_000,
              inputTokenLimit: 922_000,
              outputTokenLimit: 128_000,
            },
          },
          workspaceSelector: { kind: "task_execution_workspace" },
          companySkillPins: [{ key: "code-review", versionId }],
        },
      }]],
    });

    await expect(
      createAgentAdapterConfigurationService(harness.db).getCompanySkillPins({
        companyId,
        agentId,
      }),
    ).resolves.toEqual({
      entries: [{ key: "code-review", versionId }],
    });
  });

  it("fails closed when the canonical adapter has no explicit model", async () => {
    const locked = agent();
    const harness = createMockDb({
      select: [
        [locked],
        [{ id: agentId, companyId, currentAdapterConfigRevisionId: null }],
      ],
    });

    await expect(
      createAgentAdapterConfigurationService(harness.db).createRevision({
        companyId,
        agentId,
        configuration: {
          adapterType: "codex",
          adapterConfig: {},
          runtimeConfig: {},
          ...noCompanySkills,
        },
        actor: { type: "user", userId: boardUserId },
      }),
    ).rejects.toThrow(
      'Adapter "codex" requires explicit configuration field "model"',
    );

    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });
});
