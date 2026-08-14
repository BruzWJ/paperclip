import "./secrets-routes.test-suite-02-previews-provider-vault-discovery-and.js";
import "./secrets-routes.test-suite-03-imports-remote-references-and-logs.js";
import * as t from "./secrets-routes.test-support.js";
const { describe, registerSuiteSetup, it, mockSecretService, request, createApp } = t;
const { expect, HttpError, mockLogActivity, boardActor } = t;

describe("secret routes", () => {
  registerSuiteSetup();

  it("returns provider health checks for board callers with company access", async () => {
    mockSecretService.checkProviders.mockResolvedValue([
      {
        provider: "local_encrypted",
        status: "ok",
        message: "Local encrypted provider configured",
        backupGuidance: ["Back up the key file separately from the database."],
      },
    ]);

    const res = await request(createApp()).get("/api/companies/company-1/secret-providers/health");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      providers: [
        {
          provider: "local_encrypted",
          status: "ok",
          message: "Local encrypted provider configured",
          backupGuidance: ["Back up the key file separately from the database."],
        },
      ],
    });
  });

  it("rejects managed secret creation when externalRef is supplied", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/secrets").send({
      name: "OpenAI API Key",
      managedMode: "paperclip_managed",
      value: "secret-value",
      externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:shared/other",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/Managed secrets cannot set externalRef/);
    expect(mockSecretService.create).not.toHaveBeenCalled();
  });

  it("returns sanitized AWS provider errors when managed secret creation fails", async () => {
    mockSecretService.create.mockRejectedValue(
      new HttpError(
        403,
        "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
        {
          code: "access_denied",
          provider: "aws_secrets_manager",
          operation: "secret.create",
          providerConfigId: "11111111-1111-4111-8111-111111111111",
          region: "us-east-1",
          credentialPath: "Paperclip server runtime/provider credential path",
          requiredCapability: "secretsmanager:CreateSecret",
          actionableMessage:
            "AWS managed secret creation needs secretsmanager:CreateSecret in the selected region for this provider vault.",
          safeAlternative:
            "If the secret already exists in AWS, link it as an external reference instead of creating a Paperclip-managed value.",
        },
      ),
    );

    const res = await request(createApp()).post("/api/companies/company-1/secrets").send({
      name: "Vercel token",
      key: "vercel_token",
      provider: "aws_secrets_manager",
      providerConfigId: "11111111-1111-4111-8111-111111111111",
      managedMode: "paperclip_managed",
      value: "vcp_test",
    });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: "access_denied",
      error: "AWS Secrets Manager denied the request. Check IAM permissions for this provider vault.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret.create",
        providerConfigId: "11111111-1111-4111-8111-111111111111",
        region: "us-east-1",
        requiredCapability: "secretsmanager:CreateSecret",
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("arn:aws");
    expect(JSON.stringify(res.body)).not.toContain("123456789012");
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("restricts user secret definition management to company admins", async () => {
    const res = await request(
      createApp(
        boardActor({
          memberships: [
            {
              companyId: "company-1",
              status: "active",
              membershipRole: "operator",
            },
          ],
        }),
      ),
    )
      .post("/api/companies/company-1/user-secret-definitions")
      .send({
        key: "github_token",
        name: "GitHub token",
        provider: "local_encrypted",
      });

    expect(res.status).toBe(403);
    expect(mockSecretService.createUserSecretDefinition).not.toHaveBeenCalled();
  });

  it("records authenticated instance admins as canonical user actors", async () => {
    mockSecretService.createUserSecretDefinition.mockResolvedValue({
      id: "definition-1",
      companyId: "company-1",
      key: "github_token",
      name: "GitHub token",
      provider: "local_encrypted",
      status: "active",
    });

    const res = await request(
      createApp(
        boardActor({
          isInstanceAdmin: true,
          memberships: [],
        }),
      ),
    )
      .post("/api/companies/company-1/user-secret-definitions")
      .send({
        key: "github_token",
        name: "GitHub token",
        provider: "local_encrypted",
      });

    expect(res.status).toBe(201);
    expect(mockSecretService.createUserSecretDefinition).toHaveBeenCalledWith(
      "company-1",
      expect.objectContaining({ key: "github_token" }),
      { type: "user", userId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: "user",
        actorId: "user-1",
        action: "user_secret_definition.created",
      }),
    );
  });

  it("logs patched user-secret definition deletion as deletion activity", async () => {
    mockSecretService.updateUserSecretDefinition.mockResolvedValue({
      id: "definition-1",
      companyId: "company-1",
      key: "github_token__deleted__definition-1",
      name: "GitHub token",
      provider: "local_encrypted",
      status: "deleted",
    });

    const res = await request(createApp())
      .patch("/api/companies/company-1/user-secret-definitions/definition-1")
      .send({ status: "deleted" });

    expect(res.status).toBe(200);
    expect(mockSecretService.updateUserSecretDefinition).toHaveBeenCalledWith(
      "company-1",
      "definition-1",
      expect.objectContaining({ status: "deleted" }),
      { type: "user", userId: "user-1" },
    );
    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "user_secret_definition.deleted",
        entityType: "user_secret_definition",
        entityId: "definition-1",
      }),
    );
  });

  it("creates current-user secret values for the authenticated user only", async () => {
    mockSecretService.createCurrentUserSecretValue.mockResolvedValue({
      id: "secret-1",
      companyId: "company-1",
      scope: "user",
      ownerUserId: "user-1",
      userSecretDefinitionId: "definition-1",
      provider: "local_encrypted",
      latestVersion: 1,
    });

    const res = await request(createApp()).post("/api/companies/company-1/users/user-1/secrets").send({
      definitionId: "00000000-0000-4000-8000-000000000001",
      value: "secret-value",
    });

    expect(res.status).toBe(201);
    expect(mockSecretService.createCurrentUserSecretValue).toHaveBeenCalledWith(
      "company-1",
      "user-1",
      {
        definitionId: "00000000-0000-4000-8000-000000000001",
        value: "secret-value",
        externalRef: undefined,
        providerVersionRef: undefined,
        providerConfigId: undefined,
      },
      { type: "user", userId: "user-1" },
    );
    expect(JSON.stringify(mockLogActivity.mock.calls)).not.toContain("secret-value");
  });

  it("rejects the retired definition-key selector for current-user secret creation", async () => {
    const res = await request(createApp()).post("/api/companies/company-1/users/user-1/secrets").send({
      definitionId: "00000000-0000-4000-8000-000000000001",
      definitionKey: "github_token",
      value: "secret-value",
    });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/definitionKey|Unrecognized key/);
    expect(mockSecretService.createCurrentUserSecretValue).not.toHaveBeenCalled();
  });

  it("rejects current-user secret values without a concrete user identity", async () => {
    const res = await request(
      createApp({
        ...boardActor(),
        userId: undefined,
      }),
    )
      .post("/api/companies/company-1/users/user-1/secrets")
      .send({
        definitionId: "00000000-0000-4000-8000-000000000001",
        value: "secret-value",
      });

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: "Board access required" });
    expect(mockSecretService.createCurrentUserSecretValue).not.toHaveBeenCalled();
    expect(mockLogActivity).not.toHaveBeenCalled();
  });

  it("rejects empty current-user secret rotation payloads", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/users/user-1/secrets/secret-1/rotate")
      .send({});

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/requires value, externalRef/);
    expect(mockSecretService.rotateCurrentUserSecretValue).not.toHaveBeenCalled();
  });

  it("hides user-scoped secrets from company-scoped secret mutation routes", async () => {
    mockSecretService.getById.mockResolvedValue({
      id: "secret-1",
      companyId: "company-1",
      scope: "user",
      ownerUserId: "user-2",
      status: "active",
    });

    const res = await request(createApp()).post("/api/secrets/secret-1/rotate").send({
      value: "new-secret-value",
    });

    expect(res.status).toBe(404);
    expect(mockSecretService.rotate).not.toHaveBeenCalled();
  });

  it("rejects a user-secret route ID that differs from the authenticated user", async () => {
    const res = await request(createApp()).get("/api/companies/company-1/users/user-2/secrets");

    expect(res.status).toBe(403);
    expect(mockSecretService.listCurrentUserSecretValues).not.toHaveBeenCalled();
  });

  it("rejects provider vault cross-company access before calling the service", async () => {
    const res = await request(
      createApp(
        boardActor({
          companyIds: ["company-2"],
          memberships: [
            {
              companyId: "company-2",
              status: "active",
              membershipRole: "admin",
            },
          ],
        }),
      ),
    ).get("/api/companies/company-1/secret-provider-configs");

    expect(res.status).toBe(403);
    expect(mockSecretService.listProviderConfigs).not.toHaveBeenCalled();
  });

  it("rejects sensitive provider vault config fields", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs")
      .send({
        provider: "aws_secrets_manager",
        displayName: "AWS prod",
        config: {
          region: "us-east-1",
          accessKeyId: "AKIA...",
        },
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/sensitive field/i);
    expect(mockSecretService.createProviderConfig).not.toHaveBeenCalled();
  });

  it("rejects sensitive provider vault discovery draft config fields", async () => {
    const res = await request(createApp())
      .post("/api/companies/company-1/secret-provider-configs/discovery/preview")
      .send({
        provider: "aws_secrets_manager",
        config: {
          region: "us-east-1",
          secretAccessKey: "secret",
        },
      });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/sensitive field/i);
    expect(mockSecretService.previewProviderConfigDiscovery).not.toHaveBeenCalled();
  });
});
