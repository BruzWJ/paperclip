import * as t from "./secrets-routes.test-support.js";
const { describe, registerSuiteSetup, it, mockSecretService, request, createApp } = t;
const { expect, mockLogActivity, unprocessable, boardActor } = t;

describe("secret routes", () => {
  registerSuiteSetup();

  it("imports remote references and logs aggregate row counts", async () => {
    mockSecretService.importRemoteSecrets.mockResolvedValue({
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      provider: "aws_secrets_manager",
      importedCount: 1,
      skippedCount: 0,
      errorCount: 0,
      results: [
        {
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
          name: "OpenAI API key",
          key: "openai-api-key",
          status: "imported",
          reason: null,
          secretId: "22222222-2222-4222-8222-222222222222",
          conflicts: [],
        },
      ],
    });

    const res = await request(createApp())
      .post("/api/companies/company-1/secrets/remote-import")
      .send({
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "openai-api-key",
            description: "Operator-entered Paperclip description",
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(mockSecretService.importRemoteSecrets).toHaveBeenCalledWith(
      "company-1",
      {
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        secrets: [
          {
            externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:prod/openai",
            name: "OpenAI API key",
            key: "openai-api-key",
            description: "Operator-entered Paperclip description",
          },
        ],
      },
      { type: "user", userId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret.remote_import.completed",
        details: {
          provider: "aws_secrets_manager",
          importedCount: 1,
          skippedCount: 0,
          errorCount: 0,
        },
      }),
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("prod/openai");
  });

  it("surfaces update-route externalRef retarget rejection without logging raw refs", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "22222222-2222-4222-8222-222222222222",
      companyId: "company-1",
      name: "OpenAI API key",
      key: "openai-api-key",
      provider: "aws_secrets_manager",
      managedMode: "external_reference",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/original",
    });
    mockSecretService.update.mockRejectedValue(
      unprocessable("External reference secrets cannot be retargeted through generic update"),
    );

    const res = await request(createApp()).patch("/api/secrets/22222222-2222-4222-8222-222222222222").send({
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/repointed",
    });

    expect(res.status).toBe(422);
    expect(mockSecretService.update).toHaveBeenCalledWith(
      "22222222-2222-4222-8222-222222222222",
      expect.objectContaining({
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/repointed",
      }),
      { type: "user", userId: "user-1" },
    );
    expect(mockLogActivity).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("shared/repointed");
  });

  it("returns 404 for cross-tenant GET /secrets/:id/usage without leaking existence", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      companyId: "company-2",
      name: "Other tenant secret",
      key: "other-secret",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
    });

    const crossTenantApp = createApp(
      boardActor({
        userId: "mallory",
        userName: "Mallory",
        userEmail: "mallory@example.com",
        sessionId: "session-mallory",
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            status: "active",
            membershipRole: "admin",
          },
        ],
        isInstanceAdmin: false,
      }),
    );

    const res = await request(crossTenantApp).get("/api/secrets/44444444-4444-4444-8444-444444444444/usage");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listBindingReferences).not.toHaveBeenCalled();
  });

  it("returns 404 for missing GET /secrets/:id/usage with identical response shape", async () => {
    mockSecretService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get("/api/secrets/55555555-5555-4555-8555-555555555555/usage");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listBindingReferences).not.toHaveBeenCalled();
  });

  it("returns 404 for cross-tenant GET /secrets/:id/access-events without leaking existence", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "66666666-6666-4666-8666-666666666666",
      companyId: "company-2",
      name: "Other tenant secret",
      key: "other-secret",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
    });

    const crossTenantApp = createApp(
      boardActor({
        userId: "mallory",
        userName: "Mallory",
        userEmail: "mallory@example.com",
        sessionId: "session-mallory",
        companyIds: ["company-1"],
        memberships: [
          {
            companyId: "company-1",
            status: "active",
            membershipRole: "admin",
          },
        ],
        isInstanceAdmin: false,
      }),
    );

    const res = await request(crossTenantApp).get(
      "/api/secrets/66666666-6666-4666-8666-666666666666/access-events",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listAccessEvents).not.toHaveBeenCalled();
  });

  it("returns 404 for missing GET /secrets/:id/access-events with identical response shape", async () => {
    mockSecretService.getById.mockResolvedValue(null);

    const res = await request(createApp()).get(
      "/api/secrets/77777777-7777-4777-8777-777777777777/access-events",
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Secret not found" });
    expect(mockSecretService.listAccessEvents).not.toHaveBeenCalled();
  });

  it("returns usage bindings for in-tenant GET /secrets/:id/usage", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "88888888-8888-4888-8888-888888888888",
      companyId: "company-1",
      name: "OpenAI",
      key: "openai",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
    });
    mockSecretService.listBindingReferences.mockResolvedValue([]);

    const res = await request(createApp()).get("/api/secrets/88888888-8888-4888-8888-888888888888/usage");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      secretId: "88888888-8888-4888-8888-888888888888",
      bindings: [],
    });
    expect(mockSecretService.listBindingReferences).toHaveBeenCalledWith(
      "company-1",
      "88888888-8888-4888-8888-888888888888",
    );
  });

  it("allows DELETE to retry cleanup for already soft-deleted secrets", async () => {
    const secret = {
      id: "33333333-3333-4333-8333-333333333333",
      companyId: "company-1",
      name: "OpenAI API Key__deleted__33333333-3333-4333-8333-333333333333",
      key: "openai-api-key__deleted__33333333-3333-4333-8333-333333333333",
      provider: "aws_secrets_manager",
      managedMode: "paperclip_managed",
      status: "deleted",
    };
    mockSecretService.getById.mockResolvedValue(secret);
    mockSecretService.remove.mockResolvedValue(secret);

    const res = await request(createApp()).delete("/api/secrets/33333333-3333-4333-8333-333333333333");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(mockSecretService.remove).toHaveBeenCalledWith("33333333-3333-4333-8333-333333333333", {
      type: "user",
      userId: "user-1",
    });
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "secret.deleted",
        companyId: "company-1",
        entityId: secret.id,
      }),
    );
  });
});
