import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

const {
  createAppMock,
  createBetterAuthInstanceMock,
  createDbMock,
  createDevServerRestartCoordinatorMock,
  detectPortMock,
  devServerRestartCoordinatorMock,
  fakeServer,
  loadConfigMock,
  routineServiceFactoryMock,
  routineServiceMock,
} = vi.hoisted(() => {
  const requestAuthorityBoundary = {
    policy: {},
    resolve: vi.fn(),
    admit: vi.fn(),
    headers: vi.fn(),
    middleware: vi.fn(),
  };
  const createAppMock = vi.fn(async () => {
    const app = ((_: unknown, __: unknown) => {}) as unknown as {
      locals: Record<string, unknown>;
    };
    app.locals = { paperclipRequestAuthorityBoundary: requestAuthorityBoundary };
    return app as never;
  });
  const createBetterAuthInstanceMock = vi.fn(() => ({}));
  const createDbMock = vi.fn(() => ({}) as never);
  const devServerRestartCoordinatorMock = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const createDevServerRestartCoordinatorMock = vi.fn(
    () => devServerRestartCoordinatorMock,
  );
  const detectPortMock = vi.fn(async (port: number) => port);
  const routineServiceMock = {
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  };
  const routineServiceFactoryMock = vi.fn(() => routineServiceMock);
  const fakeServer = {
    once: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    listen: vi.fn((_port: number, _host: string, callback?: () => void) => {
      callback?.();
      return fakeServer;
    }),
    close: vi.fn(),
  };
  const loadConfigMock = vi.fn();

  return {
    createAppMock,
    createBetterAuthInstanceMock,
    createDbMock,
    createDevServerRestartCoordinatorMock,
    devServerRestartCoordinatorMock,
    detectPortMock,
    fakeServer,
    loadConfigMock,
    routineServiceFactoryMock,
    routineServiceMock,
  };
});

function buildTestConfig(overrides: Record<string, unknown> = {}) {
  return {
    deploymentExposure: "private",
    bind: "loopback",
    customBindHost: undefined,
    host: "127.0.0.1",
    port: 3210,
    allowedHostnames: [],
    authPublicBaseUrl: undefined,
    authDisableSignUp: false,
    databaseUrl: "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
    databaseTargetSource: "DATABASE_URL",
    databaseMigrationUrl: undefined,
    serveUi: false,
    uiDevMiddleware: false,
    secretsProvider: "local_encrypted",
    secretsStrictMode: false,
    secretsMasterKeyFilePath: "/tmp/paperclip-master.key",
    storageProvider: "local_disk",
    storageLocalDiskBaseDir: "/tmp/paperclip-storage",
    storageS3Bucket: "paperclip-test",
    storageS3Region: "us-east-1",
    storageS3Endpoint: undefined,
    storageS3Prefix: "",
    storageS3ForcePathStyle: false,
    taskExecutionSchedulerEnabled: false,
    taskExecutionSchedulerIntervalMs: 30000,
    companyDeletionEnabled: false,
    ...overrides,
  };
}

vi.mock("node:http", () => ({
  createServer: vi.fn(() => fakeServer),
}));

vi.mock("detect-port", () => ({
  default: detectPortMock,
}));

vi.mock("@paperclipai/db", () => ({
  createDb: createDbMock,
  authUsers: {},
  companies: {},
  companyMemberships: {},
  instanceUserRoles: {},
  taskExecutionRuns: {},
}));

vi.mock("../app.js", () => ({
  createApp: createAppMock,
}));

vi.mock("../config.js", () => ({
  loadConfig: loadConfigMock,
}));

vi.mock("../middleware/logger.js", () => ({
  logger: {
    child: vi.fn(function child() {
      return this;
    }),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../realtime/live-events-ws.js", () => ({
  setupLiveEventsWebSocketServer: vi.fn(),
}));

vi.mock("../services/index.js", () => ({
  composeAgentRunManagedActionPort: vi.fn(() => ({})),
  createTaskSessionStore: vi.fn(() => ({
    id: "task-session-store",
  })),
  createOrdinaryTaskRuntime: vi.fn(() => ({})),
  createPostgresSystemEscalationService: vi.fn(() => ({
    reconcile: vi.fn(async () => ({ terminalized: 0, ensured: 0 })),
  })),
  createTaskExecutionCancellationService: vi.fn(() => ({
    reconcileIntent: vi.fn(async () => "confirmed"),
    reconcilePending: vi.fn(async () => ({
      discovered: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
      intentIds: [],
    })),
  })),
  createPostgresTaskExecutionProductionRuntime: vi.fn(() => ({
    runService: {
      reconcilePendingSteering: vi.fn(async () => ({
        discovered: 0,
        continued: 0,
        pending: 0,
        sourceCommentIds: [],
      })),
    },
    promptCapabilities: {
      gateway: {},
      pluginRunTaskContextReader: {},
    },
    dispatcher: {
      reconcilePersistedRefs: vi.fn(async () => ({ discovered: 0 })),
      shutdown: vi.fn(async () => undefined),
    },
    cancellation: {
      reconcilePending: vi.fn(async () => []),
      drainRunningRunsForShutdown: vi.fn(async () => undefined),
    },
    executor: {},
  })),
  createPostgresTaskSessionCompositionRuntime: vi.fn(() => ({
    prepareAndNotifyPersistedRef: vi.fn(async () => undefined),
    preparePersistedRef: vi.fn(async () => undefined),
    reconcilePersistedRefs: vi.fn(async () => ({ discovered: 0 })),
  })),
  createPostgresRunInterfaceRuntime: vi.fn(() => ({
    sessionService: {},
    pluginRunTaskContextReader: {},
  })),
  createPostgresRuntimeTaskActionService: vi.fn(() => ({})),
  createRuntimeAgentActionPort: vi.fn((service) => service),
  createRuntimeAgentConfigurationService: vi.fn(() => ({})),
  createRuntimeTaskActionPort: vi.fn((service) => service),
  runTaskSessionCutoversOnStartup: vi.fn(async () => ({
    applied: [],
    skipped: [],
    blockers: [],
  })),
  reconcileBuiltInAgentsOnStartup: vi.fn(async () => ({
    scanned: 0,
    reconciled: 0,
    unknown: 0,
    duplicates: 0,
  })),
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  routineService: routineServiceFactoryMock,
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => ({ id: "plugin-worker-manager" })),
}));

vi.mock("../services/dev-server-restart-coordinator.js", () => ({
  createDevServerRestartCoordinator: createDevServerRestartCoordinatorMock,
}));

vi.mock("../services/local-execution-orchestrator.js", () => ({
  localExecutionOrchestrator: vi.fn(() => ({})),
}));

vi.mock("../startup-banner.js", () => ({
  printStartupBanner: vi.fn(),
}));

vi.mock("../instrumentation.js", () => ({
  instrumentationReady: Promise.resolve(),
  shutdownInstrumentation: vi.fn(async () => undefined),
}));

vi.mock("../telemetry.js", () => ({
  initTelemetry: vi.fn(),
  getTelemetryClient: vi.fn(() => null),
}));

vi.mock("../runtime-environment.js", () => ({
  loadRuntimeEnvironmentFiles: vi.fn(),
}));

vi.mock("../worktree-config.js", () => ({
  maybePersistWorktreeServerPort: vi.fn(),
}));

vi.mock("../secrets/local-encrypted-provider.js", () => ({
  deriveInstancePrivateSecret: vi.fn(() => Buffer.from("test-secret")),
}));

vi.mock("../services/change-consent-gate.js", () => ({
  agentProfileChangeTargetKey: vi.fn((agentId: string) => agentId),
  CHANGE_CONSENT_DEFAULT_TTL_MS: 60_000,
  changeConsentGateService: vi.fn(() => ({
    request: vi.fn(async () => undefined),
  })),
  consumeAcceptedChangeConsentInTransaction: vi.fn(async () => undefined),
}));

vi.mock("../services/paperclip-managed-tool-router.js", () => ({
  createPaperclipManagedToolRouter: vi.fn(() => ({})),
}));

vi.mock("../adapters/registry.js", () => ({
  refreshAcpxAdapters: vi.fn(async () => undefined),
}));

vi.mock("../auth/better-auth.js", () => ({
  createBetterAuthHandler: vi.fn(() => undefined),
  createBetterAuthInstance: createBetterAuthInstanceMock,
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

import { startServer } from "../index.ts";

describe("startServer scheduler wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(buildTestConfig());
    createBetterAuthInstanceMock.mockReturnValue({});
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("keeps routine ticks active in the task-execution scheduler", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      taskExecutionSchedulerEnabled: true,
      taskExecutionSchedulerIntervalMs: 30000,
    }));
    const intervalCallbacks: Array<{
      callback: () => void;
      delay: number;
    }> = [];
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockImplementation(((callback: () => void, delay?: number) => {
        intervalCallbacks.push({
          callback,
          delay: delay ?? 0,
        });
        return intervalCallbacks.length as unknown as ReturnType<
          typeof setInterval
        >;
      }) as typeof setInterval);

    try {
      await startServer();

      const schedulerInterval = intervalCallbacks.find(
        ({ delay }) => delay === 30_000,
      );
      expect(schedulerInterval).toBeDefined();
      schedulerInterval?.callback();
      await Promise.resolve();
      await Promise.resolve();

      expect(routineServiceMock.tickScheduledTriggers).toHaveBeenCalledTimes(1);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

});

describe("startServer database client lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(buildTestConfig({
      databaseMigrationUrl:
        "postgres://paperclip:paperclip@migration.example.test:5432/paperclip",
    }));
    createBetterAuthInstanceMock.mockReturnValue({});
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("closes each mocked client exactly once during graceful shutdown", async () => {
    const primaryClientEnd = vi.fn(async () => undefined);
    const migrationClientEnd = vi.fn(async () => undefined);
    createDbMock
      .mockReturnValueOnce({ $client: { end: primaryClientEnd } } as never)
      .mockReturnValueOnce({ $client: { end: migrationClientEnd } } as never);

    const sigintListenersBefore = new Set(process.listeners("SIGINT"));
    const sigtermListenersBefore = new Set(process.listeners("SIGTERM"));
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined as never) as typeof process.exit);

    let sigintListener: NodeJS.SignalsListener | undefined;
    let sigtermListener: NodeJS.SignalsListener | undefined;
    try {
      await startServer();

      sigintListener = process
        .listeners("SIGINT")
        .find((listener) => !sigintListenersBefore.has(listener));
      sigtermListener = process
        .listeners("SIGTERM")
        .find((listener) => !sigtermListenersBefore.has(listener));
      expect(sigintListener).toBeDefined();
      expect(sigtermListener).toBeDefined();

      sigtermListener?.("SIGTERM");
      await vi.waitFor(() => {
        expect(exitSpy).toHaveBeenCalledWith(0);
      });

      expect(createDbMock).toHaveBeenCalledTimes(2);
      expect(primaryClientEnd).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
      expect(migrationClientEnd).toHaveBeenCalledExactlyOnceWith({ timeout: 5 });
    } finally {
      if (sigintListener) process.removeListener("SIGINT", sigintListener);
      if (sigtermListener) process.removeListener("SIGTERM", sigtermListener);
      exitSpy.mockRestore();
    }
  });
});

describe("startServer auth origin setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(buildTestConfig());
    createBetterAuthInstanceMock.mockReturnValue({});
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("initializes auth without a parallel trusted-origin catalog", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      deploymentExposure: "public",
      port: 3210,
      allowedHostnames: ["board.example.test"],
      authPublicBaseUrl: "https://paperclip.example.test",
    }));
    detectPortMock.mockResolvedValueOnce(3211);

    await startServer();

    expect(createBetterAuthInstanceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        port: 3210,
        authPublicBaseUrl: "https://paperclip.example.test",
      }),
    );
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      serverPort: 3211,
    });
  });
});

describe("startServer runtime API URL handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(buildTestConfig());
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  afterEach(() => {
    if (ORIGINAL_PAPERCLIP_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
    else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_PAPERCLIP_RUNTIME_API_URL;

    if (ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON === undefined) {
      delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    } else {
      process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
    }

    if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
    else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

    if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
    else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;
  });

  it("derives a host-based runtime API URL", async () => {
    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("keeps loopback as the runtime API URL when allowed hostnames are present", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      allowedHostnames: ["192.168.1.50"],
    }));

    const started = await startServer();

    expect(started.apiUrl).toBe("http://127.0.0.1:3210");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3210");
  });

  it("preserves the canonical public URL when detect-port selects a new port", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      deploymentExposure: "public",
      port: 3100,
      authPublicBaseUrl: "http://my-host.ts.net:3100",
    }));
    detectPortMock.mockResolvedValueOnce(3110);

    const started = await startServer();

    expect(started.listenPort).toBe(3110);
    expect(started.apiUrl).toBe("http://my-host.ts.net:3100");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("http://my-host.ts.net:3100");
  });

  it("keeps no-port auth public URLs stable when detect-port selects a new port", async () => {
    loadConfigMock.mockReturnValueOnce(buildTestConfig({
      deploymentExposure: "public",
      port: 3100,
      authPublicBaseUrl: "https://paperclip.example",
    }));
    detectPortMock.mockResolvedValueOnce(3110);

    const started = await startServer();

    expect(started.listenPort).toBe(3110);
    expect(started.apiUrl).toBe("https://paperclip.example");
    expect(process.env.PAPERCLIP_RUNTIME_API_URL).toBe("https://paperclip.example");
  });
});
