import * as t from "./secrets-service.test-support.js";
const { describe, registerSuiteSetup, it, mkdtempSync, path, os } = t;
const { createLocalEncryptedProvider, testSecretsRuntimeConfig, expect } = t;
const { existsSync, statSync, rmSync, requireSecretMutationActor, SYSTEM_ACTOR } = t;
const { secretRow, createMockDb, secretService, companyId, valuesCalls } = t;
const { providerState, createProviderDouble, mocks, providerConfigRow } = t;
const { providerConfigId, preparedVersion, SecretProviderClientError, agentId } = t;
const { companySecrets, companySecretVersions } = t;

describe("secretService", () => {
  registerSuiteSetup();

  it("encrypts and resolves local values with an isolated master-key file", async () => {
    const tempDir = mkdtempSync(path.join(os.tmpdir(), "paperclip-secrets-service-"));
    const keyPath = path.join(tempDir, "master.key");
    const previousKey = process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
    const localEncryptedProvider = createLocalEncryptedProvider(
      testSecretsRuntimeConfig({ masterKeyFilePath: keyPath }),
    );

    try {
      const prepared = await localEncryptedProvider.createSecret({
        value: "local-runtime-secret",
      });
      expect(existsSync(keyPath)).toBe(true);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(prepared.material)).not.toContain("local-runtime-secret");
      await expect(
        localEncryptedProvider.resolveVersion({
          material: prepared.material,
          externalRef: null,
        }),
      ).resolves.toBe("local-runtime-secret");
    } finally {
      if (previousKey === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY;
      else process.env.PAPERCLIP_SECRETS_MASTER_KEY = previousKey;
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts only exact canonical mutation actors", () => {
    expect(
      requireSecretMutationActor({
        type: "user",
        userId: "user-1",
      }),
    ).toEqual({
      userId: "user-1",
      agentId: null,
    });
    expect(requireSecretMutationActor({ type: "agent", agentId })).toEqual({
      userId: null,
      agentId,
    });
    expect(requireSecretMutationActor(SYSTEM_ACTOR)).toEqual({
      userId: null,
      agentId: null,
    });

    for (const actor of [
      undefined,
      { userId: "legacy-user" },
      { agentId: "legacy-agent" },
      { type: "user", userId: "user-1", agentId: "agent-1" },
      { type: "agent", agentId: "agent-1", userId: "user-1" },
      { type: "user", userId: "   " },
      { type: "agent", agentId: "" },
      { type: "system", userId: "wrong" },
      { type: "plugin", actorId: "plugin-1" },
    ]) {
      expect(() => requireSecretMutationActor(actor)).toThrowError(
        expect.objectContaining({
          status: 422,
          details: { code: "invalid_secret_mutation_actor" },
        }),
      );
    }
  });

  it("persists exact user, agent, and system attribution on the secret and first version", async () => {
    const cases: Array<{
      actor: testSupport.SecretMutationActor;
      userId: string | null;
      agentId: string | null;
    }> = [
      {
        actor: { type: "user", userId: "secret-operator" },
        userId: "secret-operator",
        agentId: null,
      },
      { actor: { type: "agent", agentId }, userId: null, agentId },
      { actor: SYSTEM_ACTOR, userId: null, agentId: null },
    ];

    for (const [index, entry] of cases.entries()) {
      const reserved = secretRow({
        id: `reserved-${index}`,
        status: "archived",
        latestVersion: 0,
      });
      const active = secretRow({ id: reserved.id });
      const harness = createMockDb({
        select: [[], []],
        insert: [[reserved], []],
        update: [[], [], [active]],
      });

      await expect(
        secretService(harness.db).create(
          companyId,
          {
            name: `Actor secret ${index}`,
            provider: "local_encrypted",
            value: "provider-only-value",
          },
          entry.actor,
        ),
      ).resolves.toEqual(active);

      const [secretValues, versionValues] = valuesCalls(harness, "insert");
      expect(secretValues).toMatchObject({
        createdByUserId: entry.userId,
        createdByAgentId: entry.agentId,
        status: "archived",
        latestVersion: 0,
      });
      expect(versionValues).toMatchObject({
        secretId: reserved.id,
        version: 1,
        createdByUserId: entry.userId,
        createdByAgentId: entry.agentId,
        status: "disabled",
      });
      expect(JSON.stringify([secretValues, versionValues])).not.toContain("provider-only-value");
      expect(harness.remaining("select")).toBe(0);
      expect(harness.remaining("insert")).toBe(0);
      expect(harness.remaining("update")).toBe(0);
    }
  });

  it("links an external provider reference without persisting or resolving plaintext", async () => {
    providerState.current = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    const externalRef = "arn:aws:secretsmanager:us-east-1:123456789012:secret:linked";
    const config = providerConfigRow();
    const reserved = secretRow({
      status: "archived",
      latestVersion: 0,
      provider: "aws_secrets_manager",
      providerConfigId,
      managedMode: "external_reference",
    });
    const active = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      managedMode: "external_reference",
      externalRef,
    });
    const harness = createMockDb({
      select: [[], [], [config]],
      insert: [[reserved], []],
      update: [[], [], [active]],
    });

    await expect(
      secretService(harness.db).create(
        companyId,
        {
          name: "Linked AWS secret",
          provider: "aws_secrets_manager",
          providerConfigId,
          managedMode: "external_reference",
          externalRef,
        },
        SYSTEM_ACTOR,
      ),
    ).resolves.toEqual(active);

    expect(providerState.current.linkExternalSecret).toHaveBeenCalledWith(
      expect.objectContaining({
        externalRef,
        providerConfig: {
          id: providerConfigId,
          provider: "aws_secrets_manager",
          status: "ready",
          config: config.config,
        },
      }),
    );
    expect(providerState.current.createSecret).not.toHaveBeenCalled();
    expect(providerState.current.resolveVersion).not.toHaveBeenCalled();
    expect(JSON.stringify(valuesCalls(harness, "insert"))).not.toContain("runtime-secret");
  });

  it("rejects padded provider references before provider lookup or persistence", async () => {
    const harness = createMockDb();

    await expect(
      secretService(harness.db).create(
        companyId,
        {
          name: "Padded AWS reference",
          provider: "aws_secrets_manager",
          managedMode: "external_reference",
          externalRef: " arn:aws:secretsmanager:us-east-1:123456789012:secret:linked",
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/exact value without surrounding whitespace/i);

    expect(mocks.getSecretProvider).not.toHaveBeenCalled();
    expect(harness.calls).toEqual([]);
  });

  it("rejects non-exact provider output before committing provider references", async () => {
    providerState.current = createProviderDouble("aws_secrets_manager");
    providerState.current.linkExternalSecret.mockResolvedValueOnce(
      preparedVersion({
        externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:linked",
        providerVersionRef: " version-1",
      }),
    );
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    const reserved = secretRow({
      status: "archived",
      latestVersion: 0,
      provider: "aws_secrets_manager",
      providerConfigId,
      managedMode: "external_reference",
    });
    const harness = createMockDb({
      select: [[], [], [providerConfigRow()]],
      insert: [[reserved]],
      delete: [[]],
    });

    await expect(
      secretService(harness.db).create(
        companyId,
        {
          name: "Linked AWS secret",
          provider: "aws_secrets_manager",
          providerConfigId,
          managedMode: "external_reference",
          externalRef: "arn:aws:secretsmanager:us-east-1:123456789012:secret:linked",
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toThrow(/exact value without surrounding whitespace/i);

    expect(harness.remaining("update")).toBe(0);
    expect(harness.remaining("delete")).toBe(0);
    expect(valuesCalls(harness, "insert")).toHaveLength(1);
  });

  it("sanitizes provider create failures and removes the reserved row", async () => {
    providerState.current = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    const rawMessage = "AccessDenied: arn:aws:sts::123456789012:assumed-role/private";
    providerState.current.createSecret.mockRejectedValueOnce(
      new SecretProviderClientError({
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "createSecret",
        message: "AWS Secrets Manager denied the request.",
        rawMessage,
      }),
    );
    const config = providerConfigRow();
    const reserved = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      status: "archived",
      latestVersion: 0,
    });
    const harness = createMockDb({
      select: [[], [], [config]],
      insert: [[reserved]],
      delete: [[]],
    });

    const thrown = await secretService(harness.db)
      .create(
        companyId,
        {
          name: "Managed AWS secret",
          key: "managed_aws_secret",
          provider: "aws_secrets_manager",
          providerConfigId,
          value: "provider-only-value",
        },
        SYSTEM_ACTOR,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(thrown).toMatchObject({
      status: 403,
      message: "AWS Secrets Manager denied the request.",
      details: {
        code: "access_denied",
        provider: "aws_secrets_manager",
        operation: "secret.create",
        providerConfigId,
        region: "us-east-1",
        requiredCapability: "secretsmanager:CreateSecret",
      },
    });
    expect(JSON.stringify(thrown)).not.toContain("arn:aws");
    expect(JSON.stringify(thrown)).not.toContain("provider-only-value");
    expect(
      harness.calls.find((call) => call.operation === "delete" && call.method === "delete")?.args[0],
    ).toBe(companySecrets);
    expect(harness.remaining("delete")).toBe(0);
  });

  it("cleans provider material and both local rows when prepared-version persistence fails", async () => {
    const reserved = secretRow({
      status: "archived",
      latestVersion: 0,
    });
    const persistenceFailure = new Error("version persistence failed");
    const harness = createMockDb({
      select: [[], []],
      insert: [[reserved], persistenceFailure],
      update: [[]],
      delete: [[], []],
    });

    await expect(
      secretService(harness.db).create(
        companyId,
        {
          name: "Rollback secret",
          provider: "local_encrypted",
          value: "provider-only-value",
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBe(persistenceFailure);

    expect(providerState.current.deleteOrArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "delete",
        externalRef: null,
      }),
    );
    const deletedTables = harness.calls
      .filter((call) => call.operation === "delete" && call.method === "delete")
      .map((call) => call.args[0]);
    expect(deletedTables).toEqual([companySecretVersions, companySecrets]);
  });
});
