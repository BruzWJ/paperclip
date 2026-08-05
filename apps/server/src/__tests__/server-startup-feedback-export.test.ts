import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

const {
  createAppMock,
  createBetterAuthInstanceMock,
  creatorDeliveryServiceFactoryMock,
  creatorDeliveryServiceMock,
  createDbMock,
  detectPortMock,
  environmentCustomImagesServiceMock,
  environmentCustomImagesServiceFactoryMock,
  feedbackExportServiceMock,
  feedbackServiceFactoryMock,
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
  const detectPortMock = vi.fn(async (port: number) => port);
  const creatorDeliveryServiceMock = {
    drainQueued: vi.fn(async () => ({
      delivered: 0,
      deferred: 0,
      failed: 0,
      holdsChanged: 0,
      terminalOutcomesChanged: 0,
    })),
  };
  const creatorDeliveryServiceFactoryMock = vi.fn(
    () => creatorDeliveryServiceMock,
  );
  const environmentCustomImagesServiceMock = {
    cleanupExpiredSetupSessions: vi.fn(async () => ({ scanned: 0, timedOut: 0, failed: 0 })),
  };
  const environmentCustomImagesServiceFactoryMock = vi.fn(() => environmentCustomImagesServiceMock);
  const routineServiceMock = {
    tickScheduledTriggers: vi.fn(async () => ({ triggered: 0 })),
  };
  const routineServiceFactoryMock = vi.fn(() => routineServiceMock);
  const feedbackExportServiceMock = {
    flushPendingFeedbackTraces: vi.fn(async () => ({ attempted: 0, sent: 0, failed: 0 })),
  };
  const feedbackServiceFactoryMock = vi.fn(() => feedbackExportServiceMock);
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
    creatorDeliveryServiceFactoryMock,
    creatorDeliveryServiceMock,
    createDbMock,
    detectPortMock,
    environmentCustomImagesServiceMock,
    environmentCustomImagesServiceFactoryMock,
    feedbackExportServiceMock,
    feedbackServiceFactoryMock,
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
    databaseBackupEnabled: false,
    databaseBackupIntervalMinutes: 60,
    databaseBackupRetentionDays: 30,
    databaseBackupDir: "/tmp/paperclip-test-backups",
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
    feedbackExportBackendUrl: "https://telemetry.example.com",
    feedbackExportBackendToken: "telemetry-token",
    issueExecutionSchedulerEnabled: false,
    issueExecutionSchedulerIntervalMs: 30000,
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
  formatDatabaseBackupResult: vi.fn(() => "ok"),
  runDatabaseBackup: vi.fn(),
  authUsers: {},
  companies: {},
  companyMemberships: {},
  instanceUserRoles: {},
  issueExecutionRuns: {},
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
  composeRuntimeActionPort: vi.fn(() => ({})),
  createIssueSessionStore: vi.fn(() => ({
    id: "issue-session-store",
  })),
  createOrdinaryIssueRuntime: vi.fn(() => ({})),
  createPostgresCreatorDeliveryService:
    creatorDeliveryServiceFactoryMock,
  createPostgresSystemEscalationService: vi.fn(() => ({
    reconcile: vi.fn(async () => ({ terminalized: 0, ensured: 0 })),
  })),
  createIssueExecutionCancellationService: vi.fn(() => ({
    reconcileIntent: vi.fn(async () => "confirmed"),
    reconcilePending: vi.fn(async () => ({
      discovered: 0,
      confirmed: 0,
      failed: 0,
      skipped: 0,
      intentIds: [],
    })),
  })),
  createPostgresIssueExecutionProductionRuntime: vi.fn(() => ({
    runService: {},
    promptCapabilities: {
      gateway: {},
      pluginRunIssueContextReader: {},
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
  createPostgresIssueSessionCompositionRuntime: vi.fn(() => ({
    prepareAndNotifyPersistedRef: vi.fn(async () => undefined),
    preparePersistedRef: vi.fn(async () => undefined),
    reconcilePersistedRefs: vi.fn(async () => ({ discovered: 0 })),
  })),
  createPostgresRunInterfaceRuntime: vi.fn(() => ({
    sessionService: {},
    pluginRunIssueContextReader: {},
  })),
  createPostgresRuntimeIssueActionService: vi.fn(() => ({})),
  createRuntimeAgentActionPort: vi.fn((service) => service),
  createRuntimeAgentConfigurationService: vi.fn(() => ({})),
  createRuntimeIssueActionPort: vi.fn((service) => service),
  feedbackService: feedbackServiceFactoryMock,
  environmentCustomImageService: environmentCustomImagesServiceFactoryMock,
  instanceSettingsService: vi.fn(() => ({
    getGeneral: vi.fn(async () => ({
      backupRetention: {
        dailyDays: 7,
        weeklyWeeks: 4,
        monthlyMonths: 1,
      },
    })),
  })),
  reconcileCloudUpstreamRunsOnStartup: vi.fn(async () => ({ reconciled: 0 })),
  runIssueSessionCutoversOnStartup: vi.fn(async () => ({
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
  toolAccessService: vi.fn(() => ({
    sweepConnectionHealth: vi.fn(async () => ({
      checked: 0,
      healthy: 0,
      needsAttention: 0,
      failed: 0,
    })),
  })),
}));

vi.mock("../storage/index.js", () => ({
  createStorageServiceFromConfig: vi.fn(() => ({ id: "storage-service" })),
}));

vi.mock("../services/feedback-share-client.js", () => ({
  createFeedbackTraceShareClientFromConfig: vi.fn(() => ({ id: "feedback-share-client" })),
}));

vi.mock("../services/plugin-worker-manager.js", () => ({
  createPluginWorkerManager: vi.fn(() => ({ id: "plugin-worker-manager" })),
}));

vi.mock("../startup-banner.js", () => ({
  printStartupBanner: vi.fn(),
}));

vi.mock("../auth/better-auth.js", () => ({
  createBetterAuthHandler: vi.fn(() => undefined),
  createBetterAuthInstance: createBetterAuthInstanceMock,
  resolveBetterAuthSession: vi.fn(async () => null),
  resolveBetterAuthSessionFromHeaders: vi.fn(async () => null),
}));

import { startServer } from "../index.ts";

describe("startServer feedback export wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(buildTestConfig());
    createBetterAuthInstanceMock.mockReturnValue({});
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  it("passes the feedback export service into createApp so pending traces flush in runtime", async () => {
    const started = await startServer();

    expect(started.server).toBe(fakeServer);
    expect(createDbMock).toHaveBeenCalledWith(
      "postgres://paperclip:paperclip@db.example.test:5432/paperclip",
    );
    expect(feedbackServiceFactoryMock).toHaveBeenCalledTimes(1);
    expect(createAppMock).toHaveBeenCalledTimes(1);
    expect(createAppMock.mock.calls[0]?.[1]).toMatchObject({
      feedbackExportService: feedbackExportServiceMock,
      storageService: { id: "storage-service" },
      serverPort: 3210,
    });
  });

  it("keeps routine ticks and setup cleanup active in the issue-execution scheduler", async () => {
    loadConfigMock.mockReturnValue(buildTestConfig({
      issueExecutionSchedulerEnabled: true,
      issueExecutionSchedulerIntervalMs: 30000,
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

      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).toHaveBeenCalledTimes(1);

      const schedulerInterval = intervalCallbacks.find(
        ({ delay }) => delay === 30_000,
      );
      expect(schedulerInterval).toBeDefined();
      schedulerInterval?.callback();
      await Promise.resolve();
      await Promise.resolve();

      expect(routineServiceMock.tickScheduledTriggers).toHaveBeenCalledTimes(1);
      expect(environmentCustomImagesServiceMock.cleanupExpiredSetupSessions).toHaveBeenCalledTimes(2);
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
