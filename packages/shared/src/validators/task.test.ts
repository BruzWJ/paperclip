// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: AGENT_HOME, CODEX_HOME, codexHome
import { describe, expect, it } from "vitest";
import {
  createChildTaskSchema,
  createTaskSchema,
  createTaskUserCommentSchema,
  boardTaskCommentGroupPageSchema,
  boardTaskRunSegmentEntrySchema,
  commitTaskCreatorFormSchema,
  commitTaskOwnerFormSchema,
  taskBlockedInboxAttentionSchema,
  taskCommentMetadataRowSchema,
  decideTaskExecutionStageSchema,
  reassignTaskSchema,
  reopenTaskSchema,
  selfAssignTaskWithdrawalSchema,
  updateTaskExecutionPolicySchema,
  taskExecutionPolicySchema,
  taskExecutionMonitorPolicySchema,
  taskExecutionMonitorStateSchema,
  updateTaskTitleSchema,
  upsertTaskDocumentSchema,
} from "./task.js";
import { adapterConfigSchema } from "./agent.js";

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

  it("accepts one exact low-trust execution-policy shape and rejects preset aliases", () => {
    const reviewPreset = {
      id: "low_trust_review" as const,
      version: 1 as const,
      rawOutputDisposition: "quarantine" as const,
    };
    const trustBoundary = {
      mode: "low_trust_review" as const,
      rootTaskId: "33333333-3333-4333-8333-333333333333",
    };
    const canonicalPolicy = {
      reviewPreset,
      authorizationPolicy: {
        managedBy: "permissions-extension",
        trustBoundary,
      },
    };

    expect(taskExecutionPolicySchema.safeParse(canonicalPolicy).success).toBe(true);
    expect(taskExecutionPolicySchema.safeParse({
      authorizationPolicy: { trustBoundary },
    }).success).toBe(false);
    expect(taskExecutionPolicySchema.safeParse({ reviewPreset }).success).toBe(false);

    for (const aliasPolicy of [
      { ...canonicalPolicy, trustPreset: "low_trust_review" },
      {
        ...canonicalPolicy,
        authorizationPolicy: {
          ...canonicalPolicy.authorizationPolicy,
          trustPreset: "low_trust_review",
        },
      },
      {
        ...canonicalPolicy,
        authorizationPolicy: {
          ...canonicalPolicy.authorizationPolicy,
          reviewPreset,
        },
      },
    ]) {
      expect(taskExecutionPolicySchema.safeParse(aliasPolicy).success).toBe(false);
    }
  });

  it("rejects padded task-monitor service and external identities without normalizing them", () => {
    const policy = {
      nextCheckAt: "2026-08-11T12:00:00.000Z",
      serviceName: "deployments",
      externalRef: "deploy-42",
    };
    expect(taskExecutionMonitorPolicySchema.parse(policy)).toMatchObject({
      serviceName: "deployments",
      externalRef: "deploy-42",
    });
    for (const field of ["serviceName", "externalRef"] as const) {
      expect(taskExecutionMonitorPolicySchema.safeParse({
        ...policy,
        [field]: ` ${policy[field]} `,
      }).success).toBe(false);
    }

    const state = {
      status: "scheduled",
      nextCheckAt: policy.nextCheckAt,
      lastTriggeredAt: null,
      attemptCount: 0,
      notes: null,
      scheduledBy: "owner",
      kind: null,
      serviceName: policy.serviceName,
      externalRef: policy.externalRef,
      timeoutAt: null,
      maxAttempts: null,
      recoveryPolicy: null,
      clearedAt: null,
      clearReason: null,
    };
    expect(taskExecutionMonitorStateSchema.safeParse(state).success).toBe(true);
    expect(taskExecutionMonitorStateSchema.safeParse({
      ...state,
      serviceName: ` ${state.serviceName}`,
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

  it("keeps task-link metadata routing on the nullable task number only", () => {
    const taskId = "abcdef12-3456-4789-8abc-def012345678";
    expect(taskCommentMetadataRowSchema.safeParse({
      type: "task_link",
      taskId,
      taskNumber: 42,
      identifier: "PAP-42",
      title: "Canonical task link",
    }).success).toBe(true);
    expect(taskCommentMetadataRowSchema.safeParse({
      type: "task_link",
      taskId,
      taskNumber: null,
      identifier: "PAP-42",
    }).success).toBe(true);

    for (const row of [
      { type: "task_link", taskId, identifier: "PAP-42" },
      { type: "task_link", taskId, taskNumber: 42 },
      { type: "task_link", taskId: taskId.toUpperCase(), taskNumber: 42 },
      { type: "task_link", taskId, taskNumber: 42, identifier: " pap-42 " },
      { type: "task_link", taskId, taskNumber: 2_147_483_648 },
      { type: "task_link", taskNumber: null },
    ]) {
      expect(taskCommentMetadataRowSchema.safeParse(row).success).toBe(false);
    }
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

  it("keeps comment reply presentation out of grouped run segments", () => {
    const segment = {
      kind: "run_segment" as const,
      id: `segment_${"a".repeat(32)}`,
      author: {
        type: "agent" as const,
        label: "Agent",
        agentId: ownerAgentId,
        userId: null,
        pluginKey: null,
      },
      parts: [{ type: "text" as const, text: "Working" }],
      status: "complete" as const,
      canonicalSequence: 5,
      createdAt: "2026-07-31T12:00:00.000Z",
      updatedAt: "2026-07-31T12:00:00.000Z",
    };
    expect(boardTaskRunSegmentEntrySchema.safeParse(segment).success).toBe(true);
    expect(boardTaskRunSegmentEntrySchema.safeParse({
      ...segment,
      immediateParentDisplayReference: { authorLabel: "Agent", excerpt: "Run" },
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
        taskNumber: 1,
        identifier: "PAP-1",
        title: "Blocked source",
        boardPresentationStatus: "blocked",
        priority: "high",
        ownerAgentId: null,
        ownerUserId: null,
      },
      leafTask: {
        id: "22222222-2222-4222-8222-222222222222",
        taskNumber: 2,
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

  it("keeps adapter editor values to native ACPX primitives", () => {
    expect(adapterConfigSchema.parse({ model: "gpt-5.6", enabled: false })).toEqual({
      model: "gpt-5.6",
      enabled: false,
    });
    expect(adapterConfigSchema.safeParse({ env: { HOME: "/tmp" } }).success).toBe(false);
  });

});
