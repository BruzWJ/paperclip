// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: AGENT_HOME, CODEX_HOME, codexHome
import { describe, expect, it } from "vitest";
import {
  createChildTaskSchema,
  createTaskSchema,
  createTaskUserCommentSchema,
  boardTaskCommentGroupPageSchema,
  commitTaskCreatorFormSchema,
  commitTaskOwnerFormSchema,
  taskBlockedInboxAttentionSchema,
  decideTaskExecutionStageSchema,
  reassignTaskSchema,
  reopenTaskSchema,
  selfAssignTaskWithdrawalSchema,
  updateTaskExecutionPolicySchema,
  updateTaskTitleSchema,
  upsertTaskDocumentSchema,
} from "./task.js";
import {
  adapterConfigSchema,
  agentRuntimeConfigSchema,
} from "./agent.js";

describe("task validators", () => {
  const ownerAgentId = "22222222-2222-4222-8222-222222222222";

  it("accepts only the narrow board execution-policy configuration body", () => {
    expect(updateTaskExecutionPolicySchema.safeParse({
      executionPolicy: {
        stages: [{
          type: "review",
          participants: [{ type: "user", userId: "board-user" }],
        }],
      },
    }).success).toBe(true);
    expect(updateTaskExecutionPolicySchema.safeParse({
      executionPolicy: null,
    }).success).toBe(true);
    expect(updateTaskExecutionPolicySchema.safeParse({
      executionPolicy: null,
      status: "done",
    }).success).toBe(false);
  });

  it("requires an audited idempotent execution-stage decision body", () => {
    expect(decideTaskExecutionStageSchema.safeParse({
      outcome: "approved",
      body: "Reviewed and approved",
      idempotencyKey: "decision-1",
    }).success).toBe(true);
    expect(decideTaskExecutionStageSchema.safeParse({
      outcome: "changes_requested",
      body: " ",
      idempotencyKey: "decision-2",
    }).success).toBe(false);
    expect(decideTaskExecutionStageSchema.safeParse({
      outcome: "approved",
      body: "Approved",
    }).success).toBe(false);
  });

  it("preserves the immutable task request byte-for-byte", () => {
    const request = "  Line 1\n\nLine 2\\n  ";
    const parsed = createTaskSchema.parse({
      request,
      ownerAgentId,
      idempotencyKey: "board-create-1",
      title: "Follow up PR",
    });

    expect(parsed.request).toBe(request);
  });

  it("keeps the project codebase selector without restoring isolated-workspace controls", () => {
    const canonical = {
      request: "Run in the project's configured directory",
      ownerAgentId,
      idempotencyKey: "board-codebase-1",
      projectId: "11111111-1111-4111-8111-111111111111",
      projectWorkspaceId: "33333333-3333-4333-8333-333333333333",
    };

    expect(createTaskSchema.safeParse(canonical).success).toBe(true);
    expect(createTaskSchema.safeParse({
      ...canonical,
      executionWorkspacePreference: "isolated_workspace",
    }).success).toBe(false);
    expect(createTaskSchema.safeParse({
      ...canonical,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    }).success).toBe(false);
  });

  it("requires request, owner, and idempotency and rejects every retired create field", () => {
    const canonical = {
      request: "Ship the canonical ingress",
      ownerAgentId,
      idempotencyKey: "board-create-2",
    };
    expect(createTaskSchema.safeParse(canonical).success).toBe(true);
    expect(createTaskSchema.safeParse({ ...canonical, request: "   " }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...canonical, ownerAgentId: undefined }).success).toBe(false);
    expect(createTaskSchema.safeParse({ ...canonical, idempotencyKey: undefined }).success).toBe(false);
    for (const retiredField of [
      "description",
      "status",
      "ownerAgentId",
      "ownerUserId",
      "allowDuplicate",
      "workMode",
      "harnessKind",
      "requestDepth",
      "ownerAdapterOverrides",
      "executionPolicy",
      "legacyScheduler",
      "legacySchedulerDiscovery",
      "createdByUserId",
      "responsibleUserId",
    ]) {
      expect(
        createTaskSchema.safeParse({ ...canonical, [retiredField]: "legacy" }).success,
        retiredField,
      ).toBe(false);
    }
  });

  it("rejects retired per-task context-access masks", () => {
    const canonical = {
      request: "Work with narrowed context",
      ownerAgentId,
      idempotencyKey: "board-create-3",
    };
    expect(createTaskSchema.safeParse({
      ...canonical,
      contextAccessMask: { carry_context: false },
    }).success).toBe(false);
    expect(createTaskSchema.safeParse({
      ...canonical,
      attentionMask: { carry_context: false },
    }).success).toBe(false);
  });

  it("keeps parent selection outside the child-create body", () => {
    const child = {
      request: "Implement the child request",
      ownerAgentId,
      idempotencyKey: "board-child-1",
    };
    expect(createChildTaskSchema.safeParse(child).success).toBe(true);
    expect(createChildTaskSchema.safeParse({
      ...child,
      parentId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
  });

  it("preserves canonical task and comment message bytes", () => {
    const message = " \t前置\r\nactual newline\\n literal\\r tail\t \n";

    expect(createTaskSchema.parse({
      request: message,
      ownerAgentId,
      idempotencyKey: "task-byte-exact-1",
    }).request).toBe(message);
    expect(commitTaskCreatorFormSchema.parse({
      taskId: ownerAgentId,
      message,
    }).message).toBe(message);
    expect(commitTaskOwnerFormSchema.parse({
      taskId: ownerAgentId,
      message,
    }).message).toBe(message);
    expect(createTaskUserCommentSchema.parse({
      message,
      idempotencyKey: "comment-byte-exact-1",
    }).message).toBe(message);
  });

  it("accepts only an explicit owner-and-epoch mention tuple", () => {
    const parsed = createTaskUserCommentSchema.parse({
      message: "@Coder please take another look.",
      idempotencyKey: "comment-2",
      mention: {
        targetAgentId: ownerAgentId,
        ownershipEpoch: 3,
      },
    });

    expect(parsed.mention).toEqual({
      targetAgentId: ownerAgentId,
      ownershipEpoch: 3,
    });
  });

  it("accepts only the nullable canonical reply parent identity", () => {
    const replyToCommentId = "11111111-1111-4111-8111-111111111111";
    expect(createTaskUserCommentSchema.parse({
      message: "Steer the run represented by this comment.",
      idempotencyKey: "comment-reply-1",
      replyToCommentId,
    }).replyToCommentId).toBe(replyToCommentId);
    expect(createTaskUserCommentSchema.parse({
      message: "Remove the reply target.",
      idempotencyKey: "comment-reply-2",
      replyToCommentId: null,
    }).replyToCommentId).toBeNull();
    expect(createTaskUserCommentSchema.safeParse({
      message: "Do not accept a captured sequence.",
      idempotencyKey: "comment-reply-3",
      replyToCommentId,
      replyToProjectedEventSeq: 4,
    }).success).toBe(false);
    expect(createTaskUserCommentSchema.safeParse({
      message: "Do not accept a root tuple.",
      idempotencyKey: "comment-reply-4",
      threadRootCommentId: replyToCommentId,
    }).success).toBe(false);
    expect(createTaskUserCommentSchema.safeParse({
      message: "Do not mix independent dispatch contracts.",
      idempotencyKey: "comment-reply-5",
      mention: {
        targetAgentId: ownerAgentId,
        ownershipEpoch: 3,
      },
      replyToCommentId,
    }).success).toBe(false);
  });

  it("keeps the grouped board comment projection closed and selector-free", () => {
    const root = {
      id: "11111111-1111-4111-8111-111111111111",
      author: {
        type: "user" as const,
        label: "Dotta",
        agentId: null,
        userId: "user-1",
        pluginKey: null,
      },
      body: "Root comment",
      presentation: null,
      metadata: null,
      sourceTrust: null,
      runState: null,
      canonicalSequence: 4,
      immediateParentDisplayReference: null,
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    };
    expect(boardTaskCommentGroupPageSchema.safeParse({
      groups: [{
        root,
        replyCount: 1,
        runSegmentCount: 0,
        entries: [{
          kind: "comment",
          ...root,
          id: "22222222-2222-4222-8222-222222222222",
          body: "Nested reply",
          canonicalSequence: 5,
          immediateParentDisplayReference: {
            authorLabel: "Dotta",
            excerpt: "Root comment",
          },
        }],
        entriesNextCursor: null,
      }],
      nextCursor: null,
    }).success).toBe(true);
    expect(boardTaskCommentGroupPageSchema.safeParse({
      groups: [{
        root: { ...root, sessionId: "private-session" },
        replyCount: 0,
        runSegmentCount: 0,
        entries: [],
        entriesNextCursor: null,
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(boardTaskCommentGroupPageSchema.safeParse({
      groups: [{
        root,
        replyCount: 0,
        runSegmentCount: 1,
        entries: [{ kind: "provider_event", payload: {} }],
        entriesNextCursor: null,
      }],
      nextCursor: null,
    }).success).toBe(false);
  });

  it("rejects legacy comment control fields and malformed mention tuples", () => {
    const canonical = {
      message: "A plain non-dispatch comment",
      idempotencyKey: "comment-3",
    };
    for (const legacyField of ["body", "reopen", "resume", "interrupt", "presentation", "metadata"]) {
      expect(
        createTaskUserCommentSchema.safeParse({
          ...canonical,
          [legacyField]: legacyField === "body" ? canonical.message : true,
        }).success,
        legacyField,
      ).toBe(false);
    }
    expect(createTaskUserCommentSchema.safeParse({
      ...canonical,
      mention: { targetAgentId: ownerAgentId },
    }).success).toBe(false);
  });

  it("normalizes escaped line breaks in documents", () => {
    const document = upsertTaskDocumentSchema.parse({
      format: "markdown",
      body: "# Plan\\n\\nShip it",
    });

    expect(document.body).toBe("# Plan\n\nShip it");
  });

  it("keeps the board metadata patch title-only", () => {
    expect(updateTaskTitleSchema.parse({ title: "A clearer title" })).toEqual({
      title: "A clearer title",
    });
    expect(updateTaskTitleSchema.parse({ title: null })).toEqual({ title: null });
    expect(updateTaskTitleSchema.safeParse({
      title: "A clearer title",
      request: "mutated",
    }).success).toBe(false);
    expect(updateTaskTitleSchema.safeParse({ status: "done" }).success).toBe(false);
  });

  it("validates canonical reassignment and audited reopen commands", () => {
    expect(reassignTaskSchema.parse({
      ownerAgentId,
      idempotencyKey: "reassign-1",
    })).toEqual({
      ownerAgentId,
      idempotencyKey: "reassign-1",
    });
    expect(reassignTaskSchema.safeParse({
      ownerAgentId,
      idempotencyKey: "reassign-1",
      assigneeAgentId: ownerAgentId,
    }).success).toBe(false);

    expect(reopenTaskSchema.parse({
      reason: "  Re-open with the stored request.  ",
      idempotencyKey: "reopen-1",
    }).reason).toBe("  Re-open with the stored request.  ");
    expect(reopenTaskSchema.safeParse({
      reason: "   ",
      idempotencyKey: "reopen-2",
    }).success).toBe(false);
  });

  it("keeps human creator, owner, and withdrawal forms exact", () => {
    expect(
      commitTaskCreatorFormSchema.parse({
        taskId: ownerAgentId,
        message: "  Preserve these message bytes.  ",
      }),
    ).toEqual({
      taskId: ownerAgentId,
      message: "  Preserve these message bytes.  ",
    });
    expect(
      commitTaskCreatorFormSchema.safeParse({
        taskId: ownerAgentId,
        message: "follow up",
        idempotencyKey: "not-part-of-this-form",
      }).success,
    ).toBe(false);

    expect(
      commitTaskOwnerFormSchema.parse({
        taskId: ownerAgentId,
        message: "Resolved with a structured result.",
        status: "done",
        structuredResult: { outcome: "accepted" },
      }),
    ).toMatchObject({ status: "done" });
    expect(
      commitTaskOwnerFormSchema.safeParse({
        taskId: ownerAgentId,
        message: "Still working.",
        status: "open",
        structuredResult: { outcome: "premature" },
      }).success,
    ).toBe(false);

    expect(
      selfAssignTaskWithdrawalSchema.parse({
        idempotencyKey: "withdrawal-1",
      }),
    ).toEqual({ idempotencyKey: "withdrawal-1" });
    expect(
      selfAssignTaskWithdrawalSchema.safeParse({
        idempotencyKey: "withdrawal-1",
        ownerUserId: "caller-controlled",
      }).success,
    ).toBe(false);
  });

  it("validates blocked inbox attention payloads and requires redacted secret fields", () => {
    const parsed = taskBlockedInboxAttentionSchema.parse({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_chain_stalled",
      severity: "critical",
      stoppedSinceAt: "2026-05-09T12:00:00.000Z",
      owner: { type: "unknown", agentId: null, userId: null, label: null },
      action: { label: "Assign blocker", detail: "Assign the leaf blocker." },
      sourceTask: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Blocked source",
        boardPresentationStatus: "blocked",
        priority: "high",
        ownerAgentId: null,
        ownerUserId: null,
      },
      leafTask: {
        id: "22222222-2222-4222-8222-222222222222",
        identifier: "PAP-2",
        title: "Unassigned leaf",
        boardPresentationStatus: "todo",
        priority: "medium",
        ownerAgentId: null,
        ownerUserId: null,
      },
      approvalId: null,
      sampleTaskIdentifier: "PAP-2",
      redaction: {
        externalDetailsRedacted: false,
        secretFieldsOmitted: true,
      },
    });

    expect(parsed.redaction.secretFieldsOmitted).toBe(true);
    expect(taskBlockedInboxAttentionSchema.safeParse({
      ...parsed,
      redaction: { externalDetailsRedacted: false, secretFieldsOmitted: false },
    }).success).toBe(false);
  });

  it("validates agent runtime cheap model profile config and rejects retired heartbeat fields", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      modelProfiles: {
        cheap: {
          enabled: true,
          label: "Budget model",
          adapterConfig: {
            model: "fixture-small",
          },
        },
      },
    });

    expect(parsed.modelProfiles?.cheap?.adapterConfig).toEqual({
      model: "fixture-small",
    });
    expect(agentRuntimeConfigSchema.safeParse({
      heartbeat: { cooldownSec: 30 },
    }).success).toBe(false);
  });

  it("keeps raw output-token overrides separate and closed", () => {
    expect(
      agentRuntimeConfigSchema.parse({
        runtimeFlags: { outputTokenMax: 12_345 },
      }).runtimeFlags,
    ).toEqual({ outputTokenMax: 12_345 });
    expect(
      agentRuntimeConfigSchema.safeParse({
        runtimeFlags: { contextWindow: 200_000 },
      }).success,
    ).toBe(false);
    expect(
      agentRuntimeConfigSchema.safeParse({
        runtimeFlags: { outputTokenMax: -1 },
      }).success,
    ).toBe(false);
  });

  it("validates cheap model profile env bindings like top-level adapter config", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        cheap: {
          adapterConfig: {
            env: {
              API_TOKEN: 123,
            },
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts an opaque operator-supplied CODEX_HOME without importing it into Paperclip state", () => {
    const parsed = adapterConfigSchema.parse({
      env: {
        CODEX_HOME: {
          type: "plain",
          value: "/operator/native/codex-home",
        },
      },
    });

    expect(parsed.env).toEqual({
      CODEX_HOME: {
        type: "plain",
        value: "/operator/native/codex-home",
      },
    });
  });

  it("continues to reject generic or Paperclip-managed home bridges", () => {
    expect(adapterConfigSchema.safeParse({
      env: {
        AGENT_HOME: "/paperclip/agent-homes/coder",
      },
    }).success).toBe(false);

    expect(adapterConfigSchema.safeParse({
      codexHome: "/paperclip/codex-homes/coder",
    }).success).toBe(false);
  });

  it("rejects unknown agent runtime model profile keys", () => {
    const parsed = agentRuntimeConfigSchema.safeParse({
      modelProfiles: {
        fast: {
          adapterConfig: {
            model: "gpt-5-mini",
          },
        },
      },
    });

    expect(parsed.success).toBe(false);
  });
});
