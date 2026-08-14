import * as t from "./secrets-service.test-support.js";
const { describe, registerSuiteSetup, it, providerState, createProviderDouble } = t;
const { mocks, secretRow, providerConfigRow, createMockDb, expect, secretService } = t;
const { secretId, providerConfigId, valuesCalls, SYSTEM_ACTOR, versionRow, now } = t;
const { companyId, otherCompanyId, agentId, bindingRow, companySecretBindings } = t;
const { userSecretDeclarations, bindingId } = t;

describe("secretService", () => {
  registerSuiteSetup();

  it("rotates into a disabled version before atomically promoting it", async () => {
    providerState.current = createProviderDouble("aws_secrets_manager");
    mocks.getSecretProvider.mockImplementation(() => providerState.current);
    const secret = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      latestVersion: 1,
    });
    const config = providerConfigRow();
    const updated = secretRow({
      provider: "aws_secrets_manager",
      providerConfigId,
      latestVersion: 2,
    });
    const harness = createMockDb({
      select: [[secret], [config]],
      insert: [[]],
      update: [[], [], [updated]],
    });

    await expect(
      secretService(harness.db).rotate(
        secretId,
        {
          value: "rotated-provider-value",
        },
        { type: "user", userId: "rotator" },
      ),
    ).resolves.toEqual(updated);

    expect(providerState.current.createVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        value: "rotated-provider-value",
        providerConfig: expect.objectContaining({
          id: providerConfigId,
        }),
        context: {
          companyId,
          secretKey: "api-key",
          secretName: "API key",
          version: 2,
        },
      }),
    );
    expect(valuesCalls(harness, "insert")[0]).toMatchObject({
      secretId,
      version: 2,
      status: "disabled",
      createdByUserId: "rotator",
      createdByAgentId: null,
    });
    expect(valuesCalls(harness, "update")).toEqual([
      expect.objectContaining({ status: "previous" }),
      expect.objectContaining({ status: "current" }),
      expect.objectContaining({
        latestVersion: 2,
        providerConfigId,
      }),
    ]);
  });

  it("archives prepared provider material when a new version cannot be persisted", async () => {
    const secret = secretRow();
    const failure = new Error("version insert failed");
    const harness = createMockDb({
      select: [[secret]],
      insert: [failure],
    });

    await expect(
      secretService(harness.db).rotate(
        secretId,
        {
          value: "rotated-provider-value",
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toBe(failure);
    expect(providerState.current.deleteOrArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "archive",
        context: expect.objectContaining({ version: 2 }),
      }),
    );
  });

  it("rejects inactive secrets and inactive versions before provider resolution", async () => {
    for (const unavailable of [
      {
        select: [[secretRow({ status: "archived" })]],
        code: "secret_inactive",
      },
      {
        select: [[secretRow()], [versionRow({ status: "disabled" })]],
        code: "version_inactive",
      },
      {
        select: [[secretRow()], [versionRow({ revokedAt: now })]],
        code: "version_inactive",
      },
    ]) {
      const harness = createMockDb({
        select: unavailable.select,
      });
      await expect(
        secretService(harness.db).resolveSecretVersion(companyId, secretId, "latest"),
      ).rejects.toMatchObject({
        status: 422,
        details: { code: unavailable.code },
      });
    }
    expect(providerState.current.resolveVersion).not.toHaveBeenCalled();
  });

  it("rejects cross-company references during environment normalization", async () => {
    const harness = createMockDb({
      select: [[secretRow({ companyId: otherCompanyId })]],
    });

    await expect(
      secretService(harness.db).normalizeEnvBindingsForPersistence(companyId, {
        API_KEY: { type: "secret_ref", secretId, version: "latest" },
      }),
    ).rejects.toThrow(/same company/i);
    expect(providerState.current.resolveVersion).not.toHaveBeenCalled();
  });

  it("rejects class-3 leases outside the canonical allowlist", async () => {
    const invalidBindings = [
      {
        configPath: "env.GITHUB_TOKEN",
        projectionClass: "class_3_static_lease" as const,
        projectionAllowlistKey: "not-approved",
      },
    ];

    for (const invalid of invalidBindings) {
      const harness = createMockDb({
        select: [[secretRow()]],
      });
      await expect(
        secretService(harness.db).createBinding(
          {
            companyId,
            secretId,
            targetType: "agent",
            targetId: agentId,
            required: true,
            ...invalid,
          },
          SYSTEM_ACTOR,
        ),
      ).rejects.toMatchObject({ status: 422 });
      expect(harness.calls.filter((call) => call.operation === "insert")).toEqual([]);
    }
  });

  it("creates one canonical binding and rejects a duplicate target config path", async () => {
    const created = bindingRow();
    const createHarness = createMockDb({
      select: [[secretRow()], []],
      insert: [[created]],
    });

    await expect(
      secretService(createHarness.db).createBinding(
        {
          companyId,
          secretId,
          targetType: "agent",
          targetId: agentId,
          configPath: "env.API_KEY",
        },
        SYSTEM_ACTOR,
      ),
    ).resolves.toEqual(created);
    expect(valuesCalls(createHarness, "insert")[0]).toMatchObject({
      companyId,
      secretId,
      targetType: "agent",
      targetId: agentId,
      configPath: "env.API_KEY",
      versionSelector: "latest",
      required: true,
      projectionClass: "unclassified",
    });

    const duplicateHarness = createMockDb({
      select: [[secretRow()], [bindingRow({ secretId: "other-secret" })]],
    });
    await expect(
      secretService(duplicateHarness.db).createBinding(
        {
          companyId,
          secretId,
          targetType: "agent",
          targetId: agentId,
          configPath: "env.API_KEY",
        },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(duplicateHarness.calls.filter((call) => call.operation === "insert")).toEqual([]);
  });

  it("replaces only the target environment bindings with canonical secret refs", async () => {
    const harness = createMockDb({
      select: [[secretRow()]],
      delete: [[], []],
      insert: [[]],
    });

    await expect(
      secretService(harness.db).syncEnvBindingsForTarget(
        companyId,
        { targetType: "agent", targetId: agentId },
        {
          API_KEY: { type: "secret_ref", secretId, version: "latest" },
          PLAIN_VALUE: { type: "plain", value: "visible" },
        },
        { actor: SYSTEM_ACTOR },
      ),
    ).resolves.toEqual([
      {
        secretId,
        configPath: "env.API_KEY",
        versionSelector: "latest",
        projectionClass: "unclassified",
        projectionAllowlistKey: null,
      },
    ]);

    expect(valuesCalls(harness, "insert")[0]).toEqual([
      {
        companyId,
        secretId,
        targetType: "agent",
        targetId: agentId,
        configPath: "env.API_KEY",
        versionSelector: "latest",
        required: true,
        projectionClass: "unclassified",
        projectionAllowlistKey: null,
      },
    ]);
    expect(
      harness.calls
        .filter((call) => call.operation === "delete" && call.method === "delete")
        .map((call) => call.args[0]),
    ).toEqual([companySecretBindings, userSecretDeclarations]);
  });

  it("resolves binding target labels without leaking fallback identifiers", async () => {
    const harness = createMockDb({
      select: [
        [bindingRow()],
        [
          {
            id: agentId,
            name: "Codex Coder",
            title: "Engineer",
            status: "idle",
          },
        ],
      ],
    });

    await expect(secretService(harness.db).listBindingReferences(companyId, secretId)).resolves.toEqual([
      expect.objectContaining({
        id: bindingId,
        target: {
          type: "agent",
          id: agentId,
          label: "Codex Coder (Engineer)",
          routeTarget: { kind: "agent", id: agentId },
          status: "idle",
        },
      }),
    ]);
  });

  it("omits noncanonical binding targets instead of projecting identifier fallbacks", async () => {
    const harness = createMockDb({
      select: [[bindingRow({ targetId: "legacy-agent-name" })]],
    });

    await expect(secretService(harness.db).listBindingReferences(companyId, secretId)).resolves.toEqual([]);
    expect(harness.remaining("select")).toBe(0);
  });

  it("resolves an allowed binding and records value-free success metadata", async () => {
    const harness = createMockDb({
      select: [[secretRow()], [bindingRow()], [versionRow()]],
      update: [[]],
      insert: [[]],
    });

    const resolved = await secretService(harness.db).resolveEnvBindings(
      companyId,
      {
        API_KEY: { type: "secret_ref", secretId, version: "latest" },
      },
      {
        consumerType: "agent",
        consumerId: agentId,
        actorType: "agent",
        actorId: agentId,
        taskId: "task-1",
        runId: "run-1",
        allowedBindingIds: [bindingId],
      },
    );

    expect(resolved.env).toEqual({ API_KEY: "runtime-secret" });
    expect([...resolved.secretKeys]).toEqual(["API_KEY"]);
    expect(resolved.manifest).toEqual([
      expect.objectContaining({
        configPath: "env.API_KEY",
        envKey: "API_KEY",
        secretId,
        bindingId,
        version: 1,
        outcome: "success",
      }),
    ]);
    expect(providerState.current.resolveVersion).toHaveBeenCalledWith(
      expect.objectContaining({
        material: versionRow().material,
        context: { companyId, secretId, secretKey: "api-key", version: 1 },
      }),
    );
    const accessValues = valuesCalls(harness, "insert")[0];
    expect(accessValues).toMatchObject({
      companyId,
      secretId,
      version: 1,
      actorType: "agent",
      actorId: agentId,
      consumerType: "agent",
      consumerId: agentId,
      configPath: "env.API_KEY",
      taskId: "task-1",
      runId: "run-1",
      outcome: "success",
      errorCode: null,
    });
    expect(JSON.stringify(accessValues)).not.toContain("runtime-secret");
  });
});
