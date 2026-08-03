import { describe, expect, it } from "vitest";
import { TOOL_MCP_GATEWAY_TOKEN_SUBJECT_TYPES } from "../constants.js";
import {
  createToolConnectionSchema,
  createToolMcpGatewayTokenSchema,
  startConnectionAuthorizationSchema,
  toolCredentialSecretRefSchema,
  toolRedactedValueSummarySchema,
  toolTransportConfigSchema,
} from "./tool-access.js";

describe("tool access validators", () => {
  it("does not admit heartbeat runs as named gateway token subjects", () => {
    expect(TOOL_MCP_GATEWAY_TOKEN_SUBJECT_TYPES).not.toContain("heartbeat_run");
    expect(
      createToolMcpGatewayTokenSchema.safeParse({
        name: "Legacy run bearer",
        subjectType: "heartbeat_run",
        subjectId: "11111111-1111-4111-8111-111111111111",
        clientLabel: "Legacy runtime",
        ownerNote: "Must fail closed",
        expiresAt: "2027-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("accepts user authorization input", () => {
    expect(startConnectionAuthorizationSchema.parse({ subjectUserId: "user-123", scopes: ["read"] })).toEqual({
      subjectUserId: "user-123",
      scopes: ["read"],
    });
  });

  it("accepts multi-key credential annotations", () => {
    const parsed = toolCredentialSecretRefSchema.parse({
      secretId: "11111111-1111-4111-8111-111111111111",
      configPath: "credentials.apiKey",
      keyScope: "production",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(parsed.keyScope).toBe("production");
  });
  it("rejects raw credential-looking fields in transport config", () => {
    const parsed = toolTransportConfigSchema.safeParse({
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer raw-token",
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("credentialSecretRefs");
    }
  });

  it("accepts secret references for connection credentials", () => {
    const parsed = createToolConnectionSchema.safeParse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      name: "GitHub fixture",
      connectionKind: "managed",
      transportConfig: { url: "https://example.test/mcp" },
      credentialSecretRefs: [
        {
          secretId: "22222222-2222-4222-8222-222222222222",
          configPath: "headers.Authorization",
          versionSelector: "latest",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("keeps invocation payload summaries redacted and bounded", () => {
    const parsed = toolRedactedValueSummarySchema.parse({
      summary: "Redacted arguments: 2 fields omitted.",
      sha256: "a".repeat(64),
      redactedFields: ["headers.Authorization", "body.token"],
    });

    expect(parsed.redactedFields).toEqual(["headers.Authorization", "body.token"]);
  });
});
