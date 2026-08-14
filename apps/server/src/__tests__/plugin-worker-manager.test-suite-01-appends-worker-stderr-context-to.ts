import * as t from "./plugin-worker-manager.test-support.js";
const { describe, it, expect, formatWorkerFailureMessage, vi } = t;
const { createHostClientHandlers, createTestWorker } = t;
const { LOG_REQUEST_WORKER_ENTRYPOINT, TEST_MANIFEST } = t;
const { MALFORMED_OUTPUT_WORKER_ENTRYPOINT, completeHostHandlers } = t;
const { PLUGIN_RPC_ERROR_CODES, appendStderrExcerpt, CONFIG_WORKER_ENTRYPOINT } = t;
const { TEST_TOOL, configuredWorker } = t;

describe("plugin-worker-manager stderr failure context", () => {
  it("appends worker stderr context to failure messages", () => {
    expect(
      formatWorkerFailureMessage(
        "Worker process exited (code=1, signal=null)",
        'TypeError: Unknown file extension ".ts"',
      ),
    ).toBe(
      'Worker process exited (code=1, signal=null)\n\nWorker stderr:\nTypeError: Unknown file extension ".ts"',
    );
  });

  it("routes worker logs through the acknowledged host request handler", async () => {
    let acknowledgeLog: (() => void) | null = null;
    const loggerLog = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          acknowledgeLog = resolve;
        }),
    );
    const handlers = createHostClientHandlers({
      pluginKey: "test.plugin",
      capabilities: [],
      services: {
        logger: { log: loggerLog },
      } as unknown as t.HostServices,
    });
    const handle = createTestWorker(LOG_REQUEST_WORKER_ENTRYPOINT, {
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
    const handle = createTestWorker(MALFORMED_OUTPUT_WORKER_ENTRYPOINT, {
      rpcTimeoutMs: 5_000,
    });

    try {
      await handle.start();
      expect(handle.status).toBe("running");

      await expect(
        handle.call("getData", {
          key: "malformed",
          companyId: "company-1",
          params: {},
        }),
      ).rejects.toMatchObject({
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
      'TypeError: Unknown file extension ".ts"',
    ].join("\n");

    expect(formatWorkerFailureMessage(message, 'TypeError: Unknown file extension ".ts"')).toBe(message);
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
        capabilities: ["runtime.prompt.observe"] as t.PaperclipPluginManifestV1["capabilities"],
        config: {},
        expected: 'capability "runtime.prompt.observe" requires the worker to advertise "beforePrompt"',
      },
      {
        capabilities: [] as t.PaperclipPluginManifestV1["capabilities"],
        config: { advertiseBeforePrompt: true },
        expected: 'advertised "beforePrompt" without manifest capability "runtime.prompt.observe"',
      },
    ];

    for (const testCase of cases) {
      const handle = createTestWorker(CONFIG_WORKER_ENTRYPOINT, {
        manifest: {
          ...TEST_MANIFEST,
          capabilities: testCase.capabilities,
        },
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
        } as t.PaperclipPluginManifestV1,
        config: {},
        expected: 'Manifest tool declarations require the worker to advertise "executeTool"',
      },
      {
        manifest: TEST_MANIFEST,
        config: { extraSupportedMethods: ["executeTool"] },
        expected: 'Worker advertised "executeTool" without manifest tool declarations',
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
      } as t.PaperclipPluginManifestV1,
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
      } as t.PaperclipPluginManifestV1,
      method: "handleWebhook",
      expectedDeclaration: "Manifest webhook declarations",
      expectedAbsence: "without manifest webhook declarations",
    },
    {
      label: "API routes",
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["api.routes.register"],
        apiRoutes: [
          {
            routeKey: "summary",
            method: "GET",
            path: "/summary",
            companyResolution: { from: "query", key: "companyId" },
          },
        ],
      } as t.PaperclipPluginManifestV1,
      method: "handleApiRequest",
      expectedDeclaration: "Manifest API route declarations",
      expectedAbsence: "without manifest API route declarations",
    },
  ])(
    "rejects $label declarations and advertised methods that disagree",
    async ({ manifest, method, expectedDeclaration, expectedAbsence }) => {
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
    },
  );

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
    const handle = createTestWorker(CONFIG_WORKER_ENTRYPOINT, {
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["agent.tools.register"],
        tools: [TEST_TOOL],
      } as t.PaperclipPluginManifestV1,
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
    const handle = createTestWorker(CONFIG_WORKER_ENTRYPOINT, {
      manifest: {
        ...TEST_MANIFEST,
        capabilities: ["runtime.prompt.observe"],
      },
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
    const handle = createTestWorker(CONFIG_WORKER_ENTRYPOINT, {
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
    const handle = createTestWorker(CONFIG_WORKER_ENTRYPOINT, {
      hostHandlers: completeHostHandlers({
        "config.get": async () => ({ includeUnexpectedInitializeField: true }),
      }),
    });

    try {
      await expect(handle.start()).rejects.toThrow("must return exactly supportedMethods");
    } finally {
      await handle.stop().catch(() => undefined);
    }
  });
});
