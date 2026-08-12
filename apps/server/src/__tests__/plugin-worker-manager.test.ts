import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import {
  createHostClientHandlers,
  JsonRpcCallError,
  PLUGIN_RPC_ERROR_CODES,
  type HostServices,
  type HostClientHandlers,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import {
  appendStderrExcerpt,
  createPluginWorkerHandle,
  formatWorkerFailureMessage,
} from "../services/plugin-worker-manager.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const DELAYED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-delayed.cjs");
const CONFIG_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-config.cjs");
const INVOCATION_SCOPE_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-invocation-scope.cjs",
);
const TERMINATED_WORKER_ENTRYPOINT = path.join(FIXTURES_DIR, "plugin-worker-terminated.cjs");
const RPC_OPERATION_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-rpc-operation.cjs",
);
const LOG_REQUEST_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-log-request.cjs",
);
const MALFORMED_OUTPUT_WORKER_ENTRYPOINT = path.join(
  FIXTURES_DIR,
  "plugin-worker-malformed-output.cjs",
);

const TEST_MANIFEST: PaperclipPluginManifestV1 = {
  id: "test.plugin",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Test plugin",
  description: "Test plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: [],
  entrypoints: { worker: "dist/worker.js" },
};

const TEST_TOOL = {
  name: "lookup",
  displayName: "Lookup",
  description: "Lookup",
  parametersSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
} as const;

function completeHostHandlers(
  overrides: Partial<HostClientHandlers> = {},
): HostClientHandlers {
  return {
    ...createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {} as HostServices,
    }),
    ...overrides,
  };
}

function configuredWorker(
  manifest: PaperclipPluginManifestV1 = TEST_MANIFEST,
  config: Record<string, unknown> = {},
) {
  return createPluginWorkerHandle("test.plugin", {
    entrypointPath: CONFIG_WORKER_ENTRYPOINT,
    manifest,
    instanceInfo: {
      instanceId: "instance-1",
      hostVersion: "1.0.0",
    },
    apiVersion: 1,
    databaseNamespace: null,
    onTerminalCrash: () => undefined,
    hostHandlers: completeHostHandlers({
      "config.get": async () => config,
    }),
  });
}

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        "TypeError: Unknown file extension \".ts\"",
      ),
    ).toBe(
      "Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension \".ts\"",
    );
  });

  it("routes worker logs through the acknowledged host request handler", async () => {
    let acknowledgeLog: (() => void) | null = null;
    const loggerLog = vi.fn(() => new Promise<void>((resolve) => {
      acknowledgeLog = resolve;
    }));
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {
        logger: { log: loggerLog },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: LOG_REQUEST_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: handlers,
    });
    let startSettled = false;

    try {
      const startPromise = handle.start();
      void startPromise.then(
        () => {
          startSettled = true;
        },
        () => undefined,
      );

      await vi.waitFor(() => expect(loggerLog).toHaveBeenCalledOnce());
      expect(loggerLog).toHaveBeenCalledWith({
        level: "info",
        message: "Worker initialized",
        meta: { phase: "setup" },
      });
      expect(startSettled).toBe(false);

      acknowledgeLog?.();
      await expect(startPromise).resolves.toBeUndefined();
      expect(handle.status).toBe("running");
    } finally {
      acknowledgeLog?.();
      await handle.stop().catch(() => undefined);
    }
  });

  it("ignores blank stdout then terminates and restarts a worker after malformed output", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: MALFORMED_OUTPUT_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers(),
      rpcTimeoutMs: 5_000,
    });

    try {
      await handle.start();
      expect(handle.status).toBe("running");

      await expect(handle.call("getData", {
        key: "malformed",
        companyId: "company-1",
        params: {},
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: expect.stringContaining("Worker protocol violation"),
      });
      expect(handle.diagnostics()).toMatchObject({
        status: "backoff",
        totalCrashes: 1,
        pendingRequests: 0,
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not duplicate stderr that is already present", () => {
    const message = [
      "Worker process exited (code=1, signal=null)",
      "",
      "Worker stderr:",
      "TypeError: Unknown file extension \".ts\"",
    ].join("\n");

    expect(
      formatWorkerFailureMessage(message, "TypeError: Unknown file extension \".ts\""),
    ).toBe(message);
  });

  it("keeps only the latest stderr excerpt", () => {
    let excerpt = "";
    excerpt = appendStderrExcerpt(excerpt, "first line");
    excerpt = appendStderrExcerpt(excerpt, "second line");

    expect(excerpt).toContain("first line");
    expect(excerpt).toContain("second line");

    excerpt = appendStderrExcerpt(excerpt, "x".repeat(9_000));

    expect(excerpt).not.toContain("first line");
    expect(excerpt).not.toContain("second line");
    expect(excerpt.length).toBeLessThanOrEqual(8_000);
  });

  it("rejects prompt-hook workers whose manifest grant and advertised method disagree", async () => {
    const cases = [
      {
        capabilities: ["runtime.prompt.observe"] as PaperclipPluginManifestV1["capabilities"],
        config: {},
        expected: 'capability "runtime.prompt.observe" requires the worker to advertise "beforePrompt"',
      },
      {
        capabilities: [] as PaperclipPluginManifestV1["capabilities"],
        config: { advertiseBeforePrompt: true },
        expected: 'advertised "beforePrompt" without manifest capability "runtime.prompt.observe"',
      },
    ];

    for (const testCase of cases) {
      const handle = createPluginWorkerHandle("test.plugin", {
        entrypointPath: CONFIG_WORKER_ENTRYPOINT,
        manifest: {
          ...TEST_MANIFEST,
          capabilities: testCase.capabilities,
        },
        instanceInfo: {
          instanceId: "instance-1",
          hostVersion: "1.0.0",
        },
        apiVersion: 1,
        databaseNamespace: null,
        onTerminalCrash: () => undefined,
        hostHandlers: completeHostHandlers({
          "config.get": async () => testCase.config,
        }),
      });

      try {
        await expect(handle.start()).rejects.toThrow(testCase.expected);
        expect(handle.status).not.toBe("running");
      } finally {
        await handle.stop().catch(() => undefined);
      }
    }
  });

  it("rejects tool workers whose manifest declarations and advertised method disagree", async () => {
    const cases = [
      {
        manifest: {
          ...TEST_MANIFEST,
          capabilities: ["agent.tools.register"],
          tools: [TEST_TOOL],
        } as PaperclipPluginManifestV1,
        config: {},
        expected:
          'Manifest tool declarations require the worker to advertise "executeTool"',
      },
      {
        manifest: TEST_MANIFEST,
        config: { extraSupportedMethods: ["executeTool"] },
        expected:
          'Worker advertised "executeTool" without manifest tool declarations',
      },
    ];

    for (const testCase of cases) {
      const handle = configuredWorker(testCase.manifest, testCase.config);

      try {
        await expect(handle.start()).rejects.toThrow(testCase.expected);
        expect(handle.status).not.toBe("running");
      } finally {
        await handle.stop().catch(() => undefined);
      }
    }
  });

  it.each([
    {
      label: "jobs",
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["jobs.schedule"],
        jobs: [{ jobKey: "sync", displayName: "Sync" }],
      } as PaperclipPluginManifestV1,
      method: "runJob",
      expectedDeclaration: "Manifest job declarations",
      expectedAbsence: "without manifest job declarations",
    },
    {
      label: "webhooks",
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["webhooks.receive"],
        webhooks: [{ endpointKey: "events", displayName: "Events" }],
      } as PaperclipPluginManifestV1,
      method: "handleWebhook",
      expectedDeclaration: "Manifest webhook declarations",
      expectedAbsence: "without manifest webhook declarations",
    },
    {
      label: "API routes",
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["api.routes.register"],
        apiRoutes: [{
          routeKey: "summary",
          method: "GET",
          path: "/summary",
          companyResolution: { from: "query", key: "companyId" },
        }],
      } as PaperclipPluginManifestV1,
      method: "handleApiRequest",
      expectedDeclaration: "Manifest API route declarations",
      expectedAbsence: "without manifest API route declarations",
    },
  ])("rejects $label declarations and advertised methods that disagree", async ({
    manifest,
    method,
    expectedDeclaration,
    expectedAbsence,
  }) => {
    for (const testCase of [
      {
        manifest,
        config: {},
        expected: `${expectedDeclaration} require the worker to advertise "${method}"`,
      },
      {
        manifest: TEST_MANIFEST,
        config: { extraSupportedMethods: [method] },
        expected: `Worker advertised "${method}" ${expectedAbsence}`,
      },
    ]) {
      const handle = configuredWorker(testCase.manifest, testCase.config);

      try {
        await expect(handle.start()).rejects.toThrow(testCase.expected);
        expect(handle.status).not.toBe("running");
      } finally {
        await handle.stop().catch(() => undefined);
      }
    }
  });

  it.each([
    ["onEvent", "events.subscribe"],
    ["tasks.creatorCallback.deliver", "tasks.create"],
  ] as const)("rejects %s without its manifest capability", async (method, capability) => {
    const handle = configuredWorker(TEST_MANIFEST, {
      extraSupportedMethods: [method],
    });

    try {
      await expect(handle.start()).rejects.toThrow(
        `Worker advertised "${method}" without manifest capability "${capability}"`,
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("accepts a tool worker only when its declaration and method agree", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: CONFIG_WORKER_ENTRYPOINT,
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["agent.tools.register"],
        tools: [TEST_TOOL],
      } as PaperclipPluginManifestV1,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers({
        "config.get": async () => ({
          extraSupportedMethods: ["executeTool"],
        }),
      }),
    });

    try {
      await handle.start();
      expect(handle.status).toBe("running");
      expect(handle.supportedMethods).toContain("executeTool");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("starts a prompt-hook worker when its manifest grant and advertised method agree", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: CONFIG_WORKER_ENTRYPOINT,
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["runtime.prompt.observe"],
      },
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers({
        "config.get": async () => ({ advertiseBeforePrompt: true }),
      }),
    });

    try {
      await handle.start();
      expect(handle.status).toBe("running");
      expect(handle.supportedMethods).toContain("beforePrompt");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it.each([
    [["notAWorkerMethod"], "unknown optional method"],
    [["getData"], "duplicate supportedMethods"],
  ])("rejects an invalid optional-method handshake: %s", async (extraSupportedMethods, error) => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: CONFIG_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers({
        "config.get": async () => ({ extraSupportedMethods }),
      }),
    });

    try {
      await expect(handle.start()).rejects.toThrow(error);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects additional initialize result fields", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: CONFIG_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers({
        "config.get": async () => ({ includeUnexpectedInitializeField: true }),
      }),
    });

    try {
      await expect(handle.start()).rejects.toThrow(
        "must return exactly supportedMethods",
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it.each([
    [
      { rejectHealth: true },
      "Health is not implemented",
    ],
    [
      { healthResult: null },
      "Worker health must return an object",
    ],
    [
      { healthResult: { status: "ok", unexpected: true } },
      "Worker health returned unexpected fields",
    ],
    [
      { healthResult: { status: "degraded", message: "dependency lag" } },
      'Worker health check failed with status "degraded": dependency lag',
    ],
  ])("requires an exact healthy startup response", async (config, expected) => {
    const handle = configuredWorker(TEST_MANIFEST, config);

    try {
      await expect(handle.start()).rejects.toThrow(expected);
      expect(handle.status).not.toBe("running");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects optional calls the worker did not advertise", async () => {
    const handle = configuredWorker();

    try {
      await handle.start();
      await expect(handle.call("performAction", {
        key: "unadvertised",
        params: {},
        actorContext: {
          type: "system",
          companyId: null,
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED,
        message: expect.stringContaining("did not advertise it during initialization"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("times out advertised calls using the handle default when no override is provided", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers(),
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(handle.call("getData", {
        key: "delayed",
        companyId: "company-1",
        params: { delayMs: 50 },
      })).rejects.toMatchObject({
        message: expect.stringContaining("timed out after 10ms"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("honors per-call timeout overrides for advertised calls", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers(),
      rpcTimeoutMs: 10,
    });

    try {
      await handle.start();

      await expect(handle.call("getData", {
        key: "delayed",
        companyId: "company-1",
        params: { delayMs: 50 },
      }, 100)).resolves.toMatchObject({
        exitCode: 0,
        stdout: "ok\n",
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("fences new calls while stop drains an already-accepted request", async () => {
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: DELAYED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers(),
      rpcTimeoutMs: 1_000,
    });

    try {
      await handle.start();
      const completionOrder: string[] = [];
      const activeRequest = handle.call("getData", {
        key: "accepted-before-stop",
        companyId: "company-1",
        params: { delayMs: 50 },
      }).then((result) => {
        completionOrder.push("request");
        return result;
      });
      const stop = handle.stop().then(() => {
        completionOrder.push("stop");
      });

      expect(handle.status).toBe("stopping");
      await expect(handle.call("getData", {
        key: "rejected-during-stop",
        companyId: "company-1",
        params: { delayMs: 0 },
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.WORKER_UNAVAILABLE,
        message: expect.stringContaining("is stopping"),
      });

      await expect(activeRequest).resolves.toMatchObject({ stdout: "ok\n" });
      await stop;
      expect(completionOrder).toEqual(["request", "stop"]);
      expect(handle.status).toBe("stopped");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("does not emit an unhandled rejection when a plugin responds with terminated before callers attach handlers", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);

    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: TERMINATED_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers(),
    });

    try {
      await handle.start();

      const pendingCall = handle.call(
        "getData" as keyof HostToWorkerMethods,
        {
          key: "terminated",
          companyId: "company-1",
          params: {},
        } as HostToWorkerMethods[keyof HostToWorkerMethods][0],
      );

      await new Promise((resolve) => setImmediate(resolve));

      await expect(pendingCall).rejects.toBeInstanceOf(JsonRpcCallError);
      await expect(pendingCall).rejects.toMatchObject({
        message: expect.stringContaining("terminated"),
      });
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes performAction invocation scope to nested worker host calls", async () => {
    const companiesGet = vi.fn(async (
      params: { companyId: string },
      context?: { invocationScope?: { companyId?: string | null } | null },
    ) => ({
      id: params.companyId,
      scopedCompanyId: context?.invocationScope?.companyId ?? null,
    }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers({
        "companies.get": companiesGet as never,
      }),
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "echo",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).resolves.toEqual({
        id: "company-a",
        scopedCompanyId: "company-a",
      });
      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-a" },
        expect.objectContaining({
          invocationScope: { companyId: "company-a" },
          rpcOperationId: expect.stringMatching(/^pc_plugin_rpc_op_v1_/),
        }),
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("passes echoed invocation scope to worker-to-host handlers", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-1" }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers({
        "companies.get": companiesGet as never,
      }),
    });

    try {
      await handle.start();

      await expect(handle.call("getData", {
        key: "probe",
        companyId: "company-1",
        params: {
          mode: "echo",
          requestedCompanyId: "company-1",
        },
      } as HostToWorkerMethods["getData"][0])).resolves.toEqual({ id: "company-1" });

      expect(companiesGet).toHaveBeenCalledWith(
        { companyId: "company-1" },
        expect.objectContaining({
          invocationScope: { companyId: "company-1" },
          rpcOperationId: expect.stringMatching(/^pc_plugin_rpc_op_v1_/),
        }),
      );
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects performAction nested host calls that omit the invocation id", async () => {
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          list: vi.fn(async () => []),
          get: vi.fn(async (params: { companyId: string }) => ({ id: params.companyId })),
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          requestedCompanyId: "company-b",
        },
        actorContext: {
          type: "agent",
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects nested worker host calls that forge an unknown invocation id", async () => {
    const companiesGet = vi.fn(async (params: { companyId: string }) => ({ id: params.companyId }));
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: handlers,
    });

    try {
      await handle.start();

      await expect(handle.call("performAction", {
        key: "probe",
        params: {
          mode: "unknown",
          requestedCompanyId: "company-a",
        },
        actorContext: {
          type: "agent",
          agentId: "agent-1",
          runId: "run-1",
          companyId: "company-a",
        },
        renderEnvironment: null,
      })).rejects.toMatchObject({
        code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        message: expect.stringContaining("unknown invocation scope"),
      });
      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("rejects missing or unknown invocation ids while a company invocation is active", async () => {
    const companiesGet = vi.fn(async () => ({ id: "company-2" }));
    const hostHandlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: ["companies.read"],
      services: {
        companies: {
          get: companiesGet,
        },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers,
    });

    try {
      await handle.start();

      for (const mode of ["omit", "unknown"]) {
        await expect(handle.call("getData", {
          key: "probe",
          companyId: "company-1",
          params: {
            mode,
            requestedCompanyId: "company-2",
          },
        } as HostToWorkerMethods["getData"][0])).rejects.toMatchObject({
          code: PLUGIN_RPC_ERROR_CODES.INVOCATION_SCOPE_DENIED,
        });
      }

      expect(companiesGet).not.toHaveBeenCalled();
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });

  it("assigns one opaque operation identity to an exact worker RPC replay and a different identity to a distinct call", async () => {
    const withdraw = vi.fn(async (
      _params: unknown,
      context?: { rpcOperationId?: string },
    ) => ({
      operationId: context?.rpcOperationId,
      task: {
        id: "task-1",
        lifecycleStatus: "closed",
        boardPresentationStatus: "cancelled",
      },
      retried: withdraw.mock.calls.length > 1,
    }));
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: RPC_OPERATION_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers: completeHostHandlers({
        "tasks.withdraw": withdraw as never,
      }),
    });

    try {
      await handle.start();

      const result = await handle.call("getData", {
        key: "rpc-operation",
        companyId: "company-1",
        params: {},
      } as HostToWorkerMethods["getData"][0]) as {
        operationIds: string[];
      };

      expect(withdraw).toHaveBeenCalledTimes(3);
      expect(withdraw.mock.calls.map(([params]) => params)).toEqual([
        {
          taskId: "task-1",
          companyId: "company-1",
          message: "Withdraw this exact task.",
        },
        {
          taskId: "task-1",
          companyId: "company-1",
          message: "Withdraw this exact task.",
        },
        {
          taskId: "task-1",
          companyId: "company-1",
          message: "Withdraw this exact task.",
        },
      ]);
      expect(result.operationIds[0]).toBe(result.operationIds[1]);
      expect(result.operationIds[2]).not.toBe(result.operationIds[0]);
      expect(result.operationIds.every((id) =>
        id.startsWith("pc_plugin_rpc_op_v1_")
      )).toBe(true);
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});


describe("plugin instance config host calls", () => {
  it("allows instance config without company scope", async () => {
    const configGet = vi.fn(async () => ({ apiKey: "configured" }));
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {
        config: { get: configGet },
      } as unknown as HostServices,
    });

    await expect(handlers["config.get"]({})).resolves.toEqual({ apiKey: "configured" });
    expect(configGet).toHaveBeenCalledWith({}, undefined);
  });

  it("keeps instance config independent from the invocation company", async () => {
    const configGet = vi.fn(async () => ({ apiKey: "configured" }));
    const hostHandlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {
        config: { get: configGet },
      } as unknown as HostServices,
    });
    const handle = createPluginWorkerHandle("test.plugin", {
      entrypointPath: INVOCATION_SCOPE_WORKER_ENTRYPOINT,
      manifest: TEST_MANIFEST,
      instanceInfo: {
        instanceId: "instance-1",
        hostVersion: "1.0.0",
      },
      apiVersion: 1,
      databaseNamespace: null,
      onTerminalCrash: () => undefined,
      hostHandlers,
    });

    try {
      await handle.start();

      await expect(
        handle.call("performAction", {
          key: "probe",
          params: {
            mode: "echo",
            hostMethod: "config.get",
            requestedCompanyId: "company-b",
          },
          actorContext: {
            type: "agent",
            agentId: "agent-1",
            runId: "run-1",
            companyId: "company-a",
          },
          renderEnvironment: null,
        }),
      ).resolves.toEqual({ apiKey: "configured" });

      expect(configGet).toHaveBeenCalledWith({}, expect.any(Object));
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
