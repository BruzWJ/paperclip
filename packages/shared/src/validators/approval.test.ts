import { describe, expect, it } from "vitest";
import {
  addApprovalCommentSchema,
  createApprovalSchema,
  hireAgentApprovalPayloadSchema,
  hireAgentApprovalResubmissionSchema,
  requestApprovalRevisionSchema,
  resolveApprovalSchema,
} from "./approval.js";
import {
  AGENT_CONTEXT_GRANT_KEYS,
  AGENT_MENTION_REACH_GRANT_KEYS,
  PAPERCLIP_ACTION_KEYS,
} from "../issue-runtime.js";

describe("approval validators", () => {
  it("passes real line breaks through unchanged", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\n\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\n\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
  });

  it("accepts null and omitted optional decision notes", () => {
    expect(resolveApprovalSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(resolveApprovalSchema.parse({}).decisionNote).toBeUndefined();
    expect(requestApprovalRevisionSchema.parse({ decisionNote: null }).decisionNote).toBeNull();
    expect(requestApprovalRevisionSchema.parse({}).decisionNote).toBeUndefined();
  });

  it("normalizes escaped line breaks in approval comments and decision notes", () => {
    expect(addApprovalCommentSchema.parse({ body: "Looks good\\n\\nApproved." }).body)
      .toBe("Looks good\n\nApproved.");
    expect(resolveApprovalSchema.parse({ decisionNote: "Decision\\n\\nApproved." }).decisionNote)
      .toBe("Decision\n\nApproved.");
    expect(requestApprovalRevisionSchema.parse({ decisionNote: "Decision\\r\\nRevise." }).decisionNote)
      .toBe("Decision\nRevise.");
  });

  it("reserves hire approval creation for the canonical runtime transaction", () => {
    expect(
      createApprovalSchema.safeParse({
        type: "hire_agent",
        payload: { name: "Delayed create" },
      }).success,
    ).toBe(false);
    expect(
      createApprovalSchema.safeParse({
        type: "request_board_approval",
        payload: { request: "Review" },
      }).success,
    ).toBe(true);
  });

  it("accepts only the immutable pending-agent/audit/source hire link", () => {
    const payload = {
      contract: "paperclip.hire-approval/v1" as const,
      agentId: "11111111-1111-4111-8111-111111111111",
      runtimeAgentConfigurationAuditId:
        "22222222-2222-4222-8222-222222222222",
      runtimeAgentConfigurationRequestDigest: "a".repeat(64),
      source: {
        kind: "agent_run" as const,
        issueId: "33333333-3333-4333-8333-333333333333",
        runId: "44444444-4444-4444-8444-444444444444",
        issueExecutionRefId:
          "55555555-5555-4555-8555-555555555555",
      },
    };
    expect(hireAgentApprovalPayloadSchema.parse(payload)).toEqual(
      payload,
    );
    expect(
      hireAgentApprovalPayloadSchema.safeParse({
        ...payload,
        adapterConfig: { model: "must-not-be-replayed" },
      }).success,
    ).toBe(false);
  });

  it("requires a complete exact runtime-agent configuration on hire resubmission", () => {
    const input = {
      agentId: "11111111-1111-4111-8111-111111111111",
      runtimeAgentConfigurationAuditId:
        "22222222-2222-4222-8222-222222222222",
      runtimeAgentConfigurationRequestDigest: "b".repeat(64),
      configuration: {
        name: "Revised agent",
        title: null,
        capabilities: null,
        reportsTo: null,
        contextGrants: Object.fromEntries(
          AGENT_CONTEXT_GRANT_KEYS.map((key) => [key, false]),
        ),
        actionGrants: Object.fromEntries(
          PAPERCLIP_ACTION_KEYS.map((key) => [key, false]),
        ),
        mentionReachGrants: Object.fromEntries(
          AGENT_MENTION_REACH_GRANT_KEYS.map((key) => [key, false]),
        ),
      },
    };
    expect(
      hireAgentApprovalResubmissionSchema.parse(input),
    ).toEqual(input);
    expect(
      hireAgentApprovalResubmissionSchema.safeParse({
        ...input,
        configuration: {
          ...input.configuration,
          adapterType: "codex",
        },
      }).success,
    ).toBe(false);
  });
});
