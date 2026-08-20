import type { Db } from "@paperclipai/db";
import type { DeploymentExposure } from "@paperclipai/shared";
import express, { Router, type Request as ExpressRequest } from "express";
import fs from "node:fs";
import path from "node:path";
import {
  createRequestAuthorityBoundary,
  createRequestAuthorityPolicy,
  type RequestAuthorityBoundary,
  type TrustProxyPredicate,
} from "./http/request-authority.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { canonicalRequestTarget } from "./middleware/canonical-pathname.js";
import { errorHandler, httpLogger } from "./middleware/index.js";
import { applyTrustProxy, parseTrustProxyEnv } from "./middleware/trust-proxy.js";
import { changeConsentRoutes } from "./routes/change-consents.js";
import { companyRoutes } from "./routes/companies.js";
import { folderRoutes } from "./routes/folders.js";
import { healthRoutes } from "./routes/health.js";
import { inboxAgentPolicyRoutes } from "./routes/inbox-agent-policy.js";
import type { SecretsRuntimeConfig } from "./secrets/types.js";
import type { StorageService } from "./storage/types.js";

import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { taskTreeControlRoutes } from "./routes/task-tree-control.js";
import { taskRoutes } from "./routes/tasks.js";

import { goalRoutes } from "./routes/goals.js";
import { routineRoutes } from "./routes/routines.js";

import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";

import { createHostClientHandlers, type HostToWorkerMethods } from "@paperclipai/plugin-sdk";
import { installBoardUi, type UiMode } from "./app-ui.js";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT } from "./http/body-limits.js";
import { apiCompression } from "./middleware/api-compression.js";
import { rejectRunInterfaceBearerFromGenericApi } from "./middleware/prompt-capability-boundary.js";
import { accessRoutes } from "./routes/access.js";
import { activityRoutes } from "./routes/activity.js";
import { adapterRoutes } from "./routes/adapters.js";
import { assetRoutes } from "./routes/assets.js";
import { attentionRoutes } from "./routes/attention.js";
import { boardMcpSetupRoutes } from "./routes/board-mcp-setup.js";
import { boardMcpRoutes } from "./routes/board-mcp.js";
import { COMPANY_IMPORTS_API_PATH } from "./routes/company-import-paths.js";
import { costRoutes } from "./routes/costs.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { openApiRoutes } from "./routes/openapi.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { pluginRoutes } from "./routes/plugins.js";
import { resourceMembershipRoutes } from "./routes/resource-memberships.js";
import { runToolsRoutes } from "./routes/run-tools.js";
import { runRoutes } from "./routes/runs.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { createPostgresAdapterConfigurationPreflightService } from "./services/adapter-configuration-preflight.js";
import {
  localExecutionOrchestrator,
  type LocalExecutionOrchestrator,
} from "./services/local-execution-orchestrator.js";
import type { OrdinaryTaskRuntime } from "./services/ordinary-task-runtime.js";
import type { PaperclipManagedToolRouter } from "./services/paperclip-managed-tool-router.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import type { PluginDomainEventPublisher } from "./services/plugin-domain-event-publisher.js";
import type { PluginEventBus } from "./services/plugin-event-bus.js";
import {
  buildHostServices,
  type PluginRunTaskContextReader,
  type PluginRuntimeRecordsReader,
} from "./services/plugin-host-services.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import { pluginLoader } from "./services/plugin-loader.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import { createPluginTaskControlPlane } from "./services/plugin-task-control-plane.js";
import type { PluginWorkerManager } from "./services/plugin-worker-manager.js";
import type { PromptCapabilityGateway } from "./services/prompt-capability-gateway.js";
import type { TaskExecutionCancellationService } from "./services/task-execution-cancellation.js";
import type { TaskExecutionRunService } from "./services/task-execution-run-service.js";
import type { TaskSessionStore } from "./services/task-session/store.js";

export {
  requireStaticUiDist,
  resolveViteHmrHost,
  resolveViteHmrPort,
  shouldServeViteDevHtml,
} from "./app-ui.js";

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    secretsRuntime: SecretsRuntimeConfig;
    deploymentExposure: DeploymentExposure;
    canonicalPublicUrl?: string;
    allowedHostnames: string[];
    bindHost: string;
    authReady: boolean;
    companyDeletionEnabled: boolean;
    instanceId: string;
    hostVersion: string;
    localPluginDir: string;
    pluginMigrationDb: Db;
    pluginWorkerManager: PluginWorkerManager;
    pluginEventBus: PluginEventBus;
    pluginDomainEvents: PluginDomainEventPublisher;
    betterAuthHandler: express.RequestHandler;
    resolveSession: (req: ExpressRequest) => Promise<BetterAuthSessionResult | null>;
    promptCapabilityGateway: PromptCapabilityGateway;
    paperclipManagedTools: PaperclipManagedToolRouter;
    pluginRunTaskContextReader: PluginRunTaskContextReader;
    pluginRuntimeRecordsReader: PluginRuntimeRecordsReader;
    taskSessionStore?: TaskSessionStore;
    ordinaryTaskRuntime: OrdinaryTaskRuntime;
    taskExecutionRunService: Pick<TaskExecutionRunService, "readJoinedRunDetail">;
    taskExecutionCancellation: Pick<
      TaskExecutionCancellationService,
      | "suspendBudgetScopeWork"
      | "cancelRun"
      | "requestAgentCancellationsInTransaction"
      | "reconcileRequestedCancellations"
      | "requestAgentSuspensionsInTransaction"
      | "requestRunningTaskInterruptionsInTransaction"
      | "requestScopeCancellationsInTransaction"
    >;
    adapterReadinessLocalExecutionOrchestrator?: Pick<
      LocalExecutionOrchestrator,
      "acquireExecutionTargetForRun"
    >;
  },
) {
  const app = express();
  app.set("case sensitive routing", true);
  app.set("strict routing", true);
  const ordinaryTasks = opts.ordinaryTaskRuntime;
  const pluginTaskControlPlane = createPluginTaskControlPlane(db, ordinaryTasks);
  app.locals.paperclipDb = db;
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as unknown as { rawBody: Buffer }).rawBody = buf;
  };

  // Respect the operator's `TRUST_PROXY` env var (see middleware/trust-proxy.ts).
  // Default is unset → Express trusts nothing, which is the only safe choice
  // when the server may be reachable without a known reverse proxy in front.
  applyTrustProxy(app, parseTrustProxyEnv(process.env.TRUST_PROXY));
  const requestAuthorityBoundary = createRequestAuthorityBoundary({
    trustProxy: app.get("trust proxy fn") as TrustProxyPredicate,
    policy: createRequestAuthorityPolicy({
      deploymentExposure: opts.deploymentExposure,
      canonicalPublicUrl: opts.canonicalPublicUrl,
      allowedHostnames: opts.allowedHostnames,
      bindHost: opts.bindHost,
    }),
  });
  (
    app.locals as {
      paperclipRequestAuthorityBoundary?: RequestAuthorityBoundary;
    }
  ).paperclipRequestAuthorityBoundary = requestAuthorityBoundary;
  app.use(requestAuthorityBoundary.middleware);
  // Express decodes route parameters before validators see them. Plugin asset
  // identities are host-owned, so fence that namespace on the raw target.
  app.use("/_plugins", canonicalRequestTarget());

  app.use(
    COMPANY_IMPORTS_API_PATH,
    express.json({
      limit: PORTABLE_JSON_BODY_LIMIT,
      verify: captureRawBody,
    }),
  );
  app.use(
    express.json({
      limit: DEFAULT_JSON_BODY_LIMIT,
      verify: captureRawBody,
    }),
  );
  app.use("/api", apiCompression());
  app.use(httpLogger);
  // Prompt-capability authentication is intentionally isolated from the
  // generic API actor middleware and from other capability credentials.
  app.use("/api/run-tools", canonicalRequestTarget());
  app.use("/api", runToolsRoutes(opts.promptCapabilityGateway));
  // Board MCP is a separate board-user ingress. It authenticates an existing
  // board API key and never accepts or substitutes for an ACPX run bearer.
  app.use("/api/mcp", canonicalRequestTarget(), actorMiddleware(db, { resolveSession: opts.resolveSession }));
  app.use("/api", boardMcpRoutes({ db, managedTools: opts.paperclipManagedTools }));
  app.use("/api", rejectRunInterfaceBearerFromGenericApi());
  app.use(
    actorMiddleware(db, {
      resolveSession: opts.resolveSession,
    }),
  );
  app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  // Better Auth owns its external callback query contract. Everything below
  // is Paperclip-owned API surface and therefore has one raw pathname/search
  // spelling before Express performs decoding.
  app.use("/api", canonicalRequestTarget());

  const workerManager = opts.pluginWorkerManager;
  const adapterReadinessLocalExecutionOrchestrator =
    opts.adapterReadinessLocalExecutionOrchestrator ?? localExecutionOrchestrator(db);
  const adapterConfigurationPreflight = createPostgresAdapterConfigurationPreflightService(db, {
    localExecutionOrchestrator: adapterReadinessLocalExecutionOrchestrator,
  });

  // Mount API routes
  const api = Router({ caseSensitive: true, strict: true });
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
    }),
  );
  api.use(openApiRoutes());
  api.use("/companies", companyRoutes(db, opts.storageService, ordinaryTasks, opts.secretsRuntime));
  api.use(folderRoutes(db));
  api.use(changeConsentRoutes(db));
  api.use(inboxAgentPolicyRoutes(db));
  api.use(
    agentRoutes(db, {
      pluginWorkerManager: workerManager,
      taskSessionStore: opts.taskSessionStore,
      ordinaryTasks,
      taskExecutionCancellation: opts.taskExecutionCancellation,
    }),
  );
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db, opts.secretsRuntime));
  api.use(taskTreeControlRoutes(db, opts.taskExecutionCancellation));
  api.use(
    routineRoutes(db, {
      ordinaryTasks,
      secretsRuntime: opts.secretsRuntime,
    }),
  );
  api.use(goalRoutes(db));
  api.use(
    accessRoutes(db, {
      deploymentExposure: opts.deploymentExposure,
    }),
  );
  api.use(
    approvalRoutes(db, {
      pluginWorkerManager: workerManager,
      ordinaryTasks,
      taskExecutionCancellation: opts.taskExecutionCancellation,
    }),
  );
  api.use(secretRoutes(db, opts.secretsRuntime));
  api.use(
    costRoutes(db, {
      pluginWorkerManager: workerManager,
      taskExecutionCancellation: opts.taskExecutionCancellation,
    }),
  );
  api.use(activityRoutes(db));
  api.use(runRoutes(db, opts.taskExecutionRunService, adapterConfigurationPreflight));
  api.use(dashboardRoutes(db));
  api.use(attentionRoutes(db));
  api.use(userProfileRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(sidebarPreferenceRoutes(db));
  api.use(resourceMembershipRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  const pluginRegistry = pluginRegistryService(db);
  const eventBus = opts.pluginEventBus;
  const jobStore = pluginJobStore(db);
  const requestedLocalPluginDir = path.resolve(opts.localPluginDir);
  const localPluginDir = fs.existsSync(requestedLocalPluginDir)
    ? fs.realpathSync(requestedLocalPluginDir)
    : requestedLocalPluginDir;
  const loader = pluginLoader(db, {
    localPluginDir,
    migrationDb: opts.pluginMigrationDb,
  });
  const lifecycle = pluginLifecycleManager(db, {
    loader,
    dispatchRef: ordinaryTasks.dispatchRef,
    taskExecutionCancellation: opts.taskExecutionCancellation,
  });
  const scheduler = createPluginJobScheduler({
    db,
    jobStore,
    workerManager,
  });
  loader.bindRuntimeServices({
    workerManager,
    jobScheduler: scheduler,
    jobStore,
    lifecycleManager: lifecycle,
    instanceInfo: {
      instanceId: opts.instanceId,
      hostVersion: opts.hostVersion,
      deploymentExposure: opts.deploymentExposure,
    },
    buildHostBinding: (pluginId, manifest) => {
      const deliverEvent = (params: HostToWorkerMethods["onEvent"][0]) =>
        workerManager.call(pluginId, "onEvent", params, 15 * 60 * 1_000);
      const services = buildHostServices(db, pluginId, eventBus, deliverEvent, {
        manifest,
        pluginTaskControlPlane,
        pluginRunTaskContextReader: opts.pluginRunTaskContextReader,
        pluginRuntimeRecordsReader: opts.pluginRuntimeRecordsReader,
        ordinaryTasks,
        secretsRuntime: opts.secretsRuntime,
        taskExecutionCancellation: opts.taskExecutionCancellation,
      });
      return {
        handlers: createHostClientHandlers({
          pluginKey: manifest.id,
          capabilities: manifest.capabilities,
          services,
        }),
        dispose: () => services.dispose(),
      };
    },
  });
  api.use(
    taskRoutes(db, opts.storageService, {
      pluginWorkerManager: workerManager,
      ordinaryTasks,
      pluginDomainEvents: opts.pluginDomainEvents,
      taskExecutionCancellation: opts.taskExecutionCancellation,
    }),
  );
  api.use(pluginRoutes(db, lifecycle, { scheduler, jobStore, workerManager }));
  api.use(adapterRoutes());
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  // The installer must win over the SPA document fallback so curl and
  // PowerShell receive an executable script rather than index.html.
  app.use(boardMcpSetupRoutes());
  app.use(pluginUiStaticRoutes(db));

  const boardUi = await installBoardUi(app, {
    mode: opts.uiMode,
    serverPort: opts.serverPort,
    bindHost: opts.bindHost,
    deploymentExposure: opts.deploymentExposure,
    requestAuthorityBoundary,
  });

  app.use(errorHandler);

  scheduler.start();
  const devWatcher = createPluginDevWatcher(lifecycle, async (pluginId) => {
    const plugin = await pluginRegistry.getById(pluginId);
    if (!plugin) return null;
    if (plugin.source !== "local") return null;
    if (!path.isAbsolute(plugin.packagePath)) {
      throw new Error(`Plugin installation package root is not absolute: ${pluginId}`);
    }
    return {
      packagePath: plugin.packagePath,
      manifest: plugin.manifestJson,
    };
  });
  let appServicesShutdown: Promise<void> | null = null;
  const shutdownAppServices = (): Promise<void> => {
    if (appServicesShutdown) return appServicesShutdown;
    appServicesShutdown = Promise.allSettled([
      Promise.resolve().then(() => devWatcher.close()),
      Promise.resolve().then(() => boardUi.dispose()),
      loader.shutdownAll(),
    ]).then((results) => {
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
      if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to shut down application services");
      }
    });
    return appServicesShutdown;
  };
  try {
    await lifecycle.activateReadyPlugins();
  } catch (err) {
    try {
      await shutdownAppServices();
    } catch (shutdownErr) {
      throw new AggregateError([err, shutdownErr], "Plugin startup activation and cleanup failed");
    }
    throw err;
  }
  app.locals.paperclipShutdown = shutdownAppServices;

  return app;
}
