import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAgentAdapterConfigurationService,
} from "../services/agent-adapter-config-revisions.js";
import { createMockDb, type MockDbHarness } from "./helpers/mock-db.js";

const adapterRegistry = vi.hoisted(() => ({
  refreshAcpxAdapters: vi.fn(),
  findServerAdapter: vi.fn(),
}));

vi.mock("../adapters/registry.js", () => adapterRegistry);

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const boardUserId = "board-user";
const now = new Date("2026-08-01T12:00:00.000Z");

const TEST_ADAPTER = Object.freeze({
  type: "codex",
  definition: Object.freeze({
    version: "acpx-runtime/v1" as const,
    launchProfile: Object.freeze({ registryName: "codex" }),
    runtime: Object.freeze({
      controls: Object.freeze(["session/status", "session/set_config_option"]),
    }),
    ui: Object.freeze({
      label: "Codex fixture",
    }),
    configOptions: Object.freeze([
      Object.freeze({
        id: "model",
        label: "Model",
        type: "select" as const,
        values: Object.freeze([
          Object.freeze({ label: "GPT-5.6", value: "gpt-5.6" }),
          Object.freeze({ label: "GPT-5.6 Sol", value: "gpt-5.6-sol" }),
        ]),
      }),
    ]),
    modelConfigOptionId: "model",
    models: Object.freeze([
      Object.freeze({
        value: "gpt-5.6",
        label: "GPT-5.6",
      }),
      Object.freeze({
        value: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
      }),
    ]),
  }),
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
      [agent(input.revisionId)],
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
    update: [[{ id: agentId }]],
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
      [locked],
    ],
  });
  return harness;
}

async function createRevision(
  harness: MockDbHarness,
  input: {
    model?: "gpt-5.6" | "gpt-5.6-sol";
  } = {},
) {
  return createAgentAdapterConfigurationService(harness.db).createRevision({
    companyId,
    agentId,
    configuration: {
      adapterType: "codex",
      adapterConfig: adapterConfig(input.model ?? "gpt-5.6"),
    },
    actor: { type: "user", userId: boardUserId },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  adapterRegistry.refreshAcpxAdapters.mockResolvedValue(undefined);
  adapterRegistry.findServerAdapter.mockReturnValue(TEST_ADAPTER);
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
        },
        actor: { type: "user", userId: boardUserId },
      }),
    ).rejects.toThrow(
      "Adapter codex requires exact ACP config value model",
    );

    expect(harness.calls.some((call) => call.operation === "insert")).toBe(false);
    expect(harness.calls.some((call) => call.operation === "update")).toBe(false);
  });
});
