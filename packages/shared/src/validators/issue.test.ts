// PAPERCLIP_REMOVAL_NEGATIVE_FIXTURE: AGENT_HOME, CODEX_HOME, codexHome
import { describe, expect, it } from "vitest";
import {
  createChildIssueSchema,
  createIssueSchema,
  createIssueUserCommentSchema,
  boardIssueCommentGroupPageSchema,
  commitIssueCreatorFormSchema,
  commitIssueOwnerFormSchema,
  issueBlockedInboxAttentionSchema,
  decideIssueExecutionStageSchema,
  reassignIssueSchema,
  reopenIssueSchema,
  selfAssignIssueWithdrawalSchema,
  updateIssueExecutionPolicySchema,
  updateIssueTitleSchema,
  upsertIssueDocumentSchema,
  upsertIssueWatchdogSchema,
} from "./issue.js";
import {
  adapterConfigSchema,
  agentRuntimeConfigSchema,
} from "./agent.js";
import type { CompactIssue, Issue } from "../types/issue.js";

type AssertFalse<T extends false> = T;
type _IssueHasNoScheduledRetry = AssertFalse<"scheduledRetry" extends keyof Issue ? true : false>;
type _CompactIssueHasNoScheduledRetry =
  AssertFalse<"scheduledRetry" extends keyof CompactIssue ? true : false>;
// @ts-expect-error The issue-level scheduled-retry DTO is intentionally retired.
type _RetiredIssueScheduledRetryExport = import("../index.js").IssueScheduledRetry;
// @ts-expect-error The manual issue retry-now response is intentionally retired.
type _RetiredIssueRetryNowResponseExport = import("../index.js").IssueRetryNowResponse;

describe("issue validators", () => {
  const ownerAgentId = "22222222-2222-4222-8222-222222222222";

  it("accepts only the narrow board execution-policy configuration body", () => {
    expect(updateIssueExecutionPolicySchema.safeParse({
      executionPolicy: {
        stages: [{
          type: "review",
          participants: [{ type: "user", userId: "board-user" }],
        }],
      },
    }).success).toBe(true);
    expect(updateIssueExecutionPolicySchema.safeParse({
      executionPolicy: null,
    }).success).toBe(true);
    expect(updateIssueExecutionPolicySchema.safeParse({
      executionPolicy: null,
      status: "done",
    }).success).toBe(false);
  });

  it("requires an audited idempotent execution-stage decision body", () => {
    expect(decideIssueExecutionStageSchema.safeParse({
      outcome: "approved",
      body: "Reviewed and approved",
      idempotencyKey: "decision-1",
    }).success).toBe(true);
    expect(decideIssueExecutionStageSchema.safeParse({
      outcome: "changes_requested",
      body: " ",
      idempotencyKey: "decision-2",
    }).success).toBe(false);
    expect(decideIssueExecutionStageSchema.safeParse({
      outcome: "approved",
      body: "Approved",
    }).success).toBe(false);
  });

  it("preserves the immutable issue request byte-for-byte", () => {
    const request = "  Line 1\n\nLine 2\\n  ";
    const parsed = createIssueSchema.parse({
      request,
      ownerAgentId,
      idempotencyKey: "board-create-1",
      title: "Follow up PR",
    });

    expect(parsed.request).toBe(request);
  });

  it("requires request, owner, and idempotency and rejects every retired create field", () => {
    const canonical = {
      request: "Ship the canonical ingress",
      ownerAgentId,
      idempotencyKey: "board-create-2",
    };
    expect(createIssueSchema.safeParse(canonical).success).toBe(true);
    expect(createIssueSchema.safeParse({ ...canonical, request: "   " }).success).toBe(false);
    expect(createIssueSchema.safeParse({ ...canonical, ownerAgentId: undefined }).success).toBe(false);
    expect(createIssueSchema.safeParse({ ...canonical, idempotencyKey: undefined }).success).toBe(false);
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
      "watchdog",
      "watchdogDiscovery",
      "createdByUserId",
      "responsibleUserId",
    ]) {
      expect(
        createIssueSchema.safeParse({ ...canonical, [retiredField]: "legacy" }).success,
        retiredField,
      ).toBe(false);
    }
  });

  it("preserves explicit execution-workspace intent at canonical ingress", () => {
    const executionWorkspaceId =
      "33333333-3333-4333-8333-333333333333";
    const parsed = createIssueSchema.parse({
      request: "Continue in the explicitly pinned workspace",
      ownerAgentId,
      idempotencyKey: "board-create-workspace",
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "reuse_existing",
        environmentId: null,
        workspaceStrategy: {
          type: "project_primary",
          baseRef: "main",
        },
      },
    });

    expect(parsed).toMatchObject({
      executionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      executionWorkspaceSettings: {
        mode: "reuse_existing",
        environmentId: null,
        workspaceStrategy: {
          type: "project_primary",
          baseRef: "main",
        },
      },
    });
  });

  it("enables the system safeguard with an empty strict payload", () => {
    expect(upsertIssueWatchdogSchema.parse({})).toEqual({});
    expect(upsertIssueWatchdogSchema.safeParse({ agentId: ownerAgentId }).success).toBe(false);
    expect(upsertIssueWatchdogSchema.safeParse({ instructions: "legacy prompt" }).success).toBe(false);
  });

  it("accepts raw booleans and canonicalizes context-access masks to sparse false-only cells", () => {
    const canonical = {
      request: "Work with narrowed context",
      ownerAgentId,
      idempotencyKey: "board-create-3",
    };
    expect(createIssueSchema.parse({
      ...canonical,
      contextAccessMask: {
        carry_context: false,
        read_company_issue_agent_run: false,
      },
    }).contextAccessMask).toEqual({
      carry_context: false,
      read_company_issue_agent_run: false,
    });
    expect(createIssueSchema.parse({
      ...canonical,
      contextAccessMask: { carry_context: true },
    }).contextAccessMask).toBeNull();
    expect(createIssueSchema.safeParse({
      ...canonical,
      contextAccessMask: { arbitrary_context: false },
    }).success).toBe(false);
    expect(createIssueSchema.safeParse({
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
    expect(createChildIssueSchema.safeParse(child).success).toBe(true);
    expect(createChildIssueSchema.safeParse({
      ...child,
      parentId: "11111111-1111-4111-8111-111111111111",
    }).success).toBe(false);
  });

  it("preserves canonical issue and comment message bytes", () => {
    const message = " \t前置\r\nactual newline\\n literal\\r tail\t \n";

    expect(createIssueSchema.parse({
      request: message,
      ownerAgentId,
      idempotencyKey: "issue-byte-exact-1",
    }).request).toBe(message);
    expect(commitIssueCreatorFormSchema.parse({
      issueId: ownerAgentId,
      message,
    }).message).toBe(message);
    expect(commitIssueOwnerFormSchema.parse({
      issueId: ownerAgentId,
      message,
    }).message).toBe(message);
    expect(createIssueUserCommentSchema.parse({
      message,
      idempotencyKey: "comment-byte-exact-1",
    }).message).toBe(message);
  });

  it("accepts only an explicit owner-and-epoch mention tuple", () => {
    const parsed = createIssueUserCommentSchema.parse({
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
    expect(createIssueUserCommentSchema.parse({
      message: "Steer the run represented by this comment.",
      idempotencyKey: "comment-reply-1",
      replyToCommentId,
    }).replyToCommentId).toBe(replyToCommentId);
    expect(createIssueUserCommentSchema.parse({
      message: "Remove the reply target.",
      idempotencyKey: "comment-reply-2",
      replyToCommentId: null,
    }).replyToCommentId).toBeNull();
    expect(createIssueUserCommentSchema.safeParse({
      message: "Do not accept a captured sequence.",
      idempotencyKey: "comment-reply-3",
      replyToCommentId,
      replyToProjectedEventSeq: 4,
    }).success).toBe(false);
    expect(createIssueUserCommentSchema.safeParse({
      message: "Do not accept a root tuple.",
      idempotencyKey: "comment-reply-4",
      threadRootCommentId: replyToCommentId,
    }).success).toBe(false);
    expect(createIssueUserCommentSchema.safeParse({
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
    expect(boardIssueCommentGroupPageSchema.safeParse({
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
    expect(boardIssueCommentGroupPageSchema.safeParse({
      groups: [{
        root: { ...root, sessionId: "private-session" },
        replyCount: 0,
        runSegmentCount: 0,
        entries: [],
        entriesNextCursor: null,
      }],
      nextCursor: null,
    }).success).toBe(false);
    expect(boardIssueCommentGroupPageSchema.safeParse({
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
        createIssueUserCommentSchema.safeParse({
          ...canonical,
          [legacyField]: legacyField === "body" ? canonical.message : true,
        }).success,
        legacyField,
      ).toBe(false);
    }
    expect(createIssueUserCommentSchema.safeParse({
      ...canonical,
      mention: { targetAgentId: ownerAgentId },
    }).success).toBe(false);
  });

  it("normalizes escaped line breaks in documents", () => {
    const document = upsertIssueDocumentSchema.parse({
      format: "markdown",
      body: "# Plan\\n\\nShip it",
    });

    expect(document.body).toBe("# Plan\n\nShip it");
  });

  it("keeps the board metadata patch title-only", () => {
    expect(updateIssueTitleSchema.parse({ title: "A clearer title" })).toEqual({
      title: "A clearer title",
    });
    expect(updateIssueTitleSchema.parse({ title: null })).toEqual({ title: null });
    expect(updateIssueTitleSchema.safeParse({
      title: "A clearer title",
      request: "mutated",
    }).success).toBe(false);
    expect(updateIssueTitleSchema.safeParse({ status: "done" }).success).toBe(false);
  });

  it("validates canonical reassignment and audited reopen commands", () => {
    expect(reassignIssueSchema.parse({
      ownerAgentId,
      idempotencyKey: "reassign-1",
    })).toEqual({
      ownerAgentId,
      idempotencyKey: "reassign-1",
    });
    expect(reassignIssueSchema.safeParse({
      ownerAgentId,
      idempotencyKey: "reassign-1",
      assigneeAgentId: ownerAgentId,
    }).success).toBe(false);

    expect(reopenIssueSchema.parse({
      reason: "  Re-open with the stored request.  ",
      idempotencyKey: "reopen-1",
    }).reason).toBe("  Re-open with the stored request.  ");
    expect(reopenIssueSchema.safeParse({
      reason: "   ",
      idempotencyKey: "reopen-2",
    }).success).toBe(false);
  });

  it("keeps human creator, owner, and withdrawal forms exact", () => {
    expect(
      commitIssueCreatorFormSchema.parse({
        issueId: ownerAgentId,
        message: "  Preserve these message bytes.  ",
      }),
    ).toEqual({
      issueId: ownerAgentId,
      message: "  Preserve these message bytes.  ",
    });
    expect(
      commitIssueCreatorFormSchema.safeParse({
        issueId: ownerAgentId,
        message: "follow up",
        idempotencyKey: "not-part-of-this-form",
      }).success,
    ).toBe(false);

    expect(
      commitIssueOwnerFormSchema.parse({
        issueId: ownerAgentId,
        message: "Resolved with a structured result.",
        status: "done",
        structuredResult: { outcome: "accepted" },
      }),
    ).toMatchObject({ status: "done" });
    expect(
      commitIssueOwnerFormSchema.safeParse({
        issueId: ownerAgentId,
        message: "Still working.",
        status: "open",
        structuredResult: { outcome: "premature" },
      }).success,
    ).toBe(false);

    expect(
      selfAssignIssueWithdrawalSchema.parse({
        idempotencyKey: "withdrawal-1",
      }),
    ).toEqual({ idempotencyKey: "withdrawal-1" });
    expect(
      selfAssignIssueWithdrawalSchema.safeParse({
        idempotencyKey: "withdrawal-1",
        ownerUserId: "caller-controlled",
      }).success,
    ).toBe(false);
  });

  it("validates blocked inbox attention payloads and requires redacted secret fields", () => {
    const parsed = issueBlockedInboxAttentionSchema.parse({
      kind: "blocked",
      state: "needs_attention",
      reason: "blocked_chain_stalled",
      severity: "critical",
      stoppedSinceAt: "2026-05-09T12:00:00.000Z",
      owner: { type: "unknown", agentId: null, userId: null, label: null },
      action: { label: "Assign blocker", detail: "Assign the leaf blocker." },
      sourceIssue: {
        id: "11111111-1111-4111-8111-111111111111",
        identifier: "PAP-1",
        title: "Blocked source",
        boardPresentationStatus: "blocked",
        priority: "high",
        ownerAgentId: null,
        ownerUserId: null,
      },
      leafIssue: {
        id: "22222222-2222-4222-8222-222222222222",
        identifier: "PAP-2",
        title: "Unassigned leaf",
        boardPresentationStatus: "todo",
        priority: "medium",
        ownerAgentId: null,
        ownerUserId: null,
      },
      approvalId: null,
      sampleIssueIdentifier: "PAP-2",
      redaction: {
        externalDetailsRedacted: false,
        secretFieldsOmitted: true,
      },
    });

    expect(parsed.redaction.secretFieldsOmitted).toBe(true);
    expect(issueBlockedInboxAttentionSchema.safeParse({
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
        CODEX_HOME: "/operator/native/codex-home",
      },
    });

    expect(parsed.env).toEqual({
      CODEX_HOME: "/operator/native/codex-home",
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
