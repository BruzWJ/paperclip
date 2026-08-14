import * as t from "./secrets-service.test-support.js";
const { describe, registerSuiteSetup, it, secretRow, bindingRow, createMockDb } = t;
const { expect, secretService, companyId, agentId, valuesCalls, providerState } = t;
const { versionRow, secretId, definitionRow, SYSTEM_ACTOR, definitionId } = t;
const { declarationRow, declarationId, providerConfigRow, providerConfigId } = t;
const { createProviderDouble, mocks, otherCompanyId } = t;

describe("secretService", () => {
  registerSuiteSetup();

  it("records redacted failure audits for missing and disallowed bindings", async () => {
    const cases = [
      {
        select: [[secretRow()], []],
        context: {},
        code: "binding_missing",
      },
      {
        select: [[secretRow()], [bindingRow()]],
        context: { allowedBindingIds: ["another-binding"] },
        code: "binding_not_allowed",
      },
    ];

    for (const entry of cases) {
      const harness = createMockDb({
        select: entry.select,
        insert: [[]],
      });
      await expect(
        secretService(harness.db).resolveEnvBindings(
          companyId,
          {
            API_KEY: { type: "secret_ref", secretId, version: "latest" },
          },
          {
            consumerType: "agent",
            consumerId: agentId,
            actorType: "agent",
            actorId: agentId,
            ...entry.context,
          },
        ),
      ).rejects.toMatchObject({
        status: 422,
        details: { code: entry.code },
      });

      const accessValues = valuesCalls(harness, "insert")[0];
      expect(accessValues).toMatchObject({
        companyId,
        secretId,
        outcome: "failure",
      });
      expect(JSON.stringify(accessValues)).not.toContain("runtime-secret");
    }
    expect(providerState.current.resolveVersion).not.toHaveBeenCalled();
  });

  it("returns resolved values even when best-effort access metadata writes fail", async () => {
    const harness = createMockDb({
      select: [[secretRow()], [bindingRow()], [versionRow()]],
      update: [new Error("last-resolved audit unavailable")],
      insert: [new Error("access audit unavailable")],
    });

    await expect(
      secretService(harness.db).resolveSecretValue(companyId, secretId, "latest", {
        consumerType: "agent",
        consumerId: agentId,
        configPath: "env.API_KEY",
        actorType: "agent",
        actorId: agentId,
      }),
    ).resolves.toBe("runtime-secret");
    expect(harness.remaining("update")).toBe(0);
    expect(harness.remaining("insert")).toBe(0);
  });

  it("creates user secret definitions with canonical attribution and maps unique races to conflict", async () => {
    const created = definitionRow({
      createdByUserId: "owner-user",
      updatedByUserId: "owner-user",
    });
    const harness = createMockDb({
      select: [[]],
      insert: [[created]],
    });

    await expect(
      secretService(harness.db).createUserSecretDefinition(
        companyId,
        {
          key: "github_token",
          name: " GitHub token ",
          provider: "local_encrypted",
        },
        { type: "user", userId: "owner-user" },
      ),
    ).resolves.toEqual(created);
    expect(valuesCalls(harness, "insert")[0]).toMatchObject({
      companyId,
      key: "github_token",
      name: "GitHub token",
      createdByUserId: "owner-user",
      createdByAgentId: null,
      updatedByUserId: "owner-user",
      updatedByAgentId: null,
    });

    await expect(
      secretService(createMockDb().db).createUserSecretDefinition(
        companyId,
        {
          key: " github_token ",
          name: "GitHub token",
          provider: "local_encrypted",
        },
        { type: "user", userId: "owner-user" },
      ),
    ).rejects.toMatchObject({ status: 422 });

    const uniqueRace = Object.assign(new Error("duplicate definition"), {
      cause: {
        code: "23505",
        constraint: "user_secret_definitions_company_key_uq",
      },
    });
    const raceHarness = createMockDb({
      select: [[]],
      insert: [uniqueRace],
    });
    await expect(
      secretService(raceHarness.db).createUserSecretDefinition(
        companyId,
        {
          key: "github_token",
          name: "GitHub token",
          provider: "local_encrypted",
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("persists a target-scoped user-secret declaration without resolving its value", async () => {
    const harness = createMockDb({
      select: [[definitionRow()]],
      delete: [[]],
      insert: [[]],
    });

    await expect(
      secretService(harness.db).syncUserSecretDeclarationsForTarget(
        companyId,
        { targetType: "agent", targetId: agentId },
        [
          {
            definitionKey: "github_token",
            configPath: "env.GITHUB_TOKEN",
            envKey: "GITHUB_TOKEN",
          },
        ],
        { actor: SYSTEM_ACTOR },
      ),
    ).resolves.toEqual([
      {
        definitionId,
        configPath: "env.GITHUB_TOKEN",
        envKey: "GITHUB_TOKEN",
        versionSelector: "latest",
        required: true,
        allowMissingOverride: false,
        label: null,
      },
    ]);

    expect(valuesCalls(harness, "insert")[0]).toEqual([
      {
        companyId,
        userSecretDefinitionId: definitionId,
        targetType: "agent",
        targetId: agentId,
        configPath: "env.GITHUB_TOKEN",
        envKey: "GITHUB_TOKEN",
        versionSelector: "latest",
        required: true,
        allowMissingOverride: false,
        label: null,
      },
    ]);
    expect(providerState.current.resolveVersion).not.toHaveBeenCalled();
  });

  it("resolves a declared responsible-user value and audits credential ownership", async () => {
    const userSecret = secretRow({
      scope: "user",
      ownerUserId: "responsible-user",
      userSecretDefinitionId: definitionId,
      name: "GitHub token (responsible-user)",
    });
    const harness = createMockDb({
      select: [[definitionRow()], [declarationRow()], [userSecret], [userSecret], [versionRow()]],
      update: [[]],
      insert: [[]],
    });

    const result = await secretService(harness.db).resolveUserSecretValue(
      companyId,
      {
        definitionKey: "github_token",
        responsibleUserId: "responsible-user",
        version: "latest",
      },
      {
        consumerType: "agent",
        consumerId: agentId,
        configPath: "env.GITHUB_TOKEN",
        actorType: "agent",
        actorId: agentId,
        allowedBindingIds: [declarationId],
      },
    );

    expect(result).toMatchObject({
      value: "runtime-secret",
      manifestEntry: {
        bindingId: declarationId,
        secretId,
        version: 1,
      },
    });
    const accessValues = valuesCalls(harness, "insert")[0];
    expect(accessValues).toMatchObject({
      secretId,
      userSecretDefinitionId: definitionId,
      secretScope: "user",
      responsibleUserId: "responsible-user",
      credentialOwnerUserId: "responsible-user",
      credentialSubjectType: "user",
      credentialSubjectId: "responsible-user",
      outcome: "success",
    });
    expect(JSON.stringify(accessValues)).not.toContain("runtime-secret");
  });

  it("fails closed outside the user declaration allowlist and skips optional missing declarations", async () => {
    const deniedHarness = createMockDb({
      select: [[definitionRow()], [declarationRow()]],
    });
    await expect(
      secretService(deniedHarness.db).resolveUserSecretValue(
        companyId,
        {
          definitionKey: "github_token",
          responsibleUserId: "responsible-user",
        },
        {
          consumerType: "agent",
          consumerId: agentId,
          configPath: "env.GITHUB_TOKEN",
          allowedBindingIds: ["another-declaration"],
        },
      ),
    ).rejects.toMatchObject({
      status: 422,
      details: { code: "binding_not_allowed" },
    });

    const optionalHarness = createMockDb({ select: [[]] });
    await expect(
      secretService(optionalHarness.db).resolveUserSecretValue(companyId, {
        definitionKey: "missing_optional",
        required: false,
        responsibleUserId: "responsible-user",
      }),
    ).resolves.toBeNull();
  });

  it("maintains one default provider vault and rejects disabled defaults", async () => {
    const created = providerConfigRow({
      provider: "local_encrypted",
      config: {},
      displayName: "Local vault",
      isDefault: true,
      createdByAgentId: agentId,
    });
    const harness = createMockDb({
      update: [[]],
      insert: [[created]],
    });

    await expect(
      secretService(harness.db).createProviderConfig(
        companyId,
        {
          provider: "local_encrypted",
          displayName: " Local vault ",
          isDefault: true,
          config: {},
        },
        { type: "agent", agentId },
      ),
    ).resolves.toEqual(created);

    expect(valuesCalls(harness, "update")[0]).toMatchObject({
      isDefault: false,
    });
    expect(valuesCalls(harness, "insert")[0]).toMatchObject({
      companyId,
      provider: "local_encrypted",
      displayName: "Local vault",
      status: "ready",
      isDefault: true,
      createdByAgentId: agentId,
      createdByUserId: null,
    });

    const invalidHarness = createMockDb();
    await expect(
      secretService(invalidHarness.db).createProviderConfig(
        companyId,
        {
          provider: "local_encrypted",
          displayName: "Disabled",
          status: "disabled",
          isDefault: true,
          config: {},
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(invalidHarness.calls).toEqual([]);

    const disabledHarness = createMockDb({
      select: [[providerConfigRow({ status: "disabled" })]],
    });
    await expect(
      secretService(disabledHarness.db).setDefaultProviderConfig(providerConfigId, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ status: 422 });
    expect(disabledHarness.calls.filter((call) => call.operation === "update")).toEqual([]);
  });

  it("passes the selected provider vault into health checks", async () => {
    providerState.current = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    const config = providerConfigRow();
    const harness = createMockDb({
      select: [[config]],
      update: [[]],
    });

    await expect(
      secretService(harness.db).checkProviderConfigHealth(providerConfigId, SYSTEM_ACTOR),
    ).resolves.toMatchObject({
      configId: providerConfigId,
      provider: "aws_secrets_manager",
      status: "ready",
      message: "Provider ready",
      checkedAt: expect.any(Date),
    });
    expect(providerState.current.healthCheck).toHaveBeenCalledWith({
      providerConfig: {
        id: providerConfigId,
        provider: "aws_secrets_manager",
        status: "ready",
        config: config.config,
      },
    });
    expect(valuesCalls(harness, "update")[0]).toMatchObject({
      healthStatus: "ready",
      healthMessage: "Provider ready",
    });
  });

  it("rejects cross-company and disabled provider vaults before provider writes", async () => {
    for (const config of [
      providerConfigRow({
        companyId: otherCompanyId,
      }),
      providerConfigRow({ status: "disabled" }),
    ]) {
      providerState.current = createProviderDouble("aws_secrets_manager");
      mocks.getSecretProvider.mockImplementation(() => providerState.current);
      const harness = createMockDb({
        select: [[], [], [config]],
      });

      await expect(
        secretService(harness.db).create(
          companyId,
          {
            name: "Rejected vault",
            provider: "aws_secrets_manager",
            providerConfigId,
            value: "must-not-reach-provider",
          },
          SYSTEM_ACTOR,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(providerState.current.createSecret).not.toHaveBeenCalled();
      expect(harness.calls.filter((call) => call.operation === "insert")).toEqual([]);
    }
  });
});
