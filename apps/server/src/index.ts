/// <reference path="./types/express.d.ts" />
// Kicks off the OTel bootstrap as early as possible (no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set). startServer() awaits
// instrumentationReady before opening DB connections or constructing the
// HTTP server, so trace coverage does not depend on incidental timing.
import { createDb } from "@paperclipai/db";
import type { Request as ExpressRequest, RequestHandler } from "express";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { resolvePaperclipInstanceId, resolvePaperclipInstanceRoot } from "./home-paths.js";
import type { RequestAuthorityBoundary } from "./http/request-authority.js";
import { instrumentationReady, shutdownInstrumentation } from "./instrumentation.js";
import { logger } from "./middleware/logger.js";
import { setupLiveEventsSocketServer } from "./realtime/live-events-socket.js";
import { choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { loadRuntimeEnvironmentFiles } from "./runtime-environment.js";
import { deriveInstancePrivateSecret } from "./secrets/local-encrypted-provider.js";
import type { SecretsRuntimeConfig } from "./secrets/types.js";
import {
  createPersistedWorkScheduler,
  listenForServer,
  registerGracefulShutdown,
} from "./server-lifecycle.js";
import {
  closeDatabaseClient,
  createStartupAssembly,
  isMainModule,
  type BetterAuthSessionResult,
  type CausalRuntimeStartupAssembly,
  type StartedServer,
} from "./server-startup-support.js";
import type { ContextRetrievalService } from "./services/context-retrieval.js";
import { createDevServerRestartCoordinator } from "./services/dev-server-restart-coordinator.js";
import {
  composeAgentRunManagedActionPort,
  createOrdinaryTaskRuntime,
  createPostgresRuntimeTaskActionService,
  createPostgresSystemEscalationService,
  createPostgresTaskExecutionProductionRuntime,
  createPostgresTaskSessionCompositionRuntime,
  createRuntimeAgentActionPort,
  createRuntimeAgentConfigurationService,
  createRuntimeTaskActionPort,
  createTaskSessionStore,
  routineService,
} from "./services/index.js";
import { localExecutionOrchestrator } from "./services/local-execution-orchestrator.js";
import { createPaperclipManagedToolRouter } from "./services/paperclip-managed-tool-router.js";
import { createPostgresPluginBeforePromptDispatcher } from "./services/plugin-before-prompt-dispatcher.js";
import { createPluginDomainEventPublisher } from "./services/plugin-domain-event-publisher.js";
import { createPluginEventBus } from "./services/plugin-event-bus.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createRuntimePluginToolPort } from "./services/runtime-tool-gateway.js";
import { createTaskExecutionSteeringResultBroker } from "./services/task-execution-steering-results.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { initTelemetry } from "./telemetry.js";
import { serverVersion } from "./version.js";
import { maybePersistWorktreeServerPort } from "./worktree-config.js";

export type { StartedServer } from "./server-startup-support.js";

export { loadRuntimeEnvironmentFiles } from "./runtime-environment.js";
export {
  CanonicalTaskAggregateRejected,
  persistCanonicalTaskAggregateInTx,
  type CanonicalTaskAggregateInput,
} from "./services/canonical-task-aggregate.js";
export {
  appendCanonicalControlNotice,
  appendCanonicalUserComment,
  type CanonicalControlNoticeInput,
  type CanonicalUserCommentInput,
} from "./services/task-session-producers.js";

export async function startServer(): Promise<StartedServer> {
  // Tracing must be active (or have failed and logged) before the first DB
  // connection or the HTTP server exists — see instrumentation.ts.
  await instrumentationReady;
  let config = loadConfig();
  const instanceId = resolvePaperclipInstanceId();
  const localPluginDir = resolve(resolvePaperclipInstanceRoot({ instanceId }), "plugins");
  initTelemetry({ enabled: config.telemetryEnabled });
  const secretsRuntime = {
    defaultProvider: config.secretsProvider,
    strictMode: config.secretsStrictMode,
    masterKeyFilePath: config.secretsMasterKeyFilePath,
  } satisfies SecretsRuntimeConfig;

  const activeDatabaseConnectionString = config.databaseUrl;
  const db = createDb(activeDatabaseConnectionString);
  const pluginMigrationDb = config.databaseMigrationUrl ? createDb(config.databaseMigrationUrl) : db;
  const devServerRestartCoordinator = createDevServerRestartCoordinator(db);
  const startupDbInfo = { connectionString: activeDatabaseConnectionString };
  logger.info(
    { databaseTargetSource: config.databaseTargetSource },
    "Using externally provisioned PostgreSQL",
  );

  if (config.deploymentExposure === "public" && !config.authPublicBaseUrl) {
    throw new Error("public exposure requires PAPERCLIP_PUBLIC_URL or persisted auth.publicBaseUrl");
  }

  const requestedListenPort = config.port;
  const listenPort = requestedListenPort;

  const {
    createBetterAuthHandler,
    createBetterAuthInstance,
    resolveBetterAuthSession,
    resolveBetterAuthSessionFromHeaders,
  } = await import("./auth/better-auth.js");
  const auth = createBetterAuthInstance(db as any, config);
  const betterAuthHandler: RequestHandler = createBetterAuthHandler(auth);
  const resolveSession = (req: ExpressRequest): Promise<BetterAuthSessionResult | null> =>
    resolveBetterAuthSession(auth, req);
  const resolveSessionFromHeaders = (headers: Headers): Promise<BetterAuthSessionResult | null> =>
    resolveBetterAuthSessionFromHeaders(auth, headers);
  const authReady = true;
  const taskSessionStore = createTaskSessionStore(db as any, {
    cursorSecret: deriveInstancePrivateSecret("task-session-read-cursor", secretsRuntime).toString(
      "base64url",
    ),
  });

  maybePersistWorktreeServerPort({ serverPort: listenPort });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const pluginWorkerManager = createPluginWorkerManager();
  const pluginEventBus = createPluginEventBus();
  const pluginDomainEvents = createPluginDomainEventPublisher(pluginEventBus);
  const pluginBeforePrompt = createPostgresPluginBeforePromptDispatcher(db as any, pluginWorkerManager);
  const runtimeListenHost = config.host;
  const runtimeApiUrl = choosePrimaryRuntimeApiUrl({
    authPublicBaseUrl: config.authPublicBaseUrl ?? null,
    allowedHostnames: config.allowedHostnames,
    bindHost: runtimeListenHost,
    port: listenPort,
  });
  process.env.PAPERCLIP_LISTEN_HOST = runtimeListenHost;
  process.env.PAPERCLIP_LISTEN_PORT = String(listenPort);
  process.env.PAPERCLIP_RUNTIME_API_URL = runtimeApiUrl;

  const workerId = `paperclip-server:${process.pid}:${Date.now()}`;
  const causalRuntimeStartup = createStartupAssembly<CausalRuntimeStartupAssembly>();
  const taskExecutionSteeringResults = createTaskExecutionSteeringResultBroker();
  const taskActions = createRuntimeTaskActionPort(
    createPostgresRuntimeTaskActionService(db as any, {
      async dispatchPersistedRef(refId) {
        const runtime = await causalRuntimeStartup.ready;
        await runtime.dispatchPersistedRef(refId);
      },
      taskExecutionCancellation: {
        async requestScopeCancellationsInTransaction(transaction, input) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.taskExecutionCancellation.requestScopeCancellationsInTransaction(transaction, input);
        },
        async reconcileRequestedCancellations(requested) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.taskExecutionCancellation.reconcileRequestedCancellations(requested);
        },
      },
    }),
  );
  const agentActions = createRuntimeAgentActionPort(
    createRuntimeAgentConfigurationService(db as any),
  );
  const agentRunActions = composeAgentRunManagedActionPort(taskActions, agentActions);
  // One canonical managed-tool router serves two explicit authorities:
  // request-scoped ACPX runs and authenticated Board MCP users.
  let ordinaryTasksForManagedTools: ReturnType<typeof createOrdinaryTaskRuntime> | null = null;
  let retrievalForManagedTools: ContextRetrievalService | null = null;
  const paperclipManagedTools = createPaperclipManagedToolRouter({
    db: db as any,
    agentRunActions,
    ordinaryTasks() {
      if (!ordinaryTasksForManagedTools) {
        throw new Error("Paperclip managed actions are not fully assembled");
      }
      return ordinaryTasksForManagedTools;
    },
    retrieval() {
      if (!retrievalForManagedTools) {
        throw new Error("Paperclip managed actions are not fully assembled");
      }
      return retrievalForManagedTools;
    },
    pluginDomainEvents,
  });
  const promptCapabilityPluginTools = createRuntimePluginToolPort(pluginWorkerManager);
  // Warm the ACPX catalog without making server availability depend on every
  // locally configured provider CLI completing a probe. All selectable paths
  // (catalog reads, configuration, approval, and execution readiness) refresh
  // ACPX and fail closed before use, so this is only an eager cache fill.
  void import("./adapters/registry.js")
    .then(({ refreshAcpxAdapters }) => refreshAcpxAdapters({ force: true }))
    .catch((error: unknown) => {
      logger.warn({ err: error }, "initial ACPX adapter catalog refresh failed; it will retry on demand");
    });
  const composition = createPostgresTaskSessionCompositionRuntime(db as any, {
    workerId,
  });
  const taskExecutionLocalOrchestrator = localExecutionOrchestrator(db as any);
  const refDispatcher: { dispatch: ((refId: string) => Promise<void>) | null } = { dispatch: null };
  const taskExecution = createPostgresTaskExecutionProductionRuntime(db as any, {
    workerId,
    targetSessionProtectionSecret: deriveInstancePrivateSecret(
      "task-execution-target-session",
      secretsRuntime,
    ),
    taskSessionStore,
    localExecutionOrchestrator: taskExecutionLocalOrchestrator,
    capabilityEndpoint: `${runtimeApiUrl.replace(/\/+$/, "")}/api/run-tools`,
    capabilityCursorSecret: deriveInstancePrivateSecret(
      "prompt-capability-retrieval-cursor",
      secretsRuntime,
    ).toString("base64url"),
    managedTools: paperclipManagedTools,
    pluginTools: promptCapabilityPluginTools,
    pluginDomainEvents,
    beforePrompt: pluginBeforePrompt,
    steeringResults: taskExecutionSteeringResults,
    dispatchRef: (refId) => refDispatcher.dispatch?.(refId) ?? Promise.resolve(),
  });
  const dispatchPersistedRef = async (refId: string) => {
    await composition.prepareAndNotifyPersistedRef(refId, taskExecution.dispatcher);
  };
  refDispatcher.dispatch = dispatchPersistedRef;
  const systemEscalations = createPostgresSystemEscalationService(db as any, {
    dispatchRef: dispatchPersistedRef,
  });
  causalRuntimeStartup.complete({
    dispatchPersistedRef,
    taskExecutionCancellation: taskExecution.cancellation,
  });
  const ordinaryTasks = createOrdinaryTaskRuntime(db as any, {
    taskExecutionRunService: taskExecution.runService,
    taskExecutionCancellation: taskExecution.cancellation,
    dispatchRef: dispatchPersistedRef,
  });
  ordinaryTasksForManagedTools = ordinaryTasks;
  retrievalForManagedTools = taskExecution.promptCapabilities.retrieval;
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    secretsRuntime,
    deploymentExposure: config.deploymentExposure,
    canonicalPublicUrl: config.authPublicBaseUrl,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    instanceId,
    hostVersion: serverVersion,
    localPluginDir,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
    pluginEventBus,
    pluginDomainEvents,
    promptCapabilityGateway: taskExecution.promptCapabilities.gateway,
    paperclipManagedTools,
    pluginRunTaskContextReader: taskExecution.promptCapabilities.pluginRunTaskContextReader,
    pluginRuntimeRecordsReader: taskExecution.promptCapabilities.pluginRuntimeRecordsReader,
    taskSessionStore,
    ordinaryTaskRuntime: ordinaryTasks,
    taskExecutionRunService: taskExecution.runService,
    taskExecutionCancellation: taskExecution.cancellation,
    adapterReadinessLocalExecutionOrchestrator: taskExecutionLocalOrchestrator,
  });
  const requestAuthorityBoundary = (
    app.locals as {
      paperclipRequestAuthorityBoundary?: RequestAuthorityBoundary;
    }
  ).paperclipRequestAuthorityBoundary;
  if (!requestAuthorityBoundary) {
    throw new Error("Request authority boundary was not assembled");
  }
  const server = createServer(app as unknown as Parameters<typeof createServer>[0]);

  // Increase keep-alive timeouts to safely outlive default idle timeouts
  // of common reverse proxies and load balancers (like AWS ALB, Nginx, or Traefik).
  // This prevents intermittent 502/ECONNRESET errors caused by Node's 5s default.
  server.keepAliveTimeout = 185000;
  server.headersTimeout = 186000;

  const liveEventsSocket = setupLiveEventsSocketServer(server, db, {
    resolveSessionFromHeaders,
    requestAuthorityBoundary,
  });

  const routines = routineService(db as any, {
    ordinaryTasks,
    secretsRuntime,
  });

  const reconcilePersistedTaskExecutions = async () => {
    // Durable exact stops are reconciled before any path may recover or
    // dispatch persisted execution work.
    const cancellations = await taskExecution.cancellation.reconcilePending();
    const escalations = await systemEscalations.reconcile();
    const prepared = await composition.reconcilePersistedRefs(taskExecution.dispatcher);
    const dispatchable = await taskExecution.dispatcher.reconcilePersistedRefs();
    // Expired-attempt recovery above establishes the attempt/lease settlement
    // fence. Feed only then-recoverable durable steering sources back through
    // their one canonical continuation path.
    const steering = await taskExecution.runService.reconcilePendingSteering();
    if (
      cancellations.length > 0 ||
      escalations.terminalized > 0 ||
      escalations.ensured > 0 ||
      prepared.discovered > 0 ||
      dispatchable.discovered > 0 ||
      steering.discovered > 0
    ) {
      logger.info(
        {
          cancellations,
          systemEscalations: escalations,
          prepared,
          dispatchable,
          steering,
        },
        "persisted task-execution recovery reconciled refs",
      );
    }
  };

  const persistedWorkScheduler = createPersistedWorkScheduler({
    enabled: config.taskExecutionSchedulerEnabled,
    intervalMs: config.taskExecutionSchedulerIntervalMs,
    reconcile: reconcilePersistedTaskExecutions,
    tickRoutines: () => routines.tickScheduledTriggers(new Date()),
  });
  await persistedWorkScheduler.start();
  await listenForServer(server, {
    host: config.host,
    listenPort,
    openOnListen: config.openOnListen,
    banner: {
      bind: config.bind,
      host: config.host,
      deploymentExposure: config.deploymentExposure,
      authReady,
      requestedPort: requestedListenPort,
      listenPort,
      uiMode,
      db: startupDbInfo,
      taskExecutionSchedulerEnabled: config.taskExecutionSchedulerEnabled,
      taskExecutionSchedulerIntervalMs: config.taskExecutionSchedulerIntervalMs,
    },
  });

  devServerRestartCoordinator.start();

  registerGracefulShutdown({
    stopRestartCoordinator: () => devServerRestartCoordinator.stop(),
    stopScheduler: () => persistedWorkScheduler.stopAndWait(),
    drainExecutions: (signal) =>
      Promise.all([
        taskExecution.dispatcher.shutdown(),
        taskExecution.cancellation.drainRunningRunsForShutdown(signal),
      ]).then(() => undefined),
    shutdownApp: () =>
      (app as { locals?: { paperclipShutdown?: () => Promise<void> } }).locals?.paperclipShutdown?.(),
    closeLiveEvents: () => liveEventsSocket.close(),
    closeDatabases: () =>
      Promise.all(
        Array.from(new Set([db, pluginMigrationDb]), (database) => closeDatabaseClient(database)),
      ).then(() => undefined),
    shutdownInstrumentation,
  });

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: runtimeApiUrl,
    databaseUrl: activeDatabaseConnectionString,
  };
}

if (isMainModule(import.meta.url)) {
  loadRuntimeEnvironmentFiles();
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
}
