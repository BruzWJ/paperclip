import express, { Router, type Request as ExpressRequest } from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import type { DeploymentExposure } from "@paperclipai/shared";
import type { InspectDatabaseBackupHealthOptions } from "./services/database-backup-health.js";
import type { StorageService } from "./storage/types.js";
import { httpLogger, errorHandler } from "./middleware/index.js";
import { actorMiddleware } from "./middleware/auth.js";
import { boardMutationGuard } from "./middleware/board-mutation-guard.js";
import { applyTrustProxy, parseTrustProxyEnv } from "./middleware/trust-proxy.js";
import { staticPrecompressed } from "./middleware/static-precompressed.js";
import {
  createRequestAuthorityBoundary,
  createRequestAuthorityPolicy,
  type RequestAuthorityBoundary,
  type TrustProxyPredicate,
} from "./http/request-authority.js";
import { healthRoutes } from "./routes/health.js";
import { companyRoutes } from "./routes/companies.js";
import { companySkillRoutes } from "./routes/company-skills.js";
import { companySkillPolicyRoutes } from "./routes/company-skill-policy.js";
import { changeConsentRoutes } from "./routes/change-consents.js";
import { inboxAgentPolicyRoutes } from "./routes/inbox-agent-policy.js";
import { folderRoutes } from "./routes/folders.js";
import { summarySlotRoutes } from "./routes/summary-slots.js";
import { teamsCatalogRoutes } from "./routes/teams-catalog.js";
import { agentRoutes } from "./routes/agents.js";
import { projectRoutes } from "./routes/projects.js";
import { issueRoutes } from "./routes/issues.js";
import { issueTreeControlRoutes } from "./routes/issue-tree-control.js";
import { caseRoutes } from "./routes/cases.js";
import { fileResourceRoutes } from "./routes/file-resources.js";
import { routineRoutes } from "./routes/routines.js";
import { pipelineRoutes } from "./routes/pipelines.js";
import { environmentRoutes } from "./routes/environments.js";
import { executionWorkspaceRoutes } from "./routes/execution-workspaces.js";
import { goalRoutes } from "./routes/goals.js";
import { boardChatRoutes } from "./routes/board-chat.js";
import { approvalRoutes } from "./routes/approvals.js";
import { secretRoutes } from "./routes/secrets.js";
import { toolAccessRoutes } from "./routes/tool-access.js";
import { smokeLabRoutes } from "./routes/smoke-lab.js";
import { costRoutes } from "./routes/costs.js";
import { activityRoutes } from "./routes/activity.js";
import { runRoutes } from "./routes/runs.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { attentionRoutes } from "./routes/attention.js";
import { decisionTrainingRoutes } from "./routes/decision-training.js";
import { userProfileRoutes } from "./routes/user-profiles.js";
import { sidebarBadgeRoutes } from "./routes/sidebar-badges.js";
import { sidebarPreferenceRoutes } from "./routes/sidebar-preferences.js";
import { resourceMembershipRoutes } from "./routes/resource-memberships.js";
import { inboxDismissalRoutes } from "./routes/inbox-dismissals.js";
import { instanceSettingsRoutes } from "./routes/instance-settings.js";
import { openApiRoutes } from "./routes/openapi.js";
import {
  instanceDatabaseBackupRoutes,
  type InstanceDatabaseBackupService,
} from "./routes/instance-database-backups.js";
import { llmRoutes } from "./routes/llms.js";
import { assetRoutes } from "./routes/assets.js";
import { accessRoutes } from "./routes/access.js";
import { pluginRoutes } from "./routes/plugins.js";
import { mcpGatewayProtocolRoutes, toolGatewayRoutes } from "./routes/tool-gateway.js";
import { runToolsRoutes } from "./routes/run-tools.js";
import { adapterRoutes } from "./routes/adapters.js";
import { pluginUiStaticRoutes } from "./routes/plugin-ui-static.js";
import { readBrandedStaticIndexHtml } from "./static-index-html.js";
import { applyUiBranding } from "./ui-branding.js";
import { logger } from "./middleware/logger.js";
import { pluginLoader } from "./services/plugin-loader.js";
import type { PluginWorkerManager } from "./services/plugin-worker-manager.js";
import { createPluginJobScheduler } from "./services/plugin-job-scheduler.js";
import { pluginJobStore } from "./services/plugin-job-store.js";
import {
  createToolGatewayService,
  type ToolGatewayService,
} from "./services/tool-gateway.js";
import type { PromptCapabilityGateway } from "./services/prompt-capability-gateway.js";
import type { IssueExecutionRunService } from "./services/issue-execution-run-service.js";
import { pluginLifecycleManager } from "./services/plugin-lifecycle.js";
import {
  buildHostServices,
  type PluginRunIssueContextReader,
  type PluginRuntimeRecordsReader,
} from "./services/plugin-host-services.js";
import { createPluginIssueControlPlane } from "./services/plugin-issue-control-plane.js";
import type { PluginEventBus } from "./services/plugin-event-bus.js";
import type { PluginDomainEventPublisher } from "./services/plugin-domain-event-publisher.js";
import { createPluginDevWatcher } from "./services/plugin-dev-watcher.js";
import { pluginRegistryService } from "./services/plugin-registry.js";
import type { OrdinaryIssueRuntime } from "./services/ordinary-issue-runtime.js";
import {
  createHostClientHandlers,
  type HostToWorkerMethods,
} from "@paperclipai/plugin-sdk";
import type { BetterAuthSessionResult } from "./auth/better-auth.js";
import { createCachedViteHtmlRenderer } from "./vite-html-renderer.js";
import { DEFAULT_JSON_BODY_LIMIT, PORTABLE_JSON_BODY_LIMIT } from "./http/body-limits.js";
import { COMPANY_IMPORT_API_PATH } from "./routes/company-import-paths.js";
import { apiCompression } from "./middleware/api-compression.js";
import { denyGenericAgentRest } from "./routes/compiled-interface-only.js";
import { rejectRunInterfaceBearerFromGenericApi } from "./middleware/prompt-capability-boundary.js";
import type { IssueSessionStore } from "./services/issue-session/store.js";
import type { IssueExecutionCancellationService } from "./services/issue-execution-cancellation.js";
import {
  environmentRunOrchestrator,
  type EnvironmentRunOrchestrator,
} from "./services/environment-run-orchestrator.js";
import {
  createPostgresAdapterConfigurationPreflightService,
} from "./services/adapter-configuration-preflight.js";

type UiMode = "none" | "static" | "vite-dev";
const FEEDBACK_EXPORT_FLUSH_INTERVAL_MS = 5_000;
const VITE_DEV_ASSET_PREFIXES = [
  "/@fs/",
  "/@id/",
  "/@react-refresh",
  "/@vite/",
  "/assets/",
  "/node_modules/",
  "/src/",
];
const VITE_DEV_STATIC_PATHS = new Set([
  "/apple-touch-icon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/favicon.svg",
  "/site.webmanifest",
  "/sw.js",
]);

export function isDatabaseConnectionUnavailableError(err: unknown): boolean {
  const error = err as { code?: unknown; message?: unknown; cause?: unknown };
  if (error?.code === "ECONNREFUSED") return true;
  return Boolean(error?.cause && isDatabaseConnectionUnavailableError(error.cause));
}

export function resolveViteHmrPort(serverPort: number): number {
  if (serverPort <= 55_535) {
    return serverPort + 10_000;
  }
  return Math.max(1_024, serverPort - 10_000);
}

export function resolveViteHmrHost(bindHost: string): string | undefined {
  const normalized = bindHost.trim().toLowerCase();
  if (normalized === "0.0.0.0" || normalized === "::") return undefined;
  return bindHost;
}

export function shouldServeViteDevHtml(req: ExpressRequest): boolean {
  const pathname = req.path;
  if (VITE_DEV_STATIC_PATHS.has(pathname)) return false;
  if (VITE_DEV_ASSET_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return false;
  return req.accepts(["html"]) === "html";
}

export async function createApp(
  db: Db,
  opts: {
    uiMode: UiMode;
    serverPort: number;
    storageService: StorageService;
    feedbackExportService?: {
      flushPendingFeedbackTraces(input?: {
        companyId?: string;
        traceId?: string;
        limit?: number;
        now?: Date;
      }): Promise<unknown>;
    };
    databaseBackupService?: InstanceDatabaseBackupService;
    databaseBackupHealth?: InspectDatabaseBackupHealthOptions;
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
    pluginRunIssueContextReader: PluginRunIssueContextReader;
    pluginRuntimeRecordsReader: PluginRuntimeRecordsReader;
    issueSessionStore?: IssueSessionStore;
    bindPromptCapabilityCompanyTools: (
      execute: ToolGatewayService["executePromptCapabilityTool"],
    ) => void;
    ordinaryIssueRuntime: OrdinaryIssueRuntime;
    issueExecutionRunService: Pick<
      IssueExecutionRunService,
      "readJoinedRunDetail"
    >;
    issueExecutionCancellation: Pick<
      IssueExecutionCancellationService,
      | "suspendBudgetScopeWork"
      | "resumeBudgetScopeWork"
      | "cancelRun"
      | "requestAgentCancellationsInTransaction"
      | "reconcileRequestedAgentCancellations"
      | "requestAgentSuspensionsInTransaction"
      | "reconcileRequestedAgentSuspensions"
      | "releaseAgentSuspensionsInTransaction"
      | "requestRunningIssueInterruptionsInTransaction"
      | "reconcileRequestedRunningIssueInterruptions"
      | "requestScopeCancellationsInTransaction"
      | "reconcileRequestedScopeCancellations"
    >;
    adapterReadinessEnvironmentOrchestrator?: Pick<
      EnvironmentRunOrchestrator,
      "acquireExecutionTargetForRun"
    >;
  },
) {
  const app = express();
  const ordinaryIssues = opts.ordinaryIssueRuntime;
  const pluginIssueControlPlane = createPluginIssueControlPlane(
    db,
    ordinaryIssues,
  );
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
  (app.locals as { paperclipRequestAuthorityBoundary?: RequestAuthorityBoundary })
    .paperclipRequestAuthorityBoundary = requestAuthorityBoundary;
  app.use(requestAuthorityBoundary.middleware);

  app.use(COMPANY_IMPORT_API_PATH, express.json({
    limit: PORTABLE_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use(express.json({
    limit: DEFAULT_JSON_BODY_LIMIT,
    verify: captureRawBody,
  }));
  app.use("/api", apiCompression());
  app.use(httpLogger);
  // Prompt-capability authentication is intentionally isolated from the
  // generic API actor middleware and from named-gateway credentials.
  app.use("/api", runToolsRoutes(opts.promptCapabilityGateway));
  app.use("/api", rejectRunInterfaceBearerFromGenericApi());
  app.use(
    actorMiddleware(db, {
      resolveSession: opts.resolveSession,
    }),
  );
  app.all("/api/auth/{*authPath}", opts.betterAuthHandler);
  // The run interface is mounted before generic actor resolution. Any exact
  // runtime-agent actor reaching this point is categorically denied from the
  // ambient REST surface.
  app.use("/api", denyGenericAgentRest("REST"));
  app.use(llmRoutes(db));

  const workerManager = opts.pluginWorkerManager;
  const adapterReadinessEnvironmentOrchestrator =
    opts.adapterReadinessEnvironmentOrchestrator ??
    environmentRunOrchestrator(db, {
      pluginWorkerManager: workerManager,
    });
  const adapterConfigurationPreflight =
    createPostgresAdapterConfigurationPreflightService(db, {
      environmentOrchestrator:
        adapterReadinessEnvironmentOrchestrator,
    });

  // Mount API routes
  const api = Router();
  api.use(boardMutationGuard());
  api.use(
    "/health",
    healthRoutes(db, {
      deploymentExposure: opts.deploymentExposure,
      authReady: opts.authReady,
      companyDeletionEnabled: opts.companyDeletionEnabled,
      databaseBackupHealth: opts.databaseBackupHealth,
    }),
  );
  api.use(openApiRoutes());
  api.use("/companies", companyRoutes(db, opts.storageService, ordinaryIssues));
  api.use(llmRoutes(db));
  api.use(folderRoutes(db));
  api.use(companySkillRoutes(db, {
    ordinaryIssues,
    issueExecutionCancellation: opts.issueExecutionCancellation,
  }));
  api.use(companySkillPolicyRoutes(db));
  api.use(changeConsentRoutes(db));
  api.use(inboxAgentPolicyRoutes(db));
  api.use(summarySlotRoutes(db, { ordinaryIssues }));
  api.use(teamsCatalogRoutes(db, ordinaryIssues));
  api.use(
    agentRoutes(db, {
      pluginWorkerManager: workerManager,
      issueSessionStore: opts.issueSessionStore,
      ordinaryIssues,
      issueExecutionCancellation: opts.issueExecutionCancellation,
    }),
  );
  api.use(assetRoutes(db, opts.storageService));
  api.use(projectRoutes(db));
  api.use(caseRoutes(db, opts.storageService));
  api.use(issueTreeControlRoutes(
    db,
    opts.issueExecutionCancellation,
  ));
  api.use(fileResourceRoutes(db));
  api.use(routineRoutes(db, { ordinaryIssues }));
  api.use(pipelineRoutes(db, {
    ordinaryIssues,
    issueExecutionCancellation: opts.issueExecutionCancellation,
  }));
  api.use(environmentRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(executionWorkspaceRoutes(db, { pluginWorkerManager: workerManager }));
  api.use(goalRoutes(db));
  api.use(
    boardChatRoutes(db, { ordinaryIssues }),
  );
  api.use(approvalRoutes(db, {
    pluginWorkerManager: workerManager,
    ordinaryIssues,
    issueExecutionCancellation: opts.issueExecutionCancellation,
  }));
  api.use(secretRoutes(db));
  const trustedLocalStdioRuntimeHost =
    process.env.PAPERCLIP_TRUSTED_MCP_RUNTIME_HOST
    ?? process.env.PAPERCLIP_TOOL_RUNTIME_TRUSTED_HOST
    ?? null;
  api.use(costRoutes(db, {
    pluginWorkerManager: workerManager,
    issueExecutionCancellation: opts.issueExecutionCancellation,
  }));
  api.use(activityRoutes(db));
  api.use(
    runRoutes(
      db,
      opts.issueExecutionRunService,
      adapterConfigurationPreflight,
    ),
  );
  api.use(dashboardRoutes(db));
  api.use(attentionRoutes(db));
  api.use(decisionTrainingRoutes(db));
  api.use(userProfileRoutes(db));
  api.use(sidebarBadgeRoutes(db));
  api.use(sidebarPreferenceRoutes(db));
  api.use(resourceMembershipRoutes(db));
  api.use(inboxDismissalRoutes(db));
  api.use(instanceSettingsRoutes(db));
  if (opts.databaseBackupService) {
    api.use(instanceDatabaseBackupRoutes(opts.databaseBackupService));
  }
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
    dispatchRef: ordinaryIssues.dispatchRef,
    issueExecutionCancellation: opts.issueExecutionCancellation,
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
        pluginIssueControlPlane,
        pluginRunIssueContextReader: opts.pluginRunIssueContextReader,
        pluginRuntimeRecordsReader: opts.pluginRuntimeRecordsReader,
        ordinaryIssues,
        issueExecutionCancellation: opts.issueExecutionCancellation,
      });
      return {
        handlers: createHostClientHandlers({
          pluginId,
          capabilities: manifest.capabilities,
          services,
        }),
        dispose: () => services.dispose(),
      };
    },
  });
  const toolGateway = createToolGatewayService(db, {
    deploymentExposure: opts.deploymentExposure,
    trustedLocalStdioRuntimeHost,
  });
  opts.bindPromptCapabilityCompanyTools(
    toolGateway.executePromptCapabilityTool.bind(toolGateway),
  );
  // Issue routes are intentionally mounted after the gateway is constructed because
  // issue approval endpoints delegate to it. The intervening routers use distinct
  // route prefixes, so this dependency does not change issue-route precedence.
  api.use(issueRoutes(db, opts.storageService, {
    feedbackExportService: opts.feedbackExportService,
    pluginWorkerManager: workerManager,
    ordinaryIssues,
    pluginDomainEvents: opts.pluginDomainEvents,
  }));
  app.use(mcpGatewayProtocolRoutes(toolGateway));
  api.use(toolAccessRoutes(db, {
    deploymentExposure: opts.deploymentExposure,
    canonicalPublicUrl: opts.canonicalPublicUrl,
    trustedLocalStdioRuntimeHost,
    toolGateway,
  }));
  api.use(smokeLabRoutes(db, {
    deploymentExposure: opts.deploymentExposure,
  }));
  let viteHtmlRenderer: ReturnType<typeof createCachedViteHtmlRenderer> | null = null;
  api.use(
    toolGatewayRoutes(db, toolGateway),
  );
  api.use(
    pluginRoutes(
      db,
      lifecycle,
      { scheduler, jobStore, workerManager },
    ),
  );
  api.use(adapterRoutes());
  api.use(
    accessRoutes(db, {
      deploymentExposure: opts.deploymentExposure,
    }),
  );
  app.use("/api", api);
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API route not found" });
  });
  app.use(pluginUiStaticRoutes(db));

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  if (opts.uiMode === "static") {
    // Try published location first (apps/server/ui-dist/), then monorepo dev location (../../ui/dist)
    const candidates = [
      path.resolve(__dirname, "../ui-dist"),
      path.resolve(__dirname, "../../ui/dist"),
    ];
    const uiDist = candidates.find((p) => fs.existsSync(path.join(p, "index.html")));
    if (uiDist) {
      // Hashed asset files (Vite emits them under /assets/<name>.<hash>.<ext>)
      // never change once built, so they can be cached aggressively. The UI
      // build also emits precompressed <asset>.br / <asset>.gz sidecars;
      // serve those when the client accepts the encoding, falling through to
      // the plain express.static otherwise. Both paths send
      // Vary: Accept-Encoding so a shared cache never mixes encoded and
      // identity bodies for one URL.
      app.use("/assets", staticPrecompressed(path.join(uiDist, "assets")));
      app.use(
        "/assets",
        express.static(path.join(uiDist, "assets"), {
          maxAge: "1y",
          immutable: true,
          setHeaders(res) {
            res.setHeader("Vary", "Accept-Encoding");
          },
        }),
      );
      // Non-hashed static files (favicon.ico, manifest, robots.txt, etc.):
      // short cache so operators who swap them out see the new version
      // reasonably fast. Override for `index.html` specifically — it is
      // served by this middleware for `/` and `/index.html`, and it must
      // never outlive the asset hashes it points at.
      app.use(
        express.static(uiDist, {
          maxAge: "1h",
          setHeaders(res, filePath) {
            if (path.basename(filePath) === "index.html") {
              res.set("Cache-Control", "no-cache");
            }
          },
        }),
      );
      // SPA fallback. Only for non-asset routes — if the browser asks for
      // /assets/something.js that doesn't exist, we must NOT serve the HTML
      // shell: the browser would try to load it as a JavaScript module, fail
      // with a MIME-type error, and cache that broken response. Return 404
      // instead. The index.html response itself is no-cache so a subsequent
      // deploy's updated asset hashes are picked up on next load.
      app.get(/.*/, (req, res) => {
        if (req.path.startsWith("/assets/")) {
          res.status(404).end();
          return;
        }
        res
          .status(200)
          .set("Content-Type", "text/html")
          .set("Cache-Control", "no-cache")
          .end(readBrandedStaticIndexHtml(uiDist));
      });
    } else {
      console.warn("[paperclip] UI dist not found; running in API-only mode");
    }
  }

  if (opts.uiMode === "vite-dev") {
    const uiRoot = path.resolve(__dirname, "../../ui");
    const publicUiRoot = path.resolve(uiRoot, "public");
    const hmrPort = resolveViteHmrPort(opts.serverPort);
    const hmrHost = resolveViteHmrHost(opts.bindHost);
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      root: uiRoot,
      appType: "custom",
      server: {
        middlewareMode: true,
        hmr: {
          ...(hmrHost ? { host: hmrHost } : {}),
          port: hmrPort,
          clientPort: hmrPort,
        },
        allowedHosts: opts.deploymentExposure === "private"
          ? Array.from(requestAuthorityBoundary.policy.privateAllowedHostnames)
          : undefined,
      },
    });
    viteHtmlRenderer = createCachedViteHtmlRenderer({
      vite,
      uiRoot,
      brandHtml: applyUiBranding,
    });
    const renderViteHtml = viteHtmlRenderer;

    if (fs.existsSync(publicUiRoot)) {
      app.use(express.static(publicUiRoot, { index: false }));
    }
    app.get(/.*/, async (req, res, next) => {
      if (!shouldServeViteDevHtml(req)) {
        next();
        return;
      }
      try {
        const html = await renderViteHtml.render(req.originalUrl);
        res.status(200).set({ "Content-Type": "text/html" }).end(html);
      } catch (err) {
        next(err);
      }
    });
    app.use(vite.middlewares);
  }

  app.use(errorHandler);

  scheduler.start();
  let feedbackExportShuttingDown = false;
  let feedbackExportTimer: ReturnType<typeof setInterval> | null = null;
  const disableFeedbackExportFlushes = () => {
    feedbackExportShuttingDown = true;
    if (feedbackExportTimer) {
      clearInterval(feedbackExportTimer);
      feedbackExportTimer = null;
    }
  };
  const flushPendingFeedbackExports = async () => {
    if (feedbackExportShuttingDown) return;
    try {
      await opts.feedbackExportService?.flushPendingFeedbackTraces();
    } catch (err) {
      if (isDatabaseConnectionUnavailableError(err)) {
        disableFeedbackExportFlushes();
        logger.warn({ err }, "Disabling pending feedback export flushes because the database is unavailable");
        return;
      }
      logger.error({ err }, "Failed to flush pending feedback exports");
    }
  };

  feedbackExportTimer = opts.feedbackExportService
    ? setInterval(() => {
      void flushPendingFeedbackExports();
    }, FEEDBACK_EXPORT_FLUSH_INTERVAL_MS)
    : null;
  feedbackExportTimer?.unref?.();
  if (opts.feedbackExportService) {
    void flushPendingFeedbackExports();
  }
  const devWatcher = createPluginDevWatcher(
    lifecycle,
    async (pluginId) => {
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
    },
  );
  let appServicesShutdown: Promise<void> | null = null;
  const shutdownAppServices = (): Promise<void> => {
    if (appServicesShutdown) return appServicesShutdown;
    disableFeedbackExportFlushes();
    appServicesShutdown = Promise.allSettled([
      Promise.resolve().then(() => devWatcher.close()),
      Promise.resolve().then(() => viteHtmlRenderer?.dispose()),
      loader.shutdownAll(),
    ]).then((results) => {
      const failures = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
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
      throw new AggregateError(
        [err, shutdownErr],
        "Plugin startup activation and cleanup failed",
      );
    }
    throw err;
  }
  app.locals.paperclipShutdown = shutdownAppServices;

  return app;
}
