import * as t from "./admission.test-support.js";
import { assertDispatchingExecutionSource } from "./admission.js";
import { terminalExecutionRef } from "../task-execution-terminal-eligibility.js";
const { describe, it, expect, v2MessageKindForExecutionSource } = t;
const { resolveDispatchingExecutionBatchMessageKinds } = t;
const { previousOwnershipEpochForDispatchSource } = t;

const userActor = {
  kind: "user/board",
  userId: "55555555-5555-4555-8555-555555555555",
} as const;
const agentActor = {
  kind: "agent-execution",
  agentId: "66666666-6666-4666-8666-666666666666",
  authorityId: "77777777-7777-4777-8777-777777777777",
} as const;
const routineActor = {
  kind: "routine",
  routineId: "88888888-8888-4888-8888-888888888888",
  routineDispatchId: "99999999-9999-4999-8999-999999999999",
} as const;
const systemActor = {
  kind: "system",
  sourceKind: "liveness",
  sourceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;
const taskRequestSystemActor = {
  kind: "system",
  sourceKind: "system_escalation",
  sourceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
} as const;

const sourceCases = {
  task_request: {
    source: { sourceKind: "task_request", actor: taskRequestSystemActor },
    expected: "user",
  },
  task_reassignment: {
    source: { sourceKind: "task_reassignment", actor: agentActor },
    expected: "user",
  },
  mention_agent: {
    source: { sourceKind: "mention_agent", actor: userActor },
    expected: "user",
  },
  routine_dispatch: {
    source: { sourceKind: "routine_dispatch", actor: routineActor },
    expected: "user",
  },
  task_update: {
    source: { sourceKind: "task_update", actor: agentActor },
    expected: "synthetic",
  },
  system_nudge: {
    source: { sourceKind: "system_nudge", actor: systemActor },
    expected: "synthetic",
  },
} satisfies Record<
  t.TaskSessionExecutionSource["sourceKind"],
  {
    source: t.TaskSessionExecutionSource;
    expected: "user" | "synthetic";
  }
>;

const initialBatchScope = {
  companyId: "11111111-1111-4111-8111-111111111111",
  taskId: "22222222-2222-4222-8222-222222222222",
  sessionId: "ses_initial_request",
  ownershipEpoch: 1,
  targetAgentId: "33333333-3333-4333-8333-333333333333",
  taskExecutionAuthorityId: "44444444-4444-4444-8444-444444444444",
  consultExecutionId: null,
  adapterConfigRevisionId: "55555555-5555-4555-8555-555555555555",
  contextEpoch: 0,
  mode: "owner",
  executionScopeId: "66666666-6666-4666-8666-666666666666",
  executionLineageId: "77777777-7777-4777-8777-777777777777",
} as const;
const instruction = {
  ...initialBatchScope,
  sourceKind: "task_request",
  actor: taskRequestSystemActor,
  immutableSourceKey: "initial:instruction",
  sourceRecordId: initialBatchScope.taskId,
  exactText: "Agent instruction",
  comment: null,
  idempotencyKey: "initial:instruction",
} as const;
const work = {
  ...initialBatchScope,
  sourceKind: "task_request",
  actor: userActor,
  immutableSourceKey: "initial:work",
  sourceRecordId: initialBatchScope.taskId,
  exactText: "Do the work",
  comment: {
    author: { kind: "user", userId: userActor.userId },
    producingRun: null,
    body: "Do the work",
  },
  idempotencyKey: "initial:work",
} as const;
const boardMention = {
  ...work,
  sourceKind: "mention_agent",
} as const;
const agentMention = {
  ...work,
  sourceKind: "mention_agent",
  actor: agentActor,
  taskExecutionAuthorityId: null,
  consultExecutionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  mode: "consult",
  comment: null,
} as const;
export {
  agentActor,
  initialBatchScope,
  instruction,
  routineActor,
  sourceCases,
  systemActor,
  taskRequestSystemActor,
  userActor,
  work,
};
describe("Task Session canonical source authorship", () => {
  it("exhaustively derives every execution-source kind", () => {
    for (const { source, expected } of Object.values(sourceCases)) {
      expect(v2MessageKindForExecutionSource(source)).toBe(expected);
    }
  });

  it("accepts only the canonical mention actor and execution-mode pairings", () => {
    expect(assertDispatchingExecutionSource(boardMention)).toBe("user");
    expect(assertDispatchingExecutionSource(agentMention)).toBe("synthetic");

    expect(() =>
      assertDispatchingExecutionSource({
        ...boardMention,
        mode: "consult",
      }),
    ).toThrow("Mention execution mode does not match its immutable actor provenance");
    expect(() =>
      assertDispatchingExecutionSource({
        ...agentMention,
        mode: "owner",
      }),
    ).toThrow("Mention execution mode does not match its immutable actor provenance");
  });

  it("admits only Board conversations and their synthetic bootstrap on terminal tasks", () => {
    const eligible = [
      { sourceKind: "mention_agent", messageKind: "user", mode: "owner" },
      { sourceKind: "task_update", messageKind: "user", mode: "owner" },
      { sourceKind: "task_request", messageKind: "synthetic", mode: "owner" },
    ] as const;
    const ineligible = [
      { sourceKind: "task_request", messageKind: "user", mode: "owner" },
      { sourceKind: "task_update", messageKind: "synthetic", mode: "owner" },
      { sourceKind: "mention_agent", messageKind: "user", mode: "consult" },
    ] as const;
    expect(eligible.every(terminalExecutionRef)).toBe(true);
    expect(ineligible.every((input) => !terminalExecutionRef(input))).toBe(true);
  });

  it("keeps every standalone task request user-authored", () => {
    for (const actor of [agentActor, taskRequestSystemActor]) {
      expect(
        v2MessageKindForExecutionSource({
          sourceKind: "task_request",
          actor,
        }),
      ).toBe("user");
    }
  });

  it("lowers the ordered pair's first member as bootstrap", () => {
    expect(resolveDispatchingExecutionBatchMessageKinds([instruction, work])).toEqual(["synthetic", "user"]);
  });

  it("lowers an instructed system escalation pair from its exact structure", () => {
    const systemWork = {
      ...work,
      actor: taskRequestSystemActor,
      comment: {
        author: { kind: "system", source: "recovery" },
        producingRun: null,
        body: "Do the work",
      },
    } as const;

    expect(resolveDispatchingExecutionBatchMessageKinds([instruction, systemWork])).toEqual([
      "synthetic",
      "user",
    ]);
  });

  it("derives creator-update kind only from immutable actor provenance", () => {
    expect(
      v2MessageKindForExecutionSource({
        sourceKind: "task_update",
        actor: userActor,
      }),
    ).toBe("user");
    for (const actor of [
      agentActor,
      {
        kind: "plugin",
        pluginInstallationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        pluginKey: "example.plugin",
      } as const,
      routineActor,
      systemActor,
    ]) {
      expect(
        v2MessageKindForExecutionSource({
          sourceKind: "task_update",
          actor,
        }),
      ).toBe("synthetic");
    }
  });

  it("rejects producer overrides, unknown sources, and invalid actor pairs", () => {
    expect(() =>
      v2MessageKindForExecutionSource({
        sourceKind: "system_nudge",
        actor: systemActor,
        eventKind: "system",
      } as t.TaskSessionExecutionSource),
    ).toThrow("cannot override Session admission lowering");
    expect(() =>
      v2MessageKindForExecutionSource({
        sourceKind: "future_source",
        actor: systemActor,
      } as unknown as t.TaskSessionExecutionSource),
    ).toThrow("Unclassified execution source");
    expect(() =>
      v2MessageKindForExecutionSource({
        sourceKind: "system_nudge",
        actor: userActor,
      } as unknown as t.TaskSessionExecutionSource),
    ).toThrow("does not match its immutable source kind");
    for (const actor of [routineActor, systemActor]) {
      expect(() =>
        v2MessageKindForExecutionSource({
          sourceKind: "mention_agent",
          actor,
        } as unknown as t.TaskSessionExecutionSource),
      ).toThrow("does not match its immutable source kind");
    }
  });

  it("requires the exact outgoing epoch only for reassignment refs", () => {
    expect(
      previousOwnershipEpochForDispatchSource({
        sourceKind: "task_reassignment",
        ownershipEpoch: 4,
        previousOwnershipEpoch: 3,
      }),
    ).toBe(3);
    expect(
      previousOwnershipEpochForDispatchSource({
        sourceKind: "task_request",
        ownershipEpoch: 1,
      }),
    ).toBeNull();
    expect(() =>
      previousOwnershipEpochForDispatchSource({
        sourceKind: "task_reassignment",
        ownershipEpoch: 4,
      }),
    ).toThrow("exact immediately previous ownership epoch");
    expect(() =>
      previousOwnershipEpochForDispatchSource({
        sourceKind: "task_request",
        ownershipEpoch: 1,
        previousOwnershipEpoch: 1,
      }),
    ).toThrow("Only task reassignment");
  });
});
