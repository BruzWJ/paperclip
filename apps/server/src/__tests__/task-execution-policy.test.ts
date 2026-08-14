import "./task-execution-policy.test-suite-03-happy-path-executor-review-approval.js";
import "./task-execution-policy.test-suite-04-review-only-policy-no-approval.js";
import "./task-execution-policy.test-suite-05-no-op-transitions.js";
import "./task-execution-policy.test-suite-06-final-stage-completion-terminates-the.js";
import * as t from "./task-execution-policy.test-support.js";
const { describe, it, expect, normalizeTaskExecutionPolicy, qaAgentId } = t;
const { parseTaskExecutionState, coderAgentId, applyTaskExecutionPolicyTransition } = t;
const { boardUserId } = t;

describe("normalizeTaskExecutionPolicy", () => {
  it("returns null for null/undefined input", () => {
    expect(normalizeTaskExecutionPolicy(null)).toBeNull();
    expect(normalizeTaskExecutionPolicy(undefined)).toBeNull();
  });

  it("returns null when stages are empty", () => {
    expect(normalizeTaskExecutionPolicy({ stages: [] })).toBeNull();
  });

  it("throws when all participants are invalid (missing agentId)", () => {
    expect(() =>
      normalizeTaskExecutionPolicy({
        stages: [{ type: "review", participants: [{ type: "agent" }] }],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("deduplicates participants within a stage", () => {
    const result = normalizeTaskExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: qaAgentId },
            { type: "agent", agentId: qaAgentId },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("assigns UUIDs to stages and participants", () => {
    const result = normalizeTaskExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        },
      ],
    });
    expect(result!.stages[0].id).toBeDefined();
    expect(result!.stages[0].participants[0].id).toBeDefined();
  });

  it("always sets commentRequired to true", () => {
    const result = normalizeTaskExecutionPolicy({
      commentRequired: false,
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        },
      ],
    });
    expect(result!.commentRequired).toBe(true);
  });

  it("defaults mode to normal", () => {
    const result = normalizeTaskExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [{ type: "agent", agentId: qaAgentId }],
        },
      ],
    });
    expect(result!.mode).toBe("normal");
  });

  it("rejects approvalsNeeded values above 1", () => {
    expect(() =>
      normalizeTaskExecutionPolicy({
        stages: [
          {
            type: "review",
            approvalsNeeded: 2,
            participants: [{ type: "agent", agentId: qaAgentId }],
          },
        ],
      }),
    ).toThrow("Invalid execution policy");
  });

  it("throws for invalid input", () => {
    expect(() =>
      normalizeTaskExecutionPolicy({
        stages: [{ type: "invalid_type" }],
      }),
    ).toThrow();
  });

  it("keeps monitor-only policies", () => {
    const result = normalizeTaskExecutionPolicy({
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        externalRef: "https://example.test/deploy?token=secret",
      },
      stages: [],
    });
    expect(result).toMatchObject({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "owner",
        externalRef: "[redacted]",
      },
    });
  });

  it("rejects padded monitor identities rather than aliasing them", () => {
    for (const monitor of [{ serviceName: " deployments" }, { externalRef: "deploy-42 " }]) {
      expect(() =>
        normalizeTaskExecutionPolicy({
          monitor: {
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            ...monitor,
          },
          stages: [],
        }),
      ).toThrow("Invalid execution policy");
    }
  });
});

describe("parseTaskExecutionState", () => {
  it("returns null for null/undefined", () => {
    expect(parseTaskExecutionState(null)).toBeNull();
    expect(parseTaskExecutionState(undefined)).toBeNull();
  });

  it("returns null for invalid shape", () => {
    expect(parseTaskExecutionState({ status: "bogus" })).toBeNull();
  });

  it("parses a valid state", () => {
    const state = parseTaskExecutionState({
      status: "pending",
      currentStageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      currentStageIndex: 0,
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: qaAgentId },
      returnOwner: { type: "agent", agentId: coderAgentId },
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
    });
    expect(state).not.toBeNull();
    expect(state!.status).toBe("pending");
  });
});

describe("task execution monitor policy transitions", () => {
  it("schedules a one-shot monitor on an active agent-owned task", () => {
    const policy = normalizeTaskExecutionPolicy({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "board",
      },
    })!;

    const result = t.transition(policy, {
      task: t.policyTask(null, {
        monitorAttemptCount: 0,
        monitorNextCheckAt: null,
        monitorLastTriggeredAt: null,
        monitorNotes: null,
        monitorScheduledBy: null,
      }),
      previousPolicy: null,
      actor: { userId: boardUserId },
      monitorExplicitlyUpdated: true,
    });

    expect(result.patch.monitorNextCheckAt).toEqual(new Date("2026-04-11T12:30:00.000Z"));
    expect(result.patch.monitorScheduledBy).toBe("board");
    expect(result.patch.executionState).toMatchObject({
      status: "idle",
      monitor: {
        status: "scheduled",
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "board",
      },
    });
  });

  it("auto-clears a scheduled monitor when the task moves to done", () => {
    const policy = normalizeTaskExecutionPolicy({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
        scheduledBy: "owner",
      },
    })!;

    const result = t.transition(policy, {
      task: t.policyTask(policy, {
        executionState: {
          status: "idle",
          currentStageId: null,
          currentStageIndex: null,
          currentStageType: null,
          currentParticipant: null,
          returnOwner: null,
          completedStageIds: [],
          lastDecisionId: null,
          lastDecisionOutcome: null,
          monitor: {
            status: "scheduled",
            nextCheckAt: "2026-04-11T12:30:00.000Z",
            lastTriggeredAt: null,
            attemptCount: 0,
            notes: "Check deployment",
            scheduledBy: "owner",
            clearedAt: null,
            clearReason: null,
          },
        },
        monitorAttemptCount: 0,
        monitorNextCheckAt: new Date("2026-04-11T12:30:00.000Z"),
        monitorLastTriggeredAt: null,
        monitorNotes: "Check deployment",
        monitorScheduledBy: "owner",
      }),
      previousPolicy: policy,
      requestedStatus: "done",
      actor: { agentId: coderAgentId },
    });

    expect(result.patch.executionPolicy).toBeNull();
    expect(result.patch.monitorNextCheckAt).toBeNull();
    expect(result.patch.executionState).toMatchObject({
      monitor: { status: "cleared", clearReason: "done" },
    });
  });

  it("rejects explicitly scheduling a monitor on an invalid task state", () => {
    const policy = normalizeTaskExecutionPolicy({
      stages: [],
      monitor: {
        nextCheckAt: "2026-04-11T12:30:00.000Z",
        notes: "Check deployment",
      },
    })!;

    expect(() =>
      t.transition(policy, {
        task: t.policyTask(null, { boardPresentationStatus: "blocked" }),
        previousPolicy: null,
        actor: { agentId: coderAgentId },
        monitorExplicitlyUpdated: true,
      }),
    ).toThrow("Monitor can only be scheduled");
  });

  it("validates monitor eligibility from the checked owner kind and identifiers", () => {
    const policy = normalizeTaskExecutionPolicy({
      stages: [],
      monitor: {
        nextCheckAt: "2099-04-11T12:30:00.000Z",
        notes: "Check deployment",
      },
    })!;

    expect(() =>
      t.transition(policy, {
        task: t.policyTask(null, {
          ownerKind: "user",
          ownerUserId: boardUserId,
        }),
        previousPolicy: null,
        actor: { userId: boardUserId },
        monitorExplicitlyUpdated: true,
      }),
    ).toThrow("Monitor can only be scheduled");
  });

  it("rejects explicitly re-arming a monitor after max attempts are exhausted", () => {
    const policy = normalizeTaskExecutionPolicy({
      stages: [],
      monitor: {
        nextCheckAt: "2099-04-11T12:30:00.000Z",
        maxAttempts: 1,
        scheduledBy: "owner",
      },
    })!;

    expect(() =>
      t.transition(policy, {
        task: t.policyTask(null, {
          boardPresentationStatus: "in_review",
          monitorAttemptCount: 1,
          monitorNextCheckAt: null,
          monitorLastTriggeredAt: null,
          monitorNotes: null,
          monitorScheduledBy: "owner",
        }),
        previousPolicy: null,
        actor: { agentId: coderAgentId },
        monitorExplicitlyUpdated: true,
      }),
    ).toThrow("Monitor bounds are already exhausted");
  });
});
