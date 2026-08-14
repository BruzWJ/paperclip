import type { HostServices } from "@paperclipai/plugin-sdk";
import { pluginLogs } from "@paperclipai/db";
import { toPublicProject } from "./projects.js";
import { logActivity } from "./activity-log.js";
import { logger } from "../middleware/logger.js";
import { getTelemetryClient } from "../telemetry.js";
import { TELEMETRY_EVENT_NAME_REGEX } from "./plugin-host-networking.js";
import {
  MAX_LOG_MESSAGE_LENGTH,
  MAX_METRIC_NAME_LENGTH,
  readExactPluginListWindow,
  sanitiseMeta,
  truncStr,
} from "./plugin-host-validation.js";
import type { PluginHostServicesScope } from "./plugin-host-services-context.js";

export function createPluginHostServicesMethods2(scope: PluginHostServicesScope) {
  const {
    db,
    pluginId,
    options,
    pluginKey,
    companies,
    managedRoutines,
    projects,
    ensureCompanyId,
    applyWindow,
    ensurePluginAvailableForCompany,
    inCompany,
    pluginActivityDetails,
  } = scope;

  return {
    runtimeRecords: {
      async readSession(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return options.pluginRuntimeRecordsReader.readSession({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readRun(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return options.pluginRuntimeRecordsReader.readRun({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
      async readTaskComments(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return options.pluginRuntimeRecordsReader.readTaskComments({
          ...params,
          companyId,
          pluginInstallationId: pluginId,
          pluginKey,
        });
      },
    },

    activity: {
      async log(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        await logActivity(db, {
          companyId,
          actorType: "plugin",
          actorId: pluginId,
          action: "activity.logged",
          entityType: params.entityType ?? "plugin",
          entityId: params.entityId ?? pluginId,
          details: pluginActivityDetails({
            ...(params.metadata ?? {}),
            message: params.message,
          }),
        });
      },
    },

    metrics: {
      async write(params) {
        if (
          params.name.length === 0 ||
          params.name !== params.name.trim() ||
          params.name.length > MAX_METRIC_NAME_LENGTH
        ) {
          throw new Error(
            `Plugin metric names must be exact non-empty strings no longer than ${MAX_METRIC_NAME_LENGTH} characters`,
          );
        }
        const companyId = params.companyId == null ? null : ensureCompanyId(params.companyId);
        logger.debug(
          {
            pluginId,
            name: params.name,
            value: params.value,
            tags: params.tags,
          },
          "Plugin metric write",
        );

        // The RPC acknowledgement follows the durable write. Using level
        // "metric" keeps metrics queryable through the same operator surface.
        await db.insert(pluginLogs).values({
          pluginId,
          companyId,
          level: "metric",
          message: params.name,
          meta: sanitiseMeta({
            value: params.value,
            tags: params.tags ?? null,
          }),
        });
      },
    },

    telemetry: {
      async track(params) {
        if (
          params.eventName !== params.eventName.trim() ||
          !TELEMETRY_EVENT_NAME_REGEX.test(params.eventName)
        ) {
          throw new Error(
            'Plugin telemetry event names must be lowercase slugs using letters, numbers, "_" or "-".',
          );
        }
        const telemetryClient = getTelemetryClient();
        if (!telemetryClient) return;
        telemetryClient.trackDynamic(`plugin.${pluginKey}.${params.eventName}`, params.dimensions);
      },
    },

    logger: {
      async log(params) {
        const { level, meta } = params;
        const companyId = params.companyId == null ? null : ensureCompanyId(params.companyId);
        const safeMessage = truncStr(String(params.message ?? ""), MAX_LOG_MESSAGE_LENGTH);
        const safeMeta = sanitiseMeta(meta);
        const pluginLogger = logger.child({
          service: "plugin-worker",
          pluginId,
        });
        const logFields = {
          ...safeMeta,
          pluginLogLevel: level,
          pluginTimestamp: new Date().toISOString(),
        };

        if (level === "error") pluginLogger.error(logFields, `[plugin] ${safeMessage}`);
        else if (level === "warn") pluginLogger.warn(logFields, `[plugin] ${safeMessage}`);
        else if (level === "debug") pluginLogger.debug(logFields, `[plugin] ${safeMessage}`);
        else pluginLogger.info(logFields, `[plugin] ${safeMessage}`);

        // A worker log request is acknowledged only after its row is durable.
        await db.insert(pluginLogs).values({
          pluginId,
          companyId,
          level,
          message: safeMessage,
          meta: safeMeta,
        });
      },
    },

    companies: {
      async list(params) {
        const window = readExactPluginListWindow(params, null);
        return applyWindow(await companies.list(), window);
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return companies.getById(companyId);
      },
    },

    projects: {
      async list(params) {
        const window = readExactPluginListWindow(params, null);
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return applyWindow(
          (await projects.list(companyId)).map((project) => toPublicProject(project)),
          window,
        );
      },
      async get(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        const project = await projects.getById(params.projectId);
        return inCompany(project, companyId) ? toPublicProject(project) : null;
      },
      async getManaged(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return projects.resolveManagedProject({
          companyId,
          pluginId,
          pluginKey,
          projectKey: params.projectKey,
          createIfMissing: false,
        });
      },
      async reconcileManaged(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return projects.resolveManagedProject({
          companyId,
          pluginId,
          pluginKey,
          projectKey: params.projectKey,
        });
      },
      async resetManaged(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return projects.resolveManagedProject({
          companyId,
          pluginId,
          pluginKey,
          projectKey: params.projectKey,
          reset: true,
        });
      },
    },

    routines: {
      async managedGet(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.get(params.routineKey, companyId);
      },
      async managedReconcile(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.reconcile(params.routineKey, companyId, {
          assigneeAgentId: params.assigneeAgentId,
          projectId: params.projectId,
        });
      },
      async managedReset(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.reset(params.routineKey, companyId, {
          assigneeAgentId: params.assigneeAgentId,
          projectId: params.projectId,
        });
      },
      async managedUpdate(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.update(params.routineKey, companyId, {
          status: params.status,
        });
      },
      async managedRun(params) {
        const companyId = ensureCompanyId(params.companyId);
        await ensurePluginAvailableForCompany(companyId);
        return managedRoutines.run(params.routineKey, companyId, {
          assigneeAgentId: params.assigneeAgentId,
          projectId: params.projectId,
        });
      },
    },
  } satisfies Pick<
    HostServices & { dispose(): Promise<void> },
    "runtimeRecords" | "activity" | "metrics" | "telemetry" | "logger" | "companies" | "projects" | "routines"
  >;
}
