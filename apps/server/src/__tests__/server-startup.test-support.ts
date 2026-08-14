import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startServer as startServerImport } from "../index.ts";
export const startServer = startServerImport;
const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

const {
  appShutdownMock,
  createAppMock,
  createBetterAuthInstanceMock,
  createDbMock,
  createDevServerRestartCoordinatorMock,
  devServerRestartCoordinatorMock,
  fakeServer,
  liveEventsSocketCloseMock,
  loadConfigMock,
  routineServiceFactoryMock,
  routineServiceMock,
  setupLiveEventsSocketServerMock,
  taskExecutionCancellationDrainMock,
  taskExecutionDispatcherShutdownMock,
} = vi.hoisted(() => {
  const requestAuthorityBoundary = {
    policy: {},
    resolve: vi.fn(),
    admit: vi.fn(),
    headers: vi.fn(),
    middleware: vi.fn(),
  };
  const appShutdownMock = vi.fn(async () => undefined);
  const createAppMock = vi.fn(async () => {
    const app = ((_: unknown, __: unknown) => {}) as unknown as {
      locals: Record<string, unknown>;
    };
    app.locals = {
      paperclipRequestAuthorityBoundary: requestAuthorityBoundary,
      paperclipShutdown: appShutdownMock,
    };
    return app as never;
  });
  const createBetterAuthInstanceMock = vi.fn(() => ({}));
  const createDbMock = vi.fn(() => ({}) as never);
  const devServerRestartCoordinatorMock = {
    start: vi.fn(),
    stop: vi.fn(),
  };
  const createDevServerRestartCoordinatorMock = vi.fn(() => devServerRestartCoordinatorMock);
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
  const liveEventsSocketCloseMock = vi.fn(async () => undefined);
  const taskExecutionCancellationDrainMock = vi.fn(async () => undefined);
  const taskExecutionDispatcherShutdownMock = vi.fn(async () => undefined);
  const setupLiveEventsSocketServerMock = vi.fn(() => ({
    io: {},
    close: liveEventsSocketCloseMock,
  }));

  return {
    appShutdownMock,
    createAppMock,
    createBetterAuthInstanceMock,
    createDbMock,
    createDevServerRestartCoordinatorMock,
    devServerRestartCoordinatorMock,
    fakeServer,
    liveEventsSocketCloseMock,
    loadConfigMock,
    routineServiceFactoryMock,
    routineServiceMock,
    setupLiveEventsSocketServerMock,
    taskExecutionCancellationDrainMock,
    taskExecutionDispatcherShutdownMock,
  };
});

export function buildTestConfig(overrides: Record<string, unknown> = {}) {
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

function restoreEnvironmentVariable(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

export function registerSuiteSetup(
  options: {
    databaseMigrationUrl?: string;
    configureAuth?: boolean;
    restoreRuntimeEnvironment?: boolean;
  } = {},
) {
  beforeEach(() => {
    vi.clearAllMocks();
    loadConfigMock.mockReturnValue(
      buildTestConfig({
        databaseMigrationUrl: options.databaseMigrationUrl,
      }),
    );
    if (options.configureAuth !== false) {
      createBetterAuthInstanceMock.mockReturnValue({});
    }
    process.env.BETTER_AUTH_SECRET = "test-secret";
  });

  if (options.restoreRuntimeEnvironment) {
    afterEach(() => {
      restoreEnvironmentVariable("PAPERCLIP_RUNTIME_API_URL", ORIGINAL_PAPERCLIP_RUNTIME_API_URL);
      restoreEnvironmentVariable(
        "PAPERCLIP_RUNTIME_API_CANDIDATES_JSON",
        ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON,
      );
      restoreEnvironmentVariable("PAPERCLIP_LISTEN_HOST", ORIGINAL_PAPERCLIP_LISTEN_HOST);
      restoreEnvironmentVariable("PAPERCLIP_LISTEN_PORT", ORIGINAL_PAPERCLIP_LISTEN_PORT);
    });
  }
}

vi.mock("node:http", () => ({
  createServer: vi.fn(() => fakeServer),
}));

vi.mock("@paperclipai/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@paperclipai/db")>()),
  createDb: createDbMock,
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

vi.mock("../realtime/live-events-socket.js", () => ({
  setupLiveEventsSocketServer: setupLiveEventsSocketServerMock,
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
      shutdown: taskExecutionDispatcherShutdownMock,
    },
    cancellation: {
      reconcilePending: vi.fn(async () => []),
      drainRunningRunsForShutdown: taskExecutionCancellationDrainMock,
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
  reconcilePersistedRuntimeServicesOnStartup: vi.fn(async () => ({
    reconciled: 0,
  })),
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

export { describe, expect, it, vi, appShutdownMock, createAppMock };
export { createBetterAuthInstanceMock, createDbMock, fakeServer };
export { liveEventsSocketCloseMock, loadConfigMock, routineServiceMock };
export { taskExecutionCancellationDrainMock, taskExecutionDispatcherShutdownMock };
