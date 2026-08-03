/// <reference path="./types/express.d.ts" />
// Kicks off the OTel bootstrap as early as possible (no-op unless
// OTEL_EXPORTER_OTLP_ENDPOINT is set). startServer() awaits
// instrumentationReady before opening DB connections or constructing the
// HTTP server, so trace coverage does not depend on incidental timing.
import { instrumentationReady, shutdownInstrumentation } from "./instrumentation.js";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Request as ExpressRequest, RequestHandler } from "express";
import {
  createDb,
  formatDatabaseBackupResult,
  runDatabaseBackup,
} from "@paperclipai/db";
import detectPort from "detect-port";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { logger } from "./middleware/logger.js";
import { setupEnvironmentCustomImageTerminalWebSocketServer } from "./realtime/environment-custom-image-terminal-ws.js";
import { setupLiveEventsWebSocketServer } from "./realtime/live-events-ws.js";
import {
  feedbackService,
  bootstrapExecutionPolicyFromEnv,
  environmentCustomImageService,
  composeRuntimeActionPort,
  createOrdinaryIssueRuntime,
  createPostgresCreatorDeliveryService,
  createPostgresSystemEscalationService,
  createPostgresIssueExecutionProductionRuntime,
  createPostgresSessionCompactionProvider,
  createPostgresIssueSessionCompositionRuntime,
  createIssueSessionStore,
  createPostgresRuntimeIssueActionService,
  type PostgresRuntimeIssueActionServiceOptions,
  createRuntimeAgentActionPort,
  createRuntimeAgentConfigurationService,
  createRuntimeIssueActionPort,
  instanceSettingsService,
  reconcileCloudUpstreamRunsOnStartup,
  reconcilePersistedRuntimeServicesOnStartup,
  routineService,
  toolAccessService,
} from "./services/index.js";
import {
  parseAdapterRegistryEnv,
  reconcileAdapterAvailability,
} from "./services/adapter-registry-bootstrap.js";
import { createFeedbackTraceShareClientFromConfig } from "./services/feedback-share-client.js";
import { choosePrimaryRuntimeApiUrl } from "./runtime-api.js";
import { createPluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createDevServerRestartCoordinator } from "./services/dev-server-restart-coordinator.js";
import { environmentRuntimeService } from "./services/environment-runtime.js";
import { environmentRunOrchestrator } from "./services/environment-run-orchestrator.js";
import { createStorageServiceFromConfig } from "./storage/index.js";
import { printStartupBanner } from "./startup-banner.js";
import { maybePersistWorktreeServerPort } from "./worktree-config.js";
import { initTelemetry, getTelemetryClient } from "./telemetry.js";
import { conflict } from "./errors.js";
import { loadRuntimeEnvironmentFiles } from "./runtime-environment.js";
import { deriveInstancePrivateSecret } from "./secrets/local-encrypted-provider.js";
import type { ToolGatewayService } from "./services/tool-gateway.js";
import type { RuntimeCompanyToolPort } from "./services/runtime-tool-executor.js";
import { createIssueExecutionSteeringResultBroker } from "./services/issue-execution-steering-results.js";
import type {
  InstanceDatabaseBackupRunResult,
  InstanceDatabaseBackupTrigger,
} from "./routes/instance-database-backups.js";
import type { RequestAuthorityBoundary } from "./http/request-authority.js";
import {
  agentProfileChangeTargetKey,
  CHANGE_CONSENT_DEFAULT_TTL_MS,
  changeConsentGateService,
  consumeAcceptedChangeConsentInTransaction,
} from "./services/change-consent-gate.js";

export {
  appendCanonicalControlNotice,
  appendCanonicalUserComment,
  type CanonicalControlNoticeInput,
  type CanonicalUserCommentInput,
} from "./services/issue-session-producers.js";
export {
  persistCanonicalIssueAggregateInTx,
  CanonicalIssueAggregateRejected,
  type CanonicalIssueAggregateInput,
} from "./services/canonical-issue-aggregate.js";
export { loadRuntimeEnvironmentFiles } from "./runtime-environment.js";

type BetterAuthSessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
};

type BetterAuthSessionResult = {
  session: { id: string; userId: string } | null;
  user: BetterAuthSessionUser | null;
};

type CausalRuntimeStartupAssembly = Pick<
  PostgresRuntimeIssueActionServiceOptions,
  | "dispatchPersistedRef"
  | "notifyCreatorDelivery"
  | "executeMention"
  | "issueExecutionCancellation"
  | "runService"
>;

/**
 * Resolves a construction-time dependency cycle without a nullable callback,
 * no-op implementation, or late failure. The assembly is completed before
 * routes, recovery, schedulers, or the HTTP listener can submit work.
 */
function createStartupAssembly<T>() {
  let complete!: (assembly: T) => void;
  const ready = new Promise<T>((resolveReady) => {
    complete = resolveReady;
  });
  return { ready, complete };
}

async function closeDatabaseClient(database: unknown): Promise<void> {
  const client = (database as {
    $client?: { end?: (options?: { timeout?: number }) => Promise<void> };
  }).$client;
  if (client?.end) {
    await client.end({ timeout: 5 });
  }
}

export interface StartedServer {
  server: ReturnType<typeof createServer>;
  host: string;
  listenPort: number;
  apiUrl: string;
  databaseUrl: string;
}

export async function startServer(): Promise<StartedServer> {
  // Tracing must be active (or have failed and logged) before the first DB
  // connection or the HTTP server exists — see instrumentation.ts.
  await instrumentationReady;
  let config = loadConfig();
  initTelemetry({ enabled: config.telemetryEnabled });
  if (process.env.PAPERCLIP_SECRETS_PROVIDER === undefined) {
    process.env.PAPERCLIP_SECRETS_PROVIDER = config.secretsProvider;
  }
  if (process.env.PAPERCLIP_SECRETS_STRICT_MODE === undefined) {
    process.env.PAPERCLIP_SECRETS_STRICT_MODE = config.secretsStrictMode ? "true" : "false";
  }
  if (process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE === undefined) {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = config.secretsMasterKeyFilePath;
  }
  
  const activeDatabaseConnectionString = config.databaseUrl;
  const db = createDb(activeDatabaseConnectionString);
  const pluginMigrationDb = config.databaseMigrationUrl
    ? createDb(config.databaseMigrationUrl)
    : db;
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
  const listenPort = await detectPort(requestedListenPort);
  
  const {
    createBetterAuthHandler,
    createBetterAuthInstance,
    resolveBetterAuthSession,
    resolveBetterAuthSessionFromHeaders,
  } = await import("./auth/better-auth.js");
  const auth = createBetterAuthInstance(db as any, config);
  const betterAuthHandler: RequestHandler = createBetterAuthHandler(auth);
  const resolveSession = (
    req: ExpressRequest,
  ): Promise<BetterAuthSessionResult | null> => resolveBetterAuthSession(auth, req);
  const resolveSessionFromHeaders = (
    headers: Headers,
  ): Promise<BetterAuthSessionResult | null> => resolveBetterAuthSessionFromHeaders(auth, headers);
  const authReady = true;
  const issueSessionStore = createIssueSessionStore(db as any, {
    cursorSecret: deriveInstancePrivateSecret(
      "issue-session-read-cursor",
    ).toString("base64url"),
  });

  maybePersistWorktreeServerPort({ serverPort: listenPort });
  const uiMode = config.uiDevMiddleware ? "vite-dev" : config.serveUi ? "static" : "none";
  const storageService = createStorageServiceFromConfig(config);
  const backupSettingsSvc = instanceSettingsService(db);
  const databaseBackupMaxAgeHours = Math.max(
    1,
    Number(process.env.PAPERCLIP_DB_BACKUP_MAX_AGE_HOURS) ||
      Math.max(26, Math.ceil((config.databaseBackupIntervalMinutes / 60) * 2)),
  );
  const databaseBackupAlertFile =
    process.env.PAPERCLIP_DB_BACKUP_ALERT_FILE ||
    resolve(config.databaseBackupDir, "..", "health", "db-backup-to-s3.failure");
  const databaseBackupAlertFiles = [
    databaseBackupAlertFile,
    resolve(config.databaseBackupDir, "db-backup-to-s3.failure"),
    resolve(config.databaseBackupDir, "..", "db-backup-to-s3.failure"),
  ];
  let databaseBackupInFlight = false;
  const runServerDatabaseBackup = async (
    trigger: InstanceDatabaseBackupTrigger,
  ): Promise<InstanceDatabaseBackupRunResult | null> => {
    if (databaseBackupInFlight) {
      const message = "Database backup already in progress";
      if (trigger === "scheduled") {
        logger.warn("Skipping scheduled database backup because a previous backup is still running");
        return null;
      }
      throw conflict(message);
    }

    databaseBackupInFlight = true;
    const startedAt = new Date();
    const startedAtMs = Date.now();
    const label = trigger === "scheduled" ? "Automatic" : "Manual";
    try {
      logger.info({ backupDir: config.databaseBackupDir, trigger }, `${label} database backup starting`);
      // Read retention from Instance Settings (DB) so changes take effect without restart.
      const generalSettings = await backupSettingsSvc.getGeneral();
      const retention = generalSettings.backupRetention;
      const betterAuthSecret = process.env.BETTER_AUTH_SECRET;
      if (!betterAuthSecret?.trim()) {
        throw new Error(
          "BETTER_AUTH_SECRET is required to create a restorable database backup.",
        );
      }

      const result = await runDatabaseBackup({
        connectionString: activeDatabaseConnectionString,
        betterAuthSecret,
        backupDir: config.databaseBackupDir,
        retention,
        filenamePrefix: "paperclip",
      });
      const finishedAt = new Date();
      const response: InstanceDatabaseBackupRunResult = {
        ...result,
        trigger,
        backupDir: config.databaseBackupDir,
        retention,
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationMs: Date.now() - startedAtMs,
      };
      logger.info(
        {
          backupFile: result.backupFile,
          manifestFile: result.manifestFile,
          manifestFormat: result.manifestFormat,
          manifestFormatVersion: result.manifestFormatVersion,
          payloadChecksum: result.payloadChecksum,
          sizeBytes: result.sizeBytes,
          prunedCount: result.prunedCount,
          backupDir: config.databaseBackupDir,
          retention,
          trigger,
          durationMs: response.durationMs,
        },
        `${label} database backup complete: ${formatDatabaseBackupResult(result)}`,
      );
      return response;
    } catch (err) {
      logger.error({ err, backupDir: config.databaseBackupDir, trigger }, `${label} database backup failed`);
      throw err;
    } finally {
      databaseBackupInFlight = false;
    }
  };
  const pluginWorkerManager = createPluginWorkerManager();
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

  const workerId =
    `paperclip-server:${process.pid}:${Date.now()}`;
  const causalRuntimeStartup =
    createStartupAssembly<CausalRuntimeStartupAssembly>();
  const issueExecutionSteeringResults =
    createIssueExecutionSteeringResultBroker();
  const issueActions = createRuntimeIssueActionPort(
    createPostgresRuntimeIssueActionService(db as any, {
      async dispatchPersistedRef(refId) {
        const runtime = await causalRuntimeStartup.ready;
        await runtime.dispatchPersistedRef(refId);
      },
      async notifyCreatorDelivery(deliveryId) {
        const runtime = await causalRuntimeStartup.ready;
        await runtime.notifyCreatorDelivery(deliveryId);
      },
      async executeMention(input) {
        const runtime = await causalRuntimeStartup.ready;
        return runtime.executeMention(input);
      },
      issueExecutionCancellation: {
        async requestScopeCancellationsInTransaction(transaction, input) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.issueExecutionCancellation
            .requestScopeCancellationsInTransaction(transaction, input);
        },
        async reconcileRequestedScopeCancellations(requested) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.issueExecutionCancellation
            .reconcileRequestedScopeCancellations(requested);
        },
      },
      runService: {
        async readRun(input) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.runService.readRun(input);
        },
        async lockRun(transaction, input) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.runService.lockRun(transaction, input);
        },
        async requestSteeringInTransaction(transaction, input) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.runService.requestSteeringInTransaction(
            transaction,
            input,
          );
        },
        async continuePendingSteeringForSource(input) {
          const runtime = await causalRuntimeStartup.ready;
          return runtime.runService.continuePendingSteeringForSource(
            input,
          );
        },
      },
      issueExecutionSteeringResults,
    }),
  );
  const changeConsents = changeConsentGateService(db);
  const agentActions = createRuntimeAgentActionPort(
    createRuntimeAgentConfigurationService(db as any, {
      async assertConsentedChange(
        transaction,
        { capability, targetAgentId, displayedDiff },
      ) {
        await consumeAcceptedChangeConsentInTransaction(
          transaction,
          {
            companyId: capability.companyId,
            actorAgentId: capability.targetAgentId,
            actorRunId: capability.runId,
            targetKeys: [
              agentProfileChangeTargetKey(targetAgentId),
            ],
            displayedDiff,
          },
        );
      },
    }),
    {
      async requestChangeConsent({
        capability,
        targetAgentId,
        displayedDiff,
      }) {
        await changeConsents.request({
          companyId: capability.companyId,
          requestedByAgentId: capability.targetAgentId,
          sourceRunId: capability.runId,
          targetKey: agentProfileChangeTargetKey(targetAgentId),
          displayedDiff,
          expiresAt: new Date(
            Date.now() + CHANGE_CONSENT_DEFAULT_TTL_MS,
          ),
        });
      },
    },
  );
  const actions = composeRuntimeActionPort(
    issueActions,
    agentActions,
  );
  let executePromptCapabilityTool:
    | ToolGatewayService["executePromptCapabilityTool"]
    | null = null;
  const promptCapabilityCompanyTools: RuntimeCompanyToolPort = {
    execute(input) {
      if (!executePromptCapabilityTool) {
        throw new Error(
          "Prompt-capability company-tool executor is not initialized",
        );
      }
      return executePromptCapabilityTool({
        capability: input.capability,
        companyToolSelectionId: input.companyToolSelectionId,
        parameters: input.arguments,
        callIdentity: input.callIdentity,
        runInterfaceToolCallId: input.runInterfaceToolCallId,
        mintPluginRunContext: input.mintPluginRunContext,
      });
    },
  };
  // Adapter declarations must be settled before issue execution starts.
  const { waitForExternalAdapters } = await import("./adapters/registry.js");
  await waitForExternalAdapters();
  reconcileAdapterAvailability(parseAdapterRegistryEnv());
  const composition =
    createPostgresIssueSessionCompositionRuntime(db as any, {
      workerId,
    });
  const issueExecutionEnvironmentRuntime =
    environmentRuntimeService(db as any, {
      pluginWorkerManager,
    });
  const issueExecutionEnvironmentOrchestrator =
    environmentRunOrchestrator(db as any, {
      environmentRuntime:
        issueExecutionEnvironmentRuntime,
    });
  const compactionProvider =
    createPostgresSessionCompactionProvider(db as any, {
      environmentOrchestrator:
        issueExecutionEnvironmentOrchestrator,
    });
  const issueExecution =
    createPostgresIssueExecutionProductionRuntime(
      db as any,
      {
        workerId,
        targetSessionProtectionSecret:
          deriveInstancePrivateSecret(
            "issue-execution-target-session",
          ),
        issueSessionStore,
        environmentOrchestrator:
          issueExecutionEnvironmentOrchestrator,
        capabilityEndpoint:
          `${runtimeApiUrl.replace(/\/+$/, "")}/api/run-tools`,
        capabilityCursorSecret: deriveInstancePrivateSecret(
          "prompt-capability-retrieval-cursor",
        ).toString("base64url"),
        actions,
        companyTools: promptCapabilityCompanyTools,
        steeringResults: issueExecutionSteeringResults,
        compactionProvider,
        async prepareAndNotifyPersistedRef(refId, dispatcher) {
          await composition.prepareAndNotifyPersistedRef(
            refId,
            dispatcher,
          );
        },
      },
    );
  const feedback = feedbackService(db as any, {
    shareClient: createFeedbackTraceShareClientFromConfig(config),
    runService: issueExecution.runService,
  });
  const dispatchPersistedRef = async (refId: string) => {
    await composition.prepareAndNotifyPersistedRef(
      refId,
      issueExecution.dispatcher,
    );
  };
  const systemEscalations = createPostgresSystemEscalationService(
    db as any,
    {
      dispatchRef: dispatchPersistedRef,
    },
  );
  const creatorDelivery = createPostgresCreatorDeliveryService(
    db as any,
    {
      workerId,
      pluginWorkerManager,
      async notifyRef(refId) {
        return composition.prepareAndNotifyCreatorDeliveryRef(
          refId,
          issueExecution.dispatcher,
        );
      },
      terminalizeCreatorDelivery(input) {
        return systemEscalations.terminalizeCreatorDelivery(input);
      },
    },
  );
  const notifyCreatorDelivery = async (deliveryId: string) => {
    await creatorDelivery.notifyPersistedDelivery(deliveryId);
  };
  causalRuntimeStartup.complete({
    dispatchPersistedRef,
    notifyCreatorDelivery,
    executeMention(input) {
      return issueExecution.mentionExecutor.executeMention(input);
    },
    issueExecutionCancellation: issueExecution.cancellation,
    runService: issueExecution.runService,
  });
  const ordinaryIssues = createOrdinaryIssueRuntime(db as any, {
    issueExecutionRunService: issueExecution.runService,
    issueExecutionCancellation: issueExecution.cancellation,
    dispatchRef: dispatchPersistedRef,
    notifyCreatorDelivery,
  });
  const app = await createApp(db as any, {
    uiMode,
    serverPort: listenPort,
    storageService,
    feedbackExportService: feedback,
    databaseBackupService: {
      runManualBackup: async () => {
        const result = await runServerDatabaseBackup("manual");
        if (!result) {
          throw conflict("Database backup already in progress");
        }
        return result;
      },
    },
    databaseBackupHealth: config.databaseBackupEnabled
      ? {
          enabled: config.databaseBackupEnabled,
          backupDir: config.databaseBackupDir,
          maxAgeHours: databaseBackupMaxAgeHours,
          alertFile: databaseBackupAlertFile,
          alertFiles: databaseBackupAlertFiles,
        }
      : undefined,
    deploymentExposure: config.deploymentExposure,
    canonicalPublicUrl: config.authPublicBaseUrl,
    allowedHostnames: config.allowedHostnames,
    bindHost: config.host,
    authReady,
    companyDeletionEnabled: config.companyDeletionEnabled,
    pluginMigrationDb: pluginMigrationDb as any,
    betterAuthHandler,
    resolveSession,
    pluginWorkerManager,
    promptCapabilityGateway:
      issueExecution.promptCapabilities.gateway,
    pluginRunIssueContextReader:
      issueExecution.promptCapabilities.pluginRunIssueContextReader,
    issueSessionStore,
    bindPromptCapabilityCompanyTools(execute) {
      executePromptCapabilityTool = execute;
    },
    ordinaryIssueRuntime: ordinaryIssues,
    issueExecutionRunService: issueExecution.runService,
    issueExecutionCancellation: issueExecution.cancellation,
    issueSessionCompactionRuntime: issueExecution.compaction,
    adapterReadinessEnvironmentOrchestrator:
      issueExecutionEnvironmentOrchestrator,
  });
  const requestAuthorityBoundary = (
    app.locals as { paperclipRequestAuthorityBoundary?: RequestAuthorityBoundary }
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
  
  if (listenPort !== requestedListenPort) {
    logger.warn(`Requested port is busy; using next free port (requestedPort=${requestedListenPort}, selectedPort=${listenPort})`);
  }
  
  setupEnvironmentCustomImageTerminalWebSocketServer(server, db as any, {
    pluginWorkerManager,
    requestAuthorityBoundary,
  });
  setupLiveEventsWebSocketServer(server, db as any, {
    resolveSessionFromHeaders,
    requestAuthorityBoundary,
  });

  void reconcilePersistedRuntimeServicesOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled persisted runtime services from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of persisted runtime services failed");
    });

  void reconcileCloudUpstreamRunsOnStartup(db as any)
    .then((result) => {
      if (result.reconciled > 0) {
        logger.warn(
          { reconciled: result.reconciled },
          "reconciled cloud upstream runs from a previous server process",
        );
      }
    })
    .catch((err) => {
      logger.error({ err }, "startup reconciliation of cloud upstream runs failed");
    });

  // Force the instance onto the Kubernetes sandbox provider when configured via
  // env (PAPERCLIP_EXECUTION_MODE=kubernetes). Runs before persisted issue execution resumes
  // queued runs so the policy + managed k8s environments are in place. A bad
  // PAPERCLIP_EXECUTION_MODE / PAPERCLIP_K8S_* value throws and fails startup
  // (fail-loud) rather than silently allowing local execution.
  try {
    const policyResult = await bootstrapExecutionPolicyFromEnv(db as any);
    if (policyResult) {
      logger.warn(
        {
          executionMode: policyResult.executionMode,
          companiesConfigured: policyResult.companiesConfigured,
        },
        "forced execution policy applied at startup",
      );
    }
  } catch (err) {
    logger.error({ err }, "failed to apply forced execution policy from environment");
    throw err;
  }

  let issueExecutionSchedulerStopped = false;
  let issueExecutionSchedulerInterval: ReturnType<typeof setInterval> | null = null;
  let creatorDeliveryInterval: ReturnType<typeof setInterval> | null = null;
  const issueExecutionSchedulerInFlight = new Set<Promise<void>>();
  const trackIssueExecutionSchedulerWork = (work: Promise<unknown>) => {
    let tracked: Promise<void>;
    tracked = Promise.resolve(work)
      .then(() => undefined, () => undefined)
      .finally(() => {
        issueExecutionSchedulerInFlight.delete(tracked);
      });
    issueExecutionSchedulerInFlight.add(tracked);
    return tracked;
  };
  const waitForIssueExecutionSchedulerIdle = async () => {
    while (issueExecutionSchedulerInFlight.size > 0) {
      await Promise.allSettled([...issueExecutionSchedulerInFlight]);
    }
  };
  const environmentCustomImages = environmentCustomImageService(db as any, { pluginWorkerManager });
  const routines = routineService(db as any, { ordinaryIssues });
  const tools = toolAccessService(db as any, {
    deploymentExposure: config.deploymentExposure,
    trustedLocalStdioRuntimeHost: process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST
      ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST
      ?? null,
  });

  const reconcilePersistedIssueExecutions = async () => {
    // Durable exact stops are reconciled before any path may recover or
    // dispatch persisted execution work.
    const cancellations =
      await issueExecution.cancellation.reconcilePending();
    const deliveries = await creatorDelivery.drainQueued();
    const escalations = await systemEscalations.reconcile();
    const prepared = await composition.reconcilePersistedRefs(
      issueExecution.dispatcher,
    );
    const dispatchable =
      await issueExecution.dispatcher.reconcilePersistedRefs();
    if (
      cancellations.length > 0 ||
      deliveries.delivered > 0 ||
      deliveries.deferred > 0 ||
      deliveries.failed > 0 ||
      deliveries.holdsChanged > 0 ||
      deliveries.terminalOutcomesChanged > 0 ||
      escalations.terminalized > 0 ||
      escalations.ensured > 0 ||
      prepared.discovered > 0 ||
      dispatchable.discovered > 0
    ) {
      logger.info(
        {
          cancellations,
          creatorDeliveries: deliveries,
          systemEscalations: escalations,
          prepared,
          dispatchable,
        },
        "persisted issue-execution recovery reconciled refs",
      );
    }
  };

  const startupCancellations =
    await issueExecution.cancellation.reconcilePending();
  if (startupCancellations.length > 0) {
    logger.warn(
      { cancellations: startupCancellations },
      "reconciled durable issue-execution cancellations before recovery",
    );
  }
  const startupIssueExecutionRecovery =
    reconcilePersistedIssueExecutions().catch((err) => {
      logger.error(
        { err },
        "startup persisted issue-execution recovery failed",
      );
    });
  trackIssueExecutionSchedulerWork(startupIssueExecutionRecovery);
  await startupIssueExecutionRecovery;

  const setupCleanup = await environmentCustomImages.cleanupExpiredSetupSessions();
  if (setupCleanup.timedOut > 0 || setupCleanup.failed > 0) {
    logger.warn({ ...setupCleanup }, "startup environment customImage setup cleanup changed sessions");
  }
  const toolHealthSweep = await tools.sweepConnectionHealth();
  if (toolHealthSweep.failed > 0) {
    logger.warn({ ...toolHealthSweep }, "startup tool connection health sweep found failing connections");
  }

  if (config.issueExecutionSchedulerEnabled) {
    issueExecutionSchedulerInterval = setInterval(() => {
      if (issueExecutionSchedulerStopped) return;
      trackIssueExecutionSchedulerWork(
        reconcilePersistedIssueExecutions().catch((err) => {
          logger.error(
            { err },
            "periodic persisted issue-execution recovery failed",
          );
        }),
      );
      trackIssueExecutionSchedulerWork(
        routines.tickScheduledTriggers(new Date())
          .then((result) => {
            if (result.triggered > 0) {
              logger.info({ ...result }, "routine scheduler created ordinary issues");
            }
          })
          .catch((err) => {
            logger.error({ err }, "routine scheduler tick failed");
          }),
      );
      trackIssueExecutionSchedulerWork(
        environmentCustomImages.cleanupExpiredSetupSessions()
          .then((result) => {
            if (result.timedOut > 0 || result.failed > 0) {
              logger.warn({ ...result }, "environment customImage setup cleanup changed sessions");
            }
          })
          .catch((err) => {
            logger.error({ err }, "environment customImage setup cleanup failed");
          }),
      );
      trackIssueExecutionSchedulerWork(
        tools.sweepConnectionHealth()
          .then((result) => {
            if (result.failed > 0) {
              logger.warn({ ...result }, "periodic tool connection health sweep found failing connections");
            }
          })
          .catch((err) => {
            logger.error({ err }, "periodic tool connection health sweep failed");
          }),
      );
    }, config.issueExecutionSchedulerIntervalMs);
  }
  creatorDeliveryInterval = setInterval(() => {
    if (issueExecutionSchedulerStopped) return;
    trackIssueExecutionSchedulerWork(
      creatorDelivery.drainQueued()
        .then((result) => {
          if (
            result.delivered > 0 ||
            result.deferred > 0 ||
            result.failed > 0 ||
            result.holdsChanged > 0 ||
            result.terminalOutcomesChanged > 0
          ) {
            logger.info(
              { ...result },
              "creator-delivery worker drained persisted intents",
            );
          }
        })
        .catch((err) => {
          logger.error(
            { err },
            "creator-delivery worker drain failed",
          );
        }),
    );
  }, 1_000);
  
  if (config.databaseBackupEnabled) {
    const backupIntervalMs = config.databaseBackupIntervalMinutes * 60 * 1000;

    logger.info(
      {
        intervalMinutes: config.databaseBackupIntervalMinutes,
        retentionSource: "instance-settings-db",
        backupDir: config.databaseBackupDir,
      },
      "Automatic database backups enabled",
    );
    setInterval(() => {
      void runServerDatabaseBackup("scheduled").catch(() => {
        // runServerDatabaseBackup already logs the failure with context.
      });
    }, backupIntervalMs);
  }
  
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error) => {
      server.off("error", onError);
      rejectListen(err);
    };

    server.once("error", onError);
    server.listen(listenPort, config.host, () => {
      server.off("error", onError);
      logger.info(`Server listening on ${config.host}:${listenPort}`);
      if (process.env.PAPERCLIP_OPEN_ON_LISTEN === "true") {
        const openHost = config.host === "0.0.0.0" || config.host === "::" ? "127.0.0.1" : config.host;
        const url = `http://${openHost}:${listenPort}`;
        void import("open")
          .then((mod) => mod.default(url))
          .then(() => {
            logger.info(`Opened browser at ${url}`);
          })
          .catch((err) => {
            logger.warn({ err, url }, "Failed to open browser on startup");
          });
      }
        printStartupBanner({
          bind: config.bind,
          host: config.host,
          deploymentExposure: config.deploymentExposure,
        authReady,
        requestedPort: requestedListenPort,
        listenPort,
        uiMode,
        db: startupDbInfo,
        issueExecutionSchedulerEnabled: config.issueExecutionSchedulerEnabled,
        issueExecutionSchedulerIntervalMs: config.issueExecutionSchedulerIntervalMs,
        databaseBackupEnabled: config.databaseBackupEnabled,
        databaseBackupIntervalMinutes: config.databaseBackupIntervalMinutes,
        databaseBackupRetentionDays: config.databaseBackupRetentionDays,
        databaseBackupDir: config.databaseBackupDir,
      });

      resolveListen();
    });
  });

  devServerRestartCoordinator.start();
  
  {
    const shutdown = async (signal: "SIGINT" | "SIGTERM") => {
      devServerRestartCoordinator.stop();
      issueExecutionSchedulerStopped = true;
      if (issueExecutionSchedulerInterval) {
        clearInterval(issueExecutionSchedulerInterval);
        issueExecutionSchedulerInterval = null;
      }
      if (creatorDeliveryInterval) {
        clearInterval(creatorDeliveryInterval);
        creatorDeliveryInterval = null;
      }
      await waitForIssueExecutionSchedulerIdle();

      const telemetryClient = getTelemetryClient();
      if (telemetryClient) {
        telemetryClient.stop();
        await telemetryClient.flush();
      }

      try {
        await Promise.all([
          issueExecution.mentionExecutor.shutdown(),
          issueExecution.dispatcher.shutdown(),
          issueExecution.cancellation.drainRunningRunsForShutdown(signal),
        ]);
        logger.info(
          { signal },
          "graceful issue-execution drain complete",
        );
      } catch (err) {
        logger.error(
          { err, signal },
          "graceful issue-execution drain failed",
        );
      }

      const appShutdown = (app as { locals?: { paperclipShutdown?: () => void } }).locals?.paperclipShutdown;
      appShutdown?.();

      try {
        await Promise.all(
          Array.from(new Set([db, pluginMigrationDb]), (database) => closeDatabaseClient(database)),
        );
      } catch (err) {
        logger.error({ err }, "Failed to close PostgreSQL client cleanly");
      }

      // Flush buffered OTel spans before the process goes away; without this
      // await the exporter's final batch is dropped on exit.
      await shutdownInstrumentation();

      process.exit(0);
    };

    process.once("SIGINT", () => {
      void shutdown("SIGINT");
    });
    process.once("SIGTERM", () => {
      void shutdown("SIGTERM");
    });
  }

  return {
    server,
    host: config.host,
    listenPort,
    apiUrl: runtimeApiUrl,
    databaseUrl: activeDatabaseConnectionString,
  };
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(resolve(entry)).href === metaUrl;
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  loadRuntimeEnvironmentFiles();
  void startServer().catch((err) => {
    logger.error({ err }, "Paperclip server failed to start");
    process.exit(1);
  });
}
